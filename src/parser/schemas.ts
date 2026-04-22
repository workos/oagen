import type { Model, Enum, EnumValue, Field, TypeRef } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import { toPascalCase, toUpperSnakeCase, cleanSchemaName, singularize, stripListItemMarkers } from '../utils/naming.js';

/**
 * Module-level transform set during extractSchemas(). Used by schemaToTypeRef()
 * to apply the same name transform to $ref model/enum references.
 */
let activeSchemaNameTransform: ((name: string) => string) | null = null;

/** Apply cleanSchemaName + the active transform (if any) to a raw schema name. */
function resolveSchemaName(rawName: string): string {
  let name = cleanSchemaName(toPascalCase(rawName));
  if (activeSchemaNameTransform) name = activeSchemaNameTransform(name);
  return name;
}

export interface SchemaExtractionOptions {
  schemaNameTransform?: (name: string) => string;
}

export interface SchemaObject {
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject | undefined>;
  required?: string[];
  items?: SchemaObject;
  enum?: (string | number)[];
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
  [key: string]: unknown;
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

  if (!schemas) return { models: [], enums };

  // Build collision-safe transform if provided
  if (options?.schemaNameTransform) {
    const transform = options.schemaNameTransform;
    const rawNames = Object.keys(schemas);
    const cleanedNames = rawNames.map((n) => cleanSchemaName(toPascalCase(n)));
    const transformedToOriginals = new Map<string, string[]>();
    for (const cleaned of cleanedNames) {
      const transformed = transform(cleaned);
      if (!transformedToOriginals.has(transformed)) transformedToOriginals.set(transformed, []);
      transformedToOriginals.get(transformed)!.push(cleaned);
    }
    const unsafeToTransform = new Set<string>();
    for (const [, originals] of transformedToOriginals) {
      if (originals.length > 1) {
        for (const n of originals) unsafeToTransform.add(n);
      }
    }
    activeSchemaNameTransform = (name: string) => (unsafeToTransform.has(name) ? name : transform(name));
  } else {
    activeSchemaNameTransform = null;
  }

  const modelsByCleanName = new Map<string, Model>();

  for (const [name, schema] of Object.entries(schemas)) {
    const pascalName = resolveSchemaName(name);

    if (schema.enum) {
      enums.push(extractEnum(pascalName, schema));
    } else {
      const model = extractModel(pascalName, schema, schemas);
      const existing = modelsByCleanName.get(pascalName);
      if (existing) {
        // Keep the model with more fields when names collide after cleaning
        if (model.fields.length > existing.fields.length) {
          modelsByCleanName.set(pascalName, model);
        }
      } else {
        modelsByCleanName.set(pascalName, model);
      }

      for (const inlineModel of extractDiscriminatedAllOfVariantModels(schema, pascalName)) {
        const existingInline = modelsByCleanName.get(inlineModel.name);
        if (existingInline) {
          if (inlineModel.fields.length > existingInline.fields.length) {
            modelsByCleanName.set(inlineModel.name, inlineModel);
          }
        } else {
          modelsByCleanName.set(inlineModel.name, inlineModel);
        }
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

  // Collect inline enums from model fields
  for (const model of models) {
    collectInlineEnums(model.fields, enums);
  }

  // NOTE: activeSchemaNameTransform is intentionally NOT cleared here.
  // extractOperations() calls schemaToTypeRef() for $ref resolution and
  // needs the same transform active. parseSpec() calls clearSchemaNameTransform()
  // after all extraction is complete.
  return { models, enums };
}

/** Clear the module-level schemaNameTransform. Called by parseSpec() after all extraction phases. */
export function clearSchemaNameTransform(): void {
  activeSchemaNameTransform = null;
}

/**
 * Walk a single TypeRef and extract inline enum refs as top-level enum definitions.
 * Shared by both schemas.ts (field-level) and parse.ts (model-level) collection passes.
 */
export function collectInlineEnumFromRef(ref: TypeRef, enums: Enum[], seen: Set<string>): void {
  walkTypeRef(ref, {
    enum: (r) => {
      if (r.values && !seen.has(r.name)) {
        seen.add(r.name);
        enums.push({
          name: r.name,
          values: r.values.map((v) => ({
            name: toUpperSnakeCase(String(v)),
            value: v,
            description: undefined,
          })),
        });
      }
    },
  });
}

/**
 * Walk model fields and extract inline enum refs as top-level enum definitions.
 * This ensures type alias files are generated for inline enums.
 */
function collectInlineEnums(fields: Field[], enums: Enum[]): void {
  const seen = new Set(enums.map((e) => e.name));
  for (const field of fields) {
    collectInlineEnumFromRef(field.type, enums, seen);
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
  walkTypeRef(ref, {
    model: (modelRef) => {
      if (modelNames.has(modelRef.name)) return; // already extracted
      // Check if this model name corresponds to a component schema
      // by checking all possible original names that would map to this PascalCase name
      const isComponent = Object.keys(schemas).some((k) => resolveSchemaName(k) === modelRef.name);
      if (isComponent) return; // will be extracted from components

      // This is a reference to a nested inline model that wasn't extracted.
      // Look up the field schema in the parent model's component schema to extract it.
      const parentSchema = findSchemaByName(parentModelName, schemas);
      if (!parentSchema) return;

      const fieldSchema = findNestedFieldSchema(fieldName, parentSchema, schemas);
      if (!fieldSchema) return;

      // Extract inline models from the field schema
      const extracted = extractNestedSchema(modelRef.name, fieldSchema);
      for (const m of extracted) {
        if (!modelNames.has(m.name)) {
          models.push(m);
          modelNames.add(m.name);
          queue.push(m); // re-scan for deeper nesting
        }
      }
    },
  });
}

/** Find a component schema by PascalCase name. */
function findSchemaByName(pascalName: string, schemas: Record<string, SchemaObject>): SchemaObject | null {
  for (const [k, v] of Object.entries(schemas)) {
    if (resolveSchemaName(k) === pascalName) return v;
  }
  return null;
}

/** Walk into a schema to find a field's sub-schema, resolving allOf and oneOf/anyOf. */
function findNestedFieldSchema(
  fieldName: string,
  parentSchema: SchemaObject,
  schemas: Record<string, SchemaObject>,
): SchemaObject | null {
  if (parentSchema.properties?.[fieldName]) {
    return parentSchema.properties[fieldName]!;
  }
  if (parentSchema.allOf) {
    for (const sub of parentSchema.allOf) {
      let resolved = sub;
      if (sub.$ref) {
        const segments = sub.$ref.split('/');
        const refName = segments[segments.length - 1];
        if (refName && schemas[refName]) resolved = schemas[refName];
      }
      if (resolved.properties?.[fieldName]) {
        return resolved.properties[fieldName]!;
      }
    }
  }
  // Also check inside oneOf/anyOf variants (pure oneOf schemas flatten variant
  // properties into the model, so the field may live inside a variant).
  for (const variant of [...(parentSchema.oneOf ?? []), ...(parentSchema.anyOf ?? [])]) {
    let resolved = variant;
    if (variant.$ref) {
      const segments = variant.$ref.split('/');
      const refName = segments[segments.length - 1];
      if (refName && schemas[refName]) resolved = schemas[refName];
    }
    if (resolved.properties?.[fieldName]) {
      return resolved.properties[fieldName]!;
    }
  }
  return null;
}

/** Extract a model (and nested models) from an inline field schema. */
function extractNestedSchema(name: string, schema: SchemaObject): Model[] {
  // Handle oneOf: extract each object variant as its own model
  if (schema.oneOf) {
    const models: Model[] = [];
    for (const variant of schema.oneOf) {
      if (variant.$ref) continue;
      if (variant.properties && (variant.type === 'object' || !variant.type)) {
        const requiredSet = new Set(variant.required ?? []);
        const fields: Field[] = [];
        for (const [fn, fs] of Object.entries(variant.properties)) {
          if (!fs) continue;
          fields.push(buildFieldFromSchema(fn, fs, name, requiredSet));
        }
        // Use the name for the first variant, suffix for subsequent
        const variantName = models.length === 0 ? name : `${name}${models.length + 1}`;
        models.push({ name: variantName, description: variant.description, fields });
      }
    }
    return models;
  }

  // Handle direct object
  if (schema.properties && (schema.type === 'object' || !schema.type)) {
    const requiredSet = new Set(schema.required ?? []);
    const fields: Field[] = [];
    for (const [fn, fs] of Object.entries(schema.properties)) {
      if (!fs) continue;
      fields.push(buildFieldFromSchema(fn, fs, name, requiredSet));
    }
    return [{ name, description: schema.description, fields }];
  }

  // Handle array with inline items
  if (schema.type === 'array' && schema.items?.properties) {
    const requiredSet = new Set(schema.items.required ?? []);
    const fields: Field[] = [];
    for (const [fn, fs] of Object.entries(schema.items.properties)) {
      if (!fs) continue;
      fields.push(buildFieldFromSchema(fn, fs, name, requiredSet));
    }
    return [{ name, description: schema.items.description, fields }];
  }

  return [];
}

/** Build a single Field from a schema property entry. Shared across all extraction sites. */
export function buildFieldFromSchema(
  fieldName: string,
  fieldSchema: SchemaObject,
  contextName: string,
  requiredSet: Set<string>,
): Field {
  return {
    name: fieldName,
    type: schemaToTypeRef(fieldSchema, fieldName, contextName),
    required: requiredSet.has(fieldName),
    description: fieldSchema.description,
    readOnly: fieldSchema.readOnly || undefined,
    writeOnly: fieldSchema.writeOnly || undefined,
    deprecated: fieldSchema.deprecated || undefined,
    default: fieldSchema.default,
    example: fieldSchema.example,
  };
}

/**
 * If every non-null oneOf/anyOf variant is a string-valued const, return the
 * list of those const values so the union can collapse into a single enum.
 * Returns null when any variant isn't a pure string-const (model ref,
 * number const, nullable, etc.).
 */
function collectLiteralStringConsts(variants: SchemaObject[]): string[] | null {
  if (variants.length === 0) return null;
  const values: string[] = [];
  for (const v of variants) {
    // A single-element enum is semantically identical to const.
    if (typeof v.const === 'string') {
      values.push(v.const);
      continue;
    }
    if (Array.isArray(v.enum) && v.enum.length === 1 && typeof v.enum[0] === 'string') {
      values.push(v.enum[0]);
      continue;
    }
    return null;
  }
  return values;
}

/** Build an EnumRef the same way the regular enum path does for naming. */
function buildSyntheticEnumRef(
  values: string[],
  contextName: string | undefined,
  parentModelName: string | undefined,
): TypeRef {
  const baseName = toPascalCase(contextName ?? 'UnknownEnum');
  const cleanParent = parentModelName ? stripListItemMarkers(parentModelName) : undefined;
  const qualifiedName = cleanParent && !baseName.startsWith(cleanParent) ? `${cleanParent}${baseName}` : baseName;
  return { kind: 'enum', name: qualifiedName, values };
}

/**
 * Detect an implicit discriminator on an oneOf where every variant is an
 * object schema that pins the same property to a const value. Returns
 * { property, mapping } so the IR can represent the union as discriminated
 * without needing an explicit `discriminator:` key in the spec.
 *
 * Both shapes are supported:
 *   { properties: { event: { const: "x" } }, required: ["event"] }
 *   { properties: { event: { type: "string", enum: ["x"] } } }
 *
 * Returns null when any variant doesn't fit the pattern or when variants
 * disagree on which property carries the discriminator.
 */
function detectConstPropertyDiscriminator(
  variants: SchemaObject[],
): { property: string; mapping: Record<string, string> } | null {
  if (variants.length < 2) return null;

  // Find properties whose const value is present on every variant.
  let candidateProperty: string | null = null;
  const candidates = Object.keys(variants[0]?.properties ?? {});
  for (const propName of candidates) {
    if (variants.every((v) => getConstPropertyValue(v, propName) !== null)) {
      candidateProperty = propName;
      break;
    }
  }

  if (!candidateProperty) return null;

  const mapping: Record<string, string> = {};
  for (const v of variants) {
    const value = getConstPropertyValue(v, candidateProperty);
    if (value === null) return null;
    // Require a $ref or title so we have a concrete model name to map to.
    const variantName = resolveVariantModelName(v);
    if (!variantName) return null;
    mapping[value] = variantName;
  }

  return { property: candidateProperty, mapping };
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

function extractEnum(name: string, schema: SchemaObject): Enum {
  const values: EnumValue[] = (schema.enum ?? []).map((v) => ({
    name: toUpperSnakeCase(String(v)),
    value: typeof v === 'number' ? v : String(v),
    description: undefined,
  }));

  return { name, values };
}
function extractModel(name: string, schema: SchemaObject, schemas?: Record<string, SchemaObject>): Model {
  if (schema.allOf) {
    return extractAllOfModel(name, schema, schemas);
  }

  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet));
  }

  // Pure oneOf/anyOf schemas (no allOf, no properties): merge variant fields
  // as optional. This handles schemas like UpdateOrganizationMembership which
  // is a oneOf with mutually exclusive field groups (role_slug vs role_slugs).
  if (fields.length === 0 && (schema.oneOf || schema.anyOf)) {
    const variants = schema.oneOf ?? schema.anyOf ?? [];
    const emptyRequired = new Set<string>();
    const seenFieldNames = new Set<string>();
    for (const variant of variants) {
      if (!variant.properties) continue;
      for (const [fieldName, fieldSchema] of Object.entries(variant.properties)) {
        if (!fieldSchema || seenFieldNames.has(fieldName)) continue;
        seenFieldNames.add(fieldName);
        fields.push(buildFieldFromSchema(fieldName, fieldSchema as SchemaObject, name, emptyRequired));
      }
    }
  }

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

  return { name, description: schema.description, fields };
}

function extractAllOfModel(name: string, schema: SchemaObject, schemas?: Record<string, SchemaObject>): Model {
  const fields: Field[] = [];
  const requiredSet = new Set<string>();
  let resultDiscriminator: { property: string; mapping: Record<string, string> } | undefined;

  for (const subSchema of schema.allOf ?? []) {
    // Resolve $ref sub-schemas by looking up the referenced component schema
    let resolved = subSchema;
    if (subSchema.$ref && schemas) {
      const segments = subSchema.$ref.split('/');
      const refName = segments[segments.length - 1];
      if (refName && schemas[refName]) {
        resolved = schemas[refName];
      }
    }

    // If the resolved schema is itself an allOf, recursively extract its fields
    if (resolved.allOf) {
      const nested = extractAllOfModel(name, resolved, schemas);
      for (const f of nested.fields) {
        fields.push({ ...f, required: false }); // will be re-set below
        if (f.required) requiredSet.add(f.name);
      }
    } else if (resolved.oneOf || resolved.anyOf) {
      const variants = resolved.oneOf ?? resolved.anyOf ?? [];
      // Detect discriminated union: every variant pins the same property to a
      // distinct const value (e.g. EventSchema where each variant has event: const).
      // When detected, store the discriminator instead of flattening variant fields —
      // the base allOf schema already captures the common fields.
      const discriminatorInfo = detectAllOfVariantDiscriminator(variants, name);
      if (discriminatorInfo) {
        resultDiscriminator = discriminatorInfo;
      } else {
        // Flatten oneOf/anyOf variant fields into the parent model as optional
        // fields. This handles the common allOf + oneOf pattern where the spec
        // uses mutually exclusive variant groups (e.g. password vs password_hash).
        const emptyRequired = new Set<string>();
        const seenFieldNames = new Set(fields.map((f) => f.name));
        for (const variant of variants) {
          if (!variant.properties) continue;
          for (const [fieldName, fieldSchema] of Object.entries(variant.properties)) {
            if (!fieldSchema || seenFieldNames.has(fieldName)) continue;
            seenFieldNames.add(fieldName);
            fields.push(buildFieldFromSchema(fieldName, fieldSchema as SchemaObject, name, emptyRequired));
          }
        }
        // Do NOT add variant-level required to the requiredSet — these fields
        // are optional at the parent level because they come from mutually
        // exclusive branches.
      }
    } else {
      if (resolved.required) {
        for (const r of resolved.required) requiredSet.add(r);
      }
      if (resolved.properties) {
        // Use an empty requiredSet — required flags are set in the final pass below
        const emptyRequired = new Set<string>();
        for (const [fieldName, fieldSchema] of Object.entries(resolved.properties)) {
          if (!fieldSchema) continue;
          fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, emptyRequired));
        }
      }
    }
  }

  // Also collect required from the outer schema
  if (schema.required) {
    for (const r of schema.required) requiredSet.add(r);
  }

  // Set required flags
  for (const f of fields) {
    f.required = requiredSet.has(f.name);
  }

  return {
    name,
    description: schema.description,
    fields,
    ...(resultDiscriminator ? { discriminator: resultDiscriminator } : {}),
  };
}

/**
 * Detect an implicit discriminator on an allOf+oneOf where every variant is an
 * object that pins the same property to a distinct const value. Unlike
 * detectConstPropertyDiscriminator (which requires $ref or title for variant
 * model names), this version derives model names from the const value itself
 * using deriveDiscriminatedVariantName — matching how extractDiscriminatedAllOfVariantModels
 * names those models.
 *
 * Returns null when no discriminator can be reliably detected.
 */
function detectAllOfVariantDiscriminator(
  variants: SchemaObject[],
  fallbackName: string,
): { property: string; mapping: Record<string, string> } | null {
  if (variants.length < 2) return null;

  // Find a property whose const value is present on every variant
  const candidates = Object.keys(variants[0]?.properties ?? {});
  let candidateProperty: string | null = null;
  for (const propName of candidates) {
    if (variants.every((v) => getConstPropertyValue(v, propName) !== null)) {
      candidateProperty = propName;
      break;
    }
  }
  if (!candidateProperty) return null;

  const mapping: Record<string, string> = {};
  const seenModelNames = new Set<string>();
  for (const v of variants) {
    const value = getConstPropertyValue(v, candidateProperty);
    if (value === null) return null;
    const modelName = deriveDiscriminatedVariantName(v, fallbackName);
    // If two variants map to the same model name, the discriminator is ambiguous
    if (seenModelNames.has(modelName)) return null;
    seenModelNames.add(modelName);
    mapping[value] = modelName;
  }

  return { property: candidateProperty, mapping };
}

function extractDiscriminatedAllOfVariantModels(schema: SchemaObject, fallbackName: string): Model[] {
  const models: Model[] = [];
  const seenNames = new Set<string>();

  for (const subSchema of schema.allOf ?? []) {
    for (const variant of subSchema.oneOf ?? []) {
      if (!variant.properties || (variant.type !== undefined && variant.type !== 'object')) continue;

      const variantName = deriveDiscriminatedVariantName(variant, fallbackName);
      for (const model of extractInlineModelDeep(variantName, variant)) {
        if (seenNames.has(model.name)) continue;
        seenNames.add(model.name);
        models.push(model);
      }
    }
  }

  return models;
}

function deriveDiscriminatedVariantName(schema: SchemaObject, fallbackName: string): string {
  if (!schema.properties) return fallbackName;

  const preferred = ['event', 'type', 'object'];
  for (const name of preferred) {
    const field = schema.properties[name];
    if (!field) continue;
    if (typeof field.const === 'string') {
      return toPascalCase(field.const);
    }
    if (field.enum && field.enum.length === 1 && typeof field.enum[0] === 'string') {
      return toPascalCase(field.enum[0]);
    }
  }

  for (const field of Object.values(schema.properties)) {
    if (!field) continue;
    if (typeof field.const === 'string') {
      return toPascalCase(field.const);
    }
    if (field.enum && field.enum.length === 1 && typeof field.enum[0] === 'string') {
      return toPascalCase(field.enum[0]);
    }
  }

  return fallbackName;
}

function extractInlineModelDeep(name: string, schema: SchemaObject): Model[] {
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];
  const properties = schema.properties ?? {};
  const nestedModels: Model[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet));

    if (fieldSchema.type === 'object' && fieldSchema.properties) {
      nestedModels.push(...extractInlineModelDeep(qualifyNestedInlineName(name, fieldName), fieldSchema));
    }

    if (fieldSchema.type === 'array' && fieldSchema.items?.properties) {
      nestedModels.push(...extractInlineModelDeep(qualifyNestedInlineName(name, fieldName), fieldSchema.items));
    }

    if (fieldSchema.allOf) {
      const mergedProperties: Record<string, SchemaObject | undefined> = {};
      const mergedRequired: string[] = [];
      for (const sub of fieldSchema.allOf) {
        if (sub.properties) Object.assign(mergedProperties, sub.properties);
        if (sub.required) mergedRequired.push(...sub.required);
      }
      if (Object.keys(mergedProperties).length > 0) {
        nestedModels.push(
          ...extractInlineModelDeep(qualifyNestedInlineName(name, fieldName), {
            type: 'object',
            properties: mergedProperties,
            required: mergedRequired,
          }),
        );
      }
    }

    if (fieldSchema.oneOf) {
      const objectVariant = fieldSchema.oneOf.find((v) => v.properties && (v.type === 'object' || !v.type));
      if (objectVariant) {
        nestedModels.push(...extractInlineModelDeep(qualifyNestedInlineName(name, fieldName), objectVariant));
      }
    }
  }

  return [{ name, description: schema.description, fields }, ...nestedModels];
}

function qualifyNestedInlineName(parentName: string, fieldName: string): string {
  const pascalField = toPascalCase(fieldName);
  if (pascalField.startsWith(parentName)) return pascalField;

  const cleanParent = stripListItemMarkers(parentName);
  const qualified = `${cleanParent}${pascalField}`;
  const match = qualified.match(/^(.+?)([A-Z][a-z]+s?)$/);
  if (match && match[2]) {
    return match[1] + singularize(match[2]);
  }
  return qualified;
}

export function schemaToTypeRef(schema: SchemaObject, contextName?: string, parentModelName?: string): TypeRef {
  // Handle $ref → ModelRef
  if (schema.$ref) {
    const segments = schema.$ref.split('/');
    const rawName = segments[segments.length - 1];
    return { kind: 'model', name: resolveSchemaName(rawName) };
  }

  // Handle OAS 3.1 nullable type arrays: type: [string, null]
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((t: string) => t !== 'null');
    // type: ['null'] — only null, no real type
    if (nonNullTypes.length === 0) {
      return { kind: 'nullable', inner: { kind: 'primitive', type: 'unknown' } };
    }
    if (schema.type.includes('null') && nonNullTypes.length === 1) {
      return {
        kind: 'nullable',
        inner: schemaToTypeRef({ ...schema, type: nonNullTypes[0], nullable: false }, contextName),
      };
    }
    // Multiple non-null types → union
    if (nonNullTypes.length > 1) {
      const variants = nonNullTypes.map((t: string) => schemaToTypeRef({ ...schema, type: t }, contextName));
      const ref: TypeRef = { kind: 'union', variants };
      if (schema.type.includes('null')) {
        return { kind: 'nullable', inner: ref };
      }
      return ref;
    }
  }

  // Handle OAS 3.0 nullable flag
  if (schema.nullable && schema.type) {
    return {
      kind: 'nullable',
      inner: schemaToTypeRef({ ...schema, nullable: false }, contextName),
    };
  }

  // Handle allOf — merge properties from all sub-schemas.
  // This handles patterns like: allOf: [{ type: object, properties: {...} }, { oneOf: [...] }]
  // which are valid OAS 3.1 but weren't handled for field-level schemas.
  if (schema.allOf) {
    // If allOf contains a $ref, prefer the ref (it's a named type)
    const refItem = schema.allOf.find((s: SchemaObject) => s.$ref);
    if (refItem) {
      // If allOf has $ref AND siblings with properties, return a merged model ref
      // to avoid losing the augmentation properties
      const hasAugmentation = schema.allOf.some((s: SchemaObject) => !s.$ref && (s.properties || s.type === 'object'));
      if (hasAugmentation) {
        const baseName = toPascalCase(contextName ?? 'UnknownModel');
        return { kind: 'model', name: qualifyInlineModelName(baseName, parentModelName) };
      }
      return schemaToTypeRef(refItem, contextName, parentModelName);
    }
    // If allOf has a single item, unwrap it
    if (schema.allOf.length === 1) {
      return schemaToTypeRef(schema.allOf[0], contextName, parentModelName);
    }
    // If allOf items all have properties, treat as a merged model
    const hasProperties = schema.allOf.some((s: SchemaObject) => s.properties);
    if (hasProperties) {
      const baseName = toPascalCase(contextName ?? 'UnknownModel');
      return {
        kind: 'model',
        name: qualifyInlineModelName(baseName, parentModelName),
      };
    }
    // Fall through to other checks
  }

  // Handle oneOf / anyOf → Union or Nullable
  // Valid OAS 3.1: properties can have { oneOf: [{ type: object }, { type: 'null' }] }
  // without a wrapping `type` field.
  if (schema.oneOf || schema.anyOf) {
    const compositionKind: 'oneOf' | 'anyOf' = schema.oneOf ? 'oneOf' : 'anyOf';
    const rawVariants: SchemaObject[] = schema.oneOf ?? schema.anyOf ?? [];

    // Check for nullable pattern: oneOf: [realType, { type: 'null' }]
    const nullVariant = rawVariants.find(
      (v: SchemaObject) => v.type === 'null' || (Array.isArray(v.type) && v.type.length === 1 && v.type[0] === 'null'),
    );
    const nonNullVariants = rawVariants.filter((v) => v !== nullVariant);

    if (nullVariant && nonNullVariants.length === 1) {
      // Nullable single type — unwrap as nullable
      return {
        kind: 'nullable',
        inner: schemaToTypeRef(nonNullVariants[0], contextName, parentModelName),
      };
    }

    // Collapse an oneOf/anyOf whose non-null variants are all string-const
    // schemas into a single enum. This turns patterns like
    //   provider: { oneOf: [{ const: "AppleOAuth" }, { const: "GitHubOAuth" }, ...] }
    // into a proper enum type with one member per variant instead of a
    // structurally-opaque union of literal refs.
    const literalStrings = collectLiteralStringConsts(nonNullVariants);
    if (literalStrings !== null && literalStrings.length >= 2) {
      const enumRef = buildSyntheticEnumRef(literalStrings, contextName, parentModelName);
      return nullVariant ? { kind: 'nullable', inner: enumRef } : enumRef;
    }

    // Synthesize a discriminator when all non-null variants are objects that
    // share a property whose schema carries a `const` value. Covers the
    // EventSchema-style pattern where each oneOf variant pins `event:
    // const: "..."` instead of the spec using an explicit `discriminator:`.
    const syntheticDiscriminator =
      !schema.discriminator && compositionKind === 'oneOf' ? detectConstPropertyDiscriminator(nonNullVariants) : null;

    // General union
    const variants = rawVariants
      .filter((v: SchemaObject) => v.type !== 'null')
      .map((v: SchemaObject) => schemaToTypeRef(v, contextName, parentModelName));
    const hasNull = !!nullVariant;
    const union: TypeRef = {
      kind: 'union',
      variants,
      compositionKind,
      ...(schema.discriminator
        ? {
          discriminator: {
            property: schema.discriminator.propertyName,
            mapping: Object.fromEntries(
              Object.entries(schema.discriminator.mapping ?? {}).map(([k, v]) => [
                k,
                v.replace(/^#\/components\/schemas\//, ''),
              ]),
            ),
          },
        }
        : syntheticDiscriminator
          ? { discriminator: syntheticDiscriminator }
          : {}),
    };
    return hasNull ? { kind: 'nullable', inner: union } : union;
  }

  // Handle const → LiteralType (supports string, number, boolean)
  if (schema.const !== undefined) {
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
  if (schema.enum && schema.enum.length === 1) {
    const v = schema.enum[0];
    return { kind: 'literal', value: typeof v === 'number' ? v : String(v) };
  }

  // Handle enum
  if (schema.enum) {
    const baseName = toPascalCase(contextName ?? 'UnknownEnum');
    // Strip ListItem/ByExternalId markers from parent name so enum names are clean:
    // e.g., DirectoryListItem + State → Directory + State = DirectoryState
    const cleanParent = parentModelName ? stripListItemMarkers(parentModelName) : undefined;
    // Avoid redundant prefix: Connection + ConnectionType → ConnectionType
    const qualifiedName = cleanParent && !baseName.startsWith(cleanParent) ? `${cleanParent}${baseName}` : baseName;
    return {
      kind: 'enum',
      name: qualifiedName,
      values: schema.enum.map((v) => (typeof v === 'number' ? v : String(v))),
    };
  }

  // Handle array — pass parentModelName through to qualify inline items
  if (schema.type === 'array' && schema.items) {
    return {
      kind: 'array',
      items: schemaToTypeRef(schema.items, contextName, parentModelName),
    };
  }
  // Handle array without explicit type but with items (valid OAS 3.1)
  if (!schema.type && schema.items) {
    return {
      kind: 'array',
      items: schemaToTypeRef(schema.items, contextName, parentModelName),
    };
  }

  // Handle object → ModelRef (if it has properties, it's a named model reference)
  // When additionalProperties is also present, we still return a ModelRef so the
  // named properties are preserved. The extractModel path will pick up the extra
  // properties as a catch-all map field named `additionalProperties`.
  if (schema.type === 'object' && schema.properties) {
    const baseName = toPascalCase(contextName ?? 'UnknownModel');
    return {
      kind: 'model',
      name: qualifyInlineModelName(baseName, parentModelName),
    };
  }

  // Handle freeform object with additionalProperties or patternProperties → Map<string, T>
  if (schema.type === 'object' && !schema.properties) {
    let valueType: TypeRef = { kind: 'primitive', type: 'unknown' };
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      // Empty additionalProperties ({}) means "any value" — keep as unknown
      const apKeys = Object.keys(schema.additionalProperties);
      if (apKeys.length > 0) {
        valueType = schemaToTypeRef(schema.additionalProperties as SchemaObject, contextName);
      }
    } else if (schema.patternProperties) {
      // patternProperties: { "pattern": schema } → use the first pattern's schema as value type
      const patterns = Object.values(schema.patternProperties);
      if (patterns.length > 0) {
        valueType = schemaToTypeRef(patterns[0], contextName);
      }
    }
    return {
      kind: 'map',
      valueType,
    };
  }

  // Handle primitives
  const primitiveMap: Record<string, 'string' | 'integer' | 'number' | 'boolean'> = {
    string: 'string',
    integer: 'integer',
    number: 'number',
    boolean: 'boolean',
  };

  const typeStr = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (typeStr && primitiveMap[typeStr]) {
    return {
      kind: 'primitive',
      type: primitiveMap[typeStr],
      ...(schema.format ? { format: schema.format } : {}),
    };
  }

  // Handle schemas with no type — if it has properties, treat as model
  if (!schema.type && schema.properties) {
    const baseName = toPascalCase(contextName ?? 'UnknownModel');
    return {
      kind: 'model',
      name: qualifyInlineModelName(baseName, parentModelName),
    };
  }

  // Empty schema {} → unknown
  if (
    !schema.type &&
    !schema.$ref &&
    !schema.oneOf &&
    !schema.anyOf &&
    !schema.allOf &&
    !schema.enum &&
    !schema.properties &&
    !schema.items
  ) {
    return { kind: 'primitive', type: 'unknown' };
  }

  // Fallback: treat unknown schemas as unknown
  if (contextName) {
    console.warn(`[oagen] Warning: Unknown schema shape treated as unknown (context: ${contextName})`);
  }
  return { kind: 'primitive', type: 'unknown' };
}

import { qualifyInlineModelName } from './inline-models.js';

export { qualifyInlineModelName, extractInlineModelsFromSchemas } from './inline-models.js';
