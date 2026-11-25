import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { diffSnapshots } from '../../src/compat/differ.js';
import { apiSurfaceToSnapshot } from '../../src/compat/ir.js';
import type { CompatSnapshot, CompatSymbol, LanguageId } from '../../src/compat/ir.js';
import { getDefaultPolicy } from '../../src/compat/policy.js';
import { formatHumanSummary } from '../../src/compat/report.js';
import { severityMeetsThreshold } from '../../src/compat/config.js';
import { bareTypeName } from '../../src/compat/type-names.js';
import type { Extractor } from '../../src/compat/types.js';
import { dotnetExtractor } from '../../src/compat/extractors/dotnet.js';
import { elixirExtractor } from '../../src/compat/extractors/elixir.js';
import { goExtractor } from '../../src/compat/extractors/go.js';
import { iosExtractor } from '../../src/compat/extractors/ios.js';
import { kotlinExtractor } from '../../src/compat/extractors/kotlin.js';
import { nodeExtractor } from '../../src/compat/extractors/node.js';
import { phpExtractor } from '../../src/compat/extractors/php.js';
import { pythonExtractor } from '../../src/compat/extractors/python.js';
import { rubyExtractor } from '../../src/compat/extractors/ruby.js';
import { rustExtractor } from '../../src/compat/extractors/rust.js';

/**
 * #751: `compat-diff` downgrades a `field_type_changed` or
 * `return_type_changed` to soft-risk when the new type is newly added and has
 * every field of the old one. It finds the two types by the names their type
 * texts carry, and the optional spellings three extractors record as written
 * (`X | undefined`, `X | None`, `?X`) hid the name, so the same retype was
 * soft-risk on a required property and breaking on an optional one.
 */

const FORK_HINT =
  'Schema "ErrorBodyWithCode" looks like "ErrorBody" with additional fields. Consider adding the new fields to ' +
  '"ErrorBody" instead of forking a new schema — forking forces a breaking type-name change in typed SDKs, while ' +
  'extending the existing schema is additive.';

// ---------------------------------------------------------------------------
// The issue's SDKs, through the extractors
// ---------------------------------------------------------------------------

const roots: string[] = [];

function writeSdk(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'oagen-751-'));
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

/**
 * `oagen compat-extract` on both SDKs, then `oagen compat-diff`: the report
 * it prints, its exit code, and the type texts the extractor recorded for the
 * symbols that changed type.
 */
async function compatDiff(extractor: Extractor, oldFiles: Record<string, string>, newFiles: Record<string, string>) {
  const baseline = apiSurfaceToSnapshot(await extractor.extract(writeSdk(oldFiles)));
  const candidate = apiSurfaceToSnapshot(await extractor.extract(writeSdk(newFiles)));
  const diff = diffSnapshots(baseline, candidate);
  return {
    report: formatHumanSummary(diff),
    exitCode: diff.changes.some((change) => severityMeetsThreshold(change.severity, 'breaking')) ? 1 : 0,
    retyped: Object.fromEntries(
      diff.changes
        .filter((change) => change.category === 'field_type_changed' || change.category === 'return_type_changed')
        .map((change) => [
          change.symbol,
          `${change.severity}: ${change.old.type ?? change.old.returnType} → ${change.new.type ?? change.new.returnType}`,
        ]),
    ),
  };
}

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] });

/** The issue's TypeScript SDK pair, around one declaration that uses the body type. */
function nodeSdks(declaration: (body: string) => string): [Record<string, string>, Record<string, string>] {
  return [
    {
      'tsconfig.json': TSCONFIG,
      'src/index.ts': `export interface ErrorBody { message: string }\n\n${declaration('ErrorBody')}`,
    },
    {
      'tsconfig.json': TSCONFIG,
      'src/index.ts': `export interface ErrorBody { message: string }
export interface ErrorBodyWithCode { code?: string; message: string }

${declaration('ErrorBodyWithCode')}`,
    },
  ];
}

const errorClass = (members: string[]) =>
  `export declare class PetsError extends Error {\n${members.map((member) => `  ${member};\n`).join('')}}\n`;

/** The issue's Python SDK pair: a `Pet(BaseModel)` with the given fields. */
function pythonSdks(
  fields: (body: string) => string[],
  imports = '',
): [Record<string, string>, Record<string, string>] {
  const models = (body: string, extra = '') => `${imports}from pydantic import BaseModel


class ErrorBody(BaseModel):
    message: str

${extra}
class Pet(BaseModel):
    id: str
${fields(body)
  .map((field) => `    ${field}\n`)
  .join('')}`;
  const init = 'from .models import *\n';
  return [
    { 'src/petstore/__init__.py': init, 'src/petstore/models.py': models('ErrorBody') },
    {
      'src/petstore/__init__.py': init,
      'src/petstore/models.py': models(
        'ErrorBodyWithCode',
        '\nclass ErrorBodyWithCode(BaseModel):\n    code: str | None = None\n    message: str\n\n',
      ),
    },
  ];
}

const phpClass = (name: string, promoted: string[]) => `<?php

declare(strict_types=1);

namespace Petstore;

final class ${name}
{
    public function __construct(
${promoted.map((line) => `        ${line},\n`).join('')}    ) {}
}
`;

/** The issue's PHP SDK pair: a `final class Pet` with the given promoted properties. */
function phpSdks(promoted: (body: string) => string[]): [Record<string, string>, Record<string, string>] {
  const errorBody = phpClass('ErrorBody', ['public readonly string $message']);
  const pet = (body: string) => phpClass('Pet', ['public readonly string $id', ...promoted(body)]);
  return [
    { 'lib/ErrorBody.php': errorBody, 'lib/Pet.php': pet('ErrorBody') },
    {
      'lib/ErrorBody.php': errorBody,
      'lib/ErrorBodyWithCode.php': phpClass('ErrorBodyWithCode', [
        'public readonly string $message',
        'public readonly ?string $code = null',
      ]),
      'lib/Pet.php': pet('ErrorBodyWithCode'),
    },
  ];
}

describe("#751 the issue's SDKs: a compatible retype of an optional property", () => {
  it('TypeScript: an optional class property (`ErrorBody | undefined`) is soft-risk, and compat-diff exits 0', async () => {
    const { report, exitCode } = await compatDiff(nodeExtractor, ...nodeSdks((body) => errorClass([`body?: ${body}`])));

    expect(report).toMatchInlineSnapshot(`
      "Compat report:
        0 breaking, 1 soft-risk, 3 additive

        Soft-risk:
          [field_type_changed] PetsError.body — Type changed for "PetsError.body" from "ErrorBody | undefined" to "ErrorBodyWithCode | undefined"
            hint: Schema "ErrorBodyWithCode" looks like "ErrorBody" with additional fields. Consider adding the new fields to "ErrorBody" instead of forking a new schema — forking forces a breaking type-name change in typed SDKs, while extending the existing schema is additive.

        Additive: 3 new symbol(s)"
    `);
    expect(exitCode).toBe(0);
  });

  it('TypeScript: the required property and the interface field report the same line they did', async () => {
    const required = await compatDiff(nodeExtractor, ...nodeSdks((body) => errorClass([`body: ${body}`])));
    const onInterface = await compatDiff(
      nodeExtractor,
      ...nodeSdks((body) => `export interface PetsError {\n  body?: ${body};\n}\n`),
    );

    expect(required.report).toMatchInlineSnapshot(`
      "Compat report:
        0 breaking, 1 soft-risk, 3 additive

        Soft-risk:
          [field_type_changed] PetsError.body — Type changed for "PetsError.body" from "ErrorBody" to "ErrorBodyWithCode"
            hint: Schema "ErrorBodyWithCode" looks like "ErrorBody" with additional fields. Consider adding the new fields to "ErrorBody" instead of forking a new schema — forking forces a breaking type-name change in typed SDKs, while extending the existing schema is additive.

        Additive: 3 new symbol(s)"
    `);
    expect(onInterface.report).toBe(required.report);
    expect([required.exitCode, onInterface.exitCode]).toEqual([0, 0]);
  });

  it('TypeScript: every way a class member is optional or nullable, as the checker prints it', async () => {
    const { retyped, exitCode } = await compatDiff(
      nodeExtractor,
      ...nodeSdks((body) =>
        errorClass([
          `body?: ${body}`,
          `explicit: ${body} | undefined`,
          `reversed: undefined | ${body}`,
          `nullable: ${body} | null`,
          `both?: ${body} | null`,
          `bodies?: ${body}[]`,
          `sparse: (${body} | undefined)[]`,
          `holes?: (${body} | null)[]`,
          `generic?: Array<${body}>`,
          `load(): Promise<${body} | undefined>`,
          `find(): Promise<${body} | null>`,
          `peek(): ${body} | undefined`,
        ]),
      ),
    );

    expect(retyped).toEqual({
      'PetsError.body': 'soft-risk: ErrorBody | undefined → ErrorBodyWithCode | undefined',
      'PetsError.explicit': 'soft-risk: ErrorBody | undefined → ErrorBodyWithCode | undefined',
      'PetsError.reversed': 'soft-risk: ErrorBody | undefined → ErrorBodyWithCode | undefined',
      'PetsError.nullable': 'soft-risk: ErrorBody | null → ErrorBodyWithCode | null',
      'PetsError.both': 'soft-risk: ErrorBody | null | undefined → ErrorBodyWithCode | null | undefined',
      'PetsError.bodies': 'soft-risk: ErrorBody[] | undefined → ErrorBodyWithCode[] | undefined',
      'PetsError.sparse': 'soft-risk: (ErrorBody | undefined)[] → (ErrorBodyWithCode | undefined)[]',
      'PetsError.holes': 'soft-risk: (ErrorBody | null)[] | undefined → (ErrorBodyWithCode | null)[] | undefined',
      'PetsError.generic': 'soft-risk: ErrorBody[] | undefined → ErrorBodyWithCode[] | undefined',
      'PetsError.load': 'soft-risk: Promise<ErrorBody | undefined> → Promise<ErrorBodyWithCode | undefined>',
      'PetsError.find': 'soft-risk: Promise<ErrorBody | null> → Promise<ErrorBodyWithCode | null>',
      'PetsError.peek': 'soft-risk: ErrorBody | undefined → ErrorBodyWithCode | undefined',
    });
    expect(exitCode).toBe(0);
  });

  it('Python: `ErrorBody | None` on a model field is soft-risk, and compat-diff exits 0', async () => {
    const { report, exitCode } = await compatDiff(
      pythonExtractor,
      ...pythonSdks((body) => [`last_failure: ${body} | None = None`]),
    );

    expect(report).toMatchInlineSnapshot(`
      "Compat report:
        0 breaking, 1 soft-risk, 3 additive

        Soft-risk:
          [field_type_changed] Pet.last_failure — Type changed for "Pet.last_failure" from "ErrorBody | None" to "ErrorBodyWithCode | None"
            hint: Schema "ErrorBodyWithCode" looks like "ErrorBody" with additional fields. Consider adding the new fields to "ErrorBody" instead of forking a new schema — forking forces a breaking type-name change in typed SDKs, while extending the existing schema is additive.

        Additive: 3 new symbol(s)"
    `);
    expect(exitCode).toBe(0);
  });

  it('Python: every way an annotation says optional, as it is written', async () => {
    const { retyped, exitCode } = await compatDiff(
      pythonExtractor,
      ...pythonSdks(
        (body) => [
          `pep604: ${body} | None = None`,
          `reversed: None | ${body} = None`,
          `tight: ${body}|None = None`,
          `optional: Optional[${body}] = None`,
          `union: Union[${body}, None] = None`,
          `union_reversed: Union[None, ${body}] = None`,
          `wrapped: (\n        ${body} | None\n    ) = None`,
          `many: list[${body}] | None = None`,
          `optional_many: Optional[List[${body}]] = None`,
          `sparse: list[${body} | None] = []`,
        ],
        'from typing import List, Optional, Union\n\n',
      ),
    );

    expect(retyped).toEqual({
      'Pet.pep604': 'soft-risk: ErrorBody | None → ErrorBodyWithCode | None',
      'Pet.reversed': 'soft-risk: None | ErrorBody → None | ErrorBodyWithCode',
      'Pet.tight': 'soft-risk: ErrorBody|None → ErrorBodyWithCode|None',
      'Pet.optional': 'soft-risk: Optional[ErrorBody] → Optional[ErrorBodyWithCode]',
      'Pet.union': 'soft-risk: Union[ErrorBody, None] → Union[ErrorBodyWithCode, None]',
      'Pet.union_reversed': 'soft-risk: Union[None, ErrorBody] → Union[None, ErrorBodyWithCode]',
      'Pet.wrapped': 'soft-risk: (\n        ErrorBody | None\n    ) → (\n        ErrorBodyWithCode | None\n    )',
      'Pet.many': 'soft-risk: list[ErrorBody] | None → list[ErrorBodyWithCode] | None',
      'Pet.optional_many': 'soft-risk: Optional[List[ErrorBody]] → Optional[List[ErrorBodyWithCode]]',
      'Pet.sparse': 'soft-risk: list[ErrorBody | None] → list[ErrorBodyWithCode | None]',
    });
    expect(exitCode).toBe(0);
  });

  it('PHP: a promoted `?ErrorBody` property is soft-risk, and compat-diff exits 0', async () => {
    const { report, exitCode } = await compatDiff(
      phpExtractor,
      ...phpSdks((body) => [`public readonly ?${body} $lastFailure = null`]),
    );

    expect(report).toMatchInlineSnapshot(`
      "Compat report:
        0 breaking, 1 soft-risk, 3 additive

        Soft-risk:
          [field_type_changed] Pet.lastFailure — Type changed for "Pet.lastFailure" from "?ErrorBody" to "?ErrorBodyWithCode"
            hint: Schema "ErrorBodyWithCode" looks like "ErrorBody" with additional fields. Consider adding the new fields to "ErrorBody" instead of forking a new schema — forking forces a breaking type-name change in typed SDKs, while extending the existing schema is additive.

        Additive: 3 new symbol(s)"
    `);
    expect(exitCode).toBe(0);
  });

  it('PHP: every way a promoted property is nullable, as it is written', async () => {
    const { retyped, exitCode } = await compatDiff(
      phpExtractor,
      ...phpSdks((body) => [
        `public readonly ${body} $required`,
        `public readonly ?${body} $short = null`,
        `public readonly ${body}|null $union = null`,
        `public readonly null|${body} $reversed = null`,
        `public readonly ?\\Petstore\\${body} $qualified = null`,
        `public readonly null|\\Petstore\\${body} $qualifiedUnion = null`,
      ]),
    );

    expect(retyped).toEqual({
      'Pet.required': 'soft-risk: ErrorBody → ErrorBodyWithCode',
      'Pet.short': 'soft-risk: ?ErrorBody → ?ErrorBodyWithCode',
      'Pet.union': 'soft-risk: ErrorBody|null → ErrorBodyWithCode|null',
      'Pet.reversed': 'soft-risk: null|ErrorBody → null|ErrorBodyWithCode',
      'Pet.qualified': 'soft-risk: ?\\Petstore\\ErrorBody → ?\\Petstore\\ErrorBodyWithCode',
      'Pet.qualifiedUnion': 'soft-risk: null|\\Petstore\\ErrorBody → null|\\Petstore\\ErrorBodyWithCode',
    });
    expect(exitCode).toBe(0);
  });

  it('a retype to a type that drops a field stays breaking behind every spelling', async () => {
    const [oldSdk, newSdk] = nodeSdks((body) => errorClass([`body?: ${body}`, `load(): Promise<${body} | null>`]));
    newSdk['src/index.ts'] = newSdk['src/index.ts'].replace('{ code?: string; message: string }', '{ code?: string }');
    const { retyped, exitCode } = await compatDiff(nodeExtractor, oldSdk, newSdk);

    expect(retyped).toEqual({
      'PetsError.body': 'breaking: ErrorBody | undefined → ErrorBodyWithCode | undefined',
      'PetsError.load': 'breaking: Promise<ErrorBody | null> → Promise<ErrorBodyWithCode | null>',
    });
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Every rule that looks a type up by its name, in every spelling
// ---------------------------------------------------------------------------

function snapshot(language: LanguageId | undefined, symbols: CompatSymbol[]): CompatSnapshot {
  return {
    schemaVersion: '1',
    source: { extractedAt: '2026-01-01T00:00:00.000Z', ...(language ? { language } : {}) },
    policies: getDefaultPolicy(language ?? 'node'),
    symbols,
  };
}

function sym(fqName: string, kind: CompatSymbol['kind'], extra: Partial<CompatSymbol> = {}): CompatSymbol {
  return {
    id: `test:${fqName}`,
    kind,
    fqName,
    displayName: fqName,
    visibility: 'public',
    stability: 'stable',
    sourceKind: 'generated_resource_constructor',
    ...extra,
  };
}

/** A type with fields: the alias symbol and one field symbol per entry. */
function model(name: string, fields: Record<string, string>): CompatSymbol[] {
  return [
    sym(name, 'alias'),
    ...Object.entries(fields).map(([field, type]) =>
      sym(`${name}.${field}`, 'field', { ownerFqName: name, typeRef: { name: type } }),
    ),
  ];
}

function method(owner: string, name: string, returns: string): CompatSymbol[] {
  return [
    sym(owner, 'service_accessor'),
    sym(`${owner}.${name}`, 'callable', { ownerFqName: owner, parameters: [], returns: { name: returns } }),
  ];
}

function enumOf(name: string, values: string[]): CompatSymbol[] {
  return [
    sym(name, 'enum', { sourceKind: 'generated_enum' }),
    ...values.map((value) =>
      sym(`${name}.${value}`, 'enum_member', { ownerFqName: name, value, sourceKind: 'generated_enum' }),
    ),
  ];
}

const errorBody = model('ErrorBody', { message: 'string' });
const errorBodyWithCode = model('ErrorBodyWithCode', { code: 'string', message: 'string' });

interface Scenario {
  /** The symbol whose type change is the line under test. */
  symbol: string;
  /** Builds the snapshot pair around the old and the new type text. */
  build(oldType: string, newType: string): { baseline: CompatSymbol[]; candidate: CompatSymbol[] };
}

/**
 * One retype, `ErrorBody` → `ErrorBodyWithCode`, in each rule that reads a
 * type's name out of a text: the fork hint and its downgrade
 * (`detectForkedSchemas`, `isStructurallyEquivalent`), a recorded type or enum
 * rename (`cascadeRenameDowngrades`) and a rename inferred through a renamed
 * parent's field (`inferTransitiveTypeRenames`).
 */
const scenarios: Record<string, Scenario> = {
  'a field retyped to a new type with every field of the old one': {
    symbol: 'Pet.failure',
    build: (oldType, newType) => ({
      baseline: [...errorBody, ...model('Pet', { id: 'string', failure: oldType })],
      candidate: [...errorBody, ...errorBodyWithCode, ...model('Pet', { id: 'string', failure: newType })],
    }),
  },
  'a return retyped to a new type with every field of the old one': {
    symbol: 'Pets.failure',
    build: (oldType, newType) => ({
      baseline: [...errorBody, ...method('Pets', 'failure', oldType)],
      candidate: [...errorBody, ...errorBodyWithCode, ...method('Pets', 'failure', newType)],
    }),
  },
  'a field retyped along with a rename of its type': {
    symbol: 'Pet.failure',
    build: (oldType, newType) => ({
      baseline: [...errorBody, ...model('Pet', { id: 'string', failure: oldType })],
      candidate: [...errorBodyWithCode, ...model('Pet', { id: 'string', failure: newType })],
    }),
  },
  'a return retyped along with a rename of its type': {
    symbol: 'Pets.failure',
    build: (oldType, newType) => ({
      baseline: [...errorBody, ...method('Pets', 'failure', oldType)],
      candidate: [...errorBodyWithCode, ...method('Pets', 'failure', newType)],
    }),
  },
  'a field retyped along with a rename of its enum': {
    symbol: 'Pet.failure',
    build: (oldType, newType) => ({
      baseline: [...enumOf('ErrorBody', ['a', 'b']), ...model('Pet', { id: 'string', failure: oldType })],
      candidate: [...enumOf('ErrorBodyWithCode', ['a', 'b']), ...model('Pet', { id: 'string', failure: newType })],
    }),
  },
};

interface Spelling {
  language: LanguageId;
  /** The type text, with `X` where the type's name goes. */
  text: string;
  /** The same text without its optional spellings. */
  plain: string;
}

const spelled = (language: LanguageId, text: string, plain = 'X'): Spelling => ({ language, text, plain });

/**
 * Every optional or nullable spelling a registered extractor can record, in
 * both orders where the language has two and in each spacing it is written.
 * `nodeExtractor` records what the checker prints (`null` and `undefined`
 * last); `pythonExtractor` and `phpExtractor` record the annotation as
 * written; `goExtractor`, `rustExtractor`, `kotlinExtractor`, `iosExtractor`
 * and `dotnetExtractor` record the source text of the type. `elixirExtractor`
 * drops `| nil` and `rubyExtractor` records `Object` for every type, so their
 * rows are the spellings their language hints name.
 */
const optionalSpellings: Spelling[] = [
  spelled('node', 'X | undefined'),
  spelled('node', 'undefined | X'),
  spelled('node', 'X|undefined'),
  spelled('node', 'null | X'),
  spelled('node', 'X | null | undefined'),
  spelled('node', 'X | undefined | null'),
  spelled('node', 'X[] | undefined', 'X[]'),
  spelled('node', '(X | undefined)[]', 'X[]'),
  spelled('node', '(X | null)[]', 'X[]'),
  spelled('node', '(X | null)[] | undefined', 'X[]'),
  spelled('node', 'Array<X> | undefined', 'Array<X>'),
  spelled('node', 'Array<X | undefined>', 'Array<X>'),
  spelled('node', 'Promise<X | undefined>', 'Promise<X>'),
  spelled('node', 'Promise<X | null>', 'Promise<X>'),
  spelled('node', 'Promise<X> | undefined', 'Promise<X>'),
  spelled('python', 'X | None'),
  spelled('python', 'None | X'),
  spelled('python', 'X|None'),
  spelled('python', 'None|X'),
  spelled('python', 'Optional[X | None]'),
  spelled('python', 'Union[X, None]'),
  spelled('python', 'Union[None, X]'),
  spelled('python', 'NotRequired[X | None]'),
  spelled('python', '(\n        X | None\n    )'),
  spelled('python', 'list[X] | None', 'list[X]'),
  spelled('python', 'Optional[list[X]]', 'list[X]'),
  spelled('python', 'Optional[List[X]]', 'List[X]'),
  spelled('python', 'list[X | None]', 'list[X]'),
  spelled('python', 'list[Optional[X]]', 'list[X]'),
  spelled('php', '?X'),
  spelled('php', 'null|X'),
  spelled('php', 'X|NULL'),
  spelled('php', '?\\Acme\\X', '\\Acme\\X'),
  spelled('php', 'null|\\Acme\\X', '\\Acme\\X'),
  spelled('php', '?X[]', 'X[]'),
  spelled('php', 'null|X[]', 'X[]'),
  spelled('rust', 'Option<Vec<X>>', 'Vec<X>'),
  spelled('rust', 'Option<Box<X>>', 'Box<X>'),
  spelled('rust', 'Vec<Option<X>>', 'Vec<X>'),
  spelled('rust', 'std::option::Option<X>'),
  spelled('kotlin', 'List<X?>', 'List<X>'),
  spelled('kotlin', 'List<X?>?', 'List<X>'),
  spelled('dotnet', 'X?[]', 'X[]'),
  spelled('dotnet', 'Task<X?>', 'Task<X>'),
  spelled('elixir', 'X | nil'),
  spelled('elixir', 'nil | X'),
  spelled('ruby', 'T.nilable(X)'),
  // The spellings the differ read before #751: unchanged.
  spelled('node', 'X | null'),
  spelled('node', 'X[] | null', 'X[]'),
  spelled('python', 'Optional[X]'),
  spelled('python', 'NotRequired[X]'),
  spelled('php', 'X|null'),
  spelled('php', '\\Acme\\X|null', '\\Acme\\X'),
  spelled('go', '*X'),
  spelled('go', '*Iterator[X]', 'Iterator[X]'),
  spelled('go', 'Iterator[*X]', 'Iterator[X]'),
  spelled('rust', 'Option<X>'),
  spelled('kotlin', 'X?'),
  spelled('kotlin', 'List<X>?', 'List<X>'),
  spelled('dotnet', 'Nullable<X>'),
  spelled('dotnet', 'X[]?', 'X[]'),
  spelled('ios', 'Optional<X>'),
];

/** The reported line for `symbol`: its severity and its hint. */
function reportedLine(
  scenario: Scenario,
  language: LanguageId | undefined,
  oldType: string,
  newType: string,
): { severity: string; hint: string | undefined } {
  const { baseline, candidate } = scenario.build(oldType, newType);
  const diff = diffSnapshots(snapshot(language, baseline), snapshot(language, candidate));
  const changes = diff.changes.filter(
    (change) =>
      change.symbol === scenario.symbol &&
      (change.category === 'field_type_changed' || change.category === 'return_type_changed'),
  );
  expect(changes).toHaveLength(1);
  return { severity: changes[0].severity, hint: changes[0].remediation };
}

const typeText = (text: string, name: string) => text.replaceAll('X', name).replaceAll('Other', 'Unrelated');

describe('#751 an optional spelling is transparent to every rule that looks a type up by name', () => {
  describe.each(Object.keys(scenarios))('%s', (title) => {
    const scenario = scenarios[title];

    it.each(optionalSpellings)('$language `$text` is reported as `$plain` is: soft-risk, same hint', (spelling) => {
      const plain = reportedLine(
        scenario,
        spelling.language,
        typeText(spelling.plain, 'ErrorBody'),
        typeText(spelling.plain, 'ErrorBodyWithCode'),
      );
      expect(plain.severity).toBe('soft-risk');
      expect(plain.hint).toBeDefined();

      const oldType = typeText(spelling.text, 'ErrorBody');
      const newType = typeText(spelling.text, 'ErrorBodyWithCode');
      expect(reportedLine(scenario, spelling.language, oldType, newType)).toEqual(plain);
      // A snapshot written before `source.language` existed reads the same.
      expect(reportedLine(scenario, undefined, oldType, newType)).toEqual(plain);
    });
  });

  it('the hint names the two types, not their spellings', () => {
    const fork = scenarios['a field retyped to a new type with every field of the old one'];
    for (const spelling of optionalSpellings) {
      const line = reportedLine(
        fork,
        spelling.language,
        typeText(spelling.text, 'ErrorBody'),
        typeText(spelling.text, 'ErrorBodyWithCode'),
      );
      expect(line, spelling.text).toEqual({ severity: 'soft-risk', hint: FORK_HINT });
    }
  });

  describe('a retype the rule does not cover stays breaking behind every spelling', () => {
    const controls: Record<string, Scenario> = {
      'the new type already existed': {
        symbol: 'Pet.failure',
        build: (oldType, newType) => ({
          baseline: [...errorBody, ...errorBodyWithCode, ...model('Pet', { id: 'string', failure: oldType })],
          candidate: [...errorBody, ...errorBodyWithCode, ...model('Pet', { id: 'string', failure: newType })],
        }),
      },
      'the new type drops a field of the old one': {
        symbol: 'Pet.failure',
        build: (oldType, newType) => ({
          baseline: [...errorBody, ...model('Pet', { id: 'string', failure: oldType })],
          candidate: [
            ...errorBody,
            ...model('ErrorBodyWithCode', { code: 'string' }),
            ...model('Pet', { id: 'string', failure: newType }),
          ],
        }),
      },
      'the two names are no declared types': {
        symbol: 'Pet.failure',
        build: (oldType, newType) => ({
          baseline: model('Pet', { id: 'string', failure: oldType }),
          candidate: model('Pet', { id: 'string', failure: newType }),
        }),
      },
    };

    it.each(Object.keys(controls))('%s', (title) => {
      for (const spelling of [spelled('node', 'X'), ...optionalSpellings]) {
        const line = reportedLine(
          controls[title],
          spelling.language,
          typeText(spelling.text, 'ErrorBody'),
          typeText(spelling.text, 'ErrorBodyWithCode'),
        );
        expect(line, spelling.text).toEqual({ severity: 'breaking', hint: undefined });
      }
    });
  });
});

describe('#751 what the lookup must not read through', () => {
  const fork = scenarios['a field retyped to a new type with every field of the old one'];
  const line = (text: string) =>
    reportedLine(fork, undefined, typeText(text, 'ErrorBody'), typeText(text, 'ErrorBodyWithCode')).severity;

  // Each is breaking with and without the optional spelling, as before #751:
  // the text names several types, or the type sits where no rule looks.
  it.each([
    ['a union of two types', 'X | Other', 'X | Other | undefined'],
    ['a union of two types, PHP', 'X|Other', 'X|Other|null'],
    ['a union of two types, Python', 'Union[X, Other]', 'Union[X, Other, None]'],
    ['a union of two types, grouped', 'X | Other', '(X | Other | None)'],
    ['an array inside a generic', 'Promise<X[]>', 'Promise<X[] | undefined>'],
    ['a generic inside a generic', 'Promise<Array<X>>', 'Promise<Array<X> | undefined>'],
    ['an array of arrays', 'X[][]', 'X[][] | undefined'],
    ['a generic with two arguments', 'Record<string, X>', 'Record<string, X> | undefined'],
    ['a generic with two arguments, the type optional', 'Record<string, X>', 'Record<string, X | undefined>'],
    ['a generic with two arguments, Python', 'Dict[str, X]', 'Optional[Dict[str, X]]'],
    ['an object type', '{ body: X; }', '{ body: X; } | undefined'],
    ['a function type', '() => X', '(() => X) | undefined'],
    ['a quoted name', '"X"', 'Optional["X"]'],
    ['a Go slice', '[]X', '[]*X'],
    ['a Swift array', '[X]', '[X]?'],
    ['a Swift array, the long spelling', '[X]', 'Optional<[X]>'],
    ['an Elixir type', 'X.t()', 'X.t() | nil'],
  ])('%s: `%s` and `%s` stay breaking', (_title, plain, optional) => {
    expect(line(plain)).toBe('breaking');
    expect(line(optional)).toBe('breaking');
  });

  it('a type whose name merely contains None, null or undefined is looked up by that name', () => {
    for (const name of ['NoneBody', 'NullBody', 'UndefinedBody', 'NilBody', 'Nullable', 'Option', 'Optional']) {
      const build = (oldType: string, newType: string) => ({
        baseline: [...model(name, { message: 'string' }), ...model('Pet', { failure: oldType })],
        candidate: [
          ...model(name, { message: 'string' }),
          ...model(`${name}WithCode`, { code: 'string', message: 'string' }),
          ...model('Pet', { failure: newType }),
        ],
      });
      const scenario: Scenario = { symbol: 'Pet.failure', build };
      for (const text of [
        'X',
        'X[]',
        'X | None',
        'X | null',
        'X | undefined',
        '?X',
        'Optional[X]',
        'X[] | undefined',
      ]) {
        const reported = reportedLine(
          scenario,
          undefined,
          text.replaceAll('X', name),
          text.replaceAll('X', `${name}WithCode`),
        );
        expect(reported.severity, `${name} as ${text}`).toBe('soft-risk');
        expect(reported.hint, `${name} as ${text}`).toContain(`Schema "${name}WithCode" looks like "${name}"`);
      }
    }
  });

  it('a member that is a declared type, not absence, keeps the union a union', () => {
    for (const other of ['NoneType', 'Nullable', 'Undefined', 'Nil', 'Unrelated']) {
      expect(line(`X | ${other}`), other).toBe('breaking');
    }
  });
});

describe('#751 a spelling on one side only', () => {
  const fork = scenarios['a field retyped to a new type with every field of the old one'];
  const line = (oldType: string, newType: string) => reportedLine(fork, undefined, oldType, newType).severity;

  it('a property that only became optional, or only stopped being optional, stays breaking', () => {
    for (const optional of [
      'ErrorBody | undefined',
      'ErrorBody | null',
      'ErrorBody | None',
      '?ErrorBody',
      'ErrorBody?',
      '*ErrorBody',
      'Optional[ErrorBody]',
    ]) {
      expect(line('ErrorBody', optional), optional).toBe('breaking');
      expect(line(optional, 'ErrorBody'), optional).toBe('breaking');
    }
  });

  // The lookup reads the type's name; it does not compare what stands around
  // it. That held before #751 for the spellings it read (`| null`, `?`, `*`,
  // `Optional[…]`) and for an interface field, whose optionality the snapshot
  // does not carry (#750), and it now holds for every spelling.
  it('a retype that also adds or drops the spelling is looked up by name, as `| null` always was', () => {
    for (const optional of [
      'ErrorBodyWithCode | null',
      'ErrorBodyWithCode?',
      '*ErrorBodyWithCode',
      'Optional[ErrorBodyWithCode]',
      'ErrorBodyWithCode | undefined',
      'ErrorBodyWithCode | None',
      '?ErrorBodyWithCode',
    ]) {
      expect(line('ErrorBody', optional), optional).toBe('soft-risk');
    }
    expect(line('ErrorBody | null', 'ErrorBodyWithCode')).toBe('soft-risk');
    expect(line('ErrorBody | undefined', 'ErrorBodyWithCode')).toBe('soft-risk');
    expect(line('Optional[ErrorBody]', 'ErrorBodyWithCode | None')).toBe('soft-risk');
  });
});

describe('#751 a rename inferred through a renamed parent', () => {
  /**
   * `Key` is renamed to `OrgKey`, and its `owner` goes from one fieldless
   * alias to another: the pair is recorded as a rename of the alias. The same
   * retype on `Audit.owner` is then the rename, not a break.
   */
  const build = (parent: [string, string], other: [string, string], declared = ['KeyOwner', 'OrgKeyOwner']) => ({
    baseline: [
      sym(declared[0], 'alias'),
      ...model('Key', { id: 'string', owner: parent[0] }),
      ...model('Audit', { at: 'string', owner: other[0] }),
    ],
    candidate: [
      sym(declared[1], 'alias'),
      ...model('OrgKey', { id: 'string', owner: parent[1], org: 'string' }),
      ...model('Audit', { at: 'string', owner: other[1] }),
    ],
  });
  const lines = (pair: { baseline: CompatSymbol[]; candidate: CompatSymbol[] }) => {
    const diff = diffSnapshots(snapshot('node', pair.baseline), snapshot('node', pair.candidate));
    const removal = diff.changes.find((change) => change.symbol === 'KeyOwner');
    const retype = diff.changes.find((change) => change.symbol === 'Audit.owner');
    return {
      removalHint: removal?.remediation?.includes('Type "KeyOwner" appears to have been renamed to "OrgKeyOwner"'),
      retype: retype?.severity,
    };
  };

  it.each([
    ['both required', 'X', 'X'],
    ['the parent `X | undefined`, the other field required', 'X | undefined', 'X'],
    ['the parent required, the other field `X | undefined`', 'X', 'X | undefined'],
    ['both `X | undefined`', 'X | undefined', 'X | undefined'],
    ['the parent `?X`, the other field `X|null`', '?X', 'X|null'],
    ['the parent `X | None`, the other field `Optional[X]`', 'X | None', 'Optional[X]'],
    ['the parent `X[] | undefined`, the other field `X`', 'X[] | undefined', 'X'],
  ])('%s: the removal carries the rename hint and the other retype is soft-risk', (_title, parent, other) => {
    const pair = build(
      [typeText(parent, 'KeyOwner'), typeText(parent, 'OrgKeyOwner')],
      [typeText(other, 'KeyOwner'), typeText(other, 'OrgKeyOwner')],
    );
    expect(lines(pair)).toEqual({ removalHint: true, retype: 'soft-risk' });
  });

  it('a field that only became optional is no rename, in any spelling', () => {
    for (const optional of ['KeyOwner | null', 'KeyOwner | undefined', 'KeyOwner | None', '?KeyOwner']) {
      const pair = build(['KeyOwner', optional], ['KeyOwner', optional], ['KeyOwner', 'KeyOwner']);
      expect(lines(pair), optional).toEqual({ removalHint: undefined, retype: 'breaking' });
    }
  });
});

describe('#751 the spellings each language hint strips are the ones the lookup reads through', () => {
  const nullable: [Extractor, string[]][] = [
    [nodeExtractor, ['ErrorBody | null', 'null | ErrorBody']],
    [pythonExtractor, ['Optional[ErrorBody]', 'NotRequired[ErrorBody]', 'ErrorBody | None', 'None | ErrorBody']],
    [phpExtractor, ['?ErrorBody', 'ErrorBody|null', 'null|ErrorBody', 'ErrorBody|NULL']],
    [rubyExtractor, ['T.nilable(ErrorBody)']],
    [goExtractor, ['*ErrorBody']],
    [rustExtractor, ['Option<ErrorBody>']],
    [kotlinExtractor, ['ErrorBody?']],
    [dotnetExtractor, ['ErrorBody?', 'Nullable<ErrorBody>']],
    [elixirExtractor, ['ErrorBody | nil', 'nil | ErrorBody']],
    [iosExtractor, ['ErrorBody?']],
  ];

  it.each(nullable)('$language', (extractor, texts) => {
    for (const text of texts) {
      expect(extractor.hints.stripNullable(text), text).toBe('ErrorBody');
      expect(bareTypeName(text), text).toBe('ErrorBody');
    }
  });
});
