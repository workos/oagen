import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffCommand } from '../../src/cli/diff.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { isContestedTitle, markContestedTitles, sentOnlyComponentNames } from '../../src/parser/inline-models.js';
import { parseSpec } from '../../src/parser/parse.js';
import { readSchemaSites, type SiteDirection } from '../../src/parser/schema-sites.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * Issue #670: the contested-title walker (`markContestedTitles`) read every
 * schema it could reach by the OpenAPI object model, the sites the readers
 * ignore included — a `103` response, a `Content-Type` header, an
 * `Authorization` parameter, a webhook's response, a body under
 * `application/xml` — so a titled union there contested a title with a
 * component's variant of another shape: the component's variant was renamed
 * (`Tag` → `TagPetCollar`) and `oagen diff` reported that as breaking, though
 * nothing was typed from the site. The roots now come from the one walk over
 * the sites the readers type something from (`readSchemaSites`), which the
 * sent/received walk (`sentOnlyComponentNames`) goes through too.
 */

type Doc = Record<string, unknown>;

const str: SchemaObject = { type: 'string' };
const ok = { description: 'ok' };
const json = (schema: unknown): Doc => ({ 'application/json': { schema } });
const under = (mediaType: string, schema: unknown): Doc => ({ [mediaType]: { schema } });
/** A response declaring `schema` under one media type. */
const body = (schema: unknown, mediaType = 'application/json'): Doc => ({ ...ok, content: under(mediaType, schema) });

// ---------------------------------------------------------------------------
// The issue's documents
// ---------------------------------------------------------------------------

/** A titled object variant pinning `kind` to one value beside one optional string field. */
const variant = (title: string, kind: string, field: string): SchemaObject => ({
  type: 'object',
  title,
  properties: { kind: { type: 'string', enum: [kind] }, [field]: str },
});
/** The issue's `Pet`: a `collar` that is a `oneOf` of `Tag { kind: 'tag', text? }` and `Chip { kind: 'chip', code? }`. */
const pet = (): SchemaObject => ({
  type: 'object',
  properties: { collar: { oneOf: [variant('Tag', 'tag', 'text'), variant('Chip', 'chip', 'code')] } },
});
/** The issue's `note` schema, verbatim: `Pet` extended with a `note` union whose `Tag` has another shape. */
const note = (): SchemaObject => ({
  allOf: [
    { $ref: '#/components/schemas/Pet' },
    {
      type: 'object',
      properties: { note: { oneOf: [variant('Tag', 'note', 'body'), variant('Sticker', 'sticker', 'color')] } },
    },
  ],
});
const petIdParam = { name: 'petId', in: 'path', required: true, schema: str };
const petResponse = (extra: Doc = {}): Doc => ({
  ...ok,
  content: json({ $ref: '#/components/schemas/Pet' }),
  ...extra,
});
const idBody = { content: json({ type: 'object', properties: { id: str } }) };

/**
 * The issue's `old.json`: `GET /pets/{petId}` (`getPet`) returning `$ref: Pet`
 * for `200`, with `operation` merged over it, `top` beside `paths`, `paths`
 * beside the path and `components` beside `Pet`.
 */
function petDocument(
  openapi: string,
  {
    operation = {},
    top = {},
    paths = {},
    components = {},
  }: { operation?: Doc; top?: Doc; paths?: Doc; components?: Doc },
): Doc {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets/{petId}': {
        get: { operationId: 'getPet', parameters: [petIdParam], responses: { '200': petResponse() }, ...operation },
      },
      ...paths,
    },
    ...top,
    components: { schemas: { Pet: pet() }, ...components },
  };
}
const old = (openapi: string): Doc => petDocument(openapi, {});
const withResponses = (openapi: string, responses: Doc, components: Doc = {}): Doc =>
  petDocument(openapi, { operation: { responses: { '200': petResponse(), ...responses } }, components });
const withParameter = (openapi: string, parameter: Doc): Doc =>
  petDocument(openapi, { operation: { parameters: [petIdParam, parameter] } });
/** The issue's webhook `petAdopted`: `post`, request body `{ id?: string }`, answering `200`, `operation` merged over it. */
const withWebhook = (openapi: string, operation: Doc = {}): Doc =>
  petDocument(openapi, {
    top: { webhooks: { petAdopted: { post: { requestBody: idBody, responses: { '200': ok }, ...operation } } } },
  });
/** A callback `petAdopted` on `getPet`, shaped as the webhook is. */
const withCallback = (openapi: string, operation: Doc = {}): Doc =>
  petDocument(openapi, {
    operation: {
      callbacks: {
        petAdopted: {
          '{$request.query.callbackUrl}': { post: { requestBody: idBody, responses: { '200': ok }, ...operation } },
        },
      },
    },
  });
/** `POST /pets` (`createPet`): a multipart body of one `file`, answered `204`, with `mediaType` merged over its media type and `operation` over it. */
const withCreatePet = (openapi: string, mediaType: Doc = {}, operation: Doc = {}): Doc =>
  petDocument(openapi, {
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
                ...mediaType,
              },
            },
          },
          responses: { '204': { description: 'created' } },
          ...operation,
        },
      },
    },
  });

interface IgnoredSite {
  /** The site, in the issue's words. */
  label: string;
  /** The document with `schema` at the ignored site. */
  ignored: (openapi: string, schema: SchemaObject) => Doc;
  /**
   * Whether the document adds nothing else the parser reads, so the issue's
   * "the same models as `old.json`, and the diff is empty" holds against
   * `old.json` itself. When the document also adds something that is read (a
   * webhook, a `404` entry, the header that shadows), the same holds against
   * the document with a string at the ignored site.
   */
  addsNothingElse: boolean;
  /** The neighboring site the readers do read, in words, and the document with `schema` there. */
  neighbor: string;
  read: (openapi: string, schema: SchemaObject) => Doc;
  /** Set when the order of two declarations is what makes the site ignored: the later range key, the earlier header. */
  orderDecides?: true;
}

const ignoredSites: IgnoredSite[] = [
  // --- the issue's four documents ------------------------------------------
  {
    label: '`early-hints.json`: a `103` response on `getPet` with that schema under `application/json`',
    ignored: (v, s) => withResponses(v, { '103': { description: 'hints', content: json(s) } }),
    addsNothingElse: true,
    neighbor: 'a `404` response',
    read: (v, s) => withResponses(v, { '404': { description: 'missing', content: json(s) } }),
  },
  {
    label: "`content-type.json`: a `Content-Type` header with that schema on `getPet`'s `200`",
    ignored: (v, s) =>
      petDocument(v, {
        operation: { responses: { '200': petResponse({ headers: { 'Content-Type': { schema: s } } }) } },
      }),
    addsNothingElse: true,
    neighbor: 'an `X-Note` header',
    read: (v, s) =>
      petDocument(v, { operation: { responses: { '200': petResponse({ headers: { 'X-Note': { schema: s } } }) } } }),
  },
  {
    label: "`authorization.json`: `{ name: 'Authorization', in: 'header', schema: <note> }` on `getPet`",
    ignored: (v, s) => withParameter(v, { name: 'Authorization', in: 'header', schema: s }),
    addsNothingElse: true,
    neighbor: 'an `X-Note` header parameter',
    read: (v, s) => withParameter(v, { name: 'X-Note', in: 'header', schema: s }),
  },
  {
    label: '`webhook-response.json`: a webhook `petAdopted` whose `200` response has that schema',
    ignored: (v, s) => withWebhook(v, { responses: { '200': { ...ok, content: json(s) } } }),
    addsNothingElse: false,
    neighbor: "the webhook's request body",
    read: (v, s) => withWebhook(v, { requestBody: { content: json(s) } }),
  },
  // --- the comment's ---------------------------------------------------------
  {
    label: '`xml.json`: a `404` on `getPet` that has that schema under `application/xml` only',
    ignored: (v, s) => withResponses(v, { '404': { description: 'Not found', content: under('application/xml', s) } }),
    addsNothingElse: false,
    neighbor: 'the `404` under `application/json`',
    read: (v, s) => withResponses(v, { '404': { description: 'Not found', content: json(s) } }),
  },
  {
    label: 'a `200` that declares it under `application/xml` beside its `application/json` `Pet`',
    ignored: (v, s) =>
      petDocument(v, {
        operation: {
          responses: {
            '200': {
              ...ok,
              content: { ...json({ $ref: '#/components/schemas/Pet' }), ...under('application/xml', s) },
            },
          },
        },
      }),
    addsNothingElse: false,
    neighbor: 'the same `200` under `application/yaml`',
    read: (v, s) =>
      petDocument(v, {
        operation: {
          responses: {
            '200': {
              ...ok,
              content: { ...json({ $ref: '#/components/schemas/Pet' }), ...under('application/yaml', s) },
            },
          },
        },
      }),
  },
  // --- the further sites the issue lists in prose ----------------------------
  {
    label: 'a `600` response',
    ignored: (v, s) => withResponses(v, { '600': { description: 'custom', content: json(s) } }),
    addsNothingElse: true,
    neighbor: 'a `500` response',
    read: (v, s) => withResponses(v, { '500': { description: 'custom', content: json(s) } }),
  },
  {
    label: 'a `4xx` beside a `4XX`',
    ignored: (v, s) =>
      withResponses(v, {
        '4XX': { description: 'client error' },
        '4xx': { description: 'client error', content: json(s) },
      }),
    addsNothingElse: false,
    orderDecides: true,
    neighbor: 'the `4XX` that comes first',
    read: (v, s) =>
      withResponses(v, {
        '4XX': { description: 'client error', content: json(s) },
        '4xx': { description: 'client error' },
      }),
  },
  {
    label: 'an `X-Note` header shadowed by a later `x-note`',
    ignored: (v, s) =>
      petDocument(v, {
        operation: {
          responses: { '200': petResponse({ headers: { 'X-Note': { schema: s }, 'x-note': { schema: str } } }) },
        },
      }),
    addsNothingElse: false,
    orderDecides: true,
    neighbor: 'the later `x-note`',
    read: (v, s) =>
      petDocument(v, {
        operation: {
          responses: { '200': petResponse({ headers: { 'X-Note': { schema: str }, 'x-note': { schema: s } } }) },
        },
      }),
  },
  {
    label: 'an `in: body` parameter',
    ignored: (v, s) => withParameter(v, { name: 'note', in: 'body', schema: s }),
    addsNothingElse: true,
    neighbor: 'an `in: query` parameter',
    read: (v, s) => withParameter(v, { name: 'note', in: 'query', schema: s }),
  },
  {
    label: 'a webhook `path` parameter',
    ignored: (v, s) => withWebhook(v, { parameters: [{ name: 'petId', in: 'path', required: true, schema: s }] }),
    addsNothingElse: false,
    neighbor: "the webhook's `query` parameter",
    read: (v, s) => withWebhook(v, { parameters: [{ name: 'petId', in: 'query', schema: s }] }),
  },
  {
    label: "an encoding header, on the `200`'s `application/json`",
    ignored: (v, s) =>
      petDocument(v, {
        operation: {
          responses: {
            '200': {
              ...ok,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Pet' },
                  encoding: { collar: { headers: { 'X-Note': { schema: s } } } },
                },
              },
            },
          },
        },
      }),
    addsNothingElse: true,
    neighbor: 'a header of the response itself',
    read: (v, s) =>
      petDocument(v, { operation: { responses: { '200': petResponse({ headers: { 'X-Note': { schema: s } } }) } } }),
  },
  {
    label: 'an encoding header, on a multipart request body',
    ignored: (v, s) => withCreatePet(v, { encoding: { file: { headers: { 'X-Note': { schema: s } } } } }),
    addsNothingElse: false,
    neighbor: 'a header parameter of the operation',
    read: (v, s) => withCreatePet(v, {}, { parameters: [{ name: 'X-Note', in: 'header', schema: s }] }),
  },
  {
    label: "a callback's response body",
    ignored: (v, s) => withCallback(v, { responses: { '200': { ...ok, content: json(s) } } }),
    addsNothingElse: false,
    neighbor: "the callback's request body",
    read: (v, s) => withCallback(v, { requestBody: { content: json(s) } }),
  },
  // --- the header parameters the issue's first paragraph names ----------------
  {
    label: 'a header parameter named `Accept`',
    ignored: (v, s) => withParameter(v, { name: 'Accept', in: 'header', schema: s }),
    addsNothingElse: true,
    neighbor: 'a `query` parameter named `Accept`',
    read: (v, s) => withParameter(v, { name: 'Accept', in: 'query', schema: s }),
  },
  {
    label: 'a header parameter named `content-type`',
    ignored: (v, s) => withParameter(v, { name: 'content-type', in: 'header', schema: s }),
    addsNothingElse: true,
    neighbor: 'a `cookie` parameter named `content-type`',
    read: (v, s) => withParameter(v, { name: 'content-type', in: 'cookie', schema: s }),
  },
  // --- the same sites, written through `components` ---------------------------
  {
    label: 'a `Content-Type` header written as a `$ref` into `components/headers`',
    ignored: (v, s) =>
      petDocument(v, {
        operation: {
          responses: { '200': petResponse({ headers: { 'Content-Type': { $ref: '#/components/headers/Note' } } }) },
        },
        components: { headers: { Note: { schema: s } } },
      }),
    addsNothingElse: true,
    neighbor: 'an `X-Note` header written as the same `$ref`',
    read: (v, s) =>
      petDocument(v, {
        operation: {
          responses: { '200': petResponse({ headers: { 'X-Note': { $ref: '#/components/headers/Note' } } }) },
        },
        components: { headers: { Note: { schema: s } } },
      }),
  },
  {
    label: 'an `Authorization` header parameter written as a `$ref` into `components/parameters`',
    ignored: (v, s) =>
      petDocument(v, {
        operation: { parameters: [petIdParam, { $ref: '#/components/parameters/Auth' }] },
        components: { parameters: { Auth: { name: 'Authorization', in: 'header', schema: s } } },
      }),
    addsNothingElse: true,
    neighbor: 'the same component named `X-Auth`',
    read: (v, s) =>
      petDocument(v, {
        operation: { parameters: [petIdParam, { $ref: '#/components/parameters/Auth' }] },
        components: { parameters: { Auth: { name: 'X-Auth', in: 'header', schema: s } } },
      }),
  },
  {
    label: 'a `components/headers` entry nothing references',
    ignored: (v, s) => petDocument(v, { components: { headers: { Note: { schema: s } } } }),
    addsNothingElse: true,
    neighbor: 'the same entry as an `X-Note` header',
    read: (v, s) =>
      petDocument(v, {
        operation: {
          responses: { '200': petResponse({ headers: { 'X-Note': { $ref: '#/components/headers/Note' } } }) },
        },
        components: { headers: { Note: { schema: s } } },
      }),
  },
  {
    label: "a `components/responses` entry's `Content-Type` header, the entry returned for a `404`",
    ignored: (v, s) =>
      withResponses(
        v,
        { '404': { $ref: '#/components/responses/Missing' } },
        { responses: { Missing: { description: 'missing', headers: { 'Content-Type': { schema: s } } } } },
      ),
    addsNothingElse: false,
    neighbor: "the entry's `X-Note` header",
    read: (v, s) =>
      withResponses(
        v,
        { '404': { $ref: '#/components/responses/Missing' } },
        { responses: { Missing: { description: 'missing', headers: { 'X-Note': { schema: s } } } } },
      ),
  },
  // --- the one site only the sent/received walk still read --------------------
  {
    label: "an operation's `Idempotency-Key` header parameter, which the SDK injects",
    ignored: (v, s) => withCreatePet(v, {}, { parameters: [{ name: 'Idempotency-Key', in: 'header', schema: s }] }),
    addsNothingElse: false,
    neighbor: "a webhook's `Idempotency-Key` header parameter, which is typed",
    read: (v, s) => withWebhook(v, { parameters: [{ name: 'Idempotency-Key', in: 'header', schema: s }] }),
  },
];

// ---------------------------------------------------------------------------
// One document per schema site, for the agreement between the readers and the walks
// ---------------------------------------------------------------------------

/** What the readers do with a site: type something sent from it, something received, or nothing. */
type Reading = SiteDirection | 'unread';

interface Site {
  label: string;
  reading: Reading;
  /** The document's `paths`, `webhooks` and `components` with `schema` at the site. */
  build: (schema: SchemaObject) => Doc;
  /** The directions the walk visits the site in, when not `reading` alone: a path item read under `paths` and under `webhooks`. */
  visits?: SiteDirection[];
  /**
   * Set for the body of a `components/responses` entry no operation returns: no reader types it and the walk does
   * not visit it, but the name reservation reads it (`resolveComponentResponseModelNames`), so it is a root.
   */
  reserved?: true;
}

/** `GET /d` (`getD`) answering `200` with a string, `operation` merged over it and `item` over its Path Item. */
const get = (operation: Doc = {}, item: Doc = {}): Doc => ({
  paths: { '/d': { ...item, get: { operationId: 'getD', responses: { '200': body(str) }, ...operation } } },
});
const getPaths = (): Doc => get()['paths'] as Doc;
const responses = (entries: Doc): Doc => get({ responses: { '200': body(str), ...entries } });
const post = (operation: Doc): Doc => ({
  paths: { '/d': { post: { operationId: 'postD', responses: { '204': ok }, ...operation } } },
});
const received = { requestBody: { content: json(str) }, responses: { '200': ok } };
const webhook = (operation: Doc, item: Doc = {}): Doc => ({
  ...get(),
  webhooks: { event: { ...item, post: { ...received, ...operation } } },
});
const callback = (operation: Doc, item: Doc = {}): Doc =>
  get({ callbacks: { onEvent: { '{$request.query.url}': { ...item, post: { ...received, ...operation } } } } });
const nestedCallback = (operation: Doc): Doc =>
  callback({ callbacks: { onAck: { '{$request.body#/url}': { post: { ...received, ...operation } } } } });
const withComponents = (doc: Doc, components: Doc): Doc => ({ ...doc, components });
const header = (name: string, declaration: Doc, more: Doc = {}): Doc => ({
  ...ok,
  headers: { [name]: declaration, ...more },
});
const okWith = (headers: Doc): Doc => get({ responses: { '200': { ...body(str), headers } } });
const parameter = (declaration: Doc): Doc => get({ parameters: [declaration] });
const multipart = (mediaType: Doc): Doc => ({
  content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: str } }, ...mediaType } },
});

const sites: Site[] = [
  // --- an operation's responses, by key --------------------------------------
  { label: 'a `200` body', reading: 'received', build: (s) => get({ responses: { '200': body(s) } }) },
  { label: 'a `201` body beside the `200`', reading: 'received', build: (s) => responses({ '201': body(s) }) },
  { label: 'a `204` body', reading: 'received', build: (s) => get({ responses: { '204': body(s) } }) },
  { label: 'a `302` body', reading: 'received', build: (s) => responses({ '302': body(s) }) },
  { label: 'a `404` body', reading: 'received', build: (s) => responses({ '404': body(s) }) },
  { label: 'a `599` body', reading: 'received', build: (s) => responses({ '599': body(s) }) },
  { label: 'a `default` body', reading: 'received', build: (s) => responses({ default: body(s) }) },
  { label: 'a `4XX` body', reading: 'received', build: (s) => responses({ '4XX': body(s) }) },
  { label: 'a `2xx` body, a range in lower case', reading: 'received', build: (s) => responses({ '2xx': body(s) }) },
  { label: 'a `1XX` body, a range', reading: 'received', build: (s) => responses({ '1XX': body(s) }) },
  {
    label: 'the first of `4XX` and `4xx`',
    reading: 'received',
    build: (s) => responses({ '4XX': body(s), '4xx': body(str) }),
  },
  {
    label: 'the first of `4xx` and `4XX`',
    reading: 'received',
    build: (s) => responses({ '4xx': body(s), '4XX': body(str) }),
  },
  {
    label: 'the `4xx` after a `4XX` that is no object, which the reader skips',
    reading: 'received',
    build: (s) => responses({ '4XX': 'oops', '4xx': body(s) }),
  },
  ...[null, 7, []].map((skipped): Site => ({
    label: `the \`4xx\` after a \`4XX\` that is \`${JSON.stringify(skipped)}\``,
    reading: 'received',
    build: (s) => responses({ '4XX': skipped, '4xx': body(s) }),
  })),
  {
    label: 'the `2XX` after a `2xx` that is no object',
    reading: 'received',
    build: (s) => responses({ '2xx': 'oops', '2XX': body(s) }),
  },
  {
    label: 'a header of the `4xx` after a `4XX` that is no object',
    reading: 'received',
    build: (s) => responses({ '4XX': null, '4xx': header('X-Note', { schema: s }) }),
  },
  {
    label: 'the `4xx` after a `4XX` whose `$ref` ends on a `components/responses` entry that is no object',
    reading: 'received',
    build: (s) =>
      withComponents(responses({ '4XX': { $ref: '#/components/responses/Gone' }, '4xx': body(s) }), {
        responses: { Gone: [] },
      }),
  },
  {
    label: 'the `4xx` after a `4XX` whose `$ref` no response answers, which is kept without a body',
    reading: 'unread',
    build: (s) =>
      withComponents(responses({ '4XX': { $ref: '#/components/schemas/Other' }, '4xx': body(s) }), {
        schemas: { Other: str },
      }),
  },
  {
    label: 'the `4xx` after a `4XX` whose `$ref` is no string, which is kept without a body',
    reading: 'unread',
    build: (s) => responses({ '4XX': { $ref: 42 }, '4xx': body(s) }),
  },
  { label: 'a `103` body', reading: 'unread', build: (s) => responses({ '103': body(s) }) },
  { label: 'a `100` body', reading: 'unread', build: (s) => responses({ '100': body(s) }) },
  { label: 'a `199` body', reading: 'unread', build: (s) => responses({ '199': body(s) }) },
  { label: 'a `103` header', reading: 'unread', build: (s) => responses({ '103': header('X-Note', { schema: s }) }) },
  { label: 'a `600` body', reading: 'unread', build: (s) => responses({ '600': body(s) }) },
  { label: 'a `6XX` body', reading: 'unread', build: (s) => responses({ '6XX': body(s) }) },
  { label: 'a `099` body', reading: 'unread', build: (s) => responses({ '099': body(s) }) },
  { label: 'a `Default` body', reading: 'unread', build: (s) => responses({ Default: body(s) }) },
  { label: 'an `x-note` response key', reading: 'unread', build: (s) => responses({ 'x-note': body(s) }) },
  {
    label: 'the second of `4XX` and `4xx`',
    reading: 'unread',
    build: (s) => responses({ '4XX': body(str), '4xx': body(s) }),
  },
  {
    label: 'the second of `4xx` and `4XX`',
    reading: 'unread',
    build: (s) => responses({ '4xx': body(str), '4XX': body(s) }),
  },
  { label: 'a `600` header', reading: 'unread', build: (s) => responses({ '600': header('X-Note', { schema: s }) }) },
  {
    label: 'a header of the second of `4XX` and `4xx`',
    reading: 'unread',
    build: (s) => responses({ '4XX': ok, '4xx': header('X-Note', { schema: s }) }),
  },

  // --- a response body, by media type ----------------------------------------
  ...['application/problem+json', 'application/yaml', '*/*', 'text/csv', 'application/atom+xml', 'x-custom/json'].map(
    (mediaType): Site => ({
      label: `a \`200\` body under \`${mediaType}\``,
      reading: 'received',
      build: (s) => get({ responses: { '200': body(s, mediaType) } }),
    }),
  ),
  {
    label: 'a `200` body under `application/yaml` beside `application/json`',
    reading: 'received',
    build: (s) => get({ responses: { '200': { ...ok, content: { ...json(str), ...under('application/yaml', s) } } } }),
  },
  {
    label: 'a `404` body under `application/yaml` only',
    reading: 'received',
    build: (s) => responses({ '404': body(s, 'application/yaml') }),
  },
  {
    label: 'a `302` body under `application/yaml`',
    reading: 'received',
    build: (s) => responses({ '302': body(s, 'application/yaml') }),
  },
  ...[
    'application/xml',
    'text/xml',
    'text/plain',
    'text/html',
    'application/octet-stream',
    'application/pdf',
    'application/xml; charset=utf-8',
    'APPLICATION/XML',
  ].map((mediaType): Site => ({
    label: `a \`200\` body under \`${mediaType}\` only`,
    reading: 'unread',
    build: (s) => get({ responses: { '200': body(s, mediaType) } }),
  })),
  {
    label: 'a `200` body under `application/xml` beside `application/json`',
    reading: 'unread',
    build: (s) => get({ responses: { '200': { ...ok, content: { ...json(str), ...under('application/xml', s) } } } }),
  },
  {
    label: 'a `404` body under `application/xml` only',
    reading: 'unread',
    build: (s) => responses({ '404': body(s, 'application/xml') }),
  },
  {
    label: 'a `404` body under `text/plain` beside `application/json`',
    reading: 'unread',
    build: (s) => responses({ '404': { ...ok, content: { ...json(str), ...under('text/plain', s) } } }),
  },
  {
    label: 'a `302` body under `application/xml`',
    reading: 'unread',
    build: (s) => responses({ '302': body(s, 'application/xml') }),
  },
  {
    label: 'a `default` body under `application/xml`',
    reading: 'unread',
    build: (s) => responses({ default: body(s, 'application/xml') }),
  },
  {
    label: 'a `4XX` body under `application/pdf`',
    reading: 'unread',
    build: (s) => responses({ '4XX': body(s, 'application/pdf') }),
  },

  // --- a response header -------------------------------------------------------
  { label: 'an `X-Note` header on the `200`', reading: 'received', build: (s) => okWith({ 'X-Note': { schema: s } }) },
  {
    label: 'an `x-note` header, an `x-` name being a name',
    reading: 'received',
    build: (s) => okWith({ 'x-note': { schema: s } }),
  },
  {
    label: 'an `X-Note` header on a `404`',
    reading: 'received',
    build: (s) => responses({ '404': header('X-Note', { schema: s }) }),
  },
  {
    label: 'an `X-Note` header on `default`',
    reading: 'received',
    build: (s) => responses({ default: header('X-Note', { schema: s }) }),
  },
  {
    label: 'an `X-Note` header on a `1XX` range',
    reading: 'received',
    build: (s) => responses({ '1XX': header('X-Note', { schema: s }) }),
  },
  { label: 'an `Accept` response header', reading: 'received', build: (s) => okWith({ Accept: { schema: s } }) },
  {
    label: 'an `Authorization` response header',
    reading: 'received',
    build: (s) => okWith({ Authorization: { schema: s } }),
  },
  {
    label: 'the later `x-note` of `X-Note` and `x-note`',
    reading: 'received',
    build: (s) => okWith({ 'X-Note': { schema: str }, 'x-note': { schema: s } }),
  },
  {
    label: 'a header typed through `content` under `application/json`',
    reading: 'received',
    build: (s) => okWith({ 'X-Note': { content: json(s) } }),
  },
  {
    label: 'a header typed through `content` under `text/plain`',
    reading: 'received',
    build: (s) => okWith({ 'X-Note': { content: under('text/plain', s) } }),
  },
  {
    label: 'a `Content-Type` header on the `200`',
    reading: 'unread',
    build: (s) => okWith({ 'Content-Type': { schema: s } }),
  },
  {
    label: 'a `content-type` header on a `404`',
    reading: 'unread',
    build: (s) => responses({ '404': header('content-type', { schema: s }) }),
  },
  {
    label: 'a `CONTENT-TYPE` header on `default`',
    reading: 'unread',
    build: (s) => responses({ default: header('CONTENT-TYPE', { schema: s }) }),
  },
  {
    label: 'an `X-Note` header shadowed by a later `x-note`',
    reading: 'unread',
    build: (s) => okWith({ 'X-Note': { schema: s }, 'x-note': { schema: str } }),
  },
  {
    label: 'a header `content` under `application/xml`, which is not read',
    reading: 'unread',
    build: (s) => okWith({ 'X-Note': { content: under('application/xml', s) } }),
  },
  {
    label: 'a header `content` beside its `schema`, which wins',
    reading: 'unread',
    build: (s) => okWith({ 'X-Note': { schema: str, content: json(s) } }),
  },
  {
    label: 'a header `content` under `text/plain` beside `application/json`, which is picked',
    reading: 'unread',
    build: (s) => okWith({ 'X-Note': { content: { ...under('text/plain', s), ...json(str) } } }),
  },

  // --- an operation's parameters --------------------------------------------------
  { label: 'a `query` parameter', reading: 'sent', build: (s) => parameter({ name: 'note', in: 'query', schema: s }) },
  {
    label: 'a `path` parameter',
    reading: 'sent',
    build: (s) => ({
      paths: {
        '/d/{note}': {
          get: {
            operationId: 'getD',
            parameters: [{ name: 'note', in: 'path', required: true, schema: s }],
            responses: { '200': body(str) },
          },
        },
      },
    }),
  },
  {
    label: 'an `X-Note` header parameter',
    reading: 'sent',
    build: (s) => parameter({ name: 'X-Note', in: 'header', schema: s }),
  },
  {
    label: 'a `cookie` parameter',
    reading: 'sent',
    build: (s) => parameter({ name: 'note', in: 'cookie', schema: s }),
  },
  {
    label: 'a `query` parameter named `Authorization`',
    reading: 'sent',
    build: (s) => parameter({ name: 'Authorization', in: 'query', schema: s }),
  },
  {
    label: 'a `cookie` parameter named `Content-Type`',
    reading: 'sent',
    build: (s) => parameter({ name: 'Content-Type', in: 'cookie', schema: s }),
  },
  {
    label: 'a `query` parameter named `Idempotency-Key`',
    reading: 'sent',
    build: (s) => parameter({ name: 'Idempotency-Key', in: 'query', schema: s }),
  },
  {
    label: 'a Path Item parameter',
    reading: 'sent',
    build: (s) => get({}, { parameters: [{ name: 'note', in: 'query', schema: s }] }),
  },
  {
    label: 'an operation parameter that replaces a Path Item one',
    reading: 'sent',
    build: (s) =>
      get(
        { parameters: [{ name: 'note', in: 'query', schema: s }] },
        { parameters: [{ name: 'note', in: 'query', schema: str }] },
      ),
  },
  {
    label: 'a parameter typed through `content` under `application/json`',
    reading: 'sent',
    build: (s) => parameter({ name: 'note', in: 'query', content: json(s) }),
  },
  {
    label: 'the first of two `query` parameters, one with no name and one named `""`, which are two',
    reading: 'sent',
    build: (s) =>
      get({
        parameters: [
          { in: 'query', schema: s },
          { name: '', in: 'query', schema: str },
        ],
      }),
  },
  {
    label: 'the first of two `query` parameters named `null` and `""`, which are two',
    reading: 'sent',
    build: (s) =>
      get({
        parameters: [
          { name: null, in: 'query', schema: s },
          { name: '', in: 'query', schema: str },
        ],
      }),
  },
  {
    label: 'the second of two `query` parameters with no name, which replaces the first',
    reading: 'sent',
    build: (s) =>
      get({
        parameters: [
          { in: 'query', schema: str },
          { in: 'query', schema: s },
        ],
      }),
  },
  {
    label: 'the first of two `query` parameters with no name, which the second replaces',
    reading: 'unread',
    build: (s) =>
      get({
        parameters: [
          { in: 'query', schema: s },
          { in: 'query', schema: str },
        ],
      }),
  },
  {
    label: 'a Path Item parameter beside an operation `parameters` that is no array',
    reading: 'sent',
    build: (s) => get({ parameters: 'oops' }, { parameters: [{ name: 'note', in: 'query', schema: s }] }),
  },
  {
    label: 'a parameter after an entry that is no object',
    reading: 'sent',
    build: (s) => get({ parameters: [null, { name: 'note', in: 'query', schema: s }] }),
  },
  {
    label: 'a parameter after an entry whose `$ref` ends on a `components/parameters` entry that is no object',
    reading: 'sent',
    build: (s) =>
      withComponents(
        get({ parameters: [{ $ref: '#/components/parameters/Bad' }, { name: 'note', in: 'query', schema: s }] }),
        { parameters: { Bad: [] } },
      ),
  },
  {
    label: 'a Path Item parameter beside an operation entry of its name that is no object',
    reading: 'sent',
    build: (s) => get({ parameters: ['note'] }, { parameters: [{ name: 'note', in: 'query', schema: s }] }),
  },
  {
    label: 'a parameter typed through `content` under `application/problem+json`',
    reading: 'sent',
    build: (s) => parameter({ name: 'note', in: 'query', content: under('application/problem+json', s) }),
  },
  {
    label: 'a parameter `content` under `text/plain`, picked beside an `application/json` with no schema',
    reading: 'sent',
    build: (s) =>
      parameter({ name: 'note', in: 'query', content: { 'application/json': {}, ...under('text/plain', s) } }),
  },
  {
    label: 'a `query` parameter beside a body property of its name',
    reading: 'sent',
    build: (s) =>
      post({
        parameters: [{ name: 'note', in: 'query', schema: s }],
        requestBody: { content: json({ type: 'object', properties: { note: str } }) },
      }),
  },
  ...['Accept', 'Content-Type', 'Authorization', 'authorization', 'CONTENT-TYPE'].map((name): Site => ({
    label: `a header parameter named \`${name}\``,
    reading: 'unread',
    build: (s) => parameter({ name, in: 'header', schema: s }),
  })),
  {
    label: 'a Path Item header parameter named `Authorization`',
    reading: 'unread',
    build: (s) => get({}, { parameters: [{ name: 'Authorization', in: 'header', schema: s }] }),
  },
  {
    label: 'a header parameter named `Idempotency-Key`, which the SDK injects',
    reading: 'unread',
    build: (s) => post({ parameters: [{ name: 'Idempotency-Key', in: 'header', schema: s }] }),
  },
  {
    label: 'a header parameter named `idempotency-key`',
    reading: 'unread',
    build: (s) => post({ parameters: [{ name: 'idempotency-key', in: 'header', schema: s }] }),
  },
  {
    label: 'a Path Item header parameter named `Idempotency-Key`',
    reading: 'unread',
    build: (s) => get({}, { parameters: [{ name: 'Idempotency-Key', in: 'header', schema: s }] }),
  },
  {
    label: 'an `in: body` parameter',
    reading: 'unread',
    build: (s) => parameter({ name: 'note', in: 'body', schema: s }),
  },
  {
    label: 'an `in: formData` parameter',
    reading: 'unread',
    build: (s) => parameter({ name: 'note', in: 'formData', schema: s }),
  },
  {
    label: 'a Path Item parameter an operation parameter replaces',
    reading: 'unread',
    build: (s) =>
      get(
        { parameters: [{ name: 'note', in: 'query', schema: str }] },
        { parameters: [{ name: 'note', in: 'query', schema: s }] },
      ),
  },
  {
    label: 'a Path Item `X-Note` header an operation `x-note` replaces',
    reading: 'unread',
    build: (s) =>
      get(
        { parameters: [{ name: 'x-note', in: 'header', schema: str }] },
        { parameters: [{ name: 'X-Note', in: 'header', schema: s }] },
      ),
  },
  {
    label: 'a parameter of a Path Item with no operation',
    reading: 'unread',
    build: (s) => ({ paths: { ...getPaths(), '/e': { parameters: [{ name: 'note', in: 'query', schema: s }] } } }),
  },
  {
    label: 'a parameter `content` under `application/xml`, which is not read',
    reading: 'unread',
    build: (s) => parameter({ name: 'note', in: 'query', content: under('application/xml', s) }),
  },
  {
    label: 'a parameter `content` beside its `schema`, which wins',
    reading: 'unread',
    build: (s) => parameter({ name: 'note', in: 'query', schema: str, content: json(s) }),
  },

  // --- an operation's request body -------------------------------------------------
  ...['application/json', 'application/xml', 'text/plain', 'application/octet-stream', 'x-custom/json'].map(
    (mediaType): Site => ({
      label: `a request body under \`${mediaType}\``,
      reading: 'sent',
      build: (s) => post({ requestBody: { content: under(mediaType, s) } }),
    }),
  ),
  {
    label: 'a request body under `application/xml` beside `application/json`',
    reading: 'sent',
    build: (s) => post({ requestBody: { content: { ...json(str), ...under('application/xml', s) } } }),
  },
  { label: 'a request body on a `get`', reading: 'sent', build: (s) => get({ requestBody: { content: json(s) } }) },
  {
    label: 'a multipart property named `x-part`, an `x-` name being a name',
    reading: 'sent',
    build: (s) =>
      post({ requestBody: { content: under('multipart/form-data', { type: 'object', properties: { 'x-part': s } }) } }),
  },
  {
    label: "an encoding's header, on a request body",
    reading: 'unread',
    build: (s) => post({ requestBody: multipart({ encoding: { file: { headers: { 'X-Note': { schema: s } } } } }) }),
  },
  {
    label: "an encoding's header, on a response body",
    reading: 'unread',
    build: (s) =>
      get({
        responses: {
          '200': {
            ...ok,
            content: { 'application/json': { schema: str, encoding: { x: { headers: { 'X-Note': { schema: s } } } } } },
          },
        },
      }),
  },
  {
    label: "an encoding's header typed through `content`",
    reading: 'unread',
    build: (s) =>
      post({ requestBody: multipart({ encoding: { 'x-part': { headers: { 'x-hdr': { content: json(s) } } } } }) }),
  },

  // --- a map written as an array, where its reader asks for an object first -----------
  {
    label: '`responses` written as an array, which the reader reads nothing from',
    reading: 'unread',
    build: (s) => ({ paths: { ...getPaths(), '/e': { get: { operationId: 'getE', responses: [body(s)] } } } }),
  },
  {
    label: '`webhooks` written as an array, which the reader reads nothing from',
    reading: 'unread',
    build: (s) => ({ ...get(), webhooks: [{ post: { ...received, requestBody: { content: json(s) } } }] }),
  },
  {
    label: 'a `callbacks` map written as an array, which the reader reads nothing from',
    reading: 'unread',
    build: (s) =>
      get({ callbacks: [{ '{$request.query.url}': { post: { ...received, requestBody: { content: json(s) } } } }] }),
  },
  {
    label: 'a parameter `content` written as an array, none of whose keys is a media type that is read',
    reading: 'unread',
    build: (s) => parameter({ name: 'note', in: 'query', content: [{ schema: s }] }),
  },
  // A `content` that is no map declares no media type, to the readers as to the walk (#710: the readers
  // typed a media type `0` from each of these, which the walk left out).
  {
    label: 'a request body `content` written as an array, which declares no media type',
    reading: 'unread',
    build: (s) => post({ requestBody: { content: [{ schema: s }] } }),
  },
  {
    label: 'a `200` response `content` written as an array, which declares no media type',
    reading: 'unread',
    build: (s) => get({ responses: { '200': { ...ok, content: [{ schema: s }] } } }),
  },
  {
    label: 'a `404` response `content` written as an array, which declares no media type',
    reading: 'unread',
    build: (s) => responses({ '404': { ...ok, content: [{ schema: s }] } }),
  },
  {
    label: 'a `default` response `content` written as an array, which declares no media type',
    reading: 'unread',
    build: (s) => responses({ default: { ...ok, content: [{ schema: s }] } }),
  },
  {
    label: 'a response header `content` written as an array, which declares no media type',
    reading: 'unread',
    build: (s) => okWith({ 'X-Note': { content: [{ schema: s }] } }),
  },
  {
    label: "a webhook's request body `content` written as an array, which declares no media type",
    reading: 'unread',
    build: (s) => webhook({ requestBody: { content: [{ schema: s }] } }),
  },
  {
    label: "a callback's request body `content` written as an array, which declares no media type",
    reading: 'unread',
    build: (s) => callback({ requestBody: { content: [{ schema: s }] } }),
  },

  // --- the other methods, and keys that are none -------------------------------------
  ...['put', 'post', 'patch', 'delete', 'head', 'options', 'trace'].map((method): Site => ({
    label: `a \`${method}\` operation's \`200\` body`,
    reading: 'received',
    build: (s) => ({ paths: { '/d': { [method]: { operationId: 'op', responses: { '200': body(s) } } } } }),
  })),
  {
    label: 'a path `/x-ray`, an `x-` name being a name',
    reading: 'received',
    build: (s) => ({ paths: { '/x-ray': { get: { operationId: 'getD', responses: { '200': body(s) } } } } }),
  },
  {
    label: 'a `query` key of a Path Item, which is no operation',
    reading: 'unread',
    build: (s) => ({ paths: { '/d': { ...(getPaths()['/d'] as Doc), query: { responses: { '200': body(s) } } } } }),
  },
  {
    label: 'an `x-` key of the Paths Object',
    reading: 'unread',
    build: (s) => ({ paths: { ...getPaths(), 'x-path': { get: { responses: { '200': body(s) } } } } }),
  },

  // --- a webhook ---------------------------------------------------------------------
  {
    label: "a webhook's request body",
    reading: 'received',
    build: (s) => webhook({ requestBody: { content: json(s) } }),
  },
  {
    label: "a webhook's request body under `application/xml`",
    reading: 'received',
    build: (s) => webhook({ requestBody: { content: under('application/xml', s) } }),
  },
  {
    label: 'a webhook named `x-event`',
    reading: 'received',
    build: (s) => ({
      ...get(),
      webhooks: { 'x-event': { post: { requestBody: { content: json(s) }, responses: { '200': ok } } } },
    }),
  },
  {
    label: "a webhook's `query` parameter",
    reading: 'received',
    build: (s) => webhook({ parameters: [{ name: 'note', in: 'query', schema: s }] }),
  },
  {
    label: "a webhook's `X-Note` header parameter",
    reading: 'received',
    build: (s) => webhook({ parameters: [{ name: 'X-Note', in: 'header', schema: s }] }),
  },
  {
    label: "a webhook's `cookie` parameter",
    reading: 'received',
    build: (s) => webhook({ parameters: [{ name: 'note', in: 'cookie', schema: s }] }),
  },
  {
    label: "a webhook's Path Item parameter",
    reading: 'received',
    build: (s) => webhook({}, { parameters: [{ name: 'note', in: 'query', schema: s }] }),
  },
  {
    label: 'a webhook\'s first of two `query` parameters, one with no name and one named `""`',
    reading: 'received',
    build: (s) =>
      webhook({
        parameters: [
          { in: 'query', schema: s },
          { name: '', in: 'query', schema: str },
        ],
      }),
  },
  {
    label: "a webhook's `Idempotency-Key` header parameter, which is typed there",
    reading: 'received',
    build: (s) => webhook({ parameters: [{ name: 'Idempotency-Key', in: 'header', schema: s }] }),
  },
  { label: "a webhook's response body", reading: 'unread', build: (s) => webhook({ responses: { '200': body(s) } }) },
  {
    label: "a webhook's `default` response body",
    reading: 'unread',
    build: (s) => webhook({ responses: { default: body(s) } }),
  },
  {
    label: "a webhook's response header",
    reading: 'unread',
    build: (s) => webhook({ responses: { '200': header('X-Note', { schema: s }) } }),
  },
  {
    label: "a webhook's `path` parameter",
    reading: 'unread',
    build: (s) => webhook({ parameters: [{ name: 'petId', in: 'path', required: true, schema: s }] }),
  },
  {
    label: "a webhook's Path Item `path` parameter",
    reading: 'unread',
    build: (s) => webhook({}, { parameters: [{ name: 'petId', in: 'path', required: true, schema: s }] }),
  },
  {
    label: "a webhook's `Authorization` header parameter",
    reading: 'unread',
    build: (s) => webhook({ parameters: [{ name: 'Authorization', in: 'header', schema: s }] }),
  },
  {
    label: "a webhook's `in: body` parameter",
    reading: 'unread',
    build: (s) => webhook({ parameters: [{ name: 'note', in: 'body', schema: s }] }),
  },
  {
    label: "a webhook's Path Item parameter its operation replaces",
    reading: 'unread',
    build: (s) =>
      webhook(
        { parameters: [{ name: 'note', in: 'query', schema: str }] },
        { parameters: [{ name: 'note', in: 'query', schema: s }] },
      ),
  },
  {
    label: "an encoding's header, on a webhook's request body",
    reading: 'unread',
    build: (s) => webhook({ requestBody: multipart({ encoding: { file: { headers: { 'X-Note': { schema: s } } } } }) }),
  },

  // --- a callback ----------------------------------------------------------------------
  {
    label: "a callback's request body",
    reading: 'received',
    build: (s) => callback({ requestBody: { content: json(s) } }),
  },
  {
    label: "a callback's `query` parameter",
    reading: 'received',
    build: (s) => callback({ parameters: [{ name: 'note', in: 'query', schema: s }] }),
  },
  {
    label: "a callback's Path Item header parameter",
    reading: 'received',
    build: (s) => callback({}, { parameters: [{ name: 'X-Note', in: 'header', schema: s }] }),
  },
  {
    label: 'a callback named `x-cb`',
    reading: 'received',
    build: (s) =>
      get({
        callbacks: { 'x-cb': { '{$request.query.url}': { post: { ...received, requestBody: { content: json(s) } } } } },
      }),
  },
  {
    label: "a webhook's callback's request body",
    reading: 'received',
    build: (s) =>
      webhook({
        callbacks: { onAck: { '{$request.body#/url}': { post: { ...received, requestBody: { content: json(s) } } } } },
      }),
  },
  {
    label: "a nested callback's request body",
    reading: 'received',
    build: (s) => nestedCallback({ requestBody: { content: json(s) } }),
  },
  {
    label: "a callback's `Idempotency-Key` header parameter, which is typed there",
    reading: 'received',
    build: (s) => callback({ parameters: [{ name: 'Idempotency-Key', in: 'header', schema: s }] }),
  },
  { label: "a callback's response body", reading: 'unread', build: (s) => callback({ responses: { '200': body(s) } }) },
  {
    label: "a callback's response header",
    reading: 'unread',
    build: (s) => callback({ responses: { '200': header('X-Note', { schema: s }) } }),
  },
  {
    label: "a callback's `path` parameter",
    reading: 'unread',
    build: (s) => callback({ parameters: [{ name: 'petId', in: 'path', required: true, schema: s }] }),
  },
  {
    label: "a callback's `Accept` header parameter",
    reading: 'unread',
    build: (s) => callback({ parameters: [{ name: 'Accept', in: 'header', schema: s }] }),
  },
  {
    label: "a nested callback's response body",
    reading: 'unread',
    build: (s) => nestedCallback({ responses: { '200': body(s) } }),
  },
  {
    label: 'an `x-` key of a Callback Object',
    reading: 'unread',
    build: (s) =>
      get({ callbacks: { onEvent: { 'x-ext': { post: { ...received, requestBody: { content: json(s) } } } } } }),
  },

  // --- a `components` entry, by the site that references it -----------------------------
  {
    label: 'a `components/responses` entry a `200` references',
    reading: 'received',
    build: (s) =>
      withComponents(get({ responses: { '200': { $ref: '#/components/responses/Note' } } }), {
        responses: { Note: body(s) },
      }),
  },
  {
    label: 'a `components/responses` entry named `x-resp` a `404` references',
    reading: 'received',
    build: (s) =>
      withComponents(responses({ '404': { $ref: '#/components/responses/x-resp' } }), {
        responses: { 'x-resp': body(s) },
      }),
  },
  {
    label: 'a `components/responses` entry a `default` references through another entry',
    reading: 'received',
    build: (s) =>
      withComponents(responses({ default: { $ref: '#/components/responses/Alias' } }), {
        responses: { Alias: { $ref: '#/components/responses/Note' }, Note: body(s) },
      }),
  },
  {
    label: 'a `components/responses` entry both a `103` and a `404` reference',
    reading: 'received',
    build: (s) =>
      withComponents(
        responses({
          '103': { $ref: '#/components/responses/Note' },
          '404': { $ref: '#/components/responses/Note' },
        }),
        { responses: { Note: body(s) } },
      ),
  },
  {
    label: 'a `components/headers` entry an `X-Note` header references',
    reading: 'received',
    build: (s) =>
      withComponents(okWith({ 'X-Note': { $ref: '#/components/headers/Note' } }), { headers: { Note: { schema: s } } }),
  },
  {
    label: "a `components/headers` entry named `x-hdr` a component response's header references",
    reading: 'received',
    build: (s) =>
      withComponents(responses({ '404': { $ref: '#/components/responses/Missing' } }), {
        responses: { Missing: header('X-Note', { $ref: '#/components/headers/x-hdr' }) },
        headers: { 'x-hdr': { schema: s } },
      }),
  },
  {
    label: 'a `components/parameters` entry named `x-param` an operation references',
    reading: 'sent',
    build: (s) =>
      withComponents(parameter({ $ref: '#/components/parameters/x-param' }), {
        parameters: { 'x-param': { name: 'note', in: 'query', schema: s } },
      }),
  },
  {
    label: 'a `components/parameters` entry a Path Item references',
    reading: 'sent',
    build: (s) =>
      withComponents(get({}, { parameters: [{ $ref: '#/components/parameters/Note' }] }), {
        parameters: { Note: { name: 'note', in: 'query', schema: s } },
      }),
  },
  {
    label: 'a `components/parameters` entry a webhook references',
    reading: 'received',
    build: (s) =>
      withComponents(webhook({ parameters: [{ $ref: '#/components/parameters/Note' }] }), {
        parameters: { Note: { name: 'note', in: 'query', schema: s } },
      }),
  },
  {
    label: 'a `components/requestBodies` entry named `x-body` an operation references',
    reading: 'sent',
    build: (s) =>
      withComponents(post({ requestBody: { $ref: '#/components/requestBodies/x-body' } }), {
        requestBodies: { 'x-body': { content: json(s) } },
      }),
  },
  {
    label: 'a `components/requestBodies` entry a webhook references',
    reading: 'received',
    build: (s) =>
      withComponents(webhook({ requestBody: { $ref: '#/components/requestBodies/Note' } }), {
        requestBodies: { Note: { content: json(s) } },
      }),
  },
  {
    label: 'a `components/pathItems` entry named `x-item` a path references',
    reading: 'received',
    build: (s) => ({
      paths: { '/d': { $ref: '#/components/pathItems/x-item' } },
      components: { pathItems: { 'x-item': { get: { operationId: 'getD', responses: { '200': body(s) } } } } },
    }),
  },
  {
    label: 'a `components/pathItems` entry a webhook references, its request body',
    reading: 'received',
    build: (s) => ({
      ...get(),
      webhooks: { event: { $ref: '#/components/pathItems/Event' } },
      components: { pathItems: { Event: { post: { ...received, requestBody: { content: json(s) } } } } },
    }),
  },
  {
    label: 'a `components/callbacks` entry named `x-cb` an operation references',
    reading: 'received',
    build: (s) =>
      withComponents(get({ callbacks: { onEvent: { $ref: '#/components/callbacks/x-cb' } } }), {
        callbacks: { 'x-cb': { '{$request.query.url}': { post: { ...received, requestBody: { content: json(s) } } } } },
      }),
  },
  {
    label: "a `components/pathItems` entry a callback's expression references, its request body",
    reading: 'received',
    build: (s) =>
      withComponents(
        get({ callbacks: { onEvent: { '{$request.query.url}': { $ref: '#/components/pathItems/Hook' } } } }),
        {
          pathItems: { Hook: { post: { ...received, requestBody: { content: json(s) } } } },
        },
      ),
  },
  {
    label: 'a `components/headers` entry typed through `content`, which an `X-Note` header references',
    reading: 'received',
    build: (s) =>
      withComponents(okWith({ 'X-Note': { $ref: '#/components/headers/Note' } }), {
        headers: { Note: { content: json(s) } },
      }),
  },
  {
    label: 'a `components/callbacks` entry that refers back to itself, its request body',
    reading: 'received',
    build: (s) =>
      withComponents(get({ callbacks: { onEvent: { $ref: '#/components/callbacks/Loop' } } }), {
        callbacks: { Loop: { '{$request.query.url}': { $ref: '#/components/pathItems/Hook' } } },
        pathItems: {
          Hook: {
            post: {
              ...received,
              requestBody: { content: json(s) },
              callbacks: { again: { $ref: '#/components/callbacks/Loop' } },
            },
          },
        },
      }),
  },
  {
    label: 'a `paths` entry a webhook references, its request body',
    reading: 'received',
    // Sent by the operation under `paths`, received by the webhook: not only sent.
    visits: ['sent', 'received'],
    build: (s) => ({
      paths: {
        ...getPaths(),
        '/hook': { post: { operationId: 'hook', requestBody: { content: json(s) }, responses: { '204': ok } } },
      },
      webhooks: { event: { $ref: '#/paths/~1hook' } },
    }),
  },
  {
    label: 'a `webhooks` entry a path references, its `200` body',
    reading: 'received',
    build: (s) => ({
      paths: { '/d': { $ref: '#/webhooks/event' } },
      webhooks: {
        event: { post: { operationId: 'hook', requestBody: { content: json(str) }, responses: { '200': body(s) } } },
      },
    }),
  },
  {
    label: 'a `components/responses` entry nothing references',
    reading: 'unread',
    reserved: true,
    build: (s) => withComponents(get(), { responses: { Note: body(s) } }),
  },
  ...['103', '600'].map((key): Site => ({
    label: `a \`components/responses\` entry only a \`${key}\` references`,
    reading: 'unread',
    reserved: true,
    build: (s) =>
      withComponents(responses({ [key]: { $ref: '#/components/responses/Note' } }), { responses: { Note: body(s) } }),
  })),
  {
    label: 'a `components/responses` entry only the second of `4XX` and `4xx` references',
    reading: 'unread',
    reserved: true,
    build: (s) =>
      withComponents(responses({ '4XX': ok, '4xx': { $ref: '#/components/responses/Note' } }), {
        responses: { Note: body(s) },
      }),
  },
  {
    label: "a `components/responses` entry only a webhook's response references",
    reading: 'unread',
    reserved: true,
    build: (s) =>
      withComponents(webhook({ responses: { '200': { $ref: '#/components/responses/Note' } } }), {
        responses: { Note: body(s) },
      }),
  },
  {
    label: "a `components/responses` entry only a callback's response references",
    reading: 'unread',
    reserved: true,
    build: (s) =>
      withComponents(callback({ responses: { '200': { $ref: '#/components/responses/Note' } } }), {
        responses: { Note: body(s) },
      }),
  },
  {
    label: 'a `components/responses` entry nothing references, its `X-Note` header',
    reading: 'unread',
    build: (s) => withComponents(get(), { responses: { Note: header('X-Note', { schema: s }) } }),
  },
  {
    label: 'a `components/responses` entry nothing references, its `application/yaml` body beside `application/json`',
    reading: 'unread',
    build: (s) =>
      withComponents(get(), {
        responses: { Note: { ...ok, content: { ...json(str), ...under('application/yaml', s) } } },
      }),
  },
  {
    label: 'a `components/responses` entry nothing references, its body under `application/xml`',
    reading: 'unread',
    build: (s) => withComponents(get(), { responses: { Note: body(s, 'application/xml') } }),
  },
  {
    label: 'a `components/responses` entry a `404` references, its body under `application/xml`',
    reading: 'unread',
    build: (s) =>
      withComponents(responses({ '404': { $ref: '#/components/responses/Note' } }), {
        responses: { Note: body(s, 'application/xml') },
      }),
  },
  {
    label: 'a `components/responses` entry a `404` references, its `Content-Type` header',
    reading: 'unread',
    build: (s) =>
      withComponents(responses({ '404': { $ref: '#/components/responses/Note' } }), {
        responses: { Note: header('Content-Type', { schema: s }) },
      }),
  },
  {
    label: 'a `components/headers` entry nothing references',
    reading: 'unread',
    build: (s) => withComponents(get(), { headers: { Note: { schema: s } } }),
  },
  {
    label: 'a `components/headers` entry only a `Content-Type` header references',
    reading: 'unread',
    build: (s) =>
      withComponents(okWith({ 'Content-Type': { $ref: '#/components/headers/Note' } }), {
        headers: { Note: { schema: s } },
      }),
  },
  {
    label: 'a `components/headers` entry only a shadowed `X-Note` references',
    reading: 'unread',
    build: (s) =>
      withComponents(okWith({ 'X-Note': { $ref: '#/components/headers/Note' }, 'x-note': { schema: str } }), {
        headers: { Note: { schema: s } },
      }),
  },
  {
    label: "a `components/headers` entry only an encoding's header references",
    reading: 'unread',
    build: (s) =>
      withComponents(
        post({
          requestBody: multipart({
            encoding: { file: { headers: { 'X-Note': { $ref: '#/components/headers/Note' } } } },
          }),
        }),
        { headers: { Note: { schema: s } } },
      ),
  },
  {
    label: 'a `components/parameters` entry nothing references',
    reading: 'unread',
    build: (s) => withComponents(get(), { parameters: { Note: { name: 'note', in: 'query', schema: s } } }),
  },
  {
    label: 'a `components/parameters` entry named `Authorization` in `header` an operation references',
    reading: 'unread',
    build: (s) =>
      withComponents(parameter({ $ref: '#/components/parameters/Auth' }), {
        parameters: { Auth: { name: 'Authorization', in: 'header', schema: s } },
      }),
  },
  {
    label: 'a `components/parameters` entry in `path` only a webhook references',
    reading: 'unread',
    build: (s) =>
      withComponents(webhook({ parameters: [{ $ref: '#/components/parameters/PetId' }] }), {
        parameters: { PetId: { name: 'petId', in: 'path', required: true, schema: s } },
      }),
  },
  {
    label: 'a `components/parameters` entry named `Idempotency-Key` in `header` an operation references',
    reading: 'unread',
    build: (s) =>
      withComponents(post({ parameters: [{ $ref: '#/components/parameters/Key' }] }), {
        parameters: { Key: { name: 'Idempotency-Key', in: 'header', schema: s } },
      }),
  },
  {
    label: 'a `components/parameters` entry in `body` an operation references',
    reading: 'unread',
    build: (s) =>
      withComponents(parameter({ $ref: '#/components/parameters/Note' }), {
        parameters: { Note: { name: 'note', in: 'body', schema: s } },
      }),
  },
  {
    label: 'a `components/requestBodies` entry nothing references',
    reading: 'unread',
    build: (s) => withComponents(get(), { requestBodies: { Note: { content: json(s) } } }),
  },
  {
    label: 'a `components/pathItems` entry nothing references',
    reading: 'unread',
    build: (s) => withComponents(get(), { pathItems: { Item: { get: { responses: { '200': body(s) } } } } }),
  },
  {
    label: 'a `components/pathItems` entry only a webhook references, its `200` body',
    reading: 'unread',
    build: (s) => ({
      ...get(),
      webhooks: { event: { $ref: '#/components/pathItems/Event' } },
      components: { pathItems: { Event: { post: { ...received, responses: { '200': body(s) } } } } },
    }),
  },
  {
    label: 'a `components/callbacks` entry nothing references',
    reading: 'unread',
    build: (s) =>
      withComponents(get(), {
        callbacks: {
          OnEvent: { '{$request.query.url}': { post: { ...received, requestBody: { content: json(s) } } } },
        },
      }),
  },
];

/** A titled variant of the union the agreement check plants at a site: `kind` pinned, one number field. */
const shape = (title: string, field: string): SchemaObject => ({
  type: 'object',
  title,
  properties: { kind: { type: 'string', enum: [title.toLowerCase()] }, [field]: { type: 'number' } },
});
const shapes = (field: string): SchemaObject => ({ oneOf: [shape('Circle', field), shape('Square', 'side')] });
/** A schema that contests `Circle` within itself: a `shape` union beside a `marker` holding one of another shape. */
const contesting = (top: SchemaObject): SchemaObject => ({
  type: 'object',
  properties: { shape: top, marker: { type: 'object', properties: { shape: shapes('diameter') } } },
});
const complete = (openapi: string, parts: Doc): Doc => ({ openapi, info: { title: 'sites', version: '1' }, ...parts });
/** Whether `target` is `value` or sits somewhere inside it. */
const holds = (value: unknown, target: object): boolean =>
  value === target ||
  (typeof value === 'object' && value !== null && Object.values(value).some((entry) => holds(entry, target)));
/** `value` with the keys of every object in it, and the entries of every list, reversed. */
const reversed = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reversed).reverse()
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .map(([key, entry]): [string, unknown] => [key, reversed(entry)])
            .reverse(),
        )
      : value;

/** Each change as the issue reports it. */
const changesOf = ({ changes }: ReturnType<typeof diffSpecs>): string[] =>
  changes.map((change) => {
    const { classification, kind, name, operationName } = change as typeof change & {
      name?: string;
      operationName?: string;
    };
    return `${kind} ${name ?? operationName} (${classification})`;
  });
/** Each model with its fields, so a renamed variant and a retyped reference both show. */
const modelsOf = (spec: ApiSpec): string[] =>
  spec.models.map(
    ({ fields, name }) => `${name} { ${fields.map((f) => `${f.name}: ${JSON.stringify(f.type)}`).join(', ')} }`,
  );
const names = (spec: ApiSpec): string[] => spec.models.map(({ name }) => name);

describe('#670 a union at a site the parser ignores contests no title', () => {
  let dir: string;
  let counter = 0;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-670-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    // The readers warn about what they ignore (a `600`, a second `4xx`, a
    // webhook's `path` parameter), and `diffCommand` prints its report.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    markContestedTitles(undefined);
  });

  /** Write `doc` to a file of its own and parse it. */
  async function parse(doc: Doc): Promise<{ file: string; spec: ApiSpec }> {
    const file = path.join(dir, `${counter++}.json`);
    await fs.writeFile(file, JSON.stringify(doc));
    return { file, spec: await parseSpec(file) };
  }

  describe.each(['3.1.0', '3.0.3'])('OAS %s', (openapi) => {
    it("the issue's script: every document prints the models of `old.json`", async () => {
      const documents: Array<[string, Doc]> = [
        ['old.json', old(openapi)],
        ...['early-hints.json', 'content-type.json', 'authorization.json', 'webhook-response.json', 'xml.json'].map(
          (file): [string, Doc] => [
            file,
            ignoredSites.find(({ label }) => label.startsWith(`\`${file}\``))!.ignored(openapi, note()),
          ],
        ),
      ];
      const printed: string[] = [];
      for (const [file, doc] of documents) printed.push(`${file} ${JSON.stringify(names((await parse(doc)).spec))}`);
      expect(printed).toEqual([
        'old.json ["Pet","Tag","Chip"]',
        'early-hints.json ["Pet","Tag","Chip"]',
        'content-type.json ["Pet","Tag","Chip"]',
        'authorization.json ["Pet","Tag","Chip"]',
        'webhook-response.json ["Pet","Tag","Chip","PetAdoptedPayload"]',
        'xml.json ["Pet","Tag","Chip"]',
      ]);
    });

    let before: ApiSpec;
    beforeAll(async () => {
      before = (await parse(old(openapi))).spec;
    });

    describe.each(ignoredSites)('$label', ({ ignored, addsNothingElse, orderDecides, neighbor, read }) => {
      it('contests nothing: the models are those of the document with a string there, and `oagen diff` finds no change (exit 0)', async () => {
        const { file: plainFile, spec: plain } = await parse(ignored(openapi, str));
        const { file: nextFile, spec: next } = await parse(ignored(openapi, note()));
        // The component's own variants keep their titles, and nothing is typed from the site.
        expect(names(next)).toEqual(expect.arrayContaining(['Pet', 'Tag', 'Chip']));
        expect(names(next)).not.toContain('TagPetCollar');
        expect(names(next)).not.toContain('Sticker');
        expect(modelsOf(next)).toEqual(modelsOf(plain));
        expect(next.enums.map(({ name }) => name)).toEqual(plain.enums.map(({ name }) => name));
        expect(diffSpecs(plain, next).changes).toEqual([]);
        const exit: unknown = await diffCommand({ old: plainFile, new: nextFile }).catch((e: unknown) => e);
        expect((exit as { exitCode?: number }).exitCode).toBe(0);
        // Against `old.json` itself: nothing breaking, and nothing at all when the document adds only the ignored site.
        const fromOld = diffSpecs(before, next);
        expect(changesOf(fromOld).filter((change) => change.endsWith('(breaking)'))).toEqual([]);
        if (addsNothingElse) {
          expect(names(next)).toEqual(['Pet', 'Tag', 'Chip']);
          expect(changesOf(fromOld)).toEqual([]);
        }
      });

      it(`still contests the title at the site beside it that is read: ${neighbor}`, async () => {
        const { spec } = await parse(read(openapi, note()));
        // Both shapes of `Tag` are typed under one root there, so neither keeps the bare title.
        expect(names(spec)).toContain('TagPetCollar');
        expect(names(spec)).not.toContain('Tag');
      });

      // Where the order of two declarations is the site (the later range key, the earlier header), reversing
      // them moves the schema to the declaration that is read.
      if (!orderDecides) {
        it('gives the same models with every map and list of the document reversed', async () => {
          const { spec: forward } = await parse(ignored(openapi, note()));
          const { spec: backward } = await parse(reversed(ignored(openapi, note())) as Doc);
          expect(names(backward).sort()).toEqual(names(forward).sort());
          expect(names(backward)).toEqual(expect.arrayContaining(['Pet', 'Tag', 'Chip']));
          expect(names(backward)).not.toContain('TagPetCollar');
        });
      }
    });

    describe('the reader, the contested-title walker and the sent/received walk give each site one answer', () => {
      it.each(sites)('$label: $reading', async ({ reading, build, visits, reserved }) => {
        // The reader: a model with a `radius` field exists exactly when something is typed from the site.
        const { spec } = await parse(complete(openapi, build(contesting(shapes('radius')))));
        const typed = spec.models.some(({ fields }) => fields.some(({ name }) => name === 'radius'));
        // The contested-title walker: the site's own two `Circle`s are contested exactly when it is a root, which
        // it is when a reader types it, or when the name reservation reads it (`reserved`).
        const top = shapes('radius');
        markContestedTitles(complete(openapi, build(contesting(top))));
        const root = isContestedTitle(top.oneOf![0]!);
        // The sent/received walk: `Probe`, named at the site alone, is only sent when the site sends it; beside a
        // request body that sends it, it stays only sent unless the site receives it.
        const probed = (paths: Doc): boolean => {
          const parts = build({ $ref: '#/components/schemas/Probe' });
          return sentOnlyComponentNames(
            complete(openapi, {
              ...parts,
              paths: { ...(parts['paths'] as Doc | undefined), ...paths },
              components: { ...(parts['components'] as Doc | undefined), schemas: { Probe: { type: 'object' } } },
            }),
          ).has('Probe');
        };
        const sender = {
          '/sender': { post: { requestBody: { content: json({ $ref: '#/components/schemas/Probe' }) } } },
        };
        const walked: Reading = probed({}) ? 'sent' : probed(sender) ? 'unread' : 'received';
        // The walk itself, asked directly.
        const visited: SiteDirection[] = [];
        const planted = contesting(shapes('radius'));
        readSchemaSites(complete(openapi, build(planted)), (schema, direction) => {
          if (holds(schema, planted)) visited.push(direction);
        });
        expect({ typed, root, walked, visited }).toEqual({
          typed: reading !== 'unread',
          root: reading !== 'unread' || reserved === true,
          walked: reading,
          visited: visits ?? (reading === 'unread' ? [] : [reading]),
        });
      });
    });
  });

  it("an operation's `Idempotency-Key` header of `$ref: Pet` sends nothing: `Pet.owner` is typed as without it", async () => {
    // `Pet.owner` requires `name` and the component `PetOwner` does not: a `Pet` the SDK only sends keeps the
    // stricter `PetOwner2` (#400). The header is injected, never typed, so it sends no `Pet`.
    const schemas = {
      Pet: {
        type: 'object',
        properties: { owner: { type: 'object', properties: { name: str }, required: ['name'] } },
      },
      PetOwner: { type: 'object', properties: { name: str } },
    };
    const createPet = (parameters: Doc[]): Doc => ({
      openapi: '3.1.0',
      info: { title: 'Pets', version: '1' },
      paths: { '/pets': { post: { operationId: 'createPet', parameters, responses: { '204': ok } } } },
      components: { schemas },
    });
    const petRef = { $ref: '#/components/schemas/Pet' };
    const fields = (spec: ApiSpec) =>
      Object.fromEntries(spec.models.map(({ name, fields }) => [name, fields.map((f) => JSON.stringify(f.type))]));
    const { spec: without } = await parse(createPet([]));
    const { spec: injected } = await parse(createPet([{ name: 'Idempotency-Key', in: 'header', schema: petRef }]));
    const { spec: sent } = await parse(createPet([{ name: 'X-Pet', in: 'header', schema: petRef }]));
    expect(injected.services[0]!.operations[0]!.headerParams).toEqual([]);
    expect(injected.services[0]!.operations[0]!.injectIdempotencyKey).toBe(true);
    expect(fields(injected)).toEqual(fields(without));
    expect(names(injected)).toEqual(['Pet', 'PetOwner']);
    // The control: a header that is typed sends `Pet`, whose `owner` then keeps the stricter model.
    expect(names(sent)).toEqual(['Pet', 'PetOwner', 'PetOwner2']);
    expect(
      sentOnlyComponentNames(createPet([{ name: 'Idempotency-Key', in: 'header', schema: petRef }])).has('Pet'),
    ).toBe(false);
    expect(sentOnlyComponentNames(createPet([{ name: 'X-Pet', in: 'header', schema: petRef }])).has('Pet')).toBe(true);
  });

  describe('the body of a `components/responses` entry is read where it is declared, returned or not', () => {
    // The operation pass reserves the names every entry's body mints, whether or not an operation returns it
    // (`resolveComponentResponseModelNames`, #234), by running the extractor over that body. Those names are the
    // ones its titles are decided under, so the body is a root wherever that pass runs. A `103`, a webhook's
    // response or a callback's written as a `$ref` to the entry adds nothing to that.
    const hints = (schema: SchemaObject): Doc => ({ responses: { Hints: { ...ok, content: json(schema) } } });
    const hintsRef = { $ref: '#/components/responses/Hints' };
    const withPet = (doc: Doc, components: Doc): Doc => ({
      ...doc,
      components: { schemas: { Pet: pet() }, ...components },
    });
    /** The entry declared, and referenced only where the readers type nothing, beside the same document without the reference. */
    const unreturned: Array<
      [string, (openapi: string, components: Doc) => Doc, (openapi: string, components: Doc) => Doc]
    > = [
      [
        'a `103`',
        (v, components) => withResponses(v, { '103': hintsRef }, components),
        (v, components) => petDocument(v, { components }),
      ],
      [
        "a webhook's response",
        (v, components) => withPet(withWebhook(v, { responses: { '200': hintsRef } }), components),
        (v, components) => withPet(withWebhook(v), components),
      ],
      [
        "a callback's response",
        (v, components) => withPet(withCallback(v, { responses: { '200': hintsRef } }), components),
        (v, components) => withPet(withCallback(v), components),
      ],
    ];

    describe.each(['3.1.0', '3.0.3'])('OAS %s', (openapi) => {
      it('decides the titles of a body nothing returns with the names it reserves, as before', async () => {
        const { spec: declared } = await parse(petDocument(openapi, { components: hints(note()) }));
        const { spec: returned } = await parse(withResponses(openapi, { '404': hintsRef }, hints(note())));
        // Nothing is typed from the body until an operation returns it, but its titles are decided where it is
        // declared: returning it adds its models and renames nothing.
        expect(names(declared)).toEqual(['Pet', 'TagPetCollar', 'Chip']);
        expect(names(returned)).toEqual(expect.arrayContaining(['Pet', 'TagPetCollar', 'Chip', 'Sticker']));
        expect(changesOf(diffSpecs(declared, returned)).filter((change) => change.endsWith('(breaking)'))).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
      });

      it.each(unreturned)('%s written as a `$ref` to it adds nothing', async (_site, referenced, unreferenced) => {
        for (const schema of [str, note()]) {
          const { spec: without } = await parse(unreferenced(openapi, hints(schema)));
          const { spec: with_ } = await parse(referenced(openapi, hints(schema)));
          expect(modelsOf(with_)).toEqual(modelsOf(without));
          expect(diffSpecs(without, with_).changes).toEqual([]);
        }
        expect(console.warn).not.toHaveBeenCalled();
      });

      it('reads the names a body nothing returns reserves under its titles as decided, so none moves another body', async () => {
        // `Card`, which `getPet` returns for a `404`, holds a `Circle`. Beside it, a `Hints` nothing returns gives
        // `Circle` two shapes within its body: it reserves the qualified names the two take, not a bare `Circle`,
        // which would step `Card`'s body to `CardResponse2` (as a `Hints` holding `Card`'s very `Circle` does).
        const card = { ...ok, content: json({ type: 'object', properties: { shape: shapes('radius') } }) };
        const twoCircles: SchemaObject = {
          type: 'object',
          properties: {
            shape: { oneOf: [shape('Circle', 'radius'), shape('Oval', 'width')] },
            marker: {
              type: 'object',
              properties: { shape: { oneOf: [shape('Circle', 'diameter'), shape('Blob', 'area')] } },
            },
          },
        };
        const withHints = (schema: SchemaObject | undefined): Doc =>
          withResponses(
            openapi,
            { '404': { $ref: '#/components/responses/Card' } },
            { responses: { ...(schema ? (hints(schema)['responses'] as Doc) : {}), Card: card } },
          );
        const { spec: alone } = await parse(withHints(undefined));
        const { spec: plain } = await parse(withHints(str));
        const { spec: contested } = await parse(withHints(twoCircles));
        const { spec: shared } = await parse(withHints({ type: 'object', properties: { shape: shapes('radius') } }));
        expect(names(alone)).toEqual(['Pet', 'Tag', 'Chip', 'CardResponse', 'Circle', 'Square']);
        expect(modelsOf(plain)).toEqual(modelsOf(alone));
        expect(modelsOf(contested)).toEqual(modelsOf(alone));
        expect(diffSpecs(plain, contested).changes).toEqual([]);
        expect(names(shared)).toEqual(['Pet', 'Tag', 'Chip', 'CardResponse2', 'Circle', 'Square']);
        expect(console.warn).not.toHaveBeenCalled();
      });

      it('still steps a returned body past the name of an entry nothing returns (#234)', async () => {
        const card = { ...ok, content: json({ type: 'object', properties: { id: str } }) };
        const withCard = (extra: Doc): Doc =>
          withResponses(
            openapi,
            { '404': { $ref: '#/components/responses/Card' } },
            { responses: { Card: card, ...extra } },
          );
        const { spec: alone } = await parse(withCard({}));
        const { spec: beside } = await parse(withCard({ CardResponse: { ...ok, content: json(str) } }));
        const { spec: contested } = await parse(
          withCard({ CardResponse: { ...ok, content: json(contesting(shapes('radius'))) } }),
        );
        expect(names(alone)).toEqual(['Pet', 'Tag', 'Chip', 'CardResponse']);
        expect(names(beside)).toEqual(['Pet', 'Tag', 'Chip', 'CardResponse2']);
        expect(modelsOf(contested)).toEqual(modelsOf(beside));
        expect(console.warn).not.toHaveBeenCalled();
      });
    });

    it('is a root where the reservation runs: with `paths`, and for the one body it reads', () => {
      const marks = (doc: (schema: SchemaObject) => Doc): boolean => {
        const top = shapes('radius');
        markContestedTitles(doc(contesting(top)));
        return isContestedTitle(top.oneOf![0]!);
      };
      // No `paths`, no operation pass: nothing reads the entry.
      expect(marks((s) => ({ components: { responses: { Note: body(s) } } }))).toBe(false);
      expect(marks((s) => ({ paths: {}, components: { responses: { Note: body(s) } } }))).toBe(true);
      // Through a chain of refs, as the reservation follows one.
      expect(
        marks((s) => ({
          paths: {},
          components: { responses: { Alias: { $ref: '#/components/responses/Note' }, Note: body(s) } },
        })),
      ).toBe(true);
      // Its headers and the media types the reservation does not read are no roots until an operation returns it.
      expect(marks((s) => ({ paths: {}, components: { responses: { Note: header('X-Note', { schema: s }) } } }))).toBe(
        false,
      );
      expect(
        marks((s) => ({
          paths: {},
          components: { responses: { Note: { ...ok, content: { ...json(str), ...under('application/yaml', s) } } } },
        })),
      ).toBe(false);
      expect(marks((s) => ({ paths: {}, components: { responses: { Note: body(s, 'application/xml') } } }))).toBe(
        false,
      );
      // Every other kind of `components` entry nothing references is read by nothing.
      expect(marks((s) => ({ paths: {}, components: { headers: { Note: { schema: s } } } }))).toBe(false);
      expect(marks((s) => ({ paths: {}, components: { requestBodies: { Note: { content: json(s) } } } }))).toBe(false);
      expect(
        marks((s) => ({ paths: {}, components: { parameters: { Note: { name: 'n', in: 'query', schema: s } } } })),
      ).toBe(false);
    });
  });

  describe('the documents a review of the walk found, where it and a reader had parted', () => {
    const minted = (): string[] => vi.mocked(console.warn).mock.calls.map((call) => call.map(String).join(' '));
    const fieldsOf = (spec: ApiSpec, model: string): string[] | undefined =>
      spec.models.find(({ name }) => name === model)?.fields.map(({ name }) => name);

    describe.each(['3.1.0', '3.0.3'])('OAS %s', (openapi) => {
      it('a `Hints` nothing returns, giving `Circle` two shapes, leaves the body of a returned `Card` its name', async () => {
        // The name reservation reads `Hints` whether or not it is returned. Read with no title contested it
        // reserved a bare `Circle`, a name the body never mints, and `Card`, which holds a `Circle`, stepped to
        // `CardResponse2`: editing `Hints` alone was a breaking change to `getPet`.
        const twoShapes: SchemaObject = {
          type: 'object',
          properties: {
            shape: { oneOf: [shape('Circle', 'radius'), shape('Oval', 'width')] },
            marker: {
              type: 'object',
              properties: { shape: { oneOf: [shape('Circle', 'diameter'), shape('Blob', 'area')] } },
            },
          },
        };
        const hintsRef = { $ref: '#/components/responses/Hints' };
        const doc = (hints: SchemaObject, more: Doc = {}): Doc => ({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: {
            '/pets/{petId}': {
              get: {
                operationId: 'getPet',
                parameters: [petIdParam],
                responses: { '200': body(str), '404': { $ref: '#/components/responses/Card' }, ...more },
              },
            },
          },
          components: {
            responses: {
              Hints: { description: 'hints', content: json(hints) },
              Card: {
                description: 'card',
                content: json({
                  type: 'object',
                  properties: { outline: { oneOf: [shape('Circle', 'radius'), shape('Square', 'side')] } },
                }),
              },
            },
          },
        });
        const { spec: plain } = await parse(doc(str));
        const { spec: union } = await parse(doc(twoShapes));
        const { spec: hinted } = await parse(doc(twoShapes, { '103': hintsRef }));
        const { spec: returned } = await parse(doc(twoShapes, { '500': hintsRef }));
        expect(names(union)).toEqual(['CardResponse', 'Circle', 'Square']);
        expect(union.services[0]!.operations[0]!.errors.map(({ statusCode, type }) => [statusCode, type])).toEqual([
          [404, { kind: 'model', name: 'CardResponse' }],
        ]);
        expect(diffSpecs(plain, union).changes).toEqual([]);
        expect(names(hinted)).toEqual(names(union));
        expect(diffSpecs(union, hinted).changes).toEqual([]);
        // Returned, `Hints` mints the names it had reserved, and `Card` keeps its own.
        expect(names(returned)).toEqual([
          'CardResponse',
          'Circle',
          'Square',
          'HintResponse',
          'CircleHintResponseShape',
          'Oval',
          'HintResponseMarker',
          'CircleHintResponseMarkerShape',
          'Blob',
        ]);
        expect(minted()).toEqual([]);
      });

      it('the `4xx` after `4XX: "oops"` is the range\'s entry, and its two `Circle`s are told apart', async () => {
        // The reader skips an entry that is no object before it counts as its range's first (#617), so it types
        // the `4xx`. The walk had counted the skipped `4XX`, left the `4xx` out, and the body was typed with no
        // title contested: `marker.shape` resolved to the `radius` `Circle`, under a "minted twice" warning.
        const { spec } = await parse(
          complete(openapi, responses({ '4XX': 'oops', '4xx': body(contesting(shapes('radius'))) })),
        );
        expect(names(spec)).toEqual([
          'GetDError4Xx',
          'CircleGetDError4XxShape',
          'Square',
          'GetDError4XxMarker',
          'CircleGetDError4XxMarkerShape',
        ]);
        expect(fieldsOf(spec, 'CircleGetDError4XxShape')).toEqual(['kind', 'radius']);
        expect(fieldsOf(spec, 'CircleGetDError4XxMarkerShape')).toEqual(['kind', 'diameter']);
        expect(minted().filter((warning) => warning.includes('minted twice'))).toEqual([]);
        expect(minted().filter((warning) => warning.includes('is not a Response Object'))).toHaveLength(1);
      });

      it('two parameters without a string name are two, as the readers key them', async () => {
        // `{ in: 'query' }` and `{ name: '', in: 'query' }` are `query:undefined` and `query:` to the readers
        // (`parameterKey`). The walk had keyed both `''`, so the second replaced the first and its schema was
        // typed with no title contested.
        const { spec } = await parse(
          complete(
            openapi,
            get({
              parameters: [
                { in: 'query', schema: contesting(shapes('radius')) },
                { name: '', in: 'query', schema: str },
              ],
            }),
          ),
        );
        expect(names(spec)).toEqual([
          'DUndefined',
          'CircleDUndefinedShape',
          'Square',
          'DUndefinedMarker',
          'CircleDUndefinedMarkerShape',
        ]);
        expect(fieldsOf(spec, 'CircleDUndefinedMarkerShape')).toEqual(['kind', 'diameter']);
        expect(minted().filter((warning) => warning.includes('minted twice'))).toEqual([]);
      });

      it('so are a parameter named `null` beside one named `""`, and the same two on a webhook', async () => {
        const two = (name: unknown): Doc[] => [
          { ...(name === undefined ? {} : { name }), in: 'query', schema: contesting(shapes('radius')) },
          { name: '', in: 'query', schema: str },
        ];
        const { spec: named } = await parse(complete(openapi, get({ parameters: two(null) })));
        expect(names(named)).toEqual(['DNull', 'CircleDNullShape', 'Square', 'DNullMarker', 'CircleDNullMarkerShape']);
        const { spec: received } = await parse(complete(openapi, webhook({ parameters: two(undefined) })));
        expect(names(received)).toEqual([
          'EventUndefined',
          'CircleEventUndefinedShape',
          'Square',
          'EventUndefinedMarker',
          'CircleEventUndefinedMarkerShape',
        ]);
        expect(received.webhooks?.[0]?.queryParams.map(({ name }) => name)).toEqual([undefined, '']);
        expect(minted().filter((warning) => warning.includes('minted twice'))).toEqual([]);
      });
    });
  });

  it('visits a schema once per site that reaches it, and makes it one root', () => {
    // One `components/responses` body two operations return, and one schema object two sites hold.
    const shared = contesting(shapes('radius'));
    const doc = complete('3.1.0', {
      paths: {
        '/a': { get: { responses: { '404': { $ref: '#/components/responses/Missing' } } } },
        '/b': {
          post: {
            requestBody: { content: json(shared) },
            responses: { '404': { $ref: '#/components/responses/Missing' } },
          },
        },
      },
      components: { responses: { Missing: body(shared) } },
    });
    const visited: SiteDirection[] = [];
    readSchemaSites(doc, (schema, direction) => {
      if (schema === shared) visited.push(direction);
    });
    expect(visited).toEqual(['received', 'sent', 'received']);
    markContestedTitles(doc);
    const top = (shared.properties!['shape'] as SchemaObject).oneOf![0]!;
    expect(isContestedTitle(top)).toBe(true);
  });

  it('ends on a document whose callbacks lead back to themselves, by `$ref` or by object identity', () => {
    const planted = contesting(shapes('radius'));
    const item: Doc = { post: { requestBody: { content: json(planted) }, responses: { '200': body(planted) } } };
    // The path item's own callback leads back to the path item.
    (item['post'] as Doc)['callbacks'] = { back: { '{$request.body#/url}': item } };
    const visited: SiteDirection[] = [];
    readSchemaSites(
      complete('3.1.0', {
        paths: { '/d': item, '/e': { $ref: '#/paths/~1e' }, '/f': { $ref: '#/components/pathItems/Loop' } },
        webhooks: { event: { $ref: '#/components/pathItems/Hook' } },
        components: {
          pathItems: {
            Loop: { $ref: '#/components/pathItems/Loop' },
            Hook: { post: { callbacks: { again: { $ref: '#/components/callbacks/Again' } } } },
          },
          callbacks: { Again: { '{$url}': { $ref: '#/components/pathItems/Hook' } } },
        },
      }),
      (schema, direction) => {
        if (schema === planted) visited.push(direction);
      },
    );
    // `/d` sends its body, its callback receives the same path item's once, and `/d` receives its `200`.
    expect(visited).toEqual(['sent', 'received', 'received']);
  });
});
