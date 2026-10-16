import { createHash } from 'node:crypto';
import type { HttpMethod, Model, Parameter, TypeRef, Webhook, WebhookResponse } from '../ir/types.js';
import { cleanSchemaName, stripListItemMarkers, toPascalCase } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { resolveSchemaName, schemaToTypeRef } from './schemas.js';
import { extractInlineModelsFromProperties } from './inline-models.js';
import {
  HTTP_METHODS,
  buildDescription,
  collectConstPrefixes,
  extractParams,
  operationIdModelBase,
  presentText,
  resolveParameterRef,
  resolveRequestBodyRef,
  selectRequestBodyContent,
  type OperationObject,
  type ParameterObject,
  type PathItem,
  type RequestBodyObject,
} from './operations.js';
import { extractSecurityRequirements } from './security.js';

/** The `components` sections webhook extraction resolves references against. */
export interface WebhookComponents {
  schemas?: Record<string, SchemaObject>;
  parameters?: Record<string, Record<string, unknown>>;
  requestBodies?: Record<string, Record<string, unknown>>;
  examples?: Record<string, Record<string, unknown>>;
  /** `components.pathItems` (OpenAPI 3.1), the only target a webhook entry's `$ref` may point at. */
  pathItems?: Record<string, Record<string, unknown>>;
}

export interface WebhookExtractionResult {
  /** One entry per (webhook key, HTTP method), in document order. */
  webhooks: Webhook[];
  /** Models materialized from inline payload schemas, to merge into `ApiSpec.models`. */
  inlineModels: Model[];
}

/** The suffix every model minted from a webhook's stem starts with (`<Stem>Payload`, `<Stem>PayloadPet`, ...). */
const PAYLOAD_SUFFIX = 'Payload';

/** One (key, method) pair of the `webhooks` map, with its references resolved. */
interface WebhookEntry {
  name: string;
  method: HttpMethod;
  op: OperationObject;
  /** The webhook's own parameters after path-item-level ones, deduplicated by (in, name). */
  params: ParameterObject[];
  body: RequestBodyObject | undefined;
  /** `webhooks.<name>.<method>`, for diagnostics. */
  label: string;
  /** How many methods the entry's path item declares; a second one qualifies the stem. */
  methodCount: number;
}

/**
 * Read the document's top-level `webhooks` map (OpenAPI 3.1) into the IR.
 *
 * Each key names a path item, and each HTTP method on it is one `Webhook`,
 * in document order. The key is kept verbatim as `Webhook.name`. An entry
 * that is a `$ref` into `components/pathItems` is resolved (chains included,
 * with a cycle guard); one that points anywhere else, or that cannot be
 * resolved, is warned about and skipped rather than failing the parse, as is
 * an entry that is not an object. A `webhooks` value that is not an object
 * at all is warned about and ignored. Nothing is read from `x-webhooks`, the
 * pre-3.1 convention: the parser reads the standard key only.
 *
 * Parameters and request bodies go through the same resolvers and extractors
 * as operations (`components/parameters` and `components/requestBodies` refs
 * resolved, path-item-level parameters overridden by operation-level ones of
 * the same identity), so a malformed reference fails the parse the way it
 * does on an operation. A `path` parameter has nowhere to go — a webhook has
 * no path — and is dropped with a warning.
 *
 * The payload schema is typed and materialized as the `payload` property of a
 * synthetic object named by the webhook's stem (see
 * `resolveWebhookModelStems`), through the same `schemaToTypeRef` /
 * `extractInlineModelsFromProperties` pair that names component fields and
 * response unions. An inline object therefore becomes `<Stem>Payload` with
 * its nested objects under it (`<Stem>PayloadPet`); a `oneOf` of inline
 * objects stays a union whose variants are named as any field-level union's
 * are, discriminator intact, because an event handler switches on it; a
 * `$ref` stays a reference; an inline enum takes the same name and is
 * promoted by `collectInlineEnumsFromWebhooks`. Nothing is flattened.
 *
 * `reservedModelNames` is every model name already decided — the component
 * models and the operations' inline models — so a stem is never allowed to
 * mint a name one of them owns.
 */
export function extractWebhooks(
  webhooks: unknown,
  components: WebhookComponents = {},
  reservedModelNames: Iterable<string> = [],
): WebhookExtractionResult {
  if (webhooks === undefined) return { webhooks: [], inlineModels: [] };
  if (!isRecord(webhooks)) {
    console.warn('[oagen] Warning: Top-level `webhooks` is not an object; ignoring it.');
    return { webhooks: [], inlineModels: [] };
  }

  const entries = collectWebhookEntries(webhooks, components);
  const stems = resolveWebhookModelStems(entries, reservedModelNames);
  const inlineModels: Model[] = [];
  const result: Webhook[] = [];

  for (const entry of entries) {
    result.push(buildWebhook(entry, stems.get(entry)!, components, inlineModels));
  }

  return { webhooks: result, inlineModels };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten the map into one entry per (key, method), resolving path-item refs
 * and parameter / request-body refs up front so the stem resolution below can
 * read every entry's payload schema before any name is decided.
 */
function collectWebhookEntries(webhooks: Record<string, unknown>, components: WebhookComponents): WebhookEntry[] {
  const entries: WebhookEntry[] = [];
  for (const [name, raw] of Object.entries(webhooks)) {
    const pathItem = resolveWebhookPathItem(name, raw, components.pathItems);
    if (!pathItem) continue;
    const methods = HTTP_METHODS.filter((method) => isRecord(pathItem[method]));
    for (const method of methods) {
      const op = pathItem[method] as OperationObject;
      const label = `webhooks.${name}.${method}`;
      // Same precedence as buildOperation: an operation-level parameter replaces
      // a path-item-level one of the same (in, name) identity, in the
      // path-level position.
      const paramsByIdentity = new Map<string, ParameterObject>();
      for (const rawParam of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
        const param = resolveParameterRef(rawParam, components.parameters, label);
        paramsByIdentity.set(`${param.in}:${param.name}`, param);
      }
      const params: ParameterObject[] = [];
      for (const param of paramsByIdentity.values()) {
        if (param.in === 'path') {
          console.warn(
            `[oagen] Warning: Parameter "${param.name}" (in: path) on ${label} ignored: a webhook has no path to place it in.`,
          );
          continue;
        }
        params.push(param);
      }
      const body = resolveRequestBodyRef(op.requestBody, components.requestBodies, label);
      entries.push({ name, method, op, params, body, label, methodCount: methods.length });
    }
  }
  return entries;
}

/**
 * The path item a `webhooks` entry denotes: the entry itself, or the
 * `components/pathItems` component a `$ref` chain leads to. Fields written
 * beside a `$ref` are not merged in — OpenAPI leaves a conflict between them
 * and the referenced item undefined, so the referenced item is taken whole.
 * Returns `undefined`, after a warning, for an entry that is not an object,
 * a ref outside `components/pathItems`, a dangling ref, or a cycle.
 */
function resolveWebhookPathItem(
  name: string,
  raw: unknown,
  componentPathItems: Record<string, Record<string, unknown>> | undefined,
): PathItem | undefined {
  const seenRefs = new Set<string>();
  let current: unknown = raw;
  while (true) {
    if (!isRecord(current)) {
      console.warn(`[oagen] Warning: Webhook "${name}" is not a path item object; skipping it.`);
      return undefined;
    }
    const ref = current.$ref;
    if (ref === undefined) return current as PathItem;
    if (typeof ref !== 'string') {
      console.warn(`[oagen] Warning: Webhook "${name}" has a non-string $ref; skipping it.`);
      return undefined;
    }
    if (seenRefs.has(ref)) {
      console.warn(
        `[oagen] Warning: Circular path item $ref chain starting at "${ref}" for webhook "${name}"; skipping it.`,
      );
      return undefined;
    }
    seenRefs.add(ref);
    // Match the whole pointer: a ref into any other section must not resolve
    // off a same-named path item component.
    const match = /^#\/components\/pathItems\/(.+)$/.exec(ref);
    // JSON Pointer escapes (RFC 6901 §4): `~1` -> `/`, then `~0` -> `~`, in that order.
    const refName = match?.[1].replace(/~1/g, '/').replace(/~0/g, '~');
    const resolved = refName ? componentPathItems?.[refName] : undefined;
    if (!resolved) {
      console.warn(
        `[oagen] Warning: Unresolved path item $ref "${ref}" for webhook "${name}": ` +
          'no matching entry under components/pathItems. Skipping the webhook.',
      );
      return undefined;
    }
    current = resolved;
  }
}

/**
 * Decide the stem every model of each webhook is named from: `<Stem>Payload`
 * for the payload, `<Stem>Payload<Field>` for objects nested in it,
 * `<Const><Stem>Payload` for a const-discriminated variant, `<Stem><Param>`
 * for an inline parameter enum.
 *
 * The plain stem is the `operationId` when the operation declares one — run
 * through the same cleaning an operation's own `…Request` model gets, so a
 * webhook and an operation with the same id name their models alike — and
 * the PascalCase of the webhook's key otherwise. When a key's path item
 * declares several methods, a key-derived stem has the method appended
 * (`PetUpdatedPut`) so the bodies never share a model; an operationId is
 * unique per document and needs no qualifier. A key that PascalCases to
 * nothing, or to something starting with a digit, gets `Webhook` in front.
 *
 * A stem collides when a reserved name — a component model, or an inline
 * model an operation already minted — starts with `<Stem>Payload` in any of
 * its cleaned spellings, or with that behind a const value the payload can
 * prepend (`collectConstPrefixes`); or when another webhook's
 * `<Stem>Payload` starts with it, which covers two keys that flatten to one
 * stem (`pet_adopted` and `petAdopted`) as well as one stem nesting under
 * another. A colliding stem takes the first six hex characters of the SHA-1
 * of the webhook's key before the method qualifier (`PetAdopted546F12`),
 * exactly as an operationId-less operation's path prefix does. The check is
 * deliberately a superset — a reserved `PetAdoptedPayloads` also pushes the
 * stem onto the hash — because never sharing a name wrongly matters more
 * than the rare extra hash. The outcome depends only on the document's keys,
 * operationIds, component names and operations, never on their order, and a
 * key that stops colliding returns to its plain stem.
 */
function resolveWebhookModelStems(
  entries: WebhookEntry[],
  reservedModelNames: Iterable<string>,
): Map<WebhookEntry, string> {
  const reserved = [...reservedModelNames];
  const plainStems = new Map<WebhookEntry, string>();
  for (const entry of entries) plainStems.set(entry, plainStem(entry, ''));

  const stems = new Map<WebhookEntry, string>();
  for (const entry of entries) {
    const stem = plainStems.get(entry)!;
    const spellings = prefixSpellings(stem + PAYLOAD_SUFFIX);
    const constPrefixes = new Set<string>();
    collectConstPrefixes(selectRequestBodyContent(entry.body).schema, constPrefixes, 0);
    const prefixes = [...spellings, ...[...constPrefixes].flatMap((c) => spellings.map((s) => c + s))];
    const reservedTaken = reserved.some((name) => prefixes.some((prefix) => name.startsWith(prefix)));
    const webhookTaken = entries.some(
      (other) =>
        other !== entry && spellings.some((spelling) => (plainStems.get(other)! + PAYLOAD_SUFFIX).startsWith(spelling)),
    );
    stems.set(entry, reservedTaken || webhookTaken ? plainStem(entry, webhookDisambiguator(entry.name)) : stem);
  }
  return stems;
}

/** The stem of `entry` with `disambiguator` (possibly empty) inserted before the method qualifier. */
function plainStem(entry: WebhookEntry, disambiguator: string): string {
  const operationId = entry.op.operationId;
  const method = !operationId && entry.methodCount > 1 ? entry.method : '';
  const base = operationId ? operationIdModelBase(operationId) : toPascalCase(entry.name);
  // `_` separators guarantee a word boundary on each side of the disambiguator
  // and the method, whatever the base ends with; splitWords drops them.
  const stem = toPascalCase([base, disambiguator, method].filter(Boolean).join('_'));
  if (stem === '') return 'Webhook';
  return /^\d/.test(stem) ? `Webhook${stem}` : stem;
}

/** The first six hex characters of the SHA-1 of a webhook's key. */
function webhookDisambiguator(name: string): string {
  return createHash('sha1').update(name).digest('hex').slice(0, 6);
}

/**
 * The spellings a stem-derived prefix could take after one of the parser's
 * cleaning steps — the same second line of defence an operation's path
 * prefix gets: the prefix itself, cleanSchemaName's form, resolveSchemaName's
 * form, and stripListItemMarkers alone, which nested-model qualification
 * applies to a parent name. Empty spellings are dropped so a degenerate
 * prefix cannot match every reserved name.
 */
function prefixSpellings(prefix: string): string[] {
  const spellings = [prefix, cleanSchemaName(prefix), resolveSchemaName(prefix), stripListItemMarkers(prefix)];
  return [...new Set(spellings)].filter((spelling) => spelling.length > 0);
}

function buildWebhook(
  entry: WebhookEntry,
  stem: string,
  components: WebhookComponents,
  inlineModels: Model[],
): Webhook {
  const { name, method, op, params, body, label } = entry;
  // The stem qualifies inline parameter enums the way a service name does
  // for an operation: `PetAdopted` + `X-Event-Type` → `PetAdoptedXEventType`.
  const extract = (location: 'query' | 'header' | 'cookie'): Parameter[] =>
    extractParams(params, location, stem, components.schemas, components.examples, label);
  const headerParams = extract('header');
  const queryParams = extract('query');
  const cookieParams = extract('cookie');

  const { requestBody, requestBodyEncoding } = extractWebhookPayload(body, stem, components.schemas, inlineModels);
  const summary = presentText(op.summary);
  const description = buildDescription(summary, op.description);
  const tags = Array.isArray(op.tags)
    ? op.tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
    : [];
  const security = extractSecurityRequirements(op.security, label);

  return {
    name,
    ...(typeof op.operationId === 'string' && op.operationId !== '' ? { operationId: op.operationId } : {}),
    httpMethod: method,
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(op.deprecated === true ? { deprecated: true } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    headerParams,
    queryParams,
    ...(cookieParams.length > 0 ? { cookieParams } : {}),
    ...(requestBody ? { requestBody } : {}),
    ...(requestBodyEncoding ? { requestBodyEncoding } : {}),
    ...(body?.required === true ? { requestBodyRequired: true } : {}),
    responses: extractWebhookResponses(op.responses),
    ...(security !== undefined ? { security } : {}),
  };
}

/**
 * Type the payload and materialize whatever it declares inline, as the
 * `payload` property of a synthetic object named `stem`. `schemaToTypeRef`
 * names the reference and `extractInlineModelsFromProperties` names the
 * models from the same inputs, so they agree by construction for every shape
 * the field extractor knows: an inline object (`<Stem>Payload`, nested
 * objects under it), a `oneOf`/`anyOf` of inline objects (one model per
 * variant, union kept), an `allOf` merge or `$ref` augmentation, an array or
 * map of any of those, an inline enum, a nullable wrapper around any of them.
 * A body with no schema is a binary or text primitive, as on an operation.
 */
function extractWebhookPayload(
  body: RequestBodyObject | undefined,
  stem: string,
  componentSchemas: Record<string, SchemaObject> | undefined,
  inlineModels: Model[],
): { requestBody?: TypeRef; requestBodyEncoding?: Webhook['requestBodyEncoding'] } {
  if (!body?.content) return {};
  const { encoding, schema } = selectRequestBodyContent(body);
  if (!schema) {
    if (encoding === 'binary') {
      return { requestBody: { kind: 'primitive', type: 'string', format: 'binary' }, requestBodyEncoding: encoding };
    }
    if (encoding === 'text') {
      return { requestBody: { kind: 'primitive', type: 'string' }, requestBodyEncoding: encoding };
    }
    return {};
  }
  const requestBody = schemaToTypeRef(schema, 'payload', stem);
  extractInlineModelsFromProperties({ properties: { payload: schema } }, inlineModels, stem, componentSchemas);
  return { requestBody, requestBodyEncoding: encoding };
}

/**
 * The status codes the sender expects back, in document order. Only
 * three-digit keys are carried: `default` and ranges such as `2XX` name no
 * single code a handler could return. A blank description is omitted.
 */
function extractWebhookResponses(responses: OperationObject['responses']): WebhookResponse[] {
  const result: WebhookResponse[] = [];
  for (const [code, response] of Object.entries(responses ?? {})) {
    if (!/^\d{3}$/.test(code)) continue;
    const description = presentText(isRecord(response) ? (response.description as string | undefined) : undefined);
    result.push({ statusCode: Number(code), ...(description !== undefined ? { description } : {}) });
  }
  return result;
}
