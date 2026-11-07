import type { TypeRef, Model, Field, PaginationEndOfIteration, StatusRange } from '../ir/types.js';
import { numberedName, toPascalCase, singularize } from '../utils/naming.js';
import {
  collectObjectProperties,
  detectEndOfIteration,
  endOfIterationProblem,
  END_OF_ITERATION_FIELDS,
  looksLikePaginationMetadata,
  readFlattenedUnion,
  resolveDataPathArray,
  spellsOneOf,
} from './pagination.js';
import type { SchemaObject } from './schemas.js';
import {
  arraySchemaOf,
  declaresNull,
  schemaToTypeRef,
  buildFieldFromSchema,
  classifyInlineSchema,
  constraintsEntry,
  deprecatedEntry,
  foldSiblingProperties,
  isArrayComponentRef,
  namesSeveralTypes,
  isArrayPointerRef,
  isNullSchema,
  collapsedNullableBranch,
  nullableAxisBranch,
  referenceTypesAsUnknown,
  typesAsUnknown,
  unionAxesOf,
  warnOnUncarriedProperties,
  withSchemaConstraints,
  withWrapperDocs,
} from './schemas.js';
import { isPendingVariant } from './schema-refs.js';
import type { EnvelopeCompanion } from './envelope-companion-names.js';
import {
  collectProperties,
  combineDeclarations,
  extractInlineModelsFromProperties,
  mergeAllOfMembers,
  mergedObjectSchema,
  readInlineAllOf,
  unionOfDeclarations,
  unwrappedAllOfMember,
} from './inline-models.js';
import { externalDocsEntry } from './external-docs.js';
import { schemaExtensionsEntry } from './extensions.js';
import { materializeInlineSchema, type InlineModelRegistry } from './materialize-inline.js';

/**
 * What settles an array body's or list envelope's item models against the
 * names already decided (see `typeInlineItems`): the spec-wide registry of
 * model shapes the operations fill as they are read, and the operation to
 * record this body's models under.
 */
export interface ItemSettlement {
  registry: InlineModelRegistry;
  operation: string;
}

export interface ResponseExtractionResult {
  /** The TypeRef to use as the operation's response type */
  response: TypeRef;
  /** Any inline models discovered during extraction (to merge into ir.models) */
  inlineModels: Model[];
  /** Whether this response indicates a paginated list */
  isPaginated: boolean;
  /**
   * Set when the body is a list envelope detection recognized but did not
   * unwrap because nothing pages it (`paginationDisabled`): it was read as
   * any other body, a plain response model carrying every field. The caller
   * warns about an envelope kept for want of a paging parameter; one kept by
   * `strategy: 'none'` was asked for.
   */
  unpagedEnvelope?: boolean;
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
   * The field that ends an iteration, when the body declares an obvious one
   * (see `PaginationMeta.endOfIteration`): read beside the array a list
   * envelope was unwrapped on, and beside the array an explicit `dataPath`
   * names in a body kept as a wrapper — a `$ref` to a component, an envelope
   * detection would unwrap on another array, an inline body detection did
   * not recognize (`bodyEndOfIteration`). Unset for every other body.
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
   * Nothing will page the operation: its pagination was switched off
   * explicitly (`strategy: 'none'`), or no query parameter it declares
   * drives an iterator and no override names one. A list envelope is then
   * not unwrapped: the body becomes a plain response model carrying every
   * field, exactly as a non-list body does, so the wire shape survives
   * without a `pagination` entry to describe it (`unpagedEnvelope` says it
   * was an envelope).
   */
  paginationDisabled?: boolean;
  /**
   * An explicit `dataPath`, already known to reach an array in the body. One
   * that restates the path a list envelope is unwrapped on changes nothing.
   * Any other keeps the body as the wrapper the override iterates — a
   * recognized envelope, kept exactly as under `paginationDisabled` since
   * detection was wrong for this operation; an inline body detection did not
   * recognize; a `$ref` to a component — so `response` is what the wire
   * returns, the override says where the items are in it, and the wrapper
   * carries the companions. The wrapper's stop field is still read, keyed by
   * the override, whatever the wrapper is (`bodyEndOfIteration`). Read only
   * when `paginationDisabled` is not set: `strategy: 'none'` leaves no
   * iterator to stop.
   */
  dataPathOverride?: string;
  /**
   * With it, the items of an array body or a list envelope are typed under
   * the first `<Op>Item` candidate the registry does not give another shape,
   * and an identical shape shares the model it finds (`typeInlineItems`).
   * Absent — the dry run that reads a component response's names, a direct
   * call — the items take `<Op>Item` as written; the dry run that reads an
   * operation's own names settles them against a copy of the registry
   * (`operationBodyModelNames`), so it reads the name the operation takes.
   */
  settle?: ItemSettlement;
}

/**
 * The readings an inline body can take, one per way `buildOperation` decides
 * it (`iteratorSource`): unwrapped on its data array for an iterator a
 * declared query parameter or a usable override drives, or kept as the wire
 * shape — `strategy: 'none'`, nothing to page with, an explicit `dataPath`
 * naming another array (the same reading as `paginationDisabled`, so the
 * same names). A body that is no list envelope reads the same under both.
 * Which reading an operation takes is known only when it is read, so a dry
 * run that reserves a body's names (`bodyModelNames`) classifies it under
 * every reading here: whichever the operation then picks, the names it mints
 * are the reserved ones.
 */
export const BODY_READINGS: readonly ResponseClassificationOptions[] = [{}, { paginationDisabled: true }];

/**
 * The word that stands in for a range key wherever a status code would
 * qualify a name: the header models and enums of a `4XX` response are
 * `…ClientError`, and the inline body of a `1XX`–`3XX` response is
 * `<Op><Label>Response` (`<Op>SuccessResponse`), as a `default` body is
 * `<Op>DefaultResponse`. The key itself cannot be used in these names —
 * `toPascalCase('4XX')` is `4Xx`. The inline body of a `4XX` or `5XX`
 * response is an error body (`isErrorStatusRange`), named `<Op>Error4Xx`
 * from the key itself, as a 404's is `<Op>Error404`.
 */
export const STATUS_RANGE_LABELS: Record<StatusRange, string> = {
  '1XX': 'Informational',
  '2XX': 'Success',
  '3XX': 'Redirect',
  '4XX': 'ClientError',
  '5XX': 'ServerError',
};

/**
 * Whether a range response is an error response: `4XX` and `5XX` are, as
 * every status code they cover is an error (400–599); `1XX`–`3XX` are not.
 * The one answer for every place a range body is named: its inline body is
 * named and stepped as an explicit error status code's body is
 * (`<Op>Error4Xx`, then `<Op>Error4XxBody`; `<Op>Error4Xx<MediaType>` under
 * a secondary media type), while a `1XX`–`3XX` body keeps the range's label
 * (`<Op>SuccessResponse`).
 */
export function isErrorStatusRange(range: StatusRange): boolean {
  return range === '4XX' || range === '5XX';
}

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
  const body = classifyBody(schema, contextName, componentSchemas, options);
  // Under an explicit `dataPath`, a body that was not unwrapped on that path
  // is the wrapper the override iterates — a `$ref` to a component, an
  // envelope detection would unwrap on another array, an inline body
  // detection did not recognize — and its stop field is read here, once for
  // every such shape, keyed by the path. A path that restates the one the
  // envelope was unwrapped on (`isPaginated`) has had it read by
  // `extractListResponse`; under `paginationDisabled` there is no iterator
  // to stop.
  const override = options.dataPathOverride;
  if (override === undefined || options.paginationDisabled || body.isPaginated) return body;
  const endOfIteration = bodyEndOfIteration(schema, override, componentSchemas);
  return endOfIteration ? { ...body, endOfIteration } : body;
}

/**
 * The field that ends an iteration of a body kept as a wrapper under an
 * explicit `dataPath`, read beside the array the path names — the one
 * reader for every kept wrapper, whatever wraps it. The wrapper's
 * properties are collected exactly as a recognized envelope's are
 * (`collectObjectProperties`, which reads the body and every `allOf`
 * member, however deep, through `resolveBareSchema` — the resolver the path
 * walk uses — so a `$ref` body, a nullable wrapper around the body or
 * around any member, and a `$ref` chain to one all reach the same object
 * the path walked), and `detectEndOfIteration` reads them as it reads an
 * unwrapped envelope's: the fields beside the array the path names first,
 * under a parent of any name (`result.total_pages` next to `result.items`),
 * then those beside each object the path passes through, nearest the array
 * first, then the top level, then the metadata companions, and never the
 * array or an object on the path itself. The properties read are those
 * every instance carries (`onEveryInstance`): a member's, or every
 * variant's of a `oneOf`/`anyOf` the `allOf` flattens, so a stop field only
 * some variants declare — an optional field of the wrapper's model — ends no
 * iteration (workos/oagen#622). `undefined` when nothing recognizable is
 * declared, or the body resolves to no object at all.
 */
function bodyEndOfIteration(
  schema: SchemaObject,
  dataPath: string,
  componentSchemas?: Record<string, SchemaObject>,
): PaginationEndOfIteration | undefined {
  const { onEveryInstance } = collectObjectProperties(schema, componentSchemas);
  return detectEndOfIteration(onEveryInstance, dataPath, componentSchemas);
}

/**
 * Why an explicit `endOfIteration` cannot be read from `schema`, or
 * `undefined` when it can: the override's counterpart of
 * `bodyEndOfIteration`, over the very property map that reader collects
 * (`collectObjectProperties`, `onEveryInstance`: what every instance
 * carries, a stop field each variant of a flattened `oneOf` declares
 * included), so a field detection would read is one an override may name
 * and a field it would not see is not there for an override either;
 * `endOfIterationProblem` then walks the path and tests the type. `schema`
 * is the body as written — a `$ref`, an `allOf`, a nullable wrapper — or
 * `undefined` when the operation declares no body, which no path resolves
 * in.
 */
export function bodyEndOfIterationProblem(
  end: PaginationEndOfIteration,
  schema: SchemaObject | undefined,
  componentSchemas?: Record<string, SchemaObject>,
): string | undefined {
  const properties = schema && collectObjectProperties(schema, componentSchemas).onEveryInstance;
  return endOfIterationProblem(end, properties, componentSchemas);
}

/**
 * Classify one body: a `$ref` names its component; an inline body is a list
 * envelope — unwrapped on its data array, unless an explicit `dataPath`
 * names another array in it — a single-resource wrapper, or a plain model.
 */
function classifyBody(
  schema: SchemaObject,
  contextName: string,
  componentSchemas: Record<string, SchemaObject> | undefined,
  options: ResponseClassificationOptions,
): ResponseExtractionResult {
  // 1. If schema is a $ref, resolve to model name (Phase 1)
  if (schema.$ref) {
    return { response: schemaToTypeRef(schema, contextName), inlineModels: [], isPaginated: false };
  }

  // `properties` written beside a typing `allOf`/`oneOf`/`anyOf` are folded
  // into the composition, as `schemaToTypeRef` and the field extractor read
  // them (`foldSiblingProperties`), so a body is read the one way wherever it
  // appears: the branches below read `properties` before a composition and
  // would otherwise drop the composition that a field keeps. The variants
  // that cannot take the properties are reported on the body as written,
  // under the body's name, since the fold leaves `schemaToTypeRef` nothing
  // to report.
  warnOnUncarriedProperties(schema, contextName, undefined);
  schema = foldSiblingProperties(schema);

  // 2. Check for list envelope (structural detection: array prop + non-array companion)
  const envelope = detectListEnvelope(schema, componentSchemas);
  if (envelope.isEnvelope) {
    const override = options.dataPathOverride;
    if (!options.paginationDisabled && (override === undefined || override === envelope.dataPath)) {
      return extractListResponse(schema, contextName, envelope.dataPath!, componentSchemas, options.settle);
    }
    // A recognized envelope that is not unwrapped is kept as the wire shape,
    // one model carrying every field, whichever reason keeps it: nothing
    // pages the operation (`paginationDisabled` — `strategy: 'none'`, or no
    // declared query parameter and no usable override), or an explicit
    // `dataPath` names another array than the one it would be unwrapped on
    // (detection was wrong for this operation; its stop field is read by the
    // caller, `bodyEndOfIteration`). It never takes the single-resource
    // reading below: an envelope with one required companion carrying a
    // constant `type`/`object` (`{ data, pagination: { type: 'pagination',
    // total } }` with `required: ['pagination']`) fits that shape, and
    // unwrapping it would make the companion the whole response and drop
    // `data`. `unpagedEnvelope` tells the caller which reason kept it, so an
    // envelope kept for want of a paging parameter is warned about.
    const kept = extractDirectResource(schema, contextName, componentSchemas, options.settle);
    return options.paginationDisabled ? { ...kept, unpagedEnvelope: true } : kept;
  }

  // 3. Check for single-resource wrapper ({ resource_name: { object: "...", ... } })
  if (isSingleResourceWrapper(schema)) {
    return extractWrappedResource(schema, contextName, componentSchemas);
  }

  // 4. Direct resource or plain inline object
  return extractDirectResource(schema, contextName, componentSchemas, options.settle);
}

interface ListEnvelopeResult {
  isEnvelope: boolean;
  dataPath: string | null;
}

const KNOWN_DATA_PATHS = new Set(['data', 'items', 'results', 'records', 'entries', 'values', 'nodes', 'edges']);

/**
 * Whether an inline body is a list envelope — one array property beside a
 * companion that looks like pagination metadata — and the array it is
 * unwrapped on. The properties are read off the set the body's model is
 * built from: the `allOf` members' own `properties` and the body's own,
 * and what the variants of a `oneOf`/`anyOf` a member writes declare
 * (`readFlattenedUnion`, through the reader the model flattens a variant
 * with — its own properties, its `allOf` members, a `$ref` variant's
 * component; a union beside the `allOf` is one such member once folded,
 * `foldSiblingProperties`) — the model's optional fields, typed as it
 * types them (`unionOfDeclarations`) where no member declares the name,
 * since a variant can only narrow what every instance carries. So `{
 * allOf: [{ data }], oneOf: [{ has_more }, { has_more, total }] }` is the
 * envelope `{ data, has_more?, total? }` is (workos/oagen#622: the variants
 * were read by the model alone, and the body was that model, no list). The
 * array must be there whichever variant the wire sends — a member's, or
 * declared by every non-null variant (`carried`), as an explicit `dataPath`
 * is resolved through the union (`resolveDataPathArray`) — and it must be
 * the array the companion walk reads at that name
 * (`collectObjectProperties`, `onEveryInstance`), the one
 * `extractListResponse` unwraps on: a declaration a `$ref` member's
 * component or a nested `allOf` member makes — which detection does not
 * read — stands over the variants' there as in the model
 * (`declareProperty`: an always-applying declaration, typeless or not,
 * over a branch-only one), so `Base: { data: { description } }` beside
 * `oneOf: [{ data: integer[] }, …]` is no envelope but the model (PR #643
 * review round 3: it was unwrapped on an array the walk had no items for,
 * and the response was `string[]`), while `Base: { data: integer[] }` is
 * unwrapped on `Base`'s array — while a
 * companion may be any variant's: a stop field only some variants declare,
 * or one they type differently, still marks the envelope, as an optional
 * `has_more` written flat does, and `detectEndOfIteration` then finds no
 * field to stop on. A bare `oneOf`/`anyOf` body, with or without
 * `properties` beside it, is a union of models and never an envelope, and
 * so is an `allOf` the parser reads as its lone union member
 * (`readInlineAllOf`: `allOf: [{ oneOf: [...] }]`, with or without
 * annotations beside it, is that union, as `resolveBareSchema` reads it
 * for the companion walk and `extractDirectResource` for the model), so
 * the variants are read only for an `allOf` the parser merges (PR #643
 * review: a lone union member was read as a merge here, detected as an
 * envelope, and extracted off a walk that saw no field — `string[]` with
 * no companions). A `$ref` member — and whatever is written beside its
 * `$ref` (`{ $ref: Base, oneOf: [A, B] }`, `{ $ref: Base, properties }`),
 * which the model (`mergeAllOfMembers`) and the companion walk
 * (`collectObjectProperties`) ignore for the component the reference names
 * (PR #643 review round 2: a union beside the `$ref` was read here, so a
 * `data` every variant declared marked an envelope the walk had no `data`
 * in, and the response was `string[]`) — and a nullable wrapper a member
 * writes (`{ oneOf: [{ $ref: Base }, { type: 'null' }] }`, read as the
 * member by the companion walk and the model) are not read here, as
 * before: a body whose array or companion sits in one is the wrapper an
 * explicit `dataPath` keeps (workos/oagen#308).
 */
function detectListEnvelope(schema: SchemaObject, componentSchemas?: Record<string, SchemaObject>): ListEnvelopeResult {
  // Collect all property sources (allOf sub-schemas or flat schema), and
  // what the variants of a union among the members declare, for an `allOf`
  // the parser merges into one model.
  const propSources: Record<string, SchemaObject | undefined>[] = [];
  const branchOnly = new Map<string, SchemaObject[]>();
  const carried = new Set<string>();
  const merges =
    schema.allOf !== undefined &&
    classifyInlineSchema(schema) === 'allOf' &&
    readInlineAllOf(schema.allOf, schema, componentSchemas) === 'merged';
  for (const sub of schema.allOf ?? []) {
    // A `$ref` member is its component, whatever is written beside the
    // reference, as the model and the walk read it.
    if (sub.$ref) continue;
    if (sub.properties) propSources.push(sub.properties);
    if (!merges) continue;
    for (const variants of unionAxesOf(sub)) {
      if (nullableAxisBranch(sub, variants)) continue;
      const keyword = variants === sub.oneOf ? 'oneOf' : 'anyOf';
      const read = readFlattenedUnion({ schema: sub, keyword, variants, origin: null }, componentSchemas);
      for (const [name, declarations] of read.declared) {
        const held = branchOnly.get(name);
        if (held) held.push(...declarations);
        else branchOnly.set(name, [...declarations]);
        if (read.carried.has(name)) carried.add(name);
      }
    }
  }
  if (schema.properties) {
    propSources.push(schema.properties);
  }

  if (propSources.length === 0 && branchOnly.size === 0) return { isEnvelope: false, dataPath: null };

  // Merge all properties into a single view. A name two members declare is
  // settled as every `allOf` merge settles it (`combineDeclarations`): the
  // first declaration that declares a type, a typeless one only annotating
  // it, so `data: { type: 'array' }` beside a later `data: { description }`
  // is still the array detection looks for.
  const mergedProps: Record<string, SchemaObject> = {};
  for (const source of propSources) {
    for (const [key, prop] of Object.entries(source)) {
      if (!prop) continue;
      const existing = mergedProps[key];
      mergedProps[key] = existing ? combineDeclarations(existing, prop) : prop;
    }
  }
  // A name a member declares is on every instance; one only the variants
  // declare is typed as the model types it.
  const own = new Set(Object.keys(mergedProps));
  const onEveryInstance = (name: string): boolean => own.has(name) || carried.has(name);
  for (const [name, declarations] of branchOnly) {
    if (!own.has(name)) mergedProps[name] = unionOfDeclarations(declarations);
  }

  // Find array properties — typed, `items` with no `type`, or either under a
  // nullable wrapper of any spelling or an `allOf` read as its member
  // (`arraySchemaOf`), a `$ref` to an array component under such wrappers
  // (`isArrayComponentRef`), which `schemaToTypeRef` types as the array the
  // component declares, or a pointer deeper into a component that lands on
  // a schema typed as an array where it stands (`isArrayPointerRef`; #609),
  // which the settle types as that array — and non-array companion
  // properties
  const arrayProps: string[] = [];
  const nonArrayKeys: string[] = [];
  const isArrayDeclaration = (declaration: SchemaObject): boolean =>
    arraySchemaOf(declaration) !== undefined || isArrayComponentRef(declaration) || isArrayPointerRef(declaration);

  for (const [key, propSchema] of Object.entries(mergedProps)) {
    if (!propSchema) continue;
    if (isArrayDeclaration(propSchema)) {
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

    // The array an iterator unwraps on must be there whichever variant the
    // wire sends; one only some variants declare leaves the body the model
    // it is, the array an optional field of it.
    if (!onEveryInstance(arrayPropName)) return { isEnvelope: false, dataPath: null };
    // And it must be the array the companion walk reads at that name, the
    // one `extractListResponse` unwraps on: a declaration a `$ref` member's
    // component or a nested `allOf` member makes, which detection does not
    // read, stands over the variants' there as in the model, so a typeless
    // or object `data` in `Base` beside variants typing it `integer[]`
    // leaves the body the model it is.
    const walked = collectObjectProperties(schema, componentSchemas).onEveryInstance[arrayPropName];
    if (walked === undefined || !isArrayDeclaration(walked)) return { isEnvelope: false, dataPath: null };

    // A companion is pagination metadata when it is one of the stop fields
    // the end-of-iteration detector reads, in any spelling (`hasMore`,
    // `HasNext`, `page-count`, …: `spellsOneOf`, the test the detector
    // reads a stop field's name with) — one shared list and one test, so an
    // envelope that carries a stop field is always recognized — or when its
    // name, read in any spelling, contains one of the metadata patterns
    // (`meta`, `pagination`, `cursor`, …: `looksLikePaginationMetadata`, the
    // recognizer the nested stop-field scan shares, so `pageInfo` marks an
    // envelope exactly as `page_info` does and `pageInfo.hasNextPage` is
    // then read as its stop field).
    const hasPaginationCompanion = nonArrayKeys.some(
      (key) => spellsOneOf(key, END_OF_ITERATION_FIELDS) || looksLikePaginationMetadata(key),
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
  settle?: ItemSettlement,
): ResponseExtractionResult {
  let itemTypeRef: TypeRef = { kind: 'primitive', type: 'string' };
  const inlineModels: Model[] = [];

  // The envelope's fields are its model's (`fields`: a member's, and every
  // one the variants of a `oneOf`/`anyOf` the `allOf` flattens declare, as
  // optional fields); the array and the stop field are read among the
  // fields every instance carries (`onEveryInstance`), the ones detection
  // found the array in.
  const { fields, onEveryInstance, required } = collectObjectProperties(schema, componentSchemas);

  const dataProp = onEveryInstance[dataPath];
  // The property's own text, as `buildFieldFromSchema` keeps it for every
  // companion beside it; an item schema's description belongs to the item.
  const dataDescription = dataProp?.description;
  // The data array's type when it is a `$ref` typed as an array: the array
  // a component declares, with the component's own nullability, or the
  // array a pointer deeper into a component settles to.
  let dataType: TypeRef | undefined;
  if (dataProp && (isArrayComponentRef(dataProp) || isArrayPointerRef(dataProp))) {
    // A `$ref` to an array component, under any nullable wrapper, is the
    // array the component declares, its items named under the component
    // (`<Component>Item…`) and already materialized by the component pass —
    // nothing is minted here, and `<Operation>Item` stays free. A pointer
    // deeper into a component (#609) is a reference settled once every
    // model is built (`resolveSchemaPointers`), to the array the schema it
    // lands on is typed as where it stands, its items the model that
    // schema's items built (`HolderOwner` for `Holder/properties/owners`),
    // never a copy of it: until then the response is the pending reference,
    // and the item type is that very reference, so the settle rereads the
    // item type from the settled array (`visitOperation`), as it does for a
    // body that is the pointer.
    dataType = schemaToTypeRef(dataProp, contextName);
    const array = dataType.kind === 'nullable' ? dataType.inner : dataType;
    if (array.kind === 'array') itemTypeRef = array.items;
    else if (isPendingVariant(dataType)) itemTypeRef = dataType;
  } else {
    // The array under whatever nullable wrapper or `allOf` the data property
    // wears (`arraySchemaOf`); its items, whatever their shape, are typed and
    // materialized as `<Operation>Item` (`typeInlineItems`).
    const dataArray = dataProp ? arraySchemaOf(dataProp) : undefined;
    if (dataArray?.items) {
      const typed = typeInlineItems(
        dataArray.items,
        contextName.replace(/Response$/, '') + 'Item',
        componentSchemas,
        settle,
      );
      itemTypeRef = typed.itemType;
      inlineModels.push(...typed.inlineModels);
    }
  }

  // Everything the envelope carries besides the data array: the pagination
  // companion (`list_metadata`, `pagination`, `has_more`, …) and any
  // discriminant such as `object: "list"`. Without these an emitter cannot
  // type the endpoint's actual response or read the next-page details.
  const { envelopeFields, envelopeCompanions } = extractEnvelopeCompanions(
    fields,
    required,
    dataPath,
    contextName.replace(/Response$/, ''),
    componentSchemas,
  );

  // The field that says the list is exhausted — `has_more`, `total_pages`,
  // `pagination.totalPages` — so an iterator can stop without a wasted
  // request: the read `bodyEndOfIteration` makes for a kept wrapper, on the
  // properties already collected above, those every instance carries.
  const endOfIteration = detectEndOfIteration(onEveryInstance, dataPath, componentSchemas);

  return {
    // The data array's own nullability is the response's: a `data` declared
    // `type: ['array', 'null']`, OAS 3.0 `nullable: true`, or `oneOf`/`anyOf`
    // with a `null` variant means the list the SDK returns may be null, so
    // the wrapper `schemaToTypeRef` would give the field stays on `response`
    // — `envelopeFields` leaves `data` out, so nothing else records it —
    // while `itemType` is still what an iterator yields (`paginatedItemType`
    // unwraps the same wrapper). A `$ref` to an array component carries the
    // component's own nullability, and its wrapper's, the same way.
    // The array built here carries the data property's own limits
    // (`minItems`, `uniqueItems`, …), as `schemaToTypeRef` would have it
    // carry them (#545); the items carry theirs.
    response:
      dataType ??
      (dataProp
        ? nullableIf(dataProp, withSchemaConstraints({ kind: 'array', items: itemTypeRef }, dataProp))
        : { kind: 'array', items: itemTypeRef }),
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
 * component's, say), an envelope the parser did not recognize, or a
 * `oneOf`/`anyOf` on the way whose variants' models type the same items
 * under names of their own. `undefined` when the path reaches no array
 * (`resolveDataPathArray`, the one walk; `dataPathProblem` says why, for
 * the check `extractResponses` makes before classifying a body).
 *
 * The array may sit under a nullable wrapper of any form — `type: ['array',
 * 'null']`, OAS 3.0 `nullable: true`, `oneOf: [{ type: 'array' }, { type:
 * 'null' }]`, a nullable `$ref` to an array component — which
 * `resolveBareSchema` looks through exactly as the IR walk
 * (`resolveDataPathItemType`) looks through the `nullable` TypeRef those
 * forms become, and the path goes on through each non-null variant of a
 * union an object on the way is, as the IR walk goes through each variant
 * of a `union` (workos/oagen#556), so the two never disagree about whether
 * the path lands on an array; `isArraySchema` then decides, as every other
 * site does, in every variant, whose arrays must agree on their items.
 *
 * The items are typed and materialized as every array response's are
 * (`typeInlineItems`): as a field named for the path (`result.items` →
 * `ListPetsResultItem`, `records` → `ListPetsRecord`; see
 * `inlineItemNameForPath`) under no parent — so the item type never names a
 * model nobody created.
 */
export function resolveDataPathFromSchema(
  schema: SchemaObject,
  dataPath: string,
  contextName: string,
  componentSchemas?: Record<string, SchemaObject>,
  settle?: ItemSettlement,
): { itemType: TypeRef; inlineModels: Model[] } | undefined {
  const resolved = resolveDataPathArray(schema, dataPath, componentSchemas);
  if ('problem' in resolved) return undefined;
  return typeInlineItems(resolved.items, inlineItemNameForPath(contextName, dataPath), componentSchemas, settle);
}

/**
 * Type an array's items and materialize every model they reference, as a
 * field named `itemName` under no parent: `schemaToTypeRef` names the
 * reference and `extractInlineModelsFromProperties` builds the models, and
 * the two mirror each other form for form, so the item type never names a
 * model nobody created. The one path for the items of an array response
 * body, a list envelope's data array and an explicit `dataPath`'s array,
 * whatever shape the items take. A `$ref` is a reference and mints nothing;
 * a plain object is that model (`ListPetsItem`); a nullable object
 * (`type: ['object', 'null']`, OAS 3.0 `nullable: true`, a nullable
 * `oneOf`) is a `nullable` reference to it; an inline enum is
 * `<itemName>`; the inline object variants of a union take the union's
 * names (`ListPetsItem`, `ListPetsItemWithSide`); an object that also
 * composes — `properties` beside an `allOf` or `oneOf` — is the
 * composition carrying the properties (`foldSiblingProperties`); the
 * objects of a nested array or map, and whatever any of these reference in
 * turn, are materialized under the name the reference uses.
 *
 * With `settle`, the names are settled against the spec-wide registry
 * through `materializeInlineSchema`, the one retry loop every deferred
 * schema goes through: the items are tried as `<Op>Item`, and when a name
 * they mint — the root, a union variant, a nested object — belongs to
 * another shape (a component model or enum, a component's field model, an
 * earlier operation's model), as `<Op>ResponseItem`, then `<Op>Item2`,
 * `<Op>Item3`, …, the first candidate that clashes with nothing; a shape
 * identical to a name's owner shares it and mints nothing, so items matching
 * a component `ListPetsItem` reference the component. The models minted are
 * recorded under the operation; a reference written by sharing another
 * site's model joins that site (`attachSharedRefs`), so a later rename of
 * the shared model — a deprecated copy named like a live one — reaches this
 * array too. Without `settle` — the dry run that reads a component
 * response's names, a direct call — the items take `<Op>Item` as written;
 * the dry run that reads an operation's own names settles them against a
 * copy of the registry as seeded, so it reads the name the operation takes
 * (`operationBodyModelNames`).
 */
function typeInlineItems(
  items: SchemaObject,
  itemName: string,
  componentSchemas?: Record<string, SchemaObject>,
  settle?: ItemSettlement,
): { itemType: TypeRef; inlineModels: Model[] } {
  const inlineModels: Model[] = [];
  if (settle) {
    const itemType = materializeInlineSchema(items, {
      stem: (index) =>
        index === 0
          ? itemName
          : index === 1
            ? itemName.replace(/Item$/, 'ResponseItem')
            : numberedName(itemName, index),
      componentSchemas,
      registry: settle.registry,
      operation: settle.operation,
      models: inlineModels,
    });
    return { itemType, inlineModels };
  }
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

  // A `oneOf`/`anyOf` with more than one variant once every `null` one is
  // set aside (`isNullSchema`), any of which adds a shape the property does
  // not already have (`variantAddsShape`), is a union, the body's own field,
  // however many variants carry a const and whatever properties are written
  // beside it: unwrapping it would type the response as one variant, or as
  // those properties alone, and drop the rest (#415). A union whose every
  // variant only limits the object — bare constraint sets, `type: 'object'`
  // repeated, refinements of the object's own properties — does not type
  // the property; the object still unwraps.
  const variants = (propSchema.oneOf ?? propSchema.anyOf)?.filter((v) => !isNullSchema(v)) ?? [];
  if (variants.length > 1 && variants.some((variant) => variantAddsShape(variant, propSchema))) return false;

  // Direct object with a discriminant const field
  if (propSchema.type === 'object' && hasDiscriminantConstField(propSchema) !== null) return true;

  // A `oneOf` of one such object, with or without `null` variants (a
  // nullable resource).
  if (propSchema.oneOf) {
    return variants.length === 1 && variants[0].type === 'object' && hasDiscriminantConstField(variants[0]) !== null;
  }

  return false;
}

/**
 * Whether a `oneOf`/`anyOf` variant written beside a wrapped object adds a
 * shape the object does not already have, so the union is the property's
 * type rather than a limit on the object (`isSingleResourceWrapper`, #415):
 * a `$ref`; a `type` other than `object` (a primitive, or a type list
 * naming another type); a `const`, `enum`, `items` or composition that
 * types it as something else (`classifyInlineSchema`); a property the
 * object does not declare; or a const tag of its own (a second tagged
 * object, `hasDiscriminantConstField`). A variant of only `type: 'object'`,
 * `required`, limits, or refinements of properties the object declares
 * (`{ required: ['a'], properties: { a: { minLength: 1 } } }`) adds none:
 * `classifyInlineSchema` calls such a union a `union` all the same, since
 * `type` and `properties` are typing keywords, but it only limits the
 * object the body wraps.
 */
function variantAddsShape(variant: SchemaObject, object: SchemaObject): boolean {
  if (variant.type !== undefined && [variant.type].flat().some((type) => type !== 'object')) return true;
  const kind = classifyInlineSchema(variant);
  if (kind !== 'object' && kind !== 'map' && kind !== 'other') return true;
  if (hasDiscriminantConstField(variant) !== null) return true;
  const declared = object.properties ?? {};
  return Object.keys(variant.properties ?? {}).some((name) => !Object.hasOwn(declared, name));
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
      // other nullable unwrap gives it (`collapsedNullableBranch`); otherwise
      // the variant is built as written.
      const source = collapsedNullableBranch(propSchema) ?? objectVariant;
      inlineModels.push(...extractInlineModel(modelName, source, componentSchemas));

      const hasNullVariant = propSchema.oneOf.some(
        (v) => isNullSchema(v) || (Array.isArray(v.type) && v.type.includes('null')),
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

/**
 * How `extractDirectResource` reads a body that is no `$ref`, list envelope
 * or single-resource wrapper — the one dispatch it branches on and
 * `bodyTypesAsUnknown` predicts by, so a shape is read one way by both:
 * an object declaring properties of its own (`type: 'object'` or none;
 * `composedWithoutFields` leaves an empty `properties: {}` beside a
 * composition to the composition); a type list naming several types,
 * `typeRef` whatever sits beside it, so an `allOf` beside the list types
 * its `object` copy and the other types stay (`namesSeveralTypes`; #616);
 * an `allOf` that types the schema
 * (`classifyInlineSchema`), read as `readInlineAllOf` reads it — a
 * `reference`, a lone `unwrapped` member carried with the wrapper's limits,
 * flag and link (`unwrappedAllOfMember`), or a `merged` model; an array
 * with items under a nullable wrapper of any spelling, a single-entry type
 * list included (`arraySchemaOf`: `type: ['array']` is an array here as
 * `isArraySchema` reads it); and otherwise `typeRef`, typed by
 * `schemaToTypeRef` — a union, a primitive, a map, or `unknown`.
 */
type DirectResourceReading =
  | { kind: 'object' }
  | { kind: 'reference' }
  | { kind: 'unwrapped'; member: SchemaObject }
  | { kind: 'merged' }
  | { kind: 'array'; items: SchemaObject }
  | { kind: 'typeRef' };

function directResourceReading(
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
): DirectResourceReading {
  if (schema.properties && !composedWithoutFields(schema) && (schema.type === 'object' || !schema.type)) {
    return { kind: 'object' };
  }
  // A type list naming several types is the union of its per-type copies
  // (`typeListCopies`; #616), typed by `schemaToTypeRef` with what the
  // copies reference materialized under the body's name by the `typeRef`
  // fall-through, so `{ type: ['object', 'string'], allOf: [{ properties:
  // { nick } }] }` is `CreateNoteResponse | string` — the merge the
  // `object` copy is, beside the `string` — as the same body is as a
  // request body (`typePickedRequestBody`) and a field (#616 review: the
  // `allOf` branch below read the merge alone, and the `string` was lost).
  if (namesSeveralTypes(schema)) return { kind: 'typeRef' };
  if (schema.allOf && classifyInlineSchema(schema) === 'allOf') {
    const reading = readInlineAllOf(schema.allOf, schema, componentSchemas);
    if (reading === 'reference') return { kind: 'reference' };
    if (reading === 'unwrapped') return { kind: 'unwrapped', member: unwrappedAllOfMember(schema) };
    return { kind: 'merged' };
  }
  const array = arraySchemaOf(schema);
  if (array?.items) return { kind: 'array', items: array.items };
  return { kind: 'typeRef' };
}

/**
 * Whether classification types a body as the bare `unknown` — the reading
 * `classifyAndExtractResponse` makes, without making it: a `$ref` is a
 * reference, typed as what it names — unknown exactly when it names a
 * primitive component that declares no type, or an alias of one
 * (`referenceTypesAsUnknown`; #569: `{ $ref: Anything }` beside `Anything:
 * { description }` is `unknown`, as the same schema inline is); the body is
 * folded as classification folds it (`foldSiblingProperties`, without the
 * warning it then issues); a list envelope and a single-resource wrapper
 * are typed; and what is left takes `extractDirectResource`'s own dispatch
 * (`directResourceReading`): an object, an `allOf` read as a merge, and an
 * array are typed, an `allOf` read as a reference is its `$ref` member
 * (`referenceTypesAsUnknown` again), a lone `allOf` member is read as the
 * member exactly as `extractDirectResource` recurses into it, and a
 * `typeRef` reading is typed by `schemaToTypeRef` and is `unknown` exactly
 * when `typesAsUnknown` holds. The one answer a reader that must know
 * before any body is read asks (`bodyIsTyped`, choosing the primary
 * response), so no shape is typed by classification and unknown to it, or
 * the reverse — `type: ['array']` with items is an array to both.
 */
export function bodyTypesAsUnknown(schema: SchemaObject, componentSchemas?: Record<string, SchemaObject>): boolean {
  if (schema.$ref) return referenceTypesAsUnknown(schema);
  const folded = foldSiblingProperties(schema);
  if (detectListEnvelope(folded, componentSchemas).isEnvelope || isSingleResourceWrapper(folded)) return false;
  return directResourceTypesAsUnknown(folded, componentSchemas);
}

/**
 * `bodyTypesAsUnknown` from `extractDirectResource`'s dispatch on, where its
 * recursion into a lone `allOf` member lands. A `reference` reading is typed
 * by `schemaToTypeRef` as its `$ref` member, so it is unknown exactly when
 * that reference is (`referenceTypesAsUnknown`; #569).
 */
function directResourceTypesAsUnknown(schema: SchemaObject, componentSchemas?: Record<string, SchemaObject>): boolean {
  const reading = directResourceReading(schema, componentSchemas);
  if (reading.kind === 'unwrapped') return directResourceTypesAsUnknown(reading.member, componentSchemas);
  if (reading.kind === 'reference') return referenceTypesAsUnknown(schema);
  return reading.kind === 'typeRef' && typesAsUnknown(schema);
}

/**
 * `wrapper` is the single-member `allOf` wrapper the body was unwrapped
 * from, when it was (the `'unwrapped'` reading below): the schema the
 * document wrote for the body, whose `description` and link the type built
 * from the member takes, as `schemaToTypeRef` gives the same wrapper on a
 * field or a parameter (`withWrapperDocs`). It reaches only the one site
 * that types the member itself, the fall-through at the end, so an inline
 * enum body under the wrapper lifts with the wrapper's text; a model built
 * from an object member keeps the member's own `description`, as a field's
 * does. Through nested wrappers the outermost text wins, then the next, then
 * the member's own: each level composes its own wrapper with the one handed
 * down before passing it on.
 */
function extractDirectResource(
  schema: SchemaObject,
  contextName: string,
  componentSchemas?: Record<string, SchemaObject>,
  settle?: ItemSettlement,
  wrapper?: SchemaObject,
): ResponseExtractionResult {
  const inlineModels: Model[] = [];
  const reading = directResourceReading(schema, componentSchemas);

  // Direct object with properties (with or without explicit type: 'object').
  // An empty `properties: {}` beside a composition that types the schema is
  // not the body's object — the fold leaves it as written
  // (`hasFoldableProperties`) and the `allOf` or `oneOf` branch below reads
  // it, as `{ allOf: [Pet] }` alone is read — so a body declaring no field of
  // its own never becomes an empty model that drops the composition.
  if (reading.kind === 'object') {
    const modelName = deriveModelName(schema, contextName);
    inlineModels.push(...extractInlineModel(modelName, schema, componentSchemas));
    return {
      response: { kind: 'model', name: modelName },
      inlineModels,
      isPaginated: false,
    };
  }

  // allOf — read the one way every site reads an inline `allOf`
  // (`readInlineAllOf`), when the `allOf` is what types the body
  // (`classifyInlineSchema`; an `allOf` of bare limits leaves the body to
  // its own keywords below). A single `$ref` member with nothing beside it
  // that adds to the component is that component, and nothing is minted —
  // as a field of the same schema is typed (workos/oagen#307: the body was
  // a copy of the component under its own name); a ref no component answers
  // is that reference too. A second `$ref`, or a `required` beside the
  // `$ref`, makes the body the merge below, as it makes a field (every
  // component's properties and every `required` kept). A lone member with
  // nothing added to it is the body itself, carrying the wrapper's limits,
  // flag and link (`unwrappedAllOfMember`), read by the branches of this
  // function as if written in its place, and the type built from it takes
  // the wrapper's text and link too (`wrapper`, see above); a `required`
  // beside a lone object member makes the body the merge too, so `name`
  // stays required. Every other
  // `allOf` is merged into a single model through `mergeAllOfMembers`: $ref
  // branches are resolved against component schemas so the referenced
  // model's fields are merged rather than silently dropped, and the inline
  // object variants of a `oneOf`/`anyOf` member contribute their fields as
  // optional ones (workos/oagen#283), as the same schema's component model
  // has them. Earlier members win on a shared name there, and the fold
  // places the body's own properties first, so an own `kind` enum beside a
  // member's plain `kind` stays the enum here as it does in a field or an
  // array's items.
  if (reading.kind === 'reference') {
    return { response: schemaToTypeRef(schema, contextName), inlineModels, isPaginated: false };
  }
  if (reading.kind === 'unwrapped') {
    const outer = wrapper ? withWrapperDocs(schema, wrapper) : schema;
    return extractDirectResource(reading.member, contextName, componentSchemas, settle, outer);
  }
  if (reading.kind === 'merged') {
    const merged = mergeAllOfMembers(schema, componentSchemas);
    const mergedRefFields = merged.resolvedRefs.length > 0;

    // An unresolvable $ref branch (no component schema map) would drop the
    // referenced model's fields entirely — prefer the referenced model as
    // the response type over a merge that silently guts it.
    if (merged.unresolvedRefs.length === 1 && !mergedRefFields) {
      return {
        response: schemaToTypeRef({ $ref: merged.unresolvedRefs[0] }, contextName),
        inlineModels,
        isPaginated: false,
      };
    }

    if (merged.properties.length > 0) {
      // The rebuilt schema carries the wrapper's limits, conjoined with its
      // inline members', so it still declares what an instance must satisfy,
      // and the wrapper layer's text, link, `deprecated` flag and `x-*` keys
      // — the wrapper's own, else an annotating member's — as a component
      // `allOf` model and a field's merge carry them; a member's stay on
      // that member (a `$ref` member's on its component). So the model built
      // below is described as the same schema's request-body model is
      // (#604: the text alone was left off, and `CreatePetResponse` had none
      // while `CreatePetRequest` did).
      const rebuilt = mergedObjectSchema(merged);
      // Fields merged from a $ref carry the referenced model's const
      // discriminant (e.g. object: 'magic_auth'); deriving the name from it
      // would collide with the component model, so keep the context name.
      // A const only variants declare holds on a branch: it names nothing.
      const branchOnly = new Set(merged.properties.filter((p) => p.conditional).map((p) => p.name));
      const modelName = mergedRefFields ? toPascalCase(contextName) : deriveModelName(rebuilt, contextName, branchOnly);
      inlineModels.push(...extractInlineModel(modelName, rebuilt, componentSchemas));
      return {
        response: { kind: 'model', name: modelName },
        inlineModels,
        isPaginated: false,
      };
    }
  }

  // Array — `type: 'array'` or, since JSON Schema does not require `type`
  // beside `items`, bare `items`, under a nullable wrapper of any spelling
  // (`type: ['array', 'null']`, OAS 3.0 `nullable: true`, `oneOf`/`anyOf`
  // with a `null` variant, with or without `items` beside it) or none:
  // `arraySchemaOf`, which unwraps as `schemaToTypeRef` does and then asks
  // `isArraySchema`, the one test every site makes. The items, whatever
  // their shape, are typed and materialized as `<Operation>Item` under no
  // parent (`typeInlineItems`) — a `$ref` stays the reference, a plain
  // object is `<Operation>Item`, a union's inline object variants take the
  // union's names from it — with the nullable wrapper `schemaToTypeRef`
  // would give the array. Read before the `oneOf` branch below, which
  // would otherwise materialize a nullable array's items a second time
  // under the response's own name.
  if (reading.kind === 'array') {
    const typed = typeInlineItems(
      reading.items,
      contextName.replace(/Response$/, '') + 'Item',
      componentSchemas,
      settle,
    );
    return {
      // The array carries the body's own limits, as `schemaToTypeRef` would
      // have it carry them (#545); the items carry theirs.
      response: nullableIf(schema, withSchemaConstraints({ kind: 'array', items: typed.itemType }, schema)),
      inlineModels: [...inlineModels, ...typed.inlineModels],
      isPaginated: false,
    };
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
  // The one site that types the unwrapped member itself: it carries the
  // wrapper's text and link, as the type builder gives the same wrapper on
  // a field (`withWrapperDocs`), so an inline enum lifted here documents
  // itself by the wrapper. The models materialized above are built from the
  // member as written.
  return {
    response: schemaToTypeRef(wrapper ? withWrapperDocs(schema, wrapper) : schema, contextName),
    inlineModels,
    isPaginated: false,
  };
}

/**
 * Whether `schema` writes an empty `properties: {}` beside an `allOf`,
 * `oneOf` or `anyOf` that types it (`classifyInlineSchema`). Such a schema
 * declares no field of its own, so the object branch of a body path must
 * not claim it: the composition is read instead, as it is when the
 * `properties` keyword is absent. Shared by the response and request-body
 * paths.
 */
export function composedWithoutFields(schema: SchemaObject): boolean {
  if (!schema.properties || Object.keys(schema.properties).length > 0) return false;
  const kind = classifyInlineSchema(schema);
  return kind === 'allOf' || kind === 'union';
}

/**
 * Wrap `ref` in `nullable` when `schemaToTypeRef` would wrap the schema's
 * own type (`declaresNull`). For the places the response path builds an
 * array TypeRef itself instead of delegating.
 */
function nullableIf(schema: SchemaObject, ref: TypeRef): TypeRef {
  return declaresNull(schema) ? { kind: 'nullable', inner: ref } : ref;
}

/**
 * The name a response object takes from a string `const` it declares
 * (`object: 'note'` names it `Note`), else `fallback`. A property in
 * `branchOnly` holds on one branch of the body, not on every instance (only
 * an inline `allOf`'s `oneOf`/`anyOf` variants declare it:
 * `MergedProperty.conditional`), so its const names nothing
 * (workos/oagen#396: one variant's `kind: cat` named the body `Cat`, and a
 * `kind: dog` added to another variant renamed it); it still counts toward
 * the list envelope, which is the whole body's shape.
 */
function deriveModelName(schema: SchemaObject, fallback: string, branchOnly?: ReadonlySet<string>): string {
  if (!schema.properties) return toPascalCase(fallback);
  // A list envelope's const (`object: 'list'`) names the envelope's kind, which
  // every envelope of the API shares, not what it lists (workos/oagen#418).
  if (detectListEnvelope(schema).isEnvelope) return toPascalCase(fallback);

  // Prefer well-known discriminant properties for backward compatibility
  const preferred = ['object', 'type'];
  for (const name of preferred) {
    const field = branchOnly?.has(name) ? undefined : schema.properties[name];
    if (field && field.const && typeof field.const === 'string') {
      return toPascalCase(field.const);
    }
  }

  // Fall back to any property with a const string value
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!branchOnly?.has(name) && field && field.const && typeof field.const === 'string') {
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
      ...schemaExtensionsEntry(schema),
    },
    ...nestedModels,
  ];
}
