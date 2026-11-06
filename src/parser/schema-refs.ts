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
 * Tokens are decoded as the bundler decodes them when it checks that the
 * `$ref` resolves (`unescapePointerFragment` from `@redocly/openapi-core`,
 * which `pathItemRefTarget` reads a Path Item `$ref` with too): per token,
 * the JSON Pointer escapes undone as RFC 6901 §4 says, `~1` to `/` before
 * `~0` to `~`, then the percent-escapes a `$ref` carries as a URI fragment
 * decoded (RFC 6901 §6). So `#/components/schemas/a~1b` names the key
 * `a/b`, `#/components/schemas/Pet/properties/x~1y` the property `x/y`,
 * `#/components/schemas/Pet%20Owner` the key `Pet Owner` and
 * `#/components/schemas/Note/properties/due%20date` the property `due
 * date`. The bundler keeps the `$ref` string as written, so the parser
 * decodes it itself, and in the bundler's order, so every `$ref` the
 * bundler resolved is followed to the same place here (a `%2F` decodes
 * inside its token and never splits one).
 */
import { unescapePointerFragment } from '@redocly/openapi-core';
import type { Constraints, ModelRef, TypeRef } from '../ir/types.js';
import type { SchemaObject } from './schemas.js';

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/**
 * The reference tokens of a schema `$ref` into `components/schemas`, each
 * decoded as the bundler decodes it (`unescapePointerFragment`: the JSON
 * Pointer escapes undone, `~1` first, so `~01` is `~1` and not `/`, then
 * the percent-escapes): `['Pet']` for `#/components/schemas/Pet`, `['Pet',
 * 'properties', 'owner']` for a pointer into it, `['Pet Owner']` for
 * `#/components/schemas/Pet%20Owner`. `undefined` for a `$ref` that is not
 * a string, that points anywhere else in the document, or that ends at the
 * map itself.
 */
export function schemaRefTokens(ref: unknown): string[] | undefined {
  if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF_PREFIX)) return undefined;
  const rest = ref.slice(SCHEMA_REF_PREFIX.length);
  return rest === '' ? undefined : rest.split('/').map(unescapePointerFragment);
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

/**
 * The limits of the site a pending reference was built at — what is
 * written beside the `$ref`, with the wrapper's or `allOf` members' around
 * it, read as `schemaConstraints` reads any site (#545) — kept until the
 * reference is settled, since no `ModelRef` carries limits: the settled
 * type then carries them conjoined with the pointed schema's own, as a
 * `$ref` to a primitive component carries the component's conjoined with
 * the site's, and the field or parameter reads the same
 * (`resolveSchemaPointers`; #545 review). A copy of a pending reference
 * keeps them (`cloneTypeRef`).
 */
const pendingSiteLimits = new WeakMap<ModelRef, Constraints>();

/** Record `limits` as what the site of the pending `ref` writes around it, in place of any recorded before: an outer level's reading accounts for the inner's. */
export function recordPendingSiteLimits(ref: ModelRef, limits: Constraints | undefined): void {
  if (limits) pendingSiteLimits.set(ref, limits);
  else pendingSiteLimits.delete(ref);
}

/** The limits recorded for the site of the pending `ref`, `undefined` when it writes none. */
export function pendingSiteLimitsOf(ref: ModelRef): Constraints | undefined {
  return pendingSiteLimits.get(ref);
}

/**
 * The entries of a discriminator `mapping` whose target is a pointer
 * variant's schema, settled with that variant (#539 review). A mapping
 * target that is a pointer deeper into a component never reaches the parser
 * as written: the bundler hoists the schema it points at into a new
 * component named by the pointer's last token (`#/components/schemas/Zoo/
 * properties/dog` becomes a component `dog`, the same object `Zoo.dog` is)
 * and rewrites the target to `#/components/schemas/dog`, while a variant
 * written as that pointer is left as written. Read by key, the target would
 * name the model built for the hoisted copy (`Dog`), a model outside the
 * union, while the variant settles to the model `Zoo.dog` is built as
 * (`ZooDog`). So a site that builds a discriminated union matches each
 * explicit target's schema (`schemaRefTarget`) by identity against its
 * variants' and, for a variant that is a pointer — unnamed until it is
 * settled — records the entry here against the variant's own reference
 * (`deferMappingEntry`); once `resolveSchemaPointers` has settled the
 * variant, the entry is written as the model it names
 * (`settleDeferredMappingEntries`). A copy of the union carries its
 * entries with its copied variants (`carryDeferredMappingEntries`, from
 * `cloneTypeRef`). Keyed by the mapping object, so a mapping the IR no
 * longer holds is forgotten with it.
 */
interface DeferredMappingEntry {
  /** The discriminator value whose entry is deferred. */
  value: string;
  /** The variant the entry names: the pointer's reference, or its nullable wrapper, as the union holds it. */
  variant: TypeRef;
}

const deferredMappingEntries = new WeakMap<Record<string, string>, DeferredMappingEntry[]>();

/** Record that `mapping`'s entry for `value` names `variant`, a pointer variant to be settled, and is to be written as the model it settles to. */
export function deferMappingEntry(mapping: Record<string, string>, value: string, variant: TypeRef): void {
  const entries = deferredMappingEntries.get(mapping) ?? [];
  entries.push({ value, variant });
  deferredMappingEntries.set(mapping, entries);
}

/**
 * Carry the deferred entries of `from`'s mapping onto `to`'s, each against
 * the copy of its variant at the same position — for `cloneTypeRef`, which
 * copies a union's variants and mapping alike.
 */
export function carryDeferredMappingEntries(
  from: { variants: readonly TypeRef[]; mapping: Record<string, string> },
  to: { variants: readonly TypeRef[]; mapping: Record<string, string> },
): void {
  for (const { value, variant } of deferredMappingEntries.get(from.mapping) ?? []) {
    const index = from.variants.indexOf(variant);
    const copy = to.variants[index];
    if (copy !== undefined) deferMappingEntry(to.mapping, value, copy);
  }
}

/**
 * Write every deferred entry of `mapping` whose variant has settled to a
 * model — directly or under its nullable wrapper — as that model's name,
 * and forget the entries. An entry whose variant settled to no model (a
 * pointer to a string, or one that led nowhere) is left as the bundled
 * document spells it: the hoisted component's name, which names no variant.
 * Run once the variants are settled (`resolveSchemaPointers`).
 */
export function settleDeferredMappingEntries(mapping: Record<string, string> | undefined): void {
  if (mapping === undefined) return;
  const entries = deferredMappingEntries.get(mapping);
  if (entries === undefined) return;
  deferredMappingEntries.delete(mapping);
  for (const { value, variant } of entries) {
    const model = settledVariantModel(variant);
    if (model !== undefined && Object.hasOwn(mapping, value)) mapping[value] = model.name;
  }
}

/** The model `variant` names, directly or under its nullable wrapper, once settled; `undefined` while pending or for any other type. */
function settledVariantModel(variant: TypeRef): ModelRef | undefined {
  if (variant.kind === 'nullable') return settledVariantModel(variant.inner);
  return variant.kind === 'model' && !isPendingSchemaRef(variant) ? variant : undefined;
}

/** Whether `variant`, directly or under its nullable wrapper, is a reference `resolveSchemaPointers` has yet to settle. */
export function isPendingVariant(variant: TypeRef): boolean {
  if (variant.kind === 'nullable') return isPendingVariant(variant.inner);
  return variant.kind === 'model' && isPendingSchemaRef(variant);
}
