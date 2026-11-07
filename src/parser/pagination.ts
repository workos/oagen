import { isDeepStrictEqual } from 'node:util';
import type {
  Field,
  TypeRef,
  Parameter,
  Model,
  PaginationMeta,
  PaginationEndOfIteration,
  PaginationStrategy,
} from '../ir/types.js';
import type { PaginationHint } from '../ir/operation-hints.js';
import type { SchemaObject } from './schemas.js';
import { componentKeyOf, isPendingSchemaRef } from './schema-refs.js';
import {
  allOfReadAsMember,
  classifyInlineSchema,
  componentUnionDispatches,
  declaresNull,
  isArraySchema,
  isNullSchema,
  nullableAxisBranch,
  resolveComponentSchemaRef,
  resolveSchemaName,
  unionAxesOf,
  unionTypesSchema,
  unwrapNullableSchema,
  wrapperDiscriminatorOf,
} from './schemas.js';
import { toSnakeCase } from '../utils/naming.js';
import {
  annotatedTypingMember,
  combineDeclarations,
  declareVariant,
  readInlineAllOf,
  schemaShapeKey,
  unionOfDeclarations,
  type PropertyDeclarations,
} from './inline-models.js';

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
 * Every companion name that can end an iteration, each in any spelling
 * (`spellsOneOf`). List-envelope detection treats a companion with one of
 * these names as pagination metadata, and `detectEndOfIteration` reads it,
 * so the two can never disagree about which envelopes carry a stop field.
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
 * which does not contain `meta`. A name that runs its words together is one
 * word, so a pattern of several is not found in it (`pageinfo` and
 * `PAGEINFO` are no `page_info`), while a one-word pattern still is
 * (`listmetadata` holds `meta`). The one recognizer for list-envelope
 * detection and the nested stop-field scan, so the two cannot disagree
 * about which companions are pagination metadata.
 */
export function looksLikePaginationMetadata(name: string): boolean {
  const spelled = toSnakeCase(name);
  return PAGINATION_METADATA_PATTERNS.some((pattern) => spelled.includes(pattern));
}

/**
 * Whether `name` is one of `fields` in some spelling: read by its words, in
 * the snake_case spelling `looksLikePaginationMetadata` reads a companion's
 * name in (`toSnakeCase`), it is a listed name read the same way. Case and
 * separators do not matter, so `has_more`, `hasMore`, `HasMore`, `has-more`
 * and `HAS_MORE` are all `has_more`, while a name that runs its words
 * together is one word: `hasmore` is no `has_more` and `totalpages` no
 * `total_pages`. A name holding a `.` is none of them: a stop field's path
 * is dotted, so `has.more` would be read as `more` inside `has`. The one
 * test of a stop field's name, for list-envelope detection
 * (`END_OF_ITERATION_FIELDS`) and for `detectEndOfIteration` (each kind's
 * list), so the two cannot disagree about which companion is a stop field.
 */
export function spellsOneOf(name: string, fields: readonly string[]): boolean {
  if (name.includes('.')) return false;
  const spelled = toSnakeCase(name);
  return fields.some((field) => toSnakeCase(field) === spelled);
}

/**
 * Find the envelope field that ends an iteration, when the envelope declares
 * an obvious one. `properties` are the envelope's merged properties — those
 * every instance carries (`collectObjectProperties`, `onEveryInstance`: a
 * member's, or declared by every variant of a `oneOf`/`anyOf` the `allOf`
 * flattens, so a stop field only some variants declare, or one they type
 * differently, ends no iteration; workos/oagen#622) — and `dataPath` names
 * the data array among them.
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
 * segment as the document does (`pageInfo.hasNextPage`). A candidate is a
 * stop field by its name in any spelling (`spellsOneOf`), so `HasMore` and
 * `PageInfo.HasNextPage` are read as `has_more` and
 * `page_info.has_next_page` are, each kept as written; a name holding a
 * `.` is neither a stop field nor a companion looked inside, since the
 * dotted path could not address it (`has.more`, `page.info`). When several
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
    // A `.` in the name would split the path inside it.
    if (name.includes('.') || !looksLikePaginationMetadata(name)) continue;
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
  // The name decides the kind, in any spelling (`spellsOneOf`), and only a
  // named stop field has its schema read: a companion of any other name is
  // never resolved at all.
  const kind: PaginationEndOfIteration['kind'] | undefined = spellsOneOf(name, HAS_MORE_FIELDS)
    ? 'hasMore'
    : spellsOneOf(name, TOTAL_PAGES_FIELDS)
      ? 'totalPages'
      : spellsOneOf(name, TOTAL_COUNT_FIELDS)
        ? 'totalCount'
        : undefined;
  if (!kind) return undefined;
  return endDeclarationFits(kind, schema, componentSchemas) ? kind : undefined;
}

/**
 * Whether a stop field's bare schema (`resolveBareSchema`) has the type its
 * kind is tested against: a `boolean` for `hasMore`, an `integer` or
 * `number` for `totalPages` and `totalCount`, under a type list too. The
 * test `endDeclarationFits` applies to a declaration, or to each variant
 * of one.
 */
function endFieldFits(kind: PaginationEndOfIteration['kind'], schema: SchemaObject): boolean {
  return kind === 'hasMore' ? hasType(schema, 'boolean') : isNumeric(schema);
}

/**
 * Whether a stop field's declaration fits its kind: its bare schema
 * (`resolveBareSchema`) has the kind's type (`endFieldFits`) — `total: {
 * type: 'integer', anyOf: [{ maximum: 100 }, { minimum: 200 }] }` is the
 * integer its own `type` says, the union only limiting it, as
 * `classifyInlineSchema` reads such a schema (PR #643 review round 5:
 * every union was walked, so the limits were tested without the `type`,
 * the detected stop rule disappeared and an explicit `endOfIteration`
 * naming the field was rejected) — or, where it declares no such type, it
 * is a `oneOf`/`anyOf` that is what types it (`unionTypesSchema`: a
 * variant carries a typing keyword) and each non-null variant's
 * declaration fits in turn. The declaration the model types a property
 * only variants declare as is such a union when the variants' declarations
 * differ (`unionOfDeclarations`: `has_more: { type: 'boolean', const: true
 * }` in one variant and `{ type: 'boolean', const: false }` in the other,
 * or `{ $ref: Flag }` beside `{ type: 'boolean' }`), so it is tested as the
 * override walk tests the field it lands on one level down, in every
 * variant (`endOfIterationProblem`, `fieldsAtPath`) — PR #643 review
 * (MichaelDeBoey): the union was tested as one schema, so such a `has_more`
 * ended no iteration at the top level and an explicit `endOfIteration`
 * naming it was rejected as "not a boolean field", while `meta.has_more`
 * through the same union was accepted. A union reached again through
 * another variant — `Flag`, an `anyOf` of boolean consts, declared `{
 * $ref: Flag }` in one variant and `{ anyOf: [{ $ref: Flag }, { type:
 * 'boolean' }] }` in the other — is a shared reference, tested once and
 * read in each (`DeclarationWalk.done`; PR #643 review round 7: one `seen`
 * set served both variants, so the second reading was taken for a cycle,
 * the stop rule dropped and the override rejected, while `meta.has_more`
 * through the same declarations passed); only a union met again below
 * itself, on the way down (`DeclarationWalk.path`), fits nothing, which
 * ends a component that reaches itself. The one test for a field
 * detection names and for one an override names.
 */
function endDeclarationFits(
  kind: PaginationEndOfIteration['kind'],
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
  walk: DeclarationWalk = { path: new Set(), done: new Map() },
): boolean {
  const bare = resolveBareSchema(schema, componentSchemas);
  if (endFieldFits(kind, bare)) return true;
  const variants = bare.oneOf ?? bare.anyOf;
  if (!variants || !unionTypesSchema(variants)) return false;
  const known = walk.done.get(bare);
  if (known !== undefined) return known;
  if (walk.path.has(bare)) return false;
  walk.path.add(bare);
  const nonNull = variants.filter((variant) => !isNullSchema(variant));
  const fits =
    nonNull.length > 0 && nonNull.every((variant) => endDeclarationFits(kind, variant, componentSchemas, walk));
  walk.path.delete(bare);
  walk.done.set(bare, fits);
  return fits;
}

/**
 * The bookkeeping of one declaration's test (`endDeclarationFits`): the
 * unions on the way down (`path`), so a union met again below itself fits
 * nothing and the test ends where the document repeats, and the unions
 * tested so far with their result (`done`), so a union reached again
 * through another variant — a shared reference, not a cycle — is tested
 * once. A result reached by closing a cycle is kept: a union that reaches
 * one on the way down reaches it from anywhere, since the way down came
 * through it.
 */
interface DeclarationWalk {
  path: Set<SchemaObject>;
  done: Map<SchemaObject, boolean>;
}

/**
 * Why an explicit `endOfIteration` cannot be read from a body whose
 * properties are `properties`, or `undefined` when it can. `properties` is
 * the map a detected stop field is read from — the body's own and every
 * `allOf` member's, through `$ref`s and nullable wrappers, with what every
 * variant of a `oneOf`/`anyOf` the `allOf` flattens declares
 * (`onEveryInstance`), as `detectEndOfIteration` receives it — so an
 * override and detection look at
 * one map: a field detection would read is one an override may name, and a
 * field it would not see is not there for an override either. `end.path` is
 * walked over that map as an explicit `dataPath` is (`fieldsAtPath`, the
 * one walk `resolveDataPathArray` makes too: through `$ref`s, `allOf`
 * members and nullable wrappers at every further segment, and, where an
 * object on the way does not declare the next segment itself, through each
 * non-null variant of a `oneOf`/`anyOf` that object is or has among its
 * `allOf` members, a variant that is itself a union through each of its
 * own in turn), so it lands on one field per variant; each must fit
 * `end.kind` by the test detection applies to a field it names
 * (`endDeclarationFits`: under `resolveBareSchema` as a detected one is,
 * and, for a declaration that is itself a union of the variants'
 * declarations, in each variant). With no `properties` — an operation
 * whose primary response declares no body — the path resolves to nothing.
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
  if (fields.every((field) => endDeclarationFits(end.kind, field, componentSchemas))) return undefined;
  const expected = end.kind === 'hasMore' ? 'a boolean' : 'an integer or number';
  return `endOfIteration path "${end.path}" is not ${expected} field, as kind "${end.kind}" requires`;
}

/**
 * Every field `path` lands on below `schema` — the walk an explicit
 * `endOfIteration` path (`endOfIterationProblem`) and an explicit `dataPath`
 * (`resolveDataPathArray`) share. Each segment is looked up among the
 * properties of the object the path has reached, as `resolveSchemaPath`
 * looks it up — through `$ref`s, `allOf` members and nullable wrappers —
 * and, when that object does not declare it but is a
 * `oneOf`/`anyOf` or has one among its `allOf` members (`fieldsNamed`), in
 * each non-null variant of that union instead: whichever variant the wire
 * carries, the field must be there, so the path goes on in every one and
 * lands on one field per variant (`meta.has_more` with `meta` a `oneOf` of
 * two objects that each declare `has_more`, or `meta` an `allOf` of that
 * `oneOf` and a `trace_id` member, every member applying whichever variant
 * is sent). `undefined` when the object does not declare the segment and no
 * union it has declares it in every variant (and, for a union an `allOf`
 * flattens, in one written inline, as its model does). A variant that is
 * itself a union — written inline, or a `$ref` to a union component — is
 * read by the same rule: the field must be in each of its non-null
 * variants in turn, however deep the unions nest, since whichever leaf the
 * wire carries the field must be there (`meta.has_more` with `meta` an
 * `anyOf` of a `oneOf` of two objects and a third, every object declaring
 * `has_more`; PR #585 review).
 * The walk goes one segment at a time over every schema reached so far,
 * each counted once — by its `$ref`, else by the schema itself — so a
 * component several variants reach is walked on once, however many
 * variants reach it and however long the path; and within a segment a
 * node is read once however many routes through nested unions reach it
 * (`FieldLookup`).
 */
function fieldsAtPath(
  schema: SchemaObject,
  path: string,
  componentSchemas?: Record<string, SchemaObject>,
): SchemaObject[] | undefined {
  let reached = [schema];
  const lookup = newFieldLookup();
  for (const segment of path.split('.')) {
    const next = new Map<string | SchemaObject, SchemaObject>();
    for (const node of reached) {
      const named = fieldsNamed(node, segment, componentSchemas, lookup);
      if (!named) return undefined;
      for (const { schema: field } of named) next.set(field.$ref ?? field, field);
    }
    reached = [...next.values()];
  }
  return reached;
}

/**
 * The fields `segment` names in `node` (`fieldsAtPath`): its own property of
 * that name, else that property in each non-null variant of the first
 * `oneOf`/`anyOf` `node` is composed of — `node` itself or an `allOf`
 * member, however deep, as `collectObjectProperties` walks them — whose
 * every such variant declares it, in the variants' order with the `null`
 * ones left out, each with the variant it came from (`via`: the variant's
 * place as written and the union's keyword, `variantsOf`), so a reader can
 * say which variant a field came from (`resolveDataPathArray`). A variant
 * declares the segment as `node` does — as its own property, or in every
 * non-null variant of a union it is or has — so a variant that is itself a
 * union, written inline or a `$ref` to a union component (`PetPage: {
 * oneOf: [A, B] }`), is walked by this same rule (`unionFields`) and yields
 * one field per leaf, each `via` the steps down to it, outermost first
 * (PR #585 review: such a variant was read as declaring no field, though
 * each of its own variants declared it). A node met again below itself
 * (`PetPage: { oneOf: [{ $ref: PetPage }, A] }`) is not read a second
 * time: the walk ends where it repeats, as `collectObjectProperties` ends
 * on a `$ref` it has followed, so such a variant declares nothing and the
 * union does not count. A lookup once made is kept for the walk
 * (`lookup`, one per path: the `(node, segment)` pairs read so far), so a
 * node several routes reach — two references to one component in one
 * union, or a chain of such unions, where the routes double at every link
 * — is read once, and its fields are collapsed to one per distinct field
 * as they are met (`unionFields`), with the first route that reached it
 * (PR #585 review: twenty components each an `anyOf` of two references to
 * the next built over a million fields, each copying its route). A lookup
 * a cycle closed above — one that ended on a node still on the way down
 * above this one — depends on where the walk came from, and is not kept;
 * one the cycle closed on itself, or no cycle touched, is the same from
 * wherever the walk reaches the node. A `node` that is a union is typed as its
 * variants' models, a `$ref` variant's component among them; one that is an
 * `allOf`, or reaches a component composed with one (its own model, even
 * of a lone member), is one model its unions are flattened into or
 * dispatched by — a `$ref` variant's component read into the flattened
 * model as an inline variant is, and a union a `$ref` member's component
 * carries read as that component's model reads it, inline exactly as for a
 * component (`mergeAllOfMembers`, `extractAllOfModel`; #398, #429) — so a
 * field every variant declares is one the model has, or one the model
 * dispatches to a variant that has it, wherever the union sits and however
 * its variants are written (workos/oagen#527: the flattened model left a
 * `$ref` variant's fields to its component and read no union behind a
 * `$ref` member, so the field was rejected there as one the model lacked).
 * A union the walk meets counts exactly when the model carries its fields
 * (`unionCounts`): one a `$ref` member's component dispatches is left to
 * that component, as the model leaves it, and contributes nothing here.
 * `undefined` when there is none.
 */
function fieldsNamed(
  node: SchemaObject,
  segment: string,
  componentSchemas?: Record<string, SchemaObject>,
  lookup: FieldLookup = newFieldLookup(),
): NamedField[] | undefined {
  const done = lookup.memo.get(node);
  if (done?.has(segment)) return done.get(segment);
  // Met again below itself: it declares nothing, and the walk ends where the document repeats.
  const above = lookup.stack.indexOf(node);
  if (above !== -1) {
    lookup.closed = Math.min(lookup.closed, above);
    return undefined;
  }
  const depth = lookup.stack.push(node) - 1;
  const outer = lookup.closed;
  lookup.closed = Infinity;
  const fields = readFieldsNamed(node, segment, componentSchemas, lookup);
  lookup.stack.pop();
  // Kept unless a cycle closed above this node, which would make the reading depend on the way down.
  if (lookup.closed >= depth) {
    const entry = done ?? new Map<string, NamedField[] | undefined>();
    entry.set(segment, fields);
    lookup.memo.set(node, entry);
  }
  lookup.closed = Math.min(outer, lookup.closed);
  return fields;
}

/**
 * One walk's bookkeeping for `fieldsNamed`: the lookups completed so far,
 * by node and segment (`memo`); the nodes on the way down (`stack`), so a
 * node met again below itself ends the walk where the document repeats; and
 * the shallowest of those a cycle closed on during the lookup in progress
 * (`closed`, the node's place on the stack, `Infinity` when none), which
 * decides whether that lookup is kept. One per path walked (`fieldsAtPath`,
 * `resolveDataPathArray`).
 */
interface FieldLookup {
  memo: Map<SchemaObject, Map<string, NamedField[] | undefined>>;
  stack: SchemaObject[];
  closed: number;
}

function newFieldLookup(): FieldLookup {
  return { memo: new Map(), stack: [], closed: Infinity };
}

/** The reading `fieldsNamed` keeps: the rule itself, see there. */
function readFieldsNamed(
  node: SchemaObject,
  segment: string,
  componentSchemas: Record<string, SchemaObject> | undefined,
  lookup: FieldLookup,
): NamedField[] | undefined {
  // The walk's own bookkeeping is handed on, so a flattened union among the
  // node's members is read with it (`readFlattenedUnion`) and ends where the
  // document repeats.
  const { properties, unions, named } = collectObjectProperties(node, componentSchemas, lookup);
  const own = properties[segment];
  if (own) return [{ schema: own }];
  // A union counts exactly when the model carries its fields (`unionCounts`):
  // one a `$ref` member's component dispatches is left to that component.
  for (const union of unions) {
    if (!unionCounts(union, named, componentSchemas)) continue;
    const fields = unionFields(union, segment, componentSchemas, lookup);
    if (fields && fields.length > 0) return fields;
  }
  return undefined;
}

/** One step down into a `oneOf`/`anyOf`: the variant's place as written, `null` variants counted, and the union's keyword. */
interface VariantStep {
  index: number;
  keyword: 'oneOf' | 'anyOf';
}

/** A field a path segment names (`fieldsNamed`), with the variants it was reached through, outermost first — none for an object's own property. */
interface NamedField {
  schema: SchemaObject;
  via?: VariantStep[];
}

/**
 * Each non-null variant of a `oneOf`/`anyOf` `union` with its step: its
 * place among the variants as written, the `null` ones counted (the third
 * listed is `index` 3 whatever sits before it, as `variantLabel` names it),
 * and the union's keyword.
 */
function variantsOf(union: CollectedUnion): Array<{ step: VariantStep; variant: SchemaObject }> {
  return union.variants.flatMap((variant, index) =>
    isNullSchema(variant) ? [] : [{ step: { index: index + 1, keyword: union.keyword }, variant }],
  );
}

/**
 * The fields `segment` names in every non-null variant of `union`, by the
 * rule `fieldsNamed` applies to any object — so a variant that is itself a
 * union contributes one field per leaf — each `via` its own step and the
 * steps below it; `undefined` when a variant declares none. Repeated
 * fields are collapsed as they are met: one entry per distinct field — by
 * its `$ref`, else the schema itself, as `fieldsAtPath` counts them — with
 * the first route that reached it, so two references to one component
 * yield its fields once, and a chain of such unions yields at each link
 * as many fields as there are distinct ones below, not routes. `lookup`
 * carries the walk's completed lookups and cycle guard (`fieldsNamed`).
 */
function unionFields(
  union: CollectedUnion,
  segment: string,
  componentSchemas: Record<string, SchemaObject> | undefined,
  lookup: FieldLookup,
): NamedField[] | undefined {
  const fields = new Map<string | SchemaObject, NamedField>();
  for (const { step, variant } of variantsOf(union)) {
    const named = fieldsNamed(variant, segment, componentSchemas, lookup);
    if (!named) return undefined;
    for (const field of named) {
      const key = field.schema.$ref ?? field.schema;
      if (!fields.has(key)) fields.set(key, { schema: field.schema, via: [step, ...(field.via ?? [])] });
    }
  }
  return [...fields.values()];
}

/**
 * Whether a union the walk met (`collectObjectProperties`) is one the
 * node's model carries the fields of — flattened in, or dispatched to
 * variant models of its own — so that a field its every variant declares
 * is one the model has (`fieldsNamed`). The node's own unions are: an
 * inline `allOf` flattens every union of its inline members, and a
 * component flattens or dispatches its own. A union a `$ref` member's
 * component carries is read as the model reads the member (#429):
 * flattened into the model when the component's model flattens it, and
 * left to the component when that model dispatches it
 * (`componentUnionDispatches`, the one decision the inline merge and the
 * component reader apply) — the model then carries the base fields the
 * dispatcher carries and no variant's, so the field is not one it has,
 * whatever the variants declare (#398 review: every union counted, so
 * `meta: { allOf: [{ $ref: MetaDispatcher }, { trace_id }] }` accepted a
 * `has_more` every dispatched variant declares, and the iterator read a
 * field `Meta { base, trace_id }` lacks). One exception, the component
 * reader's own (`readComponentAllOfMember`): a component's direct `$ref`
 * member to a plain object that carries the union — no `allOf` of its own
 * nor on the way to it — dispatches the component itself (`Dog: { allOf:
 * [{ $ref: Pet }] }` with `Pet: { properties: { id }, oneOf: [cat, dog] }`
 * dispatches to `DogCat` and `DogDog`), whose variant models carry the
 * field; an inline merge of the same member carries the base fields only.
 */
function unionCounts(union: CollectedUnion, named: boolean, componentSchemas?: Record<string, SchemaObject>): boolean {
  if (union.origin === null) return true;
  if (named && union.origin.direct) return true;
  return !componentUnionDispatches(union.variants, union.origin.name, componentSchemas, union.discriminator);
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
 * explicit `dataPath` makes (`resolveDataPathArray`), so a stop field
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
  const reading =
    bare.allOf && classifyInlineSchema(bare) === 'allOf'
      ? readInlineAllOf(bare.allOf, bare, componentSchemas)
      : undefined;
  // The member the type builder types the `allOf` as: the one unwrapped —
  // a lone member, or the one typing member beside members that only
  // annotate or limit it (`annotatedTypingMember`; #555) — or the `$ref`
  // member of a plain reference, whatever is written beside it.
  const lone =
    reading === 'unwrapped'
      ? annotatedTypingMember(bare)
      : reading === 'reference'
        ? bare.allOf?.find((member) => member.$ref !== undefined)
        : undefined;
  return lone ? resolveBareSchema(lone, componentSchemas, seen) : bare;
}

/**
 * The properties of an object schema as `collectObjectProperties` collects
 * them — the one walk through `$ref`s, `allOf` members and nullable wrappers,
 * with a name two members declare settled by `combineDeclarations` — for a
 * site that reads the properties alone: those every instance carries
 * (`onEveryInstance`), a member's or every variant's of a union the `allOf`
 * flattens, since the sites are the stop-field scan and the walk to each
 * object on a `dataPath` (`detectEndOfIteration`, `resolveSchemaPath`).
 * Anything that is not an object yields none.
 */
function objectProperties(
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
): Record<string, SchemaObject | undefined> {
  return collectObjectProperties(schema, componentSchemas).onEveryInstance;
}

/**
 * Every property the object `schema` describes declares, merged across its
 * `allOf` members, with the `required` lists that go with them — the one
 * walk through a composite schema: a list envelope's companions
 * (`extractListResponse`), a kept wrapper's stop field
 * (`bodyEndOfIteration`), a metadata companion's fields and each object
 * on the path to a nested array (`detectEndOfIteration`) and every
 * segment of a `dataPath` (`resolveSchemaPath`, `fieldsNamed`) are all read
 * through it, so they see one shape at every level.
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
 * to the wrapper's model — two arrays combine their `items` by the same
 * rule, two declarations that each describe an object — an inline object,
 * a `$ref` to an object component, an `allOf` that reaches one — become
 * the `allOf` of both, read through as any `allOf` member is
 * (`result.items` from `PetPage` beside `result.total_pages`, written
 * inline or under an `allOf`; #432, #571), and otherwise the first
 * declaration that declares a type types it, a typeless one only annotating
 * it.
 *
 * A `oneOf`/`anyOf` member with more than one non-null variant declares no
 * property of its own here: it is listed in `unions`, with every other
 * `oneOf`/`anyOf` the walk meets — the body itself first, then the members
 * in the order walked — each with the component a `$ref` member on the way
 * names and the `discriminator` the document declares for it
 * (`CollectedUnion`), and `named` says whether the body is typed as a
 * component's model (a `$ref`, or a nullable wrapper or lone `allOf` member
 * around one), for the override check, which reads a field every variant
 * of one declares exactly when the model carries it (`fieldsNamed`,
 * `unionCounts`). What such a union's variants declare is read beside
 * `properties` for a union among the members that the model flattens into
 * the node's one model (`unionCounts`: every inline member's, and a `$ref`
 * member's component's unless that component dispatches it — never the
 * node's own union, a union of models that no field of the node belongs
 * to): `fields` is every property that model has, in the order first
 * declared — `properties` and, for each flattened union, every property
 * any non-null variant declares (`readFlattenedUnion`, through the branch
 * reader the model flattens a variant with), typed as the model types a
 * property only variants declare (`unionOfDeclarations`: one shape is that
 * declaration, several are their `oneOf`) where no member always declares
 * it — and `onEveryInstance` is the part of `fields` an instance carries
 * whichever variant the wire sends: `properties`, and a branch-only
 * property every non-null variant of its union declares, as the override
 * walk resolves a path segment through the union (`unionFields`). An
 * envelope's companions are its `fields` (`extractEnvelopeCompanions`);
 * the array it is unwrapped on and the stop field it stops on must be
 * `onEveryInstance` (`detectListEnvelope`, `detectEndOfIteration`,
 * `bodyEndOfIterationProblem`), so a stop field written in each variant of
 * a `oneOf` beside the `allOf` ends the iteration as one written flat does
 * (workos/oagen#622: `{ allOf: [{ data }], oneOf: [{ has_more }, {
 * has_more, total }] }` built the model `{ data, has_more?, total? }` and
 * was no envelope, the variants read by the model alone), while a field
 * only some variants declare, or one they type differently, is a companion
 * and no stop field. A body that is not an envelope is merged by
 * `mergeAllOfMembers`, whose reading of a variant `readFlattenedUnion`
 * shares. `lookup` is the override walk's bookkeeping when that walk is
 * what reads the node (`readFieldsNamed`), so the variants are read once
 * per walk and a variant met again below itself ends the reading where
 * the document repeats.
 */
export function collectObjectProperties(
  schema: SchemaObject,
  componentSchemas?: Record<string, SchemaObject>,
  lookup?: FieldLookup,
): CollectedProperties {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];
  const unions: CollectedUnion[] = [];
  const seenRefs = new Set<string>();
  const seenNodes = new WeakSet<SchemaObject>();
  let named: boolean | undefined;
  // Every name met, in the order first declared, by a member or by a
  // variant; what the variants of each flattened union declare of a name
  // (`readFlattenedUnion`), and the names every variant of one declares.
  const order: string[] = [];
  const noted = new Set<string>();
  const note = (name: string): void => {
    if (noted.has(name)) return;
    noted.add(name);
    order.push(name);
  };
  const branchOnly = new Map<string, SchemaObject[]>();
  const carried = new Set<string>();
  const walk = lookup ?? newFieldLookup();

  // The component a member's `$ref` names, as the model reads the member
  // (`CollectedUnion.origin`): the first reference the resolver followed
  // for the member, counting from the `from`th it recorded; `direct` when
  // the member is one of the node's own and every component on the way to
  // the schema it lands on is a plain object or an alias — none composed
  // with `allOf`, which the component reader reads as a nested component
  // whose own dispatcher stays its own. `null` for an inline member.
  const memberOrigin = (from: number, depth: number): CollectedUnion['origin'] => {
    const refs = [...seenRefs].slice(from);
    const key = componentKeyOf(refs[0]);
    if (key === undefined) return null;
    const direct =
      depth === 1 &&
      refs.every((ref) => resolveComponentSchemaRef({ $ref: ref }, componentSchemas)?.allOf === undefined);
    return { name: resolveSchemaName(key), direct };
  };

  const visit = (
    s: SchemaObject,
    depth: number,
    inherited: CollectedUnion['origin'],
    wrapperDiscriminator?: SchemaObject['discriminator'],
  ): void => {
    if (seenNodes.has(s)) return;
    seenNodes.add(s);
    const followed = seenRefs.size;
    // A member's references are followed here first, recorded as the
    // resolver records them, so a component writing both keywords is read
    // per keyword below rather than collapsed by the resolver onto a
    // nullable axis's one variant with the other axis lost.
    let carrier = s;
    while (depth > 0 && carrier.$ref) {
      if (seenRefs.has(carrier.$ref)) return;
      seenRefs.add(carrier.$ref);
      const target = resolveComponentSchemaRef(carrier, componentSchemas);
      if (!target) return;
      carrier = target;
    }
    const bare =
      depth > 0 && carrier.oneOf && carrier.anyOf ? carrier : resolveBareSchema(carrier, componentSchemas, seenRefs);
    // A reference the walk has followed already, or one nothing resolves:
    // the walk ends on it, as the resolver did.
    if (bare.$ref) return;
    // The node's own unions are its model's, whatever it resolves through;
    // a member's are read as the component its `$ref` names reads them.
    named ??= seenRefs.size > followed;
    const origin = depth === 0 ? null : (inherited ?? memberOrigin(followed, depth));
    // The `discriminator` declared for a union here: the schema's own, else
    // the member's own written on a nullable wrapper the resolver collapsed
    // (`carrier`), else the one handed down from above — as the readers read
    // it, so `unionCounts` agrees with the model.
    const discriminator = bare.discriminator ?? carrier.discriminator ?? wrapperDiscriminator;
    if (depth === 0) {
      // The node's own union is the one the type builder types it by: its
      // `oneOf`, else its `anyOf` (`unionVariantsOf`).
      const variants = bare.oneOf ?? bare.anyOf;
      if (variants)
        unions.push({ schema: bare, keyword: bare.oneOf ? 'oneOf' : 'anyOf', variants, origin, discriminator });
    } else {
      // A member's unions, one per keyword, as the merge reads them
      // (`mergeAllOfMembers`, `unionAxesOf`); a nullable wrapper beside the
      // other keyword is its one variant, read as one more member in the
      // member's own capacity (`nullableAxisBranch`) — alone, the resolver
      // collapsed it already (#398 review round 3: a member writing both was
      // one union read by its `oneOf`, so a stop field only the `anyOf`'s
      // variants declare, which the model has, resolved to no field).
      for (const variants of unionAxesOf(bare)) {
        const keyword = variants === bare.oneOf ? 'oneOf' : 'anyOf';
        const branch = bare.oneOf && bare.anyOf ? nullableAxisBranch(bare, variants) : undefined;
        if (branch) {
          visit(branch, depth, origin, discriminator);
          continue;
        }
        const union: CollectedUnion = { schema: bare, keyword, variants, origin, discriminator };
        unions.push(union);
        // What the variants declare, when the model flattens the union into
        // the node's model (`unionCounts`): branch-only fields of that model,
        // carried by every instance when every variant declares them.
        if (!unionCounts(union, named ?? false, componentSchemas)) continue;
        const read = readFlattenedUnion(union, componentSchemas, walk);
        for (const [name, declarations] of read.declared) {
          note(name);
          const held = branchOnly.get(name);
          if (held) held.push(...declarations);
          else branchOnly.set(name, [...declarations]);
          if (read.carried.has(name)) carried.add(name);
        }
      }
    }
    for (const sub of bare.allOf ?? []) visit(sub, depth + 1, origin, wrapperDiscriminatorOf(bare));
    for (const [key, prop] of Object.entries(bare.properties ?? {})) {
      if (!prop) continue;
      note(key);
      const existing = properties[key];
      properties[key] = existing ? combineDeclarations(existing, prop) : prop;
    }
    if (bare.required) required.push(...bare.required);
  };
  visit(schema, 0, null);

  // A member's declaration stands whatever a variant says — a variant can
  // only narrow what every instance carries — and a name only variants
  // declare is typed as the model types it.
  const fields: Record<string, SchemaObject> = {};
  const onEveryInstance: Record<string, SchemaObject> = {};
  for (const name of order) {
    const own = properties[name];
    if (own) {
      fields[name] = own;
      onEveryInstance[name] = own;
      continue;
    }
    const declaration = unionOfDeclarations(branchOnly.get(name) ?? []);
    fields[name] = declaration;
    if (carried.has(name)) onEveryInstance[name] = declaration;
  }

  return { properties, required, unions, named: named ?? false, fields, onEveryInstance };
}

/**
 * What `collectObjectProperties` reads off an object schema: see there.
 * `properties` is what the schema and its always-applying `allOf` members
 * declare, `fields` every property the model built from it has, and
 * `onEveryInstance` the part of `fields` an instance carries whichever
 * variant of a flattened union the wire sends.
 */
export interface CollectedProperties {
  properties: Record<string, SchemaObject>;
  required: string[];
  unions: CollectedUnion[];
  named: boolean;
  fields: Record<string, SchemaObject>;
  onEveryInstance: Record<string, SchemaObject>;
}

/**
 * What a `oneOf`/`anyOf` the model flattens into one model contributes to
 * that model (`collectObjectProperties`, `detectListEnvelope`): `declared`,
 * every property any non-null variant declares, with each variant's
 * declaration of it, in the order first declared — each variant read as the
 * model reads one it flattens (`declareVariant`: its own `properties`, its
 * `allOf` members, the component a `$ref` variant names, the branches of a
 * union nested in it), so the names and the declarations are the merged
 * model's (`mergeAllOfMembers`) — and `carried`, the names every non-null
 * variant declares, resolved as the override walk resolves a path segment
 * through the union (`unionFields`: a variant that is itself a union must
 * declare the name in each of its own variants, and one met again below
 * itself declares nothing), so a field an instance carries whichever
 * variant the wire sends is one the detected stop field and an explicit
 * `endOfIteration` both read, and a field only some variants declare is one
 * neither reads. `lookup` is the walk's bookkeeping (`fieldsNamed`).
 */
export function readFlattenedUnion(
  union: CollectedUnion,
  componentSchemas?: Record<string, SchemaObject>,
  lookup: FieldLookup = newFieldLookup(),
): { declared: Map<string, SchemaObject[]>; carried: Set<string> } {
  const ledger = new Map<string, PropertyDeclarations>();
  for (const variant of union.variants) {
    if (!isNullSchema(variant)) declareVariant(ledger, variant, componentSchemas);
  }
  const declared = new Map<string, SchemaObject[]>();
  const carried = new Set<string>();
  for (const [name, { conditional }] of ledger) {
    declared.set(name, conditional);
    const fields = unionFields(union, name, componentSchemas, lookup);
    if (fields !== undefined && fields.length > 0) carried.add(name);
  }
  return { declared, carried };
}

/**
 * One `oneOf`/`anyOf` the walk meets (`collectObjectProperties`): the
 * resolved schema that writes it; the component a `$ref` member of an
 * `allOf` on the way names, as the model reads the member (`direct` when
 * that member is one of the node's own and the component itself carries
 * the union), or `null` for a union the node's own model carries — the
 * node itself, or an inline member; and the `discriminator` the document
 * declares for it, on the schema or on the `allOf` wrapper around it
 * (`wrapperDiscriminatorOf`). What the override check decides from
 * (`unionCounts`).
 */
export interface CollectedUnion {
  schema: SchemaObject;
  keyword: 'oneOf' | 'anyOf';
  variants: SchemaObject[];
  origin: { name: string; direct: boolean } | null;
  discriminator?: SchemaObject['discriminator'];
}

// ---------------------------------------------------------------------------
// Resolving a dotted `dataPath`
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted property path (the `dataPath` convention) to the one
 * object it names in a response schema — the walk detection makes to each
 * object on the way to a nested array (`detectEndOfIteration`): each
 * segment is looked up among the object's own properties — through `$ref`s,
 * `allOf` members and nullable wrappers — and the schema it lands on is
 * returned with a final `$ref` resolved. `undefined` when a segment is
 * missing, so also when an object on the way is a `oneOf`/`anyOf` whose
 * variants declare it: a union of models declares no companion a stop
 * field is detected from. A segment every variant of a union the object's
 * `allOf` flattens declares is reached, as the one model's field it is
 * (`onEveryInstance`; workos/oagen#622). An explicit `dataPath` is walked
 * through the variants instead (`resolveDataPathArray`, workos/oagen#556).
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
 * The array an explicit `dataPath` names in a response body, read from the
 * document: the `items` schema of the array the path lands on, or the reason
 * it lands on none — the text of the warning the override is rejected with
 * (`dataPathProblem`), naming the problem alone.
 *
 * Each segment is looked up as an explicit `endOfIteration` path is
 * (`fieldsAtPath`): among the properties of the object the path has reached,
 * through `$ref`s, `allOf` members and nullable wrappers (what
 * `resolveSchemaPath` reads), and, where that object does not declare the
 * segment itself but is a `oneOf`/`anyOf` or has one among its `allOf`
 * members (`fieldsNamed`), in each non-null variant of that union — and of
 * a variant that is itself a union, inline or a `$ref` to a union
 * component, in each of its own in turn, however deep: whichever
 * variant the wire carries, the array must be there, so `result.items` on
 * `{ result: { oneOf: [A, B] } }` goes on in both `A` and `B`
 * (workos/oagen#556), and on `{ result: { anyOf: [{ oneOf: [A, B] }, B] } }`
 * in all three (PR #585 review). The path then lands on one field per
 * variant, and the override is usable only when every one is an array —
 * under a nullable wrapper too (`resolveBareSchema`) — and the arrays agree
 * on their items, each read as the type builder reads them (`itemsKey`:
 * nullable wrappers and an `allOf` read as one member collapsed, however
 * they alternate): the same component (`$ref: Pet` in both, one of them
 * written `{ allOf: [{ $ref: Pet }], description }`, the OAS 3.0 way of
 * describing a `$ref`) or the same inline shape (`schemaShapeKey`, which
 * reads past descriptions and extensions), admitting `null` alike, since
 * the SDK iterates one item type whichever variant arrives. The first
 * array's `items` stands for them all, as written. A variant that lacks the
 * segment, declares it as something other than an array, or types its items
 * otherwise (`Pet` in one variant, `Cat` in another) makes the path
 * unusable, and the reason says which variant lacks the field — the one of
 * its own, below a variant that is itself a union — or how the variants
 * type it. An array without `items` is no array an iterator can type, as
 * it never was.
 */
export function resolveDataPathArray(
  schema: SchemaObject,
  dataPath: string,
  componentSchemas?: Record<string, SchemaObject>,
): { items: SchemaObject } | { problem: string } {
  const walked = walkDataPathArray(schema, dataPath, componentSchemas);
  return 'items' in walked ? { items: walked.items } : walked;
}

/**
 * Whether an explicit `dataPath` lands on more than one array: it went on
 * through the variants of a union on its way — the body itself, or an
 * object on the way, being a `oneOf`/`anyOf` or having one among its
 * `allOf` members (`fieldsNamed`) — and the variants reach distinct arrays,
 * their `items` distinct schemas in the document. Each variant's model then
 * types inline items under a name of its own, and only the document can
 * type them once, under the path-derived name (#556), so an override whose
 * IR walk crossed a pending pointer reference reads the document at
 * extraction for such a path rather than deferring to the settle, where the
 * IR walk would find the variants' arrays disagreeing by name
 * (`resolveOverrideItemType`; Greptile, #608 review). Variants that reach
 * one array are no fork — every variant holding the same pointer (`{ oneOf:
 * [A, B] }`, both `result: { $ref: '#/components/schemas/Holder/properties/
 * result' }`, with `dataPath: 'result.items'`), or pointers that resolve to
 * one component, as `resolveBareSchema` follows them — since the one schema
 * is built as one model where it stands and the settled walk agrees on its
 * items (`HolderResultItem`), exactly as both holding `$ref: Result` agree
 * on `ResultItem` (MichaelDeBoey, #651 review); the arrays are told apart
 * by their `items` object rather than their own, which a nullable array
 * component unwraps to afresh at each reading. A `null` variant set aside
 * as a nullable wrapper is no fork either. `false` for a path that lands on
 * no array.
 */
export function dataPathForks(
  schema: SchemaObject,
  dataPath: string,
  componentSchemas?: Record<string, SchemaObject>,
): boolean {
  const walked = walkDataPathArray(schema, dataPath, componentSchemas);
  return 'items' in walked && walked.forked;
}

/** The walk `resolveDataPathArray` makes, saying too whether the path landed on more than one array (`forked`; see `dataPathForks`). */
function walkDataPathArray(
  schema: SchemaObject,
  dataPath: string,
  componentSchemas?: Record<string, SchemaObject>,
): { items: SchemaObject; forked: boolean } | { problem: string } {
  const missing = `dataPath "${dataPath}" does not resolve to an array in the response`;
  const segments = dataPath.split('.');
  // The path to the first union the walk went on through (`''` for the body
  // itself), which the reason names when the variants disagree.
  let union: string | undefined;
  // Every schema the path has reached so far, each with the variant it came
  // through (`variant 2 of the oneOf at "result"`), none for the body itself
  // or a field an object declares on its own.
  let reached: Array<{ schema: SchemaObject; via?: string }> = [{ schema }];
  const lookup = newFieldLookup();
  for (const [depth, segment] of segments.entries()) {
    const prefix = segments.slice(0, depth).join('.');
    const next = new Map<string | SchemaObject, { schema: SchemaObject; via?: string }>();
    for (const { schema: node, via } of reached) {
      const named = fieldsNamed(node, segment, componentSchemas, lookup);
      if (!named) {
        const lacking = variantLacking(node, segment, componentSchemas, lookup);
        const reason = lacking
          ? `${variantLabel(lacking, prefix)} declares no "${segment}"`
          : via === undefined
            ? undefined
            : `${unionAt(prefix)} declares no "${segment}" in ${via}`;
        return { problem: reason ? `${missing}: ${reason}` : missing };
      }
      for (const field of named) {
        if (field.via) union ??= prefix;
        const label = field.via ? variantLabel(field.via, prefix) : via;
        next.set(field.schema.$ref ?? field.schema, { schema: field.schema, via: label });
      }
    }
    reached = [...next.values()];
  }
  const bare = reached.map(({ schema: field }) => resolveBareSchema(field, componentSchemas));
  const arrays = bare.filter((field) => isArraySchema(field) && field.items !== undefined);
  if (arrays.length < bare.length) {
    if (union === undefined) return { problem: missing };
    return { problem: `${missing}: the variants of ${unionAt(union)} type it as ${listed(bare.map(describeSchema))}` };
  }
  const items = arrays.map((array) => array.items as SchemaObject);
  if (new Set(items.map(itemsKey)).size > 1) {
    return {
      problem:
        `dataPath "${dataPath}" does not resolve to one array in the response: ` +
        `the variants of ${unionAt(union ?? '')} type its items as ${listed(items.map(describeItems))}`,
    };
  }
  return { items: items[0], forked: new Set(items).size > 1 };
}

/**
 * An array's `items` as the type builder reads them, for deciding whether
 * two variants' arrays iterate one type: a nullable wrapper of any spelling
 * (`unwrapNullableSchema`) and an `allOf` read as one member — a lone
 * member with nothing added to it, or a plain reference
 * (`allOfReadAsMember`) — collapsed, however the two alternate, as
 * `arraySchemaOf` finds an array and `resolveBareSchema` reads a stop field
 * (PR #585 review: `{ allOf: [{ $ref: Pet }], description: 'A pet' }` beside
 * `{ $ref: Pet }` was rejected as `Pet and allOf`, though both variants'
 * models type the field `Pet[]` and the OAS 3.1 sibling form `{ $ref: Pet,
 * description }` was accepted). A `$ref` is kept as the reference it is, so
 * two components alike in shape are still two types.
 */
function bareItems(items: SchemaObject): SchemaObject {
  const bare = unwrapNullableSchema(items);
  const member = allOfReadAsMember(bare);
  return member ? bareItems(member) : bare;
}

/**
 * What an array's `items` type, as one string two arrays share exactly when
 * the SDK iterates one type: whether they admit `null` (`declaresNull`,
 * through the same wrappers `bareItems` collapses), and the shape of what
 * is left (`schemaShapeKey`, which reads past descriptions and extensions).
 */
function itemsKey(items: SchemaObject): string {
  return `${declaresNull(items) ? 'null | ' : ''}${schemaShapeKey(bareItems(items))}`;
}

/** An array's `items` in a word, for a warning: what the type builder reads (`describeSchema`), `| null` when they admit null. */
function describeItems(items: SchemaObject): string {
  const bare = bareItems(items);
  const word = describeSchema(bare);
  return declaresNull(items) && !hasType(bare, 'null') ? `${word} | null` : word;
}

/**
 * Why an explicit `dataPath` cannot be read from the body `schema`, or
 * `undefined` when it can (`resolveDataPathArray`). With no `schema` — an
 * operation whose primary response declares no body — the path resolves to
 * nothing. The text is the reason alone, as `endOfIterationProblem`'s is;
 * the caller names the override's source and the operation, and says what
 * it does about it.
 */
export function dataPathProblem(
  schema: SchemaObject | undefined,
  dataPath: string,
  componentSchemas?: Record<string, SchemaObject>,
): string | undefined {
  if (!schema) return `dataPath "${dataPath}" does not resolve to an array in the response`;
  const resolved = resolveDataPathArray(schema, dataPath, componentSchemas);
  return 'problem' in resolved ? resolved.problem : undefined;
}

/**
 * Which variant of a union `node` is composed of lacks `segment`, when that
 * is why `fieldsNamed` found no field of that name — the steps down to it,
 * which `variantLabel` renders (`variant 2 of the oneOf at "result"
 * declares no "items"`) — for the warning a `dataPath` is rejected with.
 * The unions are read in the order `fieldsNamed` reads them, the ones it
 * counts (`unionCounts`); the first with
 * a non-null variant that declares no such property, by the rule
 * `fieldsNamed` applies to a variant, explains the miss, and when that
 * variant is itself a union the steps go on into it, to the variant of its
 * own that lacks the field (`variant 2 of the oneOf in variant 1 of the
 * anyOf at "result"`), so the warning never says a variant declares no
 * field its own variants all declare (PR #585 review); a variant met again
 * below itself declares nothing, so the steps end at the one it was met
 * below (`variant 1 of the oneOf at "result"` for `Loop: { oneOf: [{ $ref:
 * Loop }, A] }`). `undefined` when none does: no union at all, or one left
 * to the component that dispatches it, whatever its variants declare
 * (`unionCounts`), which the plain reason covers. `lookup` is the walk's,
 * so the variants' fields are read once (`fieldsNamed`).
 */
function variantLacking(
  node: SchemaObject,
  segment: string,
  componentSchemas: Record<string, SchemaObject> | undefined,
  lookup: FieldLookup,
  walking: Set<SchemaObject> = new Set(),
): VariantStep[] | undefined {
  const { unions, named } = collectObjectProperties(node, componentSchemas);
  for (const union of unions) {
    if (!unionCounts(union, named, componentSchemas)) continue;
    for (const { step, variant } of variantsOf(union)) {
      if (fieldsNamed(variant, segment, componentSchemas, lookup)) continue;
      // Met again below itself: it declares nothing, and the step above names it.
      if (walking.has(variant)) return undefined;
      walking.add(variant);
      const below = variantLacking(variant, segment, componentSchemas, lookup, walking);
      walking.delete(variant);
      return [step, ...(below ?? [])];
    }
  }
  return undefined;
}

/**
 * A name for the variant `via` leads to, for a `dataPath` warning: its
 * place among the variants of the `oneOf`/`anyOf` at `prefix` (`''` for the
 * body itself), counted as written with the `null` variants in place —
 * `variant 3 of the oneOf at "result"` for the third one listed, whatever
 * sits before it; `variant 2 of the response's oneOf` for the body — and,
 * below a variant that is itself a union, each further step in turn:
 * `variant 2 of the oneOf in variant 1 of the anyOf at "result"`.
 */
function variantLabel(via: readonly VariantStep[], prefix: string): string {
  const [outer, ...inner] = via as [VariantStep, ...VariantStep[]];
  const at = prefix === '' ? `the response's ${outer.keyword}` : `the ${outer.keyword} at "${prefix}"`;
  return inner.reduce(
    (label, step) => `variant ${step.index} of the ${step.keyword} in ${label}`,
    `variant ${outer.index} of ${at}`,
  );
}

/** The object whose variants a `dataPath` warning speaks of: the body itself, or the property at `path`. */
function unionAt(path: string): string {
  return path === '' ? 'the response' : `"${path}"`;
}

/** The distinct entries of `words`, as prose: `a`, `a and b`, `a, b and c`. */
function listed(words: string[]): string {
  const distinct = [...new Set(words)];
  if (distinct.length < 2) return distinct.join('');
  return `${distinct.slice(0, -1).join(', ')} and ${distinct[distinct.length - 1]}`;
}

/**
 * A schema's type in a word, for a warning: a component's name for a `$ref`
 * to one, the `$ref` as written for any other (a pointer deeper into a
 * component; #539), `Pet[]` for an array of them (`array` without `items`),
 * its `type` as written (`string`, `string | null`), else the composition
 * keyword it is.
 */
function describeSchema(schema: SchemaObject): string {
  if (schema.$ref) return componentKeyOf(schema.$ref) ?? schema.$ref;
  if (isArraySchema(schema)) return schema.items ? `${describeSchema(schema.items)}[]` : 'array';
  const { type } = schema;
  if (type !== undefined) return Array.isArray(type) ? type.join(' | ') : type;
  return schema.oneOf ? 'oneOf' : schema.anyOf ? 'anyOf' : schema.allOf ? 'allOf' : 'untyped';
}

/**
 * Resolve a dotted `dataPath` against the IR rather than the document: walk
 * from the response type through model fields, under every nullable wrapper
 * (`containersOf`), and return the element type of the array the path lands
 * on. `models` is where
 * each model along the way is looked up by name, so the item type is exactly
 * the one the parser already assigned — the very `TypeRef` object the field
 * holds, which later renaming passes repoint in place. A `union` on the way
 * is walked through each of its variants, as the document walk goes on
 * through each variant of a `oneOf`/`anyOf` (`resolveDataPathArray`,
 * workos/oagen#556): every variant must be a model that declares the
 * segment — a variant that is itself a union, each of its own in turn
 * (`containersOf`) — and the arrays reached must agree on their items — the
 * same `TypeRef` by value, `Pet` in `ListPetsResponseResult.items` and in
 * `ListPetsResponseResultWithTotal.items` — the first of which is returned.
 * The types reached are counted once per segment — a model or enum by its
 * name, any other by its shape (`typeRefKey`) — as the document walk counts
 * a schema once, so a union two models reach each other through (`A.next`
 * and `B.next` both `A | B`) is read once per segment however long the
 * path, not once per way of reaching it (PR #585 review: a `next.next.….
 * items` path doubled the work at every segment). An empty `dataPath` means
 * `root` itself is the array. `undefined` when a segment is missing, a model
 * is unknown, the path does not end on an array, or the variants disagree —
 * and when the walk crosses a reference `resolveSchemaPointers` has yet to
 * settle, which `walkDataPathItemType` tells apart from the rest; the
 * document walk then answers (`resolveDataPathFromSchema`).
 */
export function resolveDataPathItemType(
  root: TypeRef,
  dataPath: string,
  models: readonly Model[],
): TypeRef | undefined {
  const walked = walkDataPathItemType(root, dataPath, models);
  return walked && 'itemType' in walked ? walked.itemType : undefined;
}

/**
 * The walk `resolveDataPathItemType` makes, telling a path the IR cannot
 * resolve yet from one it does not resolve: `{ pending: true }` when a type
 * the walk reaches — the root, a field's type on the way, a variant of a
 * union there, or the type the path lands on, under its nullable wrapper —
 * is a reference a schema `$ref` deeper into a component left pending
 * (`pendingSchemaRef`; #539), which names no model until
 * `resolveSchemaPointers` settles it. Every type a segment reaches is
 * checked for one before any field is looked up, so the answer never
 * depends on which variant of a union is read first.
 */
export function walkDataPathItemType(
  root: TypeRef,
  dataPath: string,
  models: readonly Model[],
): { itemType: TypeRef } | { pending: true } | undefined {
  let reached: TypeRef[] = [root];
  for (const segment of dataPath === '' ? [] : dataPath.split('.')) {
    const containers = new Map<string, TypeRef>();
    for (const type of reached) {
      for (const container of containersOf(type)) containers.set(typeRefKey(container), container);
    }
    if ([...containers.values()].some(isPendingModelRef)) return { pending: true };
    const next = new Map<string, TypeRef>();
    for (const container of containers.values()) {
      if (container.kind !== 'model') return undefined;
      const field = models.find((m) => m.name === container.name)?.fields.find((f) => f.name === segment);
      if (!field) return undefined;
      next.set(typeRefKey(field.type), field.type);
    }
    reached = [...next.values()];
  }
  const targets = reached.map(underNullable);
  if (targets.some(isPendingModelRef)) return { pending: true };
  const items = targets.map((target) => (target.kind === 'array' ? target.items : undefined));
  const [first, ...rest] = items;
  return first && rest.every((item) => item !== undefined && isDeepStrictEqual(item, first))
    ? { itemType: first }
    : undefined;
}

/** Whether `type` is a model reference `resolveSchemaPointers` has yet to settle (#539). */
function isPendingModelRef(type: TypeRef): boolean {
  return type.kind === 'model' && isPendingSchemaRef(type);
}

/**
 * Where an explicit `dataPath` is walked from in the IR, and the path left
 * to walk from there: the response itself, unless the response was unwrapped
 * on a list envelope (`envelopeFields` present) — it is then the data array,
 * and the path starts at the companion its first segment names, with the
 * rest of the path; `undefined` when the segment names no companion, and the
 * document answers. The one choice for the walk at extraction
 * (`resolveOverrideItemType`) and the walk at the settle
 * (`settleDeferredDataPathItemType`), so the two read one path.
 */
export function dataPathWalkStart(
  response: TypeRef,
  envelopeFields: readonly Field[] | undefined,
  dataPath: string,
): { root: TypeRef; path: string } | undefined {
  if (!envelopeFields) return { root: response, path: dataPath };
  const [head, ...rest] = dataPath.split('.');
  const companion = envelopeFields.find((field) => field.name === head);
  return companion && { root: companion.type, path: rest.join('.') };
}

/**
 * The iterator item types an explicit `dataPath` has yet to decide (#608):
 * each a placeholder, typed `unknown`, standing in `PaginationMeta.itemType`
 * from extraction until the settle. The walk from the response crossed a
 * reference a schema `$ref` deeper into a component left pending — the
 * response itself written as `{ $ref: '#/components/schemas/Holder/
 * properties/result' }`, or a field on the way — so the model the pointed
 * schema's items are built as (`HolderResultItem`, which
 * `HolderResult.items` holds) exists but cannot be reached from the response
 * yet; reading the document instead minted a second copy of it under the
 * path-derived name (`ListOwnersItem`). The path is walked again once every
 * reference is settled (`settleDeferredDataPathItemType`), so the iterator
 * yields the very type the settled response's field holds, as it does when
 * the response is a `$ref` to the component (`ResultItem` for `Result`).
 */
const deferredDataPathItemTypes = new WeakSet<TypeRef>();

/** A placeholder item type for a `dataPath` the settle decides (`settleDeferredDataPathItemType`). */
export function deferDataPathItemType(): TypeRef {
  const placeholder: TypeRef = { kind: 'primitive', type: 'unknown' };
  deferredDataPathItemTypes.add(placeholder);
  return placeholder;
}

/** Whether `type` is a placeholder `deferDataPathItemType` built, awaiting the settle. */
export function isDeferredDataPathItemType(type: TypeRef): boolean {
  return deferredDataPathItemTypes.has(type);
}

/**
 * Decide the item type `pagination.dataPath` names, now that `response`,
 * the envelope's companions and every model's fields are settled
 * (`resolveSchemaPointers`): the path is walked from where it was walked at
 * extraction (`dataPathWalkStart`), through `models` — every model built —
 * and `pagination.itemType` becomes the very `TypeRef` the array's field
 * holds, which a later rename repoints in place. A path the settled types
 * reach no array through yields `unknown`, with a warning: the override
 * was accepted on the document walk, which reads through the pointer, but
 * the pointer was typed `unknown` where it stands (an inline `allOf`
 * member the `allOf` is not read as, a chain of pointers that reaches
 * itself), and the iterator cannot yield a model the response does not
 * hold. `context` names the operation as the settle names its sites
 * (`Owners.listOwners`).
 */
export function settleDeferredDataPathItemType(
  pagination: PaginationMeta,
  response: TypeRef,
  models: readonly Model[],
  context: string,
): void {
  const { dataPath } = pagination;
  const start = dataPath === undefined ? undefined : dataPathWalkStart(response, pagination.envelopeFields, dataPath);
  const itemType = start && resolveDataPathItemType(start.root, start.path, models);
  if (itemType) {
    pagination.itemType = itemType;
    return;
  }
  warn(
    `dataPath "${dataPath}" on ${context} reaches no array in the response once its schema $ref is settled — typing the iterator's items as unknown`,
  );
  pagination.itemType = { kind: 'primitive', type: 'unknown' };
}

/**
 * The types a `dataPath` segment is looked up in below `type`: the type
 * under every nullable wrapper — a site settled from a pointer to a schema
 * that admits null wears two, `nullable<nullable<HolderResult>>` for `oneOf:
 * [{ $ref: …/Holder/properties/result }, { type: null }]` to a nullable
 * `result` (#545; Greptile, #608 review) — or each variant of a
 * `oneOf`/`anyOf` union there, under its own wrappers, and, for a variant
 * that is itself a union, each of its variants in turn, however deep, as the
 * document walk reads a nested union's variants (`fieldsNamed`). Of a union
 * a type list produced (`type: ['object', 'string']`, one variant per type
 * and no `compositionKind`), the variants that are models: the document
 * walk reads such a schema's `properties` whatever else the list names
 * (`objectProperties`), and a pointer steps through it to the member that
 * carries the keyword (#539), so the IR walk reads the object member too
 * rather than failing on the string member and minting a copy of the
 * items the object member's model holds.
 */
function containersOf(type: TypeRef): TypeRef[] {
  const bare = underNullable(type);
  if (bare.kind !== 'union') return [bare];
  const members = bare.variants.flatMap(containersOf);
  if (bare.compositionKind) return members;
  const models = members.filter((member) => member.kind === 'model');
  return models.length > 0 ? models : members;
}

/** `type` under every nullable wrapper it wears. */
function underNullable(type: TypeRef): TypeRef {
  let bare = type;
  while (bare.kind === 'nullable') bare = bare.inner;
  return bare;
}

/** A key two `TypeRef`s share exactly when they are one type to look a field up in: a model's or enum's name, else the TypeRef's shape. */
function typeRefKey(type: TypeRef): string {
  return type.kind === 'model' || type.kind === 'enum' ? `${type.kind}:${type.name}` : JSON.stringify(type);
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
 * array, under every nullable wrapper it wears too — one for an OAS 3.0
 * `nullable: true` array response (`nullable<array<T>>`), two for a
 * nullable site settled from a pointer to a schema that admits null
 * (`{ oneOf: [{ $ref: '#/components/schemas/Holder/properties/owners' },
 * { type: 'null' }] }` to `owners: { type: ['array', 'null'] }`, which the
 * settle leaves as `nullable<nullable<array<T>>>`; #609) — else the
 * response itself.
 */
export function paginatedItemType(response: TypeRef): TypeRef {
  let inner = response;
  while (inner.kind === 'nullable') inner = inner.inner;
  return inner.kind === 'array' ? inner.items : response;
}
