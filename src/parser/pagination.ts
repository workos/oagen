import type {
  TypeRef,
  Parameter,
  Model,
  PaginationMeta,
  PaginationEndOfIteration,
  PaginationStrategy,
} from '../ir/types.js';
import type { PaginationHint } from '../ir/operation-hints.js';
import type { SchemaObject } from './schemas.js';
import { resolveComponentSchemaRef, unwrapNullableSchema } from './schemas.js';

const CURSOR_PARAMS = ['cursor', 'after', 'before', 'starting_after', 'ending_before', 'page_token', 'next_token'];

const OFFSET_PARAMS = ['offset', 'skip'];
const PAGE_PARAMS = ['page', 'page_number', 'page_num'];
const LIMIT_PARAMS = ['limit', 'page_size', 'per_page', 'size', 'count'];

/**
 * Detect if an operation uses pagination and return structured metadata
 * for auto-paging iterator generation.
 *
 * Recognizes three strategies from the query parameter names, in this order:
 * 1. **Cursor-based**: a cursor-like parameter (`cursor`, `after`, …)
 * 2. **Offset-based**: an item offset (`offset`, `skip`) plus a limit-like parameter
 * 3. **Page-number**: a page number (`page`, `page_number`, `page_num`) plus a
 *    limit-like parameter — the iterator advances it by one per request, not
 *    by the number of items received, starting at `pageStart`
 *
 * An offset or page parameter without a page-size parameter is not treated as
 * pagination. Returns null if no pattern is detected — and then no iterator
 * is built from the query parameters: an iterator is driven only by a
 * parameter the operation declares, never by one guessed from the response
 * (`describeUndetectedPaging` says what was missing).
 */
export function detectPagination(
  response: TypeRef,
  queryParams: Parameter[],
  dataPath?: string,
  options: { pageStartOf?: PageStartResolver } = {},
): PaginationMeta | null {
  // Try cursor-based first (preferred). Scan in CURSOR_PARAMS priority order
  // rather than queryParams order so that an endpoint exposing both `before`
  // and `after` reports `after` (forward iteration) — matches the wire
  // convention where `after` advances through pages.
  const cursorParam = CURSOR_PARAMS.map((name) => queryParams.find((p) => p.name === name)).find(
    (p): p is Parameter => p !== undefined,
  );

  if (cursorParam) {
    return {
      strategy: 'cursor',
      param: cursorParam.name,
      dataPath: dataPath,
      itemType: paginatedItemType(response),
    };
  }

  // Offset and page-number pagination both need a page-size parameter.
  const limitParam = queryParams.find((p) => LIMIT_PARAMS.includes(p.name));
  if (!limitParam) return null;

  const itemType = paginatedItemType(response);

  const offsetParam = queryParams.find((p) => OFFSET_PARAMS.includes(p.name));
  if (offsetParam) {
    return {
      strategy: 'offset',
      param: offsetParam.name,
      limitParam: limitParam.name,
      dataPath: dataPath,
      itemType: paginatedItemType(response),
    };
  }

  const pageParam = queryParams.find((p) => PAGE_PARAMS.includes(p.name));
  if (pageParam) {
    return {
      strategy: 'page',
      param: pageParam.name,
      limitParam: limitParam.name,
      pageStart: (options.pageStartOf ?? derivePageStart)(pageParam),
      dataPath: dataPath,
      itemType,
    };
  }

  return null;
}

/**
 * Why `detectPagination` finds no strategy in `queryParams`, for the warning
 * on an operation whose list envelope nothing pages: the recognized
 * parameters it declares and what is missing beside them — an offset or page
 * parameter without a page-size one, a page-size one on its own, or none of
 * the names at all. Meaningful only when `detectPagination` returned null,
 * so a cursor parameter, which alone makes an iterator, is never among the
 * declared ones.
 */
export function describeUndetectedPaging(queryParams: Parameter[]): string {
  const declared = (names: readonly string[]): string[] =>
    queryParams.filter((p) => names.includes(p.name)).map((p) => `"${p.name}"`);
  // `"page" is` / `"offset" and "page" are` / `"a", "b" and "c" are`.
  const listed = (names: string[]): string =>
    names.length === 1 ? `${names[0]} is` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are`;
  const selectors = [...declared(OFFSET_PARAMS), ...declared(PAGE_PARAMS)];
  if (selectors.length > 0) {
    return `${listed(selectors)} declared without a page-size parameter: ${LIMIT_PARAMS.join(', ')}`;
  }
  const sizes = declared(LIMIT_PARAMS);
  if (sizes.length > 0) return `${listed(sizes)} declared without a cursor, offset or page parameter`;
  return 'no cursor, offset or page query parameter is declared';
}

/** Decides the first page number for a page parameter; see `derivePageStart`. */
export type PageStartResolver = (param: Parameter | undefined) => number;

/**
 * The first page number an API expects: the page parameter's `default`, else
 * its `minimum`, else 1. Only a non-negative integer counts — a `default` of
 * `"1"` or `1.5` is not a page number, so the next source is tried.
 *
 * `schema` is the parameter's schema as written. The IR parameter carries a
 * `default`/`minimum` declared inline or on a bare `$ref` target, but not one
 * behind `allOf: [{ $ref }]` or a nullable wrapper; those are read from the
 * schema through `resolveSchemaKeyword`, so a component declaring `default:
 * 0` still starts the iterator at page 0.
 */
export function derivePageStart(
  param: Parameter | undefined,
  schema?: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
): number {
  const candidates = [
    param?.default,
    schema && resolveSchemaKeyword(schema, 'default', componentSchemas),
    param?.constraints?.minimum,
    schema && resolveSchemaKeyword(schema, 'minimum', componentSchemas),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0) return candidate;
  }
  return 1;
}

/**
 * A keyword's value on a schema or on what it is composed of: the schema's
 * own value, else the component its `$ref` names, else its `allOf` members in
 * declaration order (the first that declares it wins), else the single
 * non-null variant of a nullable `oneOf`/`anyOf`. `undefined` when no level
 * declares it.
 */
export function resolveSchemaKeyword(
  schema: SchemaObject,
  keyword: 'default' | 'minimum',
  componentSchemas?: Record<string, SchemaObject>,
  seen: Set<string> = new Set(),
): unknown {
  if (schema[keyword] !== undefined) return schema[keyword];
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return undefined;
    seen.add(schema.$ref);
    const resolved = resolveComponentSchemaRef(schema, componentSchemas);
    return resolved ? resolveSchemaKeyword(resolved, keyword, componentSchemas, seen) : undefined;
  }
  for (const member of schema.allOf ?? []) {
    const value = resolveSchemaKeyword(member, keyword, componentSchemas, seen);
    if (value !== undefined) return value;
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) {
    const nonNull = variants.filter((variant) => !isNullSchema(variant));
    if (nonNull.length === 1) return resolveSchemaKeyword(nonNull[0], keyword, componentSchemas, seen);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// End of iteration — the envelope field that says the list is exhausted
// ---------------------------------------------------------------------------

/** Boolean companions that are `false` on the last page. */
export const HAS_MORE_FIELDS: readonly string[] = [
  'has_more',
  'hasMore',
  'has_next',
  'hasNext',
  'has_next_page',
  'hasNextPage',
];
/** Integer companions counting the pages. */
export const TOTAL_PAGES_FIELDS: readonly string[] = ['total_pages', 'totalPages', 'page_count', 'pageCount'];
/** Integer companions counting the items. */
export const TOTAL_COUNT_FIELDS: readonly string[] = [
  'total',
  'total_count',
  'totalCount',
  'total_items',
  'totalItems',
  'total_results',
  'totalResults',
];
/**
 * Every companion name that can end an iteration. List-envelope detection
 * treats a companion with one of these names as pagination metadata, and
 * `detectEndOfIteration` reads it, so the two can never disagree about which
 * envelopes carry a stop field.
 */
export const END_OF_ITERATION_FIELDS: readonly string[] = [
  ...HAS_MORE_FIELDS,
  ...TOTAL_PAGES_FIELDS,
  ...TOTAL_COUNT_FIELDS,
];
const END_KIND_PRIORITY: ReadonlyArray<PaginationEndOfIteration['kind']> = ['hasMore', 'totalPages', 'totalCount'];

/**
 * Substrings that mark an envelope companion as pagination metadata (`meta`,
 * `pagination`, `page_info`, `cursor`, ...). List-envelope detection reads
 * them to recognize an envelope, and `detectEndOfIteration` reads them to
 * decide which object companions to look inside for a stop field.
 */
export const PAGINATION_METADATA_PATTERNS: readonly string[] = [
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

/** Whether a companion's name says it carries pagination metadata. */
export function looksLikePaginationMetadata(name: string): boolean {
  const lower = name.toLowerCase();
  return PAGINATION_METADATA_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Find the envelope field that ends an iteration, when the envelope declares
 * an obvious one. `properties` are the envelope's merged properties and
 * `dataPath` names the data array among them.
 *
 * The fields beside the array are considered first: when the path is
 * nested, the other properties of the object the array sits in, under
 * whatever name that object has (`result.total_pages` beside
 * `result.items`, `data.page.has_more` beside `data.page.items`), the
 * parent reached exactly as the path itself is resolved
 * (`resolveSchemaPath` from the merged properties), so one behind a `$ref`,
 * an `allOf` or a nullable wrapper is read as the walk reads it. Then the
 * top-level fields, then the fields one level down inside each top-level
 * object companion whose name says it is pagination metadata
 * (`looksLikePaginationMetadata`: `meta`, `pagination`, `page_info`, ...; an
 * inline object, a `$ref` to a component, an `allOf` of those, or a nullable
 * wrapper around one), so a `stats.total` beside `pagination.page` is not
 * taken for the list's size. The array itself is never a stop field,
 * whatever it is called. The path follows the `dataPath` convention:
 * `has_more`, `result.total_pages` or `pagination.totalPages`. When several
 * candidates exist, a `hasMore` boolean wins over a `totalPages` integer,
 * which wins over a `totalCount` integer; within one kind the first in scan
 * order wins. A candidate whose type does not fit its kind (a string
 * `total`) is ignored.
 */
export function detectEndOfIteration(
  properties: Record<string, SchemaObject | undefined>,
  dataPath: string,
  componentSchemas?: Record<string, SchemaObject>,
): PaginationEndOfIteration | undefined {
  const found = new Map<PaginationEndOfIteration['kind'], string>();
  const record = (name: string, path: string, schema: SchemaObject): void => {
    const kind = classifyEndField(name, schema, componentSchemas);
    if (kind && !found.has(kind)) found.set(kind, path);
  };

  const segments = dataPath.split('.');
  const arrayName = segments[segments.length - 1];
  if (segments.length > 1) {
    const parentPath = segments.slice(0, -1).join('.');
    const parent = resolveSchemaPath({ properties }, parentPath, componentSchemas);
    for (const [inner, innerSchema] of Object.entries(parent ? objectProperties(parent, componentSchemas) : {})) {
      if (innerSchema && inner !== arrayName) record(inner, `${parentPath}.${inner}`, innerSchema);
    }
  }

  const companions = Object.entries(properties).filter(
    (entry): entry is [string, SchemaObject] => entry[0] !== dataPath && entry[1] !== undefined,
  );
  for (const [name, schema] of companions) record(name, name, schema);
  for (const [name, schema] of companions) {
    if (!looksLikePaginationMetadata(name)) continue;
    for (const [inner, innerSchema] of Object.entries(objectProperties(schema, componentSchemas))) {
      if (innerSchema) record(inner, `${name}.${inner}`, innerSchema);
    }
  }

  for (const kind of END_KIND_PRIORITY) {
    const path = found.get(kind);
    if (path) return { kind, path };
  }
  return undefined;
}

function classifyEndField(
  name: string,
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
): PaginationEndOfIteration['kind'] | undefined {
  // The name decides the kind, and only a named stop field has its schema
  // read: a companion of any other name is never resolved at all.
  const kind: PaginationEndOfIteration['kind'] | undefined = HAS_MORE_FIELDS.includes(name)
    ? 'hasMore'
    : TOTAL_PAGES_FIELDS.includes(name)
      ? 'totalPages'
      : TOTAL_COUNT_FIELDS.includes(name)
        ? 'totalCount'
        : undefined;
  if (!kind) return undefined;
  const resolved = resolveBareSchema(schema, componentSchemas);
  const fits = kind === 'hasMore' ? hasType(resolved, 'boolean') : isNumeric(resolved);
  return fits ? kind : undefined;
}

function hasType(schema: SchemaObject, type: string): boolean {
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function isNumeric(schema: SchemaObject): boolean {
  return hasType(schema, 'integer') || hasType(schema, 'number');
}

/**
 * The schema under every `$ref` and nullable wrapper: a `$ref` is followed
 * to its component, a nullable wrapper — an OAS 3.1 type list naming
 * `'null'`, OAS 3.0 `nullable: true`, a `oneOf`/`anyOf` with one non-null
 * variant — is stripped by `unwrapNullableSchema`, the one definition the
 * model side unwraps by, and the two alternate until the schema is neither,
 * so `{ oneOf: [{ $ref: 'Tags' }, { type: 'null' }] }` with `Tags: { type:
 * ['array', 'null'], items }` reaches the array. A `$ref` met a second time
 * (`Flag: { oneOf: [{ $ref: Flag }, { type: 'null' }] }`) ends the walk on
 * the reference instead of looping on it, as `resolveSchemaKeyword` and
 * `objectProperties` stop; so does a `$ref` with no component map or to no
 * component. Shared by the stop-field check and the document walk an
 * explicit `dataPath` makes (`resolveDataPathFromSchema`), so a stop field
 * and a data array behind the same wrappers are read the same way.
 */
export function resolveBareSchema(
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
  seen: Set<string> = new Set(),
): SchemaObject {
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return schema;
    seen.add(schema.$ref);
    const resolved = resolveComponentSchemaRef(schema, componentSchemas);
    return resolved ? resolveBareSchema(resolved, componentSchemas, seen) : schema;
  }
  const bare = unwrapNullableSchema(schema);
  return bare.$ref ? resolveBareSchema(bare, componentSchemas, seen) : bare;
}

function isNullSchema(schema: SchemaObject): boolean {
  return schema.type === 'null' || (Array.isArray(schema.type) && schema.type.every((t) => t === 'null'));
}

/**
 * The properties of an object schema: its own, merged with those of its
 * `allOf` members, following `$ref`s to component schemas and looking through
 * a nullable `oneOf`/`anyOf` wrapper with a single non-null variant. Anything
 * that is not an object yields none.
 */
function objectProperties(
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
  seen: Set<string> = new Set(),
): Record<string, SchemaObject | undefined> {
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return {};
    seen.add(schema.$ref);
    const resolved = resolveComponentSchemaRef(schema, componentSchemas);
    return resolved ? objectProperties(resolved, componentSchemas, seen) : {};
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants && !schema.properties && !schema.allOf) {
    const nonNull = variants.filter((variant) => !isNullSchema(variant));
    return nonNull.length === 1 ? objectProperties(nonNull[0], componentSchemas, seen) : {};
  }
  const out: Record<string, SchemaObject | undefined> = {};
  for (const member of schema.allOf ?? []) Object.assign(out, objectProperties(member, componentSchemas, seen));
  if (schema.properties) Object.assign(out, schema.properties);
  return out;
}

// ---------------------------------------------------------------------------
// Resolving a dotted `dataPath`
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted property path (the `dataPath` convention) against a
 * response schema: each segment is looked up among the object's properties —
 * through `$ref`s, `allOf` members and nullable wrappers — and the schema it
 * lands on is returned with a final `$ref` resolved. `undefined` when a
 * segment is missing.
 */
export function resolveSchemaPath(
  schema: SchemaObject,
  path: string,
  componentSchemas?: Record<string, SchemaObject>,
): SchemaObject | undefined {
  let current: SchemaObject | undefined = schema;
  for (const segment of path.split('.')) {
    if (!current) return undefined;
    current = objectProperties(current, componentSchemas)[segment];
  }
  if (!current) return undefined;
  return resolveComponentSchemaRef(current, componentSchemas) ?? current;
}

/**
 * Resolve a dotted `dataPath` against the IR rather than the document: walk
 * from the response type through model fields, unwrapping nullables, and
 * return the element type of the array the path lands on. `models` is where
 * each model along the way is looked up by name, so the item type is exactly
 * the one the parser already assigned — the very `TypeRef` object the field
 * holds, which later renaming passes repoint in place. An empty `dataPath`
 * means `root` itself is the array. `undefined` when a segment is missing, a
 * model is unknown, or the path does not end on an array.
 */
export function resolveDataPathItemType(root: TypeRef, dataPath: string, models: Model[]): TypeRef | undefined {
  let current: TypeRef = root;
  for (const segment of dataPath === '' ? [] : dataPath.split('.')) {
    const container = current.kind === 'nullable' ? current.inner : current;
    if (container.kind !== 'model') return undefined;
    const field = models.find((m) => m.name === container.name)?.fields.find((f) => f.name === segment);
    if (!field) return undefined;
    current = field.type;
  }
  const target = current.kind === 'nullable' ? current.inner : current;
  return target.kind === 'array' ? target.items : undefined;
}

// ---------------------------------------------------------------------------
// Explicit overrides — `x-pagination` and `operationHints[...].pagination`
// ---------------------------------------------------------------------------

const STRATEGIES: ReadonlyArray<PaginationStrategy | 'none'> = ['cursor', 'offset', 'page', 'link-header', 'none'];

export interface PaginationOverrides {
  /** The operation's `x-pagination` extension, exactly as written in the document. */
  extension?: unknown;
  /** `operationHints["METHOD /path"].pagination` from the consumer's config. */
  hint?: unknown;
}

/** The validated, merged override for one operation, with the source(s) it came from for warnings. */
export interface ResolvedPaginationOverride {
  hint: PaginationHint;
  source: string;
}

/**
 * Validate and merge the two override sources. Precedence per field: config
 * hint, then `x-pagination`; a source that fails validation is dropped with
 * an `[oagen] Warning:` and the other still applies. `undefined` when neither
 * source is present or usable.
 *
 * Resolved before the response is classified, because `strategy: 'none'`
 * must keep a list envelope from being unwrapped and an explicit `dataPath`
 * is resolved against the response while its schema is at hand.
 */
export function resolvePaginationOverride(
  sources: PaginationOverrides,
  opLabel: string,
): ResolvedPaginationOverride | undefined {
  const extension =
    sources.extension === undefined ? undefined : validatePaginationHint(sources.extension, 'x-pagination', opLabel);
  const hint =
    sources.hint === undefined ? undefined : validatePaginationHint(sources.hint, 'operationHints pagination', opLabel);
  if (!extension && !hint) return undefined;
  const source = [extension && 'x-pagination', hint && 'operationHints pagination'].filter(Boolean).join(' / ');
  return { hint: { ...extension, ...hint }, source };
}

/**
 * Layer the resolved override onto the detected pagination. A field the
 * override does not set keeps the detected value, so `{ strategy: 'page' }`
 * alone re-labels a detected offset iterator without restating its
 * parameters — except `param`, which is first looked for among the
 * operation's query parameters by the strategy's own names (`page` for
 * `page`, `cursor` or `after` for `cursor`, ...), so a strategy the override
 * names is driven by the parameter that fits it rather than by one detection
 * found for another strategy. `extras.overrideItemType` is the element type an explicit
 * `dataPath` resolved to; without it the detected item type (or the response
 * itself) stands. `extras.envelope` is the list envelope the response was
 * unwrapped on — `dataPath`, `dataDescription`, `itemType`, `envelopeFields`
 * as detection read them — whichever parameter drives the iterator: it is
 * read when `detected` is unset, so an override that creates the iterator
 * where the query parameters yielded none (`{ strategy: 'cursor', param:
 * 'c' }` on `{ data, has_more }`) still describes that envelope; when a
 * parameter was recognized, `detected` carries the same values and is read
 * first. `extras.endOfIteration` is the stop field read from the
 * response, which belongs to the iterator whether detection built one or the
 * override creates it from scratch (no paging parameter recognized, a
 * wrapper kept under an explicit `dataPath`): the override's own
 * `endOfIteration` wins, then the detected iterator's, then it.
 * `extras.pageStartOf` decides the first page for the page
 * parameter in use (default: `derivePageStart` on the IR parameter alone).
 *
 * Returns `detected` unchanged when there is no override or it is unusable —
 * no strategy or no `param` from any source, a resolved `param`/`limitParam`
 * the operation does not declare as a query parameter — after an `[oagen]
 * Warning:` naming the problem. `strategy: 'none'` yields `undefined`.
 */
export function applyPaginationOverride(
  detected: PaginationMeta | undefined,
  override: ResolvedPaginationOverride | undefined,
  queryParams: Parameter[],
  response: TypeRef,
  opLabel: string,
  extras: {
    overrideItemType?: TypeRef;
    envelope?: Pick<PaginationMeta, 'dataPath' | 'dataDescription' | 'itemType' | 'envelopeFields'>;
    endOfIteration?: PaginationEndOfIteration;
    pageStartOf?: PageStartResolver;
  } = {},
): PaginationMeta | undefined {
  if (!override) return detected;
  const merged = override.hint;
  const where = `${override.source} on ${opLabel}`;

  if (merged.strategy === 'none') return undefined;

  const resolved = resolveOverrideParams(detected, merged, queryParams);
  if ('problem' in resolved) {
    warn(`${where}${resolved.problem}`);
    return detected;
  }
  const { strategy, param, limitParam } = resolved;

  // What detection read from the response: the detected iterator's own
  // values, else the envelope unwrapped for an iterator only the override
  // creates.
  const list = detected ?? extras.envelope;
  const dataPath = merged.dataPath ?? list?.dataPath;
  // The data array's description belongs to the array detection unwrapped;
  // it survives an override that keeps that array.
  const dataDescription = dataPath === list?.dataPath ? list?.dataDescription : undefined;
  const endOfIteration = merged.endOfIteration ?? detected?.endOfIteration ?? extras.endOfIteration;
  // The page base belongs to the page parameter actually in use, which the
  // override may have swapped, so it is derived from that parameter rather
  // than carried over from detection.
  const pageStartOf = extras.pageStartOf ?? derivePageStart;
  const pageStart =
    strategy === 'page' ? (merged.pageStart ?? pageStartOf(queryParams.find((p) => p.name === param))) : undefined;
  return {
    strategy,
    param,
    ...(limitParam !== undefined && { limitParam }),
    ...(pageStart !== undefined && { pageStart }),
    ...(dataPath !== undefined && { dataPath }),
    ...(dataDescription !== undefined && { dataDescription }),
    itemType: extras.overrideItemType ?? list?.itemType ?? (response.kind === 'array' ? response.items : response),
    ...(list?.envelopeFields && { envelopeFields: list.envelopeFields }),
    ...(endOfIteration && { endOfIteration }),
  };
}

/**
 * The strategy, `param` and `limitParam` an override resolves to against
 * what was detected, or the reason it cannot apply (the text of the warning
 * `applyPaginationOverride` emits). Shared with `buildOperation`, which asks
 * before classification whether an override will be usable, so an override
 * that will be rejected never changes how the response is read.
 */
export function resolveOverrideParams(
  detected: PaginationMeta | undefined,
  merged: PaginationHint,
  queryParams: Parameter[],
): { strategy: PaginationStrategy; param: string; limitParam?: string } | { problem: string } {
  const strategy = merged.strategy === 'none' ? undefined : (merged.strategy ?? detected?.strategy);
  if (!strategy) return { problem: ' sets no strategy and none was detected — ignoring the override' };
  const param = merged.param ?? declaredParamFor(strategy, queryParams) ?? detected?.param;
  if (!param) {
    return {
      problem: `: strategy "${strategy}" needs a param, and none was given or detected — ignoring the override`,
    };
  }
  const limitParam = merged.limitParam ?? detected?.limitParam;
  // The resolved values are checked, not only the explicit ones: a `param`
  // carried over from detection for another strategy is as undeclared as a
  // misspelled one when the operation does not declare it.
  for (const [key, name] of [
    ['param', param],
    ['limitParam', limitParam],
  ] as const) {
    if (name !== undefined && !queryParams.some((p) => p.name === name)) {
      return { problem: `: ${key} "${name}" is not a query parameter of the operation — ignoring the override` };
    }
  }
  return { strategy, param, ...(limitParam !== undefined && { limitParam }) };
}

/** The first query parameter the operation declares under one of `strategy`'s own parameter names, if any. */
function declaredParamFor(strategy: PaginationStrategy, queryParams: Parameter[]): string | undefined {
  const names =
    strategy === 'cursor'
      ? CURSOR_PARAMS
      : strategy === 'offset'
        ? OFFSET_PARAMS
        : strategy === 'page'
          ? PAGE_PARAMS
          : [];
  return names.map((name) => queryParams.find((p) => p.name === name)).find((p) => p !== undefined)?.name;
}

/**
 * Check one override object. Returns the typed hint with only the keys the
 * author set, or `undefined` after a warning when any field is malformed. An
 * unknown key is reported and skipped without invalidating the rest, and a
 * key set to `undefined` counts as absent.
 */
export function validatePaginationHint(raw: unknown, source: string, opLabel: string): PaginationHint | undefined {
  const where = `${source} on ${opLabel}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`${where} must be an object — ignoring it`);
    return undefined;
  }

  const out: PaginationHint = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    switch (key) {
      case 'strategy':
        if (typeof value !== 'string' || !(STRATEGIES as readonly string[]).includes(value)) {
          const expected = STRATEGIES.map((s) => `"${s}"`).join(', ');
          warn(`${where}: unknown strategy ${JSON.stringify(value)} (expected one of ${expected}) — ignoring it`);
          return undefined;
        }
        out.strategy = value as PaginationStrategy | 'none';
        break;
      case 'param':
      case 'limitParam':
      case 'dataPath':
        if (typeof value !== 'string' || value.trim() === '') {
          warn(`${where}: ${key} must be a non-empty string — ignoring it`);
          return undefined;
        }
        out[key] = value;
        break;
      case 'pageStart':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          warn(`${where}: pageStart must be a non-negative integer — ignoring it`);
          return undefined;
        }
        out.pageStart = value;
        break;
      case 'endOfIteration': {
        const end = validateEndOfIteration(value);
        if (!end) {
          warn(
            `${where}: endOfIteration must be { kind: "hasMore" | "totalPages" | "totalCount", path: string } — ignoring it`,
          );
          return undefined;
        }
        out.endOfIteration = end;
        break;
      }
      default:
        warn(`${where}: unknown key "${key}" skipped`);
    }
  }
  return out;
}

function validateEndOfIteration(value: unknown): PaginationEndOfIteration | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { kind, path } = value as { kind?: unknown; path?: unknown };
  if (!(END_KIND_PRIORITY as readonly unknown[]).includes(kind)) return undefined;
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  return { kind: kind as PaginationEndOfIteration['kind'], path };
}

function warn(message: string): void {
  console.warn(`[oagen] Warning: ${message}`);
}

/**
 * The type an iterator yields from `response`: the items of a top-level
 * array, under a nullable wrapper too (an OAS 3.0 `nullable: true` array
 * response is `nullable<array<T>>`), else the response itself.
 */
export function paginatedItemType(response: TypeRef): TypeRef {
  const inner = response.kind === 'nullable' ? response.inner : response;
  return inner.kind === 'array' ? inner.items : response;
}
