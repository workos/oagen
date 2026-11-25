import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import ts from 'typescript';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyApprovals } from '../../src/compat/approvals.js';
import { defaultSeverityForCategory, severityMeetsThreshold } from '../../src/compat/config.js';
import { diffSnapshots } from '../../src/compat/differ.js';
import type { CompatDiffResult } from '../../src/compat/differ.js';
import { registerExtractor } from '../../src/compat/extractor-registry.js';
import { apiSurfaceToSnapshot } from '../../src/compat/ir.js';
import type { CompatSnapshot, CompatSymbol } from '../../src/compat/ir.js';
import { formatHumanSummary, generateReport } from '../../src/compat/report.js';
import { COMPAT_SCHEMA_VERSION, isCompatibleSchemaVersion, validateSnapshot } from '../../src/compat/schema.js';
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
 * #750: every extractor's surface carries each interface field's
 * optionality, each interface's supertypes and each type alias's value, and
 * the bridge to a compat snapshot kept a field's name and type and an alias's
 * name. So a required field added to an options interface was an additive
 * `symbol_added`, one added to an options type alias was not reported, and a
 * retype to a type that extends the old one was as breaking as a retype to an
 * unrelated type.
 */

// ---------------------------------------------------------------------------
// SDKs on disk, through the extractors
// ---------------------------------------------------------------------------

const roots: string[] = [];

function writeSdk(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'oagen-750-'));
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
type Side = 'old' | 'new';
/** `text` in the new SDK, `otherwise` in the old one. */
const inNew = (side: Side, text: string, otherwise = '') => (side === 'new' ? text : otherwise);
const nodeDiff = (source: (side: Side) => string) =>
  compatDiff(nodeExtractor, nodeSdk(source('old')), nodeSdk(source('new')));

/**
 * Several independent cases in one SDK pair, so that the TypeScript program
 * is built twice and not twice per case. Each case writes its names with a
 * `%`, replaced by `_<index>`; the result is each case's own lines, by name.
 */
interface NodeCase {
  name: string;
  source: (side: Side) => string;
  expected: string[];
}

async function nodeCases(cases: NodeCase[]): Promise<Record<string, { expected: string[]; actual: string[] }>> {
  const suffix = (index: number) => `_${index}`;
  const sdk = (side: Side) =>
    nodeSdk(cases.map((entry, index) => entry.source(side).replaceAll('%', suffix(index))).join('\n'));
  const { lines: all } = await compatDiff(nodeExtractor, sdk('old'), sdk('new'));
  return Object.fromEntries(
    cases.map((entry, index) => [
      entry.name,
      {
        expected: entry.expected.map((line) => line.replaceAll('%', suffix(index))),
        actual: all.filter((line) =>
          line
            .split(' ')[2]
            .split('.')
            .some((segment) => segment.endsWith(suffix(index))),
        ),
      },
    ]),
  );
}

/** A snapshot as one written before #750: no `optional`, `extends` or
 *  `aliasOf`, and no members under a type alias. The gate that compared the
 *  two writers on real SDKs found exactly these differences. */
function writtenBefore750(snapshot: CompatSnapshot): CompatSnapshot {
  const aliases = new Set(snapshot.symbols.filter((sym) => sym.aliasOf !== undefined).map((sym) => sym.fqName));
  return {
    ...snapshot,
    symbols: snapshot.symbols
      .filter((sym) => !(sym.kind === 'field' && sym.ownerFqName !== undefined && aliases.has(sym.ownerFqName)))
      .map(({ optional: _optional, extends: _extends, aliasOf: _aliasOf, ...rest }) => rest),
  };
}

// ---------------------------------------------------------------------------
// The issue's SDKs
// ---------------------------------------------------------------------------

const PETS_CLIENT = `
export declare class PetsClient {
  create(options: CreatePetOptions): Promise<Pet>;
  update(petId: string, options: UpdatePetOptions): Promise<Pet>;
}
`;

const issueSdk = (createOptions: string, updateOptions: string) => `export interface Pet { id: string; name: string }
export type CreatePetOptions = ${createOptions};
export interface UpdatePetOptions ${updateOptions}
${PETS_CLIENT}`;

describe("#750 the issue's SDKs", () => {
  it('reports a required field added to both options types as breaking', async () => {
    const result = await nodeDiff((side) =>
      issueSdk(
        `{ name: string${inNew(side, '; ownerId: string')} }`,
        `{ name?: string${inNew(side, '; ownerId: string')} }`,
      ),
    );
    expect(result.report).toMatchInlineSnapshot(`
      "Compat report:
        2 breaking, 0 soft-risk, 0 additive

        Breaking:
          [field_requiredness_increased] UpdatePetOptions.ownerId — Required field "ownerId" added to "UpdatePetOptions", which callers of "PetsClient.update" pass in
          [field_requiredness_increased] CreatePetOptions.ownerId — Required field "ownerId" added to "CreatePetOptions", which callers of "PetsClient.create" pass in"
    `);
    expect(result.exitCode).toBe(1);
    // One change per field: the breaking one, not a `symbol_added` beside it.
    expect(generateReport(result.diff).changes).toMatchInlineSnapshot(`
      [
        {
          "category": "field_requiredness_increased",
          "conceptualChangeId": "chg_field_requiredness_increased_updatepetoptions.ownerid",
          "message": "Required field "ownerId" added to "UpdatePetOptions", which callers of "PetsClient.update" pass in",
          "new": {
            "field": "ownerId",
            "required": "true",
            "takenBy": "PetsClient.update",
          },
          "old": {
            "field": "(absent)",
          },
          "provenance": "unknown",
          "severity": "breaking",
          "symbol": "UpdatePetOptions.ownerId",
        },
        {
          "category": "field_requiredness_increased",
          "conceptualChangeId": "chg_field_requiredness_increased_createpetoptions.ownerid",
          "message": "Required field "ownerId" added to "CreatePetOptions", which callers of "PetsClient.create" pass in",
          "new": {
            "field": "ownerId",
            "required": "true",
            "takenBy": "PetsClient.create",
          },
          "old": {
            "field": "(absent)",
          },
          "provenance": "unknown",
          "severity": "breaking",
          "symbol": "CreatePetOptions.ownerId",
        },
      ]
    `);
  });

  it('keeps each field with its optionality, each interface with its supertypes, an alias with its members', async () => {
    const snapshot = await snapshotOf(
      nodeExtractor,
      nodeSdk(issueSdk('{ name: string; ownerId: string }', '{ name?: string; ownerId: string }')),
    );
    const recorded = snapshot.symbols
      .filter((sym) => sym.kind === 'alias' || sym.kind === 'field')
      .map(({ id, optional, extends: supertypes, aliasOf, typeRef }) => ({
        id,
        optional,
        extends: supertypes,
        aliasOf,
        typeRef,
      }));
    expect(recorded).toMatchInlineSnapshot(`
      [
        {
          "aliasOf": undefined,
          "extends": [],
          "id": "iface:Pet",
          "optional": undefined,
          "typeRef": undefined,
        },
        {
          "aliasOf": undefined,
          "extends": undefined,
          "id": "field:Pet.id",
          "optional": false,
          "typeRef": {
            "name": "string",
          },
        },
        {
          "aliasOf": undefined,
          "extends": undefined,
          "id": "field:Pet.name",
          "optional": false,
          "typeRef": {
            "name": "string",
          },
        },
        {
          "aliasOf": undefined,
          "extends": [],
          "id": "iface:UpdatePetOptions",
          "optional": undefined,
          "typeRef": undefined,
        },
        {
          "aliasOf": undefined,
          "extends": undefined,
          "id": "field:UpdatePetOptions.name",
          "optional": true,
          "typeRef": {
            "name": "string",
          },
        },
        {
          "aliasOf": undefined,
          "extends": undefined,
          "id": "field:UpdatePetOptions.ownerId",
          "optional": false,
          "typeRef": {
            "name": "string",
          },
        },
        {
          "aliasOf": "{ name: string; ownerId: string; }",
          "extends": [],
          "id": "alias:CreatePetOptions",
          "optional": undefined,
          "typeRef": undefined,
        },
        {
          "aliasOf": undefined,
          "extends": undefined,
          "id": "field:CreatePetOptions.name",
          "optional": false,
          "typeRef": {
            "name": "string",
          },
        },
        {
          "aliasOf": undefined,
          "extends": undefined,
          "id": "field:CreatePetOptions.ownerId",
          "optional": false,
          "typeRef": {
            "name": "string",
          },
        },
      ]
    `);
    // The keys are left out where they do not apply, never written as undefined.
    for (const sym of snapshot.symbols) {
      for (const key of ['optional', 'extends', 'aliasOf'] as const) {
        if (sym[key] === undefined) expect(Object.keys(sym), `${sym.id}.${key}`).not.toContain(key);
      }
    }
    // A class, its methods and its properties carry none of the three.
    for (const sym of snapshot.symbols.filter((entry) => entry.fqName.startsWith('PetsClient'))) {
      expect(sym).not.toHaveProperty('optional');
      expect(sym).not.toHaveProperty('extends');
      expect(sym).not.toHaveProperty('aliasOf');
    }
  });

  it('keeps an optional field added to both options types additive', async () => {
    const result = await nodeDiff((side) =>
      issueSdk(
        `{ name: string${inNew(side, '; ownerId?: string')} }`,
        `{ name?: string${inNew(side, '; ownerId?: string')} }`,
      ),
    );
    // Two additions where there was one: the alias's member is now seen, as the interface's is.
    expect(result.report).toMatchInlineSnapshot(`
      "Compat report:
        0 breaking, 0 soft-risk, 2 additive

        Additive: 2 new symbol(s)"
    `);
    expect(result.lines).toEqual([
      'additive symbol_added UpdatePetOptions.ownerId',
      'additive symbol_added CreatePetOptions.ownerId',
    ]);
    expect(result.exitCode).toBe(0);
  });

  it('reports a field retyped to a type that declares it extends the old one as soft-risk', async () => {
    const result = await nodeDiff(
      (side) => `export interface ErrorBody { message: string }
export interface DetailedErrorBody extends ErrorBody { details?: string }

export declare class PetsError extends Error {
  body: ${inNew(side, 'DetailedErrorBody', 'ErrorBody')};
}
`,
    );
    expect(result.report).toMatchInlineSnapshot(`
      "Compat report:
        0 breaking, 1 soft-risk, 0 additive

        Soft-risk:
          [field_type_changed] PetsError.body — Type changed for "PetsError.body" from "ErrorBody" to "DetailedErrorBody"
            hint: Field type swap from "ErrorBody" to "DetailedErrorBody" narrows to a declared subtype — "DetailedErrorBody" extends "ErrorBody", so every value of the new type is still a value of the old one. Code that reads the value continues to work; only code that produces one (a test double, an override) has to supply "DetailedErrorBody"."
    `);
    expect(result.exitCode).toBe(0);
    expect(result.candidate.symbols.find((sym) => sym.fqName === 'DetailedErrorBody')?.extends).toEqual(['ErrorBody']);
  });
});

// ---------------------------------------------------------------------------
// The category
// ---------------------------------------------------------------------------

describe('#750 field_requiredness_increased', () => {
  it('is a breaking category by default', () => {
    expect(defaultSeverityForCategory('field_requiredness_increased')).toBe('breaking');
  });

  it('is approved by its symbol and category, as any change is', async () => {
    const { diff } = await nodeDiff((side) =>
      issueSdk(
        `{ name: string${inNew(side, '; ownerId: string')} }`,
        `{ name?: string${inNew(side, '; ownerId: string')} }`,
      ),
    );
    const matches = applyApprovals(
      diff.changes,
      [{ symbol: 'UpdatePetOptions.ownerId', category: 'field_requiredness_increased', reason: 'v3' }],
      'node',
    );
    expect(matches.map((match) => [match.change.symbol, match.approved])).toEqual([
      ['UpdatePetOptions.ownerId', true],
      ['CreatePetOptions.ownerId', false],
    ]);
  });
});

// ---------------------------------------------------------------------------
// What the bridge writes
// ---------------------------------------------------------------------------

const surface = (parts: Partial<ApiSurface>): ApiSurface => ({
  language: 'node',
  extractedFrom: '/sdk',
  extractedAt: '2026-01-01T00:00:00.000Z',
  classes: {},
  interfaces: {},
  typeAliases: {},
  enums: {},
  exports: {},
  ...parts,
});
const byId = (snapshot: CompatSnapshot, id: string): CompatSymbol | undefined =>
  snapshot.symbols.find((sym) => sym.id === id);

describe('#750 apiSurfaceToSnapshot', () => {
  it('writes a field with the optionality its surface states', () => {
    const snapshot = apiSurfaceToSnapshot(
      surface({
        interfaces: {
          Options: {
            name: 'Options',
            fields: {
              required: { name: 'required', type: 'string', optional: false },
              optional: { name: 'optional', type: 'string', optional: true },
            },
            extends: ['Base', 'Mixin<Options>'],
          },
        },
      }),
    );
    expect(byId(snapshot, 'iface:Options')).toMatchObject({ kind: 'alias', extends: ['Base', 'Mixin<Options>'] });
    expect(byId(snapshot, 'field:Options.required')).toMatchObject({ optional: false, typeRef: { name: 'string' } });
    expect(byId(snapshot, 'field:Options.optional')).toMatchObject({ optional: true });
  });

  it('writes no optionality where the surface says it is a placeholder', () => {
    const snapshot = apiSurfaceToSnapshot(
      surface({
        interfaces: {
          Options: {
            name: 'Options',
            fields: { key: { name: 'key', type: 'str', optional: false } },
            extends: ['Base'],
            fieldOptionalityUnknown: true,
          },
        },
      }),
    );
    expect(byId(snapshot, 'field:Options.key')).not.toHaveProperty('optional');
    // The supertypes are known all the same.
    expect(byId(snapshot, 'iface:Options')?.extends).toEqual(['Base']);
  });

  it('writes an alias with members as an interface is written, and any other alias by name and value', () => {
    const snapshot = apiSurfaceToSnapshot(
      surface({
        typeAliases: {
          Options: {
            name: 'Options',
            value: 'Base & { name: string; tag?: string | undefined; }',
            fields: {
              name: { name: 'name', type: 'string', optional: false },
              tag: { name: 'tag', type: 'string', optional: true },
            },
            extends: ['Base'],
            sourceFile: 'src/options.ts',
          },
          Empty: { name: 'Empty', value: '{}', fields: {}, extends: [] },
          Union: { name: 'Union', value: 'A | B' },
        },
      }),
    );
    expect(snapshot.symbols).toEqual([
      expect.objectContaining({
        id: 'alias:Options',
        kind: 'alias',
        extends: ['Base'],
        aliasOf: 'Base & { name: string; tag?: string | undefined; }',
        sourceFile: 'src/options.ts',
      }),
      {
        id: 'field:Options.name',
        kind: 'field',
        fqName: 'Options.name',
        ownerFqName: 'Options',
        displayName: 'Options.name',
        visibility: 'public',
        stability: 'stable',
        sourceKind: 'generated_resource_constructor',
        typeRef: { name: 'string' },
        optional: false,
        sourceFile: 'src/options.ts',
      },
      expect.objectContaining({ id: 'field:Options.tag', optional: true }),
      expect.objectContaining({ id: 'alias:Empty', extends: [], aliasOf: '{}' }),
      expect.objectContaining({ id: 'alias:Union', aliasOf: 'A | B' }),
    ]);
    expect(byId(snapshot, 'alias:Union')).not.toHaveProperty('extends');
  });

  it('does not bump the schema version: every key it adds is one a reader may ignore', () => {
    const snapshot = apiSurfaceToSnapshot(surface({}));
    expect(COMPAT_SCHEMA_VERSION).toBe('1');
    expect(snapshot.schemaVersion).toBe('1');
    expect(isCompatibleSchemaVersion(snapshot)).toBe(true);
    expect(validateSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
  });

  it('reads a surface written before the keys existed, and one that holds something else there', () => {
    const before = apiSurfaceToSnapshot(
      surface({
        // A surface file an older version wrote: no `fields` on an alias.
        typeAliases: { Options: { name: 'Options', value: '{ name: string; }' } },
        interfaces: {
          Pet: { name: 'Pet', fields: { id: { name: 'id', type: 'string', optional: false } }, extends: [] },
        },
      }),
    );
    expect(before.symbols.map((sym) => sym.id)).toEqual(['iface:Pet', 'field:Pet.id', 'alias:Options']);

    const kinds: unknown[] = [true, false, null, 0, 1, '', 'x', [], ['x'], [1, null], {}, { a: 1 }];
    for (const value of kinds) {
      const label = JSON.stringify(value);
      const odd = apiSurfaceToSnapshot(
        surface({
          interfaces: {
            Pet: {
              name: 'Pet',
              fields: { id: { name: 'id', type: 'string', optional: value as never } },
              extends: value as never,
              fieldOptionalityUnknown: value as never,
            },
          },
          typeAliases: {
            A: { name: 'A', value: value as never, fields: value as never, extends: value as never },
            B: { name: 'B', value: 'x', fields: { member: value as never }, extends: ['Base', value as never] },
            C: { name: 'C', value: 'x', fields: { member: { name: 'member', type: value as never, optional: false } } },
          },
        }),
      );
      // `optional` only as a boolean, `extends` only as a list of names, an
      // alias's members only as typed fields; anything else is not recorded.
      const id = byId(odd, 'field:Pet.id');
      if (typeof value === 'boolean' && value !== true) expect(id, label).toHaveProperty('optional', value);
      else if (value !== true) expect(id, label).not.toHaveProperty('optional');
      expect(byId(odd, 'iface:Pet')?.extends, label).toEqual(
        Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [],
      );
      expect(byId(odd, 'alias:B'), label).not.toHaveProperty('extends');
      expect(byId(odd, 'field:B.member'), label).toBeUndefined();
      if (typeof value === 'string')
        expect(byId(odd, 'field:C.member'), label).toMatchObject({ typeRef: { name: value } });
      else expect(byId(odd, 'alias:C'), label).not.toHaveProperty('extends');
      // `{}` is a record of no members; nothing else here is a record of members.
      if (label === '{}') expect(byId(odd, 'alias:A'), label).toMatchObject({ extends: [] });
      else expect(byId(odd, 'alias:A'), label).not.toHaveProperty('extends');
      expect(() => diffSnapshots(before, odd), label).not.toThrow();
      expect(() => diffSnapshots(odd, before), label).not.toThrow();
      expect(diffSnapshots(odd, odd).changes, label).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// What the node extractor reads
// ---------------------------------------------------------------------------

describe('#750 nodeExtractor', () => {
  let extracted: ApiSurface;

  beforeAll(async () => {
    extracted = await nodeExtractor.extract(
      writeSdk(
        nodeSdk(`export interface Owner { email: string; ownerId: string; note?: string }
export interface Tagged { tag?: string }
export declare class Klass { a: string; private secret: string; protected guarded: string; #hard: string }
export type Paged<T> = { data: T[]; next?: string };
export type WithSymbolKey = { [Symbol.iterator](): Iterator<string>; name: string };
export type ObjectType = { name: string; tag?: string; retry?(attempt: number): void; ping(): void };
export type Empty = {};
export type Parenthesized = ({ name: string });
export type IndexSignature = { [key: string]: Owner };
export type Intersection = Owner & { name: string };
export type IntersectionOfNames = Owner & Tagged;
export type IntersectionWithOmit = Omit<Owner, 'email'> & { name: string };
export type IntersectionConflict = { name?: string } & { name: string };
export type IntersectionBothOptional = { name?: string } & { name?: string };
export type IntersectionWithClass = Klass & { name: string };
export type OmitAlias = Omit<Owner, 'email'>;
export type PickAlias = Pick<Owner, 'email' | 'note'>;
export type PartialAlias = Partial<Owner>;
export type RequiredAlias = Required<Owner>;
export type ReadonlyAlias = Readonly<Owner>;
export type RecordOfKeys = Record<'a' | 'b', string>;
export type RecordOfStrings = Record<string, Owner>;
export type Mapped = { [K in 'x' | 'y']?: number };
export type Instantiated = Paged<Owner>;
const config = { region: 'us', retries: 3 };
export type TypeOf = typeof config;
export type Reference = Owner;
export type ReferenceToClass = Klass;
export type ReferenceToAlias = ObjectType;
export type ArrayAlias = Owner[];
export type ArrayGeneric = Array<Owner>;
export type Tuple = [Owner, string];
export type PromiseAlias = Promise<Owner>;
export type MapAlias = Map<string, Owner>;
export type FunctionAlias = (owner: Owner) => void;
export type ConstructorAlias = new () => Owner;
export type CallableObject = { (x: string): void; prop: string };
export type Union = Owner | Tagged;
export type NullableObject = { a: string } | null;
export type Primitive = string;
export type LiteralUnion = 'a' | 'b';
export type TemplateLiteral = \`x-\${string}\`;
export type Conditional<T> = T extends string ? Owner : Tagged;
export type ConditionalResolved = Conditional<string>;
export type OverTypeParameter<T> = T & { tag: string };
export type Branded = string & { __brand: true };
export type IntersectionWithUnion = Owner & ({ a: string } | { b: string });
export type KeyOf = keyof Owner;
export type Indexed = Owner['email'];
export type ObjectKeyword = object;
`),
      ),
    );
  });

  /** `name` for a required member, `name?` for an optional one. */
  const members = (name: string): string[] | undefined => {
    const fields = extracted.typeAliases[name].fields;
    return fields && Object.values(fields).map((member) => `${member.name}${member.optional ? '?' : ''}`);
  };

  it.each([
    ['ObjectType', ['name', 'ping', 'retry?', 'tag?'], []],
    ['Empty', [], []],
    ['Parenthesized', ['name'], []],
    ['IndexSignature', [], []],
    ['Paged', ['data', 'next?'], []],
    // An intersection: every member the checker resolves, the named types' included.
    ['Intersection', ['email', 'name', 'note?', 'ownerId'], ['Owner']],
    ['IntersectionOfNames', ['email', 'note?', 'ownerId', 'tag?'], ['Owner', 'Tagged']],
    ['IntersectionWithOmit', ['name', 'note?', 'ownerId'], ["Omit<Owner, 'email'>"]],
    // Of a class, the members a caller can name.
    ['IntersectionWithClass', ['a', 'name'], ['Klass']],
    // A member keyed by a symbol has no name that is stable between two programs.
    ['WithSymbolKey', ['name'], []],
    // A member is optional only while every part of the intersection says so.
    ['IntersectionConflict', ['name'], []],
    ['IntersectionBothOptional', ['name?'], []],
    // What a mapped type comes to, with the optionality it gives each member.
    ['OmitAlias', ['note?', 'ownerId'], []],
    ['PickAlias', ['email', 'note?'], []],
    ['PartialAlias', ['email?', 'note?', 'ownerId?'], []],
    ['RequiredAlias', ['email', 'note', 'ownerId'], []],
    ['ReadonlyAlias', ['email', 'note?', 'ownerId'], []],
    ['RecordOfKeys', ['a', 'b'], []],
    ['RecordOfStrings', [], []],
    ['Mapped', ['x?', 'y?'], []],
    ['Instantiated', ['data', 'next?'], []],
    ['TypeOf', ['region', 'retries'], []],
  ])('reads the members of %s', (name, expectedMembers, expectedSupertypes) => {
    expect(members(name)).toEqual(expectedMembers);
    expect(extracted.typeAliases[name].extends).toEqual(expectedSupertypes);
  });

  it.each([
    // another declared type under a second name
    ['Reference', 'Owner'],
    ['ReferenceToClass', 'Klass'],
    ['ReferenceToAlias', '{ name: string; tag?: string | undefined; retry?(attempt: number): void; ping(): void; }'],
    ['ConditionalResolved', 'Owner'],
    // an instantiation of an interface or a class, a tuple, a function
    ['ArrayAlias', 'Owner[]'],
    ['ArrayGeneric', 'Owner[]'],
    ['Tuple', '[Owner, string]'],
    ['PromiseAlias', 'Promise<Owner>'],
    ['MapAlias', 'Map<string, Owner>'],
    ['FunctionAlias', '(owner: Owner) => void'],
    ['ConstructorAlias', 'new () => Owner'],
    ['CallableObject', '{ (x: string): void; prop: string; }'],
    // not one object type
    ['Union', 'Owner | Tagged'],
    ['NullableObject', '{ a: string; } | null'],
    ['Primitive', 'string'],
    ['LiteralUnion', '"a" | "b"'],
    ['TemplateLiteral', '`x-${string}`'],
    ['Conditional', 'T extends string ? Owner : Tagged'],
    ['OverTypeParameter', 'T & { tag: string; }'],
    ['Branded', 'string & { __brand: true; }'],
    ['IntersectionWithUnion', 'Owner & ({ a: string; } | { b: string; })'],
    ['KeyOf', 'keyof Owner'],
    ['Indexed', 'string'],
    ['ObjectKeyword', 'object'],
  ])('records %s by name and value', (name, value) => {
    expect(extracted.typeAliases[name]).toEqual({ name, value, sourceFile: 'src/index.ts' });
  });

  it("records an alias's value as it always has, with or without members", () => {
    expect(extracted.typeAliases.ObjectType.value).toBe(
      '{ name: string; tag?: string | undefined; retry?(attempt: number): void; ping(): void; }',
    );
    expect(extracted.typeAliases.OmitAlias.value).toBe('{ ownerId: string; note?: string | undefined; }');
    expect(extracted.typeAliases.Intersection.value).toBe('Owner & { name: string; }');
  });

  it("reads a member off the alias's resolved type, not off one of its declarations", async () => {
    const extracted = await nodeExtractor.extract(
      writeSdk(
        nodeSdk(`export type Plain = { a: string | undefined };
export type OptionalPartFirst = { a?: string } & { a: string | undefined };
export type OptionalPartLast = { a: string | undefined } & { a?: string };
export type Narrowed = { a?: string } & { a: string };
export type BothOptional = { a?: string | undefined } & { a?: string };
export type ThroughPartial = Partial<{ a: string }>;
export type ThroughRequired = Required<{ a?: string }>;
export type PartialAndRequired = Partial<{ a: string }> & Required<{ a?: string }>;
export type InlineTwice = { a: () => void } & { a: () => void };
export type InlineTwiceOptional = { a?: { x: number } } & { a?: { x: number } };
export type TwoInlineTypes = { a: { x: number } } & { a: { y: string } };
`),
      ),
    );
    const member = (name: string) => extracted.typeAliases[name].fields?.a;
    // A required member that admits undefined: the `?` of the first part does not take the `undefined` out.
    const requiredOrUndefined = { name: 'a', type: 'string | undefined', optional: false };
    expect(member('Plain')).toEqual(requiredOrUndefined);
    expect(member('OptionalPartFirst')).toEqual(requiredOrUndefined);
    expect(member('OptionalPartLast')).toEqual(requiredOrUndefined);
    expect(member('Narrowed')).toEqual({ name: 'a', type: 'string', optional: false });
    expect(member('ThroughRequired')).toEqual({ name: 'a', type: 'string', optional: false });
    expect(member('PartialAndRequired')).toEqual({ name: 'a', type: 'string', optional: false });
    // An optional member: the `undefined` its optionality adds is left out, whoever made it optional.
    expect(member('BothOptional')).toEqual({ name: 'a', type: 'string', optional: true });
    expect(member('ThroughPartial')).toEqual({ name: 'a', type: 'string', optional: true });
    // One inline type declared by two parts is that type, not an intersection with itself.
    expect(member('InlineTwice')).toEqual({ name: 'a', type: '() => void', optional: false });
    expect(member('InlineTwiceOptional')).toEqual({ name: 'a', type: '{ x: number; }', optional: true });
    expect(member('TwoInlineTypes')).toEqual({ name: 'a', type: '{ x: number; } & { y: string; }', optional: false });
  });

  it("keeps an interface's field as every baseline holds it", async () => {
    // An interface's type text has always been decided by the `?` of the
    // member's property signature, so a member that is optional without one
    // keeps its `| undefined`. Its optionality is the checker's all the same.
    const twins = await nodeExtractor.extract(
      writeSdk(
        nodeSdk(`export interface Base { name: string; count: number }
export interface AsInterface extends Partial<Base> { tag?: string; list: string[]; retry?(attempt: number): void; ping(): void }
export type AsAlias = Partial<Base> & { tag?: string; list: string[]; retry?(attempt: number): void; ping(): void };
`),
      ),
    );
    expect(twins.interfaces.AsInterface.fields).toEqual({
      count: { name: 'count', type: 'number | undefined', optional: true },
      list: { name: 'list', type: 'string[]', optional: false },
      name: { name: 'name', type: 'string | undefined', optional: true },
      ping: { name: 'ping', type: '() => void', optional: false },
      retry: { name: 'retry', type: '((attempt: number) => void) | undefined', optional: true },
      tag: { name: 'tag', type: 'string', optional: true },
    });
    // The alias agrees on every member's optionality, and on the text of each
    // one whose `?` stands on a property signature or that is required.
    expect(twins.typeAliases.AsAlias.fields).toEqual({
      count: { name: 'count', type: 'number', optional: true },
      list: { name: 'list', type: 'string[]', optional: false },
      name: { name: 'name', type: 'string', optional: true },
      ping: { name: 'ping', type: '() => void', optional: false },
      retry: { name: 'retry', type: '((attempt: number) => void)', optional: true },
      tag: { name: 'tag', type: 'string', optional: true },
    });
  });
});

// ---------------------------------------------------------------------------
// One member, written every way an alias can write it
// ---------------------------------------------------------------------------

/** The type of the member `a`, as the forms below take it. */
const MEMBER_TYPES = ['string', 'string | null', 'string[]', "'a' | 'b'", '() => void', '{ x: number }'];

/**
 * Ways to write an alias with one member `a` of type `T`: required or
 * optional, admitting `undefined` or not, through an object type, the parts
 * of an intersection, a mapped type, a utility type, a generic alias, and
 * declared interfaces (one of them declared twice). `%` is the index of `T`
 * in the names declared beside the forms.
 */
const MEMBER_FORMS: Array<(t: string) => string> = [
  (t) => `{ a: ${t} }`,
  (t) => `{ a?: ${t} }`,
  (t) => `{ a: (${t}) | undefined }`,
  (t) => `{ a?: (${t}) | undefined }`,
  (t) => `{ readonly a: ${t} }`,
  (t) => `{ a?: ${t} } & { a: ${t} }`,
  (t) => `{ a: ${t} } & { a?: ${t} }`,
  (t) => `{ a?: ${t} } & { a: (${t}) | undefined }`,
  (t) => `{ a: (${t}) | undefined } & { a?: ${t} }`,
  (t) => `{ a?: ${t} } & { a?: ${t} }`,
  (t) => `{ a?: (${t}) | undefined } & { a?: ${t} }`,
  (t) => `{ a: ${t} } & { a: (${t}) | undefined }`,
  (t) => `Partial<{ a: ${t} }>`,
  (t) => `Partial<{ a: (${t}) | undefined }>`,
  (t) => `Required<{ a?: ${t} }>`,
  (t) => `Required<{ a?: (${t}) | undefined }>`,
  (t) => `Partial<{ a: ${t} }> & Required<{ a?: ${t} }>`,
  (t) => `Readonly<{ a?: ${t} }>`,
  (t) => `{ [K in 'a']: ${t} }`,
  (t) => `{ [K in 'a']?: ${t} }`,
  (t) => `{ [K in 'a']-?: (${t}) | undefined }`,
  (t) => `Pick<{ a?: ${t}; b: number }, 'a'>`,
  (t) => `Pick<{ [K in 'a' | 'b']?: ${t} }, 'a'>`,
  (t) => `Omit<{ a: ${t}; b: number }, 'b'>`,
  (t) => `Record<'a', ${t}>`,
  (t) => `Box<${t}>`,
  (t) => `OptionalBox<${t}>`,
  () => 'Declared% & DeclaredAgain%',
  (t) => `RequiredDeclared% & { a?: ${t} }`,
  () => `Pick<DeclaredTwice%, 'a'>`,
  () => `Omit<DeclaredTwice%, 'b'>`,
];
/** The two forms in which one part declares the member optional and another
 *  declares it required and admitting `undefined`. */
const OPTIONAL_PART_BESIDE_REQUIRED_OR_UNDEFINED = new Set([7, 8]);

const aliasName = (type: number, form: number) => `Form${form}_${type}`;

/**
 * The SDK that declares every form for every member type, what `tsc` makes
 * of each pair of forms (an assignment each way, in a file of its own that
 * the SDK does not export), and what the extractor records for each form.
 */
const memberTables = new Map<string, ReturnType<typeof buildMemberTable>>();
function memberTable(compilerOptions: ts.CompilerOptions): ReturnType<typeof buildMemberTable> {
  const mode = JSON.stringify(compilerOptions);
  if (!memberTables.has(mode)) memberTables.set(mode, buildMemberTable(compilerOptions));
  return memberTables.get(mode)!;
}

async function buildMemberTable(compilerOptions: ts.CompilerOptions) {
  const index = ['export type Box<V> = { a: V };', 'export type OptionalBox<V> = { a?: V };'];
  const check = ["import type * as sdk from './index.js';"];
  const assignment = new Map<number, string>();
  const key = (type: number, from: number, to: number) => `${type}:${from}:${to}`;
  MEMBER_TYPES.forEach((memberType, type) => {
    index.push(
      `export interface Declared_${type} { a?: ${memberType} }`,
      `export interface DeclaredAgain_${type} { a?: ${memberType} }`,
      `export interface RequiredDeclared_${type} { a: ${memberType} }`,
      `export interface DeclaredTwice_${type} { a?: ${memberType} }`,
      `export interface DeclaredTwice_${type} { b?: number }`,
    );
    MEMBER_FORMS.forEach((form, index_) => {
      index.push(`export type ${aliasName(type, index_)} = ${form(memberType).replaceAll('%', `_${type}`)};`);
    });
    MEMBER_FORMS.forEach((_, from) => {
      MEMBER_FORMS.forEach((_, to) => {
        if (from === to) return;
        assignment.set(check.length, key(type, from, to));
        check.push(
          `export const c_${type}_${from}_${to}: sdk.${aliasName(type, to)} = null! as sdk.${aliasName(type, from)};`,
        );
      });
    });
  });
  const root = writeSdk({
    'tsconfig.json': JSON.stringify({ compilerOptions: { ...compilerOptions, noEmit: true }, include: ['src'] }),
    'src/index.ts': index.join('\n'),
    'src/check.ts': check.join('\n'),
  });

  // `tsc -p <root>`: the diagnostics of the file of assignments, by line.
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config,
    ts.sys,
    root,
  );
  const program = ts.createProgram(config.fileNames, config.options);
  const checkFile = program.getSourceFile(join(root, 'src/check.ts'))!;
  const refused = new Set(
    program
      .getSemanticDiagnostics(checkFile)
      .map((diagnostic) => assignment.get(checkFile.getLineAndCharacterOfPosition(diagnostic.start!).line)),
  );
  const mutuallyAssignable = (type: number, one: number, other: number) =>
    !refused.has(key(type, one, other)) && !refused.has(key(type, other, one));

  const extracted = await nodeExtractor.extract(root);
  const record = (type: number, form: number) => extracted.typeAliases[aliasName(type, form)].fields;
  /** An SDK whose `Options` alias is the form, taken by a method. */
  const snapshot = (type: number, form: number) =>
    apiSurfaceToSnapshot({
      language: 'node',
      extractedFrom: root,
      extractedAt: '2026-01-01T00:00:00.000Z',
      classes: {
        Client: {
          name: 'Client',
          methods: {
            send: [
              {
                name: 'send',
                params: [{ name: 'options', type: 'Options', optional: false }],
                returnType: 'void',
                async: false,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
      interfaces: {},
      typeAliases: { Options: { ...extracted.typeAliases[aliasName(type, form)], name: 'Options' } },
      enums: {},
      exports: {},
    });

  const label = (type: number, form: number) => `T = ${MEMBER_TYPES[type]}: ${MEMBER_FORMS[form]('T')}`;
  const pairs: Array<{ type: number; one: number; other: number; mutual: boolean; sameRecord: boolean }> = [];
  MEMBER_TYPES.forEach((_, type) => {
    for (let one = 0; one < MEMBER_FORMS.length; one++) {
      for (let other = one + 1; other < MEMBER_FORMS.length; other++) {
        pairs.push({
          type,
          one,
          other,
          mutual: mutuallyAssignable(type, one, other),
          sameRecord: JSON.stringify(record(type, one)) === JSON.stringify(record(type, other)),
        });
      }
    }
  });
  return {
    pairs,
    record,
    snapshot,
    label,
    sdkDiagnostics: program.getSemanticDiagnostics(program.getSourceFile(join(root, 'src/index.ts'))!).length,
  };
}

describe('#750 two aliases that accept the same values record the same members', () => {
  const MODES: Array<[string, ts.CompilerOptions]> = [
    ['strict', { strict: true }],
    ['strict with exactOptionalPropertyTypes', { strict: true, exactOptionalPropertyTypes: true }],
    ['not strict', { strict: false }],
  ];

  it.each(MODES)('%s: however each of the two is written', async (_mode, compilerOptions) => {
    const table = await memberTable(compilerOptions);
    expect(table.sdkDiagnostics).toBe(0);
    for (const type of MEMBER_TYPES.keys()) {
      for (const form of MEMBER_FORMS.keys()) expect(table.record(type, form), table.label(type, form)).toBeDefined();
    }
    const mutual = table.pairs.filter((pair) => pair.mutual);
    // The table says something: hundreds of pairs `tsc` assigns each way, and hundreds it does not.
    expect(mutual.length).toBeGreaterThan(500);
    expect(table.pairs.length - mutual.length).toBeGreaterThan(500);

    // The same members, optionality and type text…
    const recordedApart = mutual
      .filter((pair) => !pair.sameRecord)
      .map((pair) => `${table.label(pair.type, pair.one)}  and  ${table.label(pair.type, pair.other)}`);
    expect(recordedApart).toEqual([]);

    // …so that rewriting one as the other is no change, in either direction.
    const reported = mutual.flatMap((pair) => [
      ...lines(diffSnapshots(table.snapshot(pair.type, pair.one), table.snapshot(pair.type, pair.other))),
      ...lines(diffSnapshots(table.snapshot(pair.type, pair.other), table.snapshot(pair.type, pair.one))),
    ]);
    expect(reported).toEqual([]);
  });

  it.each(MODES)('%s: and two that do not, record different ones', async (_mode, compilerOptions) => {
    const table = await memberTable(compilerOptions);
    const recordedAlike = table.pairs.filter((pair) => !pair.mutual && pair.sameRecord);
    if (compilerOptions.exactOptionalPropertyTypes !== true) {
      expect(
        recordedAlike.map((pair) => `${table.label(pair.type, pair.one)}  and  ${table.label(pair.type, pair.other)}`),
      ).toEqual([]);
      return;
    }
    // With exactOptionalPropertyTypes one shape is recorded as what it reads
    // as, though `tsc` writes it otherwise: `{ a?: T } & { a: T | undefined }`
    // has a required `a` of type `T | undefined`, into which no `undefined`
    // may be written. Every pair recorded alike involves it.
    expect(recordedAlike.length).toBeGreaterThan(0);
    for (const pair of recordedAlike) {
      expect(
        OPTIONAL_PART_BESIDE_REQUIRED_OR_UNDEFINED.has(pair.one) ||
          OPTIONAL_PART_BESIDE_REQUIRED_OR_UNDEFINED.has(pair.other),
        `${table.label(pair.type, pair.one)}  and  ${table.label(pair.type, pair.other)}`,
      ).toBe(true);
    }
  });

  it('records the three members a strict SDK can mean by `a`', async () => {
    const table = await memberTable({ strict: true });
    const records = new Map<string, string[]>();
    MEMBER_FORMS.forEach((form, index) => {
      const recorded = Object.values(table.record(0, index) ?? {}).map(
        (field) => `a${field.optional ? '?' : ''}: ${field.type}`,
      )[0];
      records.set(recorded, [...(records.get(recorded) ?? []), form('T').replaceAll('%', '')]);
    });
    expect(Object.fromEntries(records)).toMatchInlineSnapshot(`
      {
        "a: string": [
          "{ a: T }",
          "{ readonly a: T }",
          "{ a?: T } & { a: T }",
          "{ a: T } & { a?: T }",
          "{ a: T } & { a: (T) | undefined }",
          "Required<{ a?: T }>",
          "Required<{ a?: (T) | undefined }>",
          "Partial<{ a: T }> & Required<{ a?: T }>",
          "{ [K in 'a']: T }",
          "Omit<{ a: T; b: number }, 'b'>",
          "Record<'a', T>",
          "Box<T>",
          "RequiredDeclared & { a?: T }",
        ],
        "a: string | undefined": [
          "{ a: (T) | undefined }",
          "{ a?: T } & { a: (T) | undefined }",
          "{ a: (T) | undefined } & { a?: T }",
          "{ [K in 'a']-?: (T) | undefined }",
        ],
        "a?: string": [
          "{ a?: T }",
          "{ a?: (T) | undefined }",
          "{ a?: T } & { a?: T }",
          "{ a?: (T) | undefined } & { a?: T }",
          "Partial<{ a: T }>",
          "Partial<{ a: (T) | undefined }>",
          "Readonly<{ a?: T }>",
          "{ [K in 'a']?: T }",
          "Pick<{ a?: T; b: number }, 'a'>",
          "Pick<{ [K in 'a' | 'b']?: T }, 'a'>",
          "OptionalBox<T>",
          "Declared & DeclaredAgain",
          "Pick<DeclaredTwice, 'a'>",
          "Omit<DeclaredTwice, 'b'>",
        ],
      }
    `);
  });
});

// ---------------------------------------------------------------------------
// A field callers must now supply
// ---------------------------------------------------------------------------

/** A required `ownerId` added to `Owner%`, with the declarations that lead a
 *  callable to `Owner%` (or not). */
const reach = (name: string, declarations: string, expected: string[]): NodeCase => ({
  name,
  source: (side) => `export interface Owner% { email: string${inNew(side, '; ownerId: string')} }
${declarations}
`,
  expected,
});
const OWNER_BREAKING = 'breaking field_requiredness_increased Owner%.ownerId';
const OWNER_ADDITIVE = 'additive symbol_added Owner%.ownerId';
const takes = (type: string) => `export declare class Client% { create(options: ${type}): Promise<string>; }`;

describe('#750 a required field added to a type', () => {
  it('is breaking where a callable takes the type, through whatever leads to it', async () => {
    const cases = await nodeCases([
      // the parameter's own type
      reach('parameter', takes('Owner%'), [OWNER_BREAKING]),
      reach('optional parameter', 'export declare class Client% { create(options?: Owner%): void; }', [OWNER_BREAKING]),
      reach('array parameter', takes('Owner%[]'), [OWNER_BREAKING]),
      reach('union parameter', takes('Owner% | string'), [OWNER_BREAKING]),
      reach('rest parameter', 'export declare class Client% { create(...owners: Owner%[]): void; }', [OWNER_BREAKING]),
      reach('destructured parameter', 'export declare class Client% { create({ email }: Owner%): void; }', [
        OWNER_BREAKING,
      ]),
      reach('inline object parameter', takes('{ owner: Owner%; name: string }'), [OWNER_BREAKING]),
      reach('generic argument', takes('Promise<Owner%>'), [OWNER_BREAKING]),
      reach('Omit parameter', takes("Omit<Owner%, 'email'>"), [OWNER_BREAKING]),
      reach('constructor parameter', 'export declare class Client% { constructor(options: Owner%); }', [
        OWNER_BREAKING,
      ]),
      // a field of the parameter's type
      reach('field', `export interface Options% { owner: Owner% }\n${takes('Options%')}`, [OWNER_BREAKING]),
      reach('optional field', `export interface Options% { owner?: Owner% }\n${takes('Options%')}`, [OWNER_BREAKING]),
      reach('array field', `export interface Options% { owners: Owner%[] }\n${takes('Options%')}`, [OWNER_BREAKING]),
      reach('readonly array field', `export interface Options% { owners: readonly Owner%[] }\n${takes('Options%')}`, [
        OWNER_BREAKING,
      ]),
      reach('nested array field', `export interface Options% { owners: Owner%[][] }\n${takes('Options%')}`, [
        OWNER_BREAKING,
      ]),
      reach('record field', `export interface Options% { owners: Record<string, Owner%> }\n${takes('Options%')}`, [
        OWNER_BREAKING,
      ]),
      reach('map field', `export interface Options% { owners: Map<string, Owner%[]> }\n${takes('Options%')}`, [
        OWNER_BREAKING,
      ]),
      reach('union field', `export interface Options% { owner: Owner% | string }\n${takes('Options%')}`, [
        OWNER_BREAKING,
      ]),
      reach('nullable field', `export interface Options% { owner: Owner% | null }\n${takes('Options%')}`, [
        OWNER_BREAKING,
      ]),
      reach('inline object field', `export interface Options% { meta: { owner: Owner% } }\n${takes('Options%')}`, [
        OWNER_BREAKING,
      ]),
      reach('tuple field', `export interface Options% { pair: [Owner%, string] }\n${takes('Options%')}`, [
        OWNER_BREAKING,
      ]),
      reach('alias member', `export type Options% = { owner: Owner% };\n${takes('Options%')}`, [OWNER_BREAKING]),
      reach(
        'two levels down',
        `export interface Meta% { owner: Owner% }\nexport interface Options% { meta: Meta% }\n${takes('Options%')}`,
        [OWNER_BREAKING],
      ),
      // a supertype of the parameter's type: its members are the subtype's too
      reach('extends', `export interface Options% extends Owner% { name: string }\n${takes('Options%')}`, [
        'breaking field_requiredness_increased Options%.ownerId',
        OWNER_BREAKING,
      ]),
      reach(
        'extends, through a chain',
        `export interface Mid% extends Owner% { mid?: string }\nexport interface Options% extends Mid% { name: string }\n${takes('Options%')}`,
        [
          'breaking field_requiredness_increased Mid%.ownerId',
          'breaking field_requiredness_increased Options%.ownerId',
          OWNER_BREAKING,
        ],
      ),
      reach(
        'extends an instantiation of',
        `export interface Box%<T> { value: T }\nexport interface Options% extends Box%<Owner%> { name: string }\n${takes('Options%')}`,
        [OWNER_BREAKING],
      ),
      reach(
        'extends Omit<…>',
        `export interface Options% extends Omit<Owner%, 'email'> { name: string }\n${takes('Options%')}`,
        ['breaking field_requiredness_increased Options%.ownerId', OWNER_BREAKING],
      ),
      reach('intersection alias', `export type Options% = Owner% & { name: string };\n${takes('Options%')}`, [
        OWNER_BREAKING,
        'breaking field_requiredness_increased Options%.ownerId',
      ]),
      // a type alias that is recorded by name and value
      reach(
        'union alias',
        `export interface Other% { other: string }\nexport type Options% = Owner% | Other%;\n${takes('Options%')}`,
        [OWNER_BREAKING],
      ),
      reach('array alias', `export type Options% = Owner%[];\n${takes('Options%')}`, [OWNER_BREAKING]),
      reach(
        'alias of an alias',
        `export type Inner% = Owner% | string;\nexport type Options% = Inner%[];\n${takes('Options%')}`,
        [OWNER_BREAKING],
      ),
      // an alias of a mapped type: the member is the alias's own
      reach('Omit alias', `export type Options% = Omit<Owner%, 'email'>;\n${takes('Options%')}`, [
        OWNER_ADDITIVE,
        'breaking field_requiredness_increased Options%.ownerId',
      ]),
      // types that refer to themselves and to each other
      reach(
        'cycle',
        `export interface Node% { owner: Owner%; children: Node%[]; peer: Peer% }\nexport interface Peer% { node: Node% }\n${takes('Node%')}`,
        [OWNER_BREAKING],
      ),
      // taken and returned counts as taken
      reach(
        'taken and returned',
        'export declare class Client% { get(id: string): Promise<Owner%>; save(owner: Owner%): Promise<Owner%>; }',
        [OWNER_BREAKING],
      ),
    ]);
    for (const [name, { expected, actual }] of Object.entries(cases)) expect(actual, name).toEqual(expected);
  });

  it('stays additive where no callable takes the type', async () => {
    const cases = await nodeCases([
      reach('returned only', 'export declare class Client% { get(id: string): Promise<Owner%>; }', [OWNER_ADDITIVE]),
      reach('not used at all', '', [OWNER_ADDITIVE]),
      reach(
        'a field of a returned type',
        `export interface Pet% { owner: Owner% }\nexport declare class Client% { get(id: string): Promise<Pet%>; }`,
        [OWNER_ADDITIVE],
      ),
      reach('a property of a class no callable takes', 'export declare class Holder% { owner: Owner%; }', [
        OWNER_ADDITIVE,
      ]),
      // A `Partial` needs none of the type's required members, a `Pick` only the ones it lists.
      reach('Partial parameter', takes('Partial<Owner%>'), [OWNER_ADDITIVE]),
      reach('Pick parameter', takes("Pick<Owner%, 'email'>"), [OWNER_ADDITIVE]),
      reach(
        'extends Partial<…>',
        `export interface Options% extends Partial<Owner%> { name: string }\n${takes('Options%')}`,
        ['additive symbol_added Options%.ownerId', OWNER_ADDITIVE],
      ),
      reach('Partial alias', `export type Options% = Partial<Owner%>;\n${takes('Options%')}`, [
        OWNER_ADDITIVE,
        'additive symbol_added Options%.ownerId',
      ]),
      reach('Pick alias', `export type Options% = Pick<Owner%, 'email'>;\n${takes('Options%')}`, [OWNER_ADDITIVE]),
      // A quoted name is a string literal, not the type.
      reach('a string literal of the same name', `export declare class Client% { create(kind: 'Owner%'): void; }`, [
        OWNER_ADDITIVE,
      ]),
    ]);
    for (const [name, { expected, actual }] of Object.entries(cases)) expect(actual, name).toEqual(expected);
  });

  it('counts a Partial beside the whole type', async () => {
    const cases = await nodeCases([reach('Partial or whole', takes('Partial<Owner%> | Owner%'), [OWNER_BREAKING])]);
    expect(cases['Partial or whole'].actual).toEqual(cases['Partial or whole'].expected);
  });

  it('leaves a class to its properties, which carry no optionality', async () => {
    const result = await nodeDiff(
      (side) => `export declare class Owner { email: string;${inNew(side, ' ownerId: string;')} }
export declare class PetsClient { assign(petId: string, owner: Owner): Promise<string>; }
`,
    );
    expect(result.lines).toEqual(['additive symbol_added Owner.ownerId']);
    expect(result.candidate.symbols.find((sym) => sym.fqName === 'Owner.ownerId')).not.toHaveProperty('optional');
  });

  it("reads which types are taken from the baseline: today's callers are its callers", async () => {
    // A new type with required fields, taken by a new method.
    const newType = await nodeDiff(
      (side) => `export interface Pet { id: string }
${inNew(side, 'export interface CreatePetOptions { name: string; ownerId: string }\n')}
export declare class PetsClient {
  get(petId: string): Promise<Pet>;
${inNew(side, '  create(options: CreatePetOptions): Promise<Pet>;\n')}}
`,
    );
    expect(newType.lines).toEqual([
      'additive symbol_added PetsClient.create',
      'additive symbol_added CreatePetOptions',
      'additive symbol_added CreatePetOptions.name',
      'additive symbol_added CreatePetOptions.ownerId',
    ]);

    // A type that was only returned, and that a new method now takes.
    const newlyTaken = await nodeDiff(
      (side) => `export interface Pet { id: string${inNew(side, '; ownerId: string')} }
export declare class PetsClient {
  get(petId: string): Promise<Pet>;
${inNew(side, '  save(pet: Pet): Promise<Pet>;\n')}}
`,
    );
    expect(newlyTaken.lines).toEqual(['additive symbol_added PetsClient.save', 'additive symbol_added Pet.ownerId']);

    // A type the baseline's callers build, whose only taker the candidate drops.
    const noLongerTaken = await nodeDiff(
      (side) => `export interface Pet { id: string${inNew(side, '; ownerId: string')} }
export declare class PetsClient {
  get(petId: string): Promise<Pet>;
${inNew(side, '', '  save(pet: Pet): Promise<Pet>;\n')}}
`,
    );
    expect(noLongerTaken.lines).toEqual([
      'breaking symbol_removed PetsClient.save',
      'breaking field_requiredness_increased Pet.ownerId',
    ]);
  });

  it('follows the member, however it is written', async () => {
    const member = (name: string, added: string, expected: string[]): NodeCase => ({
      name,
      source: (side) => `export interface Update% { name?: string;${inNew(side, ` ${added};`)} }
export type Create% = { name: string;${inNew(side, ` ${added};`)} };
export declare class Client% { create(options: Create%): void; update(options: Update%): void; }
`,
      expected,
    });
    const both = (severity: string, category: string, field: string) => [
      `${severity} ${category} Update%.${field}`,
      `${severity} ${category} Create%.${field}`,
    ];
    const cases = await nodeCases([
      member('required property', 'ownerId: string', both('breaking', 'field_requiredness_increased', 'ownerId')),
      member('optional property', 'ownerId?: string', both('additive', 'symbol_added', 'ownerId')),
      // A key that must be written, though its value may be undefined or null.
      member(
        'required, may be undefined',
        'ownerId: string | undefined',
        both('breaking', 'field_requiredness_increased', 'ownerId'),
      ),
      member(
        'required, may be null',
        'ownerId: string | null',
        both('breaking', 'field_requiredness_increased', 'ownerId'),
      ),
      member(
        'required method',
        'retry(attempt: number): void',
        both('breaking', 'field_requiredness_increased', 'retry'),
      ),
      // An optional member without a `?` on a property signature.
      member('optional method', 'retry?(attempt: number): void', both('additive', 'symbol_added', 'retry')),
      member(
        'readonly required property',
        'readonly ownerId: string',
        both('breaking', 'field_requiredness_increased', 'ownerId'),
      ),
    ]);
    for (const [name, { expected, actual }] of Object.entries(cases)) expect(actual, name).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// An existing field's optionality
// ---------------------------------------------------------------------------

describe("#750 an existing field's optionality", () => {
  it('reports optional → required on a type callers build, and no other change of optionality', async () => {
    const flip = (name: string, taken: boolean, before: string, after: string, expected: string[]): NodeCase => ({
      name,
      source: (side) => `export interface Iface% { name: string; ownerId${inNew(side, after, before)}: string }
export type Alias% = { name: string; ownerId${inNew(side, after, before)}: string };
export declare class Client% { ${taken ? 'put(a: Iface%, b: Alias%): void' : 'get(): Promise<Iface% | Alias%>'}; }
`,
      expected,
    });
    const cases = await nodeCases([
      flip('optional → required, taken', true, '?', '', [
        'breaking field_requiredness_increased Iface%.ownerId',
        'breaking field_requiredness_increased Alias%.ownerId',
      ]),
      flip('required → optional, taken', true, '', '?', []),
      flip('optional → required, returned', false, '?', '', []),
      flip('required → optional, returned', false, '', '?', []),
      flip('unchanged, taken', true, '', '', []),
    ]);
    for (const [name, { expected, actual }] of Object.entries(cases)) expect(actual, name).toEqual(expected);
  });

  it('says what the field was and is', async () => {
    const result = await nodeDiff(
      (side) => `export interface UpdatePetOptions { name?: string; ownerId${inNew(side, '', '?')}: string }
export declare class PetsClient { update(petId: string, options: UpdatePetOptions): Promise<string>; }
`,
    );
    expect(result.diff.changes).toEqual([
      {
        category: 'field_requiredness_increased',
        severity: 'breaking',
        symbol: 'UpdatePetOptions.ownerId',
        conceptualChangeId: 'chg_field_requiredness_increased_updatepetoptions.ownerid',
        provenance: 'unknown',
        old: { field: 'ownerId', required: 'false' },
        new: { field: 'ownerId', required: 'true', takenBy: 'PetsClient.update' },
        message: 'Field "ownerId" became required on "UpdatePetOptions", which callers of "PetsClient.update" pass in',
      },
    ]);
  });

  it('reports a field that is retyped and becomes required as both', async () => {
    const result = await nodeDiff(
      (side) => `export interface UpdatePetOptions { name?: string; ownerId${inNew(side, ': number', '?: string')} }
export declare class PetsClient { update(petId: string, options: UpdatePetOptions): Promise<string>; }
`,
    );
    expect(result.lines).toEqual([
      'breaking field_type_changed UpdatePetOptions.ownerId',
      'breaking field_requiredness_increased UpdatePetOptions.ownerId',
    ]);
  });

  it('leaves a class property to its type text, where the optionality is written', async () => {
    const result = await nodeDiff(
      (side) => `export interface ErrorBody { message: string }
export declare class PetsError extends Error { body${inNew(side, '', '?')}: ErrorBody; }
export declare class PetsClient { report(error: PetsError): Promise<string>; }
`,
    );
    expect(result.lines).toEqual(['breaking field_type_changed PetsError.body']);
  });
});

// ---------------------------------------------------------------------------
// A type alias's members in the diff
// ---------------------------------------------------------------------------

describe("#750 a type alias's members", () => {
  it("are compared as an interface's fields are", async () => {
    const removed = await nodeDiff(
      (side) => `export type CreatePetOptions = { name: string${inNew(side, '', '; tag?: string')} };
export type PetSummary = { id: string${inNew(side, '', '; name: string')} };
export declare class PetsClient { create(options: CreatePetOptions): Promise<PetSummary>; }
`,
    );
    expect(removed.lines).toEqual([
      'breaking symbol_removed CreatePetOptions.tag',
      'breaking symbol_removed PetSummary.name',
    ]);

    const retyped = await nodeDiff(
      (side) => `export type CreatePetOptions = { name: ${inNew(side, 'number', 'string')} };
export declare class PetsClient { create(options: CreatePetOptions): Promise<string>; }
`,
    );
    expect(retyped.lines).toEqual(['breaking field_type_changed CreatePetOptions.name']);

    const added = await nodeDiff(
      (side) => `export interface Pet { id: string }
${inNew(side, 'export type PetSummary = { id: string; name?: string };\n')}export declare class PetsClient { get(petId: string): Promise<Pet>; }
`,
    );
    expect(added.lines).toEqual([
      'additive symbol_added PetSummary',
      'additive symbol_added PetSummary.id',
      'additive symbol_added PetSummary.name',
    ]);

    const dropped = await nodeDiff(
      (side) => `export interface Pet { id: string }
${inNew(side, '', 'export type PetSummary = { id: string; name?: string };\n')}export declare class PetsClient { get(petId: string): Promise<Pet>; }
`,
    );
    expect(dropped.lines).toEqual([
      'breaking symbol_removed PetSummary',
      'breaking symbol_removed PetSummary.id',
      'breaking symbol_removed PetSummary.name',
    ]);
  });

  it('follow an alias of a mapped type or an intersection', async () => {
    const mapped = await nodeDiff(
      (side) => `export type CreatePetOptions = { [K in ${inNew(side, "'name' | 'ownerId'", "'name'")}]: string };
export declare class PetsClient { create(options: CreatePetOptions): Promise<string>; }
`,
    );
    expect(mapped.lines).toEqual(['breaking field_requiredness_increased CreatePetOptions.ownerId']);

    const literalPart = await nodeDiff(
      (side) => `export interface Base { name: string }
export type CreatePetOptions = Base & { tag?: string${inNew(side, '; ownerId: string')} };
export declare class PetsClient { create(options: CreatePetOptions): Promise<string>; }
`,
    );
    expect(literalPart.lines).toEqual(['breaking field_requiredness_increased CreatePetOptions.ownerId']);

    const namedPart = await nodeDiff(
      (side) => `export interface Base { name: string${inNew(side, '; ownerId: string')} }
export type CreatePetOptions = Base & { tag?: string };
export declare class PetsClient { create(options: CreatePetOptions): Promise<string>; }
`,
    );
    expect(namedPart.lines).toEqual([
      'breaking field_requiredness_increased Base.ownerId',
      'breaking field_requiredness_increased CreatePetOptions.ownerId',
    ]);

    const conflict = await nodeDiff(
      (side) => `export type CreatePetOptions = { name?: string } & { name${inNew(side, '', '?')}: string };
export declare class PetsClient { create(options: CreatePetOptions): Promise<string>; }
`,
    );
    expect(conflict.lines).toEqual(['breaking field_requiredness_increased CreatePetOptions.name']);

    const generic = await nodeDiff(
      (side) => `export interface Pet { id: string }
export type Page<T> = { data: T[]; next?: string${inNew(side, '; total: number')} };
export declare class PetsClient { import(page: Page<Pet>): Promise<string>; }
`,
    );
    expect(generic.lines).toEqual(['breaking field_requiredness_increased Page.total']);
  });

  it('survive the type turning from an interface into an alias, and back', async () => {
    const same = await nodeDiff(
      (
        side,
      ) => `${inNew(side, 'export type CreatePetOptions = { name: string; tag?: string };', 'export interface CreatePetOptions { name: string; tag?: string }')}
export declare class PetsClient { create(options: CreatePetOptions): Promise<string>; }
`,
    );
    expect(same.lines).toEqual([]);

    const toAlias = await nodeDiff(
      (
        side,
      ) => `${inNew(side, 'export type CreatePetOptions = { name: string; ownerId: string };', 'export interface CreatePetOptions { name: string }')}
export declare class PetsClient { create(options: CreatePetOptions): Promise<string>; }
`,
    );
    expect(toAlias.lines).toEqual(['breaking field_requiredness_increased CreatePetOptions.ownerId']);

    const toInterface = await nodeDiff(
      (
        side,
      ) => `${inNew(side, 'export interface CreatePetOptions { name: string; ownerId: string }', 'export type CreatePetOptions = { name: string };')}
export declare class PetsClient { create(options: CreatePetOptions): Promise<string>; }
`,
    );
    expect(toInterface.lines).toEqual(['breaking field_requiredness_increased CreatePetOptions.ownerId']);
  });

  it('are compared only when both snapshots record them', async () => {
    // An alias that is recorded by name on one side says nothing about its
    // members there, so the other side's are neither added nor removed.
    const cases: Array<[string, string, string]> = [
      ['object → union', '{ name: string }', '{ name: string } | string'],
      ['union → object', '{ name: string } | string', '{ name: string }'],
      ['primitive → object', 'string', '{ name: string }'],
      ['object → reference', '{ name: string }', 'Pet'],
      ['function → object', '(pet: Pet) => void', '{ name: string }'],
    ];
    for (const [name, before, after] of cases) {
      const result = await nodeDiff(
        (side) => `export interface Pet { id: string }
export type CreatePetOptions = ${inNew(side, after, before)};
export declare class PetsClient { create(options: CreatePetOptions): Promise<Pet>; }
`,
      );
      expect(
        result.lines.filter((line) => line.includes('CreatePetOptions')),
        name,
      ).toEqual([]);
    }
  });

  it("take part in the fork and rename rules, as an interface's fields do", async () => {
    const fork = await nodeDiff(
      (side) => `export interface ErrorBody { message: string }
${inNew(side, 'export type ErrorBodyWithCode = { message: string; code?: string };\n')}
export declare class PetsError extends Error { body: ${inNew(side, 'ErrorBodyWithCode', 'ErrorBody')}; }
`,
    );
    expect(fork.lines).toEqual([
      'soft-risk field_type_changed PetsError.body',
      'additive symbol_added ErrorBodyWithCode',
      'additive symbol_added ErrorBodyWithCode.code',
      'additive symbol_added ErrorBodyWithCode.message',
    ]);
    expect(fork.diff.changes[0].remediation).toContain('Schema "ErrorBodyWithCode" looks like "ErrorBody"');

    const rename = await nodeDiff(
      (
        side,
      ) => `${inNew(side, 'export type PetDetails = { id: string; name: string; tag?: string };', 'export type PetInfo = { id: string; name: string };')}
export declare class PetsClient { get(petId: string): Promise<${inNew(side, 'PetDetails', 'PetInfo')}>; }
`,
    );
    expect(rename.lines).toEqual([
      'soft-risk return_type_changed PetsClient.get',
      'breaking symbol_removed PetInfo',
      'soft-risk symbol_removed PetInfo.id',
      'soft-risk symbol_removed PetInfo.name',
      'additive symbol_added PetDetails',
      'additive symbol_added PetDetails.id',
      'additive symbol_added PetDetails.name',
      'additive symbol_added PetDetails.tag',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A retype to a declared subtype
// ---------------------------------------------------------------------------

/** `Holder%.body` (or what `member` declares) retyped from `ErrorBody%` to
 *  `Detailed%`, which `declarations` relates to it. */
const retype = (
  name: string,
  declarations: string,
  expected: string[],
  holder?: (type: string) => string,
): NodeCase => ({
  name,
  source: (side) => {
    const used = side === 'new' ? 'Detailed%' : 'ErrorBody%';
    return `export interface ErrorBody% { message: string }
${declarations}
${holder ? holder(used) : `export declare class Holder% { body: ${used}; }`}
`;
  },
  expected,
});
const SUBTYPE = 'export interface Detailed% extends ErrorBody% { details?: string }';
const BODY = (severity: string) => [`${severity} field_type_changed Holder%.body`];

describe('#750 a retype to a type that declares it extends the old one', () => {
  it('is soft-risk on a field and on a return, through any spelling the lookup reads', async () => {
    const holder = (member: string) => (type: string) =>
      `export declare class Holder% { ${member.replace('T', type)}; }`;
    const cases = await nodeCases([
      retype('field', SUBTYPE, BODY('soft-risk')),
      retype('optional property', SUBTYPE, BODY('soft-risk'), holder('body?: T')),
      retype('nullable property', SUBTYPE, BODY('soft-risk'), holder('body: T | null')),
      retype('array property', SUBTYPE, BODY('soft-risk'), holder('body: T[]')),
      retype(
        'interface field',
        SUBTYPE,
        ['soft-risk field_type_changed Holder%.body'],
        (type) => `export interface Holder% { body: ${type} }`,
      ),
      retype(
        'alias member',
        SUBTYPE,
        ['soft-risk field_type_changed Holder%.body'],
        (type) => `export type Holder% = { body: ${type} };`,
      ),
      retype('return', SUBTYPE, ['soft-risk return_type_changed Holder%.last'], holder('last(): Promise<T>')),
      retype('plain return', SUBTYPE, ['soft-risk return_type_changed Holder%.last'], holder('last(): T')),
      retype(
        'nullable return',
        SUBTYPE,
        ['soft-risk return_type_changed Holder%.last'],
        holder('last(): Promise<T | null>'),
      ),
      // What the lookup does not read stays as it was: a nested array or generic.
      retype(
        'nested generic return',
        SUBTYPE,
        ['breaking return_type_changed Holder%.last'],
        holder('last(): Promise<T[]>'),
      ),
      // The declaration, directly or through a chain.
      retype(
        'through a chain',
        'export interface Mid% extends ErrorBody% { mid?: string }\nexport interface Detailed% extends Mid% { details?: string }',
        BODY('soft-risk'),
      ),
      retype(
        'with a required member of its own',
        'export interface Detailed% extends ErrorBody% { details: string }',
        BODY('soft-risk'),
      ),
      retype(
        'one of two supertypes',
        'export interface Coded% { code: string }\nexport interface Detailed% extends Coded%, ErrorBody% { details?: string }',
        BODY('soft-risk'),
      ),
      retype('an intersection alias', 'export type Detailed% = ErrorBody% & { details?: string };', BODY('soft-risk')),
      retype(
        'an intersection alias through a chain',
        'export interface Mid% extends ErrorBody% { mid?: string }\nexport type Detailed% = Mid% & { details?: string };',
        BODY('soft-risk'),
      ),
      // Not a declaration that the new type is a kind of the old one.
      retype(
        'the same members, unrelated',
        'export interface Detailed% { message: string; details?: string }',
        BODY('breaking'),
      ),
      retype(
        'extends Partial<…>',
        'export interface Detailed% extends Partial<ErrorBody%> { details?: string }',
        BODY('breaking'),
      ),
      retype(
        'extends Omit<…>',
        "export interface Detailed% extends Omit<ErrorBody%, 'none'> { details?: string }",
        BODY('breaking'),
      ),
      retype(
        'extends an instantiation with it',
        'export interface Box%<T> { value: T }\nexport interface Detailed% extends Box%<ErrorBody%> { details?: string }',
        BODY('breaking'),
      ),
      // The surface reads no supertype off a class.
      retype(
        'a class that implements it',
        'export declare class Detailed% implements ErrorBody% { message: string; details?: string }',
        BODY('breaking'),
      ),
    ]);
    for (const [name, { expected, actual }] of Object.entries(cases)) expect(actual, name).toEqual(expected);
  });

  it('narrows the type and changes nothing around it', async () => {
    const around = (name: string, before: string, after: string, expected: string[]): NodeCase => ({
      name,
      source: (side) => `export interface ErrorBody% { message: string }
${SUBTYPE}
export declare class Holder% { ${inNew(side, after, before)}; }
`,
      expected,
    });
    const cases = await nodeCases([
      around('the same array', 'body: ErrorBody%[] | null', 'body: Detailed%[] | null', BODY('soft-risk')),
      // A retype that also changes what the caller is handed keeps its severity.
      around('into an array', 'body: ErrorBody%', 'body: Detailed%[]', BODY('breaking')),
      around('out of an array', 'body: ErrorBody%[]', 'body: Detailed%', BODY('breaking')),
      around('and optional', 'body: ErrorBody%', 'body?: Detailed%', BODY('breaking')),
      around('and nullable', 'body: ErrorBody%', 'body: Detailed% | null', BODY('breaking')),
      around('and no longer nullable', 'body: ErrorBody% | null', 'body: Detailed%', BODY('breaking')),
      around('null for undefined', 'body: ErrorBody% | null', 'body: Detailed% | undefined', BODY('breaking')),
      around('into a promise', 'last(): ErrorBody%', 'last(): Promise<Detailed%>', [
        'breaking return_type_changed Holder%.last',
      ]),
    ]);
    for (const [name, { expected, actual }] of Object.entries(cases)) expect(actual, name).toEqual(expected);
  });

  it('keeps its severity under a generic the SDK declares', async () => {
    const under = (name: string, declarations: string, member: string, expected: string[]): NodeCase => ({
      name,
      source: (side) => `export interface ErrorBody% { message: string }
export interface Detailed% extends ErrorBody% { details: string }
${declarations}
export declare class Holder% { ${member.replaceAll('T', inNew(side, 'Detailed%', 'ErrorBody%'))}; }
`,
      expected,
    });
    const RETURN = (severity: string) => [`${severity} return_type_changed Holder%.last`];
    const cases = await nodeCases([
      // `Sink<T>.accept` takes a `T`: a caller that passed an `ErrorBody` no longer can.
      under(
        'a generic that takes its argument',
        'export interface Sink%<T> { accept: (value: T) => void }',
        'last(): Sink%<T>',
        RETURN('breaking'),
      ),
      under(
        'on a field',
        'export interface Sink%<T> { accept: (value: T) => void }',
        'body: Sink%<T>',
        BODY('breaking'),
      ),
      // The snapshot does not say how a generic uses its argument, so one that only hands it out is not told apart.
      under(
        'a generic that hands its argument out',
        'export interface Page%<T> { data: T[] }',
        'last(): Page%<T>',
        RETURN('breaking'),
      ),
      under('a generic alias', 'export type Box%<T> = { value: T };', 'last(): Box%<T>', RETURN('breaking')),
      under(
        'a generic class',
        'export declare class Cell%<T> { value: T; set(value: T): void }',
        'last(): Cell%<T>',
        RETURN('breaking'),
      ),
      under(
        'an optional one',
        'export interface Page%<T> { data: T[] }',
        'last(): Page%<T> | undefined',
        RETURN('breaking'),
      ),
      // Nor is a generic the snapshot knows nothing of: this one is not exported.
      under(
        'a generic that is not declared',
        'interface Hidden%<T> { accept(value: T): void }',
        'last(): Hidden%<T>',
        RETURN('breaking'),
      ),
      under('a library generic that takes its argument', '', 'last(): WritableStream<T>', RETURN('breaking')),
      // A promise or a collection hands its argument back, as an array does.
      under('Promise', '', 'last(): Promise<T>', RETURN('soft-risk')),
      under('PromiseLike', '', 'last(): PromiseLike<T>', RETURN('soft-risk')),
      under('Set', '', 'last(): Set<T>', RETURN('soft-risk')),
      under('AsyncIterable', '', 'last(): AsyncIterable<T>', RETURN('soft-risk')),
      // Unless the SDK declares a type of that name itself.
      under(
        'a Sequence the SDK declares',
        'export interface Sequence<T> { push(value: T): void }',
        'last(): Sequence<T>',
        RETURN('breaking'),
      ),
      under('Iterable', '', 'body: Iterable<T>', BODY('soft-risk')),
      under('Array', '', 'body: Array<T>', BODY('soft-risk')),
    ]);
    for (const [name, { expected, actual }] of Object.entries(cases)) expect(actual, name).toEqual(expected);
  });

  it('judges each retype where it stands: the pair is not recorded as a rename', async () => {
    // One pair of types, retyped in four places. Only the one that is read,
    // with nothing else changed around the name, is downgraded; it does not
    // carry the others with it, as a recorded rename of the pair would.
    const result = await nodeDiff((side) => {
      const type = inNew(side, 'DetailedErrorBody', 'ErrorBody');
      return `export interface ErrorBody { message: string }
export interface DetailedErrorBody extends ErrorBody { details: string }
export interface Sink<T> { accept: (value: T) => void }
export declare class Reader { body: ${type}; list: ${inNew(side, 'DetailedErrorBody[]', 'ErrorBody')}; sink(): Sink<${type}>; }
export interface Options { body: ${type} }
export interface Counter { count: ${inNew(side, 'number', 'string')} }
export declare class Client { send(options: Options): Counter; }
`;
    });
    const hint = (remediation: string | undefined) =>
      remediation === undefined
        ? 'no hint'
        : remediation.includes('declared subtype')
          ? 'declared subtype'
          : remediation.includes('recorded rename')
            ? 'recorded rename'
            : remediation;
    expect(
      result.diff.changes.map((change) => [
        `${change.severity} ${change.category} ${change.symbol}`,
        hint(change.remediation),
      ]),
    ).toEqual([
      ['breaking return_type_changed Reader.sink', 'no hint'],
      ['soft-risk field_type_changed Reader.body', 'declared subtype'],
      ['breaking field_type_changed Reader.list', 'no hint'],
      ['breaking field_type_changed Counter.count', 'no hint'],
      ['breaking field_type_changed Options.body', 'no hint'],
    ]);
  });

  it('is not what a retype to the supertype, or to a sibling, is', async () => {
    const toSupertype = await nodeDiff(
      (side) => `export interface ErrorBody { message: string }
export interface DetailedErrorBody extends ErrorBody { details?: string }
export declare class PetsError extends Error { body: ${inNew(side, 'ErrorBody', 'DetailedErrorBody')}; }
`,
    );
    expect(toSupertype.lines).toEqual(['breaking field_type_changed PetsError.body']);

    const toSibling = await nodeDiff(
      (side) => `export interface ErrorBody { message: string }
export interface A extends ErrorBody { a?: string }
export interface B extends ErrorBody { b?: string }
export declare class PetsError extends Error { body: ${inNew(side, 'B', 'A')}; }
`,
    );
    expect(toSibling.lines).toEqual(['breaking field_type_changed PetsError.body']);
  });

  it('holds whether or not the subtype is new, and keeps the fork hint where it applies', async () => {
    const newlyAdded = await nodeDiff(
      (side) => `export interface ErrorBody { message: string }
${inNew(side, 'export interface DetailedErrorBody extends ErrorBody { details?: string }\n')}
export declare class PetsError extends Error { body: ${inNew(side, 'DetailedErrorBody', 'ErrorBody')}; }
`,
    );
    expect(newlyAdded.lines[0]).toBe('soft-risk field_type_changed PetsError.body');
    expect(newlyAdded.diff.changes[0].remediation).toContain('Schema "DetailedErrorBody" looks like "ErrorBody"');
  });

  it('keeps its severity on a field callers write, and on a parameter', async () => {
    const written = await nodeDiff(
      (side) => `export interface OwnerRef { id: string }
export interface DetailedOwnerRef extends OwnerRef { email: string }
export interface CreatePetOptions { name: string; owner: ${inNew(side, 'DetailedOwnerRef', 'OwnerRef')} }
export type UpdatePetOptions = { owner: ${inNew(side, 'DetailedOwnerRef', 'OwnerRef')} };
export interface Pet { id: string; owner: ${inNew(side, 'DetailedOwnerRef', 'OwnerRef')} }
export declare class PetsClient {
  create(options: CreatePetOptions): Promise<Pet>;
  update(options: UpdatePetOptions): Promise<Pet>;
}
`,
    );
    expect(written.lines).toEqual([
      // The subtype asks for an `email` the callers do not pass today.
      'breaking field_type_changed CreatePetOptions.owner',
      // What is only returned is read.
      'soft-risk field_type_changed Pet.owner',
      'breaking field_type_changed UpdatePetOptions.owner',
    ]);

    const parameter = await nodeDiff(
      (side) => `export interface RequestOptions { timeout?: number }
export interface RetryRequestOptions extends RequestOptions { maxRetries?: number }
export declare class PetsClient { get(petId: string, options?: ${inNew(side, 'RetryRequestOptions', 'RequestOptions')}): Promise<string>; }
`,
    );
    expect(parameter.lines).toEqual(['breaking parameter_type_narrowed PetsClient.get']);
  });
});

// ---------------------------------------------------------------------------
// The other extractors
// ---------------------------------------------------------------------------

const pythonSdk = (options: string, pet = ''): Record<string, string> => ({
  'src/petstore/__init__.py': 'from .models import *\nfrom .client import *\n',
  'src/petstore/models.py': `from dataclasses import dataclass
from typing import Optional, TypedDict
from typing_extensions import NotRequired
from pydantic import BaseModel


class Pet(BaseModel):
    id: str
${pet}

${options}`,
  'src/petstore/client.py': `from .models import CreatePetOptions, Pet


class PetsClient:
    def create(self, options: CreatePetOptions) -> Pet:
        raise NotImplementedError
`,
});

const pythonErrors = (body: string): Record<string, string> => ({
  'src/petstore/__init__.py': 'from .models import *\n',
  'src/petstore/models.py': `from pydantic import BaseModel


class ErrorBody(BaseModel):
    message: str


class DetailedErrorBody(ErrorBody):
    details: str | None = None


class Pet(BaseModel):
    id: str
    last_failure: ${body} | None = None
`,
});

const phpClass = (name: string, promoted: string[], body = '', declaration = 'final class') => `<?php

declare(strict_types=1);

namespace Petstore;

${declaration} ${name}
{
${body}    public function __construct(
${promoted.map((line) => `        ${line},\n`).join('')}    ) {}
}
`;

const phpSdk = (promoted: string[], body = '', pet = ['public readonly string $id']): Record<string, string> => ({
  'lib/Pet.php': phpClass('Pet', pet),
  'lib/CreatePetOptions.php': phpClass('CreatePetOptions', promoted, body),
  'lib/PetsClient.php': `<?php

declare(strict_types=1);

namespace Petstore;

final class PetsClient
{
    public function create(CreatePetOptions $options): Pet
    {
        throw new \\RuntimeException('not implemented');
    }
}
`,
});

const phpErrors = (body: string): Record<string, string> => ({
  'lib/ErrorBody.php': phpClass('ErrorBody', ['public readonly string $message'], '', 'class'),
  'lib/DetailedErrorBody.php': phpClass(
    'DetailedErrorBody',
    ['public readonly string $message', 'public readonly ?string $details = null'],
    '',
    'final class',
  ).replace('final class DetailedErrorBody', 'final class DetailedErrorBody extends ErrorBody'),
  'lib/Pet.php': phpClass('Pet', ['public readonly string $id', `public readonly ?${body} $lastFailure = null`]),
});

const goSdk = (optsField: string, petField = ''): Record<string, string> => ({
  'go.mod': 'module github.com/example/petstore\n\ngo 1.21\n',
  'pkg/pets/client.go': `package pets

import "context"

// Client performs Pet requests.
type Client struct {
	APIKey string
}

// Pet is a pet.
type Pet struct {
	ID string \`json:"id"\`
${petField}}

// CreatePetOpts contains the options to create a Pet.
type CreatePetOpts struct {
	Name string \`json:"name"\`
${optsField}}

// CreatePet creates a Pet.
func (c *Client) CreatePet(ctx context.Context, opts CreatePetOpts) (Pet, error) {
	return Pet{}, nil
}
`,
});

const kotlinSdk = (optsField: string): Record<string, string> => ({
  'src/main/kotlin/com/petstore/PetsApi.kt': `package com.petstore

data class Pet(
    val id: String
)

data class CreatePetOptions(
    val name: String${optsField}
)

class PetsApi(private val client: Any) {
    fun createPet(options: CreatePetOptions): Pet {
        throw NotImplementedError()
    }
}
`,
});

const dotnetSdk = (optsProperty: string): Record<string, string> => ({
  'src/Petstore/Pet.cs': `using Newtonsoft.Json;

namespace Petstore
{
    public class Pet
    {
        [JsonProperty("id")]
        public string Id { get; set; }
    }

    public class CreatePetOptions
    {
        [JsonProperty("name")]
        public string Name { get; set; }
${optsProperty}    }
}
`,
  'src/Petstore/PetService.cs': `using System.Threading.Tasks;

namespace Petstore
{
    public class PetService
    {
        public async Task<Pet> CreatePetAsync(CreatePetOptions options)
        {
            throw new NotImplementedException();
        }
    }
}
`,
});

const rustSdk = (optsField: string): Record<string, string> => ({
  'src/lib.rs': 'pub mod client;\npub mod models;\n',
  'src/models.rs': `use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pet {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePetOpts {
    pub name: String,
${optsField}}
`,
  'src/client.rs': `use crate::models::{CreatePetOpts, Pet};

pub struct Petstore {
    pub api_key: String,
}

impl Petstore {
    pub async fn create_pet(&self, opts: CreatePetOpts) -> Result<Pet, PetstoreError> {
        todo!()
    }
}
`,
});

const iosSdk = (optsProperty: string): Record<string, string> => ({
  'Sources/Petstore/Models/Pet.swift': `import Foundation

public struct Pet: Codable, Sendable {
    public let id: String
}

public struct CreatePetOptions: Codable, Sendable {
    public let name: String
${optsProperty}}
`,
  'Sources/Petstore/Resources/Pets.swift': `import Foundation

public struct Pets: Sendable {
    let transport: Transport

    public func createPet(
        options: CreatePetOptions
    ) async throws -> Pet {
        fatalError()
    }
}
`,
});

const elixirSdk = (typeSpec: boolean, ownerType?: string): Record<string, string> => ({
  'lib/petstore/pets/create_pet_options.ex': `defmodule Petstore.Pets.CreatePetOptions do
  @moduledoc false
${
  typeSpec
    ? `
  @type t :: %__MODULE__{
    name: String.t()${ownerType ? `,\n    owner_id: ${ownerType}` : ''}
  }
`
    : ''
}
  defstruct [:name${ownerType ? ', :owner_id' : ''}]
end
`,
  'lib/petstore/pets/pets.ex': `defmodule Petstore.Pets do
  @moduledoc false

  alias Petstore.Pets.CreatePetOptions

  @spec create_pet(options :: CreatePetOptions.t()) :: {:ok, map()} | {:error, any()}
  def create_pet(options) do
    {:ok, options}
  end
end
`,
});

const OWNER_ID_BREAKING = (owner: string, field: string) => [`breaking field_requiredness_increased ${owner}.${field}`];
const OWNER_ID_ADDITIVE = (owner: string, field: string) => [`additive symbol_added ${owner}.${field}`];

describe('#750 the other extractors', () => {
  const pythonModels = createPythonExtractor({ modelBaseClasses: ['BaseModel'] });

  it.each<[string, Extractor, Record<string, string>, Record<string, string>, string[]]>([
    // Python: a field without a default is one the constructor asks for.
    [
      'python: a model field without a default',
      pythonExtractor,
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n'),
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n    owner_id: str\n'),
      OWNER_ID_BREAKING('CreatePetOptions', 'owner_id'),
    ],
    [
      'python: a model field with a default',
      pythonExtractor,
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n'),
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n    owner_id: str | None = None\n'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'owner_id'),
    ],
    [
      'python: a model read through modelBaseClasses',
      pythonModels,
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n'),
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n    owner_id: str\n'),
      OWNER_ID_BREAKING('CreatePetOptions', 'owner_id'),
    ],
    [
      'python: a dataclass field without a default',
      pythonExtractor,
      pythonSdk('@dataclass\nclass CreatePetOptions:\n    name: str\n'),
      pythonSdk('@dataclass\nclass CreatePetOptions:\n    name: str\n    owner_id: str\n'),
      OWNER_ID_BREAKING('CreatePetOptions', 'owner_id'),
    ],
    [
      'python: a dataclass field with a default',
      pythonExtractor,
      pythonSdk('@dataclass\nclass CreatePetOptions:\n    name: str\n'),
      pythonSdk('@dataclass\nclass CreatePetOptions:\n    name: str\n    owner_id: Optional[str] = None\n'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'owner_id'),
    ],
    [
      'python: a default that is dropped',
      pythonExtractor,
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n    owner_id: str | None = None\n'),
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n    owner_id: str | None\n'),
      OWNER_ID_BREAKING('CreatePetOptions', 'owner_id'),
    ],
    [
      'python: a model nested in the options',
      pythonExtractor,
      pythonSdk(
        'class Owner(BaseModel):\n    email: str\n\n\nclass CreatePetOptions(BaseModel):\n    owners: list[Owner] | None = None\n',
      ),
      pythonSdk(
        'class Owner(BaseModel):\n    email: str\n    owner_id: str\n\n\nclass CreatePetOptions(BaseModel):\n    owners: list[Owner] | None = None\n',
      ),
      OWNER_ID_BREAKING('Owner', 'owner_id'),
    ],
    [
      'python: a model that is only returned',
      pythonExtractor,
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n'),
      pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n', '    owner_id: str\n'),
      OWNER_ID_ADDITIVE('Pet', 'owner_id'),
    ],
    // A TypedDict's keys have no default; which may be left out is written
    // elsewhere (NotRequired, total=False), and the surface does not know.
    [
      'python: a TypedDict key',
      pythonExtractor,
      pythonSdk('class CreatePetOptions(TypedDict):\n    name: str\n'),
      pythonSdk('class CreatePetOptions(TypedDict):\n    name: str\n    owner_id: str\n'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'owner_id'),
    ],
    [
      'python: a NotRequired TypedDict key',
      pythonExtractor,
      pythonSdk('class CreatePetOptions(TypedDict):\n    name: str\n'),
      pythonSdk('class CreatePetOptions(TypedDict):\n    name: str\n    owner_id: NotRequired[str]\n'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'owner_id'),
    ],
    [
      'python: a key of a total=False TypedDict',
      pythonExtractor,
      pythonSdk('class CreatePetOptions(TypedDict, total=False):\n    name: str\n'),
      pythonSdk('class CreatePetOptions(TypedDict, total=False):\n    name: str\n    owner_id: str\n'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'owner_id'),
    ],
    [
      'python: a key of a class that extends a TypedDict',
      pythonExtractor,
      pythonSdk(
        'class Base(TypedDict, total=False):\n    tag: str\n\n\nclass CreatePetOptions(Base):\n    name: str\n',
      ),
      pythonSdk(
        'class Base(TypedDict, total=False):\n    tag: str\n\n\nclass CreatePetOptions(Base):\n    name: str\n    owner_id: NotRequired[str]\n',
      ),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'owner_id'),
    ],
    // PHP: a promoted constructor property is a constructor parameter.
    [
      'php: a promoted property without a default',
      phpExtractor,
      phpSdk(['public readonly string $name']),
      phpSdk(['public readonly string $name', 'public readonly string $ownerId']),
      OWNER_ID_BREAKING('CreatePetOptions', 'ownerId'),
    ],
    [
      'php: a promoted property with a default',
      phpExtractor,
      phpSdk(['public readonly string $name']),
      phpSdk(['public readonly string $name', 'public readonly ?string $ownerId = null']),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'ownerId'),
    ],
    [
      'php: a default that is dropped',
      phpExtractor,
      phpSdk(['public readonly string $name', 'public readonly ?string $ownerId = null']),
      phpSdk(['public readonly string $name', 'public readonly ?string $ownerId']),
      OWNER_ID_BREAKING('CreatePetOptions', 'ownerId'),
    ],
    [
      // A property declared in the body says nothing about the constructor.
      'php: a class with a property declared in its body',
      phpExtractor,
      phpSdk(['public readonly string $name'], '    public string $tag = "";\n'),
      phpSdk(['public readonly string $name', 'public readonly string $ownerId'], '    public string $tag = "";\n'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'ownerId'),
    ],
    [
      'php: a class that is only returned',
      phpExtractor,
      phpSdk(['public readonly string $name']),
      phpSdk(['public readonly string $name'], '', ['public readonly string $id', 'public readonly string $ownerId']),
      OWNER_ID_ADDITIVE('Pet', 'ownerId'),
    ],
    // The others: what each surface calls optional.
    [
      'go: a field without omitempty',
      goExtractor,
      goSdk(''),
      goSdk('\tOwnerID string `json:"owner_id"`\n'),
      OWNER_ID_BREAKING('CreatePetOpts', 'owner_id'),
    ],
    [
      'go: an omitempty field',
      goExtractor,
      goSdk(''),
      goSdk('\tOwnerID *string `json:"owner_id,omitempty"`\n'),
      OWNER_ID_ADDITIVE('CreatePetOpts', 'owner_id'),
    ],
    [
      'go: a struct that is only returned',
      goExtractor,
      goSdk(''),
      goSdk('', '\tOwnerID string `json:"owner_id"`\n'),
      OWNER_ID_ADDITIVE('Pet', 'owner_id'),
    ],
    [
      'kotlin: a non-null property without a default',
      kotlinExtractor,
      kotlinSdk(''),
      kotlinSdk(',\n    val ownerId: String'),
      OWNER_ID_BREAKING('CreatePetOptions', 'ownerId'),
    ],
    [
      'kotlin: a nullable property with a default',
      kotlinExtractor,
      kotlinSdk(''),
      kotlinSdk(',\n    val ownerId: String? = null'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'ownerId'),
    ],
    [
      'dotnet: a non-nullable property',
      dotnetExtractor,
      dotnetSdk(''),
      dotnetSdk('        [JsonProperty("owner_id")]\n        public string OwnerId { get; set; }\n'),
      OWNER_ID_BREAKING('CreatePetOptions', 'owner_id'),
    ],
    [
      'dotnet: a nullable property',
      dotnetExtractor,
      dotnetSdk(''),
      dotnetSdk('        [JsonProperty("owner_id")]\n        public string? OwnerId { get; set; }\n'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'owner_id'),
    ],
    [
      'rust: a field that is not an Option',
      rustExtractor,
      rustSdk(''),
      rustSdk('    pub owner_id: String,\n'),
      OWNER_ID_BREAKING('CreatePetOpts', 'owner_id'),
    ],
    [
      'rust: an Option field',
      rustExtractor,
      rustSdk(''),
      rustSdk('    pub owner_id: Option<String>,\n'),
      OWNER_ID_ADDITIVE('CreatePetOpts', 'owner_id'),
    ],
    [
      'ios: a non-optional property',
      iosExtractor,
      iosSdk(''),
      iosSdk('    public let ownerId: String\n'),
      OWNER_ID_BREAKING('CreatePetOptions', 'ownerId'),
    ],
    [
      'ios: an optional property',
      iosExtractor,
      iosSdk(''),
      iosSdk('    public let ownerId: String?\n'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'ownerId'),
    ],
    // Elixir records every parameter as `any`: no type is taken by name.
    [
      'elixir: a struct key that is not nil-able',
      elixirExtractor,
      elixirSdk(true),
      elixirSdk(true, 'String.t()'),
      OWNER_ID_ADDITIVE('CreatePetOptions', 'owner_id'),
    ],
  ])('%s', async (_name, extractor, oldFiles, newFiles, expected) => {
    expect((await compatDiff(extractor, oldFiles, newFiles)).lines).toEqual(expected);
  });

  it('records the optionality each surface knows, and none where it writes a placeholder', async () => {
    const optionality = async (extractor: Extractor, files: Record<string, string>, owner: string) =>
      Object.fromEntries(
        (await snapshotOf(extractor, files)).symbols
          .filter((sym) => sym.kind === 'field' && sym.ownerFqName === owner)
          .map((sym) => [sym.fqName.slice(owner.length + 1), sym.optional]),
      );
    expect(
      await optionality(
        pythonExtractor,
        pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n    owner_id: str | None = None\n'),
        'CreatePetOptions',
      ),
    ).toEqual({ name: false, owner_id: true });
    expect(
      await optionality(
        pythonExtractor,
        pythonSdk('class CreatePetOptions(TypedDict, total=False):\n    name: str\n    owner_id: NotRequired[str]\n'),
        'CreatePetOptions',
      ),
    ).toEqual({ name: undefined, owner_id: undefined });
    expect(
      await optionality(
        phpExtractor,
        phpSdk(['public readonly string $name', 'public readonly ?string $ownerId = null']),
        'CreatePetOptions',
      ),
    ).toEqual({ name: false, ownerId: true });
    expect(
      await optionality(
        phpExtractor,
        phpSdk(
          ['public readonly string $name', 'public readonly ?string $ownerId = null'],
          '    public string $tag = "";\n',
        ),
        'CreatePetOptions',
      ),
    ).toEqual({ tag: undefined, name: undefined, ownerId: undefined });
    expect(
      await optionality(goExtractor, goSdk('\tOwnerID *string `json:"owner_id,omitempty"`\n'), 'CreatePetOpts'),
    ).toEqual({
      name: false,
      owner_id: true,
    });
    expect(await optionality(elixirExtractor, elixirSdk(true, 'String.t() | nil'), 'CreatePetOptions')).toEqual({
      name: false,
      owner_id: true,
    });
    // Without a `@type t` an Elixir struct's fields are `any`, required by default and not by declaration.
    expect(await optionality(elixirExtractor, elixirSdk(false, 'String.t()'), 'CreatePetOptions')).toEqual({
      name: undefined,
      owner_id: undefined,
    });
  });

  it("records a PHP interface's methods and a resource class's attributes without optionality", async () => {
    const snapshot = await snapshotOf(phpExtractor, {
      'lib/Jsonable.php': `<?php

namespace Petstore;

interface Jsonable
{
    public function toArray(): array;
}
`,
    });
    expect(snapshot.symbols.find((sym) => sym.id === 'field:Jsonable.toArray')).not.toHaveProperty('optional');
  });

  it('credits a supertype where the surface reads one', async () => {
    // PHP reads a class's base.
    const php = await compatDiff(phpExtractor, phpErrors('ErrorBody'), phpErrors('DetailedErrorBody'));
    expect(php.lines).toEqual(['soft-risk field_type_changed Pet.lastFailure']);
    expect(php.candidate.symbols.find((sym) => sym.fqName === 'DetailedErrorBody')?.extends).toEqual(['ErrorBody']);

    // Python reads a model's base once the extractor is told what a model is…
    const models = await compatDiff(pythonModels, pythonErrors('ErrorBody'), pythonErrors('DetailedErrorBody'));
    expect(models.lines).toEqual(['soft-risk field_type_changed Pet.last_failure']);
    expect(models.candidate.symbols.find((sym) => sym.fqName === 'DetailedErrorBody')?.extends).toEqual(['ErrorBody']);

    // …and not before: the default extractor's surface has no supertype for it.
    const plain = await compatDiff(pythonExtractor, pythonErrors('ErrorBody'), pythonErrors('DetailedErrorBody'));
    expect(plain.lines).toEqual(['breaking field_type_changed Pet.last_failure']);
    expect(plain.candidate.symbols.find((sym) => sym.fqName === 'DetailedErrorBody')?.extends).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Snapshots written before the keys existed
// ---------------------------------------------------------------------------

describe('#750 a baseline written before the snapshot kept these', () => {
  const required = (side: Side) =>
    issueSdk(
      `{ name: string${inNew(side, '; ownerId: string')} }`,
      `{ name?: string${inNew(side, '; ownerId: string')} }`,
    );

  it('reports nothing against a candidate written since from the same sources', async () => {
    const sdks: Array<[Extractor, Record<string, string>]> = [
      [nodeExtractor, nodeSdk(required('new'))],
      [
        nodeExtractor,
        nodeSdk(
          'export interface A { a: string }\nexport type B = A & { b?: string };\nexport type C = Omit<A, "a">;\nexport declare class K { put(b: B, c: C): A; }\n',
        ),
      ],
      [
        pythonExtractor,
        pythonSdk('class CreatePetOptions(BaseModel):\n    name: str\n    owner_id: str | None = None\n'),
      ],
      [phpExtractor, phpSdk(['public readonly string $name', 'public readonly ?string $ownerId = null'])],
      [phpExtractor, phpErrors('DetailedErrorBody')],
      [goExtractor, goSdk('\tOwnerID string `json:"owner_id"`\n')],
      [kotlinExtractor, kotlinSdk(',\n    val ownerId: String')],
      [dotnetExtractor, dotnetSdk('')],
      [rustExtractor, rustSdk('    pub owner_id: String,\n')],
      [iosExtractor, iosSdk('    public let ownerId: String\n')],
      [elixirExtractor, elixirSdk(true, 'String.t() | nil')],
    ];
    for (const [extractor, files] of sdks) {
      const since = await snapshotOf(extractor, files);
      const before = writtenBefore750(since);
      expect(lines(diffSnapshots(before, since)), `${extractor.language}: before → since`).toEqual([]);
      expect(lines(diffSnapshots(since, before)), `${extractor.language}: since → before`).toEqual([]);
      expect(lines(diffSnapshots(before, before)), `${extractor.language}: before → before`).toEqual([]);
    }
  });

  it('does the same for the sample SDK of every extractor', async () => {
    const fixtures = join(__dirname, '../fixtures');
    const samples: Array<[Extractor, string]> = [
      [nodeExtractor, 'sample-sdk'],
      [dotnetExtractor, 'sample-sdk-dotnet'],
      [elixirExtractor, 'sample-sdk-elixir'],
      [goExtractor, 'sample-sdk-go'],
      [iosExtractor, 'sample-sdk-ios'],
      [kotlinExtractor, 'sample-sdk-kotlin'],
      [phpExtractor, 'sample-sdk-php'],
      [pythonExtractor, 'sample-sdk-python'],
      [rubyExtractor, 'sample-sdk-ruby'],
      [rustExtractor, 'sample-sdk-rust'],
    ];
    for (const [extractor, directory] of samples) {
      const since = apiSurfaceToSnapshot(await extractor.extract(join(fixtures, directory)));
      const before = writtenBefore750(since);
      expect(lines(diffSnapshots(before, since)), directory).toEqual([]);
      expect(lines(diffSnapshots(since, before)), directory).toEqual([]);
    }
  });

  it("supports the lines its own fields support, and no line about an alias's members", async () => {
    const before = writtenBefore750(await snapshotOf(nodeExtractor, nodeSdk(required('old'))));
    const since = await snapshotOf(nodeExtractor, nodeSdk(required('new')));
    // The interface's fields were always listed: its new required field is seen.
    // The alias was a name: its members are not compared, so none floods in.
    expect(lines(diffSnapshots(before, since))).toEqual([
      'breaking field_requiredness_increased UpdatePetOptions.ownerId',
    ]);
  });

  it('does not call a field newly required on a type it recorded by name', async () => {
    // The baseline's alias has no members listed; the candidate's interface
    // of that name has two. Neither is "new": the baseline never said.
    const before = writtenBefore750(
      await snapshotOf(
        nodeExtractor,
        nodeSdk(
          'export type CreatePetOptions = { name: string };\nexport declare class PetsClient { create(options: CreatePetOptions): void; }\n',
        ),
      ),
    );
    const since = await snapshotOf(
      nodeExtractor,
      nodeSdk(
        'export interface CreatePetOptions { name: string; ownerId: string }\nexport declare class PetsClient { create(options: CreatePetOptions): void; }\n',
      ),
    );
    expect(lines(diffSnapshots(before, since))).toEqual([
      'additive symbol_added CreatePetOptions.name',
      'additive symbol_added CreatePetOptions.ownerId',
    ]);
  });

  it('does not see an optionality it never recorded', async () => {
    const flip = (
      side: Side,
    ) => `export interface UpdatePetOptions { name?: string; ownerId${inNew(side, '', '?')}: string }
export declare class PetsClient { update(petId: string, options: UpdatePetOptions): Promise<string>; }
`;
    const before = writtenBefore750(await snapshotOf(nodeExtractor, nodeSdk(flip('old'))));
    const since = await snapshotOf(nodeExtractor, nodeSdk(flip('new')));
    expect(lines(diffSnapshots(before, since))).toEqual([]);
    expect(lines(diffSnapshots(since, before))).toEqual([]);
  });

  it('credits no supertype it never recorded, and one the candidate records', async () => {
    const subtype = (side: Side) => `export interface ErrorBody { message: string }
export interface DetailedErrorBody extends ErrorBody { details?: string }
export declare class PetsError extends Error { body: ${inNew(side, 'DetailedErrorBody', 'ErrorBody')}; }
`;
    const old = await snapshotOf(nodeExtractor, nodeSdk(subtype('old')));
    const since = await snapshotOf(nodeExtractor, nodeSdk(subtype('new')));
    // The declaration is the candidate's to make.
    expect(lines(diffSnapshots(writtenBefore750(old), since))).toEqual(['soft-risk field_type_changed PetsError.body']);
    expect(lines(diffSnapshots(old, writtenBefore750(since)))).toEqual(['breaking field_type_changed PetsError.body']);
  });
});

// ---------------------------------------------------------------------------
// Snapshots that hold something else where the keys go
// ---------------------------------------------------------------------------

describe('#750 a snapshot with something else where the keys go', () => {
  const kinds: unknown[] = [null, 0, 1, '', 'x', 'Pet', [], ['Pet'], [1, null, {}], {}, { a: 1 }, { name: 'Pet' }];

  it('reads it as not recorded', async () => {
    const snapshot = await snapshotOf(
      nodeExtractor,
      nodeSdk(issueSdk('{ name: string; ownerId: string }', '{ name?: string; ownerId: string }')),
    );
    const mutate = (id: string, key: 'optional' | 'extends' | 'aliasOf', value: unknown): CompatSnapshot => ({
      ...snapshot,
      symbols: snapshot.symbols.map((sym) => (sym.id === id ? { ...sym, [key]: value as never } : sym)),
    });
    const positions: Array<[string, 'optional' | 'extends' | 'aliasOf']> = [
      ['field:UpdatePetOptions.name', 'optional'],
      ['field:UpdatePetOptions.ownerId', 'optional'],
      ['field:CreatePetOptions.name', 'optional'],
      ['iface:UpdatePetOptions', 'extends'],
      ['alias:CreatePetOptions', 'extends'],
      ['alias:CreatePetOptions', 'aliasOf'],
      ['iface:UpdatePetOptions', 'aliasOf'],
    ];
    for (const [id, key] of positions) {
      for (const value of kinds) {
        const label = `${id}.${key} = ${JSON.stringify(value)}`;
        const odd = mutate(id, key, value);
        expect(lines(diffSnapshots(snapshot, odd)), `${label}, candidate`).toEqual([]);
        expect(lines(diffSnapshots(odd, snapshot)), `${label}, baseline`).toEqual([]);
        expect(lines(diffSnapshots(odd, odd)), `${label}, both`).toEqual([]);
      }
    }
  });

  it('reads a supertype cycle to its end', async () => {
    const subtype = (side: Side) => `export interface ErrorBody { message: string }
export interface DetailedErrorBody extends ErrorBody { details?: string }
export declare class PetsError extends Error { body: ${inNew(side, 'DetailedErrorBody', 'ErrorBody')}; }
`;
    const baseline = await snapshotOf(nodeExtractor, nodeSdk(subtype('old')));
    const candidate = await snapshotOf(nodeExtractor, nodeSdk(subtype('new')));
    const withSupertypes = (supertypes: Record<string, string[]>): CompatSnapshot => ({
      ...candidate,
      symbols: candidate.symbols.map((sym) =>
        supertypes[sym.fqName] ? { ...sym, extends: supertypes[sym.fqName] } : sym,
      ),
    });
    const severity = (supertypes: Record<string, string[]>) =>
      lines(diffSnapshots(baseline, withSupertypes(supertypes)));
    expect(severity({ ErrorBody: ['DetailedErrorBody'], DetailedErrorBody: ['ErrorBody'] })).toEqual([
      'soft-risk field_type_changed PetsError.body',
    ]);
    expect(severity({ ErrorBody: ['ErrorBody'], DetailedErrorBody: ['DetailedErrorBody'] })).toEqual([
      'breaking field_type_changed PetsError.body',
    ]);
    expect(severity({ DetailedErrorBody: ['Missing', 'Gone'] })).toEqual([
      'breaking field_type_changed PetsError.body',
    ]);
  });
});

// ---------------------------------------------------------------------------
// `oagen verify`: a baseline scoped to the spec
// ---------------------------------------------------------------------------

describe('#750 a baseline scoped to what a spec derives', () => {
  const sdk = (extra: string) => `export interface CreatePetOptions { name: string; ownerId: string${extra} }
export interface Pet { id: string; name: string }
export declare class Pets { createPet(options: CreatePetOptions): Promise<Pet>; }
`;
  // The spec spells the field `owner_id`; the SDK spells it `ownerId`, so the
  // scope (`specDerivedFieldPaths`) leaves `CreatePetOptions.ownerId` out of
  // the baseline that is compared. The spec has no operation either, so the
  // scope leaves the `Pets` class out as well.
  const OUT_OF_SCOPE = ['additive symbol_added Pets', 'additive symbol_added Pets.createPet'];
  const field = (name: string) => ({ name, type: { kind: 'primitive', type: 'string' }, required: true });
  const spec = {
    name: 'Petstore',
    version: '1.0.0',
    baseUrl: 'https://example.com',
    services: [],
    models: [
      { name: 'CreatePetOptions', fields: [field('name'), field('owner_id'), field('tag')] },
      { name: 'Pet', fields: [field('id'), field('name')] },
    ],
    enums: [],
  } as unknown as ApiSpec;

  beforeAll(() => {
    registerExtractor(nodeExtractor);
  });

  it('does not take a field the scope left out for one the candidate added', async () => {
    const baseline = await nodeExtractor.extract(writeSdk(nodeSdk(sdk(''))));
    const unchanged = await runCompatCheck(baseline, writeSdk(nodeSdk(sdk(''))), 'node', spec);
    expect(unchanged.scopedToSpec).toBe(true);
    // As before the snapshot kept optionality: an addition, since the scoped
    // baseline does not list the field. Not a field callers must now supply.
    expect(lines(unchanged.diff)).toEqual([...OUT_OF_SCOPE, 'additive symbol_added CreatePetOptions.ownerId']);
    expect(unchanged.passed).toBe(true);
  });

  it('still sees a required field the candidate did add', async () => {
    const baseline = await nodeExtractor.extract(writeSdk(nodeSdk(sdk(''))));
    const added = await runCompatCheck(baseline, writeSdk(nodeSdk(sdk('; tag: string'))), 'node', spec);
    // `Pets.createPet` is out of the compared baseline, and still what says
    // callers build `CreatePetOptions`: that is read from the whole baseline.
    expect(lines(added.diff)).toEqual([
      ...OUT_OF_SCOPE,
      'additive symbol_added CreatePetOptions.ownerId',
      'breaking field_requiredness_increased CreatePetOptions.tag',
    ]);
    expect(added.passed).toBe(false);

    const unscoped = await runCompatCheck(baseline, writeSdk(nodeSdk(sdk('; tag: string'))), 'node');
    expect(unscoped.scopedToSpec).toBe(false);
    expect(lines(unscoped.diff)).toEqual(['breaking field_requiredness_increased CreatePetOptions.tag']);
  });

  it("scopes a type alias's members as it scopes an interface's fields", async () => {
    // `helper` is a member the spec does not derive, added to the SDK by hand.
    const models = (helper: string) => `export type Pet = { id: string; name: string${helper} };
export interface CreatePetOptions { name: string${helper} }
`;
    const baseline = await nodeExtractor.extract(writeSdk(nodeSdk(models('; helper?: string'))));
    const dropped = await runCompatCheck(baseline, writeSdk(nodeSdk(models(''))), 'node', spec);
    expect(lines(dropped.diff)).toEqual([]);
    expect(dropped.passed).toBe(true);
    // Out of scope, the same change is seen on both.
    const unscoped = await runCompatCheck(baseline, writeSdk(nodeSdk(models(''))), 'node');
    expect(lines(unscoped.diff)).toEqual([
      'breaking symbol_removed CreatePetOptions.helper',
      'breaking symbol_removed Pet.helper',
    ]);
    // A member the spec does derive is compared.
    const derived = await runCompatCheck(
      baseline,
      writeSdk(nodeSdk('export type Pet = { id: string };\nexport interface CreatePetOptions { name: string }\n')),
      'node',
      spec,
    );
    expect(lines(derived.diff)).toEqual(['breaking symbol_removed Pet.name']);
  });

  it('leaves a type the scope leaves out outside the check, whoever takes it', async () => {
    // `ManualOptions` and the method that takes it are written by hand: the
    // spec derives neither, so neither is in the compared baseline.
    const manual = (extra: string) => `${sdk('')}export interface ManualOptions { reason: string${extra} }
export declare class Manual { send(options: ManualOptions): Promise<void>; }
`;
    const baseline = await nodeExtractor.extract(writeSdk(nodeSdk(manual(''))));
    const added = await runCompatCheck(baseline, writeSdk(nodeSdk(manual('; urgent: boolean'))), 'node', spec);
    const about = (name: string) => lines(added.diff).filter((line) => line.split(' ')[2].startsWith(name));
    // As before: everything about an out-of-scope type reads as an addition.
    expect(about('ManualOptions')).toEqual([
      'additive symbol_added ManualOptions',
      'additive symbol_added ManualOptions.reason',
      'additive symbol_added ManualOptions.urgent',
    ]);
    expect(added.passed).toBe(true);
    // Compared whole, the type is one the baseline's callers build.
    const unscoped = await runCompatCheck(baseline, writeSdk(nodeSdk(manual('; urgent: boolean'))), 'node');
    expect(lines(unscoped.diff)).toEqual(['breaking field_requiredness_increased ManualOptions.urgent']);
  });

  it('reads which types are taken from the whole baseline', async () => {
    const baseline = await nodeExtractor.extract(writeSdk(nodeSdk(sdk(''))));
    const scoped = apiSurfaceToSnapshot({ ...baseline, classes: {} });
    const candidate = await snapshotOf(nodeExtractor, nodeSdk(sdk('; tag: string')));
    const tag = (diff: CompatDiffResult) => lines(diff).filter((line) => line.endsWith('.tag'));
    expect(tag(diffSnapshots(scoped, candidate))).toEqual(['additive symbol_added CreatePetOptions.tag']);
    expect(
      tag(diffSnapshots(scoped, candidate, undefined, { unscopedBaseline: apiSurfaceToSnapshot(baseline) })),
    ).toEqual(['breaking field_requiredness_increased CreatePetOptions.tag']);
  });
});
