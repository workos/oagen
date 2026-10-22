/**
 * How one parameter is told apart from another on an operation, a webhook or
 * a response. OpenAPI identifies a parameter by its `name` and its `in`
 * location — a path `id` may sit beside a query `id` — so the two are
 * compared together. Header names are case-insensitive (RFC 9110 §5.1), so a
 * header's name is folded before it is compared; path, query and cookie
 * names are case-sensitive and compared as written. The IR keeps every name
 * as written: only the comparison folds. Every place that asks whether two
 * parameters are the same one — the parser merging a path item's parameters
 * with an operation's, the parser reading a response's `headers` map, the
 * differ pairing a parameter across two documents — goes through this
 * module, so one rule answers it.
 */

/** Where a parameter lives, as OpenAPI's `in` names it. */
export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

/**
 * A header name as it is compared: lower-cased, since RFC 9110 §5.1 makes
 * header names case-insensitive (`X-Request-Id` and `x-request-id` name one
 * header). A header name is an ASCII token, so plain case folding is exact.
 */
export function foldHeaderName(name: string): string {
  return name.toLowerCase();
}

/**
 * A parameter name as it is compared at `location`: a header's is folded by
 * `foldHeaderName`; a path, query or cookie name is case-sensitive and kept
 * as written (`Limit` and `limit` are two query parameters).
 */
export function foldParameterName(location: ParameterLocation, name: string): string {
  return location === 'header' ? foldHeaderName(name) : name;
}

/**
 * The identity of a parameter within one operation or webhook:
 * `location:name`, the name folded by `foldParameterName`. Two parameters
 * with one key are one parameter — the parser lets the later declaration
 * (an operation's over its path item's) replace the earlier, and the differ
 * pairs the old and new declarations rather than reporting a removal beside
 * an addition.
 */
export function parameterKey(location: ParameterLocation, name: string): string {
  return `${location}:${foldParameterName(location, name)}`;
}
