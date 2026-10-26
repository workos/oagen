import type { Model, ModelRef, Enum, EnumValue, Field, TypeRef, Constraints } from '../ir/types.js';
import { walkTypeRef, collectModelTypeRefs } from '../ir/types.js';
import { toPascalCase, cleanSchemaName, stripListItemMarkers, splitWords } from '../utils/naming.js';
import { externalDocsEntry, readExternalDocs, withWrapperExternalDocs, type RawExternalDocs } from './external-docs.js';
import {
  enumShapeKey,
  enumValuesOf,
  inlineEnumDescriptionOf,
  inlineEnumExternalDocsOf,
  inlineEnumRef,
  toEnumValue,
  type EnumMember,
} from './enum-members.js';

/**
 * Module-level transform set during extractSchemas(). Used by schemaToTypeRef()
 * to apply the same name transform to $ref model/enum references.
 *
 * Receives the cleaned PascalCase name and, when the name is a
 * `components.schemas` key, the raw key exactly as spelled in the document.
 * Names oagen synthesises (inline enums, request-body variant models,
 * title-derived names) pass no second argument.
 */
let activeSchemaNameTransform: SchemaNameTransform | null = null;

/**
 * Module-level set of raw `components.schemas` keys for the spec being
 * extracted. resolveSchemaName() consults it to decide whether the name it was
 * handed is a real component key (forwarded to the transform as
 * `originalName`) or a name oagen synthesised (no `originalName`).
 */
let activeComponentSchemaKeys: Set<string> = new Set();

/**
 * The document's `components/schemas`, by raw key, while they are read —
 * for a reader that resolves a `$ref` but is handed no map of its own
 * (`schemaToTypeRef`, `mintedInlineNameEntries`), so it decides exactly as
 * the extractors, which are handed the map, decide (`readInlineAllOf`).
 * Set by `extractSchemas`, cleared with the name transform.
 */
let activeComponentSchemas: Record<string, SchemaObject> | undefined;

/** The component schema a `$ref` names, from `componentSchemas` when given, else from the document being read. */
export function componentSchemaOf(
  ref: string,
  componentSchemas?: Record<string, SchemaObject>,
): SchemaObject | undefined {
  const key = ref.split('/').pop() ?? '';
  const map = componentSchemas ?? activeComponentSchemas;
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * Module-level set of resolved schema names whose components/schemas entry is
 * an enum (`isEnumComponentSchema`: an `enum:` list, or a `oneOf`/`anyOf` of
 * string consts). Populated by extractSchemas() so schemaToTypeRef()
 * can classify a `$ref` to a top-level enum schema as `kind: 'enum'` instead of
 * `kind: 'model'`. Without this, every `$ref` was naively returned as a model
 * ref, even when the target was a shared enum like `PaginationOrder`.
 */
let activeEnumSchemaNames: Set<string> = new Set();

/**
 * Subset of `activeEnumSchemaNames` whose component schema also admits
 * `null` — via an OAS 3.1 `type: [..., 'null']` array, the OAS 3.0
 * `nullable: true` flag, or a literal `null` member in `enum:`. A `$ref` to
 * one of these resolves to `nullable(enum)` so the component's own
 * nullability survives the reference, matching the shape an inline
 * `oneOf: [{ $ref }, { type: 'null' }]` already produces.
 */
let activeNullableEnumSchemaNames: Set<string> = new Set();

/**
 * Resolved names of named-union components that admit `null`
 * (a `type: 'null'` variant, an OAS 3.1 `type` list with `'null'`, or OAS
 * 3.0 `nullable: true`). The null variant is not a member (`namedUnionMembers`
 * drops it), so, as for a nullable enum, a `$ref` to one of these resolves to
 * `nullable(model)`: the IR then says what the inline form of the same union
 * says (`nullable<union>`).
 */
let activeNullableUnionSchemaNames: Set<string> = new Set();

/**
 * What one extraction remembers about its named unions, so each is planned
 * once although the model (`namedUnionEntry`) and the extractor
 * (`extractNamedUnionVariantModels`) both read the plan, and so the
 * whole-document reads every plan makes — each component's shape and each
 * other union's variant names — are made once per document, not once per
 * union per read. Every entry is derived from the document being extracted
 * under `activeComponentSchemaKeys` and the active name transform, so the
 * memo is created where those are set (`extractSchemas`) and dropped with
 * them; outside an extraction nothing is memoized.
 */
interface NamedUnionMemo {
  /** Each named union's plan, keyed by its schema; `name` and `schemas` are checked so a different read is never served a stale plan. */
  plans: WeakMap<
    SchemaObject,
    { name: string; schemas: Record<string, SchemaObject> | undefined; plan: NamedUnionPlan | null }
  >;
  /** `schemaShapeKey` of every component schema and variant a plan compares, hashed once. */
  shapes: WeakMap<SchemaObject, string>;
  /** Each named union's inline variants named in isolation (`otherNamedUnionVariantEntries`), read by every other union's plan. */
  variantEntries: WeakMap<SchemaObject, Map<SchemaObject, InlineVariantName>>;
  /** `componentModelNames()`, resolved once. */
  componentNames?: ReadonlySet<string>;
}
let activeNamedUnionMemo: NamedUnionMemo | null = null;

/**
 * What the parser decides about an array component (`isArrayComponentEntry`),
 * decided once per extraction and read by both sides: the reference
 * (`arrayComponentTypeRef`) and the extractor (`extractArrayComponentModels`),
 * so the items' TypeRef and the models and enums minted for them agree by
 * construction — the way a named union's plan serves `namedUnionEntry` and
 * `extractNamedUnionVariantModels`.
 */
interface ArrayComponentPlan {
  /** The `components/schemas` key, as written: what a `$ref` names. */
  key: string;
  /** The key's IR name (`resolveSchemaName`): what the items are named from. */
  name: string;
  /** The component schema as written. */
  schema: SchemaObject;
  /**
   * The synthetic property the schema is typed and extracted as, under the
   * component's name: `item`, so the items mint `<Component>Item…`, or the
   * context the tree stepped to (`item_item`, `item_array_item`, numbered)
   * when a name it would mint anywhere — the item model, an object nested
   * under it, an inline enum, a union variant — is already a component's,
   * another array component's tree's, or another named union's inline
   * variant's, of a different shape (`planArrayComponent`).
   */
  context: string;
  /** `{ [context]: schema }`: the one-property object both sides read, as a named union's `memberProperties`. */
  properties: ReadonlyMap<string, SchemaObject>;
  /** Set once the self-reference warning has been printed, so it is printed once per component. */
  warnedSelfReference: boolean;
}

/** Every model and inline enum an array component's item tree mints under one context (`arrayComponentMints`). */
interface ArrayComponentMints {
  models: Model[];
  /** Each inline enum the items are or hold, by name, with its members. */
  enums: Map<string, EnumValue[]>;
}

/**
 * Every array component of the document being extracted, by its
 * `components/schemas` key as written — the key a `$ref` names, so `Notes:
 * { type: array, items: { $ref: Note } }` beside `Note: { type: object }`,
 * two keys `cleanSchemaName` resolves to one name, keep `Note` a model and
 * make `$ref: Notes` the array. Such a component becomes no `Model`; a
 * `$ref` to it resolves to the array itself, and what its items reference
 * is extracted under its resolved name. Planned in `extractSchemas` before
 * any TypeRef is built, because the component loop, the field pass, the
 * operations and the webhooks all resolve references to it, and dropped
 * with the other per-document state (`clearSchemaNameTransform`): outside
 * an extraction a `$ref` to such a key is a plain model reference, as a
 * `$ref` to an enum component is.
 */
let activeArrayComponentPlans: Map<string, ArrayComponentPlan> = new Map();

/** The array components whose reference is being built right now, so a cycle through their items is cut (`arrayComponentTypeRef`). */
const resolvingArrayComponents = new Set<string>();

/** Drop `null` from an `enum:` list — it marks nullability, it is not a member. */
function nonNullEnumValues(values: SchemaObject['enum']): (string | number)[] {
  return (values ?? []).filter((v): v is string | number => v !== null);
}

/**
 * True when an enum schema admits `null` by any OAS 3.0 / 3.1 spelling: the
 * `nullable: true` flag, a `type` list naming `'null'`, a `null` member in
 * `enum:`, or — for an enum declared as a `oneOf`/`anyOf` of `const`
 * schemas — a `type: 'null'` variant that an `enum:` list beside the union
 * does not forbid (`enumListAdmitsNull`).
 */
function isNullableEnumSchema(schema: SchemaObject): boolean {
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  return (schema.oneOf ?? schema.anyOf ?? []).some(isNullVariantSchema) && enumListAdmitsNull(schema);
}

/**
 * Whether an `enum:` list written beside a `oneOf`/`anyOf` of consts lets a
 * `type: 'null'` variant admit `null`. The keywords apply together, so a
 * list that leaves `null` out forbids it whatever the variant says; a schema
 * with no list admits it.
 */
function enumListAdmitsNull(schema: SchemaObject): boolean {
  return !Array.isArray(schema.enum) || schema.enum.includes(null);
}

/**
 * Whether a component schema is an enum: it declares an `enum:` list, or it
 * is a `oneOf`/`anyOf` whose every non-null variant is a string `const`
 * schema (`constUnionEnumMembers`) with no `allOf` and no `properties` of
 * its own — the OAS 3.1 spelling that documents and deprecates values one
 * by one. Both become an `Enum` (`extractEnum`), and a `$ref` to either
 * resolves to an `EnumRef`; the same `oneOf` written inline collapses to an
 * inline enum (`schemaToTypeRef`), so the two spellings have one shape
 * wherever they appear. A `oneOf` with any other variant — a `$ref`, an
 * object, a number const — is a named union, as before.
 */
function isEnumComponentSchema(schema: SchemaObject): boolean {
  return Boolean(schema.enum) || isConstUnionEnumSchema(schema);
}

/** The `oneOf`/`anyOf`-of-string-consts half of `isEnumComponentSchema`. */
function isConstUnionEnumSchema(schema: SchemaObject): boolean {
  if (schema.allOf || Object.keys(schema.properties ?? {}).length > 0) return false;
  return constUnionEnumMembers(schema) !== null;
}

/**
 * `{ description }` holding the first of `candidates` that is a string with
 * non-whitespace content, `{}` when none is — spread into an `EnumMember`.
 */
function descriptionEntry(...candidates: unknown[]): { description?: string } {
  const text = candidates.find((raw) => typeof raw === 'string' && raw.trim() !== '');
  return typeof text === 'string' ? { description: text } : {};
}

/**
 * The members of an enum schema in document order, each with the
 * documentation the document attaches to that one value, from whichever
 * spelling declares them: a `oneOf`/`anyOf` of string `const` schemas
 * (`constUnionEnumMembers`, an `enum:` list beside it restricting the
 * members) first, else an `enum:` list alone (`enumListMembers`). Null when
 * the schema is neither.
 */
export function enumMembersOf(schema: SchemaObject): EnumMember[] | null {
  return constUnionEnumMembers(schema) ?? enumListMembers(schema);
}

/**
 * The members an `enum:` list declares: each non-null entry (a `null` marks
 * nullability, `isNullableEnumSchema`), a number kept as one and anything
 * else as its string form, described by the schema's `x-enum-descriptions`
 * / `x-enumDescriptions` entry for it (`enumValueDescriptions`). No entry
 * is deprecated: an `enum:` list has no per-value keyword. Null when the
 * schema declares no `enum:`.
 */
function enumListMembers(schema: SchemaObject): EnumMember[] | null {
  if (!schema.enum) return null;
  const describe = enumValueDescriptions(schema);
  const members: EnumMember[] = [];
  schema.enum.forEach((raw, index) => {
    if (raw === null) return;
    const value = typeof raw === 'number' ? raw : String(raw);
    members.push({ value, ...descriptionEntry(describe(value, index)) });
  });
  return members;
}

/**
 * The members a `oneOf`/`anyOf` of string `const` schemas declares — a
 * single-member string `enum` is the same thing — once its `type: 'null'`
 * variants are set aside: each variant's `const`, with the variant's own
 * `description` and, when it says `deprecated: true`, `deprecated` (the
 * literal `true` only, as `deprecatedEntry` reads it everywhere). A member
 * whose own `description` has no content takes the schema's
 * `x-enum-descriptions` / `x-enumDescriptions` entry for it
 * (`enumValueDescriptions`), the list form read at the variant's position as
 * written. An `enum:` list written beside the union applies together with
 * it, as JSON Schema keywords do: a member whose value the list leaves out
 * is dropped (so the list may leave no member at all), and the list decides
 * whether a `type: 'null'` variant admits `null` (`enumListAdmitsNull`).
 * Null when the schema has no `oneOf`/`anyOf`, when every variant is
 * `type: 'null'`, or when any variant is anything but a string const — a
 * `$ref`, an object, a number const — since such a union is not an enum.
 */
function constUnionEnumMembers(schema: SchemaObject): EnumMember[] | null {
  const variants = (schema.oneOf ?? schema.anyOf)
    ?.map((variant, index) => ({ variant, index }))
    .filter(({ variant }) => !isNullVariantSchema(variant));
  if (!variants || variants.length === 0) return null;
  const allowed = schema.enum
    ? new Set(nonNullEnumValues(schema.enum).map((v) => (typeof v === 'number' ? v : String(v))))
    : undefined;
  const describe = enumValueDescriptions(schema);
  const members: EnumMember[] = [];
  for (const { variant, index } of variants) {
    const value =
      typeof variant.const === 'string'
        ? variant.const
        : Array.isArray(variant.enum) && variant.enum.length === 1 && typeof variant.enum[0] === 'string'
          ? variant.enum[0]
          : undefined;
    if (value === undefined) return null;
    if (allowed && !allowed.has(value)) continue;
    members.push({
      value,
      ...descriptionEntry(variant.description, describe(value, index)),
      ...deprecatedEntry(variant),
    });
  }
  return members;
}

/**
 * The per-value descriptions an enum schema's `x-enum-descriptions` or
 * `x-enumDescriptions` extension declares, as a lookup by value and position.
 * Either key may hold an object mapping each value's text form (`"5"` for a
 * numeric `5`) to its description, or a list aligned with the members as
 * written — the `enum:` entries, or the `oneOf`/`anyOf` variants, a `null`
 * entry or `type: 'null'` variant counted in its place. `x-enum-descriptions`
 * is read when it holds an object or a list, `x-enumDescriptions` otherwise;
 * an entry that is not a string with non-whitespace content, or a value with
 * no entry, describes nothing (`descriptionEntry`).
 */
function enumValueDescriptions(schema: SchemaObject): (value: string | number, index: number) => unknown {
  const raw = [schema['x-enum-descriptions'], schema['x-enumDescriptions']].find(
    (candidate) => typeof candidate === 'object' && candidate !== null,
  );
  if (raw === undefined) return () => undefined;
  if (Array.isArray(raw)) return (_value, index) => raw[index];
  const byValue = raw as Record<string, unknown>;
  return (value) => (Object.hasOwn(byValue, String(value)) ? byValue[String(value)] : undefined);
}

/** Wrap `ref` in `nullable` unless it already is one, so a nullable enum `$ref` is never double-wrapped. */
function asNullable(ref: TypeRef): TypeRef {
  return ref.kind === 'nullable' ? ref : { kind: 'nullable', inner: ref };
}

/**
 * Apply cleanSchemaName + the active transform (if any) to a raw schema name.
 * When `rawName` is a `components.schemas` key the transform also receives it
 * as `originalName`, so a consumer can opt out of normalization by returning
 * the original spelling. Names oagen synthesises (request-body variant
 * models, title-derived names, ...) are not component keys and get no
 * `originalName`.
 */
export function resolveSchemaName(rawName: string): string {
  let name = cleanSchemaName(toPascalCase(rawName));
  if (activeSchemaNameTransform) {
    const originalName = activeComponentSchemaKeys.has(rawName) ? rawName : undefined;
    name = activeSchemaNameTransform(name, originalName);
  }
  return name;
}

/**
 * Signature of the `schemaNameTransform` hook. `name` is the cleaned
 * PascalCase name; `originalName` is the `components.schemas` key exactly
 * as spelled in the document, or `undefined` for names oagen synthesises.
 * See `SchemaExtractionOptions.schemaNameTransform`.
 */
export type SchemaNameTransform = (name: string, originalName?: string) => string;

export interface SchemaExtractionOptions {
  /**
   * Custom transform for schema (model/enum) names. Called with the cleaned
   * PascalCase name and, for component schemas, the original name as spelled
   * in the document (`originalName`). Returning `originalName` opts that
   * schema out of the built-in normalization; only do so when it is a valid
   * identifier, since keys like `user-profile` are otherwise fixed by
   * cleanSchemaName. `originalName` is undefined for
   * any name oagen synthesises (inline enums, request-body variant models,
   * title-derived names).
   */
  schemaNameTransform?: SchemaNameTransform;
  /**
   * The whole OpenAPI document the schemas come from, read once up front for
   * the rules that look at every inline schema of a root at a time: a
   * title-mapped union variant keeps its bare title only when no variant of
   * another shape takes the same title under the same root
   * (`markContestedTitles`). Without it, the component schemas are the only
   * root, so a title a request body, response, header, parameter or webhook
   * payload repeats with another shape is not seen.
   */
  document?: unknown;
}

export interface SchemaObject {
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject | undefined>;
  required?: string[];
  items?: SchemaObject;
  /** OAS 3.1 allows a literal `null` member when `type` also admits null. */
  enum?: (string | number | null)[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  readOnly?: boolean;
  writeOnly?: boolean;
  nullable?: boolean;
  $ref?: string;
  additionalProperties?: boolean | SchemaObject;
  const?: unknown;
  patternProperties?: Record<string, SchemaObject>;
  deprecated?: boolean;
  default?: unknown;
  example?: unknown;
  /** JSON Schema `examples` list; OAS 3.1 deprecates `example` in its favour. */
  examples?: unknown[];
  /** An External Documentation Object as written; `readExternalDocs` decides what reaches the IR. */
  externalDocs?: RawExternalDocs;
  // JSON Schema validation vocabulary. An exclusive bound is the bound itself
  // in OAS 3.1 and, in OAS 3.0, a boolean that makes `minimum` / `maximum`
  // exclusive; extractConstraints() normalizes both to the 3.1 shape.
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minContains?: number;
  maxContains?: number;
  minProperties?: number;
  maxProperties?: number;
  dependentRequired?: Record<string, string[]>;
  [key: string]: unknown;
}

/** Validation keywords copied through unchanged when they hold a number. */
const NUMERIC_CONSTRAINT_KEYS = [
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minContains',
  'maxContains',
  'minProperties',
  'maxProperties',
] as const;

/**
 * Collect the JSON Schema validation keywords declared directly on `schema`
 * into a `Constraints` object, or `undefined` when it declares none — so a
 * schema without limits yields no `constraints` key on its IR node at all.
 *
 * Numeric bounds are normalized to the OAS 3.1 shape. OAS 3.0 spells an
 * exclusive bound as `exclusiveMinimum: true` beside `minimum: n`; that pair
 * becomes `exclusiveMinimum: n` with no `minimum`. A boolean `false`, or a
 * `true` with no bound to apply to, is dropped. The 3.1 numeric form passes
 * through, including the legal-but-unusual case of both an inclusive and an
 * exclusive bound on the same side. `uniqueItems: false` restates the default
 * and is dropped too.
 *
 * Only the schema's own keywords are read: limits nested inside array `items`
 * or map values are not collected. The one exception is a nullable wrapper —
 * a `oneOf`/`anyOf` with a single non-null, non-`$ref` branch — that declares
 * none itself: it takes that branch's keywords, since the IR collapses it to
 * `nullable<T>`. Values of the wrong type (a string `maxLength`, say) are
 * ignored rather than carried.
 */
export function extractConstraints(schema: SchemaObject): Constraints | undefined {
  // The schema's own keywords conjoined with its `allOf` members' (recursively;
  // a keyword declared at more than one level is combined by
  // combineConstraints, so the stricter bound wins). schemaToTypeRef unwraps a
  // single-member `allOf`, so `{ allOf: [{ type: 'string', maxLength: 3 }] }`
  // is a string whose limit is the value's own; a `$ref` member contributes
  // the keywords written beside the reference, but the target itself is not
  // followed — its limits stay on the referenced model.
  let out = ownConstraints(schema);
  for (const member of schema.allOf ?? []) out = combineConstraints(out, extractConstraints(member));
  // A nullable wrapper — `oneOf`/`anyOf` with exactly one non-null branch —
  // collapses to `nullable<T>` in the IR, so that branch's keywords are the
  // value's own too and conjoin with the rest. A `$ref` branch keeps its
  // limits on the referenced model, and a genuine multi-variant union carries
  // none.
  const branch = singleNonNullBranch(schema);
  return branch ? combineConstraints(out, extractConstraints(branch)) : out;
}

/** The keywords declared strictly on `schema`, normalized — without the nullable-branch fallback. */
function ownConstraints(schema: SchemaObject): Constraints | undefined {
  const out: Constraints = {};

  const lower = normalizeBound(schema.minimum, schema.exclusiveMinimum);
  if (lower.inclusive !== undefined) out.minimum = lower.inclusive;
  if (lower.exclusive !== undefined) out.exclusiveMinimum = lower.exclusive;
  const upper = normalizeBound(schema.maximum, schema.exclusiveMaximum);
  if (upper.inclusive !== undefined) out.maximum = upper.inclusive;
  if (upper.exclusive !== undefined) out.exclusiveMaximum = upper.exclusive;

  for (const key of NUMERIC_CONSTRAINT_KEYS) {
    const value = schema[key];
    if (typeof value === 'number') out[key] = value;
  }
  if (typeof schema.pattern === 'string') out.pattern = schema.pattern;
  if (schema.uniqueItems === true) out.uniqueItems = true;

  const dependentRequired = readDependentRequired(schema.dependentRequired);
  if (dependentRequired) out.dependentRequired = dependentRequired;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The one non-null, non-`$ref` branch of a `oneOf`/`anyOf`, or `undefined` for anything else. */
function singleNonNullBranch(schema: SchemaObject): SchemaObject | undefined {
  const variants = schema.oneOf ?? schema.anyOf;
  if (!variants) return undefined;
  const nonNull = variants.filter((v) => !isNullSchema(v));
  return nonNull.length === 1 && !nonNull[0].$ref ? nonNull[0] : undefined;
}

/** True for the `{ type: 'null' }` / `{ type: ['null'] }` branch of a nullable wrapper. */
export function isNullSchema(schema: SchemaObject): boolean {
  return (
    schema.type === 'null' || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === 'null')
  );
}

/**
 * `{ constraints }` when `schema` declares any validation keyword, `{}`
 * otherwise — spread into an IR node so the key stays absent rather than
 * present-but-undefined.
 */
export function constraintsEntry(schema: SchemaObject): { constraints?: Constraints } {
  const constraints = extractConstraints(schema);
  return constraints ? { constraints } : {};
}

/**
 * `{ deprecated: true }` when `schema` says so, `{}` otherwise — spread into
 * a Model or Enum so the key stays absent rather than present-but-false. Read
 * the way `Field.deprecated` is: only the schema's own top-level keyword, and
 * only the literal `true` — `deprecated: "yes"` is not a declaration, as it
 * is not on a field, parameter, operation or header.
 */
export function deprecatedEntry(schema: SchemaObject): { deprecated?: boolean } {
  return schema.deprecated === true ? { deprecated: true } : {};
}

/**
 * Strip the nullable wrappers `schemaToTypeRef` unwraps before it names
 * anything — the OAS 3.1 `type: [X, 'null']` array, the OAS 3.0
 * `nullable: true` flag, and a `oneOf`/`anyOf` with a single non-null
 * variant — so extraction dispatches on the same shape the TypeRef was built
 * from. The unwrap keeps `contextName`/`parentModelName` semantics intact:
 * `schemaToTypeRef` passes both through each of these wrappers unchanged.
 */
export function unwrapNullableSchema(schema: SchemaObject): SchemaObject {
  if (schema.$ref) return schema;
  // `properties` beside a typing composition are folded into it before any
  // wrapper is stripped (`foldSiblingProperties`), so a nullable union
  // written beside them collapses onto a variant that already carries them,
  // and every site dispatches on the one shape `schemaToTypeRef` typed.
  const folded = foldSiblingProperties(schema);
  if (Array.isArray(folded.type)) {
    const nonNullTypes = folded.type.filter((t) => t !== 'null');
    if (nonNullTypes.length !== 1) return folded;
    return unwrapNullableSchema({ ...folded, type: nonNullTypes[0], nullable: false });
  }
  if (folded.nullable && folded.type) {
    return unwrapNullableSchema({ ...folded, nullable: false });
  }
  // A nullable union collapses onto its one non-null variant — decided by
  // `nullableUnionBranch`, the same definition `collapsedNullableBranch`
  // checks, so the check and the unwrap cannot disagree.
  const branch = nullableUnionBranch(folded);
  return branch ? unwrapNullableSchema(branch) : folded;
}

/**
 * The one variant a nullable `oneOf`/`anyOf` wrapper collapses to: what is
 * left once every `null` variant (`isNullSchema` — `{ type: 'null' }` or
 * `{ type: ['null'] }`, however many of either) is discarded, when at least
 * one was and exactly one variant remains. The single definition of a
 * nullable union wrapper on the model side, shared by `unwrapNullableSchema`
 * and `collapsedNullableBranch`. `undefined` otherwise: no union, a union
 * under `allOf` (which `schemaToTypeRef` gives precedence), no `null`
 * variant, or more than one non-null variant. Exported for the response
 * path, which wraps an array it builds itself in `nullable` exactly when
 * `schemaToTypeRef` would (`nullableIf`).
 */
export function nullableUnionBranch(schema: SchemaObject): SchemaObject | undefined {
  const variants = schema.allOf ? undefined : (schema.oneOf ?? schema.anyOf);
  if (!variants) return undefined;
  const nonNull = variants.filter((v) => !isNullSchema(v));
  return nonNull.length === 1 && nonNull.length < variants.length ? nonNull[0] : undefined;
}

/**
 * The array schema `schema` is, once a nullable wrapper of any spelling is
 * removed — an OAS 3.1 type list naming `null` (`type: ['array', 'null']`),
 * OAS 3.0 `nullable: true`, or a `oneOf`/`anyOf` with one non-null variant,
 * written with or without `items` beside it — and `undefined` when it is
 * not an array: `unwrapNullableSchema`, the one definition the model side
 * unwraps by, then `isArraySchema`, the one test every site makes. So a
 * list envelope's data array, an array response body and an `allOf`-merged
 * array property are arrays here whatever wrapper they wear, as
 * `schemaToTypeRef` types them `nullable<array<…>>`. A `$ref` is a reference
 * and is not looked through: a `$ref` to an array component is typed as the
 * array the component declares by `schemaToTypeRef` itself, with the items
 * the component pass built (`isArrayComponentRef` says whether a property
 * is one), and the explicit `dataPath` walk (`resolveBareSchema`) is the one
 * place any other reference is followed.
 */
export function arraySchemaOf(schema: SchemaObject): SchemaObject | undefined {
  const bare = unwrapNullableSchema(schema);
  return isArraySchema(bare) ? bare : undefined;
}

/**
 * Whether `schemaToTypeRef` wraps the schema's own type in `nullable`: an OAS
 * 3.1 type list naming `null` (`type: ['array', 'null']`), an OAS 3.0
 * `nullable: true` beside a `type`, or a `oneOf`/`anyOf` that collapses to
 * one non-null variant (`nullableUnionBranch`). The one test for the places
 * the response path builds an array TypeRef itself (`nullableIf`) or merges
 * two array declarations (`combineDeclarations`).
 */
export function declaresNull(schema: SchemaObject): boolean {
  return (
    (Array.isArray(schema.type) && schema.type.includes('null')) ||
    (schema.nullable === true && schema.type !== undefined) ||
    nullableUnionBranch(schema) !== undefined
  );
}

/**
 * `unwrapNullableSchema` for a schema a model is built from, carrying the
 * wrapper's limits, `deprecated` and `externalDocs` onto the branch it
 * unwraps to. The type-array and `nullable: true` forms unwrap by spreading,
 * so every keyword survives; the union form swaps in the bare branch, which
 * would drop a `minProperties` or `deprecated: true` written beside
 * `anyOf: [{ type: 'object', … }, { type: 'null' }]`. `extractConstraints`
 * conjoins that wrapper's own keywords with its branch's as the field's
 * limits, and `Field.deprecated` is the wrapper's, so the model built from the
 * branch must carry the same ones or it would disagree with its field; the
 * wrapper's link rides along the same way (`withWrapperExternalDocs`). Every
 * extractor that builds a model from a nullable wrapper's branch — the field
 * extractor, `extractNestedSchema`, `extractInlineModelDeep`, the request-body
 * and wrapped-response paths — goes through this one function, so the
 * copies they produce agree and the inline-model merges cannot keep a wrongly
 * flagged one. Returns `schema` itself when there is nothing to unwrap, and a
 * copy whenever a wrapper was stripped — a copy that still carries the union
 * when a multi-variant `oneOf`/`anyOf` sits beside `type: [X, 'null']`, so
 * identity with `schema` does not tell whether a union collapsed to one
 * branch; `collapsedNullableBranch` does.
 */
export function unwrapNullableField(schema: SchemaObject): SchemaObject {
  const inner = unwrapNullableSchema(schema);
  if (inner === schema || schema.allOf || !(schema.oneOf ?? schema.anyOf)) return inner;
  return withWrapperExternalDocs(withWrapperDeprecation({ ...inner, ...extractConstraints(schema) }, schema), schema);
}

/**
 * The one branch a nullable `oneOf`/`anyOf` wrapper collapses to, carrying
 * the wrapper's `deprecated` and limits (`unwrapNullableField`), or
 * `undefined` when `schema` is not such a wrapper: not a union, or a union
 * with more than one non-null variant — nullable or not, including
 * `type: ['object', 'null']` beside a multi-variant `oneOf`. Decided at the
 * wrapper's level alone, by `nullableUnionBranch` — the very definition
 * `unwrapNullableSchema` collapses by, so the check and the unwrap cannot
 * disagree: the union collapses iff discarding every `null` variant, however
 * many and however spelled, leaves exactly one, whatever that variant
 * contains — a branch's own nested `oneOf`/`anyOf` (a union of constraint
 * sets beside its properties, say) is the branch's business and is built as
 * written, flag and limits carried. A multi-variant union is never
 * collapsed: each variant is its own schema, built as itself with its own
 * flag, and the wrapper's stays on the field. The sites that build a model
 * from a union's variants substitute the branch this returns for the one
 * variant it stands for, and otherwise build every variant as written.
 */
export function collapsedNullableBranch(schema: SchemaObject): SchemaObject | undefined {
  return nullableUnionBranch(schema) ? unwrapNullableField(schema) : undefined;
}

/**
 * `inner` carrying the wrapper's `deprecated` in place of its own. A wrapper
 * the parser collapses — a nullable `oneOf`/`anyOf`, a single-member `allOf`
 * — is the field's schema, and `Field.deprecated` reads only that top-level
 * keyword, so the model built from what it unwraps to carries the same flag
 * the field does: the wrapper's, never the branch's or the member's own.
 */
export function withWrapperDeprecation(inner: SchemaObject, wrapper: SchemaObject): SchemaObject {
  const result: SchemaObject = { ...inner, ...deprecatedEntry(wrapper) };
  if (wrapper.deprecated !== true) delete result.deprecated;
  return result;
}

/**
 * `inner` carrying the wrapper's documentation — its `description` and its
 * link — for the type `schemaToTypeRef` builds from it. A wrapper the
 * builder collapses (a nullable `oneOf`/`anyOf`, a single-member `allOf`) is
 * the schema the document wrote for the property, parameter, header or
 * body, so an inline enum lifted from the branch documents itself by the
 * wrapper's text and link when the wrapper has them, and by the branch's
 * own only when it does not: the same precedence for both keys, decided
 * here once. The text counts when it has non-whitespace content, as
 * `inlineEnumRef` reads it; the link when it is usable
 * (`withWrapperExternalDocs`). Read by the two wrapper sites of
 * `schemaToTypeRef` and by the response path where it types the member of
 * a single-member `allOf` body it unwrapped itself (`extractDirectResource`).
 * The model extractors unwrap through `unwrapNullableField` and
 * `unwrappedAllOfMember`, which carry the link and leave the branch's own
 * `description` on the model.
 */
export function withWrapperDocs(inner: SchemaObject, wrapper: SchemaObject): SchemaObject {
  const linked = withWrapperExternalDocs(inner, wrapper);
  const described = typeof wrapper.description === 'string' && wrapper.description.trim() !== '';
  return described ? { ...linked, description: wrapper.description } : linked;
}

/** Keywords where the stricter of two declarations is the larger value. */
const MIN_KEYS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minContains', 'minProperties'] as const;
/** Keywords where the stricter of two declarations is the smaller value. */
const MAX_KEYS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxContains', 'maxProperties'] as const;

/**
 * Conjoin two constraint sets the way `allOf` conjoins schemas: an instance
 * must satisfy both, so every `min*` takes the larger value, every `max*` the
 * smaller, `uniqueItems` holds if either side demands it, and
 * `dependentRequired` merges per property with the union of its names
 * (deduplicated, `a`'s order first). A keyword declared on one side only is
 * kept as is, and an absent side yields the other unchanged.
 *
 * `multipleOf` and `pattern` keep `a`'s value when the two differ: a true
 * conjunction would need the least common multiple, or a lookahead regex
 * joining both patterns, and neither is worth carrying into the IR.
 *
 * Not for the parameter `$ref` fallback in extractParams: keywords written
 * beside a `$ref` override the target's there, which is a different operation.
 */
export function combineConstraints(a: Constraints | undefined, b: Constraints | undefined): Constraints | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Constraints = { ...a, ...b };
  for (const key of MIN_KEYS) {
    const [x, y] = [a[key], b[key]];
    if (x !== undefined && y !== undefined) out[key] = Math.max(x, y);
  }
  for (const key of MAX_KEYS) {
    const [x, y] = [a[key], b[key]];
    if (x !== undefined && y !== undefined) out[key] = Math.min(x, y);
  }
  if (a.uniqueItems || b.uniqueItems) out.uniqueItems = true;
  if (a.multipleOf !== undefined && b.multipleOf !== undefined) out.multipleOf = a.multipleOf;
  if (a.pattern !== undefined && b.pattern !== undefined) out.pattern = a.pattern;
  if (a.dependentRequired && b.dependentRequired) {
    out.dependentRequired = unionDependentRequired(a.dependentRequired, b.dependentRequired);
  }
  return out;
}

/** Per-property union of two `dependentRequired` maps, deduplicated and keeping `a`'s order first. */
function unionDependentRequired(a: Record<string, string[]>, b: Record<string, string[]>): Record<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const [property, names] of Object.entries(a)) merged.set(property, [...names]);
  for (const [property, names] of Object.entries(b)) {
    const existing = merged.get(property);
    if (!existing) {
      merged.set(property, [...names]);
      continue;
    }
    for (const name of names) if (!existing.includes(name)) existing.push(name);
  }
  return Object.fromEntries(merged);
}

/**
 * Resolve one side's bound from `minimum` / `maximum` plus its `exclusive*`
 * companion into the OAS 3.1 shape: a numeric companion is the exclusive
 * bound itself, `true` turns the inclusive bound into the exclusive one, and
 * `false` or absent leaves the inclusive bound as is.
 */
function normalizeBound(inclusive: unknown, exclusive: unknown): { inclusive?: number; exclusive?: number } {
  const bound = typeof inclusive === 'number' ? inclusive : undefined;
  if (typeof exclusive === 'number') return { inclusive: bound, exclusive };
  if (exclusive === true) return { exclusive: bound };
  return { inclusive: bound };
}

/** Copy `dependentRequired` when it is an object whose values are string arrays; anything else is ignored. */
function readDependentRequired(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries: [string, string[]][] = [];
  for (const [property, deps] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(deps) && deps.every((d): d is string => typeof d === 'string'))
      entries.push([property, [...deps]]);
  }
  // Object.fromEntries creates an own property for every key. Assigning
  // `out[property]` on a literal would instead set the prototype for a
  // dependency named `__proto__` and silently drop it.
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Narrow a raw `examples` value to a non-empty list, or undefined. Guards
 * against documents that put an OAS Example Object map (or anything else)
 * where JSON Schema expects an array, and against an empty list, so the IR
 * carries `examples` only when there is at least one value.
 */
export function nonEmptyExamples(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

/**
 * Pick the single `example` the IR carries: the document's own `example`
 * when it is set (including an explicit `null`), otherwise the first entry
 * of the resolved `examples` list.
 */
export function pickExample(example: unknown, examples: unknown[] | undefined): unknown {
  return example !== undefined ? example : examples?.[0];
}

/** One source of example values, e.g. a parameter's own declaration or its schema. */
export interface ExampleSource {
  example: unknown;
  examples: unknown[] | undefined;
}

/**
 * Resolve `example` and `examples` across ordered precedence levels: for a
 * parameter its own declaration, its inline schema, then the component its
 * `$ref` points at; for a field its own schema, then its `$ref` target.
 *
 * Each value walks the levels independently. `examples` is the first
 * non-empty list. `example` comes from the first level that has either an
 * `example` or a list, preferring that level's own `example` over its first
 * list entry — so a schema-level `example` can never mask the parameter's
 * own `examples` map. A level with neither falls through; an explicit
 * `null` is a value and stops the walk.
 */
export function resolveExamples(levels: ExampleSource[]): ExampleSource {
  let example: unknown;
  let examples: unknown[] | undefined;
  for (const level of levels) {
    if (examples === undefined) examples = level.examples;
    if (example === undefined) example = pickExample(level.example, level.examples);
  }
  return { example, examples };
}

/**
 * If a schema is a `$ref` to `#/components/schemas/X`, return the referenced
 * component schema. Used to surface schema-level metadata (default, example,
 * examples, deprecated, description) that would otherwise be invisible at the
 * field or parameter level.
 *
 * Refs are not pre-resolved by the bundler (`dereference: false` in refs.ts),
 * so without this, a param like `schema: { $ref: '.../PaginationOrder' }`
 * silently loses the target's `default: desc` and the SDK stops emitting the
 * spec-mandated default value in generated method signatures.
 */
export function resolveComponentSchemaRef(
  schema: SchemaObject | undefined,
  componentSchemas: Record<string, SchemaObject> | undefined,
): SchemaObject | undefined {
  if (!schema || !componentSchemas) return undefined;
  const ref = (schema as { $ref?: string }).$ref;
  if (!ref) return undefined;
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) return undefined;
  return componentSchemas[match[1]];
}

export interface ExtractedSchemas {
  models: Model[];
  enums: Enum[];
}

export function extractSchemas(
  schemas: Record<string, SchemaObject> | undefined,
  options?: SchemaExtractionOptions,
): ExtractedSchemas {
  const enums: Enum[] = [];

  if (!schemas) {
    // No components, so no name transform is activated for this document;
    // the titles are resolved here as they will be when the operations are
    // typed, without one.
    markContestedTitles(options?.document);
    return { models: [], enums };
  }

  // Record the raw component keys first so every resolveSchemaName() call
  // below (including the collision probe) can tell a real component key from
  // a name oagen synthesised.
  activeComponentSchemaKeys = new Set(Object.keys(schemas));
  activeComponentSchemas = schemas;
  // A new document: the references an `allOf` merge inherits from a
  // component's property (`inheritedModelRefsOf`) are recorded per document,
  // and so are the unions whose uncarried `properties` were reported.
  resetInheritedModelRefs();
  resetFoldWarnings();

  // Build collision-safe transform if provided. The transform is probed with
  // the same (cleaned, raw) pair resolveSchemaName() will hand it, so a
  // transform that keys off the original spelling is collision-checked on the
  // names it will actually produce. Collisions are tracked by raw key: two raw
  // keys may clean to the same name yet transform to different ones (e.g.
  // `Users`/`User` with an originalName-based transform), and marking the
  // shared cleaned name unsafe would wrongly disable the transform for both.
  if (options?.schemaNameTransform) {
    const transform = options.schemaNameTransform;
    const transformedToRawKeys = new Map<string, string[]>();
    for (const raw of Object.keys(schemas)) {
      const transformed = transform(cleanSchemaName(toPascalCase(raw)), raw);
      if (!transformedToRawKeys.has(transformed)) transformedToRawKeys.set(transformed, []);
      transformedToRawKeys.get(transformed)!.push(raw);
    }
    // Raw keys whose transformed output is shared with another raw key, plus
    // their cleaned names. Component keys are guarded by raw key; synthesised
    // names (no originalName) keep the cleaned-name guard they always had.
    const unsafeRawKeys = new Set<string>();
    const unsafeCleanedNames = new Set<string>();
    for (const [, rawKeys] of transformedToRawKeys) {
      if (rawKeys.length > 1) {
        for (const raw of rawKeys) {
          unsafeRawKeys.add(raw);
          unsafeCleanedNames.add(cleanSchemaName(toPascalCase(raw)));
        }
      }
    }
    activeSchemaNameTransform = (name: string, originalName?: string) => {
      const unsafe = originalName !== undefined ? unsafeRawKeys.has(originalName) : unsafeCleanedNames.has(name);
      return unsafe ? name : transform(name, originalName);
    };
  } else {
    activeSchemaNameTransform = null;
  }

  // Before any field is typed: which title-mapped variants must not keep
  // their title because another shape takes it under the same root. Decided
  // with the name transform active, since the titles are compared by the
  // names they resolve to. The component schemas are read as one root; every
  // other inline schema of the document is a root of its own.
  markContestedTitles(options?.document ?? { components: { schemas } });

  // Pre-compute the set of resolved names whose component schema is an enum so
  // schemaToTypeRef() can classify `$ref` targets correctly. Built in a separate
  // pass because the per-schema loop mutates models/enums and we want this map
  // available before any TypeRef is resolved (operations + nested fields both
  // call schemaToTypeRef during extraction).
  activeEnumSchemaNames = new Set();
  activeNullableEnumSchemaNames = new Set();
  activeNullableUnionSchemaNames = new Set();
  activeNamedUnionMemo = { plans: new WeakMap(), shapes: new WeakMap(), variantEntries: new WeakMap() };
  for (const [name, schema] of Object.entries(schemas)) {
    const resolved = resolveSchemaName(name);
    if (isEnumComponentSchema(schema)) {
      activeEnumSchemaNames.add(resolved);
      if (isNullableEnumSchema(schema)) activeNullableEnumSchemaNames.add(resolved);
    } else if (isNamedUnionSchema(schema) && isNullableUnionSchema(schema)) {
      activeNullableUnionSchemaNames.add(resolved);
    }
  }

  // The array components, planned once the sets above are complete, in
  // rounds until the plans settle. Every tree starts under `item`. A round
  // registers every tree under its current context — so a `$ref` to an
  // array component resolves to its array in every rehearsal, the typing the
  // real pass uses, which tells `{ value: { $ref: Notes } }` from `{ value:
  // { $ref: Note } }` as `array<Note>` and `Note` — reads every name every
  // other entry takes (`componentMints`) and every tree's names under its
  // context (`arrayComponentMints`; the names a tree mints are read with
  // none registered, so another component's items are never counted as its
  // own), then decides the trees one at a time in the order of their keys
  // sorted by code point — never the document's — each against every
  // component and every other tree's current names (`planArrayComponent`),
  // re-registering a tree that moves so the trees after it resolve its
  // items under its new name. A round that moves nothing is the last: every
  // shape was then compared under the names the plans settle on, so a tree
  // whose items reference another tree is never shared on a provisional
  // name (`array<PaletteItem>`) that the other tree then steps away from
  // (`array<PaletteItemItem>`), and no two trees end on one name for
  // different shapes, whatever the document's order. A `$ref` to an array
  // component — from a component field, a named union's variant, an
  // operation or a webhook — is then typed from its plan, by the key it
  // names.
  activeArrayComponentPlans = new Map();
  const arrayComponents = Object.entries(schemas)
    .filter(([, schema]) => !isEnumComponentSchema(schema) && isArrayComponentEntry(schema, schemas))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (arrayComponents.length > 0) {
    const contexts = new Map(arrayComponents.map(([key]) => [key, 'item']));
    const register = (): void => {
      activeArrayComponentPlans = new Map(
        arrayComponents.map(([key, schema]) => [key, arrayComponentPlan(key, schema, contexts.get(key)!)] as const),
      );
    };
    let settled = false;
    for (let round = 0; round < MAX_ARRAY_COMPONENT_ROUNDS && !settled; round++) {
      register();
      const minted = new Map(
        Object.entries(schemas).map(([key, schema]) => [key, componentMints(key, schema, schemas)] as const),
      );
      const current = new Map(
        arrayComponents.map(
          ([key, schema]) =>
            [key, arrayComponentMints(resolveSchemaName(key), schema, schemas, contexts.get(key)!)] as const,
        ),
      );
      settled = true;
      for (const [key, schema] of arrayComponents) {
        const name = resolveSchemaName(key);
        const own =
          contexts.get(key) === 'item' ? current.get(key)! : arrayComponentMints(name, schema, schemas, 'item');
        const others = new Map(current);
        others.delete(key);
        const context = planArrayComponent(name, schema, schemas, own, others, minted);
        if (context === contexts.get(key)) continue;
        settled = false;
        contexts.set(key, context);
        activeArrayComponentPlans.set(key, arrayComponentPlan(key, schema, context));
        current.set(key, arrayComponentMints(name, schema, schemas, context));
      }
    }
    if (!settled) {
      console.warn(
        `[oagen] Warning: The item names of the array components did not settle in ${MAX_ARRAY_COMPONENT_ROUNDS} rounds — keeping the last decision`,
      );
    }
    register();
  }

  const modelsByCleanName = new Map<string, Model>();
  // Keep the model with more fields when names collide after cleaning
  // (two raw keys cleaning to one name), or when two inline models — a
  // discriminated-allOf variant's, a named union's, an array component's
  // items' — take one name.
  const keepLarger = (model: Model): void => {
    const existing = modelsByCleanName.get(model.name);
    if (!existing || model.fields.length > existing.fields.length) modelsByCleanName.set(model.name, model);
  };
  // The key whose own model holds each name, so two keys that resolve to
  // one name are told apart from a component and a variant of its own. Two
  // such keys are one model only when their shapes agree
  // (`modelFingerprint`: fields, types, limits); equal field counts say
  // nothing, so a definition that differs is reported before it is dropped,
  // as `keepLargestByName` reports one.
  const componentKeysByName = new Map<string, string>();
  const keepComponent = (key: string, model: Model): void => {
    const other = componentKeysByName.get(model.name);
    const existing = modelsByCleanName.get(model.name);
    if (other !== undefined && existing && modelFingerprint(existing) !== modelFingerprint(model)) {
      const kept =
        model.fields.length > existing.fields.length
          ? 'keeping the one with more fields'
          : 'keeping the first definition';
      console.warn(
        `[oagen] Warning: Component schemas "${other}" and "${key}" both resolve to "${model.name}" with different fields or field types (${existing.fields.length} vs ${model.fields.length}) — ${kept}`,
      );
    }
    if (other === undefined) componentKeysByName.set(model.name, key);
    keepLarger(model);
  };

  for (const [name, schema] of Object.entries(schemas)) {
    const pascalName = resolveSchemaName(name);

    if (isEnumComponentSchema(schema)) {
      enums.push(extractEnum(pascalName, schema));
    } else if (activeArrayComponentPlans.has(name)) {
      // No model of its own: a `$ref` to it is the array (`arrayComponentTypeRef`).
      for (const inlineModel of extractArrayComponentModels(name, schemas)) keepLarger(inlineModel);
    } else {
      keepComponent(name, extractModel(pascalName, schema, schemas));

      for (const inlineModel of [
        ...extractDiscriminatedAllOfVariantModels(schema, pascalName, schemas),
        ...extractNamedUnionVariantModels(schema, pascalName, schemas),
      ]) {
        keepLarger(inlineModel);
      }
    }
  }

  const models = [...modelsByCleanName.values()];

  // Collect inline models from nested object/oneOf properties
  // that schemaToTypeRef created model refs for but weren't extracted
  const modelNames = new Set(models.map((m) => m.name));
  const inlineQueue: Model[] = [...models];
  while (inlineQueue.length > 0) {
    const model = inlineQueue.pop()!;
    for (const field of model.fields) {
      collectNestedInlineModels(field.type, field.name, model.name, schemas ?? {}, models, modelNames, inlineQueue);
    }
  }

  // Collect inline enums from model fields and named-union variants. One
  // whose name a model extracted here owns (`Pet.kind` beside a `PetKind`
  // object) is left on its ref: `collectInlineEnumsFromModels` promotes it
  // under a distinct name once every model is known, as it does any clash.
  for (const model of models) {
    collectInlineEnums(model, enums, modelNames);
  }
  // ...and from every array component's items, which no model holds: the
  // reference side types them, so an array of an inline enum lifts its enum
  // whether or not anything refers to the component, as a named union's
  // variant enum lifts through `variants`.
  for (const name of activeArrayComponentPlans.keys()) {
    const ref = arrayComponentTypeRef(name);
    if (ref) collectInlineEnumFromRef(ref, enums, new Set(enums.map((e) => e.name)));
  }

  // NOTE: activeSchemaNameTransform is intentionally NOT cleared here.
  // extractOperations() calls schemaToTypeRef() for $ref resolution and
  // needs the same transform active. parseSpec() calls clearSchemaNameTransform()
  // after all extraction is complete.
  activeNamedUnionMemo = null;
  return { models, enums };
}

/** Clear the module-level schemaNameTransform. Called by parseSpec() after all extraction phases. */
export function clearSchemaNameTransform(): void {
  activeSchemaNameTransform = null;
  activeEnumSchemaNames = new Set();
  activeNullableEnumSchemaNames = new Set();
  activeNullableUnionSchemaNames = new Set();
  activeComponentSchemaKeys = new Set();
  activeComponentSchemas = undefined;
  activeNamedUnionMemo = null;
  activeArrayComponentPlans = new Map();
  markContestedTitles(undefined);
}

/**
 * Walk a single TypeRef and extract inline enum refs as top-level enum definitions.
 * Shared by both schemas.ts (field-level) and parse.ts (model-level) collection passes.
 *
 * The lifted `Enum` carries the `description` and link its schema declared
 * and each value's own `description` and `deprecated` (recorded against the
 * ref by `inlineEnumRef`), like a component enum. This is the one place an
 * inline enum becomes an `Enum`, whatever declared it — a property, a
 * parameter, a response header, a request, response, error or secondary
 * body, a webhook parameter or payload — so every site documents its enum
 * by one rule. The first ref lifted under a name decides the enum, its
 * `description`, link and value documentation included — the same
 * first-wins rule `seen` applies to the values — so a key is absent when
 * that schema declared no text or usable link, even if a later same-named
 * one does.
 */
export function collectInlineEnumFromRef(ref: TypeRef, enums: Enum[], seen: Set<string>): void {
  walkTypeRef(ref, {
    enum: (r) => {
      if (r.values && !seen.has(r.name)) {
        seen.add(r.name);
        const description = inlineEnumDescriptionOf(r);
        const externalDocs = inlineEnumExternalDocsOf(r);
        enums.push({
          name: r.name,
          ...(description !== undefined ? { description } : {}),
          values: enumValuesOf(r),
          ...(externalDocs ? { externalDocs } : {}),
        });
      }
    },
  });
}

/**
 * Walk a model's type refs (its fields' types and, for a named union, its
 * variants) and extract inline enum refs as top-level enum definitions,
 * skipping one whose name is in `modelNames`: a model and an enum must never
 * share a name, and the collision-aware model pass
 * (`collectInlineEnumsFromModels`) renames and promotes that one later.
 * This ensures type alias files are generated for inline enums.
 */
function collectInlineEnums(model: Model, enums: Enum[], modelNames: ReadonlySet<string>): void {
  const seen = new Set(enums.map((e) => e.name));
  for (const ref of collectModelTypeRefs(model)) {
    walkTypeRef(ref, {
      enum: (r) => {
        if (!modelNames.has(r.name)) collectInlineEnumFromRef(r, enums, seen);
      },
    });
  }
}

/**
 * Walk a TypeRef tree and extract inline models for any model refs that point
 * to schemas with inline object properties (not in components/schemas).
 * This handles nested objects like `totp: { oneOf: [{ type: object, properties: {...} }] }`
 * that schemaToTypeRef turns into model refs but aren't extracted from components.
 */
function collectNestedInlineModels(
  ref: TypeRef,
  fieldName: string,
  parentModelName: string,
  schemas: Record<string, SchemaObject>,
  models: Model[],
  modelNames: Set<string>,
  queue: Model[],
): void {
  // `extractNestedSchema` names what it extracts from the ref it is handed, so
  // it is only right for refs the field schema produces directly — its own
  // object, its array items, or its union variants. A ref deeper in the tree
  // (the items of a variant's array member, a nested union) is named from its
  // enclosing variant; handing it over here would re-derive the variants'
  // names from it and register them under the wrong names. Those models come
  // from the field extractor, which names them by construction.
  const directRefs = directModelRefNames(ref);
  walkTypeRef(ref, {
    model: (modelRef) => {
      if (modelNames.has(modelRef.name)) return; // already extracted
      if (!directRefs.has(modelRef.name)) return; // nested under a variant — field extractor's
      // Check if this model name corresponds to a component schema
      // by checking all possible original names that would map to this PascalCase name
      const isComponent = Object.keys(schemas).some((k) => resolveSchemaName(k) === modelRef.name);
      if (isComponent) return; // will be extracted from components

      // This is a reference to a nested inline model that wasn't extracted.
      // Look up the field schema in the parent model's component schema to extract it.
      const parentSchema = findSchemaByName(parentModelName, schemas);
      if (!parentSchema) return;

      // The declaration the field was typed from, never another member's.
      const fieldSchema = componentFieldSchema(fieldName, parentModelName, parentSchema, schemas);
      if (!fieldSchema) return;

      // Extract inline models from the field schema. A union's variants are
      // named from the field's own qualified name — `extractModel` and
      // `extractAllOfModel` type every field of a component, inherited ones
      // included, under the component — which is also variant 0's name
      // unless variant 0 took its title (`CircleDrawingShape`). Rebuild the
      // base from the field rather than reading it off the ref, and keep the
      // ref as the base only if the rebuilt one does not reproduce it. The
      // variants also step around the names the component's other properties
      // mint, as the field's TypeRef did, so derive that set from the same
      // sibling set `extractModel` typed the field with.
      const reserved = reservedInlineNames(fieldName, collectProperties(parentSchema, schemas), parentModelName);
      const baseName = unionBaseName(modelRef.name, fieldName, fieldSchema, parentModelName, reserved);
      if (baseName === null) return; // a union's non-object variant — field extractor's
      const extracted = extractNestedSchema(baseName, fieldSchema, schemas, reserved);
      for (const m of extracted) {
        if (!modelNames.has(m.name)) {
          models.push(m);
          modelNames.add(m.name);
          queue.push(m); // re-scan for deeper nesting
          // Remembered by the field it was read from, so the field's site
          // can claim it by origin rather than by name when the field
          // extractor's copy of the same schema is settled
          // (`fieldInlineModelBundles`): `Foo.barThing` and `FooBar.thing`
          // both spell `FooBarThing`, and only one of them is lifted.
          recordLiftedFieldModel(parentModelName, fieldName, m);
        }
      }
    },
  });
}

/**
 * The base name `extractNestedSchema` should name a field's `oneOf` variants
 * from: `refName` itself (the ref the walk is resolving) for every non-union
 * field, and for a union field the field's qualified inline name when naming
 * the inline object variants from it yields `refName`. Null for a union
 * field whose inline object variants are not named `refName`: the ref was
 * minted for one of the union's other variants — a nullable wrapper around
 * an object, an `allOf`, a nested union — which `schemaToTypeRef` typed under
 * a context of its own (`nonObjectVariantContexts`) and which only the field
 * extractor materializes; naming the union's object variants from such a ref
 * would register variant 0's fields under the other variant's name.
 */
function unionBaseName(
  refName: string,
  fieldName: string,
  fieldSchema: SchemaObject,
  parentModelName: string,
  reserved: ReadonlySet<string>,
): string | null {
  if (!fieldSchema.oneOf) return refName;
  const fromField = qualifyInlineModelName(toPascalCase(fieldName), parentModelName);
  const names = [...nameInlineVariants(fieldSchema, fromField, reserved).values()];
  return names.includes(refName) ? fromField : null;
}

/**
 * The model refs a field's TypeRef produces directly: the ref itself, the
 * items of a (possibly nullable) array, or each (possibly nullable) variant of
 * a union — the shapes `extractNestedSchema` can name from a ref. Refs nested
 * any deeper are excluded.
 */
function directModelRefNames(ref: TypeRef): Set<string> {
  const names = new Set<string>();
  let root = ref;
  while (root.kind === 'nullable' || root.kind === 'array') {
    root = root.kind === 'nullable' ? root.inner : root.items;
  }
  const leaves = root.kind === 'union' ? root.variants : [root];
  for (const leaf of leaves) {
    const inner = leaf.kind === 'nullable' ? leaf.inner : leaf;
    if (inner.kind === 'model') names.add(inner.name);
  }
  return names;
}

/** Find a component schema by PascalCase name. */
function findSchemaByName(pascalName: string, schemas: Record<string, SchemaObject>): SchemaObject | null {
  for (const [k, v] of Object.entries(schemas)) {
    if (resolveSchemaName(k) === pascalName) return v;
  }
  return null;
}

/**
 * Every property a component schema's model has a field for, each with the
 * declarations it received (`PropertyDeclarations`), in field order: the one
 * answer to "which schema declares `x` for this component". The field
 * builders (`extractModel`, `extractAllOfModel`), the nested-model lookup
 * (`componentFieldSchema`, for `collectNestedInlineModels`) and the
 * component field pass (`extractInlineModelsFromSchemas`) all read it, so a
 * field and every model nested under it — an inline object, array items,
 * map values, a union's variants — are built from the same declaration. An
 * `allOf` component is read by `readComponentAllOf`; any other component
 * declares its own `properties` as always-applying and, with none, a pure
 * `oneOf`/`anyOf`'s variants' properties as branch-only — the flattening
 * `extractModel` gives such a union. `name` is the model's, for the
 * dispatcher detection a variant axis needs.
 */
export function componentPropertyLedger(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): Map<string, PropertyDeclarations> {
  const ledger = new Map<string, PropertyDeclarations>();
  if (schema.allOf) {
    readComponentAllOf(name, schema, schemas, ledger, new Set());
    return ledger;
  }
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (value) declareProperty(ledger, key, value, null, false);
  }
  if (ledger.size === 0) {
    for (const variant of unionVariantsOf(schema) ?? []) {
      for (const [key, value] of Object.entries(variant.properties ?? {})) {
        if (value) declareProperty(ledger, key, value, null, true);
      }
    }
  }
  return ledger;
}

/**
 * The schema `fieldName` of the component `schema` (resolved to `name`) is
 * typed from — `declaredComponentProperty` over `componentPropertyLedger` —
 * or `null` when the component's model has no such field. The nested-model
 * pass builds a field's inline models from this very declaration, so a
 * model it builds (`OuterChild`) has the fields the field's type was built
 * from: a member's when one always declares the field, a branch's only when
 * no member does (workos/oagen#359 review: the lookup walked the schema and
 * returned the first declaration it met, a branch's before a later member's).
 */
export function componentFieldSchema(
  fieldName: string,
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): SchemaObject | null {
  const entry = componentPropertyLedger(name, schema, schemas).get(fieldName);
  return entry ? declaredComponentProperty(entry) : null;
}

/**
 * Extract a model (and nested models) from an inline field schema. `reserved`
 * holds the inline names the field's sibling properties mint
 * (`reservedInlineNames`), which a `oneOf` variant must not take.
 */
function extractNestedSchema(
  name: string,
  schema: SchemaObject,
  schemas?: Record<string, SchemaObject>,
  reserved: ReadonlySet<string> = NO_RESERVED,
): Model[] {
  // Handle oneOf: extract each object variant as its own model. `name` is the
  // union's base name (the field's qualified inline name), and the variants
  // are named from it by `nameInlineVariants` — the one place that decides a
  // variant's name — so they match the union TypeRef and the field extractor
  // (`UserApiKeyOwner`, `CircleDrawingShape`, `DrawingShapeWithSide`, ...).
  // Same inline-object test as `schemaToTypeRef` and the field extractor, so
  // a `type: ['object', 'null']` variant is counted here too instead of
  // letting the next variant claim its name.
  //
  // One keyword types the schema (`classifyInlineSchema`, the order
  // `schemaToTypeRef` follows), so exactly one branch below runs: a schema
  // carrying both `items` and `properties` is an array here as it is there,
  // and never also an object model under the same name. `properties` beside
  // the composition that types the schema are folded into it first, as
  // `schemaToTypeRef` folds them, so the variants built here carry them.
  schema = foldSiblingProperties(schema);
  const kind = classifyInlineSchema(schema);
  if (kind === 'union' && schema.oneOf) {
    const models: Model[] = [];
    const variantNames = nameInlineVariants(schema, name, reserved);
    // A nullable wrapper (one non-null branch beside `null`) is the field's
    // schema: the model built from its branch takes the wrapper's `deprecated`,
    // limits and link (`collapsedNullableBranch`), exactly as the field
    // extractor builds the same model, so the two copies agree. A multi-variant
    // union, nullable or not, is not collapsed: every variant is built as
    // written.
    const branch = collapsedNullableBranch(schema);

    for (const variant of schema.oneOf) {
      const variantName = variantNames.get(variant);
      if (variantName === undefined) continue;
      const source = branch ?? variant;
      // Build the variant's fields under its own name: an inline object
      // nested under variant N is then referenced as `<VariantN>Child`
      // (`ThingShapeWithSideCenter`), which is the name the field extractor
      // materializes it under — not `<Variant0>Child`.
      const requiredSet = new Set(source.required ?? []);
      const siblings = collectProperties(source);
      const fields: Field[] = [];
      for (const [fn, fs] of Object.entries(source.properties ?? {})) {
        if (!fs) continue;
        fields.push(buildFieldFromSchema(fn, fs, variantName, requiredSet, schemas, siblings));
      }
      models.push({
        name: variantName,
        description: source.description,
        ...externalDocsEntry(source.externalDocs),
        fields,
        ...deprecatedEntry(source),
        ...constraintsEntry(source),
      });
    }
    return models;
  }

  // Handle direct object
  if (kind === 'object' && schema.properties && (schema.type === 'object' || !schema.type)) {
    const requiredSet = new Set(schema.required ?? []);
    const siblings = collectProperties(schema);
    const fields: Field[] = [];
    for (const [fn, fs] of Object.entries(schema.properties)) {
      if (!fs) continue;
      fields.push(buildFieldFromSchema(fn, fs, name, requiredSet, schemas, siblings));
    }
    return [
      {
        name,
        description: schema.description,
        ...externalDocsEntry(schema.externalDocs),
        fields,
        ...deprecatedEntry(schema),
        ...constraintsEntry(schema),
      },
    ];
  }

  // Handle array with inline items — typed, nullable, or `items` with no
  // `type`: `isArraySchema` is `classifyInlineSchema`'s answer once the
  // nullable type list is unwrapped, the same test `schemaToTypeRef` applied
  // when it named the ref.
  if (isArraySchema(schema) && schema.items?.properties) {
    const requiredSet = new Set(schema.items.required ?? []);
    const siblings = collectProperties(schema.items);
    const fields: Field[] = [];
    for (const [fn, fs] of Object.entries(schema.items.properties)) {
      if (!fs) continue;
      fields.push(buildFieldFromSchema(fn, fs, name, requiredSet, schemas, siblings));
    }
    return [
      {
        name,
        description: schema.items.description,
        ...externalDocsEntry(schema.items.externalDocs),
        fields,
        ...deprecatedEntry(schema.items),
        ...constraintsEntry(schema.items),
      },
    ];
  }

  return [];
}

/**
 * The prefix a variant's `title` contributes to its name: the title trimmed
 * and PascalCased, or null when there is no title or it PascalCases to
 * nothing.
 */
function variantTitlePrefix(variant: SchemaObject): string | null {
  const title = typeof variant['title'] === 'string' ? variant['title'].trim() : '';
  return title ? toPascalCase(title) || null : null;
}

/** `<Prefix><Base>`, or `base` unchanged when it already starts with the prefix (no doubling). */
function prefixedVariantName(prefix: string, base: string): string {
  return base.startsWith(prefix) ? base : `${prefix}${base}`;
}

/**
 * The properties `variant` declares that no other inline object variant of
 * the same union declares, in the variant's own `properties` order.
 */
function distinguishingProperties(variant: SchemaObject, siblings: readonly SchemaObject[]): string[] {
  const declaredElsewhere = new Set<string>();
  for (const sibling of siblings) {
    if (sibling === variant) continue;
    for (const property of Object.keys(sibling.properties ?? {})) declaredElsewhere.add(property);
  }
  return Object.keys(variant.properties ?? {}).filter((property) => !declaredElsewhere.has(property));
}

/**
 * Name an inline object variant of a `oneOf`/`anyOf` that has no better
 * signal: it is not variant 0 (which keeps the union's base name) and no
 * const discriminator gave it a prefix. The name is derived from the
 * variant's own content, never from where it sits in the document (beyond
 * its position among the variants, which only the final counter reads), so
 * an SDK user can tell the variants apart and reordering them changes nothing
 * but which one is variant 0. In order, taking the first candidate that is
 * neither the base name nor a name already given to an earlier variant of
 * the same union:
 *
 *   1. the variant's `title` (trimmed and PascalCased): `<Title><Base>`
 *      (`CircleDrawingShape`), the same prefix form a const discriminator
 *      produces, including the rule that a base already starting with the
 *      prefix is not doubled (that candidate equals the base, so it falls
 *      through); a title an earlier variant already took falls through too;
 *   2. a distinguishing property — the first property, in the variant's own
 *      order, that it declares and no other inline object variant declares:
 *      `<Base>With<Property>` (`DrawingShapeWithSide`); a property that
 *      PascalCases to nothing is skipped;
 *   3. the position counter, `<Base><position + 1>` (`DrawingShape2`), which
 *      now remains only for variants whose property sets are identical, and
 *      which keeps counting past a taken name (`DrawingShape3`).
 *
 * Every candidate is also checked against `reserved`: the inline names the
 * parent's other properties mint (`reservedInlineNames`), so a variant can
 * never take a name another field's model already has — beside a
 * `shape_with_side` object, the `{ side }` variant of `shape` is not
 * `DrawingShapeWithSide` but the next candidate. Read from sibling names and
 * content only, so document order plays no part.
 *
 * `siblings` are the inline object variants of the union, this one included;
 * `emitted` are the names already given to the earlier ones, in order. Every
 * site that names a variant — the union TypeRef, the component-field,
 * request-body and response extractors, and `mintedInlineNames` — goes
 * through this function (via `nameInlineVariant`), so they cannot drift.
 */
export function nameUndiscriminatedVariant(
  variant: SchemaObject,
  siblings: readonly SchemaObject[],
  base: string,
  emitted: readonly string[],
  reserved: ReadonlySet<string> = NO_RESERVED,
): string {
  const taken = (candidate: string): boolean =>
    candidate === base || emitted.includes(candidate) || reserved.has(candidate);

  const titlePrefix = variantTitlePrefix(variant);
  if (titlePrefix !== null) {
    const candidate = prefixedVariantName(titlePrefix, base);
    if (!taken(candidate)) return candidate;
  }

  for (const property of distinguishingProperties(variant, siblings)) {
    const word = toPascalCase(property);
    if (!word) continue;
    const candidate = `${base}With${word}`;
    if (!taken(candidate)) return candidate;
  }

  for (let position = emitted.length + 1; ; position++) {
    const candidate = `${base}${position}`;
    if (!taken(candidate)) return candidate;
  }
}

/** No reserved names: for a union with no sibling properties (a request body or response that is itself a union). */
const NO_RESERVED: ReadonlySet<string> = new Set();

/**
 * True when the union's inline object variants (two or more) each carry a
 * title and no two titles PascalCase to the same prefix: the one case in
 * which variant 0 is named from its title rather than keeping the base name.
 */
function allDistinctlyTitled(siblings: readonly SchemaObject[]): boolean {
  if (siblings.length < 2) return false;
  const prefixes = siblings.map(variantTitlePrefix);
  return prefixes.every((prefix) => prefix !== null) && new Set(prefixes).size === prefixes.length;
}

/**
 * The name of one inline object variant of a `oneOf`/`anyOf`, given the
 * union's base name (the field's qualified inline name, e.g. `ApiKeyOwner`),
 * the inline object variants of the union (`siblings`, this one included),
 * the names already given to the earlier variants (`emitted`, in order), and
 * the const-valued property that distinguishes the variants when there is
 * one (`deriveConstNamingDiscriminator`).
 *
 * Variant 0 keeps the bare base name: the union TypeRef and every extractor
 * reference it under that name, and a consumer's typed field keeps the name
 * it always had. Two exceptions: when the union has no const discriminator
 * and every variant carries a distinct title, variant 0 is named from its
 * title like the others (`CircleDrawingShape` beside `SquareDrawingShape`)
 * instead of being the only one left bare; and when the caller says the base
 * is already taken (`baseTaken`: a component schema that is itself the
 * union, whose own model holds the base name — `Model.variants`), variant 0
 * is named like every later variant (`CatPet`, `PetWithLivesLeft`, `Pet1`).
 * Whether the union is discriminated is read from the variants themselves
 * here, not from `discriminator`, so a caller forcing a property (an explicit
 * `discriminator:` without `mapping:`) still agrees with the extractors on
 * variant 0.
 *
 * A later variant takes `<ConstValue><Base>` from the discriminator
 * (`UserApiKeyOwner`) when the value PascalCases to something and the name is
 * neither the base, nor already emitted, nor minted by one of the parent's
 * other properties (`reserved`), and otherwise falls to
 * `nameUndiscriminatedVariant`: its title, a distinguishing property, then
 * the position counter, each checked the same way.
 */
export function nameInlineVariant(
  variant: SchemaObject,
  siblings: readonly SchemaObject[],
  base: string,
  emitted: readonly string[],
  discriminator: { property: string } | null,
  reserved: ReadonlySet<string> = NO_RESERVED,
  baseTaken = false,
): string {
  if (emitted.length === 0 && !baseTaken) {
    const undiscriminated = deriveConstNamingDiscriminator([...siblings]) === null;
    const titlePrefix = undiscriminated && allDistinctlyTitled(siblings) ? variantTitlePrefix(variant) : null;
    return titlePrefix === null ? base : prefixedVariantName(titlePrefix, base);
  }

  if (discriminator) {
    const constValue = getConstPropertyValue(variant, discriminator.property);
    const prefix = constValue ? toPascalCase(constValue) : '';
    if (prefix) {
      const candidate = prefixedVariantName(prefix, base);
      if (candidate !== base && !emitted.includes(candidate) && !reserved.has(candidate)) return candidate;
    }
  }
  return nameUndiscriminatedVariant(variant, siblings, base, emitted, reserved);
}

/**
 * Name every inline object variant of a `oneOf`/`anyOf` schema from the
 * union's base name, keyed by variant schema identity; null, non-object and
 * `$ref` variants get no entry. Positions are local to this variant list, so
 * the union's TypeRef entries and the extracted models agree no matter what
 * else has been extracted. `reserved` holds the inline names the parent's
 * other properties mint (`reservedInlineNames`); every site that has a
 * sibling set passes the same one, so the reference and the model step
 * around them identically.
 *
 * One union shape is named differently: a `oneOf` with no explicit
 * `discriminator:` whose every variant carries a `$ref` or a `title` and pins
 * the same const property (`titleMappedDiscriminatorProperty`). Its
 * discriminator mapping has always named an inline variant by its title
 * (`resolveSchemaName(title)`: `Circle`, `Square`, run through the project's
 * schema-name transform like a component), and `schemaToTypeRef` references
 * the variant by that mapped name, so the title is the model name here too —
 * unless it is the base, already emitted, or reserved by a sibling, in which
 * case the variant takes a context-qualified name (its title as a prefix on
 * the base, `CircleDrawingMarker`, else a distinguishing property, else the
 * counter) and the mapping, which is read from this map, follows it. A kept
 * title is context-free: it is the same whatever field, array or map the
 * union sits under, so it names one shape wherever it appears, as a
 * component name would. A second union beside it using the same title for a
 * variant of the identical shape (`schemaShapeKey`) therefore shares the
 * model instead of stepping around it; a sibling giving the same title a
 * different shape reserves it (`reservedInlineNames`), and since both sides
 * read their siblings in isolation the decision is symmetric: when the
 * shapes differ, both unions fall back to their context-qualified names
 * (`CircleDrawingShape`, `CircleDrawingMarker`) and neither keeps the bare
 * `Circle`; when they are identical, both keep `Circle` and one model is
 * emitted. The same holds at any depth of one root, not only between
 * siblings: a title that two unions anywhere under the same root — a
 * component schema, a request body, a response, a header, a webhook payload
 * — give different shapes is contested (`markContestedTitles`, decided
 * before any union is named), and a contested variant takes its
 * context-qualified name exactly as a reserved one does
 * (`CircleDrawingShape` beside `CircleDrawingMarkerShape`), wherever in the
 * root it sits and whichever is declared first. `elementContextName` never
 * lets a context-free name drive an items/values step-aside, which no
 * context could satisfy. `nameInlineVariantEntries` reports which names are
 * context-free; a fallen-back title name is context-dependent.
 *
 * This is the list-level entry point every site uses: `schemaToTypeRef` (via
 * `nameInlineObjectVariants`), `extractNestedSchema`,
 * `extractInlineModelDeep`, `extractInlineModelsFromProperties` and
 * `mintedInlineNames`.
 */
export function nameInlineVariants(
  union: SchemaObject,
  base: string,
  reserved: ReadonlySet<string> = NO_RESERVED,
  baseTaken = false,
): Map<SchemaObject, string> {
  const names = new Map<SchemaObject, string>();
  for (const [variant, entry] of nameInlineVariantEntries(union, base, reserved, baseTaken)) {
    names.set(variant, entry.name);
  }
  return names;
}

/** A variant's model name, and whether it is context-free (a title-mapped union's title, see `nameInlineVariants`). */
export interface InlineVariantName {
  name: string;
  contextFree: boolean;
}

/**
 * `nameInlineVariants`, also telling for each name whether it is context-free.
 * `baseTaken` says the base name itself already belongs to another model (a
 * named union component's own), so variant 0 steps off it (`nameInlineVariant`).
 */
export function nameInlineVariantEntries(
  union: SchemaObject,
  base: string,
  reserved: ReadonlySet<string> = NO_RESERVED,
  baseTaken = false,
): Map<SchemaObject, InlineVariantName> {
  const nonNullVariants = (union.oneOf ?? union.anyOf ?? []).filter((v) => !isNullVariantSchema(v));
  const inlineObjectVariants = nonNullVariants.filter((v) => isInlineObjectSchema(v));
  const discriminator = deriveConstNamingDiscriminator(inlineObjectVariants);
  const titles = titleMappedVariantNames(union);
  const emitted: string[] = [];
  const entries = new Map<SchemaObject, InlineVariantName>();
  for (const variant of inlineObjectVariants) {
    let name: string | null = null;
    let contextFree = false;
    const titled = titles.get(variant);
    if (titled !== undefined) {
      if (titled !== base && !emitted.includes(titled) && !reserved.has(titled) && !isContestedTitle(variant)) {
        name = titled;
        contextFree = true;
      } else {
        // The title is taken (by a sibling's model, by a sibling's variant
        // of a different shape, by an earlier variant of this union, or by a
        // variant of another shape anywhere under the same root —
        // `isContestedTitle`): the variant takes a context-qualified name
        // instead — its title as a prefix on the base
        // (`CircleDrawingMarker`), else a distinguishing property, else the
        // counter — and the mapping, read from this map, follows.
        name = nameUndiscriminatedVariant(variant, inlineObjectVariants, base, emitted, reserved);
      }
    }
    name ??= nameInlineVariant(variant, inlineObjectVariants, base, emitted, discriminator, reserved, baseTaken);
    emitted.push(name);
    entries.set(variant, { name, contextFree });
  }
  return entries;
}

/**
 * The inline object variants of a title-mapped union — a `oneOf` with no
 * explicit `discriminator:` whose every non-null variant carries a `$ref` or
 * a `title` and pins the same const property
 * (`titleMappedDiscriminatorProperty`) — each with the name its title
 * resolves to (`resolveVariantModelName`: the title run through the
 * project's schema-name transform, like a component name). Empty for any
 * other union, so a caller can read "is title-mapped" off the map's size.
 * `nameInlineVariantEntries` names such a variant from this map, and
 * `markContestedTitles` reads the same map to find the variants that give
 * one title two shapes under one root, so the two cannot disagree on which
 * variants a title names.
 */
export function titleMappedVariantNames(union: SchemaObject): ReadonlyMap<SchemaObject, string> {
  const names = new Map<SchemaObject, string>();
  if (union.oneOf === undefined || union.discriminator) return names;
  const nonNullVariants = union.oneOf.filter((v) => !isNullVariantSchema(v));
  if (titleMappedDiscriminatorProperty(nonNullVariants) === null) return names;
  for (const variant of nonNullVariants) {
    if (!isInlineObjectSchema(variant)) continue;
    const titled = resolveVariantModelName(variant);
    if (titled !== null) names.set(variant, titled);
  }
  return names;
}

/**
 * Returns a discriminator descriptor when every inline object variant in a
 * oneOf has a string-const value on the same property — the signature of a
 * discriminated union without an explicit `discriminator:` keyword. Used by
 * `nameInlineVariant` to derive variant names from the const values.
 *
 * Distinct from `detectConstPropertyDiscriminator` (which requires every
 * variant to carry a `$ref` or `title` so a name mapping can be built):
 * this pass operates on inline anonymous variants, where naming is exactly
 * what we're trying to derive.
 */
function deriveConstNamingDiscriminator(variants: SchemaObject[]): { property: string } | null {
  if (variants.length < 2) return null;
  const candidates = Object.keys(variants[0]?.properties ?? {});
  for (const propName of candidates) {
    const values = variants.map((v) => getConstPropertyValue(v, propName));
    if (values.some((v) => v === null)) continue;
    if (new Set(values).size !== values.length) continue; // collisions = no signal
    return { property: propName };
  }
  return null;
}

/**
 * True for a schema that `schemaToTypeRef` turns into an inline model reference:
 * it declares `properties` directly (no `$ref`) and is an object — whether by
 * `type: 'object'`, by omitting `type`, or by an OAS 3.1 nullable array such as
 * `type: ['object', 'null']`. Every inline-model extractor must use the same
 * test, or a field's reference points at a model nobody materializes.
 */
export function isInlineObjectSchema(schema: SchemaObject | undefined): schema is SchemaObject {
  if (!schema || schema.$ref || !schema.properties) return false;
  const { type } = schema;
  return type === undefined || type === 'object' || (Array.isArray(type) && type.includes('object'));
}

/** True when a named union admits `null`: a `type: 'null'` variant, a `type` list with `'null'`, or OAS 3.0 `nullable: true`. */
function isNullableUnionSchema(schema: SchemaObject): boolean {
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  return (schema.oneOf ?? schema.anyOf ?? []).some(isNullVariantSchema);
}

/**
 * True for a schema that `schemaToTypeRef` types as an array: `type: 'array'`,
 * an OAS 3.1 type list whose only non-null member is `array` (`['array',
 * 'null']`, which it unwraps to a nullable array), or — since JSON Schema does
 * not require `type` beside `items` — `items` with no `type` at all. Every
 * site that decides whether to materialize an array's item model must ask
 * this same question, or the items reference a model nobody creates. The
 * answer is `classifyInlineSchema`'s, asked of the schema with its nullable
 * type list unwrapped the way `schemaToTypeRef` unwraps it first: a `$ref` is
 * a reference whatever else it carries; a type list naming another type
 * beside `array` is a union; and a schema that also composes — a `oneOf` /
 * `anyOf` with a typing variant, or an `allOf` with a `$ref` member, a
 * member declaring properties inline or a lone typing member — is that composition,
 * `type: 'array'` or not, since it is read before `items` and the item
 * extractor must not claim a variant's name first. An `allOf` or `oneOf` of
 * bare limits (`[{ minItems: 1 }, { maxItems: 10 }]`) types nothing there and
 * leaves the schema an array here. `items` is not required: a bare
 * `type: 'array'` types nothing to `classifyInlineSchema` and is still an
 * array (of unknown items) to `schemaToTypeRef`; a site that needs items
 * checks for them. A plain boolean rather than a type guard, because a guard
 * on a `SchemaObject` narrows the variable to `never` in the other branch.
 */
export function isArraySchema(schema: SchemaObject | undefined): boolean {
  if (!schema) return false;
  let bare = schema;
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== 'null');
    if (nonNull.length !== 1) return false;
    bare = { ...schema, type: nonNull[0] };
  }
  const kind = classifyInlineSchema(bare);
  return kind === 'array' || (kind === 'other' && bare.type === 'array');
}

/**
 * The context each variant of a `oneOf`/`anyOf` that is not an inline object
 * is typed and extracted under, keyed by the variant. An inline object
 * variant is named by `nameInlineVariants` (`objectVariantNames`) and is not
 * in the map; a `null` variant marks the union nullable and a `$ref` variant
 * mints nothing, so neither is either. Every other variant is read with its
 * nullable wrapper removed, whichever form it takes (`unwrapNullableSchema`),
 * as the extractor reads it, and gets a context by its kind:
 *
 *   - an array or map variant is typed under `<field>_item` / `<field>_value`,
 *     so what its items or values mint (`ReqShapesItem`, `ReqShapesValue`)
 *     can never take the name an object variant of the same union keeps
 *     (`ReqShape`, `ReqShapeWithX`);
 *   - a variant that would mint a model or enum name under the field's own
 *     context — a nested `oneOf`/`anyOf` with inline object variants (its
 *     variants are named from the field's name as the outer ones are, so its
 *     first one would take the outer variant 0's name), a nullable wrapper
 *     around an inline object, an `allOf`, an inline enum or a union of
 *     string consts — keeps the field's context when nothing it mints there is
 *     claimed (a nested union beside a primitive still names its variants
 *     `ReqShape`, `BReqShape`; an inline enum beside a primitive keeps
 *     `ReqShape`), and is otherwise typed under `<field>_variant_<n>`, n its
 *     1-based position among the non-null variants, as a named union's
 *     non-object variants are (`memberContext`): the nested union's variants
 *     become `ReqShapeVariant2`, `BReqShapeVariant2`, an enum beside an object
 *     variant `ReqShapeVariant2`. Only context-dependent names take part in
 *     the claim check: a nested title-mapped union (`nameInlineVariants`:
 *     every variant titled and pinning the same const) mints its titles,
 *     `A` and `B`, under every context alike, so it keeps the field's
 *     context — it is in the map, so the extractor builds `A` and `B` — and
 *     steps only for a variant of its own that fell back to a
 *     context-qualified name (`AReqShape` when `A` is already taken);
 *   - a variant that mints nothing under the field's context (a primitive, an
 *     `allOf` of `$ref`s alone) keeps the field's context and is not in the map.
 *
 * A name is claimed when a sibling property mints it (a real `shapes_item`
 * object), the caller reserved it (`reservedNames`: the set an enclosing
 * field handed down to its array items or map values, or the names a
 * deferred body's registry already gives another shape — the same set the
 * object variants step around through `reservedNamesFor`), an inline object
 * variant of the union takes it (`ReqShape` — the reason a nested union's
 * variants step), an object variant's own property mints it (`item` under
 * `ReqShape` is `ReqShapeItem`), or an earlier variant of this map minted it.
 * When the context chosen by kind still mints a claimed name, it steps on
 * exactly as a plain array's items do beside such a sibling
 * (`firstFreeElementContext`: `shapes_array_item`, `shapes_array_item2`, …
 * for an array; `shapes_variant_2_value`, `shapes_variant_2_member_value`, …
 * for the rest), so no two variants of one union share a model, and neither
 * do a variant's items and an object variant's child. The names minted this
 * way are what `mintedInlineNameEntries` reports for the union, so a sibling
 * steps around them in turn. Decided in variant order, from the siblings' and
 * the variants' content only, so both sides of the parser agree:
 * `schemaToTypeRef` types each variant under its context, the extractors
 * re-enter with the variant as a property of that name, and
 * `mintedInlineNameEntries` reads the names under it.
 *
 * Each entry also carries the names the variant must step around when it is
 * typed and extracted under its context (`reserved`): everything claimed at
 * that point — the sibling-minted and caller-reserved names, the object
 * variants and their children, every name an earlier variant minted — plus
 * the context-free title an earlier variant kept for a different shape. Both
 * sides hand that set down as `reservedNames`, the set the enclosing field's
 * own variants step around through `reservedNamesFor`, so a nested
 * title-mapped variant whose title is already a sibling's model (`HolderA`
 * beside the `a` object of `Holder`), an earlier variant's model
 * (`HolderShapeVariant2`) or an earlier nested variant's title of another
 * shape falls back to its context-qualified name (`HolderAHolderShape`,
 * `AHolderShape`) exactly as a field-level titled variant does beside the
 * same sibling (`nameInlineVariantEntries`); an earlier nested variant's
 * title of the identical shape is shared, as between sibling fields
 * (`reservedInlineNames`). Without the set, the nested variant would keep
 * the title and the extractor would skip it as already built, so the union
 * would expose the sibling's fields. The names a variant mints are read with
 * its own set (`mintedInlineNameEntries`), so the claims a later variant
 * sees are the names actually taken.
 *
 * `objectVariantNames` is the name each inline object variant's model takes
 * (`nameInlineVariants`), as the caller decided it; those names, and the
 * names the models' own properties mint, are claimed before any context is
 * chosen. One level is enough: every name a child's children mint starts
 * with the child's.
 */
export function nonObjectVariantContexts(
  contextName: string | undefined,
  variants: readonly SchemaObject[],
  siblings: ReadonlyMap<string, SchemaObject> | undefined,
  parentModelName: string | undefined,
  objectVariantNames: ReadonlyMap<SchemaObject, string>,
  reservedNames?: ReadonlySet<string>,
): Map<SchemaObject, VariantContext> {
  const contexts = new Map<SchemaObject, VariantContext>();
  if (contextName === undefined) return contexts;
  const claimed = new Set<string>(reservedNames);
  for (const [siblingName, siblingSchema] of siblings ?? []) {
    if (siblingName === contextName) continue;
    for (const minted of mintedInlineNames(siblingName, siblingSchema, parentModelName)) claimed.add(minted);
  }
  for (const [variant, variantName] of objectVariantNames) {
    claimed.add(variantName);
    for (const [property, propertySchema] of Object.entries(unwrapNullableSchema(variant).properties ?? {})) {
      if (!propertySchema) continue;
      for (const minted of mintedInlineNames(property, propertySchema, variantName)) claimed.add(minted);
    }
  }
  // The context-free title each earlier variant kept, with the shape it
  // gave it: reserved for a later variant unless that variant gives the same
  // title the identical shape, which then shares the model.
  const keptTitles = new Map<string, string>();
  let position = 0;
  for (const variant of variants) {
    if (isNullVariantSchema(variant)) continue;
    position++;
    if (objectVariantNames.has(variant)) continue;
    const member = unwrapNullableSchema(variant);
    const kind = classifyInlineSchema(member);
    if (kind === 'ref') continue;
    const ownTitles = new Map<string, string>();
    for (const entry of mintedInlineNameEntries(contextName, member, parentModelName)) {
      if (entry.contextFree && entry.schema) ownTitles.set(entry.name, schemaShapeKey(entry.schema));
    }
    const reserved = new Set(claimed);
    for (const [title, shape] of keptTitles) if (ownTitles.get(title) !== shape) reserved.add(title);
    const minted = (candidate: string): MintedInlineName[] =>
      mintedInlineNameEntries(candidate, member, parentModelName, reserved);
    const dependentNames = (candidate: string): string[] =>
      minted(candidate)
        .filter((entry) => !entry.contextFree)
        .map((entry) => entry.name);
    const unclaimed = (names: readonly string[]): boolean => names.every((name) => !reserved.has(name));
    let context: string;
    if (kind === 'array' || kind === 'map') {
      context = firstFreeElementContext(
        contextName,
        kind === 'array' ? 'item' : 'value',
        reserved,
        dependentNames,
        [],
      ).context;
    } else {
      // A variant that mints nothing (a primitive, an `allOf` of `$ref`s
      // alone) needs no entry. One that mints only context-free names — a
      // nested title-mapped union, whose variants are `A` and `B` under
      // every context — needs one, so the extractor builds those models, but
      // never a step: no context could move such a name; a taken title is
      // stepped off through `reserved` instead.
      if (minted(contextName).length === 0) continue;
      const own = dependentNames(contextName);
      const stepped = `${contextName}_variant_${position}`;
      const under = dependentNames(stepped);
      context = unclaimed(own)
        ? contextName
        : unclaimed(under)
          ? stepped
          : firstFreeElementContext(stepped, 'value', reserved, dependentNames, under).context;
    }
    contexts.set(variant, { context, reserved });
    for (const entry of minted(context)) {
      if (entry.contextFree && entry.schema) keptTitles.set(entry.name, schemaShapeKey(entry.schema));
      else claimed.add(entry.name);
    }
  }
  return contexts;
}

/** How a non-object variant is typed and extracted: under `context`, stepping around `reserved` (see `nonObjectVariantContexts`). */
export interface VariantContext {
  context: string;
  reserved: ReadonlySet<string>;
}

/** Which of its keywords types an inline schema; see `classifyInlineSchema`. */
export type InlineSchemaKind = 'ref' | 'allOf' | 'union' | 'const' | 'enum' | 'array' | 'object' | 'map' | 'other';

/**
 * Decide which of a schema's keywords types it when several could, in the
 * one precedence every site follows: `$ref`; then `allOf`; then `oneOf` /
 * `anyOf`; then `const`; then `enum`; then `items` as an array (with
 * `type: 'array'` or no `type`); then `properties` as an object (with
 * `type: 'object'`, no `type`, or a type list naming `object`); then a
 * property-less `type: 'object'` as a map. Anything else — a primitive, a
 * type list without `object`, an empty schema — is `other`.
 *
 * `schemaToTypeRef` and every inline-model extractor
 * (`extractInlineModelsFromProperties`, `mintedInlineNameEntries`, and
 * through them the response header and secondary-body paths) dispatch on
 * this, so a schema carrying both `items` and `oneOf` is a union to all of
 * them and the models extracted are exactly the ones the type references.
 * Call it on a schema whose nullable wrappers are already removed.
 */
export function classifyInlineSchema(schema: SchemaObject): InlineSchemaKind {
  if (schema.$ref) return 'ref';
  if (schema.allOf && allOfTypesSchema(schema.allOf)) return 'allOf';
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants && unionTypesSchema(variants)) return 'union';
  if (schema.const !== undefined) return 'const';
  if (schema.enum) return 'enum';
  if (schema.items && (schema.type === 'array' || !schema.type)) return 'array';
  // A plain boolean: the type guard would otherwise narrow `schema` to `never` below.
  const inlineObject: boolean = isInlineObjectSchema(schema);
  if (inlineObject) return 'object';
  if (schema.type === 'object') return 'map';
  return 'other';
}

/** Keywords that give a schema a type of its own; a member carrying none of them only adds limits or documentation. */
const TYPING_KEYWORDS: readonly string[] = [
  '$ref',
  'allOf',
  'oneOf',
  'anyOf',
  'const',
  'enum',
  'items',
  'properties',
  'type',
  'additionalProperties',
  'patternProperties',
];

/**
 * Whether an `allOf` is what types the schema, i.e. the cases its branch in
 * `schemaToTypeRef` acts on: a `$ref` member (a reference, or an augmentation
 * model), a member declaring properties inline (a merged model —
 * `declaresInlineProperties`: its own `properties`, or those of a nested
 * `allOf` member or of a `oneOf`/`anyOf` variant, which `mergeAllOfMembers`
 * reads into the model), or a lone member that types on its own
 * (unwrapped). An `allOf` whose members only conjoin limits or
 * documentation — `allOf: [{ minProperties: 1 }, { maxProperties: 3 }]`
 * beside the schema's own `properties` — does not: the schema is then typed
 * from its own keywords, and `extractConstraints` still conjoins the
 * members' limits onto the field and the model it builds.
 */
function allOfTypesSchema(members: readonly SchemaObject[]): boolean {
  if (members.some((member) => member.$ref !== undefined || declaresInlineProperties(member))) return true;
  const only = members.length === 1 ? members[0] : undefined;
  return only !== undefined && TYPING_KEYWORDS.some((key) => (only as Record<string, unknown>)[key] !== undefined);
}

/**
 * Whether a `oneOf`/`anyOf` is what types the schema: so when any variant
 * carries a typing keyword. A union of bare constraint sets —
 * `anyOf: [{ required: ['k'] }, { maxProperties: 1 }]` beside the schema's
 * own `properties` — does not, as such an `allOf` does not: the schema is typed from its own
 * keywords (the object, with its `k`), and the variants only limit it.
 */
function unionTypesSchema(variants: readonly SchemaObject[]): boolean {
  return variants.some((variant) =>
    TYPING_KEYWORDS.some((key) => (variant as Record<string, unknown>)[key] !== undefined),
  );
}

/** The `{ type: 'null' }` member that marks a `oneOf`/`anyOf` as nullable; never a variant to name. */
function isNullVariantSchema(schema: SchemaObject): boolean {
  return (
    schema.type === 'null' || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === 'null')
  );
}

/**
 * The schema `schemaToTypeRef` and every extractor dispatch on when a schema
 * writes `properties` beside a composition that types it: the composition,
 * carrying the properties. JSON Schema applies every keyword of one schema
 * at once, so `{ properties: { id }, allOf: [{ $ref: Pet }] }` is a `Pet`
 * that also has `id`, and `{ properties: { id }, oneOf: [pet, note] }` is
 * one of `pet` or `note` with `id` in either case. The parser reads a
 * composition before `properties` (`classifyInlineSchema`), so left as
 * written the properties would be dropped — while the response and
 * request-body paths, which read `properties` first, would drop the
 * composition instead and type the same schema two ways.
 *
 * An `allOf` gains the schema's own `properties` and `required` as its first
 * member, so the merge the parser already makes of such an `allOf` — the
 * augmentation of a `$ref` member, a model merged from inline members, a
 * single member unwrapped — carries them, the schema's own first. Each inline
 * object variant of a `oneOf`/`anyOf` (`isInlineObjectSchema`: `properties`
 * with `type: 'object'`, no `type`, or a type list naming `object`, so a
 * nullable or multi-typed object variant included) gains them, the schema's
 * own first and its own declaration kept where the variant declares the same
 * property, so the union keeps every variant and each carries the shared
 * properties. Every other variant is typed as written: a `$ref` names a
 * component the parser never merges properties into (it may be an enum or a
 * union it could not augment); a primitive, an array or an enum is no object,
 * so `properties` constrains nothing in it; a nested composition or a
 * nullable union wrapper is left to its own variants. `schemaToTypeRef`
 * reports the variants that may be objects and did not take the properties
 * (`warnOnUncarriedProperties`).
 *
 * Applies only when the schema's `type` admits an object (`object`, a type
 * list naming it, or none), it declares at least one property of its own
 * (`hasFoldableProperties`: an empty `properties: {}` leaves the schema as
 * written, so `{ properties: {}, allOf: [map] }` stays the map and
 * `{ properties: {}, oneOf: [...] }` the union as before) and the
 * composition is what types the schema — an `allOf` or `oneOf` of bare
 * limits beside `properties` leaves the schema the object it is. A property
 * is matched by its own name only (`Object.hasOwn`), so a field named
 * `constructor` or `toString` is a field. Returns the schema itself when nothing folds, else a
 * copy with no `properties` or `required` of its own, every other keyword —
 * `description`, `nullable`, limits, `discriminator`, `additionalProperties`
 * — kept; so folding a folded schema changes nothing. A folded variant is a
 * copy of the document's, and `foldedVariantOrigin` gives the document's
 * back, so a decision recorded against it (a contested title,
 * `isContestedTitle`) reaches the copy. A component schema's own
 * `properties` beside its `allOf` are read the same way, as its first
 * member, by `componentAllOfMembers`.
 */
export function foldSiblingProperties(schema: SchemaObject): SchemaObject {
  if (!hasFoldableProperties(schema)) return schema;
  const kind = classifyInlineSchema(schema);
  if (kind !== 'allOf' && kind !== 'union') return schema;
  const { properties, required, ...rest } = schema;
  const own: SchemaObject = { type: 'object', properties, ...(required && required.length > 0 && { required }) };
  if (kind === 'allOf') return { ...rest, allOf: [own, ...(schema.allOf ?? [])] };
  const conjoin = (variant: SchemaObject): SchemaObject => conjoinSiblingProperties(variant, own);
  return schema.oneOf
    ? { ...rest, oneOf: schema.oneOf.map(conjoin) }
    : { ...rest, anyOf: (schema.anyOf ?? []).map(conjoin) };
}

/**
 * Whether `schema` declares at least one property of its own that a
 * composition beside them could carry (see `foldSiblingProperties`). An
 * empty `properties: {}` declares none: folded, it would add an empty object
 * member that types the schema as a model the extractor builds nothing for
 * (`{ properties: {}, allOf: [map] }` is the map, as written).
 */
function hasFoldableProperties(schema: SchemaObject): boolean {
  if (schema.$ref || schema.properties === undefined || Object.keys(schema.properties).length === 0) return false;
  const { type } = schema;
  return type === undefined || type === 'object' || (Array.isArray(type) && type.includes('object'));
}

/**
 * The members a component schema's `allOf` model is built from: the schema's
 * own `properties` and `required`, when it declares a property
 * (`hasFoldableProperties`), as one more member — the first — then the
 * members as written. JSON Schema applies both at once, so
 * `Dog: { allOf: [{ $ref: Pet }], properties: { breed }, required: [breed] }`
 * has `Pet`'s properties and `breed`: the own keywords are read here exactly
 * as `foldSiblingProperties` folds them for an inline schema, and as
 * `mergeAllOfMembers` reads this component when a `$ref` member names it
 * (its own properties, then its members), so the component's model and an
 * inline merge that names it carry its own and inherited properties in the
 * same order (workos/oagen#307: the component's own properties were not
 * read, and `Dog` was `{ name }`). Shared by `extractAllOfModel`, at every level of a
 * `$ref` chain, and by `extractDiscriminatedAllOfVariantModels`, whose
 * dispatcher base carries them into every variant. A `oneOf`/`anyOf`
 * beside a component's `properties` keeps its own rule — the object model
 * (`extractModel`) — and is not read here.
 */
function componentAllOfMembers(schema: SchemaObject): readonly SchemaObject[] {
  const members = schema.allOf ?? [];
  if (!hasFoldableProperties(schema)) return members;
  const { properties, required } = schema;
  return [{ type: 'object', properties, ...(required && required.length > 0 && { required }) }, ...members];
}

/**
 * `variant` carrying `own`'s properties and required names when it is an
 * inline object (`isInlineObjectSchema`), itself otherwise. The schema's own
 * properties come first and win where both declare a name; the required
 * names are the union of both lists.
 */
function conjoinSiblingProperties(variant: SchemaObject, own: SchemaObject): SchemaObject {
  if (!isInlineObjectSchema(variant)) return variant;
  const properties: Record<string, SchemaObject | undefined> = { ...own.properties };
  for (const [name, property] of Object.entries(variant.properties ?? {})) {
    if (!Object.hasOwn(properties, name)) properties[name] = property;
  }
  const required = [...new Set([...(own.required ?? []), ...(variant.required ?? [])])];
  const folded: SchemaObject = { ...variant, properties, ...(required.length > 0 && { required }) };
  foldedVariantOrigins.set(folded, foldedVariantOrigin(variant) ?? variant);
  return folded;
}

/** The document's variant each folded copy was made from (`conjoinSiblingProperties`). */
const foldedVariantOrigins = new WeakMap<SchemaObject, SchemaObject>();

/** The document's variant `variant` is a folded copy of, or `undefined` when it is the document's own. */
export function foldedVariantOrigin(variant: SchemaObject): SchemaObject | undefined {
  return foldedVariantOrigins.get(variant);
}

/**
 * The `oneOf`/`anyOf` lists `warnOnUncarriedProperties` has reported, so a
 * union is reported once however many times it is typed. Keyed by the list,
 * which every nullable unwrap keeps while it copies the schema around it.
 * Replaced per document (`resetFoldWarnings`).
 */
let reportedUncarriedProperties = new WeakSet<readonly SchemaObject[]>();

/** Forget which unions `warnOnUncarriedProperties` has reported; called once per document (`extractSchemas`). */
export function resetFoldWarnings(): void {
  reportedUncarriedProperties = new WeakSet();
}

/**
 * Warn, once per union, when `properties` written beside a typing
 * `oneOf`/`anyOf` are not carried into a variant that may be an object — a
 * `$ref`, an `allOf`, a nested union, a map, or a nullable union wrapper
 * around an object — because only an inline object variant takes them
 * (`foldSiblingProperties`). A primitive, array or enum variant is no object
 * and is not reported. Called by `schemaToTypeRef` with the context it types
 * the schema under, before the fold, on the schema as written — and by the
 * response and request-body paths, which fold a body before anything types
 * it, on the body as written under the body's name.
 */
export function warnOnUncarriedProperties(
  schema: SchemaObject,
  contextName: string | undefined,
  parentModelName: string | undefined,
): void {
  const variants = schema.oneOf ?? schema.anyOf;
  if (!variants || !hasFoldableProperties(schema) || classifyInlineSchema(schema) !== 'union') return;
  if (reportedUncarriedProperties.has(variants)) return;
  const uncarried: number[] = [];
  variants.forEach((variant, index) => {
    if (isNullVariantSchema(variant) || isInlineObjectSchema(variant)) return;
    const kind = classifyInlineSchema(unwrapNullableSchema(variant));
    if (kind === 'ref' || kind === 'allOf' || kind === 'union' || kind === 'map' || kind === 'object') {
      uncarried.push(index + 1);
    }
  });
  if (uncarried.length === 0) return;
  reportedUncarriedProperties.add(variants);
  const keyword = schema.oneOf ? 'oneOf' : 'anyOf';
  const which = uncarried.length === 1 ? `variant ${uncarried[0]} is` : `variants ${uncarried.join(', ')} are`;
  const context =
    contextName === undefined ? '' : ` (context: ${parentModelName ? `${parentModelName}.` : ''}${contextName})`;
  console.warn(
    `[oagen] Warning: \`properties\` beside \`${keyword}\` are carried into its inline object variants only; ${which} typed as written, without them${context}`,
  );
}

/**
 * The synthetic context names a multi-type inline variant's non-object
 * members are typed and extracted under, chosen so the models they name can
 * never collide with a model named from one of the variant's own properties.
 * An `array` member's items go under `item` (`<Variant>Item`), falling back
 * to `array_item` (`<Variant>ArrayItem`) and then `array_item2`,
 * `array_item3`, ... when a property already claims that name; any other
 * member goes under `value` (`<Variant>Value`), then `member_value`,
 * `member_value2`, .... A candidate is skipped when the model name
 * `qualifyInlineModelName` derives from it equals one derived from a
 * property — compared after qualification, so a property `items`, whose
 * name singularizes to `<Variant>Item`, blocks `item` as well.
 * This is the single source of these names for the TypeRef builder
 * (`inlineVariantTypeRef`) and the extractors (`variantMemberSchemas`).
 */
export function variantMemberKeys(variant: SchemaObject, variantName: string): { item: string; value: string } {
  const modelNameFor = (key: string): string => qualifyInlineModelName(toPascalCase(key), variantName);
  const claimed = new Set(Object.keys(variant.properties ?? {}).map(modelNameFor));
  const pick = (preferred: string, fallback: string): string => {
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? preferred : i === 1 ? fallback : `${fallback}${i}`;
      if (!claimed.has(modelNameFor(candidate))) return candidate;
    }
  };
  return { item: pick('item', 'array_item'), value: pick('value', 'member_value') };
}

/**
 * The schemas carried by the non-object members of a multi-type inline
 * variant (`type: ['object', 'array']` with `items`), keyed by the synthetic
 * context name from `variantMemberKeys` that `schemaToTypeRef` types them
 * under, so an inline object item is `<Variant>Item` (or `<Variant>ArrayItem`
 * when `item` is taken) and its own nested objects `<Variant>ItemChild`.
 * Every extractor re-enters with these under the variant's name so the
 * models line up with the refs by construction. A map member cannot occur
 * here: a variant with `properties` is typed as a model, never as a map.
 */
export function variantMemberSchemas(variant: SchemaObject, variantName: string): Record<string, SchemaObject> {
  const members: Record<string, SchemaObject> = {};
  if (Array.isArray(variant.type) && variant.type.includes('array') && variant.items) {
    members[variantMemberKeys(variant, variantName).item] = variant.items;
  }
  return members;
}

/**
 * Build a single Field from a schema property entry. Shared across all
 * extraction sites. Pass `componentSchemas` where they are at hand so a
 * field whose schema is a bare `$ref` can take `example`/`examples` from the
 * component it points at, as a parameter does. `siblingProperties` are the
 * other properties of the object the field belongs to (`collectProperties`);
 * array items and map values use them to step aside from a sibling that
 * would take their singular name (`elementContextName`).
 */
export function buildFieldFromSchema(
  fieldName: string,
  fieldSchema: SchemaObject,
  contextName: string,
  requiredSet: Set<string>,
  componentSchemas?: Record<string, SchemaObject>,
  siblingProperties?: ReadonlyMap<string, SchemaObject>,
): Field {
  const refTarget = resolveComponentSchemaRef(fieldSchema, componentSchemas);
  const { example, examples } = resolveExamples([
    { example: fieldSchema.example, examples: nonEmptyExamples(fieldSchema.examples) },
    { example: refTarget?.example, examples: nonEmptyExamples(refTarget?.examples) },
  ]);
  // A bare `$ref` to an array component names no model that could carry the
  // component's `description`, `deprecated` and `externalDocs`, so the field
  // takes them when it declares none of its own, as it takes the component's
  // `example`. A `$ref` to a model, named union or enum leaves them on it.
  const alias = refTarget !== undefined && isArrayComponentRef(fieldSchema) ? refTarget : undefined;
  const externalDocs = readExternalDocs(fieldSchema.externalDocs) ?? readExternalDocs(alias?.externalDocs);
  return {
    name: fieldName,
    type: schemaToTypeRef(fieldSchema, fieldName, contextName, siblingProperties),
    required: requiredSet.has(fieldName),
    description: fieldSchema.description ?? alias?.description,
    // The field schema's own link, read like `description`: a sibling of a
    // `$ref` is the field's, and a bare `$ref` gives none — the referenced
    // model carries its own — unless the `$ref` names an array component.
    ...(externalDocs ? { externalDocs } : {}),
    readOnly: fieldSchema.readOnly || undefined,
    writeOnly: fieldSchema.writeOnly || undefined,
    deprecated: fieldSchema.deprecated === true || alias?.deprecated === true || undefined,
    default: fieldSchema.default,
    example,
    // Only materialise the key when there is something to carry so existing
    // inline snapshots of fields without examples stay byte-identical.
    ...(examples ? { examples } : {}),
    // Keywords written beside a `$ref` (legal in OAS 3.1) are the field's own;
    // a bare `$ref` declares none, and the referenced model carries its limits.
    ...constraintsEntry(fieldSchema),
  };
}

/**
 * Build an EnumRef the same way the regular enum path does for naming. The
 * `oneOf`/`anyOf` wrapper is the schema that declares this enum, so its
 * `description` and link are the enum's (`rawDescription`,
 * `rawExternalDocs`), as an inline `enum:` schema's are; the members carry
 * each variant's own documentation (`constUnionEnumMembers`).
 */
function buildSyntheticEnumRef(
  members: readonly EnumMember[],
  contextName: string | undefined,
  parentModelName: string | undefined,
  rawExternalDocs: unknown,
  rawDescription: unknown,
): TypeRef {
  return inlineEnumRef(inlineEnumName(contextName, parentModelName), members, rawExternalDocs, rawDescription);
}

/**
 * The name `schemaToTypeRef` gives an inline enum typed under `contextName`
 * (`GetPetError404`; `status` → `Status`): qualified by `parentModelName`
 * with its list-item markers stripped (`DirectoryListItem` + `State` →
 * `DirectoryState`) unless the name already starts with it (`Connection` +
 * `ConnectionType` → `ConnectionType`), then passed through the active
 * `schemaNameTransform` as a component's name is, so a project's rename map
 * (`RadarAction` → `RadarListAction` in `oagen.config.ts`) reaches inline
 * enums too. One rule for every inline enum: an `enum:` list, a `oneOf` of
 * consts (`buildSyntheticEnumRef`), and the name a deferred body that is an
 * enum is reserved under before it is typed (`inlineEnumSchemaName`).
 */
export function inlineEnumName(contextName: string | undefined, parentModelName: string | undefined): string {
  const baseName = toPascalCase(contextName ?? 'UnknownEnum');
  const cleanParent = parentModelName ? stripListItemMarkers(parentModelName) : undefined;
  const qualifiedName = cleanParent && !baseName.startsWith(cleanParent) ? `${cleanParent}${baseName}` : baseName;
  return activeSchemaNameTransform ? activeSchemaNameTransform(qualifiedName) : qualifiedName;
}

/**
 * How `schemaToTypeRef` types a schema as an inline enum, when it does. The
 * one decision both the typer's enum branches and `inlineEnumSchemaName`
 * read, so the name a pass reserves before a schema is typed and the name
 * the schema is typed under can never disagree. Decided on the schema as
 * the typer sees it at those branches — its nullable wrappers removed, so
 * callers unwrap first (`unwrapNullableSchema`): a `oneOf`/`anyOf` whose
 * non-null variants are string `const` schemas (`constUnionEnumMembers`)
 * with two or more members, or any number beside an `enum:` list that
 * restricts them, is a `const-union` enum of those members; an `enum:` list
 * of any count of non-null members but one is an `enum-list` enum, one
 * alone being a literal; every other shape — a `$ref`, an `allOf`, a union
 * of other variants, an object, an array — is not an enum here (an array's
 * items are the array's question, `inlineEnumSchemaName`).
 */
export function inlineEnumSpelling(schema: SchemaObject): InlineEnumSpelling | undefined {
  const kind = classifyInlineSchema(schema);
  if (kind === 'union') {
    const members = constUnionEnumMembers(schema);
    if (members !== null && (members.length >= 2 || Array.isArray(schema.enum))) {
      return { spelling: 'const-union', members };
    }
    return undefined;
  }
  if (kind === 'enum' && nonNullEnumValues(schema.enum).length !== 1) return { spelling: 'enum-list' };
  return undefined;
}

/** The two spellings of an inline enum `schemaToTypeRef` lifts (`inlineEnumSpelling`), with the const union's members. */
export type InlineEnumSpelling = { spelling: 'const-union'; members: EnumMember[] } | { spelling: 'enum-list' };

/**
 * The enum name `schemaToTypeRef` types `schema` under — a schema it types
 * as an inline enum in either spelling (`inlineEnumSpelling`), under any
 * nullable wrapper, or an array of one, which is lifted under the array's
 * own name — or undefined when it types the schema as something else. Lets
 * a pass reserve the enum's name before the schema is typed
 * (`extractOperations`), whatever the document order of the sites.
 */
export function inlineEnumSchemaName(
  schema: SchemaObject,
  contextName: string | undefined,
  parentModelName: string | undefined,
): string | undefined {
  const inner = unwrapNullableSchema(schema);
  if (classifyInlineSchema(inner) === 'array') {
    const items = inner.items;
    return items && !Array.isArray(items) ? inlineEnumSchemaName(items, contextName, parentModelName) : undefined;
  }
  return inlineEnumSpelling(inner) ? inlineEnumName(contextName, parentModelName) : undefined;
}

/**
 * Detect an implicit discriminator on a `oneOf` whose every variant pins the
 * same property to a const value AND is nameable on its own — by a `$ref` to
 * a component or by a `title` — so the IR can represent the union as
 * discriminated, with a mapping to concrete names, without an explicit
 * `discriminator:` keyword. Returns the property, or null when any variant
 * doesn't fit the pattern or when the variants disagree on which property
 * carries the discriminator. The mapping itself is built by `schemaToTypeRef`
 * from the names `nameInlineVariants` gives the inline variants (their titles
 * unless taken) and the component names of `$ref` variants, so it can only
 * ever point at a model that exists.
 *
 * Both const shapes are supported:
 *   { properties: { event: { const: "x" } }, required: ["event"] }
 *   { properties: { event: { type: "string", enum: ["x"] } } }
 */
function titleMappedDiscriminatorProperty(variants: SchemaObject[]): string | null {
  if (variants.length < 2) return null;
  // Require a $ref or title on every variant so there is a concrete name to map to.
  if (!variants.every((v) => resolveVariantModelName(v) !== null)) return null;

  // The first property whose const value is present on every variant.
  const candidates = Object.keys(variants[0]?.properties ?? {});
  for (const propName of candidates) {
    if (variants.every((v) => getConstPropertyValue(v, propName) !== null)) return propName;
  }
  return null;
}

function getConstPropertyValue(schema: SchemaObject, property: string): string | null {
  const prop = schema.properties?.[property];
  if (!prop) return null;
  if (typeof prop.const === 'string') return prop.const;
  if (Array.isArray(prop.enum) && prop.enum.length === 1 && typeof prop.enum[0] === 'string') {
    return prop.enum[0];
  }
  return null;
}

function resolveVariantModelName(schema: SchemaObject): string | null {
  if (schema.$ref) {
    return resolveSchemaName(schema.$ref.replace(/^#\/components\/schemas\//, ''));
  }
  const title = typeof schema['title'] === 'string' ? (schema['title'] as string) : null;
  if (title) return resolveSchemaName(title);
  return null;
}

/** Look up the discriminator's mapped variant name for an inline object
 *  variant by reading its const-valued discriminator property. Returns null
 *  when the variant doesn't pin the property to a string const, or when
 *  the value isn't in the mapping. */
function mapVariantToDiscriminatorEntry(
  variant: SchemaObject,
  discriminator: { property: string; mapping: Record<string, string> },
): string | null {
  const value = getConstPropertyValue(variant, discriminator.property);
  if (value === null) return null;
  // Own keys only: a const spelled like an inherited property (`constructor`)
  // must not resolve to `Object.prototype`'s.
  return Object.hasOwn(discriminator.mapping, value) ? (discriminator.mapping[value] ?? null) : null;
}

/**
 * Derive a discriminator value → variant model name mapping for an inline-
 * variant `oneOf` from the names `nameInlineVariants` gave its variants
 * (`inlineVariantNames`): the explicit `discriminator:` without a `mapping:`
 * clause, and the implicit const discriminator of anonymous inline variants
 * (`ApiKeyCreatedData.owner`: `ApiKeyCreatedDataOwner`,
 * `UserApiKeyCreatedDataOwner`). Reading the names rather than deriving them
 * again is what keeps the mapping pointing at models the extractors create.
 * Returns null without a context name, when any variant is not an inline
 * object, or when a variant lacks a const value on the property.
 */
function deriveInlineVariantMapping(
  variants: SchemaObject[],
  discriminatorProperty: string,
  contextName: string | undefined,
  inlineVariantNames: ReadonlyMap<SchemaObject, string>,
): Record<string, string> | null {
  if (variants.length === 0 || !contextName) return null;
  const mapping: Record<string, string> = {};
  for (const variant of variants) {
    const variantName = inlineVariantNames.get(variant);
    if (variantName === undefined) return null;
    const constValue = getConstPropertyValue(variant, discriminatorProperty);
    if (constValue === null) return null;
    mapping[constValue] = variantName;
  }
  return mapping;
}

/**
 * The names reserved for a union typed under `contextName`: the set an
 * enclosing field handed down (`reservedNames`, for a union among a field's
 * array items or map values), else the inline names the field's own sibling
 * properties mint (`reservedInlineNames`), else nothing. The extractor
 * derives the same set at each of those levels, so the reference and the
 * model step around a sibling's name identically.
 */
function reservedNamesFor(
  contextName: string | undefined,
  siblingProperties: ReadonlyMap<string, SchemaObject> | undefined,
  parentModelName: string | undefined,
  reservedNames: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (reservedNames) return reservedNames;
  if (contextName === undefined) return NO_RESERVED;
  return reservedInlineNames(contextName, siblingProperties, parentModelName);
}

/**
 * Name the inline object variants of a field's `oneOf`/`anyOf` exactly as the
 * inline-model extractors do (`extractInlineModelsFromProperties` in
 * inline-models.ts, and `extractNestedSchema` / `extractInlineModelDeep`
 * here): the union's base name is the field's qualified inline name, the
 * names the field's sibling properties mint — or the set handed down from an
 * enclosing field — are reserved (`reservedNamesFor`), and
 * `nameInlineVariants` hands out the variant names from there. Returned keyed
 * by variant schema identity.
 */
function nameInlineObjectVariants(
  union: SchemaObject,
  contextName: string | undefined,
  parentModelName: string | undefined,
  siblingProperties: ReadonlyMap<string, SchemaObject> | undefined,
  reservedNames: ReadonlySet<string> | undefined,
): Map<SchemaObject, string> {
  const baseInlineName = qualifyInlineModelName(toPascalCase(contextName ?? 'UnknownModel'), parentModelName);
  return nameInlineVariants(
    union,
    baseInlineName,
    reservedNamesFor(contextName, siblingProperties, parentModelName, reservedNames),
  );
}

/**
 * The TypeRef for an inline object variant whose extracted model is
 * `modelName`, keeping every other type the variant allows. Mirrors what
 * `schemaToTypeRef` builds for the same schema — one member per non-null
 * entry of a `type` array, `union`-wrapped when there is more than one,
 * `nullable`-wrapped when `null` or OAS 3.0 `nullable: true` is present —
 * with the `object` member swapped for a ref to `refName`: the model's own
 * name, or the component the spec's `discriminator.mapping` points the
 * variant's const at, which substitutes for the model exactly as it does
 * inline (`mapVariantToDiscriminatorEntry`).
 * `type: ['object', 'string']` → `union[model, string]`,
 * `['object', 'integer', 'null']` → `nullable<union[model, integer]>`,
 * `['object', 'null']` / `nullable: true` → `nullable<model>`.
 * A `oneOf: [X, { type: 'null' }]` variant has no `properties` of its own
 * and never reaches this path; `schemaToTypeRef` types it directly.
 *
 * Anything inline under a non-object member is named from the variant's
 * model — never from the union's field, and never from the mapping: an
 * `array` member types its items under `modelName` as parent with the
 * context `variantMemberKeys` picks (`item` → `<Variant>Item`, or
 * `array_item` → `<Variant>ArrayItem` when a property claims `item`), and
 * any other member under its `value` key (`<Variant>Value` for an inline
 * enum, else `<Variant>MemberValue`). The extractor materializes those
 * members under the same model (`variantMemberSchemas`), which it builds
 * whether or not the mapping redirects the object member; naming them from
 * the mapped component would reference `CatItem`, which nothing extracts,
 * and naming them from the field would hand variant 0's model name to every
 * variant's items.
 */
function inlineVariantTypeRef(variant: SchemaObject, modelName: string, refName: string = modelName): TypeRef {
  const modelRef: TypeRef = { kind: 'model', name: refName };
  const typeList = Array.isArray(variant.type) ? variant.type : [];
  const nullable = variant.nullable === true || typeList.includes('null');
  const keys = variantMemberKeys(variant, modelName);
  const members = typeList
    .filter((t) => t !== 'null')
    .map((t) =>
      t === 'object'
        ? modelRef
        : schemaToTypeRef({ ...variant, type: t, nullable: false }, t === 'array' ? keys.item : keys.value, modelName),
    );
  const ref: TypeRef = members.length > 1 ? { kind: 'union', variants: members } : modelRef;
  return nullable ? asNullable(ref) : ref;
}

function extractEnum(name: string, schema: SchemaObject): Enum {
  // The members of either spelling (`enumMembersOf`), each with its own
  // `description` and `deprecated`. A `null` member or `type: 'null'`
  // variant marks the schema as nullable (OAS 3.1); it is not a value.
  // Nullability is carried on the `$ref` side via
  // `activeNullableEnumSchemaNames`, so it is dropped here instead of
  // emitting a bogus `NULL = "null"` member.
  const values: EnumValue[] = (enumMembersOf(schema) ?? []).map(toEnumValue);

  const rawDefault = schema.default;
  const def =
    rawDefault !== undefined && values.some((v) => v.value === rawDefault)
      ? (rawDefault as string | number)
      : undefined;

  // The component's own `description` is the enum's, as a model's is its
  // model's; a lifted inline enum takes its schema's the same way
  // (`collectInlineEnumFromRef`). Present only when it has content.
  return {
    name,
    ...descriptionEntry(schema.description),
    values,
    default: def,
    ...externalDocsEntry(schema.externalDocs),
    ...deprecatedEntry(schema),
  };
}
function extractModel(name: string, schema: SchemaObject, schemas?: Record<string, SchemaObject>): Model {
  // An `allOf` component, its own `properties` beside the `allOf` read as
  // its first member (`componentAllOfMembers`).
  if (schema.allOf) {
    return extractAllOfModel(name, schema, schemas);
  }

  const requiredSet = new Set(schema.required ?? []);
  // The sibling set the field extractor derives for this component too, so
  // array items and map values are named the same on both sides.
  const siblings = collectProperties(schema, schemas);

  // Its own `properties`, or — with none — the variants of a pure
  // `oneOf`/`anyOf` flattened as optional fields (`componentPropertyLedger`,
  // the ledger the nested-model lookup and the field pass read too). This
  // handles schemas like UpdateOrganizationMembership which is a oneOf with
  // mutually exclusive field groups (role_slug vs role_slugs); a variant's
  // field is optional whatever the schema's own `required` says, as it was.
  const emptyRequired = new Set<string>();
  const fields: Field[] = [...componentPropertyLedger(name, schema, schemas).values()].map((entry) =>
    buildFieldFromSchema(
      entry.name,
      declaredComponentProperty(entry),
      name,
      entry.unconditional ? requiredSet : emptyRequired,
      schemas,
      siblings,
    ),
  );

  // When additionalProperties is an object schema alongside properties,
  // surface it as a catch-all map field so emitters can generate Map<string, T>.
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && schema.properties) {
    const apKeys = Object.keys(schema.additionalProperties);
    if (apKeys.length > 0) {
      const valueType = schemaToTypeRef(schema.additionalProperties as SchemaObject, 'additionalProperties', name);
      fields.push({
        name: 'additionalProperties',
        type: { kind: 'map', valueType },
        required: false,
        description: 'Additional properties not captured by named fields',
      });
    }
  }

  // A named union keeps its variants and discriminator beside the merged
  // fields, the way the same schema written inline keeps them on its union
  // TypeRef (`namedUnionEntry`). `fields` is untouched, so a consumer that
  // does not read `variants` sees the model it always did.
  return {
    name,
    description: schema.description,
    ...externalDocsEntry(schema.externalDocs),
    fields,
    ...deprecatedEntry(schema),
    ...namedUnionEntry(name, schema, schemas),
    ...constraintsEntry(schema),
  };
}

/** One non-null variant of a named `oneOf`/`anyOf` component schema (see `namedUnionMembers`). */
interface NamedUnionMember {
  /** The variant as written. */
  raw: SchemaObject;
  /** The component schema a `$ref` variant points at (as `extractAllOfModel` resolves its members); `raw` otherwise. */
  resolved: SchemaObject;
  /**
   * The model name the variant is referenced by: an inline object variant's
   * extracted model (`nameNamedUnionVariants`), a `$ref` variant's component.
   * `null` for a variant that is neither (a primitive, an inline enum, an
   * array), which a derived discriminator cannot map.
   */
  name: string | null;
}

/**
 * Everything the parser decides about a named union, decided once and read by
 * both the model (`namedUnionEntry`) and the extractor
 * (`extractNamedUnionVariantModels`), so the variant TypeRefs and the models
 * and enums minted for them agree by construction.
 */
interface NamedUnionPlan {
  compositionKind: 'oneOf' | 'anyOf';
  /** The non-null variants, in document order; `variants[i]` is built from `members[i]`. */
  members: NamedUnionMember[];
  /** The inline object variants' model names (`nameNamedUnionVariants`). */
  inlineNames: ReadonlyMap<SchemaObject, string>;
  /**
   * Every other non-`$ref` variant (a primitive, an inline enum, an array, a
   * map, an `allOf`, a nested union) as a property of one synthetic object:
   * `variant_<n>` → schema, where n is the variant's 1-based position among
   * the non-null variants. Both sides type and extract that object as a
   * field's parent (`schemaToTypeRef` / `extractInlineModelsFromProperties`
   * under the union's name), so whatever a variant mints — an enum, an
   * array's inline items, a map's values, a nested union's variants — is
   * named `<Union>Variant<n>…` by the one rule the field path uses, and two
   * variants of the same kind can never share a name.
   */
  memberProperties: ReadonlyMap<string, SchemaObject>;
  /** The same, keyed by variant. */
  memberContexts: ReadonlyMap<SchemaObject, string>;
  discriminator?: { property: string; mapping: Record<string, string> };
}

/**
 * True when a component schema is a named union: a `oneOf`/`anyOf` with no
 * `allOf` and no `properties` of its own. A `oneOf` beside `properties` keeps
 * today's object model (the properties are its fields, the branches are
 * ignored), as does a component that is only a nullable wrapper around one
 * plain inline object — `oneOf: [{ type: object, … }, { type: 'null' }]` —
 * whose merged fields already are the object (an inline wrapper collapses to
 * `nullable<model>`, not to a union). A wrapper around one `$ref`, one
 * primitive, or one object that also admits another type
 * (`type: ['object', 'string']`) is a union of one: the model has nothing
 * else to say about it, and the other type would be lost.
 */
function isNamedUnionSchema(schema: SchemaObject): boolean {
  if (schema.allOf || (!schema.oneOf && !schema.anyOf)) return false;
  if (Object.keys(schema.properties ?? {}).length > 0) return false;
  // A `oneOf`/`anyOf` of string consts is an enum (`isEnumComponentSchema`), not a union.
  if (isConstUnionEnumSchema(schema)) return false;
  const nonNull = (schema.oneOf ?? schema.anyOf ?? []).filter((v) => !isNullVariantSchema(v));
  return !(nonNull.length === 1 && isPlainObjectSchema(nonNull[0]));
}

/**
 * An inline object that admits nothing but an object (and null): `type:
 * 'object'`, no `type`, `type: ['object', 'null']`, or OAS 3.0 `nullable:
 * true` on one of those. A type list with another member
 * (`['object', 'string']`) is not plain.
 */
function isPlainObjectSchema(schema: SchemaObject | undefined): boolean {
  if (!isInlineObjectSchema(schema)) return false;
  const { type } = schema;
  return !Array.isArray(type) || type.every((t) => t === 'object' || t === 'null');
}

/**
 * The plan for a named union component, or null for any other schema (see
 * `NamedUnionPlan`). Planned once per extraction (`activeNamedUnionMemo`):
 * the model and the extractor both read it, and building it reads every
 * component and every other union (`namedUnionClaimedShapes`).
 */
function planNamedUnion(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): NamedUnionPlan | null {
  const memo = activeNamedUnionMemo?.plans.get(schema);
  if (memo && memo.name === name && memo.schemas === schemas) return memo.plan;
  const plan = buildNamedUnionPlan(name, schema, schemas);
  activeNamedUnionMemo?.plans.set(schema, { name, schemas, plan });
  return plan;
}

function buildNamedUnionPlan(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): NamedUnionPlan | null {
  if (!isNamedUnionSchema(schema)) return null;
  const compositionKind: 'oneOf' | 'anyOf' = schema.oneOf ? 'oneOf' : 'anyOf';
  const inlineNames = nameNamedUnionVariants(name, schema, schemas);
  const members = namedUnionMembers(schema, inlineNames, schemas);
  const memberProperties = new Map<string, SchemaObject>();
  const memberContexts = new Map<SchemaObject, string>();
  const claimed = namedUnionClaimedShapes(name, schema, schemas);
  members.forEach(({ raw }, index) => {
    if (raw.$ref || inlineNames.has(raw)) return;
    const key = memberContext(`variant_${index + 1}`, raw, name, claimed);
    memberProperties.set(key, raw);
    memberContexts.set(raw, key);
  });
  const discriminator = namedUnionDiscriminator(schema, compositionKind, members);
  return {
    compositionKind,
    members,
    inlineNames,
    memberProperties,
    memberContexts,
    ...(discriminator ? { discriminator } : {}),
  };
}

/**
 * The `variants`, `compositionKind` and `discriminator` of a named union
 * component (`Model.variants`), or nothing for any other schema. Built the
 * way `schemaToTypeRef` builds the same union inline: a `$ref` variant is a
 * model/enum ref; an inline object variant is referenced by the model
 * extracted for it, a nullable or multi-type one keeping its wrapper
 * (`inlineVariantTypeRef`); a `type: 'null'` variant is dropped; and every
 * other variant is typed as the `variant_<n>` property of the plan's
 * synthetic object, under the union's name, exactly as the extractor
 * materializes it. The spec's own `mapping:` substitutes for an inline
 * variant's name exactly as it does inline (`mapVariantToDiscriminatorEntry`)
 * — on the object member only: the items or values of a multi-type variant's
 * other members are named from the model the plan extracts for it
 * (`inlineNames`, the name `extractNamedUnionVariantModels` builds them
 * under), so the reference and the model agree whatever the mapping says.
 * Derived mappings are read from the same names, so they can only point at
 * models that exist.
 */
function namedUnionEntry(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): Pick<Model, 'variants' | 'compositionKind' | 'discriminator'> {
  const plan = planNamedUnion(name, schema, schemas);
  if (!plan) return {};
  const { inlineNames, memberContexts, memberProperties, discriminator } = plan;

  const variants: TypeRef[] = plan.members.map(({ raw }) => {
    const inlineName = inlineNames.get(raw);
    if (inlineName !== undefined) {
      const mappedName = discriminator ? mapVariantToDiscriminatorEntry(raw, discriminator) : null;
      return inlineVariantTypeRef(raw, inlineName, mappedName ?? inlineName);
    }
    if (raw.$ref) return schemaToTypeRef(raw);
    return schemaToTypeRef(raw, memberContexts.get(raw), name, memberProperties);
  });

  return { variants, compositionKind: plan.compositionKind, ...(discriminator ? { discriminator } : {}) };
}

/**
 * The non-null variants of a named union, each with the schema its const
 * values and properties are read from (a `$ref` resolved against the
 * components, so a discriminator pinned inside the referenced schema is
 * seen) and the model name it is referenced by.
 */
function namedUnionMembers(
  schema: SchemaObject,
  inlineNames: ReadonlyMap<SchemaObject, string>,
  schemas: Record<string, SchemaObject> | undefined,
): NamedUnionMember[] {
  const members: NamedUnionMember[] = [];
  for (const raw of schema.oneOf ?? schema.anyOf ?? []) {
    if (isNullVariantSchema(raw)) continue;
    let resolved = raw;
    if (raw.$ref) {
      const refName = raw.$ref.split('/').pop() ?? '';
      const target = schemas && Object.hasOwn(schemas, refName) ? schemas[refName] : undefined;
      if (target) resolved = target;
    }
    members.push({ raw, resolved, name: inlineNames.get(raw) ?? resolveVariantModelName(raw) });
  }
  return members;
}

/**
 * Name the inline object variants of a named union component the way a
 * field's union names its own (`nameInlineVariants`), with the union's model
 * name as the base. The base is taken — the union's own model holds it — so
 * variant 0 steps off it like any later variant (`CatPet`, `PetWithLivesLeft`,
 * `Pet1`), and the names in `namedUnionReservedNames` are stepped around.
 */
function nameNamedUnionVariants(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): Map<SchemaObject, string> {
  return nameInlineVariants(schema, name, namedUnionReservedNames(name, schema, schemas), true);
}

/** The IR name of every component schema being extracted, resolved once per extraction. */
function componentModelNames(): ReadonlySet<string> {
  if (activeNamedUnionMemo?.componentNames) return activeNamedUnionMemo.componentNames;
  const names = new Set<string>();
  for (const key of activeComponentSchemaKeys) names.add(resolveSchemaName(key));
  if (activeNamedUnionMemo) activeNamedUnionMemo.componentNames = names;
  return names;
}

/** `schemaShapeKey`, hashed once per extraction for the schemas the named-union plans compare. */
function namedUnionShapeKey(schema: SchemaObject): string {
  const cached = activeNamedUnionMemo?.shapes.get(schema);
  if (cached !== undefined) return cached;
  const key = schemaShapeKey(schema);
  activeNamedUnionMemo?.shapes.set(schema, key);
  return key;
}

/**
 * The names a named union's inline variants must not take: every component
 * schema's name, so a variant titled like a component never shadows it, and
 * every context-free title another named union component keeps for a variant
 * whose shape differs from the one this union gives the same title — the
 * comparison the field path makes between sibling unions
 * (`reservedInlineNames`, `schemaShapeKey`). Each union is read in isolation
 * against the component names alone, so the decision is symmetric: when
 * `Circle` is `{ radius }` on `Shape` and `{ diameter }` on `Marker`, both
 * fall back to their context-qualified names (`CircleShape`, `CircleMarker`)
 * and neither keeps the bare title; when the shapes are identical, both keep
 * `Circle` and one model is emitted. Context-qualified names carry their own
 * union's name and cannot collide across unions.
 */
function namedUnionReservedNames(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): ReadonlySet<string> {
  const componentNames = componentModelNames();
  const reserved = new Set(componentNames);
  if (!schemas) return reserved;

  const ownShapes = new Map<string, string>();
  for (const [variant, entry] of nameInlineVariantEntries(schema, name, componentNames, true)) {
    if (entry.contextFree) ownShapes.set(entry.name, namedUnionShapeKey(variant));
  }
  for (const { variant, entry } of otherNamedUnionVariantEntries(name, schema, schemas, componentNames)) {
    if (entry.contextFree && ownShapes.get(entry.name) !== namedUnionShapeKey(variant)) reserved.add(entry.name);
  }
  return reserved;
}

/**
 * The inline object variants of every other named union component, each
 * with the name it would keep, read in isolation against the component names
 * alone (no cross-union reservations), so every union sees the others the
 * same way and no two can chase each other's names. Each union's entries are
 * named once per extraction (`activeNamedUnionMemo`): every other union's
 * plan reads them, twice.
 */
function otherNamedUnionVariantEntries(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>,
  componentNames: ReadonlySet<string>,
): Array<{ variant: SchemaObject; entry: InlineVariantName }> {
  const entries: Array<{ variant: SchemaObject; entry: InlineVariantName }> = [];
  for (const [key, other] of Object.entries(schemas)) {
    if (other === schema || !isNamedUnionSchema(other)) continue;
    const otherName = resolveSchemaName(key);
    if (otherName === name) continue;
    let otherEntries = activeNamedUnionMemo?.variantEntries.get(other);
    if (!otherEntries) {
      otherEntries = nameInlineVariantEntries(other, otherName, componentNames, true);
      activeNamedUnionMemo?.variantEntries.set(other, otherEntries);
    }
    for (const [variant, entry] of otherEntries) entries.push({ variant, entry });
  }
  return entries;
}

/**
 * Every model or enum name already spoken for when a named union's
 * `variant_<n>` members mint theirs, with the shape of each claimant: every
 * component schema (its own shape), and every inline object variant of every
 * other named union (`otherNamedUnionVariantEntries`). A claimant whose
 * shape is unknown (no component map) is recorded as `null`, which never
 * counts as identical.
 */
function namedUnionClaimedShapes(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): Map<string, Array<string | null>> {
  const claimed = new Map<string, Array<string | null>>();
  const claim = (claimant: string, shape: string | null): void => {
    if (claimant === name) return;
    claimed.set(claimant, [...(claimed.get(claimant) ?? []), shape]);
  };
  if (!schemas) {
    for (const claimant of componentModelNames()) claim(claimant, null);
    return claimed;
  }
  for (const [key, other] of Object.entries(schemas)) claim(resolveSchemaName(key), namedUnionShapeKey(other));
  for (const { variant, entry } of otherNamedUnionVariantEntries(name, schema, schemas, componentModelNames())) {
    claim(entry.name, namedUnionShapeKey(variant));
  }
  return claimed;
}

/**
 * The synthetic property name a non-object variant of a named union is typed
 * and extracted under: `base` (`variant_<n>`) unless a name it would mint
 * under it (`mintedInlineNameEntries`: `PetVariant1` for an inline enum, an
 * array's inline items or a map's inline values, a nested union's variants)
 * is already claimed by a component or by another union's variant of a
 * different shape (`claimed`). An identical shape is shared, as array items
 * share a same-shaped sibling's model; otherwise the context steps exactly as
 * an array's or map's does beside a claiming sibling
 * (`firstFreeElementContext`): `variant_1_item` / `variant_1_value`
 * (`PetVariant1Item`, `PetVariant1Value`), then `variant_1_array_item` /
 * `variant_1_member_value`, then numbered — stopping as soon as a candidate
 * mints the same names as the one before it (a context-free name no context
 * can escape) and at the attempt cap. Both sides read the chosen context
 * from the plan, so every name nested under a stepped variant moves with it.
 */
function memberContext(
  base: string,
  variant: SchemaObject,
  unionName: string,
  claimed: ReadonlyMap<string, ReadonlyArray<string | null>>,
): string {
  const mint = (candidate: string): string[] =>
    mintedInlineNameEntries(candidate, variant, unionName)
      .filter((entry) => !entry.contextFree)
      .map((entry) => entry.name);
  const own = mint(base);
  if (own.length === 0) return base;
  const rivals = own.flatMap((minted) => claimed.get(minted) ?? []);
  if (rivals.length === 0) return base;
  const shape = namedUnionShapeKey(mintingSchema(variant));
  if (rivals.every((rival) => rival === shape)) return base;
  // An array in any spelling (`isArraySchema`: a bare `items`, a nullable
  // type list) steps with `_item`, as the doc says it does; a map with `_value`.
  const kind = isArraySchema(variant) ? 'item' : 'value';
  return firstFreeElementContext(base, kind, new Set(claimed.keys()), mint, own).context;
}

/**
 * The schema whose shape a non-object variant's minted name stands for: an
 * array's items, a map's values, else the variant itself — read with its
 * nullable wrapper removed, as `elementContextDecision` reads an array's
 * items against a claiming sibling, so a nullable array of the claimant's
 * shape shares the claimant's model instead of stepping around it.
 */
function mintingSchema(variant: SchemaObject): SchemaObject {
  const bare = unwrapNullableSchema(variant);
  if (bare.items && isArraySchema(bare)) return mintingSchema(bare.items);
  if (bare.type === 'object' && !bare.properties) {
    const value = mapValueSchema(bare);
    if (value) return mintingSchema(value);
  }
  return bare;
}

/**
 * True for a `components/schemas` entry the parser reads as an array
 * component: a schema `isArraySchema` accepts — `type: 'array'`, an OAS 3.1
 * type list `['array', 'null']`, OAS 3.0 `nullable: true` beside `type:
 * 'array'`, or `items` with no `type` — that declares `items`. An `enum:`
 * list or a `oneOf`/`anyOf` beside the array is read first by
 * `classifyInlineSchema`, so such a schema is an enum or a named union here
 * as it is everywhere else. A `type: 'array'` with no `items` is not an array
 * component: `schemaToTypeRef` types it as unknown, with a warning, so it
 * keeps the fieldless model it always became rather than warning at every
 * reference.
 */
export function isArrayComponentSchema(schema: SchemaObject): boolean {
  return isArraySchema(schema) && schema.items !== undefined;
}

/**
 * Whether a `components/schemas` entry is read as an array component: an
 * array schema itself (`isArrayComponentSchema`), or one `schemaToTypeRef`
 * types as an array through the readings it makes of a `$ref` and an
 * `allOf` — a bare `$ref` to one; an `allOf` read as a plain reference
 * (`readInlineAllOf`: `$ref` members with nothing inline beside them —
 * `allOf: [{ $ref: Pets }]`, `allOf: [{ $ref: Pets }, { maxItems: 10 }]`),
 * read as its first `$ref` member; an `allOf` of one member, read as that
 * member (`unwrappedAllOfMember`) — followed through aliases of aliases, so a
 * `$ref` to the alias resolves to the array exactly as the same schema
 * written on a field does. `properties` written beside the composition are
 * folded in first (`foldSiblingProperties`), as `schemaToTypeRef` folds
 * them. A chain that returns to an entry it has visited names no array:
 * such an entry stays the fieldless model it always became, as an alias of
 * an object component does.
 */
export function isArrayComponentEntry(
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>,
  seen: Set<SchemaObject> = new Set(),
): boolean {
  if (isArrayComponentSchema(schema)) return true;
  if (seen.has(schema)) return false;
  seen.add(schema);
  const folded = foldSiblingProperties(schema);
  const aliasOf = (ref: string | undefined): boolean => {
    const key = ref === undefined ? undefined : componentKeyOf(ref);
    const aliased = key === undefined ? undefined : schemas[key];
    return aliased !== undefined && isArrayComponentEntry(aliased, schemas, seen);
  };
  if (folded.$ref) return aliasOf(folded.$ref);
  if (classifyInlineSchema(folded) !== 'allOf' || !folded.allOf) return false;
  const reading = readInlineAllOf(folded.allOf, folded, schemas);
  if (reading === 'reference') return aliasOf(folded.allOf.find((member) => member.$ref)?.$ref);
  if (reading === 'unwrapped') {
    return isArrayComponentEntry(unwrappedAllOfMember(folded, folded.allOf[0]), schemas, seen);
  }
  return false;
}

/** The `components/schemas` key a `$ref` names, or `undefined` for a `$ref` into another section of the document. */
function componentKeyOf(ref: string): string | undefined {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  return match?.[1];
}

/**
 * The plan for an array component (`ArrayComponentPlan`): the synthetic
 * property its schema is typed and extracted as, under the component's
 * resolved name. The base is `item`, so inline object items are
 * `<Component>Item`, an inline enum `<Component>Item`, the objects of a
 * nested array or map `<Component>Item` as well, and whatever those hold
 * `<Component>Item…`, by the one rule a field's inline models follow. Every
 * name the whole tree mints under a context is read off a rehearsal of the
 * extraction itself (`arrayComponentMints`), so an object nested under the
 * item model (`PetsItemOwner`) or an enum a nested field holds counts
 * exactly as the item model does. When any of them is already claimed for a
 * different shape (`arrayComponentClaims`: any name any extraction pass
 * takes from another entry — its model, enum or array, a discriminated or
 * named-union variant, an object its fields mint, their nested objects and
 * lifted enums — or another array component's tree), the context steps
 * exactly as a named union's `variant_<n>` does
 * (`firstFreeElementContext`): `item_item` (`<Component>ItemItem…`), then
 * `item_array_item`, then numbered, until no name under it is claimed, and
 * every name nested under the tree moves with it. A claimant of the
 * identical shape — the same fields and limits for a model, the same
 * members for an enum — is shared instead, and the tree references it.
 * `own` is the tree's names under `item`; `others` the names every other
 * tree claims — what the plans decided before this one settled on, what the
 * plans after it would mint under `item` — so a stepped tree never lands on
 * a name another tree keeps or steps to, in either direction.
 */
function planArrayComponent(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>,
  own: ArrayComponentMints,
  others: ReadonlyMap<string, ArrayComponentMints>,
  minted: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
): string {
  const claims = arrayComponentClaims(others, minted);
  const contested = [...mintedShapes(own)].some(([minted, shape]) =>
    (claims.get(minted) ?? []).some((rival) => rival !== shape),
  );
  if (!contested) return 'item';
  const names = (mints: ArrayComponentMints): string[] => [...mintedShapes(mints).keys()];
  return firstFreeElementContext(
    'item',
    'item',
    new Set(claims.keys()),
    (candidate) => names(arrayComponentMints(name, schema, schemas, candidate)),
    names(own),
  ).context;
}

/** The rounds `extractSchemas` gives the array components' plans to settle; two suffice unless trees chase each other's names. */
const MAX_ARRAY_COMPONENT_ROUNDS = 8;

/** The shape key of every name a tree mints: a model's fingerprint, an inline enum's members. */
function mintedShapes(mints: ArrayComponentMints): Map<string, string> {
  const shapes = new Map<string, string>();
  for (const model of mints.models) shapes.set(model.name, modelShapeKey(model));
  for (const [enumName, values] of mints.enums) shapes.set(enumName, enumShapeOf(values));
  return shapes;
}

/** The shape a model stands for when a name is contested: its fingerprint, the key every clash check in the parser reads. */
function modelShapeKey(model: Model): string {
  return `model:${modelFingerprint(model)}`;
}

/** The shape an enum stands for when a name is contested: its members, each with its deprecation. */
function enumShapeOf(values: readonly EnumValue[]): string {
  return `enum:${enumShapeKey(values)}`;
}

/**
 * Every model and inline enum an array component's items would mint under
 * `context`: a rehearsal of both sides — the extractor
 * (`extractInlineModelsFromProperties`) for the models, `schemaToTypeRef`
 * for the inline enums the items are or hold, read off the TypeRef it builds
 * and the fields of the models built — so the names are the ones the real
 * extraction produces, with no second copy of the naming rules to keep in
 * step. The models are built with every array component provisionally
 * registered (`extractSchemas`), so their fingerprints read a `$ref` to one
 * as the array the real pass types; the enums are read with none registered
 * (`withoutArrayComponents`), so an enum another component's items hold is
 * never counted as this tree's own. The rehearsal is silent and leaves no
 * trace (`rehearse`).
 */
function arrayComponentMints(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>,
  context: string,
): ArrayComponentMints {
  return rehearse(() => {
    const extract = (): Model[] => {
      const models: Model[] = [];
      extractInlineModelsFromProperties({ properties: { [context]: schema } }, models, name, schemas);
      return models;
    };
    const models = extract();
    const enums = withoutArrayComponents(() =>
      liftedEnums([
        schemaToTypeRef(schema, context, name, new Map([[context, schema]])),
        ...extract().flatMap((model) => collectModelTypeRefs(model)),
      ]),
    );
    return { models, enums };
  });
}

/** Every inline enum `refs` hold — an `EnumRef` carrying `values` — by name, with its members; the first occurrence of a name decides, as the lift does. */
function liftedEnums(refs: readonly TypeRef[]): Map<string, EnumValue[]> {
  const enums = new Map<string, EnumValue[]>();
  for (const ref of refs) {
    walkTypeRef(ref, {
      enum: (r) => {
        if (r.values && !enums.has(r.name)) enums.set(r.name, enumValuesOf(r));
      },
    });
  }
  return enums;
}

/**
 * The plan of an array component under `context`: what `extractSchemas`
 * registers for a tree while the plans are decided — so a `$ref` to it
 * resolves to its array in every rehearsal, as the real pass types it, under
 * the names the tree carries at that point — and, once a round moves
 * nothing, for good.
 */
function arrayComponentPlan(key: string, schema: SchemaObject, context: string): ArrayComponentPlan {
  return {
    key,
    name: resolveSchemaName(key),
    schema,
    context,
    properties: new Map([[context, schema]]),
    warnedSelfReference: false,
  };
}

/**
 * Run `fn` with no array component registered, so a `$ref` to one is a
 * plain model reference that mints nothing: the way the names a tree mints
 * are read, so another component's items are never counted among them.
 */
function withoutArrayComponents<T>(fn: () => T): T {
  const plans = activeArrayComponentPlans;
  activeArrayComponentPlans = new Map();
  try {
    return fn();
  } finally {
    activeArrayComponentPlans = plans;
  }
}

/**
 * Run `fn` as a rehearsal whose output is discarded: `console.warn` is
 * silenced, and the memory of which unions' fold warnings were already
 * reported is set aside and restored, so every warning the schema deserves
 * is printed once, by the extraction that keeps the models.
 */
function rehearse<T>(fn: () => T): T {
  const warn = console.warn;
  const reported = reportedUncarriedProperties;
  console.warn = () => {};
  reportedUncarriedProperties = new WeakSet();
  try {
    return fn();
  } finally {
    console.warn = warn;
    reportedUncarriedProperties = reported;
  }
}

/**
 * Every name a `components/schemas` entry takes when it is extracted, each
 * with the shape(s) it stands for, read off a rehearsal of the passes that
 * take them rather than a list of those passes kept in step by hand: the
 * entry's own name — a model's fingerprint (`extractModel`), an enum's
 * members (`extractEnum`), or `'array'` for an array component, a shape no
 * model or enum can share — its discriminated allOf+oneOf variants
 * (`extractDiscriminatedAllOfVariantModels`), its named-union variants and
 * `variant_<n>` members (`extractNamedUnionVariantModels`), the inline
 * models its fields mint (`extractInlineModelsFromSchemas`, the field pass),
 * everything nested under any of those, and every inline enum those
 * models' fields hold — so an array component's plan steps around exactly
 * the names the real passes will take, and an `Event` whose variant pins
 * `type: 'pets_item'` keeps its `PetsItem` while `Pets`'s items step. A name
 * two passes mint for one entry carries both shapes. The models are built
 * with every array component provisionally registered, so a field that is a
 * `$ref` to one is fingerprinted as the array the real pass types; the
 * enums are read with none registered (`withoutArrayComponents`), so an
 * enum another component's items hold is never claimed for this entry. An
 * array component's items are not read here: their names come from its plan
 * (`others`), under the context it settles on.
 */
function componentMints(
  key: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>,
): ReadonlyMap<string, readonly string[]> {
  const name = resolveSchemaName(key);
  return rehearse(() => {
    const shapes = new Map<string, string[]>();
    const claim = (minted: string, shape: string): void => {
      shapes.set(minted, [...(shapes.get(minted) ?? []), shape]);
    };
    if (isEnumComponentSchema(schema)) {
      claim(name, enumShapeOf(extractEnum(name, schema).values));
      return shapes;
    }
    if (isArrayComponentEntry(schema, schemas)) {
      claim(name, 'array');
      return shapes;
    }
    const extract = (): Model[] => [
      extractModel(name, schema, schemas),
      ...extractDiscriminatedAllOfVariantModels(schema, name, schemas),
      ...extractNamedUnionVariantModels(schema, name, schemas),
      ...extractInlineModelsFromSchemas({ [key]: schema }),
    ];
    for (const model of extract()) claim(model.name, modelShapeKey(model));
    const enums = withoutArrayComponents(() => liftedEnums(extract().flatMap((model) => collectModelTypeRefs(model))));
    for (const [enumName, values] of enums) claim(enumName, enumShapeOf(values));
    return shapes;
  });
}

/**
 * Every name an array component's item tree must not take for a shape of
 * its own, each with the shape(s) it stands for: every name every other
 * entry takes (`minted`, see `componentMints`) and every model and enum
 * every other array component's tree mints (`others`: settled or isolated,
 * as `planArrayComponent` says). A claimant of the identical shape is
 * shared, so two trees that mint one name for one shape keep it and one
 * model is emitted.
 */
function arrayComponentClaims(
  others: ReadonlyMap<string, ArrayComponentMints>,
  minted: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  const claim = (claimant: string, shape: string): void => {
    claims.set(claimant, [...(claims.get(claimant) ?? []), shape]);
  };
  for (const names of minted.values()) {
    for (const [name, shapes] of names) for (const shape of shapes) claim(name, shape);
  }
  for (const mints of others.values()) {
    for (const [name, shape] of mintedShapes(mints)) claim(name, shape);
  }
  return claims;
}

/**
 * The models an array component's items reference that nothing else
 * materializes — an inline object item, the object variants of an
 * `items.oneOf`, the objects of a nested array or map, an `allOf`, and
 * everything nested under them — extracted by the field extractor from the
 * plan's synthetic property under the component's resolved name, exactly as
 * `arrayComponentTypeRef` types it. Nothing for an alias of another array
 * component, whose `$ref` mints nothing.
 */
function extractArrayComponentModels(key: string, schemas: Record<string, SchemaObject>): Model[] {
  const plan = activeArrayComponentPlans.get(key);
  if (!plan) return [];
  const models: Model[] = [];
  extractInlineModelsFromProperties({ properties: Object.fromEntries(plan.properties) }, models, plan.name, schemas);
  return models;
}

/**
 * The TypeRef a `$ref` to the array component under `key` resolves to: the
 * array the component declares, built by `schemaToTypeRef` from the plan's
 * synthetic property under the component's resolved name — so a nullable
 * type list or OAS 3.0 flag on the component wraps it in `nullable`, an
 * alias (`isArrayComponentEntry`) resolves to the component it names, `$ref`
 * items stay the references they are (to a model, an enum, or another array
 * component, which resolves in turn), and inline items are named
 * `<Component>Item…` as `extractArrayComponentModels` builds them. A fresh
 * TypeRef per reference, since later passes rename references in place. A
 * component reached again while its own reference is being built — `Tree:
 * { type: 'array', items: { $ref: Tree } }`, directly or through another
 * array component or an alias — has no finite type in the IR: that inner
 * reference is typed as unknown, with one warning per component, naming the
 * key as the document writes it. `undefined` for any other key.
 */
function arrayComponentTypeRef(key: string): TypeRef | undefined {
  const plan = activeArrayComponentPlans.get(key);
  if (!plan) return undefined;
  if (resolvingArrayComponents.has(key)) {
    if (!plan.warnedSelfReference) {
      plan.warnedSelfReference = true;
      console.warn(
        `[oagen] Warning: Array component "${key}" refers to itself through its items — the inner reference is typed as unknown`,
      );
    }
    return { kind: 'primitive', type: 'unknown' };
  }
  resolvingArrayComponents.add(key);
  try {
    return schemaToTypeRef(plan.schema, plan.context, plan.name, plan.properties);
  } finally {
    resolvingArrayComponents.delete(key);
  }
}

/**
 * Whether `schema` is a `$ref` to an array component — by the key the `$ref`
 * names, as `schemaToTypeRef` resolves it — under any nullable wrapper
 * `unwrapNullableSchema` strips, so a reader that asks whether a property is
 * an array from the document (`detectListEnvelope`, `buildFieldFromSchema`)
 * answers for a reference as `schemaToTypeRef` types it. False outside an
 * extraction, as a `$ref` to an enum component is a model reference there.
 */
export function isArrayComponentRef(schema: SchemaObject | undefined): boolean {
  if (!schema) return false;
  const { $ref } = unwrapNullableSchema(schema);
  if (!$ref) return false;
  const segments = $ref.split('/');
  return activeArrayComponentPlans.has(segments[segments.length - 1]);
}

/**
 * The discriminator of a named union, resolved from the same four sources
 * `schemaToTypeRef` reads for an inline union, in the same order, with a
 * `$ref` variant's const read from the component it points at:
 *   1. An explicit `discriminator:` with a `mapping:` — the spec's own, each
 *      target reduced to the IR model name it refers to (the last `$ref`
 *      segment through `resolveSchemaName`, so `schemaNameTransform` applies,
 *      as it does to every mapping value `Model.discriminator` carries). An
 *      entry naming a schema outside the variant list is kept as written.
 *   2. An explicit `discriminator:` without `mapping:` — each variant's const
 *      on the property paired with its model name; `{}` when any variant
 *      pins none or is unnamed, as `deriveInlineVariantMapping` leaves it.
 *   3./4. No keyword, `oneOf` only — when every variant is named, the first
 *      property the first variant pins whose values are distinct across all
 *      of them, with that mapping (`titleMappedDiscriminatorProperty` /
 *      `deriveConstNamingDiscriminator` for an inline union). A constant
 *      every variant shares (`version: 'v1'`) is passed over, not taken as
 *      proof there is no discriminator; an unnamed variant is no signal, and
 *      an `anyOf` is never discriminated implicitly.
 */
function namedUnionDiscriminator(
  schema: SchemaObject,
  compositionKind: 'oneOf' | 'anyOf',
  members: readonly NamedUnionMember[],
): { property: string; mapping: Record<string, string> } | undefined {
  if (schema.discriminator) {
    const property = schema.discriminator.propertyName;
    const explicit = Object.entries(schema.discriminator.mapping ?? {});
    const mapping: Record<string, string> =
      explicit.length > 0
        ? Object.fromEntries(
            explicit.map(([value, target]) => [value, resolveSchemaName(target.split('/').pop() ?? '')]),
          )
        : (namedUnionConstMapping(members, property) ?? {});
    return { property, mapping };
  }
  if (compositionKind !== 'oneOf' || members.length < 2) return undefined;
  if (members.some((m) => m.name === null)) return undefined;
  const first = members[0];
  if (!first) return undefined;
  for (const property of Object.keys(getEffectiveProperties(first.resolved))) {
    const mapping = namedUnionConstMapping(members, property);
    if (mapping) return { property, mapping };
  }
  return undefined;
}

/**
 * `property`'s const value on every member paired with the member's model
 * name, or null when any member is unnamed, pins no string const on the
 * property (through its `allOf` wrappers, like an allOf+oneOf variant), or
 * repeats another member's value. Collected in a Map, so a value spelled like
 * an inherited property (`constructor`, `toString`) is neither mistaken for a
 * duplicate nor lost; the result has every value as an own key.
 */
function namedUnionConstMapping(members: readonly NamedUnionMember[], property: string): Record<string, string> | null {
  if (members.length === 0) return null;
  const mapping = new Map<string, string>();
  for (const member of members) {
    if (member.name === null) return null;
    const value = getEffectiveConstPropertyValue(member.resolved, property);
    if (value === null || mapping.has(value)) return null;
    mapping.set(value, member.name);
  }
  return Object.fromEntries(mapping);
}

/**
 * The models a named union component's variants reference that nothing else
 * materializes, extracted by the field extractor so every object shape
 * `schemaToTypeRef` references — a nested object with or without `type`, an
 * array's or map's inline items, an `allOf`, a nested union — is
 * materialized under the name the reference uses: each inline object variant
 * under the name `nameNamedUnionVariants` gave it, with everything nested
 * under it and, for a multi-type variant, the members of its other types,
 * exactly as the extractor's own union branch does; and the plan's synthetic
 * object of every other variant (`variant_<n>`), extracted under the union's
 * name as the TypeRefs were typed. Nothing for a schema that is not a named
 * union.
 */
function extractNamedUnionVariantModels(
  schema: SchemaObject,
  name: string,
  schemas?: Record<string, SchemaObject>,
): Model[] {
  const plan = planNamedUnion(name, schema, schemas);
  if (!plan) return [];
  const models: Model[] = [];
  for (const [variant, variantName] of plan.inlineNames) {
    models.push(buildInlineModel(variantName, variant, schemas));
    extractInlineModelsFromProperties(variant, models, variantName, schemas);
    extractInlineModelsFromProperties(
      { properties: variantMemberSchemas(variant, variantName) },
      models,
      variantName,
      schemas,
    );
  }
  if (plan.memberProperties.size > 0) {
    extractInlineModelsFromProperties({ properties: Object.fromEntries(plan.memberProperties) }, models, name, schemas);
  }
  return models;
}

/** A dispatcher's discriminator: the property every variant pins, and the model each value selects. */
type AllOfDiscriminator = { property: string; mapping: Record<string, string> };

/**
 * The variants of the union a schema carries — `oneOf`, else `anyOf` — or
 * `undefined` for a schema carrying none. The one keyword test every
 * reader of a component's `allOf` + union applies: the member reader that
 * detects a dispatcher or flattens the variants (`readComponentAllOfMember`),
 * the variant builder (`extractDiscriminatedAllOfVariantModels`, its axis
 * and its variant loop), a pure union's flattening
 * (`componentPropertyLedger`) and a variant's nested unions
 * (`flattenVariantForExtraction`) — so a union detected as a dispatcher is
 * the union whose variant models are built, whichever keyword spells it
 * (workos/oagen#359 review: an `anyOf` axis was dispatched but its variants
 * were not built, and the mapping named a model nothing created).
 */
export function unionVariantsOf(schema: SchemaObject): SchemaObject[] | undefined {
  return schema.oneOf ?? schema.anyOf;
}

/**
 * Read one member of a component's `allOf` into `ledger` and `required`,
 * each declaration with its provenance (`declareProperty`). A `$ref` member
 * is resolved to its component, through a chain of references; a component
 * met again on the chain declares nothing more. An `allOf` member — a
 * component composed with `allOf`, or an inline wrapper — is read by
 * `readComponentAllOf`, so a declaration it makes under a `oneOf`/`anyOf`
 * variant stays branch-only however deep it sits; its own discriminator, if
 * any, is its own model's and is not returned (the model reading it carries
 * the base fields only). Every member contributes its own `properties` as
 * always-applying and its own `required` — beside a `oneOf`/`anyOf` too. A
 * member's `oneOf`/`anyOf` with exactly one non-null variant beside `null`
 * is a nullable wrapper, not a union — decided by `nullableUnionBranch`, the
 * definition `unwrapNullableSchema` collapses by, which `mergeAllOfMembers`
 * reads an inline member through and the envelope collector reads every
 * member through (`resolveBareSchema`) — and that variant is read as one
 * more member, in this member's own capacity: `{ oneOf: [{ $ref: Base }, {
 * type: 'null' }] }` applies `Base` whole, its `$ref` followed and its
 * `required` read, since an instance that is not null is a `Base` and
 * beside an object member it is never null (workos/oagen#308: read as a
 * union, `Base`'s `has_more` ended the operation's iteration but was
 * missing from the model); the wrapper itself is recorded as read, so a
 * component that wraps a reference to itself ends there. A member's
 * `oneOf`/`anyOf` whose variants pin one property to distinct consts is a
 * dispatcher (`detectAllOfVariantDiscriminator`): its variants' properties
 * are not read, and the discriminator is returned; otherwise every
 * variant's properties are read as branch-only, and a variant's `required`
 * is not read, since its properties are present only on that branch. With
 * `readVariants` false the union is not read at all — the dispatcher base
 * reads the variant axis for its own properties only — while a nullable
 * wrapper, never a variant axis, is still applied. Shared by
 * `extractAllOfModel` and the dispatcher base of
 * `extractDiscriminatedAllOfVariantModels`, so the two read a member alike.
 */
function readComponentAllOfMember(
  name: string,
  member: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
  ledger: Map<string, PropertyDeclarations>,
  required: Set<string>,
  seen: Set<SchemaObject>,
  readVariants = true,
): AllOfDiscriminator | undefined {
  const resolved = followMemberRefs(member, schemas, seen);
  if (!resolved) return undefined;
  if (resolved.allOf) {
    readComponentAllOf(name, resolved, schemas, ledger, required, seen);
    return undefined;
  }
  // The member's own `properties` and `required` always apply, whether or
  // not a `oneOf`/`anyOf` sits beside them (workos/oagen#359 review: a
  // member `{ properties: { x }, oneOf: […] }`, inline or a `$ref` to such a
  // component, lost `x`, while the same schema as a body kept it).
  for (const r of resolved.required ?? []) required.add(r);
  for (const [key, value] of Object.entries(resolved.properties ?? {})) {
    if (value) declareProperty(ledger, key, value, null, false);
  }
  // A nullable wrapper is its one non-null variant, read as one more member
  // in this member's own capacity (`nullableUnionBranch`); the wrapper is
  // recorded so a component that wraps a reference to itself ends here.
  const branch = nullableUnionBranch(resolved);
  if (branch) {
    if (seen.has(resolved)) return undefined;
    seen.add(resolved);
    return readComponentAllOfMember(name, branch, schemas, ledger, required, seen, readVariants);
  }
  const variants = unionVariantsOf(resolved);
  if (!variants || !readVariants) return undefined;
  // Detect discriminated union: every variant pins the same property to a
  // distinct const value (e.g. EventSchema where each variant has event: const).
  // When detected, store the discriminator instead of flattening variant fields —
  // the base allOf schema already captures the common fields.
  const discriminator = detectAllOfVariantDiscriminator(variants, name);
  if (discriminator) return discriminator;
  // Flatten oneOf/anyOf variant fields into the parent model as optional
  // fields. This handles the common allOf + oneOf pattern where the spec
  // uses mutually exclusive variant groups (e.g. password vs password_hash).
  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.properties ?? {})) {
      if (value) declareProperty(ledger, key, value, null, true);
    }
  }
  return undefined;
}

/**
 * Read a component schema's `allOf` — its own `properties` and `required`
 * first (`componentAllOfMembers`), then each member through
 * `readComponentAllOfMember` — into `ledger` and `required`, and return the
 * discriminator a direct `oneOf`/`anyOf` member declares, if any. A schema
 * reached again on the chain declares nothing more (`seen`), so a component
 * that names itself, or two members naming one component, terminate.
 */
function readComponentAllOf(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
  ledger: Map<string, PropertyDeclarations>,
  required: Set<string>,
  seen: Set<SchemaObject> = new Set(),
): AllOfDiscriminator | undefined {
  if (seen.has(schema)) return undefined;
  seen.add(schema);
  let discriminator: AllOfDiscriminator | undefined;
  for (const member of componentAllOfMembers(schema)) {
    discriminator = readComponentAllOfMember(name, member, schemas, ledger, required, seen) ?? discriminator;
  }
  // The component's own `required`: carried by its own member when it
  // declares properties, and read here when it only names inherited ones
  // (`Pup: { allOf: [{ $ref: Dog }], required: [breed] }`).
  for (const r of schema.required ?? []) required.add(r);
  return discriminator;
}

/**
 * The schema that types a property a component declares: the always-applying
 * declaration `declareProperty` settles on — the first that declares a type,
 * a typeless one only annotating it (`combineDeclarations`) — else the first
 * branch's.
 * A component flattens a union's branches as written; the union of distinct
 * branch declarations `mergeAllOfMembers` builds for an inline `allOf` is not
 * built here, since no pass would materialize its inline variants under a
 * component. Read over `componentPropertyLedger` by every pass that builds a
 * field or a model nested under one, so they agree on the declaration.
 */
export function declaredComponentProperty(entry: PropertyDeclarations): SchemaObject {
  return entry.unconditional?.schema ?? entry.conditional[0]!;
}

/**
 * The model of a component schema composed with `allOf` (`extractModel`).
 * The members are read in document order (`readComponentAllOf`), the
 * component's own `properties` and `required` first as one more member
 * (`componentAllOfMembers`); a `$ref` member's component is read the same
 * way, its own properties and then its members, so a chain
 * (`Puppy → Dog → Pet`) carries every level's own properties. Every field is
 * typed under the component's own name with one sibling set
 * (`collectProperties`), from the one declaration
 * `declaredComponentProperty` picks: the always-applying declaration
 * `declareProperty` settles on — the first that declares a type, the
 * component's own first, a typeless one only annotating it — whatever a
 * `oneOf`/`anyOf` variant declares
 * before or after it and at whatever depth — the precedence
 * `declareProperty` gives `mergeAllOfMembers` too — and `required` is the
 * union of every always-applying member's list and the component's own; a
 * variant's `required` is not read. A `oneOf`/`anyOf` member whose variants
 * pin one property to distinct consts makes the model a dispatcher
 * (`detectAllOfVariantDiscriminator`; its variants are built by
 * `extractDiscriminatedAllOfVariantModels`); otherwise the variants' inline
 * properties are flattened in as optional fields.
 */
function extractAllOfModel(name: string, schema: SchemaObject, schemas?: Record<string, SchemaObject>): Model {
  // One sibling set for every field of the composed model, nested `allOf`
  // levels included, matching what the field extractor derives for it.
  const siblings = collectProperties(schema, schemas);
  const ledger = new Map<string, PropertyDeclarations>();
  const requiredSet = new Set<string>();
  const discriminator = readComponentAllOf(name, schema, schemas, ledger, requiredSet);
  const fields = [...ledger.values()].map((entry) =>
    buildFieldFromSchema(entry.name, declaredComponentProperty(entry), name, requiredSet, schemas, siblings),
  );

  return {
    name,
    description: schema.description,
    ...externalDocsEntry(schema.externalDocs),
    fields,
    ...(discriminator ? { discriminator } : {}),
    // Deprecation is the wrapper's own: a member's flag is not read — a `$ref`
    // member's stays on the referenced model — as `Field.deprecated` ignores
    // it on an allOf field.
    ...deprecatedEntry(schema),
    // The wrapper's own keywords conjoined with its inline members'; `$ref`
    // members keep theirs on the referenced model.
    ...constraintsEntry(schema),
  };
}

/**
 * Walk through `allOf` wrappers to collect the effective top-level properties
 * of a schema. Stops at `oneOf` / `anyOf` boundaries — those are different
 * variant axes, not part of the same flat object.
 *
 * Used by `detectAllOfVariantDiscriminator` and `deriveDiscriminatedVariantName`
 * so a oneOf variant of the form `{ allOf: [{ properties: { … } }, { oneOf: […] }] }`
 * still surfaces its top-level `properties` (in particular its discriminator
 * `const`) instead of being treated as having none.
 */
function getEffectiveProperties(schema: SchemaObject): Record<string, SchemaObject> {
  // Collected in a `Map` and returned through `Object.fromEntries`, so a
  // property named `__proto__` is an own entry rather than the prototype.
  const props = new Map<string, SchemaObject>();
  const visit = (s: SchemaObject): void => {
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      if (!props.has(k) && v) props.set(k, v);
    }
    for (const sub of s.allOf ?? []) visit(sub);
    // Do NOT walk into oneOf / anyOf — those are alternatives, not
    // simultaneously-present properties.
  };
  visit(schema);
  return Object.fromEntries(props);
}

function getEffectiveConstPropertyValue(schema: SchemaObject, property: string): string | null {
  const direct = getConstPropertyValue(schema, property);
  if (direct !== null) return direct;
  const effective = getEffectiveProperties(schema)[property];
  if (!effective) return null;
  if (typeof effective.const === 'string') return effective.const;
  if (Array.isArray(effective.enum) && effective.enum.length === 1 && typeof effective.enum[0] === 'string') {
    return effective.enum[0];
  }
  return null;
}

/**
 * Detect an implicit discriminator on an allOf+oneOf where every variant is an
 * object that pins the same property to a distinct const value. Unlike
 * detectConstPropertyDiscriminator (which requires $ref or title for variant
 * model names), this version derives model names from the const value itself
 * using deriveDiscriminatedVariantName — matching how extractDiscriminatedAllOfVariantModels
 * names those models.
 *
 * Walks through allOf wrappers on each variant so a oneOf branch like
 *   { allOf: [{ properties: { type: { const: 'oauth' } } }, { oneOf: […] }] }
 * still surfaces `type` as a candidate discriminator.
 *
 * Returns null when no discriminator can be reliably detected.
 */
function detectAllOfVariantDiscriminator(
  variants: SchemaObject[],
  fallbackName: string,
): { property: string; mapping: Record<string, string> } | null {
  // A single const-pinned variant dispatches too: its model is built and
  // the mapping names it, as `extractDiscriminatedAllOfVariantModels` builds
  // a variant model exactly for a union this detection accepts.
  if (variants.length === 0) return null;

  // Find a property whose const value is present on every variant
  // (looking through allOf wrappers on each variant).
  const firstProps = getEffectiveProperties(variants[0] ?? {});
  let candidateProperty: string | null = null;
  for (const propName of Object.keys(firstProps)) {
    if (variants.every((v) => getEffectiveConstPropertyValue(v, propName) !== null)) {
      candidateProperty = propName;
      break;
    }
  }
  if (!candidateProperty) return null;

  const mapping: Record<string, string> = {};
  const seenModelNames = new Set<string>();
  for (const v of variants) {
    const value = getEffectiveConstPropertyValue(v, candidateProperty);
    if (value === null) return null;
    const modelName = deriveDiscriminatedVariantName(v, fallbackName);
    // If two variants map to the same model name, the discriminator is ambiguous
    if (seenModelNames.has(modelName)) return null;
    seenModelNames.add(modelName);
    mapping[value] = modelName;
  }

  return { property: candidateProperty, mapping };
}

/**
 * The component an `allOf` member names, followed through a chain of
 * references (`Hop: { $ref: Alias }`), or the member itself when it is no
 * reference; `undefined` when the chain repeats or reaches a component
 * already read on this walk (`seen`), which then declares nothing more. The
 * one reference-following every reader of a component's member shares:
 * `readComponentAllOfMember` reads the member it lands on, and `memberUnion`
 * finds the union it carries.
 */
function followMemberRefs(
  member: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
  seen: Set<SchemaObject>,
): SchemaObject | undefined {
  let resolved = member;
  const chain = new Set<SchemaObject>();
  while (resolved.$ref) {
    const segments = resolved.$ref.split('/');
    const refName = segments[segments.length - 1];
    if (!schemas || !refName || !Object.hasOwn(schemas, refName)) break;
    const target = schemas[refName]!;
    if (seen.has(target) || chain.has(target)) return undefined;
    chain.add(target);
    resolved = target;
  }
  return resolved;
}

/**
 * The union a component's `allOf` member carries, read through every wrapper
 * `readComponentAllOfMember` reads the member through — a chain of
 * references (`followMemberRefs`), then a nullable union wrapper
 * (`nullableUnionBranch`) to its one non-null variant, the two alternating
 * — and `undefined` for a member that carries none, or an `allOf` member
 * (read as a component composed with `allOf`, never as a variant axis). The
 * one way the variant builder (`extractDiscriminatedAllOfVariantModels`)
 * finds a variant axis, so a union the member reader detects as a
 * dispatcher is the union whose variant models are built, whichever wrapper
 * it sits under (workos/oagen#308 merge review: a dispatcher detected
 * through `{ oneOf: [{ oneOf: [A, B] }, { type: 'null' }] }` mapped its
 * tags to models nothing built, since the builder looked at each direct
 * member's union only).
 */
function memberUnion(
  member: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): SchemaObject[] | undefined {
  const seen = new Set<SchemaObject>();
  let resolved: SchemaObject | undefined = member;
  for (;;) {
    resolved = followMemberRefs(resolved, schemas, seen);
    if (!resolved || resolved.allOf) return undefined;
    const branch = nullableUnionBranch(resolved);
    if (!branch) return unionVariantsOf(resolved);
    if (seen.has(resolved)) return undefined;
    seen.add(resolved);
    resolved = branch;
  }
}

function extractDiscriminatedAllOfVariantModels(
  schema: SchemaObject,
  fallbackName: string,
  schemas?: Record<string, SchemaObject>,
): Model[] {
  const models: Model[] = [];
  const seenNames = new Set<string>();

  // Collect base-object properties + required from the allOf wrapper so each
  // variant can be emitted as a complete, self-contained type. Schemas like
  // `EventSchema` repeat the base fields inside every variant in the spec
  // (so this merge is a no-op there), but `ConnectApplication`'s OAuth /
  // M2M variants don't — without this, dispatcher consumers would get a
  // variant that's missing the shared `id` / `name` / `object` etc.
  // The base: every declaration the members other than the variant axis
  // make, read exactly as `extractAllOfModel` reads them
  // (`readComponentAllOfMember`, with the component's own `properties` and
  // `required` first — `componentAllOfMembers` — so what the component
  // declares beside its `allOf` is a base field every variant carries, as a
  // member's is) and resolved by the same precedence: the first
  // always-applying declaration; a declaration a nested union's branch makes
  // is a fallback the base carries as optional. Names are matched by own
  // name (`Map`, `Object.fromEntries`), so a base property named
  // `constructor`, `toString` or `__proto__` reaches every variant.
  const members = componentAllOfMembers(schema);
  // The variant axis: a member carrying a `oneOf`/`anyOf` — read through a
  // reference chain and a nullable wrapper exactly as `readComponentAllOfMember`
  // reads it (`memberUnion`) — whose variants pin one property to distinct
  // consts — the reading `extractAllOfModel` makes of it
  // (`detectAllOfVariantDiscriminator`) — so a variant model exists exactly
  // when the component's model dispatches to it. A union that is not an
  // axis is flattened into the model and builds no variant model here
  // (workos/oagen#359 review: it did, and a model nested under such a
  // variant took the name of the flattened field's own model).
  const axisVariants = new Map<SchemaObject, SchemaObject[]>();
  for (const m of members) {
    const variants = memberUnion(m, schemas);
    if (variants !== undefined && detectAllOfVariantDiscriminator(variants, fallbackName) !== null) {
      axisVariants.set(m, variants);
    }
  }
  const axes = new Set(axisVariants.keys());
  if (axes.size === 0) return models;
  const ledger = new Map<string, PropertyDeclarations>();
  const baseRequired = new Set<string>();
  const seen = new Set<SchemaObject>([schema]);
  // Shared limits every variant instance must satisfy under allOf semantics:
  // the outer wrapper's own keywords, each base member's (through its allOf
  // wrappers), and any written beside the `oneOf` itself — everything except
  // the branches. They ride along with the base properties and are conjoined
  // with each variant's own below, so on a shared keyword the stricter bound
  // wins.
  let baseConstraints = ownConstraints(schema);
  for (const subSchema of members) {
    if (axes.has(subSchema)) {
      // The axis: its branches are handled below, its own keywords bind all
      // of them, and its own `properties` and `required` are base fields
      // every variant carries (read without its variants).
      readComponentAllOfMember(fallbackName, subSchema, schemas, ledger, baseRequired, seen, false);
      baseConstraints = combineConstraints(baseConstraints, ownConstraints(subSchema));
      continue;
    }
    // Any other member, a union that is not an axis included: read as the
    // model reads it, its variants' properties as branch-only fallbacks.
    readComponentAllOfMember(fallbackName, subSchema, schemas, ledger, baseRequired, seen);
    baseConstraints = combineConstraints(baseConstraints, extractConstraints(subSchema));
  }
  // The component's own `required` naming an inherited property only, as
  // `readComponentAllOf` reads it for the dispatcher model.
  for (const r of schema.required ?? []) baseRequired.add(r);
  const baseProperties: Record<string, SchemaObject> = Object.fromEntries(
    [...ledger.values()].map((entry) => [entry.name, declaredComponentProperty(entry)]),
  );

  for (const variants of axisVariants.values()) {
    for (const variant of variants) {
      // Flatten any allOf wrapper on the variant (e.g. `ConnectApplication`'s
      // OAuth branch is `allOf: [{ properties: {…} }, { oneOf: [first-party
      // sub-variants] }]`). The flattened object has merged properties and
      // an inlined sub-variant `oneOf` so `extractInlineModelDeep` can pull
      // out a complete variant model.
      const flat = flattenVariantForExtraction(variant);
      if (!flat.properties || (flat.type !== undefined && flat.type !== 'object')) continue;

      // Merge base fields into the variant. Variant-specific properties win
      // on name collisions because the spec may pin a base field to a more
      // specific shape inside a variant. Built through a `Map`, so a property
      // named `__proto__` is set rather than taken for the prototype.
      const mergedProperties = new Map<string, SchemaObject>(Object.entries(baseProperties));
      for (const [k, v] of Object.entries(flat.properties)) {
        if (v) mergedProperties.set(k, v);
      }
      const mergedRequired = new Set<string>([...baseRequired, ...(flat.required ?? [])]);
      // The variant's own keywords (read through its allOf wrappers, like its
      // properties) conjoined with the base members'. They are already in the
      // 3.1 shape, so spreading them into the rebuilt schema lets
      // extractInlineModelDeep's constraintsEntry read them back unchanged.
      const merged: SchemaObject = {
        type: 'object',
        properties: Object.fromEntries(mergedProperties),
        required: [...mergedRequired],
        // The variant's own flag only: the union's wrapper deprecates the
        // dispatcher model, not the variants it dispatches to.
        ...deprecatedEntry(variant),
        ...combineConstraints(baseConstraints, extractConstraints(variant)),
        // The variant's own link rides along like its keywords, so the model
        // built from the rebuilt schema carries it.
        ...externalDocsEntry(variant.externalDocs),
      };

      const variantName = deriveDiscriminatedVariantName(variant, fallbackName);
      for (const model of extractInlineModelDeep(variantName, merged, schemas)) {
        if (seenNames.has(model.name)) continue;
        seenNames.add(model.name);
        models.push(model);
      }
    }
  }

  return models;
}

/**
 * Flatten a oneOf variant schema into a single object-shaped schema for
 * variant-model extraction. Recursively merges `allOf` members and folds
 * any nested `oneOf` into an inline-oneOf field group whose properties are
 * the union across sub-branches (required only when present in every
 * sub-branch). Returns the schema unchanged when no flattening is needed.
 */
function flattenVariantForExtraction(variant: SchemaObject): SchemaObject {
  if (!variant.allOf) return variant;

  // A `Map`, returned through `Object.fromEntries`, so a property named
  // `__proto__` is kept as an own entry.
  const mergedProperties = new Map<string, SchemaObject>();
  const mergedRequired = new Set<string>();
  const nestedOneOfs: SchemaObject[][] = [];

  const collect = (s: SchemaObject): void => {
    if (s.properties) {
      for (const [k, v] of Object.entries(s.properties)) {
        if (!mergedProperties.has(k) && v) mergedProperties.set(k, v);
      }
    }
    if (s.required) {
      for (const r of s.required) mergedRequired.add(r);
    }
    if (s.allOf) {
      for (const sub of s.allOf) collect(sub);
    }
    const nested = unionVariantsOf(s);
    if (nested) nestedOneOfs.push(nested);
  };
  collect(variant);

  // Fold each nested oneOf into the merged shape: any field appearing in any
  // sub-branch is included as optional (or required iff present-and-required
  // in every sub-branch). Conflicting literal types widen to their primitive
  // base. This handles the `is_first_party: true | false` widening on the
  // OAuth variant's first-party sub-oneOf.
  for (const branches of nestedOneOfs) {
    const flatBranches = branches.map(flattenVariantForExtraction);
    const branchKeys = new Set<string>();
    for (const b of flatBranches) {
      for (const k of Object.keys(b.properties ?? {})) branchKeys.add(k);
    }
    for (const key of branchKeys) {
      const schemas: SchemaObject[] = [];
      for (const b of flatBranches) {
        const s = b.properties?.[key];
        if (s) schemas.push(s);
      }
      const merged = mergeBranchPropertySchemas(schemas);
      if (!mergedProperties.has(key)) mergedProperties.set(key, merged);
      const inAllBranches = flatBranches.every((b) => b.properties !== undefined && Object.hasOwn(b.properties, key));
      const requiredInAll = inAllBranches && flatBranches.every((b) => (b.required ?? []).includes(key));
      if (requiredInAll) mergedRequired.add(key);
    }
  }

  return {
    type: 'object',
    properties: Object.fromEntries(mergedProperties),
    required: [...mergedRequired],
  };
}

/**
 * Merge same-named property schemas from across sub-variants. If every
 * occurrence is a boolean const, widen to plain boolean; if every occurrence
 * is a distinct string const, widen to plain string. Otherwise return the
 * first occurrence — emitters that build their own widened types (e.g. the
 * Node discriminated-models module) re-derive from the raw spec.
 */
function mergeBranchPropertySchemas(schemas: SchemaObject[]): SchemaObject {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0];

  const allBoolConst = schemas.every((s) => s.type === 'boolean' && typeof s.const === 'boolean');
  if (allBoolConst) {
    return { type: 'boolean', description: schemas[0].description };
  }
  const allStringConst = schemas.every((s) => s.type === 'string' && typeof s.const === 'string');
  if (allStringConst) {
    const values = schemas.map((s) => s.const as string);
    if (new Set(values).size === 1) return schemas[0];
    return { type: 'string', description: schemas[0].description };
  }
  return schemas[0];
}

function deriveDiscriminatedVariantName(schema: SchemaObject, fallbackName: string): string {
  // Walk through allOf wrappers so a variant of the form
  // `{ allOf: [{ properties: { type: const: 'oauth' } }, { oneOf: […] }] }`
  // still surfaces its discriminator const value for naming.
  const effective = getEffectiveProperties(schema);
  if (Object.keys(effective).length === 0) return fallbackName;

  const pickConst = (name: string): string | null => {
    const field = effective[name];
    if (!field) return null;
    if (typeof field.const === 'string') return field.const;
    if (field.enum && field.enum.length === 1 && typeof field.enum[0] === 'string') {
      return field.enum[0];
    }
    return null;
  };

  let constValue: string | null = null;
  for (const preferred of ['event', 'type', 'object']) {
    constValue = pickConst(preferred);
    if (constValue) break;
  }
  if (constValue === null) {
    for (const name of Object.keys(effective)) {
      constValue = pickConst(name);
      if (constValue) break;
    }
  }
  if (constValue === null) return fallbackName;

  const pascal = toPascalCase(constValue);
  if (!pascal) return fallbackName;

  // A single-word const like `oauth` or `m2m` is too generic to stand alone
  // as a top-level model name — it would collide with unrelated schemas. Pair
  // it with the parent name so the variant resolves to e.g. `ConnectApplicationOAuth`
  // / `ConnectApplicationM2M`. Multi-word consts like `action.authentication.denied`
  // are already specific enough on their own, matching the established
  // EventSchema variant naming.
  const wordCount = splitWords(constValue).length;
  if (wordCount >= 2) return pascal;
  if (pascal === fallbackName) return pascal;
  if (fallbackName.startsWith(pascal)) return fallbackName;
  if (pascal.endsWith(fallbackName)) return pascal;
  return `${fallbackName}${pascal}`;
}

/**
 * The model for a discriminated variant's rebuilt object schema, and every
 * inline model its fields reference: the variant's own model
 * (`buildInlineModel`, its properties typed under `name`) followed by
 * whatever its properties mint, extracted by the field extractor
 * (`extractInlineModelsFromProperties`) under `name` as parent — so a
 * nested object, typed or not, nullable or not; array items and map values
 * of any shape (an inline object, an `allOf` merge, a union); every
 * `oneOf`/`anyOf` variant and its members; an `allOf` field read as
 * `readInlineAllOf` reads it; an inline enum — is materialized under exactly
 * the name `buildFieldFromSchema` typed it with, since the extractor and the
 * type builder name by the same rules. A variant's fields are built here
 * the one way every inline object's are, so typing and extraction cannot
 * disagree for any shape under a discriminated variant.
 */
function extractInlineModelDeep(name: string, schema: SchemaObject, schemas?: Record<string, SchemaObject>): Model[] {
  const nestedModels: Model[] = [];
  extractInlineModelsFromProperties(schema, nestedModels, name, schemas);
  return [buildInlineModel(name, schema, schemas), ...nestedModels];
}

/**
 * `elementContextName` for an optional context: with no field name there is
 * nothing to decide, and the items / values keep an undefined context.
 */
function elementContext(
  contextName: string | undefined,
  kind: 'item' | 'value',
  siblingProperties: ReadonlyMap<string, SchemaObject> | undefined,
  parentModelName: string | undefined,
  elementSchema: SchemaObject,
): string | undefined {
  return contextName === undefined
    ? undefined
    : elementContextName(contextName, kind, siblingProperties, parentModelName, elementSchema);
}

/**
 * Every `ModelRef` built from a `$ref` — an explicit reference to a component
 * schema, as opposed to one minted for an inline object. The two kinds carry
 * the same `{ kind: 'model', name }` shape, so the identity is kept here: a
 * pass that renames an inline model repoints the references minted for it and
 * must leave an explicit reference to a same-named component as written
 * (`isComponentModelRef`). The set is keyed by object identity and every
 * pass between building and emitting mutates refs in place, so it holds.
 */
const componentModelRefs = new WeakSet<ModelRef>();

/** Whether `ref` was built from a `$ref` to a component schema rather than minted for an inline object. */
export function isComponentModelRef(ref: ModelRef): boolean {
  return componentModelRefs.has(ref);
}

/** Record `ref` as built from a `$ref` to a component: for a copy of a marked reference (`cloneTypeRef`), which a structural clone would leave unmarked. */
export function markComponentModelRef(ref: ModelRef): void {
  componentModelRefs.add(ref);
}

export function schemaToTypeRef(
  schema: SchemaObject,
  contextName?: string,
  parentModelName?: string,
  siblingProperties?: ReadonlyMap<string, SchemaObject>,
  // The inline names an enclosing field's siblings mint, handed down to the
  // field's array items and map values so a union among them steps around a
  // sibling's model like a union at field level (`reservedNamesFor`).
  reservedNames?: ReadonlySet<string>,
): TypeRef {
  // Handle $ref → ModelRef or EnumRef.
  // A `$ref` to a top-level component schema needs to preserve whether the
  // target is a model or an enum, because emitters route imports differently
  // for the two kinds (e.g. com.example.models.X vs com.example.types.X). The
  // set of enum names is precomputed by extractSchemas() in a first pass so
  // it's available even when called recursively for nested $refs.
  if (schema.$ref) {
    const segments = schema.$ref.split('/');
    const rawName = segments[segments.length - 1];
    // An array component is no model: the reference is the array it
    // declares, its items typed under the component's name exactly as the
    // component pass materializes them (`arrayComponentTypeRef`). Looked up
    // by the key the `$ref` names, before any name-based test: `Notes` is
    // the array whatever another key resolving to `Note` is.
    const arrayAlias = arrayComponentTypeRef(rawName);
    if (arrayAlias) return arrayAlias;
    const resolved = resolveSchemaName(rawName);
    if (activeEnumSchemaNames.has(resolved)) {
      const enumRef: TypeRef = { kind: 'enum', name: resolved };
      // Carry the component's own nullability through the reference so
      // `field: { $ref: NullableEnum }` has the same shape as the inline
      // `oneOf: [{ $ref }, { type: 'null' }]` form.
      return activeNullableEnumSchemaNames.has(resolved) ? { kind: 'nullable', inner: enumRef } : enumRef;
    }
    // Likewise a named union with a `null` variant: the variant is not a
    // member of the model, so the reference carries the nullability. The
    // model reference itself is recorded as a component's (`componentModelRefs`)
    // whether or not it is wrapped.
    const modelRef: ModelRef = { kind: 'model', name: resolved };
    componentModelRefs.add(modelRef);
    return activeNullableUnionSchemaNames.has(resolved) ? { kind: 'nullable', inner: modelRef } : modelRef;
  }

  // Handle OAS 3.1 nullable type arrays: type: [string, null]
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((t: string) => t !== 'null');
    // type: ['null'] — only null, no real type
    if (nonNullTypes.length === 0) {
      return { kind: 'nullable', inner: { kind: 'primitive', type: 'unknown' } };
    }
    // Keep `parentModelName` through the unwrap so an inline object, map
    // value, or enum under a nullable field is qualified exactly like its
    // non-nullable twin — the inline-model extractor names it that way.
    if (schema.type.includes('null') && nonNullTypes.length === 1) {
      return asNullable(
        schemaToTypeRef(
          { ...schema, type: nonNullTypes[0], nullable: false },
          contextName,
          parentModelName,
          siblingProperties,
          reservedNames,
        ),
      );
    }
    // Multiple non-null types → union
    if (nonNullTypes.length > 1) {
      const variants = nonNullTypes.map((t: string) =>
        schemaToTypeRef({ ...schema, type: t }, contextName, parentModelName, siblingProperties, reservedNames),
      );
      const ref: TypeRef = { kind: 'union', variants };
      if (schema.type.includes('null')) {
        return { kind: 'nullable', inner: ref };
      }
      return ref;
    }
  }

  // Handle OAS 3.0 nullable flag
  if (schema.nullable && schema.type) {
    return asNullable(
      schemaToTypeRef({ ...schema, nullable: false }, contextName, parentModelName, siblingProperties, reservedNames),
    );
  }

  // From here on the nullable wrappers are gone. `properties` written beside
  // a typing `allOf`/`oneOf`/`anyOf` are folded into it (the extractors
  // dispatch on the same fold, through `unwrapNullableSchema`), the variants
  // that cannot take them reported, and then one classification decides
  // which keyword types the schema — the same one the inline-model
  // extractors dispatch on, so the models they build are the ones referenced.
  // A schema no branch below types is `unknown` — decided by
  // `typesAsUnknown`, the one answer a reader that must know before typing
  // asks (`bodyIsTyped`, for the primary response) — with a warning for a
  // shape the parser does not read; an empty `{}` describes nothing on
  // purpose and is not reported.
  if (typesAsUnknown(schema)) {
    if (contextName && !describesNothing(schema)) {
      console.warn(`[oagen] Warning: Unknown schema shape treated as unknown (context: ${contextName})`);
    }
    return { kind: 'primitive', type: 'unknown' };
  }

  warnOnUncarriedProperties(schema, contextName, parentModelName);
  schema = foldSiblingProperties(schema);
  const inlineKind = classifyInlineSchema(schema);

  // Handle allOf, read the one way every site reads it (`readInlineAllOf`):
  // a merged model — a `$ref` member augmented by an inline object member,
  // or inline members one of which declares properties, a `oneOf`/`anyOf`
  // member's inline object variants included — which `materializeMergedAllOf`
  // builds under this very name; a lone member unwrapped; or a plain
  // reference to the first `$ref` member.
  if (inlineKind === 'allOf' && schema.allOf) {
    const reading = readInlineAllOf(schema.allOf, schema);
    if (reading === 'merged') {
      const baseName = toPascalCase(contextName ?? 'UnknownModel');
      return { kind: 'model', name: qualifyInlineModelName(baseName, parentModelName) };
    }
    if (reading === 'reference') {
      const refItem = schema.allOf.find((s: SchemaObject) => s.$ref);
      // `'reference'` is only read with a `$ref` member among the members an
      // `allOfTypesSchema` admits, so one is found here.
      if (refItem) return schemaToTypeRef(refItem, contextName, parentModelName);
    } else {
      // A single member, unwrapped. The wrapper is the schema the document
      // wrote, so its documentation rides onto the member — an inline enum
      // lifted from it carries the wrapper's `description` and link
      // (`withWrapperDocs`), and a model built from it the wrapper's link
      // (`unwrappedAllOfMember`).
      return schemaToTypeRef(
        withWrapperDocs(schema.allOf[0], schema),
        contextName,
        parentModelName,
        siblingProperties,
        reservedNames,
      );
    }
    // Unreachable: `allOfTypesSchema` admits only the three readings above.
    // An `allOf` of bare limits is classified from the schema's own keywords.
  }

  // Handle oneOf / anyOf → Union or Nullable
  // Valid OAS 3.1: properties can have { oneOf: [{ type: object }, { type: 'null' }] }
  // without a wrapping `type` field.
  if (inlineKind === 'union') {
    const compositionKind: 'oneOf' | 'anyOf' = schema.oneOf ? 'oneOf' : 'anyOf';
    const rawVariants: SchemaObject[] = schema.oneOf ?? schema.anyOf ?? [];

    // Check for nullable pattern: oneOf: [realType, { type: 'null' }]
    const nullVariant = rawVariants.find(isNullVariantSchema);
    const nonNullVariants = rawVariants.filter((v) => v !== nullVariant);

    // Collapse an oneOf/anyOf whose non-null variants are all string-const
    // schemas into a single enum. This turns patterns like
    //   provider: { oneOf: [{ const: "AppleOAuth" }, { const: "GitHubOAuth" }, ...] }
    // into a proper enum type with one member per variant instead of a
    // structurally-opaque union of literal refs. Each member keeps its
    // variant's `description` and `deprecated` (`constUnionEnumMembers`), the
    // way the same `oneOf` under `components.schemas` does (`extractEnum`).
    // An `enum:` list beside the union restricts the members and `null`
    // alike, through the two helpers the component path reads
    // (`constUnionEnumMembers`, `enumListAdmitsNull`), whatever it leaves:
    // one member is an enum of that member, none an enum with no members —
    // the component's answers — never the union of every const the list
    // forbade, nor the nullable literal the single-variant unwrap below would
    // make of `oneOf: [a, null]` when the list forbids `null`; so this is
    // decided first. Without a list, a union of fewer than two consts keeps
    // the shape the branches below give it (a lone const beside
    // `type: 'null'` is a nullable literal).
    // Whether this union is such an enum is the one decision the predictor
    // that reserves enum names before typing reads too (`inlineEnumSpelling`).
    const constUnion = inlineEnumSpelling(schema);
    if (constUnion?.spelling === 'const-union') {
      const enumRef = buildSyntheticEnumRef(
        constUnion.members,
        contextName,
        parentModelName,
        schema.externalDocs,
        schema.description,
      );
      // An `enum:` list beside the union that leaves `null` out forbids it,
      // whatever the `type: 'null'` variant says (`enumListAdmitsNull`).
      return nullVariant && enumListAdmitsNull(schema) ? { kind: 'nullable', inner: enumRef } : enumRef;
    }

    if (nullVariant && nonNullVariants.length === 1) {
      // Nullable single type — unwrap as nullable. `asNullable` keeps a
      // `$ref` to an already-nullable enum component from double-wrapping.
      // The wrapper's `description` and link ride onto the branch
      // (`withWrapperDocs`), so an inline enum under a nullable wrapper lifts
      // with the wrapper's text and link; the model the extractor builds from
      // the same branch takes the wrapper's link (`unwrapNullableField`).
      return asNullable(
        schemaToTypeRef(
          withWrapperDocs(nonNullVariants[0], schema),
          contextName,
          parentModelName,
          siblingProperties,
          reservedNames,
        ),
      );
    }

    // The inline object variants' model names, decided once for this TypeRef
    // and every extractor (`nameInlineVariants`): variant 0's bare qualified
    // field name, a const prefix, a title, a distinguishing property or a
    // counter — or, for a `oneOf` whose every variant is titled and pins a
    // const (3. below), the title itself — never a name a sibling property
    // mints. Computed first because the derived discriminator mappings below
    // are read from it, so a mapping can only point at a model that exists.
    const inlineVariantNames = nameInlineObjectVariants(
      schema,
      contextName,
      parentModelName,
      siblingProperties,
      reservedNames,
    );

    // Resolve the discriminator. Four sources, in order:
    //   1. Explicit `discriminator:` with explicit `mapping:` — trust the spec.
    //   2. Explicit `discriminator:` with no `mapping:` — pair each variant's
    //      const value on the property with its inline model name
    //      (`deriveInlineVariantMapping`). This covers `ApiKey.owner`-shaped
    //      schemas where the spec uses `discriminator: { propertyName: type }`
    //      but lists inline anonymous `oneOf` variants instead of `$ref` links.
    //   3. No explicit discriminator, but every variant carries a `$ref` or a
    //      `title` and pins the same const property
    //      (`titleMappedDiscriminatorProperty`): the mapping names a `$ref`
    //      variant by its component and an inline variant by the name
    //      `nameInlineVariants` gave it — its title (`Circle`, `Square`)
    //      unless that is taken — so the extracted model and the mapping agree.
    //   4. Otherwise, when every inline variant pins the same const property
    //      with distinct values (`deriveConstNamingDiscriminator`), the same
    //      value → inline model name pairing as 2. This covers
    //      `ApiKeyCreatedData.owner`-shaped schemas (oneOf with inline
    //      const-discriminating variants but no `discriminator:` keyword).
    let resolvedDiscriminator: { property: string; mapping: Record<string, string> } | undefined;
    if (schema.discriminator) {
      const property = schema.discriminator.propertyName;
      const explicitMapping = schema.discriminator.mapping ?? {};
      let mapping: Record<string, string> = Object.fromEntries(
        Object.entries(explicitMapping).map(([k, v]) => [k, v.replace(/^#\/components\/schemas\//, '')]),
      );
      if (Object.keys(mapping).length === 0) {
        const inlineMapping = deriveInlineVariantMapping(nonNullVariants, property, contextName, inlineVariantNames);
        if (inlineMapping) mapping = inlineMapping;
      }
      resolvedDiscriminator = { property, mapping };
    } else if (compositionKind === 'oneOf') {
      const titleProperty = titleMappedDiscriminatorProperty(nonNullVariants);
      if (titleProperty) {
        const mapping: Record<string, string> = {};
        for (const v of nonNullVariants) {
          const value = getConstPropertyValue(v, titleProperty);
          const mappedName = inlineVariantNames.get(v) ?? resolveVariantModelName(v);
          if (value !== null && mappedName !== null) mapping[value] = mappedName;
        }
        resolvedDiscriminator = { property: titleProperty, mapping };
      } else {
        const namingDisc = deriveConstNamingDiscriminator(nonNullVariants);
        if (namingDisc) {
          const inlineMapping = deriveInlineVariantMapping(
            nonNullVariants,
            namingDisc.property,
            contextName,
            inlineVariantNames,
          );
          if (inlineMapping) {
            resolvedDiscriminator = { property: namingDisc.property, mapping: inlineMapping };
          }
        }
      }
    }

    // Build variants. An inline object variant is referenced by the name its
    // extracted model carries (`inlineVariantNames`); a discriminator mapping
    // entry substitutes for it only when the spec's own `mapping:` (1.) names
    // the variant, since the derived mappings (2.–4.) are read from the same
    // names. Falling back to `schemaToTypeRef` instead would hand every
    // inline variant the same parent-derived name (e.g. `ApiKeyOwner`),
    // collapsing the union onto one repeated model ref while the extractor
    // emits `ApiKeyOwner`, `UserApiKeyOwner`, ... for them.
    // The named ref replaces only the `object` member of what `schemaToTypeRef`
    // would build for the variant: a nullable variant (`['object', 'null']`,
    // OAS 3.0 `nullable: true`) keeps its wrapper, and a multi-type variant
    // (`['object', 'string']`) keeps its other alternatives in a union — see
    // `inlineVariantTypeRef`. The extractor emits the model under the same
    // name in every case, and a multi-type variant's other members are named
    // from that model, not from the mapping, so their items resolve.
    const variants: TypeRef[] = [];
    // Every other variant that mints a name — an array or map, a nested
    // union, a nullable wrapper around an object, an `allOf`, an inline enum
    // — is typed under the context `nonObjectVariantContexts` gives it, so
    // the models and enums it mints never share a name with an object
    // variant of the same union, which keeps the field's own name, nor with
    // another such variant's. The extractors re-enter with the same contexts.
    const variantContexts = nonObjectVariantContexts(
      contextName,
      rawVariants,
      siblingProperties,
      parentModelName,
      inlineVariantNames,
      reservedNames,
    );
    for (const v of rawVariants) {
      if (v === nullVariant) continue;
      const inlineName = inlineVariantNames.get(v);
      if (inlineName) {
        const mappedName = resolvedDiscriminator ? mapVariantToDiscriminatorEntry(v, resolvedDiscriminator) : null;
        variants.push(inlineVariantTypeRef(v, inlineName, mappedName ?? inlineName));
      } else {
        const entry = variantContexts.get(v);
        variants.push(
          entry
            ? schemaToTypeRef(v, entry.context, parentModelName, undefined, entry.reserved)
            : schemaToTypeRef(v, contextName, parentModelName),
        );
      }
    }
    const hasNull = !!nullVariant;

    const union: TypeRef = {
      kind: 'union',
      variants,
      compositionKind,
      ...(resolvedDiscriminator ? { discriminator: resolvedDiscriminator } : {}),
    };
    return hasNull ? { kind: 'nullable', inner: union } : union;
  }

  // Handle const → LiteralType (supports string, number, boolean)
  if (inlineKind === 'const') {
    if (typeof schema.const === 'string' || typeof schema.const === 'number' || typeof schema.const === 'boolean') {
      return { kind: 'literal', value: schema.const };
    }
    // null const → nullable unknown
    if (schema.const === null) {
      return { kind: 'nullable', inner: { kind: 'primitive', type: 'unknown' } };
    }
    // const of object/array → map or array with unknown values
    if (typeof schema.const === 'object') {
      if (Array.isArray(schema.const)) {
        return { kind: 'array', items: { kind: 'primitive', type: 'unknown' } };
      }
      return { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } };
    }
  }
  // A `null` member of an inline `enum:` marks nullability, not a value.
  // Strip it before deciding literal-vs-enum, and wrap the result so a
  // bare `type: 'string', enum: ['a', null]` is nullable even without a
  // `type: [..., 'null']` array (the array branch above already wrapped
  // us when present; `asNullable` keeps that from doubling up).
  const enumValues = nonNullEnumValues(schema.enum);
  const enumAdmitsNull = schema.enum !== undefined && enumValues.length !== schema.enum.length;
  if (inlineKind === 'enum' && enumValues.length === 1) {
    const v = enumValues[0];
    const literal: TypeRef = { kind: 'literal', value: typeof v === 'number' ? v : String(v) };
    return enumAdmitsNull ? asNullable(literal) : literal;
  }

  // Handle enum — the `enum-list` spelling of the one decision the predictor
  // that reserves enum names before typing reads too (`inlineEnumSpelling`);
  // the single-member list was returned as a literal above.
  if (inlineEnumSpelling(schema)?.spelling === 'enum-list') {
    // Named by the one rule every inline enum follows (`inlineEnumName`):
    // qualified by the parent with its list-item markers stripped, no
    // redundant prefix, the project's `schemaNameTransform` applied. The
    // schema's `description` and link and each value's `x-enum-descriptions`
    // / `x-enumDescriptions` entry are recorded against the ref so the lifted
    // `Enum` carries them (`collectInlineEnumFromRef`); the nullable unwraps
    // above spread the schema, so a wrapped enum's text and link reach here
    // too.
    const enumRef = inlineEnumRef(
      inlineEnumName(contextName, parentModelName),
      enumListMembers(schema) ?? [],
      schema.externalDocs,
      schema.description,
    );
    return enumAdmitsNull ? asNullable(enumRef) : enumRef;
  }

  // Handle array — pass parentModelName through to qualify inline items. The
  // items' context is the field itself, or `<field>_item` when a sibling
  // property would take the singular name (`elementContextName`), so an
  // inline object item is `<Parent><Field>` or `<Parent><Field>Item`. The
  // items get no sibling set of their own (they are not a property), but a
  // union among them must still step around the models the field's siblings
  // mint, so that set is handed down (`reservedNamesFor`), exactly as the
  // extractor passes it into its items re-entry.
  if (inlineKind === 'array' && schema.items) {
    return {
      kind: 'array',
      items: schemaToTypeRef(
        schema.items,
        elementContext(contextName, 'item', siblingProperties, parentModelName, schema.items),
        parentModelName,
        undefined,
        reservedNamesFor(contextName, siblingProperties, parentModelName, reservedNames),
      ),
    };
  }

  // Handle object → ModelRef (if it has properties, it's a named model reference,
  // with `type: 'object'`, no `type`, or a type list naming `object`).
  // When additionalProperties is also present, we still return a ModelRef so the
  // named properties are preserved. The extractModel path will pick up the extra
  // properties as a catch-all map field named `additionalProperties`.
  if (inlineKind === 'object') {
    const baseName = toPascalCase(contextName ?? 'UnknownModel');
    return {
      kind: 'model',
      name: qualifyInlineModelName(baseName, parentModelName),
    };
  }

  // Handle freeform object with additionalProperties or patternProperties → Map<string, T>
  // The value schema is typed with the field's own `contextName` and
  // `parentModelName`, exactly like array items, so an inline object value is
  // referenced as `${Parent}${SingularField}` (`layers` on
  // `CreateDrawingRequest` → `CreateDrawingRequestLayer`) and the inline-model
  // extractor (`extractInlineModelsFromProperties`) emits a model of that name.
  // When a sibling property would take that singular name the values use
  // `<field>_value` instead (`<Parent><Field>Value`, see `elementContextName`).
  if (inlineKind === 'map') {
    // `mapValueSchema` picks the value schema in this branch's precedence: a
    // non-empty `additionalProperties` object, else the first
    // `patternProperties` entry; `additionalProperties: {}` or `true` means
    // "any value" and stays unknown.
    let valueType: TypeRef = { kind: 'primitive', type: 'unknown' };
    const valueSchema = mapValueSchema(schema);
    if (valueSchema) {
      const valueContext = elementContext(contextName, 'value', siblingProperties, parentModelName, valueSchema);
      // Like array items: the field's sibling reservations reach the values.
      valueType = schemaToTypeRef(
        valueSchema,
        valueContext,
        parentModelName,
        undefined,
        reservedNamesFor(contextName, siblingProperties, parentModelName, reservedNames),
      );
    }
    return {
      kind: 'map',
      valueType,
    };
  }

  // Handle primitives
  const typeStr = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (typeStr && PRIMITIVE_TYPES[typeStr]) {
    return {
      kind: 'primitive',
      type: PRIMITIVE_TYPES[typeStr],
      ...(schema.format ? { format: schema.format } : {}),
    };
  }

  // Unreachable: every shape no branch above types was answered at the top
  // (`typesAsUnknown` holds exactly for those).
  return { kind: 'primitive', type: 'unknown' };
}

/** The `type` keywords `schemaToTypeRef` reads as a primitive, and the primitive each becomes. */
const PRIMITIVE_TYPES: Record<string, 'string' | 'integer' | 'number' | 'boolean'> = {
  string: 'string',
  integer: 'integer',
  number: 'number',
  boolean: 'boolean',
};

/** An empty schema — `{}`, or one with annotations only: none of the keywords that type a schema. */
function describesNothing(schema: SchemaObject): boolean {
  return (
    !schema.type &&
    !schema.$ref &&
    !schema.oneOf &&
    !schema.anyOf &&
    !schema.allOf &&
    !schema.enum &&
    !schema.properties &&
    !schema.items
  );
}

/**
 * Whether `schemaToTypeRef` types `schema` as the bare `unknown` primitive,
 * decided without typing it — the one answer, which `schemaToTypeRef`
 * itself returns on, so a reader that must know before a body is typed
 * (`bodyIsTyped`, choosing the primary response) never disagrees with the
 * type it then gets. It holds for a schema no branch of `schemaToTypeRef`
 * types: no `$ref`; no type list except one naming a single type without
 * `null` (an empty list is `nullable<unknown>`, `null` beside one type is
 * nullable, several types are a union); no `nullable: true` beside a
 * `type`; then, once sibling properties are folded into a typing
 * composition (`foldSiblingProperties`), a classification of `other`
 * (`classifyInlineSchema`: no composition, union, `const`, `enum`, array,
 * object or map) with no primitive `type` — `{}`, `{ nullable: true }`, a
 * `type` no rule knows, `type: 'array'` without `items`, a bare
 * `additionalProperties` without `type: 'object'` — or a lone `allOf`
 * member read as the schema itself (`readInlineAllOf`: `'unwrapped'`)
 * that is such a schema. Warns about nothing.
 */
export function typesAsUnknown(schema: SchemaObject): boolean {
  if (schema.$ref) return false;
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((t: string) => t !== 'null');
    if (nonNullTypes.length !== 1 || schema.type.includes('null')) return false;
  }
  if (schema.nullable && schema.type) return false;
  const folded = foldSiblingProperties(schema);
  const kind = classifyInlineSchema(folded);
  if (kind === 'allOf' && folded.allOf) {
    return readInlineAllOf(folded.allOf, folded) === 'unwrapped' && typesAsUnknown(folded.allOf[0]);
  }
  if (kind !== 'other') return false;
  const typeStr = Array.isArray(folded.type) ? folded.type[0] : folded.type;
  return !(typeStr && PRIMITIVE_TYPES[typeStr]);
}

import {
  buildInlineModel,
  collectProperties,
  declareProperty,
  declaresInlineProperties,
  elementContextName,
  extractInlineModelsFromProperties,
  extractInlineModelsFromSchemas,
  firstFreeElementContext,
  isContestedTitle,
  mapValueSchema,
  markContestedTitles,
  readInlineAllOf,
  unwrappedAllOfMember,
  type MintedInlineName,
  mintedInlineNameEntries,
  mintedInlineNames,
  modelFingerprint,
  type PropertyDeclarations,
  qualifyInlineModelName,
  recordLiftedFieldModel,
  reservedInlineNames,
  resetInheritedModelRefs,
  schemaShapeKey,
} from './inline-models.js';

export { qualifyInlineModelName, extractInlineModelsFromSchemas } from './inline-models.js';
