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
  'Species',
  'Series',
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
 * Conservative singularisation of a path segment, for naming an operation on
 * one item of a collection: `pets` → `pet`, `api_keys` → `api_key`,
 * `directories` → `directory`, `addresses` → `address`, `statuses` → `status`,
 * `aliases` → `alias`, `analyses` → `analysis`, `boxes` → `box`, `batches` →
 * `batch`, `responses` → `response`.
 *
 * Suffix rules only, no dictionary, so anything that does not look plural is
 * returned as it is: a segment that does not end in `s`, or ends in `ss`, `us`
 * or `is` (`status`, `analysis`), or is an invariant plural (`series`).
 * Case is preserved — the rules only slice, except `-ies` → `-y` and `-yses`
 * → `-ysis`, whose `y` and `is` take the case of the letters they replace
 * (`DIRECTORIES` → `DIRECTORY`, `ANALYSES` → `ANALYSIS`, so splitWords still
 * sees one word) — and only the trailing word of a compound segment matters.
 *
 * Deliberately not handled — a resource that stems wrong should carry an
 * `operationId`: irregular plurals (`people`, `children`, `data`), `-ies`
 * words whose singular keeps the `ie` (`cookies` → `cooky`), `-oes` (`heroes`
 * → `heroe`), `-ches` nouns ending in `-che` (`caches` → `cach`), `-uses`
 * nouns ending in `-use` (`excuses` → `excus`), `-ases` nouns ending in `-as`
 * other than `-ias` (`canvases` → `canvase`, where `cases` → `case` is the
 * common reading), `-es` plurals of `-is` nouns other than `-ysis` (`crises`
 * → `crise`, `theses` → `these`, where `premises` → `premise` and `cheeses`
 * → `cheese` are the common readings), singular nouns ending in `-as` or
 * `-ns` (`alias` → `alia`, `canvas` → `canva`, `lens` → `len`, where `areas`
 * → `area` and `tokens` → `token` are the common readings), plurals of
 * `-u`/`-i` nouns (`menus`, `apis` are kept as they are) and acronyms (`sms`
 * → `sm`).
 */
export function singularizePathSegment(segment: string): string {
  const lower = segment.toLowerCase();
  if (lower.length <= 2 || !lower.endsWith('s')) return segment;
  if (lower.endsWith('series') || lower.endsWith('species') || lower.endsWith('news')) return segment;
  if (lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is')) return segment;
  // `directories` → `directory`; a short `-ies` word keeps its `ie` (`pies` → `pie`).
  if (lower.endsWith('ies') && lower.length > 4) {
    return segment.slice(0, -3) + (segment.endsWith('IES') ? 'Y' : 'y');
  }
  // `analyses` → `analysis`: every English `-yses` noun is the plural of a
  // `-ysis` noun (`paralyses`, `dialyses`, `catalyses`).
  if (lower.endsWith('yses')) return segment.slice(0, -2) + (segment.endsWith('ES') ? 'IS' : 'is');
  // An `es` added to a sibilant stem: `addresses`, `statuses`, `aliases`,
  // `boxes`, `batches`, `hashes`. A vowel before `uses` is a plain `s` instead
  // (`warehouses`), and so is any letter but `i` before `ases` (`cases`,
  // `releases`): no English noun ends in `-iase`, so `aliases` and `biases`
  // are `-ias` nouns.
  if (lower.endsWith('sses') || /[^aeiou]uses$/.test(lower) || lower.endsWith('iases')) return segment.slice(0, -2);
  if (lower.endsWith('xes') || lower.endsWith('ches') || lower.endsWith('shes')) return segment.slice(0, -2);
  return segment.slice(0, -1);
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
