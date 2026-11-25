/**
 * Reading the name of a declared type out of a recorded type text.
 *
 * A compat snapshot carries the type of each field, property, return value and
 * parameter as the text its extractor recorded (`CompatTypeRef.name`):
 * `ErrorBody`, `ErrorBody[]`, `Promise<ErrorBody>`, `ErrorBody | undefined`,
 * `?ErrorBody`, `*ErrorBody`. The differ's fork and rename rules ask which
 * declared type such a text names, and `bareTypeName` is the one place that
 * answers. It reads text only: it takes no language and no snapshot, so the
 * same text reads the same whichever extractor wrote it.
 */

/** Union members that stand for "no value": TypeScript's `null` and
 *  `undefined`, PHP's `null` (which PHP reads in any case, see
 *  `standsForNoValue`), Python's `None`, Elixir's and Ruby's `nil`. */
const ABSENT_MEMBERS = new Set(['null', 'undefined', 'None', 'nil']);

/** Wrappers that say "or no value" by name: Python's `Optional[X]` and
 *  `NotRequired[X]`, Swift's `Optional<X>`, Rust's `Option<X>`, C#'s
 *  `Nullable<X>` and Sorbet's `T.nilable(X)`. Compared with the last segment
 *  of the wrapper's name, so `typing.Optional[X]` and `std::option::Option<X>`
 *  count as well. */
const OPTIONAL_WRAPPERS = new Set(['Optional', 'Option', 'Nullable', 'NotRequired', 'nilable']);

/** Python's `Union[X, None]`: a union spelled as a wrapper. */
const UNION_WRAPPER = 'Union';

const CLOSING_BRACKET = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
]);
const CLOSING_BRACKETS = new Set(CLOSING_BRACKET.values());

/** A wrapper's name, with the module path it may be written under. */
const QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]*)*$/;

/** What a single-argument generic may hold for its argument to be looked up:
 *  a plain, possibly dotted name (the `*` is Go's pointer, `Iterator[*Foo]`). */
const GENERIC_ARGUMENT_NAME = /^[A-Za-z_*][A-Za-z0-9_.*]*$/;
const ANGLE_GENERIC = /^[A-Za-z_][A-Za-z0-9_.]*<([\s\S]*)>$/;
const SQUARE_GENERIC = /^[A-Za-z_][A-Za-z0-9_.]*\[([\s\S]*)\]$/;

/**
 * The name a type text is looked up by: the declared type it names, read
 * through the decorations a language puts around it.
 *
 * Three decorations are read through, in this order:
 *
 *  - an optional or nullable spelling (see `presentType`): `Foo | null`,
 *    `Foo | undefined`, `Foo | None`, `?Foo`, `Foo?`, `*Foo`, `Optional[Foo]`;
 *  - one array suffix: `Foo[]`;
 *  - one single-argument generic around a plain name: `Promise<Foo>`,
 *    `List<Foo>`, `Iterator[Foo]`.
 *
 * An optional spelling says nothing about the type a value has when it is
 * there, so it is transparent wherever the function looks: at the top, on an
 * array's element (`(Foo | null)[]`, `Foo?[]`) and on a generic's argument
 * (`Promise<Foo | undefined>`, `list[Optional[Foo]]`). A text is therefore
 * looked up exactly as the same text without its optional spellings is.
 *
 * A PHP namespace prefix is dropped (`\Vendor\Pkg\Foo` → `Foo`). Anything else
 * is returned as it stands and matches no declared type: a union of several
 * types (`A | B`, also behind an optional spelling: `A | B | null` → `A | B`),
 * a generic with several arguments (`Record<string, Foo>`), a nested array or
 * generic (`Foo[][]`, `Promise<Foo[]>`), an object or function type. This is a
 * reader for the common shapes, not a parser of any one language.
 */
export function bareTypeName(typeText: string): string {
  let text = presentType(typeText.trim());
  if (text.endsWith('[]')) text = presentType(text.slice(0, -2));
  // PHP fully-qualified names lead with a backslash and separate their
  // segments with one; the declared type is the last segment.
  if (text.startsWith('\\')) text = text.slice(text.lastIndexOf('\\') + 1);
  const argument = (ANGLE_GENERIC.exec(text) ?? SQUARE_GENERIC.exec(text))?.[1];
  if (argument !== undefined) {
    const name = presentType(argument).trim();
    if (GENERIC_ARGUMENT_NAME.test(name)) return bareTypeName(name);
  }
  return text;
}

/**
 * The type a text names when the value is present: the text without its
 * optional and nullable spellings, however many are stacked
 * (`Optional[Foo | None]`, `Foo | null | undefined`).
 *
 * The spellings, each in every order and spacing a language allows:
 *
 *  - a union with a member that stands for no value: `Foo | null`,
 *    `undefined | Foo`, `Foo|null`, `None | Foo`, `Foo | nil`, parenthesized
 *    or not, and Python's `Union[Foo, None]`. `null` is matched in any case,
 *    as PHP reads it; the other three as written;
 *  - a sigil: PHP's leading `?`, Go's leading `*`, the trailing `?` of Kotlin,
 *    Swift and C#;
 *  - a wrapper named for it (`OPTIONAL_WRAPPERS`) around one argument.
 *
 * Only whole members and whole names count: `NoneType`, `Nullable` without an
 * argument and `UndefinedBehavior` are types like any other. A union keeps the
 * members that are types (`A | B | null` → `A | B`), and a text that is
 * nothing but absence (`null`, `null | undefined`) stays as it is.
 */
function presentType(typeText: string): string {
  let text = typeText.trim();
  let found = false;
  for (;;) {
    // Each rewrite drops at least one character, so this ends.
    const next = withoutOneOptionalSpelling(text).trim();
    // A text with no optional spelling is handed back untouched, spaces
    // included: what is not optional reads as it always has.
    if (next === text) return found ? text : typeText;
    text = next;
    found = true;
  }
}

function withoutOneOptionalSpelling(text: string): string {
  // Sigils, each run in one step: `?Foo`, `*Foo`, `**Foo`, `Foo?`.
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === '?' || text[start] === '*')) start++;
  while (end > start && text[end - 1] === '?') end--;
  if (start > 0 || end < text.length) return text.slice(start, end);

  const members = splitTopLevel(text, '|');
  const types = members && withoutAbsentMembers(members);
  if (types) return types.join('|');

  // `(Foo | null)`, as an array's element is written: `(Foo | null)[]`. The
  // parentheses go with the union; `(A | B | null)` stays a group, `(A | B)`.
  const group = text.startsWith('(') ? enclosed(text) : undefined;
  const grouped = group === undefined ? undefined : withoutAbsentMembers(splitTopLevel(group, '|') ?? []);
  if (grouped) return grouped.length > 1 ? `(${grouped.join('|').trim()})` : grouped[0];

  const wrapper = wrapperOf(text);
  if (wrapper) {
    const args = splitTopLevel(wrapper.content, ',') ?? [];
    // `Option[]` is an array of a type named `Option`, not a wrapper around nothing.
    if (OPTIONAL_WRAPPERS.has(wrapper.name) && args.length === 1 && args[0].trim() !== '') return args[0];
    const unionTypes = wrapper.name === UNION_WRAPPER ? withoutAbsentMembers(args) : undefined;
    if (unionTypes) {
      return unionTypes.length > 1
        ? `${wrapper.opening}${unionTypes.join(',').trim()}${wrapper.closing}`
        : unionTypes[0];
    }
  }
  return text;
}

/** The members that are types, when `members` holds both a type and a member
 *  that stands for no value; undefined when there is nothing to drop or
 *  nothing to keep, and when a member is blank (`| null`, `Union[, None]`):
 *  a text that does not read as a union is left whole. */
function withoutAbsentMembers(members: string[]): string[] | undefined {
  const names = members.map((member) => member.trim());
  if (names.includes('')) return undefined;
  const types = members.filter((_, i) => !standsForNoValue(names[i]));
  return types.length > 0 && types.length < members.length ? types : undefined;
}

function standsForNoValue(member: string): boolean {
  return ABSENT_MEMBERS.has(member) || member.toLowerCase() === 'null';
}

/** `text` read as `name<content>`, `name[content]` or `name(content)`, the
 *  bracket closing on the last character. */
function wrapperOf(text: string): { name: string; opening: string; closing: string; content: string } | undefined {
  const open = text.search(/[<[(]/);
  if (open <= 0) return undefined;
  const qualifiedName = text.slice(0, open).trimEnd();
  if (!QUALIFIED_NAME.test(qualifiedName)) return undefined;
  const content = enclosed(text.slice(open));
  if (content === undefined) return undefined;
  return {
    name: qualifiedName.slice(Math.max(qualifiedName.lastIndexOf('.'), qualifiedName.lastIndexOf(':')) + 1),
    opening: text.slice(0, open + 1),
    closing: text.slice(-1),
    content,
  };
}

/** The content of `text` when one bracket pair spans it from its first
 *  character to its last: `(A | B)`, but not `(A) | (B)`. */
function enclosed(text: string): string | undefined {
  const closing = CLOSING_BRACKET.get(text[0]);
  if (closing === undefined || text.length < 2 || !text.endsWith(closing)) return undefined;
  const content = text.slice(1, -1);
  return splitTopLevel(content, ',') === undefined ? undefined : content;
}

/**
 * Splits `text` at each `separator` that sits outside every bracket pair and
 * string literal, so the `|` of `Array<A | B>`, of `{ a: A | null }` and of
 * `"a|b"` splits nothing. Returns undefined when the brackets or quotes of
 * `text` do not pair up: such a text is not taken apart at all.
 *
 * `classify.ts` has a splitter of its own for Python annotations, which
 * counts square brackets only; this one reads every language's text, so it
 * counts all four kinds and skips the `>` of an arrow (`=>`, `->`).
 */
function splitTopLevel(text: string, separator: '|' | ','): string[] | undefined {
  const parts: string[] = [];
  const expectedClosings: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote !== undefined) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    const closing = CLOSING_BRACKET.get(char);
    if (closing !== undefined) {
      expectedClosings.push(closing);
    } else if (CLOSING_BRACKETS.has(char)) {
      if (char === '>' && (text[i - 1] === '=' || text[i - 1] === '-')) continue;
      if (expectedClosings.pop() !== char) return undefined;
    } else if (char === separator && expectedClosings.length === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (quote !== undefined || expectedClosings.length > 0) return undefined;
  parts.push(text.slice(start));
  return parts;
}
