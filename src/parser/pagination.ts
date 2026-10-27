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
import { classifyInlineSchema, resolveComponentSchemaRef, unwrapNullableSchema } from './schemas.js';
import { toSnakeCase } from '../utils/naming.js';
import { combineDeclarations, readInlineAllOf } from './inline-models.js';

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
 * `pagination`, `page_info`, `cursor`, ...), written in snake_case: the
 * spelling `looksLikePaginationMetadata` matches a companion's name in,
 * whatever case or separators the document uses. List-envelope detection
 * reads them to recognize an envelope, and `detectEndOfIteration` reads them
 * to decide which object companions to look inside for a stop field.
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

/**
 * Whether a companion's name says it carries pagination metadata: its
 * snake_case spelling (`toSnakeCase`, which splits the name into words as
 * `toPascalCase` does) contains one of `PAGINATION_METADATA_PATTERNS`. The
 * name is read by its words, so case and separators do not matter —
 * `page_info`, `pageInfo`, `PageInfo` and `page-info` are all `page_info` —
 * while a pattern never straddles a word boundary: `nameTag` is `name_tag`,
 * which does not contain `meta`. The one recognizer for list-envelope
 * detection and the nested stop-field scan, so the two cannot disagree
 * about which companions are pagination metadata.
 */
export function looksLikePaginationMetadata(name: string): boolean {
  const spelled = toSnakeCase(name);
  return PAGINATION_METADATA_PATTERNS.some((pattern) => spelled.includes(pattern));
}

/**
 * Find the envelope field that ends an iteration, when the envelope declares
 * an obvious one. `properties` are the envelope's merged properties and
 * `dataPath` names the data array among them.
 *
 * The fields beside the array are considered first: when the path is
 * nested, the other properties of the object the array sits in, under
 * whatever name that object has (`result.total_pages` beside
 * `result.items`, `data.page.has_more` beside `data.page.items`), then
 * those of each object the path passes through on its way there, nearest
 * the array first (`result.total_pages` beside `result.page` for
 * `result.page.items`), every one reached exactly as the path itself is
 * resolved (`resolveSchemaPath` from the merged properties), so one behind
 * a `$ref`, an `allOf` or a nullable wrapper is read as the walk reads it.
 * Then the top-level fields, then the fields one level down inside each
 * top-level object companion whose name says it is pagination metadata
 * (`looksLikePaginationMetadata`: `meta`, `pagination`, `page_info`, ..., in
 * any spelling — `pageInfo` and `PageInfo` as much as `page_info`; an
 * inline object, a `$ref` to a component, an `allOf` of those, or a nullable
 * wrapper around one), so a `stats.total` beside `pagination.page` is not
 * taken for the list's size. Nothing the path passes through — the array,
 * or an object on the way to it — is ever a stop field, whatever it is
 * called. The path follows the `dataPath` convention — `has_more`,
 * `result.total_pages` or `pagination.totalPages` — and spells each
 * segment as the document does (`pageInfo.hasNextPage`). When several
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

  // Every object on the path, nearest the array first, without the property
  // the path goes on through; the top level, the outermost, comes last.
  const segments = dataPath.split('.');
  for (let depth = segments.length - 1; depth > 0; depth--) {
    const parentPath = segments.slice(0, depth).join('.');
    const parent = resolveSchemaPath({ properties }, parentPath, componentSchemas);
    for (const [inner, innerSchema] of Object.entries(parent ? objectProperties(parent, componentSchemas) : {})) {
      if (innerSchema && inner !== segments[depth]) record(inner, `${parentPath}.${inner}`, innerSchema);
    }
  }

  const companions = Object.entries(properties).filter(
    (entry): entry is [string, SchemaObject] => entry[0] !== segments[0] && entry[1] !== undefined,
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
  return endFieldFits(kind, resolveBareSchema(schema, componentSchemas)) ? kind : undefined;
}

/**
 * Whether a stop field's bare schema (`resolveBareSchema`) has the type its
 * kind is tested against: a `boolean` for `hasMore`, an `integer` or
 * `number` for `totalPages` and `totalCount`, under a type list too. The one
 * test for a field detection names and for one an override names.
 */
function endFieldFits(kind: PaginationEndOfIteration['kind'], schema: SchemaObject): boolean {
  return kind === 'hasMore' ? hasType(schema, 'boolean') : isNumeric(schema);
}

/**
 * Why an explicit `endOfIteration` cannot be read from a body whose
 * properties are `properties`, or `undefined` when it can. `properties` is
 * the map a detected stop field is read from — the body's own and every
 * `allOf` member's, through `$ref`s and nullable wrappers, as
 * `detectEndOfIteration` receives it — so an override and detection look at
 * one map: a field detection would read is one an override may name, and a
 * field it would not see is not there for an override either. `end.path` is
 * walked over that map as an explicit `dataPath` is (`resolveSchemaPath`:
 * through `$ref`s, `allOf` members and nullable wrappers at every further
 * segment), and through each non-null variant of a `oneOf`/`anyOf` on the
 * way that does not declare the next segment itself (`fieldsAtPath`), so it
 * lands on one field per variant; each must fit `end.kind` by the test
 * detection applies to a field it names (`endFieldFits`), under
 * `resolveBareSchema` as a detected one is. With no `properties` — an
 * operation whose primary response declares no body — the path resolves to
 * nothing.
 *
 * The text is the reason alone; the caller names the override's source and
 * the operation, and says what it does about it.
 */
export function endOfIterationProblem(
  end: PaginationEndOfIteration,
  properties: Record<string, SchemaObject | undefined> | undefined,
  componentSchemas?: Record<string, SchemaObject>,
): string | undefined {
  const fields = properties && fieldsAtPath({ properties }, end.path, componentSchemas);
  if (!fields) return `endOfIteration path "${end.path}" does not resolve to a field in the response`;
  if (fields.every((field) => endFieldFits(end.kind, resolveBareSchema(field, componentSchemas)))) return undefined;
  const expected = end.kind === 'hasMore' ? 'a boolean' : 'an integer or number';
  return `endOfIteration path "${end.path}" is not ${expected} field, as kind "${end.kind}" requires`;
}

/**
 * Every field `path` lands on below `schema`. Each segment is looked up
 * among the properties of the object the path has reached, as
 * `resolveSchemaPath` looks it up — through `$ref`s, `allOf` members and
 * nullable wrappers — and, when that object does not declare it but is a
 * `oneOf`/`anyOf`, in each of its non-null variants instead: whichever
 * variant the wire carries, the field must be there, so the path goes on in
 * every one and lands on one field per variant (`meta.has_more` with `meta`
 * a `oneOf` of two objects that each declare `has_more`). `undefined` when
 * the object, or any of its variants, lacks the segment. A variant that is
 * itself such a union declares no properties of its own
 * (`objectProperties`), so it lacks every segment. The walk goes one
 * segment at a time over every schema reached so far, each counted once —
 * by its `$ref`, else by the schema itself — so a component several
 * variants reach is walked on once, however many variants reach it and
 * however long the path.
 */
function fieldsAtPath(
  schema: SchemaObject,
  path: string,
  componentSchemas?: Record<string, SchemaObject>,
): SchemaObject[] | undefined {
  let reached = [schema];
  for (const segment of path.split('.')) {
    const next = new Map<string | SchemaObject, SchemaObject>();
    for (const node of reached) {
      const fields = fieldsNamed(node, segment, componentSchemas);
      if (!fields) return undefined;
      for (const field of fields) next.set(field.$ref ?? field, field);
    }
    reached = [...next.values()];
  }
  return reached;
}

/**
 * The fields `segment` names in `node` (`fieldsAtPath`): its own property of
 * that name, else that property in each non-null variant of the
 * `oneOf`/`anyOf` `node` is. `undefined` when `node`, or any variant, lacks it.
 */
function fieldsNamed(
  node: SchemaObject,
  segment: string,
  componentSchemas?: Record<string, SchemaObject>,
): SchemaObject[] | undefined {
  const own = objectProperties(node, componentSchemas)[segment];
  if (own) return [own];
  const bare = resolveBareSchema(node, componentSchemas);
  const variants = (bare.oneOf ?? bare.anyOf ?? []).filter((variant) => !isNullSchema(variant));
  const fields = variants.map((variant) => objectProperties(variant, componentSchemas)[segment]);
  return fields.length > 0 && fields.every((field) => field !== undefined) ? fields : undefined;
}

function hasType(schema: SchemaObject, type: string): boolean {
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function isNumeric(schema: SchemaObject): boolean {
  return hasType(schema, 'integer') || hasType(schema, 'number');
}

/**
 * The schema under every `$ref`, nullable wrapper and lone `allOf` member:
 * a `$ref` is followed to its component; a nullable wrapper — an OAS 3.1
 * type list naming `'null'`, OAS 3.0 `nullable: true`, a `oneOf`/`anyOf`
 * with one non-null variant — is stripped by `unwrapNullableSchema`, the
 * one definition the model side unwraps by; and an `allOf` with one member
 * that is what types the schema (`classifyInlineSchema`: a `$ref` member,
 * or an inline member with a type of its own — not an `allOf` of bare
 * limits beside the schema's own `type`) is read as that member exactly
 * when `schemaToTypeRef` types the schema as it (`readInlineAllOf`:
 * `'unwrapped'` or `'reference'`; a `required` beside a lone `$ref`
 * member to a component that declares properties makes the schema the
 * merged model, which is left as written), so
 * `has_more: { allOf: [{ $ref: Flag }], description }` with `Flag: { type:
 * boolean }` is a boolean here as it is in the IR. The three alternate
 * until the schema is
 * none of them, so `{ oneOf: [{ $ref: 'Tags' }, { type: 'null' }] }` with
 * `Tags: { type: ['array', 'null'], items }` reaches the array. Sibling
 * `properties` are folded into the `allOf` by the unwrap
 * (`foldSiblingProperties`), so a member with properties beside it is
 * never alone, and an `allOf` of several members is left as written for
 * the readers that merge them (`objectProperties`,
 * `collectObjectProperties`). A `$ref` met a second time
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
  if (bare.$ref) return resolveBareSchema(bare, componentSchemas, seen);
  const lone =
    bare.allOf?.length === 1 &&
    classifyInlineSchema(bare) === 'allOf' &&
    readInlineAllOf(bare.allOf, bare, componentSchemas) !== 'merged'
      ? bare.allOf[0]
      : undefined;
  return lone ? resolveBareSchema(lone, componentSchemas, seen) : bare;
}

function isNullSchema(schema: SchemaObject): boolean {
  return schema.type === 'null' || (Array.isArray(schema.type) && schema.type.every((t) => t === 'null'));
}

/**
 * The properties of an object schema as `collectObjectProperties` collects
 * them — the one walk through `$ref`s, `allOf` members and nullable wrappers,
 * with a name two members declare settled by `combineDeclarations` — for a
 * site that reads the properties alone. Anything that is not an object
 * yields none.
 */
function objectProperties(
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
): Record<string, SchemaObject | undefined> {
  return collectObjectProperties(schema, componentSchemas).properties;
}

/**
 * Every property the object `schema` describes declares, merged across its
 * `allOf` members, with the `required` lists that go with them — the one
 * walk through a composite schema: a list envelope's companions
 * (`extractListResponse`), a kept wrapper's stop field
 * (`bodyEndOfIteration`), a metadata companion's fields and each object
 * on the path to a nested array (`detectEndOfIteration`) and every
 * segment of a `dataPath` (`resolveSchemaPath`) are all read through it,
 * so they see one shape at every level.
 *
 * Every node the walk meets — the body, then each `allOf` member, however
 * deep — is read through `resolveBareSchema`, the resolver the explicit
 * `dataPath` walk reads the document with: a `$ref` is followed to its
 * component and a nullable wrapper of any spelling (a type list naming
 * `null`, OAS 3.0 `nullable: true`, a `oneOf`/`anyOf` with one non-null
 * variant) is stripped, however the two alternate. So fields an envelope
 * inherits from a shared base (`trace_id` on every response, say) are not
 * silently dropped whether the member is written `$ref: Base`, `{ oneOf: [{
 * $ref: Base }, { type: 'null' }] }`, a `$ref` to such a wrapper, or an
 * `allOf` nested inside one — and a stop field declared in any of them is
 * read. The one place the walk resolves a node, so the companions and the
 * stop field are read from the same shape, at every level, that the path
 * walk reaches the data array through. One `seen` runs through the whole
 * walk: the `$ref` strings `resolveBareSchema` records as it follows them,
 * handed to every call the walk makes, so a reference reached inside a
 * wrapper is as seen as one written on the member; and, for an inline
 * node, the schema object itself. No node is entered twice, under whatever
 * wrapper or at whatever depth it reappears, so a component that reaches
 * itself (`Base.allOf` holding `{ oneOf: [{ $ref: Base }, { type: 'null'
 * }] }`, or `{ $ref: Base }` outright), two components that reach each
 * other, and a document whose objects form a cycle are each read once and
 * end the walk where they repeat. An `allOf` member's own `properties`
 * beside its `allOf` are folded in as its first member
 * (`foldSiblingProperties`, through `unwrapNullableSchema`). A property
 * declared by more than one member is settled exactly as every `allOf`
 * merge settles it for a model's field (`combineDeclarations`): two inline
 * objects merge their properties — `pagination.next` from one member and
 * `pagination.total` from another both belong to the response, as they do
 * to the wrapper's model — two arrays keep the `items` that say something,
 * and otherwise the first declaration that declares a type types it, a
 * typeless one only annotating it. (Envelope detection reads the
 * members' own `properties`; a `oneOf`/`anyOf` member with more than one
 * non-null variant declares none, so it contributes nothing here. A body
 * that is not an envelope is merged by `mergeAllOfMembers`, which reads such
 * a member's variants.)
 */
export function collectObjectProperties(
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
): { properties: Record<string, SchemaObject>; required: string[] } {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];
  const seenRefs = new Set<string>();
  const seenNodes = new WeakSet<SchemaObject>();

  const visit = (s: SchemaObject): void => {
    if (seenNodes.has(s)) return;
    seenNodes.add(s);
    const bare = resolveBareSchema(s, componentSchemas, seenRefs);
    // A reference the walk has followed already, or one nothing resolves:
    // the walk ends on it, as the resolver did.
    if (bare.$ref) return;
    for (const sub of bare.allOf ?? []) visit(sub);
    for (const [key, prop] of Object.entries(bare.properties ?? {})) {
      if (!prop) continue;
      const existing = properties[key];
      properties[key] = existing ? combineDeclarations(existing, prop) : prop;
    }
    if (bare.required) required.push(...bare.required);
  };
  visit(schema);

  return { properties, required };
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
 * no strategy or no `param` from any source, a `pageStart` under a strategy
 * other than `page`, a resolved `param`/`limitParam` the operation does not
 * declare as a query parameter, one parameter resolved as both — after an
 * `[oagen] Warning:` naming the problem (`resolveOverrideParams`). An
 * explicit `endOfIteration` is checked against the primary response before
 * this is reached (`endOfIterationProblem`, asked by `extractResponses`), so
 * one that arrives here resolves and fits. `strategy: 'none'` yields
 * `undefined`.
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
 * `applyPaginationOverride` emits): no strategy from any source, a
 * `pageStart` under a strategy other than `page`, no `param` from any
 * source, a resolved `param` or `limitParam` the operation does not declare
 * as a query parameter, or one query parameter resolved as both. Shared with
 * `buildOperation`, which asks before classification whether an override
 * will be usable, so an override that will be rejected never changes how
 * the response is read.
 */
export function resolveOverrideParams(
  detected: PaginationMeta | undefined,
  merged: PaginationHint,
  queryParams: Parameter[],
): { strategy: PaginationStrategy; param: string; limitParam?: string } | { problem: string } {
  const strategy = merged.strategy === 'none' ? undefined : (merged.strategy ?? detected?.strategy);
  if (!strategy) return { problem: ' sets no strategy and none was detected — ignoring the override' };
  // A first page number means nothing to an iterator that does not count
  // pages, so one set for another strategy is a contradiction, not a field
  // to drop quietly.
  if (merged.pageStart !== undefined && strategy !== 'page') {
    return {
      problem: `: pageStart ${merged.pageStart} applies to the "page" strategy only, not to "${strategy}" — ignoring the override`,
    };
  }
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
  // The two are checked against each other as resolved, so `{ param:
  // 'limit' }` next to a detected `limitParam: 'limit'` is caught as surely
  // as an override that names the same parameter twice: one parameter
  // cannot carry both the page and the page size.
  if (param === limitParam) {
    return { problem: `: param and limitParam both name "${param}" — ignoring the override` };
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
 * Check one override object's shape. Returns the typed hint with only the
 * keys the author set, or `undefined` after a warning when any field is
 * malformed. An unknown key is reported and skipped without invalidating the
 * rest, and a key set to `undefined` counts as absent. What the fields say
 * about the operation — whether the parameters are declared, the `dataPath`
 * reaches an array, the `endOfIteration` resolves to a field of the fitting
 * type — is checked later, against the operation (`resolveOverrideParams`,
 * `endOfIterationProblem`).
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

/** The shape alone: a known `kind` and a non-empty `path`. Whether the path resolves is `endOfIterationProblem`'s question. */
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
