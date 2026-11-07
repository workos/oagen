import type { TypeRef } from '../ir/types.js';
import { mediaTypeEssence } from '../utils/media-type.js';

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
 * (`typeSecondaryContent`), and by the sent/received walk
 * (`sentOnlyComponentNames`), which reads a response body by exactly the
 * media types whose schema the reader reads — so a body of `$ref: Pet` under
 * `application/xml` neither types anything as `Pet` nor counts as receiving
 * it (workos/oagen#610). A request body has no such list: every media type
 * that declares a schema is typed through it, as the primary pick
 * (`selectRequestBodyContent`) or a secondary entry
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
