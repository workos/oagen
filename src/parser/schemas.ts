import type { Model, Enum, EnumValue, Field, TypeRef } from '../ir/types.js';
import { toPascalCase, toUpperSnakeCase, stripBackendSuffixes, stripBackendPrefixes } from '../utils/naming.js';

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
    const pascalName = stripBackendPrefixes(stripBackendSuffixes(toPascalCase(name)));

    if (schema.enum) {
      enums.push(extractEnum(pascalName, schema));
    } else {
      models.push(extractModel(pascalName, schema));
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
  const existingNames = new Set(enums.map(e => e.name));
  for (const field of fields) {
    walkTypeRefForEnums(field.type, enums, existingNames);
  }
}

function walkTypeRefForEnums(ref: TypeRef, enums: Enum[], seen: Set<string>): void {
  if (ref.kind === 'enum' && ref.values && !seen.has(ref.name)) {
    seen.add(ref.name);
    enums.push({
      name: ref.name,
      values: ref.values.map(v => ({
        name: toUpperSnakeCase(v),
        value: v,
        description: undefined,
      })),
    });
  } else if (ref.kind === 'array') {
    walkTypeRefForEnums(ref.items, enums, seen);
  } else if (ref.kind === 'nullable') {
    walkTypeRefForEnums(ref.inner, enums, seen);
  } else if (ref.kind === 'union') {
    for (const v of ref.variants) {
      walkTypeRefForEnums(v, enums, seen);
    }
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

function extractModel(name: string, schema: SchemaObject): Model {
  if (schema.allOf) {
    return extractAllOfModel(name, schema);
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

function extractAllOfModel(name: string, schema: SchemaObject): Model {
  const fields: Field[] = [];
  const requiredSet = new Set<string>();

  for (const subSchema of schema.allOf ?? []) {
    if (subSchema.required) {
      for (const r of subSchema.required) requiredSet.add(r);
    }
    if (subSchema.properties) {
      for (const [fieldName, fieldSchema] of Object.entries(subSchema.properties)) {
        fields.push({
          name: fieldName,
          type: schemaToTypeRef(fieldSchema, fieldName, name),
          required: false, // will be set below
          description: fieldSchema.description,
        });
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
    return { kind: 'model', name: stripBackendPrefixes(stripBackendSuffixes(toPascalCase(rawName))) };
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

  // Handle oneOf / anyOf → Union
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf ?? schema.anyOf ?? []).map((v: SchemaObject) => schemaToTypeRef(v, contextName));
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
    return union;
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
    // Avoid redundant prefix: Connection + ConnectionType → ConnectionType
    const qualifiedName = parentModelName && !baseName.startsWith(parentModelName)
      ? `${parentModelName}${baseName}`
      : baseName;
    return {
      kind: 'enum',
      name: qualifiedName,
      values: schema.enum as string[],
    };
  }

  // Handle array
  if (schema.type === 'array' && schema.items) {
    return {
      kind: 'array',
      items: schemaToTypeRef(schema.items, contextName),
    };
  }

  // Handle object → ModelRef (if it has properties, it's a named model reference)
  if (schema.type === 'object' && schema.properties) {
    return {
      kind: 'model',
      name: toPascalCase(contextName ?? 'UnknownModel'),
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

  // Fallback: treat unknown schemas as string
  return { kind: 'primitive', type: 'string' };
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

  for (const [, schema] of Object.entries(schemas)) {
    extractInlineModelsFromProperties(schema, inlineModels);
  }

  return inlineModels;
}

function extractInlineModelsFromProperties(schema: SchemaObject, results: Model[]): void {
  const properties = schema.properties ?? {};
  const allOfSchemas = schema.allOf ?? [];

  for (const sub of allOfSchemas) {
    if (sub.properties) {
      extractInlineModelsFromProperties(sub, results);
    }
  }

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    // Direct inline object with properties
    if (fieldSchema.type === 'object' && fieldSchema.properties) {
      const modelName = toPascalCase(fieldName);
      results.push(buildInlineModel(modelName, fieldSchema));
      extractInlineModelsFromProperties(fieldSchema, results);
    }

    // Array of inline objects
    if (fieldSchema.type === 'array' && fieldSchema.items) {
      const items = fieldSchema.items as SchemaObject;
      if (items.type === 'object' && items.properties) {
        const modelName = toPascalCase(fieldName);
        results.push(buildInlineModel(modelName, items));
        extractInlineModelsFromProperties(items, results);
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
      type: schemaToTypeRef(fieldSchema, fieldName),
      required: requiredSet.has(fieldName),
      description: fieldSchema.description,
    });
  }

  return { name, description: schema.description, fields };
}
