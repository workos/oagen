import type { Model, Enum, EnumValue, Field, TypeRef } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import { toPascalCase, toUpperSnakeCase, cleanSchemaName, stripListItemMarkers } from '../utils/naming.js';

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
  [key: string]: unknown;
}

export interface ExtractedSchemas {
  models: Model[];
  enums: Enum[];
}

export function extractSchemas(schemas: Record<string, SchemaObject> | undefined): ExtractedSchemas {
  const models: Model[] = [];
  const enums: Enum[] = [];

  if (!schemas) return { models, enums };

  for (const [name, schema] of Object.entries(schemas)) {
    const pascalName = cleanSchemaName(toPascalCase(name));

    if (schema.enum) {
      enums.push(extractEnum(pascalName, schema));
    } else {
      models.push(extractModel(pascalName, schema, schemas));
    }
  }

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

  return { models, enums };
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
      const isComponent = Object.keys(schemas).some((k) => cleanSchemaName(toPascalCase(k)) === modelRef.name);
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
    if (cleanSchemaName(toPascalCase(k)) === pascalName) return v;
  }
  return null;
}

/** Walk into a schema to find a field's sub-schema, resolving allOf. */
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
  };
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

  return { name, description: schema.description, fields };
}

export function schemaToTypeRef(schema: SchemaObject, contextName?: string, parentModelName?: string): TypeRef {
  // Handle $ref → ModelRef
  if (schema.$ref) {
    const segments = schema.$ref.split('/');
    const rawName = segments[segments.length - 1];
    return { kind: 'model', name: cleanSchemaName(toPascalCase(rawName)) };
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
              mapping: schema.discriminator.mapping ?? {},
            },
          }
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
      values: schema.enum.map((v) => (typeof v === 'number' ? String(v) : String(v))),
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

  // Fallback: treat unknown schemas as string
  if (contextName) {
    console.warn(`[oagen] Warning: Unknown schema shape treated as string (context: ${contextName})`);
  }
  return { kind: 'primitive', type: 'string' };
}

import { qualifyInlineModelName } from './inline-models.js';

export { qualifyInlineModelName, extractInlineModelsFromSchemas } from './inline-models.js';
