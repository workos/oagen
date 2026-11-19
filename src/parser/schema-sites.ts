/**
 * The schema sites of a document the readers type something from, outside
 * `components.schemas`: one walk, the one definition of "a site the parser
 * reads" for every pass that decides something ahead of the readers.
 *
 * Two passes run before any operation is read and must agree with the
 * readers on what will be: the contested-title walker
 * (`markContestedTitles`), for which each schema visited here is a root —
 * beside the one schema read without being typed, the body of a
 * `components/responses` entry no operation returns, whose names are
 * reserved all the same (`schemaRootsOf`) — and the sent/received walk
 * (`sentOnlyComponentNames`), which follows each to the components it
 * names. Both go through `readSchemaSites`, so the two
 * read the same sites, and a site the readers step over — a `103` body, a
 * `Content-Type` header, an `Authorization` parameter, a webhook's response
 * — is stepped over by both (#670: the contested-title walker read every
 * such site, so a titled union there renamed a component's variant of
 * another shape, `Tag` to `TagPetCollar`, though nothing was typed from
 * it).
 *
 * Every skip is asked of the reader's own rule where the reader names one
 * (`HTTP_METHODS`, `isIgnoredHeaderParameter`, `isIdempotencyKeyHeader`,
 * `isIgnoredResponseHeader`, `classifyResponseKey`, `isResponseEntry`,
 * `resolveResponseRef`, `responseBodyReading`, `mediaTypesOf`,
 * `parameterTyping`, `parameterKey`, `pathItemRefTarget`), and mirrors the
 * reader's branch
 * where it does not. `test/parser/schema-sites.test.ts` holds one document
 * per site and checks that the reader, this walk and both passes give it
 * one answer, so a site among them that a reader gains or drops fails there
 * until the walk follows.
 */
import { foldHeaderName, parameterKey, type ParameterLocation } from '../ir/parameter-key.js';
import { mediaTypesOf, responseBodyReading } from './body-media-types.js';
import {
  HTTP_METHODS,
  isIdempotencyKeyHeader,
  isIgnoredHeaderParameter,
  isIgnoredResponseHeader,
  parameterTyping,
  type ParameterObject,
  type SchemaOrContent,
} from './operations.js';
import { pathItemRefTarget, resolveComponentRef } from './path-item-refs.js';
import { isResponseEntry, resolveResponseRef } from './response-refs.js';
import { classifyResponseKey } from './responses.js';
import type { SchemaObject } from './schemas.js';

/** Which way a site moves what it types: out with a request the SDK makes, or in. */
export type SiteDirection = 'sent' | 'received';

/** The `components` sections `follow` leads into: a Reference Object's, a Path Item's `$ref`'s or a Callback Object's. */
type ReferencedSection = 'pathItems' | 'parameters' | 'requestBodies' | 'headers' | 'callbacks';

/**
 * The `in` locations a parameter is typed at: the ones `buildOperation`
 * types through `extractParams` (`ParameterObject['in']`, the type this
 * record is keyed by, so a location added to it must be listed here). A
 * parameter declared anywhere else (`in: body`, `in: formData`) is on no
 * list of an operation or a webhook, and nothing reads its schema.
 */
const TYPED_PARAMETER_LOCATIONS: Record<ParameterObject['in'], true> = {
  path: true,
  query: true,
  header: true,
  cookie: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Call `visit` with every schema the readers type something from outside
 * `components.schemas`, and the direction its site moves it in. A schema two
 * sites share is visited for each, and one site reached twice — a
 * `components/responses` entry two operations return — is visited twice.
 *
 * **What is read.** Every entry of `paths` but an `x-` extension
 * (`extractOperations`) and every entry of `webhooks`, an `x-` key included
 * (`extractWebhooks`, #421), each a Path Item followed as the readers follow
 * one (`resolvePathItemRef`: into `components/pathItems`, or to another
 * `paths` or `webhooks` entry, #422) and read through its operations
 * (`HTTP_METHODS`). Of an operation:
 *
 * - **Parameters**, sent by an operation under `paths` and received by a
 *   webhook or a callback: the Path Item's, then its own, each Reference
 *   Object followed into `components/parameters`, an operation parameter
 *   replacing a Path Item one of the same identity (`parameterKey`: location
 *   and name, a header's name case-folded) as `buildOperation` and
 *   `readPathItemEntries` merge them, so a Path Item parameter the operation
 *   overrides is no site, nor is one of a Path Item with no operation. Not
 *   read: an `Accept`, `Content-Type` or `Authorization` header, which
 *   OpenAPI says to ignore (`isIgnoredHeaderParameter`, #414); one in no
 *   location the readers type (`in: body`); an operation's
 *   `Idempotency-Key` header, which the SDK injects
 *   (`isIdempotencyKeyHeader`); and a webhook's or a callback's `path`
 *   parameter, which `readPathItemEntries` drops with a warning.
 * - **The request body**, sent or received the same way, a Reference Object
 *   followed into `components/requestBodies`: the schema of every media
 *   type it declares, each typed as the primary pick
 *   (`selectRequestBodyContent`) or a secondary entry
 *   (`typeSecondaryRequestContent`, a webhook's `mintPayload`), under
 *   `application/xml` as under `application/json`.
 * - **Responses**, received, of an operation under `paths` only — a
 *   webhook's and a callback's type no body and no header
 *   (`extractWebhookResponses`): each key classified as `extractResponses`
 *   classifies it (`classifyResponseKey`), so a 200–599 status code,
 *   `default` and a `1XX`–`5XX` range are read and a 1xx status code (`103`),
 *   an `x-` extension, a key OpenAPI does not define (`600`, `6XX`) and the
 *   later of two range keys that differ in case alone (`4xx` after `4XX`,
 *   `readFallbackResponse`) are not; the entry resolved as the reader
 *   resolves it (`isResponseEntry`, `resolveResponseRef`), so one that is no
 *   object, or whose `$ref` ends on a `components/responses` entry that is
 *   none, is skipped before it counts as its range's first (#617: after
 *   `4XX: "oops"` the `4xx` is the one read). Of a response that is read: the schema of every
 *   media type the reader types through its schema (`responseBodyReading`:
 *   every one but `application/octet-stream`, `application/pdf`,
 *   `text/plain`, `text/html`, `text/xml` and `application/xml`, by essence,
 *   #610), and every header, read as `extractResponseHeaders` reads the map —
 *   of two keys that differ in case alone the later declaration (#295),
 *   never one keyed `Content-Type` (`isIgnoredResponseHeader`, #540), each
 *   followed into `components/headers`.
 * - **Callbacks**, of an operation, a webhook or a callback alike, read as
 *   `extractCallbacks` reads them: each Callback Object, a `$ref` followed
 *   into `components/callbacks` and one that refers back to a callback it
 *   sits in read once, maps expressions — an `x-` key is an extension — to
 *   Path Items whose requests the SDK is sent, so their parameters and
 *   bodies are received and their responses type nothing (#382).
 *
 * A parameter or a header is read by the one schema that types it
 * (`parameterTyping`): its `schema`, else the schema of the `content` entry
 * `selectParameterContent` picks; a `content` map beside a `schema`, or one
 * none of whose media types is read, is no site. An Encoding Object is
 * never entered: no reader reads `encoding`, so its `headers` are no site.
 *
 * **References.** A Reference Object is followed to the component its
 * chain ends on and read there; nothing written beside the `$ref` is read
 * (`followReference`, #562, #601), and a chain that loops, leaves its
 * section or ends on no object reads nothing. A `$ref` key holding
 * `undefined` is no reference. So a `components` entry is read exactly
 * where a site that is read references it: one nothing references, or one
 * only a site that is stepped over references (`103: { $ref:
 * '#/components/responses/Hints' }`), is no site of this walk.
 *
 * **A `content` that is no map.** A `content` is read through the readers'
 * own check (`mediaTypesOf`): one that is no object — an array, a string —
 * declares no media type, to the readers and to this walk alike, so
 * `content: [{ schema }]` is a site of neither (#710: the readers typed a
 * media type `0` from it, which this walk left out).
 *
 * **Not followed: any other map written as an array.** Every other map is
 * read here as an object that is no array. The readers that iterate
 * `paths`, a `headers` map or a `components` section without asking what it
 * is read one written as an array by its indexes (`headers: [{ schema }]`
 * types a header `0`); this walk leaves such a map out, as both walks it
 * replaces did.
 */
export function readSchemaSites(
  document: Record<string, unknown>,
  visit: (schema: SchemaObject, direction: SiteDirection) => void,
): void {
  const components = isRecord(document['components']) ? document['components'] : {};
  /** What a Reference Object chain into `section` leads to; `undefined` for one that loops or leads nowhere. */
  const follow = (value: unknown, section: ReferencedSection): Record<string, unknown> | undefined => {
    const entries = components[section];
    const map = isRecord(entries) ? (entries as Record<string, Record<string, unknown>>) : undefined;
    const seen = new Set<string>();
    let current = value;
    while (isRecord(current) && current['$ref'] !== undefined) {
      const ref = current['$ref'];
      if (typeof ref !== 'string' || seen.has(ref)) return undefined;
      seen.add(ref);
      // A Path Item's `$ref` may also name another `paths` or `webhooks`
      // entry, as `resolvePathItemRef` reads it (#422).
      current =
        section === 'pathItems' ? pathItemRefTarget(ref, map, document) : resolveComponentRef(ref, section, map);
    }
    return isRecord(current) ? current : undefined;
  };
  const schema = (value: unknown, direction: SiteDirection): void => {
    if (isRecord(value)) visit(value as SchemaObject, direction);
  };
  /**
   * A request body's `content` map — an operation's, sent, or a webhook's or
   * a callback's, received — read as the body readers read it: every media
   * type that declares a schema is typed through it, as the primary pick
   * (`selectRequestBodyContent`) or a secondary entry
   * (`typeSecondaryRequestContent`, `mintPayload`: `requestBodyContents`).
   * `encoding` is not read. A `content` that is no object is no map and
   * declares no media type, as to those readers (`mediaTypesOf`, #710).
   */
  const requestContent = (value: unknown, direction: SiteDirection): void => {
    for (const mediaType of Object.values(mediaTypesOf(value) ?? {})) {
      if (isRecord(mediaType)) schema(mediaType['schema'], direction);
    }
  };
  /**
   * A response's `content` map, read as `extractResponseContents` reads it:
   * a media type the reader types as a binary string or a string without
   * reading its schema (`responseBodyReading`) is no site, as the primary
   * pick (`primaryBodySchema`) and a secondary entry (`typeSecondaryContent`)
   * alike leave its schema unread; every other media type types its body
   * through its schema (#610). A `content` that is no object is no map and
   * declares no media type, as to the reader (`mediaTypesOf`, #710).
   */
  const responseContent = (value: unknown): void => {
    for (const [contentType, mediaType] of Object.entries(mediaTypesOf(value) ?? {})) {
      if (!isRecord(mediaType) || responseBodyReading(contentType) !== 'schema') continue;
      schema(mediaType['schema'], 'received');
    }
  };
  /**
   * A Parameter or Header Object, read by the one schema that types it
   * (`parameterTyping`): its `schema`, else the schema of the `content`
   * entry `selectParameterContent` picks. One typed as a string — a
   * `content` map none of whose media types is read, a `content` that is
   * no map (`mediaTypesOf`, #710), or no schema at all — is no site, and a
   * `content` map beside a `schema` is not consulted.
   */
  const typed = (declaration: Record<string, unknown>, direction: SiteDirection): void => {
    schema(parameterTyping(declaration as SchemaOrContent).schema, direction);
  };
  /**
   * The parameters `operation` types, resolved as `buildOperation` and
   * `readPathItemEntries` resolve them: the Path Item's, then its own, each
   * Reference Object followed, an `Accept`, `Content-Type` or
   * `Authorization` header dropped (#414), an operation parameter replacing
   * a Path Item one of the same identity — the readers' own key
   * (`parameterKey`), given the `name` as it is written, so two parameters
   * with no name, or one with none beside one named `''`, are two as they
   * are to the readers (`query:undefined`, `query:`). Of those left, the
   * ones in a location the readers type are read, less the one each reader
   * leaves untyped: an operation's `Idempotency-Key` header, which the SDK
   * injects, and a received request's `path` parameter, which has no path to
   * sit in.
   */
  const parameters = (item: Record<string, unknown>, operation: Record<string, unknown>, direction: SiteDirection) => {
    const byIdentity = new Map<string, Record<string, unknown>>();
    for (const list of [item['parameters'], operation['parameters']]) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const resolved = follow(raw, 'parameters');
        const location = resolved?.['in'];
        if (!resolved || typeof location !== 'string' || !Object.hasOwn(TYPED_PARAMETER_LOCATIONS, location)) continue;
        const name = resolved['name'];
        // A header's name is folded before anything asks about it
        // (`foldHeaderName`), which fails the parse on one that is no
        // string: no reader gets to type the operation.
        if (location === 'header' && typeof name !== 'string') continue;
        const identity = { in: location as ParameterLocation, name: name as string };
        if (isIgnoredHeaderParameter(identity as ParameterObject)) continue;
        if (direction === 'sent' ? isIdempotencyKeyHeader(identity) : identity.in === 'path') continue;
        byIdentity.set(parameterKey(identity.in, identity.name), resolved);
      }
    }
    for (const resolved of byIdentity.values()) typed(resolved, direction);
  };
  /**
   * The Callback Objects on the path to the one being read, by identity
   * after `$ref` resolution: a callback that refers back to one it sits in
   * is read once, as `extractCallbacks` reads it (#382).
   */
  const readingCallbacks = new Set<object>();
  /** Each callback of an operation: its path items are read as a webhook's is, since a callback's request is one the SDK is sent. */
  const callbacks = (map: unknown): void => {
    if (!isRecord(map)) return;
    for (const raw of Object.values(map)) {
      const callback = follow(raw, 'callbacks');
      if (!callback || readingCallbacks.has(callback)) continue;
      readingCallbacks.add(callback);
      for (const [expression, entry] of Object.entries(callback)) {
        // An `x-` key is a specification extension of the Callback Object.
        if (expression.startsWith('x-')) continue;
        const item = follow(entry, 'pathItems');
        if (item) pathItem(item, true);
      }
      readingCallbacks.delete(callback);
    }
  };
  /**
   * A response's `headers` map, read as `extractResponseHeaders` reads it:
   * header names are case-insensitive, so of two keys that differ in case
   * alone the later declaration is the header (#295), and a `Content-Type`
   * header, which OpenAPI says to ignore, is skipped by its key, whatever
   * its `$ref` leads to (`isIgnoredResponseHeader`, #540). Nothing types the
   * dropped declaration or the ignored header.
   */
  const responseHeaders = (headers: unknown): void => {
    if (!isRecord(headers)) return;
    const declared = new Map<string, unknown>();
    for (const [name, header] of Object.entries(headers)) declared.set(foldHeaderName(name), header);
    for (const [name, header] of declared) {
      if (isIgnoredResponseHeader(name)) continue;
      const resolved = follow(header, 'headers');
      if (resolved) typed(resolved, 'received');
    }
  };
  /**
   * An operation's `responses` map, read as `extractResponses` reads it,
   * each key classified as the reader classifies it (`classifyResponseKey`):
   * a 200–599 status code, `default` and a `1XX`–`5XX` range are read, body
   * and headers alike. A 1xx status code is kept as written and nothing of
   * it typed, an `x-` key is an extension, and a key OpenAPI does not define
   * (`600`, `6XX`) is warned about — once, by the reader — and ignored. An
   * entry is resolved by the reader's own resolver, silently: one that is no
   * object (`isResponseEntry`), or whose `$ref` chain ends on a
   * `components/responses` entry that is none (`resolveResponseRef`), is
   * skipped as the reader skips it, and a `$ref` nothing answers is read as
   * the Reference Object it is, with no body and no headers (#562). Of two
   * range keys that differ in case alone (`4XX` beside `4xx`) only the first
   * the reader keeps is read (`readFallbackResponse`): an entry it skipped
   * takes no range, so after `4XX: "oops"` the `4xx` is the range's entry
   * (#617), while a `4XX` whose `$ref` nothing answers is kept, without a
   * body, and the `4xx` after it dropped.
   */
  const operationResponses = (responses: unknown): void => {
    if (!isRecord(responses)) return;
    const entries = components['responses'];
    const componentResponses = isRecord(entries) ? (entries as Record<string, Record<string, unknown>>) : undefined;
    const ranges = new Set<string>();
    for (const [code, entry] of Object.entries(responses)) {
      const key = classifyResponseKey(code);
      if (key.kind === 'extension' || key.kind === 'unrecognized') continue;
      if (key.kind === 'status' && key.code < 200) continue;
      if (!isResponseEntry(entry)) continue;
      const response = resolveResponseRef(entry, componentResponses, code, 'override', 'silent');
      if (response === undefined) continue;
      if (key.kind === 'range') {
        if (ranges.has(key.range)) continue;
        ranges.add(key.range);
      }
      responseContent(response['content']);
      responseHeaders(response['headers']);
    }
  };
  /** A path item's operations, their requests read as sent or — a webhook's or a callback's — received. */
  const pathItem = (item: Record<string, unknown>, received: boolean): void => {
    const request: SiteDirection = received ? 'received' : 'sent';
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      parameters(item, operation, request);
      requestContent(follow(operation['requestBody'], 'requestBodies')?.['content'], request);
      callbacks(operation['callbacks']);
      // A webhook's and a callback's responses type no body and no header
      // (`extractWebhookResponses`).
      if (!received) operationResponses(operation['responses']);
    }
  };
  const pathItems = (map: unknown, webhooks: boolean): void => {
    if (!isRecord(map)) return;
    for (const [key, raw] of Object.entries(map)) {
      // An extension under `paths`; a webhook's name under `webhooks` (#421).
      if (!webhooks && key.startsWith('x-')) continue;
      const item = follow(raw, 'pathItems');
      // A webhook's request is one the SDK is sent.
      if (item) pathItem(item, webhooks);
    }
  };
  pathItems(document['paths'], false);
  pathItems(document['webhooks'], true);
}
