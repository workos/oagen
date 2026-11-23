import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { responseHeadersOf } from '../../src/parser/response-refs.js';
import { readSchemaSites } from '../../src/parser/schema-sites.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Operation, ResponseHeader } from '../../src/ir/types.js';

/**
 * Issue #729: a response's `headers` was read with `Object.entries`,
 * whatever it held, and each value handed to `followReference`, which asks
 * `'$ref' in` it. A string or a list of names in its place is no map of
 * Header Objects, but it reached that walk one character or one element at
 * a time and failed the whole parse with a `TypeError` that named neither
 * the operation nor the response; a header entry that is no object
 * (`"X-Rate-Limit": "integer"`) failed the same way; and a list of Header
 * Objects was read by its indexes, so its first element became a response
 * header named `0`. Every reader now takes the map from one check
 * (`responseHeadersOf`): a `headers` that is no object declares no header,
 * as an absent one declares none, after one warning naming the response and
 * the value; and an entry that is no object is no Header Object
 * (`isReferenceEntry`), warned about and skipped as the `components/headers`
 * entry a `$ref` leads to already was.
 */

type Doc = Record<string, unknown>;

const VERSIONS = ['3.0.3', '3.1.0'] as const;
const INT = { schema: { type: 'integer' } };
const STR = { schema: { type: 'string' } };
const NOTE = { type: 'object', properties: { title: { type: 'string' } } };
/** Everything but an object a `headers` can hold, with how the warning renders it. */
const NON_MAPS: Array<[kind: string, value: unknown, rendered: string]> = [
  ['a header name written as a string', 'X-Rate-Limit', '"X-Rate-Limit"'],
  ['an array of header names', ['X-Rate-Limit'], '["X-Rate-Limit"]'],
  ['an array of Header Objects', [INT], JSON.stringify([INT])],
  ['an empty array', [], '[]'],
  ['a number', 7, '7'],
  ['zero', 0, '0'],
  ['true', true, 'true'],
  ['false', false, 'false'],
  ['null', null, 'null'],
  ['an empty string', '', '""'],
];
/** Everything but an object one entry of a `headers` map can hold, with how the warning renders it. */
const NON_OBJECTS: Array<[kind: string, value: unknown, rendered: string]> = [
  ['a type written as a string', 'integer', '"integer"'],
  ['an array of type names', ['integer'], '["integer"]'],
  ['an array of Header Objects', [INT], JSON.stringify([INT])],
  ['an empty array', [], '[]'],
  ['a number', 7, '7'],
  ['zero', 0, '0'],
  ['true', true, 'true'],
  ['false', false, 'false'],
  ['null', null, 'null'],
  ['an empty string', '', '""'],
];
/** Stands for a `headers`, or one entry of it, that is not written at all. */
const ABSENT = Symbol('absent');
const info = { title: 'Repro', version: '1.0.0' };
const ok = { '200': { description: 'ok' } };
/** A response that declares a string body, as the issue's does. */
const answer = { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } };
/** `base` with the given `headers`, or as it is for `ABSENT`. */
const holding = (base: Doc, headers: unknown): Doc => (headers === ABSENT ? base : { ...base, headers });
/** A `headers` map declaring `X-Kept`, after `X-Rate-Limit` as `entry` unless that is `ABSENT`. */
const beside = (entry: unknown): Doc => ({ ...(entry === ABSENT ? {} : { 'X-Rate-Limit': entry }), 'X-Kept': STR });

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Write `doc` to a temp file. */
function write(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-729-'));
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
 * a list keeps its own, and so does what a `headers` holds, which a warning
 * renders as written and whose order is the order of the headers.
 */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, key === 'headers' ? entry : reversed(entry)]),
  );
}

const operationsOf = (spec: ApiSpec): Operation[] => spec.services.flatMap((service) => service.operations);
const warning = (text: string) => `[oagen] Warning: ${text}`;
/** The warning for a `headers` that is no map, on `response`. */
const notAMap = (response: string, rendered: string) =>
  warning(`headers of ${response} is not a map of headers (${rendered}); reading no header from it.`);
/** The warning for an entry of a `headers` map that is no object, on `operation`. */
const notAHeader = (operation: string, name: string, rendered: string) =>
  warning(`the response header "${name}" of ${operation} is not a Header Object (${rendered}); skipping it.`);
/** The warning for a `$ref` that ends on a `components/headers` entry that is no object. */
const notAHeaderComponent = (component: string, operation: string, name: string, rendered: string) =>
  warning(
    `components/headers/${component} (the response header "${name}" of ${operation}) is not a Header Object ` +
      `(${rendered}); skipping it.`,
  );
/** The warning for two keys of one `headers` map that differ in case alone. */
const declaredTwice = (later: string, earlier: string, where: string) =>
  warning(
    `Response header "${later}" on ${where} is also declared as "${earlier}"; header names are case-insensitive, ` +
      `so the later declaration is used.`,
  );

const shown = ({ name, type }: ResponseHeader): string =>
  `${name}: ${type.kind === 'primitive' ? type.type : type.kind === 'model' || type.kind === 'enum' ? type.name : type.kind}`;
/** Every header an operation carries, by the response it sits on. */
function headersOf(op: Operation): Record<string, string[]> {
  const lists: Array<[string, ResponseHeader[] | undefined]> = [
    ['primary', op.responseHeaders],
    ...(op.successResponses ?? []).map((r): [string, ResponseHeader[] | undefined] => [
      String(r.statusCode),
      r.headers,
    ]),
    ...op.errors.map((r): [string, ResponseHeader[] | undefined] => [String(r.statusCode), r.headers]),
    ['default', op.defaultResponse?.headers],
    ...(op.rangeResponses ?? []).map((r): [string, ResponseHeader[] | undefined] => [r.range, r.headers]),
  ];
  return Object.fromEntries(lists.filter(([, list]) => list !== undefined).map(([at, list]) => [at, list!.map(shown)]));
}

/** The line the issue's script prints for a parsed document. */
function issueScript(file: string, spec: ApiSpec): string {
  const [{ responseHeaders }] = operationsOf(spec);
  return `${file} ${JSON.stringify((responseHeaders ?? []).map(({ name, type }) => `${name}: ${(type as { type?: string }).type}`))}`;
}

/** The issue's document: `GET /notes` (`listNotes`) answering `key` with a string body and the given `headers`. */
function issueDoc(headers: unknown, openapi: string, key = '200'): Doc {
  return {
    openapi,
    info,
    paths: {
      '/notes': {
        get: { operationId: 'listNotes', responses: { ...(key === '200' ? {} : ok), [key]: holding(answer, headers) } },
      },
    },
    components: { schemas: {} },
  };
}
/** The issue's four documents, by file name. */
const ISSUE_DOCUMENTS: Array<[file: string, headers: unknown]> = [
  ['string.json', 'X-Rate-Limit'],
  ['list.json', ['X-Rate-Limit']],
  ['list-of-headers.json', [INT]],
  ['header-string.json', { 'X-Rate-Limit': 'integer' }],
];

const listNotes = (operation: Doc, openapi: string, extra: Doc = {}): Doc => ({
  openapi,
  info,
  paths: { '/notes': { get: { operationId: 'listNotes', responses: ok, ...operation } } },
  ...extra,
});
const createNote = (operation: Doc, openapi: string, extra: Doc = {}): Doc => ({
  openapi,
  info,
  paths: { '/notes': { post: { operationId: 'createNote', responses: ok, ...operation } } },
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

interface Site {
  label: string;
  /** The response as the warning for its `headers` names it. */
  response: string;
  /** The operation as the warning for one header names it. */
  operation: string;
  /** The document answering with `response` at the site. */
  build: (response: Doc, openapi: string) => Doc;
}

/** Every site a response's `headers` is read at, each as one document. */
const SITES: Site[] = [
  ...['200', '201', '302', '404', '503', 'default', '2XX', '4XX', '5xx'].map((key): Site => ({
    label: `a \`${key}\` response`,
    response: `the ${key} response of listNotes`,
    operation: 'listNotes',
    build: (response, v) => responding(key, response, v),
  })),
  ...['200', '302', '404', 'default', '4XX'].map((key): Site => ({
    label: `a \`${key}\` response through \`components/responses\``,
    response: `the ${key} response of listNotes`,
    operation: 'listNotes',
    build: (response, v) =>
      responding(key, { $ref: '#/components/responses/Notes' }, v, { components: { responses: { Notes: response } } }),
  })),
  {
    label: 'a response through a chain of `components/responses` refs',
    response: 'the 200 response of listNotes',
    operation: 'listNotes',
    build: (response, v) =>
      responding('200', { $ref: '#/components/responses/Alias' }, v, {
        components: { responses: { Alias: { $ref: '#/components/responses/Notes' }, Notes: response } },
      }),
  },
  {
    label: 'a `200` response of an operation named from its path, which the name rehearsals read too',
    response: 'the 200 response of GET /notes',
    operation: 'GET /notes',
    build: (response, v) => ({ openapi: v, info, paths: { '/notes': { get: { responses: { '200': response } } } } }),
  },
];

describe('#729 a response `headers` that is not an object declares no header', () => {
  describe.each(VERSIONS)('OpenAPI %s', (openapi) => {
    it("runs the issue's script over its four documents: each parses, and none declares a header", async () => {
      const printed: string[] = [];
      const warned: string[][] = [];
      for (const [file, headers] of ISSUE_DOCUMENTS) {
        const { spec, warnings } = await parse(issueDoc(headers, openapi));
        printed.push(issueScript(file, spec));
        warned.push(warnings);
      }

      // Was `string.json TypeError: Cannot use 'in' operator to search for '$ref' in X`,
      // `list.json TypeError: Cannot use 'in' operator to search for '$ref' in X-Rate-Limit`,
      // `list-of-headers.json [ '0: integer' ]` and
      // `header-string.json TypeError: Cannot use 'in' operator to search for '$ref' in integer`.
      expect(printed).toEqual(['string.json []', 'list.json []', 'list-of-headers.json []', 'header-string.json []']);
      expect(warned).toEqual([
        [notAMap('the 200 response of listNotes', '"X-Rate-Limit"')],
        [notAMap('the 200 response of listNotes', '["X-Rate-Limit"]')],
        [notAMap('the 200 response of listNotes', '[{"schema":{"type":"integer"}}]')],
        [notAHeader('listNotes', 'X-Rate-Limit', '"integer"')],
      ]);
    });

    it.each(['200', '404', 'default'])(
      "reads each of the issue's documents as the one without `headers`, at a `%s` response",
      async (key) => {
        const absent = await parse(issueDoc(ABSENT, openapi, key));
        expect(absent.warnings).toEqual([]);
        for (const [, headers] of ISSUE_DOCUMENTS) {
          const { spec, warnings } = await parse(issueDoc(headers, openapi, key));
          expect(warnings).toHaveLength(1);
          expect(spec).toEqual(absent.spec);
          expect(diffSpecs(absent.spec, spec).changes).toEqual([]);
          expect(diffSpecs(spec, absent.spec).changes).toEqual([]);
        }
      },
    );

    describe('a `headers` that is no map, at every site one is read at', () => {
      it.each(SITES)('$label: read as absent, after one warning naming the response', async ({ response, build }) => {
        const absent = await parse(build(answer, openapi));
        const backwardAbsent = await parse(reversed(build(answer, openapi)));
        expect(absent.warnings).toEqual([]);
        for (const [, value, rendered] of NON_MAPS) {
          const { spec, warnings } = await parse(build(holding(answer, value), openapi));
          // One warning for the one `headers`, however many readers visit it.
          expect(warnings).toEqual([notAMap(response, rendered)]);
          expect(spec).toEqual(absent.spec);
          // And wherever the document writes it: `components` ahead of `paths`, `headers` ahead of its siblings.
          const backward = await parse(reversed(build(holding(answer, value), openapi)));
          expect(backward.warnings).toEqual(warnings);
          expect(backward.spec).toEqual(backwardAbsent.spec);
        }
      });

      it.each(SITES)('$label: still read from a map, and silently from an empty one', async ({ build }) => {
        const absent = await parse(build(answer, openapi));
        // An empty map declares no header, and is a map: nothing to report.
        const empty = await parse(build(holding(answer, {}), openapi));
        expect(empty.warnings).toEqual([]);
        expect(empty.spec).toEqual(absent.spec);
        // A map is read: the response carries the header its key declares, typed from its schema.
        const read = await parse(build(holding(answer, { 'X-Rate-Limit': INT }), openapi));
        expect(read.warnings).toEqual([]);
        const [headers] = Object.values(headersOf(operationsOf(read.spec)[0]!));
        expect(headers).toEqual(['X-Rate-Limit: integer']);
        expect(Object.values(headersOf(operationsOf(absent.spec)[0]!))).toEqual([]);
      });
    });

    describe('an entry of a `headers` map that is no object, at every site one is read at', () => {
      it.each(SITES)(
        '$label: skipped after one warning naming the header, the others read',
        async ({ operation, build }) => {
          const without = await parse(build(holding(answer, beside(ABSENT)), openapi));
          const backwardWithout = await parse(reversed(build(holding(answer, beside(ABSENT)), openapi)));
          expect(without.warnings).toEqual([]);
          // The response carries the other header alone, on every list it sits on.
          const lists = Object.values(headersOf(operationsOf(without.spec)[0]!));
          expect(lists).not.toEqual([]);
          for (const list of lists) expect(list).toEqual(['X-Kept: string']);
          for (const [, value, rendered] of NON_OBJECTS) {
            const { spec, warnings } = await parse(build(holding(answer, beside(value)), openapi));
            expect(warnings).toEqual([notAHeader(operation, 'X-Rate-Limit', rendered)]);
            expect(spec).toEqual(without.spec);
            const backward = await parse(reversed(build(holding(answer, beside(value)), openapi)));
            expect(backward.warnings).toEqual(warnings);
            expect(backward.spec).toEqual(backwardWithout.spec);
          }
        },
      );

      it.each(NON_OBJECTS)(
        'reads %s as the `$ref` to a `components/headers` entry holding it is read: one IR, the component named',
        async (_kind, value, rendered) => {
          const inline = responding('200', holding(answer, beside(value)), openapi);
          const viaRef = responding('200', holding(answer, beside({ $ref: '#/components/headers/Rate' })), openapi, {
            components: { headers: { Rate: value } },
          });
          const viaChain = responding('200', holding(answer, beside({ $ref: '#/components/headers/Alias' })), openapi, {
            components: { headers: { Alias: { $ref: '#/components/headers/Rate' }, Rate: value } },
          });
          const a = await parse(inline);
          const b = await parse(viaRef);
          const c = await parse(viaChain);

          expect(a.warnings).toEqual([notAHeader('listNotes', 'X-Rate-Limit', rendered)]);
          // As before #729: the component is named ahead of the header that refers to it (#664).
          expect(b.warnings).toEqual([notAHeaderComponent('Rate', 'listNotes', 'X-Rate-Limit', rendered)]);
          expect(c.warnings).toEqual(b.warnings);
          expect(b.spec).toEqual(a.spec);
          expect(c.spec).toEqual(a.spec);
          expect(headersOf(operationsOf(a.spec)[0]!)).toEqual({ primary: ['X-Kept: string'] });
        },
      );

      it('skips the entry wherever it sits in the map, and every entry of a map of none', async () => {
        const first = await parse(
          responding('200', { ...answer, headers: { 'X-Rate': 'integer', 'X-Kept': STR } }, openapi),
        );
        const last = await parse(
          responding('200', { ...answer, headers: { 'X-Kept': STR, 'X-Rate': 'integer' } }, openapi),
        );
        expect(first.warnings).toEqual([notAHeader('listNotes', 'X-Rate', '"integer"')]);
        expect(last.warnings).toEqual(first.warnings);
        expect(last.spec).toEqual(first.spec);

        // Nothing survives: the response carries no `headers` at all, as one that declares none.
        const none = await parse(
          responding('200', { ...answer, headers: { 'X-Rate': 'integer', 'X-Burst': null, 'X-Left': [] } }, openapi),
        );
        expect(none.warnings).toEqual([
          notAHeader('listNotes', 'X-Rate', '"integer"'),
          notAHeader('listNotes', 'X-Burst', 'null'),
          notAHeader('listNotes', 'X-Left', '[]'),
        ]);
        expect(none.spec).toEqual((await parse(responding('200', answer, openapi))).spec);
        expect(operationsOf(none.spec)[0]).not.toHaveProperty('responseHeaders');
      });

      it('still reads an entry that is an object as the Header Object it is, whatever it holds', async () => {
        // `{}` declares a header with no schema: a string, as before.
        const { spec, warnings } = await parse(
          responding('200', { ...answer, headers: { 'X-Rate-Limit': {}, 'X-Kept': STR } }, openapi),
        );
        expect(warnings).toEqual([]);
        expect(headersOf(operationsOf(spec)[0]!)).toEqual({ primary: ['X-Rate-Limit: string', 'X-Kept: string'] });
      });
    });

    it('never reads an array by its indexes: a Header Object in one declares no header and mints no model', async () => {
      const inArray = [{ schema: NOTE }, { schema: { type: 'string', enum: ['a', 'b'] } }];
      const doc = (headers: unknown) =>
        listNotes(
          {
            responses: {
              '200': holding({ description: 'ok' }, headers),
              '404': holding({ description: 'gone' }, headers),
              default: holding({ description: 'else' }, headers),
              '5XX': holding({ description: 'down' }, headers),
            },
          },
          openapi,
        );

      const { spec, warnings } = await parse(doc(inArray));
      const rendered = JSON.stringify(inArray);
      expect(warnings).toEqual([
        notAMap('the 200 response of listNotes', rendered),
        notAMap('the 404 response of listNotes', rendered),
        notAMap('the default response of listNotes', rendered),
        notAMap('the 5XX response of listNotes', rendered),
      ]);
      // Was four responses each carrying the headers `0` and `1`, typed from the schemas under a model and an
      // enum named for the index (`Notes0`, `Notes1`, …).
      expect(spec.models).toEqual([]);
      expect(spec.enums).toEqual([]);
      expect(headersOf(operationsOf(spec)[0]!)).toEqual({});
      expect(spec).toEqual((await parse(doc(ABSENT))).spec);

      // The same Header Objects under the keys of a map are read, at every one of those responses.
      const mapped = await parse(doc({ 'X-Meta': inArray[0], 'X-Kind': inArray[1] }));
      expect(mapped.warnings).toEqual([]);
      expect(mapped.spec.models.map(({ name }) => name)).not.toEqual([]);
      expect(mapped.spec.enums.map(({ name }) => name)).not.toEqual([]);
      expect(Object.keys(headersOf(operationsOf(mapped.spec)[0]!)).sort()).toEqual([
        '404',
        '5XX',
        'default',
        'primary',
      ]);
    });

    it('still reads a key of a map as the header it declares, an index-like `0` included', async () => {
      // What declares a header is a key of a map, however it is spelled; only a value that is no map has none.
      const { spec, warnings } = await parse(issueDoc({ '0': INT }, openapi));
      expect(warnings).toEqual([]);
      expect(issueScript('zero.json', spec)).toBe('zero.json ["0: integer"]');
    });

    describe('header names that differ in case alone', () => {
      const pair = (headers: Doc, components?: Doc) =>
        responding('200', { ...answer, headers }, openapi, components ? { components } : {});

      it.each(NON_OBJECTS)(
        'keeps the later key as the declaration when it holds %s, and skips it as its `$ref` spelling is skipped',
        async (_kind, value, rendered) => {
          const inline = await parse(pair({ 'X-A': INT, 'x-a': value }));
          const viaRef = await parse(
            pair({ 'X-A': INT, 'x-a': { $ref: '#/components/headers/Bad' } }, { headers: { Bad: value } }),
          );

          // The key declares the header, whatever it holds: the later one is the declaration (#295), and a
          // declaration that is no Header Object is skipped — inline as behind a pointer, which it already was.
          expect(viaRef.warnings).toEqual([
            declaredTwice('x-a', 'X-A', 'listNotes 200'),
            notAHeaderComponent('Bad', 'listNotes', 'x-a', rendered),
          ]);
          expect(inline.warnings).toEqual([
            declaredTwice('x-a', 'X-A', 'listNotes 200'),
            notAHeader('listNotes', 'x-a', rendered),
          ]);
          expect(inline.spec).toEqual(viaRef.spec);
          expect(headersOf(operationsOf(inline.spec)[0]!)).toEqual({});
        },
      );

      it.each(NON_OBJECTS)(
        'reads the later key alone when the earlier holds %s, without a word of it',
        async (_k, value) => {
          const { spec, warnings } = await parse(pair({ 'X-A': value, 'x-a': INT }));
          expect(warnings).toEqual([declaredTwice('x-a', 'X-A', 'listNotes 200')]);
          expect(headersOf(operationsOf(spec)[0]!)).toEqual({ primary: ['x-a: integer'] });
        },
      );
    });

    describe('one warning per response that reads the `headers`', () => {
      it('names each response of an operation, and each header of each', async () => {
        const { spec, warnings } = await parse(
          listNotes(
            {
              responses: {
                '200': { description: 'ok', headers: { 'X-Rate': 'integer' } },
                '404': { description: 'gone', headers: { 'X-Rate': 'integer' } },
                default: { description: 'else', headers: 'X-Rate' },
              },
            },
            openapi,
          ),
        );
        expect(warnings).toEqual([
          notAHeader('listNotes', 'X-Rate', '"integer"'),
          notAHeader('listNotes', 'X-Rate', '"integer"'),
          notAMap('the default response of listNotes', '"X-Rate"'),
        ]);
        expect(headersOf(operationsOf(spec)[0]!)).toEqual({});
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
          components: { responses: { Notes: { description: 'Notes.', headers: ['X-Rate'] } } },
        });
        expect(warnings).toEqual([
          notAMap('the 200 response of listNotes', '["X-Rate"]'),
          notAMap('the default response of listNotes', '["X-Rate"]'),
          notAMap('the 201 response of createNote', '["X-Rate"]'),
        ]);
        expect(operationsOf(spec).map(headersOf)).toEqual([{}, {}]);
      });

      it('names each path that reads a path item through a `$ref`', async () => {
        const { warnings } = await parse({
          openapi,
          info,
          paths: {
            '/notes': { $ref: '#/components/pathItems/Notes' },
            '/memos': { $ref: '#/components/pathItems/Notes' },
          },
          components: {
            pathItems: { Notes: { get: { responses: { '200': { description: 'ok', headers: 'X-Rate' } } } } },
          },
        });
        expect(warnings).toEqual([
          notAMap('the 200 response of GET /notes', '"X-Rate"'),
          notAMap('the 200 response of GET /memos', '"X-Rate"'),
        ]);
      });

      it('says nothing of a `components` entry no response refers to', async () => {
        const { warnings } = await parse(
          listNotes({}, openapi, {
            components: {
              responses: { Notes: { description: 'Notes.', headers: 'X-Rate' } },
              headers: { Rate: 'integer' },
            },
          }),
        );
        expect(warnings).toEqual([]);
      });
    });

    describe('a `headers` no reader reads is not reported', () => {
      /** Every value a `headers` may hold in place of a map, and a map holding each value that is no Header Object. */
      const UNREAD: unknown[] = [
        ...NON_MAPS.map(([, value]) => value),
        ...NON_OBJECTS.map(([, value]) => ({ 'X-Rate-Limit': value })),
      ];

      it('on a 1xx response, and on a response of a webhook or a callback, whose headers are not typed', async () => {
        const answering = (headers: unknown) => ({ responses: { '200': holding({ description: 'ok' }, headers) } });
        const informational = (headers: unknown) =>
          responding('103', holding({ description: 'Hints.' }, headers), openapi);
        const ofWebhook = (headers: unknown) => webhook(answering(headers), openapi);
        const ofCallback = (headers: unknown) => callback(answering(headers), openapi);
        for (const build of [informational, ofWebhook, ofCallback]) {
          const absent = await parse(build(ABSENT));
          for (const value of UNREAD) {
            const { spec, warnings } = await parse(build(value));
            expect(warnings).toEqual([]);
            expect(spec).toEqual(absent.spec);
          }
        }
      });

      it('beside a response `$ref`, where nothing but the reference is read', async () => {
        const components = { responses: { Notes: { ...answer, headers: { 'X-Kept': STR } } } };
        const beside$ref = (headers: unknown) =>
          responding('200', holding({ $ref: '#/components/responses/Notes' }, headers), openapi, { components });
        const absent = await parse(beside$ref(ABSENT));
        for (const value of UNREAD) {
          const { spec, warnings } = await parse(beside$ref(value));
          expect(warnings).toEqual([]);
          expect(spec).toEqual(absent.spec);
        }
        expect(headersOf(operationsOf(absent.spec)[0]!)).toEqual({ primary: ['X-Kept: string'] });
      });

      it('under the `Content-Type` key, which OpenAPI says to ignore whatever it holds', async () => {
        const ignored = (entry: unknown) =>
          responding(
            '200',
            { ...answer, headers: { ...(entry === ABSENT ? {} : { 'Content-Type': entry }), 'X-Kept': STR } },
            openapi,
          );
        const absent = await parse(ignored(ABSENT));
        for (const [, value] of NON_OBJECTS) {
          const { spec, warnings } = await parse(ignored(value));
          expect(warnings).toEqual([]);
          expect(spec).toEqual(absent.spec);
        }
      });

      it('on an Encoding Object, whose `headers` no reader reads', async () => {
        const encoded = (headers: unknown) =>
          createNote(
            {
              requestBody: {
                content: {
                  'multipart/form-data': {
                    schema: { type: 'object', properties: { file: { type: 'string' } } },
                    encoding: { file: holding({}, headers) },
                  },
                },
              },
            },
            openapi,
          );
        const absent = await parse(encoded(ABSENT));
        for (const value of UNREAD) {
          const { spec, warnings } = await parse(encoded(value));
          expect(warnings).toEqual([]);
          expect(spec).toEqual(absent.spec);
        }
      });
    });

    describe('oagen diff', () => {
      it.each([
        ['a string', 'X-Rate-Limit'],
        ['an array of names', ['X-Rate-Limit']],
        ['an array of Header Objects', [INT]],
        ['null', null],
      ])('against the document without any `headers`, both ways, exits 0 for %s', async (_kind, value) => {
        // Was a `TypeError` for a string and an array of names, and exit 1 one way (the header `0` added) and
        // exit 2 the other (the header `0` removed) for an array of Header Objects.
        const old = issueDoc(ABSENT, openapi);
        const repro = issueDoc(value, openapi);
        expect(await diffExitCode(old, repro)).toBe(0);
        expect(await diffExitCode(repro, old)).toBe(0);
        expect(await diffExitCode(repro, repro)).toBe(0);
      });

      it.each([
        ['a string', 'integer'],
        ['an array', []],
        ['an array of Header Objects', [INT]],
        ['null', null],
      ])('against the document without the entry, both ways, exits 0 for an entry that is %s', async (_kind, value) => {
        // Was a `TypeError` for a string and `null`, and exit 1 one way and exit 2 the other for an array, which
        // was read as a header with no schema.
        const old = issueDoc(beside(ABSENT), openapi);
        const repro = issueDoc(beside(value), openapi);
        expect(await diffExitCode(old, repro)).toBe(0);
        expect(await diffExitCode(repro, old)).toBe(0);
      });

      it('between the inline and the `$ref` spelling of each site, both ways, exits 0', async () => {
        const inline = responding('200', { ...answer, headers: { 'X-Rate-Limit': [], 'X-Kept': STR } }, openapi);
        const headerRef = responding(
          '200',
          { ...answer, headers: { 'X-Rate-Limit': { $ref: '#/components/headers/Rate' }, 'X-Kept': STR } },
          openapi,
          { components: { headers: { Rate: [] } } },
        );
        // Was exit 2 one way and exit 1 the other: the inline `[]` was a string header the `$ref` spelling dropped.
        expect(await diffExitCode(inline, headerRef)).toBe(0);
        expect(await diffExitCode(headerRef, inline)).toBe(0);

        const written = responding('200', { ...answer, headers: 'X-Rate-Limit' }, openapi);
        const responseRef = responding('200', { $ref: '#/components/responses/Notes' }, openapi, {
          components: { responses: { Notes: { ...answer, headers: 'X-Rate-Limit' } } },
        });
        expect(await diffExitCode(written, responseRef)).toBe(0);
        expect(await diffExitCode(responseRef, written)).toBe(0);
      });

      it('still reports the header a map declares against the list that declares none', async () => {
        const map = issueDoc({ 'X-Rate-Limit': INT }, openapi);
        const list = issueDoc([INT], openapi);
        // The header is removed, which is breaking, and added back, which is not.
        expect(await diffExitCode(map, list)).toBe(2);
        expect(await diffExitCode(list, map)).toBe(1);
      });
    });
  });

  it('reads each malformed document alike under OpenAPI 3.0.3 and 3.1.0: `oagen diff` between them exits 0', async () => {
    for (const [, headers] of ISSUE_DOCUMENTS) {
      expect(await diffExitCode(issueDoc(headers, '3.1.0'), issueDoc(headers, '3.0.3'))).toBe(0);
      expect(await diffExitCode(issueDoc(headers, '3.0.3'), issueDoc(headers, '3.1.0'))).toBe(0);
    }
  });

  it('reads a well-formed `headers` map as before', async () => {
    const doc = (openapi: string) => ({
      openapi,
      info,
      paths: {
        '/notes': {
          get: {
            operationId: 'listNotes',
            responses: {
              '200': {
                ...answer,
                headers: {
                  'X-Rate-Limit': { description: 'The limit.', required: true, schema: { type: 'integer' } },
                  'X-Meta': { schema: NOTE },
                  'X-Shared': { $ref: '#/components/headers/Rate' },
                  'X-Plain': { content: { 'text/plain': {} } },
                  'X-Bare': {},
                  'Content-Type': STR,
                  'X-Request-Id': STR,
                  'x-request-id': { deprecated: true, ...STR },
                },
              },
              '429': { description: 'Slow down.', headers: { 'Retry-After': INT } },
              default: { description: 'Else.', headers: {} },
              '5XX': { $ref: '#/components/responses/Down' },
            },
          },
        },
      },
      components: {
        headers: { Rate: { description: 'Shared.', schema: { type: 'integer' } } },
        responses: { Down: { description: 'Down.', headers: { 'X-Outage': { schema: { type: 'boolean' } } } } },
      },
    });

    const { spec, warnings } = await parse(doc('3.1.0'));
    expect(warnings).toEqual([declaredTwice('x-request-id', 'X-Request-Id', 'listNotes 200')]);
    const older = await parse(doc('3.0.3'));
    expect(older.warnings).toEqual(warnings);
    expect(older.spec.services).toEqual(spec.services);
    expect(spec.models.map(({ name }) => name)).toEqual(['NotesXMeta']);
    const [op] = operationsOf(spec);
    expect(JSON.parse(JSON.stringify({ responseHeaders: op!.responseHeaders, errors: op!.errors })))
      .toMatchInlineSnapshot(`
        {
          "errors": [
            {
              "description": "Slow down.",
              "headers": [
                {
                  "name": "Retry-After",
                  "required": false,
                  "type": {
                    "kind": "primitive",
                    "type": "integer",
                  },
                },
              ],
              "statusCode": 429,
            },
          ],
          "responseHeaders": [
            {
              "description": "The limit.",
              "name": "X-Rate-Limit",
              "required": true,
              "type": {
                "kind": "primitive",
                "type": "integer",
              },
            },
            {
              "name": "X-Meta",
              "required": false,
              "type": {
                "kind": "model",
                "name": "NotesXMeta",
              },
            },
            {
              "description": "Shared.",
              "name": "X-Shared",
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "integer",
              },
            },
            {
              "name": "X-Plain",
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
            },
            {
              "name": "X-Bare",
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
            },
            {
              "deprecated": true,
              "name": "x-request-id",
              "required": false,
              "type": {
                "kind": "primitive",
                "type": "string",
              },
            },
          ],
        }
      `);
    expect(JSON.parse(JSON.stringify({ defaultResponse: op!.defaultResponse, rangeResponses: op!.rangeResponses })))
      .toMatchInlineSnapshot(`
        {
          "defaultResponse": {
            "description": "Else.",
          },
          "rangeResponses": [
            {
              "description": "Down.",
              "headers": [
                {
                  "name": "X-Outage",
                  "required": false,
                  "type": {
                    "kind": "primitive",
                    "type": "boolean",
                  },
                },
              ],
              "range": "5XX",
            },
          ],
        }
      `);
  });

  it('checks every value written where a Reference Object may stand before following it', async () => {
    // `followReference` takes an object: each reader of a Parameter, Request Body, Response, Header, Example or
    // Security Scheme Object asks first whether the value is one, so none of them fails the parse on one that is
    // not. A response header was the one reader that did not ask.
    const doc = (value: unknown, openapi: string) => ({
      openapi,
      info,
      paths: {
        '/notes': {
          post: {
            operationId: 'createNote',
            parameters: [
              value,
              { name: 'limit', in: 'query', schema: { type: 'integer' }, examples: { small: value } },
            ],
            requestBody: value,
            responses: {
              '200': { description: 'ok', headers: { 'X-Rate-Limit': value } },
              '404': value,
            },
          },
        },
      },
      components: { securitySchemes: { key: value } },
    });
    for (const openapi of VERSIONS) {
      for (const [, value] of NON_OBJECTS) await expect(parse(doc(value, openapi))).resolves.toBeDefined();
      const { warnings } = await parse(doc('oops', openapi));
      expect(warnings).toEqual([
        warning('the request body of createNote is not a Request Body Object ("oops"); skipping it.'),
        warning('a parameter of createNote is not a Parameter Object ("oops"); skipping it.'),
        warning('404 response of createNote is not a Response Object ("oops"); skipping it.'),
        notAHeader('createNote', 'X-Rate-Limit', '"oops"'),
        warning('Unsupported security scheme "key" (a string is not a Security Scheme Object) omitted from spec.auth'),
      ]);
    }
  });

  describe('responseHeadersOf', () => {
    it('hands back the map itself, an empty one included, without a word', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const map = { 'X-Rate-Limit': INT };
      const empty = {};
      expect(responseHeadersOf(map, 'the 200 response of listNotes')).toBe(map);
      expect(responseHeadersOf(empty, 'the 200 response of listNotes')).toBe(empty);
      expect(responseHeadersOf(map)).toBe(map);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads an absent `headers` as no map without a word, with or without a site', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(responseHeadersOf(undefined)).toBeUndefined();
      expect(responseHeadersOf(undefined, 'the 200 response of listNotes')).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(NON_MAPS)('reads %s as no map: named once for a site, silently for none', (_kind, value, rendered) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(responseHeadersOf(value)).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(responseHeadersOf(value, 'the 200 response of listNotes')).toBeUndefined();
      expect(warn.mock.calls).toEqual([[notAMap('the 200 response of listNotes', rendered)]]);
    });

    it("hands back a map whatever its entries hold: an entry is each reader's own to check", () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const map = { 'X-Rate-Limit': 'integer', 'X-Burst': null, 'X-Left': [] };
      expect(responseHeadersOf(map, 'the 200 response of listNotes')).toBe(map);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('readSchemaSites', () => {
    /** Every schema the walk visits in a document whose `200`, `404` and `default` responses hold `headers`. */
    const visited = (headers: unknown, components?: Doc): unknown[] => {
      const schemas: unknown[] = [];
      readSchemaSites(
        {
          openapi: '3.1.0',
          info,
          paths: {
            '/notes': {
              get: {
                operationId: 'listNotes',
                responses: {
                  '200': { description: 'ok', headers },
                  '404': { description: 'gone', headers },
                  default: { description: 'else', headers },
                },
              },
            },
          },
          ...(components ? { components } : {}),
        },
        (schema) => schemas.push(schema),
      );
      return schemas;
    };

    it('visits no schema of a `headers` that is no map, as the reader types none from it', () => {
      for (const [, value] of NON_MAPS) expect(visited(value)).toEqual([]);
      // Was the one place the two parted: the reader typed a header `0` from the schema the walk left out.
      expect(visited([{ schema: NOTE }])).toEqual([]);
    });

    it('visits no schema under an entry that is no object, inline or behind a `$ref`', () => {
      for (const [, value] of NON_OBJECTS) {
        expect(visited({ 'X-Rate-Limit': value })).toEqual([]);
        expect(
          visited({ 'X-Rate-Limit': { $ref: '#/components/headers/Rate' } }, { headers: { Rate: value } }),
        ).toEqual([]);
      }
      expect(visited({ 'X-Rate-Limit': [{ schema: NOTE }] })).toEqual([]);
    });

    it('visits the schema under each key of a map', () => {
      expect(visited({ 'X-Meta': { schema: NOTE } })).toEqual([NOTE, NOTE, NOTE]);
      expect(visited({ '0': { schema: NOTE } })).toEqual([NOTE, NOTE, NOTE]);
    });
  });
});
