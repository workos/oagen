import { describe, it, expect, afterAll, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec, type ParseOptions } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { mergeAllOfMembers, modelFingerprint } from '../../src/parser/inline-models.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #755: a model built from a component's `allOf` names each `$ref`
 * member's model in `Model.bases` and marks the fields it takes from one
 * with `Field.inheritedFrom` (#591), but a model built from an inline
 * `allOf` — a request or response body, a field — recorded neither, and
 * the error-body fold built its shared models without them. So an emitter
 * for a nominally typed language wrote an error class for `allOf: [{ $ref:
 * PetError }, { properties: { code } }]` that was no `PetError`. An inline
 * `allOf` now names its bases by exactly the rules a component's follows,
 * at every site one is written, and two error bodies fold onto one shared
 * model only when they name the same bases in the same order.
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
const warnings = (): string[] => warn.mock.calls.map(([message]) => String(message));

async function writeDoc(doc: unknown, name = 'spec.json'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-755-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}
const parse = async (doc: unknown, options?: ParseOptions): Promise<ApiSpec> => parseSpec(await writeDoc(doc), options);

type Doc = Record<string, unknown>;
const R = (name: string): Doc => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const obj = (properties: Doc, required: string[] = []): Doc => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});
const code = obj({ code: string });

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

const document = (openapi: Version, paths: Doc, schemas: Doc, more: Doc = {}): Doc => ({
  openapi,
  info: { title: 'Repro', version: '1.0.0' },
  paths,
  components: { schemas, ...(more.components as Doc | undefined) },
  ...Object.fromEntries(Object.entries(more).filter(([key]) => key !== 'components')),
});

/** The issue's components. */
const Pet = obj({ id: string, name: string }, ['id', 'name']);
const PetError = obj({ message: string }, ['message']);
const Retryable = obj({ retryAfter: { type: 'integer' } });
const issueSchemas = { Pet, PetError, Retryable };

const petPath = (responses: Doc, more: Doc = {}): Doc => ({
  '/pets/{petId}': {
    get: {
      operationId: 'getPet',
      parameters: [{ name: 'petId', in: 'path', required: true, schema: string }],
      responses,
      ...more,
    },
  },
});
const ok = { '200': { description: 'OK', ...json(R('Pet')) } };
/** `GET /pets/{petId}` returning `Pet` under `200` and `body` under `400`. */
const getPet = (body: unknown): Doc => petPath({ ...ok, '400': { description: 'Bad Request', ...json(body) } });

/** The issue's inline `400` body, and the same `allOf` with the one `$ref`. */
const issueBody = { allOf: [R('PetError'), R('Retryable'), code] };
const oneRefBody = { allOf: [R('PetError'), code] };

const show = (type: TypeRef | undefined): string => {
  if (!type) return 'none';
  switch (type.kind) {
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `${show(type.items)}[]`;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'primitive':
      return type.type;
    case 'literal':
      return JSON.stringify(type.value);
    default:
      return type.name;
  }
};
const modelOf = (spec: ApiSpec, name: string | undefined): Model | undefined =>
  spec.models.find((m) => m.name === name);
const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((service) => service.operations);
const operation = (spec: ApiSpec, name: string): Operation => operations(spec).find((op) => op.name === name)!;

/** A model as the issue's script prints it: `bases [PetError, Retryable] { message ← PetError, retryAfter ← Retryable, code }`. */
const provenance = (model: Model | undefined): string => {
  if (!model) return 'no model';
  const bases = (model.bases ?? []).map(show).join(', ');
  const fields = model.fields.map((f) => `${f.name}${f.inheritedFrom ? ` ← ${show(f.inheritedFrom)}` : ''}`);
  return `bases [${bases}] { ${fields.join(', ')} }`;
};
/** The same with each field's requiredness and type, so two models read as one only when their fields do. */
const outline = (model: Model | undefined): string => {
  if (!model) return 'no model';
  const bases = (model.bases ?? []).map(show).join(', ');
  const fields = model.fields.map(
    (f) => `${f.name}${f.required ? '' : '?'}${f.inheritedFrom ? ` ← ${show(f.inheritedFrom)}` : ''}`,
  );
  return `bases [${bases}] { ${fields.join(', ')} }`;
};
/** Every model, one per line: `Name bases [..] { field ← Base, .. }`. */
const models = (spec: ApiSpec, skip: readonly string[] = Object.keys(issueSchemas)): string[] =>
  spec.models.filter((m) => !skip.includes(m.name)).map((m) => `${m.name} ${outline(m)}`);
/** Each operation's error types: `getPet → GetPetError400`. */
const errors = (spec: ApiSpec): string[] =>
  operations(spec).map((op) => `${op.name} → ${op.errors.map((e) => show(e.type)).join(', ')}`);

/** The exit code of `oagen diff --old … --new …`. */
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
/** What `diffSpecs` reports from `oldDoc` to `newDoc`, one change per line. */
async function diffLines(oldDoc: unknown, newDoc: unknown): Promise<string[]> {
  const { changes } = diffSpecs(await parse(oldDoc), await parse(newDoc));
  return changes.map((change) => {
    const named = change as { name?: string; operationName?: string };
    return `${change.kind} ${named.name ?? named.operationName}: ${change.classification}`;
  });
}

// ── The matrix: every site × every way of naming `$ref` members ─────────────

/** The components a row can name. */
const matrixSchemas = (openapi: Version): Doc => ({
  ...issueSchemas,
  Living: obj({ born: string }),
  Animal: { allOf: [R('Living')], required: ['name'], properties: { name: string } },
  Hop: R('PetError'),
  Maybe:
    openapi === '3.0.3' ? { oneOf: [R('PetError')], nullable: true } : { oneOf: [R('PetError'), { type: 'null' }] },
  Kind: { type: 'string', enum: ['cat', 'dog'] },
  Names: { type: 'array', items: string },
  Count: { type: 'integer' },
  Meta: obj({ meta: obj({ a: string }) }),
  Stat: obj({ status: { type: 'string', enum: ['a', 'b'] } }),
  Cat: obj({ kind: { type: 'string', const: 'cat' }, meow: string }, ['kind']),
  Dog: obj({ kind: { type: 'string', const: 'dog' }, bark: string }, ['kind']),
  Shape: { oneOf: [R('Cat'), R('Dog')] },
  Tagged: obj({ tag: string }),
  Kinded: obj({ tag: { type: 'string', enum: ['cat', 'dog'] }, kind: string }),
  Wrap: obj({ inner: { allOf: [R('PetError'), obj({ w: string })] } }),
  Dispatcher: {
    type: 'object',
    properties: { id: string },
    oneOf: [
      obj({ kind: { type: 'string', const: 'a' }, x: string }, ['kind']),
      obj({ kind: { type: 'string', const: 'b' }, y: string }, ['kind']),
    ],
  },
  Dict: { type: 'object', additionalProperties: string },
  Empty: { type: 'object' },
  Node: obj({ id: string, next: { allOf: [R('Node'), obj({ depth: { type: 'integer' } })] } }),
  ...(openapi === '3.1.0'
    ? { Multi: { type: ['object', 'string'], properties: { m: string } }, Anything: true, Never: false }
    : {}),
});

/** Every way an `allOf` names its `$ref` members. */
const variations = (openapi: Version): Record<string, Doc> => ({
  'one $ref': oneRefBody,
  'two $refs': issueBody,
  'two $refs, swapped': { allOf: [R('Retryable'), R('PetError'), code] },
  'the inline member first': { allOf: [code, R('PetError')] },
  '$refs only': { allOf: [R('PetError'), R('Retryable')] },
  'a $ref and a required list': { allOf: [R('Retryable')], required: ['retryAfter'] },
  'properties beside the allOf': { allOf: [R('PetError')], properties: { code: string } },
  'a chain': { allOf: [R('Animal'), code] },
  'a chain and its own base': { allOf: [R('Animal'), R('Living'), code] },
  'a base and the chain over it': { allOf: [R('Living'), R('Animal'), code] },
  'a bare alias': { allOf: [R('Hop'), code] },
  'an alias and what it names': { allOf: [R('Hop'), R('PetError'), code] },
  'what an alias names and the alias': { allOf: [R('PetError'), R('Hop'), code] },
  'a nullable alias': { allOf: [R('Maybe'), code] },
  'an enum component': { allOf: [R('Kind'), code] },
  'an array component': { allOf: [R('Names'), code] },
  'a primitive component': { allOf: [R('Count'), code] },
  'a map component': { allOf: [R('Dict'), code] },
  'an empty object component': { allOf: [R('Empty'), code] },
  'the same $ref twice': { allOf: [R('PetError'), R('PetError'), code] },
  'a field redeclared after the $ref': {
    allOf: [R('PetError'), obj({ message: { type: 'string', description: 'Why.' }, code: string })],
  },
  'a field the base leaves optional, required': { allOf: [R('Retryable'), obj({ code: string }, ['retryAfter'])] },
  'a $ref in an allOf wrapper': { allOf: [{ allOf: [R('PetError')] }, code] },
  'a wrapper that requires': { allOf: [{ allOf: [R('Retryable')], required: ['retryAfter'] }, code] },
  'three levels of wrappers': { allOf: [{ allOf: [{ allOf: [R('PetError')] }, R('Retryable')] }, code] },
  'a $ref under a union of one': { allOf: [{ oneOf: [R('PetError')] }, code] },
  'a union member beside the $ref': { allOf: [R('PetError'), { oneOf: [obj({ a: string }), obj({ b: string })] }] },
  'a named union': { allOf: [R('Shape'), code] },
  'a dispatcher': { allOf: [R('Dispatcher'), code] },
  'a base that declares an object': { allOf: [R('Meta'), code] },
  'a base that declares an enum': { allOf: [R('Stat'), code] },
  'two bases declaring one field apart': { allOf: [R('Tagged'), R('Kinded')] },
  'two bases declaring one field apart, swapped': { allOf: [R('Kinded'), R('Tagged')] },
  'a component that extends itself': { allOf: [R('Node'), code] },
  'a pointer into a component': { allOf: [{ $ref: '#/components/schemas/Meta/properties/meta' }, code] },
  'a pointer to an allOf': { allOf: [{ $ref: '#/components/schemas/Wrap/properties/inner' }, code] },
  'a $ref with text beside it': { allOf: [{ ...R('PetError'), description: 'The error.' }, code] },
  'a member that only describes': { allOf: [R('PetError'), { description: 'Annotated.' }, code] },
  'a member that only requires': { allOf: [R('Retryable'), { required: ['retryAfter'] }] },
  'a member that only allows more': { allOf: [R('PetError'), { type: 'object', additionalProperties: string }] },
  'two components without fields': { allOf: [R('Empty'), R('Dict')] },
  'a component without fields and an empty object': { allOf: [R('Empty'), { type: 'object' }] },
  'a component without fields and empty properties': { allOf: [R('Empty'), { type: 'object', properties: {} }] },
  ...(openapi === '3.1.0'
    ? {
        'a merge that admits null': { type: ['object', 'null'], allOf: [R('PetError'), code] },
        'a type list component': { allOf: [R('Multi'), code] },
        'the schema true': { allOf: [R('Anything'), R('PetError'), code] },
        'the schema false': { allOf: [R('Never'), R('PetError'), code] },
      }
    : { 'a merge that admits null': { nullable: true, allOf: [R('PetError'), code] } }),
});

interface Site {
  /** The document's parts with `schema` written at the site. */
  doc: (schema: unknown) => { paths?: Doc; webhooks?: Doc; schemas?: Doc; components?: Doc };
  /** The type at the site. */
  pick: (spec: ApiSpec) => TypeRef | undefined;
  options?: ParseOptions;
  /** Whether only OAS 3.1 has the site. */
  since31?: true;
}
const holder = (spec: ApiSpec, name = 'Holder', field = 0): TypeRef | undefined =>
  modelOf(spec, name)?.fields[field]?.type;
const idParam = { name: 'petId', in: 'path', required: true, schema: string };
const errorSite = (options?: ParseOptions): Site => ({
  doc: (schema) => ({ paths: getPet(schema) }),
  pick: (spec) => operation(spec, 'getPet').errors[0]?.type,
  ...(options ? { options } : {}),
});
const createPet = (requestBody: unknown): Doc => ({
  '/pets': { post: { operationId: 'createPet', requestBody, responses: { '204': { description: 'OK' } } } },
});

/** Every site an inline `allOf` is read at. */
const sites: Record<string, Site> = {
  'a request body': {
    doc: (schema) => ({ paths: createPet(json(schema)) }),
    pick: (spec) => operation(spec, 'createPet').requestBody,
  },
  'a request body’s second media type': {
    doc: (schema) => ({
      paths: createPet({
        content: { 'application/json': { schema: R('Pet') }, 'application/vnd.pet+json': { schema } },
      }),
    }),
    pick: (spec) =>
      operation(spec, 'createPet').requestBodyContents?.find((c) => c.contentType === 'application/vnd.pet+json')?.type,
  },
  'a component request body': {
    doc: (schema) => ({
      paths: createPet({ $ref: '#/components/requestBodies/NewPet' }),
      components: { requestBodies: { NewPet: json(schema) } },
    }),
    pick: (spec) => operation(spec, 'createPet').requestBody,
  },
  'the success response': {
    doc: (schema) => ({ paths: petPath({ '200': { description: 'OK', ...json(schema) } }) }),
    pick: (spec) => operation(spec, 'getPet').response,
  },
  'a second success code': {
    doc: (schema) => ({ paths: petPath({ ...ok, '202': { description: 'Later', ...json(schema) } }) }),
    pick: (spec) => operation(spec, 'getPet').successResponses?.find((r) => r.statusCode === 202)?.type,
  },
  'a response’s second media type': {
    doc: (schema) => ({
      paths: petPath({
        '200': {
          description: 'OK',
          content: { 'application/json': { schema: R('Pet') }, 'application/vnd.pet+json': { schema } },
        },
      }),
    }),
    pick: (spec) =>
      operation(spec, 'getPet').responseContents?.find((c) => c.contentType === 'application/vnd.pet+json')?.type,
  },
  'an error response, the fold on': errorSite(),
  'an error response, the fold off': errorSite({ collapseErrorBodies: false }),
  'a component response': {
    doc: (schema) => ({
      paths: petPath({ ...ok, '409': { $ref: '#/components/responses/Conflict' } }),
      components: { responses: { Conflict: { description: 'Conflict', ...json(schema) } } },
    }),
    pick: (spec) => operation(spec, 'getPet').errors[0]?.type,
  },
  'the default response': {
    doc: (schema) => ({ paths: petPath({ ...ok, default: { description: 'Else', ...json(schema) } }) }),
    pick: (spec) => operation(spec, 'getPet').defaultResponse?.type,
  },
  'a range response': {
    doc: (schema) => ({ paths: petPath({ ...ok, '4XX': { description: 'Bad', ...json(schema) } }) }),
    pick: (spec) => operation(spec, 'getPet').rangeResponses?.[0]?.type,
  },
  'a response’s array items': {
    doc: (schema) => ({ paths: petPath({ '200': { description: 'OK', ...json({ type: 'array', items: schema }) } }) }),
    pick: (spec) => operation(spec, 'getPet').response,
  },
  'a field of a response’s object': {
    doc: (schema) => ({ paths: petPath({ '200': { description: 'OK', ...json(obj({ pet: schema })) } }) }),
    pick: (spec) => holder(spec, 'GetPetResponse'),
  },
  'a field of an error body, the fold on': {
    doc: (schema) => ({ paths: getPet(obj({ message: string, detail: schema }, ['message'])) }),
    pick: (spec) => {
      const body = operation(spec, 'getPet').errors[0]?.type;
      return modelOf(spec, body?.kind === 'model' ? body.name : undefined)?.fields.find((f) => f.name === 'detail')
        ?.type;
    },
  },
  'a variant of an error body’s union, the fold on': {
    doc: (schema) => ({ paths: getPet({ oneOf: [schema, obj({ other: string }, ['other'])] }) }),
    pick: (spec) => {
      const body = operation(spec, 'getPet').errors[0]?.type;
      return body?.kind === 'union' ? body.variants[0] : undefined;
    },
  },
  'a component’s field': {
    doc: (schema) => ({ paths: petPath(ok), schemas: { Holder: obj({ pet: schema }) } }),
    pick: (spec) => holder(spec),
  },
  'array items': {
    doc: (schema) => ({ paths: petPath(ok), schemas: { Holder: obj({ pets: { type: 'array', items: schema } }) } }),
    pick: (spec) => holder(spec),
  },
  'map values': {
    doc: (schema) => ({
      paths: petPath(ok),
      schemas: { Holder: obj({ pets: { type: 'object', additionalProperties: schema } }) },
    }),
    pick: (spec) => holder(spec),
  },
  'a union’s variant': {
    doc: (schema) => ({ paths: petPath(ok), schemas: { Holder: obj({ pet: { oneOf: [schema, string] } }) } }),
    pick: (spec) => holder(spec),
  },
  'a named union’s variant': {
    doc: (schema) => ({ paths: petPath(ok), schemas: { Holder: { oneOf: [schema, R('Pet')] } } }),
    pick: (spec) => modelOf(spec, 'Holder')?.variants?.[0],
  },
  'a field under a dispatcher’s variant': {
    doc: (schema) => ({
      paths: petPath(ok),
      schemas: {
        Holder: {
          allOf: [R('Living')],
          oneOf: [
            obj({ kind: { type: 'string', const: 'a' }, inner: schema }, ['kind']),
            obj({ kind: { type: 'string', const: 'b' } }, ['kind']),
          ],
        },
      },
    }),
    pick: (spec) => modelOf(spec, 'HolderA')?.fields.find((f) => f.name === 'inner')?.type,
  },
  'an allOf nested in an inline allOf': {
    doc: (schema) => ({
      paths: petPath(ok),
      schemas: { Holder: obj({ pet: { allOf: [R('Retryable'), obj({ inner: schema })] } }) },
    }),
    pick: (spec) => modelOf(spec, 'HolderPet')?.fields.find((f) => f.name === 'inner')?.type,
  },
  'a query parameter': {
    doc: (schema) => ({ paths: petPath(ok, { parameters: [idParam, { name: 'filter', in: 'query', schema }] }) }),
    pick: (spec) => operation(spec, 'getPet').queryParams[0]?.type,
  },
  'a parameter’s content': {
    doc: (schema) => ({
      paths: petPath(ok, { parameters: [idParam, { name: 'filter', in: 'query', ...json(schema) }] }),
    }),
    pick: (spec) => operation(spec, 'getPet').queryParams[0]?.type,
  },
  'a component parameter': {
    doc: (schema) => ({
      paths: petPath(ok, { parameters: [idParam, { $ref: '#/components/parameters/Filter' }] }),
      components: { parameters: { Filter: { name: 'filter', in: 'query', schema } } },
    }),
    pick: (spec) => operation(spec, 'getPet').queryParams[0]?.type,
  },
  'a header parameter': {
    doc: (schema) => ({ paths: petPath(ok, { parameters: [idParam, { name: 'X-Filter', in: 'header', schema }] }) }),
    pick: (spec) => operation(spec, 'getPet').headerParams[0]?.type,
  },
  'a cookie parameter': {
    doc: (schema) => ({ paths: petPath(ok, { parameters: [idParam, { name: 'prefs', in: 'cookie', schema }] }) }),
    pick: (spec) => operation(spec, 'getPet').cookieParams?.[0]?.type,
  },
  'a response header': {
    doc: (schema) => ({
      paths: petPath({ '200': { description: 'OK', ...json(R('Pet')), headers: { 'X-Meta': { schema } } } }),
    }),
    pick: (spec) => operation(spec, 'getPet').responseHeaders?.[0]?.type,
  },
  'a webhook payload': {
    doc: (schema) => ({
      paths: petPath(ok),
      webhooks: { petChanged: { post: { requestBody: json(schema), responses: { '200': { description: 'OK' } } } } },
    }),
    pick: (spec) => spec.webhooks?.[0]?.requestBody,
    since31: true,
  },
  'a callback payload': {
    doc: (schema) => ({
      paths: petPath(ok, {
        callbacks: {
          onChange: {
            '{$request.query.url}': {
              post: { requestBody: json(schema), responses: { '200': { description: 'OK' } } },
            },
          },
        },
      }),
    }),
    pick: (spec) => operation(spec, 'getPet').callbacks?.[0]?.requestBody,
  },
};

/** The names of the models a type references, in order. */
const modelNames = (type: TypeRef | undefined, found: string[] = []): string[] => {
  if (!type) return found;
  if (type.kind === 'model') found.push(type.name);
  if (type.kind === 'nullable') modelNames(type.inner, found);
  if (type.kind === 'array') modelNames(type.items, found);
  if (type.kind === 'map') modelNames(type.valueType, found);
  if (type.kind === 'union') for (const variant of type.variants) modelNames(variant, found);
  return found;
};

/** The model the site builds for `schema` written inline, and the component `Twin` written with the same schema. */
async function row(
  openapi: Version,
  site: Site,
  schema: unknown,
): Promise<{ inline: string; twin: string; name: string }> {
  const schemas = matrixSchemas(openapi);
  const written = (at: unknown, extra: Doc): Doc => {
    const { paths, webhooks, schemas: own, components } = site.doc(at);
    return document(
      openapi,
      paths ?? {},
      { ...schemas, ...extra, ...own },
      { ...(webhooks ? { webhooks } : {}), components },
    );
  };
  const inline = await parse(written(schema, {}), site.options);
  const component = await parse(written(R('Twin'), { Twin: schema }), site.options);
  const minted = modelNames(site.pick(inline)).find((name) => !Object.hasOwn(schemas, name));
  return {
    name: minted ?? show(site.pick(inline)),
    inline: outline(modelOf(inline, minted)),
    twin: outline(modelOf(component, 'Twin')),
  };
}

/**
 * The one spelling a union's variant reads apart, as it always did: a
 * variant that writes `properties` beside its `allOf` is the object its
 * `properties` declare, the `allOf` not read at all — its fields with its
 * bases. Not this issue's; pinned below.
 */
const variantSites = [
  'a union’s variant',
  'a named union’s variant',
  'a variant of an error body’s union, the fold on',
];
const readsPropertiesAlone = (site: string, variation: string): boolean =>
  variantSites.includes(site) && variation === 'properties beside the allOf';

describe('#755 the bases of an inline `allOf`', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it('prints the issue’s proposal for its documents: the inline body names its bases as the component does', async () => {
      const lines: string[] = [];
      const documents: ReadonlyArray<readonly [string, Doc]> = [
        ['inline.json', document(openapi, getPet(issueBody), issueSchemas)],
        [
          'component.json',
          document(openapi, getPet(R('BadRequestError')), { ...issueSchemas, BadRequestError: issueBody }),
        ],
        ['inline-one-ref.json', document(openapi, getPet(oneRefBody), issueSchemas)],
      ];
      for (const [file, doc] of documents) {
        for (const collapseErrorBodies of [true, false]) {
          const spec = await parse(doc, { collapseErrorBodies });
          const [{ type }] = operations(spec).flatMap((op) => op.errors);
          const name = show(type);
          lines.push(
            `${file}, collapseErrorBodies: ${collapseErrorBodies}: ${name} ${provenance(modelOf(spec, name))}`,
          );
        }
      }
      expect(lines).toMatchInlineSnapshot(`
        [
          "inline.json, collapseErrorBodies: true: ErrorBody bases [PetError, Retryable] { message ← PetError, retryAfter ← Retryable, code }",
          "inline.json, collapseErrorBodies: false: GetPetError400 bases [PetError, Retryable] { message ← PetError, retryAfter ← Retryable, code }",
          "component.json, collapseErrorBodies: true: BadRequestError bases [PetError, Retryable] { message ← PetError, retryAfter ← Retryable, code }",
          "component.json, collapseErrorBodies: false: BadRequestError bases [PetError, Retryable] { message ← PetError, retryAfter ← Retryable, code }",
          "inline-one-ref.json, collapseErrorBodies: true: ErrorBody bases [PetError] { message ← PetError, code }",
          "inline-one-ref.json, collapseErrorBodies: false: GetPetError400 bases [PetError] { message ← PetError, code }",
        ]
      `);
      expect(warnings()).toEqual([]);
    });

    it('writes the keys as a component’s model carries them: `bases` after `fields`, `inheritedFrom` on the field', async () => {
      const spec = await parse(document(openapi, getPet(issueBody), issueSchemas), { collapseErrorBodies: false });
      expect(modelOf(spec, 'GetPetError400')).toEqual({
        name: 'GetPetError400',
        description: undefined,
        fields: [
          {
            name: 'message',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            inheritedFrom: { kind: 'model', name: 'PetError' },
          },
          {
            name: 'retryAfter',
            type: { kind: 'primitive', type: 'integer' },
            required: false,
            inheritedFrom: { kind: 'model', name: 'Retryable' },
          },
          { name: 'code', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
        bases: [
          { kind: 'model', name: 'PetError' },
          { kind: 'model', name: 'Retryable' },
        ],
      });
      expect(Object.keys(modelOf(spec, 'GetPetError400')!)).toEqual(['name', 'description', 'fields', 'bases']);
    });

    describe('at every site, as the component written with the same `allOf`', () => {
      const here = Object.entries(sites).filter(([, site]) => openapi === '3.1.0' || !site.since31);

      it.each(here)('%s', async (siteName, site) => {
        const differing: string[] = [];
        for (const [variation, schema] of Object.entries(variations(openapi))) {
          if (readsPropertiesAlone(siteName, variation)) continue;
          const { inline, twin } = await row(openapi, site, schema);
          // A site that builds no model for the schema — a `$ref` to an enum beside an
          // object member is still a model, so every row here builds one.
          if (inline !== twin) differing.push(`${variation}: ${inline} ≠ ${twin}`);
        }
        expect(differing).toEqual([]);
      });

      it('names the model each site builds, each with the issue’s two bases', async () => {
        const lines: string[] = [];
        for (const [siteName, site] of here) {
          const { name, inline } = await row(openapi, site, issueBody);
          lines.push(`${siteName}: ${name} ${inline}`);
        }
        const expected = [
          'a request body: CreatePetRequest',
          'a request body’s second media type: CreatePetApplicationVndPetJsonRequest',
          'a component request body: CreatePetRequest',
          'the success response: GetPetResponse',
          'a second success code: GetPetResponse202',
          'a response’s second media type: GetPetApplicationVndPetJsonResponse',
          'an error response, the fold on: ErrorBody',
          'an error response, the fold off: GetPetError400',
          'a component response: ConflictResponse',
          'the default response: GetPetDefaultResponse',
          'a range response: ErrorBody',
          'a response’s array items: GetPetItem',
          'a field of a response’s object: GetPetResponsePet',
          'a field of an error body, the fold on: ErrorBodyDetailWithMessage',
          'a variant of an error body’s union, the fold on: ErrorBody',
          'a component’s field: HolderPet',
          'array items: HolderPets',
          'map values: HolderPets',
          'a union’s variant: HolderPet',
          'a named union’s variant: HolderVariant1',
          'a field under a dispatcher’s variant: HolderAInner',
          'an allOf nested in an inline allOf: HolderPetInner',
          'a query parameter: PetsFilter',
          'a parameter’s content: PetsFilter',
          'a component parameter: PetsFilter',
          'a header parameter: PetsXFilter',
          'a cookie parameter: PetsPref',
          'a response header: PetsXMeta',
          ...(openapi === '3.1.0' ? ['a webhook payload: PetChangedPayload'] : []),
          'a callback payload: GetPetOnChangePayload',
        ].map((line) => `${line} bases [PetError, Retryable] { message ← PetError, retryAfter? ← Retryable, code? }`);
        expect(lines).toEqual(expected);
      });

      it('reads each way of naming the members by the component’s rules', async () => {
        const lines: string[] = [];
        for (const [variation, schema] of Object.entries(variations(openapi))) {
          const { inline, twin } = await row(openapi, sites['a component’s field']!, schema);
          expect(inline, variation).toBe(twin);
          lines.push(`${variation}: ${inline}`);
        }
        const shared = [
          'one $ref: bases [PetError] { message ← PetError, code? }',
          'two $refs: bases [PetError, Retryable] { message ← PetError, retryAfter? ← Retryable, code? }',
          'two $refs, swapped: bases [Retryable, PetError] { retryAfter? ← Retryable, message ← PetError, code? }',
          'the inline member first: bases [PetError] { code?, message ← PetError }',
          '$refs only: bases [PetError, Retryable] { message ← PetError, retryAfter? ← Retryable }',
          // The model requires what the base leaves optional: the field is its own.
          'a $ref and a required list: bases [Retryable] { retryAfter }',
          'properties beside the allOf: bases [PetError] { code?, message ← PetError }',
          // Only the direct base is named, and a field it inherits in turn names it.
          'a chain: bases [Animal] { name ← Animal, born? ← Animal, code? }',
          'a chain and its own base: bases [Animal, Living] { name ← Animal, born? ← Animal, code? }',
          'a base and the chain over it: bases [Living, Animal] { born? ← Living, name ← Animal, code? }',
          'a bare alias: bases [Hop] { message ← Hop, code? }',
          'an alias and what it names: bases [Hop, PetError] { message ← Hop, code? }',
          'what an alias names and the alias: bases [PetError, Hop] { message ← PetError, code? }',
          'a nullable alias: bases [PetError] { message ← PetError, code? }',
          // An enum, an array and a primitive component build no model: no base.
          'an enum component: bases [] { code? }',
          'an array component: bases [] { code? }',
          'a primitive component: bases [] { code? }',
          'a map component: bases [Dict] { code? }',
          'an empty object component: bases [Empty] { code? }',
          'the same $ref twice: bases [PetError] { message ← PetError, code? }',
          // A later typing declaration is set aside: the field stays the base's.
          'a field redeclared after the $ref: bases [PetError] { message ← PetError, code? }',
          'a field the base leaves optional, required: bases [Retryable] { retryAfter, code? }',
          'a $ref in an allOf wrapper: bases [PetError] { message ← PetError, code? }',
          'a wrapper that requires: bases [Retryable] { retryAfter, code? }',
          'three levels of wrappers: bases [PetError, Retryable] { message ← PetError, retryAfter? ← Retryable, code? }',
          // A union of one is flattened as a branch: its component is no base.
          'a $ref under a union of one: bases [] { message?, code? }',
          'a union member beside the $ref: bases [PetError] { message ← PetError, a?, b? }',
          'a named union: bases [Shape] { code? }',
          'a dispatcher: bases [Dispatcher] { id? ← Dispatcher, code? }',
          'a base that declares an object: bases [Meta] { meta? ← Meta, code? }',
          'a base that declares an enum: bases [Stat] { status? ← Stat, code? }',
          // `settleBases`: the field is the first base's declaration, which the other does not declare alike.
          'two bases declaring one field apart: bases [Tagged] { tag? ← Tagged, kind? }',
          'two bases declaring one field apart, swapped: bases [Kinded] { tag? ← Kinded, kind? ← Kinded }',
          'a component that extends itself: bases [Node] { id? ← Node, next? ← Node, code? }',
          // A pointer names a schema and no model: what it declares is the merge's own, and a
          // `$ref` under it starts a base as one written in its place does.
          'a pointer into a component: bases [] { a?, code? }',
          'a pointer to an allOf: bases [PetError] { message ← PetError, w?, code? }',
          'a $ref with text beside it: bases [PetError] { message ← PetError, code? }',
          'a member that only describes: bases [PetError] { message ← PetError, code? }',
          'a member that only requires: bases [Retryable] { retryAfter }',
          'a member that only allows more: bases [PetError] { message ← PetError }',
          // A base that declares nothing is still named.
          'two components without fields: bases [Empty, Dict] {  }',
          'a component without fields and an empty object: bases [Empty] {  }',
          'a component without fields and empty properties: bases [Empty] {  }',
          'a merge that admits null: bases [PetError] { message ← PetError, code? }',
        ];
        const only31 = [
          'a type list component: bases [Multi] { m? ← Multi, code? }',
          'the schema true: bases [PetError] { message ← PetError, code? }',
          'the schema false: bases [PetError] { message ← PetError, code? }',
        ];
        expect(lines).toEqual(openapi === '3.1.0' ? [...shared, ...only31] : shared);
      });

      it('types an inherited field as the base’s own on a merged model, and under the body’s name on the primary response', async () => {
        const merged = { allOf: [R('Meta'), code] };
        const field = await parse(
          document(openapi, petPath(ok), { ...matrixSchemas(openapi), Holder: obj({ pet: merged }) }),
        );
        expect(modelOf(field, 'HolderPet')?.fields[0]).toEqual({
          name: 'meta',
          type: { kind: 'model', name: 'MetaMeta' },
          required: false,
          inheritedFrom: { kind: 'model', name: 'Meta' },
        });
        const body = await parse(
          document(openapi, petPath({ '200': { description: 'OK', ...json(merged) } }), matrixSchemas(openapi)),
        );
        expect(modelOf(body, 'GetPetResponse')?.fields[0]).toEqual({
          name: 'meta',
          type: { kind: 'model', name: 'GetPetResponseMeta' },
          required: false,
          inheritedFrom: { kind: 'model', name: 'Meta' },
        });
        // The same shape under either name, so the base stays (`settleBases`).
        expect(modelFingerprint({ ...modelOf(body, 'GetPetResponseMeta')!, name: '' })).toBe(
          modelFingerprint({ ...modelOf(body, 'MetaMeta')!, name: '' }),
        );
      });

      it('leaves a union’s variant that writes `properties` beside its `allOf` the object alone, as before', async () => {
        // Not this issue's: the variant is read as the object its `properties` declare and
        // its `allOf` is not read, fields and bases alike, where the same schema on a field
        // is the merge. The component written with it carries both.
        for (const siteName of variantSites) {
          const { inline, twin } = await row(
            openapi,
            sites[siteName]!,
            variations(openapi)['properties beside the allOf'],
          );
          expect(inline, siteName).toBe('bases [] { code? }');
          expect(twin, siteName).toBe('bases [PetError] { code?, message ← PetError }');
        }
      });
    });

    describe('settled as a component’s are', () => {
      const Animal = obj({ name: string, species: { type: 'string', enum: ['cat', 'dog'] } });
      const field = async (schema: unknown, more: Doc = {}): Promise<string> => {
        const spec = await parse(
          document(openapi, petPath(ok), { Pet, Animal, ...more, Holder: obj({ pet: schema }) }),
        );
        return outline(modelOf(spec, 'HolderPet'));
      };

      it('drops a base the model’s own declaration does not fit, and keeps one it narrows', async () => {
        // `species: string` admits more than `Animal`'s enum: `Animal` is no base, `name` the model's own.
        expect(
          await field({ allOf: [R('Animal')], properties: { species: { type: 'string', description: 'Any.' } } }),
        ).toBe('bases [] { species?, name? }');
        // A pinned value under the enum, declared before the base's, fits it: the base stays,
        // the field the model's own.
        expect(await field({ allOf: [R('Animal')], properties: { species: { type: 'string', const: 'cat' } } })).toBe(
          'bases [Animal] { species?, name? ← Animal }',
        );
        // The same two as components.
        const twin = async (schema: unknown): Promise<string> =>
          outline(modelOf(await parse(document(openapi, petPath(ok), { Pet, Animal, Twin: schema })), 'Twin'));
        expect(
          await twin({ allOf: [R('Animal')], properties: { species: { type: 'string', description: 'Any.' } } }),
        ).toBe('bases [] { species?, name? }');
        expect(await twin({ allOf: [R('Animal')], properties: { species: { type: 'string', const: 'cat' } } })).toBe(
          'bases [Animal] { species?, name? ← Animal }',
        );
      });

      it('names a component that extends itself through the field as that field’s base', async () => {
        const Node = obj({ id: string, child: { allOf: [R('Node'), obj({ depth: { type: 'integer' } })] } });
        const spec = await parse(
          document(openapi, petPath({ '200': { description: 'OK', ...json(R('Node')) } }), { Node }),
        );
        expect(models(spec, [])).toEqual([
          'Node bases [] { id?, child? }',
          'NodeChild bases [Node] { id? ← Node, child? ← Node, depth? }',
        ]);
      });

      it('keeps the base reachable for emission through the inline model alone', async () => {
        // Nothing but the `400` body names `PetError`.
        const spec = await parse(document(openapi, getPet(oneRefBody), { Pet, PetError }), {
          collapseErrorBodies: false,
        });
        expect(modelOf(spec, 'GetPetError400')?.bases).toEqual([{ kind: 'model', name: 'PetError' }]);
        expect(collectReferencedNames(spec.services, spec.models).models.has('PetError')).toBe(true);
      });
    });

    describe('what is left as it was', () => {
      it('gives an inline `allOf` that names no component neither key', async () => {
        const inline = { allOf: [obj({ message: string }, ['message']), code] };
        const spec = await parse(
          document(openapi, { ...getPet(inline), ...createPet(json(inline)) }, { Pet, Holder: obj({ pet: inline }) }),
          { collapseErrorBodies: false },
        );
        for (const name of ['GetPetError400', 'CreatePetRequest', 'HolderPet']) {
          const model = modelOf(spec, name)!;
          expect(Object.keys(model), name).toEqual(['name', 'description', 'fields']);
          expect(
            model.fields.every((f) => !('inheritedFrom' in f)),
            name,
          ).toBe(true);
        }
      });

      it('reads an `allOf` of one `$ref` as the reference, and one that only annotates as its member', async () => {
        const spec = await parse(
          document(openapi, petPath(ok), {
            ...issueSchemas,
            Holder: obj({
              reference: { allOf: [R('PetError')] },
              described: { allOf: [R('PetError'), { description: 'The error.' }] },
            }),
          }),
        );
        expect(modelOf(spec, 'Holder')?.fields.map((f) => show(f.type))).toEqual(['PetError', 'PetError']);
        expect(spec.models.map((m) => m.name)).toEqual(['Pet', 'PetError', 'Retryable', 'Holder']);
      });

      it('types no component to learn whether it is a base', async () => {
        // An array component whose items are a union with a variant that merges the
        // component: noting the base while the component is being typed must not type it
        // again, which reported it as referring to itself through its items.
        const merged = { allOf: [R('Pets'), obj({ x: string })] };
        const self = await parse(
          document(openapi, petPath(ok), {
            Pet,
            Pets: { type: 'array', items: { oneOf: [merged, obj({ y: string })] } },
          }),
        );
        expect(self.models.map((m) => m.name)).toEqual(['Pet', 'PetsItem', 'PetsItemVariant1']);
        expect(warnings()).toEqual([]);
        // And an array component whose items no reader types is reported where it is typed,
        // not once more for each `allOf` that names it, inline or a component's.
        const odd = { type: 'array', items: { allOf: [string, { type: 'integer' }] } };
        const named = { allOf: [R('Odd'), code] };
        await parse(document(openapi, petPath(ok), { Pet, Odd: odd, Twin: named, Holder: obj({ pet: named }) }));
        expect(warnings()).toEqual(['[oagen] Warning: Unknown schema shape treated as unknown (context: item)']);
      });

      it('keeps the keys provenance, not shape: an inline body of a component’s name and shape is that component', async () => {
        // `GetPetResponse` is a component here; the `200` body spells its fields with the base.
        const GetPetResponse = obj({ message: string, code: string }, ['message']);
        const spec = await parse(
          document(openapi, petPath({ '200': { description: 'OK', ...json(oneRefBody) } }), {
            ...issueSchemas,
            GetPetResponse,
          }),
        );
        expect(show(operation(spec, 'getPet').response)).toBe('GetPetResponse');
        expect(models(spec)).toEqual(['GetPetResponse bases [] { message, code? }']);
        expect(warnings()).toEqual([]);
      });
    });

    describe('the error-body fold', () => {
      const plain = obj({ message: string, code: string }, ['message']);
      const based = (...names: string[]): Doc => ({ allOf: [...names.map(R), code] });
      /** One operation per body, each returning it under `400`. */
      const bodies = (each: Record<string, unknown>, schemas: Doc = issueSchemas): Doc =>
        document(
          openapi,
          Object.fromEntries(
            Object.entries(each).map(([operationId, schema], index) => [
              `/p${index}`,
              { get: { operationId, responses: { ...ok, '400': { description: 'Bad Request', ...json(schema) } } } },
            ]),
          ),
          schemas,
        );
      const fold = async (each: Record<string, unknown>, schemas?: Doc, options?: ParseOptions) => {
        const spec = await parse(bodies(each, schemas), options);
        return { errors: errors(spec), models: models(spec), warnings: warnings() };
      };

      it('keeps a body that names a base apart from one that names none, whichever path comes first', async () => {
        // The issue's neighbor: `fold.json`.
        const expected = {
          errors: ['getPet → GetPetError400', 'listPets → ErrorBody'],
          models: [
            'GetPetError400 bases [PetError] { message ← PetError, code? }',
            'ErrorBody bases [] { message, code? }',
          ],
          warnings: [
            '[oagen] Warning: The shared error body extends PetError { message: string, code?: string } would be named "ErrorBody", which the shared error body "ErrorBody" { message: string, code?: string } already holds — keeping model "GetPetError400" as it is; give the two the same shape, or rename one',
          ],
        };
        expect(await fold({ getPet: based('PetError'), listPets: plain })).toEqual(expected);
        warn.mockClear();
        const swapped = await fold({ listPets: plain, getPet: based('PetError') });
        expect(swapped.models).toEqual(expected.models);
        expect(swapped.errors).toEqual([...expected.errors].reverse());
        expect(swapped.warnings).toEqual(expected.warnings);
      });

      it('leaves both as the parser built them with the fold off', async () => {
        expect(
          await fold({ getPet: based('PetError'), listPets: plain }, issueSchemas, { collapseErrorBodies: false }),
        ).toEqual({
          errors: ['getPet → GetPetError400', 'listPets → ListPetsError400'],
          models: [
            'GetPetError400 bases [PetError] { message ← PetError, code? }',
            'ListPetsError400 bases [] { message, code? }',
          ],
          warnings: [],
        });
      });

      it('folds bodies that name the same bases in the same order onto one model that names them', async () => {
        expect(await fold({ getPet: based('PetError'), listPets: based('PetError') })).toEqual({
          errors: ['getPet → ErrorBody', 'listPets → ErrorBody'],
          models: ['ErrorBody bases [PetError] { message ← PetError, code? }'],
          warnings: [],
        });
        warn.mockClear();
        // An optional field is still no shape (#506): the shared model carries every one.
        expect(
          await fold({ getPet: based('PetError'), listPets: { allOf: [R('PetError'), obj({ hint: string })] } }),
        ).toEqual({
          errors: ['getPet → ErrorBody', 'listPets → ErrorBody'],
          models: ['ErrorBody bases [PetError] { message ← PetError, code?, hint? }'],
          warnings: [],
        });
      });

      it('keeps apart bodies that name other bases, or the same ones in another order', async () => {
        expect(await fold({ getPet: based('PetError'), listPets: based('PetError', 'Retryable') })).toEqual({
          errors: ['getPet → GetPetError400', 'listPets → ErrorBody'],
          models: [
            'GetPetError400 bases [PetError] { message ← PetError, code? }',
            'ErrorBody bases [PetError, Retryable] { message ← PetError, retryAfter? ← Retryable, code? }',
          ],
          warnings: [
            '[oagen] Warning: The shared error body extends PetError { message: string, code?: string } would be named "ErrorBody", which the shared error body "ErrorBody" extends PetError, Retryable { message: string, retryAfter?: integer, code?: string } already holds — keeping model "GetPetError400" as it is; give the two the same shape, or rename one',
          ],
        });
        warn.mockClear();
        expect(
          await fold({ getPet: based('PetError', 'Retryable'), listPets: based('Retryable', 'PetError') }),
        ).toEqual({
          errors: ['getPet → ErrorBody', 'listPets → ListPetsError400'],
          models: [
            'ListPetsError400 bases [Retryable, PetError] { retryAfter? ← Retryable, message ← PetError, code? }',
            'ErrorBody bases [PetError, Retryable] { message ← PetError, retryAfter? ← Retryable, code? }',
          ],
          warnings: [
            '[oagen] Warning: The shared error body extends Retryable, PetError { retryAfter?: integer, message: string, code?: string } would be named "ErrorBody", which the shared error body "ErrorBody" extends PetError, Retryable { message: string, retryAfter?: integer, code?: string } already holds — keeping model "ListPetsError400" as it is; give the two the same shape, or rename one',
          ],
        });
      });

      it('leaves the plain bodies their shared model however many bodies extend a component', async () => {
        expect(await fold({ a: based('PetError'), b: based('PetError'), c: plain, d: plain })).toEqual({
          errors: ['a → AError400', 'b → BError400', 'c → ErrorBody', 'd → ErrorBody'],
          models: [
            'AError400 bases [PetError] { message ← PetError, code? }',
            'BError400 bases [PetError] { message ← PetError, code? }',
            'ErrorBody bases [] { message, code? }',
          ],
          warnings: [
            '[oagen] Warning: The shared error body extends PetError { message: string, code?: string } would be named "ErrorBody", which the shared error body "ErrorBody" { message: string, code?: string } already holds — keeping models "AError400", "BError400" as they are; give the two the same shape, or rename one',
          ],
        });
      });

      it('shares the pinned codes of bodies on one base, and keeps the base while the field is its declaration', async () => {
        const pinned = (value: string): Doc => ({
          allOf: [R('PetError'), obj({ code: { type: 'string', const: value } }, ['code'])],
        });
        const spec = await parse(bodies({ getPet: pinned('not_found'), listPets: pinned('gone') }));
        expect(models(spec)).toEqual(['ErrorBodyWithCode bases [PetError] { message ← PetError, code }']);
        expect(spec.enums.map((e) => `${e.name} [${e.values.map((v) => v.value).join(', ')}]`)).toEqual([
          'ErrorBodyCode [gone, not_found]',
        ]);
        warn.mockClear();
        // A base that lists the values itself stays the base while the shared enum lists no more …
        const Coded = obj({ message: string, code: { type: 'string', enum: ['x', 'y'] } }, ['message', 'code']);
        const coded = (extra: string): Doc => ({ allOf: [R('Coded'), obj({ [extra]: string })] });
        expect(
          models(await parse(bodies({ getPet: coded('hint'), listPets: coded('other') }, { ...issueSchemas, Coded })), [
            ...Object.keys(issueSchemas),
            'Coded',
          ]),
        ).toEqual(['ErrorBodyWithCode bases [Coded] { message ← Coded, code ← Coded, hint?, other? }']);
      });

      it('reads a nested error body’s bases with its parent’s', async () => {
        const parent = (detail: unknown): Doc => obj({ message: string, detail }, ['message', 'detail']);
        const nested = await fold({
          getPet: parent(based('Retryable')),
          listPets: parent(obj({ retryAfter: { type: 'integer' }, code: string })),
        });
        expect(nested.errors).toEqual([
          'getPet → GetPetError400',
          'listPets → ErrorBodyWithCodeRetryAfterIntegerDetail',
        ]);
        expect(nested.models).toEqual([
          'GetPetError400 bases [] { message, detail }',
          'GetPetError400Detail bases [Retryable] { retryAfter? ← Retryable, code? }',
          'ErrorBodyWithCodeRetryAfterIntegerDetail bases [] { message, detail }',
          'ErrorBodyWithCodeRetryAfterIntegerDetailDetail bases [] { retryAfter?, code? }',
        ]);
        warn.mockClear();
        // Alone, the nested body takes the name its parent and field give it, with its base.
        expect((await fold({ getPet: parent(based('Retryable')) })).models).toEqual([
          'ErrorBodyWithCodeRetryAfterIntegerDetail bases [] { message, detail }',
          'ErrorBodyWithCodeRetryAfterIntegerDetailDetail bases [Retryable] { retryAfter? ← Retryable, code? }',
        ]);
      });

      describe('a component schema that holds the shared name', () => {
        const componentPlain = obj({ message: string, code: string }, ['message']);
        const componentBased = { allOf: [R('PetError')], properties: { code: string } };
        const holding = (body: unknown, ErrorBody: unknown, more: Doc = {}) =>
          fold({ getPet: body }, { ...issueSchemas, ...more, ErrorBody });

        it('takes a body that names no base, whatever the component is built on, as before', async () => {
          expect(await holding(plain, componentPlain)).toEqual({
            errors: ['getPet → ErrorBody'],
            models: ['ErrorBody bases [] { message, code? }'],
            warnings: [],
          });
          expect(await holding(plain, componentBased)).toEqual({
            errors: ['getPet → ErrorBody'],
            models: ['ErrorBody bases [PetError] { code?, message ← PetError }'],
            warnings: [],
          });
        });

        it('tells a body that names no base of the component as it always did, its bases unsaid', async () => {
          // The component differs in a field's type, not in what it is built on.
          const narrower = { allOf: [R('PetError')], properties: { code: { type: 'integer' } } };
          expect(await holding(plain, narrower)).toEqual({
            errors: ['getPet → GetPetError400'],
            models: [
              'ErrorBody bases [PetError] { code?, message ← PetError }',
              'GetPetError400 bases [] { message, code? }',
            ],
            warnings: [
              '[oagen] Warning: The shared error body { message: string, code?: string } would be named "ErrorBody", which component schema "ErrorBody" { code?: integer, message: string } already holds — keeping model "GetPetError400" as it is; give the two the same shape, or rename one',
            ],
          });
        });

        it('takes a body that names bases only where it names the same ones', async () => {
          expect(await holding(based('PetError'), componentBased)).toEqual({
            errors: ['getPet → ErrorBody'],
            models: ['ErrorBody bases [PetError] { code?, message ← PetError }'],
            warnings: [],
          });
          warn.mockClear();
          expect(await holding(based('PetError'), componentPlain)).toEqual({
            errors: ['getPet → GetPetError400'],
            models: [
              'ErrorBody bases [] { message, code? }',
              'GetPetError400 bases [PetError] { message ← PetError, code? }',
            ],
            warnings: [
              '[oagen] Warning: The shared error body extends PetError { message: string, code?: string } would be named "ErrorBody", which component schema "ErrorBody" { message: string, code?: string } already holds — keeping model "GetPetError400" as it is; give the two the same shape, or rename one',
            ],
          });
          warn.mockClear();
          const Other = obj({ message: string }, ['message']);
          const onOther = { allOf: [R('Other')], properties: { code: string } };
          expect(await holding(based('PetError'), onOther, { Other })).toEqual({
            errors: ['getPet → GetPetError400'],
            models: [
              'Other bases [] { message }',
              'ErrorBody bases [Other] { code?, message ← Other }',
              'GetPetError400 bases [PetError] { message ← PetError, code? }',
            ],
            warnings: [
              '[oagen] Warning: The shared error body extends PetError { message: string, code?: string } would be named "ErrorBody", which component schema "ErrorBody" extends Other { code?: string, message: string } already holds — keeping model "GetPetError400" as it is; give the two the same shape, or rename one',
            ],
          });
        });
      });

      it('folds bodies whose `allOf` names no component exactly as before', async () => {
        const inline = { allOf: [obj({ message: string }, ['message']), code] };
        expect(
          await fold(
            { getPet: inline, listPets: plain, a: { allOf: [R('Kind'), plain] } },
            { ...issueSchemas, Kind: { type: 'string', enum: ['cat'] } },
          ),
        ).toEqual({
          errors: ['getPet → ErrorBody', 'listPets → ErrorBody', 'a → ErrorBody'],
          models: ['ErrorBody bases [] { message, code? }'],
          warnings: [],
        });
      });
    });

    describe('`oagen diff`', () => {
      const plain = obj({ message: string, code: string }, ['message']);
      const one = (body: unknown, schemas: Doc = issueSchemas): Doc => document(openapi, getPet(body), schemas);
      const two = (first: unknown): Doc =>
        document(
          openapi,
          {
            ...getPet(first),
            '/pets': {
              get: { operationId: 'listPets', responses: { ...ok, '400': { description: 'Bad', ...json(plain) } } },
            },
          },
          issueSchemas,
        );

      it('sees nothing between a body that names its base and one that spells the fields, as between two components', async () => {
        const pairs: ReadonlyArray<readonly [string, Doc, Doc]> = [
          ['an error body', one(plain), one(oneRefBody)],
          [
            'a component',
            one(R('BadRequest'), { ...issueSchemas, BadRequest: plain }),
            one(R('BadRequest'), { ...issueSchemas, BadRequest: oneRefBody }),
          ],
          [
            'a success body',
            document(openapi, petPath({ '200': { description: 'OK', ...json(plain) } }), issueSchemas),
            document(openapi, petPath({ '200': { description: 'OK', ...json(oneRefBody) } }), issueSchemas),
          ],
          [
            'a field',
            document(openapi, petPath(ok), { ...issueSchemas, Holder: obj({ pet: plain }) }),
            document(openapi, petPath(ok), { ...issueSchemas, Holder: obj({ pet: oneRefBody }) }),
          ],
        ];
        for (const [label, spelled, named] of pairs) {
          expect(await diffLines(spelled, named), label).toEqual([]);
          expect(await diffLines(named, spelled), label).toEqual([]);
          expect(await diffExit(spelled, named), label).toBe(0);
          expect(await diffExit(named, spelled), label).toBe(0);
        }
      });

      it('reports the move where the fold keeps the body apart: additive to the new model, breaking back', async () => {
        // `listPets` holds `ErrorBody`; `getPet`'s body leaves it once it names `PetError`.
        expect(await diffLines(two(plain), two(oneRefBody))).toEqual([
          'model-added GetPetError400: additive',
          'operation-modified getPet: additive',
        ]);
        expect(await diffExit(two(plain), two(oneRefBody))).toBe(1);
        expect(await diffLines(two(oneRefBody), two(plain))).toEqual([
          'model-removed GetPetError400: breaking',
          'operation-modified getPet: additive',
        ]);
        expect(await diffExit(two(oneRefBody), two(plain))).toBe(2);
      });
    });
  });

  describe('the inline merge', () => {
    const schemas = {
      PetError,
      Retryable,
      Hop: R('PetError'),
      Living: obj({ born: string }),
      Animal: { allOf: [R('Living')], properties: { name: string } },
    } as unknown as Record<string, SchemaObject>;
    const provenanceOf = (schema: unknown): string => {
      const { provenance: read, resolvedRefs } = mergeAllOfMembers(schema as SchemaObject, schemas);
      const inherited = [...read.inheritedFrom].map(([name, base]) => `${name} ← ${base.name}`);
      return `bases [${read.bases.map(show).join(', ')}] { ${inherited.join(', ')} } refs ${resolvedRefs.length}`;
    };

    it('notes the direct bases alone, where `resolvedRefs` lists every `$ref` followed', () => {
      expect(provenanceOf({ allOf: [R('Animal'), code] })).toBe(
        'bases [Animal] { name ← Animal, born ← Animal } refs 2',
      );
      expect(provenanceOf({ allOf: [R('Hop'), code] })).toBe('bases [Hop] { message ← Hop } refs 2');
      expect(provenanceOf(issueBody)).toBe(
        'bases [PetError, Retryable] { message ← PetError, retryAfter ← Retryable } refs 2',
      );
      expect(provenanceOf({ allOf: [code, obj({ a: string })] })).toBe('bases [] {  } refs 0');
    });

    it('lists `required` as it did: every always-applying list, each name once, in order', () => {
      const merged = mergeAllOfMembers(
        {
          allOf: [R('PetError'), { required: ['code', 'message'] }, obj({ code: string }, ['code'])],
          required: ['zeta'],
        } as SchemaObject,
        schemas,
      );
      expect(merged.required).toEqual(['zeta', 'message', 'code']);
    });
  });
});
