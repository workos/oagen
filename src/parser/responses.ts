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
  const allOf = schema.allOf as Record<string, unknown>[] | undefined;
  if (!allOf) return false;

  let hasListMetadata = false;
  let hasDataArray = false;

  for (const sub of allOf) {
    const props = sub.properties as Record<string, unknown> | undefined;
    if (!props) continue;

    if (props.list_metadata) hasListMetadata = true;

    const dataSchema = props.data as Record<string, unknown> | undefined;
    if (dataSchema?.type === 'array') hasDataArray = true;
  }

  return hasListMetadata && hasDataArray;
}

function extractListResponse(schema: Record<string, unknown>, contextName: string): ResponseExtractionResult {
  const allOf = schema.allOf as Record<string, unknown>[];
  let itemTypeRef: TypeRef = { kind: 'primitive', type: 'string' };
  const inlineModels: Model[] = [];

  for (const subSchema of allOf) {
    const props = subSchema.properties as Record<string, unknown> | undefined;
    if (!props?.data) continue;

    const dataSchema = props.data as Record<string, unknown>;
    if (dataSchema.type === 'array' && dataSchema.items) {
      const items = dataSchema.items as Record<string, unknown>;
      if (items.$ref) {
        itemTypeRef = schemaToTypeRef(items, contextName);
      } else if (items.type === 'object' && items.properties) {
        const itemName = contextName.replace(/Response$/, '') + 'Item';
        itemTypeRef = { kind: 'model', name: itemName };
        inlineModels.push(extractInlineModel(itemName, items));
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
  const required = schema.required as string[] | undefined;
  if (!required || required.length !== 1) return false;

  const propSchema = props[required[0]] as Record<string, unknown> | undefined;
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
  const required = schema.required as string[];
  const props = schema.properties as Record<string, unknown>;
  const propSchema = props[required[0]] as Record<string, unknown>;
  const inlineModels: Model[] = [];

  // Derive model name from the object const value or wrapper property name
  const resourceName = contextName.replace(/Response$/, '');

  if (propSchema.oneOf) {
    const variants = propSchema.oneOf as Record<string, unknown>[];
    const objectVariant = variants.find((v) => v.type === 'object' && hasObjectConstField(v));

    if (objectVariant) {
      const modelName = deriveModelName(objectVariant, resourceName);
      inlineModels.push(extractInlineModel(modelName, objectVariant));

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
  inlineModels.push(extractInlineModel(modelName, propSchema));

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
    inlineModels.push(extractInlineModel(modelName, schema));
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

function extractInlineModel(name: string, schema: Record<string, unknown>): Model {
  const requiredSet = new Set((schema.required as string[] | undefined) ?? []);
  const fields: Field[] = [];
  const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    fields.push({
      name: fieldName,
      type: schemaToTypeRef(fieldSchema, fieldName),
      required: requiredSet.has(fieldName),
      description: (fieldSchema.description as string) ?? undefined,
    });
  }

  return { name, description: (schema.description as string) ?? undefined, fields };
}
