import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { mediaTypesOf } from '../../src/parser/body-media-types.js';
import {
  parameterSchema,
  parameterTyping,
  selectParameterContent,
  selectRequestBodyContent,
  warnUnreadParameterContent,
  warnUnreadRequestBody,
  type RequestBodyObject,
  type SchemaOrContent,
} from '../../src/parser/operations.js';
import { readSchemaSites } from '../../src/parser/schema-sites.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';

/**
 * Issue #710: a parameter's, a response header's, a request body's and a
 * response's `content` was read with `Object.keys`, whatever it held. A
 * string or an array in its place is no map of Media Type Objects, but its
 * indexes were read as media types — `content: "json"` declared `0`, `1`,
 * `2` and `3` — and reached `Parameter.contentTypes`,
 * `requestBodyContentTypes` / `requestBodyContents` and
 * `responseContentTypes` / `responseContents`, the warnings and `oagen
 * diff`. Every reader now takes the map from one check (`mediaTypesOf`): a
 * `content` that is no object declares no media type, as an absent one
 * declares none, after one warning naming the site and the value.
 */

type Doc = Record<string, unknown>;

const VERSIONS = ['3.0.3', '3.1.0'] as const;
const NOTE = { type: 'object', properties: { title: { type: 'string' } } };
/** Everything but an object a `content` can hold, with how the warning renders it. */
const NON_MAPS: Array<[kind: string, value: unknown, rendered: string]> = [
  ['a string', 'json', '"json"'],
  ['a media type written as a string', 'application/json', '"application/json"'],
  ['an array of media type names', ['application/json'], '["application/json"]'],
  ['an array of Media Type Objects', [{ schema: NOTE }], JSON.stringify([{ schema: NOTE }])],
  ['an empty array', [], '[]'],
  ['a number', 7, '7'],
  ['zero', 0, '0'],
  ['true', true, 'true'],
  ['false', false, 'false'],
  ['null', null, 'null'],
  ['an empty string', '', '""'],
];
/** Stands for a `content` that is not written at all. */
const ABSENT = Symbol('absent');
const info = { title: 'Repro', version: '1.0.0' };
const ok = { '200': { description: 'ok' } };
const none = { '204': { description: 'none' } };
/** `base` with the given `content`, or as it is for `ABSENT`. */
const holding = (base: Doc, content: unknown): Doc => (content === ABSENT ? base : { ...base, content });

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Write `doc` to a temp file. */
function write(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-710-'));
  dirs.push(dir);
  const file = join(dir, 'spec.json');
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

/** Parse `doc` from a file, as the issue does, collecting every warning the parse prints. */
async function parse(doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const spec = await parseSpec(write(doc));
    return { spec, warnings: warn.mock.calls.map((call) => String(call[0])) };
  } finally {
    warn.mockRestore();
  }
}

/** The exit code `oagen diff` ends with for the two documents. */
async function diffExitCode(oldDoc: unknown, newDoc: unknown): Promise<number> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const err: any = await diffCommand({ old: write(oldDoc), new: write(newDoc) }).catch((e) => e);
  expect(err).toBeDefined();
  return err.exitCode;
}

/**
 * `value` with the keys of every object in it written in the opposite order;
 * a list keeps its own, and so does what a `content` holds, which a warning
 * renders as written.
 */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, key === 'content' ? entry : reversed(entry)]),
  );
}

const operationsOf = (spec: ApiSpec): Operation[] => spec.services.flatMap((service) => service.operations);
const warning = (text: string) => `[oagen] Warning: ${text}`;
/** The warning for a `content` that is no map, at `site`. */
const notAMap = (site: string, rendered: string) =>
  warning(`content of ${site} is not a map of media types (${rendered}); reading no media type from it.`);

/** The lines the issue's script prints for a parsed document. */
function issueScript(spec: ApiSpec): string[] {
  return operationsOf(spec).map(
    ({ name, queryParams, requestBodyContentTypes, responseContentTypes }) =>
      `${name} ${JSON.stringify({
        queryParams: queryParams.map(({ contentTypes, name }) => ({ contentTypes, name })),
        requestBodyContentTypes,
        responseContentTypes,
      })}`,
  );
}

/**
 * The issue's `repro.json`: `GET /notes` (`listNotes`) with a query
 * parameter `filter` and a `200`, and `POST /notes` (`createNote`) with a
 * request body, answering `204` — each holding the given `content`.
 */
function reproDoc(content: unknown, openapi: string): Doc {
  return {
    openapi,
    info,
    paths: {
      '/notes': {
        get: {
          operationId: 'listNotes',
          parameters: [holding({ name: 'filter', in: 'query' }, content)],
          responses: { '200': holding({ description: 'ok' }, content) },
        },
        post: {
          operationId: 'createNote',
          requestBody: holding({}, content),
          responses: none,
        },
      },
    },
    components: { schemas: {} },
  };
}

const listNotes = (operation: Doc, openapi: string, extra: Doc = {}, pathItem: Doc = {}): Doc => ({
  openapi,
  info,
  paths: { '/notes': { ...pathItem, get: { operationId: 'listNotes', responses: ok, ...operation } } },
  ...extra,
});
const createNote = (operation: Doc, openapi: string, extra: Doc = {}): Doc => ({
  openapi,
  info,
  paths: { '/notes': { post: { operationId: 'createNote', responses: none, ...operation } } },
  ...extra,
});
const webhook = (operation: Doc, openapi: string, extra: Doc = {}): Doc => ({
  openapi,
  info,
  paths: {},
  webhooks: { noteAdded: { post: { responses: ok, ...operation } } },
  ...extra,
});
const callback = (operation: Doc, openapi: string): Doc =>
  createNote(
    { callbacks: { noteAdded: { '{$request.body#/url}': { post: { responses: ok, ...operation } } } } },
    openapi,
  );
/** `listNotes` answering `200` beside the response under `key`, or under `200` itself. */
const responding = (key: string, response: Doc, openapi: string, extra: Doc = {}): Doc =>
  listNotes({ responses: { ...(key === '200' ? {} : ok), [key]: response } }, openapi, extra);

const WEBHOOK = 'webhooks.noteAdded.post';
const CALLBACK = 'createNote.callbacks.noteAdded.{$request.body#/url}.post';

interface Site {
  label: string;
  /** The site as the warning names it. */
  site: string;
  /** The document with `content` at the site, or with none there for `ABSENT`. */
  build: (content: unknown, openapi: string) => Doc;
}

/** Every site a `content` is read at, each as one document. */
const SITES: Site[] = [
  // --- a parameter --------------------------------------------------------------
  {
    label: "an operation's query parameter",
    site: 'the parameter "filter" (in: query) of listNotes',
    build: (c, v) => listNotes({ parameters: [holding({ name: 'filter', in: 'query' }, c)] }, v),
  },
  {
    label: "a path item's query parameter",
    site: 'the parameter "filter" (in: query) of listNotes',
    build: (c, v) => listNotes({}, v, {}, { parameters: [holding({ name: 'filter', in: 'query' }, c)] }),
  },
  {
    label: 'a header parameter through `components/parameters`',
    site: 'the parameter "X-Filter" (in: header) of listNotes',
    build: (c, v) =>
      listNotes({ parameters: [{ $ref: '#/components/parameters/Filter' }] }, v, {
        components: { parameters: { Filter: holding({ name: 'X-Filter', in: 'header' }, c) } },
      }),
  },
  {
    label: 'a parameter through a chain of `components/parameters` refs',
    site: 'the parameter "filter" (in: query) of listNotes',
    build: (c, v) =>
      listNotes({ parameters: [{ $ref: '#/components/parameters/Alias' }] }, v, {
        components: {
          parameters: {
            Alias: { $ref: '#/components/parameters/Filter' },
            Filter: holding({ name: 'filter', in: 'query' }, c),
          },
        },
      }),
  },
  {
    label: 'a cookie parameter',
    site: 'the parameter "sid" (in: cookie) of listNotes',
    build: (c, v) => listNotes({ parameters: [holding({ name: 'sid', in: 'cookie' }, c)] }, v),
  },
  {
    label: 'a path parameter',
    site: 'the parameter "id" (in: path) of getNote',
    build: (c, v) => ({
      openapi: v,
      info,
      paths: {
        '/notes/{id}': {
          get: {
            operationId: 'getNote',
            parameters: [holding({ name: 'id', in: 'path', required: true }, c)],
            responses: ok,
          },
        },
      },
    }),
  },
  {
    label: 'a parameter of an operation named from its path',
    site: 'the parameter "filter" (in: query) of GET /notes',
    build: (c, v) => ({
      openapi: v,
      info,
      paths: { '/notes': { get: { parameters: [holding({ name: 'filter', in: 'query' }, c)], responses: ok } } },
    }),
  },
  // --- a request body -----------------------------------------------------------
  {
    label: 'a request body',
    site: 'the request body of createNote',
    build: (c, v) => createNote({ requestBody: holding({ description: 'A note.', required: true }, c) }, v),
  },
  {
    label: 'a request body through `components/requestBodies`',
    site: 'the request body of createNote',
    build: (c, v) =>
      createNote({ requestBody: { $ref: '#/components/requestBodies/NewNote' } }, v, {
        components: { requestBodies: { NewNote: holding({ required: true }, c) } },
      }),
  },
  {
    label: 'a request body of an operation named from its path, which the name rehearsals read too',
    site: 'the request body of POST /notes',
    build: (c, v) => ({
      openapi: v,
      info,
      paths: { '/notes': { post: { requestBody: holding({}, c), responses: none } } },
    }),
  },
  // --- a response ---------------------------------------------------------------
  ...['200', '201', '302', '404', '503', 'default', '2XX', '4XX', '5xx'].map((key): Site => ({
    label: `a \`${key}\` response`,
    site: `the ${key} response of listNotes`,
    build: (c, v) => responding(key, holding({ description: 'It.' }, c), v),
  })),
  ...['200', '302', '404', 'default', '4XX'].map((key): Site => ({
    label: `a \`${key}\` response through \`components/responses\``,
    site: `the ${key} response of listNotes`,
    build: (c, v) =>
      responding(key, { $ref: '#/components/responses/Notes' }, v, {
        components: { responses: { Notes: holding({ description: 'It.' }, c) } },
      }),
  })),
  {
    label: 'a `200` response of an operation named from its path, which the name rehearsals read too',
    site: 'the 200 response of GET /notes',
    build: (c, v) => ({
      openapi: v,
      info,
      paths: { '/notes': { get: { responses: { '200': holding({ description: 'It.' }, c) } } } },
    }),
  },
  // --- a response header --------------------------------------------------------
  ...(
    [
      ['200', '200'],
      ['404', '404'],
      ['default', 'Default'],
      ['4XX', 'ClientError'],
    ] as const
  ).map(([key, label]): Site => ({
    label: `a header of a \`${key}\` response`,
    site: `the response header "X-Rate" (${label}) of listNotes`,
    build: (c, v) =>
      responding(key, { description: 'It.', headers: { 'X-Rate': holding({ description: 'The rate.' }, c) } }, v),
  })),
  {
    label: 'a response header through `components/headers`',
    site: 'the response header "X-Rate" (200) of listNotes',
    build: (c, v) =>
      responding('200', { description: 'It.', headers: { 'X-Rate': { $ref: '#/components/headers/Rate' } } }, v, {
        components: { headers: { Rate: holding({ description: 'The rate.' }, c) } },
      }),
  },
  // --- a webhook and a callback, whose requests the same readers read ------------
  {
    label: "a webhook's header parameter",
    site: `the parameter "X-Signature" (in: header) of ${WEBHOOK}`,
    build: (c, v) => webhook({ parameters: [holding({ name: 'X-Signature', in: 'header' }, c)] }, v),
  },
  {
    label: "a webhook's request body",
    site: `the request body of ${WEBHOOK}`,
    build: (c, v) => webhook({ requestBody: holding({ description: 'A note.' }, c) }, v),
  },
  {
    label: "a webhook's request body through `components/requestBodies`",
    site: `the request body of ${WEBHOOK}`,
    build: (c, v) =>
      webhook({ requestBody: { $ref: '#/components/requestBodies/NewNote' } }, v, {
        components: { requestBodies: { NewNote: holding({ description: 'A note.' }, c) } },
      }),
  },
  {
    label: "a callback's query parameter",
    site: `the parameter "token" (in: query) of ${CALLBACK}`,
    build: (c, v) => callback({ parameters: [holding({ name: 'token', in: 'query' }, c)] }, v),
  },
  {
    label: "a callback's request body",
    site: `the request body of ${CALLBACK}`,
    build: (c, v) => callback({ requestBody: holding({}, c) }, v),
  },
];

describe('#710 a `content` that is not an object declares no media type', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it("runs the issue's script over repro.json: no index is a media type, and each `content` is named once", async () => {
      const { spec, warnings } = await parse(reproDoc('json', openapi));

      // Was `listNotes {"queryParams":[{"contentTypes":["0","1","2","3"],"name":"filter"}],"responseContentTypes":["0","1","2","3"]}`
      // and `createNote {"queryParams":[],"requestBodyContentTypes":["0","1","2","3"]}`.
      expect(issueScript(spec)).toEqual([
        'listNotes {"queryParams":[{"name":"filter"}]}',
        'createNote {"queryParams":[]}',
      ]);
      // Was `Parameter "filter" (in: query) on listNotes is typed as a string: none of its content media types
      // (0, 1, 2, 3) is read. …` and `Request body of createNote is not read as requestBody: none of its media
      // types (0, 1, 2, 3) is one the parser reads …`, the response not named at all.
      expect(warnings).toEqual([
        notAMap('the parameter "filter" (in: query) of listNotes', '"json"'),
        notAMap('the 200 response of listNotes', '"json"'),
        notAMap('the request body of createNote', '"json"'),
      ]);
      // The document is read as the one that writes no `content` anywhere.
      const absent = await parse(reproDoc(ABSENT, openapi));
      expect(absent.warnings).toEqual([]);
      expect(spec).toEqual(absent.spec);
      // A string parameter, a response and a request that declare no body: no media type anywhere.
      expect(JSON.parse(JSON.stringify(operationsOf(spec)))).toMatchInlineSnapshot(`
        [
          {
            "errors": [],
            "headerParams": [],
            "httpMethod": "get",
            "injectIdempotencyKey": false,
            "name": "listNotes",
            "operationId": "listNotes",
            "path": "/notes",
            "pathParams": [],
            "queryParams": [
              {
                "name": "filter",
                "required": false,
                "type": {
                  "kind": "primitive",
                  "type": "string",
                },
              },
            ],
            "response": {
              "kind": "primitive",
              "type": "unknown",
            },
            "responseDescription": "ok",
            "responseStatusCode": 200,
          },
          {
            "errors": [],
            "headerParams": [],
            "httpMethod": "post",
            "injectIdempotencyKey": false,
            "name": "createNote",
            "operationId": "createNote",
            "path": "/notes",
            "pathParams": [],
            "queryParams": [],
            "response": {
              "kind": "primitive",
              "type": "unknown",
            },
            "responseDescription": "none",
            "responseStatusCode": 204,
          },
        ]
      `);
    });

    it.each(NON_MAPS)(
      'reads the issue document holding %s as the one without any `content`',
      async (_kind, value, rendered) => {
        const absent = await parse(reproDoc(ABSENT, openapi));
        const { spec, warnings } = await parse(reproDoc(value, openapi));

        expect(spec).toEqual(absent.spec);
        expect(diffSpecs(absent.spec, spec).changes).toEqual([]);
        expect(diffSpecs(spec, absent.spec).changes).toEqual([]);
        expect(warnings).toEqual([
          notAMap('the parameter "filter" (in: query) of listNotes', rendered),
          notAMap('the 200 response of listNotes', rendered),
          notAMap('the request body of createNote', rendered),
        ]);
      },
    );

    describe('at every site a `content` is read at, whatever it holds', () => {
      it.each(SITES)('$label: read as absent, after one warning naming the site', async ({ site, build }) => {
        const absent = await parse(build(ABSENT, openapi));
        expect(absent.warnings).toEqual([]);
        for (const [, value, rendered] of NON_MAPS) {
          const { spec, warnings } = await parse(build(value, openapi));
          // One warning for the one `content`, however many readers visit it.
          expect(warnings).toEqual([notAMap(site, rendered)]);
          expect(spec).toEqual(absent.spec);
          // And wherever the document writes it: `components` ahead of `paths`, `content` ahead of its siblings.
          const backward = await parse(reversed(build(value, openapi)));
          expect(backward.warnings).toEqual(warnings);
          expect(backward.spec).toEqual(spec);
        }
      });

      it.each(SITES)('$label: still read from a map, and silently from an empty one', async ({ build }) => {
        const absent = await parse(build(ABSENT, openapi));
        // An empty map declares no media type, and is a map: nothing to report.
        const empty = await parse(build({}, openapi));
        expect(empty.warnings).toEqual([]);
        expect(empty.spec).toEqual(absent.spec);
        // A map is read: the site is typed from the schema it declares.
        const read = await parse(build({ 'application/json': { schema: NOTE } }, openapi));
        expect(read.warnings).toEqual([]);
        expect(JSON.stringify(read.spec)).toContain('"title"');
        expect(JSON.stringify(absent.spec)).not.toContain('"title"');
      });
    });

    it('never reads an array by its indexes: a Media Type Object in one types nothing and mints no model', async () => {
      const inArray = [{ schema: NOTE }];
      const doc = (content: unknown) => ({
        openapi,
        info,
        paths: {
          '/notes': {
            post: {
              operationId: 'createNote',
              parameters: [{ name: 'filter', in: 'query', content }],
              requestBody: { content },
              responses: {
                '200': { description: 'ok', content, headers: { 'X-Note': { content } } },
                '404': { description: 'gone', content },
                default: { description: 'else', content },
              },
            },
          },
        },
      });

      const { spec, warnings } = await parse(doc(inArray));
      const rendered = JSON.stringify(inArray);
      expect(warnings).toEqual([
        notAMap('the parameter "filter" (in: query) of createNote', rendered),
        notAMap('the request body of createNote', rendered),
        notAMap('the response header "X-Note" (200) of createNote', rendered),
        notAMap('the 200 response of createNote', rendered),
        notAMap('the 404 response of createNote', rendered),
        notAMap('the default response of createNote', rendered),
      ]);
      // Was a request body and three responses each carrying a media type `0` typed from the schema, under
      // models named for it (`CreateNote0Request`, …).
      expect(spec.models).toEqual([]);
      expect(JSON.stringify(spec)).not.toContain('contentType');
      const [op] = operationsOf(spec);
      expect(op.queryParams.map(({ name, type }) => ({ name, type }))).toEqual([
        { name: 'filter', type: { kind: 'primitive', type: 'string' } },
      ]);
      expect(op.responseHeaders).toEqual([
        { name: 'X-Note', type: { kind: 'primitive', type: 'string' }, required: false, description: undefined },
      ]);
      expect(op.errors).toEqual([{ statusCode: 404, type: undefined, description: 'gone' }]);
      expect(op.defaultResponse).toEqual({ description: 'else' });

      // The same Media Type Object under a key of a map is read, at every one of those sites.
      const mapped = await parse(doc({ 'application/json': inArray[0] }));
      expect(mapped.warnings).toEqual([]);
      expect(mapped.spec.models.map(({ name }) => name)).not.toEqual([]);
      const [typed] = operationsOf(mapped.spec);
      expect(typed.queryParams[0]!.contentTypes).toEqual(['application/json']);
      expect(typed.requestBodyContentTypes).toEqual(['application/json']);
      expect(typed.responseContentTypes).toEqual(['application/json']);
      expect(typed.defaultResponse?.contentTypes).toEqual(['application/json']);
    });

    it('still reads a key of a map as the media type it declares, an index-like `0` included', async () => {
      // What declares a media type is a key of a map, however it is spelled; only a value that is no map has none.
      const zero = { '0': { schema: NOTE } };
      const { spec, warnings } = await parse(reproDoc(zero, openapi));

      expect(issueScript(spec)).toEqual([
        'listNotes {"queryParams":[{"contentTypes":["0"],"name":"filter"}],"responseContentTypes":["0"]}',
        'createNote {"queryParams":[],"requestBodyContentTypes":["0"]}',
      ]);
      expect(warnings).toEqual([
        warning(
          'Parameter "filter" (in: query) on listNotes is typed as a string: none of its content media types (0) ' +
            'is read. A parameter or response header declared with content is read from application/json or a +json ' +
            'media type when the entry declares a schema, and from text/plain with or without one, parameters and ' +
            'case aside.',
        ),
        warning(
          'Request body of createNote is not read as requestBody: none of its media types (0) is one the parser ' +
            'reads — application/json or a concrete +json media type, multipart/form-data or ' +
            'application/x-www-form-urlencoded with a schema, application/octet-stream or text/plain with or ' +
            'without one, parameters and case aside. It is carried in requestBodyContents only.',
        ),
      ]);
    });

    it('reads the rest of the operation the same wherever the malformed `content` sits', async () => {
      const good = { 'application/json': { schema: NOTE } };
      const doc = (first: unknown, second: unknown) =>
        createNote(
          {
            parameters: [
              { name: 'a', in: 'query', content: first },
              { name: 'b', in: 'query', content: second },
            ],
            responses: {
              '200': { description: 'ok', content: first },
              '201': { description: 'made', content: second },
            },
          },
          openapi,
        );
      const summary = (spec: ApiSpec) => {
        const [op] = operationsOf(spec);
        return {
          params: Object.fromEntries(op.queryParams.map(({ name, contentTypes }) => [name, contentTypes])),
          responses: Object.fromEntries(
            (op.successResponses ?? []).map(({ statusCode, contentTypes }) => [statusCode, contentTypes]),
          ),
          models: spec.models.map(({ name }) => name).sort(),
        };
      };

      const badFirst = await parse(doc('json', good));
      const badLast = await parse(doc(good, 'json'));
      expect(summary(badFirst.spec)).toEqual({
        params: { a: undefined, b: ['application/json'] },
        responses: { 200: undefined, 201: ['application/json'] },
        models: ['CreateNoteResponse', 'NotesB'],
      });
      expect(summary(badLast.spec)).toEqual({
        params: { a: ['application/json'], b: undefined },
        responses: { 200: ['application/json'], 201: undefined },
        models: ['CreateNoteResponse', 'NotesA'],
      });
      expect(badFirst.warnings).toEqual([
        notAMap('the parameter "a" (in: query) of createNote', '"json"'),
        notAMap('the 200 response of createNote', '"json"'),
      ]);
      expect(badLast.warnings).toEqual([
        notAMap('the parameter "b" (in: query) of createNote', '"json"'),
        notAMap('the 201 response of createNote', '"json"'),
      ]);
    });

    describe('one warning per site that reads the `content`', () => {
      it("names each operation that reads a path item's parameter", async () => {
        const { warnings } = await parse({
          openapi,
          info,
          paths: {
            '/notes': {
              parameters: [{ name: 'filter', in: 'query', content: 'json' }],
              get: { operationId: 'listNotes', responses: ok },
              post: { operationId: 'createNote', responses: none },
            },
          },
        });
        expect(warnings).toEqual([
          notAMap('the parameter "filter" (in: query) of listNotes', '"json"'),
          notAMap('the parameter "filter" (in: query) of createNote', '"json"'),
        ]);
      });

      it('names each response a `components/responses` entry is returned as, and each operation', async () => {
        const notes = { $ref: '#/components/responses/Notes' };
        const { spec, warnings } = await parse({
          openapi,
          info,
          paths: {
            '/notes': {
              get: { operationId: 'listNotes', responses: { '200': notes, default: notes } },
              post: { operationId: 'createNote', responses: { '201': notes } },
            },
          },
          components: { responses: { Notes: { description: 'Notes.', content: ['application/json'] } } },
        });
        expect(warnings).toEqual([
          notAMap('the 200 response of listNotes', '["application/json"]'),
          notAMap('the default response of listNotes', '["application/json"]'),
          notAMap('the 201 response of createNote', '["application/json"]'),
        ]);
        expect(JSON.stringify(spec)).not.toContain('contentType');
      });

      it('names a request body `components/requestBodies` entry once per operation and webhook that sends it', async () => {
        const newNote = { $ref: '#/components/requestBodies/NewNote' };
        const { warnings } = await parse({
          openapi,
          info,
          paths: {
            '/notes': {
              post: { operationId: 'createNote', requestBody: newNote, responses: none },
              put: { operationId: 'replaceNote', requestBody: newNote, responses: none },
            },
          },
          webhooks: { noteAdded: { post: { requestBody: newNote, responses: ok } } },
          components: { requestBodies: { NewNote: { content: 7 } } },
        });
        expect(warnings).toEqual([
          notAMap('the request body of createNote', '7'),
          notAMap('the request body of replaceNote', '7'),
          notAMap(`the request body of ${WEBHOOK}`, '7'),
        ]);
      });

      it('says nothing of a `components` entry no site refers to', async () => {
        const { warnings } = await parse(
          listNotes({}, openapi, {
            components: {
              parameters: { Filter: { name: 'filter', in: 'query', content: 'json' } },
              requestBodies: { NewNote: { content: 'json' } },
              responses: { Notes: { description: 'Notes.', content: 'json' } },
              headers: { Rate: { content: 'json' } },
            },
          }),
        );
        expect(warnings).toEqual([]);
      });
    });

    describe('a `content` no reader reads is not reported', () => {
      it('beside a `schema`, which types the parameter or the header alone', async () => {
        const typed = (content: unknown) =>
          listNotes(
            {
              parameters: [holding({ name: 'limit', in: 'query', schema: { type: 'integer' } }, content)],
              responses: {
                '200': {
                  description: 'ok',
                  headers: { 'X-Rate': holding({ schema: { type: 'integer' } }, content) },
                },
              },
            },
            openapi,
          );
        const absent = await parse(typed(ABSENT));
        for (const [, value] of NON_MAPS) {
          const { spec, warnings } = await parse(typed(value));
          expect(warnings).toEqual([]);
          expect(spec).toEqual(absent.spec);
        }
        const [op] = operationsOf(absent.spec);
        expect(op.queryParams[0]!.type).toEqual({ kind: 'primitive', type: 'integer' });
        expect(op.responseHeaders![0]!.type).toEqual({ kind: 'primitive', type: 'integer' });
      });

      it('on a path item parameter the operation replaces with one of its own', async () => {
        const { spec, warnings } = await parse(
          listNotes(
            { parameters: [{ name: 'filter', in: 'query', schema: { type: 'integer' } }] },
            openapi,
            {},
            { parameters: [{ name: 'filter', in: 'query', content: 'json' }] },
          ),
        );
        expect(warnings).toEqual([]);
        expect(operationsOf(spec)[0]!.queryParams.map(({ name, type }) => ({ name, type }))).toEqual([
          { name: 'filter', type: { kind: 'primitive', type: 'integer' } },
        ]);
      });

      it('on a header OpenAPI says to ignore, or the idempotency header the SDK injects', async () => {
        const headers = (content: unknown) =>
          createNote(
            {
              parameters: [
                holding({ name: 'Accept', in: 'header' }, content),
                holding({ name: 'Idempotency-Key', in: 'header' }, content),
              ],
              responses: {
                '200': { description: 'ok', headers: { 'Content-Type': holding({}, content) } },
              },
            },
            openapi,
          );
        const absent = await parse(headers(ABSENT));
        const { spec, warnings } = await parse(headers('json'));
        expect(warnings).toEqual([]);
        expect(spec).toEqual(absent.spec);
        expect(operationsOf(spec)[0]!.headerParams).toEqual([]);
      });

      it('on a 1xx response, and on a response of a webhook or a callback, whose bodies are not typed', async () => {
        const answering = (content: unknown) => ({ responses: { '200': holding({ description: 'ok' }, content) } });
        const informational = (content: unknown) =>
          responding('103', holding({ description: 'Hints.' }, content), openapi);
        const ofWebhook = (content: unknown) => webhook(answering(content), openapi);
        const ofCallback = (content: unknown) => callback(answering(content), openapi);
        for (const build of [informational, ofWebhook, ofCallback]) {
          const absent = await parse(build(ABSENT));
          for (const [, value] of NON_MAPS) {
            const { spec, warnings } = await parse(build(value));
            expect(warnings).toEqual([]);
            expect(spec).toEqual(absent.spec);
          }
        }
      });
    });

    describe('oagen diff', () => {
      it.each([
        ['a string', 'json'],
        ['an array', ['application/json']],
        ['an array of Media Type Objects', [{ schema: NOTE }]],
        ['null', null],
      ])('against the document without any `content`, both ways, exits 0 for %s', async (_kind, value) => {
        // Was exit 2 both ways for a string: `param-content-type-changed` on `filter` (`content type <schema> →
        // 0 (unread)`) and the media types `0`–`3` added to, or removed from, the `200` response.
        const old = reproDoc(ABSENT, openapi);
        const repro = reproDoc(value, openapi);
        expect(await diffExitCode(old, repro)).toBe(0);
        expect(await diffExitCode(repro, old)).toBe(0);
        expect(await diffExitCode(repro, repro)).toBe(0);
      });

      it('between the inline and the `$ref` spelling of each site, both ways, exits 0', async () => {
        const inline = {
          openapi,
          info,
          paths: {
            '/notes': {
              post: {
                operationId: 'createNote',
                parameters: [{ name: 'filter', in: 'query', content: 'json' }],
                requestBody: { content: 'json' },
                responses: {
                  '200': { description: 'ok', content: 'json', headers: { 'X-Rate': { content: 'json' } } },
                },
              },
            },
          },
        };
        const viaRef = {
          openapi,
          info,
          paths: {
            '/notes': {
              post: {
                operationId: 'createNote',
                parameters: [{ $ref: '#/components/parameters/Filter' }],
                requestBody: { $ref: '#/components/requestBodies/NewNote' },
                responses: { '200': { $ref: '#/components/responses/Notes' } },
              },
            },
          },
          components: {
            parameters: { Filter: { name: 'filter', in: 'query', content: 'json' } },
            requestBodies: { NewNote: { content: 'json' } },
            responses: {
              Notes: {
                description: 'ok',
                content: 'json',
                headers: { 'X-Rate': { $ref: '#/components/headers/Rate' } },
              },
            },
            headers: { Rate: { content: 'json' } },
          },
        };
        const a = await parse(inline);
        const b = await parse(viaRef);
        expect(b.warnings).toEqual(a.warnings);
        expect(a.warnings).toEqual([
          notAMap('the parameter "filter" (in: query) of createNote', '"json"'),
          notAMap('the request body of createNote', '"json"'),
          notAMap('the response header "X-Rate" (200) of createNote', '"json"'),
          notAMap('the 200 response of createNote', '"json"'),
        ]);
        expect(b.spec).toEqual(a.spec);
        expect(await diffExitCode(inline, viaRef)).toBe(0);
        expect(await diffExitCode(viaRef, inline)).toBe(0);
      });
    });
  });

  describe('mediaTypesOf', () => {
    it('hands back the map itself, an empty one included, without a word', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const map = { 'application/json': { schema: NOTE } };
      const empty = {};
      expect(mediaTypesOf(map, 'the request body of createNote')).toBe(map);
      expect(mediaTypesOf(empty, 'the request body of createNote')).toBe(empty);
      expect(mediaTypesOf(map)).toBe(map);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads an absent `content` as no map without a word, with or without a site', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(mediaTypesOf(undefined)).toBeUndefined();
      expect(mediaTypesOf(undefined, 'the request body of createNote')).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(NON_MAPS)('reads %s as no map: named once for a site, silently for none', (_kind, value, rendered) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(mediaTypesOf(value)).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(mediaTypesOf(value, 'the 200 response of listNotes')).toBeUndefined();
      expect(warn.mock.calls).toEqual([[notAMap('the 200 response of listNotes', rendered)]]);
    });
  });

  describe('the readers of a `content`, asked directly', () => {
    it.each(NON_MAPS)('pick nothing from %s, and list no media type, without a word', (_kind, value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const declaration = { content: value } as SchemaOrContent;
      const body = { content: value } as RequestBodyObject;

      expect(selectParameterContent(declaration.content)).toBeUndefined();
      expect(parameterTyping(declaration)).toEqual({});
      expect(parameterSchema(declaration)).toBeUndefined();
      expect(selectRequestBodyContent(body)).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('report a `content` that is no map in its own sentence, and not as a map nothing is read from', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      warnUnreadParameterContent(
        { content: 'json' } as unknown as SchemaOrContent,
        'Parameter "filter" (in: query) on listNotes',
        'the parameter "filter" (in: query) of listNotes',
      );
      warnUnreadRequestBody({ content: ['application/json'] } as unknown as RequestBodyObject, 'createNote');
      expect(warn.mock.calls).toEqual([
        [notAMap('the parameter "filter" (in: query) of listNotes', '"json"')],
        [notAMap('the request body of createNote', '["application/json"]')],
      ]);
    });

    it('say nothing of a `content` beside a `schema`, of an absent one or of an empty map', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const subject = 'Parameter "filter" (in: query) on listNotes';
      const site = 'the parameter "filter" (in: query) of listNotes';
      warnUnreadParameterContent(
        { schema: { type: 'string' }, content: 'json' } as unknown as SchemaOrContent,
        subject,
        site,
      );
      warnUnreadParameterContent({}, subject, site);
      warnUnreadParameterContent({ content: {} }, subject, site);
      warnUnreadRequestBody(undefined, 'createNote');
      warnUnreadRequestBody({}, 'createNote');
      warnUnreadRequestBody({ content: {} }, 'createNote');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('readSchemaSites', () => {
    /** Every schema the walk visits in a document that writes `content` at each kind of site. */
    const visited = (content: unknown): unknown[] => {
      const schemas: unknown[] = [];
      readSchemaSites(
        {
          openapi: '3.1.0',
          info,
          paths: {
            '/notes': {
              post: {
                operationId: 'createNote',
                parameters: [{ name: 'filter', in: 'query', content }],
                requestBody: { content },
                responses: { '200': { description: 'ok', content, headers: { 'X-Note': { content } } } },
              },
            },
          },
          webhooks: { noteAdded: { post: { requestBody: { content }, responses: ok } } },
        },
        (schema) => schemas.push(schema),
      );
      return schemas;
    };

    it('visits no schema of a `content` that is no map, as the readers type none from it', () => {
      for (const [, value] of NON_MAPS) expect(visited(value)).toEqual([]);
    });

    it('visits the schema under each key of a map', () => {
      expect(visited({ 'application/json': { schema: NOTE } })).toEqual([NOTE, NOTE, NOTE, NOTE, NOTE]);
    });
  });
});
