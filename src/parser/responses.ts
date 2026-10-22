import type { TypeRef, Model, Field, PaginationEndOfIteration, StatusRange } from '../ir/types.js';
import { toPascalCase, singularize } from '../utils/naming.js';
import {
  detectEndOfIteration,
  END_OF_ITERATION_FIELDS,
  looksLikePaginationMetadata,
  resolveBareSchema,
  resolveSchemaPath,
} from './pagination.js';
import type { SchemaObject } from './schemas.js';
import {
  schemaToTypeRef,
  buildFieldFromSchema,
  constraintsEntry,
  deprecatedEntry,
  extractConstraints,
  isArrayComponentRef,
  isArraySchema,
  isInlineObjectSchema,
  collapsedNullableBranch,
} from './schemas.js';
import type { EnvelopeCompanion } from './envelope-companion-names.js';
import { collectProperties, extractInlineModelsFromProperties } from './inline-models.js';
import { externalDocsEntry } from './external-docs.js';

export interface ResponseExtractionResult {
  /** The TypeRef to use as the operation's response type */
  response: TypeRef;
  /** Any inline models discovered during extraction (to merge into ir.models) */
  inlineModels: Model[];
  /** Whether this response indicates a paginated list */
  isPaginated: boolean;
  /** Path to the data array within the response envelope (e.g., 'data') */
  dataPath?: string;
  /**
   * The data array property's own description (see
   * `PaginationMeta.dataDescription`). Set only for a list envelope whose
   * data property declares one.
   */
  dataDescription?: string;
  /** TypeRef of individual items in a paginated list */
  itemType?: TypeRef;
  /**
   * The envelope's properties other than the data array (see
   * `PaginationMeta.envelopeFields`). Set only for a list envelope.
   */
  envelopeFields?: Field[];
  /**
   * The envelope field that ends an iteration, when the envelope declares an
   * obvious one (see `PaginationMeta.endOfIteration`). Set only for a list
   * envelope.
   */
  endOfIteration?: PaginationEndOfIteration;
  /**
   * Models lifted from inline companion objects, still under their
   * operation-qualified names. They are deliberately not in `inlineModels`:
   * `resolveEnvelopeCompanionNames` decides their final names once every list
   * operation has been extracted.
   */
  envelopeCompanions?: EnvelopeCompanion[];
}

export interface ResponseClassificationOptions {
  /**
   * The operation's pagination was switched off explicitly (`strategy:
   * 'none'`). A list envelope is then not unwrapped: the body becomes a plain
   * response model carrying every field, exactly as a non-list body does, so
   * the wire shape survives without a `pagination` entry to describe it.
   */
  paginationDisabled?: boolean;
  /**
   * An explicit `dataPath` (already known to reach an array in the body) that
   * names another array than the one a list envelope would be unwrapped on.
   * Detection was wrong for this operation, so the envelope is kept as a
   * wrapper exactly as under `paginationDisabled` — `response` is what the
   * wire returns, the override says where the items are in it, and the
   * wrapper carries the companions — except that its stop field is still
   * read, with the override's root property as the data property.
   */
  dataPathOverride?: string;
}

/**
 * The word that stands in for a range key wherever a status code would
 * qualify a name: the inline body model of a `4XX` response is
 * `<Op>ClientErrorResponse`, its header models and enums `…ClientError`.
 * The key itself cannot be used — `toPascalCase('4XX')` is `4Xx`.
 */
export const STATUS_RANGE_LABELS: Record<StatusRange, string> = {
  '1XX': 'Informational',
  '2XX': 'Success',
  '3XX': 'Redirect',
  '4XX': 'ClientError',
  '5XX': 'ServerError',
};

/**
 * What a Responses Object key names. OpenAPI defines four kinds of key:
 * `default`; an HTTP status code, exactly three digits in 100–599; a range,
 * `1XX`–`5XX` in either case; and an `x-` specification extension. The
 * whole key decides, never a numeric prefix: `6XX`, `4XXX`, `20X`, `600`,
 * `099` and `200 ` are `unrecognized`, like `error` or `Default`.
 */
export type ResponseKey =
  | { kind: 'status'; code: number }
  | { kind: 'range'; range: StatusRange }
  | { kind: 'default' }
  | { kind: 'extension' }
  | { kind: 'unrecognized' };

/**
 * Classify a Responses Object key. Every reader of a Responses Object —
 * an operation's responses, the const prefixes it reserves, a webhook's
 * responses — goes through here, so a key is a status code in one place or
 * in none.
 */
export function classifyResponseKey(key: string): ResponseKey {
  if (key === 'default') return { kind: 'default' };
  if (key.startsWith('x-')) return { kind: 'extension' };
  if (/^[1-5]\d{2}$/.test(key)) return { kind: 'status', code: Number(key) };
  if (/^[1-5]XX$/i.test(key)) return { kind: 'range', range: key.toUpperCase() as StatusRange };
  return { kind: 'unrecognized' };
}

/**
 * Warn about a Responses Object key OpenAPI does not define, which the
 * caller then ignores rather than drops silently. `label` names the
 * operation or webhook the key sits on.
 */
export function warnUnrecognizedResponseKey(key: string, label: string): void {
  console.warn(
    `[oagen] Warning: Ignoring response key "${key}" on ${label}: not a status code (three digits, 100–599), a 1XX–5XX range, or "default"`,
  );
}

export function classifyAndExtractResponse(
  schema: SchemaObject,
  contextName: string,
  componentSchemas?: Record<string, SchemaObject>,
  options: ResponseClassificationOptions = {},
): ResponseExtractionResult {
  // 1. If schema is a $ref, resolve to model name (Phase 1)
  if (schema.$ref) {
    return { response: schemaToTypeRef(schema, contextName), inlineModels: [], isPaginated: false };
  }

  // 2. Check for list envelope (structural detection: array prop + non-array companion)
  if (!options.paginationDisabled) {
    const envelope = detectListEnvelope(schema);
    if (envelope.isEnvelope) {
      const override = options.dataPathOverride;
      if (override === undefined || override === envelope.dataPath) {
        return extractListResponse(schema, contextName, envelope.dataPath!, componentSchemas);
      }
      // The full path is excluded, not its root: a stop field beside the
      // nested array (`pagination.has_more` next to `pagination.items`) stays
      // visible, and the array itself is never a stop field.
      const { properties } = collectEnvelopeProperties(schema, componentSchemas);
      const endOfIteration = detectEndOfIteration(properties, override, componentSchemas);
      return {
        ...extractDirectResource(schema, contextName, componentSchemas),
        ...(endOfIteration && { endOfIteration }),
      };
    }
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

  // Find array properties (typed, nullable, or `items` with no `type` —
  // `isArraySchema` — or a `$ref` to an array component, which
  // `schemaToTypeRef` types as the array it declares) and non-array
  // companion properties
  const arrayProps: string[] = [];
  const nonArrayKeys: string[] = [];

  for (const [key, propSchema] of Object.entries(mergedProps)) {
    if (!propSchema) continue;
    if (isArraySchema(propSchema) || isArrayComponentRef(propSchema)) {
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

    // A companion is pagination metadata when it is one of the stop fields
    // the end-of-iteration detector reads (`hasMore`, `hasNext`, `pageCount`,
    // …) — one shared list, so an envelope that carries a stop field is
    // always recognized — or when its name contains one of the metadata
    // patterns (`meta`, `pagination`, `cursor`, …).
    const hasPaginationCompanion = nonArrayKeys.some(
      (key) => END_OF_ITERATION_FIELDS.includes(key) || looksLikePaginationMetadata(key),
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
  // The property's own text, as `buildFieldFromSchema` keeps it for every
  // companion beside it; an item schema's description belongs to the item.
  const dataDescription = dataProp?.description;
  // The data array's type when it is a `$ref` to an array component: the
  // array the component declares, with the component's own nullability.
  let dataType: TypeRef | undefined;
  if (dataProp && isArrayComponentRef(dataProp)) {
    // A `$ref` to an array component, under any nullable wrapper, is the
    // array the component declares, its items named under the component
    // (`<Component>Item…`) and already materialized by the component pass —
    // nothing is minted here, and `<Operation>Item` stays free.
    dataType = schemaToTypeRef(dataProp, contextName);
    const array = dataType.kind === 'nullable' ? dataType.inner : dataType;
    if (array.kind === 'array') itemTypeRef = array.items;
  } else if (dataProp && isArraySchema(dataProp) && dataProp.items) {
    const items = dataProp.items;
    const itemName = contextName.replace(/Response$/, '') + 'Item';
    if (items.$ref) {
      itemTypeRef = schemaToTypeRef(items, contextName);
    } else if (items.type === 'object' && items.properties) {
      itemTypeRef = { kind: 'model', name: itemName };
      inlineModels.push(...extractInlineModel(itemName, items, componentSchemas));
    } else {
      // Every other item shape — a primitive, an inline enum, a `oneOf`, a
      // nullable or untyped object, a nested array — is typed by
      // `schemaToTypeRef` as a field named `<Operation>Item` under no parent,
      // and whatever models it references are materialized by the field
      // extractor under that same name, so the two agree by construction
      // (the direct array path in `extractDirectResource` does the same).
      itemTypeRef = schemaToTypeRef(items, itemName);
      extractInlineModelsFromProperties(
        { properties: { [itemName]: items } },
        inlineModels,
        undefined,
        componentSchemas,
      );
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

  // The field that says the list is exhausted — `has_more`, `total_pages`,
  // `pagination.totalPages` — so an iterator can stop without a wasted request.
  const endOfIteration = detectEndOfIteration(properties, dataPath, componentSchemas);

  return {
    // The data array's own nullability is the response's: a `data` declared
    // `type: ['array', 'null']` (or OAS 3.0 `nullable: true`) means the list
    // the SDK returns may be null, so the wrapper `schemaToTypeRef` would give
    // the field stays on `response` — `envelopeFields` leaves `data` out, so
    // nothing else records it — while `itemType` is still what an iterator
    // yields (`paginatedItemType` unwraps the same wrapper). A `$ref` to an
    // array component carries the component's nullability the same way.
    response:
      dataType ??
      (dataProp ? nullableIf(dataProp, { kind: 'array', items: itemTypeRef }) : { kind: 'array', items: itemTypeRef }),
    inlineModels,
    isPaginated: true,
    dataPath,
    ...(dataDescription !== undefined && { dataDescription }),
    itemType: itemTypeRef,
    envelopeFields,
    endOfIteration,
    envelopeCompanions: envelopeCompanions.length > 0 ? envelopeCompanions : undefined,
  };
}

/**
 * Element type of the array an explicit `dataPath` points at, read from the
 * response document when the IR cannot answer — a `$ref` wrapper whose path
 * runs through a model the parser has not materialized (an array
 * component's, say), or an envelope the parser did not recognize — and the
 * check `extractResponses` makes before classifying a body, to learn whether
 * the path reaches an array at all. `undefined` when it does not.
 *
 * The array may sit under a nullable wrapper of any form — `type: ['array',
 * 'null']`, OAS 3.0 `nullable: true`, `oneOf: [{ type: 'array' }, { type:
 * 'null' }]`, a nullable `$ref` to an array component — which
 * `resolveBareSchema` looks through exactly as the IR walk
 * (`resolveDataPathItemType`) looks through the `nullable` TypeRef those
 * forms become, so the two never disagree about whether the path lands on
 * an array; `isArraySchema` then decides, as every other site does.
 *
 * The items are typed and materialized the way every other inline schema
 * that is not a model field is (`extractListResponse`'s fall-through, the
 * header and fallback-body paths): as a field named for the path
 * (`result.items` → `ListPetsResultItem`, `records` → `ListPetsRecord`; see
 * `inlineItemNameForPath`) under no parent, typed by `schemaToTypeRef` and
 * extracted by `extractInlineModelsFromProperties`, which mirror each other
 * form for form. A `$ref` is a reference and mints nothing; a plain object
 * is that model; a nullable object (`type: ['object', 'null']`, OAS 3.0
 * `nullable: true`, a nullable `oneOf`) is a `nullable` reference to it; the
 * object variants of a union, the objects of a nested array or map, and
 * whatever those reference in turn are each materialized under the name the
 * reference uses — so the item type never names a model nobody created.
 */
export function resolveDataPathFromSchema(
  schema: SchemaObject,
  dataPath: string,
  contextName: string,
  componentSchemas?: Record<string, SchemaObject>,
): { itemType: TypeRef; inlineModels: Model[] } | undefined {
  const target = resolveSchemaPath(schema, dataPath, componentSchemas);
  if (!target) return undefined;
  const array = resolveBareSchema(target, componentSchemas);
  if (!isArraySchema(array) || !array.items) return undefined;

  const items = array.items;
  const itemName = inlineItemNameForPath(contextName, dataPath);
  const inlineModels: Model[] = [];
  extractInlineModelsFromProperties({ properties: { [itemName]: items } }, inlineModels, undefined, componentSchemas);
  return { itemType: schemaToTypeRef(items, itemName), inlineModels };
}

/**
 * Name for inline items reached through an overridden `dataPath`, built from
 * the path the way the inline extractor names a nested field's items: the
 * operation, the enclosing properties, then the singular of the array's own
 * name (`result.items` → `ListPetsResultItem`). It therefore coincides with a
 * model the parser may already have minted for that field, and never takes
 * the bare `<Op>Item` that a recognized envelope's data array owns.
 */
function inlineItemNameForPath(contextName: string, dataPath: string): string {
  const segments = dataPath.split('.');
  const parents = segments
    .slice(0, -1)
    .map((segment) => toPascalCase(segment))
    .join('');
  const own = singularize(toPascalCase(segments[segments.length - 1]));
  return contextName.replace(/Response$/, '') + parents + own;
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
  if (isArraySchema(earlier) && isArraySchema(later)) {
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
      // `oneOf: [object, null]` is a nullable wrapper: the model built from
      // its one branch takes the wrapper's `deprecated` and limits, as every
      // other nullable unwrap gives it (`collapsedNullableBranch`); a
      // multi-variant union's variant is built as written.
      const source = collapsedNullableBranch(propSchema) ?? objectVariant;
      inlineModels.push(...extractInlineModel(modelName, source, componentSchemas));

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
      // rebuilt schema still declares what an instance must satisfy, and the
      // wrapper's own link, as a component `allOf` model carries it; a
      // member's stays on that member (a `$ref` member's on its component).
      const merged: SchemaObject = {
        type: 'object',
        properties: mergedProperties,
        required: mergedRequired,
        // The wrapper's own flag, as for a component `allOf` model.
        ...deprecatedEntry(schema),
        ...extractConstraints(schema),
        ...externalDocsEntry(schema.externalDocs),
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

  // Array — `type: 'array'`, a nullable array (`type: ['array', 'null']`,
  // OAS 3.0 `nullable: true`) or, since JSON Schema does not require `type`
  // beside `items`, bare `items`: `isArraySchema`, which is what
  // `classifyInlineSchema` — the one precedence `schemaToTypeRef` follows —
  // answers once the nullable type list is unwrapped. So `items` with no
  // `type` is an array here as it is there, or the reference it produces
  // names an item model nobody creates (`array<ListThingsResponse>` with no
  // `ListThingsResponse`); and `items` beside a `oneOf` / `anyOf` (a nullable
  // array) or an `allOf` that types the schema is not, `type: 'array'` or
  // not, so it falls through to the path below, or the composition — the
  // null — is lost. Inline object items become `<Operation>Item`, with the
  // nullable wrapper `schemaToTypeRef` would give the array. Anything else
  // the items may reference — the inline object variants of an `items.oneOf`,
  // the objects of a nested array or map — and `$ref` items, even with
  // sibling `properties` beside the `$ref`, take the fall-through, which
  // keeps the reference as `schemaToTypeRef` does and materializes the rest
  // under the names it gives them.
  if (isArraySchema(schema) && schema.items) {
    const items = schema.items;
    if (!items.$ref && items.properties && (items.type === 'object' || !items.type)) {
      const itemName = contextName.replace(/Response$/, '') + 'Item';
      inlineModels.push(...extractInlineModel(itemName, items, componentSchemas));
      return {
        response: nullableIf(schema, { kind: 'array', items: { kind: 'model', name: itemName } }),
        inlineModels,
        isPaginated: false,
      };
    }
  }

  // Anything else is typed by schemaToTypeRef (primitive, union, map, array
  // of unions, nullable object, …). Such a TypeRef can still reach an inline
  // model — a map whose values are an inline object (`additionalProperties`),
  // an array whose items are a union of inline objects, a nullable
  // `type: ['object', 'null']` object, a map of arrays of objects — so
  // materialize them the way the oneOf branch does: as a field of this name
  // under no parent, which names every nested model exactly as the TypeRef
  // references it. The oneOf branch may already have pushed some of them, so
  // dedupe by name.
  const nested: Model[] = [];
  extractInlineModelsFromProperties({ properties: { [contextName]: schema } }, nested, undefined, componentSchemas);
  const known = new Set(inlineModels.map((m) => m.name));
  for (const model of nested) {
    if (known.has(model.name)) continue;
    known.add(model.name);
    inlineModels.push(model);
  }
  return {
    response: schemaToTypeRef(schema, contextName),
    inlineModels,
    isPaginated: false,
  };
}

/**
 * Wrap `ref` in `nullable` when `schemaToTypeRef` would wrap the schema's
 * own type: an OAS 3.1 type list naming `null` (`type: ['array', 'null']`)
 * or an OAS 3.0 `nullable: true` beside a `type`. For the one place the
 * response path builds an array TypeRef itself instead of delegating.
 */
function nullableIf(schema: SchemaObject, ref: TypeRef): TypeRef {
  const nullable =
    (Array.isArray(schema.type) && schema.type.includes('null')) ||
    (schema.nullable === true && schema.type !== undefined);
  return nullable ? { kind: 'nullable', inner: ref } : ref;
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
    {
      name,
      description: schema.description,
      ...externalDocsEntry(schema.externalDocs),
      fields,
      ...deprecatedEntry(schema),
      ...constraintsEntry(schema),
    },
    ...nestedModels,
  ];
}
