/**
 * Reading a Schema Object's `$ref` (#539).
 *
 * The bundler never inlines internal refs (`dereference: false`), so every
 * schema `$ref` reaches the readers as written. A `$ref` is a JSON Pointer
 * (RFC 6901), and one into `components/schemas` names either a component —
 * `#/components/schemas/Pet`, exactly one token after the map — or a schema
 * deeper inside one: `#/components/schemas/Pet/properties/owner` is `Pet`'s
 * `owner` schema, `#/components/schemas/Pets/items` the array component's
 * items. Every reader that follows a schema `$ref` reads it through this one
 * module, so none takes a pointer's last token for a component's key (which
 * named a model `Owner` that nothing declared, or an unrelated component
 * `Owner`): `componentKeyOf` answers for the readers that ask which
 * component a `$ref` names, `schemaRefTarget` for the ones that follow it
 * to the schema it points at. A `$ref` into any other section of the
 * document — a Response, Parameter or Request Body Object is no Schema
 * Object, and a pointer under `paths` is not followed — names nothing here.
 *
 * Tokens are unescaped as RFC 6901 §4 says, `~1` to `/` before `~0` to `~`,
 * so `#/components/schemas/a~1b` names the key `a/b` and
 * `#/components/schemas/Pet/properties/x~1y` the property `x/y`.
 * Percent-escapes are left as written: a schema `$ref` is a URI fragment
 * the bundler has already decoded, and no document spells a key with them.
 */
import type { ModelRef } from '../ir/types.js';
import type { SchemaObject } from './schemas.js';

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/**
 * The reference tokens of a schema `$ref` into `components/schemas`, JSON
 * Pointer escapes undone: `['Pet']` for `#/components/schemas/Pet`, `['Pet',
 * 'properties', 'owner']` for a pointer into it. `undefined` for a `$ref`
 * that is not a string, that points anywhere else in the document, or that
 * ends at the map itself.
 */
export function schemaRefTokens(ref: unknown): string[] | undefined {
  if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF_PREFIX)) return undefined;
  const rest = ref.slice(SCHEMA_REF_PREFIX.length);
  return rest === '' ? undefined : rest.split('/').map(unescapePointerToken);
}

/** One reference token as written, its escapes undone (RFC 6901 §4): `~1` first, so `~01` is `~1` and not `/`. */
function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * The `components/schemas` key a `$ref` names — the pointer is exactly
 * `#/components/schemas/<key>` — or `undefined` for a pointer deeper into a
 * component, which names a schema and no component, and for a `$ref` into
 * another section. The one test every reader that decides by key makes
 * (whether a `$ref` is to an array, primitive or enum component, the name a
 * variant or a mapping target takes), so a pointer into `Pet` is never
 * mistaken for a component named by its last token.
 */
export function componentKeyOf(ref: unknown): string | undefined {
  const tokens = schemaRefTokens(ref);
  return tokens?.length === 1 ? tokens[0] : undefined;
}

/**
 * The schema a `$ref` points at in `schemas`: the component it names by
 * key, or the schema a deeper pointer lands on inside one
 * (`schemaAtPointer`). `undefined` when the `$ref` points outside
 * `components/schemas`, at a key the map lacks, or at no schema. The one
 * walk every reader that follows a schema `$ref` makes — to merge an
 * `allOf` member's properties, read a variant's const, take a referenced
 * schema's `example` or `default` — so a pointer is followed to the schema
 * it names wherever a component ref is followed.
 */
export function schemaRefTarget(
  ref: unknown,
  schemas: Record<string, SchemaObject> | undefined,
): SchemaObject | undefined {
  const tokens = schemaRefTokens(ref);
  if (!tokens || !schemas || !Object.hasOwn(schemas, tokens[0])) return undefined;
  const component = schemas[tokens[0]];
  return component === undefined ? undefined : schemaAtPointer(component, tokens.slice(1));
}

/**
 * Keywords under which a Schema Object holds other schemas, and how: one
 * schema (`items`), a list of them indexed by position (`allOf/0`), or a map
 * of them by name (`properties/owner`). A pointer steps from one schema to
 * the next through these alone; any other token (`type`, `enum/0`,
 * `properties` with no name after it, an `x-` key) leads to no schema.
 */
const SCHEMA_KEYWORDS: ReadonlyMap<string, 'one' | 'list' | 'map'> = new Map<string, 'one' | 'list' | 'map'>([
  ['items', 'one'],
  ['additionalProperties', 'one'],
  ['unevaluatedProperties', 'one'],
  ['unevaluatedItems', 'one'],
  ['additionalItems', 'one'],
  ['contains', 'one'],
  ['propertyNames', 'one'],
  ['not', 'one'],
  ['if', 'one'],
  ['then', 'one'],
  ['else', 'one'],
  ['allOf', 'list'],
  ['oneOf', 'list'],
  ['anyOf', 'list'],
  ['prefixItems', 'list'],
  ['properties', 'map'],
  ['patternProperties', 'map'],
  ['dependentSchemas', 'map'],
  ['$defs', 'map'],
  ['definitions', 'map'],
]);

/**
 * The schema the pointer `tokens` lead to from `root`, as RFC 6901 §4
 * evaluates them — each token a key of the object at hand, or the index of
 * a list element (digits with no leading zero; `-` names nothing) — read
 * through the keywords a schema holds schemas under (`SCHEMA_KEYWORDS`), so
 * the walk lands on a Schema Object or nothing: `[]` is `root` itself,
 * `['properties', 'owner']` its `owner` property, `['allOf', '1',
 * 'properties', 'id']` the `id` of its second `allOf` member. The walk is
 * structural and never follows a `$ref` on the way: a pointer through one
 * (`Pet/properties/owner/properties/name` where `owner` is itself a `$ref`)
 * leads nowhere, as it does for any JSON Pointer evaluator; a pointer that
 * lands on a `$ref` schema is that schema, which the reader resolves in
 * turn. `undefined` for a token that names nothing, a value that is no
 * object, and a `true`/`false` boolean schema.
 */
export function schemaAtPointer(root: SchemaObject, tokens: readonly string[]): SchemaObject | undefined {
  let current: SchemaObject = root;
  for (let index = 0; index < tokens.length; index++) {
    const keyword = tokens[index];
    const holds = SCHEMA_KEYWORDS.get(keyword);
    const value: unknown = Object.hasOwn(current, keyword) ? current[keyword] : undefined;
    let next: unknown;
    if (holds === 'one') {
      next = value;
    } else if (holds === 'list' && Array.isArray(value)) {
      const token = tokens[++index];
      next =
        token !== undefined && isArrayIndex(token) && Number(token) < value.length ? value[Number(token)] : undefined;
    } else if (holds === 'map' && isRecord(value)) {
      const token = tokens[++index];
      next = token !== undefined && Object.hasOwn(value, token) ? value[token] : undefined;
    }
    if (!isRecord(next)) return undefined;
    current = next as SchemaObject;
  }
  return current;
}

/** Whether `token` is an array index as RFC 6901 §4 spells one: `0`, or digits with no leading zero. */
function isArrayIndex(token: string): boolean {
  if (token === '0') return true;
  if (token === '' || token[0] === '0') return false;
  for (const char of token) if (char < '0' || char > '9') return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The model references `schemaToTypeRef` builds for a `$ref` that names no
 * component — a pointer deeper into one, or a `$ref` into another section
 * — each named by the `$ref` as written, a name no model can have. What
 * such a site is typed as is the type the parser gives the schema where it
 * stands (`Pet.owner`'s field type for `Pet/properties/owner`), which no
 * reader knows until every model is built, so the reference is settled
 * once they are (`resolveSchemaPointers`), in place, and until then it is
 * marked here: a merge pass never repoints it (no model carries its name),
 * and a copy keeps the mark (`cloneTypeRef`).
 */
const pendingSchemaRefs = new WeakSet<ModelRef>();

/** A reference to be settled by `resolveSchemaPointers`, named by the `$ref` it was built from. */
export function pendingSchemaRef(ref: string): ModelRef {
  const pending: ModelRef = { kind: 'model', name: ref };
  pendingSchemaRefs.add(pending);
  return pending;
}

/** Whether `ref` is a reference `resolveSchemaPointers` has yet to settle. */
export function isPendingSchemaRef(ref: ModelRef): boolean {
  return pendingSchemaRefs.has(ref);
}

/** Mark `ref` as pending: for a copy of a pending reference (`cloneTypeRef`), which a structural clone would leave unmarked. */
export function markPendingSchemaRef(ref: ModelRef): void {
  pendingSchemaRefs.add(ref);
}

/** Forget the mark once `ref` is settled into the type the pointer names. */
export function settlePendingSchemaRef(ref: ModelRef): void {
  pendingSchemaRefs.delete(ref);
}
