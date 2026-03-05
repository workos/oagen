/**
 * Split a string into words, handling:
 * - camelCase / PascalCase boundaries
 * - snake_case / kebab-case separators
 * - Consecutive capitals (e.g., "HTTPClient" → ["HTTP", "Client"])
 * - Numbers as word boundaries (e.g., "OAuth2Token" → ["OAuth", "2", "Token"])
 */
function splitWords(s: string): string[] {
  if (!s) return [];

  return s
    .replace(/([a-z])([A-Z])/g, '$1\0$2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2') // consecutive caps boundary
    .replace(/([a-zA-Z])(\d)/g, '$1\0$2') // letter to number
    .replace(/(\d)([a-zA-Z])/g, '$1\0$2') // number to letter
    .split(/[\0_\-\s.]+/)
    .filter((w) => w.length > 0);
}

export function toPascalCase(s: string): string {
  return splitWords(s)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

export function toCamelCase(s: string): string {
  const pascal = toPascalCase(s);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toSnakeCase(s: string): string {
  return splitWords(s)
    .map((w) => w.toLowerCase())
    .join('_');
}

export function toKebabCase(s: string): string {
  return splitWords(s)
    .map((w) => w.toLowerCase())
    .join('-');
}

export function toUpperSnakeCase(s: string): string {
  return splitWords(s)
    .map((w) => w.toUpperCase())
    .join('_');
}
