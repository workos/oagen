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
 * each other, one level of nesting at a time, so a collision hashes the
 * NEW stem (`CreatePetPetAdoptedD62D88Payload`, from the key and expression
 * together) as a webhook's is hashed, and never renames an existing model.
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
import type { Callback, Model, Operation, TypeRef, Webhook } from '../ir/types.js';
import { callbackContext, collectModelTypeRefs, collectWebhookTypeRefs, walkTypeRef } from '../ir/types.js';
import type { InlineModelBundle } from './inline-models.js';
import type { DeclaredCallbacks, PathItem } from './operations.js';
import { resolveComponentRef, resolvePathItemRef } from './path-item-refs.js';
import type { SiblingDocs } from './reference-objects.js';
import {
  buildReceivedRequests,
  readPathItemEntries,
  settleStemOperationIds,
  type ReservedNames,
  type WebhookComponents,
  type WebhookEntry,
} from './webhooks.js';

export interface CallbackExtractionResult {
  /** Models materialized from inline callback payload and parameter schemas, to merge into `ApiSpec.models`. */
  inlineModels: Model[];
  /** Where those models came from, one site per minting, as a webhook's (`WebhookExtractionResult.inlineModelBundles`). */
  inlineModelBundles: InlineModelBundle[];
}

/** One callback entry waiting to be named and built, with where it attaches and how deep it sits. */
interface PendingCallback {
  entry: WebhookEntry;
  /** The node the built `Callback` is appended to: the declaring operation or webhook, or the parent pending callback (once built). */
  owner: Operation | Webhook | PendingCallback;
  /** The stem of `owner` when it is an operation or webhook; a parent callback's is read once it is built. */
  ownerStem: string | undefined;
  /** How many callbacks sit between the declaring operation or webhook and this one. */
  depth: number;
  /** The `Callback` built for this entry, once its level is built. */
  node?: Callback;
  /** The stem the models were named from, once built. */
  stem?: string;
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
 * declares it (`settleStemOperationIds`). The entries are then named and
 * built one level at a time: a level's key-derived stems are prefixed with
 * the stems the level above settled on, each level reserves every name the
 * levels above minted, and the nodes of a level are attached to their
 * owners in document order — `callbacks` key order, expression order
 * within each Callback Object, then the path item's method order.
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
  for (const { owner, callbacks, label, stem } of declared) {
    collectPendingCallbacks(callbacks, label, owner, stem, 0, new Set(), pending, components, siblingDocs, {
      paths,
      webhooks,
    });
  }
  const inlineModels: Model[] = [];
  const inlineModelBundles: InlineModelBundle[] = [];
  if (pending.length === 0) return { inlineModels, inlineModelBundles };

  settleStemOperationIds(
    pending.map(({ entry }) => entry),
    'callback',
  );

  const all = new Set(reservedNames);
  const enums = new Set(reservedEnumNames);
  const deepest = Math.max(...pending.map(({ depth }) => depth));
  for (let depth = 0; depth <= deepest; depth++) {
    const level = pending.filter((candidate) => candidate.depth === depth);
    for (const candidate of level) {
      candidate.entry.parentStem = isPending(candidate.owner) ? candidate.owner.stem! : candidate.ownerStem!;
    }
    const reserved: ReservedNames = { all, enums };
    const batch = buildReceivedRequests(
      level.map(({ entry }) => entry),
      components,
      reserved,
      siblingDocs,
    );
    inlineModels.push(...batch.inlineModels);
    inlineModelBundles.push(...batch.inlineModelBundles);
    // The next level steps around everything this one minted: every model
    // and enum name, and among them the enums (which no model may take).
    for (const name of batch.names) all.add(name);
    reserveInlineEnums(batch.inlineModels.flatMap(collectModelTypeRefs), enums);
    for (const [index, { node, stem }] of batch.built.entries()) {
      const candidate = level[index]!;
      // The node `buildWebhook` made, with the expression after the key.
      const { name, ...rest } = node;
      const callback: Callback = { name, expression: candidate.entry.expression!, ...rest };
      reserveInlineEnums(collectWebhookTypeRefs(callback), enums);
      candidate.node = callback;
      candidate.stem = stem;
      const owner = isPending(candidate.owner) ? candidate.owner.node! : candidate.owner;
      owner.callbacks = [...(owner.callbacks ?? []), callback];
    }
  }
  return { inlineModels, inlineModelBundles };
}

function isPending(owner: PendingCallback['owner']): owner is PendingCallback {
  return 'entry' in owner;
}

/** Add every inline enum name among `refs` (an enum reference carrying its `values`) to `enums`. */
function reserveInlineEnums(refs: readonly TypeRef[], enums: Set<string>): void {
  for (const ref of refs) {
    walkTypeRef(ref, {
      enum: (r) => {
        if (r.values) enums.add(r.name);
      },
    });
  }
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
  depth: number,
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
          labelOf: (method) => callbackContext(label, { name: key, expression, httpMethod: method }),
        },
        components,
        siblingDocs,
      );
      for (const entry of entries) {
        const candidate: PendingCallback = { entry, owner, ownerStem, depth };
        pending.push(candidate);
        // The callback operation's own callbacks nest under it.
        collectPendingCallbacks(
          entry.op.callbacks,
          entry.label,
          candidate,
          undefined,
          depth + 1,
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
