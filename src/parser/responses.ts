import type { TypeRef, Model, Field } from '../ir/types.js';
import { toPascalCase } from '../utils/naming.js';
import { schemaToTypeRef } from './schemas.js';

export interface ResponseExtractionResult {
  /** The TypeRef to use as the operation's response type */
  response: TypeRef;
  /** Any inline models discovered during extraction (to merge into ir.models) */
  inlineModels: Model[];
  /** Whether this response indicates a paginated list */
  isPaginated: boolean;
}

export function classifyAndExtractResponse(
  schema: Record<string, unknown>,
  contextName: string,
): ResponseExtractionResult {
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

function isListEnvelope(schema: Record<string, unknown>): boolean {
  // Check allOf-style list envelope
  const allOf = schema.allOf as Record<string, unknown>[] | undefined;
  if (allOf) {
    let hasListMetadata = false;
    let hasDataArray = false;

    for (const sub of allOf) {
      const props = sub.properties as Record<string, unknown> | undefined;
      if (!props) continue;

      if (props.list_metadata) hasListMetadata = true;

      const dataSchema = props.data as Record<string, unknown> | undefined;
      if (dataSchema?.type === 'array') hasDataArray = true;
    }

    if (hasListMetadata && hasDataArray) return true;
  }

  // Check flat list envelope (object with data array + list_metadata)
  const props = schema.properties as Record<string, unknown> | undefined;
  if (props) {
    const dataSchema = props.data as Record<string, unknown> | undefined;
    const hasDataArray = dataSchema?.type === 'array';
    const hasListMetadata = !!props.list_metadata;
    if (hasDataArray && hasListMetadata) return true;
  }

  return false;
}

function extractListResponse(schema: Record<string, unknown>, contextName: string): ResponseExtractionResult {
  let itemTypeRef: TypeRef = { kind: 'primitive', type: 'string' };
  const inlineModels: Model[] = [];

  // Collect all property sources (allOf sub-schemas or flat schema)
  const propSources: Record<string, unknown>[] = [];
  const allOf = schema.allOf as Record<string, unknown>[] | undefined;
  if (allOf) {
    for (const sub of allOf) {
      if (sub.properties) propSources.push(sub.properties as Record<string, unknown>);
    }
  }
  if (schema.properties) {
    propSources.push(schema.properties as Record<string, unknown>);
  }

  for (const props of propSources) {
    if (!props.data) continue;

    const dataSchema = props.data as Record<string, unknown>;
    if (dataSchema.type === 'array' && dataSchema.items) {
      const items = dataSchema.items as Record<string, unknown>;
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
  };
}

function hasObjectConstField(schema: Record<string, unknown>): boolean {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props?.object) return false;
  const objectField = props.object as Record<string, unknown>;
  return objectField.const !== undefined || objectField.enum !== undefined;
}

function isSingleResourceWrapper(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object') return false;
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return false;

  // Find the wrapper property: use required[0] if available, or the single property key
  const required = schema.required as string[] | undefined;
  let wrapperKey: string | undefined;
  if (required && required.length === 1) {
    wrapperKey = required[0];
  } else {
    const propKeys = Object.keys(props);
    if (propKeys.length === 1) {
      wrapperKey = propKeys[0];
    }
  }
  if (!wrapperKey) return false;

  const propSchema = props[wrapperKey] as Record<string, unknown> | undefined;
  if (!propSchema) return false;

  // Direct object with `object` const field
  if (propSchema.type === 'object' && hasObjectConstField(propSchema)) return true;

  // oneOf with object + null (nullable resource)
  if (propSchema.oneOf) {
    const variants = propSchema.oneOf as Record<string, unknown>[];
    return variants.some((v) => v.type === 'object' && hasObjectConstField(v));
  }

  return false;
}

function extractWrappedResource(schema: Record<string, unknown>, contextName: string): ResponseExtractionResult {
  const props = schema.properties as Record<string, unknown>;
  const required = schema.required as string[] | undefined;
  const wrapperKey = required && required.length === 1 ? required[0] : Object.keys(props)[0];
  const propSchema = props[wrapperKey] as Record<string, unknown>;
  const inlineModels: Model[] = [];

  // Derive model name from the object const value or wrapper property name
  const resourceName = contextName.replace(/Response$/, '');

  if (propSchema.oneOf) {
    const variants = propSchema.oneOf as Record<string, unknown>[];
    const objectVariant = variants.find((v) => v.type === 'object' && hasObjectConstField(v));

    if (objectVariant) {
      const modelName = deriveModelName(objectVariant, resourceName);
      inlineModels.push(...extractInlineModel(modelName, objectVariant));

      const hasNullVariant = variants.some(
        (v) => v.type === 'null' || (Array.isArray(v.type) && (v.type as string[]).includes('null')),
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

function extractDirectResource(schema: Record<string, unknown>, contextName: string): ResponseExtractionResult {
  const inlineModels: Model[] = [];

  if (schema.type === 'object' && schema.properties) {
    const modelName = deriveModelName(schema, contextName);
    inlineModels.push(...extractInlineModel(modelName, schema));
    return {
      response: { kind: 'model', name: modelName },
      inlineModels,
      isPaginated: false,
    };
  }

  // Non-object schema (primitive, array, etc.) — delegate to schemaToTypeRef
  return {
    response: schemaToTypeRef(schema, contextName),
    inlineModels: [],
    isPaginated: false,
  };
}

function deriveModelName(schema: Record<string, unknown>, fallback: string): string {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (props?.object) {
    const objectField = props.object as Record<string, unknown>;
    if (objectField.const && typeof objectField.const === 'string') {
      return toPascalCase(objectField.const);
    }
  }
  return toPascalCase(fallback);
}

function extractInlineModel(name: string, schema: Record<string, unknown>): Model[] {
  const requiredSet = new Set((schema.required as string[] | undefined) ?? []);
  const fields: Field[] = [];
  const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const nestedModels: Model[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    fields.push({
      name: fieldName,
      type: schemaToTypeRef(fieldSchema, fieldName),
      required: requiredSet.has(fieldName),
      description: (fieldSchema.description as string) ?? undefined,
    });

    // Recursively extract nested inline objects
    if (fieldSchema.type === 'object' && fieldSchema.properties) {
      nestedModels.push(...extractInlineModel(toPascalCase(fieldName), fieldSchema));
    }
    if (fieldSchema.type === 'array' && fieldSchema.items) {
      const items = fieldSchema.items as Record<string, unknown>;
      if (items.type === 'object' && items.properties) {
        nestedModels.push(...extractInlineModel(toPascalCase(fieldName), items));
      }
    }
  }

  return [{ name, description: (schema.description as string) ?? undefined, fields }, ...nestedModels];
}
