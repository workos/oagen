import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { severityMeetsThreshold } from '../../src/compat/config.js';
import { diffSnapshots } from '../../src/compat/differ.js';
import type { CompatDiffResult } from '../../src/compat/differ.js';
import { registerExtractor } from '../../src/compat/extractor-registry.js';
import { apiSurfaceToSnapshot } from '../../src/compat/ir.js';
import type { CompatSnapshot, CompatSymbol } from '../../src/compat/ir.js';
import { getDefaultPolicy } from '../../src/compat/policy.js';
import { formatHumanSummary, generateReport } from '../../src/compat/report.js';
import { validateSnapshot } from '../../src/compat/schema.js';
import type { ApiSurface, Extractor } from '../../src/compat/types.js';
import { dotnetExtractor } from '../../src/compat/extractors/dotnet.js';
import { elixirExtractor } from '../../src/compat/extractors/elixir.js';
import { goExtractor } from '../../src/compat/extractors/go.js';
import { iosExtractor } from '../../src/compat/extractors/ios.js';
import { kotlinExtractor } from '../../src/compat/extractors/kotlin.js';
import { nodeExtractor } from '../../src/compat/extractors/node.js';
import { phpExtractor } from '../../src/compat/extractors/php.js';
import { createPythonExtractor, pythonExtractor } from '../../src/compat/extractors/python.js';
import { rubyExtractor } from '../../src/compat/extractors/ruby.js';
import { rustExtractor } from '../../src/compat/extractors/rust.js';
import type { ApiSpec } from '../../src/ir/types.js';
import { runCompatCheck } from '../../src/verify/run-compat-check.js';

/**
 * #752: `classifyParameterChanges` reports any parameter whose type text
 * changed as a breaking `parameter_type_narrowed`, whichever way it changed.
 * A parameter that now takes an interface with one more optional member, or
 * a wider union, still takes every argument callers pass today. Such a retype
 * is soft-risk now, under the same category: by the two types' members where
 * the language's parameter types are structural (TypeScript), by a declared
 * supertype where a value is accepted by the type it was declared as.
 */

// ---------------------------------------------------------------------------
// SDKs on disk, through the extractors
// ---------------------------------------------------------------------------

const roots: string[] = [];

function writeSdk(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'oagen-752-'));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const snapshotOf = async (extractor: Extractor, files: Record<string, string>): Promise<CompatSnapshot> =>
  apiSurfaceToSnapshot(await extractor.extract(writeSdk(files)));

/** One line per change, as `oagen compat-diff` classifies it. */
const lines = (diff: CompatDiffResult): string[] =>
  diff.changes.map((change) => `${change.severity} ${change.category} ${change.symbol}`);
/** The lines that are not additions. */
const notAdditive = (diff: CompatDiffResult): string[] => lines(diff).filter((line) => !line.startsWith('additive '));

const exitCode = (diff: CompatDiffResult): number =>
  diff.changes.some((change) => severityMeetsThreshold(change.severity, 'breaking')) ? 1 : 0;

/** `oagen compat-extract` on both SDKs, then `oagen compat-diff`. */
async function compatDiff(extractor: Extractor, oldFiles: Record<string, string>, newFiles: Record<string, string>) {
  const baseline = await snapshotOf(extractor, oldFiles);
  const candidate = await snapshotOf(extractor, newFiles);
  const diff = diffSnapshots(baseline, candidate);
  return { baseline, candidate, diff, lines: lines(diff), report: formatHumanSummary(diff), exitCode: exitCode(diff) };
}

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] });
const nodeSdk = (source: string): Record<string, string> => ({ 'tsconfig.json': TSCONFIG, 'src/index.ts': source });

const SOFT_RISK = 'soft-risk';
const BREAKING = 'breaking';
/** The parameter's type text is the same on both sides: nothing to report. */
const UNREPORTED = 'unreported';

/**
 * A parameter retype in TypeScript: the declarations of each side and the
 * parameter list of `Client%.get` on each. Every name a case declares ends in
 * `%`, which becomes the case's own suffix, so that a group of cases is one
 * SDK pair and the TypeScript program is built twice, not twice per case.
 */
interface Retype {
  name: string;
  /** Declarations of both SDKs, of the old one only, of the new one only. */
  shared?: string;
  oldOnly?: string;
  newOnly?: string;
  old: string;
  new: string;
  expected: typeof SOFT_RISK | typeof BREAKING | typeof UNREPORTED;
}

/** The severity of each case's `parameter_type_narrowed` on its client. */
async function retypeSeverities(cases: Retype[]): Promise<Map<string, string[]>> {
  const sdk = (side: 'old' | 'new') =>
    nodeSdk(
      cases
        .map((entry, index) =>
          [
            entry.shared,
            side === 'old' ? entry.oldOnly : entry.newOnly,
            `export declare class Client% { get(${entry[side]}): Promise<string>; }`,
          ]
            .filter(Boolean)
            .join('\n')
            .replaceAll('%', `_${index}`),
        )
        .join('\n'),
    );
  const { diff } = await compatDiff(nodeExtractor, sdk('old'), sdk('new'));
  return new Map(
    cases.map((entry, index) => [
      entry.name,
      diff.changes
        .filter((change) => change.category === 'parameter_type_narrowed' && change.symbol === `Client_${index}.get`)
        .map((change) => change.severity),
    ]),
  );
}

/** A group of retypes, each a test of its own, extracted together. */
function retypes(title: string, cases: Retype[]): void {
  describe(title, () => {
    let severities: Map<string, string[]>;
    beforeAll(async () => {
      severities = await retypeSeverities(cases);
    });
    it.each(cases.map((entry) => [entry.name, entry.expected, entry] as const))('%s: %s', (_, expected, entry) => {
      expect(severities.get(entry.name)).toEqual(expected === UNREPORTED ? [] : [expected]);
    });
  });
}

const OLD = (body: string) => `export interface OldOptions% { ${body} }`;
const NEW = (body: string) => `export interface NewOptions% { ${body} }`;
/** `OldOptions` with one body retyped to `NewOptions` with another, in a parameter written around `%%`. */
const swap = (
  name: string,
  oldBody: string,
  newBody: string,
  expected: Retype['expected'],
  parameter = 'options: %%',
): Retype => ({
  name,
  shared: OLD(oldBody),
  newOnly: NEW(newBody),
  old: parameter.replace('%%', 'OldOptions%'),
  new: parameter.replace('%%', 'NewOptions%'),
  expected,
});

// ---------------------------------------------------------------------------
// The issue's SDKs
// ---------------------------------------------------------------------------

const issueSdk = (petId: string, options: string, extra = '') => `export interface Pet { id: string; name: string }
export interface RequestOptions { timeout?: number }
${extra}
export declare class PetsClient {
  get(petId: ${petId}, options?: ${options}): Promise<Pet>;
}
`;
const ISSUE_OLD = nodeSdk(issueSdk('string', 'RequestOptions'));
const ISSUE_NEW = nodeSdk(
  issueSdk(
    'string',
    'RetryRequestOptions',
    'export interface RetryRequestOptions extends RequestOptions { maxRetries?: number }\n',
  ),
);

const phpFile = (body: string) => `<?php\n\ndeclare(strict_types=1);\n\nnamespace Petstore;\n\n${body}\n`;
const phpClass = (name: string, promoted: string[], base?: string) =>
  phpFile(`class ${name}${base ? ` extends ${base}` : ''}
{
    public function __construct(
${promoted.map((line) => `        ${line},\n`).join('')}    ) {}
}`);
const phpClient = (petId: string, options: string) =>
  phpFile(`final class PetsClient
{
    public function get(${petId} $petId, ${options} $options${options.startsWith('?') ? ' = null' : ''}): Pet
    {
        throw new \\LogicException('Not implemented.');
    }
}`);

describe("#752 the issue's SDKs", () => {
  it('reports `options?: RequestOptions` → an interface that extends it with an optional member as soft-risk', async () => {
    const { report, exitCode: exit, diff } = await compatDiff(nodeExtractor, ISSUE_OLD, ISSUE_NEW);
    expect(report).toMatchInlineSnapshot(`
      "Compat report:
        0 breaking, 1 soft-risk, 3 additive

        Soft-risk:
          [parameter_type_narrowed] PetsClient.get — Parameter type changed for "options" on "PetsClient.get"
            hint: Parameter type swap from "RequestOptions | undefined" to "RetryRequestOptions | undefined" accepts every argument callers pass today — "RetryRequestOptions" keeps every field of "RequestOptions" and requires none that "RequestOptions" did not. Call sites continue to compile; only code that names "RequestOptions" explicitly may want the new type.

        Additive: 3 new symbol(s)"
    `);
    expect(exit).toBe(0);

    // The category, the symbol and the two texts are what they were; the
    // severity and the hint are what changed.
    const [change] = generateReport(diff).changes.filter((entry) => entry.category === 'parameter_type_narrowed');
    expect(change).toMatchObject({
      category: 'parameter_type_narrowed',
      severity: 'soft-risk',
      symbol: 'PetsClient.get',
      old: { parameter: 'options', type: 'RequestOptions | undefined' },
      new: { parameter: 'options', type: 'RetryRequestOptions | undefined' },
      conceptualChangeId: 'chg_parameter_type_narrowed_petsclient.get_options',
    });
  });

  it('reports `petId: string` → `string | number` as soft-risk, and the reverse as breaking', async () => {
    const widened = nodeSdk(issueSdk('string | number', 'RequestOptions'));
    const { report, exitCode: exit } = await compatDiff(nodeExtractor, ISSUE_OLD, widened);
    expect(report).toMatchInlineSnapshot(`
      "Compat report:
        0 breaking, 1 soft-risk, 0 additive

        Soft-risk:
          [parameter_type_narrowed] PetsClient.get — Parameter type changed for "petId" on "PetsClient.get"
            hint: Parameter type swap from "string" to "string | number" accepts every argument callers pass today — every member of the old type is still a member of the new one. Call sites continue to compile; only code that repeats the parameter's type (a wrapper, an override) may want the new one."
    `);
    expect(exit).toBe(0);

    // `tsc` refuses `string | number` where `string` is expected (TS2322).
    const reversed = await compatDiff(nodeExtractor, widened, ISSUE_OLD);
    expect(reversed.report).toMatchInlineSnapshot(`
      "Compat report:
        1 breaking, 0 soft-risk, 0 additive

        Breaking:
          [parameter_type_narrowed] PetsClient.get — Parameter type changed for "petId" on "PetsClient.get""
    `);
    expect(reversed.exitCode).toBe(1);
    expect(reversed.diff.changes[0].remediation).toBeUndefined();
  });

  it('keeps the same retype breaking in PHP, where a class takes only what was declared as it', async () => {
    // "Where a parameter's type is nominal … a new type is breaking unless
    // the old one is assignable to it there too (a subclass relation)."
    const php = (options: string, extra: Record<string, string> = {}) => ({
      'lib/Pet.php': phpClass('Pet', ['public readonly string $id', 'public readonly string $name']),
      'lib/RequestOptions.php': phpClass('RequestOptions', ['public readonly ?int $timeout = null']),
      ...extra,
      'lib/PetsClient.php': phpClient('string', `?${options}`),
    });
    const retry = (base?: string) => ({
      'lib/RetryRequestOptions.php': phpClass(
        'RetryRequestOptions',
        ['public readonly ?int $timeout = null', 'public readonly ?int $maxRetries = null'],
        base,
      ),
    });
    const unrelated = await compatDiff(phpExtractor, php('RequestOptions'), php('RetryRequestOptions', retry()));
    expect(unrelated.report).toMatchInlineSnapshot(`
      "Compat report:
        1 breaking, 0 soft-risk, 3 additive

        Breaking:
          [parameter_type_narrowed] PetsClient.get — Parameter type changed for "options" on "PetsClient.get"

        Additive: 3 new symbol(s)"
    `);
    expect(unrelated.exitCode).toBe(1);

    // The issue's own retype, to a subclass of the old type: a caller's
    // `RequestOptions` is not a `RetryRequestOptions`.
    const subclass = await compatDiff(
      phpExtractor,
      php('RequestOptions'),
      php('RetryRequestOptions', retry('RequestOptions')),
    );
    expect(notAdditive(subclass.diff)).toEqual(['breaking parameter_type_narrowed PetsClient.get']);
  });
});

// ---------------------------------------------------------------------------
// What TypeScript does with the old argument
// ---------------------------------------------------------------------------

describe('#752 what `tsc --strict` does with an argument of the old type', () => {
  /** The first diagnostic of a file compiled under `--strict`, or `ok`. */
  const compile = (source: string): string => {
    const file = join(writeSdk({ 'check.ts': source }), 'check.ts');
    const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true });
    const [first] = ts.getPreEmitDiagnostics(program);
    return first ? `TS${first.code}` : 'ok';
  };
  const check = (types: string, oldType: string, newType: string, literal: string) => ({
    // A value held in a variable of the old type.
    variable: compile(`${types}\nexport const pass = (value: ${oldType}): ${newType} => value;\n`),
    // An object literal at the call site.
    literal: compile(`${types}\ndeclare function get(options: ${newType}): void;\nget(${literal});\n`),
  });

  it('takes an argument of a type with fewer optional members both ways', () => {
    const types = `interface RequestOptions { timeout?: number }
interface RetryRequestOptions extends RequestOptions { maxRetries?: number }`;
    expect(check(types, 'RequestOptions', 'RetryRequestOptions', '{ timeout: 1 }')).toEqual({
      variable: 'ok',
      literal: 'ok',
    });
  });

  it('takes a variable of a type with one member more, and refuses the literal that names it', () => {
    // The row that makes a dropped member breaking, with or without `extends`:
    // an options object is most often written in place.
    const declared = `interface BaseOptions { timeout?: number }
interface RetryOptions extends BaseOptions { maxRetries?: number }`;
    const undeclared = `interface BaseOptions { timeout?: number }
interface RetryOptions { timeout?: number; maxRetries?: number }`;
    for (const types of [declared, undeclared]) {
      expect(check(types, 'RetryOptions', 'BaseOptions', '{ maxRetries: 2 }')).toEqual({
        variable: 'ok',
        literal: 'TS2353',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// TypeScript: which way the parameter was retyped
// ---------------------------------------------------------------------------

retypes('#752 a TypeScript parameter retyped between two interfaces', [
  {
    name: 'the new type extends the old one and adds an optional member',
    shared: 'export interface RequestOptions% { timeout?: number }',
    newOnly: 'export interface RetryRequestOptions% extends RequestOptions% { maxRetries?: number }',
    old: 'options?: RequestOptions%',
    new: 'options?: RetryRequestOptions%',
    expected: SOFT_RISK,
  },
  {
    name: 'the new type extends the old one and adds a required member',
    shared: 'export interface RequestOptions% { timeout?: number }',
    newOnly: 'export interface RetryRequestOptions% extends RequestOptions% { retryKey: string }',
    old: 'options?: RequestOptions%',
    new: 'options?: RetryRequestOptions%',
    expected: BREAKING,
  },
  {
    // `get(id, { maxRetries: 2 })` no longer compiles: TS2353.
    name: 'the old type extends the new one and has a member of its own',
    shared:
      'export interface BaseOptions% { timeout?: number }\nexport interface RetryOptions% extends BaseOptions% { maxRetries?: number }',
    old: 'options?: RetryOptions%',
    new: 'options?: BaseOptions%',
    expected: BREAKING,
  },
  {
    name: 'the old type extends the new one and adds no member',
    shared:
      'export interface BaseOptions% { timeout?: number }\nexport interface RetryOptions% extends BaseOptions% {}',
    old: 'options?: RetryOptions%',
    new: 'options?: BaseOptions%',
    expected: SOFT_RISK,
  },
  {
    name: 'the old type extends the new one through a chain and adds no member',
    shared:
      'export interface BaseOptions% { timeout?: number }\nexport interface MidOptions% extends BaseOptions% {}\nexport interface RetryOptions% extends MidOptions% {}',
    old: 'options?: RetryOptions%',
    new: 'options?: BaseOptions%',
    expected: SOFT_RISK,
  },
  {
    // The declaration vouches for the member's type, which a compiler checked.
    name: 'the old type extends the new one and only narrows a member',
    shared:
      "export interface BaseOptions% { mode?: string }\nexport interface StrictOptions% extends BaseOptions% { mode?: 'fast' | 'slow' }",
    old: 'options?: StrictOptions%',
    new: 'options?: BaseOptions%',
    expected: SOFT_RISK,
  },
  {
    // Without it, a literal type is not read as its primitive would take it.
    name: 'the same two shapes without the extends clause',
    shared:
      "export interface BaseOptions% { mode?: string }\nexport interface StrictOptions% { mode?: 'fast' | 'slow' }",
    old: 'options?: StrictOptions%',
    new: 'options?: BaseOptions%',
    expected: BREAKING,
  },
  swap('the same fields under another name', 'timeout?: number', 'timeout?: number', SOFT_RISK),
  swap('an optional member added', 'timeout?: number', 'timeout?: number; maxRetries?: number', SOFT_RISK),
  swap('a required member added', 'timeout?: number', 'timeout?: number; retryKey: string', BREAKING),
  swap('a member made optional', 'name: string', 'name?: string', SOFT_RISK),
  swap('a member made required', 'name?: string', 'name: string', BREAKING),
  swap('a member retyped', 'timeout?: number', 'timeout?: string', BREAKING),
  swap('a member widened', 'timeout?: number', 'timeout?: number | string', SOFT_RISK),
  swap('a member narrowed', 'timeout?: number | string', 'timeout?: number', BREAKING),
  swap('an optional member dropped', 'timeout?: number; maxRetries?: number', 'timeout?: number', BREAKING),
  swap('a required member dropped', 'name: string; timeout?: number', 'timeout?: number', BREAKING),
  swap('a member renamed', 'timeout?: number', 'timeoutMs?: number', BREAKING),
  swap('a readonly member made writable', 'readonly timeout?: number', 'timeout?: number', SOFT_RISK),
  swap(
    'an optional method kept',
    'retry?(attempt: number): void',
    'retry?(attempt: number): void; timeout?: number',
    SOFT_RISK,
  ),
  swap("a quoted member's name", "'content-type'?: string", "'content-type'?: string; accept?: string", SOFT_RISK),
  swap("a union member's order", "order?: 'asc' | 'desc'", "order?: 'desc' | 'asc'", SOFT_RISK),
  swap('a union member gains a member', "order?: 'asc' | 'desc'", "order?: 'asc' | 'desc' | 'none'", SOFT_RISK),
  swap('a union member loses a member', "order?: 'asc' | 'desc'", "order?: 'asc'", BREAKING),
  // `exactOptionalPropertyTypes` refuses `{ name: undefined }` for `name?: string`.
  swap('a member that may be undefined made optional', 'name: string | undefined', 'name?: string', BREAKING),
  swap('an optional member made one that may be undefined', 'name?: string', 'name: string | undefined', BREAKING),
  // A type without members takes any object: nothing says what callers pass.
  swap('an old type without members', '', 'timeout?: number', BREAKING),
  swap('a new type without members', 'timeout?: number', '', BREAKING),
  {
    name: 'a nested type that gains an optional member',
    shared: `export interface Retry% { max?: number }\n${OLD('retry?: Retry%')}`,
    newOnly: `export interface Retry2% { max?: number; delay?: number }\n${NEW('retry?: Retry2%')}`,
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: SOFT_RISK,
  },
  {
    name: 'a nested type that loses a member',
    shared: `export interface Retry% { max?: number; delay?: number }\n${OLD('retry?: Retry%')}`,
    newOnly: `export interface Retry2% { max?: number }\n${NEW('retry?: Retry2%')}`,
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    // Not settled: the two types come back to their own pair through a member.
    name: 'types that refer to themselves',
    shared: OLD('children?: OldOptions%[]; depth?: number'),
    newOnly: NEW('children?: NewOptions%[]; depth?: number; label?: string'),
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
]);

retypes('#752 however a TypeScript type is declared', [
  {
    name: 'object type aliases',
    shared: 'export type OldOptions% = { timeout?: number };',
    newOnly: 'export type NewOptions% = { timeout?: number; maxRetries?: number };',
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: SOFT_RISK,
  },
  {
    name: 'object type aliases, a member dropped',
    shared: 'export type OldOptions% = { timeout?: number; maxRetries?: number };',
    newOnly: 'export type NewOptions% = { timeout?: number };',
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    name: 'an intersection alias of the old type with optional members',
    shared: 'export interface RequestOptions% { timeout?: number }',
    newOnly: 'export type RetryRequestOptions% = RequestOptions% & { maxRetries?: number };',
    old: 'options: RequestOptions%',
    new: 'options: RetryRequestOptions%',
    expected: SOFT_RISK,
  },
  {
    name: 'an intersection alias of the old type with a required member',
    shared: 'export interface RequestOptions% { timeout?: number }',
    newOnly: 'export type RetryRequestOptions% = RequestOptions% & { retryKey: string };',
    old: 'options: RequestOptions%',
    new: 'options: RetryRequestOptions%',
    expected: BREAKING,
  },
  {
    name: 'an interface to an alias with the same members',
    shared: OLD('timeout?: number'),
    newOnly: 'export type NewOptions% = { timeout?: number };',
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: SOFT_RISK,
  },
  {
    // The checker prints the old type's name for its alias: no change of text.
    name: 'an alias of the old type by another name',
    shared: 'export interface RequestOptions% { timeout?: number }\nexport type Options% = RequestOptions%;',
    old: 'options: Options%',
    new: 'options: RequestOptions%',
    expected: UNREPORTED,
  },
  {
    name: 'object types written in place, an optional member added',
    old: 'options: { timeout?: number }',
    new: 'options: { timeout?: number; maxRetries?: number }',
    expected: SOFT_RISK,
  },
  {
    name: 'object types written in place, a required member added',
    old: 'options: { timeout?: number }',
    new: 'options: { timeout?: number; retryKey: string }',
    expected: BREAKING,
  },
  {
    name: 'object types written in place, a member dropped',
    old: 'options: { timeout?: number; maxRetries?: number }',
    new: 'options: { timeout?: number }',
    expected: BREAKING,
  },
  {
    name: 'object types written in place, a member of a nested one added',
    old: 'options: { filter?: { name?: string } }',
    new: 'options: { filter?: { name?: string; tag?: string } }',
    expected: SOFT_RISK,
  },
  {
    name: 'a declared type to the same shape written in place, with an optional member more',
    shared: 'export interface RequestOptions% { timeout?: number }',
    old: 'options: RequestOptions%',
    new: 'options: { timeout?: number; maxRetries?: number }',
    expected: SOFT_RISK,
  },
  {
    name: 'a shape written in place to a declared type with every member of it',
    newOnly: 'export interface RequestOptions% { timeout?: number; maxRetries?: number }',
    old: 'options: { timeout?: number }',
    new: 'options: RequestOptions%',
    expected: SOFT_RISK,
  },
  {
    name: 'a destructured parameter',
    shared: 'export interface RequestOptions% { timeout?: number }',
    newOnly: 'export interface RetryRequestOptions% extends RequestOptions% { maxRetries?: number }',
    old: '{ timeout }: RequestOptions%',
    new: '{ timeout, maxRetries }: RetryRequestOptions%',
    expected: SOFT_RISK,
  },
  {
    // A class's properties carry no optionality in the surface.
    name: 'classes with the same members',
    shared: 'export declare class OldOptions% { timeout?: number }',
    newOnly: 'export declare class NewOptions% { timeout?: number; maxRetries?: number }',
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    // `get({ anything: 1 })` compiles against the old type alone.
    name: 'an interface that takes any key, to one that does not',
    shared: OLD('timeout?: number; [key: string]: unknown'),
    newOnly: NEW('timeout?: number; maxRetries?: number'),
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    name: 'an interface that inherits an index signature',
    shared: `export interface Open% { [key: string]: unknown }\nexport interface OldOptions% extends Open% { timeout?: number }`,
    newOnly: NEW('timeout?: number'),
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    name: 'an object alias that takes any key',
    shared: 'export type OldOptions% = { timeout?: number; [key: string]: unknown };',
    newOnly: 'export type NewOptions% = { timeout?: number };',
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    name: 'a `Record<string, string>` alias to an interface',
    shared: 'export type OldOptions% = Record<string, string>;',
    newOnly: NEW('timeout?: string'),
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    name: 'an object type written in place that takes any key',
    old: 'options: { timeout?: number; [key: string]: unknown }',
    new: 'options: { timeout?: number }',
    expected: BREAKING,
  },
  {
    name: 'an interface with a call signature',
    shared: OLD('(attempt: number): void; timeout?: number'),
    newOnly: NEW('timeout?: number'),
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    // What `Partial<…>` contributes is not a type the snapshot records by name.
    name: 'a new type that extends an instantiation',
    shared: OLD('timeout?: number'),
    newOnly: 'export interface NewOptions% extends Partial<{ timeout: number; maxRetries: number }> {}',
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
]);

retypes('#752 what stands around the type of a TypeScript parameter', [
  swap('an array of each', 'timeout?: number', 'timeout?: number; maxRetries?: number', SOFT_RISK, 'options: %%[]'),
  swap(
    'an array of arrays of each',
    'timeout?: number',
    'timeout?: number; maxRetries?: number',
    SOFT_RISK,
    'options: %%[][]',
  ),
  swap(
    'an array of each, a member dropped',
    'timeout?: number; maxRetries?: number',
    'timeout?: number',
    BREAKING,
    'options: %%[]',
  ),
  swap(
    'a rest parameter of each',
    'timeout?: number',
    'timeout?: number; maxRetries?: number',
    SOFT_RISK,
    '...options: %%[]',
  ),
  {
    ...swap('a type to an array of the new one', 'timeout?: number', 'timeout?: number; maxRetries?: number', BREAKING),
    new: 'options: NewOptions%[]',
  },
  {
    ...swap('an array to its element', 'timeout?: number', 'timeout?: number; maxRetries?: number', BREAKING),
    old: 'options: OldOptions%[]',
  },
  {
    ...swap(
      'a type to a promise of the new one',
      'timeout?: number',
      'timeout?: number; maxRetries?: number',
      BREAKING,
    ),
    new: 'options: Promise<NewOptions%>',
  },
  // A generic's argument is not read into: whether a `Box<Old>` is taken
  // where a `Box<New>` is expected depends on how `Box` uses it.
  swap(
    'a promise of each',
    'timeout?: number',
    'timeout?: number; maxRetries?: number',
    BREAKING,
    'options: Promise<%%>',
  ),
  swap(
    'a record of each',
    'timeout?: number',
    'timeout?: number; maxRetries?: number',
    BREAKING,
    'options: Record<string, %%>',
  ),
  swap('Partial of each', 'timeout: number', 'timeout: number; maxRetries: number', BREAKING, 'options: Partial<%%>'),
  swap(
    'a tuple with each',
    'timeout?: number',
    'timeout?: number; maxRetries?: number',
    BREAKING,
    'options: [%%, string]',
  ),
  swap(
    'a readonly array of each',
    'timeout?: number',
    'timeout?: number; maxRetries?: number',
    BREAKING,
    'options: readonly %%[]',
  ),
  // `(value: Old) => void` is not a `(value: New) => void` when `New` takes more.
  swap('a callback handed each', 'name: string', 'name?: string', BREAKING, 'handle: (value: %%) => void'),
  swap(
    'a callback returning each',
    'timeout?: number',
    'timeout?: number; maxRetries?: number',
    BREAKING,
    'make: () => %%',
  ),
  swap(
    'beside another member of a union',
    'timeout?: number',
    'timeout?: number; maxRetries?: number',
    SOFT_RISK,
    'options: %% | string',
  ),
  swap(
    'an optional parameter on both sides',
    'timeout?: number',
    'timeout?: number; maxRetries?: number',
    SOFT_RISK,
    'options?: %%',
  ),
  {
    ...swap(
      'the parameter becomes optional as well',
      'timeout?: number',
      'timeout?: number; maxRetries?: number',
      SOFT_RISK,
    ),
    new: 'options?: NewOptions%',
  },
  {
    // `undefined` is no longer taken; `parameter_requiredness_increased` says so too.
    ...swap(
      'the parameter becomes required as well',
      'timeout?: number',
      'timeout?: number; maxRetries?: number',
      BREAKING,
    ),
    old: 'options?: OldOptions%',
  },
]);

retypes('#752 a TypeScript parameter whose union changed', [
  { name: 'gains a member', old: 'petId: string', new: 'petId: string | number', expected: SOFT_RISK },
  { name: 'loses a member', old: 'petId: string | number', new: 'petId: string', expected: BREAKING },
  { name: 'becomes nullable', old: 'petId: string', new: 'petId: string | null', expected: SOFT_RISK },
  { name: 'is no longer nullable', old: 'petId: string | null', new: 'petId: string', expected: BREAKING },
  { name: 'becomes optional', old: 'petId: string', new: 'petId?: string', expected: SOFT_RISK },
  { name: 'is no longer optional', old: 'petId?: string', new: 'petId: string', expected: BREAKING },
  {
    name: 'takes `undefined` in place of `null`',
    old: 'petId: string | null',
    new: 'petId: string | undefined',
    expected: BREAKING,
  },
  {
    name: 'swaps one member for another',
    old: 'petId: string | number',
    new: 'petId: string | boolean',
    expected: BREAKING,
  },
  // The checker prints a union's members in one order.
  {
    name: 'is written in another order',
    old: 'petId: string | number',
    new: 'petId: number | string',
    expected: UNREPORTED,
  },
  {
    name: 'of literals gains a member',
    old: "order: 'asc' | 'desc'",
    new: "order: 'asc' | 'desc' | 'none'",
    expected: SOFT_RISK,
  },
  { name: 'of literals loses a member', old: "order: 'asc' | 'desc'", new: "order: 'asc'", expected: BREAKING },
  { name: 'in an array gains a member', old: 'ids: string[]', new: 'ids: (string | number)[]', expected: SOFT_RISK },
  { name: 'in an array loses a member', old: 'ids: (string | number)[]', new: 'ids: string[]', expected: BREAKING },
  {
    name: 'gains `undefined` beside a callback',
    old: 'done: () => void',
    new: 'done?: () => void',
    expected: SOFT_RISK,
  },
  // Not read into, though `tsc` takes each: a literal by its primitive,
  // anything by `unknown`, a callback by what it returns.
  {
    name: 'of literals becomes their primitive',
    old: "order: 'asc' | 'desc'",
    new: 'order: string',
    expected: BREAKING,
  },
  { name: 'becomes `unknown`', old: 'petId: string', new: 'petId: unknown', expected: BREAKING },
  {
    name: 'in what a callback returns gains a member',
    old: 'make: () => string',
    new: 'make: () => string | number',
    expected: BREAKING,
  },
  {
    name: 'in what a callback returns loses a member',
    old: 'make: () => string | number',
    new: 'make: () => string',
    expected: BREAKING,
  },
  {
    name: 'in what a callback is handed gains a member',
    old: 'handle: (value: string) => void',
    new: 'handle: (value: string | number) => void',
    expected: BREAKING,
  },
]);

retypes('#752 a TypeScript parameter typed by a type alias of a union', [
  {
    name: 'an alias of a primitive, widened in place',
    shared: 'export type PetId% = string;',
    old: 'petId: PetId%',
    new: 'petId: string | number',
    expected: SOFT_RISK,
  },
  {
    name: 'a primitive to an alias of a union that has it',
    newOnly: 'export type PetId% = string | number;',
    old: 'petId: string',
    new: 'petId: PetId%',
    expected: SOFT_RISK,
  },
  {
    name: 'an alias of a union to one of its members',
    shared: 'export type PetId% = string | number;',
    old: 'petId: PetId%',
    new: 'petId: string',
    expected: BREAKING,
  },
  {
    name: 'an alias to an alias with one more member',
    shared: 'export type PetId% = string;',
    newOnly: 'export type AnyId% = string | number;',
    old: 'petId: PetId%',
    new: 'petId: AnyId%',
    expected: SOFT_RISK,
  },
  {
    name: 'an alias of a union with a declared type',
    shared:
      'export interface RequestOptions% { timeout?: number }\nexport type AnyOptions% = RequestOptions% | string;',
    newOnly: 'export interface RetryRequestOptions% extends RequestOptions% { maxRetries?: number }',
    old: 'options: AnyOptions%',
    new: 'options: RetryRequestOptions% | string',
    expected: SOFT_RISK,
  },
  {
    // Callers pass `5` today; the alias they named and the parameter both
    // narrow to `string`.
    name: 'an alias the new SDK narrows, replaced by what it now stands for',
    oldOnly: 'export type PetId% = string | number;',
    newOnly: 'export type PetId% = string;',
    old: 'petId: PetId%',
    new: 'petId: string',
    expected: BREAKING,
  },
  {
    // A long union under a name is recorded whole.
    name: 'an alias of forty literals to one of forty-one',
    shared: `export type Order% = ${Array.from({ length: 40 }, (_, index) => `'value_number_${index}'`).join(' | ')};`,
    newOnly: `export type WiderOrder% = ${Array.from({ length: 41 }, (_, index) => `'value_number_${index}'`).join(' | ')};`,
    old: 'order: Order%',
    new: 'order: WiderOrder%',
    expected: SOFT_RISK,
  },
  {
    // Written in place it is cut short (`... 34 more ...`), and what was
    // left out of the old one may be missing from the new one.
    name: 'forty literals in place to forty-one',
    old: `order: ${Array.from({ length: 40 }, (_, index) => `'value_number_${index}'`).join(' | ')}`,
    new: `order: ${Array.from({ length: 41 }, (_, index) => `'value_number_${index}'`).join(' | ')}`,
    expected: BREAKING,
  },
]);

retypes('#752 a TypeScript parameter whose old type changes in the same release', [
  {
    // Code that names `OldOptions` and sets `tag` no longer passes.
    name: 'the old type gains an optional member the new one types otherwise',
    oldOnly: OLD('timeout?: number'),
    newOnly: `${OLD('timeout?: number; tag?: string')}\n${NEW('timeout?: number; tag?: number')}`,
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    // A variable of the old type may now lack the `name` the new type requires.
    name: 'the old type makes a member optional that the new one requires',
    oldOnly: OLD('name: string'),
    newOnly: `${OLD('name?: string')}\n${NEW('name: string')}`,
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: BREAKING,
  },
  {
    name: 'the old type gains an optional member the new one has too',
    oldOnly: OLD('timeout?: number'),
    newOnly: `${OLD('timeout?: number; tag?: string')}\n${NEW('timeout?: number; tag?: string')}`,
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: SOFT_RISK,
  },
  {
    // The removal is its own breaking line; what callers pass still fits.
    name: 'the old type is removed',
    oldOnly: OLD('timeout?: number'),
    newOnly: NEW('timeout?: number; maxRetries?: number'),
    old: 'options: OldOptions%',
    new: 'options: NewOptions%',
    expected: SOFT_RISK,
  },
]);

describe('#752 a method with two retyped parameters', () => {
  it('weighs each retyped parameter of a method on its own', async () => {
    const sdk = (petId: string, options: string) => `export interface RequestOptions { timeout?: number }
export interface RetryRequestOptions extends RequestOptions { maxRetries?: number }
export declare class PetsClient { get(petId: ${petId}, options?: ${options}): Promise<string>; }
`;
    const { diff } = await compatDiff(
      nodeExtractor,
      nodeSdk(sdk('string | number', 'RequestOptions')),
      nodeSdk(sdk('string', 'RetryRequestOptions')),
    );
    expect(diff.changes.map((change) => `${change.severity} ${change.old.parameter}`)).toEqual([
      'breaking petId',
      'soft-risk options',
    ]);
    expect(exitCode(diff)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The other languages
// ---------------------------------------------------------------------------

/** A PHP SDK: value objects with promoted properties, and `PetsClient::get`. */
const phpSdk = (classes: Record<string, { promoted: string[]; base?: string }>, petId: string, options: string) => ({
  'lib/Pet.php': phpClass('Pet', ['public readonly string $id']),
  ...Object.fromEntries(
    Object.entries(classes).map(([name, { promoted, base }]) => [`lib/${name}.php`, phpClass(name, promoted, base)]),
  ),
  'lib/PetsClient.php': phpClient(petId, options),
});
const PHP_TIMEOUT = 'public readonly ?int $timeout = null';
const PHP_RETRIES = 'public readonly ?int $maxRetries = null';
const PHP_OPTIONS = {
  BaseOptions: { promoted: [PHP_TIMEOUT] },
  RetryOptions: { promoted: [PHP_TIMEOUT, PHP_RETRIES], base: 'BaseOptions' },
  OtherOptions: { promoted: [PHP_TIMEOUT, PHP_RETRIES] },
};

/** A Python SDK: pydantic models, and `PetsClient.get`. */
const pythonSdk = (models: string, petId: string, options: string): Record<string, string> => ({
  'src/petstore/__init__.py': 'from .models import *\nfrom .client import *\n',
  'src/petstore/models.py': `from pydantic import BaseModel


class Pet(BaseModel):
    id: str

${models}`,
  'src/petstore/client.py': `from .models import *


class PetsClient:
    def get(self, pet_id: ${petId}, options: ${options}) -> Pet:
        raise NotImplementedError
`,
});
const PYTHON_OPTIONS = `
class BaseOptions(BaseModel):
    timeout: int | None = None


class RetryOptions(BaseOptions):
    max_retries: int | None = None


class OtherOptions(BaseModel):
    timeout: int | None = None
    max_retries: int | None = None
`;

describe('#752 a parameter of a class type, where a value is accepted as what it was declared', () => {
  const pythonModels = createPythonExtractor({ modelBaseClasses: ['BaseModel'] });
  const php = (petId: string, options: string) => phpSdk(PHP_OPTIONS, petId, options);
  const python = (petId: string, options: string) => pythonSdk(PYTHON_OPTIONS, petId, options);
  const GET = (severity: string) => [`${severity} parameter_type_narrowed PetsClient.get`];

  it.each<[string, Extractor, Record<string, string>, Record<string, string>, string[]]>([
    // PHP: a class's base is its supertype.
    [
      'php: to the class the old one extends',
      phpExtractor,
      php('string', '?RetryOptions'),
      php('string', '?BaseOptions'),
      GET(SOFT_RISK),
    ],
    [
      'php: the same, a required parameter',
      phpExtractor,
      php('string', 'RetryOptions'),
      php('string', 'BaseOptions'),
      GET(SOFT_RISK),
    ],
    [
      'php: to a class that extends the old one',
      phpExtractor,
      php('string', '?BaseOptions'),
      php('string', '?RetryOptions'),
      GET(BREAKING),
    ],
    [
      'php: to a class with the same properties',
      phpExtractor,
      php('string', '?RetryOptions'),
      php('string', '?OtherOptions'),
      GET(BREAKING),
    ],
    [
      'php: to a class with every property and one more',
      phpExtractor,
      php('string', '?BaseOptions'),
      php('string', '?OtherOptions'),
      GET(BREAKING),
    ],
    // The retype does one thing only: the parameter also becoming nullable is another.
    [
      'php: to the base class, and nullable as well',
      phpExtractor,
      php('string', 'RetryOptions'),
      php('string', '?BaseOptions'),
      GET(BREAKING),
    ],
    [
      'php: to the base class, no longer nullable',
      phpExtractor,
      php('string', '?RetryOptions'),
      php('string', 'BaseOptions'),
      ['breaking parameter_requiredness_increased PetsClient.get', ...GET(BREAKING)],
    ],
    // A union that kept every member is the shape rule's, which PHP is not asked.
    [
      'php: a union gains a member',
      phpExtractor,
      php('string', '?BaseOptions'),
      php('string|int', '?BaseOptions'),
      GET(BREAKING),
    ],
    [
      'php: becomes nullable',
      phpExtractor,
      php('string', '?BaseOptions'),
      php('?string', '?BaseOptions'),
      GET(BREAKING),
    ],
    // Python: a model's base is read once the extractor is told what a model is.
    [
      'python models: to the model the old one extends',
      pythonModels,
      python('str', 'RetryOptions | None = None'),
      python('str', 'BaseOptions | None = None'),
      GET(SOFT_RISK),
    ],
    [
      'python models: the same, spelled `Optional[…]`',
      pythonModels,
      python('str', 'Optional[RetryOptions] = None'),
      python('str', 'Optional[BaseOptions] = None'),
      GET(SOFT_RISK),
    ],
    [
      'python models: to a model that extends the old one',
      pythonModels,
      python('str', 'BaseOptions | None = None'),
      python('str', 'RetryOptions | None = None'),
      GET(BREAKING),
    ],
    [
      'python models: to a model with the same fields',
      pythonModels,
      python('str', 'RetryOptions | None = None'),
      python('str', 'OtherOptions | None = None'),
      GET(BREAKING),
    ],
    // A `list` is written to as well as read: a list of the subclass is not one of the base.
    [
      'python models: a list of each',
      pythonModels,
      python('str', 'list[RetryOptions]'),
      python('str', 'list[BaseOptions]'),
      GET(BREAKING),
    ],
    [
      'python models: a union gains a member',
      pythonModels,
      python('str', 'BaseOptions'),
      python('str | int', 'BaseOptions'),
      GET(BREAKING),
    ],
    // As registered, the Python extractor reads no supertype.
    [
      'python: to the model the old one extends',
      pythonExtractor,
      python('str', 'RetryOptions | None = None'),
      python('str', 'BaseOptions | None = None'),
      GET(BREAKING),
    ],
  ])('%s', async (_, extractor, oldFiles, newFiles, expected) => {
    expect(notAdditive((await compatDiff(extractor, oldFiles, newFiles)).diff)).toEqual(expected);
  });

  it('names the two types in the hint', async () => {
    const { report, exitCode: exit } = await compatDiff(
      phpExtractor,
      php('string', '?RetryOptions'),
      php('string', '?BaseOptions'),
    );
    expect(report).toMatchInlineSnapshot(`
      "Compat report:
        0 breaking, 1 soft-risk, 0 additive

        Soft-risk:
          [parameter_type_narrowed] PetsClient.get — Parameter type changed for "options" on "PetsClient.get"
            hint: Parameter type swap from "RetryOptions" to "BaseOptions" widens to a declared supertype — "RetryOptions" extends "BaseOptions", so every value callers pass today is still accepted. Call sites continue to work; only code that overrides or implements the method has to take "BaseOptions"."
    `);
    expect(exit).toBe(0);
  });

  it('does not read a PHP class that declares no property of its own as a subclass', async () => {
    // The PHP surface records such a class as a plain class, without a base.
    const classes = {
      BaseOptions: { promoted: [PHP_TIMEOUT] },
      EmptyOptions: { promoted: ['?int $timeout = null'], base: 'BaseOptions' },
    };
    const { candidate, diff } = await compatDiff(
      phpExtractor,
      phpSdk(classes, 'string', '?EmptyOptions'),
      phpSdk(classes, 'string', '?BaseOptions'),
    );
    expect(candidate.symbols.find((sym) => sym.fqName === 'EmptyOptions')?.extends).toBeUndefined();
    expect(notAdditive(diff)).toEqual(GET(BREAKING));
  });
});

/** One SDK per language that records parameter types but no supertype. */
const UNTYPED_SUPERTYPES: Array<
  [string, Extractor, (options: string) => Record<string, string>, string, string, string]
> = [
  [
    'go',
    goExtractor,
    (options) => ({
      'go.mod': 'module github.com/example/petstore\n\ngo 1.21\n',
      'pkg/pets/client.go': `package pets

import "context"

// Client performs Pet requests.
type Client struct {
	APIKey string
}

// BaseOptions holds options.
type BaseOptions struct {
	Timeout *int \`json:"timeout,omitempty"\`
}

// RetryOptions holds options.
type RetryOptions struct {
	BaseOptions
	MaxRetries *int \`json:"max_retries,omitempty"\`
}

// GetPet gets a Pet.
func (c *Client) GetPet(ctx context.Context, petId string, opts ${options}) (string, error) {
	return "", nil
}
`,
    }),
    'RetryOptions',
    'BaseOptions',
    'Client.GetPet',
  ],
  [
    'kotlin',
    kotlinExtractor,
    (options) => ({
      'src/main/kotlin/com/petstore/models/BaseOptions.kt':
        'package com.petstore.models\n\ndata class BaseOptions(\n    val timeout: Int? = null\n)\n',
      'src/main/kotlin/com/petstore/models/RetryOptions.kt':
        'package com.petstore.models\n\ndata class RetryOptions(\n    val maxRetries: Int? = null\n) : BaseOptions()\n',
      'src/main/kotlin/com/petstore/PetsApi.kt': `package com.petstore

class PetsApi(private val client: Any) {
    fun getPet(petId: String, options: ${options}): String {
        throw NotImplementedError()
    }
}
`,
    }),
    'RetryOptions',
    'BaseOptions',
    'PetsApi.getPet',
  ],
  [
    'dotnet',
    dotnetExtractor,
    (options) => ({
      'src/Petstore/Models.cs': `using Newtonsoft.Json;

namespace Petstore
{
    public class BaseOptions
    {
        [JsonProperty("timeout")]
        public int? Timeout { get; set; }
    }

    public class RetryOptions : BaseOptions
    {
        [JsonProperty("max_retries")]
        public int? MaxRetries { get; set; }
    }
}
`,
      'src/Petstore/PetService.cs': `using System.Threading.Tasks;

namespace Petstore
{
    public class PetService
    {
        public async Task<string> GetPetAsync(string petId, ${options} options)
        {
            throw new NotImplementedException();
        }
    }
}
`,
    }),
    'RetryOptions',
    'BaseOptions',
    'PetService.GetPetAsync',
  ],
  [
    'rust',
    rustExtractor,
    (options) => ({
      'src/lib.rs': 'pub mod client;\npub mod models;\n',
      'src/models.rs': `use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseOptions {
    pub timeout: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryOptions {
    #[serde(flatten)]
    pub base: BaseOptions,
    pub max_retries: Option<i64>,
}
`,
      'src/client.rs': `use crate::models::*;

pub struct Petstore {
    pub api_key: String,
}

impl Petstore {
    pub async fn get_pet(&self, pet_id: &str, opts: ${options}) -> Result<String, PetstoreError> {
        todo!()
    }
}
`,
    }),
    'RetryOptions',
    'BaseOptions',
    'Petstore.get_pet',
  ],
  [
    'ios',
    iosExtractor,
    (options) => ({
      'Sources/Petstore/Models/Models.swift': `import Foundation

public struct BaseOptions: Codable, Sendable {
    public let timeout: Int?
}

public struct RetryOptions: Codable, Sendable {
    public let base: BaseOptions
    public let maxRetries: Int?
}
`,
      'Sources/Petstore/Resources/Pets.swift': `import Foundation

public struct Pets: Sendable {
    let transport: Transport

    public func getPet(
        petId: String,
        options: ${options}
    ) async throws -> String {
        fatalError()
    }
}
`,
    }),
    'RetryOptions',
    'BaseOptions',
    'Pets.getPet',
  ],
];

describe('#752 the extractors that record no supertype', () => {
  it.each(UNTYPED_SUPERTYPES)(
    '%s: a parameter retyped to the type the old one is built on stays breaking, and so does the reverse',
    async (_, extractor, sdk, subtype, supertype, method) => {
      const widened = await compatDiff(extractor, sdk(subtype), sdk(supertype));
      expect(widened.baseline.policies.parameterTypesAreStructural).toBe(false);
      expect(notAdditive(widened.diff)).toEqual([`breaking parameter_type_narrowed ${method}`]);
      expect(widened.diff.changes[0].old.type).toContain(subtype);
      const narrowed = await compatDiff(extractor, sdk(supertype), sdk(subtype));
      expect(notAdditive(narrowed.diff)).toEqual([`breaking parameter_type_narrowed ${method}`]);
    },
  );

  it.each<[string, Extractor, Record<string, string>, Record<string, string>]>([
    [
      'ruby',
      rubyExtractor,
      {
        'lib/petstore.rb': "module Petstore\n  autoload :Pets, 'petstore/pets'\nend\n",
        'lib/petstore/pets.rb':
          'module Petstore\n  module Pets\n    class << self\n      # @param options [RetryOptions]\n      def get_pet(pet_id, options)\n      end\n    end\n  end\nend\n',
      },
      {
        'lib/petstore.rb': "module Petstore\n  autoload :Pets, 'petstore/pets'\nend\n",
        'lib/petstore/pets.rb':
          'module Petstore\n  module Pets\n    class << self\n      # @param options [BaseOptions]\n      def get_pet(pet_id, options)\n      end\n    end\n  end\nend\n',
      },
    ],
    [
      'elixir',
      elixirExtractor,
      {
        'lib/petstore/pets/pets.ex':
          'defmodule Petstore.Pets do\n  @spec get_pet(pet_id :: String.t(), options :: RetryOptions.t()) :: {:ok, map()}\n  def get_pet(pet_id, options) do\n    {:ok, {pet_id, options}}\n  end\nend\n',
      },
      {
        'lib/petstore/pets/pets.ex':
          'defmodule Petstore.Pets do\n  @spec get_pet(pet_id :: String.t(), options :: BaseOptions.t()) :: {:ok, map()}\n  def get_pet(pet_id, options) do\n    {:ok, {pet_id, options}}\n  end\nend\n',
      },
    ],
  ])('%s: records no parameter type, so reports no retype', async (_, extractor, oldFiles, newFiles) => {
    const { baseline, diff } = await compatDiff(extractor, oldFiles, newFiles);
    expect(baseline.symbols.some((sym) => sym.parameters?.length)).toBe(true);
    expect(lines(diff)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

const symbol = (kind: CompatSymbol['kind'], fqName: string, extra: Partial<CompatSymbol> = {}): CompatSymbol => ({
  id: `${kind}:${fqName}`,
  kind,
  fqName,
  displayName: fqName,
  visibility: 'public',
  stability: 'stable',
  sourceKind: 'generated_resource_constructor',
  ...extra,
});
/** An object type with its fields: `name: 'type'`, or `'?type'` when optional. */
const objectType = (
  name: string,
  fields: Record<string, string>,
  extra: Partial<CompatSymbol> = {},
): CompatSymbol[] => [
  symbol('alias', name, { extends: [], hasUnlistedMembers: false, ...extra }),
  ...Object.entries(fields).map(([fieldName, text]) =>
    symbol('field', `${name}.${fieldName}`, {
      ownerFqName: name,
      typeRef: { name: text.startsWith('?') ? text.slice(1) : text },
      optional: text.startsWith('?'),
    }),
  ),
];
const get = (...parameterTypes: string[]): CompatSymbol =>
  symbol('callable', 'PetsClient.get', {
    ownerFqName: 'PetsClient',
    parameters: parameterTypes.map((name, position) => ({
      publicName: `p${position}`,
      position,
      required: true,
      nullable: false,
      hasDefault: false,
      passing: 'positional' as const,
      type: { name },
      sensitivity: { order: true, publicName: false, requiredness: true, type: true },
    })),
  });
const snapshot = (
  policies: CompatSnapshot['policies'],
  ...symbols: Array<CompatSymbol | CompatSymbol[]>
): CompatSnapshot => ({
  schemaVersion: '1',
  source: { extractedAt: '2026-01-01T00:00:00.000Z' },
  policies,
  symbols: [symbol('service_accessor', 'PetsClient'), ...symbols.flat()],
});
const severities = (diff: CompatDiffResult): string[] =>
  diff.changes.filter((change) => change.category === 'parameter_type_narrowed').map((change) => change.severity);

/** Two types, each a declared supertype of the next and with one optional field more. */
const BASE = objectType('BaseOptions', { timeout: '?number' });
const RETRY = objectType('RetryOptions', { timeout: '?number', maxRetries: '?number' }, { extends: ['BaseOptions'] });

describe('#752 `parameterTypesAreStructural` decides which rule is asked', () => {
  const NODE = getDefaultPolicy('node');
  const PHP = getDefaultPolicy('php');
  const { parameterTypesAreStructural: _unstated, ...BEFORE_THE_KEY } = NODE;
  const diff = (
    policies: CompatSnapshot['policies'],
    oldTypes: string[],
    newTypes: string[],
    passed?: CompatSnapshot['policies'],
  ) =>
    severities(
      diffSnapshots(
        snapshot(policies, get(...oldTypes), BASE, RETRY),
        snapshot(policies, get(...newTypes), BASE, RETRY),
        passed,
      ),
    );

  // Three retypes: to a type with an optional field more, to a declared
  // supertype with a field less, and to a union with a member more.
  const ADDS_A_FIELD: [string[], string[]] = [['BaseOptions'], ['RetryOptions']];
  const TO_THE_SUPERTYPE: [string[], string[]] = [['RetryOptions'], ['BaseOptions']];
  const ADDS_A_MEMBER: [string[], string[]] = [['string'], ['string | number']];

  it('asks the shape rule under a policy that says `true`', () => {
    expect(diff(NODE, ...ADDS_A_FIELD)).toEqual(['soft-risk']);
    expect(diff(NODE, ...TO_THE_SUPERTYPE)).toEqual(['breaking']);
    expect(diff(NODE, ...ADDS_A_MEMBER)).toEqual(['soft-risk']);
  });

  it('asks the declared rule under a policy that says `false`', () => {
    expect(diff(PHP, ...ADDS_A_FIELD)).toEqual(['breaking']);
    expect(diff(PHP, ...TO_THE_SUPERTYPE)).toEqual(['soft-risk']);
    expect(diff(PHP, ...ADDS_A_MEMBER)).toEqual(['breaking']);
  });

  it('asks neither under a policy that does not say, as every snapshot written before the key', () => {
    expect(BEFORE_THE_KEY).not.toHaveProperty('parameterTypesAreStructural');
    expect(diff(BEFORE_THE_KEY, ...ADDS_A_FIELD)).toEqual(['breaking']);
    expect(diff(BEFORE_THE_KEY, ...TO_THE_SUPERTYPE)).toEqual(['breaking']);
    expect(diff(BEFORE_THE_KEY, ...ADDS_A_MEMBER)).toEqual(['breaking']);
  });

  it('weighs a constructor parameter as a method parameter', () => {
    // A model's constructor: a service class's is not compared at all.
    const construct = (text: string): CompatSymbol => ({
      ...get(text),
      id: 'ctor:Upload',
      kind: 'constructor',
      fqName: 'Upload.constructor',
      ownerFqName: 'Upload',
    });
    const upload = objectType('Upload', {});
    const constructed = (policies: CompatSnapshot['policies'], oldText: string, newText: string) =>
      lines(
        diffSnapshots(
          snapshot(policies, construct(oldText), upload, BASE, RETRY),
          snapshot(policies, construct(newText), upload, BASE, RETRY),
        ),
      );
    expect(constructed(NODE, 'BaseOptions', 'RetryOptions')).toEqual([
      'soft-risk parameter_type_narrowed Upload.constructor',
    ]);
    expect(constructed(NODE, 'RetryOptions', 'BaseOptions')).toEqual([
      'breaking parameter_type_narrowed Upload.constructor',
    ]);
    expect(constructed(PHP, 'RetryOptions', 'BaseOptions')).toEqual([
      'soft-risk parameter_type_narrowed Upload.constructor',
    ]);
    expect(constructed(PHP, 'BaseOptions', 'RetryOptions')).toEqual([
      'breaking parameter_type_narrowed Upload.constructor',
    ]);
  });

  it('reads the policy from the baseline, or the one it is handed', () => {
    // The candidate's own policies are not read.
    const candidate = snapshot(NODE, get('string | number'));
    expect(severities(diffSnapshots(snapshot(BEFORE_THE_KEY, get('string')), candidate))).toEqual(['breaking']);
    expect(
      severities(diffSnapshots(snapshot(NODE, get('string')), snapshot(BEFORE_THE_KEY, get('string | number')))),
    ).toEqual(['soft-risk']);
    // A policy passed to the diff stands in for the baseline's.
    expect(diff(BEFORE_THE_KEY, ...ADDS_A_MEMBER, NODE)).toEqual(['soft-risk']);
    expect(diff(NODE, ...ADDS_A_MEMBER, BEFORE_THE_KEY)).toEqual(['breaking']);
    expect(diff(NODE, ...TO_THE_SUPERTYPE, PHP)).toEqual(['soft-risk']);
  });

  it.each([[null], ['true'], [1], [0], [[]], [{}]])('asks neither when the hint is %j', (stated) => {
    const odd = { ...NODE, parameterTypesAreStructural: stated as unknown as boolean };
    expect(diff(odd, ...ADDS_A_FIELD)).toEqual(['breaking']);
    expect(diff(odd, ...TO_THE_SUPERTYPE)).toEqual(['breaking']);
    expect(diff(odd, ...ADDS_A_MEMBER)).toEqual(['breaking']);
  });

  it.each([[null], [undefined], [true], ['node'], [[]]])(
    'does not throw on a baseline whose policies are %j',
    (policies) => {
      const odd = policies as unknown as CompatSnapshot['policies'];
      expect(diff(odd, ...ADDS_A_MEMBER)).toEqual(['breaking']);
      expect(diff(odd, ...ADDS_A_FIELD)).toEqual(['breaking']);
    },
  );

  it('is written into the snapshot of every extractor, with the language default', async () => {
    const node = await snapshotOf(nodeExtractor, ISSUE_OLD);
    expect(node.policies).toEqual(NODE);
    expect(node.policies.parameterTypesAreStructural).toBe(true);
    expect(validateSnapshot(JSON.parse(JSON.stringify(node)))).toBe(true);
    const php = await snapshotOf(phpExtractor, phpSdk(PHP_OPTIONS, 'string', '?BaseOptions'));
    expect(php.policies.parameterTypesAreStructural).toBe(false);
    // A language with no default states nothing.
    const plugin = apiSurfaceToSnapshot({ ...EMPTY_SURFACE, language: 'cobol' });
    expect(plugin.policies).toEqual({});
  });

  describe('`compat.languagePolicy` in `oagen verify`', () => {
    beforeAll(() => {
      registerExtractor(nodeExtractor);
      registerExtractor(phpExtractor);
    });
    const node = (options: string, petId = 'string') =>
      nodeSdk(`export interface BaseOptions { timeout?: number }
export interface RetryOptions extends BaseOptions { maxRetries?: number }
export declare class PetsClient { get(petId: ${petId}, options?: ${options}): Promise<string>; }
`);
    const verify = async (
      lang: string,
      oldFiles: Record<string, string>,
      newFiles: Record<string, string>,
      overrides?: { parameterTypesAreStructural: boolean },
    ) => {
      const extractor = lang === 'node' ? nodeExtractor : phpExtractor;
      const baseline = await extractor.extract(writeSdk(oldFiles));
      const result = await runCompatCheck(baseline, writeSdk(newFiles), lang, undefined, overrides);
      return { passed: result.passed, lines: notAdditive(result.diff) };
    };
    const GET = (severity: string) => [`${severity} parameter_type_narrowed PetsClient.get`];

    it('applies the language default', async () => {
      expect(await verify('node', node('BaseOptions'), node('RetryOptions'))).toEqual({
        passed: true,
        lines: GET(SOFT_RISK),
      });
      expect(await verify('node', node('RetryOptions'), node('BaseOptions'))).toEqual({
        passed: false,
        lines: GET(BREAKING),
      });
    });

    it('asks a Node SDK whose options are classes for a declared supertype', async () => {
      const nominal = { parameterTypesAreStructural: false };
      expect(await verify('node', node('BaseOptions'), node('RetryOptions'), nominal)).toEqual({
        passed: false,
        lines: GET(BREAKING),
      });
      expect(await verify('node', node('RetryOptions'), node('BaseOptions'), nominal)).toEqual({
        passed: true,
        lines: GET(SOFT_RISK),
      });
      expect(await verify('node', node('BaseOptions'), node('BaseOptions', 'string | number'), nominal)).toEqual({
        passed: false,
        lines: GET(BREAKING),
      });
    });

    it('reads the unions of another language by shape when told to, and no object type its extractor does not vouch for', async () => {
      const php = (petId: string, options: string) => phpSdk(PHP_OPTIONS, petId, options);
      const structural = { parameterTypesAreStructural: true };
      expect(await verify('php', php('string', '?BaseOptions'), php('string|int', '?BaseOptions'), structural)).toEqual(
        {
          passed: true,
          lines: GET(SOFT_RISK),
        },
      );
      // The PHP surface does not say a class's properties are all a value
      // may carry (`hasUnlistedMembers`), so its fields are not weighed.
      expect(await verify('php', php('string', '?BaseOptions'), php('string', '?OtherOptions'), structural)).toEqual({
        passed: false,
        lines: GET(BREAKING),
      });
      // And the declared rule is no longer asked.
      expect(await verify('php', php('string', '?RetryOptions'), php('string', '?BaseOptions'), structural)).toEqual({
        passed: false,
        lines: GET(BREAKING),
      });
    });
  });
});

const EMPTY_SURFACE: ApiSurface = {
  language: 'node',
  extractedFrom: '/sdk',
  extractedAt: '2026-01-01T00:00:00.000Z',
  classes: {},
  interfaces: {},
  typeAliases: {},
  enums: {},
  exports: {},
};

// ---------------------------------------------------------------------------
// Whether the fields are all a value may carry
// ---------------------------------------------------------------------------

describe('#752 `hasUnlistedMembers`', () => {
  it('is what the type checker says of each interface and each alias with members', async () => {
    const surface = await nodeExtractor.extract(
      writeSdk(
        nodeSdk(`export interface Plain { timeout?: number }
export interface Empty {}
export interface Indexed { timeout?: number; [key: string]: unknown }
export interface NumberIndexed { [index: number]: string }
export interface InheritsIndex extends Indexed { retries?: number }
export interface Callable { (attempt: number): void; timeout?: number }
export interface Constructible { new (attempt: number): object }
export interface ExtendsPlain extends Plain { retries?: number }
export type PlainAlias = { timeout?: number };
export type IndexedAlias = { timeout?: number; [key: string]: unknown };
export type RecordAlias = Record<string, string>;
export type KeyedRecord = Record<'a' | 'b', string>;
export type Intersection = Plain & { retries?: number };
export type IndexedIntersection = Plain & { [key: string]: unknown };
export type SymbolKeyed = { timeout?: number; [Symbol.iterator]?: () => Iterator<string> };
export type PartialAlias = Partial<Plain>;
export type Union = Plain | Indexed;
export type Text = string;
export type Other = Plain;
`),
      ),
    );
    expect(
      Object.fromEntries(Object.entries(surface.interfaces).map(([name, iface]) => [name, iface.hasUnlistedMembers])),
    ).toEqual({
      Callable: true,
      Constructible: true,
      Empty: false,
      ExtendsPlain: false,
      Indexed: true,
      InheritsIndex: true,
      NumberIndexed: true,
      Plain: false,
    });
    expect(
      Object.fromEntries(Object.entries(surface.typeAliases).map(([name, alias]) => [name, alias.hasUnlistedMembers])),
    ).toEqual({
      IndexedAlias: true,
      IndexedIntersection: true,
      Intersection: false,
      KeyedRecord: false,
      Other: undefined,
      PartialAlias: false,
      PlainAlias: false,
      RecordAlias: true,
      // A member left out of the fields is one they do not list.
      SymbolKeyed: true,
      Text: undefined,
      Union: undefined,
    });

    // The snapshot keeps it on the type's own symbol, where it is stated.
    const byName = new Map(apiSurfaceToSnapshot(surface).symbols.map((sym) => [sym.fqName, sym]));
    expect(byName.get('Plain')).toMatchObject({ extends: [], hasUnlistedMembers: false });
    expect(byName.get('Indexed')).toMatchObject({ extends: [], hasUnlistedMembers: true });
    expect(byName.get('RecordAlias')).toMatchObject({
      extends: [],
      hasUnlistedMembers: true,
      aliasOf: '{ [x: string]: string; }',
    });
    expect(byName.get('Union')).not.toHaveProperty('hasUnlistedMembers');
    expect(byName.get('Plain.timeout')).not.toHaveProperty('hasUnlistedMembers');
  });

  it.each<[string, Extractor, Record<string, string>]>([
    ['php', phpExtractor, phpSdk(PHP_OPTIONS, 'string', '?BaseOptions')],
    ['python', pythonExtractor, pythonSdk(PYTHON_OPTIONS, 'str', 'BaseOptions')],
    ['go', goExtractor, UNTYPED_SUPERTYPES[0][2]('BaseOptions')],
    ['kotlin', kotlinExtractor, UNTYPED_SUPERTYPES[1][2]('BaseOptions')],
    ['dotnet', dotnetExtractor, UNTYPED_SUPERTYPES[2][2]('BaseOptions')],
    ['rust', rustExtractor, UNTYPED_SUPERTYPES[3][2]('BaseOptions')],
    ['ios', iosExtractor, UNTYPED_SUPERTYPES[4][2]('BaseOptions')],
  ])('is not stated by the %s extractor, which does not look', async (_, extractor, files) => {
    const snap = await snapshotOf(extractor, files);
    const typed = snap.symbols.filter((sym) => sym.extends !== undefined);
    expect(typed.length).toBeGreaterThan(0);
    expect(snap.symbols.filter((sym) => 'hasUnlistedMembers' in sym)).toEqual([]);
  });

  it('is written only where the surface states `true` or `false`', () => {
    const marked = (stated: unknown) =>
      apiSurfaceToSnapshot({
        ...EMPTY_SURFACE,
        interfaces: {
          Options: { name: 'Options', fields: {}, extends: [], hasUnlistedMembers: stated as boolean },
        },
        typeAliases: {
          Shape: { name: 'Shape', value: '{}', fields: {}, extends: [], hasUnlistedMembers: stated as boolean },
          // An alias without `fields` is recorded by name: nothing to say it of.
          Text: { name: 'Text', value: 'string', hasUnlistedMembers: stated as boolean },
        },
      }).symbols.map((sym) => [sym.fqName, sym.hasUnlistedMembers]);
    expect(marked(true)).toEqual([
      ['Options', true],
      ['Shape', true],
      ['Text', undefined],
    ]);
    expect(marked(false)).toEqual([
      ['Options', false],
      ['Shape', false],
      ['Text', undefined],
    ]);
    for (const stated of [undefined, null, 0, 1, 'false', [], {}]) {
      expect(marked(stated)).toEqual([
        ['Options', undefined],
        ['Shape', undefined],
        ['Text', undefined],
      ]);
    }
  });

  it('is not compared: a type that starts or stops taking any key reports nothing of its own', async () => {
    const sdk = (body: string) => nodeSdk(`export interface Options { ${body} }\n`);
    const opened = await compatDiff(
      nodeExtractor,
      sdk('timeout?: number'),
      sdk('timeout?: number; [key: string]: unknown'),
    );
    expect(opened.lines).toEqual([]);
    const closed = await compatDiff(
      nodeExtractor,
      sdk('timeout?: number; [key: string]: unknown'),
      sdk('timeout?: number'),
    );
    expect(closed.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// When the snapshot cannot tell
// ---------------------------------------------------------------------------

/** A snapshot as one written before #750 and #752: no `optional`, `extends`,
 *  `aliasOf` or `hasUnlistedMembers`, no members under a type alias, and
 *  policies without `parameterTypesAreStructural`. */
function writtenBefore(snapshot: CompatSnapshot): CompatSnapshot {
  const aliases = new Set(snapshot.symbols.filter((sym) => sym.aliasOf !== undefined).map((sym) => sym.fqName));
  const { parameterTypesAreStructural: _unstated, ...policies } = snapshot.policies;
  return {
    ...snapshot,
    policies,
    symbols: snapshot.symbols
      .filter((sym) => !(sym.kind === 'field' && sym.ownerFqName !== undefined && aliases.has(sym.ownerFqName)))
      .map(
        ({ optional: _optional, extends: _extends, aliasOf: _aliasOf, hasUnlistedMembers: _listed, ...rest }) => rest,
      ),
  };
}
/** The same, by the writer #750 left: every key but this issue's two. */
function writtenBefore752(snapshot: CompatSnapshot): CompatSnapshot {
  const { parameterTypesAreStructural: _unstated, ...policies } = snapshot.policies;
  return {
    ...snapshot,
    policies,
    symbols: snapshot.symbols.map(({ hasUnlistedMembers: _listed, ...rest }) => rest),
  };
}

describe('#752 a snapshot written before the keys', () => {
  const PAIRS: Array<[string, Extractor, Record<string, string>, Record<string, string>]> = [
    ["the issue's options", nodeExtractor, ISSUE_OLD, ISSUE_NEW],
    ["the issue's petId", nodeExtractor, ISSUE_OLD, nodeSdk(issueSdk('string | number', 'RequestOptions'))],
    [
      'a PHP parameter widened to the base class',
      phpExtractor,
      phpSdk(PHP_OPTIONS, 'string', '?RetryOptions'),
      phpSdk(PHP_OPTIONS, 'string', '?BaseOptions'),
    ],
  ];

  it.each(PAIRS)(
    '%s: an older baseline reports the retype as it always was',
    async (_, extractor, oldFiles, newFiles) => {
      const baseline = await snapshotOf(extractor, oldFiles);
      const candidate = await snapshotOf(extractor, newFiles);
      const GET = (severity: string) => [`${severity} parameter_type_narrowed PetsClient.get`];
      expect(notAdditive(diffSnapshots(baseline, candidate))).toEqual(GET(SOFT_RISK));
      // The baseline's policy does not state the hint: neither rule is asked.
      for (const older of [writtenBefore, writtenBefore752]) {
        expect(notAdditive(diffSnapshots(older(baseline), candidate))).toEqual(GET(BREAKING));
        expect(notAdditive(diffSnapshots(older(baseline), older(candidate)))).toEqual(GET(BREAKING));
      }
      // Handed today's policy, an older baseline still does not say enough of
      // its types for the shape rule to compare fields; a union needs none.
      const handed = notAdditive(diffSnapshots(writtenBefore(baseline), candidate, baseline.policies));
      const needsNoType = oldFiles === ISSUE_OLD && newFiles !== ISSUE_NEW;
      const readsTheCandidateOnly = extractor === phpExtractor;
      expect(handed).toEqual(GET(needsNoType || readsTheCandidateOnly ? SOFT_RISK : BREAKING));
    },
  );

  it('an older candidate does not say enough of the new type either', async () => {
    const baseline = await snapshotOf(nodeExtractor, ISSUE_OLD);
    const candidate = await snapshotOf(nodeExtractor, ISSUE_NEW);
    for (const older of [writtenBefore, writtenBefore752]) {
      expect(notAdditive(diffSnapshots(baseline, older(candidate)))).toEqual([
        'breaking parameter_type_narrowed PetsClient.get',
      ]);
    }
  });

  it('reports nothing between an older snapshot and a newer one of the same SDK', async () => {
    for (const [, extractor, , newFiles] of PAIRS) {
      const current = await snapshotOf(extractor, newFiles);
      for (const older of [writtenBefore, writtenBefore752]) {
        expect(lines(diffSnapshots(older(current), current))).toEqual([]);
        expect(lines(diffSnapshots(current, older(current)))).toEqual([]);
      }
    }
  });

  it('still loads: the new keys are optional, and the schema version is what it was', async () => {
    const current = await snapshotOf(nodeExtractor, ISSUE_NEW);
    expect(current.schemaVersion).toBe('1');
    for (const snap of [current, writtenBefore(current), writtenBefore752(current)]) {
      expect(validateSnapshot(JSON.parse(JSON.stringify(snap)))).toBe(true);
    }
  });
});

describe('#752 a type the snapshot does not record whole', () => {
  const NODE = getDefaultPolicy('node');
  const OLD_TYPE = objectType('OldOptions', { timeout: '?number' });
  const NEW_TYPE = objectType('NewOptions', { timeout: '?number', maxRetries: '?number' });
  const diff = (oldType: CompatSymbol[], newType: CompatSymbol[]) =>
    severities(
      diffSnapshots(snapshot(NODE, get('OldOptions'), oldType), snapshot(NODE, get('NewOptions'), oldType, newType)),
    );
  const without = (symbols: CompatSymbol[], key: keyof CompatSymbol, on: CompatSymbol['kind']): CompatSymbol[] =>
    symbols.map((sym) => (sym.kind === on ? { ...sym, [key]: undefined } : sym));

  it('settles two types recorded whole', () => {
    expect(diff(OLD_TYPE, NEW_TYPE)).toEqual(['soft-risk']);
  });

  it.each<[string, (symbols: CompatSymbol[]) => CompatSymbol[]]>([
    ['no `extends`', (symbols) => without(symbols, 'extends', 'alias')],
    ['no `hasUnlistedMembers`', (symbols) => without(symbols, 'hasUnlistedMembers', 'alias')],
    [
      '`hasUnlistedMembers: true`',
      (symbols) => symbols.map((sym) => (sym.kind === 'alias' ? { ...sym, hasUnlistedMembers: true } : sym)),
    ],
    ['a field without `optional`', (symbols) => without(symbols, 'optional', 'field')],
    ['a field without a type', (symbols) => without(symbols, 'typeRef', 'field')],
    ['no symbol of its own', (symbols) => symbols.filter((sym) => sym.kind !== 'alias')],
    ['no symbol at all', () => []],
    [
      'a class for its symbol',
      (symbols) => symbols.map((sym) => (sym.kind === 'alias' ? { ...sym, kind: 'service_accessor' as const } : sym)),
    ],
    [
      'a supertype the snapshot does not declare',
      (symbols) => symbols.map((sym) => (sym.kind === 'alias' ? { ...sym, extends: ['Elsewhere'] } : sym)),
    ],
  ])('stays breaking when the old type or the new one has %s', (_, strip) => {
    expect(diff(strip(OLD_TYPE), NEW_TYPE)).toEqual(['breaking']);
    expect(diff(OLD_TYPE, strip(NEW_TYPE))).toEqual(['breaking']);
  });

  it('stays breaking for a generic, an external type and a type written under a generic', () => {
    const texts = (oldText: string, newText: string) =>
      severities(
        diffSnapshots(
          snapshot(NODE, get(oldText), OLD_TYPE, NEW_TYPE),
          snapshot(NODE, get(newText), OLD_TYPE, NEW_TYPE),
        ),
      );
    expect(texts('OldOptions', 'NewOptions')).toEqual(['soft-risk']);
    expect(texts('Page<OldOptions>', 'Page<NewOptions>')).toEqual(['breaking']);
    expect(texts('Buffer', 'Uint8Array')).toEqual(['breaking']);
    expect(texts('OldOptions', 'Elsewhere')).toEqual(['breaking']);
    expect(texts('Elsewhere', 'NewOptions')).toEqual(['breaking']);
  });

  it('reads a PHP class whose optionality the surface could not tell as it reads no other: by its declaration', async () => {
    // A property declared in the class body says nothing about the
    // constructor, so the surface records no `optional` for the class.
    const body = (name: string, base?: string) =>
      phpFile(`class ${name}${base ? ` extends ${base}` : ''}
{
    public ?int $timeout = null;
}`);
    const sdk = (options: string) => ({
      'lib/Pet.php': phpClass('Pet', ['public readonly string $id']),
      'lib/BaseOptions.php': body('BaseOptions'),
      'lib/RetryOptions.php': body('RetryOptions', 'BaseOptions'),
      'lib/PetsClient.php': phpClient('string', options),
    });
    const { baseline, diff: declared } = await compatDiff(phpExtractor, sdk('?RetryOptions'), sdk('?BaseOptions'));
    expect(baseline.symbols.find((sym) => sym.fqName === 'BaseOptions.timeout')).not.toHaveProperty('optional');
    expect(notAdditive(declared)).toEqual(['soft-risk parameter_type_narrowed PetsClient.get']);
    // Asked for the shape instead, there is nothing to compare.
    const structural = { ...baseline.policies, parameterTypesAreStructural: true };
    const candidate = await snapshotOf(phpExtractor, sdk('?BaseOptions'));
    expect(notAdditive(diffSnapshots(baseline, candidate, structural))).toEqual([
      'breaking parameter_type_narrowed PetsClient.get',
    ]);
  });
});

describe('#752 a snapshot with something else where the keys go', () => {
  const NODE = getDefaultPolicy('node');
  const VALUES: unknown[] = [true, false, null, 0, 1, '', 'x', [], ['x'], [null], {}, { name: 1 }];
  const pair = () => ({
    baseline: snapshot(
      NODE,
      get('PetId', 'RequestOptions | undefined'),
      BASE,
      RETRY,
      symbol('alias', 'PetId', { aliasOf: 'string' }),
      objectType('RequestOptions', { timeout: '?number' }),
    ),
    candidate: snapshot(
      NODE,
      get('string | number', 'RetryRequestOptions | undefined'),
      BASE,
      RETRY,
      symbol('alias', 'PetId', { aliasOf: 'string' }),
      objectType('RequestOptions', { timeout: '?number' }),
      objectType('RetryRequestOptions', { timeout: '?number', maxRetries: '?number' }, { extends: ['RequestOptions'] }),
    ),
  });

  it('settles both parameters as they stand', () => {
    const { baseline, candidate } = pair();
    expect(severities(diffSnapshots(baseline, candidate))).toEqual(['soft-risk', 'soft-risk']);
  });

  it('does not throw, whatever stands in a key the rule reads', () => {
    // Not `fqName` or `ownerFqName`, and not a `typeRef` whose name is a
    // number: a symbol whose name or owner is not a string, and a field
    // retyped to a type that is not one, made the classifier and the rename
    // pass throw before this rule existed, and still do. None is a key this
    // rule is the first to read.
    const keys: Array<[CompatSymbol['kind'], string[]]> = [
      ['alias', ['extends', 'hasUnlistedMembers', 'aliasOf', 'kind']],
      ['field', ['optional', 'typeRef', 'kind']],
    ];
    let rows = 0;
    for (const [kind, names] of keys) {
      for (const key of names) {
        for (const value of VALUES) {
          if (key === 'typeRef' && typeof (value as { name?: unknown } | null)?.name === 'number') continue;
          for (const side of ['baseline', 'candidate', 'both'] as const) {
            const { baseline, candidate } = pair();
            for (const snap of [
              side !== 'candidate' ? baseline : undefined,
              side !== 'baseline' ? candidate : undefined,
            ]) {
              for (const sym of snap?.symbols ?? []) {
                if (sym.kind === kind) (sym as unknown as Record<string, unknown>)[key] = structuredClone(value);
              }
            }
            expect(() => diffSnapshots(baseline, candidate)).not.toThrow();
            rows++;
          }
        }
      }
    }
    expect(rows).toBe((7 * VALUES.length - 1) * 3);
  });

  it.each(VALUES.filter((value) => typeof value !== 'string'))(
    'stays breaking for a parameter whose type text is %j',
    (value) => {
      const typed = (name: unknown) => {
        const callable = get('string');
        (callable.parameters![0].type as { name: unknown }).name = structuredClone(name);
        return snapshot(NODE, callable);
      };
      for (const [oldText, newText] of [
        [value, 'string'],
        ['string', value],
      ]) {
        const reported = diffSnapshots(typed(oldText), typed(newText));
        expect(severities(reported)).toEqual(['breaking']);
      }
    },
  );

  it.each(VALUES.filter((value) => !Array.isArray(value)))(
    'stays breaking for a type whose `extends` is %j',
    (value) => {
      const { baseline, candidate } = pair();
      for (const sym of candidate.symbols) {
        if (sym.fqName === 'RetryRequestOptions') (sym as unknown as Record<string, unknown>).extends = value;
      }
      expect(severities(diffSnapshots(baseline, candidate))).toEqual(['soft-risk', 'breaking']);
    },
  );

  it.each([[[null]], [[1]], [['RequestOptions', null]], [[['RequestOptions']]], [['Partial<RequestOptions>']]])(
    'stays breaking for a type whose `extends` holds %j',
    (entries) => {
      const { baseline, candidate } = pair();
      for (const sym of candidate.symbols) {
        if (sym.fqName === 'RetryRequestOptions') (sym as unknown as Record<string, unknown>).extends = entries;
      }
      expect(severities(diffSnapshots(baseline, candidate))).toEqual(['soft-risk', 'breaking']);
    },
  );
});

// ---------------------------------------------------------------------------
// What the downgrade leaves alone
// ---------------------------------------------------------------------------

describe('#752 the other changes of a diff', () => {
  it('does not take the two types of a parameter for a rename: an unrelated field between them keeps its line', async () => {
    // `OldOptions` and `NewOptions` both exist on both sides, with the same
    // fields. The parameter moves from one to the other, and so do a class
    // property and a return, which are read, not passed.
    const sdk = (type: string) => `export interface OldOptions { timeout?: number }
export interface NewOptions { timeout?: number }
export declare class Holder { options: ${type}; }
export declare class PetsClient {
  get(petId: string, options: ${type}): Promise<string>;
  defaults(): ${type};
}
`;
    const { diff } = await compatDiff(nodeExtractor, nodeSdk(sdk('OldOptions')), nodeSdk(sdk('NewOptions')));
    expect(lines(diff)).toEqual([
      'breaking field_type_changed Holder.options',
      'breaking return_type_changed PetsClient.defaults',
      'soft-risk parameter_type_narrowed PetsClient.get',
    ]);
    // The field and the return are as they are without the parameter's retype.
    const alone = (type: string) => sdk(type).replace(`options: ${type}): Promise`, 'options: OldOptions): Promise');
    const { diff: withoutTheParameter } = await compatDiff(
      nodeExtractor,
      nodeSdk(alone('OldOptions')),
      nodeSdk(alone('NewOptions')),
    );
    expect(lines(withoutTheParameter)).toEqual([
      'breaking field_type_changed Holder.options',
      'breaking return_type_changed PetsClient.defaults',
    ]);
  });

  it('leaves a field of a type callers build as #750 weighs it', async () => {
    // The same retype one level down is a `field_type_changed`, not a parameter's.
    const sdk = (type: string) => `export interface RequestOptions { timeout?: number }
export interface RetryRequestOptions extends RequestOptions { maxRetries?: number }
export interface CreatePetOptions { name: string; request?: ${type} }
export declare class PetsClient { create(options: CreatePetOptions): Promise<string>; }
`;
    const { diff } = await compatDiff(
      nodeExtractor,
      nodeSdk(sdk('RequestOptions')),
      nodeSdk(sdk('RetryRequestOptions')),
    );
    expect(lines(diff)).toEqual(['breaking field_type_changed CreatePetOptions.request']);
  });

  it('leaves every other parameter change as it was', async () => {
    const sdk = (parameters: string) => `export interface RequestOptions { timeout?: number }
export declare class PetsClient { get(${parameters}): Promise<string>; }
`;
    const changed = async (oldParameters: string, newParameters: string) =>
      lines((await compatDiff(nodeExtractor, nodeSdk(sdk(oldParameters)), nodeSdk(sdk(newParameters)))).diff);
    // Removed, added, renamed, moved, made required: none is a retype.
    expect(await changed('petId: string, options?: RequestOptions', 'petId: string')).toEqual([
      'breaking parameter_removed PetsClient.get',
    ]);
    expect(await changed('petId: string', 'petId: string, options?: RequestOptions')).toEqual([
      'additive parameter_added_optional_terminal PetsClient.get',
    ]);
    expect(await changed('petId: string', 'petId: string, options: RequestOptions')).toEqual([
      'breaking parameter_requiredness_increased PetsClient.get',
    ]);
    expect(await changed('petId: string', 'id: string')).toEqual(['soft-risk parameter_renamed PetsClient.get']);
    expect(await changed('petId: string, kind: number', 'kind: number, petId: string')).toEqual([
      'breaking parameter_position_changed_order_sensitive PetsClient.get',
      'breaking parameter_position_changed_order_sensitive PetsClient.get',
    ]);
    // An optional parameter made required: both lines, both breaking.
    expect(await changed('petId: string, options?: RequestOptions', 'petId: string, options: RequestOptions')).toEqual([
      'breaking parameter_requiredness_increased PetsClient.get',
      'breaking parameter_type_narrowed PetsClient.get',
    ]);
  });

  it('keeps the removal of the old type breaking beside the parameter that still takes its values', async () => {
    const { diff } = await compatDiff(
      nodeExtractor,
      nodeSdk(`export interface OldOptions { timeout?: number }
export declare class PetsClient { get(options: OldOptions): Promise<string>; }
`),
      nodeSdk(`export interface NewOptions { timeout?: number; maxRetries?: number }
export declare class PetsClient { get(options: NewOptions): Promise<string>; }
`),
    );
    expect(notAdditive(diff)).toEqual([
      'soft-risk parameter_type_narrowed PetsClient.get',
      'breaking symbol_removed OldOptions',
      'soft-risk symbol_removed OldOptions.timeout',
    ]);
    expect(exitCode(diff)).toBe(1);
  });

  it('keeps a hint another pass already gave the change', () => {
    const NODE = getDefaultPolicy('node');
    const diff = diffSnapshots(snapshot(NODE, get('string')), snapshot(NODE, get('string | number')));
    expect(diff.changes[0].remediation).toContain('accepts every argument callers pass today');
    expect(diff.summary).toEqual({ breaking: 0, softRisk: 1, additive: 0 });
  });
});

// ---------------------------------------------------------------------------
// `oagen verify`: a baseline scoped to the spec
// ---------------------------------------------------------------------------

describe('#752 a baseline scoped to what a spec derives', () => {
  const sdk = (options: string) => `export interface Pet { id: string; name: string }
export interface OldOptions { timeout?: number; maxRetries?: number }
export interface WiderOptions { timeout?: number; maxRetries?: number; signal?: string }
export interface NarrowerOptions { timeout?: number }
export declare class Pets { getPet(petId: string, options: ${options}): Promise<Pet>; }
`;
  // The spec derives `Pets.getPet` and `Pet`; the options types are the
  // SDK's own, so the scope leaves them out of the baseline that is compared.
  const spec = {
    name: 'Petstore',
    version: '1.0.0',
    baseUrl: 'https://example.com',
    services: [
      {
        name: 'Pets',
        operations: [
          {
            name: 'getPet',
            httpMethod: 'get',
            path: '/pets/{petId}',
            pathParams: [{ name: 'petId', type: { kind: 'primitive', type: 'string' }, required: true }],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'Pet' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ],
    models: [
      {
        name: 'Pet',
        fields: ['id', 'name'].map((name) => ({ name, type: { kind: 'primitive', type: 'string' }, required: true })),
      },
    ],
    enums: [],
  } as unknown as ApiSpec;

  beforeAll(() => {
    registerExtractor(nodeExtractor);
  });

  it('reads the old type from the whole baseline, not from the part that is compared', async () => {
    const baseline = await nodeExtractor.extract(writeSdk(nodeSdk(sdk('OldOptions'))));
    const GET = (severity: string) => [`${severity} parameter_type_narrowed Pets.getPet`];

    const wider = await runCompatCheck(baseline, writeSdk(nodeSdk(sdk('WiderOptions'))), 'node', spec);
    expect(wider.scopedToSpec).toBe(true);
    expect(notAdditive(wider.diff)).toEqual(GET(SOFT_RISK));
    expect(wider.passed).toBe(true);

    const narrower = await runCompatCheck(baseline, writeSdk(nodeSdk(sdk('NarrowerOptions'))), 'node', spec);
    expect(notAdditive(narrower.diff)).toEqual(GET(BREAKING));
    expect(narrower.passed).toBe(false);

    // Unscoped, the same two verdicts.
    expect(notAdditive((await runCompatCheck(baseline, writeSdk(nodeSdk(sdk('WiderOptions'))), 'node')).diff)).toEqual(
      GET(SOFT_RISK),
    );
  });

  it('would not know the old type from the compared part alone', async () => {
    const baseline = await nodeExtractor.extract(writeSdk(nodeSdk(sdk('OldOptions'))));
    const candidate = await snapshotOf(nodeExtractor, nodeSdk(sdk('WiderOptions')));
    // The scope as `oagen verify` applies it leaves `OldOptions` out.
    const { OldOptions: _out, ...interfaces } = baseline.interfaces;
    const scoped = apiSurfaceToSnapshot({ ...baseline, interfaces });
    const retype = (diff: CompatDiffResult) => severities(diff);
    expect(retype(diffSnapshots(scoped, candidate))).toEqual(['breaking']);
    expect(
      retype(diffSnapshots(scoped, candidate, undefined, { unscopedBaseline: apiSurfaceToSnapshot(baseline) })),
    ).toEqual(['soft-risk']);
    // A scope that keeps the type and drops one of its fields would let a
    // new type without that field through; the whole baseline does not.
    const partial = apiSurfaceToSnapshot({
      ...baseline,
      interfaces: {
        ...baseline.interfaces,
        OldOptions: {
          ...baseline.interfaces.OldOptions,
          fields: { timeout: baseline.interfaces.OldOptions.fields.timeout },
        },
      },
    });
    const narrower = await snapshotOf(nodeExtractor, nodeSdk(sdk('NarrowerOptions')));
    expect(
      retype(diffSnapshots(partial, narrower, undefined, { unscopedBaseline: apiSurfaceToSnapshot(baseline) })),
    ).toEqual(['breaking']);
  });
});
