/**
 * The case folding HTTP header names compare under (RFC 9110 §5.1: field
 * names are case-insensitive), so `X-Rate-Limit` and `x-rate-limit` are one
 * header wherever two are matched by name. Layer 0: no imports.
 */
export function foldHeaderName(name: string): string {
  return name.toLowerCase();
}
