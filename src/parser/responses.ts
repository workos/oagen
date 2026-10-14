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
  /**
   * The envelope's properties other than the data array (see
   * `PaginationMeta.envelopeFields`). Set only for a list envelope.
   */
  envelopeFields?: Field[];
}

export function classifyAndExtractResponse(
  schema: SchemaObject,
  contextName: string,
  componentSchemas?: Record<string, SchemaObject>,
): ResponseExtractionResult {
  // 1. If schema is a $ref, resolve to model name (Phase 1)
  if (schema.$ref) {
    return { response: schemaToTypeRef(schema, contextName), inlineModels: [], isPaginated: false };
  }

  // 2. Check for list envelope (structural detection: array prop + non-array companion)
  const envelope = detectListEnvelope(schema);
  if (envelope.isEnvelope) {
    return extractListResponse(schema, contextName, envelope.dataPath!);
  }

  // 3. Check for single-resource wrapper ({ resource_name: { object: "...", ... } })
  if (isSingleResourceWrapper(schema)) {
    return extractWrappedResource(schema, contextName);
  }

  // 4. Direct resource or plain inline object
  return extractDirectResource(schema, contextName, componentSchemas);
}

interface ListEnvelopeResult {
  isEnvelope: boolean;
  dataPath: string | null;
}

const KNOWN_DATA_PATHS = new Set(['data', 'items', 'results', 'records', 'entries', 'values', 'nodes', 'edges']);

const PAGINATION_METADATA_PATTERNS = [
  'meta',
  'metadata',
  'pagination',
  'cursor',
  'has_more',
  'page_info',
  'total',
  'next_page',
  'previous_page',
  'offset',
];

function detectListEnvelope(schema: SchemaObject): ListEnvelopeResult {
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

  if (propSources.length === 0) return { isEnvelope: false, dataPath: null };

  // Merge all properties into a single view
  const mergedProps: Record<string, SchemaObject | undefined> = {};
  for (const source of propSources) {
    Object.assign(mergedProps, source);
  }

  // Find array-typed properties and non-array companion properties
  const arrayProps: string[] = [];
  const nonArrayKeys: string[] = [];

  for (const [key, propSchema] of Object.entries(mergedProps)) {
    if (!propSchema) continue;
    if (propSchema.type === 'array') {
      arrayProps.push(key);
    } else {
      nonArrayKeys.push(key);
    }
  }

  // List envelope heuristic: exactly one array property + at least one non-array companion
  // that looks like pagination metadata.  A `data` array alone (e.g. with only an
  // `object` discriminant companion) is NOT sufficient — the companion must indicate
  // actual pagination (cursor, metadata, total, etc.).
  if (arrayProps.length === 1 && nonArrayKeys.length >= 1) {
    const arrayPropName = arrayProps[0];

    const hasPaginationCompanion = nonArrayKeys.some((key) =>
      PAGINATION_METADATA_PATTERNS.some((pattern) => key.toLowerCase().includes(pattern)),
    );

    if (KNOWN_DATA_PATHS.has(arrayPropName) && hasPaginationCompanion) {
      return { isEnvelope: true, dataPath: arrayPropName };
    }

    // Non-standard array property name — still treat as envelope if pagination companion exists
    if (hasPaginationCompanion) {
      return { isEnvelope: true, dataPath: arrayPropName };
    }
  }

  return { isEnvelope: false, dataPath: null };
}

function extractListResponse(schema: SchemaObject, contextName: string, dataPath: string): ResponseExtractionResult {
  let itemTypeRef: TypeRef = { kind: 'primitive', type: 'string' };
  const inlineModels: Model[] = [];

  // Collect all property sources (allOf sub-schemas or flat schema), and the
  // `required` lists that go with them.
  const propSources: Record<string, SchemaObject | undefined>[] = [];
  const required: string[] = [];
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      if (sub.properties) propSources.push(sub.properties);
      if (sub.required) required.push(...sub.required);
    }
  }
  if (schema.properties) {
    propSources.push(schema.properties);
  }
  if (schema.required) required.push(...schema.required);

  for (const props of propSources) {
    const dataProp = props[dataPath];
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

  // Everything the envelope carries besides the data array: the pagination
  // companion (`list_metadata`, `pagination`, `has_more`, …) and any
  // discriminant such as `object: "list"`. Without these an emitter cannot
  // type the endpoint's actual response or read the next-page details.
  const companionProps: Record<string, SchemaObject | undefined> = {};
  for (const props of propSources) {
    for (const [key, propSchema] of Object.entries(props)) {
      if (key !== dataPath && propSchema) companionProps[key] = propSchema;
    }
  }
  const { fields: envelopeFields, models: companionModels } = extractEnvelopeCompanions(companionProps, required);
  inlineModels.push(...companionModels);

  return {
    response: { kind: 'array', items: itemTypeRef },
    inlineModels,
    isPaginated: true,
    dataPath,
    itemType: itemTypeRef,
    envelopeFields,
  };
}

/**
 * Type a list envelope's companion properties as fields, lifting any inline
 * object among them (and anything nested inside it) to a model.
 *
 * Companion models are named from the property alone — `list_metadata` →
 * `ListMetadata`, `pagination` → `Pagination` — rather than qualified by the
 * operation the way list items are (`ListUsersItem`). The same envelope recurs
 * on every list endpoint of an API, so operation-qualified names would mint one
 * identical model per endpoint; a shared name lets `mergeInlineResponseModels`
 * collapse the copies onto one model, preferring the component schema when the
 * document declares one.
 *
 * Both `buildFieldFromSchema` and `extractInlineModel` derive inline names from
 * their parent name, so handing them an empty parent yields exactly that bare
 * name, and the two stay in agreement for nested objects (`PaginationLinks`).
 */
function extractEnvelopeCompanions(
  properties: Record<string, SchemaObject | undefined>,
  required: string[],
): { fields: Field[]; models: Model[] } {
  if (Object.keys(properties).length === 0) return { fields: [], models: [] };
  const [envelope, ...models] = extractInlineModel('', { type: 'object', properties, required });
  return { fields: envelope.fields, models };
}

function hasDiscriminantConstField(schema: SchemaObject): { property: string; value: string } | null {
  if (!schema.properties) return null;

  // Prefer well-known discriminant properties for backward compatibility
  const preferred = ['object', 'type'];
  for (const name of preferred) {
    const field = schema.properties[name];
    if (!field) continue;
    if (field.const !== undefined && typeof field.const === 'string') {
      return { property: name, value: field.const };
    }
    if (field.enum && field.enum.length === 1 && typeof field.enum[0] === 'string') {
      return { property: name, value: field.enum[0] };
    }
  }

  // Fall back to any property with a const or single-value enum
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!field) continue;
    if (field.const !== undefined && typeof field.const === 'string') {
      return { property: name, value: field.const };
    }
    if (field.enum && field.enum.length === 1 && typeof field.enum[0] === 'string') {
      return { property: name, value: field.enum[0] };
    }
  }

  return null;
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

  // Direct object with a discriminant const field
  if (propSchema.type === 'object' && hasDiscriminantConstField(propSchema) !== null) return true;

  // oneOf with object + null (nullable resource)
  if (propSchema.oneOf) {
    return propSchema.oneOf.some((v) => v.type === 'object' && hasDiscriminantConstField(v) !== null);
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
    const objectVariant = propSchema.oneOf.find((v) => v.type === 'object' && hasDiscriminantConstField(v) !== null);

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

function extractDirectResource(
  schema: SchemaObject,
  contextName: string,
  componentSchemas?: Record<string, SchemaObject>,
): ResponseExtractionResult {
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

  // allOf — merge into a single model. $ref branches are resolved against
  // component schemas so the referenced model's fields are merged rather
  // than silently dropped.
  if (schema.allOf) {
    const mergedProperties: Record<string, SchemaObject | undefined> = {};
    const mergedRequired: string[] = [];
    const unresolvedRefs: string[] = [];
    const seenRefs = new Set<string>();
    let mergedRefFields = false;

    const mergeSubSchemas = (subs: SchemaObject[]) => {
      for (const sub of subs) {
        let resolved: SchemaObject = sub;
        if (sub.$ref) {
          if (seenRefs.has(sub.$ref)) continue;
          seenRefs.add(sub.$ref);
          const segments = sub.$ref.split('/');
          const refName = segments[segments.length - 1];
          const refSchema = refName ? componentSchemas?.[refName] : undefined;
          if (!refSchema) {
            unresolvedRefs.push(sub.$ref);
            continue;
          }
          resolved = refSchema;
          mergedRefFields = true;
        }
        if (resolved.allOf) mergeSubSchemas(resolved.allOf);
        if (resolved.properties) Object.assign(mergedProperties, resolved.properties);
        if (resolved.required) mergedRequired.push(...resolved.required);
      }
    };
    mergeSubSchemas(schema.allOf);

    // An unresolvable $ref branch (no component schema map) would drop the
    // referenced model's fields entirely — prefer the referenced model as
    // the response type over a merge that silently guts it.
    if (unresolvedRefs.length === 1 && !mergedRefFields) {
      return {
        response: schemaToTypeRef({ $ref: unresolvedRefs[0] }, contextName),
        inlineModels,
        isPaginated: false,
      };
    }

    if (Object.keys(mergedProperties).length > 0) {
      const merged: SchemaObject = { type: 'object', properties: mergedProperties, required: mergedRequired };
      // Fields merged from a $ref carry the referenced model's const
      // discriminant (e.g. object: 'magic_auth'); deriving the name from it
      // would collide with the component model, so keep the context name.
      const modelName = mergedRefFields ? toPascalCase(contextName) : deriveModelName(merged, contextName);
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
  if (!schema.properties) return toPascalCase(fallback);

  // Prefer well-known discriminant properties for backward compatibility
  const preferred = ['object', 'type'];
  for (const name of preferred) {
    const field = schema.properties[name];
    if (field && field.const && typeof field.const === 'string') {
      return toPascalCase(field.const);
    }
  }

  // Fall back to any property with a const string value
  for (const [, field] of Object.entries(schema.properties)) {
    if (field && field.const && typeof field.const === 'string') {
      return toPascalCase(field.const);
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
