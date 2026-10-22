import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractSchemas, clearSchemaNameTransform, enumMembersOf } from '../../src/parser/schemas.js';
import {
  enumValueShapeKey,
  enumValuesOf,
  inlineEnumRef,
  inlineEnumExternalDocsOf,
  sameEnumShape,
  toEnumValue,
} from '../../src/parser/enum-members.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { collectModelTypeRefs, collectResponseHeaders, walkTypeRef } from '../../src/ir/types.js';
import type { ApiSpec, Enum, EnumRef, EnumValue, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #265: `EnumValue.description` and `EnumValue.deprecated` are declared
 * in the IR but the parser never set them. Both now come from the document:
 * a `oneOf`/`anyOf` of `const` members (OAS 3.1) gives each value its
 * member's `description` and `deprecated: true`, and a plain `enum:` list
 * takes descriptions from `x-enum-descriptions` / `x-enumDescriptions`. A
 * component written as a `oneOf` of consts is an enum, as the same `oneOf`
 * written inline already was.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function parseDocument(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-enum-members-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

/** A minimal OpenAPI 3.1 document around `schemas` and `paths`. */
const specDoc = (schemas: Record<string, unknown>, paths: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'enum members', version: '1' },
  paths,
  components: { schemas },
});

/** A GET under the `pets` tag whose 200 body is `schema`, with `parameters` and `headers` as given. */
const getOp = (
  operationId: string,
  schema: unknown,
  extra: { parameters?: unknown[]; headers?: Record<string, unknown> } = {},
) => ({
  get: {
    operationId,
    tags: ['pets'],
    ...(extra.parameters ? { parameters: extra.parameters } : {}),
    responses: {
      '200': {
        description: 'OK',
        ...(extra.headers ? { headers: extra.headers } : {}),
        content: { 'application/json': { schema } },
      },
    },
  },
});

const enumByName = (spec: ApiSpec, name: string): Enum => {
  const found = spec.enums.find((e) => e.name === name);
  expect(found, `enum ${name}`).toBeDefined();
  return found!;
};

/** Every enum ref the IR holds, from models, operations and webhooks. */
function everyEnumRef(spec: ApiSpec): EnumRef[] {
  const refs: EnumRef[] = [];
  const visit = (ref: TypeRef | undefined) => {
    if (ref) walkTypeRef(ref, { enum: (r) => void refs.push(r) });
  };
  for (const model of spec.models) for (const ref of collectModelTypeRefs(model)) visit(ref);
  for (const op of spec.services.flatMap((s) => s.operations)) {
    visit(op.response);
    visit(op.requestBody);
    for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])])
      visit(p.type);
    for (const h of collectResponseHeaders(op)) visit(h.type);
    for (const e of op.errors) visit(e.type);
  }
  return refs;
}

/** Every `EnumRef` names an enum of `spec.enums`, and no model shares a name with one. */
function expectEnumsConsistent(spec: ApiSpec): void {
  const enumNames = new Set(spec.enums.map((e) => e.name));
  for (const ref of everyEnumRef(spec)) expect(enumNames, `ref ${ref.name}`).toContain(ref.name);
  for (const model of spec.models) expect(enumNames, `model ${model.name}`).not.toContain(model.name);
}

/** The keys an `EnumValue` carries, so an absent `description` or `deprecated` is pinned as absent, not `undefined`. */
const keysOf = (value: EnumValue) => Object.keys(value).sort();

const petStatus = {
  type: 'string',
  oneOf: [
    { const: 'available', description: 'Can be adopted' },
    { const: 'sold', description: 'Already adopted' },
    { const: 'pending', description: 'Use available', deprecated: true },
  ],
};

describe('enum value description and deprecation (issue #265)', () => {
  it('reads each member of a component `oneOf` of consts, the issue repro', async () => {
    const spec = await parseDocument(
      specDoc(
        {
          PetStatus: petStatus,
          Pet: { type: 'object', properties: { status: { $ref: '#/components/schemas/PetStatus' } } },
        },
        { '/pets': getOp('listPets', { $ref: '#/components/schemas/Pet' }) },
      ),
    );

    expect(spec.enums.map(({ name, values }) => ({ name, values }))).toEqual([
      {
        name: 'PetStatus',
        values: [
          { name: 'AVAILABLE', value: 'available', description: 'Can be adopted' },
          { name: 'SOLD', value: 'sold', description: 'Already adopted' },
          { name: 'PENDING', value: 'pending', description: 'Use available', deprecated: true },
        ],
      },
    ]);
    // `deprecated` is present only on the deprecated member, never `false`.
    expect(spec.enums[0].values.map(keysOf)).toEqual([
      ['description', 'name', 'value'],
      ['description', 'name', 'value'],
      ['deprecated', 'description', 'name', 'value'],
    ]);
    // The component is an enum, not a named union of literals, and the `$ref` follows.
    expect(spec.models.map((m) => m.name)).toEqual(['Pet']);
    expect(spec.models[0].fields[0].type).toEqual({ kind: 'enum', name: 'PetStatus' });
    expectEnumsConsistent(spec);
  });

  it('fills a plain `enum:` list from `x-enum-descriptions` and `x-enumDescriptions` maps keyed by value', () => {
    const { enums } = extractSchemas({
      Kind: { type: 'string', enum: ['dog', 'cat'], 'x-enum-descriptions': { dog: 'A dog', cat: 'A cat' } },
      Size: { type: 'string', enum: ['s', 'l'], 'x-enumDescriptions': { s: 'Small', l: 'Large' } },
      Bare: { type: 'string', enum: ['a', 'b'] },
    });
    clearSchemaNameTransform();

    expect(enums.map((e) => e.values)).toEqual([
      [
        { name: 'DOG', value: 'dog', description: 'A dog' },
        { name: 'CAT', value: 'cat', description: 'A cat' },
      ],
      [
        { name: 'S', value: 's', description: 'Small' },
        { name: 'L', value: 'l', description: 'Large' },
      ],
      [
        { name: 'A', value: 'a' },
        { name: 'B', value: 'b' },
      ],
    ]);
    // No key at all when the document says nothing — never `description: undefined`.
    expect(enums[2].values.map(keysOf)).toEqual([
      ['name', 'value'],
      ['name', 'value'],
    ]);
    // An `enum:` list has no per-value keyword, so no value is deprecated.
    expect(enums.flatMap((e) => e.values).some((v) => 'deprecated' in v)).toBe(false);
  });

  it('reads the list form of the extension at each member position as written, `null` entries counted', () => {
    const { enums } = extractSchemas({
      Mode: {
        type: ['string', 'null'],
        enum: ['fast', null, 'slow'],
        'x-enum-descriptions': ['Quick', 'Nothing', 'Careful'],
      },
    });
    clearSchemaNameTransform();

    expect(enums[0].values).toEqual([
      { name: 'FAST', value: 'fast', description: 'Quick' },
      { name: 'SLOW', value: 'slow', description: 'Careful' },
    ]);
  });

  it('keys a numeric value by its text, keeps the number, and ignores entries that are not text', () => {
    const { enums } = extractSchemas({
      Level: {
        type: 'integer',
        enum: [1, 2, 3, 4],
        'x-enum-descriptions': { '1': 'Low', '2': '   ', '3': 42, constructor: 'not a value' },
      },
    });
    clearSchemaNameTransform();

    expect(enums[0].values).toEqual([
      { name: '1', value: 1, description: 'Low' },
      { name: '2', value: 2 },
      { name: '3', value: 3 },
      { name: '4', value: 4 },
    ]);
  });

  it('reads `x-enum-descriptions` when it holds an object or a list, `x-enumDescriptions` otherwise', () => {
    const { enums } = extractSchemas({
      Both: {
        type: 'string',
        enum: ['a'],
        'x-enum-descriptions': { a: 'From the hyphenated key' },
        'x-enumDescriptions': { a: 'From the camel key' },
      },
      Fallback: {
        type: 'string',
        enum: ['a'],
        'x-enum-descriptions': 'not a map',
        'x-enumDescriptions': { a: 'From the camel key' },
      },
    });
    clearSchemaNameTransform();

    expect(enums[0].values[0].description).toBe('From the hyphenated key');
    expect(enums[1].values[0].description).toBe('From the camel key');
  });

  it('lets the extension describe a const member whose own description has no content', () => {
    const { enums } = extractSchemas({
      Status: {
        type: 'string',
        oneOf: [{ const: 'on', description: 'Own text' }, { const: 'off' }, { const: 'dim', description: '  ' }],
        'x-enum-descriptions': { on: 'Extension text', off: 'Switched off', dim: 'Half on' },
      },
    });
    clearSchemaNameTransform();

    expect(enums[0].values).toEqual([
      { name: 'ON', value: 'on', description: 'Own text' },
      { name: 'OFF', value: 'off', description: 'Switched off' },
      { name: 'DIM', value: 'dim', description: 'Half on' },
    ]);
  });

  it('reads only a literal `true` as deprecated and only non-blank text as a description, on a member', () => {
    const { enums } = extractSchemas({
      Status: {
        type: 'string',
        oneOf: [
          // A document may spell the keyword wrongly; the parser reads only the literal `true`.
          { const: 'a', deprecated: 'yes' as unknown as boolean, description: '   ' },
          { const: 'b', deprecated: false, description: '' },
          { enum: ['c'], deprecated: true, description: 'Single-member enum is a const' },
        ],
      },
    });
    clearSchemaNameTransform();

    expect(enums[0].values).toEqual([
      { name: 'A', value: 'a' },
      { name: 'B', value: 'b' },
      { name: 'C', value: 'c', description: 'Single-member enum is a const', deprecated: true },
    ]);
    expect(enums[0].values.map(keysOf)).toEqual([
      ['name', 'value'],
      ['name', 'value'],
      ['deprecated', 'description', 'name', 'value'],
    ]);
  });
});

describe('a component `oneOf`/`anyOf` of consts is an enum', () => {
  it('keeps the wrapper keywords on the enum, not on its values', () => {
    const { enums, models } = extractSchemas({
      Status: {
        type: 'string',
        description: 'The wrapper, not a value',
        deprecated: true,
        default: 'b',
        externalDocs: { url: 'https://docs.example.com/status' },
        anyOf: [{ const: 'a' }, { const: 'b' }],
      },
    });
    clearSchemaNameTransform();

    expect(models).toEqual([]);
    expect(enums).toEqual([
      {
        name: 'Status',
        values: [
          { name: 'A', value: 'a' },
          { name: 'B', value: 'b' },
        ],
        default: 'b',
        externalDocs: { url: 'https://docs.example.com/status' },
        deprecated: true,
      },
    ]);
  });

  it('carries a `type: null` variant as nullability on the reference, never as a member', async () => {
    const spec = await parseDocument(
      specDoc(
        {
          Status: { oneOf: [{ const: 'a' }, { const: 'b' }, { type: 'null' }] },
          Pet: { type: 'object', properties: { status: { $ref: '#/components/schemas/Status' } } },
        },
        { '/pets': getOp('listPets', { $ref: '#/components/schemas/Pet' }) },
      ),
    );

    expect(enumByName(spec, 'Status').values.map((v) => v.value)).toEqual(['a', 'b']);
    expect(spec.models.map((m) => m.name)).toEqual(['Pet']);
    expect(spec.models[0].fields[0].type).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'Status' } });
    expectEnumsConsistent(spec);
  });

  it('makes a single const member a one-value enum, as a single-member `enum:` list is', () => {
    const { enums, models } = extractSchemas({
      One: { oneOf: [{ const: 'only', description: 'The only value' }] },
      Listed: { type: 'string', enum: ['only'] },
    });
    clearSchemaNameTransform();

    expect(models).toEqual([]);
    expect(enums.map((e) => e.values)).toEqual([
      [{ name: 'ONLY', value: 'only', description: 'The only value' }],
      [{ name: 'ONLY', value: 'only' }],
    ]);
  });

  it('leaves a union with any other variant a named union, as before', () => {
    const { enums, models } = extractSchemas({
      Other: { type: 'object', properties: { id: { type: 'string' } } },
      WithRef: { oneOf: [{ const: 'a' }, { $ref: '#/components/schemas/Other' }] },
      WithNumber: { oneOf: [{ const: 'a' }, { const: 1 }] },
      WithProperties: { properties: { id: { type: 'string' } }, oneOf: [{ const: 'a' }, { const: 'b' }] },
      OnlyNull: { oneOf: [{ type: 'null' }] },
    });
    clearSchemaNameTransform();

    expect(enums).toEqual([]);
    expect(models.map((m) => m.name)).toEqual(['Other', 'WithRef', 'WithNumber', 'WithProperties', 'OnlyNull']);
    expect(models[1].variants).toEqual([
      { kind: 'literal', value: 'a' },
      { kind: 'model', name: 'Other' },
    ]);
    expect(models[2].variants).toEqual([
      { kind: 'literal', value: 'a' },
      { kind: 'literal', value: 1 },
    ]);
  });
});

describe('inline enums carry their members to the lifted enum', () => {
  const doc = specDoc(
    {
      Pet: {
        type: 'object',
        properties: {
          size: {
            type: 'string',
            oneOf: [
              { const: 's', description: 'Small' },
              { const: 'l', description: 'Large', deprecated: true },
            ],
          },
          color: { type: 'string', enum: ['red', 'blue'], 'x-enum-descriptions': { red: 'Red', blue: 'Blue' } },
        },
      },
    },
    {
      '/pets': getOp(
        'listPets',
        { $ref: '#/components/schemas/Pet' },
        {
          parameters: [
            {
              name: 'mood',
              in: 'query',
              schema: { type: 'string', enum: ['happy', 'sad'], 'x-enumDescriptions': { happy: 'Smiling' } },
            },
          ],
          headers: {
            'X-Policy': {
              schema: {
                type: 'string',
                oneOf: [
                  { const: 'fast', description: 'No delay' },
                  { const: 'slow', deprecated: true },
                ],
              },
            },
          },
        },
      ),
    },
  );

  it('from a field, a query parameter and a response header', async () => {
    const spec = await parseDocument(doc);

    expect(enumByName(spec, 'PetSize').values).toEqual([
      { name: 'S', value: 's', description: 'Small' },
      { name: 'L', value: 'l', description: 'Large', deprecated: true },
    ]);
    expect(enumByName(spec, 'PetColor').values).toEqual([
      { name: 'RED', value: 'red', description: 'Red' },
      { name: 'BLUE', value: 'blue', description: 'Blue' },
    ]);
    expect(enumByName(spec, 'PetsMood').values).toEqual([
      { name: 'HAPPY', value: 'happy', description: 'Smiling' },
      { name: 'SAD', value: 'sad' },
    ]);
    expect(enumByName(spec, 'PetsXPolicy').values).toEqual([
      { name: 'FAST', value: 'fast', description: 'No delay' },
      { name: 'SLOW', value: 'slow', deprecated: true },
    ]);
    expectEnumsConsistent(spec);
  });

  it('the differ reports a value becoming deprecated between two parses', async () => {
    const before = await parseDocument(doc);
    const after = await parseDocument(
      specDoc(
        {
          Pet: {
            type: 'object',
            properties: {
              size: {
                type: 'string',
                oneOf: [
                  { const: 's', description: 'Small', deprecated: true },
                  { const: 'l', description: 'Large' },
                ],
              },
              color: { type: 'string', enum: ['red', 'blue'] },
            },
          },
        },
        { '/pets': getOp('listPets', { $ref: '#/components/schemas/Pet' }) },
      ),
    );

    const report = diffSpecs(before, after);
    const size = report.changes.find((c) => c.kind === 'enum-modified' && c.name === 'PetSize');
    expect(size?.kind === 'enum-modified' && size.valueChanges).toEqual([
      {
        kind: 'value-deprecated-changed',
        valueName: 'S',
        classification: 'additive',
        oldDeprecated: false,
        newDeprecated: true,
        details: 'live → deprecated',
      },
      {
        kind: 'value-deprecated-changed',
        valueName: 'L',
        classification: 'additive',
        oldDeprecated: true,
        newDeprecated: false,
        details: 'deprecated → live',
      },
    ]);
    // A description change alone is not a change to the enum.
    expect(report.changes.find((c) => c.kind === 'enum-modified' && c.name === 'PetColor')).toBeUndefined();
  });
});

describe('sharing an inline enum name', () => {
  const modeParam = (variants: unknown[]) => ({
    name: 'mode',
    in: 'query',
    schema: { type: 'string', oneOf: variants },
  });

  it('shares the name when two copies have the same members, the first copy describing them', async () => {
    const spec = await parseDocument(
      specDoc(
        {},
        {
          '/a': getOp(
            'getA',
            { type: 'string' },
            { parameters: [modeParam([{ const: 'x', description: 'First' }, { const: 'y' }])] },
          ),
          '/b': getOp(
            'getB',
            { type: 'string' },
            { parameters: [modeParam([{ const: 'y' }, { const: 'x', description: 'Second' }])] },
          ),
        },
      ),
    );

    expect(spec.enums.map((e) => e.name)).toEqual(['PetsMode']);
    expect(enumByName(spec, 'PetsMode').values).toEqual([
      { name: 'X', value: 'x', description: 'First' },
      { name: 'Y', value: 'y' },
    ]);
    // Untagged-by-root services: `/a` and `/b` each get a service, the enums are named from the tag.
    const ops = spec.services.flatMap((s) => s.operations);
    expect(ops.map((op) => op.queryParams[0].type)).toEqual([
      { kind: 'enum', name: 'PetsMode', values: ['x', 'y'] },
      { kind: 'enum', name: 'PetsMode', values: ['y', 'x'] },
    ]);
  });

  it('renames a copy that deprecates a value the first does not, so no reference points at the wrong flag', async () => {
    const spec = await parseDocument(
      specDoc(
        {},
        {
          '/a': getOp('getA', { type: 'string' }, { parameters: [modeParam([{ const: 'x' }, { const: 'y' }])] }),
          '/b': getOp(
            'getB',
            { type: 'string' },
            { parameters: [modeParam([{ const: 'x' }, { const: 'y', deprecated: true }])] },
          ),
        },
      ),
    );

    expect(spec.enums.map((e) => [e.name, e.values.map((v) => `${v.value}${v.deprecated ? '!' : ''}`)])).toEqual([
      ['PetsMode', ['x', 'y']],
      ['PetsMode2', ['x', 'y!']],
    ]);
    const ops = spec.services.flatMap((s) => s.operations);
    expect(ops.map((op) => op.queryParams[0].type.kind === 'enum' && op.queryParams[0].type.name)).toEqual([
      'PetsMode',
      'PetsMode2',
    ]);
    expectEnumsConsistent(spec);
  });
});

describe('enum-members helpers', () => {
  it('toEnumValue carries only what the member has', () => {
    expect(toEnumValue({ value: 'x' })).toEqual({ name: 'X', value: 'x' });
    expect(keysOf(toEnumValue({ value: 'x' }))).toEqual(['name', 'value']);
    expect(toEnumValue({ value: 5, description: 'Five', deprecated: true })).toEqual({
      name: '5',
      value: 5,
      description: 'Five',
      deprecated: true,
    });
  });

  it('enumValuesOf reads the members recorded by inlineEnumRef, in the order of the ref values', () => {
    const ref = inlineEnumRef(
      'Mode',
      [
        { value: 'a', description: 'A' },
        { value: 'b', deprecated: true },
      ],
      {
        url: 'https://docs.example.com/mode',
      },
    );
    expect(ref).toEqual({ kind: 'enum', name: 'Mode', values: ['a', 'b'] });
    expect(enumValuesOf(ref)).toEqual([
      { name: 'A', value: 'a', description: 'A' },
      { name: 'B', value: 'b', deprecated: true },
    ]);
    expect(inlineEnumExternalDocsOf(ref)).toEqual({ url: 'https://docs.example.com/mode' });
    // A rename in place keeps the identity, so the members survive it.
    ref.name = 'Mode2';
    expect(enumValuesOf(ref).map((v) => v.name)).toEqual(['A', 'B']);
  });

  it('enumValuesOf lifts a ref built without inlineEnumRef to bare values', () => {
    const ref: EnumRef = { kind: 'enum', name: 'Bare', values: ['a', 1] };
    expect(enumValuesOf(ref)).toEqual([
      { name: 'A', value: 'a' },
      { name: '1', value: 1 },
    ]);
    expect(inlineEnumExternalDocsOf(ref)).toBeUndefined();
    expect(enumValuesOf({ kind: 'enum', name: 'Component' })).toEqual([]);
  });

  it('sameEnumShape ignores order and descriptions, and reads per-value deprecation', () => {
    const a = [toEnumValue({ value: 'x', description: 'one' }), toEnumValue({ value: 'y' })];
    expect(sameEnumShape(a, [toEnumValue({ value: 'y' }), toEnumValue({ value: 'x', description: 'two' })])).toBe(true);
    expect(sameEnumShape(a, [toEnumValue({ value: 'x' }), toEnumValue({ value: 'y', deprecated: true })])).toBe(false);
    expect(sameEnumShape(a, [toEnumValue({ value: 'x' })])).toBe(false);
    expect(sameEnumShape([toEnumValue({ value: 5 })], [toEnumValue({ value: '5' })])).toBe(false);
  });

  it('enumValueShapeKey tells apart type, text and deprecation', () => {
    expect(enumValueShapeKey({ value: 5 })).toBe('number:5');
    expect(enumValueShapeKey({ value: '5' })).toBe('string:5');
    expect(enumValueShapeKey({ value: '5', deprecated: true })).toBe('string:5!deprecated');
  });

  it('enumMembersOf reads either spelling and nothing else', () => {
    expect(enumMembersOf({ enum: ['a', null, 2] })).toEqual([{ value: 'a' }, { value: 2 }]);
    expect(enumMembersOf({ oneOf: [{ const: 'a', deprecated: true }, { type: 'null' }] })).toEqual([
      { value: 'a', deprecated: true },
    ]);
    expect(enumMembersOf({ oneOf: [{ const: 'a' }, { $ref: '#/components/schemas/B' }] })).toBeNull();
    expect(enumMembersOf({ type: 'string' })).toBeNull();
  });
});
