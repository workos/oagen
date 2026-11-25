import { describe, it, expect, afterAll, beforeAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { componentPropertyLedger, isDeclaredProperty, type SchemaObject } from '../../src/parser/schemas.js';
import { buildInlineModel, collectProperties, mergeAllOfMembers } from '../../src/parser/inline-models.js';
import { collectObjectProperties } from '../../src/parser/pagination.js';
import { pointerSteps } from '../../src/parser/schema-pointers.js';
import { schemaAtPointer, schemaRefTarget, schemaRefValue } from '../../src/parser/schema-refs.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #746: a property written `false` is no field, and every reader of a
 * `properties` map asked whether the entry itself was falsy. A `$ref` is an
 * object, so a property written as a `$ref` to a component that is `false`
 * was declared, and typed as #728 types a `$ref` to `false`: `unknown`. The
 * inline and the `$ref` spelling of one schema gave two IRs, and `oagen
 * diff` between them reported a field added. Every reader now asks one
 * question of the entry (`isDeclaredProperty`), which follows a `$ref`,
 * through any chain, to what the document wrote: a property that leads to
 * `false` is the `false` it names. A `$ref` to `false` read for a type — a
 * variant, an `allOf` member, `items`, a body — stays the `unknown` it was.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

type Doc = Record<string, unknown>;

async function writeDoc(doc: unknown, name = 'spec.json'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-746-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** What a document parses to, with the warnings the parse printed. */
interface Reading {
  spec: ApiSpec;
  warnings: string[];
}
async function read(doc: unknown): Promise<Reading> {
  const before = warn.mock.calls.length;
  const spec = await parseSpec(await writeDoc(doc));
  return { spec, warnings: warn.mock.calls.slice(before).map(([message]) => String(message)) };
}
const parse = async (doc: unknown): Promise<ApiSpec> => (await read(doc)).spec;

/** `oagen diff --old <old> --new <new>`: the exit code it ends with. */
async function diffExit(oldDoc: unknown, newDoc: unknown): Promise<number> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const files = { old: await writeDoc(oldDoc, 'old.json'), new: await writeDoc(newDoc, 'new.json') };
    const error = (await diffCommand(files).catch((e: unknown) => e)) as { exitCode: number };
    return error.exitCode;
  } finally {
    log.mockRestore();
  }
}

/** The two documents parse to one IR and `oagen diff` between them exits 0, in either direction. */
async function expectNoDiff(first: unknown, second: unknown, label = ''): Promise<void> {
  const [firstSpec, secondSpec] = [await parse(first), await parse(second)];
  expect(firstSpec, label).toEqual(secondSpec);
  expect(diffSpecs(firstSpec, secondSpec).changes, label).toEqual([]);
  expect(diffSpecs(secondSpec, firstSpec).changes, label).toEqual([]);
  expect(await diffExit(first, second), label).toBe(0);
  expect(await diffExit(second, first), label).toBe(0);
}

/** `value` where a schema goes, as a document may write it. */
const written = (value: unknown): SchemaObject => value as SchemaObject;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const string = { type: 'string' };

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

// ---------------------------------------------------------------------------
// Rendering

const show = (type: TypeRef | undefined): string => {
  if (type === undefined) return 'none';
  switch (type.kind) {
    case 'primitive':
      return type.type;
    case 'array':
      return `${show(type.items)}[]`;
    case 'model':
      return type.name;
    case 'enum':
      return `enum ${type.name}`;
    case 'literal':
      return JSON.stringify(type.value);
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'map':
      return `map<${show(type.valueType)}>`;
  }
};

/** The `getPet` operation as every document here writes it, left out of a rendering it says nothing in. */
const PLAIN_OPERATION = 'getPet(path petId: string) -> Pet';

/** One line for a parsed document: its models with their fields, then its operations and webhooks. */
function render(spec: ApiSpec): string {
  const models = spec.models.map((model) => {
    const fields = model.fields.map((field) => `${field.name}${field.required ? '' : '?'}: ${show(field.type)}`);
    const union = model.variants ? ` = ${model.compositionKind}(${model.variants.map(show).join(' | ')})` : '';
    return `${model.name} { ${fields.join(', ')} }${union}`;
  });
  const operations = spec.services
    .flatMap((service) => service.operations)
    .map((op) => {
      const params = [
        ...op.pathParams.map((p) => `path ${p.name}: ${show(p.type)}`),
        ...op.queryParams.map((p) => `query ${p.name}: ${show(p.type)}`),
        ...op.headerParams.map((p) => `header ${p.name}: ${show(p.type)}`),
        ...(op.cookieParams ?? []).map((p) => `cookie ${p.name}: ${show(p.type)}`),
      ];
      const body = op.requestBody ? ` body ${show(op.requestBody)}` : '';
      const headers = op.responseHeaders?.length
        ? ` headers[${op.responseHeaders.map((h) => `${h.name}: ${show(h.type)}`).join(', ')}]`
        : '';
      const errors = op.errors.length ? ` errors[${op.errors.map((e) => `${e.statusCode}: ${show(e.type)}`)}]` : '';
      const fallback = op.defaultResponse ? ` default ${show(op.defaultResponse.type)}` : '';
      const ranges = (op.rangeResponses ?? []).map((r) => ` ${r.range} ${show(r.type)}`).join('');
      const page = op.pagination ? ` paged ${op.pagination.strategy} of ${show(op.pagination.itemType)}` : '';
      const callbacks = (op.callbacks ?? []).map((c) => ` callback ${c.name} body ${show(c.requestBody)}`).join('');
      return `${op.name}(${params.join(', ')})${body} -> ${show(op.response)}${headers}${errors}${fallback}${ranges}${page}${callbacks}`;
    })
    .filter((line) => line !== PLAIN_OPERATION);
  const webhooks = (spec.webhooks ?? []).map((hook) => `webhook ${hook.name} body ${show(hook.requestBody)}`);
  return [...models, ...operations, ...webhooks].join('; ');
}

/** The model and enum references of the IR that name no model or enum the IR holds. */
function danglingReferences(spec: ApiSpec): string[] {
  const models = new Set(spec.models.map((model) => model.name));
  const enums = new Set(spec.enums.map((entry) => entry.name));
  const dangling = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value !== 'object' || value === null) return;
    const node = value as { kind?: unknown; name?: unknown };
    if (node.kind === 'model' && typeof node.name === 'string' && !models.has(node.name)) dangling.add(node.name);
    if (node.kind === 'enum' && typeof node.name === 'string' && !enums.has(node.name)) dangling.add(node.name);
    Object.values(value).forEach(walk);
  };
  const { sdk: _sdk, ...rest } = spec;
  walk(rest);
  return [...dangling];
}

// ---------------------------------------------------------------------------
// The positions a property is written at

type Build = (value: unknown) => Doc;

/** `doc` with `schemas` among its `components/schemas`: after its own, or before them (`first`). */
function withSchemas(doc: Doc, schemas: Doc, first = false): Doc {
  const components = doc['components'] as { schemas: Doc };
  const merged = first ? { ...schemas, ...components.schemas } : { ...components.schemas, ...schemas };
  return { ...doc, components: { ...components, schemas: merged } };
}

/**
 * Every position a property is written at (`property`: each builder writes
 * `value` as the property's schema), the positions that read a JSON
 * Pointer to such a property (`pointer`), and the positions a schema is
 * read for a type at (`typed`): `Pet { name }` and `GET /pets/{petId}`
 * (`getPet`) returning `$ref: Pet`, as the issue's documents are, with what
 * the position needs beside them.
 */
function positions(openapi: Version): Record<'property' | 'pointer' | 'typed', Array<[string, Build]>> {
  const document = (
    schemas: Record<string, unknown>,
    response: unknown = json(ref('Pet')),
    operation: Record<string, unknown> = {},
    more: Record<string, unknown> = {},
    components: Record<string, unknown> = {},
  ) => ({
    openapi,
    info: { title: 'Repro', version: '1.0.0' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: string }],
          responses: { '200': { description: 'OK', ...(response as object) } },
          ...operation,
        },
      },
    },
    ...more,
    components: { schemas, ...components },
  });
  const pet = (extra: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({
    type: 'object',
    properties: { name: string, ...extra },
    ...more,
  });
  const object = (properties: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
    type: 'object',
    properties,
    ...more,
  });
  const owner = object({ ownerName: string });
  const nullVariant = openapi === '3.0.3' ? { enum: [null] } : { type: 'null' };
  const cat = (extra: Record<string, unknown> = {}) => ({
    ...object({ kind: { type: 'string', enum: ['cat'] }, meow: string, ...extra }),
    required: ['kind'],
  });
  const dog = { ...object({ kind: { type: 'string', enum: ['dog'] }, bark: string }), required: ['kind'] };
  const post = (requestBody: unknown, path = '/pets') => ({
    paths: {
      [path]: {
        post: {
          operationId: 'createPet',
          requestBody,
          responses: { '200': { description: 'OK', ...json(ref('Pet')) } },
        },
      },
    },
  });
  const parameter = (where: string, schema: unknown, more: object = {}) => ({
    parameters: [
      { name: 'petId', in: 'path', required: true, schema: string },
      { name: 'filter', in: where, schema, ...more },
    ],
  });
  const webhook = (schema: unknown) => ({
    webhooks: {
      'pet.created': {
        post: { operationId: 'petCreated', requestBody: json(schema), responses: { '200': { description: 'OK' } } },
      },
    },
  });
  const callback = (schema: unknown) => ({
    callbacks: {
      onEvent: {
        '{$request.body#/url}': {
          post: { requestBody: json(schema), responses: { '200': { description: 'OK' } } },
        },
      },
    },
  });
  const list = {
    operationId: 'listPets',
    parameters: [{ name: 'after', in: 'query', schema: string }],
  };
  const envelope = (data: unknown, more: Record<string, unknown> = {}) =>
    object({ data, list_metadata: object({ after: string }), ...more });
  const pets = { type: 'array', items: ref('Pet') };
  const meta = (schema: unknown) => object({ meta: schema });
  const withStatus = (status: string, schema: unknown) => ({
    responses: {
      '200': { description: 'OK', ...json(ref('Pet')) },
      [status]: { description: 'Other', ...json(schema) },
    },
  });

  const nested = (x: unknown, other: string) => object({ addr: object({ x, [other]: string }) });

  const property: Array<[string, Build]> = [
    ['a property of a component', (v) => document({ Pet: pet({ legacyId: v }) })],
    ['a required property of a component', (v) => document({ Pet: pet({ legacyId: v }, { required: ['legacyId'] }) })],
    ['the only property of a component', (v) => document({ Pet: object({ legacyId: v }) })],
    ['the first property of a component', (v) => document({ Pet: object({ legacyId: v, name: string }) })],
    [
      'a property of a component with no `type`',
      (v) => document({ Pet: { properties: { name: string, legacyId: v } } }),
    ],
    [
      'a property of a nullable component',
      (v) =>
        document({
          Pet:
            openapi === '3.0.3'
              ? { type: 'object', nullable: true, properties: { name: string, legacyId: v } }
              : { type: ['object', 'null'], properties: { name: string, legacyId: v } },
        }),
    ],
    [
      'a property beside an `allOf` (component)',
      (v) => document({ Owner: owner, Pet: { allOf: [ref('Owner')], properties: { legacyId: v } } }),
    ],
    [
      'a required property beside an `allOf` (component)',
      (v) =>
        document({ Owner: owner, Pet: { allOf: [ref('Owner')], properties: { legacyId: v }, required: ['legacyId'] } }),
    ],
    [
      'a property of an `allOf` member (component)',
      (v) => document({ Owner: owner, Pet: { allOf: [ref('Owner'), object({ legacyId: v })] } }),
    ],
    [
      'a required property of an `allOf` member (component)',
      (v) =>
        document({ Owner: owner, Pet: { allOf: [ref('Owner'), object({ legacyId: v }, { required: ['legacyId'] })] } }),
    ],
    [
      "a property of a `$ref` member's component (inherited)",
      (v) =>
        document({
          Base: object({ legacyId: v, id: string }),
          Pet: { allOf: [ref('Base'), object({ name: string })] },
        }),
    ],
    [
      "a required property of a `$ref` member's component (inherited)",
      (v) =>
        document({
          Base: object({ legacyId: v, id: string }, { required: ['legacyId'] }),
          Pet: { allOf: [ref('Base'), object({ name: string })] },
        }),
    ],
    [
      'a property of the only `allOf` member (component)',
      (v) => document({ Pet: { allOf: [object({ name: string, legacyId: v })] } }),
    ],
    [
      'a property of a nested `allOf` member (component)',
      (v) => document({ Owner: owner, Pet: { allOf: [ref('Owner'), { allOf: [object({ legacyId: v })] }] } }),
    ],
    [
      'a property two `allOf` members declare, the first (component)',
      (v) => document({ Pet: { allOf: [meta(v), meta(string)] } }),
    ],
    [
      'a property two `allOf` members declare, the second (component)',
      (v) => document({ Pet: { allOf: [meta(string), meta(v)] } }),
    ],
    [
      'a property two `allOf` members declare, both (component)',
      (v) => document({ Pet: { allOf: [meta(v), meta(v)] } }),
    ],
    [
      "a property a `$ref` member's component declares typed, the inline member as `false`",
      (v) => document({ Base: meta(string), Pet: { allOf: [ref('Base'), meta(v)] } }),
    ],
    [
      "a property a `$ref` member's component declares as `false`, the inline member typed",
      (v) => document({ Base: meta(v), Pet: { allOf: [ref('Base'), meta(string)] } }),
    ],
    [
      "a property a `$ref` member's component declares as `false`, the inline member first and typed",
      (v) => document({ Base: meta(v), Pet: { allOf: [meta(string), ref('Base')] } }),
    ],
    [
      "a property two `$ref` members' components declare, the first as `false`",
      (v) => document({ A: meta(v), B: meta(string), Pet: { allOf: [ref('A'), ref('B')] } }),
    ],
    [
      "a property two `$ref` members' components declare, the second as `false`",
      (v) => document({ A: meta(string), B: meta(v), Pet: { allOf: [ref('A'), ref('B')] } }),
    ],
    [
      'a property beside an `allOf` whose member declares it typed (component)',
      (v) => document({ Base: meta(string), Pet: { allOf: [ref('Base')], properties: { meta: v } } }),
    ],
    [
      'a property of a variant of a pure `oneOf` component',
      (v) => document({ Pet: { oneOf: [object({ name: string, legacyId: v }), object({ other: string })] } }),
    ],
    [
      'a property of a variant of a pure `anyOf` component',
      (v) => document({ Pet: { anyOf: [object({ name: string, legacyId: v }), object({ other: string })] } }),
    ],
    [
      'a property of a variant beside properties (component)',
      (v) =>
        document({
          Pet: {
            type: 'object',
            properties: { name: string },
            oneOf: [object({ legacyId: v }), object({ other: string })],
          },
        }),
    ],
    [
      'a property beside a `oneOf` (component)',
      (v) =>
        document({
          Pet: {
            type: 'object',
            properties: { name: string, legacyId: v },
            oneOf: [object({ a: string }), object({ b: string })],
          },
        }),
    ],
    [
      'a property of a discriminated variant component',
      (v) =>
        document({
          Cat: cat({ legacyId: v }),
          Dog: dog,
          Pet: pet({ animal: { oneOf: [ref('Cat'), ref('Dog')], discriminator: { propertyName: 'kind' } } }),
        }),
    ],
    [
      'the discriminator property of a variant component',
      (v) =>
        document({
          Cat: object({ kind: v, meow: string }),
          Dog: dog,
          Pet: pet({ animal: { oneOf: [ref('Cat'), ref('Dog')], discriminator: { propertyName: 'kind' } } }),
        }),
    ],
    [
      'a property of a variant of an allOf+oneOf dispatcher',
      (v) =>
        document({
          Base: object({ id: string }),
          Pet: {
            allOf: [ref('Base')],
            oneOf: [
              object({ kind: { type: 'string', enum: ['cat'] }, legacyId: v }, { required: ['kind'] }),
              object({ kind: { type: 'string', enum: ['dog'] }, bark: string }, { required: ['kind'] }),
            ],
            discriminator: { propertyName: 'kind' },
          },
        }),
    ],
    ['a property of an inline object (field)', (v) => document({ Pet: pet({ owner: object({ legacyId: v }) }) })],
    [
      'a required property of an inline object (field)',
      (v) => document({ Pet: pet({ owner: object({ legacyId: v, id: string }, { required: ['legacyId'] }) }) }),
    ],
    [
      'a property of an inline object two levels down',
      (v) => document({ Pet: pet({ owner: object({ address: object({ legacyId: v, city: string }) }) }) }),
    ],
    [
      'a property of the inline items of an array (field)',
      (v) => document({ Pet: pet({ tags: { type: 'array', items: object({ label: string, legacyId: v }) } }) }),
    ],
    [
      'a property of the inline items of an array component',
      (v) =>
        document({
          Pet: pet({ tags: ref('Tags') }),
          Tags: { type: 'array', items: object({ label: string, legacyId: v }) },
        }),
    ],
    [
      'a property of inline map values (field)',
      (v) =>
        document({
          Pet: pet({ extra: { type: 'object', additionalProperties: object({ label: string, legacyId: v }) } }),
        }),
    ],
    [
      'a property of a nullable inline object (field)',
      (v) => document({ Pet: pet({ owner: { oneOf: [object({ id: string, legacyId: v }), nullVariant] } }) }),
    ],
    [
      'a property of an inline union variant (field)',
      (v) => document({ Pet: pet({ value: { oneOf: [object({ id: string, legacyId: v }), string] } }) }),
    ],
    [
      'a property of an inline `anyOf` variant (field)',
      (v) => document({ Pet: pet({ value: { anyOf: [object({ id: string, legacyId: v }), string] } }) }),
    ],
    [
      'a property of an inline variant of a named union component',
      (v) =>
        document({
          Owner: owner,
          Pet: pet({ value: ref('Value') }),
          Value: { oneOf: [ref('Owner'), object({ id: string, legacyId: v })] },
        }),
    ],
    [
      'a property beside a `oneOf` (field)',
      (v) =>
        document({
          Pet: pet({
            value: { properties: { legacyId: v, id: string }, oneOf: [object({ a: string }), object({ b: string })] },
          }),
        }),
    ],
    [
      'a property beside an `allOf` (field)',
      (v) => document({ Owner: owner, Pet: pet({ owner: { allOf: [ref('Owner')], properties: { legacyId: v } } }) }),
    ],
    [
      'a property of an `allOf` member (field)',
      (v) => document({ Owner: owner, Pet: pet({ owner: { allOf: [ref('Owner'), object({ legacyId: v })] } }) }),
    ],
    [
      'a required property of an `allOf` member (field)',
      (v) =>
        document({
          Owner: owner,
          Pet: pet({ owner: { allOf: [ref('Owner'), object({ legacyId: v }, { required: ['legacyId'] })] } }),
        }),
    ],
    [
      'a property two `allOf` members declare, the first (field)',
      (v) => document({ Pet: pet({ owner: { allOf: [meta(v), meta(string)] } }) }),
    ],
    [
      'a property two `allOf` members declare, the second (field)',
      (v) => document({ Pet: pet({ owner: { allOf: [meta(string), meta(v)] } }) }),
    ],
    [
      'a property two `allOf` members declare, both (field)',
      (v) => document({ Pet: pet({ owner: { allOf: [meta(v), meta(v)] } }) }),
    ],
    [
      "a property a `$ref` member's component declares typed, the inline member as `false` (field)",
      (v) => document({ Base: meta(string), Pet: pet({ owner: { allOf: [ref('Base'), meta(v)] } }) }),
    ],
    [
      "a property a `$ref` member's component declares as `false`, the inline member typed (field)",
      (v) => document({ Base: meta(v), Pet: pet({ owner: { allOf: [ref('Base'), meta(string)] } }) }),
    ],
    [
      "a property a `$ref` member's component declares as `false`, beside another property (field)",
      (v) =>
        document({
          Base: object({ meta: v, id: string }),
          Pet: pet({ owner: { allOf: [ref('Base'), object({ x: string })] } }),
        }),
    ],
    [
      'a property of an inline response body',
      (v) => document({ Pet: pet() }, json(object({ legacyId: v, id: string }))),
    ],
    [
      'a required property of an inline response body',
      (v) => document({ Pet: pet() }, json(object({ legacyId: v, id: string }, { required: ['legacyId'] }))),
    ],
    [
      'a property of the inline items of an array response body',
      (v) => document({ Pet: pet() }, json({ type: 'array', items: object({ legacyId: v, id: string }) })),
    ],
    [
      'a property of an `allOf` member (response body)',
      (v) => document({ Owner: owner, Pet: pet() }, json({ allOf: [ref('Owner'), object({ legacyId: v })] })),
    ],
    [
      'a property two `allOf` members declare, the first (response body)',
      (v) => document({ Pet: pet() }, json({ allOf: [meta(v), meta(string)] })),
    ],
    [
      'a property two `allOf` members declare, the second (response body)',
      (v) => document({ Pet: pet() }, json({ allOf: [meta(string), meta(v)] })),
    ],
    [
      "a property a `$ref` member's component declares as `false` (response body)",
      (v) =>
        document(
          { Base: object({ meta: v, id: string }), Pet: pet() },
          json({ allOf: [ref('Base'), object({ x: string })] }),
        ),
    ],
    [
      'a property of a variant of a response body union',
      (v) => document({ Pet: pet() }, json({ oneOf: [ref('Pet'), object({ legacyId: v, id: string })] })),
    ],
    [
      'a property of an inline `404` response body',
      (v) => document({ Pet: pet() }, undefined, withStatus('404', object({ legacyId: v, message: string }))),
    ],
    [
      'a property of an inline `default` response body',
      (v) => document({ Pet: pet() }, undefined, withStatus('default', object({ legacyId: v, message: string }))),
    ],
    [
      'a property of an inline `4XX` response body',
      (v) => document({ Pet: pet() }, undefined, withStatus('4XX', object({ legacyId: v, message: string }))),
    ],
    [
      'a property of an error component',
      (v) =>
        document(
          { Pet: pet(), Problem: object({ legacyId: v, message: string }) },
          undefined,
          withStatus('404', ref('Problem')),
        ),
    ],
    [
      'a property of an inline request body',
      (v) => document({ Pet: pet() }, undefined, {}, post(json(object({ legacyId: v, id: string })))),
    ],
    [
      'a required property of an inline request body',
      (v) =>
        document(
          { Pet: pet() },
          undefined,
          {},
          post(json(object({ legacyId: v, id: string }, { required: ['legacyId'] }))),
        ),
    ],
    [
      'the only property of an inline request body',
      (v) => document({ Pet: pet() }, undefined, {}, post(json(object({ legacyId: v })))),
    ],
    [
      'a property of an `allOf` member (request body)',
      (v) =>
        document(
          { Owner: owner, Pet: pet() },
          undefined,
          {},
          post(json({ allOf: [ref('Owner'), object({ legacyId: v })] })),
        ),
    ],
    [
      'a property two `allOf` members declare, the first (request body)',
      (v) => document({ Pet: pet() }, undefined, {}, post(json({ allOf: [meta(v), meta(string)] }))),
    ],
    [
      'a property two `allOf` members declare, the second (request body)',
      (v) => document({ Pet: pet() }, undefined, {}, post(json({ allOf: [meta(string), meta(v)] }))),
    ],
    [
      'a property of a variant of a request body union',
      (v) =>
        document(
          { Pet: pet() },
          undefined,
          {},
          post(json({ oneOf: [object({ a: string, legacyId: v }), object({ b: string })] })),
        ),
    ],
    [
      'a property of a request body component',
      (v) =>
        document({ Pet: pet(), NewPet: object({ legacyId: v, id: string }) }, undefined, {}, post(json(ref('NewPet')))),
    ],
    [
      'a property of an inline form request body',
      (v) =>
        document(
          { Pet: pet() },
          undefined,
          {},
          post({ content: { 'application/x-www-form-urlencoded': { schema: object({ legacyId: v, id: string }) } } }),
        ),
    ],
    [
      'a property of an inline multipart request body',
      (v) =>
        document(
          { Pet: pet() },
          undefined,
          {},
          post({ content: { 'multipart/form-data': { schema: object({ legacyId: v, id: string }) } } }),
        ),
    ],
    [
      'a property of a request body under `components/requestBodies`',
      (v) =>
        document({ Pet: pet() }, undefined, {}, post({ $ref: '#/components/requestBodies/Any' }), {
          requestBodies: { Any: json(object({ legacyId: v, id: string })) },
        }),
    ],
    [
      'a property of a response body under `components/responses`',
      (v) =>
        document(
          { Pet: pet() },
          {},
          { responses: { '200': { $ref: '#/components/responses/Any' } } },
          {},
          { responses: { Any: { description: 'OK', ...json(object({ legacyId: v, id: string })) } } },
        ),
    ],
    [
      'a property of an object query parameter',
      (v) => document({ Pet: pet() }, undefined, parameter('query', object({ legacyId: v, id: string }))),
    ],
    [
      'a property of a deepObject query parameter',
      (v) =>
        document(
          { Pet: pet() },
          undefined,
          parameter('query', object({ legacyId: v, id: string }), { style: 'deepObject', explode: true }),
        ),
    ],
    [
      'a property of an object header parameter',
      (v) => document({ Pet: pet() }, undefined, parameter('header', object({ legacyId: v, id: string }))),
    ],
    [
      "a property of a parameter's `content` schema",
      (v) =>
        document({ Pet: pet() }, undefined, {
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: string },
            {
              name: 'filter',
              in: 'query',
              content: { 'application/json': { schema: object({ legacyId: v, id: string }) } },
            },
          ],
        }),
    ],
    [
      'a property of an object response header',
      (v) =>
        document(
          { Pet: pet() },
          { ...json(ref('Pet')), headers: { 'X-Rate-Limit': { schema: object({ legacyId: v, id: string }) } } },
        ),
    ],
    [
      'a property of a webhook payload',
      (v) => document({ Pet: pet() }, undefined, {}, webhook(object({ legacyId: v, id: string }))),
    ],
    [
      'a property of an `allOf` member of a webhook payload',
      (v) =>
        document(
          { Owner: owner, Pet: pet() },
          undefined,
          {},
          webhook({ allOf: [ref('Owner'), object({ legacyId: v })] }),
        ),
    ],
    [
      'a property of a callback payload',
      (v) => document({ Pet: pet() }, undefined, callback(object({ legacyId: v, id: string }))),
    ],
    ['a property of a list envelope', (v) => document({ Pet: pet() }, json(envelope(pets, { extra: v })), list)],
    ['the `data` of a list envelope', (v) => document({ Pet: pet() }, json(envelope(v)), list)],
    [
      'the `list_metadata` of a list envelope',
      (v) => document({ Pet: pet() }, json(object({ data: pets, list_metadata: v })), list),
    ],
    [
      'a property of the `list_metadata` of a list envelope',
      (v) =>
        document(
          { Pet: pet() },
          json(object({ data: pets, list_metadata: object({ after: string, legacyId: v }) })),
          list,
        ),
    ],
    [
      'the `data` of a list envelope component',
      (v) => document({ Pet: pet(), PetList: envelope(v) }, json(ref('PetList')), list),
    ],
    [
      'a property of a list envelope component',
      (v) => document({ Pet: pet(), PetList: envelope(pets, { extra: v }) }, json(ref('PetList')), list),
    ],
    [
      'a property of an `allOf` member of a list envelope',
      (v) => document({ Pet: pet() }, json({ allOf: [envelope(pets), object({ extra: v })] }), list),
    ],
    [
      'a nested property two typing declarations conjoin, the first as `false` (field)',
      (v) => document({ Pet: pet({ owner: { allOf: [nested(v, 'a'), nested(string, 'b')] } }) }),
    ],
    [
      'a nested property two typing declarations conjoin, the second as `false` (field)',
      (v) => document({ Pet: pet({ owner: { allOf: [nested(string, 'a'), nested(v, 'b')] } }) }),
    ],
    [
      'a nested property two typing declarations conjoin, both as `false` (field)',
      (v) => document({ Pet: pet({ owner: { allOf: [nested(v, 'a'), nested(v, 'b')] } }) }),
    ],
    [
      'a nested property two typing declarations conjoin, the first as `false` (component)',
      (v) => document({ Pet: { allOf: [nested(v, 'a'), nested(string, 'b')] } }),
    ],
    [
      'a nested property two typing declarations conjoin, the second as `false` (component)',
      (v) => document({ Pet: { allOf: [nested(string, 'a'), nested(v, 'b')] } }),
    ],
    [
      'a property of a dispatcher variant the base declares typed',
      (v) =>
        document({
          Base: object({ id: string, legacyId: string }),
          Pet: {
            allOf: [ref('Base')],
            oneOf: [
              object({ kind: { type: 'string', enum: ['cat'] }, legacyId: v }, { required: ['kind'] }),
              object({ kind: { type: 'string', enum: ['dog'] }, bark: string }, { required: ['kind'] }),
            ],
            discriminator: { propertyName: 'kind' },
          },
        }),
    ],
    [
      'a property of the base of a dispatcher',
      (v) =>
        document({
          Base: object({ id: string, legacyId: v }),
          Pet: {
            allOf: [ref('Base')],
            oneOf: [
              object({ kind: { type: 'string', enum: ['cat'] }, meow: string }, { required: ['kind'] }),
              object({ kind: { type: 'string', enum: ['dog'] }, bark: string }, { required: ['kind'] }),
            ],
            discriminator: { propertyName: 'kind' },
          },
        }),
    ],
    [
      'a property of an `allOf` member of a dispatcher variant',
      (v) =>
        document({
          Base: object({ id: string }),
          Pet: {
            allOf: [ref('Base')],
            oneOf: [
              { allOf: [object({ kind: { type: 'string', enum: ['cat'] }, legacyId: v }, { required: ['kind'] })] },
              object({ kind: { type: 'string', enum: ['dog'] }, bark: string }, { required: ['kind'] }),
            ],
            discriminator: { propertyName: 'kind' },
          },
        }),
    ],
    [
      'a property of the branches of a union nested in a dispatcher variant',
      (v) =>
        document({
          Base: object({ id: string }),
          Pet: {
            allOf: [ref('Base')],
            oneOf: [
              {
                allOf: [
                  object({ kind: { type: 'string', enum: ['cat'] } }, { required: ['kind'] }),
                  { oneOf: [object({ legacyId: v, a: string }), object({ legacyId: v, b: string })] },
                ],
              },
              object({ kind: { type: 'string', enum: ['dog'] }, bark: string }, { required: ['kind'] }),
            ],
            discriminator: { propertyName: 'kind' },
          },
        }),
    ],
    [
      'the pinned property of one dispatcher variant',
      (v) =>
        document({
          Base: object({ id: string }),
          Pet: {
            allOf: [ref('Base')],
            oneOf: [
              object({ kind: v, meow: string }),
              object({ kind: { type: 'string', enum: ['dog'] }, bark: string }),
            ],
          },
        }),
    ],
    [
      'a property the schema declares as `false` beside a variant that pins it',
      (v) =>
        document({
          Pet: {
            type: 'object',
            properties: { name: string, kind: v },
            oneOf: [
              object({ kind: { type: 'string', enum: ['cat'] }, meow: string }),
              object({ kind: { type: 'string', enum: ['dog'] }, bark: string }),
            ],
          },
        }),
    ],
    [
      'a property the schema declares typed beside a variant that declares it as `false`',
      (v) =>
        document({
          Pet: pet({
            value: {
              properties: { kind: string, id: string },
              oneOf: [object({ kind: v, meow: string }), object({ bark: string })],
            },
          }),
        }),
    ],
    [
      'a property of a discriminated request body variant',
      (v) =>
        document(
          { Pet: pet() },
          undefined,
          {},
          post(
            json({
              oneOf: [
                object(
                  { grant_type: { type: 'string', const: 'password' }, legacyId: v },
                  { required: ['grant_type'] },
                ),
                object(
                  { grant_type: { type: 'string', const: 'refresh' }, token: string },
                  { required: ['grant_type'] },
                ),
              ],
            }),
          ),
        ),
    ],
    [
      'the pinned property of a request body variant',
      (v) =>
        document(
          { Pet: pet() },
          undefined,
          {},
          post(
            json({
              oneOf: [
                object({ grant_type: v, password: string }),
                object(
                  { grant_type: { type: 'string', const: 'refresh' }, token: string },
                  { required: ['grant_type'] },
                ),
              ],
            }),
          ),
        ),
    ],
    [
      'a property of a `$ref` variant of a request body union',
      (v) =>
        document(
          { Pet: pet(), ByName: object({ name: string, legacyId: v }), ById: object({ id: string }) },
          undefined,
          {},
          post(json({ oneOf: [ref('ByName'), ref('ById')] })),
        ),
    ],
    [
      'the `object` property of a response body',
      (v) => document({ Pet: pet() }, json(object({ object: v, id: string }))),
    ],
    [
      'the `has_more` of a list envelope',
      (v) =>
        document(
          { Pet: pet() },
          json(object({ data: pets, has_more: v, list_metadata: object({ after: string }) })),
          list,
        ),
    ],
    [
      'the `has_more` of the `list_metadata` of a list envelope',
      (v) =>
        document(
          { Pet: pet() },
          json(object({ data: pets, list_metadata: object({ after: string, has_more: v }) })),
          list,
        ),
    ],
    [
      'the `after` of the `list_metadata` of a list envelope',
      (v) =>
        document(
          { Pet: pet() },
          json(object({ data: pets, list_metadata: object({ after: v, before: string }) })),
          list,
        ),
    ],
    [
      'a property of the items of a list envelope',
      (v) =>
        document({ Pet: pet() }, json(envelope({ type: 'array', items: object({ id: string, legacyId: v }) })), list),
    ],
    [
      'a property of a variant of a union an `allOf` flattens (response body)',
      (v) =>
        document(
          { Owner: owner, Pet: pet() },
          json({ allOf: [ref('Owner'), { oneOf: [object({ a: string, legacyId: v }), object({ b: string })] }] }),
        ),
    ],
    [
      'a property of a component a field, array items and map values name',
      (v) =>
        document({
          Tag: object({ label: string, legacyId: v }),
          Pet: pet({
            tag: ref('Tag'),
            tags: { type: 'array', items: ref('Tag') },
            byName: { type: 'object', additionalProperties: ref('Tag') },
          }),
        }),
    ],
    [
      'a property of a component a webhook payload names',
      (v) => document({ Pet: pet(), Event: object({ id: string, legacyId: v }) }, undefined, {}, webhook(ref('Event'))),
    ],
    [
      'a sibling whose name array items would take',
      (v) => document({ Pet: pet({ tags: { type: 'array', items: object({ label: string }) }, tag: v }) }),
    ],
    [
      'a sibling whose name map values would take',
      (v) =>
        document({
          Pet: pet({ extras: { type: 'object', additionalProperties: object({ label: string }) }, extra: v }),
        }),
    ],
    [
      'a sibling whose name a union variant would take',
      (v) =>
        document({
          Pet: pet({ shape: { oneOf: [object({ radius: string }), object({ side: string })] }, shape_with_side: v }),
        }),
    ],
    [
      'a sibling whose name array items would take (response body)',
      (v) =>
        document({ Pet: pet() }, json(object({ tags: { type: 'array', items: object({ label: string }) }, tag: v }))),
    ],
    [
      'a sibling whose name array items would take (`allOf` member)',
      (v) =>
        document({
          Owner: owner,
          Pet: { allOf: [ref('Owner'), object({ tags: { type: 'array', items: object({ label: string }) }, tag: v })] },
        }),
    ],
    [
      '`additionalProperties` beside `properties` and an `allOf` (component)',
      (v) =>
        document({
          Owner: owner,
          Pet: { allOf: [ref('Owner')], properties: { name: string }, additionalProperties: v },
        }),
    ],
    [
      '`additionalProperties` beside `properties` (request body component)',
      (v) =>
        document(
          { Pet: pet(), NewPet: object({ id: string }, { additionalProperties: v }) },
          undefined,
          {},
          post(json(ref('NewPet'))),
        ),
    ],
    [
      '`additionalProperties` beside `properties` (component)',
      (v) => document({ Pet: pet({}, { additionalProperties: v }) }),
    ],
  ];

  const pointer: Array<[string, Build]> = [
    [
      'a property a pointer names from another property',
      (v) =>
        document({
          Pet: pet({ legacyId: v, again: { $ref: '#/components/schemas/Pet/properties/legacyId' } }),
        }),
    ],
    [
      'a property a pointer names from another component',
      (v) =>
        document({
          Pet: pet({ legacyId: v }),
          Other: object({ id: string, again: { $ref: '#/components/schemas/Pet/properties/legacyId' } }),
        }),
    ],
    [
      'a property a pointer names from a response body',
      (v) => document({ Pet: pet({ legacyId: v }) }, json({ $ref: '#/components/schemas/Pet/properties/legacyId' })),
    ],
    [
      'a property a pointer names from array items',
      (v) =>
        document({
          Pet: pet({
            legacyId: v,
            tags: { type: 'array', items: { $ref: '#/components/schemas/Pet/properties/legacyId' } },
          }),
        }),
    ],
  ];

  const typed: Array<[string, Build]> = [
    ['array `items`', (v) => document({ Pet: pet({ tags: { type: 'array', items: v } }) })],
    ['array `items` with no `type`', (v) => document({ Pet: pet({ tags: { items: v } }) })],
    [
      'array `items` (array component)',
      (v) => document({ Pet: pet({ tags: ref('Tags') }), Tags: { type: 'array', items: v } }),
    ],
    ['array `items` (response body)', (v) => document({ Pet: pet() }, json({ type: 'array', items: v }))],
    [
      'array `items` (query parameter)',
      (v) => document({ Pet: pet() }, undefined, parameter('query', { type: 'array', items: v })),
    ],
    ['a `prefixItems` entry', (v) => document({ Pet: pet({ pair: { type: 'array', prefixItems: [v, string] } }) })],
    ['`additionalProperties`', (v) => document({ Pet: pet({ extra: { type: 'object', additionalProperties: v } }) })],
    [
      '`additionalProperties` beside `properties` (field)',
      (v) => document({ Pet: pet({ owner: object({ id: string }, { additionalProperties: v }) }) }),
    ],
    [
      '`additionalProperties` (response body)',
      (v) => document({ Pet: pet() }, json({ type: 'object', additionalProperties: v })),
    ],
    [
      '`additionalProperties` (map component)',
      (v) => document({ Pet: pet({ extra: ref('Extra') }), Extra: { type: 'object', additionalProperties: v } }),
    ],
    [
      'a `patternProperties` value',
      (v) => document({ Pet: pet({ extra: { type: 'object', patternProperties: { '^x-': v } } }) }),
    ],
    [
      'a `patternProperties` value beside `properties` (component)',
      (v) => document({ Pet: pet({}, { patternProperties: { '^x-': v } }) }),
    ],
    ['`unevaluatedProperties`', (v) => document({ Pet: pet({ extra: { type: 'object', unevaluatedProperties: v } }) })],
    [
      '`unevaluatedProperties` beside `properties` (component)',
      (v) => document({ Pet: pet({}, { unevaluatedProperties: v }) }),
    ],
    [
      '`unevaluatedItems`',
      (v) => document({ Pet: pet({ tags: { type: 'array', items: string, unevaluatedItems: v } }) }),
    ],
    ['`propertyNames`', (v) => document({ Pet: pet({ extra: { type: 'object', propertyNames: v } }) })],
    ['`contains`', (v) => document({ Pet: pet({ tags: { type: 'array', items: string, contains: v } }) })],
    ['`not`', (v) => document({ Pet: pet({ value: { not: v } }) })],
    ['a `oneOf` variant', (v) => document({ Pet: pet({ value: { oneOf: [string, v] } }) })],
    ['a `oneOf` variant beside a `null` one', (v) => document({ Pet: pet({ value: { oneOf: [v, nullVariant] } }) })],
    ['an `anyOf` variant', (v) => document({ Pet: pet({ value: { anyOf: [string, v] } }) })],
    ['the only `oneOf` variant', (v) => document({ Pet: pet({ value: { oneOf: [v] } }) })],
    ['an `allOf` member (field)', (v) => document({ Owner: owner, Pet: pet({ owner: { allOf: [ref('Owner'), v] } }) })],
    ['the only `allOf` member (field)', (v) => document({ Pet: pet({ owner: { allOf: [v] } }) })],
    ['an `allOf` member (component)', (v) => document({ Owner: owner, Pet: { allOf: [ref('Owner'), v] } })],
    ['a response body', (v) => document({ Pet: pet() }, json(v))],
    ['a `404` response body', (v) => document({ Pet: pet() }, undefined, withStatus('404', v))],
    ['a `default` response body', (v) => document({ Pet: pet() }, undefined, withStatus('default', v))],
    ['a request body', (v) => document({ Pet: pet() }, undefined, {}, post(json(v)))],
    [
      'a form request body',
      (v) =>
        document(
          { Pet: pet() },
          undefined,
          {},
          post({ content: { 'application/x-www-form-urlencoded': { schema: v } } }),
        ),
    ],
    ['a query parameter', (v) => document({ Pet: pet() }, undefined, parameter('query', v))],
    ['a header parameter', (v) => document({ Pet: pet() }, undefined, parameter('header', v))],
    [
      'a path parameter',
      (v) =>
        document({ Pet: pet() }, undefined, { parameters: [{ name: 'petId', in: 'path', required: true, schema: v }] }),
    ],
    [
      'a response header',
      (v) => document({ Pet: pet() }, { ...json(ref('Pet')), headers: { 'X-Rate-Limit': { schema: v } } }),
    ],
    ['a webhook payload', (v) => document({ Pet: pet() }, undefined, {}, webhook(v))],
    ['a callback payload', (v) => document({ Pet: pet() }, undefined, callback(v))],
    ['the body of a list operation', (v) => document({ Pet: pet() }, json(v), list)],
    [
      "the `items` of a list envelope's `data`",
      (v) => document({ Pet: pet() }, json(envelope({ type: 'array', items: v })), list),
    ],
  ];

  return { property, pointer, typed };
}

/** A way to write a property's schema that leads to `false`: the schema, and the components it names. */
interface Spelling {
  label: string;
  value: unknown;
  schemas: Doc;
  /** Whether the components are written before the document's own. */
  first?: boolean;
}

const never = ref('Never');

/** Every `$ref` spelling of a property that is `false`: each must read as `false` written in its place. */
const LEADS_TO_FALSE: readonly Spelling[] = [
  { label: 'a `$ref` to a component that is `false`', value: never, schemas: { Never: false } },
  { label: 'the same, the component written first', value: never, schemas: { Never: false }, first: true },
  {
    label: 'a `$ref` to an alias of one',
    value: ref('NeverAlias'),
    schemas: { NeverAlias: never, Never: false },
  },
  {
    label: 'a chain of five `$ref`s',
    value: ref('N1'),
    schemas: { N1: ref('N2'), N2: ref('N3'), N3: ref('N4'), N4: ref('N5'), N5: false },
  },
  {
    label: 'a `$ref` with a description beside it',
    value: { ...never, description: 'Gone.' },
    schemas: { Never: false },
  },
  { label: 'a `$ref` with a `type` beside it', value: { ...never, type: 'string' }, schemas: { Never: false } },
  { label: 'a `$ref` to a component that is `0`', value: never, schemas: { Never: 0 } },
  { label: "a `$ref` to a component that is `''`", value: never, schemas: { Never: '' } },
];

/** `Holder { held, gone }`, `gone` written as `schema`: what a JSON Pointer to a property lands on. */
const holder = (schema: unknown): Doc => ({ Holder: { type: 'object', properties: { held: string, gone: schema } } });
const pointerToGone = { $ref: '#/components/schemas/Holder/properties/gone' };

/** A JSON Pointer to a property that is `false`, by each spelling of that property. */
const POINTS_AT_FALSE: readonly Spelling[] = [
  { label: 'a pointer to a property written `false`', value: pointerToGone, schemas: holder(false) },
  {
    label: 'a pointer to a property that is a `$ref` to `false`',
    value: pointerToGone,
    schemas: { ...holder(never), Never: false },
  },
  { label: 'a pointer to a property written `null`', value: pointerToGone, schemas: holder(null) },
];

const spell = (build: Build, { value, schemas, first }: Spelling): Doc => withSchemas(build(value), schemas, first);

// ---------------------------------------------------------------------------

describe("#746 the issue's documents", () => {
  const document = (legacyId: unknown, schemas: Doc = {}, openapi: Version = '3.1.0') => ({
    openapi,
    info: { title: 'Repro', version: '1.0.0' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: string }],
          responses: { '200': { description: 'OK', ...json(ref('Pet')) } },
        },
      },
    },
    components: { schemas: { Pet: { type: 'object', properties: { name: string, legacyId } }, ...schemas } },
  });
  const inline = document(false);
  const byRef = document(never, { Never: false });

  /** The issue's script: each field of `Pet` as `name?: type`. */
  const typeOf = (type: TypeRef): string => (type.kind === 'model' ? type.name : (type as { type: string }).type);
  const fieldsOf = async (doc: unknown): Promise<string> => {
    const { models } = await parse(doc);
    const { fields } = models.find(({ name }) => name === 'Pet')!;
    return fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${typeOf(f.type)}`).join(', ');
  };

  it("prints the issue's script output: `ref.json` as `inline.json`", async () => {
    const lines = [`inline.json ${await fieldsOf(inline)}`, `ref.json ${await fieldsOf(byRef)}`];
    // On main (ae211f35) the second line was `ref.json name?: string, legacyId?: unknown`.
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "inline.json name?: string
      ref.json name?: string"
    `);
  });

  it('reports nothing between the two, in either direction', async () => {
    // On main `oagen diff --old inline.json --new ref.json` exited 1, with an additive `field-added` for `legacyId`.
    await expectNoDiff(inline, byRef);
    expect(await parse(byRef)).toEqual(await parse(inline));
    expect((await read(byRef)).warnings).toEqual([]);
  });

  it('reads the two alike in an OAS 3.0.3 document too, which the parser reads a boolean schema in', async () => {
    const [first, second] = [document(false, {}, '3.0.3'), document(never, { Never: false }, '3.0.3')];
    expect(await fieldsOf(second)).toBe('name?: string');
    await expectNoDiff(first, second);
  });

  it('keeps a `$ref` to a `true` component, and to `{}`, the field typed `unknown` it was', async () => {
    const anything = ref('Anything');
    expect(await fieldsOf(document(anything, { Anything: true }))).toBe('name?: string, legacyId?: unknown');
    expect(await fieldsOf(document(anything, { Anything: {} }))).toBe('name?: string, legacyId?: unknown');
    expect(await fieldsOf(document(true))).toBe('name?: string, legacyId?: unknown');
    await expectNoDiff(document(anything, { Anything: true }), document(true, { Anything: true }));
  });

  it('gives a `required` name no field either, as the inline `false` gives it none', async () => {
    const required = (legacyId: unknown, schemas: Doc = {}) => {
      const doc = document(legacyId, schemas);
      (doc.components.schemas.Pet as Doc)['required'] = ['legacyId'];
      return doc;
    };
    expect(await fieldsOf(required(never, { Never: false }))).toBe('name?: string');
    await expectNoDiff(required(false), required(never, { Never: false }));
  });
});

describe.each(VERSIONS)('#746 a property that is a `$ref` to `false`, OpenAPI %s', (openapi) => {
  interface Row {
    position: string;
    build: Build;
    /** The property written `false`. */
    inline: Reading;
  }
  let table: Row[];
  beforeAll(async () => {
    // `beforeAll` runs before the `beforeEach` that silences the warnings.
    const silenced = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn = silenced;
    try {
      table = [];
      for (const [position, build] of positions(openapi).property) {
        table.push({ position, build, inline: await read(build(false)) });
      }
    } finally {
      silenced.mockRestore();
    }
  }, 60_000);

  it('is the `false` it names at every position a property is written at, by every spelling of the `$ref`', async () => {
    expect(table.length).toBeGreaterThanOrEqual(120);
    for (const { position, build, inline } of table) {
      for (const spelling of LEADS_TO_FALSE) {
        const label = `${position}: ${spelling.label}`;
        const reading = await read(spell(build, spelling));
        expect(reading.spec, label).toEqual(inline.spec);
        expect(reading.warnings, label).toEqual(inline.warnings);
        expect(danglingReferences(reading.spec), label).toEqual([]);
      }
    }
  }, 60_000);

  it('types every position as `false` written there types it', () => {
    // What both spellings parse to. On main each `$ref` row carried the property as a field typed `unknown`
    // (`Pet { name?: string, legacyId?: unknown }` for the first), or typed a field by the `$ref` where the inline
    // `false` leaves it to another declaration (`meta?: unknown` for a property two members declare).
    const lines = table.map(({ position, inline }) => `${position}: ${render(inline.spec)}`);
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "a property of a component: Pet { name?: string }
      a required property of a component: Pet { name?: string }
      the only property of a component: Pet {  }
      the first property of a component: Pet { name?: string }
      a property of a component with no \`type\`: Pet { name?: string }
      a property of a nullable component: Pet { name?: string }; getPet(path petId: string) -> nullable<Pet>
      a property beside an \`allOf\` (component): Owner { ownerName?: string }; Pet { ownerName?: string }
      a required property beside an \`allOf\` (component): Owner { ownerName?: string }; Pet { ownerName?: string }
      a property of an \`allOf\` member (component): Owner { ownerName?: string }; Pet { ownerName?: string }
      a required property of an \`allOf\` member (component): Owner { ownerName?: string }; Pet { ownerName?: string }
      a property of a \`$ref\` member's component (inherited): Base { id?: string }; Pet { id?: string, name?: string }
      a required property of a \`$ref\` member's component (inherited): Base { id?: string }; Pet { id?: string, name?: string }
      a property of the only \`allOf\` member (component): Pet { name?: string }
      a property of a nested \`allOf\` member (component): Owner { ownerName?: string }; Pet { ownerName?: string }
      a property two \`allOf\` members declare, the first (component): Pet { meta?: string }
      a property two \`allOf\` members declare, the second (component): Pet { meta?: string }
      a property two \`allOf\` members declare, both (component): Pet {  }
      a property a \`$ref\` member's component declares typed, the inline member as \`false\`: Base { meta?: string }; Pet { meta?: string }
      a property a \`$ref\` member's component declares as \`false\`, the inline member typed: Base {  }; Pet { meta?: string }
      a property a \`$ref\` member's component declares as \`false\`, the inline member first and typed: Base {  }; Pet { meta?: string }
      a property two \`$ref\` members' components declare, the first as \`false\`: A {  }; B { meta?: string }; Pet { meta?: string }
      a property two \`$ref\` members' components declare, the second as \`false\`: A { meta?: string }; B {  }; Pet { meta?: string }
      a property beside an \`allOf\` whose member declares it typed (component): Base { meta?: string }; Pet { meta?: string }
      a property of a variant of a pure \`oneOf\` component: Pet { name?: string, other?: string } = oneOf(PetWithName | PetWithOther); PetWithName { name?: string }; PetWithOther { other?: string }
      a property of a variant of a pure \`anyOf\` component: Pet { name?: string, other?: string } = anyOf(PetWithName | PetWithOther); PetWithName { name?: string }; PetWithOther { other?: string }
      a property of a variant beside properties (component): Pet { name?: string, other?: string }
      a property beside a \`oneOf\` (component): Pet { name?: string, a?: string, b?: string }
      a property of a discriminated variant component: Cat { kind: "cat", meow?: string }; Dog { kind: "dog", bark?: string }; Pet { name?: string, animal?: (Cat | Dog) }
      the discriminator property of a variant component: Cat { meow?: string }; Dog { kind: "dog", bark?: string }; Pet { name?: string, animal?: (Cat | Dog) }
      a property of a variant of an allOf+oneOf dispatcher: Base { id?: string }; Pet { id?: string }; PetCat { id?: string, kind: "cat" }; PetDog { id?: string, kind: "dog", bark?: string }
      a property of an inline object (field): Pet { name?: string, owner?: PetOwner }; PetOwner {  }
      a required property of an inline object (field): Pet { name?: string, owner?: PetOwner }; PetOwner { id?: string }
      a property of an inline object two levels down: Pet { name?: string, owner?: PetOwner }; PetOwner { address?: PetOwnerAddress }; PetOwnerAddress { city?: string }
      a property of the inline items of an array (field): Pet { name?: string, tags?: PetTags[] }; PetTags { label?: string }
      a property of the inline items of an array component: Pet { name?: string, tags?: TagsItem[] }; TagsItem { label?: string }
      a property of inline map values (field): Pet { name?: string, extra?: map<PetExtra> }; PetExtra { label?: string }
      a property of a nullable inline object (field): Pet { name?: string, owner?: nullable<PetOwner> }; PetOwner { id?: string }
      a property of an inline union variant (field): Pet { name?: string, value?: (PetValue | string) }; PetValue { id?: string }
      a property of an inline \`anyOf\` variant (field): Pet { name?: string, value?: (PetValue | string) }; PetValue { id?: string }
      a property of an inline variant of a named union component: Owner { ownerName?: string }; Pet { name?: string, value?: Value }; Value { id?: string } = oneOf(Owner | ValueWithId); ValueWithId { id?: string }
      a property beside a \`oneOf\` (field): Pet { name?: string, value?: (PetValue | PetValueWithB) }; PetValue { id?: string, a?: string }; PetValueWithB { id?: string, b?: string }
      a property beside an \`allOf\` (field): Owner { ownerName?: string }; Pet { name?: string, owner?: PetOwner }; PetOwner { ownerName?: string }
      a property of an \`allOf\` member (field): Owner { ownerName?: string }; Pet { name?: string, owner?: PetOwner }; PetOwner { ownerName?: string }
      a required property of an \`allOf\` member (field): Owner { ownerName?: string }; Pet { name?: string, owner?: PetOwner }; PetOwner { ownerName?: string }
      a property two \`allOf\` members declare, the first (field): Pet { name?: string, owner?: PetOwner }; PetOwner { meta?: string }
      a property two \`allOf\` members declare, the second (field): Pet { name?: string, owner?: PetOwner }; PetOwner { meta?: string }
      a property two \`allOf\` members declare, both (field): Pet { name?: string, owner?: PetOwner }; PetOwner {  }
      a property a \`$ref\` member's component declares typed, the inline member as \`false\` (field): Base { meta?: string }; Pet { name?: string, owner?: PetOwner }; PetOwner { meta?: string }
      a property a \`$ref\` member's component declares as \`false\`, the inline member typed (field): Base {  }; Pet { name?: string, owner?: PetOwner }; PetOwner { meta?: string }
      a property a \`$ref\` member's component declares as \`false\`, beside another property (field): Base { id?: string }; Pet { name?: string, owner?: PetOwner }; PetOwner { id?: string, x?: string }
      a property of an inline response body: Pet { name?: string }; GetPetResponse { id?: string }; getPet(path petId: string) -> GetPetResponse
      a required property of an inline response body: Pet { name?: string }; GetPetResponse { id?: string }; getPet(path petId: string) -> GetPetResponse
      a property of the inline items of an array response body: Pet { name?: string }; GetPetItem { id?: string }; getPet(path petId: string) -> GetPetItem[]
      a property of an \`allOf\` member (response body): Owner { ownerName?: string }; Pet { name?: string }; GetPetResponse { ownerName?: string }; getPet(path petId: string) -> GetPetResponse
      a property two \`allOf\` members declare, the first (response body): Pet { name?: string }; GetPetResponse { meta?: string }; getPet(path petId: string) -> GetPetResponse
      a property two \`allOf\` members declare, the second (response body): Pet { name?: string }; GetPetResponse { meta?: string }; getPet(path petId: string) -> GetPetResponse
      a property a \`$ref\` member's component declares as \`false\` (response body): Base { id?: string }; Pet { name?: string }; GetPetResponse { id?: string, x?: string }; getPet(path petId: string) -> GetPetResponse
      a property of a variant of a response body union: Pet { name?: string }; GetPetResponse { id?: string }; getPet(path petId: string) -> (Pet | GetPetResponse)
      a property of an inline \`404\` response body: Pet { name?: string }; OptionalErrorBody { message?: string }; getPet(path petId: string) -> Pet errors[404: OptionalErrorBody]
      a property of an inline \`default\` response body: Pet { name?: string }; GetPetDefaultResponse { message?: string }; getPet(path petId: string) -> Pet default GetPetDefaultResponse
      a property of an inline \`4XX\` response body: Pet { name?: string }; OptionalErrorBody { message?: string }; getPet(path petId: string) -> Pet 4XX OptionalErrorBody
      a property of an error component: Pet { name?: string }; Problem { message?: string }; getPet(path petId: string) -> Pet errors[404: Problem]
      a property of an inline request body: Pet { name?: string }; CreatePetRequest { id?: string }; createPet() body CreatePetRequest -> Pet
      a required property of an inline request body: Pet { name?: string }; CreatePetRequest { id?: string }; createPet() body CreatePetRequest -> Pet
      the only property of an inline request body: Pet { name?: string }; CreatePetRequest {  }; createPet() body CreatePetRequest -> Pet
      a property of an \`allOf\` member (request body): Owner { ownerName?: string }; Pet { name?: string }; CreatePetRequest { ownerName?: string }; createPet() body CreatePetRequest -> Pet
      a property two \`allOf\` members declare, the first (request body): Pet { name?: string }; CreatePetRequest { meta?: string }; createPet() body CreatePetRequest -> Pet
      a property two \`allOf\` members declare, the second (request body): Pet { name?: string }; CreatePetRequest { meta?: string }; createPet() body CreatePetRequest -> Pet
      a property of a variant of a request body union: Pet { name?: string }; CreatePetRequest { a?: string }; CreatePetRequestWithB { b?: string }; createPet() body (CreatePetRequest | CreatePetRequestWithB) -> Pet
      a property of a request body component: Pet { name?: string }; NewPet { id?: string }; createPet() body NewPet -> Pet
      a property of an inline form request body: Pet { name?: string }; CreatePetRequest { id?: string }; createPet() body CreatePetRequest -> Pet
      a property of an inline multipart request body: Pet { name?: string }; CreatePetRequest { id?: string }; createPet() body CreatePetRequest -> Pet
      a property of a request body under \`components/requestBodies\`: Pet { name?: string }; CreatePetRequest { id?: string }; createPet() body CreatePetRequest -> Pet
      a property of a response body under \`components/responses\`: Pet { name?: string }; AnyResponse { id?: string }; getPet(path petId: string) -> AnyResponse
      a property of an object query parameter: Pet { name?: string }; PetsFilter { id?: string }; getPet(path petId: string, query filter: PetsFilter) -> Pet
      a property of a deepObject query parameter: Pet { name?: string }; PetsFilter { id?: string }; getPet(path petId: string, query filter: PetsFilter) -> Pet
      a property of an object header parameter: Pet { name?: string }; PetsFilter { id?: string }; getPet(path petId: string, header filter: PetsFilter) -> Pet
      a property of a parameter's \`content\` schema: Pet { name?: string }; PetsFilter { id?: string }; getPet(path petId: string, query filter: PetsFilter) -> Pet
      a property of an object response header: Pet { name?: string }; PetsXRateLimit { id?: string }; getPet(path petId: string) -> Pet headers[X-Rate-Limit: PetsXRateLimit]
      a property of a webhook payload: Pet { name?: string }; PetCreatedPayload { id?: string }; webhook pet.created body PetCreatedPayload
      a property of an \`allOf\` member of a webhook payload: Owner { ownerName?: string }; Pet { name?: string }; PetCreatedPayload { ownerName?: string }; webhook pet.created body PetCreatedPayload
      a property of a callback payload: Pet { name?: string }; GetPetOnEventPayload { id?: string }; getPet(path petId: string) -> Pet callback onEvent body GetPetOnEventPayload
      a property of a list envelope: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
      the \`data\` of a list envelope: Pet { name?: string }; ListPetsResponse { list_metadata?: ListPetsResponseListMetadata }; ListPetsResponseListMetadata { after?: string }; listPets(query after: string) -> ListPetsResponse paged cursor of ListPetsResponse
      the \`list_metadata\` of a list envelope: Pet { name?: string }; ListPetsResponse { data?: Pet[] }; listPets(query after: string) -> ListPetsResponse paged cursor of ListPetsResponse
      a property of the \`list_metadata\` of a list envelope: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
      the \`data\` of a list envelope component: Pet { name?: string }; PetList { list_metadata?: PetListListMetadata }; PetListListMetadata { after?: string }; listPets(query after: string) -> PetList paged cursor of PetList
      a property of a list envelope component: Pet { name?: string }; PetList { data?: Pet[], list_metadata?: PetListListMetadata }; PetListListMetadata { after?: string }; listPets(query after: string) -> PetList paged cursor of PetList
      a property of an \`allOf\` member of a list envelope: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
      a nested property two typing declarations conjoin, the first as \`false\` (field): Pet { name?: string, owner?: PetOwner }; PetOwner { addr?: PetOwnerAddr }; PetOwnerAddr { x?: string, a?: string, b?: string }
      a nested property two typing declarations conjoin, the second as \`false\` (field): Pet { name?: string, owner?: PetOwner }; PetOwner { addr?: PetOwnerAddr }; PetOwnerAddr { x?: string, a?: string, b?: string }
      a nested property two typing declarations conjoin, both as \`false\` (field): Pet { name?: string, owner?: PetOwner }; PetOwner { addr?: PetOwnerAddr }; PetOwnerAddr { a?: string, b?: string }
      a nested property two typing declarations conjoin, the first as \`false\` (component): Pet { addr?: PetAddr }; PetAddr { x?: string, a?: string, b?: string }
      a nested property two typing declarations conjoin, the second as \`false\` (component): Pet { addr?: PetAddr }; PetAddr { x?: string, a?: string, b?: string }
      a property of a dispatcher variant the base declares typed: Base { id?: string, legacyId?: string }; Pet { id?: string, legacyId?: string }; PetCat { id?: string, legacyId?: string, kind: "cat" }; PetDog { id?: string, legacyId?: string, kind: "dog", bark?: string }
      a property of the base of a dispatcher: Base { id?: string }; Pet { id?: string }; PetCat { id?: string, kind: "cat", meow?: string }; PetDog { id?: string, kind: "dog", bark?: string }
      a property of an \`allOf\` member of a dispatcher variant: Base { id?: string }; Pet { id?: string }; PetCat { id?: string, kind: "cat" }; PetDog { id?: string, kind: "dog", bark?: string }
      a property of the branches of a union nested in a dispatcher variant: Base { id?: string }; Pet { id?: string }; PetCat { id?: string, kind: "cat", legacyId?: unknown, a?: string, b?: string }; PetDog { id?: string, kind: "dog", bark?: string }
      the pinned property of one dispatcher variant: Base { id?: string }; Pet { id?: string, meow?: string, kind?: "dog", bark?: string }
      a property the schema declares as \`false\` beside a variant that pins it: Pet { name?: string }; PetCat { name?: string, kind?: "cat", meow?: string }; PetDog { name?: string, kind?: "dog", bark?: string }
      a property the schema declares typed beside a variant that declares it as \`false\`: Pet { name?: string, value?: (PetValue | PetValueWithBark) }; PetValue { kind?: string, id?: string, meow?: string }; PetValueWithBark { kind?: string, id?: string, bark?: string }
      a property of a discriminated request body variant: Pet { name?: string }; PasswordCreatePetRequest { grant_type: "password" }; RefreshCreatePetRequest { grant_type: "refresh", token?: string }; createPet() body (PasswordCreatePetRequest | RefreshCreatePetRequest) -> Pet
      the pinned property of a request body variant: Pet { name?: string }; CreatePetRequest { password?: string }; RefreshCreatePetRequest { grant_type: "refresh", token?: string }; createPet() body (CreatePetRequest | RefreshCreatePetRequest) -> Pet
      a property of a \`$ref\` variant of a request body union: Pet { name?: string }; ByName { name?: string }; ById { id?: string }; createPet() body (ByName | ById) -> Pet
      the \`object\` property of a response body: Pet { name?: string }; GetPetResponse { id?: string }; getPet(path petId: string) -> GetPetResponse
      the \`has_more\` of a list envelope: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
      the \`has_more\` of the \`list_metadata\` of a list envelope: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
      the \`after\` of the \`list_metadata\` of a list envelope: Pet { name?: string }; ListMetadata { before?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
      a property of the items of a list envelope: Pet { name?: string }; ListPetsItem { id?: string }; ListMetadata { after?: string }; listPets(query after: string) -> ListPetsItem[] paged cursor of ListPetsItem
      a property of a variant of a union an \`allOf\` flattens (response body): Owner { ownerName?: string }; Pet { name?: string }; GetPetResponse { ownerName?: string, a?: string, b?: string }; getPet(path petId: string) -> GetPetResponse
      a property of a component a field, array items and map values name: Tag { label?: string }; Pet { name?: string, tag?: Tag, tags?: Tag[], byName?: map<Tag> }
      a property of a component a webhook payload names: Pet { name?: string }; Event { id?: string }; webhook pet.created body Event
      a sibling whose name array items would take: Pet { name?: string, tags?: PetTags[] }; PetTags { label?: string }
      a sibling whose name map values would take: Pet { name?: string, extras?: map<PetExtra> }; PetExtra { label?: string }
      a sibling whose name a union variant would take: Pet { name?: string, shape?: (PetShape | PetShapeWithSide) }; PetShape { radius?: string }; PetShapeWithSide { side?: string }
      a sibling whose name array items would take (response body): Pet { name?: string }; GetPetResponse { tags?: GetPetResponseTags[] }; GetPetResponseTags { label?: string }; getPet(path petId: string) -> GetPetResponse
      a sibling whose name array items would take (\`allOf\` member): Owner { ownerName?: string }; Pet { ownerName?: string, tags?: PetTags[] }; PetTags { label?: string }
      \`additionalProperties\` beside \`properties\` and an \`allOf\` (component): Owner { ownerName?: string }; Pet { name?: string, ownerName?: string }
      \`additionalProperties\` beside \`properties\` (request body component): Pet { name?: string }; NewPet { id?: string }; createPet() body NewPet -> Pet
      \`additionalProperties\` beside \`properties\` (component): Pet { name?: string }"
    `);
  });

  it('reports no change between the two spellings at any position, in either direction', async () => {
    for (const { position, build } of table) {
      await expectNoDiff(build(false), spell(build, LEADS_TO_FALSE[0]!), position);
    }
  }, 120_000);

  it('is the `false` a JSON Pointer to a property names, however that property is written', async () => {
    for (const { position, build } of table) {
      for (const spelling of POINTS_AT_FALSE) {
        const label = `${position}: ${spelling.label}`;
        // The same document with `false` in the pointer's place.
        const inline = await read(withSchemas(build(false), spelling.schemas));
        const reading = await read(spell(build, spelling));
        expect(reading.spec, label).toEqual(inline.spec);
        expect(reading.warnings, label).toEqual(inline.warnings);
      }
    }
  }, 60_000);

  it('leaves a `$ref` to `true` and to `{}` the declaration it was, read alike', async () => {
    const anything = ref('Anything');
    const lines: string[] = [];
    for (const { position, build } of table) {
      const [yes, empty] = [
        await read(withSchemas(build(anything), { Anything: true })),
        await read(withSchemas(build(anything), { Anything: {} })),
      ];
      expect(yes.spec, position).toEqual(empty.spec);
      expect(yes.warnings, position).toEqual(empty.warnings);
      lines.push(`${position}: ${render(yes.spec)}`);
    }
    // Unchanged from main: the property is declared, and typed as #728 types a `$ref` to `true`.
    expect(lines.slice(0, 12).join('\n')).toMatchInlineSnapshot(`
      "a property of a component: Pet { name?: string, legacyId?: unknown }
      a required property of a component: Pet { name?: string, legacyId: unknown }
      the only property of a component: Pet { legacyId?: unknown }
      the first property of a component: Pet { legacyId?: unknown, name?: string }
      a property of a component with no \`type\`: Pet { name?: string, legacyId?: unknown }
      a property of a nullable component: Pet { name?: string, legacyId?: unknown }; getPet(path petId: string) -> nullable<Pet>
      a property beside an \`allOf\` (component): Owner { ownerName?: string }; Pet { legacyId?: unknown, ownerName?: string }
      a required property beside an \`allOf\` (component): Owner { ownerName?: string }; Pet { legacyId: unknown, ownerName?: string }
      a property of an \`allOf\` member (component): Owner { ownerName?: string }; Pet { ownerName?: string, legacyId?: unknown }
      a required property of an \`allOf\` member (component): Owner { ownerName?: string }; Pet { ownerName?: string, legacyId: unknown }
      a property of a \`$ref\` member's component (inherited): Base { legacyId?: unknown, id?: string }; Pet { legacyId?: unknown, id?: string, name?: string }
      a required property of a \`$ref\` member's component (inherited): Base { legacyId: unknown, id?: string }; Pet { legacyId: unknown, id?: string, name?: string }"
    `);
  }, 60_000);

  it('leaves `false` reached through anything but a `$ref` the `unknown` it was', async () => {
    // `{ allOf: [false] }` and a nullable wrapper around `false` are read for a type, and so is a `$ref` to
    // either: each reads as the same schema over `true` does.
    const nullVariant = openapi === '3.0.3' ? { enum: [null] } : { type: 'null' };
    const through: ReadonlyArray<readonly [string, (leaf: unknown) => { value: unknown; schemas: Doc }]> = [
      ['an `allOf` of the `$ref`', (leaf) => ({ value: { allOf: [never] }, schemas: { Never: leaf } })],
      [
        'a `$ref` to an `allOf` of the `$ref`',
        (leaf) => ({ value: ref('Wrapped'), schemas: { Wrapped: { allOf: [never] }, Never: leaf } }),
      ],
      [
        'a nullable wrapper around the `$ref`',
        (leaf) => ({ value: { oneOf: [never, nullVariant] }, schemas: { Never: leaf } }),
      ],
      ['an `allOf` of the boolean itself', (leaf) => ({ value: { allOf: [leaf] }, schemas: {} })],
    ];
    for (const { position, build } of table) {
      for (const [label, of] of through) {
        const [no, yes] = [of(false), of(true)];
        const [overFalse, overTrue] = [
          await read(withSchemas(build(no.value), no.schemas)),
          await read(withSchemas(build(yes.value), yes.schemas)),
        ];
        expect(overFalse.spec, `${position}: ${label}`).toEqual(overTrue.spec);
      }
    }
  }, 60_000);
});

describe.each(VERSIONS)('#746 a JSON Pointer to a property that is `false`, OpenAPI %s', (openapi) => {
  /** The property the pointer names, by each spelling. */
  const spellings: ReadonlyArray<readonly [string, unknown, Doc]> = [
    ['`false`', false, {}],
    ['a `$ref` to `false`', never, { Never: false }],
    ['a `$ref` to an alias of `false`', ref('NeverAlias'), { NeverAlias: never, Never: false }],
  ];

  it('reads every site that names the property alike, whichever way the property is written', async () => {
    const lines: string[] = [];
    for (const [position, build] of positions(openapi).pointer) {
      const inline = await read(build(false));
      for (const [label, value, schemas] of spellings) {
        const reading = await read(withSchemas(build(value), schemas));
        expect(reading.spec, `${position}: ${label}`).toEqual(inline.spec);
        expect(reading.warnings, `${position}: ${label}`).toEqual(inline.warnings);
      }
      lines.push(`${position}\n  ${render(inline.spec)}\n  ${inline.warnings.join('\n  ') || '(no warning)'}`);
    }
    // A property written as the pointer is the `false` it names, no field (on main it was `again?: unknown`,
    // with the unresolved-reference warning for the inline `false` and with none for the `$ref`). A body or
    // array items written as the pointer are read for a type: `unknown`, with the warning a pointer to a
    // property written `false` always had (on main the `$ref` spelling was typed silently, from the field).
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "a property a pointer names from another property
        Pet { name?: string }
        (no warning)
      a property a pointer names from another component
        Pet { name?: string }; Other { id?: string }
        (no warning)
      a property a pointer names from a response body
        Pet { name?: string }; getPet(path petId: string) -> unknown
        [oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/legacyId" in Pets.getPet.response: no schema at that pointer — typing the site as unknown
      a property a pointer names from array items
        Pet { name?: string, tags?: unknown[] }
        [oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/legacyId" in Pet.tags: no schema at that pointer — typing the site as unknown"
    `);
  });

  it('keeps a pointer to a property written `true` the `unknown` it was, with the warning (#728)', async () => {
    const lines: string[] = [];
    for (const [position, build] of positions(openapi).pointer) {
      const reading = await read(build(true));
      lines.push(`${position}\n  ${render(reading.spec)}\n  ${reading.warnings.join('\n  ') || '(no warning)'}`);
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "a property a pointer names from another property
        Pet { name?: string, legacyId?: unknown, again?: unknown }
        [oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/legacyId" in Pet.again: no schema at that pointer — typing the site as unknown
      a property a pointer names from another component
        Pet { name?: string, legacyId?: unknown }; Other { id?: string, again?: unknown }
        [oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/legacyId" in Other.again: no schema at that pointer — typing the site as unknown
      a property a pointer names from a response body
        Pet { name?: string, legacyId?: unknown }; getPet(path petId: string) -> unknown
        [oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/legacyId" in Pets.getPet.response: no schema at that pointer — typing the site as unknown
      a property a pointer names from array items
        Pet { name?: string, legacyId?: unknown, tags?: unknown[] }
        [oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/legacyId" in Pet.tags: no schema at that pointer — typing the site as unknown"
    `);
  });
});

describe.each(VERSIONS)('#746 a `$ref` to `false` read for a type, OpenAPI %s', (openapi) => {
  it('stays what it was at every position that reads a schema for a type: as a `$ref` to `true` is', async () => {
    // The positions the issue leaves alone. A reader that first asks whether a schema is written at all reads
    // the inline `false` as none written (`items`, a media type's or a parameter's `schema`); the `$ref` is a
    // schema that is written, typed `unknown` (#728). Both columns are as on main.
    const lines: string[] = [];
    for (const [position, build] of positions(openapi).typed) {
      const [inline, byRef, toTrue] = [
        await read(build(false)),
        await read(withSchemas(build(never), { Never: false })),
        await read(withSchemas(build(never), { Never: true })),
      ];
      expect(byRef.spec, position).toEqual(toTrue.spec);
      expect(byRef.warnings, position).toEqual(toTrue.warnings);
      expect(danglingReferences(byRef.spec), position).toEqual([]);
      lines.push(`${position}\n  false: ${render(inline.spec)}\n  $ref:  ${render(byRef.spec)}`);
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "array \`items\`
        false: Pet { name?: string, tags?: unknown }
        $ref:  Pet { name?: string, tags?: unknown[] }
      array \`items\` with no \`type\`
        false: Pet { name?: string, tags?: unknown }
        $ref:  Pet { name?: string, tags?: unknown[] }
      array \`items\` (array component)
        false: Pet { name?: string, tags?: unknown }
        $ref:  Pet { name?: string, tags?: unknown[] }
      array \`items\` (response body)
        false: Pet { name?: string }; getPet(path petId: string) -> unknown
        $ref:  Pet { name?: string }; getPet(path petId: string) -> unknown[]
      array \`items\` (query parameter)
        false: Pet { name?: string }; getPet(path petId: string, query filter: unknown) -> Pet
        $ref:  Pet { name?: string }; getPet(path petId: string, query filter: unknown[]) -> Pet
      a \`prefixItems\` entry
        false: Pet { name?: string, pair?: unknown }
        $ref:  Pet { name?: string, pair?: unknown }
      \`additionalProperties\`
        false: Pet { name?: string, extra?: map<unknown> }
        $ref:  Pet { name?: string, extra?: map<unknown> }
      \`additionalProperties\` beside \`properties\` (field)
        false: Pet { name?: string, owner?: PetOwner }; PetOwner { id?: string }
        $ref:  Pet { name?: string, owner?: PetOwner }; PetOwner { id?: string }
      \`additionalProperties\` (response body)
        false: Pet { name?: string }; getPet(path petId: string) -> map<unknown>
        $ref:  Pet { name?: string }; getPet(path petId: string) -> map<unknown>
      \`additionalProperties\` (map component)
        false: Pet { name?: string, extra?: Extra }; Extra {  }
        $ref:  Pet { name?: string, extra?: Extra }; Extra {  }
      a \`patternProperties\` value
        false: Pet { name?: string, extra?: map<unknown> }
        $ref:  Pet { name?: string, extra?: map<unknown> }
      a \`patternProperties\` value beside \`properties\` (component)
        false: Pet { name?: string }
        $ref:  Pet { name?: string }
      \`unevaluatedProperties\`
        false: Pet { name?: string, extra?: map<unknown> }
        $ref:  Pet { name?: string, extra?: map<unknown> }
      \`unevaluatedProperties\` beside \`properties\` (component)
        false: Pet { name?: string }
        $ref:  Pet { name?: string }
      \`unevaluatedItems\`
        false: Pet { name?: string, tags?: string[] }
        $ref:  Pet { name?: string, tags?: string[] }
      \`propertyNames\`
        false: Pet { name?: string, extra?: map<unknown> }
        $ref:  Pet { name?: string, extra?: map<unknown> }
      \`contains\`
        false: Pet { name?: string, tags?: string[] }
        $ref:  Pet { name?: string, tags?: string[] }
      \`not\`
        false: Pet { name?: string, value?: unknown }
        $ref:  Pet { name?: string, value?: unknown }
      a \`oneOf\` variant
        false: Pet { name?: string, value?: (string | unknown) }
        $ref:  Pet { name?: string, value?: (string | unknown) }
      a \`oneOf\` variant beside a \`null\` one
        false: Pet { name?: string, value?: nullable<unknown> }
        $ref:  Pet { name?: string, value?: nullable<unknown> }
      an \`anyOf\` variant
        false: Pet { name?: string, value?: (string | unknown) }
        $ref:  Pet { name?: string, value?: (string | unknown) }
      the only \`oneOf\` variant
        false: Pet { name?: string, value?: unknown }
        $ref:  Pet { name?: string, value?: (unknown) }
      an \`allOf\` member (field)
        false: Owner { ownerName?: string }; Pet { name?: string, owner?: Owner }
        $ref:  Owner { ownerName?: string }; Pet { name?: string, owner?: Owner }
      the only \`allOf\` member (field)
        false: Pet { name?: string, owner?: unknown }
        $ref:  Pet { name?: string, owner?: unknown }
      an \`allOf\` member (component)
        false: Owner { ownerName?: string }; Pet { ownerName?: string }
        $ref:  Owner { ownerName?: string }; Pet { ownerName?: string }
      a response body
        false: Pet { name?: string }; getPet(path petId: string) -> unknown
        $ref:  Pet { name?: string }; getPet(path petId: string) -> unknown
      a \`404\` response body
        false: Pet { name?: string }; getPet(path petId: string) -> Pet errors[404: none]
        $ref:  Pet { name?: string }; getPet(path petId: string) -> Pet errors[404: unknown]
      a \`default\` response body
        false: Pet { name?: string }; getPet(path petId: string) -> Pet default none
        $ref:  Pet { name?: string }; getPet(path petId: string) -> Pet default unknown
      a request body
        false: Pet { name?: string }; createPet() -> Pet
        $ref:  Pet { name?: string }; createPet() body unknown -> Pet
      a form request body
        false: Pet { name?: string }; createPet() -> Pet
        $ref:  Pet { name?: string }; createPet() body unknown -> Pet
      a query parameter
        false: Pet { name?: string }; getPet(path petId: string, query filter: string) -> Pet
        $ref:  Pet { name?: string }; getPet(path petId: string, query filter: unknown) -> Pet
      a header parameter
        false: Pet { name?: string }; getPet(path petId: string, header filter: string) -> Pet
        $ref:  Pet { name?: string }; getPet(path petId: string, header filter: unknown) -> Pet
      a path parameter
        false: Pet { name?: string }
        $ref:  Pet { name?: string }; getPet(path petId: unknown) -> Pet
      a response header
        false: Pet { name?: string }; getPet(path petId: string) -> Pet headers[X-Rate-Limit: string]
        $ref:  Pet { name?: string }; getPet(path petId: string) -> Pet headers[X-Rate-Limit: unknown]
      a webhook payload
        false: Pet { name?: string }; webhook pet.created body none
        $ref:  Pet { name?: string }; webhook pet.created body unknown
      a callback payload
        false: Pet { name?: string }; getPet(path petId: string) -> Pet callback onEvent body none
        $ref:  Pet { name?: string }; getPet(path petId: string) -> Pet callback onEvent body unknown
      the body of a list operation
        false: Pet { name?: string }; listPets(query after: string) -> unknown paged cursor of unknown
        $ref:  Pet { name?: string }; listPets(query after: string) -> unknown paged cursor of unknown
      the \`items\` of a list envelope's \`data\`
        false: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> string[] paged cursor of string
        $ref:  Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> unknown[] paged cursor of unknown"
    `);
  }, 60_000);
});

describe('#746 `additionalProperties` beside `properties` on a component', () => {
  const document = (additionalProperties: unknown, schemas: Doc = {}) => ({
    openapi: '3.1.0',
    info: { title: 'Repro', version: '1.0.0' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: string }],
          responses: { '200': { description: 'OK', ...json(ref('Pet')) } },
        },
      },
    },
    components: {
      schemas: { Pet: { type: 'object', properties: { name: string }, additionalProperties }, ...schemas },
    },
  });

  it('gives no catch-all field for a `$ref` to `false`, as `false` gives none', async () => {
    expect(render(await parse(document(false)))).toBe('Pet { name?: string }');
    // On main: `Pet { name?: string, additionalProperties?: map<unknown> }`.
    expect(render(await parse(document(never, { Never: false })))).toBe('Pet { name?: string }');
    expect(render(await parse(document(ref('NeverAlias'), { NeverAlias: never, Never: false })))).toBe(
      'Pet { name?: string }',
    );
    await expectNoDiff(document(false), document(never, { Never: false }));
  });

  it('keeps the catch-all field a schema gives, a `$ref` to `true` among them', async () => {
    expect(render(await parse(document({ type: 'integer' })))).toBe(
      'Pet { name?: string, additionalProperties?: map<integer> }',
    );
    expect(render(await parse(document(ref('Count'), { Count: { type: 'integer' } })))).toBe(
      'Pet { name?: string, additionalProperties?: map<integer> }',
    );
    // As on main: the `$ref` is an object with a key, where `true` and `{}` written inline have none.
    expect(render(await parse(document(ref('Anything'), { Anything: true })))).toBe(
      'Pet { name?: string, additionalProperties?: map<unknown> }',
    );
    expect(render(await parse(document(true)))).toBe('Pet { name?: string }');
    expect(render(await parse(document({})))).toBe('Pet { name?: string }');
  });
});

describe('#746 the one question a reader of `properties` asks', () => {
  const schemas = written({
    Never: false,
    NeverAlias: never,
    Zero: 0,
    Empty: '',
    Nothing: null,
    Anything: true,
    AnyAlias: ref('Anything'),
    Open: {},
    Text: string,
    Number: 1.5,
    Word: 'x',
    List: [],
    Wrapped: { allOf: [never] },
    Self: ref('Self'),
    Ping: ref('Pong'),
    Pong: ref('Ping'),
    Holder: {
      type: 'object',
      properties: {
        gone: false,
        nothing: null,
        any: true,
        text: string,
        byRef: never,
        again: { $ref: '#/components/schemas/Holder/properties/again' },
        viaPointer: { $ref: '#/components/schemas/Holder/properties/gone' },
      },
      items: false,
      allOf: [false, { properties: { gone: false } }],
    },
  }) as unknown as Record<string, SchemaObject>;
  const at = (pointer: string) => ({ $ref: `#/components/schemas/${pointer}` });

  it('answers what is written: nothing a reader reads declares no property, everything else declares one', () => {
    for (const value of [false, null, 0, '', undefined]) expect(isDeclaredProperty(value, schemas)).toBe(false);
    for (const value of [true, {}, string, 1.5, 'x', [], [string], { allOf: [false] }]) {
      expect(isDeclaredProperty(value, schemas), JSON.stringify(value)).toBe(true);
    }
  });

  it('follows a `$ref` to what the document wrote, through any chain', () => {
    for (const name of ['Never', 'NeverAlias', 'Zero', 'Empty', 'Nothing']) {
      expect(isDeclaredProperty(ref(name), schemas), name).toBe(false);
    }
    for (const name of ['Anything', 'AnyAlias', 'Open', 'Text', 'Number', 'Word', 'List', 'Wrapped', 'Holder']) {
      expect(isDeclaredProperty(ref(name), schemas), name).toBe(true);
    }
    // Whatever is written beside the `$ref`.
    expect(isDeclaredProperty({ ...never, description: 'Gone.', type: 'string' }, schemas)).toBe(false);
    // A chain as long as the document writes it.
    const chain: Record<string, SchemaObject> = { N0: written(false) };
    for (let hop = 1; hop <= 500; hop++) chain[`N${hop}`] = ref(`N${hop - 1}`);
    expect(isDeclaredProperty(ref('N500'), chain)).toBe(false);
    chain['N0'] = written(true);
    expect(isDeclaredProperty(ref('N500'), chain)).toBe(true);
  });

  it('follows a JSON Pointer to the value it lands on', () => {
    expect(isDeclaredProperty(at('Holder/properties/gone'), schemas)).toBe(false);
    expect(isDeclaredProperty(at('Holder/properties/nothing'), schemas)).toBe(false);
    expect(isDeclaredProperty(at('Holder/properties/byRef'), schemas)).toBe(false);
    expect(isDeclaredProperty(at('Holder/properties/viaPointer'), schemas)).toBe(false);
    expect(isDeclaredProperty(at('Holder/items'), schemas)).toBe(false);
    expect(isDeclaredProperty(at('Holder/allOf/0'), schemas)).toBe(false);
    expect(isDeclaredProperty(at('Holder/allOf/1/properties/gone'), schemas)).toBe(false);
    expect(isDeclaredProperty(at('Holder/properties/any'), schemas)).toBe(true);
    expect(isDeclaredProperty(at('Holder/properties/text'), schemas)).toBe(true);
  });

  it('leaves a `$ref` that names nothing, or leads back to itself, the declaration it was', () => {
    const declared: unknown[] = [
      ref('Missing'),
      ref('Self'),
      ref('Ping'),
      ref('Pong'),
      at('Holder/properties/again'),
      at('Holder/properties/absent'),
      at('Holder/properties'),
      at('Holder/allOf/7'),
      at('Holder/type'),
      at('Never/properties/x'),
      at('Nothing/properties/x'),
      at('Text/properties/x/properties/y'),
      { $ref: '#/components/responses/Never' },
      { $ref: '#/components/schemas/' },
      { $ref: 'https://example.com/schemas.json#/Never' },
      { $ref: 5 },
      { $ref: null },
      { $ref: false },
    ];
    for (const value of declared) expect(isDeclaredProperty(value, schemas), JSON.stringify(value)).toBe(true);
  });

  it('resolves a `$ref` in the map it is handed, and declares the property where it has none', () => {
    expect(isDeclaredProperty(never, { Never: written(false) })).toBe(false);
    expect(isDeclaredProperty(never, { Never: written(true) })).toBe(true);
    expect(isDeclaredProperty(never, {})).toBe(true);
    // Outside a parse there is no document to resolve it in.
    expect(isDeclaredProperty(never)).toBe(true);
    expect(isDeclaredProperty(false)).toBe(false);
  });

  it('reads what a `$ref` points at as written, where `schemaRefTarget` reads a schema', () => {
    expect(schemaRefValue('#/components/schemas/Never', schemas)).toBe(false);
    expect(schemaRefValue('#/components/schemas/Nothing', schemas)).toBe(null);
    expect(schemaRefValue('#/components/schemas/Text', schemas)).toBe(schemas['Text']);
    expect(schemaRefValue('#/components/schemas/Holder/properties/gone', schemas)).toBe(false);
    expect(schemaRefValue('#/components/schemas/Holder/properties/any', schemas)).toBe(true);
    expect(schemaRefValue('#/components/schemas/Holder/properties/nothing', schemas)).toBe(null);
    expect(schemaRefValue('#/components/schemas/Holder/properties/text', schemas)).toBe(string);
    expect(schemaRefValue('#/components/schemas/Holder/allOf/1/properties/gone', schemas)).toBe(false);
    for (const nowhere of [
      '#/components/schemas/Missing',
      '#/components/schemas/Holder/properties/absent',
      '#/components/schemas/Holder/properties',
      '#/components/schemas/Holder/properties/gone/properties/x',
      '#/components/schemas/Holder/allOf/7',
      '#/components/schemas/Never/properties/x',
      '#/components/schemas/Nothing/properties/x',
      '#/components/responses/Never',
      '#/components/schemas/',
    ]) {
      expect(schemaRefValue(nowhere, schemas), nowhere).toBeUndefined();
    }
    expect(schemaRefValue(5, schemas)).toBeUndefined();
    expect(schemaRefValue('#/components/schemas/Never', undefined)).toBeUndefined();
    // `schemaRefTarget` and `schemaAtPointer` answer as they did: a schema, or none for a pointer to a boolean.
    expect(schemaRefTarget('#/components/schemas/Never', schemas)).toBe(false);
    expect(schemaRefTarget('#/components/schemas/Holder/properties/gone', schemas)).toBeUndefined();
    expect(schemaRefTarget('#/components/schemas/Holder/properties/any', schemas)).toBeUndefined();
    expect(schemaRefTarget('#/components/schemas/Holder/properties/text', schemas)).toBe(string);
    const holder = schemas['Holder']!;
    expect(schemaAtPointer(holder, [])).toBe(holder);
    expect(schemaAtPointer(written(false), [])).toBe(false);
    expect(schemaAtPointer(holder, ['properties', 'gone'])).toBeUndefined();
    expect(schemaAtPointer(holder, ['properties', 'text'])).toBe(string);
    expect(schemaAtPointer(holder, ['properties', 'text', 'properties', 'x'])).toBeUndefined();
  });

  it('is asked by every reader that is handed the map: each declares what the inline `false` declares', () => {
    const map = {
      Never: written(false),
      NeverAlias: never,
      Base: written({ type: 'object', properties: { id: string } }),
    };
    const object = (legacyId: unknown): SchemaObject =>
      written({ type: 'object', properties: { name: string, legacyId }, required: ['legacyId'] });
    for (const legacyId of [never, ref('NeverAlias'), { ...never, description: 'Gone.' }]) {
      const [byRef, inline] = [object(legacyId), object(false)];
      expect([...componentPropertyLedger('Pet', byRef, map).keys()]).toEqual(['name']);
      expect([...collectProperties(byRef, map).keys()]).toEqual(['name']);
      expect(buildInlineModel('Pet', byRef, map).fields.map((f) => f.name)).toEqual(['name']);
      expect(Object.keys(collectObjectProperties(byRef, map).properties)).toEqual(['name']);
      const merged = (schema: SchemaObject) =>
        mergeAllOfMembers({ allOf: [ref('Base'), schema] }, map).properties.map((p) => p.name);
      expect(merged(byRef)).toEqual(merged(inline));
      expect(merged(byRef)).toEqual(['id', 'name']);
      // A union's variant, flattened: the variant declares what it declares with `false`.
      const flattened = (schema: SchemaObject) =>
        mergeAllOfMembers(
          { allOf: [ref('Base'), { oneOf: [schema, { type: 'object', properties: { other: string } }] }] },
          map,
        ).properties.map((p) => p.name);
      expect(flattened(byRef)).toEqual(flattened(inline));
      // A pointer through the property lands on no schema, as one through `false` does.
      const holder = { ...map, Holder: byRef };
      expect(pointerSteps(byRef, ['properties', 'legacyId'], holder)).toEqual({ problem: 'no schema at that pointer' });
      expect(pointerSteps(inline, ['properties', 'legacyId'], holder)).toEqual({
        problem: 'no schema at that pointer',
      });
      expect(pointerSteps(byRef, ['properties', 'name'], holder)).toHaveLength(1);
    }
    // A `$ref` to `true` declares the property for each of them.
    const toTrue = object(ref('Anything'));
    const anything = { ...map, Anything: written(true) };
    expect([...componentPropertyLedger('Pet', toTrue, anything).keys()]).toEqual(['name', 'legacyId']);
    expect([...collectProperties(toTrue, anything).keys()]).toEqual(['name', 'legacyId']);
    expect(buildInlineModel('Pet', toTrue, anything).fields.map((f) => f.name)).toEqual(['name', 'legacyId']);
  });
});
