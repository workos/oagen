import type { Model, Field } from '../ir/types.js';
import { toPascalCase, cleanSchemaName, stripListItemMarkers, singularize } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { buildFieldFromSchema } from './schemas.js';

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
 * Walk all component schemas and extract inline Model definitions for fields
 * that are objects with properties (or arrays of such objects).
 * These correspond to the ModelRef entries created by schemaToTypeRef.
 */
export function extractInlineModelsFromSchemas(schemas: Record<string, SchemaObject> | undefined): Model[] {
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
    if (!fieldSchema) continue;
    // Direct inline object with properties (with or without explicit type: 'object')
    if (fieldSchema.properties && (fieldSchema.type === 'object' || !fieldSchema.type)) {
      const baseName = toPascalCase(fieldName);
      const modelName = qualifyInlineModelName(baseName, parentName);
      results.push(buildInlineModel(modelName, fieldSchema));
      extractInlineModelsFromProperties(fieldSchema, results, modelName);
    }

    // Array of inline objects
    if (fieldSchema.type === 'array' && fieldSchema.items) {
      const items = fieldSchema.items;
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
      const objectVariant = fieldSchema.oneOf.find((v) => v.properties && (v.type === 'object' || !v.type));
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
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet));
  }

  return { name, description: schema.description, fields };
}
