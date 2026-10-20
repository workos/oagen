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
            "name": "pinNote",
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

  /** Parse the same paths in both orders, assert the names agree, and return them keyed by path. */
  async function namesInBothOrders(entries: Array<[string, object]>) {
    const forward = await parseInline(api(Object.fromEntries(entries)), summarizeAll);
    const backward = await parseInline(api(Object.fromEntries([...entries].reverse())), summarizeAll);
    const byPath = (list: typeof forward.ops) =>
      Object.fromEntries(list.map((o) => [o.path, [o.requestBody, o.response]]));
    expect(byPath(backward.ops)).toEqual(byPath(forward.ops));
    return byPath(forward.ops);
  }

  it('keeps the plain name on POST /foo/bar and hashes POST /foo-bar, each on its own models, in either order', async () => {
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
          "requestBody": "FooBarPostRequest",
          "response": "FooBarPostResponse",
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

  it('keeps the plain name on GET /notes/{id} and hashes GET /notes/by-id, in either order', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const byId = { get: { responses: { '200': jsonResponse(inlineObject({ ids: { type: 'string' } })) } } };
    const byParam = {
      get: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': jsonResponse(inlineObject({ id: { type: 'string' }, text: { type: 'string' } })) },
      },
    };

    const { ops, models } = await parseInline(api({ '/notes/by-id': byId, '/notes/{id}': byParam }), summarizeAll);
    expect(ops.map((o) => [o.path, o.response])).toMatchInlineSnapshot(`
      [
        [
          "/notes/by-id",
          "NotesByIdBa41B5GetResponse",
        ],
        [
          "/notes/{id}",
          "NotesByIdGetResponse",
        ],
      ]
    `);

    expect(ops[0].response).not.toBe(ops[1].response);
    expect(fieldsOf(models, ops[0].response)).toEqual(['ids']);
    expect(fieldsOf(models, ops[1].response)).toEqual(['id', 'text']);
    await namesInBothOrders([
      ['/notes/by-id', byId],
      ['/notes/{id}', byParam],
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps the plain name on POST /notes and hashes POST /notes/ (trailing slash), in either order', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const names = await namesInBothOrders([
      ['/notes', fooBar],
      ['/notes/', fooSlashBar],
    ]);
    expect(names).toMatchInlineSnapshot(`
      {
        "/notes": [
          "NotesPostRequest",
          "NotesPostResponse",
        ],
        "/notes/": [
          "Notes5F3D21PostRequest",
          "Notes5F3D21PostResponse",
        ],
      }
    `);

    expect(names['/notes']).toEqual(['NotesPostRequest', 'NotesPostResponse']);
    expect(names['/notes/'][0]).not.toBe('NotesPostRequest');
    expect(names['/notes/'][1]).not.toBe('NotesPostResponse');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('hashes both POST /foo-bar and POST /foo_bar when they tie for plainest, in either order', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const names = await namesInBothOrders([
      ['/foo-bar', fooBar],
      ['/foo_bar', fooSlashBar],
    ]);
    expect(names).toMatchInlineSnapshot(`
      {
        "/foo-bar": [
          "FooBar546F12PostRequest",
          "FooBar546F12PostResponse",
        ],
        "/foo_bar": [
          "FooBar98F6D6PostRequest",
          "FooBar98F6D6PostResponse",
        ],
      }
    `);

    for (const path of ['/foo-bar', '/foo_bar']) {
      expect(names[path][0]).not.toBe('FooBarPostRequest');
      expect(names[path][1]).not.toBe('FooBarPostResponse');
    }
    expect(names['/foo-bar']).not.toEqual(names['/foo_bar']);
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

  it('yields to the names an operationId-bearing operation will use (POST /audit/events vs auditEventsPost)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unnamed = {
      post: {
        requestBody: jsonBody(inlineObject({ a: { type: 'string' } })),
        responses: { '200': jsonResponse(inlineObject({ x: { type: 'string' } })) },
      },
    };
    const named = {
      post: {
        operationId: 'auditEventsPost',
        requestBody: jsonBody(inlineObject({ b: { type: 'string' }, c: { type: 'string' } })),
        responses: { '200': jsonResponse(inlineObject({ y: { type: 'string' }, z: { type: 'string' } })) },
      },
    };

    const { ops, models } = await parseInline(api({ '/audit/events': unnamed, '/legacy-audit': named }), summarizeAll);
    expect(ops).toMatchInlineSnapshot(`
      [
        {
          "name": "createEvents",
          "path": "/audit/events",
          "requestBody": "AuditEventsD4C4A0PostRequest",
          "response": "AuditEventsD4C4A0PostResponse",
        },
        {
          "name": "auditEventsPost",
          "path": "/legacy-audit",
          "requestBody": "AuditEventsPostRequest",
          "response": "AuditEventsPostResponse",
        },
      ]
    `);

    const [pathNamed, idNamed] = ops;
    // The operationId-derived names are untouched; the path-based ones step aside.
    expect(idNamed.requestBody).toBe('AuditEventsPostRequest');
    expect(idNamed.response).toBe('AuditEventsPostResponse');
    expect(pathNamed.requestBody).not.toBe(idNamed.requestBody);
    expect(pathNamed.response).not.toBe(idNamed.response);
    expect(prefixOf(pathNamed.requestBody)).toBe(prefixOf(pathNamed.response));
    expect(fieldsOf(models, pathNamed.requestBody)).toEqual(['a']);
    expect(fieldsOf(models, pathNamed.response)).toEqual(['x']);
    expect(fieldsOf(models, idNamed.requestBody)).toEqual(['b', 'c']);
    expect(fieldsOf(models, idNamed.response)).toEqual(['y', 'z']);

    // Reservation depends on the document's names, not on their order.
    const reversed = await parseInline(api({ '/legacy-audit': named, '/audit/events': unnamed }), summarizeAll);
    const byPath = (list: typeof ops) => Object.fromEntries(list.map((o) => [o.path, [o.requestBody, o.response]]));
    expect(byPath(reversed.ops)).toEqual(byPath(ops));

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('yields to a component schema that takes the Request form (POST /audit/events vs AuditEventsPostRequest)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unnamed = {
      post: {
        requestBody: jsonBody(inlineObject({ a: { type: 'string' } })),
        responses: { '200': jsonResponse(inlineObject({ x: { type: 'string' } })) },
      },
    };
    const spec = {
      ...api({ '/audit/events': unnamed }),
      components: {
        schemas: { AuditEventsPostRequest: inlineObject({ b: { type: 'string' }, c: { type: 'string' } }) },
      },
    };

    const { ops, models } = await parseInline(spec, summarizeAll);
    expect(ops.map((o) => [o.path, o.requestBody, o.response])).toMatchInlineSnapshot(`
      [
        [
          "/audit/events",
          "AuditEventsD4C4A0PostRequest",
          "AuditEventsD4C4A0PostResponse",
        ],
      ]
    `);

    const [op] = ops;
    // The component keeps its name and fields; the operation's models step aside together.
    expect(fieldsOf(models, 'AuditEventsPostRequest')).toEqual(['b', 'c']);
    expect(op.requestBody).not.toBe('AuditEventsPostRequest');
    expect(prefixOf(op.requestBody)).toBe(prefixOf(op.response));
    expect(fieldsOf(models, op.requestBody)).toEqual(['a']);
    expect(fieldsOf(models, op.response)).toEqual(['x']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('yields to a component schema that takes the Response form (POST /audit/events vs AuditEventsPostResponse)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unnamed = {
      post: {
        requestBody: jsonBody(inlineObject({ a: { type: 'string' } })),
        responses: { '200': jsonResponse(inlineObject({ x: { type: 'string' } })) },
      },
    };
    const spec = {
      ...api({ '/audit/events': unnamed }),
      components: {
        schemas: { AuditEventsPostResponse: inlineObject({ y: { type: 'string' }, z: { type: 'string' } }) },
      },
    };

    const { ops, models } = await parseInline(spec, summarizeAll);
    expect(ops.map((o) => [o.path, o.requestBody, o.response])).toMatchInlineSnapshot(`
      [
        [
          "/audit/events",
          "AuditEventsD4C4A0PostRequest",
          "AuditEventsD4C4A0PostResponse",
        ],
      ]
    `);

    const [op] = ops;
    expect(fieldsOf(models, 'AuditEventsPostResponse')).toEqual(['y', 'z']);
    expect(op.response).not.toBe('AuditEventsPostResponse');
    expect(prefixOf(op.requestBody)).toBe(prefixOf(op.response));
    expect(fieldsOf(models, op.requestBody)).toEqual(['a']);
    expect(fieldsOf(models, op.response)).toEqual(['x']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  /** The inline item model name of an array response, or undefined. */
  const itemNameOf = (response: unknown) => (response as { items?: { name?: string } }).items?.name;

  it('reserves every name a component could take: AuditEventsGetItem beside an unnamed GET /audit/events list', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unnamedList = {
      get: { responses: { '200': jsonResponse({ type: 'array', items: inlineObject({ a: { type: 'string' } }) }) } },
    };
    const spec = {
      ...api({ '/audit/events': unnamedList }),
      components: { schemas: { AuditEventsGetItem: inlineObject({ b: { type: 'string' }, c: { type: 'string' } }) } },
    };

    const { ops, models } = await parseInline(spec, summarizeAll);
    const [op] = ops;
    const itemName = itemNameOf(op.response);
    expect([op.path, itemName]).toMatchInlineSnapshot(`
      [
        "/audit/events",
        "AuditEventsD4C4A0GetItem",
      ]
    `);

    // The component keeps its name and fields; the list items get their own model.
    expect(fieldsOf(models, 'AuditEventsGetItem')).toEqual(['b', 'c']);
    expect(itemName).not.toBe('AuditEventsGetItem');
    expect(fieldsOf(models, itemName)).toEqual(['a']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reserves the whole stem of an operationId: auditEventsGet minting AuditEventsGetItem beside an unnamed GET /audit/events list', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unnamedList = {
      get: { responses: { '200': jsonResponse({ type: 'array', items: inlineObject({ a: { type: 'string' } }) }) } },
    };
    const namedList = {
      get: {
        operationId: 'auditEventsGet',
        responses: {
          '200': jsonResponse({ type: 'array', items: inlineObject({ b: { type: 'string' }, c: { type: 'string' } }) }),
        },
      },
    };
    const itemNamesByPath = (paths: object) =>
      parseInline(api(paths), (ir) =>
        Object.fromEntries(ir.services.flatMap((s) => s.operations).map((o) => [o.path, itemNameOf(o.response)])),
      );

    const forward = await itemNamesByPath({ '/audit/events': unnamedList, '/legacy-audit': namedList });
    const backward = await itemNamesByPath({ '/legacy-audit': namedList, '/audit/events': unnamedList });
    expect(backward).toEqual(forward);
    expect(forward).toMatchInlineSnapshot(`
      {
        "/audit/events": "AuditEventsD4C4A0GetItem",
        "/legacy-audit": "AuditEventsGetItem",
      }
    `);

    // The operationId's stem `AuditEventsGet` is a prefix of the path-based `AuditEventsGetItem`,
    // so the operationId keeps its item model and the path-based list steps aside.
    expect(forward['/legacy-audit']).toBe('AuditEventsGetItem');
    expect(forward['/audit/events']).not.toBe('AuditEventsGetItem');
    const { models } = await parseInline(
      api({ '/audit/events': unnamedList, '/legacy-audit': namedList }),
      summarizeAll,
    );
    expect(fieldsOf(models, 'AuditEventsGetItem')).toEqual(['b', 'c']);
    expect(fieldsOf(models, forward['/audit/events'])).toEqual(['a']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is deliberately a superset: AuditEventsGetter or auditEventsGetSummary also push GET /audit/events onto a hashed name', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unnamed = { get: { responses: { '200': jsonResponse(inlineObject({ a: { type: 'string' } })) } } };

    const withComponent = await parseInline(
      {
        ...api({ '/audit/events': unnamed }),
        components: { schemas: { AuditEventsGetter: inlineObject({ b: { type: 'string' } }) } },
      },
      summarizeAll,
    );
    const withOperationId = await parseInline(
      api({
        '/audit/events': unnamed,
        '/legacy-audit': {
          get: {
            operationId: 'auditEventsGetSummary',
            responses: { '200': jsonResponse(inlineObject({ b: { type: 'string' } })) },
          },
        },
      }),
      summarizeAll,
    );

    // No emitted name would have coincided, but a reserved name starts with the
    // path-based prefix `AuditEventsGet`, so the path gets the hash. Expected.
    expect([withComponent.ops[0].response, withOperationId.ops[0].response]).toMatchInlineSnapshot(`
      [
        "AuditEventsD4C4A0GetResponse",
        "AuditEventsD4C4A0GetResponse",
      ]
    `);
    for (const { ops, models } of [withComponent, withOperationId]) {
      expect(ops[0].response).not.toBe('AuditEventsGetResponse');
      expect(fieldsOf(models, ops[0].response)).toEqual(['a']);
    }
    expect(fieldsOf(withComponent.models, 'AuditEventsGetter')).toEqual(['b']);
    expect(withOperationId.ops[1].response).toBe('AuditEventsGetSummaryResponse');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  /** Model names referenced by a union TypeRef, or undefined. */
  const variantNamesOf = (body: unknown) =>
    (body as { variants?: Array<{ name?: string }> }).variants?.map((v) => v.name);

  it('names body oneOf variants from the path base verbatim and yields to a singularized component (POST /notes vs NotePostRequest)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unnamedUnion = {
      post: {
        requestBody: jsonBody({
          oneOf: [
            inlineObject({ a: { type: 'string' } }),
            inlineObject({ d: { type: 'string' }, e: { type: 'string' } }),
          ],
        }),
        responses: { '204': { description: 'ok' } },
      },
    };
    const spec = {
      ...api({ '/notes': unnamedUnion }),
      components: { schemas: { NotePostRequest: inlineObject({ b: { type: 'string' }, c: { type: 'string' } }) } },
    };

    const { ops, models } = await parseInline(spec, summarizeAll);
    const [op] = ops;
    const variants = variantNamesOf(op.requestBody)!;
    expect([op.path, variants]).toMatchInlineSnapshot(`
      [
        "/notes",
        [
          "Notes151Dd5PostRequest",
          "Notes151Dd5PostRequestWithD",
        ],
      ]
    `);

    // The component keeps its name and fields; every variant resolves to its own model.
    expect(fieldsOf(models, 'NotePostRequest')).toEqual(['b', 'c']);
    expect(variants).not.toContain('NotePostRequest');
    expect(fieldsOf(models, variants[0])).toEqual(['a']);
    expect(fieldsOf(models, variants[1])).toEqual(['d', 'e']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps body oneOf variant names verbatim without a component: NotesPostRequest / NotesPostRequestWithD and const-prefixed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const numbered = {
      post: {
        requestBody: jsonBody({
          oneOf: [inlineObject({ a: { type: 'string' } }), inlineObject({ d: { type: 'string' } })],
        }),
        responses: { '204': { description: 'ok' } },
      },
    };
    const constPrefixed = {
      post: {
        requestBody: jsonBody({
          oneOf: [
            { type: 'object', properties: { kind: { type: 'string', const: 'email' }, to: { type: 'string' } } },
            { type: 'object', properties: { kind: { type: 'string', const: 'sms' }, number: { type: 'string' } } },
          ],
        }),
        responses: { '204': { description: 'ok' } },
      },
    };

    const { ops, models } = await parseInline(api({ '/notes': numbered, '/tags': constPrefixed }), summarizeAll);
    const byPath = Object.fromEntries(ops.map((o) => [o.path, variantNamesOf(o.requestBody)]));
    expect(byPath).toMatchInlineSnapshot(`
      {
        "/notes": [
          "NotesPostRequest",
          "NotesPostRequestWithD",
        ],
        "/tags": [
          "EmailTagsPostRequest",
          "SmsTagsPostRequest",
        ],
      }
    `);

    // The union TypeRef and the materialized models agree, with the path base verbatim;
    // the second const-less variant is named by its distinguishing property.
    expect(byPath['/notes']).toEqual(['NotesPostRequest', 'NotesPostRequestWithD']);
    for (const name of [...byPath['/notes']!, ...byPath['/tags']!]) {
      expect(models.some((m) => m.name === name)).toBe(true);
    }
    expect(fieldsOf(models, 'NotesPostRequest')).toEqual(['a']);
    expect(fieldsOf(models, 'NotesPostRequestWithD')).toEqual(['d']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reserves the singularized spelling too: GET /notes list yields to a component NoteGetItem', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unnamedList = {
      get: { responses: { '200': jsonResponse({ type: 'array', items: inlineObject({ a: { type: 'string' } }) }) } },
    };
    const spec = {
      ...api({ '/notes': unnamedList }),
      components: { schemas: { NoteGetItem: inlineObject({ b: { type: 'string' } }) } },
    };

    const { ops, models } = await parseInline(spec, summarizeAll);
    const itemName = itemNameOf(ops[0].response);
    expect(itemName).toMatchInlineSnapshot(`"Notes151Dd5GetItem"`);

    // `NotesGetItem` would not have clashed, but the cleaned spelling `NoteGet…` is reserved. Expected.
    expect(fieldsOf(models, 'NoteGetItem')).toEqual(['b']);
    expect(itemName).not.toBe('NotesGetItem');
    expect(fieldsOf(models, itemName)).toEqual(['a']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  /** Every model name referenced anywhere inside a TypeRef (or any nested value). */
  const modelRefsIn = (value: unknown, out: string[] = []): string[] => {
    if (Array.isArray(value)) value.forEach((v) => modelRefsIn(v, out));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record.kind === 'model' && typeof record.name === 'string') out.push(record.name);
      Object.values(record).forEach((v) => modelRefsIn(v, out));
    }
    return out;
  };

  const constVariants = (first: string, second: string) => ({
    oneOf: [
      { type: 'object', properties: { kind: { type: 'string', const: 'email' }, [first]: { type: 'string' } } },
      { type: 'object', properties: { kind: { type: 'string', const: 'sms' }, [second]: { type: 'string' } } },
    ],
  });

  it('reserves const-prefixed body variants: EmailTagsPostRequest beside an unnamed POST /tags with email/sms variants', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = {
      ...api({
        '/tags': {
          post: { requestBody: jsonBody(constVariants('to', 'number')), responses: { '204': { description: 'ok' } } },
        },
      }),
      components: { schemas: { EmailTagsPostRequest: inlineObject({ x: { type: 'string' } }) } },
    };

    const { ops, models } = await parseInline(spec, summarizeAll);
    const variants = variantNamesOf(ops[0].requestBody)!;
    expect(variants).toMatchInlineSnapshot(`
      [
        "EmailTagsA96599PostRequest",
        "SmsTagsA96599PostRequest",
      ]
    `);

    // The component keeps its fields; the hash lands inside the const-prefixed names.
    expect(fieldsOf(models, 'EmailTagsPostRequest')).toEqual(['x']);
    expect(variants).not.toContain('EmailTagsPostRequest');
    expect(fieldsOf(models, variants[0])).toEqual(['kind', 'to']);
    expect(fieldsOf(models, variants[1])).toEqual(['kind', 'number']);
    for (const name of modelRefsIn(ops[0].requestBody)) expect(models.some((m) => m.name === name)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reserves const-prefixed response variants: SmsTagsGetResponsePayload beside an unnamed GET /tags', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = {
      ...api({
        '/tags': {
          get: {
            responses: {
              // Two properties: a lone `payload` would be read as a single-resource
              // wrapper by responses.ts and unwrapped to its first variant.
              '200': jsonResponse({
                type: 'object',
                properties: { id: { type: 'string' }, payload: constVariants('to', 'number') },
              }),
            },
          },
        },
      }),
      components: { schemas: { SmsTagsGetResponsePayload: inlineObject({ x: { type: 'string' } }) } },
    };

    // Read the payload union from the raw IR: summarizeAll keeps only field names.
    const { ops, models, payloadVariants } = await parseInline(spec, (ir) => {
      const summary = summarizeAll(ir);
      const responseModel = ir.models.find((m) => m.name === summary.ops[0].response);
      return { ...summary, payloadVariants: modelRefsIn(responseModel?.fields ?? []) };
    });
    const [op] = ops;
    expect([op.response, payloadVariants]).toMatchInlineSnapshot(`
      [
        "TagsA96599GetResponse",
        [
          "TagsA96599GetResponsePayload",
          "SmsTagsA96599GetResponsePayload",
        ],
      ]
    `);

    // The nested variants are `<Parent>Payload` and `Sms<Parent>Payload`, both carrying the hash.
    expect(payloadVariants).toHaveLength(2);
    expect(fieldsOf(models, 'SmsTagsGetResponsePayload')).toEqual(['x']);
    expect(payloadVariants).not.toContain('SmsTagsGetResponsePayload');
    for (const name of [op.response as string, ...payloadVariants]) {
      expect(models.some((m) => m.name === name)).toBe(true);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('leaves const-prefixed names plain when no reserved name claims them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = {
      ...api({
        '/tags': {
          post: { requestBody: jsonBody(constVariants('to', 'number')), responses: { '204': { description: 'ok' } } },
        },
      }),
      components: { schemas: { Unrelated: inlineObject({ x: { type: 'string' } }) } },
    };

    const { ops, models } = await parseInline(spec, summarizeAll);
    expect(variantNamesOf(ops[0].requestBody)).toEqual(['EmailTagsPostRequest', 'SmsTagsPostRequest']);
    expect(fieldsOf(models, 'EmailTagsPostRequest')).toEqual(['kind', 'to']);
    expect(fieldsOf(models, 'SmsTagsPostRequest')).toEqual(['kind', 'number']);
    expect(warnSpy).not.toHaveBeenCalled();
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
