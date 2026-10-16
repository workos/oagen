import { createHash } from 'node:crypto';
import type { Enum, HttpMethod, Model, Parameter, Service, TypeRef, Webhook, WebhookResponse } from '../ir/types.js';
import { collectResponseHeaders, walkTypeRef } from '../ir/types.js';
import { toPascalCase } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { schemaToTypeRef } from './schemas.js';
import { extractInlineModelsFromProperties } from './inline-models.js';
import {
  HTTP_METHODS,
  buildDescription,
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
  responses?: Record<string, Record<string, unknown>>;
  examples?: Record<string, Record<string, unknown>>;
  /** `components.pathItems` (OpenAPI 3.1), the only target a webhook entry's `$ref` may point at. */
  pathItems?: Record<string, Record<string, unknown>>;
}

export interface WebhookExtractionResult {
  /** One entry per (webhook key, HTTP method), in document order. */
  webhooks: Webhook[];
  /** Models materialized from inline payload and parameter schemas, to merge into `ApiSpec.models`. */
  inlineModels: Model[];
}

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
  /** How many methods the entry's path item declares; a second one qualifies a key-derived stem. */
  methodCount: number;
}

/** What one stem mints for a webhook: its typed parameters and payload, and the models behind them. */
interface MintedWebhook {
  headerParams: Parameter[];
  queryParams: Parameter[];
  cookieParams: Parameter[];
  requestBody?: TypeRef;
  requestBodyEncoding?: Webhook['requestBodyEncoding'];
  inlineModels: Model[];
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
 * no path — and is dropped with a warning. A response that is a `$ref` into
 * `components/responses` is followed for its description.
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
 * promoted by `collectInlineEnumsFromWebhooks`. Nothing is flattened. An
 * inline object on a parameter is materialized the same way, under the name
 * `extractParams` references it by (`<Stem>XMeta`).
 *
 * `reservedNames` is every model and enum name already decided — see
 * `collectExistingNames` — so a webhook never mints a name one of them owns.
 */
export function extractWebhooks(
  webhooks: unknown,
  components: WebhookComponents = {},
  reservedNames: Iterable<string> = [],
): WebhookExtractionResult {
  if (webhooks === undefined) return { webhooks: [], inlineModels: [] };
  if (!isRecord(webhooks)) {
    console.warn('[oagen] Warning: Top-level `webhooks` is not an object; ignoring it.');
    return { webhooks: [], inlineModels: [] };
  }

  const entries = collectWebhookEntries(webhooks, components);
  const stems = resolveWebhookModelStems(entries, new Set(reservedNames), components);
  const inlineModels: Model[] = [];
  const result: Webhook[] = [];

  for (const entry of entries) {
    const minted = mintWebhook(entry, stems.get(entry)!, components);
    inlineModels.push(...minted.inlineModels);
    result.push(buildWebhook(entry, minted, components));
  }

  return { webhooks: result, inlineModels };
}

/**
 * Every model and enum name the rest of the parse has decided before webhooks
 * are extracted, for `extractWebhooks` to reserve: each model's name, each
 * enum's name, and every model or enum a model field or an operation refers
 * to (parameters, bodies, responses, errors, pagination envelopes, response
 * headers), inline enums included since their names are already fixed in the
 * references that carry them. A superset is harmless — a referenced name is
 * one that exists — and keeps the check from depending on which pass minted
 * what.
 */
export function collectExistingNames(models: Model[], services: Service[], enums: Enum[]): Set<string> {
  const names = new Set<string>();
  const collect = (ref: TypeRef): void => {
    walkTypeRef(ref, { model: (r) => names.add(r.name), enum: (r) => names.add(r.name) });
  };
  for (const model of models) {
    names.add(model.name);
    for (const field of model.fields) collect(field.type);
  }
  for (const e of enums) names.add(e.name);
  for (const service of services) {
    for (const op of service.operations) {
      for (const param of [
        ...op.pathParams,
        ...op.queryParams,
        ...(op.bodyOwnedQueryParams ?? []),
        ...op.headerParams,
        ...(op.cookieParams ?? []),
      ]) {
        collect(param.type);
      }
      if (op.requestBody) collect(op.requestBody);
      collect(op.response);
      for (const success of op.successResponses ?? []) collect(success.type);
      for (const error of op.errors) if (error.type) collect(error.type);
      if (op.pagination) {
        collect(op.pagination.itemType);
        for (const field of op.pagination.envelopeFields ?? []) collect(field.type);
      }
      for (const header of collectResponseHeaders(op)) collect(header.type);
    }
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten the map into one entry per (key, method), resolving path-item refs
 * and parameter / request-body refs up front so the stem resolution below can
 * mint every entry's names before any stem is decided.
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
    const resolved = resolveComponentRef(ref, 'pathItems', componentPathItems);
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
 * The component a `#/components/<section>/<name>` pointer names, or
 * `undefined` when it points anywhere else or at nothing. The whole pointer
 * is matched, so a ref into another section never resolves off a same-named
 * entry of this one.
 */
function resolveComponentRef(
  ref: string,
  section: 'pathItems' | 'responses',
  components: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const prefix = `#/components/${section}/`;
  if (!ref.startsWith(prefix)) return undefined;
  // JSON Pointer escapes (RFC 6901 §4): `~1` -> `/`, then `~0` -> `~`, in that order.
  const refName = ref.slice(prefix.length).replace(/~1/g, '/').replace(/~0/g, '~');
  return refName === '' ? undefined : components?.[refName];
}

/**
 * Decide the stem every model of each webhook is named from: `<Stem>Payload`
 * for the payload, `<Stem>Payload<Field>` for objects nested in it,
 * `<Const><Stem>Payload` for a const-discriminated variant, `<Stem><Param>`
 * for an inline parameter object or enum.
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
 * Whether a stem collides is decided from the names it actually mints, not
 * from a prefix: every entry is first minted with its plain stem
 * (`mintWebhook`) and the model and inline-enum names that produces —
 * payload, nested objects, union variants with their const or title
 * prefixes, parameter objects, parameter enums, field enums — are collected
 * (`mintedNames`). An entry collides when one of those names is reserved
 * (`collectExistingNames`: every model and enum the components and the
 * operations have decided, the components' own inline field models included)
 * or is also minted by another entry. Two keys that flatten to one stem
 * (`pet_adopted` and `petAdopted`) collide on every name; a `petEvent` union
 * variant pinning `kind: returned` and a webhook keyed `returnedPetEvent`
 * collide on the one name `ReturnedPetEventPayload`; a stem that merely
 * starts with another's (`petAdopted` beside `petAdoptedPayloadPet`) does
 * not collide unless a name coincides. A colliding stem takes the first six
 * hex characters of the SHA-1 of the webhook's key before the method
 * qualifier (`PetAdoptedB4A950`), exactly as an operationId-less operation's
 * path prefix does, and is minted again under it. Both sides of a
 * webhook-to-webhook collision are hashed, since neither key is more
 * canonical than the other. The outcome depends only on the document's keys,
 * operationIds, components and operations, never on their order, and a key
 * that stops colliding returns to its plain stem.
 *
 * A name that does not embed the stem — a title-mapped union variant, which
 * is context-free by design — cannot be moved by the hash; such a clash is
 * left to the model merge, which shares an identical shape and warns about
 * a different one, as it does for operations.
 */
function resolveWebhookModelStems(
  entries: WebhookEntry[],
  reserved: ReadonlySet<string>,
  components: WebhookComponents,
): Map<WebhookEntry, string> {
  const minted = new Map<WebhookEntry, Set<string>>();
  for (const entry of entries) {
    minted.set(entry, mintedNames(mintWebhook(entry, plainStem(entry, ''), components)));
  }

  const stems = new Map<WebhookEntry, string>();
  for (const entry of entries) {
    const names = minted.get(entry)!;
    const taken = [...names].some(
      (name) => reserved.has(name) || entries.some((other) => other !== entry && minted.get(other)!.has(name)),
    );
    stems.set(entry, taken ? plainStem(entry, webhookDisambiguator(entry.name)) : plainStem(entry, ''));
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
 * Type a webhook's parameters and payload under `stem`, materializing every
 * model they reference inline. The parameters go through `extractParams`
 * with the stem as the qualifying context, as a service name qualifies an
 * operation's (`PetAdopted` + `X-Event-Type` → `PetAdoptedXEventType`); a
 * parameter with an inline object (or array of them) is then run through the
 * field extractor as a single synthetic property of the stem, which names
 * the model exactly as `extractParams` referenced it — the pairing response
 * headers already rely on. The payload is typed and materialized as the
 * synthetic `payload` property of the stem for the same reason: for every
 * shape the field extractor knows — an inline object, a `oneOf`/`anyOf` of
 * inline objects, an `allOf` merge or `$ref` augmentation, an array or map of
 * any of those, an inline enum, a nullable wrapper — the reference and the
 * model are named by one code path. A body with no schema is a binary or text
 * primitive, as on an operation.
 */
function mintWebhook(entry: WebhookEntry, stem: string, components: WebhookComponents): MintedWebhook {
  const { params, body, label } = entry;
  const inlineModels: Model[] = [];
  const parent = toPascalCase(stem);
  const extract = (location: 'query' | 'header' | 'cookie'): Parameter[] =>
    extractParams(params, location, stem, components.schemas, components.examples, label);
  const headerParams = extract('header');
  const queryParams = extract('query');
  const cookieParams = extract('cookie');
  for (const param of params) {
    if (!param.schema) continue;
    extractInlineModelsFromProperties(
      { properties: { [param.name]: param.schema } },
      inlineModels,
      parent,
      components.schemas,
    );
  }

  const minted: MintedWebhook = { headerParams, queryParams, cookieParams, inlineModels };
  if (!body?.content) return minted;
  const { encoding, schema } = selectRequestBodyContent(body);
  if (!schema) {
    if (encoding === 'binary') {
      minted.requestBody = { kind: 'primitive', type: 'string', format: 'binary' };
      minted.requestBodyEncoding = encoding;
    } else if (encoding === 'text') {
      minted.requestBody = { kind: 'primitive', type: 'string' };
      minted.requestBodyEncoding = encoding;
    }
    return minted;
  }
  minted.requestBody = schemaToTypeRef(schema, 'payload', stem);
  minted.requestBodyEncoding = encoding;
  extractInlineModelsFromProperties({ properties: { payload: schema } }, inlineModels, stem, components.schemas);
  return minted;
}

/**
 * Every name `mintWebhook` decided: the models it materialized and every
 * inline enum (an enum ref carrying `values`; a `$ref` to a component enum
 * carries none and is a reference, not a minting) in the parameters, the
 * payload, and the materialized models' fields. Component references are
 * deliberately not included: a payload that refers to `AdoptionEvent` names
 * nothing new.
 */
function mintedNames(minted: MintedWebhook): Set<string> {
  const names = new Set<string>();
  const collectEnums = (ref: TypeRef): void => {
    walkTypeRef(ref, {
      enum: (r) => {
        if (r.values) names.add(r.name);
      },
    });
  };
  for (const model of minted.inlineModels) {
    names.add(model.name);
    for (const field of model.fields) collectEnums(field.type);
  }
  for (const param of [...minted.headerParams, ...minted.queryParams, ...minted.cookieParams]) {
    collectEnums(param.type);
  }
  if (minted.requestBody) collectEnums(minted.requestBody);
  return names;
}

function buildWebhook(entry: WebhookEntry, minted: MintedWebhook, components: WebhookComponents): Webhook {
  const { name, method, op, body, label } = entry;
  const { headerParams, queryParams, cookieParams, requestBody, requestBodyEncoding } = minted;
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
    responses: extractWebhookResponses(op.responses, components.responses, label),
    ...(security !== undefined ? { security } : {}),
  };
}

/**
 * The status codes the sender expects back, in document order. Only
 * three-digit keys are carried: `default` and ranges such as `2XX` name no
 * single code a handler could return. A response written as a `$ref` into
 * `components/responses` is followed for its description, chains included; a
 * description written beside the `$ref` (OpenAPI 3.1) wins over the
 * component's. A ref that leads nowhere, or anywhere else, keeps the status
 * code without a description, with a warning. A blank description is omitted.
 */
function extractWebhookResponses(
  responses: OperationObject['responses'],
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  label: string,
): WebhookResponse[] {
  const result: WebhookResponse[] = [];
  for (const [code, raw] of Object.entries(responses ?? {})) {
    if (!/^\d{3}$/.test(code)) continue;
    const description = presentText(resolveResponseDescription(raw, componentResponses, code, label));
    result.push({ statusCode: Number(code), ...(description !== undefined ? { description } : {}) });
  }
  return result;
}

/**
 * The description of a response, following a `components/responses` `$ref`
 * chain with a cycle guard. The outermost description along the chain wins,
 * so a sibling beside a ref overrides what it points at.
 */
function resolveResponseDescription(
  raw: unknown,
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  code: string,
  label: string,
): string | undefined {
  const seenRefs = new Set<string>();
  let description: string | undefined;
  let current: unknown = raw;
  while (isRecord(current)) {
    if (description === undefined && typeof current.description === 'string') description = current.description;
    const ref = current.$ref;
    if (ref === undefined) break;
    if (typeof ref !== 'string' || seenRefs.has(ref)) {
      console.warn(
        `[oagen] Warning: Circular or malformed response $ref for status ${code} in ${label}; keeping the status code only.`,
      );
      break;
    }
    seenRefs.add(ref);
    current = resolveComponentRef(ref, 'responses', componentResponses);
    if (!current) {
      console.warn(
        `[oagen] Warning: Unresolved response $ref "${ref}" for status ${code} in ${label}: ` +
          'no matching entry under components/responses. Keeping the status code only.',
      );
    }
  }
  return description;
}
