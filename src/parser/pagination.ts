import type { TypeRef, Parameter, PaginationMeta, PaginationEndOfIteration, PaginationStrategy } from '../ir/types.js';
import type { PaginationHint } from '../ir/operation-hints.js';
import type { SchemaObject } from './schemas.js';
import { resolveComponentSchemaRef } from './schemas.js';

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
 *    by the number of items received
 *
 * An offset or page parameter without a page-size parameter is not treated as
 * pagination. Returns null if no pattern is detected.
 */
export function detectPagination(
  response: TypeRef,
  queryParams: Parameter[],
  dataPath?: string,
): PaginationMeta | null {
  // Try cursor-based first (preferred). Scan in CURSOR_PARAMS priority order
  // rather than queryParams order so that an endpoint exposing both `before`
  // and `after` reports `after` (forward iteration) — matches the wire
  // convention where `after` advances through pages.
  const cursorParam = CURSOR_PARAMS.map((name) => queryParams.find((p) => p.name === name)).find(
    (p): p is Parameter => p !== undefined,
  );

  if (cursorParam) {
    const itemType: TypeRef = response.kind === 'array' ? response.items : response;
    return {
      strategy: 'cursor',
      param: cursorParam.name,
      dataPath: dataPath,
      itemType,
    };
  }

  // Offset and page-number pagination both need a page-size parameter.
  const limitParam = queryParams.find((p) => LIMIT_PARAMS.includes(p.name));
  if (!limitParam) return null;

  const itemType: TypeRef = response.kind === 'array' ? response.items : response;

  const offsetParam = queryParams.find((p) => OFFSET_PARAMS.includes(p.name));
  if (offsetParam) {
    return {
      strategy: 'offset',
      param: offsetParam.name,
      limitParam: limitParam.name,
      dataPath: dataPath,
      itemType,
    };
  }

  const pageParam = queryParams.find((p) => PAGE_PARAMS.includes(p.name));
  if (pageParam) {
    return {
      strategy: 'page',
      param: pageParam.name,
      limitParam: limitParam.name,
      dataPath: dataPath,
      itemType,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// End of iteration — the envelope field that says the list is exhausted
// ---------------------------------------------------------------------------

const HAS_MORE_FIELDS = ['has_more', 'hasMore', 'has_next', 'hasNext', 'has_next_page', 'hasNextPage'];
const TOTAL_PAGES_FIELDS = ['total_pages', 'totalPages', 'page_count', 'pageCount'];
const TOTAL_COUNT_FIELDS = [
  'total',
  'total_count',
  'totalCount',
  'total_items',
  'totalItems',
  'total_results',
  'totalResults',
];
const END_KIND_PRIORITY: ReadonlyArray<PaginationEndOfIteration['kind']> = ['hasMore', 'totalPages', 'totalCount'];

/**
 * Find the envelope field that ends an iteration, when the envelope declares
 * an obvious one. `properties` are the envelope's merged properties and
 * `dataPath` names the data array among them.
 *
 * Top-level fields are considered first, then the fields one level down
 * inside each object companion (an inline object, a `$ref` to a component, or
 * an `allOf` of those), and the path follows the `dataPath` convention:
 * `has_more` or `pagination.totalPages`. When several candidates exist, a
 * `hasMore` boolean wins over a `totalPages` integer, which wins over a
 * `totalCount` integer; within one kind the first in scan order wins. A
 * candidate whose type does not fit its kind (a string `total`) is ignored.
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

  const companions = Object.entries(properties).filter(
    (entry): entry is [string, SchemaObject] => entry[0] !== dataPath && entry[1] !== undefined,
  );
  for (const [name, schema] of companions) record(name, name, schema);
  for (const [name, schema] of companions) {
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
  const resolved = resolveComponentSchemaRef(schema, componentSchemas) ?? schema;
  if (HAS_MORE_FIELDS.includes(name)) return hasType(resolved, 'boolean') ? 'hasMore' : undefined;
  if (TOTAL_PAGES_FIELDS.includes(name)) return isNumeric(resolved) ? 'totalPages' : undefined;
  if (TOTAL_COUNT_FIELDS.includes(name)) return isNumeric(resolved) ? 'totalCount' : undefined;
  return undefined;
}

function hasType(schema: SchemaObject, type: string): boolean {
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function isNumeric(schema: SchemaObject): boolean {
  return hasType(schema, 'integer') || hasType(schema, 'number');
}

/**
 * The properties of an object companion: its own, merged with those of its
 * `allOf` members, following `$ref`s to component schemas. Anything that is
 * not an object yields none.
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
  const out: Record<string, SchemaObject | undefined> = {};
  for (const member of schema.allOf ?? []) Object.assign(out, objectProperties(member, componentSchemas, seen));
  if (schema.properties) Object.assign(out, schema.properties);
  return out;
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

/**
 * Layer the explicit overrides onto the detected pagination. Precedence per
 * field: config hint, then `x-pagination`, then `detected`; a field no
 * override sets keeps the detected value, so `{ strategy: 'page' }` alone
 * re-labels a detected offset iterator without restating its parameters.
 *
 * Returns `detected` unchanged when no override is present, or when the
 * overrides are unusable — unknown strategy, no strategy or no `param` from
 * any source, a `param`/`limitParam` the operation does not declare as a
 * query parameter, a malformed field — after an `[oagen] Warning:` naming the
 * problem. `strategy: 'none'` turns pagination off and yields `undefined`.
 */
export function applyPaginationOverrides(
  detected: PaginationMeta | undefined,
  overrides: PaginationOverrides,
  queryParams: Parameter[],
  response: TypeRef,
  opLabel: string,
): PaginationMeta | undefined {
  const extension =
    overrides.extension === undefined
      ? undefined
      : validatePaginationHint(overrides.extension, 'x-pagination', opLabel);
  const hint =
    overrides.hint === undefined
      ? undefined
      : validatePaginationHint(overrides.hint, 'operationHints pagination', opLabel);
  if (!extension && !hint) return detected;

  const merged: PaginationHint = { ...extension, ...hint };
  const where = `${[extension && 'x-pagination', hint && 'operationHints pagination'].filter(Boolean).join(' / ')} on ${opLabel}`;

  if (merged.strategy === 'none') return undefined;

  const strategy = merged.strategy ?? detected?.strategy;
  if (!strategy) {
    warn(`${where} sets no strategy and none was detected — ignoring the override`);
    return detected;
  }
  const param = merged.param ?? detected?.param;
  if (!param) {
    warn(`${where}: strategy "${strategy}" needs a param, and none was given or detected — ignoring the override`);
    return detected;
  }
  for (const [key, name] of [
    ['param', merged.param],
    ['limitParam', merged.limitParam],
  ] as const) {
    if (name !== undefined && !queryParams.some((p) => p.name === name)) {
      warn(`${where}: ${key} "${name}" is not a query parameter of the operation — ignoring the override`);
      return detected;
    }
  }

  const limitParam = merged.limitParam ?? detected?.limitParam;
  const dataPath = merged.dataPath ?? detected?.dataPath;
  const endOfIteration = merged.endOfIteration ?? detected?.endOfIteration;
  return {
    strategy,
    param,
    ...(limitParam !== undefined && { limitParam }),
    ...(dataPath !== undefined && { dataPath }),
    itemType: detected?.itemType ?? (response.kind === 'array' ? response.items : response),
    ...(detected?.envelopeFields && { envelopeFields: detected.envelopeFields }),
    ...(endOfIteration && { endOfIteration }),
  };
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
