import type { TypeRef } from '../ir/types.js';
import { mediaTypeEssence } from '../utils/media-type.js';

/**
 * The media-type map of a `content` — a Parameter, Header, Request Body or
 * Response Object's — as every reader reads one: the object itself, whose
 * keys are the media types the site declares, or `undefined` when the site
 * declares none through it. OpenAPI defines `content` as a map of media
 * types to Media Type Objects, so one that is absent declares no media
 * type, and neither does one written as anything but an object — a string,
 * an array, a number, a boolean or `null`: `content: "json"`, `content:
 * ['application/json']`, `content: 7`. Such a value is no map at all, and
 * it is read as an absent `content` is — never by the indexes of a string's
 * characters or of an array's elements, which `Object.keys` lists as
 * readily as a map's keys, so that `content: "json"` declared the media
 * types `0`, `1`, `2` and `3` (#710).
 *
 * The one check every reader of a `content` asks before it lists a key:
 * the parameter and header typing (`selectParameterContent`,
 * `parameterTyping`), the request body pick and its media types
 * (`selectRequestBodyContent`, `extractRequestBodyContents`, a webhook's or
 * a callback's `mintPayload`), the response body pick and its media types
 * (`primaryBodySchema`, `jsonResponseSchema`, `extractResponseContents`),
 * the name reservation (`collectOperationConstPrefixes`) and the walk over
 * the sites the readers type (`readSchemaSites`) — so no reader can list a
 * media type another does not, and none of them an index.
 *
 * Given a `site`, a `content` that is written and is no object is warned
 * about once, naming the site and the value as JSON (`content of the
 * request body of createNote is not a map of media types ("json"); reading
 * no media type from it.`), the way a `parameters` that is no array and a
 * `responses` that is no object are (`declaredParameterEntries`,
 * `isResponsesObject`). The site is passed by the one reader that reports
 * on each `content` — `warnUnreadParameterContent` for a parameter's or a
 * response header's, `warnUnreadRequestBody` for a request body's,
 * `extractResponseContents` for a response's — and by no other, so a
 * `content` several readers visit is reported once.
 */
export function mediaTypesOf<M = unknown>(content: unknown, site?: string): Record<string, M> | undefined {
  if (content === undefined) return undefined;
  if (typeof content === 'object' && content !== null && !Array.isArray(content)) return content as Record<string, M>;
  if (site !== undefined) {
    console.warn(
      `[oagen] Warning: content of ${site} is not a map of media types (${JSON.stringify(content)}); ` +
        `reading no media type from it.`,
    );
  }
  return undefined;
}

/**
 * How the operation reader types a response body by the media type it is
 * declared under: `binary` and `text` without reading its schema, `schema`
 * through the schema it declares (`unknown` when it declares none).
 */
export type ResponseBodyReading = 'binary' | 'text' | 'schema';

/**
 * The media types a response body is typed as a binary string under, by
 * essence, in the order the fixed-order pick tries them
 * (`primaryBodySchema`). Their schema is never read.
 */
export const BINARY_RESPONSE_MEDIA_TYPES: readonly string[] = ['application/octet-stream', 'application/pdf'];

/**
 * The media types a response body is typed as a plain string under, by
 * essence, in the order the fixed-order pick tries them
 * (`primaryBodySchema`). Their schema is never read.
 */
export const TEXT_RESPONSE_MEDIA_TYPES: readonly string[] = ['text/plain', 'text/html', 'text/xml', 'application/xml'];

/**
 * How a response body under `contentType` is read, by essence — parameters
 * and case aside, so `application/pdf; version=1.7` is as binary as
 * `application/pdf` and `TEXT/PLAIN; charset=utf-8` as much a string as
 * `text/plain`: `binary` for `application/octet-stream` and
 * `application/pdf`, `text` for `text/plain`, `text/html`, `text/xml` and
 * `application/xml`, each typed without its schema being read, whatever it
 * says; `schema` for every other media type — `application/json`, a `+json`
 * type, `application/*+json`, `*\/*`, `application/yaml`, `text/csv`, a
 * `+xml` type such as `application/atom+xml` — typed from the schema it
 * declares. The one classification of a response body's media type, read by
 * the fixed-order pick of the primary body (`primaryBodySchema`), by every
 * secondary entry of a 2xx, 3xx, error, `default` or range response
 * (`typeSecondaryContent`), and by the walk over the sites the readers type
 * (`readSchemaSites`), which reads a response body by exactly the media
 * types whose schema the reader reads — so a body of `$ref: Pet` under
 * `application/xml` neither types anything as `Pet` nor counts as receiving
 * it (`sentOnlyComponentNames`, workos/oagen#610), and a titled union in it
 * contests no title (`markContestedTitles`, #670). A request body has no
 * such list: every media type that declares a schema is typed through it,
 * as the primary pick (`selectRequestBodyContent`) or a secondary entry
 * (`typeSecondaryRequestContent`, a webhook's `mintPayload`), and one
 * without is typed by `schemalessRequestContentType`, so the walk reads a
 * request body — an operation's, sent, a webhook's or a callback's, received
 * — under every media type it declares.
 */
export function responseBodyReading(contentType: string): ResponseBodyReading {
  const essence = mediaTypeEssence(contentType);
  if (BINARY_RESPONSE_MEDIA_TYPES.includes(essence)) return 'binary';
  if (TEXT_RESPONSE_MEDIA_TYPES.includes(essence)) return 'text';
  return 'schema';
}

/**
 * The type of a response body read without its schema: a binary string for
 * a `binary` media type, a string for a `text` one — what the primary pick
 * and a secondary entry alike give such a body. Each call returns a new
 * object.
 */
export function unreadResponseBodyType(reading: Exclude<ResponseBodyReading, 'schema'>): TypeRef {
  return reading === 'binary'
    ? { kind: 'primitive', type: 'string', format: 'binary' }
    : { kind: 'primitive', type: 'string' };
}
