import type { Constraints, EnumRef, Extensions, ExternalDocs, Model, ModelRef, Field, TypeRef } from '../ir/types.js';
import { collectModelRefs, collectModelTypeRefs, renameTypeRefModels, walkTypeRef } from '../ir/types.js';
import { toPascalCase, stripListItemMarkers, singularize } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import {
  buildFieldFromSchema,
  classifyInlineSchema,
  componentPropertyLedger,
  declaredComponentProperty,
  nonObjectVariantContexts,
  constraintsEntry,
  deprecatedEntry,
  extractConstraints,
  isComponentModelRef,
  markComponentModelRef,
  isInlineObjectSchema,
  isNullSchema,
  nullableUnionBranch,
  unwrapNullableField,
  unwrapNullableSchema,
  withWrapperDeprecation,
  nameInlineVariantEntries,
  nameInlineVariants,
  resolveSchemaName,
  titleMappedVariantNames,
  variantMemberSchemas,
  foldSiblingProperties,
  foldedVariantOrigin,
} from './schemas.js';
import { externalDocsEntry, readExternalDocs, withWrapperExternalDocs } from './external-docs.js';
import {
  SCHEMA_CONSUMED_EXTENSIONS,
  extensionsOf,
  schemaExtensionsEntry,
  withWrapperExtensions,
} from './extensions.js';
import { copyInlineEnumMeta, shapeWithEnumFlags } from './enum-members.js';
import { readDiscriminator } from './union-shape.js';

/**
 * Qualify an inline model name with the parent schema name.
 * If `parentName` is provided and the field name doesn't already start with
 * the parent, the result is `${parentName}${PascalField}` with the trailing
 * word singularized (e.g., Connection + Domains → ConnectionDomain).
 */
export function qualifyInlineModelName(baseName: string, parentName?: string): string {
  if (!parentName) return baseName;
  // Strip ListItem/ByExternalId markers from parent name so inline model names
  // are clean, for response models as much as component ones.
  // e.g., ConnectionListItem + Domains → Connection + Domain = ConnectionDomain
  const cleanParent = stripListItemMarkers(parentName);
  if (baseName.startsWith(cleanParent)) return baseName;
  // Singularize the trailing PascalCase word of the combined name.
  // Split baseName into leading words + trailing word, singularize trailing.
  const trailingMatch = baseName.match(/^(.*?)([A-Z][a-z]*)$/);
  if (trailingMatch) {
    const [, prefix, trailingWord] = trailingMatch;
    const singular = singularize(trailingWord);
    return `${cleanParent}${prefix}${singular}`;
  }
  return `${cleanParent}${baseName}`;
}

/**
 * The inline model or enum names `schemaToTypeRef` would mint for `schema`
 * typed under `contextName` with `parentModelName`; empty when it mints none
 * (a `$ref`, a primitive, an array or map of those). Mirrors the naming
 * branches of `schemaToTypeRef`: an inline object in any form it recognises
 * (`properties`, an `allOf` with object members) takes
 * `qualifyInlineModelName`; a `oneOf`/`anyOf` mints one model per inline
 * object variant, named exactly as the union references them
 * (`nameInlineVariants`: `DrawingLayer`, `DrawingLayerWithOpacity`, or
 * `CircleDrawingLayer` when every variant is titled); an inline enum, or a
 * `oneOf` of string consts that collapses into one, takes the parent-prefixed
 * enum name, which is never singularized; an array or map claims whatever its
 * items or values would.
 */
export function mintedInlineNames(
  contextName: string,
  schema: SchemaObject,
  parentModelName: string | undefined,
): string[] {
  return mintedInlineNameEntries(contextName, schema, parentModelName).map((entry) => entry.name);
}

/**
 * An inline name a schema mints, and whether it is context-free: a
 * title-mapped variant's title (`nameInlineVariantEntries`) is the same
 * whatever field, array or map the union sits under, where every other
 * inline name embeds the context it is typed under.
 */
export interface MintedInlineName {
  name: string;
  contextFree: boolean;
  /** The variant schema a union variant's name was minted for; `reservedInlineNames` compares shapes through it. */
  schema?: SchemaObject;
}

/**
 * `mintedInlineNames`, also telling for each name whether it is context-free.
 * `reserved` are the names the schema's unions must step around
 * (`nameInlineVariantEntries`), as `schemaToTypeRef` receives them for the
 * same schema (`reservedNames`); the sibling-reservation readers leave it
 * unset and read the names in isolation, while `nonObjectVariantContexts`
 * passes a variant's own set so the names it records are the ones taken.
 */
export function mintedInlineNameEntries(
  contextName: string,
  schema: SchemaObject,
  parentModelName: string | undefined,
  reserved?: ReadonlySet<string>,
): MintedInlineName[] {
  const s = unwrapNullableSchema(schema);
  // Dispatch on the one classification `schemaToTypeRef` uses, so the names
  // predicted here are the names it mints.
  const kind = classifyInlineSchema(s);
  if (kind === 'ref') return [];
  const base = toPascalCase(contextName);
  const modelName = (): MintedInlineName[] => [
    { name: qualifyInlineModelName(base, parentModelName), contextFree: false },
  ];
  const enumName = (): MintedInlineName[] => {
    const cleanParent = parentModelName ? stripListItemMarkers(parentModelName) : undefined;
    return [
      { name: cleanParent && !base.startsWith(cleanParent) ? `${cleanParent}${base}` : base, contextFree: false },
    ];
  };
  if (kind === 'allOf' && s.allOf) {
    // The one reading `schemaToTypeRef` makes of an `allOf` (`readInlineAllOf`).
    const reading = readInlineAllOf(s.allOf, s);
    if (reading === 'unwrapped') return mintedInlineNameEntries(contextName, s.allOf[0]!, parentModelName, reserved);
    return reading === 'merged' ? modelName() : [];
  }
  const variants = kind === 'union' ? (s.oneOf ?? s.anyOf) : undefined;
  if (variants) {
    const nonNull = variants.filter((v) => !isNullSchema(v));
    if (nonNull.length >= 2 && nonNull.every((v) => typeof v.const === 'string')) return enumName();
    const variantEntries = nameInlineVariantEntries(s, modelName()[0]!.name, reserved);
    // Every other variant mints under the context `nonObjectVariantContexts`
    // gives it (read here without siblings but with the object variants'
    // names): `<context>_item` / `<context>_value` for an array or map, the
    // context itself or `<context>_variant_<n>` for a nested union, a nullable
    // object, an `allOf` or an inline enum — stepping around the names the
    // entry reserves — so a sibling that would take one of those names steps
    // around it.
    const objectVariantNames = new Map([...variantEntries].map(([variant, entry]) => [variant, entry.name]));
    const others = [
      ...nonObjectVariantContexts(contextName, nonNull, undefined, parentModelName, objectVariantNames, reserved),
    ].flatMap(([variant, entry]) =>
      mintedInlineNameEntries(entry.context, unwrapNullableSchema(variant), parentModelName, entry.reserved),
    );
    return [...[...variantEntries].map(([variant, entry]) => ({ ...entry, schema: variant })), ...others];
  }
  if (kind === 'const') return [];
  if (kind === 'enum') return (s.enum ?? []).filter((v) => v !== null).length >= 2 ? enumName() : [];
  if (kind === 'array' && s.items) return mintedInlineNameEntries(contextName, s.items, parentModelName, reserved);
  if (kind === 'object') return modelName();
  if (kind === 'map') {
    const value = mapValueSchema(s);
    return value ? mintedInlineNameEntries(contextName, value, parentModelName, reserved) : [];
  }
  return [];
}

/**
 * The inline names the other properties of an object mint
 * (`mintedInlineNameEntries`) which a `oneOf`/`anyOf` under `fieldName` must
 * not give one of its variants (`nameInlineVariants`): beside a
 * `shape_with_side` object, the `{ side }` variant of `shape` cannot become
 * `DrawingShapeWithSide`. Every context-dependent sibling name is reserved.
 * A context-free name — a title-mapped variant's title — names one shape
 * wherever it appears, so it is shared, not reserved, when this field gives
 * the same title a variant of the identical shape (`schemaShapeKey`:
 * documentation keywords ignored, property names verbatim — the rule array
 * items already use to share a singular sibling's model); a sibling giving
 * the same title a different shape, or one this field does not use, reserves
 * it, so this union's variant falls back to its context-qualified name. Each
 * sibling's names are read in isolation, without the reservations that
 * sibling would itself apply, so the set depends on sibling names and content
 * only, two unions beside each other cannot chase each other's names, and
 * the shape test is symmetric: when `Circle` means `{ radius }` on one side
 * and `{ diameter }` on the other, both fall back (`CircleDrawingShape`,
 * `CircleDrawingMarker`) and neither keeps the bare `Circle`. Empty without a
 * sibling set, as for a request body or response that is itself a union.
 *
 * Siblings are the one case decided here. A title two unions at different
 * depths of one root give different shapes — `shape` and `marker.shape` —
 * is decided before any union is named (`markContestedTitles`): such a
 * variant never keeps its title, so by the time its union is named the
 * title is not among the context-free names on either side.
 */
export function reservedInlineNames(
  fieldName: string,
  siblings: ReadonlyMap<string, SchemaObject> | undefined,
  parentModelName: string | undefined,
): ReadonlySet<string> {
  const reserved = new Set<string>();
  if (!siblings) return reserved;

  // The shape this field gives each title it would keep, in isolation.
  const ownShapes = new Map<string, string[]>();
  const fieldSchema = siblings.get(fieldName);
  if (fieldSchema) {
    for (const own of mintedInlineNameEntries(fieldName, fieldSchema, parentModelName)) {
      if (!own.contextFree || !own.schema) continue;
      ownShapes.set(own.name, [...(ownShapes.get(own.name) ?? []), schemaShapeKey(own.schema)]);
    }
  }

  for (const [siblingName, siblingSchema] of siblings) {
    if (siblingName === fieldName) continue;
    for (const minted of mintedInlineNameEntries(siblingName, siblingSchema, parentModelName)) {
      if (!minted.contextFree) {
        reserved.add(minted.name);
        continue;
      }
      const shapes = ownShapes.get(minted.name);
      const siblingShape = minted.schema ? schemaShapeKey(minted.schema) : undefined;
      const identical = shapes !== undefined && siblingShape !== undefined && shapes.every((s) => s === siblingShape);
      if (!identical) reserved.add(minted.name);
    }
  }
  return reserved;
}

/**
 * Documentation keywords that do not shape a model; ignored by
 * `schemaShapeKey` at a schema's own level. `deprecated` is not one of them:
 * a deprecated copy never shares a live model's name, and a `const` member
 * deprecated on one side only makes a different enum, so `deprecated: true`
 * is shape at every level (a `false` is dropped, like `nullable: false`).
 */
const DOC_KEYWORDS = new Set(['description', 'title', 'example', 'examples', 'summary', 'externalDocs']);
/** Keywords whose value maps NAMES (not keywords) to schemas: names are kept verbatim, values recurse as schemas. */
const NAMED_SCHEMA_MAPS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']);
/** Keywords whose value is a single schema. */
const SCHEMA_KEYWORDS = new Set([
  'items',
  'additionalProperties',
  'additionalItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
]);
/** Keywords whose value is an ordered list of schemas. */
const SCHEMA_LIST_KEYWORDS = new Set(['allOf', 'oneOf', 'anyOf', 'prefixItems']);
/** Keywords whose list value is a set: compared order-insensitively. */
const UNORDERED_LIST_KEYWORDS = new Set(['required', 'type']);

/**
 * A canonical rendering of a schema's shape, for deciding whether two inline
 * schemas describe the same model: every structural keyword (`type`,
 * `properties`, `required`, `items`, `additionalProperties`,
 * `patternProperties`, `allOf`/`oneOf`/`anyOf`, `enum`, `const`, `format`,
 * `nullable`, ...) recursively, with keywords sorted and the `required` and
 * `type` lists order-insensitive. Documentation keywords (`description`,
 * `title`, `example`, `examples`, `summary`, `externalDocs`, `deprecated`)
 * and vendor extensions (`x-*`) are ignored, and so is `nullable: false`,
 * which the nullable unwrap leaves behind — but only where they are a
 * schema's own keywords. Inside `properties`, `patternProperties`,
 * `dependentSchemas`, `dependentRequired` and `$defs` the keys are property
 * names, kept verbatim: a field named `description` or `title` is part of the
 * shape. Enum, const and default values are compared as plain data, in
 * order, as the IR keeps them.
 */
export function schemaShapeKey(schema: SchemaObject): string {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  // Plain data (enum members, const, default): sorted keys, nothing stripped.
  const dataKey = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(dataKey);
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = dataKey(value[key]);
    return out;
  };
  const schemaKey = (value: unknown): unknown => {
    if (!isRecord(value)) return value; // boolean schemas such as `additionalProperties: true`
    const out: Record<string, unknown> = {};
    for (const keyword of Object.keys(value).sort()) {
      const v = value[keyword];
      if (DOC_KEYWORDS.has(keyword) || keyword.startsWith('x-')) continue;
      if (keyword === 'nullable' && v === false) continue;
      if (keyword === 'deprecated' && v !== true) continue;
      if (NAMED_SCHEMA_MAPS.has(keyword) && isRecord(v)) {
        const named: Record<string, unknown> = {};
        for (const name of Object.keys(v).sort()) named[name] = schemaKey(v[name]);
        out[keyword] = named;
      } else if (keyword === 'dependentRequired' && isRecord(v)) {
        const named: Record<string, unknown> = {};
        for (const name of Object.keys(v).sort()) {
          const names = v[name];
          named[name] = Array.isArray(names) ? names.map(String).sort() : dataKey(names);
        }
        out[keyword] = named;
      } else if (SCHEMA_KEYWORDS.has(keyword)) {
        out[keyword] = schemaKey(v);
      } else if (SCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(v)) {
        out[keyword] = v.map(schemaKey);
      } else if (UNORDERED_LIST_KEYWORDS.has(keyword) && Array.isArray(v)) {
        out[keyword] = v.map(String).sort();
      } else {
        out[keyword] = dataKey(v);
      }
    }
    return out;
  };
  return JSON.stringify(schemaKey(schema));
}

/** Field properties that only document a field — its extensions included; two shapes that differ in these alone are one shape. */
const FIELD_DOC_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'externalDocs',
  'example',
  'examples',
  'extensions',
]);
/** Model properties outside its shape: the name, its documentation (description, link, extensions), and the fields (fingerprinted on their own). */
const MODEL_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'externalDocs',
  'extensions',
  'fields',
]);
/** `MODEL_IDENTITY_KEYS` and the model's own `deprecated`, which the admit predicates read on its own (`flagAdmits`) rather than as part of the shape. */
const MODEL_ADMIT_KEYS: ReadonlySet<string> = new Set([...MODEL_IDENTITY_KEYS, 'deprecated']);

/**
 * Shape of a model, independent of field order, name and documentation:
 * every field's name, type, requiredness, limits, default and access flags,
 * plus the model's own limits, type parameters, variants and discriminator.
 * Types are read through `shapeWithEnumFlags`, so an inline enum's per-value
 * deprecation counts as its values do. Two schemas share a model only when
 * this agrees, so a body that repeats another's fields with a different
 * `minLength` or `minProperties`, or an enum member deprecated on one side
 * only, keeps its own model and its own limits. `schemaShapeKey` is the same
 * question asked of a schema before any model is built; this is asked of the
 * models, so two built by different paths (an ordinary object and a union
 * variant) compare the same way (`warnOnVariantNameClash`, the shape
 * registry in `materializeInlineSchema`, the response merge).
 */
export function modelFingerprint(model: Model): string {
  const fields = model.fields
    .map((field) => `${field.name}:${fieldShapeKey(field)}`)
    .sort()
    .join('|');
  return `${fields}#${modelShapeKey(model)}`;
}

/** A field's shape as `modelFingerprint` reads it: everything but its documentation, the type through `shapeWithEnumFlags`. */
function fieldShapeKey(field: Field): string {
  return stableStringify({ ...omitKeys(field, FIELD_DOC_KEYS), type: shapeWithEnumFlags(field.type) });
}

/**
 * `modelFingerprint` read without the model's own `deprecated`: the shape a
 * deprecated copy and a live one of one schema share. What a shape the SDK
 * sends must agree with a declared model on (`modelShares`), and what the
 * merge passes compare two inline copies of one name by when only the flag
 * tells them apart (`differOnlyByDeprecation`).
 */
export function shapeFingerprint(model: Model): string {
  return modelFingerprint({ ...model, deprecated: undefined });
}

/**
 * A model's shape beside its fields: its limits, type parameters,
 * `deprecated` (unless `omit` leaves it out, as `modelAdmits` does), variants
 * (through `readShape`) and dispatch rules, the mapping's targets read under
 * `options.readName` as the variants are.
 */
function modelShapeKey(
  model: Model,
  options: ShapeReadOptions = {},
  omit: ReadonlySet<string> = MODEL_IDENTITY_KEYS,
): string {
  const rest = omitKeys(model, omit);
  if (model.variants) rest.variants = model.variants.map((variant) => readShape(variant, options));
  if (model.discriminator) rest.discriminator = readDiscriminator(model.discriminator, options.readName);
  return stableStringify(rest);
}

/** Field properties `fieldAdmits` reads on their own — the type and the requiredness — beside the documentation it ignores; every other property is compared verbatim. */
const FIELD_ADMIT_KEYS: ReadonlySet<string> = new Set([...FIELD_DOC_KEYS, 'type', 'required', 'deprecated']);
/** Field properties outside `fieldPropertiesKey`: the documentation and the type, which the list-envelope pass compares by structure on its own. */
const FIELD_PROPERTY_KEYS_OMITTED: ReadonlySet<string> = new Set([...FIELD_DOC_KEYS, 'type']);

/**
 * How `modelAdmits`, `fieldAdmits` and `typeShapeKey` read a shape before
 * they compare it.
 */
export interface ShapeReadOptions {
  /**
   * The name every model reference, and every inline enum reference, is
   * read under on both sides before the shapes are compared — in a field's
   * type, a union's variants and a discriminator's mapping targets alike.
   * Absent, a reference is read under the name it carries, so a nested
   * inline model that was renamed keeps a parent from being admitted by one
   * whose child was not. A pass about to rename models hands the name its
   * renaming gives each one, so two shapes compare as that renaming leaves
   * them: the `…Json` fold (`collapseJsonSuffixModels`) reads `<Name>Json…`
   * as `<Name>…`, so a child it will rename counts as its namesake, while a
   * reference it will not rename is still read as it is. An inline enum
   * reference — one carrying its `values`, named by the extractor after the
   * model and field it sits in — is read the same way, so `PetJsonStatus`
   * with the members of `PetStatus` counts as `PetStatus`, and with other
   * members does not, since the members are compared with the name. A
   * component enum reference carries no values and is never renamed by any
   * pass, so it is always read as it is.
   */
  readonly readName?: (name: string) => string;
}

/**
 * Whether `owner` admits `candidate`: every value `candidate` describes is
 * one `owner` describes too, so a reference typed as `owner` in place of
 * `candidate` loses strictness and nothing else. The two have the same field
 * names, and each field admits its namesake (`fieldAdmits`): it agrees in
 * everything `modelFingerprint` reads — type, limits, default, access flags,
 * its own `deprecated` — except that `owner` may be looser where `candidate`
 * is strict, never the other way round: a field `candidate` requires may be
 * optional on `owner`, and a field type `candidate` leaves non-null may be
 * `nullable<…>` on `owner`. Only the field type's own nullable wrapper is
 * read that way; a wrapper deeper down (an array's items) must agree. The
 * models' own limits, type parameters, variants and dispatch rules must
 * agree, and a model reference is compared by name — the name it carries, or
 * the one `options.readName` reads it under: a nested inline model keeps its
 * name, so a parent whose child was renamed is not admitted by one whose
 * child was not. The models' own `deprecated` is read apart from the shape
 * (`flagAdmits`): a live `owner` admits a deprecated `candidate` — the flag
 * stays on the field, parameter or envelope field that wrote the candidate's
 * schema, not on a second model of the same shape — and a deprecated `owner`
 * admits only a deprecated one, so no live reference comes to resolve to a
 * deprecated model by folding. An identical shape is admitted.
 *
 * The one rule by which an inline model folds onto a model the document
 * declares — a component schema, or a model a component's field minted — in
 * the merge passes (`settleSharedNames`) and in the shape registry of
 * `materializeInlineSchema` (`ownerShares`), both through `modelShares`, and
 * by which the `…Json` fold (`collapseJsonSuffixModels`) collapses a
 * `<Name>Json…` child onto the `<Name>…` model that already holds its folded
 * name, every reference read under the fold; two inline models share a name
 * on an identical fingerprint only. A shape the SDK sends — a request body,
 * a parameter — is the callers' exception (`modelShares`): it shares a
 * component on an identical shape only, since typed as a looser component a
 * caller could leave out what the operation requires. The list-envelope pass
 * compares its companions by a structural rule of its own, since a
 * companion's nested models are named per operation; it reads the flag by
 * `flagAdmits` as well.
 */
export function modelAdmits(owner: Model, candidate: Model, options: ShapeReadOptions = {}): boolean {
  if (!flagAdmits(owner, candidate)) return false;
  if (owner.fields.length !== candidate.fields.length) return false;
  const ownerFields = new Map(owner.fields.map((field) => [field.name, field]));
  for (const field of candidate.fields) {
    const own = ownerFields.get(field.name);
    if (!own || !fieldAdmits(own, field, options)) return false;
  }
  return modelShapeKey(owner, options, MODEL_ADMIT_KEYS) === modelShapeKey(candidate, options, MODEL_ADMIT_KEYS);
}

/**
 * Whether `owner`'s own `deprecated` admits `candidate`'s: a live `owner`
 * admits a candidate of either flag, and a deprecated `owner` only a
 * deprecated one. The flag is not part of the shape a fold compares: a
 * deprecated inline schema identical to a live model it is named like shares
 * that model, its flag carried by the site that wrote the schema (a
 * `Field`, a `Parameter`, an envelope field) rather than by a second model
 * of the same shape, while a live site never resolves to a deprecated model
 * through a fold. Read by `modelAdmits` and `modelShares`, and by the
 * list-envelope pass for a companion beside a component.
 */
export function flagAdmits(owner: Model, candidate: Model): boolean {
  return !owner.deprecated || !!candidate.deprecated;
}

/**
 * Whether `owner`, a model the document declares — a component schema, or a
 * model a component's field minted — shares its name with `candidate`, an
 * inline model: when it admits the shape (`modelAdmits`), or, for a shape
 * the SDK sends (`sent`: a request body, a parameter), when the two are
 * identical but for the model's own `deprecated` (`shapeFingerprint`), which
 * is read as `modelAdmits` reads it (`flagAdmits`). The one question the
 * merge passes (`settleSharedNames`) and the shape registry (`ownerShares`)
 * ask of a declared model.
 */
export function modelShares(owner: Model, candidate: Model, sent = false): boolean {
  if (!sent) return modelAdmits(owner, candidate);
  return flagAdmits(owner, candidate) && shapeFingerprint(owner) === shapeFingerprint(candidate);
}

/**
 * Whether `owner` admits `candidate` as the field of its name: the rule
 * `modelAdmits` applies to each field, on its own. The two agree in
 * everything but their documentation — type (through `fieldTypeAdmits`,
 * model and inline enum references read under `options.readName`), limits, default, access
 * flags, their own `deprecated` (`fieldFlagAgrees`: in either direction,
 * since the owner's fields are what every site reads after a fold) — except
 * that `owner` may be optional where `candidate` is required, and
 * `nullable<…>` where `candidate` is not. Everything but the type is
 * `fieldPropertiesAdmit`, which the list-envelope pass reads as well. The
 * `…Json` fold asks this of every field the base and the `…Json` model both
 * declare, since the base takes the `…Json` model's fields.
 */
export function fieldAdmits(owner: Field, candidate: Field, options: ShapeReadOptions = {}): boolean {
  return fieldPropertiesAdmit(owner, candidate) && fieldTypeAdmits(owner.type, candidate.type, options);
}

/**
 * Whether `owner` admits `candidate` as the field of its name in everything
 * but the type — what `fieldAdmits` reads beside `fieldTypeAdmits`: the two
 * agree on their own `deprecated` (`fieldFlagAgrees`), `owner` is no
 * stricter on requiredness (a field `candidate` requires may be optional on
 * `owner`, never the reverse), and every other property — limits, default,
 * access flags, whatever else the IR adds to a field — is identical
 * (`FIELD_ADMIT_KEYS` names the ones read on their own, so a property added
 * to `Field` is compared verbatim until it is listed there). The one
 * definition of a field's properties a fold must preserve: `fieldAdmits`
 * applies it with the type read by shape key, and the list-envelope pass
 * (`admits`) with the type compared by structure, since a companion's nested
 * models are named per operation.
 */
export function fieldPropertiesAdmit(owner: Field, candidate: Field): boolean {
  if (!fieldFlagAgrees(owner, candidate)) return false;
  if (owner.required && !candidate.required) return false;
  return stableStringify(omitKeys(owner, FIELD_ADMIT_KEYS)) === stableStringify(omitKeys(candidate, FIELD_ADMIT_KEYS));
}

/**
 * A field's properties as `fieldPropertiesAdmit` reads them, as one string:
 * everything but its documentation and its type — requiredness, its own
 * `deprecated`, limits, default, access flags. Two fields with the same key
 * admit each other in everything but the type; the list-envelope pass keys
 * a companion's shape by it (`fingerprintModel`) beside the structural key
 * of the type, so the shapes it counts agree with the folds it allows.
 */
export function fieldPropertiesKey(field: Field): string {
  return stableStringify(omitKeys(field, FIELD_PROPERTY_KEYS_OMITTED));
}

/**
 * Whether `owner` and `candidate`, fields of one name, agree on their own
 * `deprecated`, in either direction. A field's flag has no carrier but the
 * field itself: after a fold every site reads the owner's fields, so an
 * owner whose field is live would drop the notice a candidate's deprecated
 * field gave its readers, and an owner whose field is deprecated would give
 * a candidate's readers a notice its own schema never wrote. Read by
 * `fieldAdmits` for every fold `modelAdmits` decides, and by the
 * list-envelope pass's own structural comparison (`admits`), so no fold
 * changes what any site's readers see of a field's flag.
 */
export function fieldFlagAgrees(owner: Field, candidate: Field): boolean {
  return !!owner.deprecated === !!candidate.deprecated;
}

/** Whether `owner` admits every value of `candidate`'s type: the same type under the field's own nullable wrapper, which `owner` may carry where `candidate` does not. */
function fieldTypeAdmits(owner: TypeRef, candidate: TypeRef, options: ShapeReadOptions): boolean {
  if (candidate.kind === 'nullable' && owner.kind !== 'nullable') return false;
  const inner = (ref: TypeRef): TypeRef => (ref.kind === 'nullable' ? ref.inner : ref);
  return typeShapeKey(inner(owner), options) === typeShapeKey(inner(candidate), options);
}

/**
 * A type's shape as the admit predicates read it — every inline enum with
 * its per-value deprecation (`shapeWithEnumFlags`), every model reference
 * and inline enum reference under `options.readName` — stable-stringified,
 * so two types compare by string equality. The `…Json` fold compares a
 * base union's variants with the `…Json` model's through this, both read
 * under the fold.
 */
export function typeShapeKey(ref: TypeRef, options: ShapeReadOptions = {}): string {
  return stableStringify(readShape(ref, options));
}

/**
 * `shapeWithEnumFlags(ref)`, with every model reference and every inline
 * enum reference (one carrying its `values`) renamed by `options.readName`
 * on a copy — the flags are read first, since the copy has no identity in
 * the enum side table.
 */
function readShape(ref: TypeRef, options: ShapeReadOptions): unknown {
  const shape = shapeWithEnumFlags(ref);
  const { readName } = options;
  if (!readName) return shape;
  const read = structuredClone(shape) as TypeRef;
  walkTypeRef(read, {
    model: (r) => {
      (r as { name: string }).name = readName(r.name);
    },
    enum: (r) => {
      if (r.values) r.name = readName(r.name);
    },
  });
  return read;
}

/** The entries of `value` whose key is not in `keys` and whose value is set. */
function omitKeys(value: object, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, entryValue]) => entryValue !== undefined && !keys.has(key)),
  );
}

/** `JSON.stringify` with object keys sorted and unset entries dropped, so equal shapes serialize equally. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * The title-mapped union variants that must not keep their bare title
 * because a variant of another shape takes the same title under the same
 * root (`markContestedTitles`). Replaced whole whenever a document is marked,
 * so a schema object marked for one document is never read as contested for
 * another; empty outside an extraction, where no title is contested.
 */
let contestedTitledVariants = new WeakSet<SchemaObject>();

/**
 * Whether `variant` is a title-mapped union variant whose title another
 * shape takes under the same root (see `markContestedTitles`). The marks are
 * on the document's variants; a folded copy of one (`foldSiblingProperties`)
 * is read through its origin.
 */
export function isContestedTitle(variant: SchemaObject): boolean {
  return contestedTitledVariants.has(foldedVariantOrigin(variant) ?? variant);
}

/**
 * Decide, for a whole OpenAPI document, which title-mapped union variants
 * (`titleMappedVariantNames`) must not keep their bare title: a kept title
 * is context-free — it names one shape wherever it appears, as a component
 * name would — so when two variants anywhere under one root give the same
 * title different shapes (`schemaShapeKey`), neither can keep it, and both
 * take their context-qualified names instead (`nameInlineVariantEntries`).
 * Identical shapes under one title share one model, as between siblings
 * (`reservedInlineNames`), and a title used once is kept. Within one union
 * only the first variant to carry a title is read: a later one with the
 * same title never keeps it, whatever the document holds (`emitted` in
 * `nameInlineVariantEntries`), so it is no claim on the title. The same
 * holds across everything one union reaches without entering an object —
 * its nested unions, its array variants' items, its map variants' values,
 * a lone `allOf` member — the names `mintedInlineNameEntries` reads for the
 * union, which `nonObjectVariantContexts` decides in variant order: an
 * earlier variant's kept title is reserved for a later variant of another
 * shape and shared for the identical one. So one claim set spans that
 * group, and only its first variant per title is read here.
 *
 * A root is a schema whose inline models are collected together: every
 * `components.schemas` entry is read as one root, because one pass collects
 * their inline field models into one list and a named union's variants are
 * already compared across every component; every other schema of the
 * document — the `schema` of a request body's or response's media type, of
 * a parameter, of a response header, of a webhook payload, under `paths`,
 * `webhooks` or `components` alike — is a root of its own. The same title
 * given two shapes by two roots is not contested here: the passes that merge
 * the roots' models decide it (the first owner keeps the name, and a later
 * shape is renamed or dropped with a warning).
 *
 * Within a root, the walk follows the schema keywords only — `properties`
 * and the other name-to-schema maps, `items`, `additionalProperties`,
 * `allOf`/`oneOf`/`anyOf` and the rest of `schemaShapeKey`'s structural
 * keywords — so a property named `schema` or `title` is a property, and a
 * `$ref` is a reference to a component read under the components root, not
 * descended into. The roots are found by following the OpenAPI object model
 * (`schemaRootsOf`), the way the operation, response and webhook readers
 * do, so a name is never mistaken for a specification extension: a header
 * named `x-meta`, a component named `x-thing`, a media type `x-custom/json`
 * or a property `x-id` is read like any other, and an `x-` key is stepped
 * over only where the readers step over it or read nothing: the Paths
 * Object's and the `webhooks` map's (extensions by the specification, which
 * `extractOperations` and `extractWebhooks` step over), a Responses
 * Object's (`readFallbackResponse`) and a Callback Object's (extensions by
 * the specification; the parser reads no callbacks). Decided from the document's content
 * alone, so declaration order and depth play no part, and once per
 * document, before any union is named (`extractSchemas`), so the union
 * TypeRef and every extractor read the same decision. `undefined` clears
 * the previous document's marks.
 *
 * Each root is read with visited sets of its own, so a schema object two
 * roots share — one a `transformSpec` assigned in both places, a bundled
 * external schema inlined twice as one object — is read under each root and
 * compared with each root's other variants, and a mark from either root
 * stands: the shared variant's title is then qualified wherever it appears.
 * Within a root the same holds per claim group: a union object reached
 * under two groups — nested in `shape`, where an earlier union of the group
 * already claimed its title, and again as `wrapper.marker`, where it keeps
 * the title — is read under each, so the two shapes of the title are
 * compared and contested (`markContestedTitlesUnderRoot`). A schema that
 * refers back to itself is stopped by the ancestors on the path to it. The
 * descent over the document keeps a separate guard that never holds a
 * schema. The guards end the walk on a document that refers back to itself.
 */
export function markContestedTitles(document: unknown): void {
  contestedTitledVariants = new WeakSet();
  if (!isRecord(document)) return;
  const components = isRecord(document['components']) ? document['components'] : undefined;
  const schemas = components?.['schemas'];
  if (isRecord(schemas)) markContestedTitlesUnderRoot(Object.values(schemas).filter(isSchemaRecord));
  for (const root of schemaRootsOf(document, components)) markContestedTitlesUnderRoot([root]);
}

/** A plain object: the only value that can be a schema or a container of them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `isRecord`, typed as a schema for the walks below. */
function isSchemaRecord(value: unknown): value is SchemaObject {
  return isRecord(value);
}

/** The Path Item Object's operation fields, the keys the operation readers dispatch on. */
const PATH_ITEM_OPERATIONS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Every schema root of the document outside `components.schemas`, found by
 * walking the OpenAPI 3.0/3.1 object model (see `markContestedTitles`):
 *
 *   - the OpenAPI Object's `paths` and `webhooks` (a path or a name per
 *     key, an `x-` extension stepped over) to Path Item Objects; the
 *     Components Object's `responses`,
 *     `parameters`, `requestBodies`, `headers`, `pathItems` and `callbacks`
 *     (a name per key);
 *   - a Path Item's `parameters` list and operations; an Operation's
 *     `parameters`, `requestBody`, `responses` (a status code, `default`, a
 *     range or an `x-` extension per key) and `callbacks` (a name per key,
 *     each a Callback Object: an expression or an `x-` extension per key,
 *     each a Path Item);
 *   - a Parameter's or Header's `schema` and `content`; a Request Body's and
 *     a Response's `content` (a media type per key) and a Response's
 *     `headers` (a name per key); a Media Type's `schema` and `encoding` (a
 *     property name per key, each an Encoding Object with `headers`).
 *
 * A map whose keys are names is read whole, whatever the keys look like.
 * An `x-` key is stepped over in the Paths Object and the `webhooks` map,
 * where the specification makes it an extension and `extractOperations`
 * and `extractWebhooks` step over it, in a Responses Object, as
 * `readFallbackResponse` steps over it, and in a Callback Object, where the
 * specification makes it an extension (the parser reads no callbacks, so
 * nothing named under one is ever typed). A `$ref` entry
 * anywhere carries no schema of its own: the target is a component, read
 * under its own map. A `schema` is yielded and not entered, so one shared by
 * two sites is yielded for each; every other object is entered once, which
 * ends the walk on a document that refers back to itself. `example`,
 * `examples`, `links` and extensions are never entered.
 */
function schemaRootsOf(
  document: Record<string, unknown>,
  components: Record<string, unknown> | undefined,
): SchemaObject[] {
  const roots: SchemaObject[] = [];
  const entered = new WeakSet<object>();
  /** Enter an object once; false for a non-object or one entered before. */
  const enter = (value: unknown): value is Record<string, unknown> => {
    if (!isRecord(value) || entered.has(value)) return false;
    entered.add(value);
    return true;
  };
  /** Every entry of a map whose keys are names. */
  const named = (map: unknown, visit: (entry: unknown) => void): void => {
    if (!enter(map)) return;
    for (const entry of Object.values(map)) visit(entry);
  };
  /** Every entry of a map whose keys OpenAPI defines beside `x-` extensions. */
  const keyed = (map: unknown, visit: (entry: unknown) => void): void => {
    if (!enter(map)) return;
    for (const [key, entry] of Object.entries(map)) if (!key.startsWith('x-')) visit(entry);
  };
  const listed = (list: unknown, visit: (entry: unknown) => void): void => {
    if (!Array.isArray(list) || entered.has(list)) return;
    entered.add(list);
    for (const entry of list) visit(entry);
  };
  const schema = (value: unknown): void => {
    if (isSchemaRecord(value)) roots.push(value);
  };
  const encoding = (value: unknown): void => {
    if (enter(value)) named(value['headers'], parameter);
  };
  const mediaType = (value: unknown): void => {
    if (!enter(value)) return;
    schema(value['schema']);
    named(value['encoding'], encoding);
  };
  /** A Parameter Object or a Header Object: the same schema sites. */
  const parameter = (value: unknown): void => {
    if (!enter(value)) return;
    schema(value['schema']);
    named(value['content'], mediaType);
  };
  const requestBody = (value: unknown): void => {
    if (enter(value)) named(value['content'], mediaType);
  };
  const response = (value: unknown): void => {
    if (!enter(value)) return;
    named(value['headers'], parameter);
    named(value['content'], mediaType);
  };
  const pathItem = (value: unknown): void => {
    if (!enter(value)) return;
    listed(value['parameters'], parameter);
    for (const method of PATH_ITEM_OPERATIONS) operation(value[method]);
  };
  const operation = (value: unknown): void => {
    if (!enter(value)) return;
    listed(value['parameters'], parameter);
    requestBody(value['requestBody']);
    keyed(value['responses'], response);
    named(value['callbacks'], (callback) => keyed(callback, pathItem));
  };

  // Both maps step over `x-` extensions, as `extractOperations` and
  // `extractWebhooks` do.
  keyed(document['paths'], pathItem);
  keyed(document['webhooks'], pathItem);
  if (components) {
    named(components['responses'], response);
    named(components['parameters'], parameter);
    named(components['requestBodies'], requestBody);
    named(components['headers'], parameter);
    named(components['pathItems'], pathItem);
    named(components['callbacks'], (callback) => keyed(callback, pathItem));
  }
  return roots;
}

/**
 * Mark every title-mapped variant under `roots` (read as one root) whose
 * title another variant under the same roots gives a different shape; see
 * `markContestedTitles` for the walk. The visited sets are this root's own:
 * a schema object another root also holds is read here as well, against
 * this root's variants. Within the root a schema is read once per claim
 * group it is reached from — a union object one group already read (its
 * title skipped as claimed) is read again under a property that starts a
 * group of its own, where the same title is a claim — and a schema that
 * refers back to itself is stopped by the ancestors on the path to it, which
 * ends the walk.
 */
function markContestedTitlesUnderRoot(roots: readonly SchemaObject[]): void {
  const byTitle = new Map<string, { shapes: Set<string>; variants: SchemaObject[] }>();
  const visitedByGroup = new WeakMap<Set<string>, WeakSet<SchemaObject>>();
  const ancestors = new Set<SchemaObject>();
  // `claims` is the group's claim set (see `markContestedTitles`): the titles
  // already read for the union this schema is reached from without entering
  // an object. Only the first variant of a group to carry a title can keep
  // it — a later one with the same title is stepped off it by its own union
  // (`emitted` in `nameInlineVariantEntries` within one union; the kept
  // titles `nonObjectVariantContexts` reserves across a union's non-object
  // variants) whatever else is in the document — so a later one competes
  // for nothing and is not read here. A schema reached any other way starts
  // a group of its own, under which a title the first group skipped is a
  // claim of its own, so the schema is read again there (a union object a
  // `transformSpec` reused under another property: its title keeps the bare
  // name there, and contests the first group's).
  const walk = (schema: SchemaObject, claims: Set<string> = new Set()): void => {
    if (ancestors.has(schema)) return;
    let visited = visitedByGroup.get(claims);
    if (!visited) visitedByGroup.set(claims, (visited = new WeakSet()));
    if (visited.has(schema)) return;
    visited.add(schema);
    if (schema.$ref) return;
    // The shapes are the ones the variants are named and built with: with
    // `properties` written beside the union folded into them
    // (`foldSiblingProperties`). The marks go on the document's variants,
    // which every later fold's copies are read through (`isContestedTitle`).
    for (const [variant, title] of titleMappedVariantNames(foldSiblingProperties(schema))) {
      if (claims.has(title)) continue;
      claims.add(title);
      const entry = byTitle.get(title) ?? { shapes: new Set<string>(), variants: [] };
      entry.shapes.add(schemaShapeKey(variant));
      entry.variants.push(foldedVariantOrigin(variant) ?? variant);
      byTitle.set(title, entry);
    }
    // The group continues through what `mintedInlineNameEntries` reads for a
    // union: its variants, an array's items, a map's values (whether under
    // `additionalProperties` or `patternProperties`), and the one member of a
    // lone `allOf`. `properties` and every other keyword begin a new group.
    ancestors.add(schema);
    for (const [keyword, value] of Object.entries(schema)) {
      if (NAMED_SCHEMA_MAPS.has(keyword) && isRecord(value)) {
        const inherited = keyword === 'patternProperties' ? claims : undefined;
        for (const sub of Object.values(value)) if (isSchemaRecord(sub)) walk(sub, inherited);
      } else if (SCHEMA_KEYWORDS.has(keyword) && isSchemaRecord(value)) {
        walk(value, keyword === 'items' || keyword === 'additionalProperties' ? claims : undefined);
      } else if (SCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value)) {
        const inherited =
          keyword === 'oneOf' || keyword === 'anyOf' || (keyword === 'allOf' && value.length === 1)
            ? claims
            : undefined;
        for (const sub of value) if (isSchemaRecord(sub)) walk(sub, inherited);
      }
    }
    ancestors.delete(schema);
  };
  for (const root of roots) walk(root);
  for (const { shapes, variants } of byTitle.values()) {
    if (shapes.size > 1) for (const variant of variants) contestedTitledVariants.add(variant);
  }
}

/**
 * The context name an array field's items (`kind: 'item'`) or a map field's
 * values (`kind: 'value'`) are typed and extracted under. By default it is
 * the field itself, so the inline model is the parent plus the singularized
 * field (`layers` on `Drawing` → `DrawingLayer`).
 *
 * When a sibling property of the same object would mint that very name —
 * `layer` as an inline object, an inline enum, an inline union with object
 * variants (any of whose variant names counts), or an array or map of such
 * (`mintedInlineNames`); a primitive `email` beside `emails` claims nothing
 * — the elements step aside to
 * `<field>_item` / `<field>_value`, which qualify to `<Parent><Field>Item` /
 * `<Parent><Field>Value` (`DrawingLayersItem`, `DrawingLayersValue`),
 * matching the `<Variant>Item` convention. Should a sibling mint that name
 * too (a property `layers_item`), the fallback keeps going the way
 * `variantMemberKeys` does for variants: `<field>_array_item`, then
 * `<field>_array_item2`, `<field>_array_item3`, ... for items
 * (`DrawingLayersArrayItem`, ...) and `<field>_member_value`,
 * `<field>_member_value2`, ... for values, taking the first candidate whose
 * minted name no sibling claims.
 *
 * Identical-shape sharing: when every sibling claiming the singular name is
 * an inline object whose shape is structurally identical to the items or
 * values (`schemaShapeKey`: same properties, required, types, nested inline
 * schemas and enum values; description, title and example ignored), the
 * fields share one model under the singular name. They are the same shape,
 * so one model is the right SDK type and a duplicate would only add noise;
 * should a later spec version make the shapes diverge, the split happens
 * then, which is the moment the item type genuinely changes. This
 * deliberately departs from a literal one-model-per-field reading for the
 * identical case.
 *
 * Only context-dependent names take part: a title-mapped variant's title
 * (`MintedInlineName.contextFree`) is the same under every context, so no
 * candidate could step away from it, and such a name is shared by design —
 * two sibling arrays whose items carry the same titled variants both
 * reference `Circle` and `Square` (`nameInlineVariants`). The search always
 * terminates: it stops as soon as a candidate changes nothing about the names
 * (`firstFreeElementContext`'s no-progress rule), and
 * `MAX_ELEMENT_CONTEXT_ATTEMPTS` caps it as a backstop; both return the last
 * candidate tried, deterministically.
 *
 * Decided from sibling names and schema content alone, so document order
 * plays no part. `schemaToTypeRef` and every extractor call this with the
 * same sibling set (`collectProperties`); otherwise the reference and the
 * model disagree.
 */
export function elementContextName(
  fieldName: string,
  kind: 'item' | 'value',
  siblings: ReadonlyMap<string, SchemaObject> | undefined,
  parentModelName: string | undefined,
  elementSchema: SchemaObject,
): string {
  return elementContextDecision(fieldName, kind, siblings, parentModelName, elementSchema).context;
}

/** Why `elementContextDecision` settled on a context. */
export type ElementContextReason =
  /** No sibling set: nothing to decide. */
  | 'no-siblings'
  /** The elements mint no context-dependent name. */
  | 'nothing-minted'
  /** No sibling claims any name the elements mint. */
  | 'unclaimed'
  /** Every claimant is an inline object of the identical shape: one model is shared. */
  | 'shared-shape'
  /** A later candidate mints only unclaimed names. */
  | 'free'
  /** The names did not change from one candidate to the next, so no candidate can avoid the claim. */
  | 'no-progress'
  /** `MAX_ELEMENT_CONTEXT_ATTEMPTS` candidates were tried; the last one is kept. */
  | 'cap';

/** Hard cap on the candidates `firstFreeElementContext` tries; the no-progress rule stops it long before in practice. */
export const MAX_ELEMENT_CONTEXT_ATTEMPTS = 256;

/** `elementContextName`, with the reason it decided as it did (see `ElementContextReason`). */
export function elementContextDecision(
  fieldName: string,
  kind: 'item' | 'value',
  siblings: ReadonlyMap<string, SchemaObject> | undefined,
  parentModelName: string | undefined,
  elementSchema: SchemaObject,
): { context: string; reason: ElementContextReason } {
  if (!siblings) return { context: fieldName, reason: 'no-siblings' };
  // The names the elements would mint under a context — the context-dependent
  // ones only, since a context-free name is shared rather than stepped from.
  const dependentNames = (candidate: string): string[] =>
    mintedInlineNameEntries(candidate, elementSchema, parentModelName)
      .filter((entry) => !entry.contextFree)
      .map((entry) => entry.name);
  const own = dependentNames(fieldName);
  if (own.length === 0) return { context: fieldName, reason: 'nothing-minted' };

  // Every inline name the other siblings mint, with the schemas minting it.
  const claimed = new Map<string, SchemaObject[]>();
  for (const [siblingName, siblingSchema] of siblings) {
    if (siblingName === fieldName) continue;
    for (const minted of mintedInlineNames(siblingName, siblingSchema, parentModelName)) {
      claimed.set(minted, [...(claimed.get(minted) ?? []), siblingSchema]);
    }
  }

  const rivals = [...new Set(own.flatMap((name) => claimed.get(name) ?? []))];
  if (rivals.length === 0) return { context: fieldName, reason: 'unclaimed' };
  const element = unwrapNullableSchema(elementSchema);
  const identical = (rival: SchemaObject): boolean => {
    const sibling = unwrapNullableSchema(rival);
    return (
      isInlineObjectSchema(sibling) &&
      isInlineObjectSchema(element) &&
      schemaShapeKey(sibling) === schemaShapeKey(element)
    );
  };
  if (rivals.every(identical)) return { context: fieldName, reason: 'shared-shape' };

  return firstFreeElementContext(fieldName, kind, new Set(claimed.keys()), dependentNames, own);
}

/**
 * The first fallback context under which the elements mint no claimed name:
 * `<field>_item` / `<field>_value`, then `<field>_array_item` /
 * `<field>_member_value`, then `<field>_array_item2`, `…3`, ... (the way
 * `variantMemberKeys` numbers a variant's members). `mint` gives the names
 * under a candidate and `previous` those under the context tried before the
 * first candidate. The search stops with `no-progress` as soon as a
 * candidate mints the same names as the one before it — the names do not
 * depend on the context, so no candidate can avoid the claim — and with
 * `cap` after `maxAttempts` candidates; both keep the last candidate tried.
 */
export function firstFreeElementContext(
  fieldName: string,
  kind: 'item' | 'value',
  claimed: ReadonlySet<string>,
  mint: (candidate: string) => string[],
  previous: readonly string[],
  maxAttempts: number = MAX_ELEMENT_CONTEXT_ATTEMPTS,
): { context: string; reason: ElementContextReason } {
  const fallback = kind === 'item' ? 'array_item' : 'member_value';
  let last = previous;
  let candidate = fieldName;
  for (let i = 0; i < maxAttempts; i++) {
    candidate =
      i === 0 ? `${fieldName}_${kind}` : i === 1 ? `${fieldName}_${fallback}` : `${fieldName}_${fallback}${i}`;
    const minted = mint(candidate);
    if (minted.every((name) => !claimed.has(name))) return { context: candidate, reason: 'free' };
    if (sameNames(minted, last)) return { context: candidate, reason: 'no-progress' };
    last = minted;
  }
  return { context: candidate, reason: 'cap' };
}

/** The same names, in any order. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((name, i) => name === sortedB[i]);
}

/**
 * Every property the object described by `schema` exposes, by name: its own
 * `properties`, those of its `allOf` members (following a member's `$ref`
 * into `schemas` when given, as `extractAllOfModel` does), those of a
 * nullable `oneOf`/`anyOf` wrapper's one non-null variant, read as the
 * member it wraps (`nullableUnionBranch`, the definition the model walks
 * resolve a member by, so a nullable `$ref` member's component is followed
 * here as `mergeAllOfMembers` and `readComponentAllOfMember` follow it), and
 * those of every other inline `oneOf`/`anyOf` variant, whose fields the
 * model extractors flatten in — in the order first declared, each name with
 * the declaration `declareProperty`'s precedence picks: the first
 * always-applying one, else the first variant's. This is the sibling set
 * `elementContextName` decides from; the TypeRef builder and every extractor
 * derive it through this one function so they agree.
 */
export function collectProperties(
  schema: SchemaObject,
  schemas?: Record<string, SchemaObject>,
): Map<string, SchemaObject> {
  const ledger = new Map<string, PropertyDeclarations>();
  const seen = new Set<SchemaObject>();
  const visit = (s: SchemaObject | undefined, followRef: boolean, onBranch: boolean): void => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    if (s.$ref) {
      if (followRef && schemas) visit(schemas[s.$ref.split('/').pop() ?? ''], true, onBranch);
      return;
    }
    for (const [key, value] of Object.entries(s.properties ?? {})) {
      if (value) declareProperty(ledger, key, value, null, onBranch);
    }
    for (const sub of s.allOf ?? []) visit(sub, true, onBranch);
    const branch = nullableUnionBranch(s);
    if (branch) visit(branch, followRef, onBranch);
    else for (const variant of [...(s.oneOf ?? []), ...(s.anyOf ?? [])]) visit(variant, false, true);
  };
  visit(schema, false, false);
  return new Map(
    [...ledger.values()].map((entry) => [entry.name, entry.unconditional?.schema ?? entry.conditional[0]!]),
  );
}

/**
 * Walk all component schemas and extract inline Model definitions for fields
 * that are objects with properties, including objects reached through array
 * items, `oneOf` variants, and map (`additionalProperties` /
 * `patternProperties`) values.
 * These correspond to the ModelRef entries created by schemaToTypeRef.
 */
export function extractInlineModelsFromSchemas(
  schemas: Record<string, SchemaObject> | undefined,
  groups?: FieldInlineModelGroup[],
): Model[] {
  if (!schemas) return [];

  const inlineModels: Model[] = [];
  for (const [schemaName, schema] of Object.entries(schemas)) {
    extractComponentFieldModels(schemaName, schema, schemas, inlineModels, groups);
  }
  return inlineModels;
}

/**
 * The inline models the fields of one component schema (`key`) mint, into
 * `results`: for every field of its model — the declaration
 * `componentPropertyLedger` chose for it, the component's own, one
 * inherited through a `$ref` member, or a branch's when no member always
 * declares the field — everything the field's type reaches (an inline
 * object, array items, map values, a union's variants, under a nullable
 * wrapper, at any depth), through the field extractor
 * (`extractInlineModelsFromProperties`), under the component's name with the
 * sibling set its fields were typed with. The one path through which the
 * field pass (`extractInlineModelsFromSchemas`, run by `parseSpec` on every
 * component) builds a component field's nested models, so a model is built
 * exactly when a component's field references it — `Puppy.meta`, inherited
 * from `Dog` and typed `PuppyMeta` under `Puppy`, has its `PuppyMeta`, and
 * the values of an inherited map their model (workos/oagen#359 review: an
 * inherited map's values were typed but never built, since the field pass
 * walked only the inline declarations and the nested-model backstop of
 * `extractSchemas` follows a reference only into an array or a union). One
 * field at a time, in field order, so the models each field
 * produced are known (`groups`) and the merge pass can rename one by the
 * field that references it. Every call sees the same siblings, reserved
 * names and results list, so the names are exactly those one call over
 * the whole schema would mint.
 */
export function extractComponentFieldModels(
  key: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>,
  results: Model[],
  groups?: FieldInlineModelGroup[],
): void {
  const parentName = resolveSchemaName(key);
  // The same sibling set `extractModel` / `extractAllOfModel` type the
  // component's fields from, `$ref`'d allOf members included.
  const siblings = collectProperties(schema, schemas);
  for (const entry of componentPropertyLedger(parentName, schema, schemas).values()) {
    const before = results.length;
    extractInlineModelsFromProperties(
      { properties: { [entry.name]: declaredComponentProperty(entry) } },
      results,
      parentName,
      schemas,
      siblings,
    );
    groups?.push({ parentName, fieldName: entry.name, models: results.slice(before) });
  }
}

/**
 * Where a group of inline models came from, so a copy that must give up a
 * name it shares with a differently flagged or differently shaped model can
 * be renamed and exactly its own references repointed (see
 * `settleSharedNames` in the merge passes). `qualifier` is prefixed to the
 * new name — the PascalCase operation
 * name for an operation's models, as a list-envelope companion or header
 * model is qualified, the component name for a component field's; `roots`
 * are the type references the site owns — an operation's response, its
 * request body, a component field's type; `models` are the models the site
 * produced, whose fields reference one another. Renaming one of `models`
 * repoints `roots` and the other models' fields, and nothing outside the
 * bundle, so a `$ref` to a same-named component elsewhere in the document is
 * never touched.
 */
export interface InlineModelBundle {
  qualifier: string;
  roots: TypeRef[];
  models: Model[];
  /**
   * Told of every rename of one of `models`, for a site whose references are
   * copied after it is settled — a component field's, whose inline model an
   * operation's or webhook's `allOf` merge copies a reference to
   * (`recordFieldModelRename`). Absent for a site nothing copies from.
   */
  renamed?: (from: string, to: string) => void;
  /**
   * Set when the site's models are what the SDK sends — an operation's
   * request body, primary or secondary, or an inline parameter — so a
   * component shares a name with one of them only on an identical shape
   * (`settleSharedNames`, as `ownerShares` decides for the registry): typed
   * as a looser component, a caller could leave out what the operation
   * requires. Absent for a shape the SDK receives — a response body or
   * header, a webhook's payload or parameter — and for a component field's
   * object, whose direction the document does not say.
   */
  sent?: boolean;
}

/**
 * The inline models one component field produced: `fieldName` of the
 * component resolved to `parentName`. `extractInlineModelsFromSchemas` fills
 * one per field; `fieldInlineModelBundles` turns it into an
 * `InlineModelBundle` once the field's type can be looked up.
 */
export interface FieldInlineModelGroup {
  parentName: string;
  fieldName: string;
  models: Model[];
}

/**
 * Every `ModelRef` an `allOf` merge copied from a referenced component's own
 * property (`buildMergedModel`): `Holder.ext: allOf: [{ $ref: Base }, …]`
 * types the merged model's `meta` exactly as `Base.meta` is typed, so its
 * reference names the inline model `Base.meta` produced. Such a reference
 * belongs to that component field's site, not to the site of the model it
 * sits in: when the merge passes rename the model `Base.meta` produced, the
 * references recorded under `Base.meta` are repointed with the field's own
 * (`fieldInlineModelBundles`), and no other site's rename touches them
 * (`isInheritedModelRef`). An explicit `$ref` among the copied references is
 * a component reference and is not recorded. Reset per document by
 * `extractSchemas`.
 */
/** Each inherited reference, keyed to the `Parent.field` it was copied from, so a copy of it (`cloneTypeRef`) can be recorded under the same field. */
const inheritedModelRefs = new WeakMap<ModelRef, string>();
const inheritedModelRefsByField = new Map<string, ModelRef[]>();
/**
 * The renames the merge passes have applied to the inline models of each
 * component field (`settleFieldInlineModels`, before any operation or
 * webhook is read), keyed `Parent.field`, so a reference an `allOf` merge
 * copies from the field afterwards (`recordInheritedModelRefs`) — typed from
 * the schema, which still mints the original name — is created under the
 * settled name. Reset per document with the inherited references.
 */
const fieldModelRenames = new Map<string, Map<string, string>>();

/** Record that the inline model `from` of `fieldName` of the component resolved to `parentName` is now named `to`. */
export function recordFieldModelRename(parentName: string, fieldName: string, from: string, to: string): void {
  const key = `${parentName}.${fieldName}`;
  const renames = fieldModelRenames.get(key) ?? new Map<string, string>();
  renames.set(from, to);
  fieldModelRenames.set(key, renames);
}

/** Whether `ref` was copied from a component's property by an `allOf` merge (see `inheritedModelRefsOf`). */
export function isInheritedModelRef(ref: ModelRef): boolean {
  return inheritedModelRefs.has(ref);
}

/** The references `allOf` merges copied from `fieldName` of the component resolved to `parentName`. */
export function inheritedModelRefsOf(parentName: string, fieldName: string): ModelRef[] {
  return inheritedModelRefsByField.get(`${parentName}.${fieldName}`) ?? [];
}

/**
 * The models the schema pass lifts from a component field's own inline
 * schema (`collectNestedInlineModels` in `extractSchemas`: a nested object,
 * array items or a union variant, named as the field extractor names them),
 * keyed `Parent.field` by the field each was read from. The field's site
 * claims them by that origin (`fieldInlineModelBundles`), never by name:
 * `Foo.barThing` and `FooBar.thing` both spell `FooBarThing`, only one of
 * them is lifted, and the other field's site must not touch it. Reset per
 * document with the inherited references.
 */
const liftedFieldModels = new Map<string, Model[]>();

/** Record that the schema pass lifted `model` from `fieldName` of the component resolved to `parentName`. */
export function recordLiftedFieldModel(parentName: string, fieldName: string, model: Model): void {
  const key = `${parentName}.${fieldName}`;
  const lifted = liftedFieldModels.get(key) ?? [];
  lifted.push(model);
  liftedFieldModels.set(key, lifted);
}

/** The models the schema pass lifted from `fieldName` of the component resolved to `parentName`, in the order it lifted them. */
export function liftedFieldModelsOf(parentName: string, fieldName: string): Model[] {
  return liftedFieldModels.get(`${parentName}.${fieldName}`) ?? [];
}

/** Forget every inherited reference, field-model rename and lifted field model recorded so far: a new document is being read. */
export function resetInheritedModelRefs(): void {
  inheritedModelRefsByField.clear();
  fieldModelRenames.clear();
  liftedFieldModels.clear();
}

function recordInheritedModelRefs(type: TypeRef, parentName: string, fieldName: string): void {
  const key = `${parentName}.${fieldName}`;
  // A copy made after the field's models were settled names them as the
  // schema does; it is moved to the settled names first, every reference
  // minted for an inline model and never an explicit `$ref`.
  const renames = fieldModelRenames.get(key);
  if (renames) renameTypeRefModels(type, renames, (ref) => !isComponentModelRef(ref));
  walkTypeRef(type, {
    model: (ref) => {
      if (!isComponentModelRef(ref)) recordInheritedRef(ref, key);
    },
  });
}

function recordInheritedRef(ref: ModelRef, key: string): void {
  inheritedModelRefs.set(ref, key);
  const refs = inheritedModelRefsByField.get(key) ?? [];
  refs.push(ref);
  inheritedModelRefsByField.set(key, refs);
}

/**
 * The one way to copy a built type reference. Every pass keys a reference's
 * provenance by its identity — a `$ref` to a component
 * (`isComponentModelRef`), a reference an `allOf` merge copied from a
 * component's field (`isInheritedModelRef`), an inline enum's members and
 * link (`inlineEnumRef`) — so a structural copy (`structuredClone`, a
 * spread) silently turns a component reference into one a merge pass may
 * repoint, drops an inherited reference from its field's site, and leaves an
 * inline enum a bare name to the lift. A copy made here carries every mark
 * its original has: the component mark, the inherited record under the same
 * field, the enum's members and link; a union's mapping is copied with its
 * variants. For a type copied to a second owner — a webhook sharing a path
 * item's minting (`extractWebhooks`). A copy made only to be serialized for
 * comparison, after its flags are spelled out (`foldedVariantKey`), needs
 * none of this.
 */
export function cloneTypeRef(ref: TypeRef): TypeRef {
  switch (ref.kind) {
    case 'model': {
      const copy: ModelRef = { ...ref };
      if (isComponentModelRef(ref)) markComponentModelRef(copy);
      const key = inheritedModelRefs.get(ref);
      if (key !== undefined) recordInheritedRef(copy, key);
      return copy;
    }
    case 'enum': {
      const copy: EnumRef = { ...ref, ...(ref.values ? { values: [...ref.values] } : {}) };
      copyInlineEnumMeta(ref, copy);
      return copy;
    }
    case 'array':
      return { ...ref, items: cloneTypeRef(ref.items) };
    case 'nullable':
      return { ...ref, inner: cloneTypeRef(ref.inner) };
    case 'map':
      return {
        ...ref,
        valueType: cloneTypeRef(ref.valueType),
        ...(ref.keyType ? { keyType: cloneTypeRef(ref.keyType) } : {}),
      };
    case 'union':
      return {
        ...ref,
        variants: ref.variants.map(cloneTypeRef),
        ...(ref.discriminator
          ? { discriminator: { ...ref.discriminator, mapping: { ...ref.discriminator.mapping } } }
          : {}),
      };
    case 'literal':
    case 'primitive':
      return { ...ref };
    default:
      return assertNeverRef(ref);
  }
}

function assertNeverRef(ref: never): never {
  throw new Error(`Unhandled type reference: ${JSON.stringify(ref)}`);
}

/**
 * Walk a schema's properties and materialise every inline object as a model.
 * `componentSchemas` is optional and only feeds `buildFieldFromSchema`, so a
 * field that `$ref`s a component can take its `example`/`examples` from it;
 * callers without the component map at hand simply omit it.
 * `siblingProperties` is the parent object's full property set, for callers
 * that see more of it than this schema shows (see `elementContextName`).
 * `reservedNames` is set only on the re-entry for a field's array items or
 * map values: the inline names that field's siblings mint, which a union
 * among the items or values must step around exactly as `schemaToTypeRef`
 * does when it hands the same set down (`reservedNamesFor`).
 *
 * The recursion follows the document's own inline structure only: a `$ref`
 * is resolved solely to read a component's property list for typing (an
 * augmentation's inherited fields, a sibling set), never descended into, so
 * the depth is bounded by the document's inline nesting and no component
 * graph — self-extending, mutually extending, or reused at several levels —
 * can make it run away.
 */
export function extractInlineModelsFromProperties(
  schema: SchemaObject,
  results: Model[],
  parentName?: string,
  componentSchemas?: Record<string, SchemaObject>,
  siblingProperties?: ReadonlyMap<string, SchemaObject>,
  reservedNames?: ReadonlySet<string>,
): void {
  const properties = schema.properties ?? {};
  const allOfSchemas = schema.allOf ?? [];
  // Every property the parent object exposes, so array items and map values
  // can step aside from a sibling that would mint their name (see
  // `elementContextName`). A caller that sees more siblings than this schema
  // shows — an `allOf` member, an envelope field — passes them in.
  const siblings = siblingProperties ?? collectProperties(schema);
  // The names a union under `fieldName` must not take: the set handed down
  // for array items / map values, else what the field's siblings mint.
  const reservedFor = (fieldName: string): ReadonlySet<string> =>
    reservedNames ?? reservedInlineNames(fieldName, siblings, parentName);

  for (const sub of allOfSchemas) {
    if (sub.properties) {
      extractInlineModelsFromProperties(sub, results, parentName, componentSchemas, siblings, reservedNames);
    }
  }

  for (const [fieldName, rawFieldSchema] of Object.entries(properties)) {
    if (!rawFieldSchema) continue;
    // Dispatch on the shape `schemaToTypeRef` named: it strips nullable
    // wrappers before deciding whether a field is an object, array, or map,
    // so a nullable field must be unwrapped here the same way or its inline
    // object / array items / map values are referenced but never extracted.
    const fieldSchema = unwrapNullableField(rawFieldSchema);
    // One keyword types the field (`classifyInlineSchema`, the order
    // `schemaToTypeRef` follows), so exactly one branch below runs and the
    // models it builds are the ones the field's type references: a schema
    // carrying both `items` and `oneOf` yields the union's variants, never an
    // item model under a variant's name.
    const kind = classifyInlineSchema(fieldSchema);
    // Direct inline object with properties (with or without explicit type: 'object',
    // including the nullable `type: ['object', 'null']` form)
    if (kind === 'object') {
      const baseName = toPascalCase(fieldName);
      const modelName = qualifyInlineModelName(baseName, parentName);
      results.push(buildInlineModel(modelName, fieldSchema, componentSchemas));
      extractInlineModelsFromProperties(fieldSchema, results, modelName, componentSchemas);
    }

    // Array: schemaToTypeRef types the items with the field's own context
    // name and parent, so every inline model reachable through the items — a
    // plain inline object, the variants of an `items.oneOf`, a nested array
    // or map — is named exactly as if the items schema were the field itself
    // (`shapes` → `CreateDrawingRequestShape`, `SquareCreateDrawingRequestShape`).
    // Re-enter with a synthetic property named by `elementContextName` — the
    // field itself, or `<field>_item` when a sibling would take the singular
    // name — so the branches in this function do the extraction with
    // byte-for-byte identical naming.
    const arrayItems = kind === 'array' ? fieldSchema.items : undefined;
    if (arrayItems) {
      const itemContext = elementContextName(fieldName, 'item', siblings, parentName, arrayItems);
      extractInlineModelsFromProperties(
        { properties: { [itemContext]: arrayItems } },
        results,
        parentName,
        componentSchemas,
        undefined,
        reservedFor(fieldName),
      );
    }

    // Map (`additionalProperties` / `patternProperties` on a property-less
    // object): schemaToTypeRef types the values the same way it types array
    // items, so a map of inline objects references `${Parent}${SingularField}`
    // (`layers` on `CreateDrawingRequest` → `CreateDrawingRequestLayer`), or
    // `<Parent><Field>Value` when a sibling takes the singular name. Re-enter
    // with the value schema as a synthetic property of that name.
    if (kind === 'map') {
      const valueSchema = mapValueSchema(fieldSchema);
      if (valueSchema) {
        const valueContext = elementContextName(fieldName, 'value', siblings, parentName, valueSchema);
        extractInlineModelsFromProperties(
          { properties: { [valueContext]: valueSchema } },
          results,
          parentName,
          componentSchemas,
          undefined,
          reservedFor(fieldName),
        );
      }
    }

    // A field expressed via `allOf`, read as `schemaToTypeRef` reads it
    // (`readInlineAllOf`, the one decision):
    //  - `'merged'` — a `$ref` member plus an inline object member
    //    (`isInlineAllOfMember`), or several inline members one of which
    //    declares properties inline (`declaresInlineProperties`): the field
    //    is typed as the model `<Parent><Field>`; merge the referenced
    //    component(s) and the inline members into that model
    //    (`materializeMergedAllOf`), with every inherited property typed
    //    under its component — `Base.meta` stays `BaseMeta`, a
    //    self-reference `Base.child` stays `BaseChild` — and only the inline
    //    members' own properties, a variant's included, qualified under the
    //    merged model and recursed into. The component pass already
    //    materialized whatever the inherited properties reference, so nothing
    //    is duplicated; a component that extends itself through a field
    //    simply points back at a model that exists, and a component reused by
    //    several nested augmentations hands each of them its full field
    //    list. The model is built whatever fields the merge yields, since the
    //    reference that names it exists;
    //  - `'unwrapped'` — a single non-`$ref` member: typed as the field
    //    itself, so re-enter with it as the field (same siblings);
    //  - `'reference'` — `$ref` members only: a plain reference to the first
    //    component, nothing to materialize.
    if (kind === 'allOf' && fieldSchema.allOf) {
      const reading = readInlineAllOf(fieldSchema.allOf, fieldSchema);
      if (reading === 'merged') {
        const modelName = qualifyInlineModelName(toPascalCase(fieldName), parentName);
        materializeMergedAllOf(modelName, fieldSchema, results, componentSchemas);
      } else if (reading === 'unwrapped') {
        // Re-enter with the member as the field (same siblings), carrying the
        // wrapper's limits, flag and link (`unwrappedAllOfMember`).
        extractInlineModelsFromProperties(
          { properties: { [fieldName]: unwrappedAllOfMember(fieldSchema, fieldSchema.allOf[0]!) } },
          results,
          parentName,
          componentSchemas,
          siblings,
          reservedNames,
        );
      }
    }

    // oneOf/anyOf containing objects — extract every inline object variant as a
    // model so each gets its own typed class, under the names the union
    // TypeRef references them by (`nameInlineVariants`, the one place that
    // decides them): variant 0 keeps the bare qualified inline name
    // (`ApiKeyCreatedDataOwner`), later variants take their const-
    // discriminator value (`UserApiKeyCreatedDataOwner`), their title, a
    // distinguishing property (`DrawingShapeWithSide`) or, for identical
    // property sets, the position counter — never a name a sibling property
    // mints (`reservedInlineNames`), nor a title another shape takes under
    // the same root (`isContestedTitle`), so no variant overwrites another
    // field's model.
    const unionVariants = kind === 'union' ? (fieldSchema.oneOf ?? fieldSchema.anyOf) : undefined;
    if (unionVariants) {
      const inlineObjectVariants = unionVariants.filter((v) => isInlineObjectSchema(v));
      // Decided once, for the object variants' models and for the collection
      // contexts, which step around those models' children.
      const variantNames: ReadonlyMap<SchemaObject, string> =
        inlineObjectVariants.length > 0
          ? nameInlineVariants(
              fieldSchema,
              qualifyInlineModelName(toPascalCase(fieldName), parentName),
              reservedFor(fieldName),
            )
          : new Map();
      if (inlineObjectVariants.length > 0) {
        const existingByName = new Map(results.map((r) => [r.name, r]));
        for (const variant of inlineObjectVariants) {
          const variantName = variantNames.get(variant);
          if (variantName === undefined) continue;
          const existing = existingByName.get(variantName);
          if (existing) {
            // The name is already in `results`: a context-free title shared
            // by a variant of the identical shape — the one case the naming
            // rules let two variants take one name — references the model
            // already built. Anything else is a clash the naming rules did
            // not reach (a title coinciding with another field's model, two
            // roots read into one list), and the union's reference will
            // resolve to the model that keeps the name, so say so rather
            // than drop the variant silently.
            warnOnVariantNameClash(existing, variant, variantName, parentName, componentSchemas, results);
            continue;
          }
          const model = buildInlineModel(variantName, variant, componentSchemas);
          existingByName.set(variantName, model);
          results.push(model);
          extractInlineModelsFromProperties(variant, results, variantName, componentSchemas);
          // A multi-type variant (`type: ['object', 'array']`) types the
          // items of its array member under the variant's name
          // (`<Variant>Item`, see `variantMemberSchemas`); re-enter with
          // them as a same-named synthetic property so the models line up.
          extractInlineModelsFromProperties(
            { properties: variantMemberSchemas(variant, variantName) },
            results,
            variantName,
            componentSchemas,
          );
        }
      }
      // Every other variant that mints a name is typed under the context
      // `nonObjectVariantContexts` gives it — `<field>_item` / `<field>_value`
      // for an array or map; the field itself or `<field>_variant_<n>` for a
      // nested union, a nullable wrapper around an object, an `allOf`, an
      // inline enum — apart from the object variants' and each other's names,
      // so whatever it mints is extracted the same way: re-entered as a
      // property of that name, the branches above materialize it exactly as
      // the reference names it (`ReqShapesItem` for a `shapes` variant's
      // items; `ReqShapeVariant2`, `BReqShapeVariant2` for the inline object
      // variants of a union nested under the second variant). The context
      // already stepped around the siblings; the re-entry sees none, exactly
      // as `schemaToTypeRef` types the variant.
      for (const [variant, { context, reserved }] of nonObjectVariantContexts(
        fieldName,
        unionVariants,
        siblings,
        parentName,
        variantNames,
        reservedNames,
      )) {
        const member = unwrapNullableField(variant);
        extractInlineModelsFromProperties(
          { properties: { [context]: member } },
          results,
          parentName,
          componentSchemas,
          undefined,
          reserved,
        );
      }
    }
  }
}

/**
 * Warn when a union variant named `variantName` finds a model of that name
 * already in the results list and the two are not the same shape: the
 * variant is not extracted, and the union's reference resolves to the model
 * that keeps the name. The comparison is between the models themselves —
 * the one in the list, however it was built (an ordinary object, an `allOf`
 * merge, a variant), and the one the variant would have produced, with the
 * nested models each would build — by `deepModelFingerprint`, so a `detail`
 * that is `{ radius }` under the first and `{ diameter }` under the variant
 * counts as a different shape although both parents reference one
 * `DrawingCircleDetail`, and an ordinary object of exactly the variant's
 * shape, nested models included, shares the name silently, as a sibling
 * variant of the identical shape does. The warning names the nested models
 * that differ when the parents' own fields agree. Once per variant, since
 * each is visited once.
 */
function warnOnVariantNameClash(
  existing: Model,
  variant: SchemaObject,
  variantName: string,
  parentName: string | undefined,
  componentSchemas: Record<string, SchemaObject> | undefined,
  results: readonly Model[],
): void {
  const candidate = buildInlineModel(variantName, variant, componentSchemas);
  const built: Model[] = [candidate];
  extractInlineModelsFromProperties(variant, built, variantName, componentSchemas);
  if (deepModelFingerprint(existing, results) === deepModelFingerprint(candidate, built)) return;
  const fieldList = (model: Model): string => model.fields.map((f) => f.name).join(', ') || '(no fields)';
  const site = parentName ? ` under ${parentName}` : '';
  const differing =
    modelFingerprint(existing) === modelFingerprint(candidate)
      ? `; nested models differ: ${differingNestedModels(existing, results, candidate, built).join(', ')}`
      : '';
  console.warn(
    `[oagen] Warning: Inline model "${variantName}" is minted twice with different shapes${site} ` +
      `(fields: ${fieldList(existing)} | ${fieldList(candidate)}${differing}) ` +
      `— keeping the first; the second union's reference resolves to it`,
  );
}

/**
 * `modelFingerprint` of `model` extended with the deep fingerprint of every
 * inline model its fields and variants reference, read from `models`, the
 * list it was built into — so two models of the same fields whose nested
 * models differ compare as different shapes. A referenced name no model in
 * the list defines is a component's and stays a name, the same on both
 * sides; a model that reaches itself is read once per path. Sorted by name,
 * so field order plays no part here either.
 */
export function deepModelFingerprint(model: Model, models: readonly Model[]): string {
  const byName = new Map(models.map((m) => [m.name, m]));
  const visiting = new Set<string>();
  const deep = (m: Model): string => {
    visiting.add(m.name);
    const nested = [...new Set(collectModelTypeRefs(m).flatMap((ref) => collectModelRefs(ref)))].sort().map((name) => {
      const referenced = byName.get(name);
      return referenced && !visiting.has(name) ? `${name}=${deep(referenced)}` : name;
    });
    visiting.delete(m.name);
    return `${modelFingerprint(m)}@{${nested.join(',')}}`;
  };
  return deep(model);
}

/** The names of the inline models `a` and `b` reference, directly or below, whose deep fingerprints differ or that only one side defines; sorted. */
function differingNestedModels(a: Model, aModels: readonly Model[], b: Model, bModels: readonly Model[]): string[] {
  const reachable = (model: Model, models: readonly Model[]): Map<string, string> => {
    const byName = new Map(models.map((m) => [m.name, m]));
    const found = new Map<string, string>();
    const visit = (m: Model): void => {
      for (const name of collectModelTypeRefs(m).flatMap((ref) => collectModelRefs(ref))) {
        const referenced = byName.get(name);
        if (!referenced || found.has(name)) continue;
        found.set(name, deepModelFingerprint(referenced, models));
        visit(referenced);
      }
    };
    visit(model);
    return found;
  };
  const left = reachable(a, aModels);
  const right = reachable(b, bModels);
  const names = new Set([...left.keys(), ...right.keys()]);
  return [...names].filter((name) => left.get(name) !== right.get(name)).sort();
}

/** One property of a merged inline `allOf` and the component it is inherited from (null: an inline member's own). */
export interface MergedProperty {
  name: string;
  schema: SchemaObject;
  origin: { name: string; schema: SchemaObject } | null;
}

/** An inline `allOf` read as one object shape; see `mergeAllOfMembers`. */
export interface MergedAllOf {
  /** Every property the members declare, each name once, in the order first declared. */
  properties: MergedProperty[];
  /** The wrapper's `required` and every always-applying member's, in order; a variant's is not read. */
  required: string[];
  /** The `$ref` members a component schema answered, each once, in order (a member's component chain included). */
  resolvedRefs: string[];
  /** The `$ref` members no component schema answers, each once, in order; they contribute nothing. */
  unresolvedRefs: string[];
  description: string | undefined;
  /** The wrapper's own link, read like its description. */
  externalDocs: ExternalDocs | undefined;
  /** The wrapper's own limits conjoined with its inline members' (a `$ref` member contributes only its sibling keywords). */
  constraints: Constraints | undefined;
  /** `true` when the wrapper itself says `deprecated: true`; a member's flag is not read (a `$ref` member's stays on its model). */
  deprecated: boolean | undefined;
  /** The wrapper's own extensions (`extensionsOf`), read like its link; a member's stay on that member, a `$ref` member's on its component. */
  extensions: Extensions | undefined;
}

/**
 * Whether a schema declares object properties inline: `properties` of its
 * own, or — through a nested `allOf` member or a `oneOf`/`anyOf` variant —
 * a schema that does. A `$ref` declares none here, whatever its component
 * holds: it is a reference, and the component keeps its own fields.
 *
 * This is the question every site that reads an inline `allOf` asks of a
 * member — `allOfTypesSchema` (through `classifyInlineSchema`),
 * `schemaToTypeRef`, `mintedInlineNameEntries` and
 * `extractInlineModelsFromProperties` — so they agree on whether the `allOf`
 * mints a merged model: a member written as `{ oneOf: [{ properties: … },
 * …] }` carries fields `mergeAllOfMembers` reads, so it counts exactly as a
 * member written as `{ properties: … }` does (workos/oagen#283: it did not,
 * and `allOf: [{ $ref }, { oneOf: […] }]` was typed as the bare reference
 * while the variants' fields were dropped).
 */
export function declaresInlineProperties(schema: SchemaObject): boolean {
  const seen = new Set<SchemaObject>();
  const declares = (s: SchemaObject): boolean => {
    if (seen.has(s)) return false;
    seen.add(s);
    if (s.$ref) return false;
    if (s.properties) return true;
    return (s.allOf ?? []).some(declares) || (s.oneOf ?? s.anyOf ?? []).some(declares);
  };
  return declares(schema);
}

/**
 * Whether an `allOf` member is an inline object member — one that, beside a
 * `$ref` member, makes the `allOf` an augmentation model rather than a plain
 * reference (`schemaToTypeRef`): not a `$ref`, and either `type: 'object'`
 * or declaring properties inline (`declaresInlineProperties`).
 */
export function isInlineAllOfMember(member: SchemaObject): boolean {
  return !member.$ref && (member.type === 'object' || declaresInlineProperties(member));
}

/** How an inline `allOf` is read; see `readInlineAllOf`. */
export type InlineAllOfReading = 'merged' | 'unwrapped' | 'reference';

/**
 * The one decision every site makes of an inline `allOf` — `schemaToTypeRef`
 * when it types the schema, `mintedInlineNameEntries` when it predicts the
 * names, the field extractor and `extractInlineModelDeep` when they build
 * the models, `extractDirectResource` when it reads a primary response body
 * — so a model is built exactly when a reference names it:
 *
 *   - `'merged'`: a `$ref` member beside an inline object member
 *     (`isInlineAllOfMember`), or, without a `$ref`, several members one of
 *     which declares properties inline (`declaresInlineProperties`). The
 *     schema is the merged model `mergeAllOfMembers` reads, built with
 *     whatever fields the merge yields: an empty `properties: {}` is an
 *     inline object with no fields, as it is as a plain field or a union
 *     variant (`isInlineObjectSchema`), so its model is built with none
 *     rather than left for the reference to dangle on.
 *   - `'unwrapped'`: a single non-`$ref` member with nothing beside it that
 *     adds to it, typed and extracted as the schema itself
 *     (`unwrappedAllOfMember`, which carries the wrapper's limits, flag and
 *     link onto it). A `required` list the wrapper writes beside a lone
 *     member that declares properties (`declaresInlineProperties`) adds to
 *     it: the schema is then the merged model, which reads both lists
 *     (workos/oagen#359 review: the unwrap carried the member's `required`
 *     only, so `{ allOf: [{ properties: { name } }], required: [name] }`
 *     left `name` optional). Beside a member that declares none — an
 *     array, a primitive, an enum — `required` constrains nothing, and the
 *     member is the schema.
 *   - `'reference'`: a single `$ref` member with nothing beside it that adds
 *     to the component — a `description`, limits — is that component, and
 *     nothing is minted. A second `$ref` member, or a `required` list
 *     (`wrapper`'s own, or a member's) adds to it: the schema is then the
 *     merged model, which carries every component's properties and every
 *     `required` (workos/oagen#359 review: `allOf: [{ $ref: Pet },
 *     { $ref: Owner }]` was `Pet`, `Owner`'s fields gone; `allOf: [{ $ref:
 *     Pet }], required: [name]` was `Pet` with `name` optional).
 *
 * `allOfTypesSchema` admits no other shape as an `allOf`. `wrapper` is the
 * schema the `allOf` is written on, for its own `required`; a site reading
 * bare members passes none.
 */
export function readInlineAllOf(members: readonly SchemaObject[], wrapper?: SchemaObject): InlineAllOfReading {
  const refs = members.filter((m) => m.$ref).length;
  if (refs > 0) {
    if (members.some(isInlineAllOfMember) || refs > 1) return 'merged';
    const addsRequired = [wrapper, ...members].some((s) => s !== undefined && (s.required?.length ?? 0) > 0);
    return addsRequired ? 'merged' : 'reference';
  }
  if (members.length === 1) {
    const only = members[0]!;
    const addsRequired = (wrapper?.required?.length ?? 0) > 0 && declaresInlineProperties(only);
    return addsRequired ? 'merged' : 'unwrapped';
  }
  return members.some(declaresInlineProperties) ? 'merged' : 'reference';
}

/**
 * The lone member of an `allOf`, read as the schema itself. The wrapper's own
 * keywords, conjoined with the member's, are the schema's limits (see
 * `extractConstraints`), so they ride along with the member and the model
 * built from it carries the same constraints; its `deprecated` is the
 * wrapper's alone, as `Field.deprecated` reads it, and its link is the
 * wrapper's too, when the wrapper has one (`withWrapperExternalDocs`). The
 * wrapper's `description` is not carried: the model built from the member
 * keeps the member's own. The type `schemaToTypeRef` builds from the same
 * member takes the wrapper's text as well as its link (`withWrapperDocs`),
 * so an inline enum under the wrapper is documented by the wrapper.
 */
export function unwrappedAllOfMember(wrapper: SchemaObject, member: SchemaObject): SchemaObject {
  // The wrapper's extensions ride along as its link does (`withWrapperExtensions`).
  return withWrapperExtensions(
    withWrapperExternalDocs(withWrapperDeprecation({ ...member, ...extractConstraints(wrapper) }, wrapper), wrapper),
    wrapper,
  );
}

/**
 * The declarations one property name received from the members of an
 * `allOf`, in the order first declared; see `declareProperty`.
 */
export interface PropertyDeclarations {
  name: string;
  /** The always-applying declaration that types the property (`combineDeclarations`), with the component it is inherited from (`null` for the schema's own). */
  unconditional?: { schema: SchemaObject; origin: MergedProperty['origin'] };
  /** Each branch-only declaration — a `oneOf`/`anyOf` variant's — in order. */
  conditional: SchemaObject[];
}

/**
 * Whether a declaration says what an instance is: a `type`, a `$ref`,
 * `properties`, `items`, an `enum` or `const`, a composition, or an
 * `additionalProperties`/`patternProperties` map. One that declares none —
 * a bare `description`, `title`, `example`, `deprecated`, `default`, or a
 * validation keyword on its own (`minimum: 1`) — annotates or constrains a
 * type another declaration gives, and is never read as the type itself
 * (`combineDeclarations`).
 */
export function declaresType(schema: SchemaObject): boolean {
  return (
    schema.type !== undefined ||
    schema.$ref !== undefined ||
    schema.properties !== undefined ||
    schema.items !== undefined ||
    schema.enum !== undefined ||
    schema.const !== undefined ||
    schema.allOf !== undefined ||
    schema.oneOf !== undefined ||
    schema.anyOf !== undefined ||
    schema.additionalProperties !== undefined ||
    schema.patternProperties !== undefined
  );
}

/**
 * The always-applying declaration of one property once a second arrives, in
 * document order — the one precedence rule for a name two members declare,
 * applied by `declareProperty` for every `allOf` merge and by the envelope
 * collector for the properties it reads (`collectObjectProperties`), so a
 * model's field and a list's stop field are typed from the same declaration.
 * The first declaration that declares a type (`declaresType`) types the
 * property, whatever comes after it; a declaration that declares none never
 * does, before or after, and only fills in the keywords the typing one
 * leaves unset — so `has_more: { type: 'boolean' }` beside an `allOf`
 * member's `has_more: { description: 'More pages' }` is a described boolean
 * whichever is read first (workos/oagen#308 review: the collector took the
 * later declaration, so a component's own boolean, folded in first, lost
 * its type to the description). Two typing declarations keep the first as
 * written; the second is not conjoined into it. Returns `held` itself when
 * `next` adds nothing to it, so a lone declaration keeps its identity.
 */
export function combineDeclarations(held: SchemaObject, next: SchemaObject): SchemaObject {
  if (!declaresType(held) && declaresType(next)) return { ...held, ...next };
  if (declaresType(held) && declaresType(next)) return held;
  const unset = Object.entries(next).filter(([key]) => !Object.hasOwn(held, key));
  return unset.length === 0 ? held : { ...Object.fromEntries(unset), ...held };
}

/**
 * Record one declaration of `name` in `ledger`: the one precedence rule
 * every `allOf` merge applies, whether the declaration arrives from a direct
 * member, a nested `allOf` member or a `oneOf`/`anyOf` variant, at any
 * depth. Of the always-applying declarations, the first that declares a
 * type wins, whatever is declared before or after it, and a typeless one
 * only annotates it (`combineDeclarations`); the entry's origin is the
 * typing declaration's. A branch-only declaration (`onBranch`) is only a
 * fallback, kept in order for the reader to use when no member always
 * declares the name — `mergeAllOfMembers` as the union of the distinct
 * branch declarations, the component readers (`extractAllOfModel`,
 * `extractDiscriminatedAllOfVariantModels`) as the first branch's. Names are
 * matched by own name (a `Map`), so `constructor`, `toString` and
 * `__proto__` are properties like any other.
 */
export function declareProperty(
  ledger: Map<string, PropertyDeclarations>,
  name: string,
  schema: SchemaObject,
  origin: MergedProperty['origin'],
  onBranch: boolean,
): void {
  let entry = ledger.get(name);
  if (!entry) ledger.set(name, (entry = { name, conditional: [] }));
  if (onBranch) entry.conditional.push(schema);
  else if (!entry.unconditional) entry.unconditional = { schema, origin };
  else {
    const held = entry.unconditional;
    const typesIt = !declaresType(held.schema) && declaresType(schema);
    entry.unconditional = { schema: combineDeclarations(held.schema, schema), origin: typesIt ? origin : held.origin };
  }
}

/**
 * Merge an inline `allOf` into one object shape, remembering where each
 * property comes from. Every site that types an inline `allOf` reads it
 * through this one function — a model field (of a component or of any
 * inline model), a request body, a response body of every kind (primary,
 * secondary media type, error, `default` and range), a response header, a
 * webhook payload or parameter, array items, map values, a union's `allOf`
 * variant, and a field nested under a discriminated component variant — so
 * the same schema has the same fields wherever it appears.
 *
 * Members are read in document order, the wrapper's own `properties` and
 * `required` first. A `$ref` member is resolved against `componentSchemas`
 * by its component name, as `extractAllOfModel` does, and contributes its
 * component's `properties` — its own, written beside its `allOf`, and those
 * of its `allOf` chain, in the order `extractAllOfModel` reads them
 * (`componentAllOfMembers`) — tagged with that component's model name, so the merged
 * model can type them exactly as the component's own model does; a ref no
 * component answers contributes nothing and is listed in `unresolvedRefs`.
 * The component tagged is the one whose own model carries the field under
 * its name: an `allOf` component that inherits it stays the origin of
 * everything reached inside its chain (`DogMeta`), while a bare alias
 * (`Hop: { $ref: Base }`), a nullable alias (`Alias: { oneOf: [{ $ref: Base
 * }, { type: 'null' }] }`) or a chain of either declares nothing of its own
 * and builds no model, so a reference met inside one starts its own origin
 * (`Base.meta` stays `BaseMeta`; workos/oagen#308 round 4).
 * An inline member contributes its `properties`, those of its nested
 * `allOf` members and, for a `oneOf`/`anyOf` it carries, those of every
 * variant that declares properties inline — read through the variant's own
 * `allOf` members and nested unions the same way — tagged as the merged
 * model's own (workos/oagen#283: a variant's fields were dropped, so an
 * inline `allOf: [base, { oneOf: [{ a }, { b }] }]` lost `a` and `b` while
 * the same schema as a component kept them).
 *
 * `required` is collected from the wrapper and from every member that always
 * applies; a variant's `required` is not read, since its properties are
 * present only on that branch, so they are optional on the merged model,
 * exactly as `extractAllOfModel` flattens a component's variants. Two
 * boundaries are not crossed: a `$ref` under a variant — the variant itself,
 * or a member of the variant's own `allOf` — is not followed (its component
 * keeps its own fields), and a union a `$ref` member's component carries is
 * not read (the component's own model dispatches or flattens it).
 *
 * A property keeps the always-applying declaration `declareProperty` settles
 * on — the first that declares a type, a typeless one before or after it
 * only annotating it (`combineDeclarations`) — whatever a variant says: a
 * variant can only narrow what every instance
 * carries. A property only variants declare is typed as the union of its
 * distinct declarations (`unionOfDeclarations`): one declaration, or several
 * of one shape, is that declaration; several shapes become a `oneOf` of
 * them, which the type builder reads as it reads any inline union — string
 * consts pinned differently per variant (`kind: cat` | `kind: dog`) collapse
 * to an inline enum, other literals and types to a union — so the field is
 * never typed from one variant's value alone. Properties keep the order they
 * were first declared in.
 *
 * A schema reached twice is read once in each capacity: a reading under a
 * variant does not stand in for an always-applying one, so a schema shared
 * between a variant and a member — a YAML anchor, an object a `transformSpec`
 * reuses, a `$ref` written twice — still contributes its `required` and is
 * still followed when the member is reached (`done`). The walk reads
 * property lists only — it never descends into a property — so it is finite
 * for any component graph: a schema already read in the same capacity is not
 * read again, which is what stops a component that extends itself.
 */
export function mergeAllOfMembers(
  schema: SchemaObject,
  componentSchemas: Record<string, SchemaObject> | undefined,
): MergedAllOf {
  const declared = new Map<string, PropertyDeclarations>();
  const required: string[] = [];
  const resolvedRefs: string[] = [];
  const unresolvedRefs: string[] = [];
  // The schemas read so far, by capacity. An always-applying reading is
  // complete; a reading under a variant is not, so the same schema reached
  // again as a member is read once more for its `required` and its `$ref`s.
  const done = { unconditional: new Set<SchemaObject>(), conditional: new Set<SchemaObject>() };
  // `onBranch`: inside a `oneOf`/`anyOf` variant, whose properties are
  // optional and whose `$ref`s are not followed.
  const visit = (s: SchemaObject, origin: MergedProperty['origin'], onBranch: boolean): void => {
    const mode = onBranch ? 'conditional' : 'unconditional';
    if (done.unconditional.has(s) || done[mode].has(s)) return;
    done[mode].add(s);
    if (s.$ref) {
      if (onBranch) return;
      const rawName = s.$ref.split('/').pop() ?? '';
      const target = componentSchemas?.[rawName];
      const refs = target ? resolvedRefs : unresolvedRefs;
      if (!refs.includes(s.$ref)) refs.push(s.$ref);
      if (!target) return;
      // The component the properties belong to is the one whose own model
      // carries them under its name. A ref inside an `allOf` component's own
      // chain stays that component's: its model inherits through its
      // members, nullable ones included, and types their fields under its
      // own name (`DogMeta`). Any other component met on the way declares
      // nothing of its own that this reference adds to — a bare alias
      // (`Hop: { $ref: Base }`), a nullable alias (`Alias: { oneOf: [{ $ref:
      // Base }, { type: 'null' }] }`), a chain of either — and builds no
      // model for the fields, so the reference starts its own origin, as a
      // top-level ref member does (workos/oagen#308 round 4: `HolderValue.meta`
      // named `AliasMeta`, which nothing built, where `BaseMeta` exists).
      const owner = origin?.schema.allOf ? origin : { name: resolveSchemaName(rawName), schema: target };
      visit(target, owner, onBranch);
      return;
    }
    for (const [key, value] of Object.entries(s.properties ?? {})) {
      if (value) declareProperty(declared, key, value, origin, onBranch);
    }
    if (s.required && !onBranch) required.push(...s.required);
    for (const sub of s.allOf ?? []) visit(sub, origin, onBranch);
    // A nullable union wrapper — one non-null variant beside `null`, decided
    // by `nullableUnionBranch`, the definition `unwrapNullableSchema`
    // collapses by, which `readComponentAllOfMember` reads a component's
    // member through and the envelope collector reads every member through
    // (`resolveBareSchema`) — is that variant, applying as the member does:
    // an instance that is not null is the variant, and beside an object
    // member it is never null. So the variant is read in the member's own
    // capacity — its `$ref` followed, its `required` read, its properties
    // always-applying — wherever the member sits, a `$ref` member's
    // component included (workos/oagen#308: read as a branch, `Base`'s
    // `has_more` ended the iteration but was missing from the model). Any
    // other inline union is flattened; one a `$ref` member's component
    // carries belongs to that component's model.
    const branch = nullableUnionBranch(s);
    if (branch) visit(branch, origin, onBranch);
    else if (origin === null) for (const variant of s.oneOf ?? s.anyOf ?? []) visit(variant, origin, true);
  };
  visit(schema, null, false);
  const properties: MergedProperty[] = [...declared.values()].map(({ name, unconditional, conditional }) =>
    unconditional
      ? { name, schema: unconditional.schema, origin: unconditional.origin }
      : { name, schema: unionOfDeclarations(conditional), origin: null },
  );
  // Limits conjoin the way properties merge, so the merged model declares what
  // an instance must satisfy; a `$ref` member's target keeps its own limits.
  return {
    properties,
    required,
    resolvedRefs,
    unresolvedRefs,
    description: schema.description,
    externalDocs: readExternalDocs(schema.externalDocs),
    constraints: extractConstraints(schema),
    deprecated: schema.deprecated === true || undefined,
    extensions: extensionsOf(schema, SCHEMA_CONSUMED_EXTENSIONS),
  };
}

/**
 * The keywords a field reads from its own schema — the flags and
 * documentation `buildFieldFromSchema` reads and the validation keywords
 * `extractConstraints` reads — which `unionOfDeclarations` lifts onto a
 * combined declaration when every declaration agrees on them.
 */
const LIFTED_DECLARATION_KEYWORDS: readonly string[] = [
  'readOnly',
  'writeOnly',
  'deprecated',
  'description',
  'default',
  'example',
  'examples',
  'externalDocs',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minContains',
  'maxContains',
  'minProperties',
  'maxProperties',
  'pattern',
  'uniqueItems',
  'dependentRequired',
];

/**
 * The one schema that types a property several variants declare: the first
 * declaration when every declaration has the same shape (`schemaShapeKey`,
 * documentation ignored), else a `oneOf` of the distinct shapes, each the
 * first declaration of its shape, in order. See `mergeAllOfMembers`.
 *
 * A field reads its flags, documentation and limits from its own schema
 * (`buildFieldFromSchema`, `extractConstraints`), never from a union's
 * variants, so a combined declaration carries every keyword of
 * `LIFTED_DECLARATION_KEYWORDS` the declarations agree on, value for value:
 * two `kind` declarations both `readOnly: true` with different consts make a
 * read-only enum field; a keyword the declarations disagree on, or one only
 * some declare, is not the field's. Every declaration as written has a say,
 * a repeat of an earlier shape included. The extensions are read by the same
 * agreement (`agreedExtensions`), and — unlike the keywords, which the first
 * declaration gives when all share one shape — under both outcomes: the one
 * declaration a single shape is typed from carries the agreed keys in place
 * of its own. The declarations themselves are kept as
 * written inside the `oneOf`, so an enum member or a variant model still
 * carries its own description and limits. A `null` any declaration admits
 * (`nullable: true`, or a `type` list naming `null`) is a value the property
 * takes on that branch, so the union admits it: the admission moves to a
 * `{ type: 'null' }` variant of the `oneOf` — the one place the type builder
 * reads a union's nullability from, and one a union of string consts would
 * otherwise lose when it collapses to an enum — and off the declarations.
 */
function unionOfDeclarations(declarations: readonly SchemaObject[]): SchemaObject {
  if (declarations.length === 1) return declarations[0]!;
  // The extensions are decided first, across every declaration as written,
  // apart from the shape dedupe below: a declaration dropped as a repeat of
  // an earlier shape still has its say, so `x-since` written as `1`, `2` and
  // `1` by three declarations is nobody's (workos/oagen#369 review, which
  // read the keys off the distinct shapes alone and kept the `1`).
  const extensions = agreedExtensions(declarations);
  const distinct = new Map<string, SchemaObject>();
  for (const declaration of declarations) {
    const key = schemaShapeKey(declaration);
    if (!distinct.has(key)) distinct.set(key, declaration);
  }
  const shapes = [...distinct.values()];
  // One shape: the first declaration, as written, carrying the agreed
  // extensions in place of its own.
  if (shapes.length === 1) return withAgreedExtensions(shapes[0]!, extensions);
  // The keywords are read across every declaration the same way: a dropped
  // repeat of a shape that disagrees on a keyword leaves it off too.
  const agreed: Record<string, unknown> = { ...agreedDeclarationKeys(declarations, LIFTED_DECLARATION_KEYWORDS) };
  const anyAdmitsNull = shapes.some(admitsNull);
  const variants = anyAdmitsNull ? [...shapes.map(withoutNull), { type: 'null' }] : shapes;
  return { ...agreed, ...extensions, oneOf: variants };
}

/**
 * The entries of `keys` every one of `declarations` declares with one
 * value — compared by `stableStringify`, so an object value agrees whatever
 * its key order — each as the first declaration writes it. A key any
 * declaration leaves unset, or declares with another value, is left out.
 * The one agreement rule for a property several variants declare, read for
 * the lifted keywords and for the extensions alike (`unionOfDeclarations`).
 */
function agreedDeclarationKeys(declarations: readonly SchemaObject[], keys: Iterable<string>): Record<string, unknown> {
  const agreed: Record<string, unknown> = {};
  for (const key of keys) {
    const values = declarations.map((declaration) => declaration[key]);
    if (values[0] === undefined) continue;
    const first = stableStringify(values[0]);
    if (values.every((value) => value !== undefined && stableStringify(value) === first)) agreed[key] = values[0];
  }
  return agreed;
}

/**
 * The extensions every one of `declarations` agrees on
 * (`agreedDeclarationKeys` over the first declaration's keys, the consumed
 * ones left out as `extensionsOf` leaves them); `undefined` when none. A
 * property several variants declare carries exactly these, whether or not
 * the declarations share one shape: no one declaration is the schema for a
 * key OpenAPI gives no meaning to, and an emitter may act on it, so a key
 * the declarations dispute is nobody's.
 */
function agreedExtensions(declarations: readonly SchemaObject[]): Extensions | undefined {
  const keys = Object.keys(extensionsOf(declarations[0]!, SCHEMA_CONSUMED_EXTENSIONS) ?? {});
  const agreed = agreedDeclarationKeys(declarations, keys);
  return Object.keys(agreed).length > 0 ? agreed : undefined;
}

/** `schema` with `extensions` in place of its own (consumed keys kept where they are); `schema` itself when neither has any. */
function withAgreedExtensions(schema: SchemaObject, extensions: Extensions | undefined): SchemaObject {
  const own = extensionsOf(schema, SCHEMA_CONSUMED_EXTENSIONS);
  if (!own && !extensions) return schema;
  const kept = Object.entries(schema).filter(([key]) => !(own && Object.hasOwn(own, key)));
  return { ...Object.fromEntries(kept), ...extensions };
}

/** Whether a declaration admits `null` on its own: OAS 3.0 `nullable: true`, or a `type` list naming `null`. */
function admitsNull(schema: SchemaObject): boolean {
  return schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'));
}

/** `schema` with its own `null` admission removed (see `admitsNull`); the type list collapses to its one remaining entry. */
function withoutNull(schema: SchemaObject): SchemaObject {
  const { nullable: _nullable, ...rest } = schema;
  if (Array.isArray(rest.type)) {
    const types = rest.type.filter((t) => t !== 'null');
    rest.type = types.length === 1 ? types[0] : types;
  }
  return rest;
}

/**
 * Build the model for an inline `allOf` read as `'merged'` (`readInlineAllOf`)
 * under `name`, and materialize what its own properties reference, into
 * `results`. The model is built whatever fields the merge yields — none for
 * an `allOf` whose inline members declare only an empty `properties: {}` —
 * since the reference `schemaToTypeRef` made under the same reading exists
 * and must resolve. The model is `buildMergedModel`'s, so an inherited
 * property is typed as its component's model types it (`Base.meta` stays
 * `BaseMeta`) and is not read into again — the component pass materialized
 * whatever it references, and a component that extends itself through a
 * field (`Node.child: allOf: [{ $ref: Node }, …]`) is typed as the
 * `NodeChild` that exists instead of being re-extracted without end. Only
 * the merged model's own properties — the inline members' and the variants'
 * — are re-entered, under `name`, with the full merged property set as
 * siblings. Shared by the field extractor and `extractInlineModelDeep`, so a
 * field nested under a discriminated component variant is built exactly as
 * the same field anywhere else.
 */
export function materializeMergedAllOf(
  name: string,
  schema: SchemaObject,
  results: Model[],
  componentSchemas: Record<string, SchemaObject> | undefined,
): void {
  const merged = mergeAllOfMembers(schema, componentSchemas);
  results.push(buildMergedModel(name, merged, componentSchemas));
  // Properties are matched by own name throughout the merge (a `Map` there,
  // `Object.fromEntries` here), so a property named `constructor`,
  // `toString` or `__proto__` is kept and re-entered like any other.
  const own = Object.fromEntries(merged.properties.filter((p) => p.origin === null).map((p) => [p.name, p.schema]));
  const mergedSiblings = new Map(merged.properties.map((p) => [p.name, p.schema]));
  extractInlineModelsFromProperties({ properties: own }, results, name, componentSchemas, mergedSiblings);
}

/**
 * The merged shape as one object schema, for a site that builds its model
 * from a schema rather than from the merged list (`extractDirectResource`,
 * `extractInlineModelDeep`): every property under its name in merged order,
 * the collected `required`, and the wrapper's own `deprecated`, limits and
 * link, as `buildMergedModel` carries them — a member's stay on that member,
 * a `$ref` member's on its component. The wrapper's `description` is left
 * off, as both sites left it off the schemas they rebuilt before.
 */
export function mergedObjectSchema(merged: MergedAllOf): SchemaObject {
  return {
    type: 'object',
    properties: Object.fromEntries(merged.properties.map((p) => [p.name, p.schema])),
    required: merged.required,
    ...(merged.deprecated ? { deprecated: true } : {}),
    ...merged.constraints,
    ...(merged.externalDocs ? { externalDocs: merged.externalDocs } : {}),
    ...merged.extensions,
  };
}

/**
 * Build the model for a merged `allOf` field. An inherited property is typed
 * with its component as naming context and the component's own sibling set,
 * so it carries the same TypeRef as in the component's model (`BaseMeta`,
 * `BaseChild`, ...); the merged model's own properties are typed under its
 * name with the full merged property set as siblings.
 */
function buildMergedModel(name: string, merged: MergedAllOf, componentSchemas?: Record<string, SchemaObject>): Model {
  const requiredSet = new Set(merged.required);
  const mergedSiblings = new Map(merged.properties.map((p) => [p.name, p.schema]));
  const componentSiblings = new Map<string, Map<string, SchemaObject>>();
  const fields = merged.properties.map((p) => {
    if (p.origin === null) {
      return buildFieldFromSchema(p.name, p.schema, name, requiredSet, componentSchemas, mergedSiblings);
    }
    let siblings = componentSiblings.get(p.origin.name);
    if (!siblings) {
      siblings = collectProperties(p.origin.schema, componentSchemas);
      componentSiblings.set(p.origin.name, siblings);
    }
    const field = buildFieldFromSchema(p.name, p.schema, p.origin.name, requiredSet, componentSchemas, siblings);
    // The field is a copy of the component's own: whatever inline model its
    // references name is the one the component's field references, so they
    // are recorded under that field and follow its model wherever it goes.
    recordInheritedModelRefs(field.type, p.origin.name, p.name);
    return field;
  });
  return {
    name,
    description: merged.description,
    ...(merged.externalDocs ? { externalDocs: merged.externalDocs } : {}),
    fields,
    ...(merged.deprecated ? { deprecated: true } : {}),
    ...(merged.constraints ? { constraints: merged.constraints } : {}),
    ...(merged.extensions ? { extensions: merged.extensions } : {}),
  };
}

/**
 * The schema that types a map's values, in the precedence `schemaToTypeRef`
 * uses: a non-empty `additionalProperties` object wins, otherwise the first
 * `patternProperties` entry. `additionalProperties: {}` means "any value"
 * (typed `unknown`, nothing to extract) and does not fall through to
 * `patternProperties`, matching the type-ref branch.
 */
export function mapValueSchema(schema: SchemaObject): SchemaObject | null {
  const additional = schema.additionalProperties;
  if (additional && typeof additional === 'object') {
    return Object.keys(additional).length > 0 ? additional : null;
  }
  const patterns = schema.patternProperties ? Object.values(schema.patternProperties) : [];
  return patterns[0] ?? null;
}

/**
 * The model for an inline object: its properties as fields, typed under
 * `name`, with its description and constraints. Shared with the named-union
 * extractor in schemas.ts, which materializes a union's inline object variants
 * exactly as the union branch below does.
 */
export function buildInlineModel(
  name: string,
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
): Model {
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];
  const siblings = collectProperties(schema);

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet, componentSchemas, siblings));
  }

  return {
    name,
    description: schema.description,
    ...externalDocsEntry(schema.externalDocs),
    fields,
    ...deprecatedEntry(schema),
    ...constraintsEntry(schema),
    ...schemaExtensionsEntry(schema),
  };
}
