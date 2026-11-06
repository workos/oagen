/**
 * Reading an Operation Object's `callbacks` (OpenAPI 3.x) into the IR
 * (#382).
 *
 * A callback is a request the API makes back to a URL the caller supplied
 * in the operation's request: under each key of the `callbacks` map sits a
 * Callback Object, or a `$ref` into `components/callbacks`, mapping runtime
 * expressions such as `{$request.body#/callbackUrl}` to path items. Each
 * HTTP method of each of those path items is one `Callback` — a `Webhook`
 * tied to the operation that registers it — carried on
 * `Operation.callbacks` or, for a `webhooks` operation's, on
 * `Webhook.callbacks`, and a callback operation's own `callbacks` nest the
 * same way. Everything is read through the webhook machinery
 * (`readPathItemEntries`, `buildReceivedRequests`): parameters (a `path`
 * one dropped with a warning), the payload with every media type,
 * responses, docs, deprecation, tags and security are read exactly as a
 * webhook's, and a callback's sites are labelled
 * `<owner label>.callbacks.<key>.<expression>.<method>`.
 *
 * **Naming.** A callback's models are named from a stem as a webhook's are:
 * the callback operation's `operationId` when it names something
 * (`namesNothing`; #564) and exactly one callback operation object in the
 * document declares it, else the declaring node's stem followed by the key
 * PascalCased — `createPet`'s `petAdopted` mints `CreatePetPetAdoptedPayload`,
 * `POST /pets`'s `PetsPostPetAdoptedPayload`, a nested callback
 * `<CallbackStem><Key>`. A key declaring several expressions qualifies
 * each key-derived stem with the expression PascalCased, and a path item
 * declaring several methods with the method, as one `webhooks` entry with
 * several methods is qualified (`plainStem`). The stems of every callback
 * are decided against every model and enum name the document already
 * holds — components, the operations' models, the webhooks' — and against
 * each other — once, across every depth, as the `webhooks` map's are, only a
 * name a descendant mints under a stem of its own never moving an ancestor's
 * stem; the minting then proceeds ancestors first (see `extractCallbacks`) —
 * so a collision hashes the
 * NEW stem as a webhook's is hashed — from the callback's identity: its
 * owner's identity (an operation's operationId, else `METHOD /path`; a
 * shared callback operation's operationId) with the key, expression and
 * method, so the callbacks of two owners whose stems coincide (`createPet`
 * beside `create_pet`) under one key never hash alike
 * (`CreatePetPetAdopted2Fac84Payload` beside a component
 * `CreatePetPetAdoptedPayload`), while a group read at several sites hashes
 * alike whichever site comes first; the moved names are checked again —
 * and never renames an existing model.
 *
 * **Cycles.** A `components/callbacks` entry, or a nested callback, can
 * refer back to a callback it sits in (a callback whose operation `$ref`s
 * the path item declaring the callback). The Callback Objects on the path
 * from the owner down are tracked by identity, after `$ref` resolution: a
 * callback already on that path is skipped with one warning naming the
 * site. Depth is otherwise unbounded, and one Callback Object reached from
 * two sites that do not nest is read at both, as two `webhooks` keys that
 * `$ref` one path item are.
 *
 * **Guards.** A `callbacks` value that is not a map, or an empty one,
 * declares no callback and is silent — as is an entry under
 * `components/callbacks` that nothing references. A Callback Object that is
 * not an object, a `$ref` that is not a string, one that resolves to
 * nothing under `components/callbacks`, or a chain that loops, is warned
 * about and skipped. An `x-` key inside a Callback Object is a
 * specification extension and is not an expression.
 */
import type { Callback, Model, Operation, Webhook } from '../ir/types.js';
import { callbackContext } from '../ir/types.js';
import type { InlineModelBundle } from './inline-models.js';
import type { DeclaredCallbacks, PathItem } from './operations.js';
import { resolveComponentRef, resolvePathItemRef } from './path-item-refs.js';
import type { SiblingDocs } from './reference-objects.js';
import {
  buildReceivedRequests,
  plainStemOf,
  readPathItemEntries,
  settleStemOperationIds,
  type WebhookComponents,
  type WebhookEntry,
} from './webhooks.js';

export interface CallbackExtractionResult {
  /** Models materialized from inline callback payload and parameter schemas, to merge into `ApiSpec.models`. */
  inlineModels: Model[];
  /** Where those models came from, one site per minting, as a webhook's (`WebhookExtractionResult.inlineModelBundles`). */
  inlineModelBundles: InlineModelBundle[];
}

/** One callback entry waiting to be named and built, with where it attaches. */
interface PendingCallback {
  entry: WebhookEntry;
  /** The node the built `Callback` is appended to: the declaring operation or webhook, or the parent pending callback. */
  owner: Operation | Webhook | PendingCallback;
  /** The stem of `owner` when it is an operation or webhook; a parent callback's is its plain stem (`plainStemOf`). */
  ownerStem: string | undefined;
  /** The identity of `owner` when it is an operation or webhook (`DeclaredCallbacks.identity`); a parent callback's is its own. */
  ownerIdentity: string | undefined;
  /** The `Callback` built for this entry, once the batch is built (see `extractCallbacks`). */
  node?: Callback;
}

/**
 * Read every declared `callbacks` map into `Callback` entries on its owner,
 * in place, and return the models the callbacks minted. `reservedNames` and
 * `reservedEnumNames` are every name decided before the callbacks — the
 * components', the operations', the webhooks' — see `collectExistingNames`.
 * `paths` and `webhooks` are the document's own maps, as written, which a
 * callback path item's `$ref` may name beside `components/pathItems`.
 *
 * Every callback of the document, nested ones included, is collected
 * first (`collectPendingCallbacks`), so an operationId names a stem only
 * when exactly one callback operation object in the whole document
 * declares it (`settleStemOperationIds`). Each key-named entry's stem is
 * then prefixed with its owner's stem — an operation's or webhook's settled
 * one, a parent callback's plain stem before any collision hash
 * (`plainStemOf`), parents preceding children — and every entry is grouped,
 * named, minted and built by `buildReceivedRequests`, as the `webhooks` map
 * is, in three phases: the groups are formed over every entry of the
 * document; the stems are settled once, in one resolution across every
 * depth, exactly as the `webhooks` map's are — a name a group would mint
 * that the document holds or another group also mints hashes the stem,
 * both of a colliding pair moving whichever depths reference them, so a
 * reference added at another depth renames nothing, and a group of one
 * plain stem with another is its peer whether referenced directly, nested
 * inside it, or both — with the one rule the `webhooks` map never
 * exercises, that a name a descendant mints under a stem of its own never
 * moves an ancestor's stem, so a new nested callback never renames its
 * parent's parameter or payload model (it is the one that hashes), two
 * groups nesting each other being peers again; and the minting
 * proceeds ancestors first, in waves by each group's shallowest member's
 * depth — every group with a member at depth 0, then those at depth 1, and
 * so on — each wave stepping around at mint time any name still taken,
 * while a group that spans depths is still one minting, named at its
 * shallowest depth and reused by its deeper members; last, whatever lets
 * two groups mint one name past all that — a title-mapped variant no stem
 * hash moves — moves the later group alone (`separateMintedNames`), so no
 * two callbacks ever share a model by accident. Entries reading one
 * operation object and named from
 * its operationId form one group whatever their depths (a
 * `components/callbacks` entry an operation references directly and
 * another callback nests), and so do key-named entries reading one object
 * under one plain stem (`groupEntries`: `noteRead` declared by a shared
 * `NoteAdded`; `Read` referenced by a path operation `registerEvent` and by
 * a callback operation `register_event`, both `RegisterEvent`), so each
 * mints once and every site references the one model
 * (`NotifyAdoptionPayload`, `OnNoteAddedNoteReadPayload`,
 * `RegisterEventReadPayload`) whichever site comes first; a nested site is
 * never named apart from a direct one. Every group is named against every
 * other and against every name decided before. Once every node exists,
 * each is attached to its owner in document order — `callbacks` key order,
 * expression order within each Callback Object, then the path item's
 * method order.
 */
export function extractCallbacks(
  declared: readonly DeclaredCallbacks[],
  components: WebhookComponents,
  reservedNames: Iterable<string>,
  reservedEnumNames: Iterable<string>,
  siblingDocs: SiblingDocs,
  paths?: unknown,
  webhooks?: unknown,
): CallbackExtractionResult {
  const pending: PendingCallback[] = [];
  for (const { owner, callbacks, label, stem, identity } of declared) {
    collectPendingCallbacks(
      callbacks,
      label,
      owner,
      stem,
      identity ?? label,
      new Set(),
      pending,
      components,
      siblingDocs,
      { paths, webhooks },
    );
  }
  const inlineModels: Model[] = [];
  const inlineModelBundles: InlineModelBundle[] = [];
  if (pending.length === 0) return { inlineModels, inlineModelBundles };

  settleStemOperationIds(
    pending.map(({ entry }) => entry),
    'callback',
  );
  // Each entry's identity, once the operationIds are settled: the owner's
  // — a parent callback's operationId when its stem is named from one, else
  // the parent's own identity — with the key, expression and method, in
  // the shape of the label. Parents precede their children in `pending`.
  for (const candidate of pending) {
    const { entry, owner } = candidate;
    const parent = isPending(owner) ? (owner.entry.stemOperationId ?? owner.entry.identity!) : candidate.ownerIdentity!;
    entry.identity = callbackContext(parent, {
      name: entry.name,
      expression: entry.expression!,
      httpMethod: entry.method,
    });
  }

  // Each key-named entry's parent stem: the owner's settled stem for an
  // operation or webhook, a parent callback's plain stem (before the
  // collision hash the batch below may give it). Parents precede their
  // children in `pending`, so a parent's own parent stem is set first.
  for (const candidate of pending) {
    const { entry, owner } = candidate;
    if (entry.stemOperationId !== undefined) continue;
    entry.parentStem = isPending(owner) ? plainStemOf(owner.entry) : candidate.ownerStem!;
  }

  // Every callback of the document at once, as the `webhooks` map is read:
  // entries reading one operation object under one plain stem form one
  // group whatever their depths (`groupEntries`); the stems are settled
  // once across every depth, as the `webhooks` map's are, only a name a
  // descendant mints under a stem of its own never moving an ancestor's
  // stem; the groups are minted in waves
  // by their shallowest member's depth, each wave stepping around every
  // name decided before it, and each mints once.
  const batch = buildReceivedRequests(
    pending.map(({ entry }) => entry),
    components,
    { all: new Set(reservedNames), enums: new Set(reservedEnumNames) },
    siblingDocs,
  );
  inlineModels.push(...batch.inlineModels);
  inlineModelBundles.push(...batch.inlineModelBundles);
  for (const [index, { node }] of batch.built.entries()) {
    const candidate = pending[index]!;
    // The node `buildWebhook` made, with the expression after the key.
    const { name, ...rest } = node;
    candidate.node = { name, expression: candidate.entry.expression!, ...rest };
  }
  // Attached once every node exists, in document order: `pending` is
  // collected depth-first, so an owner's callbacks come in key, expression
  // and method order, and a parent's node is built before its children attach.
  for (const candidate of pending) {
    const owner = isPending(candidate.owner) ? candidate.owner.node! : candidate.owner;
    owner.callbacks = [...(owner.callbacks ?? []), candidate.node!];
  }
  return { inlineModels, inlineModelBundles };
}

function isPending(owner: PendingCallback['owner']): owner is PendingCallback {
  return 'entry' in owner;
}

/** The document's own `paths` and `webhooks` maps, which a callback path item's `$ref` may name. */
interface DocumentMaps {
  paths?: unknown;
  webhooks?: unknown;
}

/**
 * Read one `callbacks` map into pending entries, recursing into each
 * callback operation's own `callbacks` with the Callback Objects on the path
 * (`ancestors`) as the cycle guard. `label` is the declaring node's, which
 * each site is labelled under.
 */
function collectPendingCallbacks(
  callbacks: unknown,
  label: string,
  owner: PendingCallback['owner'],
  ownerStem: string | undefined,
  ownerIdentity: string | undefined,
  ancestors: ReadonlySet<object>,
  pending: PendingCallback[],
  components: WebhookComponents,
  siblingDocs: SiblingDocs,
  document: DocumentMaps,
): void {
  // Not a map, or an empty one: nothing declared, nothing said.
  if (!isRecord(callbacks)) return;
  for (const [key, raw] of Object.entries(callbacks)) {
    const site = `${label}.callbacks.${key}`;
    const callback = resolveCallbackRef(raw, site, components.callbacks);
    if (!callback) continue;
    if (ancestors.has(callback)) {
      console.warn(`[oagen] Warning: Callback "${site}" refers back to a callback it sits in; skipping it.`);
      continue;
    }
    const onPath = new Set(ancestors).add(callback);
    // An `x-` key is a specification extension of the Callback Object, not
    // an expression (as `schemaRootsOf` steps over it).
    const expressions = Object.keys(callback).filter((expression) => !expression.startsWith('x-'));
    for (const expression of expressions) {
      const expressionSite = `${site}.${expression}`;
      const pathItem = resolvePathItemRef(
        callback[expression],
        components.pathItems,
        { kind: 'callback', key: expressionSite },
        document,
      ) as PathItem | undefined;
      if (!pathItem) continue;
      const entries = readPathItemEntries(
        pathItem,
        {
          kind: 'callback',
          name: key,
          expression,
          expressionCount: expressions.length,
          // The parent callback's entry, for the depth and the ancestry.
          ...(isPending(owner) ? { parent: owner.entry } : {}),
          labelOf: (method) => callbackContext(label, { name: key, expression, httpMethod: method }),
        },
        components,
        siblingDocs,
      );
      for (const entry of entries) {
        const candidate: PendingCallback = { entry, owner, ownerStem, ownerIdentity };
        pending.push(candidate);
        // The callback operation's own callbacks nest under it.
        collectPendingCallbacks(
          entry.op.callbacks,
          entry.label,
          candidate,
          undefined,
          undefined,
          onPath,
          pending,
          components,
          siblingDocs,
          document,
        );
      }
    }
  }
}

/**
 * The Callback Object `raw` denotes: itself, or the `components/callbacks`
 * entry its `$ref` chain leads to. A Callback Object carries no
 * documentation a Reference Object could override, so nothing beside the
 * `$ref` is read. `undefined`, after one warning naming the site, for a
 * value that is not an object, a `$ref` that is not a string, a ref
 * nothing under `components/callbacks` answers (one into another section
 * included), or a chain that loops; the caller skips the callback.
 */
function resolveCallbackRef(
  raw: unknown,
  site: string,
  componentCallbacks: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const seen = new Set<string>();
  let current: unknown = raw;
  while (true) {
    if (!isRecord(current)) {
      console.warn(`[oagen] Warning: Callback "${site}" is not a Callback Object; skipping it.`);
      return undefined;
    }
    const ref = current.$ref;
    if (ref === undefined) return current;
    if (typeof ref !== 'string') {
      console.warn(`[oagen] Warning: Callback "${site}" has a non-string $ref; skipping it.`);
      return undefined;
    }
    if (seen.has(ref)) {
      console.warn(
        `[oagen] Warning: Circular callback $ref chain starting at "${ref}" for callback "${site}"; skipping it.`,
      );
      return undefined;
    }
    seen.add(ref);
    const resolved = resolveComponentRef(ref, 'callbacks', componentCallbacks);
    if (!resolved) {
      console.warn(
        `[oagen] Warning: Unresolved callback $ref "${ref}" for callback "${site}": ` +
          'no matching entry under components/callbacks. Skipping the callback.',
      );
      return undefined;
    }
    current = resolved;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
