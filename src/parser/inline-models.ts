import type { Model, Field } from '../ir/types.js';
import { toPascalCase, stripListItemMarkers, singularize } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { buildFieldFromSchema, isInlineObjectSchema, resolveSchemaName, variantMemberSchemas } from './schemas.js';

/**
 * Qualify an inline model name with the parent schema name.
 * If `parentName` is provided and the field name doesn't already start with
 * the parent, the result is `${parentName}${PascalField}` with the trailing
 * word singularized (e.g., Connection + Domains → ConnectionDomain).
 */
export function qualifyInlineModelName(baseName: string, parentName?: string): string {
  if (!parentName) return baseName;
  // Strip ListItem/ByExternalId markers from parent name so inline model names
  // are clean and match the names produced by qualifyNestedName() in responses.ts.
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

/**
 * A canonical rendering of a schema's shape, for deciding whether two inline
 * schemas describe the same model: every structural keyword (`type`,
 * `properties`, `required`, `items`, `additionalProperties`,
 * `patternProperties`, `allOf`/`oneOf`/`anyOf`, `enum`, `const`, `format`,
 * `nullable`, ...) recursively, with object keys sorted and the `required`
 * and `type` lists order-insensitive. Documentation (`description`, `title`,
 * `example`, `examples`, `summary`, `externalDocs`, `deprecated`) and vendor
 * extensions (`x-*`) are ignored, and so is `nullable: false`, which the
 * nullable unwrap leaves behind. Enum values keep their order, as the IR
 * does.
 */
export function schemaShapeKey(schema: SchemaObject): string {
  const ignored = new Set(['description', 'title', 'example', 'examples', 'summary', 'externalDocs', 'deprecated']);
  const canon = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) {
      const items = value.map((v) => canon(v));
      return key === 'required' || key === 'type' ? items.map(String).sort() : items;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(record).sort()) {
        if (ignored.has(k) || k.startsWith('x-')) continue;
        if (k === 'nullable' && record[k] === false) continue;
        out[k] = canon(record[k], k);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(canon(schema));
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
 * matching the `<Variant>Item` convention.
 *
 * Identical-shape sharing: when the claiming sibling is an inline object
 * whose shape is structurally identical to the items or values
 * (`schemaShapeKey`: same properties, required, types, nested inline schemas
 * and enum values; description, title and example ignored), the two fields
 * share one model under the singular name. They are the same shape, so one
 * model is the right SDK type and a duplicate would only add noise; should a
 * later spec version make the shapes diverge, the split happens then, which
 * is the moment the item type genuinely changes. This deliberately departs
 * from a literal one-model-per-field reading for the identical case.
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
  const element = unwrapNullableSchema(elementSchema);
  for (const [siblingName, siblingSchema] of siblings) {
    if (siblingName === fieldName) continue;
    if (mintedInlineName(siblingName, siblingSchema, parentModelName) !== own) continue;
    const sibling = unwrapNullableSchema(siblingSchema);
    if (
      isInlineObjectSchema(sibling) &&
      isInlineObjectSchema(element) &&
      schemaShapeKey(sibling) === schemaShapeKey(element)
    ) {
      continue; // same shape: share the singular name
    }
    return `${fieldName}_${kind}`;
  }
  return fieldName;
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
    extractInlineModelsFromProperties(schema, inlineModels, parentName, collectProperties(schema, schemas));
  }

  return inlineModels;
}

export function extractInlineModelsFromProperties(
  schema: SchemaObject,
  results: Model[],
  parentName?: string,
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
      extractInlineModelsFromProperties(sub, results, parentName, siblings);
    }
  }

  for (const [fieldName, rawFieldSchema] of Object.entries(properties)) {
    if (!rawFieldSchema) continue;
    // Dispatch on the shape `schemaToTypeRef` named: it strips nullable
    // wrappers before deciding whether a field is an object, array, or map,
    // so a nullable field must be unwrapped here the same way or its inline
    // object / array items / map values are referenced but never extracted.
    const fieldSchema = unwrapNullableSchema(rawFieldSchema);
    // Direct inline object with properties (with or without explicit type: 'object',
    // including the nullable `type: ['object', 'null']` form)
    if (isInlineObjectSchema(fieldSchema)) {
      const baseName = toPascalCase(fieldName);
      const modelName = qualifyInlineModelName(baseName, parentName);
      results.push(buildInlineModel(modelName, fieldSchema));
      extractInlineModelsFromProperties(fieldSchema, results, modelName);
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
      extractInlineModelsFromProperties({ properties: { [itemContext]: fieldSchema.items } }, results, parentName);
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
        extractInlineModelsFromProperties({ properties: { [valueContext]: valueSchema } }, results, parentName);
      }
    }

    // Inline object expressed via `allOf` (no $ref / oneOf / anyOf members).
    // schemaToTypeRef collapses such a field into a single merged model ref, so
    // materialize that model — otherwise the ref dangles exactly like a direct
    // inline object would. An `allOf` containing a `$ref` is the augmentation
    // case resolved through the ref path and is intentionally left alone here.
    if (fieldSchema.allOf && fieldSchema.allOf.every((s) => !s.$ref && !s.oneOf && !s.anyOf)) {
      const merged = mergeAllOfObjectSchema(fieldSchema);
      if (Object.keys(merged.properties ?? {}).length > 0) {
        const baseName = toPascalCase(fieldName);
        const modelName = qualifyInlineModelName(baseName, parentName);
        results.push(buildInlineModel(modelName, merged));
        extractInlineModelsFromProperties(merged, results, modelName);
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
            results.push(buildInlineModel(variantName, variant));
            extractInlineModelsFromProperties(variant, results, variantName);
            // A multi-type variant (`type: ['object', 'array']`) types the
            // items of its array member under the variant's name
            // (`<Variant>Item`, see `variantMemberSchemas`); re-enter with
            // them as a same-named synthetic property so the models line up.
            extractInlineModelsFromProperties(
              { properties: variantMemberSchemas(variant, variantName) },
              results,
              variantName,
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

/**
 * Merge the object members of an `allOf` (recursively) into a single
 * object-shaped schema, so an inline object expressed via `allOf` can be
 * materialized as one model — mirroring how schemaToTypeRef collapses such a
 * field into a single merged model ref. Earlier members win on key conflicts,
 * matching the merge order used elsewhere in the parser.
 */
function mergeAllOfObjectSchema(schema: SchemaObject): SchemaObject {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];
  const visit = (s: SchemaObject): void => {
    if (s.properties) {
      for (const [key, value] of Object.entries(s.properties)) {
        if (value && !(key in properties)) properties[key] = value;
      }
    }
    if (s.required) required.push(...s.required);
    if (s.allOf) for (const sub of s.allOf) visit(sub);
  };
  visit(schema);
  return { type: 'object', properties, required, description: schema.description };
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

function buildInlineModel(name: string, schema: SchemaObject): Model {
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];
  const siblings = collectProperties(schema);

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet, siblings));
  }

  return { name, description: schema.description, fields };
}
