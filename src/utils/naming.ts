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
    .replace(/[^a-zA-Z0-9_\-\s.]/g, '_') // replace non-alphanumeric chars with separator
    .replace(/([a-z])([A-Z])/g, '$1\0$2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2') // consecutive caps boundary
    .replace(/([a-zA-Z])(\d)/g, '$1\0$2') // letter to number
    .replace(/(\d)([a-zA-Z])/g, '$1\0$2') // number to letter
    .split(/[\0_\-\s.]+/)
    .filter((w) => w.length > 0);
}

const ACRONYM_SET = new Set(['SSO', 'FGA', 'SAML', 'SCIM', 'JWT', 'HMAC']);

export function toPascalCase(s: string): string {
  return splitWords(s)
    .map((w) => {
      const upper = w.toUpperCase();
      if (ACRONYM_SET.has(upper)) return upper;
      // Special case: OAuth should stay as OAuth, not OAUTH
      if (upper === 'OAUTH') return 'OAuth';
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join('');
}

export function toCamelCase(s: string): string {
  const words = splitWords(s);
  if (words.length === 0) return '';
  return words
    .map((w, i) => {
      if (i === 0) return w.toLowerCase();
      const upper = w.toUpperCase();
      if (ACRONYM_SET.has(upper)) return upper;
      if (upper === 'OAUTH') return 'OAuth';
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join('');
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

const BACKEND_SUFFIXES = ['Dto', 'DTO', 'Controller'];

export function stripBackendSuffixes(name: string): string {
  for (const suffix of BACKEND_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}
