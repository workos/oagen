import { createHash } from 'node:crypto';
import type {
  Enum,
  HttpMethod,
  Model,
  Parameter,
  RequestBodyContent,
  Service,
  TypeRef,
  Webhook,
  WebhookResponse,
} from '../ir/types.js';
import { collectModelTypeRefs, collectOperationTypeRefs, collectWebhookTypeRefs, walkTypeRef } from '../ir/types.js';
import { foldParameterName, parameterKey } from '../ir/parameter-key.js';
import { numberedName, toPascalCase } from '../utils/naming.js';
import { mediaTypeNameFragment, mediaTypeNamingOrder } from '../utils/media-type.js';
import type { SchemaObject } from './schemas.js';
import { isComponentModelRef, schemaToTypeRef } from './schemas.js';
import {
  cloneTypeRef,
  extractInlineModelsFromProperties,
  modelFingerprint,
  qualifyInlineModelName,
  type InlineModelBundle,
} from './inline-models.js';
import {
  HTTP_METHODS,
  extractParams,
  extractTags,
  operationIdModelBase,
  parameterSchema,
  presentText,
  requestBodyDescriptionOf,
  resolveOperationDocs,
  resolveParameterRef,
  resolveRequestBodyRef,
  schemalessRequestBodyType,
  schemalessRequestContentType,
  selectRequestBodyContent,
  warnUnreadParameterContent,
  warnUnreadRequestBody,
  type OperationObject,
  type ParameterObject,
  type PathItem,
  type RequestBodyObject,
} from './operations.js';
import { externalDocsEntry } from './external-docs.js';
import { resolvePathItemRef } from './path-item-refs.js';
import { followReference, type SiblingDocs } from './reference-objects.js';
import { classifyResponseKey, warnUnrecognizedResponseKey } from './responses.js';
import { extractSecurityRequirements } from './security.js';
import { warnOnIgnoredCallbacks } from './callbacks.js';

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
  /**
   * Where those models came from: one site per group of entries that share
   * a minting, qualified by the group's stem and owning every reference of
   * every webhook in the group — its payload and its parameters
   * (`collectWebhookTypeRefs`) — so a merge pass that must rename one of the
   * models (a payload variant titled like a component of another shape)
   * repoints exactly those, as it does an operation's (`InlineModelBundle`).
   */
  inlineModelBundles: InlineModelBundle[];
}

/** One (key, method) pair of the `webhooks` map, with its references resolved. */
interface WebhookEntry {
  name: string;
  method: HttpMethod;
  op: OperationObject;
  /**
   * The path item the operation sits on — the entry itself, or the
   * `components/pathItems` item its `$ref` leads to — whose `summary` and
   * `description` apply to the operation (`resolveOperationDocs`).
   */
  pathItem: PathItem;
  /** The webhook's own parameters after path-item-level ones, deduplicated by (in, name). */
  params: ParameterObject[];
  body: RequestBodyObject | undefined;
  /** `webhooks.<name>.<method>`, for diagnostics. */
  label: string;
  /** How many methods the entry's path item declares; a second one qualifies a key-derived stem. */
  methodCount: number;
  /**
   * The operationId the stem is named from: the operation's own, unless a
   * different operation object declares the same one (see
   * `collectWebhookEntries`). Absent, the stem comes from the key.
   */
  stemOperationId?: string;
}

/** What one stem mints for a webhook: its typed parameters and payload, and the models behind them. */
interface MintedWebhook {
  headerParams: Parameter[];
  queryParams: Parameter[];
  cookieParams: Parameter[];
  requestBody?: TypeRef;
  requestBodyEncoding?: Webhook['requestBodyEncoding'];
  requestBodyContentType?: string;
  requestBodyContentTypes?: string[];
  requestBodyContents?: RequestBodyContent[];
  inlineModels: Model[];
  /** Every model and inline-enum name the webhook minted (see `mintSchema`). */
  names: Set<string>;
}

/** The part of a minting a `Webhook` carries: its typed parameters and payload. */
type MintedShape = Pick<
  MintedWebhook,
  | 'headerParams'
  | 'queryParams'
  | 'cookieParams'
  | 'requestBody'
  | 'requestBodyEncoding'
  | 'requestBodyContentType'
  | 'requestBodyContentTypes'
  | 'requestBodyContents'
>;

/**
 * Read the document's top-level `webhooks` map (OpenAPI 3.1) into the IR.
 *
 * Each key names a path item, and each HTTP method on it is one `Webhook`,
 * in document order. The key is kept verbatim as `Webhook.name`. An entry
 * that is a `$ref` into `components/pathItems` is resolved (chains included,
 * with a cycle guard) by `resolvePathItemRef`, the resolver a `paths` entry
 * goes through too; one that points anywhere else, or that cannot be
 * resolved, is warned about and skipped rather than failing the parse, as is
 * an entry that is not an object. A key starting with `x-` is a
 * specification extension, not a webhook, and is stepped over without a
 * warning whatever its value, as `extractOperations` steps over one under
 * `paths`. A `webhooks` value that is not an object at all is warned about
 * and ignored. Nothing is read from `x-webhooks`, the
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
 * `collectExistingNames` — so a webhook never mints a name one of them owns,
 * and `reservedEnumNames` the enums among them (`collectExistingEnumNames`),
 * which no webhook model may take even where the stem cannot move it.
 */
export function extractWebhooks(
  webhooks: unknown,
  components: WebhookComponents = {},
  reservedNames: Iterable<string> = [],
  reservedEnumNames: Iterable<string> = [],
  // Whether text written beside a `$ref` into `components/parameters`,
  // `requestBodies`, `responses` or `examples` overrides the component's
  // (OAS 3.1) or is ignored (OAS 3.0): the document's mode, as the operations
  // read it (`siblingDocsMode`), applied to every Reference Object here.
  siblingDocs: SiblingDocs = 'override',
): WebhookExtractionResult {
  if (webhooks === undefined) return { webhooks: [], inlineModels: [], inlineModelBundles: [] };
  if (!isRecord(webhooks)) {
    console.warn('[oagen] Warning: Top-level `webhooks` is not an object; ignoring it.');
    return { webhooks: [], inlineModels: [], inlineModelBundles: [] };
  }

  const entries = collectWebhookEntries(webhooks, components, siblingDocs);
  const { groups, groupOf } = groupEntries(entries);
  const reserved: ReservedNames = { all: new Set(reservedNames), enums: new Set(reservedEnumNames) };
  const stems = resolveWebhookModelStems(groups, reserved, components, siblingDocs);
  const inlineModels: Model[] = [];
  const mintedByGroup = new Map<WebhookGroup, MintedWebhook>();
  for (const group of groups) {
    const minted = mintWebhook(group.owner, stems.get(group)!, components, reserved, siblingDocs);
    inlineModels.push(...minted.inlineModels);
    mintedByGroup.set(group, minted);
  }

  // Document order of the entries, not of the groups: a shared operation's
  // second key keeps its own place. A group's owner takes the minted
  // parameters and payload as they are; every other member gets its own
  // copy, so no two webhooks share IR nodes — a copy that keeps each
  // reference's provenance (`cloneMintedShape`), so a `$ref` to a component
  // stays one on every member when a merge pass renames the group's models.
  const result: Webhook[] = [];
  const webhooksByGroup = new Map<WebhookGroup, Webhook[]>();
  for (const entry of entries) {
    const group = groupOf.get(entry)!;
    const minted = mintedByGroup.get(group)!;
    const shape: MintedShape = {
      headerParams: minted.headerParams,
      queryParams: minted.queryParams,
      cookieParams: minted.cookieParams,
      requestBody: minted.requestBody,
      requestBodyEncoding: minted.requestBodyEncoding,
      requestBodyContentType: minted.requestBodyContentType,
      requestBodyContentTypes: minted.requestBodyContentTypes,
      requestBodyContents: minted.requestBodyContents,
    };
    const webhook = buildWebhook(
      entry,
      entry === group.owner ? shape : cloneMintedShape(shape),
      components,
      siblingDocs,
    );
    result.push(webhook);
    webhooksByGroup.set(group, [...(webhooksByGroup.get(group) ?? []), webhook]);
  }

  // Each group's models are one site: every member's references, the
  // copies included, so a rename reaches every webhook that shares the
  // minting and nothing else.
  const inlineModelBundles: InlineModelBundle[] = [];
  for (const group of groups) {
    const minted = mintedByGroup.get(group)!;
    if (minted.inlineModels.length === 0) continue;
    inlineModelBundles.push({
      qualifier: toPascalCase(stems.get(group)!),
      roots: (webhooksByGroup.get(group) ?? []).flatMap((webhook) => collectWebhookTypeRefs(webhook)),
      models: minted.inlineModels,
    });
  }

  return { webhooks: result, inlineModels, inlineModelBundles };
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
  return collectExistingNamesByKind(models, services, enums).all;
}

/**
 * The enum names among `collectExistingNames`: each enum's name, and every
 * enum a model field or an operation refers to, inline enums included. A
 * webhook model may never take one of these (`mintSchema`): a model and an
 * enum under one name would reach an emitter as one public symbol.
 */
export function collectExistingEnumNames(models: Model[], services: Service[], enums: Enum[]): Set<string> {
  return collectExistingNamesByKind(models, services, enums).enums;
}

/** The names a webhook's minting must step around: every decided name, and among them the enums'. */
interface ReservedNames {
  all: ReadonlySet<string>;
  enums: ReadonlySet<string>;
}

function collectExistingNamesByKind(
  models: Model[],
  services: Service[],
  enums: Enum[],
): { all: Set<string>; enums: Set<string> } {
  const names = new Set<string>();
  const enumNames = new Set<string>();
  const collect = (ref: TypeRef): void => {
    walkTypeRef(ref, {
      model: (r) => names.add(r.name),
      enum: (r) => {
        names.add(r.name);
        enumNames.add(r.name);
      },
    });
  };
  for (const model of models) {
    names.add(model.name);
    for (const field of model.fields) collect(field.type);
  }
  for (const e of enums) {
    names.add(e.name);
    enumNames.add(e.name);
  }
  for (const service of services) {
    for (const op of service.operations) for (const ref of collectOperationTypeRefs(op)) collect(ref);
  }
  return { all: names, enums: enumNames };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten the map into one entry per (key, method), resolving path-item refs
 * and parameter / request-body refs up front so the stem resolution below can
 * mint every entry's names before any stem is decided.
 */
function collectWebhookEntries(
  webhooks: Record<string, unknown>,
  components: WebhookComponents,
  siblingDocs: SiblingDocs,
): WebhookEntry[] {
  const entries: WebhookEntry[] = [];
  for (const [name, raw] of Object.entries(webhooks)) {
    // A specification extension, never a webhook: stepped over whatever its
    // value, as `resolvePathItems` steps over one under `paths`.
    if (name.startsWith('x-')) continue;
    // The same resolver `extractOperations` reads a `paths` entry through, so
    // a `$ref` into `components/pathItems` is followed the same way here.
    const pathItem = resolvePathItemRef(raw, components.pathItems, { kind: 'webhook', key: name }) as
      | PathItem
      | undefined;
    if (!pathItem) continue;
    // The path item's own key order, as the IR promises document order; an
    // entry declaring `put` before `post` keeps `put` first.
    const methods = (Object.keys(pathItem) as string[]).filter(
      (key): key is HttpMethod =>
        (HTTP_METHODS as readonly string[]).includes(key) && isRecord(pathItem[key as HttpMethod]),
    );
    for (const method of methods) {
      const op = pathItem[method] as OperationObject;
      const label = `webhooks.${name}.${method}`;
      warnOnIgnoredCallbacks(op.callbacks, label);
      // Same precedence as buildOperation: an operation-level parameter replaces
      // a path-item-level one of the same identity (`parameterKey`: location
      // and name, a header's name case-folded), in the path-level position.
      const paramsByIdentity = new Map<string, ParameterObject>();
      for (const rawParam of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
        const param = resolveParameterRef(rawParam, components.parameters, label, siblingDocs);
        paramsByIdentity.set(parameterKey(param.in, param.name), param);
      }
      const params: ParameterObject[] = [];
      for (const param of paramsByIdentity.values()) {
        if (param.in === 'path') {
          console.warn(
            `[oagen] Warning: Parameter "${param.name}" (in: path) on ${label} ignored: a webhook has no path to place it in.`,
          );
          continue;
        }
        // Reported here, once per webhook parameter: the mint below runs
        // twice for each webhook, so it must not report.
        warnUnreadParameterContent(param, `Parameter "${param.name}" (in: ${param.in}) on ${label}`);
        params.push(param);
      }
      const body = resolveRequestBodyRef(op.requestBody, components.requestBodies, label, siblingDocs);
      // Reported here, once per webhook: the mint below runs twice for each
      // (`resolveWebhookModelStems`, then the build), so it must not report.
      warnUnreadRequestBody(body, label);
      entries.push({ name, method, op, pathItem, params, body, label, methodCount: methods.length });
    }
  }

  // An operationId names the stem only when exactly one operation object
  // declares it. Two keys that `$ref` one path item resolve to the same
  // object and are fine — they will share a stem (see `groupEntries`); two
  // different objects declaring one id is a document error OpenAPI forbids,
  // so neither is named from it, with a warning.
  const objectsByOperationId = new Map<string, Set<OperationObject>>();
  for (const entry of entries) {
    const id = entry.op.operationId;
    if (typeof id !== 'string' || id === '') continue;
    const objects = objectsByOperationId.get(id) ?? new Set<OperationObject>();
    objects.add(entry.op);
    objectsByOperationId.set(id, objects);
  }
  for (const [id, objects] of objectsByOperationId) {
    const declaring = entries.filter((entry) => entry.op.operationId === id);
    if (objects.size === 1) {
      for (const entry of declaring) entry.stemOperationId = id;
      continue;
    }
    console.warn(
      `[oagen] Warning: operationId "${id}" is declared by more than one webhook operation ` +
        `(${declaring.map((entry) => entry.label).join(', ')}); naming their models from the webhook keys instead.`,
    );
  }
  return entries;
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
 * (`PetUpdatedPut`) so the bodies never share a model. An operationId is
 * unique per document and needs no qualifier, with one caveat: two keys that
 * `$ref` the same `components/pathItems` entry resolve to one operation
 * object and so carry one operationId. Sharing a path item between events is
 * what that section is for, so such entries form one group (`groupEntries`)
 * that mints once and shares its stem and its models (`SharedPayload`)
 * rather than colliding with each other; each key is still its own
 * `Webhook`. An operationId that two different operation objects declare —
 * which no valid document does — is ignored for naming, with a warning, and
 * those webhooks take their key-derived stems (`collectWebhookEntries`). A
 * key that PascalCases to nothing, or to something starting with a digit,
 * gets `Webhook` in front.
 *
 * Whether a stem collides is decided from the names it actually mints, not
 * from a prefix: every group is first minted with its plain stem
 * (`mintWebhook`) and the model and inline-enum names that produces —
 * payload, nested objects, union variants with their const or title
 * prefixes, parameter objects, parameter enums, field enums — are collected
 * (`MintedWebhook.names`). A group collides when one of those names is
 * reserved (`collectExistingNames`: every model and enum the components and
 * the operations have decided, the components' own inline field models
 * included) or is also minted by another group. Two keys that flatten to
 * one stem (`pet_adopted` and `petAdopted`) collide on every name; a
 * `petEvent` union variant pinning `kind: returned` and a webhook keyed
 * `returnedPetEvent` collide on the one name `ReturnedPetEventPayload`; a
 * stem that merely starts with another's (`petAdopted` beside
 * `petAdoptedPayloadPet`) does not collide unless a name coincides. A
 * colliding stem takes the first six hex characters of the SHA-1 of the
 * webhook's operationId when it is named from one and of its key otherwise,
 * before the method qualifier (`PetAdoptedB4A950`), exactly as an
 * operationId-less operation's path prefix does, and is minted again under
 * it. Both sides of a webhook-to-webhook collision are hashed, since neither
 * key is more canonical than the other. The outcome depends only on the
 * document's keys, operationIds, components and operations, never on their
 * order, and a key that stops colliding returns to its plain stem.
 *
 * A name that does not embed the stem — a title-mapped union variant, which
 * is context-free by design — cannot be moved by the hash, so a clash on it
 * alone leaves the stem plain. One named like a decided enum is renamed
 * under the payload's root instead (`PetAdoptedPayloadCircle`, see
 * `mintSchema`), since a model and an enum under one name would reach an
 * emitter as one symbol; one named like a decided model, or like another
 * webhook's variant, is left to the model merge, which shares a component's
 * name when the component admits the shape and renames the variant under
 * the webhook's stem otherwise (`PetAdoptedComp`), as it does for
 * operations.
 */
function resolveWebhookModelStems(
  groups: WebhookGroup[],
  reserved: ReservedNames,
  components: WebhookComponents,
  siblingDocs: SiblingDocs,
): Map<WebhookGroup, string> {
  const minted = new Map<WebhookGroup, Set<string>>();
  for (const group of groups) {
    minted.set(group, mintWebhook(group.owner, plainStem(group.owner, ''), components, reserved, siblingDocs).names);
  }

  const stems = new Map<WebhookGroup, string>();
  for (const group of groups) {
    const names = minted.get(group)!;
    const { owner } = group;
    // Only a clashing name the hash would move — one that embeds the stem —
    // moves the stem.
    const stem = toPascalCase(plainStem(owner, ''));
    const taken = [...names].some(
      (name) =>
        name.includes(stem) &&
        (reserved.all.has(name) || groups.some((other) => other !== group && minted.get(other)!.has(name))),
    );
    const disambiguator = taken ? webhookDisambiguator(owner.stemOperationId ?? owner.name) : '';
    stems.set(group, plainStem(owner, disambiguator));
  }
  return stems;
}

/**
 * Entries that mint together. Those resolving to one operation object and
 * named from its operationId share a group: `owner` is the first of them in
 * document order, and its parameters and body stand for the group's, since
 * every member read the same path item. Every other entry is a group of its
 * own.
 */
interface WebhookGroup {
  owner: WebhookEntry;
  entries: WebhookEntry[];
}

function groupEntries(entries: WebhookEntry[]): { groups: WebhookGroup[]; groupOf: Map<WebhookEntry, WebhookGroup> } {
  const groups: WebhookGroup[] = [];
  const groupOf = new Map<WebhookEntry, WebhookGroup>();
  const byOperation = new Map<OperationObject, WebhookGroup>();
  for (const entry of entries) {
    const shared = entry.stemOperationId !== undefined;
    let group = shared ? byOperation.get(entry.op) : undefined;
    if (!group) {
      group = { owner: entry, entries: [] };
      groups.push(group);
      if (shared) byOperation.set(entry.op, group);
    }
    group.entries.push(entry);
    groupOf.set(entry, group);
  }
  return { groups, groupOf };
}

/** The stem of `entry` with `disambiguator` (possibly empty) inserted before the method qualifier. */
function plainStem(entry: WebhookEntry, disambiguator: string): string {
  const operationId = entry.stemOperationId;
  const method = !operationId && entry.methodCount > 1 ? entry.method : '';
  const base = operationId ? operationIdModelBase(operationId) : toPascalCase(entry.name);
  // `_` separators guarantee a word boundary on each side of the disambiguator
  // and the method, whatever the base ends with; splitWords drops them, so
  // the disambiguator is the suffix numberedName gives the base: a hash that
  // starts with a digit is set off from a base that ends in one as a number
  // is (`PetV2No2780A4`), as an operation's path prefix sets it off.
  const hash = numberedName(base, disambiguator).slice(base.length);
  const stem = toPascalCase([base, hash, method].filter(Boolean).join('_'));
  if (stem === '') return 'Webhook';
  return /^\d/.test(stem) ? `Webhook${stem}` : stem;
}

/** The first six hex characters of the SHA-1 of a webhook's key. */
function webhookDisambiguator(name: string): string {
  return createHash('sha1').update(name).digest('hex').slice(0, 6);
}

/**
 * Type a webhook's parameters and payload under `stem`, materializing every
 * model they reference inline, in one namespace per webhook.
 *
 * The payload goes first, as the synthetic `payload` property of the stem
 * (`<Stem>Payload`, nested objects under it), through the same
 * `schemaToTypeRef` / `extractInlineModelsFromProperties` pair that names
 * component fields and response unions, so for every shape the field
 * extractor knows — an inline object, a `oneOf`/`anyOf` of inline objects, an
 * `allOf` merge or `$ref` augmentation, an array or map of any of those, an
 * inline enum, a nullable wrapper — the reference and the model are named by
 * one code path. A body with no schema is a binary or text primitive, as on
 * an operation.
 *
 * Each parameter then goes through `extractParams` with the stem as the
 * qualifying context, as a service name qualifies an operation's
 * (`PetAdopted` + `X-Event-Type` → `PetAdoptedXEventType`), and one whose
 * schema mints anything inline — an object, an array of them, an enum — is
 * run through the field extractor as a single synthetic property of the
 * stem, which names the model exactly as `extractParams` referenced it, the
 * pairing response headers already rely on. The property is the parameter's
 * own name unless a name it would mint is already taken by the payload or an
 * earlier parameter of this webhook: a query parameter named `payload` would
 * mint the body's `<Stem>Payload`, one named `payload_pet` the body's nested
 * `<Stem>PayloadPet`, and a header `X-Meta` beside a query `x_meta` would
 * mint `<Stem>XMeta` twice. Such a parameter is typed and minted under its
 * location-qualified name instead (`query_payload` → `<Stem>QueryPayload`),
 * then a numbered one (`<Stem>QueryPayload2`, …), the first that takes
 * nothing already minted, and its reference follows (see `mintParameter`).
 * Parameters are visited in document order, so the outcome depends only on
 * the document. `names` carries everything the webhook minted, for the stem
 * decision in `resolveWebhookModelStems`.
 */
function mintWebhook(
  entry: WebhookEntry,
  stem: string,
  components: WebhookComponents,
  reserved: ReservedNames,
  siblingDocs: SiblingDocs,
): MintedWebhook {
  const { params, body, label } = entry;
  const parent = toPascalCase(stem);
  const inlineModels: Model[] = [];
  const names = new Set<string>();
  const extract = (location: 'query' | 'header' | 'cookie'): Parameter[] =>
    extractParams(params, location, stem, components.schemas, components.examples, label, siblingDocs);
  const minted: MintedWebhook = {
    headerParams: extract('header'),
    queryParams: extract('query'),
    cookieParams: extract('cookie'),
    inlineModels,
    names,
  };

  const payload = mintPayload(body, stem, components.schemas, reserved);
  if (payload) {
    minted.requestBody = payload.ref;
    minted.requestBodyEncoding = payload.encoding;
    minted.requestBodyContentType = payload.contentType;
    minted.requestBodyContentTypes = payload.contentTypes;
    minted.requestBodyContents = payload.contents;
    inlineModels.push(...payload.models);
    for (const name of payload.names) names.add(name);
  }

  // Each raw parameter and the IR parameter `extractParams` typed from it,
  // paired on the identity every parameter lookup uses (`parameterKey`).
  const typed = new Map<string, Parameter>();
  for (const [location, list] of [
    ['header', minted.headerParams],
    ['query', minted.queryParams],
    ['cookie', minted.cookieParams],
  ] as const) {
    for (const param of list) typed.set(parameterKey(location, param.name), param);
  }
  for (const param of params) {
    const ir = typed.get(parameterKey(param.in, param.name));
    // The schema `extractParams` typed the parameter from: `schema`, else
    // the picked `content` entry's (`parameterTyping`).
    const schema = parameterSchema(param);
    if (!ir || !schema) continue;
    const { ref, models, names: own } = mintParameter(param, schema, parent, names, components.schemas, reserved);
    // `extractParams` typed the parameter from its schema alone; the minted
    // reference is the one whose models exist — it differs when the parameter
    // moved to a qualified property, and when a variant was renamed past a
    // decided enum (`mintSchema`) under the parameter's own name — so it
    // always replaces the extracted type, variants and discriminator mapping
    // included, whether or not the property name changed.
    ir.type = ref;
    inlineModels.push(...models);
    for (const name of own) names.add(name);
  }
  return minted;
}

/**
 * A copy of a minted shape for a second member of a group, carrying every
 * field the shape has: the fields that hold type references — the
 * parameters, the payload, the content entries — are copied through
 * `cloneTypeRef`, so each reference keeps the marks the merge passes read (a
 * `$ref` to a component, an inherited reference, an inline enum's members),
 * and each reference is cloned once, so a content entry whose `type` is the
 * payload's own reference shares the copy as it shared the original; every
 * other field (the encoding, the content type and its list, anything added
 * to the shape later) is copied structurally, present or absent exactly as
 * on the original. A field that comes to hold a type reference must join the
 * first group.
 */
function cloneMintedShape(shape: MintedShape): MintedShape {
  const clones = new Map<TypeRef, TypeRef>();
  const clone = (ref: TypeRef): TypeRef => {
    let copy = clones.get(ref);
    if (!copy) clones.set(ref, (copy = cloneTypeRef(ref)));
    return copy;
  };
  const cloneParameter = ({ type, ...rest }: Parameter): Parameter => ({ ...structuredClone(rest), type: clone(type) });
  const { headerParams, queryParams, cookieParams, requestBody, requestBodyContents, ...rest } = shape;
  return {
    ...structuredClone(rest),
    headerParams: headerParams.map(cloneParameter),
    queryParams: queryParams.map(cloneParameter),
    cookieParams: cookieParams.map(cloneParameter),
    ...(requestBody ? { requestBody: clone(requestBody) } : {}),
    ...(requestBodyContents
      ? {
          requestBodyContents: requestBodyContents.map(({ type, ...entry }) => ({
            ...structuredClone(entry),
            type: clone(type),
          })),
        }
      : {}),
  };
}

/** What one schema minted under one synthetic property: its reference, its models, and every name among them. */
interface MintedSchema {
  ref: TypeRef;
  models: Model[];
  names: Set<string>;
}

/** What a webhook's body mints: the picked payload's reference and encoding, every media type with its type, and the models behind them. */
interface MintedPayload {
  /** The picked entry's type (`Webhook.requestBody`); absent when no media type is read. */
  ref?: TypeRef;
  encoding?: Webhook['requestBodyEncoding'];
  /** The picked entry's essence (`Webhook.requestBodyContentType`); set exactly when `ref` is. */
  contentType?: string;
  contentTypes: string[];
  contents: RequestBodyContent[];
  models: Model[];
  names: Set<string>;
}

/**
 * The payload typed and materialized as the `payload` property of `stem`,
 * read from the content entry the operation body pick chooses
 * (`selectRequestBodyContent`, by media type essence), plus one entry per
 * media type the body declares, as `Operation.requestBodyContents` carries
 * them: the picked entry shares `ref`; every other entry with a schema is
 * typed and materialized as the `<MediaType>Payload` property of the stem
 * (`PetAdoptedTextCsvPayload`, named the way the body's own
 * `<Stem>Payload` is), and one without is typed as
 * `schemalessRequestContentType` types it. `undefined` when the body
 * declares no media type at all. A body none of whose media types is read
 * as `ref` is reported where the webhook's entry is built
 * (`warnUnreadRequestBody`), not here: the mint runs twice per webhook and
 * the warning fires once.
 */
function mintPayload(
  body: RequestBodyObject | undefined,
  stem: string,
  componentSchemas: Record<string, SchemaObject> | undefined,
  reserved: ReservedNames,
): MintedPayload | undefined {
  const content = body?.content;
  if (!content) return undefined;
  const contentTypes = Object.keys(content);
  if (contentTypes.length === 0) return undefined;
  const minted: MintedPayload = { contentTypes, contents: [], models: [], names: new Set() };
  const absorb = ({ ref, models, names }: MintedSchema): TypeRef => {
    minted.models.push(...models);
    for (const name of names) minted.names.add(name);
    return ref;
  };

  const selected = selectRequestBodyContent(body);
  if (selected) {
    minted.encoding = selected.encoding;
    minted.contentType = selected.essence;
    // Only a binary or text pick comes without a schema; it is a primitive.
    minted.ref = selected.schema
      ? absorb(mintSchema(selected.schema, 'payload', stem, componentSchemas, reserved))
      : schemalessRequestBodyType(selected.encoding);
  }
  // Minted — and so named — in naming order; listed as written.
  const types = new Map<string, TypeRef>();
  for (const contentType of mediaTypeNamingOrder(contentTypes)) {
    const schema = content[contentType]?.schema;
    const type =
      selected && contentType === selected.contentType && minted.ref
        ? minted.ref
        : schema
          ? absorb(mintSecondaryPayload(schema, contentType, contentTypes, stem, minted, componentSchemas, reserved))
          : schemalessRequestContentType(contentType);
    types.set(contentType, type);
  }
  for (const contentType of contentTypes) minted.contents.push({ contentType, type: types.get(contentType)! });
  return minted;
}

/**
 * A secondary payload entry typed and materialized under the first
 * `<Fragment>Payload` property whose minted names are free of everything the
 * payload has minted so far — `<Fragment>Payload`, then `<Fragment>Payload2`,
 * `…Payload3`, … — the fragment coming from the media type's essence and,
 * when another key of the same essence sits beside it, the parameters
 * `oagen diff` compares, or a `charset` when nothing else tells them apart
 * (`mediaTypeNameFragment`), so `application/xml` and `APPLICATION/XML;
 * charset=utf-8` take `…ApplicationXmlPayload` and
 * `…ApplicationXmlCharsetPayload` before any candidate is tried; entries
 * still left with one fragment are minted in `mediaTypeNamingOrder`. A
 * candidate whose names are all taken by models of the very shape this entry
 * mints shares them and mints nothing, as the operation registry shares an
 * identical shape; a name taken by a different shape (`application/xml` and
 * `APPLICATION/XML` with other fields) steps on, so no two entries of one
 * payload ever point at a model with the other's fields. When a candidate
 * changes none of the clashing names (a title-mapped variant, which embeds
 * no property), no candidate can clear them: the earliest trial is kept,
 * under `<Fragment>Payload`, and the clash left to the model merge, as
 * `mintParameter` does.
 */
function mintSecondaryPayload(
  schema: SchemaObject,
  contentType: string,
  siblings: readonly string[],
  stem: string,
  minted: MintedPayload,
  componentSchemas: Record<string, SchemaObject> | undefined,
  reserved: ReservedNames,
): MintedSchema {
  const fragment = mediaTypeNameFragment(contentType, siblings);
  const own = new Map(minted.models.map((model) => [model.name, model]));
  let previous: { trial: MintedSchema; clashing: string } | undefined;
  for (let attempt = 0; ; attempt++) {
    const property = attempt === 0 ? `${fragment}Payload` : `${fragment}Payload${attempt + 1}`;
    const trial = mintSchema(schema, property, stem, componentSchemas, reserved);
    const taken = [...trial.names].filter((name) => minted.names.has(name));
    if (taken.length === 0) return trial;
    const sharesShape =
      taken.length === trial.names.size &&
      trial.models.every((model) => {
        const owner = own.get(model.name);
        return owner !== undefined && modelFingerprint(owner) === modelFingerprint(model);
      });
    if (sharesShape) return { ref: trial.ref, models: [], names: new Set() };
    // Judged on the clashing names alone: a name that embeds the property (a
    // variant renamed past a decided enum) changes with every candidate.
    const clashing = taken.sort().join('\n');
    if (previous !== undefined && previous.clashing === clashing) return previous.trial;
    if (attempt >= MAX_PARAMETER_PROPERTY_ATTEMPTS) return trial;
    previous = { trial, clashing };
  }
}

/**
 * A parameter's schema typed and materialized under the first synthetic
 * property whose minted names are all free: the parameter's own name, then
 * `<in>_<name>`, then that numbered by numberedName (`query_payload2`,
 * `query_payload3`, …; `query_v2No2` for a name that ends in a digit, which
 * an `_` before the number would not set off once PascalCased). A schema that
 * mints nothing (a primitive, a `$ref`) keeps the parameter's name at once.
 * When a candidate changes none of the clashing names — they do not embed
 * the property, as a title-mapped union variant does not — no candidate can
 * avoid the clash, so the earliest trial is kept, under the parameter's own
 * name, and the clash is left to the model merge, as for operations;
 * `MAX_PARAMETER_PROPERTY_ATTEMPTS` is a backstop behind that rule. The
 * caller always takes the returned reference, whether or not the property
 * moved: a variant renamed past a decided enum (`PetAdoptedFilterCircle`,
 * see `mintSchema`) is referenced only by the minted type.
 */
function mintParameter(
  param: ParameterObject,
  schema: SchemaObject,
  parent: string,
  taken: ReadonlySet<string>,
  componentSchemas: Record<string, SchemaObject> | undefined,
  reserved: ReservedNames,
): MintedSchema {
  let previous: { minted: MintedSchema; clashing: string } | undefined;
  // The name the models derive from is the one `extractParams` typed the
  // parameter under — a header's lower-cased (`foldParameterName`) — so the
  // reference and the models agree, and neither moves with the header's case.
  const stem = foldParameterName(param.in, param.name);
  for (let attempt = 0; ; attempt++) {
    const property =
      attempt === 0 ? stem : attempt === 1 ? `${param.in}_${stem}` : numberedName(`${param.in}_${stem}`, attempt);
    const minted = mintSchema(schema, property, parent, componentSchemas, reserved);
    const clashing = [...minted.names]
      .filter((name) => taken.has(name))
      .sort()
      .join('\n');
    if (clashing === '' || attempt >= MAX_PARAMETER_PROPERTY_ATTEMPTS) return minted;
    // The clash did not move with the property: what clashes are names that
    // do not embed it (a title-mapped variant), which no candidate can clear
    // — keep the earliest trial, under the parameter's own name, and leave
    // the clash to the model merge. Judged on the clashing names alone, since
    // a name that does embed the property (a variant renamed past a decided
    // enum, `PetAdoptedXShapeCircle`) changes with every candidate.
    if (previous !== undefined && previous.clashing === clashing) return previous.minted;
    previous = { minted, clashing };
  }
}

/** Hard cap on the properties `mintParameter` tries; the no-progress rule stops it long before in practice. */
const MAX_PARAMETER_PROPERTY_ATTEMPTS = 64;

/**
 * Type `schema` as the synthetic property `property` of `parent` and
 * materialize what it declares inline, collecting every name that minted:
 * the models, and every inline enum (an enum ref carrying `values`; a `$ref`
 * to a component enum carries none and is a reference, not a minting) in the
 * reference and in the models' fields. Component references are deliberately
 * not names: a payload that refers to `AdoptionEvent` names nothing new.
 * A model minted under a name among `reserved.enums` — a title-mapped union
 * variant `Circle` beside a component enum `Circle`, which a property of the
 * same payload may reference — is renamed under the minted root
 * (`PetAdoptedPayloadCircle`; numbered when that is taken too, by anything
 * in `reserved.all` or minted here) with every reference among the models
 * and in the returned type rewritten, as `materializeInlineSchema` renames
 * one under a response body's root; an explicit `$ref` to a component model
 * of the name is never touched, and the enum reference is an `EnumRef`,
 * which no rename reaches. A model and an enum under one name would reach an
 * emitter as one public symbol. A variant named like a decided MODEL is left
 * to the stem hash and the model merge, as before: the names minted here are
 * not reserved from the extractor, so a stem-embedded clash still hashes the
 * stem and a context-free one still reaches the merge.
 */
function mintSchema(
  schema: SchemaObject,
  property: string,
  parent: string,
  componentSchemas: Record<string, SchemaObject> | undefined,
  reserved: ReservedNames,
): MintedSchema {
  const models: Model[] = [];
  extractInlineModelsFromProperties({ properties: { [property]: schema } }, models, parent, componentSchemas);
  const ref = schemaToTypeRef(schema, property, parent);
  const root = qualifyInlineModelName(toPascalCase(property), parent);
  const taken = new Set([...reserved.all, ...models.map((model) => model.name)]);
  for (const model of models) {
    if (!reserved.enums.has(model.name)) continue;
    const from = model.name;
    let to = `${root}${from}`;
    for (let n = 2; taken.has(to); n++) to = numberedName(`${root}${from}`, n);
    taken.add(to);
    model.name = to;
    for (const other of models) {
      for (const typeRef of collectModelTypeRefs(other)) repointMintedRefs(typeRef, from, to);
    }
    repointMintedRefs(ref, from, to);
  }
  const names = new Set<string>();
  const collectEnums = (typeRef: TypeRef): void => {
    walkTypeRef(typeRef, {
      enum: (r) => {
        if (r.values) names.add(r.name);
      },
    });
  };
  for (const model of models) {
    names.add(model.name);
    for (const field of model.fields) collectEnums(field.type);
  }
  collectEnums(ref);
  return { ref, models, names };
}

/**
 * Repoint every reference to the minted model `from` within `ref` to `to`,
 * an explicit `$ref` to a component of that name excepted
 * (`isComponentModelRef`); a discriminator mapping naming the model follows.
 */
function repointMintedRefs(ref: TypeRef, from: string, to: string): void {
  switch (ref.kind) {
    case 'model':
      if (ref.name === from && !isComponentModelRef(ref)) (ref as { name: string }).name = to;
      return;
    case 'array':
      repointMintedRefs(ref.items, from, to);
      return;
    case 'nullable':
      repointMintedRefs(ref.inner, from, to);
      return;
    case 'map':
      repointMintedRefs(ref.valueType, from, to);
      if (ref.keyType) repointMintedRefs(ref.keyType, from, to);
      return;
    case 'union':
      for (const variant of ref.variants) repointMintedRefs(variant, from, to);
      for (const [value, target] of Object.entries(ref.discriminator?.mapping ?? {})) {
        if (target === from) ref.discriminator!.mapping[value] = to;
      }
      return;
    default:
      return;
  }
}

function buildWebhook(
  entry: WebhookEntry,
  minted: MintedShape,
  components: WebhookComponents,
  siblingDocs: SiblingDocs,
): Webhook {
  const { name, method, op, pathItem, body, label } = entry;
  const {
    headerParams,
    queryParams,
    cookieParams,
    requestBody,
    requestBodyEncoding,
    requestBodyContentType,
    requestBodyContentTypes,
    requestBodyContents,
  } = minted;
  // Read as an operation's are: the operation's own `summary` and
  // `description`, or the path item's for each it declares none for.
  const { summary, description } = resolveOperationDocs(op, pathItem);
  const tags = extractTags(op.tags);
  const security = extractSecurityRequirements(op.security, label);
  // The payload's doc text, read as an operation's body's is: the Request
  // Body Object's own, else its picked schema's (`requestBodyDescriptionOf`).
  const requestBodyDescription = requestBodyDescriptionOf(body, selectRequestBodyContent(body));

  return {
    name,
    ...(typeof op.operationId === 'string' && op.operationId !== '' ? { operationId: op.operationId } : {}),
    httpMethod: method,
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
    // The operation's own link, present only when usable, as on an operation.
    // A Path Item Object has no `externalDocs` field, so there is no path-item
    // level to fall back to.
    ...externalDocsEntry(op.externalDocs),
    ...(op.deprecated === true ? { deprecated: true } : {}),
    ...(tags !== undefined ? { tags } : {}),
    headerParams,
    queryParams,
    ...(cookieParams.length > 0 ? { cookieParams } : {}),
    ...(requestBody ? { requestBody } : {}),
    ...(requestBodyEncoding ? { requestBodyEncoding } : {}),
    ...(requestBodyContentType ? { requestBodyContentType } : {}),
    // Set only when the body declares a media type, as an operation's flag is.
    ...(requestBodyContentTypes && body?.required === true ? { requestBodyRequired: true } : {}),
    ...(requestBodyDescription !== undefined ? { requestBodyDescription } : {}),
    // Every media type the body declares, present only when there is one, as on an operation.
    ...(requestBodyContentTypes ? { requestBodyContentTypes, requestBodyContents } : {}),
    responses: extractWebhookResponses(op.responses, components.responses, label, siblingDocs),
    ...(security !== undefined ? { security } : {}),
  };
}

/**
 * The status codes the sender expects back, in document order. Only status
 * code keys (three digits, 100–599, as `classifyResponseKey` decides) are
 * carried: `default` and ranges such as `2XX` name no single code a handler
 * could return, and an `x-` key is a specification extension, so those are
 * skipped silently; a key OpenAPI does not define (`error`, `6XX`, `600`) is
 * warned about and ignored, as on an operation. A response written as a
 * `$ref` into `components/responses` is followed for its description, chains
 * included; a description written beside the `$ref` wins over the
 * component's under `siblingDocs: 'override'` (OpenAPI 3.1) and is ignored
 * under `'ignore'` (3.0), as beside every Reference Object
 * (`followReference`). A ref that leads nowhere, or anywhere else, keeps the
 * status code without a description, with a warning. A blank description is
 * omitted.
 */
function extractWebhookResponses(
  responses: OperationObject['responses'],
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  label: string,
  siblingDocs: SiblingDocs,
): WebhookResponse[] {
  const result: WebhookResponse[] = [];
  for (const [code, raw] of Object.entries(responses ?? {})) {
    const responseKey = classifyResponseKey(code);
    if (responseKey.kind === 'unrecognized') warnUnrecognizedResponseKey(code, label);
    if (responseKey.kind !== 'status') continue;
    const description = presentText(resolveResponseDescription(raw, componentResponses, code, label, siblingDocs));
    result.push({ statusCode: responseKey.code, ...(description !== undefined ? { description } : {}) });
  }
  return result;
}

/**
 * The description of a response, following a `components/responses` `$ref`
 * chain through `followReference`, the walk every Reference Object takes:
 * the outermost sibling description with content wins under `'override'`
 * and the component's own is read under `'ignore'`. A chain that loops, a
 * `$ref` that is not a string, or a ref nothing answers is warned about and
 * the walk's last object read as written.
 */
function resolveResponseDescription(
  raw: unknown,
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  code: string,
  label: string,
  siblingDocs: SiblingDocs,
): string | undefined {
  if (!isRecord(raw)) return undefined;
  const followed = followReference<{ description?: unknown }>(raw, 'responses', componentResponses, siblingDocs);
  if (followed.outcome === 'circular' || followed.outcome === 'malformed') {
    console.warn(
      `[oagen] Warning: Circular or malformed response $ref for status ${code} in ${label}; keeping the status code only.`,
    );
  } else if (followed.outcome === 'unresolved') {
    console.warn(
      `[oagen] Warning: Unresolved response $ref "${followed.ref}" for status ${code} in ${label}: ` +
        'no matching entry under components/responses. Keeping the status code only.',
    );
  }
  const { description } = followed.value;
  return typeof description === 'string' ? description : undefined;
}
