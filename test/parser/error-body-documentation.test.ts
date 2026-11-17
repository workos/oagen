import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec, type ParseOptions } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { expandDocUrls } from '../../src/utils/expand-doc-urls.js';
import type { ApiSpec, ExternalDocs, Field, Model } from '../../src/ir/types.js';

// #666: `collapseErrorBodies` built each shared model (`buildSharedModel`)
// with the `deprecated`, limits and `x-` keys every folded body agrees on,
// but never read the bodies' own `description` or `externalDocs`, so a
// shared error body was undocumented even when every body wrote the same
// text and link, and even when it folded a single body — while the same
// bodies with the fold off keep both, and since #640 every other response
// body site carries the text an `allOf` wrapper layer gives it. The shared
// model now keeps each of the two by the rule it keeps an `x-` extension
// by: when every body of the shape wrote the same one. The same function
// kept a field's link only while the fold left the field's type alone,
// though it kept the field's description either way; the link now follows
// the description.

type Doc = Record<string, unknown>;
const VERSIONS = ['3.1.0', '3.0.3'] as const;
const TEXT = 'Why the request failed.';
const LINK: ExternalDocs = { url: 'https://example.com/errors' };
const str = { type: 'string' };
const json = (schema: Doc) => ({ 'application/json': { schema } });

/** The issue's body, verbatim. */
const issueBody: Doc = {
  type: 'object',
  required: ['message'],
  properties: { message: { type: 'string' } },
  description: 'Why the request failed.',
  externalDocs: { url: 'https://example.com/errors' },
  'x-kind': 'error',
};
/** `{ message, ...fields }` requiring `message` and whatever `required` lists, with `keys` beside its `properties`. */
const body = (keys: Doc = {}, fields: Doc = {}, required: string[] = []): Doc => ({
  type: 'object',
  required: ['message', ...required],
  properties: { message: str, ...fields },
  ...keys,
});
/** An inline object with one required string field, and `keys` beside its `properties`. */
const item = (field: string, keys: Doc = {}): Doc => ({
  type: 'object',
  required: [field],
  properties: { [field]: str },
  ...keys,
});

/** An operation with a path parameter `id`, answering a bare `200` and `responses`. */
const getting = (operationId: string, responses: Doc): Doc => ({
  operationId,
  parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
  responses: { '200': { description: 'OK' }, ...responses },
});
const notFound = (schema: Doc): Doc => ({ '404': { description: 'Not found', content: json(schema) } });
const OPERATIONS = [
  ['/notes/{id}', 'getNote'],
  ['/pets/{id}', 'getPet'],
  ['/tags/{id}', 'getTag'],
] as const;
/**
 * One operation per body — `GET /notes/{id}` (`getNote`), `GET /pets/{id}`
 * (`getPet`), `GET /tags/{id}` (`getTag`), in that order — each answering
 * `404` with its body: two bodies are the issue's document.
 */
const errorDoc = (bodies: Doc[], openapi: string = '3.1.0', schemas?: Doc): Doc => ({
  openapi,
  info: { title: 'repro', version: '1' },
  paths: Object.fromEntries(
    bodies.map((schema, i) => [OPERATIONS[i][0], { get: getting(OPERATIONS[i][1], notFound(schema)) }]),
  ),
  ...(schemas && { components: { schemas } }),
});

async function withFile<T>(spec: Doc, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-666-'));
  const file = path.join(dir, 'spec.json');
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    return await use(file);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Parse, returning the IR and every `console.warn` line. */
async function parseWarned(spec: Doc, options?: ParseOptions): Promise<{ ir: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await withFile(spec, (file) => parseSpec(file, options));
    return { ir, warnings: warn.mock.calls.map((call) => String(call[0])) };
  } finally {
    warn.mockRestore();
  }
}

/** Parse, expecting no `console.warn`. */
async function parse(spec: Doc, options?: ParseOptions): Promise<ApiSpec> {
  const { ir, warnings } = await parseWarned(spec, options);
  expect(warnings).toEqual([]);
  return ir;
}

/** The issue's script: every model's name with its `description`, `extensions` and `externalDocs`. */
const show = ({ models }: ApiSpec): string[] =>
  models.map(
    ({ description, extensions, externalDocs, name }) =>
      `${name} ${JSON.stringify({ description, extensions, externalDocs })}`,
  );

function modelOf(spec: ApiSpec, name: string): Model {
  const model = spec.models.find((m) => m.name === name);
  if (!model) throw new Error(`no model "${name}" among ${spec.models.map((m) => m.name).join(', ')}`);
  return model;
}
function fieldOf(spec: ApiSpec, model: string, name: string): Field {
  const field = modelOf(spec, model).fields.find((f) => f.name === name);
  if (!field) throw new Error(`no field "${name}" on "${model}"`);
  return field;
}
/** The documentation a model or a field carries: both keys, `undefined` when absent. */
const docsOf = ({ description, externalDocs }: Model | Field) => ({ description, externalDocs });
/** The documentation of the one model two or more `{ message }` bodies fold onto. */
const sharedDocs = async (bodies: Doc[], openapi?: string) =>
  docsOf(modelOf(await parse(errorDoc(bodies, openapi)), 'ErrorBody'));

/** The exit code `oagen diff` gives a diff (`src/cli/diff.ts`): 2 on a breaking change, 1 on any other change, 0 on none. */
const exitCodeOf = ({ summary }: ReturnType<typeof diffSpecs>): number =>
  summary.breaking > 0 ? 2 : summary.modified > 0 || summary.removed > 0 || summary.added > 0 ? 1 : 0;

describe('#666 a shared error body keeps the description and externalDocs every body wrote', () => {
  describe.each(VERSIONS)('OAS %s', (openapi) => {
    it("the issue's repro: `ErrorBody` is described and linked, as it carries `x-kind`", async () => {
      const spec = errorDoc([issueBody, issueBody], openapi);
      expect(show(await parse(spec))).toEqual([
        'ErrorBody {"description":"Why the request failed.","extensions":{"x-kind":"error"},"externalDocs":{"url":"https://example.com/errors"}}',
      ]);
      // The per-operation models the fold is read against, as they were.
      expect(show(await parse(spec, { collapseErrorBodies: false }))).toEqual([
        'GetNoteError404 {"description":"Why the request failed.","extensions":{"x-kind":"error"},"externalDocs":{"url":"https://example.com/errors"}}',
        'GetPetError404 {"description":"Why the request failed.","extensions":{"x-kind":"error"},"externalDocs":{"url":"https://example.com/errors"}}',
      ]);
    });

    it('`getPet` alone: a single folded body keeps its own', async () => {
      const spec: Doc = {
        openapi,
        info: { title: 'repro', version: '1' },
        paths: { '/pets/{id}': { get: getting('getPet', notFound(issueBody)) } },
      };
      expect(show(await parse(spec))).toEqual([
        'ErrorBody {"description":"Why the request failed.","extensions":{"x-kind":"error"},"externalDocs":{"url":"https://example.com/errors"}}',
      ]);
    });

    it('one body says something else, or nothing: `ErrorBody` keeps what the bodies still agree on', async () => {
      const reworded = { ...issueBody, description: 'Another text.' };
      expect(show(await parse(errorDoc([issueBody, reworded], openapi)))).toEqual([
        'ErrorBody {"extensions":{"x-kind":"error"},"externalDocs":{"url":"https://example.com/errors"}}',
      ]);
      expect(show(await parse(errorDoc([issueBody, issueBody, body()], openapi)))).toEqual(['ErrorBody {}']);
    });

    it('an `allOf` body documented by its wrapper layer folds with its text, as every other response body site carries it (#640)', async () => {
      // The issue's spelling: the text in a member that declares no type.
      const inMember = { allOf: [body(), { description: TEXT }] };
      expect(await sharedDocs([inMember, inMember], openapi)).toEqual({ description: TEXT, externalDocs: undefined });
      // The text and the link beside the `allOf`, and in a member.
      const beside = { allOf: [body()], description: TEXT, externalDocs: LINK };
      const linked = { allOf: [body(), { description: TEXT, externalDocs: LINK }] };
      expect(await sharedDocs([beside, beside], openapi)).toEqual({ description: TEXT, externalDocs: LINK });
      expect(await sharedDocs([linked, linked], openapi)).toEqual({ description: TEXT, externalDocs: LINK });
      // What each body says is what counts, however it spells it: a plain
      // body beside the two wrapper spellings agrees with them.
      expect(await sharedDocs([body({ description: TEXT, externalDocs: LINK }), beside, linked], openapi)).toEqual({
        description: TEXT,
        externalDocs: LINK,
      });
    });

    it('a nullable wrapper around the body gives the model its text, and the fold keeps it', async () => {
      const nullable =
        openapi === '3.0.3'
          ? { ...body({ description: 'The branch.' }), nullable: true }
          : { oneOf: [body({ description: 'The branch.' }), { type: 'null' }], description: TEXT };
      const expected = openapi === '3.0.3' ? 'The branch.' : TEXT;
      const spec = errorDoc([nullable, nullable], openapi);
      expect(docsOf(modelOf(await parse(spec, { collapseErrorBodies: false }), 'GetPetError404')).description).toBe(
        expected,
      );
      expect(docsOf(modelOf(await parse(spec), 'ErrorBody')).description).toBe(expected);
    });
  });

  describe('each of the two is kept when every body wrote the same one, and dropped otherwise', () => {
    const other: ExternalDocs = { url: 'https://example.com/other' };
    const rows: Array<{ title: string; bodies: Doc[]; expected: ReturnType<typeof docsOf> }> = [
      {
        title: 'the same text and link',
        bodies: [body({ description: TEXT, externalDocs: LINK }), body({ description: TEXT, externalDocs: LINK })],
        expected: { description: TEXT, externalDocs: LINK },
      },
      {
        title: 'two texts, one link: the link alone',
        bodies: [body({ description: 'One.', externalDocs: LINK }), body({ description: 'Two.', externalDocs: LINK })],
        expected: { description: undefined, externalDocs: LINK },
      },
      {
        title: 'one text, two links: the text alone',
        bodies: [body({ description: TEXT, externalDocs: LINK }), body({ description: TEXT, externalDocs: other })],
        expected: { description: TEXT, externalDocs: undefined },
      },
      {
        title: 'a body that wrote neither beside one that wrote both: neither',
        bodies: [body({ description: TEXT, externalDocs: LINK }), body()],
        expected: { description: undefined, externalDocs: undefined },
      },
      {
        title: 'a text one body lacks, a link both wrote: the link alone',
        bodies: [body({ description: TEXT, externalDocs: LINK }), body({ externalDocs: LINK })],
        expected: { description: undefined, externalDocs: LINK },
      },
      {
        title: 'three bodies, two agreeing: neither',
        bodies: [
          body({ description: TEXT, externalDocs: LINK }),
          body({ description: TEXT, externalDocs: LINK }),
          body({ description: 'Another.', externalDocs: other }),
        ],
        expected: { description: undefined, externalDocs: undefined },
      },
      {
        title: 'three bodies agreeing',
        bodies: [
          body({ description: TEXT, externalDocs: LINK }),
          body({ description: TEXT, externalDocs: LINK }),
          body({ description: TEXT, externalDocs: LINK }),
        ],
        expected: { description: TEXT, externalDocs: LINK },
      },
      {
        title: "two links that differ in their own description: no link, as a field's",
        bodies: [body({ externalDocs: { ...LINK, description: 'More.' } }), body({ externalDocs: LINK })],
        expected: { description: undefined, externalDocs: undefined },
      },
      {
        title: 'two links with one description: the whole link',
        bodies: [
          body({ externalDocs: { ...LINK, description: 'More.' } }),
          body({ externalDocs: { description: 'More.', url: LINK.url } }),
        ],
        expected: { description: undefined, externalDocs: { ...LINK, description: 'More.' } },
      },
      {
        title: 'a blank link description is no description (`readExternalDocs`), so the links agree',
        bodies: [body({ externalDocs: { ...LINK, description: ' ' } }), body({ externalDocs: LINK })],
        expected: { description: undefined, externalDocs: LINK },
      },
      {
        title: 'a link without a usable `url` is no link, on every body or on one',
        bodies: [body({ description: TEXT, externalDocs: { url: ' ' } }), body({ description: TEXT })],
        expected: { description: TEXT, externalDocs: undefined },
      },
      {
        title: "a blank text every body wrote is kept verbatim, as each body's own model keeps it",
        bodies: [body({ description: '  ' }), body({ description: '  ' })],
        expected: { description: '  ', externalDocs: undefined },
      },
      {
        title: 'an empty text beside none: none',
        bodies: [body({ description: '' }), body()],
        expected: { description: undefined, externalDocs: undefined },
      },
      {
        title: 'texts that differ in trailing whitespace are two texts',
        bodies: [body({ description: TEXT }), body({ description: `${TEXT} ` })],
        expected: { description: undefined, externalDocs: undefined },
      },
    ];

    it.each(rows)('$title', async ({ bodies, expected }) => {
      expect(await sharedDocs(bodies)).toEqual(expected);
      // Whichever operation wrote which body.
      expect(await sharedDocs([...bodies].reverse())).toEqual(expected);
    });

    it('the `x-` keys are settled apart from the text and the link, as one set', async () => {
      const keyed = (keys: Doc): Doc => body({ description: TEXT, externalDocs: LINK, ...keys });
      const spec = errorDoc([keyed({ 'x-kind': 'error' }), keyed({ 'x-kind': 'error', 'x-team': 'core' })]);
      expect(show(await parse(spec))).toEqual([
        'ErrorBody {"description":"Why the request failed.","externalDocs":{"url":"https://example.com/errors"}}',
      ]);
    });

    it('an absent key stays absent: no `description: undefined` on the shared model', async () => {
      const shared = modelOf(
        await parse(errorDoc([body({ description: 'One.' }), body({ description: 'Two.' })])),
        'ErrorBody',
      );
      expect(Object.keys(shared)).toEqual(['name', 'fields']);
    });

    it('the bodies read in either document order give the same models', async () => {
      const a = body({ description: TEXT, externalDocs: LINK, 'x-kind': 'error' }, { hint: str });
      const b = body({ description: TEXT, externalDocs: LINK, 'x-kind': 'error' });
      const forward = errorDoc([a, b]);
      const paths = forward.paths as Doc;
      const backward = { ...forward, paths: Object.fromEntries(Object.entries(paths).reverse()) };
      const [first, second] = [await parse(forward), await parse(backward)];
      expect(second.models).toEqual(first.models);
      expect(show(first)).toEqual([
        'ErrorBody {"description":"Why the request failed.","extensions":{"x-kind":"error"},"externalDocs":{"url":"https://example.com/errors"}}',
      ]);
    });
  });

  describe('every body of the shape counts, wherever it is declared', () => {
    it('a `4XX` range body, its other media type and a status code fold onto one documented model', async () => {
      const spec: Doc = {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets/{id}': {
            get: getting('getPet', {
              '4XX': {
                description: 'Refused',
                content: { ...json(issueBody), 'application/yaml': { schema: issueBody } },
              },
              '500': { description: 'Broken', content: json(issueBody) },
            }),
          },
        },
      };
      expect(show(await parse(spec, { collapseErrorBodies: false })).map((line) => line.split(' ')[0])).toEqual([
        'GetPetError500',
        'GetPetError4Xx',
        'GetPetError4XxApplicationYaml',
      ]);
      expect(show(await parse(spec))).toEqual([
        'ErrorBody {"description":"Why the request failed.","extensions":{"x-kind":"error"},"externalDocs":{"url":"https://example.com/errors"}}',
      ]);
      // One of the three says something else: the shared model says nothing.
      const paths = structuredClone(spec.paths) as Record<string, { get: { responses: Record<string, Doc> } }>;
      paths['/pets/{id}'].get.responses['500'] = {
        description: 'Broken',
        content: json({ ...issueBody, description: 'The server failed.' }),
      };
      expect(docsOf(modelOf(await parse({ ...spec, paths }), 'ErrorBody'))).toEqual({
        description: undefined,
        externalDocs: LINK,
      });
    });

    it('a body that gains an optional field stays in its group, and its text still counts', async () => {
      const described = (text: string) => [body({ description: TEXT }), body({ description: text }, { hint: str })];
      const agreeing = modelOf(await parse(errorDoc(described(TEXT))), 'ErrorBody');
      expect(agreeing.fields.map((f) => f.name)).toEqual(['message', 'hint']);
      expect(agreeing.description).toBe(TEXT);
      expect(modelOf(await parse(errorDoc(described('With a hint.'))), 'ErrorBody').description).toBeUndefined();
    });

    it('the variants of one `oneOf` body that fold onto one model must agree like any two bodies', async () => {
      const union = (second: string) => ({
        oneOf: [body({ description: 'A failure.' }), body({ description: second }, { code: str })],
        description: 'Either failure.',
      });
      expect(docsOf(modelOf(await parse(errorDoc([union('A failure.')])), 'ErrorBody')).description).toBe('A failure.');
      expect(
        docsOf(modelOf(await parse(errorDoc([union('A coded failure.')])), 'ErrorBody')).description,
      ).toBeUndefined();
    });

    it('expands a relative link in the shared text like any model text', async () => {
      const linking = body({
        description: 'See [errors](/reference/errors).',
        externalDocs: { ...LINK, description: 'See (/errors).' },
      });
      const spec = expandDocUrls(await parse(errorDoc([linking, linking])), 'https://docs.example.com');
      expect(docsOf(modelOf(spec, 'ErrorBody'))).toEqual({
        description: 'See [errors](https://docs.example.com/reference/errors).',
        externalDocs: { ...LINK, description: 'See (https://docs.example.com/errors).' },
      });
    });
  });

  describe('a nested error body is documented by the same rule, on its own', () => {
    const DETAIL = 'What went wrong.';
    /** `{ message, detail: { reason } }`, `detail` required, each level with its own text and link. */
    const detailed = (text: string, detailText: string): Doc =>
      body({ description: text }, { detail: item('reason', { description: detailText, externalDocs: LINK }) }, [
        'detail',
      ]);
    /** `{ message, errors?: [{ code }] }`, the items with `keys`. */
    const listing = (keys: Doc): Doc =>
      body({ description: TEXT }, { errors: { type: 'array', items: item('code', keys) } });

    it.each(VERSIONS)('an object under a required field, OAS %s', async (openapi) => {
      const spec = await parse(errorDoc([detailed(TEXT, DETAIL), detailed(TEXT, DETAIL)], openapi));
      expect(show(spec)).toEqual([
        'ErrorBodyWithReasonDetail {"description":"Why the request failed."}',
        'ErrorBodyWithReasonDetailDetail {"description":"What went wrong.","externalDocs":{"url":"https://example.com/errors"}}',
      ]);
      // The field that holds it is documented by the field's own rule, as before.
      expect(docsOf(fieldOf(spec, 'ErrorBodyWithReasonDetail', 'detail'))).toEqual({
        description: DETAIL,
        externalDocs: LINK,
      });
    });

    it.each(VERSIONS)('the items of an array under an optional field, OAS %s', async (openapi) => {
      const keys = { description: 'One error.', externalDocs: LINK };
      expect(show(await parse(errorDoc([listing(keys), listing(keys)], openapi)))).toEqual([
        'ErrorBody {"description":"Why the request failed."}',
        'ErrorBodyErrorWithCode {"description":"One error.","externalDocs":{"url":"https://example.com/errors"}}',
      ]);
      expect(show(await parse(errorDoc([listing(keys)], openapi)))).toEqual([
        'ErrorBody {"description":"Why the request failed."}',
        'ErrorBodyErrorWithCode {"description":"One error.","externalDocs":{"url":"https://example.com/errors"}}',
      ]);
    });

    it('each level agrees or not by itself', async () => {
      // The nested bodies say two things, their parents one.
      expect(show(await parse(errorDoc([detailed(TEXT, DETAIL), detailed(TEXT, 'Something else.')])))).toEqual([
        'ErrorBodyWithReasonDetail {"description":"Why the request failed."}',
        'ErrorBodyWithReasonDetailDetail {"externalDocs":{"url":"https://example.com/errors"}}',
      ]);
      // The parents say two things, the nested bodies one.
      expect(show(await parse(errorDoc([detailed(TEXT, DETAIL), detailed('Something else.', DETAIL)])))).toEqual([
        'ErrorBodyWithReasonDetail {}',
        'ErrorBodyWithReasonDetailDetail {"description":"What went wrong.","externalDocs":{"url":"https://example.com/errors"}}',
      ]);
    });

    it('a nested body of the shape of a top-level one is one of its bodies', async () => {
      // `{ message, cause?: { message } }`: the `cause` object is a
      // `{ message }` body too, so the three fold onto `ErrorBody` and all
      // three must agree.
      const causing = (causeText: string): Doc =>
        body({ description: TEXT }, { cause: body({ description: causeText }) });
      expect(show(await parse(errorDoc([causing(TEXT), body({ description: TEXT })])))).toEqual([
        'ErrorBody {"description":"Why the request failed."}',
      ]);
      expect(show(await parse(errorDoc([causing('The cause.'), body({ description: TEXT })])))).toEqual([
        'ErrorBody {}',
      ]);
    });
  });

  describe("a shared field's link is kept by the rule its description is", () => {
    /** `{ message, code: <const> }`, `code` described, linked and with `keys`. */
    const coded = (value: string, keys: Doc = {}): Doc =>
      body({}, { code: { type: 'string', const: value, description: 'The code.', externalDocs: LINK, ...keys } }, [
        'code',
      ]);

    it.each(VERSIONS)(
      '`code: const a` beside `const b`, the same link on both: `ErrorBodyCode`, linked — OAS %s',
      async (openapi) => {
        const keys = { 'x-stable': true };
        const document = errorDoc([coded('a', keys), coded('b', keys)], openapi);
        const off = await parse(document, { collapseErrorBodies: false });
        expect(docsOf(fieldOf(off, 'GetNoteError404', 'code'))).toEqual({
          description: 'The code.',
          externalDocs: LINK,
        });
        const code = fieldOf(await parse(document), 'ErrorBodyWithCode', 'code');
        expect(code.type).toEqual({ kind: 'enum', name: 'ErrorBodyCode', values: ['a', 'b'] });
        // The text and the `x-` keys always rode along; the link now does.
        expect(code).toMatchObject({ description: 'The code.', externalDocs: LINK, extensions: keys });
      },
    );

    it('a pinned value beside a free string, and an optional field typed two ways, keep the link too', async () => {
      const free = body({}, { code: { ...str, description: 'The code.', externalDocs: LINK } }, ['code']);
      const widened = fieldOf(await parse(errorDoc([coded('a'), free])), 'ErrorBodyWithCode', 'code');
      expect(widened.type).toEqual({ kind: 'primitive', type: 'string' });
      expect(docsOf(widened)).toEqual({ description: 'The code.', externalDocs: LINK });

      const hinted = (type: string): Doc => body({}, { hint: { type, description: 'A hint.', externalDocs: LINK } });
      const hint = fieldOf(await parse(errorDoc([hinted('string'), hinted('integer')])), 'ErrorBody', 'hint');
      expect(hint.type.kind).toBe('union');
      expect(docsOf(hint)).toEqual({ description: 'A hint.', externalDocs: LINK });
    });

    it('two links, or a link one body lacks, leave the field without one, whatever its type', async () => {
      const other = { url: 'https://example.com/other' };
      // The second row pins one value on both bodies, so the field keeps
      // its literal and the model is named from the value (`AErrorBody`).
      for (const [a, b, model] of [
        [coded('a'), coded('b', { externalDocs: other }), 'ErrorBodyWithCode'],
        [coded('a'), coded('a', { externalDocs: other }), 'AErrorBody'],
        [coded('a'), coded('b', { externalDocs: undefined }), 'ErrorBodyWithCode'],
      ] as const) {
        const code = fieldOf(await parse(errorDoc([a, b])), model, 'code');
        expect(docsOf(code)).toEqual({ description: 'The code.', externalDocs: undefined });
      }
    });

    it("the examples still follow the type: kept while it is the member's own, dropped once the fold changes it", async () => {
      const exampled = { example: 'a', examples: ['a'] };
      const kept = fieldOf(await parse(errorDoc([coded('a', exampled), coded('a', exampled)])), 'AErrorBody', 'code');
      expect(kept).toMatchObject({ ...exampled, externalDocs: LINK });
      const changed = fieldOf(
        await parse(errorDoc([coded('a', exampled), coded('b', exampled)])),
        'ErrorBodyWithCode',
        'code',
      );
      expect(changed.example).toBeUndefined();
      expect(changed.examples).toBeUndefined();
      expect(changed.externalDocs).toEqual(LINK);
    });
  });

  describe('a component of the shared name is never rewritten', () => {
    const bodies = [
      body({ description: 'Body text.', externalDocs: LINK }),
      body({ description: 'Body text.', externalDocs: LINK }),
    ];

    it('its own text and link stay when the bodies it takes say something else', async () => {
      const component = body({
        description: 'Component text.',
        externalDocs: { url: 'https://example.com/component' },
      });
      expect(show(await parse(errorDoc(bodies, '3.1.0', { ErrorBody: component })))).toEqual([
        'ErrorBody {"description":"Component text.","externalDocs":{"url":"https://example.com/component"}}',
      ]);
    });

    it('one that says nothing gains nothing from the bodies it takes', async () => {
      const spec = await parse(errorDoc(bodies, '3.1.0', { ErrorBody: body() }));
      expect(show(spec)).toEqual(['ErrorBody {}']);
      const operations = spec.services.flatMap((service) => service.operations);
      expect(operations.map((op) => op.errors[0].type)).toEqual([
        { kind: 'model', name: 'ErrorBody' },
        { kind: 'model', name: 'ErrorBody' },
      ]);
    });

    it('bodies a component of another shape leaves as they are keep their own', async () => {
      const component = { type: 'object', required: ['code'], properties: { code: { type: 'integer' } } };
      const { ir, warnings } = await parseWarned(errorDoc(bodies, '3.1.0', { ErrorBody: component }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('would be named "ErrorBody"');
      expect(show(ir)).toEqual([
        'ErrorBody {}',
        'GetNoteError404 {"description":"Body text.","externalDocs":{"url":"https://example.com/errors"}}',
        'GetPetError404 {"description":"Body text.","externalDocs":{"url":"https://example.com/errors"}}',
      ]);
    });
  });

  describe('`oagen diff` reports nothing: documentation is not shape', () => {
    const diffOf = async (before: Doc[], after: Doc[]) => {
      const [oldSpec, newSpec] = [await parse(errorDoc(before)), await parse(errorDoc(after))];
      const diff = diffSpecs(oldSpec, newSpec);
      return {
        changes: diff.changes,
        exitCode: exitCodeOf(diff),
        before: docsOf(modelOf(oldSpec, 'ErrorBody')),
        after: docsOf(modelOf(newSpec, 'ErrorBody')),
      };
    };

    it('one of two agreeing bodies changes its text: the shared model loses it, exit 0', async () => {
      expect(await diffOf([issueBody, issueBody], [issueBody, { ...issueBody, description: 'Changed.' }])).toEqual({
        changes: [],
        exitCode: 0,
        before: { description: TEXT, externalDocs: LINK },
        after: { description: undefined, externalDocs: LINK },
      });
    });

    it('every body gains the text and the link: the shared model gains both, exit 0', async () => {
      const { 'x-kind': _kind, ...documented } = issueBody;
      expect(await diffOf([body(), body()], [documented, documented])).toEqual({
        changes: [],
        exitCode: 0,
        before: { description: undefined, externalDocs: undefined },
        after: { description: TEXT, externalDocs: LINK },
      });
      // The `x-kind` the issue's body also writes is reported, as it was
      // before the model carried the text: an additive `model-modified`.
      expect(await diffOf([body(), body()], [issueBody, issueBody])).toMatchObject({
        changes: [{ kind: 'model-modified', name: 'ErrorBody', classification: 'additive' }],
        exitCode: 1,
        after: { description: TEXT, externalDocs: LINK },
      });
    });

    it('an undocumented body joins two documented ones: the shared model loses both, exit 1 for the added `getTag` alone', async () => {
      const { 'x-kind': _kind, ...documented } = issueBody;
      const result = await diffOf([documented, documented], [documented, documented, body()]);
      expect(result.changes.map((change) => change.kind)).toEqual(['service-added']);
      expect(result).toMatchObject({
        exitCode: 1,
        before: { description: TEXT, externalDocs: LINK },
        after: { description: undefined, externalDocs: undefined },
      });
    });
  });
});
