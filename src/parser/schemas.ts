import type { Model, Enum, EnumValue, Field, TypeRef } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import { toPascalCase, toUpperSnakeCase, cleanSchemaName, stripListItemMarkers, singularize } from '../utils/naming.js';

interface SchemaObject {
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: string[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  nullable?: boolean;
  $ref?: string;
  additionalProperties?: boolean | SchemaObject;
}

export interface ExtractedSchemas {
  models: Model[];
  enums: Enum[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractSchemas(schemas: Record<string, any> | undefined): ExtractedSchemas {
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

  // Collect inline enums from model fields
  for (const model of models) {
    collectInlineEnums(model.fields, enums);
  }

  return { models, enums };
}

/**
 * Walk model fields and extract inline enum refs as top-level enum definitions.
 * This ensures type alias files are generated for inline enums.
 */
function collectInlineEnums(fields: Field[], enums: Enum[]): void {
  const seen = new Set(enums.map((e) => e.name));
  for (const field of fields) {
    walkTypeRef(field.type, {
      enum: (ref) => {
        if (ref.values && !seen.has(ref.name)) {
          seen.add(ref.name);
          enums.push({
            name: ref.name,
            values: ref.values.map((v) => ({
              name: toUpperSnakeCase(v),
              value: v,
              description: undefined,
            })),
          });
        }
      },
    });
  }
}

function extractEnum(name: string, schema: SchemaObject): Enum {
  const values: EnumValue[] = (schema.enum ?? []).map((v) => ({
    name: toUpperSnakeCase(v),
    value: v,
    description: undefined,
  }));

  return { name, values };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractModel(name: string, schema: SchemaObject, schemas?: Record<string, any>): Model {
  if (schema.allOf) {
    return extractAllOfModel(name, schema, schemas);
  }

  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    fields.push({
      name: fieldName,
      type: schemaToTypeRef(fieldSchema, fieldName, name),
      required: requiredSet.has(fieldName),
      description: fieldSchema.description,
    });
  }

  return { name, description: schema.description, fields };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAllOfModel(name: string, schema: SchemaObject, schemas?: Record<string, any>): Model {
  const fields: Field[] = [];
  const requiredSet = new Set<string>();

  for (const subSchema of schema.allOf ?? []) {
    // Resolve $ref sub-schemas by looking up the referenced component schema
    let resolved = subSchema;
    if (subSchema.$ref && schemas) {
      const segments = (subSchema.$ref as string).split('/');
      const refName = segments[segments.length - 1];
      if (refName && schemas[refName]) {
        resolved = schemas[refName] as SchemaObject;
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
        for (const [fieldName, fieldSchema] of Object.entries(resolved.properties)) {
          fields.push({
            name: fieldName,
            type: schemaToTypeRef(fieldSchema, fieldName, name),
            required: false, // will be set below
            description: fieldSchema.description,
          });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function schemaToTypeRef(schema: any, contextName?: string, parentModelName?: string): TypeRef {
  // Handle $ref → ModelRef
  if (schema.$ref) {
    const segments = schema.$ref.split('/');
    const rawName = segments[segments.length - 1];
    return { kind: 'model', name: cleanSchemaName(toPascalCase(rawName)) };
  }

  // Handle OAS 3.1 nullable type arrays: type: [string, null]
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((t: string) => t !== 'null');
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
      return {
        kind: 'model',
        name: toPascalCase(contextName ?? 'UnknownModel'),
      };
    }
    // Fall through to other checks
  }

  // Handle oneOf / anyOf → Union or Nullable
  // Valid OAS 3.1: properties can have { oneOf: [{ type: object }, { type: 'null' }] }
  // without a wrapping `type` field.
  if (schema.oneOf || schema.anyOf) {
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
      .map((v: SchemaObject) => schemaToTypeRef(v, contextName));
    const hasNull = !!nullVariant;
    const union: TypeRef = {
      kind: 'union',
      variants,
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

  // Handle const or single-value enum → LiteralType
  if (schema.const !== undefined && typeof schema.const === 'string') {
    return { kind: 'literal', value: schema.const };
  }
  if (schema.enum && schema.enum.length === 1) {
    return { kind: 'literal', value: schema.enum[0] };
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
      values: schema.enum as string[],
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
  if (schema.type === 'object' && schema.properties) {
    // Warn when additionalProperties is an object schema — not yet modeled in IR
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      console.warn(
        `[oagen] Warning: additionalProperties with object schema ignored (context: ${contextName ?? 'unknown'})`,
      );
    }
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
        valueType = schemaToTypeRef(schema.additionalProperties, contextName);
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

/**
 * Qualify an inline model name with the parent schema name.
 * If `parentName` is provided and the field name doesn't already start with
 * the parent, the result is `${parentName}${PascalField}` with the trailing
 * word singularized (e.g., Connection + Domains → ConnectionDomain).
 */
function qualifyInlineModelName(baseName: string, parentName?: string): string {
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
 * Walk all component schemas and extract inline Model definitions for fields
 * that are objects with properties (or arrays of such objects).
 * These correspond to the ModelRef entries created by schemaToTypeRef.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractInlineModelsFromSchemas(schemas: Record<string, any> | undefined): Model[] {
  if (!schemas) return [];

  const inlineModels: Model[] = [];

  for (const [schemaName, schema] of Object.entries(schemas)) {
    const parentName = cleanSchemaName(toPascalCase(schemaName));
    extractInlineModelsFromProperties(schema, inlineModels, parentName);
  }

  return inlineModels;
}

function extractInlineModelsFromProperties(schema: SchemaObject, results: Model[], parentName?: string): void {
  const properties = schema.properties ?? {};
  const allOfSchemas = schema.allOf ?? [];

  for (const sub of allOfSchemas) {
    if (sub.properties) {
      extractInlineModelsFromProperties(sub, results, parentName);
    }
  }

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    // Direct inline object with properties (with or without explicit type: 'object')
    if (fieldSchema.properties && (fieldSchema.type === 'object' || !fieldSchema.type)) {
      const baseName = toPascalCase(fieldName);
      const modelName = qualifyInlineModelName(baseName, parentName);
      results.push(buildInlineModel(modelName, fieldSchema));
      extractInlineModelsFromProperties(fieldSchema, results, modelName);
    }

    // Array of inline objects
    if (fieldSchema.type === 'array' && fieldSchema.items) {
      const items = fieldSchema.items as SchemaObject;
      if (items.properties && (items.type === 'object' || !items.type)) {
        const baseName = toPascalCase(fieldName);
        const modelName = qualifyInlineModelName(baseName, parentName);
        results.push(buildInlineModel(modelName, items));
        extractInlineModelsFromProperties(items, results, modelName);
      }
    }

    // oneOf containing objects — extract the first non-null variant as a model
    // This handles: totp: { oneOf: [{ type: object, properties: {...} }, { type: 'null' }] }
    if (fieldSchema.oneOf) {
      const objectVariant = (fieldSchema.oneOf as SchemaObject[]).find(
        (v) => v.properties && (v.type === 'object' || !v.type),
      );
      if (objectVariant) {
        const baseName = toPascalCase(fieldName);
        const modelName = qualifyInlineModelName(baseName, parentName);
        const existingNames = new Set(results.map((r) => r.name));
        if (!existingNames.has(modelName)) {
          results.push(buildInlineModel(modelName, objectVariant));
          extractInlineModelsFromProperties(objectVariant, results, modelName);
        }
      }
    }
  }
}

function buildInlineModel(name: string, schema: SchemaObject): Model {
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    fields.push({
      name: fieldName,
      type: schemaToTypeRef(fieldSchema, fieldName, name),
      required: requiredSet.has(fieldName),
      description: fieldSchema.description,
    });
  }

  return { name, description: schema.description, fields };
}
