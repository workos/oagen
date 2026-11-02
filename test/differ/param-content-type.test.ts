/**
 * The differ compares a parameter's `contentType` (issue #297, review).
 *
 * A parameter declared with `content` is typed as its schema and carries the
 * media type its value is serialized in (`Parameter.contentType`); a `schema`
 * parameter is serialized by `style`/`explode`. Moving between the two, or
 * between two media types that differ in essence, changes what a caller must
 * send even when the type did not move, so `diffParams` and
 * `diffWebhookParams` report it as a breaking `param-content-type-changed` —
 * beside, not instead of, whatever else changed about the parameter. A
 * `content` map none of whose media types is read is compared by the media
 * type it declares (`Parameter.contentTypes`), not taken for `schema`, and a
 * move between two JSON media types the parser reads is additive (#410).
 */
import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffOperations } from '../../src/differ/operations.js';
import { diffWebhooks } from '../../src/differ/webhooks.js';
import { jsonEncodedOnBothSides, parameterContentTypeShift } from '../../src/differ/params.js';
import { classifyParamChange } from '../../src/differ/classify.js';
import { diffCommand } from '../../src/cli/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Operation, Parameter, Webhook } from '../../src/ir/types.js';
import type { ParamChange } from '../../src/differ/types.js';

const string = { kind: 'primitive', type: 'string' } as const;
const filterModel = { kind: 'model', name: 'NotesFilter' } as const;

/** The query `filter`, typed as the inline object the parser mints for it. */
const filter = (over: Partial<Parameter> = {}): Parameter => ({
  name: 'filter',
  type: filterModel,
  required: false,
  ...over,
});

/** `GET /notes` (`listNotes`) carrying one query parameter. */
const listNotes = (param: Parameter): Operation => ({
  name: 'listNotes',
  httpMethod: 'get',
  path: '/notes',
  pathParams: [],
  queryParams: [param],
  headerParams: [],
  response: string,
  errors: [],
  injectIdempotencyKey: false,
});

/** A `noteAdded` webhook carrying the same query parameter. */
const noteAdded = (param: Parameter): Webhook => ({
  name: 'noteAdded',
  httpMethod: 'post',
  headerParams: [],
  queryParams: [param],
  responses: [{ statusCode: 200 }],
});

const specOf = (op: Operation): ApiSpec => ({
  name: 'Notes',
  version: '1',
  baseUrl: 'https://api.example.com',
  models: [],
  enums: [],
  services: [{ name: 'Notes', operations: [op] }],
  sdk: defaultSdkBehavior(),
});

const paramChangesOf = (changes: ReturnType<typeof diffOperations>): ParamChange[] =>
  changes[0]?.kind === 'operation-modified' ? changes[0].paramChanges : [];
const webhookParamChangesOf = (changes: ReturnType<typeof diffWebhooks>): ParamChange[] =>
  changes[0]?.kind === 'webhook-modified' ? changes[0].paramChanges : [];

/** The entry `filter`'s re-encoding is reported as, at `query`. */
const reencoded = (oldContentType: string | null, newContentType: string | null, paramName = 'filter') => ({
  kind: 'param-content-type-changed',
  paramName,
  classification: 'breaking',
  paramLocation: 'query',
  oldContentType,
  newContentType,
  details: `content type ${oldContentType ?? '<schema>'} → ${newContentType ?? '<schema>'}`,
});

describe('parameterContentTypeShift', () => {
  it('reports schema → content, content → schema and an essence change, each side as written', () => {
    expect(parameterContentTypeShift(filter(), filter({ contentType: 'application/json' }))).toEqual({
      oldContentType: null,
      newContentType: 'application/json',
      details: 'content type <schema> → application/json',
    });
    expect(parameterContentTypeShift(filter({ contentType: 'application/json' }), filter())).toEqual({
      oldContentType: 'application/json',
      newContentType: null,
      details: 'content type application/json → <schema>',
    });
    expect(
      parameterContentTypeShift(filter({ contentType: 'application/json' }), filter({ contentType: 'text/plain' })),
    ).toEqual({
      oldContentType: 'application/json',
      newContentType: 'text/plain',
      details: 'content type application/json → text/plain',
    });
  });

  it('compares by essence: case and parameters such as charset do not change how the value is encoded', () => {
    const json = filter({ contentType: 'application/json' });
    expect(parameterContentTypeShift(json, filter({ contentType: 'application/json; charset=utf-8' }))).toBeUndefined();
    expect(parameterContentTypeShift(json, filter({ contentType: 'APPLICATION/JSON' }))).toBeUndefined();
    expect(parameterContentTypeShift(json, json)).toBeUndefined();
    expect(parameterContentTypeShift(filter(), filter())).toBeUndefined();
  });

  it('is classified breaking', () => {
    expect(classifyParamChange('param-content-type-changed', 'filter')).toEqual({
      kind: 'param-content-type-changed',
      paramName: 'filter',
      classification: 'breaking',
    });
  });

  it('reads a content map none of whose media types is read as the media type it declares, not as `schema` (#410)', () => {
    // Typed as a string on every side: only the declaration moves.
    const schema = filter({ type: string });
    const xml = filter({ type: string, contentTypes: ['application/xml'] });
    const json = filter({ type: string, contentType: 'application/json', contentTypes: ['application/json'] });
    expect(parameterContentTypeShift(schema, xml)).toEqual({
      oldContentType: null,
      newContentType: 'application/xml',
      details: 'content type <schema> → application/xml (unread)',
    });
    expect(parameterContentTypeShift(xml, schema)).toEqual({
      oldContentType: 'application/xml',
      newContentType: null,
      details: 'content type application/xml (unread) → <schema>',
    });
    expect(parameterContentTypeShift(json, xml)).toEqual({
      oldContentType: 'application/json',
      newContentType: 'application/xml',
      details: 'content type application/json → application/xml (unread)',
    });
    // A JSON entry that loses its schema keeps its media type but is no
    // longer read, so its value is sent as written rather than JSON-encoded.
    expect(parameterContentTypeShift(json, filter({ type: string, contentTypes: ['application/json'] }))).toEqual({
      oldContentType: 'application/json',
      newContentType: 'application/json',
      details: 'content type application/json → application/json (unread)',
    });
    // Compared by essence, as a media type that is read is.
    expect(
      parameterContentTypeShift(xml, filter({ type: string, contentTypes: ['APPLICATION/XML; charset=utf-8'] })),
    ).toBeUndefined();
    expect(parameterContentTypeShift(xml, xml)).toBeUndefined();
  });

  it('tells a move between two JSON media types the parser reads, which encode the value alike, additive (#410)', () => {
    const json = filter({ contentType: 'application/json' });
    const vnd = filter({ contentType: 'application/vnd.notes+json' });
    expect(jsonEncodedOnBothSides(json, vnd)).toBe(true);
    expect(jsonEncodedOnBothSides(vnd, json)).toBe(true);
    expect(jsonEncodedOnBothSides(vnd, filter({ contentType: 'application/merge-patch+json; charset=utf-8' }))).toBe(
      true,
    );
    expect(jsonEncodedOnBothSides(json, filter({ contentType: 'text/plain' }))).toBe(false);
    expect(jsonEncodedOnBothSides(filter(), json)).toBe(false);
    // A `+json` entry without a schema is not read: its value is sent as written.
    expect(jsonEncodedOnBothSides(json, filter({ type: string, contentTypes: ['application/vnd.notes+json'] }))).toBe(
      false,
    );
    expect(classifyParamChange('param-content-type-changed', 'filter', true)).toEqual({
      kind: 'param-content-type-changed',
      paramName: 'filter',
      classification: 'additive',
    });
    expect(classifyParamChange('param-content-type-changed', 'filter', false)).toMatchObject({
      classification: 'breaking',
    });
  });
});

describe('diffOperations / diffWebhooks – param-content-type-changed', () => {
  it('reports the parameter moving from schema to content, breaking, with its type unchanged', () => {
    const changes = diffOperations(
      'Notes',
      [listNotes(filter())],
      [listNotes(filter({ contentType: 'application/json' }))],
    );
    expect(paramChangesOf(changes)).toEqual([reencoded(null, 'application/json')]);
    expect(changes[0]).toMatchObject({ kind: 'operation-modified', classification: 'breaking' });
  });

  it('reports the move back, breaking', () => {
    expect(
      paramChangesOf(
        diffOperations('Notes', [listNotes(filter({ contentType: 'application/json' }))], [listNotes(filter())]),
      ),
    ).toEqual([reencoded('application/json', null)]);
  });

  it('reports application/json becoming text/plain with the same schema, breaking', () => {
    expect(
      paramChangesOf(
        diffOperations(
          'Notes',
          [listNotes(filter({ contentType: 'application/json' }))],
          [listNotes(filter({ contentType: 'text/plain' }))],
        ),
      ),
    ).toEqual([reencoded('application/json', 'text/plain')]);
  });

  it('reports nothing for a respelling that keeps the essence, or an unchanged declaration', () => {
    const json = listNotes(filter({ contentType: 'application/json' }));
    expect(
      diffOperations('Notes', [json], [listNotes(filter({ contentType: 'application/json; charset=utf-8' }))]),
    ).toEqual([]);
    expect(diffOperations('Notes', [json], [json])).toEqual([]);
    expect(diffOperations('Notes', [listNotes(filter())], [listNotes(filter())])).toEqual([]);
  });

  it('reports it beside a type change, not instead of it', () => {
    const changes = diffOperations(
      'Notes',
      [listNotes(filter({ type: string }))],
      [listNotes(filter({ contentType: 'application/json' }))],
    );
    expect(paramChangesOf(changes)).toEqual([
      { kind: 'param-type-changed', paramName: 'filter', classification: 'breaking', paramLocation: 'query' },
      reencoded(null, 'application/json'),
    ]);
  });

  it("reports the same entry on a webhook, from the receiver's side", () => {
    expect(
      webhookParamChangesOf(
        diffWebhooks([noteAdded(filter())], [noteAdded(filter({ contentType: 'application/json' }))]),
      ),
    ).toEqual([reencoded(null, 'application/json')]);
    expect(
      webhookParamChangesOf(
        diffWebhooks([noteAdded(filter({ contentType: 'application/json' }))], [noteAdded(filter())]),
      ),
    ).toEqual([reencoded('application/json', null)]);
    expect(
      diffWebhooks(
        [noteAdded(filter({ contentType: 'application/json' }))],
        [noteAdded(filter({ contentType: 'application/json; charset=utf-8' }))],
      ),
    ).toEqual([]);
  });

  it('reports a move between two JSON media types as additive, on an operation and on a webhook (#410)', () => {
    const json = filter({ contentType: 'application/json' });
    const vnd = filter({ contentType: 'application/vnd.notes+json' });
    const api = filter({ contentType: 'application/vnd.api+json' });
    const additive = (oldContentType: string, newContentType: string) => ({
      ...reencoded(oldContentType, newContentType),
      classification: 'additive',
    });

    const changes = diffOperations('Notes', [listNotes(json)], [listNotes(vnd)]);
    expect(paramChangesOf(changes)).toEqual([additive('application/json', 'application/vnd.notes+json')]);
    expect(changes[0]).toMatchObject({ kind: 'operation-modified', classification: 'additive' });
    expect(paramChangesOf(diffOperations('Notes', [listNotes(vnd)], [listNotes(json)]))).toEqual([
      additive('application/vnd.notes+json', 'application/json'),
    ]);
    expect(paramChangesOf(diffOperations('Notes', [listNotes(vnd)], [listNotes(api)]))).toEqual([
      additive('application/vnd.notes+json', 'application/vnd.api+json'),
    ]);

    const webhookChanges = diffWebhooks([noteAdded(json)], [noteAdded(vnd)]);
    expect(webhookParamChangesOf(webhookChanges)).toEqual([additive('application/json', 'application/vnd.notes+json')]);
    expect(webhookChanges[0]).toMatchObject({ kind: 'webhook-modified', classification: 'additive' });
  });

  it('keeps a move from a JSON media type to one that is not, or one the parser does not read, breaking (#410)', () => {
    const json = filter({ contentType: 'application/json' });
    // A `+json` entry without a schema: not read, so typed as a string and sent as written.
    const unreadVnd = filter({ type: string, contentTypes: ['application/vnd.notes+json'] });
    expect(
      paramChangesOf(diffOperations('Notes', [listNotes(json)], [listNotes(filter({ contentType: 'text/plain' }))])),
    ).toEqual([reencoded('application/json', 'text/plain')]);
    expect(paramChangesOf(diffOperations('Notes', [listNotes(json)], [listNotes(unreadVnd)]))).toEqual([
      { kind: 'param-type-changed', paramName: 'filter', classification: 'breaking', paramLocation: 'query' },
      {
        ...reencoded('application/json', 'application/vnd.notes+json'),
        details: 'content type application/json → application/vnd.notes+json (unread)',
      },
    ]);
    expect(webhookParamChangesOf(diffWebhooks([noteAdded(json)], [noteAdded(unreadVnd)]))).toContainEqual({
      ...reencoded('application/json', 'application/vnd.notes+json'),
      details: 'content type application/json → application/vnd.notes+json (unread)',
    });
  });

  it('reports a move to or from a content map none of whose media types is read, breaking, naming the media type (#410)', () => {
    const schema = filter({ type: string });
    const xml = filter({ type: string, contentTypes: ['application/xml'] });
    const toXml = {
      ...reencoded(null, 'application/xml'),
      details: 'content type <schema> → application/xml (unread)',
    };
    const fromXml = {
      ...reencoded('application/xml', null),
      details: 'content type application/xml (unread) → <schema>',
    };

    const changes = diffOperations('Notes', [listNotes(schema)], [listNotes(xml)]);
    expect(paramChangesOf(changes)).toEqual([toXml]);
    expect(changes[0]).toMatchObject({ kind: 'operation-modified', classification: 'breaking' });
    expect(paramChangesOf(diffOperations('Notes', [listNotes(xml)], [listNotes(schema)]))).toEqual([fromXml]);
    expect(webhookParamChangesOf(diffWebhooks([noteAdded(schema)], [noteAdded(xml)]))).toEqual([toXml]);
    expect(webhookParamChangesOf(diffWebhooks([noteAdded(xml)], [noteAdded(schema)]))).toEqual([fromXml]);
    expect(diffOperations('Notes', [listNotes(xml)], [listNotes(xml)])).toEqual([]);
  });

  it('is not mirrored into behaviorChanges, as param-type-changed is not', () => {
    const diff = diffSpecs(specOf(listNotes(filter())), specOf(listNotes(filter({ contentType: 'application/json' }))));
    expect(diff.summary.breaking).toBe(1);
    expect(diff.behaviorChanges).toEqual([]);
  });
});

describe('diffSpecs – end to end (issue #297 review, point 3)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mood = { type: 'string', enum: ['calm', 'busy'] };
  const filterSchema = { type: 'object', properties: { tag: { type: 'string' }, owner: { type: 'string' } } };

  /** `GET /notes` (`listNotes`) with the inline enum `mood` and the inline object `filter`, each declared by `via`. */
  const doc = (via: (schema: unknown) => Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths: {
      '/notes': {
        get: {
          operationId: 'listNotes',
          parameters: [
            { name: 'mood', in: 'query', ...via(mood) },
            { name: 'filter', in: 'query', style: 'deepObject', ...via(filterSchema) },
          ],
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } } },
        },
      },
    },
  });
  const bySchema = (schema: unknown) => ({ schema });
  const byContent =
    (mediaType: string) =>
    (schema: unknown): Record<string, unknown> => ({ content: { [mediaType]: { schema } } });

  async function write(name: string, document: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-param-content-type-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(document));
    return file;
  }
  async function parse(name: string, document: unknown): Promise<ApiSpec> {
    return parseSpec(await write(name, document));
  }
  /** The exit code `oagen diff` ends with for the two documents: 2 breaking, 1 otherwise changed, 0 unchanged. */
  async function exitCodeOf(before: unknown, after: unknown): Promise<number> {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = (await diffCommand({
      old: await write('before.json', before),
      new: await write('after.json', after),
    }).catch((e: unknown) => e)) as { exitCode: number };
    return err.exitCode;
  }

  it('reports an inline enum and an inline object moving from schema to content as one re-encoding each, and nothing else', async () => {
    const before = await parse('before.json', doc(bySchema));
    const after = await parse('after.json', doc(byContent('application/json')));
    // The enum and the model keep their names on both sides.
    expect(after.enums.map((e) => e.name)).toEqual(before.enums.map((e) => e.name));
    expect(after.models.map((m) => m.name)).toEqual(before.models.map((m) => m.name));

    const diff = diffSpecs(before, after);
    // No enum-removed, no model-removed: the operation is the only change.
    expect(diff.changes.map((c) => c.kind)).toEqual(['operation-modified']);
    expect(paramChangesOf(diff.changes as ReturnType<typeof diffOperations>)).toEqual([
      reencoded(null, 'application/json', 'mood'),
      reencoded(null, 'application/json', 'filter'),
    ]);
    expect(diff.summary.breaking).toBe(1);
    expect(await exitCodeOf(doc(bySchema), doc(byContent('application/json')))).toBe(2);
  });

  it('reports the move back the same way, mirrored', async () => {
    const diff = diffSpecs(
      await parse('before.json', doc(byContent('application/json'))),
      await parse('after.json', doc(bySchema)),
    );
    expect(diff.changes.map((c) => c.kind)).toEqual(['operation-modified']);
    expect(paramChangesOf(diff.changes as ReturnType<typeof diffOperations>)).toEqual([
      reencoded('application/json', null, 'mood'),
      reencoded('application/json', null, 'filter'),
    ]);
    expect(await exitCodeOf(doc(byContent('application/json')), doc(bySchema))).toBe(2);
  });

  it('reports application/json becoming text/plain with the same schemas', async () => {
    const diff = diffSpecs(
      await parse('before.json', doc(byContent('application/json'))),
      await parse('after.json', doc(byContent('text/plain'))),
    );
    expect(diff.changes.map((c) => c.kind)).toEqual(['operation-modified']);
    expect(paramChangesOf(diff.changes as ReturnType<typeof diffOperations>)).toEqual([
      reencoded('application/json', 'text/plain', 'mood'),
      reencoded('application/json', 'text/plain', 'filter'),
    ]);
  });

  it('reports nothing, exit 0, for a content declaration whose essence and schemas are unchanged', async () => {
    const before = doc(byContent('application/json'));
    const respelled = doc(byContent('application/json; charset=utf-8'));
    expect(diffSpecs(await parse('before.json', before), await parse('after.json', respelled)).changes).toEqual([]);
    expect(diffSpecs(await parse('before.json', before), await parse('after.json', before)).changes).toEqual([]);
    expect(await exitCodeOf(before, respelled)).toBe(0);
    expect(await exitCodeOf(before, before)).toBe(0);
  });

  describe('a content map the parser does not read, and a move between JSON media types (issue #410)', () => {
    /** `GET /notes` (`listNotes`) with the query parameter `filter`, declared by `declaration`. */
    const notes = (declaration: Record<string, unknown>) => ({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/notes': {
          get: {
            operationId: 'listNotes',
            parameters: [{ name: 'filter', in: 'query', ...declaration }],
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } },
            },
          },
        },
      },
    });
    const text = { type: 'string' };
    const owner = { type: 'object', properties: { owner: { type: 'string' } } };
    // The issue's `schema.json`, `json.json` and `xml.json`.
    const documents = {
      schema: notes({ schema: text }),
      json: notes(byContent('application/json')(text)),
      xml: notes(byContent('application/xml')(text)),
    };
    const paramChangesBetween = async (from: keyof typeof documents, to: keyof typeof documents) =>
      diffSpecs(await parse(`${from}.json`, documents[from]), await parse(`${to}.json`, documents[to])).changes.flatMap(
        (change) => ('paramChanges' in change ? change.paramChanges : []),
      );

    beforeEach(() => {
      // `application/xml` is not read; the parser says so on every parse.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('reports schema → xml as a breaking move to content, naming application/xml, exit 2', async () => {
      expect(await paramChangesBetween('schema', 'xml')).toEqual([
        {
          kind: 'param-content-type-changed',
          paramName: 'filter',
          classification: 'breaking',
          paramLocation: 'query',
          oldContentType: null,
          newContentType: 'application/xml',
          details: 'content type <schema> → application/xml (unread)',
        },
      ]);
      expect(await paramChangesBetween('xml', 'schema')).toEqual([
        {
          kind: 'param-content-type-changed',
          paramName: 'filter',
          classification: 'breaking',
          paramLocation: 'query',
          oldContentType: 'application/xml',
          newContentType: null,
          details: 'content type application/xml (unread) → <schema>',
        },
      ]);
      expect(await exitCodeOf(documents.schema, documents.xml)).toBe(2);
      expect(await exitCodeOf(documents.xml, documents.schema)).toBe(2);
    });

    it('names application/xml as the new side of json → xml, not <schema>', async () => {
      expect(await paramChangesBetween('json', 'xml')).toEqual([
        {
          kind: 'param-content-type-changed',
          paramName: 'filter',
          classification: 'breaking',
          paramLocation: 'query',
          oldContentType: 'application/json',
          newContentType: 'application/xml',
          details: 'content type application/json → application/xml (unread)',
        },
      ]);
      expect(await paramChangesBetween('xml', 'xml')).toEqual([]);
    });

    it('reports application/json → application/vnd.notes+json as additive, exit 1, and the same between two +json types', async () => {
      const before = notes(byContent('application/json')(owner));
      const after = notes(byContent('application/vnd.notes+json')(owner));
      const diff = diffSpecs(await parse('before.json', before), await parse('after.json', after));
      // The inline object keeps its model on both sides: the operation is the only change.
      expect(diff.changes.map((c) => c.kind)).toEqual(['operation-modified']);
      expect(paramChangesOf(diff.changes as ReturnType<typeof diffOperations>)).toEqual([
        { ...reencoded('application/json', 'application/vnd.notes+json'), classification: 'additive' },
      ]);
      expect(diff.summary.breaking).toBe(0);
      expect(await exitCodeOf(before, after)).toBe(1);

      const api = notes(byContent('application/vnd.api+json; charset=utf-8')(owner));
      expect(
        paramChangesOf(
          diffSpecs(await parse('after.json', after), await parse('api.json', api)).changes as ReturnType<
            typeof diffOperations
          >,
        ),
      ).toEqual([
        {
          ...reencoded('application/vnd.notes+json', 'application/vnd.api+json; charset=utf-8'),
          classification: 'additive',
        },
      ]);
      expect(await exitCodeOf(after, api)).toBe(1);
    });
  });
});
