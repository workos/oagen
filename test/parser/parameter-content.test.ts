import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations, parameterSchema, selectParameterContent } from '../../src/parser/operations.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { collectInlineEnumsFromOperations } from '../../src/parser/collect-inline-enums.js';
import { collectModelRefs, collectResponseHeaders, collectWebhookTypeRefs, walkTypeRef } from '../../src/ir/types.js';
import type { ApiSpec, Enum, Model, Operation, Parameter, TypeRef, Webhook } from '../../src/ir/types.js';

/**
 * Issue #297: a Parameter Object may declare a single-entry `content` map
 * instead of `schema`. Such a parameter must be typed from that entry's
 * schema — with the description, externalDocs, inline enum or model it
 * declares — exactly as a `schema` parameter is, in every location, on an
 * operation and on a webhook, and a response header declared with `content`
 * must be read by the same media type rule.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

let warn: ReturnType<typeof vi.spyOn>;
/** Every warning printed so far, in order. */
const warnings = (): unknown[] => warn.mock.calls.map((call: unknown[]) => call[0]);
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function parseDocument(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-297-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

const document = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'repro', version: '1' },
  paths,
  ...extra,
});

/** A GET with the given parameters and an empty 200. */
const getOp = (operationId: string, parameters: unknown[], extra: Record<string, unknown> = {}) => ({
  get: { operationId, parameters, responses: { '200': { description: 'ok' } }, ...extra },
});

/** A `content` map with one entry under `mediaType`. */
const content = (mediaType: string, media: Record<string, unknown> = {}) => ({ content: { [mediaType]: media } });

const mood = {
  type: 'string',
  enum: ['calm', 'busy'],
  description: 'The mood.',
  externalDocs: { url: 'https://docs.example.com/mood' },
};

const typeLabel = (type: TypeRef) => `${type.kind} ${'name' in type ? type.name : 'type' in type ? type.type : ''}`;
const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
const paramsOf = (op: Operation): Parameter[] => [
  ...op.pathParams,
  ...op.queryParams,
  ...op.headerParams,
  ...(op.cookieParams ?? []),
  ...(op.bodyOwnedQueryParams ?? []),
];
/** A parameter without the media type it is serialized in, to compare a `content` twin with its `schema` twin. */
const withoutContentType = (p: Parameter): Partial<Parameter> =>
  Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'contentType'));
const namesIn = (ref: TypeRef, kind: 'model' | 'enum'): string[] => {
  const names: string[] = [];
  walkTypeRef(ref, { [kind]: (node: { name: string }) => names.push(node.name) });
  return names;
};

/** Every type reference an operation or webhook holds, labelled by where it sits. */
function allRefs(spec: ApiSpec): Array<[string, TypeRef]> {
  const refs: Array<[string, TypeRef]> = [];
  for (const op of Object.values(opsOf(spec))) {
    refs.push([`${op.name}.response`, op.response]);
    if (op.requestBody) refs.push([`${op.name}.requestBody`, op.requestBody]);
    for (const e of op.errors) if (e.type) refs.push([`${op.name}.${e.statusCode}`, e.type]);
    for (const h of collectResponseHeaders(op)) refs.push([`${op.name}.${h.name}`, h.type]);
    for (const p of paramsOf(op)) refs.push([`${op.name}(${p.name})`, p.type]);
  }
  for (const hook of spec.webhooks ?? []) {
    for (const ref of collectWebhookTypeRefs(hook)) refs.push([`webhook ${hook.name}`, ref]);
  }
  for (const model of spec.models) for (const f of model.fields) refs.push([`${model.name}.${f.name}`, f.type]);
  return refs;
}

/** Every model or enum reference, from operations, webhooks and model fields alike, that names nothing. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const models = new Set(spec.models.map((m) => m.name));
  const enums = new Set(spec.enums.map((e) => e.name));
  const found: string[] = [];
  for (const [owner, ref] of allRefs(spec)) {
    for (const name of collectModelRefs(ref)) if (!models.has(name)) found.push(`${owner} → ${name}`);
    for (const name of namesIn(ref, 'enum')) if (!enums.has(name)) found.push(`${owner} → enum ${name}`);
  }
  return found.sort();
}

/** Every model or enum that is neither a component nor referenced from anywhere. */
function orphans(spec: ApiSpec, componentNames: string[] = []): string[] {
  const referenced = new Set<string>();
  for (const [, ref] of allRefs(spec)) {
    for (const name of collectModelRefs(ref)) referenced.add(name);
    for (const name of namesIn(ref, 'enum')) referenced.add(name);
  }
  return [...spec.models.map((m) => m.name), ...spec.enums.map((e) => e.name)]
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

function expectSound(spec: ApiSpec, componentNames: string[] = []): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphans(spec, componentNames)).toEqual([]);
}

const unreadWarning = (subject: string, mediaTypes: string) =>
  `[oagen] Warning: ${subject} is typed as a string: none of its content media types (${mediaTypes}) is read. ` +
  `A parameter or response header declared with content is read from application/json or a +json media type ` +
  `when the entry declares a schema, and from text/plain with or without one, parameters and case aside.`;

describe('a parameter declared with `content` instead of `schema` (issue #297)', () => {
  it('reproduces the issue: typed from the single content entry, with its description and externalDocs', async () => {
    const spec = await parseDocument(
      document({
        '/notes': getOp('listNotes', [{ name: 'mood', in: 'query', ...content('application/json', { schema: mood }) }]),
        '/notes/recent': getOp('listRecentNotes', [{ name: 'mood', in: 'query', schema: mood }]),
      }),
    );

    expect(spec.enums.map(({ name }) => name)).toEqual(['NotesMood']);
    const seen = spec.services
      .flatMap(({ operations }) => operations)
      .map(({ name, queryParams: [{ description, externalDocs, type }] }) => ({
        name,
        mood: { type: typeLabel(type), description, externalDocs },
      }));
    expect(seen).toEqual([
      {
        name: 'listNotes',
        mood: {
          type: 'enum NotesMood',
          description: 'The mood.',
          externalDocs: { url: 'https://docs.example.com/mood' },
        },
      },
      {
        name: 'listRecentNotes',
        mood: {
          type: 'enum NotesMood',
          description: 'The mood.',
          externalDocs: { url: 'https://docs.example.com/mood' },
        },
      },
    ]);
    // Nothing printed before the output.
    expect(warn).not.toHaveBeenCalled();
    expectSound(spec);
  });

  it('types a parameter of every location exactly as its `schema` twin, body-owned query parameters included', async () => {
    const schemas = {
      id: { type: 'integer', minimum: 1, description: 'The id.' },
      mood,
      trace: { type: 'string', format: 'uuid', minLength: 36, deprecated: true, default: 'none', example: 'abc' },
      session: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      note: { type: 'object', properties: { body: { type: 'string' } } },
    };
    const declared = (via: (schema: unknown) => Record<string, unknown>) => [
      { name: 'id', in: 'path', required: true, ...via(schemas.id) },
      { name: 'mood', in: 'query', ...via(schemas.mood) },
      { name: 'X-Trace', in: 'header', ...via(schemas.trace) },
      { name: 'session', in: 'cookie', ...via(schemas.session) },
      // Declared both as a query parameter and as a body property: body-owned
      // on a POST, kept on the operation and typed like the others.
      { name: 'body', in: 'query', ...via({ type: 'string' }) },
    ];
    const post = (operationId: string, parameters: unknown[]) => ({
      post: {
        operationId,
        parameters,
        requestBody: { content: { 'application/json': { schema: schemas.note } } },
        responses: { '200': { description: 'ok' } },
      },
    });
    const spec = await parseDocument(
      document({
        '/notes/{id}': post(
          'createNote',
          declared((schema) => content('application/json', { schema })),
        ),
        '/notes/{id}/copies': post(
          'copyNote',
          declared((schema) => ({ schema })),
        ),
      }),
    );

    const { createNote, copyNote } = opsOf(spec);
    expect(paramsOf(createNote).map((p) => p.name)).toEqual(['id', 'mood', 'X-Trace', 'session', 'body']);
    // Identical but for the media type the value is serialized in, which
    // only the `content` twin carries.
    expect(paramsOf(createNote).map(withoutContentType)).toEqual(paramsOf(copyNote));
    expect(paramsOf(createNote).map((p) => p.contentType)).toEqual(Array(5).fill('application/json'));
    expect(paramsOf(copyNote).some((p) => 'contentType' in p)).toBe(false);
    expect(paramsOf(createNote).map((p) => typeLabel(p.type))).toEqual([
      'primitive integer',
      'enum NotesMood',
      'primitive string',
      'array ',
      'primitive string',
    ]);
    const trace = createNote.headerParams[0];
    expect(trace).toMatchObject({
      deprecated: true,
      default: 'none',
      example: 'abc',
      constraints: { minLength: 36 },
      type: { kind: 'primitive', type: 'string', format: 'uuid' },
    });
    expect(createNote.pathParams[0].description).toBe('The id.');
    expect(spec.enums.map((e) => e.name)).toEqual(['NotesMood', 'NotesSession']);
    expect(warn).not.toHaveBeenCalled();
    expectSound(spec);
  });

  it('mints an inline object under `content` through the parameter path, in every location, so its model exists', async () => {
    const filter = {
      type: 'object',
      properties: { tag: { type: 'string' }, owner: { type: 'object', properties: { id: { type: 'string' } } } },
    };
    const spec = await parseDocument(
      document({
        '/notes': getOp('listNotes', [
          { name: 'filter', in: 'query', style: 'deepObject', ...content('application/json', { schema: filter }) },
          { name: 'X-Scope', in: 'header', ...content('application/json', { schema: filter }) },
          { name: 'prefs', in: 'cookie', ...content('application/json', { schema: filter }) },
        ]),
        '/notes/recent': getOp('listRecentNotes', [
          { name: 'filter', in: 'query', style: 'deepObject', schema: filter },
          { name: 'X-Scope', in: 'header', schema: filter },
          { name: 'prefs', in: 'cookie', schema: filter },
        ]),
      }),
    );

    const { listNotes, listRecentNotes } = opsOf(spec);
    expect(paramsOf(listNotes).map(withoutContentType)).toEqual(paramsOf(listRecentNotes));
    expect(paramsOf(listNotes).map((p) => p.contentType)).toEqual(Array(3).fill('application/json'));
    // `prefs` is singularized by the model naming, as for a `schema` parameter.
    expect(paramsOf(listNotes).map((p) => typeLabel(p.type))).toEqual([
      'model NotesFilter',
      'model NotesXScope',
      'model NotesPref',
    ]);
    expect(spec.models.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
      ['NotesFilter', ['tag', 'owner']],
      ['NotesFilterOwner', ['id']],
      ['NotesXScope', ['tag', 'owner']],
      ['NotesXScopeOwner', ['id']],
      ['NotesPref', ['tag', 'owner']],
      ['NotesPrefOwner', ['id']],
    ]);
    expect(warn).not.toHaveBeenCalled();
    expectSound(spec);
  });

  it('carries the content key the value is serialized under, as written, wherever a parameter is read from content', async () => {
    const spec = await parseDocument(
      document(
        {
          '/notes/{id}': {
            // A path-level parameter, merged into the operation.
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                ...content('application/json; charset=utf-8', { schema: { type: 'integer' } }),
              },
            ],
            ...getOp('listNotes', [
              { $ref: '#/components/parameters/Mood' },
              // A schema-less text/plain entry is read: the string is sent as text.
              { name: 'note', in: 'query', ...content('TEXT/PLAIN; charset=utf-8') },
              { name: 'plain', in: 'query', schema: { type: 'string' } },
              {
                name: 'both',
                in: 'query',
                schema: { type: 'integer' },
                ...content('application/json', { schema: mood }),
              },
              // Not read: the string is sent as written, so no media type.
              { name: 'blob', in: 'header', ...content('image/png', { schema: { type: 'string' } }) },
            ]),
          },
        },
        {
          components: {
            parameters: {
              Mood: { name: 'mood', in: 'query', ...content('application/vnd.api+json', { schema: mood }) },
            },
          },
          webhooks: {
            noteAdded: {
              post: {
                parameters: [
                  { name: 'X-Mood', in: 'header', ...content('application/json', { schema: mood }) },
                  { name: 'tag', in: 'query', schema: { type: 'string' } },
                ],
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        },
      ),
    );

    const { listNotes } = opsOf(spec);
    expect(paramsOf(listNotes).map((p) => [p.name, p.contentType])).toEqual([
      ['id', 'application/json; charset=utf-8'],
      ['mood', 'application/vnd.api+json'],
      ['note', 'TEXT/PLAIN; charset=utf-8'],
      ['plain', undefined],
      ['both', undefined],
      ['blob', undefined],
    ]);
    // Absent, not set to `undefined`, where it does not apply.
    for (const name of ['plain', 'both', 'blob']) {
      expect(paramsOf(listNotes).find((p) => p.name === name)).not.toHaveProperty('contentType');
    }
    const [noteAdded] = spec.webhooks!;
    expect(noteAdded.headerParams[0]).toMatchObject({ name: 'X-Mood', contentType: 'application/json' });
    expect(noteAdded.queryParams[0]).not.toHaveProperty('contentType');
    expect(warnings()).toEqual([unreadWarning('Parameter "blob" (in: header) on listNotes', 'image/png')]);
    expectSound(spec);
  });

  it('reads the entry by media type essence: parameters and case aside, a +json type, and text/plain with or without a schema', () => {
    const { services } = extractOperations(
      document({
        '/notes': getOp('listNotes', [
          { name: 'a', in: 'query', ...content('application/json; charset=utf-8', { schema: { type: 'integer' } }) },
          { name: 'b', in: 'query', ...content('APPLICATION/JSON', { schema: { type: 'boolean' } }) },
          { name: 'c', in: 'query', ...content('application/vnd.api+json', { schema: { type: 'number' } }) },
          { name: 'd', in: 'query', ...content('text/plain', { schema: { type: 'integer' } }) },
          { name: 'e', in: 'query', ...content('TEXT/PLAIN; charset=utf-8') },
        ]),
      }).paths as never,
    );

    expect(services[0].operations[0].queryParams.map((p) => typeLabel(p.type))).toEqual([
      'primitive integer',
      'primitive boolean',
      'primitive number',
      'primitive integer',
      'primitive string',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('prefers a JSON entry over a text/plain one whatever the document order, and `schema` over `content`', () => {
    const { services } = extractOperations(
      document({
        '/notes': getOp('listNotes', [
          {
            name: 'ordered',
            in: 'query',
            content: {
              'text/plain': { schema: { type: 'integer' } },
              'application/json': { schema: { type: 'boolean' } },
            },
          },
          // A JSON entry without a schema is not read; the text/plain one is.
          {
            name: 'tiered',
            in: 'query',
            content: { 'application/json': {}, 'text/plain': { schema: { type: 'number' } } },
          },
          { name: 'both', in: 'query', schema: { type: 'integer' }, ...content('application/json', { schema: mood }) },
        ]),
      }).paths as never,
    );

    expect(services[0].operations[0].queryParams.map((p) => typeLabel(p.type))).toEqual([
      'primitive boolean',
      'primitive number',
      'primitive integer',
    ]);
    expect(selectParameterContent({ 'image/png': { schema: { type: 'string' } }, 'text/plain': {} })).toEqual({
      contentType: 'text/plain',
      media: {},
    });
    expect(parameterSchema({ schema: { type: 'integer' }, content: { 'application/json': { schema: mood } } })).toEqual(
      {
        type: 'integer',
      },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('types the parameter as a string and warns once per site when no media type is read', async () => {
    const spec = await parseDocument(
      document(
        {
          '/notes': getOp('listNotes', [
            { name: 'blob', in: 'query', ...content('image/png', { schema: { type: 'string', format: 'binary' } }) },
            { name: 'xml', in: 'header', ...content('application/xml', { schema: { type: 'object' } }) },
            { name: 'schemaless', in: 'query', ...content('application/json') },
            { name: 'empty', in: 'query', content: {} },
            { name: 'shared', in: 'query', $ref: '#/components/parameters/Shared' },
            // Not typed, so not reported.
            { name: 'Idempotency-Key', in: 'header', ...content('image/png', { schema: { type: 'string' } }) },
          ]),
          '/notes/recent': getOp('listRecentNotes', [{ $ref: '#/components/parameters/Shared' }]),
        },
        {
          components: {
            parameters: {
              Shared: { name: 'shared', in: 'query', ...content('text/csv', { schema: { type: 'string' } }) },
            },
          },
        },
      ),
    );

    const { listNotes, listRecentNotes } = opsOf(spec);
    expect(paramsOf(listNotes).map((p) => [p.name, typeLabel(p.type)])).toEqual([
      ['blob', 'primitive string'],
      ['schemaless', 'primitive string'],
      ['empty', 'primitive string'],
      ['shared', 'primitive string'],
      ['xml', 'primitive string'],
    ]);
    expect(listRecentNotes.queryParams.map((p) => typeLabel(p.type))).toEqual(['primitive string']);
    expect(warnings()).toEqual([
      unreadWarning('Parameter "blob" (in: query) on listNotes', 'image/png'),
      unreadWarning('Parameter "xml" (in: header) on listNotes', 'application/xml'),
      unreadWarning('Parameter "schemaless" (in: query) on listNotes', 'application/json'),
      unreadWarning('Parameter "shared" (in: query) on listNotes', 'text/csv'),
      unreadWarning('Parameter "shared" (in: query) on listRecentNotes', 'text/csv'),
    ]);
    expect(spec.models).toEqual([]);
  });

  it("reads examples from the Media Type Object, between the parameter's own and the schema's", () => {
    const { services } = extractOperations(
      document({
        '/notes': getOp('listNotes', [
          {
            name: 'own',
            in: 'query',
            example: 'parameter',
            ...content('application/json', { schema: { type: 'string', example: 'schema' }, example: 'media' }),
          },
          {
            name: 'media',
            in: 'query',
            ...content('application/json', {
              schema: { type: 'string', example: 'schema', examples: ['schema-list'] },
              examples: { first: { value: 'media-1' }, second: { $ref: '#/components/examples/Second' } },
            }),
          },
          {
            name: 'schema',
            in: 'query',
            ...content('application/json', { schema: { type: 'string', example: 'schema' } }),
          },
        ]),
      }).paths as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { Second: { value: 'media-2' } },
    );

    const byName = Object.fromEntries(services[0].operations[0].queryParams.map((p) => [p.name, p]));
    expect(byName.own.example).toBe('parameter');
    expect(byName.own).not.toHaveProperty('examples');
    expect(byName.media.example).toBe('media-1');
    expect(byName.media.examples).toEqual(['media-1', 'media-2']);
    expect(byName.schema.example).toBe('schema');
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the page start from a `page` parameter declared with content', async () => {
    const page = (schema: Record<string, unknown>) => ({
      name: 'page',
      in: 'query',
      ...content('application/json', { schema }),
    });
    const list = (schema: Record<string, unknown>) =>
      document({
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [page(schema), { name: 'limit', in: 'query', schema: { type: 'integer' } }],
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        pets: { type: 'array', items: { type: 'string' } },
                        pagination: {
                          type: 'object',
                          properties: { page: { type: 'integer' }, totalPages: { type: 'integer' } },
                          required: ['page', 'totalPages'],
                        },
                      },
                      required: ['pets', 'pagination'],
                    },
                  },
                },
              },
            },
          },
        },
      });
    const start = async (schema: Record<string, unknown>) =>
      opsOf(await parseDocument(list(schema))).listPets.pagination?.pageStart;

    expect(await start({ type: 'integer', default: 0 })).toBe(0);
    expect(await start({ type: 'integer', minimum: 0 })).toBe(0);
    expect(await start({ type: 'integer' })).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a webhook parameter declared with `content` (the `mintParameter` twin)', () => {
  const meta = { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['x', 'y'] } } };
  const hook = (via: (schema: unknown) => Record<string, unknown>, extra: unknown[] = []) => ({
    post: {
      parameters: [
        { name: 'X-Meta', in: 'header', ...via(meta) },
        { name: 'mood', in: 'query', ...via(mood) },
        { name: 'session', in: 'cookie', ...via({ type: 'string', minLength: 1 }) },
        ...extra,
      ],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
      },
      responses: { '200': { description: 'ok' } },
    },
  });
  /**
   * A webhook's parameter types and models with its stem replaced, so two
   * stems can be compared; the media type only a `content` twin carries is
   * left out and asserted on its own.
   */
  const shape = (hook: Webhook, models: Model[], stem: string) =>
    JSON.parse(
      JSON.stringify({
        header: hook.headerParams.map(withoutContentType),
        query: hook.queryParams.map(withoutContentType),
        cookie: hook.cookieParams?.map(withoutContentType),
        models: models.filter((m) => m.name.startsWith(stem)),
      }).replaceAll(stem, 'Stem'),
    );

  it('types header, query and cookie parameters from the content entry and mints under the stem', () => {
    const { webhooks, inlineModels } = extractWebhooks({
      petAdopted: hook((schema) => content('application/json; charset=utf-8', { schema })),
      petReturned: hook((schema) => ({ schema })),
    });

    const [adopted, returned] = webhooks;
    // The key as written travels with each `content` parameter; the `schema` twin carries none.
    for (const list of [adopted.headerParams, adopted.queryParams, adopted.cookieParams!]) {
      expect(list.map((p) => p.contentType)).toEqual(['application/json; charset=utf-8']);
    }
    for (const list of [returned.headerParams, returned.queryParams, returned.cookieParams!]) {
      expect(list.some((p) => 'contentType' in p)).toBe(false);
    }
    expect(adopted.headerParams[0].type).toEqual({ kind: 'model', name: 'PetAdoptedXMeta' });
    expect(adopted.queryParams[0].type).toEqual({ kind: 'enum', name: 'PetAdoptedMood', values: ['calm', 'busy'] });
    expect(adopted.cookieParams?.[0]).toMatchObject({
      type: { kind: 'primitive', type: 'string' },
      constraints: { minLength: 1 },
    });
    expect(shape(adopted, inlineModels, 'PetAdopted')).toEqual(shape(returned, inlineModels, 'PetReturned'));
    expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
      ['PetAdoptedPayload', ['ok']],
      ['PetAdoptedXMeta', ['id', 'kind']],
      ['PetReturnedPayload', ['ok']],
      ['PetReturnedXMeta', ['id', 'kind']],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per unread parameter although the mint runs twice, and keeps the parameter a string', async () => {
    const spec = await parseDocument(
      document(
        {},
        {
          webhooks: {
            petAdopted: hook(
              (schema) => content('application/json', { schema }),
              [{ name: 'blob', in: 'query', ...content('image/png', { schema: { type: 'string' } }) }],
            ),
          },
        },
      ),
    );

    const [adopted] = spec.webhooks!;
    expect(adopted.queryParams.map((p) => [p.name, typeLabel(p.type)])).toEqual([
      ['mood', 'enum PetAdoptedMood'],
      ['blob', 'primitive string'],
    ]);
    expect(warnings()).toEqual([
      unreadWarning('Parameter "blob" (in: query) on webhooks.petAdopted.post', 'image/png'),
    ]);
    expect(spec.models.map((m) => m.name)).toEqual(['PetAdoptedPayload', 'PetAdoptedXMeta']);
    expect(spec.enums.map((e) => e.name)).toEqual(['PetAdoptedXMetaKind', 'PetAdoptedMood']);
    expectSound(spec);
  });
});

describe('a response header declared with `content`', () => {
  const getWithHeaders = (headers: Record<string, unknown>, responses: Record<string, unknown> = {}) =>
    document({
      '/documents': {
        get: {
          operationId: 'listDocuments',
          responses: { '200': { description: 'ok', headers }, ...responses },
        },
      },
    });
  const meta = { type: 'object', properties: { etag: { type: 'string' } } };

  it('picks the entry by essence, materializes an object under it, and warns once when none is read', () => {
    const { services, inlineModels } = extractOperations(
      getWithHeaders({
        'X-Meta': content('application/json; charset=utf-8', { schema: meta }),
        'X-Count': content('TEXT/PLAIN', { schema: { type: 'integer' } }),
        'X-Opaque': content('text/plain'),
        'X-Blob': content('image/png', { schema: { type: 'string', format: 'binary' } }),
        'X-Schemaless': content('application/json'),
        'X-Both': { schema: { type: 'integer' }, ...content('application/json', { schema: meta }) },
      }).paths as never,
    );

    const [op] = services[0].operations;
    expect(op.responseHeaders!.map((h) => [h.name, typeLabel(h.type)])).toEqual([
      ['X-Meta', 'model DocumentsXMeta'],
      ['X-Count', 'primitive integer'],
      ['X-Opaque', 'primitive string'],
      ['X-Blob', 'primitive string'],
      ['X-Schemaless', 'primitive string'],
      ['X-Both', 'primitive integer'],
    ]);
    expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([['DocumentsXMeta', ['etag']]]);
    expect(warnings()).toEqual([
      unreadWarning('Response header "X-Blob" (200) in listDocuments', 'image/png'),
      unreadWarning('Response header "X-Schemaless" (200) in listDocuments', 'application/json'),
    ]);
  });

  it('reads a components/headers ref, and the headers of error, default and range responses, by the same rule', async () => {
    const spec = await parseDocument({
      ...getWithHeaders(
        { 'X-Meta': { $ref: '#/components/headers/Meta' } },
        {
          '429': {
            description: 'slow down',
            headers: { 'Retry-After': content('text/plain', { schema: { type: 'integer', minimum: 0 } }) },
          },
          '5XX': {
            description: 'server error',
            headers: { 'X-Incident': content('application/json', { schema: meta }) },
          },
          default: {
            description: 'other',
            headers: { 'X-Unread': content('image/png', { schema: { type: 'string' } }) },
          },
        },
      ),
      components: { headers: { Meta: content('application/vnd.api+json', { schema: meta }) } },
    });

    const { listDocuments } = opsOf(spec);
    expect(collectResponseHeaders(listDocuments).map((h) => [h.name, typeLabel(h.type)])).toEqual([
      ['X-Meta', 'model DocumentsXMeta'],
      ['Retry-After', 'primitive integer'],
      ['X-Unread', 'primitive string'],
      ['X-Incident', 'model DocumentsXIncident'],
    ]);
    expect(spec.models.map((m) => m.name)).toEqual(['DocumentsXMeta', 'DocumentsXIncident']);
    expect(warnings()).toEqual([unreadWarning('Response header "X-Unread" (Default) in listDocuments', 'image/png')]);
    expectSound(spec);
  });

  it('lifts an inline enum declared under a header content entry like one under a parameter', () => {
    const { services, inlineModels } = extractOperations(
      document({
        '/documents': getOp(
          'listDocuments',
          [{ name: 'policy', in: 'query', ...content('application/json', { schema: mood }) }],
          {
            responses: {
              '200': { description: 'ok', headers: { 'X-Policy': content('application/json', { schema: mood }) } },
            },
          },
        ),
      }).paths as never,
    );
    const enums: Enum[] = [];
    collectInlineEnumsFromOperations(services, enums, inlineModels);

    const [op] = services[0].operations;
    expect(op.queryParams[0].type).toEqual({ kind: 'enum', name: 'DocumentsPolicy', values: ['calm', 'busy'] });
    expect(op.responseHeaders![0].type).toEqual({ kind: 'enum', name: 'DocumentsXPolicy', values: ['calm', 'busy'] });
    expect(enums.map((e) => e.name)).toEqual(['DocumentsPolicy', 'DocumentsXPolicy']);
    expect(warn).not.toHaveBeenCalled();
  });
});
