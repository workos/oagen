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

/**
 * `name` with the numeric suffix `n`, the one spelling of every numbered
 * operation, model and enum name: `list` + 2 is `list2`. A name that already
 * ends in a digit takes the number behind `No`, so that it cannot be read as
 * part of the number the name ends with: `listV1` + 2 is `listV1No2`, never
 * `listV12`, which reads as version 12 of the API, and `PetSizeV2` + 2 is
 * `PetSizeV2No2`. The hex hash that sets a path-derived or webhook stem
 * apart is appended the same way, so one that starts with a digit is set off
 * too (`PetsTop10` + `567B59` is `PetsTop10No567B59`, never
 * `PetsTop10567B59`) and one that starts with a letter follows the name as
 * it is (`PetsTop10Ba41B5`). An underscore would not do: splitWords reads a
 * digit run as a word of its own, so `listV1_2` re-cased by toPascalCase or
 * toCamelCase is `ListV12` or `listV12` again. The name is read as given, so
 * a caller numbers a name in its final spelling; one that is cased only
 * later is numbered by numberedProperty.
 */
export function numberedName(name: string, n: number | string): string {
  const suffix = String(n);
  return /\d$/.test(name) && /^\d/.test(suffix) ? `${name}No${suffix}` : `${name}${suffix}`;
}

/**
 * `property` with the numeric suffix `n`, for a property name that is cased
 * only later: the raw parameter or header name the shape registry and a
 * webhook's `mintParameter` extract a schema under, which toPascalCase turns
 * into the model name. The number is spelled as numberedName spells it on the
 * cased name, so one that ends in a digit once the characters that are
 * neither letters nor digits are dropped (`filter[v2]`, `x-meta-v2_`,
 * `filter_v2_`) takes it behind `No` too: `filter[v2]` + 2 is
 * `filter[v2]No2`, cased `FilterV2No2`, never `filter[v2]2`, which cases to
 * `FilterV22` and reads as version 22 (#533); `query_payload` + 2 is still
 * `query_payload2`. The property is returned as written, not cased: the
 * stems a site's siblings settled on are compared as strings, and
 * toPascalCase is not idempotent (`sso_v2` is `SSOV2`, re-cased `Ssov2`).
 */
export function numberedProperty(property: string, n: number | string): string {
  const cased = toPascalCase(property);
  return `${property}${numberedName(cased, n).slice(cased.length)}`;
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
 * The singular of a word read as a plural, by suffix alone: `word` ends in
 * `s`, and the caller has ruled out whatever it does not read as a plural.
 * The one set of rules `singularize` and `singularizePathSegment` share, so a
 * field, a component and a path segment spell one noun's singular the same
 * way (`causes` is `cause` as an array field and as a resource; #620):
 * - `-ies` → `-y` when the word is longer than four letters (`directories` →
 *   `directory`; a short `-ies` word keeps its `ie`, `pies` → `pie`);
 * - `-yses` → `-ysis` (`analyses` → `analysis`);
 * - the `es` of a sibilant stem is dropped — `-sses`, `-uses` after a
 *   consonant, `-iases`, `-xes`, `-ches`, `-shes` (`addresses` → `address`,
 *   `statuses` → `status`, `aliases` → `alias`, `boxes` → `box`, `batches` →
 *   `batch`, `hashes` → `hash`) — except `-aches` after a consonant, which
 *   is an `-ache` noun's plain `s` (`caches` → `cache`, `headaches` →
 *   `headache`, `mustaches` → `mustache`; an `-ach` noun has a vowel before
 *   the `a`, `coaches` → `coach`, `beaches` → `beach`);
 * - any other `s` is a plain plural `s` (`notes` → `note`, `causes` →
 *   `cause`, `licenses` → `license`, `responses` → `response`, `releases` →
 *   `release`, `warehouses` → `warehouse`).
 * Case is preserved — the rules only slice, except the `y` and `is` they
 * write, which take the case of the letters they replace (`DIRECTORIES` →
 * `DIRECTORY`, `ANALYSES` → `ANALYSIS`).
 */
function stripPluralSuffix(word: string): string {
  const lower = word.toLowerCase();
  // `directories` → `directory`; a short `-ies` word keeps its `ie` (`pies` → `pie`).
  if (lower.endsWith('ies') && lower.length > 4) {
    return word.slice(0, -3) + (word.endsWith('IES') ? 'Y' : 'y');
  }
  // `analyses` → `analysis`: every English `-yses` noun is the plural of a
  // `-ysis` noun (`paralyses`, `dialyses`, `catalyses`).
  if (lower.endsWith('yses')) return word.slice(0, -2) + (word.endsWith('ES') ? 'IS' : 'is');
  // An `es` added to a sibilant stem: `addresses`, `statuses`, `aliases`,
  // `boxes`, `batches`, `hashes`. A vowel before `uses` is a plain `s` instead
  // (`warehouses`), and so is any letter but `i` before `ases` (`cases`,
  // `releases`): no English noun ends in `-iase`, so `aliases` and `biases`
  // are `-ias` nouns.
  if (lower.endsWith('sses') || /[^aeiou]uses$/.test(lower) || lower.endsWith('iases')) return word.slice(0, -2);
  // An `-ache` noun (`caches`, `headaches`, `mustaches`) is the `-aches` word
  // with a consonant before the `a`; an `-ach` noun has a vowel there
  // (`coaches`, `beaches`, `approaches`) and drops its `es` below.
  if (/[^aeiou]aches$/.test(lower)) return word.slice(0, -1);
  if (lower.endsWith('xes') || lower.endsWith('ches') || lower.endsWith('shes')) return word.slice(0, -2);
  return word.slice(0, -1);
}

/**
 * Conservative singularize for one word of a model name — the leading word
 * of a component name (`cleanSchemaName`), the trailing word of an inline
 * model's name (`qualifyInlineModelName`), the field a nested error body's
 * items are reached through (`collapseErrorBodies`), the array a `dataPath`
 * hint ends in (`inlineItemNameForPath`) — or a raw field name. The suffix
 * rules are the ones a path segment is singularized by (`stripPluralSuffix`,
 * shared with `singularizePathSegment`), so a field and a resource of one
 * noun spell its singular alike: `Directories` → `Directory`, `Organizations`
 * → `Organization`, `Statuses` → `Status`, `Addresses` → `Address`, `Boxes`
 * → `Box`, `Batches` → `Batch`, `Causes` → `Cause`, `Licenses` → `License`,
 * `Responses` → `Response`, `Analyses` → `Analysis`, `Caches` → `Cache`
 * (#620; before it, every `-ses` word lost its `es` — `Caus`, `Licens`,
 * `Respons` — and every other `-es` word only its `s` — `Boxe`, `Batche`).
 * What is read as a plural at all is decided here, not by the path
 * segment's guards: a safe-listed word (`Status`, `Address`, `Series`, …)
 * and its `-es` plural (`Canvases` → `Canvas`, `Radiuses` → `Radius`,
 * whatever the suffix rules would make of them), a word of four letters or
 * fewer (`Pets`, `Tags`, `Bus`, `Gas`, `News`, `Axes` are kept as they are,
 * since a short word is as likely a singular) and a word ending in `ss`
 * (`Class`) are never singularized, and neither is a `-ysis` word, the
 * singular the `-yses` rule writes (`Analysis`); any other `-us` or `-is`
 * word is read as a plural, as it always was (`Menus` → `Menu`, `Emojis` →
 * `Emoji`, at the price of `Campus` → `Campu`). The suffix rules' limits
 * are the ones documented on `singularizePathSegment`, and reach a model
 * name as they reach an operation's: `Gases` → `Gase`, `Lenses` → `Lense`,
 * `Atlases` → `Atlase`, `Niches` → `Nich`, `Diagnoses` → `Diagnose` (where
 * the two-branch rule before #620 happened to give `Gas`, `Lens`, `Atlas`
 * and `Niche`). Every singular the `-ies`, `-yses` and sibilant rules write
 * is returned as it is when passed back in, so `cleanSchemaName` is
 * idempotent on it; the `-us` a consonant + `-uses` plural gives is not,
 * since a `-us` word is read as a plural (`Bonuses` → `Bonus` → `Bonu`,
 * `Campuses` → `Campus` → `Campu`, `Viruses` → `Virus` → `Viru`, as on
 * every version before this one).
 */
export function singularize(word: string): string {
  if (SINGULAR_SAFE_LIST.has(word) || word.length <= 4) return word;
  // `-ss` is never a plural (`Class`), and neither is `-ysis`, the singular
  // the `-yses` rule writes (`Analysis`), so the singulars the suffix rules
  // write are returned as they are when passed back in, as cleanSchemaName
  // requires — all but the `-us` a consonant + `-uses` plural gives, which
  // is read as a plural again (`Bonuses` → `Bonus` → `Bonu`).
  if (!word.endsWith('s') || word.endsWith('ss') || word.endsWith('ysis')) return word;
  // A safe-listed word's `-es` plural is that word (`Canvases` → `Canvas`,
  // `Radiuses` → `Radius`), whatever the suffix rules would make of it.
  if (word.endsWith('es') && SINGULAR_SAFE_LIST.has(word.slice(0, -2))) return word.slice(0, -2);
  return stripPluralSuffix(word);
}

/**
 * Conservative singularisation of a path segment, for naming an operation on
 * one item of a collection: `pets` → `pet`, `api_keys` → `api_key`,
 * `directories` → `directory`, `addresses` → `address`, `statuses` → `status`,
 * `aliases` → `alias`, `analyses` → `analysis`, `boxes` → `box`, `batches` →
 * `batch`, `caches` → `cache`, `responses` → `response`.
 *
 * Suffix rules only (`stripPluralSuffix`, the rules `singularize` applies to
 * a model name's word, so `/causes/{id}` and a `causes` field spell one
 * `cause`), no dictionary, so anything that does not look plural is returned
 * as it is: a segment that does not end in `s`, or ends in `ss`, `us`, `is`
 * or `ias` (`status`, `analysis`, `alias`), or is an invariant plural
 * (`series`). Case is preserved — the rules only slice, except `-ies` → `-y`
 * and `-yses` → `-ysis`, whose `y` and `is` take the case of the letters they
 * replace (`DIRECTORIES` → `DIRECTORY`, `ANALYSES` → `ANALYSIS`, so splitWords
 * still sees one word) — and only the trailing word of a compound segment
 * matters. Idempotent: every singular it produces is returned as it is when
 * passed back in (`aliases` → `alias` → `alias`), so a comparison of two
 * words by their singular forms (see appendQualifier) is sound.
 *
 * Deliberately not handled — a resource that stems wrong should carry an
 * `operationId`: irregular plurals (`people`, `children`, `data`), `-ies`
 * words whose singular keeps the `ie` (`cookies` → `cooky`), `-oes` (`heroes`
 * → `heroe`), `-ches` nouns ending in `-che` other than a consonant + `-ache`
 * (`niches` → `nich`, `avalanches` → `avalanch`, `tranches` → `tranch`,
 * where `caches` → `cache` and `branches` → `branch` are the common
 * readings), `-uses`
 * nouns ending in `-use` (`excuses` → `excus`), `-zes` plurals of a doubled
 * `z` (`quizzes` → `quizze`, where `sizes` → `size` is the common reading),
 * `-ases` nouns ending in `-as`
 * other than `-ias` (`canvases` → `canvase`, where `cases` → `case` is the
 * common reading), `-es` plurals of `-is` nouns other than `-ysis` (`crises`
 * → `crise`, `theses` → `these`, where `premises` → `premise` and `cheeses`
 * → `cheese` are the common readings), singular nouns ending in `-as` other
 * than `-ias`, or in `-ns` (`canvas` → `canva`, `lens` → `len`, where `areas`
 * → `area` and `tokens` → `token` are the common readings), plurals of `-ia`
 * nouns (`utopias` is kept as it is, so that `alias` is), plurals of
 * `-u`/`-i` nouns (`menus`, `apis` are kept as they are) and acronyms (`sms`
 * → `sm`). These limits reach every segment the parser singularises — the
 * resource of an item operation, a deeper segment a path parameter follows
 * and the service noun a name restores — so `/messages/sms/{smsId}/attachments`
 * contributes `Sm` and `/design/canvas/{id}/layers/{layerId}` contributes
 * `Canva` to a qualified name.
 */
export function singularizePathSegment(segment: string): string {
  const lower = segment.toLowerCase();
  if (lower.length <= 2 || !lower.endsWith('s')) return segment;
  if (lower.endsWith('series') || lower.endsWith('species') || lower.endsWith('news')) return segment;
  // `-ias` is kept for `alias` and `bias`, the singulars the `-iases` rule
  // below produces, at the price of the rarer `-ia` plurals (`utopias`).
  if (lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is') || lower.endsWith('ias')) return segment;
  return stripPluralSuffix(segment);
}

/**
 * Compose all backend name cleaning transforms in order:
 * 1. Strip backend prefixes (Userland, Controller)
 * 2. Strip backend suffixes (Dto, DTO, Controller)
 * 3. Strip ListItem / ByExternalId markers
 * 4. Singularize leading resource word
 *
 * Must be idempotent: `cleanSchemaName(cleanSchemaName(x)) === cleanSchemaName(x)`
 * — which holds for every name but one whose leading word is a consonant +
 * `-uses` plural, since `singularize` reads the `-us` it writes as a plural
 * again (`Bonuses` → `Bonus` → `Bonu`; see singularize).
 */
/** Strip `.js` extensions from import/export specifiers for dedup comparison. */
export function normalizeJsExtension(text: string): string {
  return text.replace(/\.js(['"])/g, '$1');
}

export function cleanSchemaName(name: string): string {
  return singularizeLeadingWord(stripListItemMarkers(stripBackendPrefixes(stripBackendSuffixes(name))));
}

/**
 * `name` with its leading PascalCase word singularized (`NotesList` →
 * `NoteList`, `Pets` → `Pet`): the last step of cleanSchemaName, read on its
 * own where an id the cleaning only singularized must be told from one it
 * stripped a marker or a backend word from (resolveContestedOperationIdStems,
 * #627).
 */
export function singularizeLeadingWord(name: string): string {
  const match = name.match(/^([A-Z][a-z]*)/);
  if (!match) return name;
  const leadWord = match[1];
  const singular = singularize(leadWord);
  return singular === leadWord ? name : singular + name.slice(leadWord.length);
}
