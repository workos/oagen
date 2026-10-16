import type { ExternalDocs } from '../ir/types.js';
import type { SchemaObject } from './schemas.js';

/**
 * An External Documentation Object as written in the OpenAPI document, before
 * validation. Any key may be missing or of the wrong type; `readExternalDocs`
 * decides what reaches the IR.
 */
export interface RawExternalDocs {
  url?: string;
  description?: string;
}

/**
 * Read an `externalDocs` value from the document into the IR.
 *
 * Only `url` makes the object meaningful, so an entry is kept when `url` is a
 * string with non-whitespace content and dropped otherwise — a non-object, a
 * missing `url`, a blank one. The parser ignored `externalDocs` entirely
 * before it was read, so a malformed value must keep parsing the way a
 * malformed document tag does: it is skipped, neither warned about nor thrown
 * on, and nothing the IR used to carry is lost.
 *
 * `url` is kept exactly as written. OpenAPI allows it to be relative to the
 * document's own location, which the parser does not know, so it neither
 * resolves nor rewrites it. `description` is carried only when it has
 * non-whitespace content, matching how a blank operation summary or tag
 * description is treated as absent; text with content is kept verbatim.
 */
export function readExternalDocs(raw: unknown): ExternalDocs | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { url, description } = raw as RawExternalDocs;
  if (typeof url !== 'string' || url.trim() === '') return undefined;
  const described = typeof description === 'string' && description.trim() !== '';
  return described ? { url, description } : { url };
}

/**
 * `{ externalDocs }` when `raw` is a usable entry and `{}` otherwise, for
 * spreading into an IR node literal so the key stays absent — not present but
 * `undefined` — on nodes without one. Same shape as `constraintsEntry`.
 */
export function externalDocsEntry(raw: unknown): { externalDocs?: ExternalDocs } {
  const externalDocs = readExternalDocs(raw);
  return externalDocs ? { externalDocs } : {};
}

/**
 * `inner` carrying the wrapper's `externalDocs` when the wrapper declares a
 * usable one, its own otherwise. A wrapper the parser collapses — a nullable
 * `oneOf`/`anyOf`, a single-member `allOf` — is the schema the document
 * wrote for the field, so its link is that schema's own documentation and
 * the model built from what it unwraps to must carry it, or the link would
 * vanish with the wrapper. A branch or member that documents itself keeps
 * its link only when the wrapper says nothing.
 */
export function withWrapperExternalDocs(inner: SchemaObject, wrapper: SchemaObject): SchemaObject {
  return { ...inner, ...externalDocsEntry(wrapper.externalDocs) };
}
