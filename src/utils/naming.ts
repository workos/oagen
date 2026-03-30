/**
 * Known compound tokens that the regex-based splitter over-splits.
 * Each entry is [lowercase-word-sequence, canonical-form].
 * Sorted longest-first so greedy matching works correctly.
 */
const COMPOUND_WORDS: [string[], string][] = [
  [['m', '2', 'm'], 'M2M'],
  [['o', 'auth'], 'OAuth'],
];

/**
 * Recombine adjacent words that form a known compound token.
 */
function recombineCompounds(words: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (const [pattern, canonical] of COMPOUND_WORDS) {
      if (i + pattern.length <= words.length) {
        const matches = pattern.every((p, j) => words[i + j].toLowerCase() === p);
        if (matches) {
          result.push(canonical);
          i += pattern.length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      result.push(words[i]);
      i++;
    }
  }
  return result;
}

/**
 * Split a string into words, handling:
 * - camelCase / PascalCase boundaries
 * - snake_case / kebab-case separators
 * - Consecutive capitals (e.g., "HTTPClient" → ["HTTP", "Client"])
 * - Numbers as word boundaries (e.g., "OAuth2Token" → ["OAuth", "2", "Token"])
 * - Known compounds are recombined (e.g., "M2M" stays as one word)
 */
export function splitWords(s: string): string[] {
  if (!s) return [];

  const words = s
    .replace(/[^a-zA-Z0-9_\-\s.]/g, '_') // replace non-alphanumeric chars with separator
    .replace(/([a-z])([A-Z])/g, '$1\0$2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2') // consecutive caps boundary
    .replace(/([a-zA-Z])(\d)/g, '$1\0$2') // letter to number
    .replace(/(\d)([a-zA-Z])/g, '$1\0$2') // number to letter
    .split(/[\0_\-\s.]+/)
    .filter((w) => w.length > 0);

  return recombineCompounds(words);
}

export const ACRONYM_SET = new Set(['SSO', 'FGA', 'SAML', 'SCIM', 'JWT', 'HMAC', 'M2M']);

export function toPascalCase(s: string, acronyms?: Set<string>): string {
  const merged = acronyms ? new Set([...ACRONYM_SET, ...acronyms]) : ACRONYM_SET;
  return splitWords(s)
    .map((w) => {
      const upper = w.toUpperCase();
      if (merged.has(upper)) return upper;
      // Special case: OAuth should stay as OAuth, not OAUTH
      if (upper === 'OAUTH') return 'OAuth';
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join('');
}

export function toCamelCase(s: string, acronyms?: Set<string>): string {
  const merged = acronyms ? new Set([...ACRONYM_SET, ...acronyms]) : ACRONYM_SET;
  const words = splitWords(s);
  if (words.length === 0) return '';
  return words
    .map((w, i) => {
      if (i === 0) return w.toLowerCase();
      const upper = w.toUpperCase();
      if (merged.has(upper)) return upper;
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

const BACKEND_SUFFIXES = ['Controller'];

export function stripBackendSuffixes(name: string): string {
  for (const suffix of BACKEND_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

export function stripBackendPrefixes(name: string): string {
  return name.replace(/Userland/g, '').replace(/Controller/g, '');
}

/**
 * Remove ListItem / ByExternalId / ByResourceId / ForResource markers from PascalCase names.
 * E.g. "DirectoriesListItemState" → "DirectoriesState"
 */
export function stripListItemMarkers(name: string): string {
  return name
    .replace(/ListItem/g, '')
    .replace(/ByExternalId/g, '')
    .replace(/ByResourceId/g, '')
    .replace(/ForResource/g, '');
}

/** Words that look plural but must NOT be singularized. */
const SINGULAR_SAFE_LIST = new Set([
  'Status',
  'Address',
  'Access',
  'Process',
  'Progress',
  'Success',
  'Radius',
  'Canvas',
  'Alias',
  'Basis',
  'Bus',
]);

/**
 * Conservative singularize for the leading PascalCase word.
 * Only applied to the first word of a PascalCase name (the resource word).
 * - `ies` → `y` (e.g. Directories → Directory)
 * - trailing `s` for words >4 chars (e.g. Organizations → Organization)
 * Safe-listed words are never singularized.
 */
export function singularize(word: string): string {
  if (SINGULAR_SAFE_LIST.has(word)) return word;
  if (word.endsWith('ies') && word.length > 4) {
    return word.slice(0, -3) + 'y';
  }
  if (word.endsWith('ses') && word.length > 4) {
    // e.g. "Processes" — but "Process" is safe-listed, this handles non-safe ones
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 4) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Compose all backend name cleaning transforms in order:
 * 1. Strip backend prefixes (Userland, Controller)
 * 2. Strip backend suffixes (Dto, DTO, Controller)
 * 3. Strip ListItem / ByExternalId markers
 * 4. Singularize leading resource word
 *
 * Must be idempotent: `cleanSchemaName(cleanSchemaName(x)) === cleanSchemaName(x)`
 */
/** Strip `.js` extensions from import/export specifiers for dedup comparison. */
export function normalizeJsExtension(text: string): string {
  return text.replace(/\.js(['"])/g, '$1');
}

export function cleanSchemaName(name: string): string {
  let result = stripBackendPrefixes(stripBackendSuffixes(name));
  result = stripListItemMarkers(result);

  // Singularize the leading PascalCase word
  const match = result.match(/^([A-Z][a-z]*)/);
  if (match) {
    const leadWord = match[1];
    const singular = singularize(leadWord);
    if (singular !== leadWord) {
      result = singular + result.slice(leadWord.length);
    }
  }

  return result;
}
