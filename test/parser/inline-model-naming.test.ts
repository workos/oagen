import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { derivePathBasedName } from '../../src/parser/operations.js';
import { mergeInlineResponseModels } from '../../src/parser/normalize-inline-models.js';
import { toPascalCase } from '../../src/utils/naming.js';
import type { Model, Operation } from '../../src/ir/types.js';

/**
 * Helper: write a spec object to a temp file, parse it, return the IR.
 * Cleans up the temp dir on completion.
 */
async function parseInline<T>(spec: object, fn: (ir: Awaited<ReturnType<typeof parseSpec>>) => T): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-inline-model-naming-'));
  const specFile = path.join(tmpDir, 'spec.json');
  try {
    await fs.writeFile(specFile, JSON.stringify(spec), 'utf-8');
    return fn(await parseSpec(specFile));
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
}

function inlineObject(properties: Record<string, { type: string }>, required?: string[]) {
  return { type: 'object', properties, ...(required ? { required } : {}) };
}

function jsonBody(schema: object) {
  return { content: { 'application/json': { schema } } };
}

function jsonResponse(schema: object) {
  return { description: 'ok', content: { 'application/json': { schema } } };
}

function summarize(op: Operation) {
  return {
    name: op.name,
    path: op.path,
    requestBody: op.requestBody?.kind === 'model' ? op.requestBody.name : op.requestBody,
    response: op.response.kind === 'model' ? op.response.name : op.response,
  };
}

/** The repro from issue #188, verbatim. */
const ISSUE_188_SPEC = {
  openapi: '3.1.0',
  info: { title: 'repro', version: '1' },
  paths: {
    '/notes': {
      post: {
        requestBody: jsonBody(inlineObject({ text: { type: 'string' } }, ['text'])),
        responses: { '200': jsonResponse(inlineObject({ id: { type: 'string' } }, ['id'])) },
      },
    },
    '/notes/{id}/pin': {
      post: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': jsonResponse(
            inlineObject({ pinnedAt: { type: 'string' }, pinnedBy: { type: 'string' } }, ['pinnedAt', 'pinnedBy']),
          ),
        },
      },
    },
    '/tags': {
      post: {
        requestBody: jsonBody(inlineObject({ label: { type: 'string' }, color: { type: 'string' } }, ['label'])),
        responses: { '204': { description: 'ok' } },
      },
    },
  },
};

describe('inline model naming without operationId (issue #188)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives every operationId-less body and response its own model, with its own fields, and no warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await parseInline(ISSUE_188_SPEC, (ir) => {
      const operations = ir.services.flatMap((s) => s.operations).map(summarize);
      expect(operations).toMatchInlineSnapshot(`
        [
          {
            "name": "create",
            "path": "/notes",
            "requestBody": "NotesPostRequest",
            "response": "NotesPostResponse",
          },
          {
            "name": "createPin",
            "path": "/notes/{id}/pin",
            "requestBody": undefined,
            "response": "NotesByIdPinPostResponse",
          },
          {
            "name": "create",
            "path": "/tags",
            "requestBody": "TagsPostRequest",
            "response": {
              "kind": "primitive",
              "type": "unknown",
            },
          },
        ]
      `);

      const models = ir.models.map((m) => ({ name: m.name, fields: m.fields.map((f) => f.name) }));
      expect(models).toMatchInlineSnapshot(`
        [
          {
            "fields": [
              "id",
            ],
            "name": "NotesPostResponse",
          },
          {
            "fields": [
              "text",
            ],
            "name": "NotesPostRequest",
          },
          {
            "fields": [
              "pinnedAt",
              "pinnedBy",
            ],
            "name": "NotesByIdPinPostResponse",
          },
          {
            "fields": [
              "label",
              "color",
            ],
            "name": "TagsPostRequest",
          },
        ]
      `);

      // Every model referenced by an operation exists, and each operation's
      // model carries the fields that operation declared — not someone else's.
      const byName = new Map(ir.models.map((m) => [m.name, m]));
      const notesCreate = ir.services.find((s) => s.name === 'Notes')!.operations.find((o) => o.path === '/notes')!;
      expect(byName.get((notesCreate.requestBody as { name: string }).name)!.fields.map((f) => f.name)).toEqual([
        'text',
      ]);
      expect(byName.get((notesCreate.response as { name: string }).name)!.fields.map((f) => f.name)).toEqual(['id']);
      const tagsCreate = ir.services.find((s) => s.name === 'Tags')!.operations[0];
      expect(byName.get((tagsCreate.requestBody as { name: string }).name)!.fields.map((f) => f.name)).toEqual([
        'label',
        'color',
      ]);
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps list and get on the same resource apart (GET /notes vs GET /notes/{id})', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await parseInline(
      {
        openapi: '3.1.0',
        info: { title: 'list-vs-get', version: '1' },
        paths: {
          '/notes': {
            get: {
              responses: { '200': jsonResponse(inlineObject({ total: { type: 'integer' } })) },
            },
          },
          '/notes/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: { '200': jsonResponse(inlineObject({ id: { type: 'string' }, text: { type: 'string' } })) },
            },
          },
        },
      },
      (ir) => {
        const [list, get] = ir.services.find((s) => s.name === 'Notes')!.operations.map(summarize);
        expect(list.response).toBe('NotesGetResponse');
        expect(get.response).toBe('NotesByIdGetResponse');

        const fields = (name: string) => ir.models.find((m) => m.name === name)!.fields.map((f) => f.name);
        expect(fields('NotesGetResponse')).toEqual(['total']);
        expect(fields('NotesByIdGetResponse')).toEqual(['id', 'text']);
      },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when two operationIds resolve to the same inline model name with different fields', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await parseInline(
      {
        openapi: '3.1.0',
        info: { title: 'collision', version: '1' },
        paths: {
          '/notes': {
            post: {
              operationId: 'createNote',
              requestBody: jsonBody(inlineObject({ text: { type: 'string' } })),
              responses: { '204': { description: 'ok' } },
            },
          },
          '/legacy/notes': {
            post: {
              operationId: 'create-note',
              requestBody: jsonBody(inlineObject({ title: { type: 'string' }, body: { type: 'string' } })),
              responses: { '204': { description: 'ok' } },
            },
          },
        },
      },
      (ir) => {
        const bodies = ir.services.flatMap((s) => s.operations).map((o) => summarize(o).requestBody);
        expect(bodies).toEqual(['CreateNoteRequest', 'CreateNoteRequest']);
        expect(ir.models.filter((m) => m.name === 'CreateNoteRequest')).toHaveLength(1);
        expect(ir.models.find((m) => m.name === 'CreateNoteRequest')!.fields.map((f) => f.name)).toEqual([
          'title',
          'body',
        ]);
      },
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatchInlineSnapshot(
      `"[oagen] Warning: Inline model "CreateNoteRequest" has more than one definition with different fields or field types (2 vs 1) — keeping the one with more fields"`,
    );
  });
});

describe('path-derived names that would otherwise collide', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const api = (paths: object) => ({ openapi: '3.1.0', info: { title: 'collide', version: '1' }, paths });

  const summarizeAll = (ir: Awaited<ReturnType<typeof parseSpec>>) => ({
    ops: ir.services.flatMap((s) => s.operations).map(summarize),
    models: ir.models.map((m) => ({ name: m.name, fields: m.fields.map((f) => f.name) })),
  });

  const fieldsOf = (models: Array<{ name: string; fields: string[] }>, name: unknown) =>
    models.find((m) => m.name === name)?.fields;

  const prefixOf = (name: unknown) => String(name).replace(/Re(quest|sponse)$/, '');

  const fooBar = {
    post: {
      requestBody: jsonBody(inlineObject({ a: { type: 'string' } })),
      responses: { '200': jsonResponse(inlineObject({ x: { type: 'string' } })) },
    },
  };
  const fooSlashBar = {
    post: {
      requestBody: jsonBody(inlineObject({ b: { type: 'string' }, c: { type: 'string' } })),
      responses: { '200': jsonResponse(inlineObject({ y: { type: 'string' }, z: { type: 'string' } })) },
    },
  };

  it('tells POST /foo-bar and POST /foo/bar apart, each on its own models, independent of document order', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { ops, models } = await parseInline(api({ '/foo-bar': fooBar, '/foo/bar': fooSlashBar }), summarizeAll);
    expect(ops).toMatchInlineSnapshot(`
      [
        {
          "name": "create",
          "path": "/foo-bar",
          "requestBody": "FooBar546F12PostRequest",
          "response": "FooBar546F12PostResponse",
        },
        {
          "name": "createBar",
          "path": "/foo/bar",
          "requestBody": "FooBarA82CcePostRequest",
          "response": "FooBarA82CcePostResponse",
        },
      ]
    `);

    const [dashed, nested] = ops;
    expect(dashed.requestBody).not.toBe(nested.requestBody);
    expect(dashed.response).not.toBe(nested.response);
    expect(prefixOf(dashed.requestBody)).toBe(prefixOf(dashed.response));
    expect(prefixOf(nested.requestBody)).toBe(prefixOf(nested.response));
    expect(fieldsOf(models, dashed.requestBody)).toEqual(['a']);
    expect(fieldsOf(models, dashed.response)).toEqual(['x']);
    expect(fieldsOf(models, nested.requestBody)).toEqual(['b', 'c']);
    expect(fieldsOf(models, nested.response)).toEqual(['y', 'z']);

    // The disambiguator comes from the raw path, not from document order.
    const reversed = await parseInline(api({ '/foo/bar': fooSlashBar, '/foo-bar': fooBar }), summarizeAll);
    const byPath = (list: typeof ops) => Object.fromEntries(list.map((o) => [o.path, [o.requestBody, o.response]]));
    expect(byPath(reversed.ops)).toEqual(byPath(ops));

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('tells GET /notes/by-id and GET /notes/{id} apart', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { ops, models } = await parseInline(
      api({
        '/notes/by-id': { get: { responses: { '200': jsonResponse(inlineObject({ ids: { type: 'string' } })) } } },
        '/notes/{id}': {
          get: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': jsonResponse(inlineObject({ id: { type: 'string' }, text: { type: 'string' } })) },
          },
        },
      }),
      summarizeAll,
    );
    expect(ops.map((o) => [o.path, o.response])).toMatchInlineSnapshot(`
      [
        [
          "/notes/by-id",
          "NotesByIdBa41B5GetResponse",
        ],
        [
          "/notes/{id}",
          "NotesById846BceGetResponse",
        ],
      ]
    `);

    expect(ops[0].response).not.toBe(ops[1].response);
    expect(fieldsOf(models, ops[0].response)).toEqual(['ids']);
    expect(fieldsOf(models, ops[1].response)).toEqual(['id', 'text']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('only disambiguates the colliding method: GET /foo-bar keeps its plain name next to the POST collision', async () => {
    const { ops } = await parseInline(
      api({
        '/foo-bar': { ...fooBar, get: { responses: { '200': jsonResponse(inlineObject({ g: { type: 'string' } })) } } },
        '/foo/bar': fooSlashBar,
      }),
      summarizeAll,
    );
    const get = ops.find((o) => o.path === '/foo-bar' && o.requestBody === undefined)!;
    expect(get.response).toBe('FooBarGetResponse');
  });

  it('normalizes so request and response prefixes agree (/a/b, /v2/x/y)', async () => {
    const op = {
      post: {
        requestBody: jsonBody(inlineObject({ q: { type: 'string' } })),
        responses: { '200': jsonResponse(inlineObject({ r: { type: 'string' } })) },
      },
    };
    const { ops } = await parseInline(api({ '/a/b': op, '/v2/x/y': op }), summarizeAll);
    expect(ops.map((o) => [o.path, o.requestBody, o.response])).toMatchInlineSnapshot(`
      [
        [
          "/a/b",
          "AbPostRequest",
          "AbPostResponse",
        ],
        [
          "/v2/x/y",
          "V2XyPostRequest",
          "V2XyPostResponse",
        ],
      ]
    `);
    for (const o of ops) expect(prefixOf(o.requestBody)).toBe(prefixOf(o.response));
  });
});

describe('derivePathBasedName', () => {
  it('produces names that are fixed points of toPascalCase, with or without a disambiguator', () => {
    const names = [
      derivePathBasedName('/a/b', 'post', 'Request'),
      derivePathBasedName('/v2/x/y', 'post', 'Response'),
      derivePathBasedName('/foo/bar', 'post', 'Response', '3f9a2c'),
      derivePathBasedName('/foo-bar', 'post', 'Request', 'abcdef'),
      derivePathBasedName('/sso', 'get', 'Response', 'ab12cd'),
      derivePathBasedName('/users/{user_id}/sessions', 'get', 'Response'),
    ];
    expect(names).toMatchInlineSnapshot(`
      [
        "AbPostRequest",
        "V2XyPostResponse",
        "FooBar3F9A2CPostResponse",
        "FooBarAbcdefPostRequest",
        "SSOAb12CdGetResponse",
        "UsersByUserIdSessionsGetResponse",
      ]
    `);
    for (const name of names) expect(toPascalCase(name)).toBe(name);
  });

  it('encodes every path segment, parameters as By<Name>, then the method and suffix', () => {
    const cases: Array<[string, 'get' | 'post', 'Request' | 'Response']> = [
      ['/widgets', 'get', 'Response'],
      ['/notes', 'post', 'Request'],
      ['/notes', 'post', 'Response'],
      ['/notes/{id}/pin', 'post', 'Response'],
      ['/tags', 'post', 'Request'],
      ['/notes/{id}', 'get', 'Response'],
      ['/users/{user_id}/sessions', 'get', 'Response'],
      ['/', 'get', 'Response'],
    ];
    expect(cases.map(([p, m, s]) => `${m.toUpperCase()} ${p} → ${derivePathBasedName(p, m, s)}`))
      .toMatchInlineSnapshot(`
        [
          "GET /widgets → WidgetsGetResponse",
          "POST /notes → NotesPostRequest",
          "POST /notes → NotesPostResponse",
          "POST /notes/{id}/pin → NotesByIdPinPostResponse",
          "POST /tags → TagsPostRequest",
          "GET /notes/{id} → NotesByIdGetResponse",
          "GET /users/{user_id}/sessions → UsersByUserIdSessionsGetResponse",
          "GET / → UnknownGetResponse",
        ]
      `);
  });
});

describe('keepLargestByName collision warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const model = (name: string, fieldNames: string[]): Model => ({
    name,
    fields: fieldNames.map((f) => ({ name: f, type: { kind: 'primitive', type: 'string' }, required: true })),
  });

  it('warns once and keeps the larger model when same-named inline models have different fields', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const merged = mergeInlineResponseModels([], [model('Thing', ['a']), model('Thing', ['b', 'c'])]);

    expect(merged.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([['Thing', ['b', 'c']]]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(
      'Inline model "Thing" has more than one definition with different fields',
    );
  });

  it('stays quiet when same-named inline models have the same field names and types', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const merged = mergeInlineResponseModels([], [model('Thing', ['a', 'b']), model('Thing', ['b', 'a'])]);

    expect(merged).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns on a tie when only the field types differ, and says it keeps the first definition', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first: Model = {
      name: 'Thing',
      fields: [{ name: 'a', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const second: Model = {
      name: 'Thing',
      fields: [{ name: 'a', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: true }],
    };

    const merged = mergeInlineResponseModels([], [first, second]);

    expect(merged).toHaveLength(1);
    expect(merged[0].fields[0].type).toEqual({ kind: 'primitive', type: 'string' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatchInlineSnapshot(
      `"[oagen] Warning: Inline model "Thing" has more than one definition with different fields or field types (1 vs 1) — keeping the first definition"`,
    );
  });
});
