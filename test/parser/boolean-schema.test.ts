import { describe, it, expect, afterAll, beforeAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import {
  derivedCopy,
  foldSiblingProperties,
  isSchemaObject,
  sourceDeclaration,
  unwrapNullableSchema,
  type SchemaObject,
} from '../../src/parser/schemas.js';
import { combineDeclarations } from '../../src/parser/inline-models.js';
import { collectObjectProperties } from '../../src/parser/pagination.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #728: since #597 `foldSiblingProperties` remembers what each schema
 * folds to in a `WeakMap` keyed by the schema, and every reader that strips
 * a nullable wrapper goes through it (`unwrapNullableSchema`). OAS 3.1
 * allows a JSON Schema boolean wherever a schema goes, and `true` cannot
 * key a `WeakMap`, so a property, an array's items, a union variant, a
 * body, a parameter or a component written as `true` failed the whole
 * parse with `Invalid value used as weak map key`. Every memo keyed by a
 * schema now answers a value that is no Schema Object before anything is
 * remembered for it (`isSchemaObject`), so `true` is typed where it stands
 * as `{}` is, `unknown`, and `false` is read as it was.
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

async function writeDoc(doc: unknown, name = 'spec.json'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-728-'));
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
// The positions a schema is written at

/** Stands for "not written": `strip` removes the key or the list entry that holds it. */
const ABSENT = '__not written__';
const strip = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.filter((entry) => entry !== ABSENT).map(strip)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, entry]) => entry !== ABSENT)
            .map(([key, entry]) => [key, strip(entry)]),
        )
      : value;

type Build = (value: unknown) => unknown;

/**
 * Every position a schema can be written at, each a document builder that
 * writes `value` there: `Pet { name }` and `GET /pets/{petId}` (`getPet`)
 * returning `$ref: Pet`, as the issue's documents are, with what the
 * position needs beside them.
 */
function positions(openapi: Version): Array<[string, Build]> {
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
  const object = (properties: Record<string, unknown>) => ({ type: 'object', properties });
  const owner = object({ ownerName: string });
  const tag = object({ tagName: string });
  // Two components that admit `null`, in the version's own spelling.
  const nullable = (properties: Record<string, unknown>) => ({
    ...(openapi === '3.0.3' ? { type: 'object', nullable: true } : { type: ['object', 'null'] }),
    properties,
  });
  const nullVariant = openapi === '3.0.3' ? { enum: [null] } : { type: 'null' };
  const cat = { ...object({ kind: { type: 'string', enum: ['cat'] }, meow: string }), required: ['kind'] };
  const post = (requestBody: unknown) => ({
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody,
          responses: { '200': { description: 'OK', ...json(ref('Pet')) } },
        },
      },
    },
  });
  const parameter = (where: string, schema: unknown) => ({
    parameters: [
      { name: 'petId', in: 'path', required: true, schema: string },
      { name: 'filter', in: where, schema },
    ],
  });
  const webhook = (schema: unknown) => ({
    webhooks: {
      'pet.created': {
        post: { operationId: 'petCreated', requestBody: json(schema), responses: { '200': { description: 'OK' } } },
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

  return [
    // A property.
    ['a property', (v) => document({ Pet: pet({ metadata: v }) })],
    ['a required property', (v) => document({ Pet: pet({ metadata: v }, { required: ['metadata'] }) })],
    ['a property of an inline object', (v) => document({ Pet: pet({ owner: object({ any: v }) }) })],
    ['a property of an inline response body', (v) => document({ Pet: pet() }, json(object({ any: v, id: string })))],
    [
      'a property beside an `allOf` (component)',
      (v) => document({ Owner: owner, Pet: { allOf: [ref('Owner')], properties: { metadata: v } } }),
    ],
    [
      'a property of an `allOf` member (field)',
      (v) => document({ Owner: owner, Pet: pet({ owner: { allOf: [ref('Owner'), object({ metadata: v })] } }) }),
    ],
    [
      'a property of an `allOf` member (response body)',
      (v) => document({ Owner: owner, Pet: pet() }, json({ allOf: [ref('Owner'), object({ metadata: v })] })),
    ],
    [
      'a property two `allOf` members declare, the first',
      (v) => document({ Pet: pet({ owner: { allOf: [meta(v), meta(string)] } }) }),
    ],
    [
      'a property two `allOf` members declare, the second',
      (v) => document({ Pet: pet({ owner: { allOf: [meta(string), meta(v)] } }) }),
    ],
    [
      'a property two `allOf` members declare, both',
      (v) => document({ Pet: pet({ owner: { allOf: [meta(v), meta(v)] } }) }),
    ],
    [
      "a property a `$ref` member's component declares too",
      (v) => document({ Base: meta(string), Pet: { allOf: [ref('Base'), meta(v)] } }),
    ],
    [
      'a property of a union variant',
      (v) => document({ Pet: pet({ value: { oneOf: [object({ any: v }), string] } }) }),
    ],
    // An array's items.
    ['array `items`', (v) => document({ Pet: pet({ tags: { type: 'array', items: v } }) })],
    ['array `items` with no `type`', (v) => document({ Pet: pet({ tags: { items: v } }) })],
    [
      'the `items` of the `items`',
      (v) => document({ Pet: pet({ tags: { type: 'array', items: { type: 'array', items: v } } }) }),
    ],
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
    // Map values.
    ['`additionalProperties`', (v) => document({ Pet: pet({ extra: { type: 'object', additionalProperties: v } }) })],
    [
      '`additionalProperties` beside `properties` (component)',
      (v) => document({ Pet: pet({}, { additionalProperties: v }) }),
    ],
    [
      '`additionalProperties` (response body)',
      (v) => document({ Pet: pet() }, json({ type: 'object', additionalProperties: v })),
    ],
    [
      'a `patternProperties` value',
      (v) => document({ Pet: pet({ extra: { type: 'object', patternProperties: { '^x-': v } } }) }),
    ],
    // A `oneOf`/`anyOf` variant.
    ...(['oneOf', 'anyOf'] as const).flatMap((keyword): Array<[string, Build]> => [
      [`a \`${keyword}\` variant, first`, (v) => document({ Pet: pet({ value: { [keyword]: [v, string] } }) })],
      [`a \`${keyword}\` variant, last`, (v) => document({ Pet: pet({ value: { [keyword]: [string, v] } }) })],
      [`the only \`${keyword}\` variant`, (v) => document({ Pet: pet({ value: { [keyword]: [v] } }) })],
      [
        `a \`${keyword}\` variant beside a \`null\` one`,
        (v) => document({ Pet: pet({ value: { [keyword]: [v, nullVariant] } }) }),
      ],
      [
        `a \`${keyword}\` variant beside a \`$ref\``,
        (v) => document({ Owner: owner, Pet: pet({ value: { [keyword]: [ref('Owner'), v] } }) }),
      ],
      [
        `a \`${keyword}\` variant (named union component)`,
        (v) => document({ Owner: owner, Pet: pet({ value: ref('Value') }), Value: { [keyword]: [ref('Owner'), v] } }),
      ],
      [
        `the only \`${keyword}\` variant (component)`,
        (v) => document({ Pet: pet({ value: ref('Value') }), Value: { [keyword]: [v] } }),
      ],
      [
        `a \`${keyword}\` variant beside a \`null\` one (component)`,
        (v) => document({ Pet: pet({ value: ref('Value') }), Value: { [keyword]: [v, nullVariant] } }),
      ],
      [
        `a \`${keyword}\` variant (response body)`,
        (v) => document({ Pet: pet() }, json({ [keyword]: [ref('Pet'), v] })),
      ],
      [
        `a \`${keyword}\` variant (request body)`,
        (v) => document({ Pet: pet() }, undefined, {}, post(json({ [keyword]: [ref('Pet'), v] }))),
      ],
      [
        `a \`${keyword}\` variant beside an \`allOf\` (component)`,
        (v) => document({ Owner: owner, Tag: tag, Pet: { allOf: [ref('Owner')], [keyword]: [ref('Tag'), v] } }),
      ],
      [
        `a discriminated \`${keyword}\` variant (field)`,
        (v) =>
          document({
            Cat: cat,
            Pet: pet({ value: { [keyword]: [ref('Cat'), v], discriminator: { propertyName: 'kind' } } }),
          }),
      ],
      [
        `a discriminated \`${keyword}\` variant (component, with a \`mapping\`)`,
        (v) =>
          document({
            Cat: cat,
            Pet: pet({ value: ref('Animal') }),
            Animal: {
              [keyword]: [ref('Cat'), v],
              discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat' } },
            },
          }),
      ],
    ]),
    // An `allOf` member (parses since #722).
    ['an `allOf` member (field)', (v) => document({ Owner: owner, Pet: pet({ owner: { allOf: [ref('Owner'), v] } }) })],
    ['the only `allOf` member (field)', (v) => document({ Pet: pet({ owner: { allOf: [v] } }) })],
    ['an `allOf` member, first (component)', (v) => document({ Owner: owner, Pet: { allOf: [v, ref('Owner')] } })],
    [
      'an `allOf` member beside two nullable `$ref`s (component)',
      (v) =>
        document({
          Owner: nullable({ ownerName: string }),
          Tag: nullable({ tagName: string }),
          Pet: pet({ owner: ref('PetOwner') }),
          PetOwner: { allOf: [ref('Owner'), ref('Tag'), v] },
        }),
    ],
    ['an `allOf` member (response body)', (v) => document({ Pet: pet() }, json({ allOf: [ref('Pet'), v] }))],
    // `not` (never failed).
    ['`not`', (v) => document({ Pet: pet({ value: { not: v } }) })],
    ['`not` beside a `type`', (v) => document({ Pet: pet({ value: { type: 'string', not: v } }) })],
    // A component.
    ['a component nothing references', (v) => document({ Pet: pet(), Anything: v })],
    [
      'a component nothing references, beside a named union and an array component',
      (v) =>
        document({
          Anything: v,
          Owner: owner,
          Pet: pet({ value: ref('Value'), tags: ref('Tags') }),
          Value: { oneOf: [ref('Owner'), string] },
          Tags: { type: 'array', items: object({ label: string }) },
        }),
    ],
    ['a component a field names', (v) => document({ Pet: pet({ any: ref('Anything') }), Anything: v })],
    [
      'a component a required field names',
      (v) => document({ Pet: pet({ any: ref('Anything') }, { required: ['any'] }), Anything: v }),
    ],
    ['a component a response body names', (v) => document({ Pet: pet(), Anything: v }, json(ref('Anything')))],
    [
      'a component a request body names',
      (v) => document({ Pet: pet(), Anything: v }, undefined, {}, post(json(ref('Anything')))),
    ],
    [
      'a component a query parameter names',
      (v) => document({ Pet: pet(), Anything: v }, undefined, parameter('query', ref('Anything'))),
    ],
    [
      'a component array `items` name',
      (v) => document({ Pet: pet({ tags: { type: 'array', items: ref('Anything') } }), Anything: v }),
    ],
    [
      'a component `additionalProperties` name',
      (v) => document({ Pet: pet({ extra: { type: 'object', additionalProperties: ref('Anything') } }), Anything: v }),
    ],
    [
      'a component an `allOf` member names (field)',
      (v) => document({ Owner: owner, Pet: pet({ owner: { allOf: [ref('Owner'), ref('Anything')] } }), Anything: v }),
    ],
    [
      'a component an `allOf` member names (component)',
      (v) => document({ Owner: owner, Pet: { allOf: [ref('Owner'), ref('Anything')] }, Anything: v }),
    ],
    [
      'a component the only `allOf` member names',
      (v) => document({ Pet: pet({ owner: { allOf: [ref('Anything')] } }), Anything: v }),
    ],
    [
      'a component an `allOf` member names beside two nullable `$ref`s (field)',
      (v) =>
        document({
          Owner: nullable({ ownerName: string }),
          Tag: nullable({ tagName: string }),
          Pet: pet({ owner: { allOf: [ref('Owner'), ref('Tag'), ref('Anything')] } }),
          Anything: v,
        }),
    ],
    [
      'a component an `allOf` member names beside two nullable `$ref`s (component)',
      (v) =>
        document({
          Owner: nullable({ ownerName: string }),
          Tag: nullable({ tagName: string }),
          Pet: pet({ owner: ref('PetOwner') }),
          PetOwner: { allOf: [ref('Owner'), ref('Tag'), ref('Anything')] },
          Anything: v,
        }),
    ],
    [
      'a component a `oneOf` variant names (field)',
      (v) => document({ Pet: pet({ value: { oneOf: [string, ref('Anything')] } }), Anything: v }),
    ],
    [
      'a component a `oneOf` variant names (named union component)',
      (v) =>
        document({
          Owner: owner,
          Pet: pet({ value: ref('Value') }),
          Value: { oneOf: [ref('Owner'), ref('Anything')] },
          Anything: v,
        }),
    ],
    [
      'a component a discriminated variant names, with a `mapping`',
      (v) =>
        document({
          Cat: cat,
          Pet: pet({ value: ref('Animal') }),
          Animal: {
            oneOf: [ref('Cat'), ref('Anything')],
            discriminator: {
              propertyName: 'kind',
              mapping: { cat: '#/components/schemas/Cat', any: '#/components/schemas/Anything' },
            },
          },
          Anything: v,
        }),
    ],
    [
      'a component an alias names',
      (v) => document({ Pet: pet({ any: ref('Alias') }), Alias: ref('Anything'), Anything: v }),
    ],
    [
      'a component a nullable wrapper names',
      (v) => document({ Pet: pet({ any: { oneOf: [ref('Anything'), nullVariant] } }), Anything: v }),
    ],
    [
      'a component a webhook payload names',
      (v) => document({ Pet: pet(), Anything: v }, undefined, {}, webhook(ref('Anything'))),
    ],
    // The operation's own schemas.
    ['a response body', (v) => document({ Pet: pet() }, json(v))],
    [
      'a `404` response body',
      (v) =>
        document({ Pet: pet() }, undefined, {
          responses: {
            '200': { description: 'OK', ...json(ref('Pet')) },
            '404': { description: 'Missing', ...json(v) },
          },
        }),
    ],
    [
      'a `default` response body',
      (v) =>
        document({ Pet: pet() }, undefined, {
          responses: {
            '200': { description: 'OK', ...json(ref('Pet')) },
            default: { description: 'Error', ...json(v) },
          },
        }),
    ],
    [
      'a `4XX` response body',
      (v) =>
        document({ Pet: pet() }, undefined, {
          responses: { '200': { description: 'OK', ...json(ref('Pet')) }, '4XX': { description: 'Error', ...json(v) } },
        }),
    ],
    [
      'a response body under `components/responses`',
      (v) =>
        document(
          { Pet: pet() },
          {},
          { responses: { '200': { $ref: '#/components/responses/Any' } } },
          {},
          { responses: { Any: { description: 'OK', ...json(v) } } },
        ),
    ],
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
    [
      'a request body under `components/requestBodies`',
      (v) =>
        document({ Pet: pet() }, undefined, {}, post({ $ref: '#/components/requestBodies/Any' }), {
          requestBodies: { Any: json(v) },
        }),
    ],
    ['a query parameter', (v) => document({ Pet: pet() }, undefined, parameter('query', v))],
    ['a header parameter', (v) => document({ Pet: pet() }, undefined, parameter('header', v))],
    ['a cookie parameter', (v) => document({ Pet: pet() }, undefined, parameter('cookie', v))],
    [
      'a path parameter',
      (v) =>
        document({ Pet: pet() }, undefined, { parameters: [{ name: 'petId', in: 'path', required: true, schema: v }] }),
    ],
    [
      "a parameter's `content` schema",
      (v) =>
        document({ Pet: pet() }, undefined, {
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: string },
            { name: 'filter', in: 'query', content: { 'application/json': { schema: v } } },
          ],
        }),
    ],
    [
      'a parameter under `components/parameters`',
      (v) =>
        document(
          { Pet: pet() },
          undefined,
          {
            parameters: [
              { name: 'petId', in: 'path', required: true, schema: string },
              { $ref: '#/components/parameters/Filter' },
            ],
          },
          {},
          { parameters: { Filter: { name: 'filter', in: 'query', schema: v } } },
        ),
    ],
    [
      'a response header',
      (v) => document({ Pet: pet() }, { ...json(ref('Pet')), headers: { 'X-Rate-Limit': { schema: v } } }),
    ],
    ['a webhook payload', (v) => document({ Pet: pet() }, undefined, {}, webhook(v))],
    [
      'a property of a webhook payload',
      (v) => document({ Pet: pet() }, undefined, {}, webhook(object({ data: v, id: string }))),
    ],
    [
      'a callback payload',
      (v) =>
        document({ Pet: pet() }, undefined, {
          callbacks: {
            onEvent: {
              '{$request.body#/url}': {
                post: { requestBody: json(v), responses: { '200': { description: 'OK' } } },
              },
            },
          },
        }),
    ],
    // A paginated list, which the pagination walk reads too.
    ['the body of a list operation', (v) => document({ Pet: pet() }, json(v), list)],
    [
      "the `items` of a list envelope's `data`",
      (v) => document({ Pet: pet() }, json(envelope({ type: 'array', items: v })), list),
    ],
    ['a property of a list envelope', (v) => document({ Pet: pet() }, json(envelope(pets, { extra: v })), list)],
    [
      "a list envelope's `list_metadata`",
      (v) => document({ Pet: pet() }, json(object({ data: pets, list_metadata: v })), list),
    ],
    [
      'an `allOf` member of a list envelope',
      (v) => document({ Pet: pet() }, json({ allOf: [envelope(pets), v] }), list),
    ],
    [
      'a variant beside the `allOf` of a list envelope',
      (v) =>
        document(
          { Pet: pet() },
          json({ allOf: [envelope(pets)], oneOf: [object({ has_more: { type: 'boolean' } }), v] }),
          list,
        ),
    ],
  ];
}

/** How `value` is read at a position: as `{}` is there, as a schema not written is, as both, or as neither. */
type ReadAs = 'as `{}`' | 'as not written' | 'as `{}` and as not written' | 'as neither';

interface Row {
  position: string;
  /** `{}` at the position. */
  empty: Reading;
  /** The schema not written at the position; `undefined` where the document then fails to bundle (a `$ref` to no component). */
  absent: Reading | undefined;
  of: (value: unknown) => Promise<Reading>;
}

async function rows(openapi: Version): Promise<Row[]> {
  const out: Row[] = [];
  for (const [position, build] of positions(openapi)) {
    const of = (value: unknown): Promise<Reading> => read(strip(build(value)));
    out.push({ position, empty: await of({}), absent: await of(ABSENT).catch(() => undefined), of });
  }
  return out;
}

function readAs(reading: Reading, row: Row): ReadAs {
  const same = (other: Reading | undefined): boolean =>
    other !== undefined &&
    JSON.stringify(other.spec) === JSON.stringify(reading.spec) &&
    JSON.stringify(other.warnings) === JSON.stringify(reading.warnings);
  const [empty, absent] = [same(row.empty), same(row.absent)];
  return empty && absent ? 'as `{}` and as not written' : empty ? 'as `{}`' : absent ? 'as not written' : 'as neither';
}

// ---------------------------------------------------------------------------

describe("#728 the issue's documents", () => {
  const pet = (extra: Record<string, unknown>) => ({ type: 'object', properties: { name: string, ...extra } });
  const document = (schemas: Record<string, unknown>, schema: unknown = ref('Pet'), more: object = {}) => ({
    openapi: '3.1.0',
    info: { title: 'Repro', version: '1.0.0' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: string }],
          responses: { '200': { description: 'OK', ...json(schema) } },
          ...more,
        },
      },
    },
    components: { schemas },
  });
  /** The five documents, each with `value` where the issue writes `true`. */
  const files = (value: unknown): Record<string, unknown> => ({
    'property.json': document({ Pet: pet({ metadata: value }) }),
    'items.json': document({ Pet: pet({ tags: { type: 'array', items: value } }) }),
    'variant.json': document({ Pet: pet({ value: { oneOf: [string, value] } }) }),
    'component.json': document({ Pet: pet({}), Anything: value }),
    'response.json': document({ Pet: pet({}) }, value),
  });

  it("prints the issue's script output as it was before #597", async () => {
    const lines: string[] = [];
    for (const [file, doc] of Object.entries(files(true))) {
      try {
        const { models } = await parse(doc);
        const printed = models.map(({ fields, name }) => `${name} { ${fields.map((field) => field.name).join(', ')} }`);
        lines.push(`${file} [ ${printed.map((model) => `'${model}'`).join(', ')} ]`);
      } catch (error) {
        lines.push(`${file} ${String(error)}`);
      }
    }
    // On main (246587a7) every line was `TypeError: Invalid value used as weak map key`.
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "property.json [ 'Pet { name, metadata }' ]
      items.json [ 'Pet { name, tags }' ]
      variant.json [ 'Pet { name, value }' ]
      component.json [ 'Pet { name }' ]
      response.json [ 'Pet { name }' ]"
    `);
  });

  it('types `true` where it stands as `unknown`, as `{}` is', async () => {
    const lines: string[] = [];
    for (const [file, doc] of Object.entries(files(true))) lines.push(`${file}: ${render(await parse(doc))}`);
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "property.json: Pet { name?: string, metadata?: unknown }
      items.json: Pet { name?: string, tags?: unknown[] }
      variant.json: Pet { name?: string, value?: (string | unknown) }
      component.json: Pet { name?: string }
      response.json: Pet { name?: string }; getPet(path petId: string) -> unknown"
    `);
    const empty = files({});
    for (const [file, doc] of Object.entries(files(true))) await expectNoDiff(doc, empty[file], file);
  });

  it("parses a query parameter's and a request body's `schema: true`, which failed the same way", async () => {
    const parameter = (schema: unknown) =>
      document({ Pet: pet({}) }, ref('Pet'), {
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: string },
          { name: 'filter', in: 'query', schema },
        ],
      });
    const body = (schema: unknown) => document({ Pet: pet({}) }, ref('Pet'), { requestBody: json(schema) });
    expect(render(await parse(parameter(true)))).toMatchInlineSnapshot(
      `"Pet { name?: string }; getPet(path petId: string, query filter: unknown) -> Pet"`,
    );
    expect(render(await parse(body(true)))).toMatchInlineSnapshot(
      `"Pet { name?: string }; getPet(path petId: string) body unknown -> Pet"`,
    );
    await expectNoDiff(parameter(true), parameter({}));
    await expectNoDiff(body(true), body({}));
  });

  it('keeps what parsed: `false` as a property declares no field, and `additionalProperties: true` and `not: true` parse', async () => {
    expect(render(await parse(document({ Pet: pet({ metadata: false }) })))).toBe('Pet { name?: string }');
    await expectNoDiff(document({ Pet: pet({ metadata: false }) }), document({ Pet: pet({}) }));
    expect(render(await parse(document({ Pet: pet({ extra: { type: 'object', additionalProperties: true } }) })))).toBe(
      'Pet { name?: string, extra?: map<unknown> }',
    );
    expect(render(await parse(document({ Pet: pet({ value: { not: true } }) })))).toBe(
      'Pet { name?: string, value?: unknown }',
    );
  });
});

describe.each(VERSIONS)('#728 a boolean where a schema goes, OpenAPI %s', (openapi) => {
  let table: Row[];
  beforeAll(async () => {
    // `beforeAll` runs before the `beforeEach` that silences the warnings.
    const silenced = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn = silenced;
    try {
      table = await rows(openapi);
    } finally {
      silenced.mockRestore();
    }
  }, 60_000);

  it('reads `true` as `{}` at every position, to the same IR and the same warnings', async () => {
    for (const row of table) {
      const reading = await row.of(true);
      expect(reading.spec, row.position).toEqual(row.empty.spec);
      expect(reading.warnings, row.position).toEqual(row.empty.warnings);
    }
  });

  it('types every position with `true` there as with `{}`, and with `false` as before #597', async () => {
    // `false` is read as not written where a reader first asks whether a schema is written at all (a property,
    // `items`, a media type's or a parameter's `schema`), and as `{}` where it is asked for a type (a variant, a
    // member, a component and every `$ref` to it).
    const lines: string[] = [];
    for (const row of table) {
      const [yes, no] = [await row.of(true), await row.of(false)];
      expect(readAs(yes, row), row.position).toMatch(/^as `\{\}`/);
      lines.push(`${row.position}\n  true:  ${render(yes.spec)}\n  false: ${render(no.spec)} (${readAs(no, row)})`);
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "a property
        true:  Pet { name?: string, metadata?: unknown }
        false: Pet { name?: string } (as not written)
      a required property
        true:  Pet { name?: string, metadata: unknown }
        false: Pet { name?: string } (as not written)
      a property of an inline object
        true:  Pet { name?: string, owner?: PetOwner }; PetOwner { any?: unknown }
        false: Pet { name?: string, owner?: PetOwner }; PetOwner {  } (as not written)
      a property of an inline response body
        true:  Pet { name?: string }; GetPetResponse { any?: unknown, id?: string }; getPet(path petId: string) -> GetPetResponse
        false: Pet { name?: string }; GetPetResponse { id?: string }; getPet(path petId: string) -> GetPetResponse (as not written)
      a property beside an \`allOf\` (component)
        true:  Owner { ownerName?: string }; Pet { metadata?: unknown, ownerName?: string }
        false: Owner { ownerName?: string }; Pet { ownerName?: string } (as not written)
      a property of an \`allOf\` member (field)
        true:  Owner { ownerName?: string }; Pet { name?: string, owner?: PetOwner }; PetOwner { ownerName?: string, metadata?: unknown }
        false: Owner { ownerName?: string }; Pet { name?: string, owner?: PetOwner }; PetOwner { ownerName?: string } (as not written)
      a property of an \`allOf\` member (response body)
        true:  Owner { ownerName?: string }; Pet { name?: string }; GetPetResponse { ownerName?: string, metadata?: unknown }; getPet(path petId: string) -> GetPetResponse
        false: Owner { ownerName?: string }; Pet { name?: string }; GetPetResponse { ownerName?: string }; getPet(path petId: string) -> GetPetResponse (as not written)
      a property two \`allOf\` members declare, the first
        true:  Pet { name?: string, owner?: PetOwner }; PetOwner { meta?: string }
        false: Pet { name?: string, owner?: PetOwner }; PetOwner { meta?: string } (as \`{}\` and as not written)
      a property two \`allOf\` members declare, the second
        true:  Pet { name?: string, owner?: PetOwner }; PetOwner { meta?: string }
        false: Pet { name?: string, owner?: PetOwner }; PetOwner { meta?: string } (as \`{}\` and as not written)
      a property two \`allOf\` members declare, both
        true:  Pet { name?: string, owner?: PetOwner }; PetOwner { meta?: unknown }
        false: Pet { name?: string, owner?: PetOwner }; PetOwner {  } (as not written)
      a property a \`$ref\` member's component declares too
        true:  Base { meta?: string }; Pet { meta?: string }
        false: Base { meta?: string }; Pet { meta?: string } (as \`{}\` and as not written)
      a property of a union variant
        true:  Pet { name?: string, value?: (PetValue | string) }; PetValue { any?: unknown }
        false: Pet { name?: string, value?: (PetValue | string) }; PetValue {  } (as not written)
      array \`items\`
        true:  Pet { name?: string, tags?: unknown[] }
        false: Pet { name?: string, tags?: unknown } (as not written)
      array \`items\` with no \`type\`
        true:  Pet { name?: string, tags?: unknown[] }
        false: Pet { name?: string, tags?: unknown } (as not written)
      the \`items\` of the \`items\`
        true:  Pet { name?: string, tags?: unknown[][] }
        false: Pet { name?: string, tags?: unknown[] } (as not written)
      array \`items\` (array component)
        true:  Pet { name?: string, tags?: unknown[] }
        false: Pet { name?: string, tags?: unknown } (as neither)
      array \`items\` (response body)
        true:  Pet { name?: string }; getPet(path petId: string) -> unknown[]
        false: Pet { name?: string }; getPet(path petId: string) -> unknown (as not written)
      array \`items\` (query parameter)
        true:  Pet { name?: string }; getPet(path petId: string, query filter: unknown[]) -> Pet
        false: Pet { name?: string }; getPet(path petId: string, query filter: unknown) -> Pet (as not written)
      a \`prefixItems\` entry
        true:  Pet { name?: string, pair?: unknown }
        false: Pet { name?: string, pair?: unknown } (as \`{}\` and as not written)
      \`additionalProperties\`
        true:  Pet { name?: string, extra?: map<unknown> }
        false: Pet { name?: string, extra?: map<unknown> } (as \`{}\` and as not written)
      \`additionalProperties\` beside \`properties\` (component)
        true:  Pet { name?: string }
        false: Pet { name?: string } (as \`{}\` and as not written)
      \`additionalProperties\` (response body)
        true:  Pet { name?: string }; getPet(path petId: string) -> map<unknown>
        false: Pet { name?: string }; getPet(path petId: string) -> map<unknown> (as \`{}\` and as not written)
      a \`patternProperties\` value
        true:  Pet { name?: string, extra?: map<unknown> }
        false: Pet { name?: string, extra?: map<unknown> } (as \`{}\` and as not written)
      a \`oneOf\` variant, first
        true:  Pet { name?: string, value?: (unknown | string) }
        false: Pet { name?: string, value?: (unknown | string) } (as \`{}\`)
      a \`oneOf\` variant, last
        true:  Pet { name?: string, value?: (string | unknown) }
        false: Pet { name?: string, value?: (string | unknown) } (as \`{}\`)
      the only \`oneOf\` variant
        true:  Pet { name?: string, value?: unknown }
        false: Pet { name?: string, value?: unknown } (as \`{}\` and as not written)
      a \`oneOf\` variant beside a \`null\` one
        true:  Pet { name?: string, value?: nullable<unknown> }
        false: Pet { name?: string, value?: nullable<unknown> } (as \`{}\`)
      a \`oneOf\` variant beside a \`$ref\`
        true:  Owner { ownerName?: string }; Pet { name?: string, value?: (Owner | unknown) }
        false: Owner { ownerName?: string }; Pet { name?: string, value?: (Owner | unknown) } (as \`{}\`)
      a \`oneOf\` variant (named union component)
        true:  Owner { ownerName?: string }; Pet { name?: string, value?: Value }; Value {  } = oneOf(Owner | unknown)
        false: Owner { ownerName?: string }; Pet { name?: string, value?: Value }; Value {  } = oneOf(Owner | unknown) (as \`{}\`)
      the only \`oneOf\` variant (component)
        true:  Pet { name?: string, value?: Value }; Value {  } = oneOf(unknown)
        false: Pet { name?: string, value?: Value }; Value {  } = oneOf(unknown) (as \`{}\`)
      a \`oneOf\` variant beside a \`null\` one (component)
        true:  Pet { name?: string, value?: nullable<unknown> }
        false: Pet { name?: string, value?: nullable<Value> }; Value {  } = oneOf(unknown) (as neither)
      a \`oneOf\` variant (response body)
        true:  Pet { name?: string }; getPet(path petId: string) -> (Pet | unknown)
        false: Pet { name?: string }; getPet(path petId: string) -> (Pet | unknown) (as \`{}\`)
      a \`oneOf\` variant (request body)
        true:  Pet { name?: string }; createPet() body (Pet | unknown) -> Pet
        false: Pet { name?: string }; createPet() body (Pet | unknown) -> Pet (as \`{}\`)
      a \`oneOf\` variant beside an \`allOf\` (component)
        true:  Owner { ownerName?: string }; Tag { tagName?: string }; Pet { ownerName?: string, tagName?: string }
        false: Owner { ownerName?: string }; Tag { tagName?: string }; Pet { ownerName?: string, tagName?: string } (as \`{}\` and as not written)
      a discriminated \`oneOf\` variant (field)
        true:  Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: (Cat | unknown) }
        false: Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: (Cat | unknown) } (as \`{}\`)
      a discriminated \`oneOf\` variant (component, with a \`mapping\`)
        true:  Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: Animal }; Animal {  } = oneOf(Cat | unknown)
        false: Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: Animal }; Animal {  } = oneOf(Cat | unknown) (as \`{}\`)
      a \`anyOf\` variant, first
        true:  Pet { name?: string, value?: (unknown | string) }
        false: Pet { name?: string, value?: (unknown | string) } (as \`{}\`)
      a \`anyOf\` variant, last
        true:  Pet { name?: string, value?: (string | unknown) }
        false: Pet { name?: string, value?: (string | unknown) } (as \`{}\`)
      the only \`anyOf\` variant
        true:  Pet { name?: string, value?: unknown }
        false: Pet { name?: string, value?: unknown } (as \`{}\` and as not written)
      a \`anyOf\` variant beside a \`null\` one
        true:  Pet { name?: string, value?: nullable<unknown> }
        false: Pet { name?: string, value?: nullable<unknown> } (as \`{}\`)
      a \`anyOf\` variant beside a \`$ref\`
        true:  Owner { ownerName?: string }; Pet { name?: string, value?: (Owner | unknown) }
        false: Owner { ownerName?: string }; Pet { name?: string, value?: (Owner | unknown) } (as \`{}\`)
      a \`anyOf\` variant (named union component)
        true:  Owner { ownerName?: string }; Pet { name?: string, value?: Value }; Value {  } = anyOf(Owner | unknown)
        false: Owner { ownerName?: string }; Pet { name?: string, value?: Value }; Value {  } = anyOf(Owner | unknown) (as \`{}\`)
      the only \`anyOf\` variant (component)
        true:  Pet { name?: string, value?: Value }; Value {  } = anyOf(unknown)
        false: Pet { name?: string, value?: Value }; Value {  } = anyOf(unknown) (as \`{}\`)
      a \`anyOf\` variant beside a \`null\` one (component)
        true:  Pet { name?: string, value?: nullable<unknown> }
        false: Pet { name?: string, value?: nullable<Value> }; Value {  } = anyOf(unknown) (as neither)
      a \`anyOf\` variant (response body)
        true:  Pet { name?: string }; getPet(path petId: string) -> (Pet | unknown)
        false: Pet { name?: string }; getPet(path petId: string) -> (Pet | unknown) (as \`{}\`)
      a \`anyOf\` variant (request body)
        true:  Pet { name?: string }; createPet() body (Pet | unknown) -> Pet
        false: Pet { name?: string }; createPet() body (Pet | unknown) -> Pet (as \`{}\`)
      a \`anyOf\` variant beside an \`allOf\` (component)
        true:  Owner { ownerName?: string }; Tag { tagName?: string }; Pet { ownerName?: string, tagName?: string }
        false: Owner { ownerName?: string }; Tag { tagName?: string }; Pet { ownerName?: string, tagName?: string } (as \`{}\` and as not written)
      a discriminated \`anyOf\` variant (field)
        true:  Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: (Cat | unknown) }
        false: Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: (Cat | unknown) } (as \`{}\`)
      a discriminated \`anyOf\` variant (component, with a \`mapping\`)
        true:  Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: Animal }; Animal {  } = anyOf(Cat | unknown)
        false: Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: Animal }; Animal {  } = anyOf(Cat | unknown) (as \`{}\`)
      an \`allOf\` member (field)
        true:  Owner { ownerName?: string }; Pet { name?: string, owner?: Owner }
        false: Owner { ownerName?: string }; Pet { name?: string, owner?: Owner } (as \`{}\` and as not written)
      the only \`allOf\` member (field)
        true:  Pet { name?: string, owner?: unknown }
        false: Pet { name?: string, owner?: unknown } (as \`{}\` and as not written)
      an \`allOf\` member, first (component)
        true:  Owner { ownerName?: string }; Pet { ownerName?: string }
        false: Owner { ownerName?: string }; Pet { ownerName?: string } (as \`{}\` and as not written)
      an \`allOf\` member beside two nullable \`$ref\`s (component)
        true:  Owner { ownerName?: string }; Tag { tagName?: string }; Pet { name?: string, owner?: nullable<PetOwner> }; PetOwner { ownerName?: string, tagName?: string }
        false: Owner { ownerName?: string }; Tag { tagName?: string }; Pet { name?: string, owner?: nullable<PetOwner> }; PetOwner { ownerName?: string, tagName?: string } (as \`{}\` and as not written)
      an \`allOf\` member (response body)
        true:  Pet { name?: string }
        false: Pet { name?: string } (as \`{}\` and as not written)
      \`not\`
        true:  Pet { name?: string, value?: unknown }
        false: Pet { name?: string, value?: unknown } (as \`{}\` and as not written)
      \`not\` beside a \`type\`
        true:  Pet { name?: string, value?: string }
        false: Pet { name?: string, value?: string } (as \`{}\` and as not written)
      a component nothing references
        true:  Pet { name?: string }
        false: Pet { name?: string } (as \`{}\` and as not written)
      a component nothing references, beside a named union and an array component
        true:  Owner { ownerName?: string }; Pet { name?: string, value?: Value, tags?: TagsItem[] }; Value {  } = oneOf(Owner | string); TagsItem { label?: string }
        false: Owner { ownerName?: string }; Pet { name?: string, value?: Value, tags?: TagsItem[] }; Value {  } = oneOf(Owner | string); TagsItem { label?: string } (as \`{}\` and as not written)
      a component a field names
        true:  Pet { name?: string, any?: unknown }
        false: Pet { name?: string, any?: unknown } (as \`{}\`)
      a component a required field names
        true:  Pet { name?: string, any: unknown }
        false: Pet { name?: string, any: unknown } (as \`{}\`)
      a component a response body names
        true:  Pet { name?: string }; getPet(path petId: string) -> unknown
        false: Pet { name?: string }; getPet(path petId: string) -> unknown (as \`{}\`)
      a component a request body names
        true:  Pet { name?: string }; createPet() body unknown -> Pet
        false: Pet { name?: string }; createPet() body unknown -> Pet (as \`{}\`)
      a component a query parameter names
        true:  Pet { name?: string }; getPet(path petId: string, query filter: unknown) -> Pet
        false: Pet { name?: string }; getPet(path petId: string, query filter: unknown) -> Pet (as \`{}\`)
      a component array \`items\` name
        true:  Pet { name?: string, tags?: unknown[] }
        false: Pet { name?: string, tags?: unknown[] } (as \`{}\`)
      a component \`additionalProperties\` name
        true:  Pet { name?: string, extra?: map<unknown> }
        false: Pet { name?: string, extra?: map<unknown> } (as \`{}\`)
      a component an \`allOf\` member names (field)
        true:  Owner { ownerName?: string }; Pet { name?: string, owner?: Owner }
        false: Owner { ownerName?: string }; Pet { name?: string, owner?: Owner } (as \`{}\`)
      a component an \`allOf\` member names (component)
        true:  Owner { ownerName?: string }; Pet { ownerName?: string }
        false: Owner { ownerName?: string }; Pet { ownerName?: string } (as \`{}\`)
      a component the only \`allOf\` member names
        true:  Pet { name?: string, owner?: unknown }
        false: Pet { name?: string, owner?: unknown } (as \`{}\`)
      a component an \`allOf\` member names beside two nullable \`$ref\`s (field)
        true:  Owner { ownerName?: string }; Tag { tagName?: string }; Pet { name?: string, owner?: nullable<PetOwner> }; PetOwner { ownerName?: string, tagName?: string }
        false: Owner { ownerName?: string }; Tag { tagName?: string }; Pet { name?: string, owner?: nullable<PetOwner> }; PetOwner { ownerName?: string, tagName?: string } (as \`{}\`)
      a component an \`allOf\` member names beside two nullable \`$ref\`s (component)
        true:  Owner { ownerName?: string }; Tag { tagName?: string }; Pet { name?: string, owner?: nullable<PetOwner> }; PetOwner { ownerName?: string, tagName?: string }
        false: Owner { ownerName?: string }; Tag { tagName?: string }; Pet { name?: string, owner?: nullable<PetOwner> }; PetOwner { ownerName?: string, tagName?: string } (as \`{}\`)
      a component a \`oneOf\` variant names (field)
        true:  Pet { name?: string, value?: (string | unknown) }
        false: Pet { name?: string, value?: (string | unknown) } (as \`{}\`)
      a component a \`oneOf\` variant names (named union component)
        true:  Owner { ownerName?: string }; Pet { name?: string, value?: Value }; Value {  } = oneOf(Owner | unknown)
        false: Owner { ownerName?: string }; Pet { name?: string, value?: Value }; Value {  } = oneOf(Owner | unknown) (as \`{}\`)
      a component a discriminated variant names, with a \`mapping\`
        true:  Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: Animal }; Animal {  } = oneOf(Cat | unknown)
        false: Cat { kind: "cat", meow?: string }; Pet { name?: string, value?: Animal }; Animal {  } = oneOf(Cat | unknown) (as \`{}\`)
      a component an alias names
        true:  Pet { name?: string, any?: unknown }
        false: Pet { name?: string, any?: unknown } (as \`{}\`)
      a component a nullable wrapper names
        true:  Pet { name?: string, any?: nullable<unknown> }
        false: Pet { name?: string, any?: nullable<unknown> } (as \`{}\`)
      a component a webhook payload names
        true:  Pet { name?: string }; webhook pet.created body unknown
        false: Pet { name?: string }; webhook pet.created body unknown (as \`{}\`)
      a response body
        true:  Pet { name?: string }; getPet(path petId: string) -> unknown
        false: Pet { name?: string }; getPet(path petId: string) -> unknown (as \`{}\` and as not written)
      a \`404\` response body
        true:  Pet { name?: string }; getPet(path petId: string) -> Pet errors[404: unknown]
        false: Pet { name?: string }; getPet(path petId: string) -> Pet errors[404: none] (as not written)
      a \`default\` response body
        true:  Pet { name?: string }; getPet(path petId: string) -> Pet default unknown
        false: Pet { name?: string }; getPet(path petId: string) -> Pet default none (as not written)
      a \`4XX\` response body
        true:  Pet { name?: string }; getPet(path petId: string) -> Pet 4XX unknown
        false: Pet { name?: string }; getPet(path petId: string) -> Pet 4XX none (as not written)
      a response body under \`components/responses\`
        true:  Pet { name?: string }; getPet(path petId: string) -> unknown
        false: Pet { name?: string }; getPet(path petId: string) -> unknown (as \`{}\` and as not written)
      a request body
        true:  Pet { name?: string }; createPet() body unknown -> Pet
        false: Pet { name?: string }; createPet() -> Pet (as not written)
      a form request body
        true:  Pet { name?: string }; createPet() body unknown -> Pet
        false: Pet { name?: string }; createPet() -> Pet (as not written)
      a request body under \`components/requestBodies\`
        true:  Pet { name?: string }; createPet() body unknown -> Pet
        false: Pet { name?: string }; createPet() -> Pet (as not written)
      a query parameter
        true:  Pet { name?: string }; getPet(path petId: string, query filter: unknown) -> Pet
        false: Pet { name?: string }; getPet(path petId: string, query filter: string) -> Pet (as not written)
      a header parameter
        true:  Pet { name?: string }; getPet(path petId: string, header filter: unknown) -> Pet
        false: Pet { name?: string }; getPet(path petId: string, header filter: string) -> Pet (as not written)
      a cookie parameter
        true:  Pet { name?: string }; getPet(path petId: string, cookie filter: unknown) -> Pet
        false: Pet { name?: string }; getPet(path petId: string, cookie filter: string) -> Pet (as not written)
      a path parameter
        true:  Pet { name?: string }; getPet(path petId: unknown) -> Pet
        false: Pet { name?: string } (as not written)
      a parameter's \`content\` schema
        true:  Pet { name?: string }; getPet(path petId: string, query filter: unknown) -> Pet
        false: Pet { name?: string }; getPet(path petId: string, query filter: string) -> Pet (as not written)
      a parameter under \`components/parameters\`
        true:  Pet { name?: string }; getPet(path petId: string, query filter: unknown) -> Pet
        false: Pet { name?: string }; getPet(path petId: string, query filter: string) -> Pet (as not written)
      a response header
        true:  Pet { name?: string }; getPet(path petId: string) -> Pet headers[X-Rate-Limit: unknown]
        false: Pet { name?: string }; getPet(path petId: string) -> Pet headers[X-Rate-Limit: string] (as not written)
      a webhook payload
        true:  Pet { name?: string }; webhook pet.created body unknown
        false: Pet { name?: string }; webhook pet.created body none (as not written)
      a property of a webhook payload
        true:  Pet { name?: string }; PetCreatedPayload { data?: unknown, id?: string }; webhook pet.created body PetCreatedPayload
        false: Pet { name?: string }; PetCreatedPayload { id?: string }; webhook pet.created body PetCreatedPayload (as not written)
      a callback payload
        true:  Pet { name?: string }; getPet(path petId: string) -> Pet callback onEvent body unknown
        false: Pet { name?: string }; getPet(path petId: string) -> Pet callback onEvent body none (as not written)
      the body of a list operation
        true:  Pet { name?: string }; listPets(query after: string) -> unknown paged cursor of unknown
        false: Pet { name?: string }; listPets(query after: string) -> unknown paged cursor of unknown (as \`{}\` and as not written)
      the \`items\` of a list envelope's \`data\`
        true:  Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> unknown[] paged cursor of unknown
        false: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> string[] paged cursor of string (as not written)
      a property of a list envelope
        true:  Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
        false: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet (as not written)
      a list envelope's \`list_metadata\`
        true:  Pet { name?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
        false: Pet { name?: string }; ListPetsResponse { data?: Pet[] }; listPets(query after: string) -> ListPetsResponse paged cursor of ListPetsResponse (as not written)
      an \`allOf\` member of a list envelope
        true:  Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
        false: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet (as \`{}\` and as not written)
      a variant beside the \`allOf\` of a list envelope
        true:  Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet
        false: Pet { name?: string }; ListMetadata { after?: string }; listPets(query after: string) -> Pet[] paged cursor of Pet (as \`{}\`)"
    `);
  });

  it('references no model or enum the IR lacks, whatever is written', async () => {
    for (const row of table) {
      for (const value of [true, false, 0, 1.5, '', 'x']) {
        expect(danglingReferences((await row.of(value)).spec), `${row.position}: ${JSON.stringify(value)}`).toEqual([]);
      }
    }
  });

  it('reads a number or a string where a schema goes as it reads a boolean: `1.5` and `"x"` as `true`, `0` and `""` as `false`', async () => {
    // Neither is a schema, and each reached the same memo: the same regression through another value.
    for (const row of table) {
      const [yes, no] = [await row.of(true), await row.of(false)];
      for (const value of [1.5, 'x']) {
        const reading = await row.of(value);
        expect(reading.spec, `${row.position}: ${JSON.stringify(value)}`).toEqual(yes.spec);
        expect(reading.warnings, `${row.position}: ${JSON.stringify(value)}`).toEqual(yes.warnings);
      }
      for (const value of [0, '']) {
        const reading = await row.of(value);
        expect(reading.spec, `${row.position}: ${JSON.stringify(value)}`).toEqual(no.spec);
        expect(reading.warnings, `${row.position}: ${JSON.stringify(value)}`).toEqual(no.warnings);
      }
    }
  });

  it('parses a list where a schema goes, as it did', async () => {
    for (const row of table) {
      for (const value of [[], [{ type: 'string' }], [true]]) {
        await expect(row.of(value), `${row.position}: ${JSON.stringify(value)}`).resolves.toBeDefined();
      }
    }
  });

  it('reports no change between `true` and `{}`, in either direction', async () => {
    const [, property] = positions(openapi).find(([position]) => position === 'a property')!;
    const [, variant] = positions(openapi).find(([position]) => position === 'a `oneOf` variant, last')!;
    const [, component] = positions(openapi).find(([position]) => position === 'a component a field names')!;
    const [, body] = positions(openapi).find(([position]) => position === 'a response body')!;
    for (const build of [property, variant, component, body]) await expectNoDiff(build(true), build({}));
    // `false` as a property declares no field: no change against the property not written.
    await expectNoDiff(property(false), strip(property(ABSENT)));
  });
});

describe('#728 what stays as it was', () => {
  const document = (schemas: Record<string, unknown>) => ({
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
    components: { schemas },
  });
  const pet = (extra: Record<string, unknown>) => ({ type: 'object', properties: { name: string, ...extra } });

  it('lands a JSON Pointer on no schema where it lands on a boolean: `unknown`, with the warning', async () => {
    const pointer = (value: unknown) =>
      document({ Pet: pet({ metadata: value, again: { $ref: '#/components/schemas/Pet/properties/metadata' } }) });
    const reading = await read(pointer(true));
    expect(render(reading.spec)).toBe('Pet { name?: string, metadata?: unknown, again?: unknown }');
    expect(reading.warnings).toEqual([
      '[oagen] Warning: Unresolved schema $ref "#/components/schemas/Pet/properties/metadata" in Pet.again: no schema at that pointer — typing the site as unknown',
    ]);
    // The same type as with `{}` there, which the pointer does land on.
    expect(render((await read(pointer({}))).spec)).toBe(render(reading.spec));
  });

  it('types a header whose `schema` is a boolean beside a header that is one itself, which is no Header Object (#729)', async () => {
    // Where the two fixes meet: a boolean where a Header Object goes is skipped with a warning (#729), and a
    // boolean where the header's schema goes is the schema.
    const reading = await read({
      openapi: '3.1.0',
      info: { title: 'Repro', version: '1.0.0' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: {
              '200': {
                description: 'OK',
                ...json({ type: 'array', items: true }),
                headers: { 'X-Skipped': true, 'X-Any': { schema: true }, 'X-None': { schema: false } },
              },
            },
          },
        },
      },
    });
    expect(render(reading.spec)).toBe('listPets() -> unknown[] headers[X-Any: unknown, X-None: string]');
    expect(reading.warnings).toEqual([
      '[oagen] Warning: the response header "X-Skipped" of listPets is not a Header Object (true); skipping it.',
    ]);
  });

  it('reads `null` as a property as it reads `false` there: no field', async () => {
    expect(render(await parse(document({ Pet: pet({ metadata: null }) })))).toBe('Pet { name?: string }');
  });

  it('compares two schemas by what they write: `true` and `{}` are two shapes, as two spellings of one type always were', async () => {
    // Greptile on #737. Two unions under one root, each with a variant titled `Circle`: the two share the
    // bare title when their shapes are one (`schemaShapeKey`, a fingerprint of the schema as written), and
    // each is named with its context when they differ. A document that writes `true` throughout reads as
    // the one that writes `{}` throughout. One that writes each is two shapes, as it was before #597, and
    // as `additionalProperties: true` beside `additionalProperties: {}` is, which never failed the parse.
    const variant = (title: string, kind: string, properties: Record<string, unknown>, more: object = {}) => ({
      title,
      type: 'object',
      properties: { kind: { const: kind }, ...properties },
      required: ['kind'],
      ...more,
    });
    const names = async (shape: object, marker: object): Promise<string> => {
      const union = (circle: object) => ({ oneOf: [circle, variant('Square', 'square', { side: string })] });
      const spec = await parse(document({ Pet: pet({ shape: union(shape), marker: union(marker) }) }));
      return spec.models
        .map((model) => model.name)
        .filter((name) => name !== 'Pet')
        .join(', ');
    };
    const circle = (metadata: unknown) => variant('Circle', 'circle', { metadata });
    expect(await names(circle({}), circle({}))).toBe('Circle, Square');
    expect(await names(circle(true), circle(true))).toBe('Circle, Square');
    expect(await names(circle(true), circle({}))).toBe('CirclePetShape, Square, CirclePetMarker');
    // The same for two spellings `main` has always parsed.
    const open = (additionalProperties: unknown) => variant('Circle', 'circle', {}, { additionalProperties });
    expect(await names(open(true), open(true))).toBe('Circle, Square');
    expect(await names(open(true), open({}))).toBe('CirclePetShape, Square, CirclePetMarker');
  });

  it('combines a list written where a schema goes as it did, its entries read as keywords of the declaration', async () => {
    // A list is no Schema Object either, but it is an object the memo holds: main parses it, and so it reads here
    // exactly as on main. The copy `{ 0: { type: 'string' }, type: 'string' }` is not `Base`'s declaration, so the
    // field is not marked inherited, where `{}` and `true` in its place leave `Base`'s own (`inheritedFrom`).
    const merged = (value: unknown) =>
      document({
        Base: { type: 'object', properties: { meta: string } },
        Pet: { allOf: [ref('Base'), { type: 'object', properties: { meta: value } }] },
      });
    const fields = async (value: unknown) => (await parse(merged(value))).models.find((m) => m.name === 'Pet')!.fields;
    expect(await fields([{ type: 'string' }])).toEqual([
      { name: 'meta', type: { kind: 'primitive', type: 'string' }, required: false },
    ]);
    const inherited = [
      {
        name: 'meta',
        type: { kind: 'primitive', type: 'string' },
        required: false,
        inheritedFrom: { kind: 'model', name: 'Base' },
      },
    ];
    expect(await fields({})).toEqual(inherited);
    expect(await fields(true)).toEqual(inherited);
  });
});

describe('#728 a merge that reaches itself through a property a boolean declares too', () => {
  const document = (schemas: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'Repro', version: '1.0.0' },
    paths: {
      '/notes': {
        get: { operationId: 'getNote', responses: { '200': { description: 'OK', ...json(ref('Note')) } } },
      },
    },
    components: { schemas },
  });
  const inner = (schema: unknown) => ({ type: 'object', properties: { inner: schema } });
  const again = { allOf: [ref('Note'), { type: 'object', properties: { depth: { type: 'integer' } } }] };
  const note = (reply: unknown) => ({ Note: { type: 'object', properties: { id: string, reply } } });

  it.each([
    [
      'the boolean, then text, then the merge',
      (v: unknown) => [inner(v), inner({ description: 'Inner.' }), inner(again)],
    ],
    [
      'text, then the boolean, then the merge',
      (v: unknown) => [inner({ description: 'Inner.' }), inner(v), inner(again)],
    ],
    ['the merge, then the boolean', (v: unknown) => [inner(again), inner(v)]],
  ])('ends, read as with `{}` in its place: %s', async (_label, members) => {
    // Each combination is one object however often the merges build it (#566), which is what ends the
    // re-entry: a boolean adds nothing to the declaration it meets, so the combination stays that one.
    const spec = await parse(document(note({ allOf: members(true) })));
    expect(render(spec)).toBe(
      'Note { id?: string, reply?: NoteReply }; NoteReply { inner?: NoteReplyInner }; ' +
        'NoteReplyInner { id?: string, reply?: NoteReply, depth?: integer }; getNote() -> Note',
    );
    expect(spec).toEqual(await parse(document(note({ allOf: members({}) }))));
  });

  it('ends on a union variant that names its own component beside a boolean variant', async () => {
    const reply = (v: unknown) => ({
      allOf: [{ type: 'object', properties: { depth: string } }],
      oneOf: [ref('Note'), v, { type: 'object', properties: { other: string } }],
    });
    const spec = await parse(document(note(reply(true))));
    expect(render(spec)).toBe(
      'Note { id?: string, reply?: NoteReply }; ' +
        'NoteReply { depth?: string, id?: string, reply?: NoteReply, other?: string }; getNote() -> Note',
    );
    expect(spec).toEqual(await parse(document(note(reply({})))));
  });
});

describe('#728 the readers that remember by the schema', () => {
  const values: ReadonlyArray<readonly [string, unknown]> = [
    ['`true`', true],
    ['`false`', false],
    ['a number', 1.5],
    ['zero', 0],
    ['a string', 'x'],
    ['an empty string', ''],
    ['`null`', null],
    ['a list', [{ type: 'string' }]],
  ];

  it('tells a Schema Object from anything else written where one goes', () => {
    expect(isSchemaObject({})).toBe(true);
    expect(isSchemaObject({ type: 'string' })).toBe(true);
    for (const [label, value] of values) expect(isSchemaObject(value), label).toBe(false);
    expect(isSchemaObject(undefined)).toBe(false);
  });

  it.each(values)('folds nothing for %s, and remembers nothing', (_label, value) => {
    expect(foldSiblingProperties(written(value))).toBe(value);
    // Asked again, as every site that folds a schema asks.
    expect(foldSiblingProperties(written(value))).toBe(value);
  });

  it.each(values.filter(([, value]) => value !== null))('strips no wrapper from %s', (_label, value) => {
    expect(unwrapNullableSchema(written(value))).toBe(value);
  });

  it('records no copy that is no Schema Object', () => {
    const source: SchemaObject = { type: 'string' };
    for (const [label, value] of values) {
      expect(derivedCopy(written(value), source), label).toBe(value);
      expect(sourceDeclaration(written(value)), label).toBe(value);
    }
  });

  it('combines a declaration with one that is no object as the declaration itself', () => {
    const typed: SchemaObject = { type: 'string' };
    const text: SchemaObject = { description: 'Text.' };
    for (const [label, value] of values.filter(([, v]) => !Array.isArray(v))) {
      const other = written(value);
      expect(combineDeclarations(typed, other), label).toBe(typed);
      expect(combineDeclarations(other, typed), label).toBe(typed);
      expect(combineDeclarations(text, other), label).toBe(text);
      expect(combineDeclarations(other, text), label).toBe(text);
      expect(combineDeclarations(other, other), label).toBe(value);
    }
    expect(combineDeclarations(written(true), written(false))).toBe(true);
    // As `{}` adds nothing to a declaration that types the property.
    expect(combineDeclarations(typed, {})).toBe(typed);
  });

  it('remembers the combination with a list, an object the memo holds, as it did', () => {
    const typed: SchemaObject = { type: 'string' };
    const list = written([{ type: 'integer' }]);
    const combined = combineDeclarations(list, typed);
    expect(combined).toEqual({ 0: { type: 'integer' }, type: 'string' });
    expect(combineDeclarations(list, typed)).toBe(combined);
  });

  it('collects no property and no union from a node that is no Schema Object', () => {
    for (const [label, value] of values) {
      expect(collectObjectProperties(written(value)), label).toEqual({
        properties: {},
        required: [],
        unions: [],
        named: false,
        fields: {},
        onEveryInstance: {},
      });
    }
    // A member that is one declares nothing beside the members that do.
    const envelope: SchemaObject = {
      type: 'object',
      properties: { data: { type: 'array', items: { type: 'string' } } },
    };
    const collected = collectObjectProperties({ allOf: [written(true), envelope, written(false)] });
    expect(Object.keys(collected.properties)).toEqual(['data']);
    expect(collected).toEqual(collectObjectProperties({ allOf: [{}, envelope, {}] }));
  });
});
