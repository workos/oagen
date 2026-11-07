import { createHash } from 'node:crypto';
import type {
  Enum,
  HttpMethod,
  Model,
  ModelRef,
  Parameter,
  RequestBodyContent,
  Service,
  TypeRef,
  Webhook,
  WebhookResponse,
} from '../ir/types.js';
import {
  collectModelTypeRefs,
  collectOperationTypeRefs,
  collectWebhookTypeRefs,
  renameTypeRefModels,
  walkTypeRef,
} from '../ir/types.js';
import { foldParameterName, parameterKey } from '../ir/parameter-key.js';
import { numberedName, numberedProperty, toPascalCase } from '../utils/naming.js';
import { mediaTypeNameFragment, mediaTypeNamingOrder } from '../utils/media-type.js';
import type { SchemaObject } from './schemas.js';
import { isComponentModelRef, schemaToTypeRef } from './schemas.js';
import {
  cloneTypeRef,
  extractInlineModelsFromProperties,
  modelFingerprint,
  qualifyInlineModelName,
  shapeFingerprint,
  type InlineModelBundle,
} from './inline-models.js';
import {
  HTTP_METHODS,
  extractParams,
  extractTags,
  isIgnoredHeaderParameter,
  namesNothing,
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
  type DeclaredCallbacks,
  type OperationObject,
  type ParameterObject,
  type PathItem,
  type RequestBodyObject,
} from './operations.js';
import { externalDocsEntry } from './external-docs.js';
import { resolvePathItemRef } from './path-item-refs.js';
import { followReference, type SiblingDocs } from './reference-objects.js';
import { isResponseEntry, isResponsesObject } from './response-refs.js';
import { classifyResponseKey, warnUnrecognizedResponseKey } from './responses.js';
import { extractSecurityRequirements } from './security.js';

/** The `components` sections webhook extraction resolves references against. */
export interface WebhookComponents {
  schemas?: Record<string, SchemaObject>;
  parameters?: Record<string, Record<string, unknown>>;
  requestBodies?: Record<string, Record<string, unknown>>;
  responses?: Record<string, Record<string, unknown>>;
  examples?: Record<string, Record<string, unknown>>;
  /**
   * `components.pathItems` (OpenAPI 3.1), which a webhook entry's `$ref` may
   * point into, as it may name another `webhooks` or `paths` entry.
   */
  pathItems?: Record<string, Record<string, unknown>>;
  /** `components.callbacks`, which a `callbacks` entry's `$ref` may point into (`extractCallbacks`; #382). */
  callbacks?: Record<string, Record<string, unknown>>;
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
  /**
   * Every `callbacks` map a webhook's operation declares, in webhook order,
   * for `extractCallbacks` to read once every webhook is named (#382).
   */
  declaredCallbacks: DeclaredCallbacks[];
}

/**
 * What a received request is read from: a (key, method) of the `webhooks`
 * map, or a (key, expression, method) of a `callbacks` map (#382). Names
 * the noun in diagnostics (`a webhook has no path`, `callback operation`)
 * and the word put in front of a stem that would be empty or start with a
 * digit (`Webhook2FaEnabledPayload`, `Callback2FaEnabledPayload`).
 */
export type ReceivedRequestKind = 'webhook' | 'callback';

/**
 * One (key, method) pair of the `webhooks` map — or, for a callback, one
 * (key, expression, method) of a `callbacks` map — with its references
 * resolved. Every reader below takes one of these, so a webhook and a
 * callback are typed, named and built by one code path.
 */
export interface WebhookEntry {
  kind: ReceivedRequestKind;
  /** The `webhooks` key, or the `callbacks` key, verbatim. */
  name: string;
  method: HttpMethod;
  op: OperationObject;
  /**
   * The path item the operation sits on — the entry itself, or the
   * Path Item its `$ref` leads to — whose `summary` and
   * `description` apply to the operation (`resolveOperationDocs`).
   */
  pathItem: PathItem;
  /** The webhook's own parameters after path-item-level ones, deduplicated by (in, name). */
  params: ParameterObject[];
  body: RequestBodyObject | undefined;
  /** `webhooks.<name>.<method>`, or `<owner label>.callbacks.<name>.<expression>.<method>`, for diagnostics. */
  label: string;
  /** How many methods the entry's path item declares; a second one qualifies a key-derived stem. */
  methodCount: number;
  /**
   * The operationId the stem is named from: the operation's own, when it
   * names something (`namesNothing`; #564) and no different operation
   * object among the entries read together declares the same one (see
   * `settleStemOperationIds`). Absent, the stem comes from the key.
   */
  stemOperationId?: string;
  /** A callback's runtime expression, verbatim (`{$request.body#/callbackUrl}`); absent on a webhook. */
  expression?: string;
  /**
   * How many expressions the Callback Object declares; a second one
   * qualifies a key-derived stem with the expression PascalCased, as a
   * second method qualifies it with the method. Absent on a webhook.
   */
  expressionCount?: number;
  /**
   * The stem of the operation, webhook or callback that declares the
   * callback, which a key-derived stem is prefixed with: `CreatePet` +
   * `petAdopted` → `CreatePetPetAdopted`. An operation's or webhook's
   * settled stem (`DeclaredCallbacks.stem`); a parent callback's plain stem
   * before any collision hash (`plainStemOf`), since every callback of the
   * document is named in one batch. Absent on a webhook, whose key stands
   * alone.
   */
  parentStem?: string;
  /**
   * What a key-named callback's collision hash is taken from
   * (`stemIdentity`): its owner's identity — an operation's operationId,
   * else `METHOD /path`; a webhook's or a callback's operationId when its
   * stem is named from one, else that node's own identity — followed by
   * `.callbacks.<key>.<expression>.<method>`, the shape of `label`. The
   * label itself names the site the entry was read at, which for a shared
   * callback operation differs per site; the identity does not, so a group
   * read at several sites hashes alike whichever site comes first (#382).
   * Absent on a webhook, and on a callback read outside `extractCallbacks`,
   * where the label stands in.
   */
  identity?: string;
  /**
   * The callback entry whose operation declares this one; absent on a
   * webhook and on an operation's or webhook's own callback. The chain of
   * parents is the entry's depth (`depthOf`) and its ancestry: a name a
   * descendant mints under a stem of its own never moves an ancestor's
   * stem, and a group is minted at its shallowest member's depth, after
   * every group shallower than it (`buildReceivedRequests`).
   */
  parent?: WebhookEntry;
}

/** How many callbacks sit between the declaring operation or webhook and `entry`: 0 for a webhook or a direct callback. */
function depthOf(entry: WebhookEntry): number {
  let depth = 0;
  for (let parent = entry.parent; parent !== undefined; parent = parent.parent) depth++;
  return depth;
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
 * in document order. The key is kept verbatim as `Webhook.name`, one
 * starting with `x-` included: OpenAPI gives the `webhooks` map no
 * specification extensions, unlike `paths`, so `x-pet-returned` is a webhook
 * like any other (#421). An entry that is a `$ref` into
 * `components/pathItems`, or to another `webhooks` or `paths` entry
 * (`#/webhooks/petAdopted`, `#/paths/~1pets`; #422), is resolved (chains
 * included, with a cycle guard) by `resolvePathItemRef`, the resolver a
 * `paths` entry goes through too; one that points anywhere else, or that
 * cannot be resolved, is warned about and skipped rather than failing the
 * parse, as is an entry that is not an object. A `webhooks` value that is not an object
 * at all is warned about and ignored. Nothing is read from `x-webhooks`, the
 * pre-3.1 convention: the parser reads the standard key only.
 *
 * Parameters and request bodies go through the same resolvers and extractors
 * as operations (`components/parameters` and `components/requestBodies` refs
 * resolved, path-item-level parameters overridden by operation-level ones of
 * the same identity), so a malformed reference fails the parse the way it
 * does on an operation. A `path` parameter has nowhere to go — a webhook has
 * no path — and is dropped with a warning; an `Accept`, `Content-Type` or
 * `Authorization` header is ignored, as OpenAPI requires and as on an
 * operation (`isIgnoredHeaderParameter`). A response that is a `$ref` into
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
 *
 * A webhook operation's `callbacks` are not read here: each map is
 * recorded (`declaredCallbacks`) with the webhook's label and stem for
 * `extractCallbacks` to read once every webhook is named, so a callback's
 * models step around the webhooks' too (#382).
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
  // The document's `paths` map, as written, whose entries a webhook entry's
  // `$ref` may name (`resolvePathItemRef`), as it may name another webhook's.
  paths?: unknown,
): WebhookExtractionResult {
  if (webhooks === undefined) return { webhooks: [], inlineModels: [], inlineModelBundles: [], declaredCallbacks: [] };
  if (!isRecord(webhooks)) {
    console.warn('[oagen] Warning: Top-level `webhooks` is not an object; ignoring it.');
    return { webhooks: [], inlineModels: [], inlineModelBundles: [], declaredCallbacks: [] };
  }

  const entries = collectWebhookEntries(webhooks, components, siblingDocs, paths);
  const reserved: ReservedNames = { all: new Set(reservedNames), enums: new Set(reservedEnumNames) };
  const { built, inlineModels, inlineModelBundles } = buildReceivedRequests(entries, components, reserved, siblingDocs);
  // Each webhook's `callbacks`, read after every webhook is named, under
  // the webhook's label and the stem its own models took.
  const declaredCallbacks: DeclaredCallbacks[] = built
    .filter(({ entry }) => entry.op.callbacks !== undefined)
    .map(({ entry, node, stem }) => ({
      owner: node,
      callbacks: entry.op.callbacks,
      label: entry.label,
      stem,
      // Two keys sharing one path item with an operationId are one identity.
      identity: entry.stemOperationId ?? entry.label,
    }));
  return { webhooks: built.map(({ node }) => node), inlineModels, inlineModelBundles, declaredCallbacks };
}

/** What `buildReceivedRequests` made of a batch of entries. */
export interface BuiltReceivedRequests {
  /** One node per entry, in entry order, with the entry and the stem its models were named from. */
  built: Array<{ entry: WebhookEntry; node: Webhook; stem: string }>;
  /** The models the batch minted, to merge into `ApiSpec.models`. */
  inlineModels: Model[];
  /** Where those models came from (see `WebhookExtractionResult.inlineModelBundles`). */
  inlineModelBundles: InlineModelBundle[];
  /** Every model and inline-enum name the batch minted, for a later batch to reserve. */
  names: Set<string>;
}

/**
 * Name, mint and build one batch of entries — the `webhooks` map's, or
 * every callback of the document (`extractCallbacks`) — against `reserved`,
 * in three phases. The entries are grouped first (`groupEntries`): those
 * that resolve to one operation object and are named from its operationId,
 * and key-named callbacks reading one object under one plain stem, mint
 * once and share the minting, whatever depths their members sit at; every
 * other entry mints on its own. The stems are then settled once, in one
 * resolution over every group at every depth (`resolveWebhookModelStems`),
 * exactly as the `webhooks` map's are: a name a group would mint that the
 * document already holds, or that another group also mints, hashes its
 * stem from its identity, the reserved-name hits and the collisions decided
 * together, so both of a colliding pair move and a group's stem never
 * depends on which depths reference it, nor on how the groups nest: a
 * group of one plain stem with another is its peer, referenced directly,
 * nested inside it, or both, and both hash. The one rule the `webhooks`
 * map never exercises: a name a descendant mints under a stem of its own
 * never moves an ancestor's stem — a nested callback's payload landing on
 * its parent's parameter model moves the nested stem alone — so a nested
 * callback added renames nothing above it. (The resolution compares the
 * names minted, not the stems, so without that rule the parent's parameter
 * model would move the nested payload and the nested payload the parent's
 * stem alike.) Two groups that each nest a reference to the other are
 * peers again, neither protected. Minting then proceeds ancestors first, in waves by each group's
 * shallowest member's depth (`depthOf`, 0 for a webhook): every group with
 * a member at depth 0, then those at depth 1, and so on, each wave minted
 * against the reserved names and every name the waves before minted, where
 * a name still taken — a spent hash, an enum an earlier wave minted —
 * steps aside at mint time; a group that spans depths is one minting,
 * named at its shallowest depth and reused by its deeper members (#382).
 * Last, for a callback batch, whatever let two groups mint one name for
 * two shapes past all that moves every group minting it, each on its own
 * stem (`separateMintedNames`); one shape under one name is the merge's to
 * share. The
 * outcome depends only on the document, never on the order its entries
 * are read in, and a document without callbacks names its webhooks as it
 * always has.
 *
 * The nodes come back in entry order, not group order: a shared
 * operation's second key keeps its own place. A group's owner takes the
 * minted parameters and payload as they are; every other member gets its
 * own copy, so no two nodes share IR nodes — a copy that keeps each
 * reference's provenance (`cloneMintedShape`), so a `$ref` to a component
 * stays one on every member when a merge pass renames the group's models.
 * Each group's models are one site (`inlineModelBundles`): every member's
 * references, the copies included, so a rename reaches every node that
 * shares the minting and nothing else. The bundle is recorded before any
 * callback is attached to a node, so it owns the node's own references and
 * not a nested callback's, which has a bundle of its own.
 */
export function buildReceivedRequests(
  entries: WebhookEntry[],
  components: WebhookComponents,
  reserved: ReservedNames,
  siblingDocs: SiblingDocs,
): BuiltReceivedRequests {
  const { groups, groupOf } = groupEntries(entries);
  // What each group's collision hash is taken from, decided once for the
  // batch so the settling, every wave and the catch-all hash one string.
  const identities = groupIdentities(groups);
  // The groups a group descends from: those of its members' parents, at
  // every remove. None for the `webhooks` map.
  const ancestorsOf = new Map<WebhookGroup, Set<WebhookGroup>>();
  for (const group of groups) {
    const ancestors = new Set<WebhookGroup>();
    for (const entry of group.entries) {
      for (let parent = entry.parent; parent !== undefined; parent = parent.parent) {
        const ancestor = groupOf.get(parent);
        if (ancestor !== undefined && ancestor !== group) ancestors.add(ancestor);
      }
    }
    ancestorsOf.set(group, ancestors);
  }
  // The stems, settled once over every group at every depth, reserved-name
  // hits and collisions decided together as the `webhooks` map's are: both
  // of a colliding pair move, whichever depths reference them and however
  // they nest — a group of one plain stem with another is its peer, direct
  // or nested or both. The one rule the `webhooks` map never exercises: a
  // name a descendant mints under a stem of its own never moves an
  // ancestor's stem, so the descendant is the one that hashes.
  const plainStems = new Map(groups.map((group) => [group, plainStem(group.owner, '')]));
  /**
   * Whether a name `other` mints may move `group`'s stem: it may when the
   * plain stems agree, when neither group is a strict descendant of the
   * other, or when each descends from the other — mutual ancestry makes
   * them peers, neither protected: `petEvent`, whose union mints
   * `ReturnedPetEventPayload`, and `returnedPetEvent`, whose body wants
   * that name, each nesting a reference to the other (the cycle guard
   * stops each walk one level down), both hash as two `webhooks` keys
   * would. Only a name a strict descendant mints under a stem of its own
   * never moves its ancestor's stem.
   */
  const contends = (group: WebhookGroup, other: WebhookGroup): boolean =>
    plainStems.get(other) === plainStems.get(group) ||
    !ancestorsOf.get(other)!.has(group) ||
    ancestorsOf.get(group)!.has(other);
  const settled = resolveWebhookModelStems(groups, reserved, components, siblingDocs, identities, undefined, contends);
  // Each group's wave: its shallowest member's depth.
  const waveOf = new Map(groups.map((group) => [group, Math.min(...group.entries.map(depthOf))] as const));
  const waves = [...new Set(waveOf.values())].sort((a, b) => a - b);
  // What every wave steps around at mint time: the reserved names, and the
  // names and enums the waves before minted.
  const all = new Set(reserved.all);
  const enums = new Set(reserved.enums);
  const stems = new Map<WebhookGroup, string>();
  const hashLength = new Map<WebhookGroup, number>();
  const reservedOf = new Map<WebhookGroup, ReservedNames>();
  const mintedByGroup = new Map<WebhookGroup, MintedWebhook>();
  for (const wave of waves) {
    const waveGroups = groups.filter((group) => waveOf.get(group) === wave);
    // One reserved set for the wave's step-around and its minting, so what
    // the step-around minted is what is kept; the next wave reserves it.
    const waveReserved: ReservedNames = { all: new Set(all), enums: new Set(enums) };
    const resolved = resolveWebhookModelStems(
      waveGroups,
      waveReserved,
      components,
      siblingDocs,
      identities,
      settled,
      contends,
    );
    for (const group of waveGroups) {
      const stem = resolved.stems.get(group)!;
      const minted = mintWebhook(group.owner, stem, components, waveReserved, siblingDocs);
      stems.set(group, stem);
      hashLength.set(group, resolved.hashLength.get(group) ?? 0);
      reservedOf.set(group, waveReserved);
      mintedByGroup.set(group, minted);
      for (const name of minted.names) all.add(name);
      for (const name of mintedEnumNames(minted)) enums.add(name);
    }
  }
  // The groups in minting order: by wave, then as the document declares them.
  const order = waves.flatMap((wave) => groups.filter((group) => waveOf.get(group) === wave));
  if (entries[0]?.kind === 'callback') {
    separateMintedNames(order, stems, hashLength, mintedByGroup, reservedOf, identities, components, siblingDocs);
  }
  const inlineModels = order.flatMap((group) => mintedByGroup.get(group)!.inlineModels);
  const names = new Set(order.flatMap((group) => [...mintedByGroup.get(group)!.names]));

  const built: BuiltReceivedRequests['built'] = [];
  const nodesByGroup = new Map<WebhookGroup, Webhook[]>();
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
    const node = buildWebhook(entry, entry === group.owner ? shape : cloneMintedShape(shape), components, siblingDocs);
    built.push({ entry, node, stem: stems.get(group)! });
    nodesByGroup.set(group, [...(nodesByGroup.get(group) ?? []), node]);
  }

  const inlineModelBundles: InlineModelBundle[] = [];
  for (const group of groups) {
    const minted = mintedByGroup.get(group)!;
    if (minted.inlineModels.length === 0) continue;
    inlineModelBundles.push({
      qualifier: toPascalCase(stems.get(group)!),
      roots: (nodesByGroup.get(group) ?? []).flatMap((node) => collectWebhookTypeRefs(node)),
      models: minted.inlineModels,
    });
  }

  return { built, inlineModels, inlineModelBundles, names };
}

/**
 * The catch-all after a callback batch is minted, independent of what the
 * resolution counted: no two groups may mint one model or enum name for
 * two shapes, whatever let the collision through — a title-mapped union
 * variant, which embeds no stem and so no stem hash moves
 * (`resolveWebhookModelStems`), a hash coincidence, a spent hash. A name
 * two groups mint for one shape — the model's with `deprecated` read
 * apart, an enum's values (`mintedShape`), the way the merge decides a
 * clash — is left to the model merge, which shares the one model, as two
 * webhooks' identical variants are shared. A contested name moves EVERY
 * group minting it, each on its own identity and stem, so the outcome
 * never depends on which was declared first: a name that embeds a group's
 * stem is moved as the resolution moves one, the stem settled with six
 * more characters of the hash of what the batch decided the group is
 * hashed from (`identities`, see `groupIdentities`) and the group minted
 * again; one the hash cannot move is renamed under the group's stem
 * (`<Stem><Name>`, numbered when that is taken too) with every reference
 * minted for it repointed through `renameTypeRefModels`, as the merge
 * passes rename, so
 * an explicit `$ref` to a component of the name — a parameter's union over
 * `components/schemas` — and the mapping entry it owns stay untouched. The
 * check runs again until no name is contested. A contested inline enum
 * name once the hash is spent cannot be moved — nothing renames an enum
 * reference — and is warned about and left to the model merge, never
 * merged silently.
 *
 * The `webhooks` map is not held to this: the one name the resolution
 * leaves two webhooks sharing is a title-mapped variant, which the model
 * merge shares when the shapes agree and renames otherwise, as it always
 * has, and a document without callbacks names its webhooks as before. A
 * callback batch — nested, shared across depths, its stems built on its
 * owners' — is held to the stricter rule (#382).
 */
function separateMintedNames(
  order: WebhookGroup[],
  stems: Map<WebhookGroup, string>,
  hashLength: Map<WebhookGroup, number>,
  mintedByGroup: Map<WebhookGroup, MintedWebhook>,
  reservedOf: Map<WebhookGroup, ReservedNames>,
  identities: Map<WebhookGroup, string>,
  components: WebhookComponents,
  siblingDocs: SiblingDocs,
): void {
  // The names warned about, left to the merge.
  const given = new Set<string>();
  for (;;) {
    // Every name two or more groups mint, with the groups, in minting order.
    const minters = new Map<string, WebhookGroup[]>();
    for (const group of order) {
      for (const name of mintedByGroup.get(group)!.names) minters.set(name, [...(minters.get(name) ?? []), group]);
    }
    // The first contested one: minted by two groups whose shapes disagree.
    // Identical shapes are the merge's to share, as two webhooks' are.
    let contested: { name: string; groups: WebhookGroup[] } | undefined;
    for (const [name, groups] of minters) {
      if (groups.length < 2 || given.has(name)) continue;
      if (new Set(groups.map((group) => mintedShape(mintedByGroup.get(group)!, name))).size > 1) {
        contested = { name, groups };
        break;
      }
    }
    if (contested === undefined) return;
    const { name, groups } = contested;
    // Every group minting it moves, each on its own identity and stem, so
    // the outcome does not depend on which was declared first.
    let moved = false;
    for (const group of groups) {
      const stem = toPascalCase(stems.get(group)!);
      const length = hashLength.get(group) ?? 0;
      if (name.includes(stem) && length < SHA1_HEX_LENGTH) {
        // The hash moves it: six more characters, minted again.
        const next = Math.min(SHA1_HEX_LENGTH, length + 6);
        const hashed = plainStem(group.owner, webhookDisambiguator(identities.get(group)!, next));
        hashLength.set(group, next);
        stems.set(group, hashed);
        mintedByGroup.set(group, mintWebhook(group.owner, hashed, components, reservedOf.get(group)!, siblingDocs));
        moved = true;
        continue;
      }
      const minted = mintedByGroup.get(group)!;
      const model = minted.inlineModels.find((m) => m.name === name);
      // An inline enum of a spent hash: nothing renames an enum reference.
      if (model === undefined) continue;
      // A name the hash cannot move: the model renamed under the group's
      // stem, every reference minted for it repointed — an explicit `$ref`
      // to a component of the name, and the mapping entry it owns, stay.
      const taken = new Set([
        ...reservedOf.get(group)!.all,
        ...order.flatMap((other) => [...mintedByGroup.get(other)!.names]),
      ]);
      let to = `${stem}${name}`;
      for (let n = 2; taken.has(to); n++) to = numberedName(`${stem}${name}`, n);
      model.name = to;
      const renames = new Map([[name, to]]);
      const admit = (ref: ModelRef): boolean => !isComponentModelRef(ref);
      for (const other of minted.inlineModels) {
        for (const ref of collectModelTypeRefs(other)) renameTypeRefModels(ref, renames, admit);
      }
      for (const ref of mintedShapeRefs(minted)) renameTypeRefModels(ref, renames, admit);
      minted.names.delete(name);
      minted.names.add(to);
      moved = true;
    }
    if (!moved) {
      const sites = groups.map((group) => `"${group.owner.label}"`).join(', ');
      console.warn(
        `[oagen] Warning: Callbacks ${sites} each mint an inline enum "${name}" with different values, and no hash parts them; leaving them to the model merge.`,
      );
      given.add(name);
    }
  }
}

/**
 * What the groups minting `name` are compared on, the way the merge decides
 * a clash: a model's shape with `deprecated` read apart
 * (`shapeFingerprint`); an inline enum's values.
 */
function mintedShape(minted: MintedWebhook, name: string): string {
  const model = minted.inlineModels.find((m) => m.name === name);
  if (model !== undefined) return `model:${shapeFingerprint(model)}`;
  let values: string | undefined;
  for (const ref of [...minted.inlineModels.flatMap(collectModelTypeRefs), ...mintedShapeRefs(minted)]) {
    walkTypeRef(ref, {
      enum: (r) => {
        if (r.name === name && r.values) values ??= JSON.stringify(r.values);
      },
    });
  }
  return `enum:${values ?? ''}`;
}

/** Every reference a minting's shape holds: its parameters' types, its payload and its content entries' types. */
function mintedShapeRefs(minted: MintedWebhook): TypeRef[] {
  return [
    ...[...minted.headerParams, ...minted.queryParams, ...minted.cookieParams].map((param) => param.type),
    ...(minted.requestBody ? [minted.requestBody] : []),
    ...(minted.requestBodyContents ?? []).map((content) => content.type),
  ];
}

/**
 * Every inline enum name a minting produced — an enum reference carrying
 * its `values`, in a minted model's field or in the shape's own references
 * — which a later wave's model may not take (`ReservedNames.enums`).
 */
function mintedEnumNames(minted: MintedWebhook): Set<string> {
  const names = new Set<string>();
  const refs: TypeRef[] = [...minted.inlineModels.flatMap(collectModelTypeRefs), ...mintedShapeRefs(minted)];
  for (const ref of refs) {
    walkTypeRef(ref, {
      enum: (r) => {
        if (r.values) names.add(r.name);
      },
    });
  }
  return names;
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
export function collectExistingNames(
  models: Model[],
  services: Service[],
  enums: Enum[],
  webhooks: readonly Webhook[] = [],
): Set<string> {
  return collectExistingNamesByKind(models, services, enums, webhooks).all;
}

/**
 * The enum names among `collectExistingNames`: each enum's name, and every
 * enum a model field or an operation refers to, inline enums included. A
 * webhook model may never take one of these (`mintSchema`): a model and an
 * enum under one name would reach an emitter as one public symbol.
 */
export function collectExistingEnumNames(
  models: Model[],
  services: Service[],
  enums: Enum[],
  webhooks: readonly Webhook[] = [],
): Set<string> {
  return collectExistingNamesByKind(models, services, enums, webhooks).enums;
}

/** The names a webhook's minting must step around: every decided name, and among them the enums'. */
export interface ReservedNames {
  all: ReadonlySet<string>;
  enums: ReadonlySet<string>;
}

/**
 * `webhooks` — every webhook read so far, their callbacks included — is
 * given when the callbacks are named after them (`extractCallbacks`), so a
 * callback's models step around a webhook's too (#382).
 */
function collectExistingNamesByKind(
  models: Model[],
  services: Service[],
  enums: Enum[],
  webhooks: readonly Webhook[],
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
  for (const webhook of webhooks) for (const ref of collectWebhookTypeRefs(webhook)) collect(ref);
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
  paths: unknown,
): WebhookEntry[] {
  const entries: WebhookEntry[] = [];
  // Every key, an `x-` one included: unlike `paths`, the map takes no
  // specification extensions (#421).
  for (const [name, raw] of Object.entries(webhooks)) {
    // The same resolver `extractOperations` reads a `paths` entry through, so
    // a `$ref` into `components/pathItems`, or to another `webhooks` or
    // `paths` entry, is followed the same way here.
    const pathItem = resolvePathItemRef(
      raw,
      components.pathItems,
      { kind: 'webhook', key: name },
      { paths, webhooks },
    ) as PathItem | undefined;
    if (!pathItem) continue;
    entries.push(
      ...readPathItemEntries(
        pathItem,
        { kind: 'webhook', name, labelOf: (method) => `webhooks.${name}.${method}` },
        components,
        siblingDocs,
      ),
    );
  }
  settleStemOperationIds(entries, 'webhook');
  return entries;
}

/** Where a path item's operations are read for (`readPathItemEntries`): the entry's key, how each method is labelled, and a callback's own fields. */
export interface PathItemEntrySite extends Pick<
  WebhookEntry,
  'kind' | 'name' | 'expression' | 'expressionCount' | 'parentStem' | 'parent'
> {
  /** The diagnostic label of one method's operation. */
  labelOf: (method: HttpMethod) => string;
}

/**
 * One entry per HTTP method of a resolved path item, in the path item's own
 * key order, as the IR promises document order (an entry declaring `put`
 * before `post` keeps `put` first); a method whose value is not an object
 * is skipped. Each entry's parameters are read with the same precedence as
 * `buildOperation`'s — an operation-level parameter replaces a
 * path-item-level one of the same identity (`parameterKey`: location and
 * name, a header's name case-folded), in the path-level position; an
 * `Accept`, `Content-Type` or `Authorization` header is dropped — and a
 * `path` parameter, which a received request has no path to place in, is
 * dropped with a warning. The request body's `components/requestBodies`
 * ref is resolved here too. A parameter `content` map or a request body
 * none of whose media types is read is reported here, once per entry: the
 * mint runs twice for each (`resolveWebhookModelStems`, then the build), so
 * it must not report. `stemOperationId` is left for `settleStemOperationIds`
 * to set over the whole batch.
 */
export function readPathItemEntries(
  pathItem: PathItem,
  site: PathItemEntrySite,
  components: WebhookComponents,
  siblingDocs: SiblingDocs,
): WebhookEntry[] {
  const { kind, name, labelOf } = site;
  const entries: WebhookEntry[] = [];
  const methods = (Object.keys(pathItem) as string[]).filter(
    (key): key is HttpMethod =>
      (HTTP_METHODS as readonly string[]).includes(key) && isRecord(pathItem[key as HttpMethod]),
  );
  for (const method of methods) {
    const op = pathItem[method] as OperationObject;
    const label = labelOf(method);
    const paramsByIdentity = new Map<string, ParameterObject>();
    for (const rawParam of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
      const param = resolveParameterRef(rawParam, components.parameters, label, siblingDocs);
      if (isIgnoredHeaderParameter(param)) continue;
      paramsByIdentity.set(parameterKey(param.in, param.name), param);
    }
    const params: ParameterObject[] = [];
    for (const param of paramsByIdentity.values()) {
      if (param.in === 'path') {
        console.warn(
          `[oagen] Warning: Parameter "${param.name}" (in: path) on ${label} ignored: a ${kind} has no path to place it in.`,
        );
        continue;
      }
      warnUnreadParameterContent(param, `Parameter "${param.name}" (in: ${param.in}) on ${label}`);
      params.push(param);
    }
    const body = resolveRequestBodyRef(op.requestBody, components.requestBodies, label, siblingDocs);
    warnUnreadRequestBody(body, label);
    const entry: WebhookEntry = { kind, name, method, op, pathItem, params, body, label, methodCount: methods.length };
    // A callback's own fields, present only on a callback.
    if (site.expression !== undefined) entry.expression = site.expression;
    if (site.expressionCount !== undefined) entry.expressionCount = site.expressionCount;
    if (site.parentStem !== undefined) entry.parentStem = site.parentStem;
    if (site.parent !== undefined) entry.parent = site.parent;
    entries.push(entry);
  }
  return entries;
}

/**
 * Decide which entries are named from their operationId. An operationId
 * names the stem only when it names something and exactly one operation
 * object among `entries` declares it. One with no ASCII letter or digit
 * once its trailing overload markers are stripped (`' '`, `'-'`, `'[1]'`,
 * `'[1][2]'`) counts as absent, as `''` does and as an operation's does
 * (`namesNothing`; #564): it neither names the stem nor counts toward a
 * duplicate, so the key names the models, as when no id is declared. Two
 * keys that `$ref` one path item resolve to the same object and are fine
 * — they will share a stem (see `groupEntries`); two different objects
 * declaring one id is a document error OpenAPI forbids, so neither is
 * named from it, with a warning naming every site. The batch is the
 * `webhooks` map's entries, or every callback entry of the document read
 * together (`extractCallbacks`), so the rule is the same for both.
 */
export function settleStemOperationIds(entries: WebhookEntry[], kind: ReceivedRequestKind): void {
  const objectsByOperationId = new Map<string, Set<OperationObject>>();
  for (const entry of entries) {
    const id = entry.op.operationId;
    if (typeof id !== 'string' || namesNothing(id)) continue;
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
      `[oagen] Warning: operationId "${id}" is declared by more than one ${kind} operation ` +
        `(${declaring.map((entry) => entry.label).join(', ')}); naming their models from the ${kind} keys instead.`,
    );
  }
}

/**
 * Decide the stem every model of each webhook is named from: `<Stem>Payload`
 * for the payload, `<Stem>Payload<Field>` for objects nested in it,
 * `<Const><Stem>Payload` for a const-discriminated variant, `<Stem><Param>`
 * for an inline parameter object or enum.
 *
 * The plain stem is the `operationId` when the operation declares one that
 * names something — run through the same cleaning an operation's own
 * `…Request` model gets, so a webhook and an operation with the same id name
 * their models alike; one that names nothing (`namesNothing`: `' '`, `'-'`,
 * `'[1][2]'`) counts as absent, as an operation's does (#564) — and the
 * PascalCase of the webhook's key otherwise. When a key's path item
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
 * webhook's operationId when it is named from one and of its key otherwise
 * — for a callback, of its site label (`stemIdentity`): the owner's label,
 * the key, the expression and the method, so the callbacks of two owners
 * whose stems coincide (`createPet` beside `create_pet`, both `CreatePet`)
 * under one key never hash alike, each keeping its own payload (#382) —
 * before the method qualifier (`PetAdoptedB4A950`), exactly as an
 * operationId-less operation's path prefix does, and is minted again under
 * it. What is hashed is the text as written when no other group of the
 * batch has the same one, and the text prefixed with where it came from
 * otherwise (`groupIdentities`): a webhook keyed `petAdopted` without an
 * operationId and one keyed `noteAdded` declaring `operationId: petAdopted`
 * hash `key:petAdopted` and `operationId:petAdopted`, never one string
 * twice, so the six characters part them and each keeps its own payload
 * whatever the key order (#580). The names minted under the moved stems
 * are then checked again, against the reserved names and every other
 * group's: a group still
 * clashing — two hash prefixes that coincide, a reserved name that spells a
 * hashed stem — takes six more characters of its hash, and so on until no
 * stem-embedding name clashes or the hash is spent, when the clash is left
 * to the model merge. Both sides of a webhook-to-webhook collision are
 * hashed, since neither key is more canonical than the other. The outcome
 * depends only on the document's keys, operationIds, components and
 * operations, never on their order, and a key that stops colliding returns
 * to its plain stem.
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
 *
 * `buildReceivedRequests` runs this twice: once over every group at every
 * depth, with every name counted as above except one a descendant mints
 * under a stem of its own, which `contends` keeps from moving an ancestor's
 * stem — the settling that holds across depths — and once per minting wave
 * under the same rule, from the `settled` stems and
 * hash lengths, where a name still taken moves a stem further, the
 * mint-time step-around. For the `webhooks` map, which nests nothing and
 * mints in one wave, the two are the one resolution this always was.
 */
function resolveWebhookModelStems(
  groups: WebhookGroup[],
  reserved: ReservedNames,
  components: WebhookComponents,
  siblingDocs: SiblingDocs,
  /** What each group's disambiguator is hashed from, decided once for the whole batch (`groupIdentities`). */
  identities: Map<WebhookGroup, string>,
  /** Stems and hash lengths already settled, to start from and extend instead of the plain stems (`buildReceivedRequests`'s minting). */
  settled?: ResolvedStems,
  /** Whether a name `other` mints may move `group`'s stem; any may unless said otherwise. */
  contends: (group: WebhookGroup, other: WebhookGroup) => boolean = () => true,
): ResolvedStems {
  const mint = (group: WebhookGroup, stem: string): Set<string> =>
    mintWebhook(group.owner, stem, components, reserved, siblingDocs).names;
  // How many hex characters of its hash each group's stem carries: none
  // until it clashes, six more each time it still does.
  const hashLength = new Map<WebhookGroup, number>(settled?.hashLength);
  let stems = new Map(groups.map((group) => [group, settled?.stems.get(group) ?? plainStem(group.owner, '')]));
  let names = new Map(groups.map((group) => [group, mint(group, stems.get(group)!)]));
  for (;;) {
    // Only a clashing name the hash would move — one that embeds the stem —
    // moves the stem.
    const clashing = groups.filter((group) => {
      const stem = toPascalCase(stems.get(group)!);
      return [...names.get(group)!].some(
        (name) =>
          name.includes(stem) &&
          (reserved.all.has(name) ||
            groups.some((other) => other !== group && contends(group, other) && names.get(other)!.has(name))),
      );
    });
    // A clash that survives the whole hash is left to the model merge.
    const movable = clashing.filter((group) => (hashLength.get(group) ?? 0) < SHA1_HEX_LENGTH);
    if (movable.length === 0) return { stems, hashLength };
    const moved = new Map(stems);
    for (const group of movable) {
      const length = Math.min(SHA1_HEX_LENGTH, (hashLength.get(group) ?? 0) + 6);
      hashLength.set(group, length);
      moved.set(group, plainStem(group.owner, webhookDisambiguator(identities.get(group)!, length)));
    }
    // Minted again under the moved stems alone, then checked again: the
    // groups that did not move keep the names they minted.
    names = new Map(
      groups.map((group) => [
        group,
        moved.get(group) === stems.get(group) ? names.get(group)! : mint(group, moved.get(group)!),
      ]),
    );
    stems = moved;
  }
}

/** The hex characters a SHA-1 spells: the most a disambiguator can take. */
const SHA1_HEX_LENGTH = 40;

/** What `resolveWebhookModelStems` settles: each group's stem, and how many hex characters of its hash the stem carries. */
interface ResolvedStems {
  stems: Map<WebhookGroup, string>;
  hashLength: Map<WebhookGroup, number>;
}

/** Where an identity's text comes from: the operationId a stem is named from, or the key — a callback's site — otherwise. */
type IdentitySource = 'operationId' | 'key';

/** What an entry or a group is told apart by: a text, and where it came from. */
interface StemIdentity {
  source: IdentitySource;
  text: string;
}

/**
 * What an entry's disambiguator is hashed from: its operationId when its
 * stem is named from one; else a webhook's key, and a callback's identity
 * (`WebhookEntry.identity`, its label when none was set) — the owner's
 * identity, the key, the expression and the method — so two owners
 * declaring one callback key, or two expressions of one key that
 * PascalCase alike (`#/url` and `#/URL`), never hash alike (#382). The
 * source comes with the text, so a key and an operationId that spell one
 * text can be told apart when a batch holds both (`groupIdentities`; #580).
 */
function stemIdentity(entry: WebhookEntry): StemIdentity {
  if (entry.stemOperationId !== undefined) return { source: 'operationId', text: entry.stemOperationId };
  return { source: 'key', text: entry.kind === 'callback' ? (entry.identity ?? entry.label) : entry.name };
}

/**
 * The identity a group is hashed from: the smallest text among its members'
 * identities (`stemIdentity`), so the hash never depends on which site the
 * group was first read at. The members of an operationId-named group share
 * one identity, as do the sites of a shared callback operation's own
 * callbacks, whose owner's identity is that operationId; a group of
 * key-named entries reading one object under one stem from owners whose
 * identities differ takes the smallest, which a reorder of the owners
 * cannot move (#382). A group of one is hashed from its own. Every member
 * of a group has the one source, since a group is either named from one
 * operationId or made of key-named entries (`groupEntries`).
 */
function groupIdentity(group: WebhookGroup): StemIdentity {
  return group.entries.map(stemIdentity).sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))[0]!;
}

/**
 * What each group's disambiguator is hashed from (`webhookDisambiguator`),
 * decided once over the whole batch — the groups of the `webhooks` map, or
 * of every callback of the document — so that a key and an operationId of
 * one text never hash one string, and the hash prefixes that part them
 * exist to be found. It is the identity's text as written
 * (`groupIdentity`) unless the batch holds that text under both sources:
 * a webhook keyed `petAdopted` without an `operationId` and one keyed
 * `noteAdded` declaring `operationId: petAdopted` hashed one string,
 * shared every hashed stem to the last character and merged their
 * payloads, the first declared winning (#580); now each group of such a
 * text hashes it prefixed with its source, `key:petAdopted` and
 * `operationId:petAdopted`, and the six-character prefixes part them.
 * Only the groups of a text held under both sources move, so a document
 * without such a pair hashes exactly as before, and adding the pair moves
 * only its stems. The entries of one key with several methods are several
 * groups holding one text under one source; they hash one string and are
 * parted by the method qualifier (`PetAdoptedB4A950Post`,
 * `PetAdoptedB4A950Put`), as they always were, prefixed or not. A key or
 * operationId that spells a prefixed text as written — a webhook keyed
 * `key:petAdopted` beside that pair — hashes the string `petAdopted`'s key
 * hashes, and names apart all the same: its stem starts with the word the
 * prefix PascalCases to (`KeyPetAdopted`, `OperationIdPetAdopted`), so
 * every name it mints starts with `KeyPetAdopted<hash>` and every name
 * `petAdopted`'s mints with `PetAdopted<hash>`, and no name coincides
 * (`KeyPetAdopted15Fe0FPayload` beside `PetAdopted15Fe0FPayload`); nothing
 * else in the batch is moved by it. The rule reads the batch's texts
 * alone, never their order.
 */
function groupIdentities(groups: WebhookGroup[]): Map<WebhookGroup, string> {
  const identities = new Map(groups.map((group) => [group, groupIdentity(group)] as const));
  // The sources each text is held under: one, or both.
  const sources = new Map<string, Set<IdentitySource>>();
  for (const { source, text } of identities.values()) sources.set(text, new Set(sources.get(text)).add(source));
  return new Map(
    groups.map((group) => {
      const { source, text } = identities.get(group)!;
      return [group, sources.get(text)!.size > 1 ? `${source}:${text}` : text];
    }),
  );
}

/**
 * Entries that mint together. Those resolving to one operation object and
 * named from its operationId share a group: `owner` is the first of them in
 * document order, and its parameters and body stand for the group's, since
 * every member read the same path item. So do key-named callback entries
 * that read one operation object under one plain stem — the sites of one
 * shared callback operation's own callbacks (`noteRead` declared by a
 * `components/callbacks` entry two operations reference, or by a path item
 * two `webhooks` keys share), which every site reaches under the owner's
 * one stem — so a callback inside a shared minting mints once with it,
 * however many sites reach it (#382). Every other entry is a group of its
 * own: two keys reading one path item without an operationId keep their
 * key-derived stems, and two owners' inline callbacks are two objects.
 */
interface WebhookGroup {
  owner: WebhookEntry;
  entries: WebhookEntry[];
}

function groupEntries(entries: WebhookEntry[]): { groups: WebhookGroup[]; groupOf: Map<WebhookEntry, WebhookGroup> } {
  const groups: WebhookGroup[] = [];
  const groupOf = new Map<WebhookEntry, WebhookGroup>();
  const byOperation = new Map<OperationObject, WebhookGroup>();
  // A key-named callback's groups, by the operation object read and the
  // plain stem it is read under (the owner's stem, key, expression and
  // method; `plainStem`): the sites of one shared callback operation's own
  // callbacks read one object under one stem and mint once (#382).
  const byOwnedOperation = new Map<OperationObject, Map<string, WebhookGroup>>();
  for (const entry of entries) {
    const shared = entry.stemOperationId !== undefined;
    const ownedStem = !shared && entry.kind === 'callback' ? plainStem(entry, '') : undefined;
    let group = shared
      ? byOperation.get(entry.op)
      : ownedStem !== undefined
        ? byOwnedOperation.get(entry.op)?.get(ownedStem)
        : undefined;
    if (!group) {
      group = { owner: entry, entries: [] };
      groups.push(group);
      if (shared) byOperation.set(entry.op, group);
      if (ownedStem !== undefined) {
        const byStem = byOwnedOperation.get(entry.op) ?? new Map<string, WebhookGroup>();
        byStem.set(ownedStem, group);
        byOwnedOperation.set(entry.op, byStem);
      }
    }
    group.entries.push(entry);
    groupOf.set(entry, group);
  }
  return { groups, groupOf };
}

/** The plain stem of `entry` — before any collision hash — which a nested callback's key-derived stem is prefixed with (`extractCallbacks`). */
export function plainStemOf(entry: WebhookEntry): string {
  return plainStem(entry, '');
}

/**
 * The stem of `entry` with `disambiguator` inserted before the qualifiers:
 * empty for the plain stem, else the hash prefix of what the batch decided
 * the entry's group is hashed from (`groupIdentities`,
 * `webhookDisambiguator`) — so two entries whose stems collide carry
 * different prefixes, a key and an operationId of one text included. A
 * key-derived stem is the key PascalCased, prefixed with
 * the declaring node's stem for a callback (`CreatePet` + `petAdopted` →
 * `CreatePetPetAdopted`; #382), then qualified by the expression
 * PascalCased when the callback's key declares several
 * (`CreatePetPetAdoptedRequestBodyCallbackUrl` for
 * `{$request.body#/callbackUrl}`) and by the method when the path item
 * declares several (`PetUpdatedPut`), so no two entries of one key share a
 * model; an operationId-derived stem needs neither. An empty stem, or one
 * starting with a digit, gets the kind's noun in front (`Webhook`,
 * `Callback`).
 */
function plainStem(entry: WebhookEntry, disambiguator: string): string {
  const operationId = entry.stemOperationId;
  const expression = !operationId && (entry.expressionCount ?? 1) > 1 ? toPascalCase(entry.expression ?? '') : '';
  const method = !operationId && entry.methodCount > 1 ? entry.method : '';
  const base = operationId ? operationIdModelBase(operationId) : `${entry.parentStem ?? ''}${toPascalCase(entry.name)}`;
  // `_` separators guarantee a word boundary on each side of the disambiguator
  // and the qualifiers, whatever the base ends with; splitWords drops them, so
  // the disambiguator is the suffix numberedName gives the base: a hash that
  // starts with a digit is set off from a base that ends in one as a number
  // is (`PetV2No2780A4`), as an operation's path prefix sets it off.
  const hash = numberedName(base, disambiguator).slice(base.length);
  const stem = toPascalCase([base, hash, expression, method].filter(Boolean).join('_'));
  const noun = entry.kind === 'callback' ? 'Callback' : 'Webhook';
  if (stem === '') return noun;
  return /^\d/.test(stem) ? `${noun}${stem}` : stem;
}

/** The first `length` (six, by default) hex characters of the SHA-1 of what a group is hashed from (`groupIdentities`). */
function webhookDisambiguator(name: string, length = 6): string {
  return createHash('sha1').update(name).digest('hex').slice(0, length);
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
 * `<in>_<name>`, then that numbered by numberedProperty (`query_payload2`,
 * `query_payload3`, …; `query_v2No2` for a name that ends in a digit, which
 * an `_` before the number would not set off once PascalCased, and
 * `query_filter[v2]No2` for one that ends in a digit once cased, which a
 * number behind the bracket would run into once it is dropped —
 * `QueryFilterV2No2`, never `QueryFilterV22`, #533). A schema that
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
      attempt === 0 ? stem : attempt === 1 ? `${param.in}_${stem}` : numberedProperty(`${param.in}_${stem}`, attempt);
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
    // The document's operationId as written, when it names something; one
    // that names nothing is left out, as on an operation (`namesNothing`;
    // #564). No `operationIdTransform` is applied to a webhook's.
    ...(typeof op.operationId === 'string' && !namesNothing(op.operationId) ? { operationId: op.operationId } : {}),
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
 * status code with a warning, and the description beside it by that rule, as
 * an operation's response does. A blank description is omitted. An entry at
 * a status code that is not an object (`200: "oops"`, `null`, `7`) is no
 * Response Object and no Reference Object: it is warned about once, naming
 * the site, and skipped, and a `responses` that is not an object at all is
 * read as absent, with a warning — as on an operation (`isResponseEntry`,
 * `isResponsesObject`, #617).
 */
function extractWebhookResponses(
  responses: OperationObject['responses'],
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  label: string,
  siblingDocs: SiblingDocs,
): WebhookResponse[] {
  const result: WebhookResponse[] = [];
  // A `responses` that is not an object is no Responses Object: warned
  // about once and read as absent, as on an operation (#617).
  if (responses !== undefined && !isResponsesObject(responses, label)) responses = undefined;
  for (const [code, raw] of Object.entries(responses ?? {})) {
    const responseKey = classifyResponseKey(code);
    if (responseKey.kind === 'unrecognized') warnUnrecognizedResponseKey(code, label);
    if (responseKey.kind !== 'status') continue;
    // An entry that is not an object (`200: "oops"`) is no Response Object
    // and no Reference Object: warned about once, naming the site and the
    // code, and skipped, as on an operation (#617). Only a status code is
    // checked, since only one is read.
    if (!isResponseEntry(raw, `${code} response of ${label}`)) continue;
    const read = resolveResponseDescription(raw, componentResponses, code, label, siblingDocs);
    if (read.skip) continue;
    const description = presentText(read.description);
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
 * the walk's last object read as written, by the same rule: the text beside
 * the refs under `'override'`, none under `'ignore'`. The warning says
 * whether that leaves a description beside the status code. A chain that
 * ends on a `components/responses` entry that is no object (`Gone: []`) is
 * the inline case behind a pointer: it goes through `isResponseEntry` as an
 * inline entry does, warned about naming the component and the site, and
 * `{ skip: true }` tells the caller to skip the status code, as an
 * operation skips the entry (#617).
 */
function resolveResponseDescription(
  raw: Record<string, unknown>,
  componentResponses: Record<string, Record<string, unknown>> | undefined,
  code: string,
  label: string,
  siblingDocs: SiblingDocs,
): { skip: true } | { skip?: undefined; description?: string } {
  const followed = followReference<{ description?: unknown }>(raw, 'responses', componentResponses, siblingDocs);
  if (followed.outcome === 'unresolved' && followed.found !== undefined) {
    const { name, value } = followed.found;
    if (!isResponseEntry(value, `components/responses/${name} (the ${code} response of ${label})`))
      return { skip: true };
  }
  const { description } = followed.value;
  const text = typeof description === 'string' ? description : undefined;
  const keeping =
    presentText(text) === undefined ? 'the status code only' : 'the status code and the description beside the $ref';
  if (followed.outcome === 'circular' || followed.outcome === 'malformed') {
    console.warn(
      `[oagen] Warning: Circular or malformed response $ref for status ${code} in ${label}; keeping ${keeping}.`,
    );
  } else if (followed.outcome === 'unresolved') {
    console.warn(
      `[oagen] Warning: Unresolved response $ref "${followed.ref}" for status ${code} in ${label}: ` +
        `no matching entry under components/responses. Keeping ${keeping}.`,
    );
  }
  return { description: text };
}
