/**
 * Resolution of a Path Item written as a `$ref`.
 *
 * The bundler never inlines internal refs (`dereference: false`), so an entry
 * under `paths` or `webhooks` written as `{ $ref: '#/components/pathItems/Pets' }`
 * reaches extraction as a Reference Object with no operations, `parameters`,
 * `servers`, `summary` or `description` of its own. This module is
 * self-contained so both maps resolve the same way, through one function:
 * `extractOperations` resolves every `paths` entry before reading any of them
 * (issue #300), and `collectWebhookEntries` resolves each `webhooks` entry.
 */

/** Where a path item is read from, for diagnostics. */
export interface PathItemSite {
  /** `'path'` for an entry under `paths`, `'webhook'` for one under `webhooks`. */
  kind: 'path' | 'webhook';
  /** The entry's key: the path template (`/pets`) or the webhook name (`petAdopted`). */
  key: string;
}

/**
 * The path item an entry denotes: the entry itself, or the
 * `components/pathItems` component a `$ref` chain leads to. Fields written
 * beside a `$ref` — on the entry or on a link of its chain — are not merged
 * in: OpenAPI leaves a field present on both sides undefined, and the
 * referenced item is taken whole so the rule does not depend on which fields
 * clash. They are reported once per entry, naming the site and the keys, so
 * a `post` written beside a ref to an item that declares only `get` is not
 * lost silently; an `x-` extension beside the `$ref` is not reported, since
 * the parser reads none off a path item. Returns `undefined`, after one
 * warning naming the site, for an entry that is not an object, a `$ref` that
 * is not a string, a ref outside `components/pathItems` (into another
 * section, or into another `paths` entry), a dangling ref, or a cycle; the
 * caller skips the entry. A dangling ref and a cycle are only reachable when
 * the document bypassed the bundler, which fails on either before parsing
 * (`Can't resolve $ref`; `Self-referencing circular pointer`).
 */
export function resolvePathItemRef(
  raw: unknown,
  componentPathItems: Record<string, Record<string, unknown>> | undefined,
  site: PathItemSite,
): Record<string, unknown> | undefined {
  const label = `${site.kind === 'path' ? 'Path' : 'Webhook'} "${site.key}"`;
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
    const resolved = resolveComponentRef(ref, 'pathItems', componentPathItems);
    if (!resolved) {
      console.warn(
        `[oagen] Warning: Unresolved path item $ref "${ref}" for ${site.kind} "${site.key}": ` +
          `no matching entry under components/pathItems. Skipping the ${site.kind}.`,
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
 * entry of this one. Shared by the path item resolution above and the
 * webhook response resolution (`resolveResponseDescription` in `webhooks.ts`).
 */
export function resolveComponentRef(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
