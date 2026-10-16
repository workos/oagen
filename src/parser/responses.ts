import type { TypeRef, Model, Field } from '../ir/types.js';
import { toPascalCase } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import {
  schemaToTypeRef,
  buildFieldFromSchema,
  constraintsEntry,
  deprecatedEntry,
  extractConstraints,
  isInlineObjectSchema,
} from './schemas.js';
import type { EnvelopeCompanion } from './envelope-companion-names.js';
import { collectProperties, extractInlineModelsFromProperties } from './inline-models.js';

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
  /**
   * Models lifted from inline companion objects, still under their
   * operation-qualified names. They are deliberately not in `inlineModels`:
   * `resolveEnvelopeCompanionNames` decides their final names once every list
   * operation has been extracted.
   */
  envelopeCompanions?: EnvelopeCompanion[];
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
    return extractListResponse(schema, contextName, envelope.dataPath!, componentSchemas);
  }

  // 3. Check for single-resource wrapper ({ resource_name: { object: "...", ... } })
  if (isSingleResourceWrapper(schema)) {
    return extractWrappedResource(schema, contextName, componentSchemas);
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

function extractListResponse(
  schema: SchemaObject,
  contextName: string,
  dataPath: string,
  componentSchemas?: Record<string, SchemaObject>,
): ResponseExtractionResult {
  let itemTypeRef: TypeRef = { kind: 'primitive', type: 'string' };
  const inlineModels: Model[] = [];

  const { properties, required } = collectEnvelopeProperties(schema, componentSchemas);

  const dataProp = properties[dataPath];
  if (dataProp?.type === 'array' && dataProp.items) {
    const items = dataProp.items;
    if (items.$ref) {
      itemTypeRef = schemaToTypeRef(items, contextName);
    } else if (items.type === 'object' && items.properties) {
      const itemName = contextName.replace(/Response$/, '') + 'Item';
      itemTypeRef = { kind: 'model', name: itemName };
      inlineModels.push(...extractInlineModel(itemName, items, componentSchemas));
    }
  }

  // Everything the envelope carries besides the data array: the pagination
  // companion (`list_metadata`, `pagination`, `has_more`, …) and any
  // discriminant such as `object: "list"`. Without these an emitter cannot
  // type the endpoint's actual response or read the next-page details.
  const { envelopeFields, envelopeCompanions } = extractEnvelopeCompanions(
    properties,
    required,
    dataPath,
    contextName.replace(/Response$/, ''),
    componentSchemas,
  );

  return {
    response: { kind: 'array', items: itemTypeRef },
    inlineModels,
    isPaginated: true,
    dataPath,
    itemType: itemTypeRef,
    envelopeFields,
    envelopeCompanions: envelopeCompanions.length > 0 ? envelopeCompanions : undefined,
  };
}

/**
 * Every property the envelope declares, merged across its `allOf` branches,
 * with the `required` lists that go with them.
 *
 * A `$ref` branch is resolved against the component schemas so fields an
 * envelope inherits from a shared base (`trace_id` on every response, say)
 * are not silently dropped. A property declared by more than one branch keeps
 * both declarations' shape when both are inline objects — `pagination.next`
 * from one branch and `pagination.total` from another both belong to the
 * response — and otherwise takes the later declaration, as `allOf` merging
 * does elsewhere in the parser.
 */
function collectEnvelopeProperties(
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
): { properties: Record<string, SchemaObject>; required: string[] } {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];
  const seenRefs = new Set<string>();

  const visit = (s: SchemaObject): void => {
    if (s.$ref) {
      if (seenRefs.has(s.$ref)) return;
      seenRefs.add(s.$ref);
      const refName = s.$ref.split('/').pop();
      const resolved = refName ? componentSchemas?.[refName] : undefined;
      if (resolved) visit(resolved);
      return;
    }
    for (const sub of s.allOf ?? []) visit(sub);
    for (const [key, prop] of Object.entries(s.properties ?? {})) {
      if (!prop) continue;
      const existing = properties[key];
      properties[key] = existing ? mergePropertyDeclarations(existing, prop) : prop;
    }
    if (s.required) required.push(...s.required);
  };
  visit(schema);

  return { properties, required };
}

/**
 * Combine two `allOf` declarations of one property. Inline objects merge their
 * fields; an array keeps the earlier `items` when the later declaration only
 * constrains it (`minItems: 1`), so `data: User[]` is not downgraded to
 * `string[]`; anything else takes the later declaration.
 */
function mergePropertyDeclarations(earlier: SchemaObject, later: SchemaObject): SchemaObject {
  if (isInlineObjectSchema(earlier) && isInlineObjectSchema(later)) {
    return {
      ...earlier,
      ...later,
      properties: { ...earlier.properties, ...later.properties },
      required: [...(earlier.required ?? []), ...(later.required ?? [])],
    };
  }
  if (earlier.type === 'array' && later.type === 'array') {
    return { ...earlier, ...later, items: later.items ?? earlier.items };
  }
  return later;
}

/**
 * Type a list envelope's companion properties as fields, lifting any inline
 * object among them (and anything nested inside it) to a model.
 *
 * Models come from `extractInlineModelsFromProperties`, the extractor that
 * mirrors `schemaToTypeRef` form for form — plain, nullable and `allOf`
 * objects, arrays of objects, and every `oneOf`/`anyOf` object variant — so a
 * field's reference always has a model behind it.
 *
 * Each companion is extracted twice: once under the operation's name, which
 * is how its models enter the IR (`ListUsersListMetadata`), and once under no
 * parent, which yields the name each model would carry if named from its
 * property alone (`ListMetadata`). Both runs walk the same code path, so the
 * two model lists line up index for index. `resolveEnvelopeCompanionNames`
 * later picks, per companion, which of the two names survives — the bare one
 * only where every copy of that companion across the API agrees structurally.
 */
function extractEnvelopeCompanions(
  properties: Record<string, SchemaObject>,
  required: string[],
  dataPath: string,
  operationName: string,
  componentSchemas?: Record<string, SchemaObject>,
): { envelopeFields: Field[]; envelopeCompanions: EnvelopeCompanion[] } {
  const envelopeFields: Field[] = [];
  const envelopeCompanions: EnvelopeCompanion[] = [];
  const requiredSet = new Set(required);
  // The companion is extracted from a one-property schema, so hand the
  // extractor the envelope's full property list: array items and map values
  // must step aside from a singular sibling exactly as the field does.
  const siblings = collectProperties({ properties });

  for (const [key, propSchema] of Object.entries(properties)) {
    if (key === dataPath) continue;
    const field = buildFieldFromSchema(key, propSchema, operationName, requiredSet, componentSchemas, siblings);
    envelopeFields.push(field);

    // Both runs get the component map so a companion's `$ref` fields carry
    // the component's example in the qualified and bare copies alike; it
    // only feeds field metadata, so the two model lists still line up.
    const single: SchemaObject = { type: 'object', properties: { [key]: propSchema } };
    const models: Model[] = [];
    extractInlineModelsFromProperties(single, models, operationName, componentSchemas, siblings);
    if (models.length === 0) continue;
    const bare: Model[] = [];
    extractInlineModelsFromProperties(single, bare, undefined, componentSchemas, siblings);
    envelopeCompanions.push({ field, models, bareNames: bare.map((m) => m.name) });
  }

  return { envelopeFields, envelopeCompanions };
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

function extractWrappedResource(
  schema: SchemaObject,
  contextName: string,
  componentSchemas?: Record<string, SchemaObject>,
): ResponseExtractionResult {
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
      inlineModels.push(...extractInlineModel(modelName, objectVariant, componentSchemas));

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
  inlineModels.push(...extractInlineModel(modelName, propSchema, componentSchemas));

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
    inlineModels.push(...extractInlineModel(modelName, schema, componentSchemas));
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
      // Carry the wrapper's limits, conjoined with its inline members', so the
      // rebuilt schema still declares what an instance must satisfy.
      const merged: SchemaObject = {
        type: 'object',
        properties: mergedProperties,
        required: mergedRequired,
        // The wrapper's own flag, as for a component `allOf` model.
        ...deprecatedEntry(schema),
        ...extractConstraints(schema),
      };
      // Fields merged from a $ref carry the referenced model's const
      // discriminant (e.g. object: 'magic_auth'); deriving the name from it
      // would collide with the component model, so keep the context name.
      const modelName = mergedRefFields ? toPascalCase(contextName) : deriveModelName(merged, contextName);
      inlineModels.push(...extractInlineModel(modelName, merged, componentSchemas));
      return {
        response: { kind: 'model', name: modelName },
        inlineModels,
        isPaginated: false,
      };
    }
  }

  // oneOf — delegate to schemaToTypeRef (returns union) and materialize the
  // inline object variants through the field extractor, as a field of this
  // name under no parent: it names them exactly as the union below references
  // them (`nameInlineVariants` from the context name — `GetThingResponse`,
  // `GetThingResponseWithSide`, `SquareGetThingResponse`), covers a nullable
  // (`type: ['object', 'null']`) or multi-type variant that a plain
  // `type === 'object'` test would skip, and recurses into everything nested
  // under each variant, so the response never references a model the parser
  // did not create.
  if (schema.oneOf) {
    extractInlineModelsFromProperties(
      { properties: { [contextName]: schema } },
      inlineModels,
      undefined,
      componentSchemas,
    );
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
      inlineModels.push(...extractInlineModel(itemName, items, componentSchemas));
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
 * Materialise an inline response object (and every nested inline object
 * under it) as models. `componentSchemas` only feeds `buildFieldFromSchema`,
 * so a response field that `$ref`s a component takes the component's
 * `example`/`examples` exactly as a request-body or component-model field
 * does; nested models get the same map so the fallback reaches every level.
 */
function extractInlineModel(
  name: string,
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
): Model[] {
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];
  const properties = schema.properties ?? {};
  const nestedModels: Model[] = [];

  const siblings = collectProperties(schema);
  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet, componentSchemas, siblings));
  }

  // Every nested inline model a field references — an inline object, array
  // items, map values, an `allOf` merge or `$ref` augmentation, every
  // `oneOf`/`anyOf` variant (numbered, const-prefixed, nullable, multi-type,
  // with `<Variant>Item` members), with sibling-aware item/value names —
  // comes from the same extractor that materializes them for component
  // schemas and request bodies. `buildFieldFromSchema` above named the
  // references through `schemaToTypeRef`; this names the models the same way,
  // so they agree by construction instead of through a response-local copy of
  // the rules.
  extractInlineModelsFromProperties(schema, nestedModels, name, componentSchemas);

  return [
    { name, description: schema.description, fields, ...deprecatedEntry(schema), ...constraintsEntry(schema) },
    ...nestedModels,
  ];
}
