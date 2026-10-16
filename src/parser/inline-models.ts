import type { Constraints, Model, Field } from '../ir/types.js';
import { toPascalCase, stripListItemMarkers, singularize } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import {
  buildFieldFromSchema,
  constraintsEntry,
  extractConstraints,
  isInlineObjectSchema,
  resolveSchemaName,
  variantMemberSchemas,
} from './schemas.js';

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
 * The inline model or enum name `schemaToTypeRef` would mint for `schema`
 * typed under `contextName` with `parentModelName`, or null when it mints
 * none (a `$ref`, a primitive, an array or map of those). Mirrors the naming
 * branches of `schemaToTypeRef`: an inline object in any form it recognises
 * (`properties`, an `allOf` with object members, a `oneOf`/`anyOf` with an
 * inline object variant) takes `qualifyInlineModelName`; an inline enum, or
 * a `oneOf` of string consts that collapses into one, takes the parent-
 * prefixed enum name, which is never singularized; an array or map claims
 * whatever its items or values would.
 */
export function mintedInlineName(
  contextName: string,
  schema: SchemaObject,
  parentModelName: string | undefined,
): string | null {
  const s = unwrapNullableSchema(schema);
  if (s.$ref) return null;
  const base = toPascalCase(contextName);
  const modelName = (): string => qualifyInlineModelName(base, parentModelName);
  const enumName = (): string => {
    const cleanParent = parentModelName ? stripListItemMarkers(parentModelName) : undefined;
    return cleanParent && !base.startsWith(cleanParent) ? `${cleanParent}${base}` : base;
  };
  if (s.allOf) {
    const only = s.allOf.length === 1 ? s.allOf[0] : undefined;
    if (only) return mintedInlineName(contextName, only, parentModelName);
    return s.allOf.some((m) => !m.$ref && (m.properties || m.type === 'object')) ? modelName() : null;
  }
  const variants = s.oneOf ?? s.anyOf;
  if (variants) {
    const nonNull = variants.filter((v) => !isNullSchema(v));
    if (nonNull.length >= 2 && nonNull.every((v) => typeof v.const === 'string')) return enumName();
    return nonNull.some((v) => isInlineObjectSchema(v)) ? modelName() : null;
  }
  if (s.const !== undefined) return null;
  if ((s.enum ?? []).filter((v) => v !== null).length >= 2) return enumName();
  // A plain boolean: the type guard would otherwise narrow `s` to `never` below.
  const inlineObject: boolean = isInlineObjectSchema(s);
  if (inlineObject) return modelName();
  if (s.items && (s.type === 'array' || !s.type)) return mintedInlineName(contextName, s.items, parentModelName);
  if (s.type === 'object' && !s.properties) {
    const value = mapValueSchema(s);
    return value ? mintedInlineName(contextName, value, parentModelName) : null;
  }
  return null;
}

/** Documentation keywords that do not shape a model; ignored by `schemaShapeKey` at a schema's own level. */
const DOC_KEYWORDS = new Set(['description', 'title', 'example', 'examples', 'summary', 'externalDocs', 'deprecated']);
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

/**
 * The context name an array field's items (`kind: 'item'`) or a map field's
 * values (`kind: 'value'`) are typed and extracted under. By default it is
 * the field itself, so the inline model is the parent plus the singularized
 * field (`layers` on `Drawing` → `DrawingLayer`).
 *
 * When a sibling property of the same object would mint that very name —
 * `layer` as an inline object, an inline enum, an inline union with object
 * variants, or an array or map of such (`mintedInlineName`); a primitive
 * `email` beside `emails` claims nothing — the elements step aside to
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
  if (!siblings) return fieldName;
  const own = mintedInlineName(fieldName, elementSchema, parentModelName);
  if (own === null) return fieldName;

  // Every inline name the other siblings mint, with the schemas minting it.
  const claimed = new Map<string, SchemaObject[]>();
  for (const [siblingName, siblingSchema] of siblings) {
    if (siblingName === fieldName) continue;
    const minted = mintedInlineName(siblingName, siblingSchema, parentModelName);
    if (minted === null) continue;
    claimed.set(minted, [...(claimed.get(minted) ?? []), siblingSchema]);
  }

  const rivals = claimed.get(own);
  if (!rivals) return fieldName;
  const element = unwrapNullableSchema(elementSchema);
  const identical = (rival: SchemaObject): boolean => {
    const sibling = unwrapNullableSchema(rival);
    return (
      isInlineObjectSchema(sibling) &&
      isInlineObjectSchema(element) &&
      schemaShapeKey(sibling) === schemaShapeKey(element)
    );
  };
  if (rivals.every(identical)) return fieldName; // same shape: share the singular name

  const fallback = kind === 'item' ? 'array_item' : 'member_value';
  for (let i = 0; ; i++) {
    const candidate =
      i === 0 ? `${fieldName}_${kind}` : i === 1 ? `${fieldName}_${fallback}` : `${fieldName}_${fallback}${i}`;
    const minted = mintedInlineName(candidate, elementSchema, parentModelName);
    if (minted === null || !claimed.has(minted)) return candidate;
  }
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
export function extractInlineModelsFromSchemas(schemas: Record<string, SchemaObject> | undefined): Model[] {
  if (!schemas) return [];

  const inlineModels: Model[] = [];

  for (const [schemaName, schema] of Object.entries(schemas)) {
    const parentName = resolveSchemaName(schemaName);
    // The same sibling set `extractModel` / `extractAllOfModel` type the
    // component's fields from, `$ref`'d allOf members included.
    extractInlineModelsFromProperties(schema, inlineModels, parentName, schemas, collectProperties(schema, schemas));
  }

  return inlineModels;
}

/**
 * Walk a schema's properties and materialise every inline object as a model.
 * `componentSchemas` is optional and only feeds `buildFieldFromSchema`, so a
 * field that `$ref`s a component can take its `example`/`examples` from it;
 * callers without the component map at hand simply omit it.
 * `siblingProperties` is the parent object's full property set, for callers
 * that see more of it than this schema shows (see `elementContextName`).
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
): void {
  const properties = schema.properties ?? {};
  const allOfSchemas = schema.allOf ?? [];
  // Every property the parent object exposes, so array items and map values
  // can step aside from a sibling that would mint their name (see
  // `elementContextName`). A caller that sees more siblings than this schema
  // shows — an `allOf` member, an envelope field — passes them in.
  const siblings = siblingProperties ?? collectProperties(schema);

  for (const sub of allOfSchemas) {
    if (sub.properties) {
      extractInlineModelsFromProperties(sub, results, parentName, componentSchemas, siblings);
    }
  }

  for (const [fieldName, rawFieldSchema] of Object.entries(properties)) {
    if (!rawFieldSchema) continue;
    // Dispatch on the shape `schemaToTypeRef` named: it strips nullable
    // wrappers before deciding whether a field is an object, array, or map,
    // so a nullable field must be unwrapped here the same way or its inline
    // object / array items / map values are referenced but never extracted.
    const fieldSchema = unwrapNullableField(rawFieldSchema);
    // Direct inline object with properties (with or without explicit type: 'object',
    // including the nullable `type: ['object', 'null']` form)
    if (isInlineObjectSchema(fieldSchema)) {
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
    if (fieldSchema.type === 'array' && fieldSchema.items) {
      const itemContext = elementContextName(fieldName, 'item', siblings, parentName, fieldSchema.items);
      extractInlineModelsFromProperties(
        { properties: { [itemContext]: fieldSchema.items } },
        results,
        parentName,
        componentSchemas,
      );
    }

    // Map (`additionalProperties` / `patternProperties` on a property-less
    // object): schemaToTypeRef types the values the same way it types array
    // items, so a map of inline objects references `${Parent}${SingularField}`
    // (`layers` on `CreateDrawingRequest` → `CreateDrawingRequestLayer`), or
    // `<Parent><Field>Value` when a sibling takes the singular name. Re-enter
    // with the value schema as a synthetic property of that name.
    if (fieldSchema.type === 'object' && !fieldSchema.properties) {
      const valueSchema = mapValueSchema(fieldSchema);
      if (valueSchema) {
        const valueContext = elementContextName(fieldName, 'value', siblings, parentName, valueSchema);
        extractInlineModelsFromProperties(
          { properties: { [valueContext]: valueSchema } },
          results,
          parentName,
          componentSchemas,
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
    if (fieldSchema.allOf) {
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
        // unwrapped member and its model carries the same constraints.
        extractInlineModelsFromProperties(
          { properties: { [fieldName]: { ...only, ...extractConstraints(fieldSchema) } } },
          results,
          parentName,
          componentSchemas,
          siblings,
        );
      } else if (members.some((m) => m.properties)) {
        emitMerged();
      }
    }

    // oneOf/anyOf containing objects — extract every inline object variant as a
    // model so each gets its own typed class. Variant 0 keeps the bare
    // qualified inline name (e.g. `ApiKeyCreatedDataOwner`); subsequent
    // variants are prefixed by their const-discriminator value via
    // `nameOneOfVariant` (e.g. `UserApiKeyCreatedDataOwner`). When the
    // oneOf doesn't have a const-discriminator (single object variant + null
    // for nullable, or single object variant only), only variant 0 is
    // extracted and the bare name pattern preserves backward compat.
    const unionVariants = fieldSchema.oneOf ?? fieldSchema.anyOf;
    if (unionVariants) {
      const inlineObjectVariants = unionVariants.filter((v) => isInlineObjectSchema(v));
      if (inlineObjectVariants.length > 0) {
        const baseName = toPascalCase(fieldName);
        const modelName = qualifyInlineModelName(baseName, parentName);
        const existingNames = new Set(results.map((r) => r.name));
        const namingDiscProp = deriveOneOfNamingDiscriminator(inlineObjectVariants);
        const emittedNames: string[] = [];
        for (const variant of inlineObjectVariants) {
          const variantName = nameOneOfVariant(variant, modelName, emittedNames, namingDiscProp);
          emittedNames.push(variantName);
          if (!existingNames.has(variantName)) {
            existingNames.add(variantName);
            results.push(buildInlineModel(variantName, variant, componentSchemas));
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
      }
    }
  }
}

/** Find a single string-const-valued property shared by every variant whose
 *  values are all distinct — the implicit discriminator. Returns null when no
 *  such property exists. Mirrors `deriveConstNamingDiscriminator` in schemas.ts. */
function deriveOneOfNamingDiscriminator(variants: SchemaObject[]): string | null {
  if (variants.length < 2) return null;
  const candidates = Object.keys(variants[0]?.properties ?? {});
  for (const propName of candidates) {
    const values = variants.map((v) => readConstString(v.properties?.[propName]));
    if (values.some((v) => v === null)) continue;
    if (new Set(values).size !== values.length) continue;
    return propName;
  }
  return null;
}

function readConstString(prop: SchemaObject | undefined): string | null {
  if (!prop) return null;
  if (typeof prop.const === 'string') return prop.const;
  if (Array.isArray(prop.enum) && prop.enum.length === 1 && typeof prop.enum[0] === 'string') {
    return prop.enum[0];
  }
  return null;
}

/** Produce a per-variant model name. Variant 0 keeps the bare parent name;
 *  later variants are prefixed by the const-derived label. Mirrors
 *  `nameVariantModel` in schemas.ts. Falls back to a numeric suffix when no
 *  discriminator is available, the const value PascalCases to nothing, or
 *  the derived candidate collides with the parent or an already-emitted name. */
function nameOneOfVariant(
  variant: SchemaObject,
  parentName: string,
  alreadyEmitted: string[],
  discriminatorProperty: string | null,
): string {
  if (alreadyEmitted.length === 0) return parentName;
  if (discriminatorProperty) {
    const constValue = readConstString(variant.properties?.[discriminatorProperty]);
    if (constValue) {
      const prefix = toPascalCase(constValue);
      if (prefix) {
        const candidate = parentName.startsWith(prefix) ? parentName : `${prefix}${parentName}`;
        const collision = candidate === parentName || alreadyEmitted.includes(candidate);
        if (!collision) return candidate;
      }
    }
  }
  return `${parentName}${alreadyEmitted.length + 1}`;
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
  /** The wrapper's own limits conjoined with its inline members' (a `$ref` member contributes only its sibling keywords). */
  constraints: Constraints | undefined;
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
  return { properties, required, description: schema.description, constraints: extractConstraints(schema) };
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
    return buildFieldFromSchema(p.name, p.schema, p.origin.name, requiredSet, componentSchemas, siblings);
  });
  return {
    name,
    description: merged.description,
    fields,
    ...(merged.constraints ? { constraints: merged.constraints } : {}),
  };
}

/**
 * Strip the nullable wrappers `schemaToTypeRef` unwraps before it names
 * anything — the OAS 3.1 `type: [X, 'null']` array, the OAS 3.0
 * `nullable: true` flag, and a `oneOf`/`anyOf` with a single non-null
 * variant — so extraction dispatches on the same shape the TypeRef was built
 * from. The unwrap keeps `contextName`/`parentModelName` semantics intact:
 * `schemaToTypeRef` passes both through each of these wrappers unchanged.
 */
function unwrapNullableSchema(schema: SchemaObject): SchemaObject {
  if (schema.$ref) return schema;
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((t) => t !== 'null');
    if (nonNullTypes.length !== 1) return schema;
    return unwrapNullableSchema({ ...schema, type: nonNullTypes[0], nullable: false });
  }
  if (schema.nullable && schema.type) {
    return unwrapNullableSchema({ ...schema, nullable: false });
  }
  // `allOf` takes precedence over `oneOf`/`anyOf` in schemaToTypeRef, so only
  // a bare union is a nullable wrapper candidate.
  const variants = schema.allOf ? undefined : (schema.oneOf ?? schema.anyOf);
  if (variants) {
    const nullVariant = variants.find(isNullSchema);
    const nonNullVariants = variants.filter((v) => v !== nullVariant);
    const only = nonNullVariants[0];
    if (nullVariant && nonNullVariants.length === 1 && only) {
      return unwrapNullableSchema(only);
    }
  }
  return schema;
}

/**
 * `unwrapNullableSchema` for a field, carrying the wrapper's limits onto the
 * branch it unwraps to. The type-array and `nullable: true` forms unwrap by
 * spreading, so every keyword survives; the union form swaps in the bare
 * branch, which would drop a `minProperties` written beside
 * `anyOf: [{ type: 'object', … }, { type: 'null' }]`. `extractConstraints`
 * conjoins that wrapper's own keywords with its branch's as the field's
 * limits, so the model built from the branch must carry the same ones or
 * `Model.constraints` would omit what the field declares.
 */
function unwrapNullableField(schema: SchemaObject): SchemaObject {
  const inner = unwrapNullableSchema(schema);
  if (inner === schema || schema.allOf || !(schema.oneOf ?? schema.anyOf)) return inner;
  return { ...inner, ...extractConstraints(schema) };
}

/** The `{ type: 'null' }` member that marks a `oneOf`/`anyOf` as nullable — same test as schemaToTypeRef. */
function isNullSchema(schema: SchemaObject): boolean {
  return (
    schema.type === 'null' || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === 'null')
  );
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

function buildInlineModel(name: string, schema: SchemaObject, componentSchemas?: Record<string, SchemaObject>): Model {
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];
  const siblings = collectProperties(schema);

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet, componentSchemas, siblings));
  }

  return { name, description: schema.description, fields, ...constraintsEntry(schema) };
}
