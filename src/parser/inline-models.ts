import type { Constraints, ExternalDocs, Model, ModelRef, Field, TypeRef } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import { toPascalCase, stripListItemMarkers, singularize } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import {
  buildFieldFromSchema,
  classifyInlineSchema,
  nonObjectVariantContexts,
  constraintsEntry,
  deprecatedEntry,
  extractConstraints,
  isComponentModelRef,
  isInlineObjectSchema,
  isNullSchema,
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
import { shapeWithEnumFlags } from './enum-members.js';

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
    const only = s.allOf.length === 1 ? s.allOf[0] : undefined;
    if (only) return mintedInlineNameEntries(contextName, only, parentModelName, reserved);
    return s.allOf.some((m) => !m.$ref && (m.properties || m.type === 'object')) ? modelName() : [];
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

/** Field properties that only document a field; two shapes that differ in these alone are one shape. */
const FIELD_DOC_KEYS: ReadonlySet<string> = new Set(['name', 'description', 'externalDocs', 'example', 'examples']);
/** Model properties outside its shape: the name, its documentation (description and link), and the fields (fingerprinted on their own). */
const MODEL_IDENTITY_KEYS: ReadonlySet<string> = new Set(['name', 'description', 'externalDocs', 'fields']);

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
    .map(
      (field) =>
        `${field.name}:${stableStringify({ ...omitKeys(field, FIELD_DOC_KEYS), type: shapeWithEnumFlags(field.type) })}`,
    )
    .sort()
    .join('|');
  const rest = omitKeys(model, MODEL_IDENTITY_KEYS);
  if (model.variants) rest.variants = model.variants.map(shapeWithEnumFlags);
  return `${fields}#${stableStringify(rest)}`;
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
 * over only where the readers step over it or read nothing: a Responses
 * Object's (`readFallbackResponse`) and a Callback Object's (extensions by
 * the specification; the parser reads no callbacks). Decided from the document's content
 * alone, so declaration order and depth play no part, and once per
 * document, before any union is named (`extractSchemas`), so the union
 * TypeRef and every extractor read the same decision. `undefined` clears
 * the previous document's marks.
 *
 * Each root is read with a visited set of its own, so a schema object two
 * roots share — one a `transformSpec` assigned in both places, a bundled
 * external schema inlined twice as one object — is read under each root and
 * compared with each root's other variants, and a mark from either root
 * stands: the shared variant's title is then qualified wherever it appears.
 * The descent over the document keeps a separate guard that never holds a
 * schema. Both guards end the walk on a document that refers back to itself.
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
 *     key) to Path Item Objects; the Components Object's `responses`,
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
 * The Paths Object is read whole too, every key as a Path Item, exactly as
 * `extractOperations` reads it. An `x-` key is stepped over in a Responses
 * Object, as `readFallbackResponse` steps over it, and in a Callback Object,
 * where the specification makes it an extension (the parser reads no
 * callbacks, so nothing named under one is ever typed). A `$ref` entry
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

  named(document['paths'], pathItem);
  named(document['webhooks'], pathItem);
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
 * `markContestedTitles` for the walk. The visited set is this root's own:
 * a schema object another root also holds is read here as well, against
 * this root's variants, and a schema reached twice within this root — the
 * same object under two properties, or one that refers back to itself — is
 * read once, which ends the walk.
 */
function markContestedTitlesUnderRoot(roots: readonly SchemaObject[]): void {
  const byTitle = new Map<string, { shapes: Set<string>; variants: SchemaObject[] }>();
  const visited = new WeakSet<SchemaObject>();
  // `claims` is the group's claim set (see `markContestedTitles`): the titles
  // already read for the union this schema is reached from without entering
  // an object. Only the first variant of a group to carry a title can keep
  // it — a later one with the same title is stepped off it by its own union
  // (`emitted` in `nameInlineVariantEntries` within one union; the kept
  // titles `nonObjectVariantContexts` reserves across a union's non-object
  // variants) whatever else is in the document — so a later one competes
  // for nothing and is not read here. A schema reached any other way starts
  // a group of its own.
  const walk = (schema: SchemaObject, claims: Set<string> = new Set()): void => {
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
 * into `schemas` when given, as `extractAllOfModel` does), and those of
 * inline `oneOf`/`anyOf` variants, whose fields the model extractors flatten
 * in; the first definition of a name wins. This is the sibling set
 * `elementContextName` decides from; the TypeRef builder and every extractor
 * derive it through this one function so they agree.
 */
export function collectProperties(
  schema: SchemaObject,
  schemas?: Record<string, SchemaObject>,
): Map<string, SchemaObject> {
  const properties = new Map<string, SchemaObject>();
  const seen = new Set<SchemaObject>();
  const visit = (s: SchemaObject | undefined, followRef: boolean): void => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    if (s.$ref) {
      if (followRef && schemas) visit(schemas[s.$ref.split('/').pop() ?? ''], true);
      return;
    }
    for (const [key, value] of Object.entries(s.properties ?? {})) {
      if (value && !properties.has(key)) properties.set(key, value);
    }
    for (const sub of s.allOf ?? []) visit(sub, true);
    for (const variant of [...(s.oneOf ?? []), ...(s.anyOf ?? [])]) visit(variant, false);
  };
  visit(schema, false);
  return properties;
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
    const parentName = resolveSchemaName(schemaName);
    // The same sibling set `extractModel` / `extractAllOfModel` type the
    // component's fields from, `$ref`'d allOf members included.
    const siblings = collectProperties(schema, schemas);
    // One field at a time — the inline `allOf` members' properties first,
    // then the schema's own, in the order `extractInlineModelsFromProperties`
    // walks them — so the models each field produced are known (`groups`)
    // and the merge pass can rename one by the field that references it.
    // Every call sees the same siblings, reserved names and results list, so
    // the names are exactly those one call over the whole schema would mint.
    for (const [fieldName, fieldSchema] of inlineProperties(schema)) {
      const before = inlineModels.length;
      extractInlineModelsFromProperties(
        { properties: { [fieldName]: fieldSchema } },
        inlineModels,
        parentName,
        schemas,
        siblings,
      );
      groups?.push({ parentName, fieldName, models: inlineModels.slice(before) });
    }
  }

  return inlineModels;
}

/**
 * A schema's inline properties in extraction order: those of its inline
 * `allOf` members (each walked the same way, members first) before its own —
 * the order `extractInlineModelsFromProperties` visits them in, so splitting
 * a schema by field changes nothing about which models are minted, or when.
 */
function* inlineProperties(schema: SchemaObject): Generator<[string, SchemaObject]> {
  for (const sub of schema.allOf ?? []) if (sub.properties) yield* inlineProperties(sub);
  for (const [name, property] of Object.entries(schema.properties ?? {})) if (property) yield [name, property];
}

/**
 * Where a group of inline models came from, so a copy that must give up a
 * name it shares with a differently flagged model can be renamed and exactly
 * its own references repointed (see `separateDeprecatedCopies` in the merge
 * passes). `qualifier` is prefixed to the new name — the PascalCase operation
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
const inheritedModelRefs = new WeakSet<ModelRef>();
const inheritedModelRefsByField = new Map<string, ModelRef[]>();

/** Whether `ref` was copied from a component's property by an `allOf` merge (see `inheritedModelRefsOf`). */
export function isInheritedModelRef(ref: ModelRef): boolean {
  return inheritedModelRefs.has(ref);
}

/** The references `allOf` merges copied from `fieldName` of the component resolved to `parentName`. */
export function inheritedModelRefsOf(parentName: string, fieldName: string): ModelRef[] {
  return inheritedModelRefsByField.get(`${parentName}.${fieldName}`) ?? [];
}

/** Forget every inherited reference recorded so far: a new document is being read. */
export function resetInheritedModelRefs(): void {
  inheritedModelRefsByField.clear();
}

function recordInheritedModelRefs(type: TypeRef, parentName: string, fieldName: string): void {
  const key = `${parentName}.${fieldName}`;
  walkTypeRef(type, {
    model: (ref) => {
      if (isComponentModelRef(ref)) return;
      inheritedModelRefs.add(ref);
      const refs = inheritedModelRefsByField.get(key) ?? [];
      refs.push(ref);
      inheritedModelRefsByField.set(key, refs);
    },
  });
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

    // A field expressed via `allOf`. Mirror the four outcomes of the allOf
    // branch in `schemaToTypeRef` exactly:
    //  - a `$ref` member plus an inline object member: the field is typed as
    //    the augmentation model `<Parent><Field>`; merge the referenced
    //    component(s) and the inline members into that model
    //    (`mergeAugmentation`), with every inherited property typed under
    //    its component — `Base.meta` stays `BaseMeta`, a self-reference
    //    `Base.child` stays `BaseChild` — and only the inline members' own
    //    properties qualified under the merged model and recursed into. The
    //    component pass already materialized whatever the inherited
    //    properties reference, so nothing is duplicated; a component that
    //    extends itself through a field simply points back at a model that
    //    exists, and a component reused by several nested augmentations
    //    hands each of them its full field list;
    //  - `$ref` members only: a plain reference to the first component,
    //    nothing to materialize;
    //  - a single non-`$ref` member: unwrapped and typed as the field itself,
    //    so re-enter with it as the field (same siblings);
    //  - several inline members with properties: one merged model.
    if (kind === 'allOf' && fieldSchema.allOf) {
      const members = fieldSchema.allOf;
      const emitMerged = (): void => {
        const merged = mergeAugmentation(fieldSchema, componentSchemas);
        if (merged.properties.length === 0) return;
        const modelName = qualifyInlineModelName(toPascalCase(fieldName), parentName);
        results.push(buildMergedModel(modelName, merged, componentSchemas));
        const own: Record<string, SchemaObject> = {};
        for (const p of merged.properties) if (p.origin === null) own[p.name] = p.schema;
        const mergedSiblings = new Map(merged.properties.map((p) => [p.name, p.schema]));
        extractInlineModelsFromProperties({ properties: own }, results, modelName, componentSchemas, mergedSiblings);
      };
      const only = members.length === 1 ? members[0] : undefined;
      if (members.some((m) => m.$ref)) {
        if (members.some((m) => !m.$ref && (m.properties || m.type === 'object'))) emitMerged();
      } else if (only) {
        // The wrapper's own keywords, conjoined with the member's, are the
        // field's limits (see extractConstraints), so they ride along with the
        // unwrapped member and its model carries the same constraints. Its
        // `deprecated` is the wrapper's alone, as `Field.deprecated` reads it,
        // and its link is the wrapper's too, when the wrapper has one.
        extractInlineModelsFromProperties(
          {
            properties: {
              [fieldName]: withWrapperExternalDocs(
                withWrapperDeprecation({ ...only, ...extractConstraints(fieldSchema) }, fieldSchema),
                fieldSchema,
              ),
            },
          },
          results,
          parentName,
          componentSchemas,
          siblings,
          reservedNames,
        );
      } else if (members.some((m) => m.properties)) {
        emitMerged();
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
            warnOnVariantNameClash(existing, variant, variantName, parentName, componentSchemas);
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
 * merge, a variant), and the one the variant would have produced — by
 * `modelFingerprint`, the shape every clash check in the parser reads, so an
 * ordinary object of exactly the variant's shape shares the name silently,
 * as a sibling variant of the identical shape does. Once per variant, since
 * each is visited once.
 */
function warnOnVariantNameClash(
  existing: Model,
  variant: SchemaObject,
  variantName: string,
  parentName: string | undefined,
  componentSchemas: Record<string, SchemaObject> | undefined,
): void {
  const candidate = buildInlineModel(variantName, variant, componentSchemas);
  if (modelFingerprint(existing) === modelFingerprint(candidate)) return;
  const fieldList = (model: Model): string => model.fields.map((f) => f.name).join(', ') || '(no fields)';
  const site = parentName ? ` under ${parentName}` : '';
  console.warn(
    `[oagen] Warning: Inline model "${variantName}" is minted twice with different shapes${site} ` +
      `(fields: ${fieldList(existing)} | ${fieldList(candidate)}) ` +
      `— keeping the first; the second union's reference resolves to it`,
  );
}

/** One property of a merged `allOf` field and the component it is inherited from (null: an inline member's own). */
interface MergedProperty {
  name: string;
  schema: SchemaObject;
  origin: { name: string; schema: SchemaObject } | null;
}

interface MergedAllOf {
  properties: MergedProperty[];
  required: string[];
  description: string | undefined;
  /** The wrapper's own link, read like its description. */
  externalDocs: ExternalDocs | undefined;
  /** The wrapper's own limits conjoined with its inline members' (a `$ref` member contributes only its sibling keywords). */
  constraints: Constraints | undefined;
  /** `true` when the wrapper itself says `deprecated: true`; a member's flag is not read (a `$ref` member's stays on its model). */
  deprecated: boolean | undefined;
}

/**
 * Merge an `allOf` field into one object shape, remembering where each
 * property comes from. A `$ref` member is resolved against `componentSchemas`
 * by its component name, as `extractAllOfModel` does, and contributes its
 * properties — its own nested `allOf` chain included — tagged with that
 * component's model name, so the merged model can type them exactly as the
 * component's own model does; inline members contribute properties tagged as
 * the merged model's own. `required` is collected from every member. Earlier
 * members win on key conflicts, matching the merge order used elsewhere in
 * the parser; an unresolvable ref contributes nothing. The walk reads the
 * components' property lists only — it never descends into a property — so
 * it is finite for any component graph (the `seen` set only short-circuits a
 * component reached twice within one merge).
 */
function mergeAugmentation(
  schema: SchemaObject,
  componentSchemas: Record<string, SchemaObject> | undefined,
): MergedAllOf {
  const properties: MergedProperty[] = [];
  const seenNames = new Set<string>();
  const required: string[] = [];
  const seen = new Set<SchemaObject>();
  const visit = (s: SchemaObject, origin: MergedProperty['origin']): void => {
    if (seen.has(s)) return;
    seen.add(s);
    if (s.$ref) {
      const rawName = s.$ref.split('/').pop() ?? '';
      const target = componentSchemas?.[rawName];
      if (!target) return;
      // A ref inside a component's own allOf chain stays that component's;
      // a top-level ref member is the component the properties belong to.
      visit(target, origin ?? { name: resolveSchemaName(rawName), schema: target });
      return;
    }
    for (const [key, value] of Object.entries(s.properties ?? {})) {
      if (!value || seenNames.has(key)) continue;
      seenNames.add(key);
      properties.push({ name: key, schema: value, origin });
    }
    if (s.required) required.push(...s.required);
    for (const sub of s.allOf ?? []) visit(sub, origin);
  };
  visit(schema, null);
  // Limits conjoin the way properties merge, so the merged model declares what
  // an instance must satisfy; a `$ref` member's target keeps its own limits.
  return {
    properties,
    required,
    description: schema.description,
    externalDocs: readExternalDocs(schema.externalDocs),
    constraints: extractConstraints(schema),
    deprecated: schema.deprecated === true || undefined,
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
  };
}
