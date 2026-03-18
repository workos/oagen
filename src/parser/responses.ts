import type { TypeRef, Model, Field } from '../ir/types.js';
import { toPascalCase, singularize, stripListItemMarkers } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { schemaToTypeRef, buildFieldFromSchema } from './schemas.js';

export interface ResponseExtractionResult {
  /** The TypeRef to use as the operation's response type */
  response: TypeRef;
  /** Any inline models discovered during extraction (to merge into ir.models) */
  inlineModels: Model[];
  /** Whether this response indicates a paginated list */
  isPaginated: boolean;
  /** Path to the data array within the response envelope (e.g., 'data') */
  dataPath?: string;
  /** TypeRef of individual items in a paginated list */
  itemType?: TypeRef;
}

export function classifyAndExtractResponse(schema: SchemaObject, contextName: string): ResponseExtractionResult {
  // 1. If schema is a $ref, resolve to model name (Phase 1)
  if (schema.$ref) {
    return { response: schemaToTypeRef(schema, contextName), inlineModels: [], isPaginated: false };
  }

  // 2. Check for list envelope (allOf with list_metadata + data array)
  if (isListEnvelope(schema)) {
    return extractListResponse(schema, contextName);
  }

  // 3. Check for single-resource wrapper ({ resource_name: { object: "...", ... } })
  if (isSingleResourceWrapper(schema)) {
    return extractWrappedResource(schema, contextName);
  }

  // 4. Direct resource or plain inline object
  return extractDirectResource(schema, contextName);
}

function isListEnvelope(schema: SchemaObject): boolean {
  // Check allOf-style list envelope
  if (schema.allOf) {
    let hasListMetadata = false;
    let hasDataArray = false;

    for (const sub of schema.allOf) {
      if (!sub.properties) continue;

      if (sub.properties.list_metadata) hasListMetadata = true;

      const dataSchema = sub.properties.data;
      if (dataSchema?.type === 'array') hasDataArray = true;
    }

    if (hasListMetadata && hasDataArray) return true;
  }

  // Check flat list envelope (object with data array + list_metadata)
  if (schema.properties) {
    const dataSchema = schema.properties.data;
    const hasDataArray = dataSchema?.type === 'array';
    const hasListMetadata = !!schema.properties.list_metadata;
    if (hasDataArray && hasListMetadata) return true;
  }

  return false;
}

function extractListResponse(schema: SchemaObject, contextName: string): ResponseExtractionResult {
  let itemTypeRef: TypeRef = { kind: 'primitive', type: 'string' };
  const inlineModels: Model[] = [];

  // Collect all property sources (allOf sub-schemas or flat schema)
  const propSources: Record<string, SchemaObject | undefined>[] = [];
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      if (sub.properties) propSources.push(sub.properties);
    }
  }
  if (schema.properties) {
    propSources.push(schema.properties);
  }

  for (const props of propSources) {
    const dataProp = props.data;
    if (!dataProp) continue;

    if (dataProp.type === 'array' && dataProp.items) {
      const items = dataProp.items;
      if (items.$ref) {
        itemTypeRef = schemaToTypeRef(items, contextName);
      } else if (items.type === 'object' && items.properties) {
        const itemName = contextName.replace(/Response$/, '') + 'Item';
        itemTypeRef = { kind: 'model', name: itemName };
        inlineModels.push(...extractInlineModel(itemName, items));
      }
    }
  }

  return {
    response: { kind: 'array', items: itemTypeRef },
    inlineModels,
    isPaginated: true,
    dataPath: 'data',
    itemType: itemTypeRef,
  };
}

function hasObjectConstField(schema: SchemaObject): boolean {
  if (!schema.properties?.object) return false;
  const objectField = schema.properties.object;
  return objectField !== undefined && (objectField.const !== undefined || objectField.enum !== undefined);
}

function isSingleResourceWrapper(schema: SchemaObject): boolean {
  if (schema.type !== 'object') return false;
  if (!schema.properties) return false;

  // Find the wrapper property: use required[0] if available, or the single property key
  let wrapperKey: string | undefined;
  if (schema.required && schema.required.length === 1) {
    wrapperKey = schema.required[0];
  } else {
    const propKeys = Object.keys(schema.properties);
    if (propKeys.length === 1) {
      wrapperKey = propKeys[0];
    }
  }
  if (!wrapperKey) return false;

  const propSchema = schema.properties[wrapperKey];
  if (!propSchema) return false;

  // Direct object with `object` const field
  if (propSchema.type === 'object' && hasObjectConstField(propSchema)) return true;

  // oneOf with object + null (nullable resource)
  if (propSchema.oneOf) {
    return propSchema.oneOf.some((v) => v.type === 'object' && hasObjectConstField(v));
  }

  return false;
}

function extractWrappedResource(schema: SchemaObject, contextName: string): ResponseExtractionResult {
  const props = schema.properties!;
  const wrapperKey = schema.required && schema.required.length === 1 ? schema.required[0] : Object.keys(props)[0];
  const propSchema = props[wrapperKey]!;
  const inlineModels: Model[] = [];

  // Derive model name from the object const value or wrapper property name
  const resourceName = contextName.replace(/Response$/, '');

  if (propSchema.oneOf) {
    const objectVariant = propSchema.oneOf.find((v) => v.type === 'object' && hasObjectConstField(v));

    if (objectVariant) {
      const modelName = deriveModelName(objectVariant, resourceName);
      inlineModels.push(...extractInlineModel(modelName, objectVariant));

      const hasNullVariant = propSchema.oneOf.some(
        (v) => v.type === 'null' || (Array.isArray(v.type) && v.type.includes('null')),
      );

      const modelRef: TypeRef = { kind: 'model', name: modelName };
      return {
        response: hasNullVariant ? { kind: 'nullable', inner: modelRef } : modelRef,
        inlineModels,
        isPaginated: false,
      };
    }
  }

  // Direct object
  const modelName = deriveModelName(propSchema, resourceName);
  inlineModels.push(...extractInlineModel(modelName, propSchema));

  return {
    response: { kind: 'model', name: modelName },
    inlineModels,
    isPaginated: false,
  };
}

function extractDirectResource(schema: SchemaObject, contextName: string): ResponseExtractionResult {
  const inlineModels: Model[] = [];

  // Direct object with properties (with or without explicit type: 'object')
  if (schema.properties && (schema.type === 'object' || !schema.type)) {
    const modelName = deriveModelName(schema, contextName);
    inlineModels.push(...extractInlineModel(modelName, schema));
    return {
      response: { kind: 'model', name: modelName },
      inlineModels,
      isPaginated: false,
    };
  }

  // allOf with properties — merge into a single model
  if (schema.allOf) {
    const mergedProperties: Record<string, SchemaObject | undefined> = {};
    const mergedRequired: string[] = [];
    for (const sub of schema.allOf) {
      if (sub.properties) {
        Object.assign(mergedProperties, sub.properties);
      }
      if (sub.required) {
        mergedRequired.push(...sub.required);
      }
    }
    if (Object.keys(mergedProperties).length > 0) {
      const merged: SchemaObject = { type: 'object', properties: mergedProperties, required: mergedRequired };
      const modelName = deriveModelName(merged, contextName);
      inlineModels.push(...extractInlineModel(modelName, merged));
      return {
        response: { kind: 'model', name: modelName },
        inlineModels,
        isPaginated: false,
      };
    }
  }

  // oneOf — delegate to schemaToTypeRef (returns union) but also extract inline models
  // from object variants so the model refs resolve
  if (schema.oneOf) {
    for (const variant of schema.oneOf) {
      if (variant.properties && (variant.type === 'object' || !variant.type)) {
        const modelName = deriveModelName(variant, contextName);
        const existingNames = new Set(inlineModels.map((m) => m.name));
        if (!existingNames.has(modelName)) {
          inlineModels.push(...extractInlineModel(modelName, variant));
        }
      }
    }
  }

  // Array with inline object items — extract the item model
  if (schema.type === 'array' && schema.items) {
    const items = schema.items;
    if (items.$ref) {
      return {
        response: { kind: 'array', items: schemaToTypeRef(items, contextName) },
        inlineModels,
        isPaginated: false,
      };
    }
    if (items.properties && (items.type === 'object' || !items.type)) {
      const itemName = contextName.replace(/Response$/, '') + 'Item';
      inlineModels.push(...extractInlineModel(itemName, items));
      return {
        response: { kind: 'array', items: { kind: 'model', name: itemName } },
        inlineModels,
        isPaginated: false,
      };
    }
  }

  // Non-object schema (primitive, union, etc.) — delegate to schemaToTypeRef
  return {
    response: schemaToTypeRef(schema, contextName),
    inlineModels,
    isPaginated: false,
  };
}

function deriveModelName(schema: SchemaObject, fallback: string): string {
  if (schema.properties?.object) {
    const objectField = schema.properties.object;
    if (objectField && objectField.const && typeof objectField.const === 'string') {
      return toPascalCase(objectField.const);
    }
  }
  return toPascalCase(fallback);
}

/**
 * Qualify a nested inline model name with its parent to avoid generic names.
 * e.g., parent="Connection" + field="domains" → "ConnectionDomain" (singularized)
 * Only qualifies when the field name alone would be too generic.
 */
function qualifyNestedName(parentName: string, fieldName: string): string {
  const pascalField = toPascalCase(fieldName);
  // If the field name already starts with the parent name, don't double-prefix
  if (pascalField.startsWith(parentName)) return pascalField;
  // Qualify with parent and singularize:
  // Connection + Domains → ConnectionDomains → singularize lead word → ConnectionDomain
  const cleanParent = stripListItemMarkers(parentName);
  const qualified = `${cleanParent}${pascalField}`;
  // Singularize the trailing word: ConnectionDomains → ConnectionDomain
  const match = qualified.match(/^(.+?)([A-Z][a-z]+s?)$/);
  if (match && match[2]) {
    const trailing = singularize(match[2]);
    return match[1] + trailing;
  }
  return qualified;
}

function extractInlineModel(name: string, schema: SchemaObject): Model[] {
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];
  const properties = schema.properties ?? {};
  const nestedModels: Model[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet));

    // Recursively extract nested inline objects — qualify with parent name
    // to avoid generic names like "Domains" when multiple parents have a "domains" field
    if (fieldSchema.type === 'object' && fieldSchema.properties) {
      const nestedName = qualifyNestedName(name, fieldName);
      nestedModels.push(...extractInlineModel(nestedName, fieldSchema));
    }
    if (fieldSchema.type === 'array' && fieldSchema.items) {
      const items = fieldSchema.items;
      if (items.type === 'object' && items.properties) {
        const nestedName = qualifyNestedName(name, fieldName);
        nestedModels.push(...extractInlineModel(nestedName, items));
      }
    }
    // Handle allOf with inline object properties — merge into a single nested model
    if (fieldSchema.allOf) {
      const mergedProperties: Record<string, SchemaObject | undefined> = {};
      const mergedRequired: string[] = [];
      for (const sub of fieldSchema.allOf) {
        if (sub.properties) Object.assign(mergedProperties, sub.properties);
        if (sub.required) mergedRequired.push(...sub.required);
      }
      if (Object.keys(mergedProperties).length > 0) {
        const nestedName = qualifyNestedName(name, fieldName);
        const merged: SchemaObject = { type: 'object', properties: mergedProperties, required: mergedRequired };
        const existingNames = new Set(nestedModels.map((m) => m.name));
        if (!existingNames.has(nestedName)) {
          nestedModels.push(...extractInlineModel(nestedName, merged));
        }
      }
    }
    // Handle oneOf containing inline objects — extract the first non-null object variant
    if (fieldSchema.oneOf) {
      const objectVariant = fieldSchema.oneOf.find((v) => v.properties && (v.type === 'object' || !v.type));
      if (objectVariant) {
        const nestedName = qualifyNestedName(name, fieldName);
        const existingNames = new Set(nestedModels.map((m) => m.name));
        if (!existingNames.has(nestedName)) {
          nestedModels.push(...extractInlineModel(nestedName, objectVariant));
        }
      }
    }
  }

  return [{ name, description: schema.description, fields }, ...nestedModels];
}
