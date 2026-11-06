/**
 * Resolution of a Path Item written as a `$ref`.
 *
 * The bundler never inlines internal refs (`dereference: false`), so an entry
 * under `paths` or `webhooks` written as `{ $ref: '#/components/pathItems/Pets' }`,
 * or as a `$ref` to another entry of either map (`#/paths/~1pets`,
 * `#/webhooks/petAdopted`; #422), reaches extraction as a Reference Object
 * with no operations, `parameters`, `servers`, `summary` or `description` of
 * its own. This module is self-contained so both maps resolve the same way,
 * through one function: `extractOperations` resolves every `paths` entry
 * before reading any of them (issue #300), and `collectWebhookEntries`
 * resolves each `webhooks` entry.
 */
import { unescapePointerFragment } from '@redocly/openapi-core';

/** Where a path item is read from, for diagnostics. */
export interface PathItemSite {
  /**
   * `'path'` for an entry under `paths`, `'webhook'` for one under
   * `webhooks`, `'callback'` for the path item under one runtime expression
   * of a Callback Object (#382).
   */
  kind: 'path' | 'webhook' | 'callback';
  /**
   * The entry's key: the path template (`/pets`), the webhook name
   * (`petAdopted`), or, for a callback, the site down to its expression
   * (`createPet.callbacks.petAdopted.{$request.body#/callbackUrl}`).
   */
  key: string;
}

/** The noun a path item site's diagnostics name it by. */
const SITE_NOUNS: Record<PathItemSite['kind'], string> = { path: 'Path', webhook: 'Webhook', callback: 'Callback' };

/**
 * The document's own `paths` and `webhooks` maps, as written: a Path Item's
 * `$ref` may name an entry of either beside a `components/pathItems` one,
 * since OpenAPI lets it point at any Path Item Object. A map that is absent,
 * or not an object, names nothing.
 */
export interface DocumentPathItems {
  paths?: unknown;
  webhooks?: unknown;
}

/**
 * The path item an entry denotes: the entry itself, or the Path Item a
 * `$ref` chain leads to — a `components/pathItems` component, or another
 * entry of the document's `paths` or `webhooks` (`pathItemRefTarget`).
 * Fields written beside a `$ref` — on the entry or on a link of its chain —
 * are not merged in: OpenAPI leaves a field present on both sides undefined,
 * and the referenced item is taken whole so the rule does not depend on
 * which fields clash. They are reported once per entry, naming the site and
 * the keys, so a `post` written beside a ref to an item that declares only
 * `get` is not lost silently; an `x-` extension beside the `$ref` is not
 * reported, since the parser reads none off a path item. Returns
 * `undefined`, after one warning naming the site, for an entry that is not
 * an object, a `$ref` that is not a string, a ref that names no Path Item
 * (into another section, deeper into an entry, or to an `x-` extension
 * under `paths`), a dangling ref, or a cycle; the caller skips the entry. A
 * dangling ref and a cycle are only reachable when the document bypassed
 * the bundler, which fails on either before parsing (`Can't resolve $ref`;
 * `Self-referencing circular pointer`).
 */
export function resolvePathItemRef(
  raw: unknown,
  componentPathItems: Record<string, Record<string, unknown>> | undefined,
  site: PathItemSite,
  documentPathItems?: DocumentPathItems,
): Record<string, unknown> | undefined {
  const label = `${SITE_NOUNS[site.kind]} "${site.key}"`;
  const seenRefs = new Set<string>();
  /** Keys written beside a `$ref` along the chain, in document order; reported once the item is resolved. */
  const droppedKeys: string[] = [];
  let current: unknown = raw;
  while (true) {
    if (!isRecord(current)) {
      console.warn(`[oagen] Warning: ${label} is not a path item object; skipping it.`);
      return undefined;
    }
    const ref = current.$ref;
    if (ref === undefined) {
      if (droppedKeys.length > 0) {
        console.warn(
          `[oagen] Warning: ${label} has fields beside its $ref (${droppedKeys.map((key) => `"${key}"`).join(', ')}) ` +
            'that are not read: the referenced path item is taken whole.',
        );
      }
      return current;
    }
    if (typeof ref !== 'string') {
      console.warn(`[oagen] Warning: ${label} has a non-string $ref; skipping it.`);
      return undefined;
    }
    for (const key of Object.keys(current)) {
      if (key !== '$ref' && !key.startsWith('x-') && !droppedKeys.includes(key)) droppedKeys.push(key);
    }
    if (seenRefs.has(ref)) {
      console.warn(
        `[oagen] Warning: Circular path item $ref chain starting at "${ref}" for ${site.kind} "${site.key}"; skipping it.`,
      );
      return undefined;
    }
    seenRefs.add(ref);
    const resolved = pathItemRefTarget(ref, componentPathItems, documentPathItems);
    if (!resolved) {
      console.warn(
        `[oagen] Warning: Unresolved path item $ref "${ref}" for ${site.kind} "${site.key}": ` +
          `no matching entry under ${documentMapOf(ref) ?? 'components/pathItems'}. Skipping the ${site.kind}.`,
      );
      return undefined;
    }
    current = resolved;
  }
}

/**
 * What one Path Item `$ref` points at: an entry of `components/pathItems`
 * (`resolveComponentRef`), or of the document's `paths` or `webhooks`, or
 * `undefined` when it points at none. A pointer into either map names one
 * entry whole: a single reference token, decoded as the bundler decodes it
 * (`unescapePointerFragment`: `~1` and `~0` unescaped, percent-escapes
 * decoded, RFC 6901 §6), so `#/paths/~1pets~1%7BpetId%7D` names
 * `/pets/{petId}`. A pointer deeper into an entry names no Path Item, and
 * nor does an `x-` key under `paths`: a specification extension, which
 * `extractOperations` never reads as a path. Shared by `resolvePathItemRef`
 * and `sentOnlyComponentNames`, which follows a path item ahead of the
 * readers.
 */
export function pathItemRefTarget(
  ref: string,
  componentPathItems: Record<string, Record<string, unknown>> | undefined,
  documentPathItems: DocumentPathItems | undefined,
): unknown {
  const map = documentMapOf(ref);
  if (!map) return resolveComponentRef(ref, 'pathItems', componentPathItems);
  const token = ref.slice(`#/${map}/`.length);
  const entries = documentPathItems?.[map];
  if (token === '' || token.includes('/') || !isRecord(entries)) return undefined;
  const key = unescapePointerFragment(token);
  if (map === 'paths' && key.startsWith('x-')) return undefined;
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
}

/** The document map a `#/paths/…` or `#/webhooks/…` pointer names an entry of; `undefined` for any other. */
function documentMapOf(ref: string): 'paths' | 'webhooks' | undefined {
  if (ref.startsWith('#/paths/')) return 'paths';
  if (ref.startsWith('#/webhooks/')) return 'webhooks';
  return undefined;
}

/**
 * The component a `#/components/<section>/<name>` pointer names, or
 * `undefined` when it points anywhere else or at nothing. The whole pointer
 * is matched, so a ref into another section never resolves off a same-named
 * entry of this one. Shared by the path item resolution above and every
 * Reference Object resolver (`followReference` in `reference-objects.ts`).
 */
export function resolveComponentRef(
  ref: string,
  section:
    | 'pathItems'
    | 'parameters'
    | 'requestBodies'
    | 'responses'
    | 'headers'
    | 'examples'
    | 'callbacks'
    | 'securitySchemes',
  components: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const prefix = `#/components/${section}/`;
  if (!ref.startsWith(prefix)) return undefined;
  // JSON Pointer escapes (RFC 6901 §4): `~1` -> `/`, then `~0` -> `~`, in that order.
  const refName = ref.slice(prefix.length).replace(/~1/g, '/').replace(/~0/g, '~');
  return refName === '' ? undefined : components?.[refName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
