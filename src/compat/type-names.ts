/**
 * Reading the name of a declared type out of a recorded type text.
 *
 * A compat snapshot carries the type of each field, property, return value and
 * parameter as the text its extractor recorded (`CompatTypeRef.name`):
 * `ErrorBody`, `ErrorBody[]`, `Promise<ErrorBody>`, `ErrorBody | undefined`,
 * `?ErrorBody`, `*ErrorBody`. The differ's fork and rename rules ask which
 * declared type such a text names, and `bareTypeName` is the one place that
 * answers; `genericWrapperOf` says which generic it read the name through.
 * `typeNamesIn` reads every name a text mentions, for following a type to the
 * types it is built from, and `supertypeName` reads a declared supertype's
 * entry. Five more read a parameter's type, to ask whether its new text
 * accepts every value of its old one: `unionMembers` takes a union apart,
 * `objectTypeMembers` an object type written in place and
 * `singleArgumentGeneric` a generic, `soleTypeName` reads the name of a text
 * that is one declared type and nothing a caller would have to wrap a value
 * in, and `everyNameIn` reads every type a text depends on. All of them read
 * text only: they take no language and no snapshot, so the same text reads
 * the same whichever extractor wrote it.
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

/**
 * Generics that hold values of their argument for the caller to read: the
 * promise of one (`Promise<X>`, `Awaitable[X]`) and a collection of them
 * (`list[X]`, `Sequence[X]`, `Iterable<X>`, `Set<X>`), which is to its
 * argument what an array (`X[]`) is to its element. Compared with the last
 * segment of the generic's name (`typing.Sequence[X]`).
 *
 * A closed list, because nothing in a type text says how a generic uses its
 * argument: `Sink<X>`, `Observer<X>` and `Comparator<X>` take an `X` where
 * these hand one back. The names are TypeScript's and Python's, the
 * languages with generics whose surfaces record a supertype for the differ
 * to credit (see `handsBackItsArgument`).
 */
const VALUE_HOLDERS = new Set([
  'Promise',
  'PromiseLike',
  'Awaitable',
  'Array',
  'ReadonlyArray',
  'Set',
  'ReadonlySet',
  'Iterable',
  'Iterator',
  'IterableIterator',
  'AsyncIterable',
  'AsyncIterator',
  'AsyncIterableIterator',
  'list',
  'List',
  'Sequence',
  'Collection',
  'set',
  'frozenset',
  'FrozenSet',
  'AbstractSet',
]);

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
 * is returned as it stands, less its optional spellings, and matches no
 * declared type: a union of several types (`A | B`, and `A | B | null` →
 * `A | B`), a generic with several arguments (`Record<string, Foo>`), a nested
 * array or generic (`Foo[][]`, `Promise<Foo[]>`, and `Promise<Foo[] | null>` →
 * `Promise<Foo[]>`), an object or function type. This is a reader for the
 * common shapes, not a parser of any one language.
 */
export function bareTypeName(typeText: string): string {
  let text = presentType(typeText.trim());
  if (text.endsWith('[]')) text = presentType(text.slice(0, -2));
  // PHP fully-qualified names lead with a backslash and separate their
  // segments with one; the declared type is the last segment.
  if (text.startsWith('\\')) text = text.slice(text.lastIndexOf('\\') + 1);
  const argument = (ANGLE_GENERIC.exec(text) ?? SQUARE_GENERIC.exec(text))?.[1];
  if (argument !== undefined && splitTopLevel(argument, ',')?.length === 1) {
    const present = presentType(argument);
    if (GENERIC_ARGUMENT_NAME.test(present.trim())) return bareTypeName(present.trim());
    // An argument that is no plain name stays where it is, without its
    // optional spelling: `Promise<Foo[] | undefined>` reads as `Promise<Foo[]>`.
    if (present !== argument) {
      text = `${text.slice(0, text.length - argument.length - 1)}${present}${text.slice(-1)}`;
    }
  }
  return text;
}

/**
 * The generic `bareTypeName` reads a text's name through, when it reads it
 * through one: `Promise` for `Promise<Foo>` and for `Promise<Foo | null>[]`,
 * `models.Page` for `models.Page[Foo]`. Undefined when the name stands with no
 * generic around it (`Foo`, `Foo[]`, `Foo | null`, and `Optional[Foo]`, which
 * is an optional spelling) and when the text names no single type.
 *
 * It takes the steps `bareTypeName` takes, so the two agree on which texts
 * have a wrapper: one generic, around one argument that is a plain name.
 */
export function genericWrapperOf(typeText: string): string | undefined {
  let text = presentType(typeText.trim());
  if (text.endsWith('[]')) text = presentType(text.slice(0, -2));
  if (text.startsWith('\\')) text = text.slice(text.lastIndexOf('\\') + 1);
  const argument = (ANGLE_GENERIC.exec(text) ?? SQUARE_GENERIC.exec(text))?.[1];
  if (argument === undefined || splitTopLevel(argument, ',')?.length !== 1) return undefined;
  if (!GENERIC_ARGUMENT_NAME.test(presentType(argument).trim())) return undefined;
  return text.slice(0, text.length - argument.length - 2);
}

/**
 * Whether a generic of this name (as `genericWrapperOf` returns it) is known
 * to hand its argument back and never take it: a promise or a collection
 * (`VALUE_HOLDERS`). A value read out of `Promise<Sub>` is still a `Base`; a
 * `Sink<Sub>` no longer accepts one, and a generic that is not on the list
 * may be either.
 */
export function handsBackItsArgument(genericName: string): boolean {
  const name = genericName.trim();
  return VALUE_HOLDERS.has(
    name.slice(Math.max(name.lastIndexOf('.'), name.lastIndexOf(':'), name.lastIndexOf('\\')) + 1),
  );
}

/**
 * A generic around one argument, taken apart: `Promise<Foo | null>` is
 * `Promise` around `Foo | null`, `typing.Sequence[Foo]` is `typing.Sequence`
 * around `Foo`. The argument is whatever stands in the brackets, where
 * `genericWrapperOf` reads a generic only around a plain name; the generic's
 * name is as written, as `handsBackItsArgument` takes it.
 *
 * Undefined for a text that is not one generic around one argument: a plain
 * name, a generic with several (`Record<string, Foo>`), a union or an
 * intersection of generics, an array of one.
 */
export function singleArgumentGeneric(typeText: string): { generic: string; argument: string } | undefined {
  const text = typeText.trim();
  const argument = (ANGLE_GENERIC.exec(text) ?? SQUARE_GENERIC.exec(text))?.[1];
  if (argument === undefined || argument.trim() === '' || splitTopLevel(argument, ',')?.length !== 1) return undefined;
  return { generic: text.slice(0, text.length - argument.length - 2), argument };
}

/** A name as a type text writes it, alone or under a module path:
 *  `Foo`, `models.Foo`, `crate::models::Foo`, `\Acme\Foo`. */
const NAME_PATH = /\\?[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::|\\)[A-Za-z_$][A-Za-z0-9_$]*)*/y;
const NAME_PATH_SEPARATOR = /\.|::|\\/;

/** A supertype written as a name and nothing else, with the namespace PHP
 *  may put before it: `Base`, `\Acme\Base`. */
const SUPERTYPE_NAME = /^\\?[A-Za-z_$][A-Za-z0-9_$]*(?:\\[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/** What a quoted run holds when it is a string literal and not two
 *  apostrophes that happen to stand in one text (Rust's lifetimes:
 *  `&'a Foo, &'b Bar`). */
const NOT_A_STRING_LITERAL = /[<>()[\]{}&,]/;

/**
 * TypeScript's wrappers that take a part of their first argument: an
 * `Omit<Foo, 'a'>` is a `Foo` without the members it lists, a
 * `Pick<Foo, 'a'>` a `Foo` with only the ones it lists, and a `Partial<Foo>`
 * a `Foo` none of whose members has to be there. Read by their names, as
 * TypeScript defines them (see `typesTakenIn`).
 */
const WRAPPERS_OF_A_PART = new Set(['Partial', 'Pick', 'Omit']);

/**
 * The part of a declared type a text takes: which of the type's members a
 * value written for the text carries.
 */
export interface TypePart {
  /** The member names the part is told by: the ones it leaves out or, with
   *  `only`, the only ones it keeps. */
  readonly keys: ReadonlySet<string>;
  readonly only: boolean;
  /** Whether a value may leave out every member it keeps (`Partial`). */
  readonly optional: boolean;
}

/** A type taken whole: every member, each as required as the type declares. */
export const WHOLE_TYPE: TypePart = { keys: new Set(), only: false, optional: false };

/** Whether a value of this part of a type carries the type's member of this
 *  name at all, required or not. */
export function keepsMember(part: TypePart, member: string): boolean {
  return part.keys.has(member) === part.only;
}

/** A name a type text mentions, and the part of that type the text takes. */
export interface TakenType {
  name: string;
  part: TypePart;
}

/**
 * Every name a type text mentions, each with the part of that type a value of
 * the text is built from: the members of a union or an intersection, an
 * array's element, each argument of a generic, the types of an inline
 * object's properties and of a function's parameters and result.
 *
 * `bareTypeName` answers which one declared type a text names, and refuses a
 * text that names several. This reads them all, the one `bareTypeName` reads
 * among them: each name path of the text as written (`models.Foo`,
 * `\Acme\Foo`) and each of its segments (`models`, `Foo`), since the declared
 * type may be recorded under either.
 *
 * A name is taken whole (`WHOLE_TYPE`) unless it stands under one of
 * `WRAPPERS_OF_A_PART`, which gives the part to each type its first argument
 * names at the top: alone, as a member of a union or an intersection, in
 * parentheses, or under another of the three. `Omit<Foo, 'a' | 'b'>` takes
 * `Foo` without `a` and `b`, `Pick<Foo & Bar, 'a'>` only the `a` of each,
 * `Partial<Omit<Foo, 'a'>>` every member of `Foo` but `a`, none of them
 * required. The keys are the string literals the text spells out, a union of
 * them in any quotes and spacing. Where it spells none (`Omit<Foo, Keys>`,
 * `Omit<Foo, keyof Bar>`), the part is not known and nothing is made up for
 * it: an `Omit` is then read as any other generic, whole, and a `Pick` is not
 * read at all, as neither was before the keys were read.
 *
 * What else a wrapper's first argument holds (an object type written in
 * place, another generic, an array) has no declared type's members for the
 * part to choose among. Under `Omit` and `Partial` it is read as any other
 * text, each name whole; under `Pick`, whose keys choose among members the
 * text spells out in place, it is not read. So is an argument with a function
 * type anywhere in it, all of it: where a function's result ends is not told
 * apart from where a union's member does.
 *
 * `part` is the part the text itself is taken in, for a text one type stands
 * for (a supertype's entry, what a type alias stands for) where that type is
 * taken in part: it applies as a wrapper's does.
 *
 * It over-approximates on purpose. A property name, a parameter name and a
 * keyword are names too (`{ body: Foo }` gives `body` and `Foo`), and the
 * caller keeps the ones that are declared types. A string literal is left
 * out, whole, which is also why a quoted forward reference (`Optional["Foo"]`)
 * is not followed, as `bareTypeName` does not look one up.
 */
export function typesTakenIn(typeText: string, part: TypePart = WHOLE_TYPE): TakenType[] {
  const taken: TakenType[] = [];
  if (part === WHOLE_TYPE) takeWhole(typeText, taken);
  else takePart(typeText, part, true, taken);
  return taken;
}

/**
 * Every name a type text takes whole (`typesTakenIn`): the names a value of
 * the text is built from with all their members. `Promise<Foo[]> | Bar` gives
 * `Promise`, `Foo` and `Bar`; `Omit<Foo, 'a'> | Bar` and `Partial<Foo> | Bar`
 * give `Bar`, since each takes a part of `Foo`.
 */
export function typeNamesIn(typeText: string): string[] {
  return typesTakenIn(typeText)
    .filter(({ part }) => part === WHOLE_TYPE)
    .map(({ name }) => name);
}

/** Reads a text each name of which is taken whole, but for what stands under
 *  a wrapper of a part. */
function takeWhole(typeText: string, taken: TakenType[]): void {
  let i = 0;
  while (i < typeText.length) {
    const char = typeText[i];
    if (char === '"' || char === "'" || char === '`') {
      i = stringLiteralEnd(typeText, i) ?? i + 1;
      continue;
    }
    NAME_PATH.lastIndex = i;
    const path = NAME_PATH.exec(typeText)?.[0];
    if (path === undefined) {
      i++;
      continue;
    }
    i += path.length;
    const end = WRAPPERS_OF_A_PART.has(path) ? typeArgumentsEnd(typeText, i) : undefined;
    if (end !== undefined) {
      const argument = wrapperArgument(path, typeText.slice(typeText.indexOf('<', i) + 1, end - 1), WHOLE_TYPE);
      if (argument) takePart(argument.text, argument.part, path !== 'Pick', taken);
      // Arguments that say no part: an `Omit` is a generic like any other.
      if (argument || path !== 'Omit') {
        i = end;
        continue;
      }
    }
    takeName(path, WHOLE_TYPE, taken);
  }
}

/**
 * Reads a text that is taken in part: the part goes to each name at the top
 * of the text, and what stands there that is no name is read whole when
 * `elseWhole` says so (see `typesTakenIn`).
 */
function takePart(text: string, part: TypePart, elseWhole: boolean, taken: TakenType[]): void {
  const trimmed = text.trim();
  // A function type's `|` and `&` belong to what it returns, so a text with
  // one in it is not taken apart.
  for (const separator of trimmed.includes('=>') ? [] : (['|', '&'] as const)) {
    const members = splitTopLevel(trimmed, separator);
    if (members === undefined || members.length === 1) continue;
    // Each member is shorter than the text, so this ends.
    for (const member of members) takePart(member, part, elseWhole, taken);
    return;
  }
  const group = trimmed.startsWith('(') ? enclosed(trimmed) : undefined;
  if (group !== undefined) return takePart(group, part, elseWhole, taken);

  NAME_PATH.lastIndex = 0;
  const path = NAME_PATH.exec(trimmed)?.[0];
  if (path !== undefined && path === trimmed) return takeName(path, part, taken);
  if (path !== undefined && WRAPPERS_OF_A_PART.has(path) && typeArgumentsEnd(trimmed, path.length) === trimmed.length) {
    const argument = wrapperArgument(path, trimmed.slice(trimmed.indexOf('<') + 1, -1), part);
    if (argument) return takePart(argument.text, argument.part, elseWhole && path !== 'Pick', taken);
  }
  if (elseWhole) takeWhole(trimmed, taken);
}

/** Records a name path and each of its segments, once per part. */
function takeName(path: string, part: TypePart, taken: TakenType[]): void {
  for (const name of [path, ...path.split(NAME_PATH_SEPARATOR)]) {
    if (name !== '' && !taken.some((other) => other.name === name && other.part === part)) taken.push({ name, part });
  }
}

/**
 * What a wrapper of a part takes, given the text between its angle brackets:
 * its first argument, and the part of it a value carries when the wrapper
 * itself is taken in `part`. Undefined when the arguments do not say: a
 * `Partial` of anything but one argument, an `Omit` or a `Pick` of anything
 * but two, or whose second spells no keys (`listedKeys`).
 */
function wrapperArgument(
  wrapper: string,
  content: string,
  part: TypePart,
): { text: string; part: TypePart } | undefined {
  const args = splitTopLevel(content, ',');
  if (args === undefined) return undefined;
  if (wrapper === 'Partial')
    return args.length === 1 ? { text: args[0], part: { ...part, optional: true } } : undefined;
  const keys = args.length === 2 ? listedKeys(args[1]) : undefined;
  if (keys === undefined) return undefined;
  const only = wrapper === 'Pick';
  // The members left are the ones both keep: the part's, less the ones an
  // `Omit` lists or the ones a `Pick` does not.
  if (part.only)
    return { text: args[0], part: { ...part, keys: new Set([...part.keys].filter((key) => keys.has(key) === only)) } };
  const left = only ? [...keys].filter((key) => !part.keys.has(key)) : [...part.keys, ...keys];
  return { text: args[0], part: { ...part, only, keys: new Set(left) } };
}

/**
 * The keys a wrapper's second argument spells out: one string literal or a
 * union of them (`'a'`, `"a" | "b"`, each on a line of its own behind a
 * leading `|`). Undefined for anything else, a name that stands for the keys
 * (`Keys`, `keyof Bar`) and a literal with an escape or a placeholder in it
 * included: what the text does not spell is not guessed.
 */
function listedKeys(text: string): Set<string> | undefined {
  const members = splitTopLevel(text, '|');
  if (members === undefined) return undefined;
  const keys = new Set<string>();
  for (const [i, member] of members.entries()) {
    const literal = member.trim();
    if (literal === '' && i === 0 && members.length > 1) continue;
    const quote = literal[0];
    if (literal.length < 2 || (quote !== '"' && quote !== "'" && quote !== '`') || !literal.endsWith(quote))
      return undefined;
    const key = literal.slice(1, -1);
    if (key.includes(quote) || key.includes('\\') || (quote === '`' && key.includes('${'))) return undefined;
    keys.add(key);
  }
  return keys;
}

/**
 * Every word of a type text that could be a type's name, wherever it stands:
 * each name path and each of its segments, as `typeNamesIn` reads them, with
 * nothing left out. The arguments of `Partial<…>` and `Pick<…>` are read, and
 * so is what stands in quotes (a forward reference, `Optional["Foo"]`) and in
 * a template literal (`\`pet_\${PetId}\``).
 *
 * `typeNamesIn` follows a type to what a value of it is built from, and a
 * `Partial<Foo>` is built from no whole `Foo`. This answers another
 * question: which declared types does a text depend on at all? A text that
 * is the same in two snapshots stands for one type only if each of them does,
 * and a `Partial<Foo>` changes with `Foo`. It over-approximates further than
 * `typeNamesIn` (the words of a string literal are words too), which only
 * ever makes a caller look at more names.
 */
export function everyNameIn(typeText: string): string[] {
  const names = new Set<string>();
  let i = 0;
  while (i < typeText.length) {
    NAME_PATH.lastIndex = i;
    const path = NAME_PATH.exec(typeText)?.[0];
    if (path === undefined) {
      i++;
      continue;
    }
    i += path.length;
    names.add(path);
    for (const segment of path.split(NAME_PATH_SEPARATOR)) if (segment !== '') names.add(segment);
  }
  return [...names];
}

/** The index after the `<…>` that opens at `start` (spaces before it
 *  allowed), or undefined when no argument list opens there or it never
 *  closes. */
function typeArgumentsEnd(text: string, start: number): number | undefined {
  let open = start;
  while (text[open] === ' ') open++;
  if (text[open] !== '<') return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'" || char === '`') {
      i = (stringLiteralEnd(text, i) ?? i + 1) - 1;
    } else if (char === '<') {
      depth++;
    } else if (char === '>' && text[i - 1] !== '=' && text[i - 1] !== '-') {
      if (--depth === 0) return i + 1;
    }
  }
  return undefined;
}

/** The index after the string literal that opens at `start`, or undefined
 *  when the quote there opens none: it has no partner, or what stands between
 *  the two is type syntax (see `NOT_A_STRING_LITERAL`). */
function stringLiteralEnd(text: string, start: number): number | undefined {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return NOT_A_STRING_LITERAL.test(text.slice(start + 1, i)) ? undefined : i + 1;
  }
  return undefined;
}

/**
 * The declared type a supertype entry names (an interface's `extends`, a
 * class's base, a named member of an intersection), or undefined when the
 * entry is not a name alone.
 *
 * `Base` and `\Acme\Base` name `Base`. An instantiation does not name the
 * type it instantiates: `Partial<Base>` has none of `Base`'s required
 * members, and `bareTypeName` would read `List<Item>` as `Item`. Such an entry
 * declares no supertype the differ can credit.
 */
export function supertypeName(entry: string): string | undefined {
  const text = entry.trim();
  return SUPERTYPE_NAME.test(text) ? bareTypeName(text) : undefined;
}

/**
 * The declared type a text names when nothing stands around the name but an
 * optional spelling and at most one array suffix: `Foo`, `Foo | undefined`,
 * `?Foo`, `Optional[Foo]`, `Foo[]`, `(Foo | null)[]`, `\Acme\Foo`.
 *
 * `bareTypeName` also reads a name out of a generic's argument
 * (`Promise<Foo>`, `List<Foo>`). Where a value is accepted by the type it was
 * declared as, a generic of the subtype is not one of the supertype unless
 * the generic says so: Python's `list[Sub]` is no `list[Base]`, nor is C#'s
 * `List<Sub>` a `List<Base>`, since a list is written to as well as read. So
 * a text under a generic names no type here, as a union of several types, a
 * dotted path and an object or function type name none in either reader.
 */
export function soleTypeName(typeText: string): string | undefined {
  let text = presentType(typeText.trim());
  if (text.endsWith('[]')) text = presentType(text.slice(0, -2));
  return supertypeName(text);
}

/**
 * The members of a union a text writes with `|`, each trimmed and once:
 * `A | B`, `A|B` and `(A | B)` are `A` and `B`. A text that is no union is a
 * union of one member, itself.
 *
 * The text is taken apart and nothing more: `undefined`, `null` and `None`
 * are members like any other (`presentType` is the reader that sets them
 * aside), an array, a generic and an object type stay whole (`(A | B)[]`,
 * `Array<A | B>`, `{ a: A | B }`), and so does a function type, whose `|`
 * belongs to what it returns (`(pet: Pet) => A | B`). A function among a
 * union's members is written in parentheses, which go with the union:
 * `(() => void) | undefined` is `() => void` and `undefined`.
 *
 * Returns undefined for a text that does not read as a union at all: one
 * whose brackets or quotes do not pair up, or with a blank member (`A |`).
 */
export function unionMembers(typeText: string): string[] | undefined {
  const text = typeText.trim();
  if (text === '') return undefined;
  if (isFunctionType(text)) return [text];
  const parts = splitTopLevel(text, '|');
  if (parts === undefined) return undefined;
  const members = new Set<string>();
  for (const part of parts) {
    const member = part.trim();
    if (member === '') return undefined;
    // A parenthesized member is read as what it holds, which is shorter than
    // the text it came from, so this ends.
    const group = member.startsWith('(') ? enclosed(member) : undefined;
    const held = group === undefined ? [member] : unionMembers(group);
    if (held === undefined) return undefined;
    for (const name of held) members.add(name);
  }
  return [...members];
}

/** A member's name as an object type writes it bare: an identifier or a
 *  number. A quoted name is read out of its quotes. */
const MEMBER_NAME = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+)$/;

/**
 * The members of an object type written in place, as TypeScript prints one:
 * `{ id: string; name?: string | undefined; }` has `id`, required, and
 * `name`, optional. Each member's type is the text after its colon, as it
 * stands; a `readonly` in front of the name is dropped, and a quoted name is
 * read without its quotes (`"content-type"`).
 *
 * Undefined for a text that is not an object type in braces, and for one
 * with a member that is not a name and a type, since the members then do not
 * say all a value may carry: an index signature (`[key: string]: unknown`), a
 * call or a method signature (`retry(attempt: number): void`), an accessor,
 * a name written twice, and the `... 12 more ...` a long type is cut down
 * to. This is a reader for the shape a parameter's type is recorded in, not
 * a parser of the language.
 */
export function objectTypeMembers(typeText: string): Map<string, { type: string; optional: boolean }> | undefined {
  const text = typeText.trim();
  const content = text.startsWith('{') ? enclosed(text) : undefined;
  const parts = content === undefined ? undefined : splitTopLevel(content, ';');
  if (parts === undefined) return undefined;
  const members = new Map<string, { type: string; optional: boolean }>();
  for (const part of parts) {
    // The `;` after the last member leaves a blank one.
    if (part.trim() === '') continue;
    const [head, ...rest] = splitTopLevel(part, ':') ?? [];
    const type = rest.join(':').trim();
    if (head === undefined || type === '') return undefined;
    let name = head.trim();
    if (name.startsWith('readonly ')) name = name.slice('readonly '.length).trim();
    const optional = name.endsWith('?');
    if (optional) name = name.slice(0, -1).trim();
    const quoted = (name[0] === '"' || name[0] === "'") && stringLiteralEnd(name, 0) === name.length;
    if (quoted) name = name.slice(1, -1);
    else if (!MEMBER_NAME.test(name)) return undefined;
    if (members.has(name)) return undefined;
    members.set(name, { type, optional });
  }
  return members;
}

/** A text with an arrow outside every bracket pair: TypeScript's `=>`, the
 *  `->` of Swift, Kotlin and Rust. */
function isFunctionType(text: string): boolean {
  return (splitTopLevel(text, '=>')?.length ?? 1) > 1 || (splitTopLevel(text, '->')?.length ?? 1) > 1;
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

/**
 * A type text with an intersection that repeats one type read as that type:
 * `A & A` is `A`, and `(A & A) | undefined` is `A | undefined`.
 *
 * A type checker prints what a member resolves to, and a member that two
 * parts of an intersection both declare resolves to the intersection of the
 * two declared types. Named types and primitives collapse there
 * (`string & string` is printed `string`); two object or function types
 * written inline do not, though they are one type written twice:
 * `{ a: () => void } & { a: () => void }` has an `a` printed
 * `(() => void) & (() => void)`. Members are compared by their text, so the
 * repetition is taken out: the same member reads the same whether one part
 * declares it or two.
 *
 * Only an intersection that stands at the top of the text, or as a whole
 * member of a union there, is read, and only operands that are the same text
 * are one type. A text without such a repetition is returned untouched.
 */
export function withoutRepeatedIntersectionMembers(typeText: string): string {
  const members = splitTopLevel(typeText, '|');
  if (!members) return typeText;
  let repeated = false;
  const reduced = members.map((member) => {
    const text = member.trim();
    // `(A & B)`, as an intersection is written inside a union.
    const group = text.startsWith('(') ? enclosed(text) : undefined;
    const operands = splitTopLevel(group ?? text, '&')?.map((operand) => operand.trim());
    const distinct = operands && [...new Set(operands)];
    if (!operands || !distinct || distinct.length === operands.length) return text;
    repeated = true;
    if (distinct.length === 1) return distinct[0];
    return group === undefined ? distinct.join(' & ') : `(${distinct.join(' & ')})`;
  });
  if (!repeated) return typeText;
  // One operand left of the whole text keeps no parentheses: `(() => void)`
  // stood so beside an `&`, and stands as `() => void` alone.
  const only = reduced.length === 1 && reduced[0].startsWith('(') ? enclosed(reduced[0]) : undefined;
  return only ?? reduced.join(' | ');
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
 * counts all four kinds and skips the `>` of an arrow (`=>`, `->`). Split at
 * the arrow itself, it says whether a text is a function type.
 */
function splitTopLevel(text: string, separator: '|' | ',' | '&' | ';' | ':' | '=>' | '->'): string[] | undefined {
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
    // No separator starts with a bracket, so asking for it first changes
    // nothing for the brackets; an arrow is taken whole, `>` included.
    if (expectedClosings.length === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i = start - 1;
      continue;
    }
    const closing = CLOSING_BRACKET.get(char);
    if (closing !== undefined) {
      expectedClosings.push(closing);
    } else if (CLOSING_BRACKETS.has(char)) {
      if (char === '>' && (text[i - 1] === '=' || text[i - 1] === '-')) continue;
      if (expectedClosings.pop() !== char) return undefined;
    }
  }
  if (quote !== undefined || expectedClosings.length > 0) return undefined;
  parts.push(text.slice(start));
  return parts;
}
