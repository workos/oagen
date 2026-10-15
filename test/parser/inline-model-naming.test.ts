import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { derivePathBasedName } from '../../src/parser/operations.js';
import { mergeInlineResponseModels } from '../../src/parser/normalize-inline-models.js';
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
      `"[oagen] Warning: Inline model "CreateNoteRequest" has more than one definition with different fields (2 vs 1) — keeping the definition with the most fields"`,
    );
  });
});

describe('derivePathBasedName', () => {
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

  it('stays quiet when same-named inline models have the same field names', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const merged = mergeInlineResponseModels([], [model('Thing', ['a', 'b']), model('Thing', ['b', 'a'])]);

    expect(merged).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
