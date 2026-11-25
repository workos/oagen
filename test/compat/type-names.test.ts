import { describe, it, expect } from 'vitest';
import {
  bareTypeName,
  genericWrapperOf,
  objectTypeMembers,
  singleArgumentGeneric,
  soleTypeName,
  unionMembers,
} from '../../src/compat/type-names.js';

/**
 * `bareTypeName` reads the declared type a recorded type text names. #751:
 * an optional or nullable spelling is transparent to it, so a text reads as
 * the same text without its optional spellings did before #751, in every
 * spelling and order a language writes and at every place the function looks
 * (the top, an array's element, a single generic argument).
 */

/**
 * Texts without an optional spelling, each with what the function returned for
 * it before #751. None of these may move, and they are what every optional
 * spelling below is measured against.
 */
const PLAIN: [text: string, name: string][] = [
  // a name, an array of it, a single-argument generic around it
  ['ErrorBody', 'ErrorBody'],
  ['  ErrorBody  ', 'ErrorBody'],
  ['ErrorBody[]', 'ErrorBody'],
  ['Array<ErrorBody>', 'ErrorBody'],
  ['Promise<ErrorBody>', 'ErrorBody'],
  ['List< ErrorBody >', 'ErrorBody'],
  ['Iterator[ErrorBody]', 'ErrorBody'],
  ['list[ErrorBody]', 'ErrorBody'],
  ['List<ErrorBody>[]', 'ErrorBody'],
  ['models.ErrorBody', 'models.ErrorBody'],
  ['models.List<models.ErrorBody>', 'models.ErrorBody'],
  ['\\Acme\\Models\\ErrorBody', 'ErrorBody'],
  ['\\Acme\\Models\\ErrorBody[]', 'ErrorBody'],
  // one array suffix and one generic are read through, not two
  ['ErrorBody[][]', 'ErrorBody[]'],
  ['Promise<ErrorBody[]>', 'Promise<ErrorBody[]>'],
  ['Promise<Array<ErrorBody>>', 'Promise<Array<ErrorBody>>'],
  // several arguments
  ['Record<string, ErrorBody>', 'Record<string, ErrorBody>'],
  ['Dict[str, ErrorBody]', 'Dict[str, ErrorBody]'],
  // several types: at the top, grouped, as an array's element, as a generic's argument
  ['ErrorBody | Unrelated', 'ErrorBody | Unrelated'],
  ['Unrelated | ErrorBody', 'Unrelated | ErrorBody'],
  ['ErrorBody|Unrelated', 'ErrorBody|Unrelated'],
  ['(ErrorBody | Unrelated)', '(ErrorBody | Unrelated)'],
  ['(Unrelated | ErrorBody)', '(Unrelated | ErrorBody)'],
  ['(ErrorBody|Unrelated)', '(ErrorBody|Unrelated)'],
  ['(ErrorBody | Unrelated)[]', '(ErrorBody | Unrelated)'],
  ['Promise<ErrorBody | Unrelated>', 'Promise<ErrorBody | Unrelated>'],
  ['Promise<(ErrorBody | Unrelated)>', 'Promise<(ErrorBody | Unrelated)>'],
  ['Union[ErrorBody, Unrelated]', 'Union[ErrorBody, Unrelated]'],
  // A PHP union of two fully-qualified types has always been read as its
  // last member: the namespace prefix is cut at the last backslash of the text.
  ['\\Acme\\Unrelated|\\Acme\\ErrorBody', 'ErrorBody'],
  ['(\\Acme\\Unrelated|\\Acme\\ErrorBody)', '(\\Acme\\Unrelated|\\Acme\\ErrorBody)'],
  // no name at all
  ['{ body: ErrorBody; }', '{ body: ErrorBody; }'],
  ['() => ErrorBody', '() => ErrorBody'],
  ['(ErrorBody)', '(ErrorBody)'],
  ['"ErrorBody"', '"ErrorBody"'],
  // shapes of other languages the function has no rule for
  ['[]ErrorBody', '[]ErrorBody'],
  ['map[string]ErrorBody', 'map[string]ErrorBody'],
  ['[ErrorBody]', '[ErrorBody]'],
  ['ErrorBody.t()', 'ErrorBody.t()'],
  ["&'a ErrorBody", "&'a ErrorBody"],
  // a space before the suffix stays in the name, as it did
  ['ErrorBody []', 'ErrorBody '],
];

/** The optional spellings the function read before #751, with what it returned. */
const READ_BEFORE: [text: string, name: string][] = [
  ['ErrorBody | null', 'ErrorBody'],
  ['ErrorBody|null', 'ErrorBody'],
  ['ErrorBody?', 'ErrorBody'],
  ['*ErrorBody', 'ErrorBody'],
  ['ErrorBody[] | null', 'ErrorBody'],
  ['ErrorBody[]?', 'ErrorBody'],
  ['List<ErrorBody>?', 'ErrorBody'],
  ['Optional[ErrorBody]', 'ErrorBody'],
  ['typing.Optional[ErrorBody]', 'ErrorBody'],
  ['Optional<ErrorBody>', 'ErrorBody'],
  ['Option<ErrorBody>', 'ErrorBody'],
  ['Nullable<ErrorBody>', 'ErrorBody'],
  ['NotRequired[ErrorBody]', 'ErrorBody'],
  ['*Iterator[ErrorBody]', 'ErrorBody'],
  ['Iterator[*ErrorBody]', 'ErrorBody'],
  ['\\Acme\\ErrorBody|null', 'ErrorBody'],
  ['ErrorBody | Unrelated | null', 'ErrorBody | Unrelated'],
  ['\\Acme\\Unrelated|\\Acme\\ErrorBody|null', 'ErrorBody'],
];

/** What the function returned before #751 for a text of `PLAIN`. */
function nameBefore751(plain: string): string {
  const row = PLAIN.find(([text]) => text === plain);
  if (!row) throw new Error(`not pinned in PLAIN: ${JSON.stringify(plain)}`);
  return row[1];
}

type Spell = (text: string) => string;

/** An optional spelling around a whole text. */
const SPELLINGS: Record<string, Spell> = {
  'X | undefined': (t) => `${t} | undefined`,
  'undefined | X': (t) => `undefined | ${t}`,
  'X|undefined': (t) => `${t}|undefined`,
  'undefined|X': (t) => `undefined|${t}`,
  'X | null': (t) => `${t} | null`,
  'null | X': (t) => `null | ${t}`,
  'X|null': (t) => `${t}|null`,
  'null|X': (t) => `null|${t}`,
  'X|NULL': (t) => `${t}|NULL`,
  'X | null | undefined': (t) => `${t} | null | undefined`,
  'X | undefined | null': (t) => `${t} | undefined | null`,
  'undefined | null | X': (t) => `undefined | null | ${t}`,
  'null | X | undefined': (t) => `null | ${t} | undefined`,
  'X | None': (t) => `${t} | None`,
  'None | X': (t) => `None | ${t}`,
  'X|None': (t) => `${t}|None`,
  'None|X': (t) => `None|${t}`,
  'X | nil': (t) => `${t} | nil`,
  'nil | X': (t) => `nil | ${t}`,
  '?X': (t) => `?${t}`,
  'X?': (t) => `${t}?`,
  '*X': (t) => `*${t}`,
  'Optional[X]': (t) => `Optional[${t}]`,
  'typing.Optional[X]': (t) => `typing.Optional[${t}]`,
  'Optional[X | None]': (t) => `Optional[${t} | None]`,
  'Optional[Optional[X]]': (t) => `Optional[Optional[${t}]]`,
  'NotRequired[X]': (t) => `NotRequired[${t}]`,
  'Union[X, None]': (t) => `Union[${t}, None]`,
  'Union[None, X]': (t) => `Union[None, ${t}]`,
  'typing.Union[X, None]': (t) => `typing.Union[${t}, None]`,
  'Optional<X>': (t) => `Optional<${t}>`,
  'Option<X>': (t) => `Option<${t}>`,
  'std::option::Option<X>': (t) => `std::option::Option<${t}>`,
  'Nullable<X>': (t) => `Nullable<${t}>`,
  'T.nilable(X)': (t) => `T.nilable(${t})`,
};

/**
 * A union with a member for no value, in parentheses: how an optional element
 * of an array is written, `(X | null)[]`. Around a text that is itself a
 * union, the parentheses stay with what is left: `(A | B | null)` → `(A | B)`.
 */
const GROUPED_SPELLINGS: Record<string, Spell> = {
  '(X | undefined)': (t) => `(${t} | undefined)`,
  '(undefined | X)': (t) => `(undefined | ${t})`,
  '(X | null)': (t) => `(${t} | null)`,
  '(X|null)': (t) => `(${t}|null)`,
  '(null | X)': (t) => `(null | ${t})`,
  '(X | null | undefined)': (t) => `(${t} | null | undefined)`,
  '(X | None)': (t) => `(${t} | None)`,
  '(X | None), wrapped over lines': (t) => `(\n        ${t} | None\n    )`,
  '(X | nil)': (t) => `(${t} | nil)`,
};

/** The texts of `PLAIN` that are a union of several types at their top level. */
const UNIONS = new Set([
  'ErrorBody | Unrelated',
  'Unrelated | ErrorBody',
  'ErrorBody|Unrelated',
  '\\Acme\\Unrelated|\\Acme\\ErrorBody',
]);

/** The text an optional spelling was put around, as `PLAIN` has it: in a
 *  grouped spelling a union keeps its parentheses. */
const plainOf = (text: string, grouped: boolean) => (grouped && UNIONS.has(text) ? `(${text})` : text);

const EVERY_SPELLING: [title: string, spell: Spell, grouped: boolean][] = [
  ...Object.entries(SPELLINGS).map(([title, spell]): [string, Spell, boolean] => [title, spell, false]),
  ...Object.entries(GROUPED_SPELLINGS).map(([title, spell]): [string, Spell, boolean] => [title, spell, true]),
];

describe('bareTypeName (#751)', () => {
  describe('a text without an optional spelling reads as it always has', () => {
    it.each(PLAIN)('%j → %j', (text, name) => {
      expect(bareTypeName(text)).toBe(name);
    });

    it.each(READ_BEFORE)('%j → %j, as before', (text, name) => {
      expect(bareTypeName(text)).toBe(name);
    });
  });

  /**
   * The rule: `bareTypeName(spelled)` is what the function returned before
   * #751 for the same text without the optional spelling. Every spelling,
   * around every text of `PLAIN`, at each of the three places the function
   * looks.
   */
  describe('an optional spelling is transparent: a text reads as the same text without it did', () => {
    // An unpaired quote (a Rust lifetime) leaves a text whole; see the last block.
    const texts = PLAIN.map(([text]) => text).filter((text) => !text.includes("'"));

    it.each(EVERY_SPELLING)('around the whole text: %s', (_title, spell, grouped) => {
      const moved: string[] = [];
      for (const text of texts) {
        const name = bareTypeName(spell(text));
        const expected = nameBefore751(plainOf(text, grouped));
        if (name !== expected) moved.push(`${JSON.stringify(spell(text))} → ${JSON.stringify(name)}, not ${expected}`);
      }
      expect(moved).toEqual([]);
    });

    // Every array of `PLAIN`, the spelling around its element: `(X | null)[]`,
    // `X?[]`, `Optional[X][]`. (A sigil in front, `?X[]`, is around the whole
    // text.) The padded `ErrorBody []` is left out.
    const arrays = texts.filter((text) => text.endsWith('[]') && !text.endsWith(' []'));
    const aroundAnElement = EVERY_SPELLING.filter(([title]) => !title.startsWith('?') && !title.startsWith('*'));

    it.each(aroundAnElement)("around an array's element: %s", (_title, spell, grouped) => {
      expect(arrays).toHaveLength(5);
      const moved: string[] = [];
      for (const array of arrays) {
        const element = array.slice(0, -2);
        // Only a text that is one member can join a union: `X[] | null`, not `A | B | null[]`.
        const spelled = `${grouped || !UNIONS.has(element) ? spell(element) : `Optional[${element}]`}[]`;
        const name = bareTypeName(spelled);
        if (name !== nameBefore751(array)) moved.push(`${JSON.stringify(spelled)} → ${JSON.stringify(name)}`);
      }
      expect(moved).toEqual([]);
    });

    // Every single-argument generic of `PLAIN`, the spelling around its argument.
    const generics: [opening: string, argument: string, closing: string][] = [
      ['Array<', 'ErrorBody', '>'],
      ['Promise<', 'ErrorBody', '>'],
      ['Iterator[', 'ErrorBody', ']'],
      ['list[', 'ErrorBody', ']'],
      ['models.List<', 'models.ErrorBody', '>'],
      ['Promise<', 'ErrorBody[]', '>'],
      ['Promise<', 'Array<ErrorBody>', '>'],
      ['Promise<', 'ErrorBody | Unrelated', '>'],
    ];

    it.each(EVERY_SPELLING)("around a generic's argument: %s", (_title, spell, grouped) => {
      const moved: string[] = [];
      for (const [opening, argument, closing] of generics) {
        const spelled = `${opening}${spell(argument)}${closing}`;
        const name = bareTypeName(spelled);
        const expected = nameBefore751(`${opening}${plainOf(argument, grouped)}${closing}`);
        if (name !== expected) moved.push(`${JSON.stringify(spelled)} → ${JSON.stringify(name)}, not ${expected}`);
      }
      expect(moved).toEqual([]);
    });

    // A spelling already there does not get in the way of another around it.
    it.each(EVERY_SPELLING)('around a text that is optional already: %s', (_title, spell, grouped) => {
      const moved: string[] = [];
      for (const [text, expected] of READ_BEFORE) {
        // The two unions of `READ_BEFORE` keep their parentheses in a grouped spelling.
        if (grouped && text.includes('Unrelated')) continue;
        const name = bareTypeName(spell(text));
        if (name !== expected) moved.push(`${JSON.stringify(spell(text))} → ${JSON.stringify(name)}, not ${expected}`);
      }
      expect(moved).toEqual([]);
    });

    /**
     * A union that still has two types once the spelling is gone is looked up
     * as the union is: by no name at all, or, for the two fully-qualified PHP
     * types, by the last member's, as before #751.
     */
    it.each([
      ['ErrorBody | Unrelated | undefined', 'ErrorBody | Unrelated'],
      ['undefined | ErrorBody | Unrelated', 'ErrorBody | Unrelated'],
      ['ErrorBody | undefined | Unrelated', 'ErrorBody | Unrelated'],
      ['ErrorBody | Unrelated | null | undefined', 'ErrorBody | Unrelated'],
      ['ErrorBody | Unrelated | None', 'ErrorBody | Unrelated'],
      ['None | ErrorBody | Unrelated', 'ErrorBody | Unrelated'],
      ['Optional[ErrorBody | Unrelated]', 'ErrorBody | Unrelated'],
      ['ErrorBody|Unrelated|null', 'ErrorBody|Unrelated'],
      ['null|ErrorBody|Unrelated', 'ErrorBody|Unrelated'],
      ['ErrorBody|null|Unrelated', 'ErrorBody|Unrelated'],
      // PHP cannot write `?` in front of a union; if a snapshot does, the group is what is left
      ['?(ErrorBody|Unrelated)', '(ErrorBody|Unrelated)'],
      ['(ErrorBody | Unrelated | undefined)', '(ErrorBody | Unrelated)'],
      ['(ErrorBody | Unrelated) | undefined', '(ErrorBody | Unrelated)'],
      ['Union[ErrorBody, Unrelated, None]', 'Union[ErrorBody, Unrelated]'],
      ['Union[None, ErrorBody, Unrelated]', 'Union[ErrorBody, Unrelated]'],
      ['Union[ErrorBody, None, Unrelated]', 'Union[ErrorBody, Unrelated]'],
      ['Optional[Union[ErrorBody, Unrelated]]', 'Union[ErrorBody, Unrelated]'],
      ['Union[ErrorBody, Unrelated] | None', 'Union[ErrorBody, Unrelated]'],
      ['(ErrorBody | Unrelated | null)[]', '(ErrorBody | Unrelated)[]'],
      ['(ErrorBody | Unrelated)[] | undefined', '(ErrorBody | Unrelated)[]'],
      ['(null | ErrorBody | Unrelated)[] | undefined', '(ErrorBody | Unrelated)[]'],
      ['Promise<ErrorBody | Unrelated | undefined>', 'Promise<ErrorBody | Unrelated>'],
      ['Promise<ErrorBody | Unrelated | null> | undefined', 'Promise<ErrorBody | Unrelated>'],
      ['Promise<ErrorBody | Unrelated> | undefined', 'Promise<ErrorBody | Unrelated>'],
      ['null|\\Acme\\Unrelated|\\Acme\\ErrorBody', '\\Acme\\Unrelated|\\Acme\\ErrorBody'],
      ['\\Acme\\Unrelated|null|\\Acme\\ErrorBody', '\\Acme\\Unrelated|\\Acme\\ErrorBody'],
    ])('a union of two types behind a spelling: %j reads as %j did', (spelled, plain) => {
      expect(bareTypeName(spelled)).toBe(nameBefore751(plain));
    });
  });

  describe('the spellings each language writes', () => {
    // TypeScript: the checker prints `null` and `undefined` last; the other
    // orders and spacings are what another extractor or a hand-written
    // snapshot may carry.
    it.each([
      'ErrorBody | undefined',
      'undefined | ErrorBody',
      'ErrorBody|undefined',
      'undefined|ErrorBody',
      'null | ErrorBody',
      'null|ErrorBody',
      'ErrorBody | null | undefined',
      'ErrorBody | undefined | null',
      'undefined | null | ErrorBody',
      'null | ErrorBody | undefined',
      '(ErrorBody | undefined)',
      // an optional array, an array of optionals, both
      'ErrorBody[] | undefined',
      'ErrorBody[] | null | undefined',
      '(ErrorBody | undefined)[]',
      '(ErrorBody | null)[]',
      '(ErrorBody | null | undefined)[]',
      '(ErrorBody | null)[] | undefined',
      // around a single-argument generic, and around its argument
      'Array<ErrorBody> | undefined',
      'Array<ErrorBody | undefined>',
      'Promise<ErrorBody | undefined>',
      'Promise<ErrorBody | null>',
      'Promise<ErrorBody> | undefined',
      'Promise<ErrorBody | null> | undefined',
    ])('TypeScript: %j → "ErrorBody"', (text) => {
      expect(bareTypeName(text)).toBe('ErrorBody');
    });

    it.each([
      'ErrorBody | None',
      'None | ErrorBody',
      'ErrorBody|None',
      'None|ErrorBody',
      'Optional[ErrorBody | None]',
      'Union[ErrorBody, None]',
      'Union[None, ErrorBody]',
      'typing.Union[ErrorBody, None]',
      'NotRequired[ErrorBody | None]',
      'NotRequired[Optional[ErrorBody]]',
      'typing_extensions.NotRequired[ErrorBody]',
      // a union the formatter wrapped over several lines
      '(\n        ErrorBody | None\n    )',
      '(\n        ErrorBody\n        | None\n    )',
      'list[ErrorBody] | None',
      'Optional[list[ErrorBody]]',
      'Optional[List[ErrorBody]]',
      'typing.Optional[list[ErrorBody]]',
      'list[ErrorBody | None]',
      'list[Optional[ErrorBody]]',
      'Optional[list[ErrorBody | None]]',
    ])('Python: %j → "ErrorBody"', (text) => {
      expect(bareTypeName(text)).toBe('ErrorBody');
    });

    it.each([
      '?ErrorBody',
      'null|ErrorBody',
      'ErrorBody|NULL',
      'ErrorBody|Null',
      'NULL|ErrorBody',
      '?\\Acme\\Models\\ErrorBody',
      'null|\\Acme\\Models\\ErrorBody',
      // PHPDoc types
      '?ErrorBody[]',
      'null|ErrorBody[]',
      'ErrorBody[]|null',
      '?\\Acme\\Models\\ErrorBody[]',
    ])('PHP: %j → "ErrorBody"', (text) => {
      expect(bareTypeName(text)).toBe('ErrorBody');
    });

    it.each([
      // Rust
      'Option<Vec<ErrorBody>>',
      'Option<Box<ErrorBody>>',
      'Vec<Option<ErrorBody>>',
      'Option<Option<ErrorBody>>',
      'std::option::Option<ErrorBody>',
      // Kotlin, Swift, C#
      'List<ErrorBody?>',
      'List<ErrorBody?>?',
      'ErrorBody?[]',
      'ErrorBody?[]?',
      'Task<ErrorBody?>',
      'System.Nullable<ErrorBody>',
      'Nullable<ErrorBody>[]',
      // Go
      '**ErrorBody',
      // Elixir, and Sorbet's spelling in Ruby
      'ErrorBody | nil',
      'nil | ErrorBody',
      'T.nilable(ErrorBody)',
    ])('Rust, Kotlin, Swift, C#, Go, Elixir, Ruby: %j → "ErrorBody"', (text) => {
      expect(bareTypeName(text)).toBe('ErrorBody');
    });
  });

  describe('only a whole member and a whole name count as a spelling', () => {
    it.each([
      // names that contain the words
      ['NoneBody', 'NoneBody'],
      ['NullableBody', 'NullableBody'],
      ['UndefinedBody', 'UndefinedBody'],
      ['nilBody', 'nilBody'],
      ['OptionalBody', 'OptionalBody'],
      ['NoneBody | None', 'NoneBody'],
      ['Optional[NullableBody]', 'NullableBody'],
      ['UndefinedBody | undefined', 'UndefinedBody'],
      ['ErrorBody | NoneType', 'ErrorBody | NoneType'],
      ['ErrorBody | Nullable', 'ErrorBody | Nullable'],
      ['ErrorBody | Undefined', 'ErrorBody | Undefined'],
      ['ErrorBody | Nil', 'ErrorBody | Nil'],
      // a type named like a wrapper, with nothing or something else in its brackets
      ['Nullable', 'Nullable'],
      ['Option', 'Option'],
      ['Option[]', 'Option'],
      ['Optional[]', 'Optional'],
      ['Nullable[]', 'Nullable'],
      ['Option[] | undefined', 'Option'],
      ['OptionalBody<ErrorBody>', 'ErrorBody'],
      ['Optional[ErrorBody, Unrelated]', 'Optional[ErrorBody, Unrelated]'],
      // string literals are values, not absence
      ['"null" | "undefined"', '"null" | "undefined"'],
      ['Literal["None"] | None', 'Literal["None"]'],
      ['"ErrorBody | None"', '"ErrorBody | None"'],
      // nothing but absence names no type and stays as written
      ['null', 'null'],
      ['undefined', 'undefined'],
      ['None', 'None'],
      ['null | undefined', 'null | undefined'],
      ['Union[None, None]', 'Union[None, None]'],
    ])('%j → %j', (text, name) => {
      expect(bareTypeName(text)).toBe(name);
    });
  });

  describe('what names no single type still names none behind an optional spelling', () => {
    it.each([
      // a union keeps the members that are types
      ['ErrorBody | Unrelated | undefined', 'ErrorBody | Unrelated'],
      ['undefined | ErrorBody | Unrelated', 'ErrorBody | Unrelated'],
      ['ErrorBody | undefined | Unrelated', 'ErrorBody | Unrelated'],
      ['ErrorBody|Unrelated|null', 'ErrorBody|Unrelated'],
      ['null|ErrorBody|Unrelated', 'ErrorBody|Unrelated'],
      ['ErrorBody | Unrelated | None', 'ErrorBody | Unrelated'],
      ['Union[ErrorBody, Unrelated, None]', 'Union[ErrorBody, Unrelated]'],
      ['Union[None, ErrorBody, Unrelated]', 'Union[ErrorBody, Unrelated]'],
      ['Optional[ErrorBody | Unrelated]', 'ErrorBody | Unrelated'],
      ['(ErrorBody | Unrelated | null)[]', '(ErrorBody | Unrelated)'],
      ['Promise<ErrorBody | Unrelated | undefined>', 'Promise<ErrorBody | Unrelated>'],
      // several arguments
      ['Record<string, ErrorBody> | undefined', 'Record<string, ErrorBody>'],
      ['Record<string, ErrorBody | undefined>', 'Record<string, ErrorBody | undefined>'],
      ['Optional[Dict[str, ErrorBody]]', 'Dict[str, ErrorBody]'],
      ['Option<HashMap<String, ErrorBody>>', 'HashMap<String, ErrorBody>'],
      // an array or a generic two deep
      ['ErrorBody[][] | undefined', 'ErrorBody[]'],
      ['Promise<ErrorBody[] | undefined>', 'Promise<ErrorBody[]>'],
      ['Promise<Array<ErrorBody> | undefined>', 'Promise<Array<ErrorBody>>'],
      ['Optional[list[list[ErrorBody]]]', 'list[list[ErrorBody]]'],
      // object and function types, a quoted name
      ['{ body?: ErrorBody | undefined; } | undefined', '{ body?: ErrorBody | undefined; }'],
      ['{ body: ErrorBody | undefined; }', '{ body: ErrorBody | undefined; }'],
      ['(() => ErrorBody) | undefined', '(() => ErrorBody)'],
      ['() => ErrorBody | undefined', '() => ErrorBody'],
      ['Optional["ErrorBody"]', '"ErrorBody"'],
      ['"ErrorBody" | None', '"ErrorBody"'],
      // shapes of other languages
      ['[ErrorBody]?', '[ErrorBody]'],
      ['[]*ErrorBody', '[]*ErrorBody'],
      ['*[]ErrorBody', '[]ErrorBody'],
      ['ErrorBody.t() | nil', 'ErrorBody.t()'],
      ['T.nilable(T::Array[ErrorBody])', 'T::Array[ErrorBody]'],
    ])('%j → %j', (text, name) => {
      expect(bareTypeName(text)).toBe(name);
    });
  });

  describe('a text whose brackets or quotes do not pair up is left whole', () => {
    it.each([
      ['ErrorBody | undefined>', 'ErrorBody | undefined>'],
      ['Array<ErrorBody | undefined', 'Array<ErrorBody | undefined'],
      ['(ErrorBody | undefined', '(ErrorBody | undefined'],
      ['ErrorBody) | undefined', 'ErrorBody) | undefined'],
      ['"ErrorBody | undefined', '"ErrorBody | undefined'],
      ["Option<&'a ErrorBody>", "Option<&'a ErrorBody>"],
      ['Optional[ErrorBody][ErrorBody]', 'Optional[ErrorBody][ErrorBody]'],
      ['Optional[ErrorBody)', 'Optional[ErrorBody)'],
      // a blank member: not a union
      ['| undefined', '| undefined'],
      ['ErrorBody | | undefined', 'ErrorBody | | undefined'],
      ['Union[, None]', 'Union[, None]'],
      ['', ''],
      ['?', ''],
      ['[]', ''],
    ])('%j → %j', (text, name) => {
      expect(bareTypeName(text)).toBe(name);
    });
  });
});

/**
 * #752: three more readers of a type text, for asking whether a parameter's
 * new type accepts every value of its old one.
 */
describe('unionMembers (#752)', () => {
  it.each<[string, string[]]>([
    ['string', ['string']],
    ['string | number', ['string', 'number']],
    ['string|number', ['string', 'number']],
    ['  string  |  number  ', ['string', 'number']],
    ['RequestOptions | undefined', ['RequestOptions', 'undefined']],
    ['string | null | undefined', ['string', 'null', 'undefined']],
    ['str | None', ['str', 'None']],
    // each member once
    ['string | string', ['string']],
    // parentheses around the whole union, and around a member
    ['(string | number)', ['string', 'number']],
    ['(string | number) | null', ['string', 'number', 'null']],
    ['((string))', ['string']],
    // what a member is made of stays whole
    ['(string | number)[]', ['(string | number)[]']],
    ['Array<string | number>', ['Array<string | number>']],
    ['Record<string, A | B>', ['Record<string, A | B>']],
    ['{ a: A | B; }', ['{ a: A | B; }']],
    ['{ a: A | B; } | undefined', ['{ a: A | B; }', 'undefined']],
    ['[A | B, C]', ['[A | B, C]']],
    ["'a|b' | 'c'", ["'a|b'", "'c'"]],
    ['"a|b"', ['"a|b"']],
    ['`a|${string}` | "c"', ['`a|${string}`', '"c"']],
    ['A & B | C', ['A & B', 'C']],
    ['Optional[A | B]', ['Optional[A | B]']],
    ['string|int|null', ['string', 'int', 'null']],
  ])('%j → %j', (text, members) => {
    expect(unionMembers(text)).toEqual(members);
  });

  describe('a function type is one member, whatever it returns', () => {
    it.each<[string, string[]]>([
      ['() => void', ['() => void']],
      ['() => string | number', ['() => string | number']],
      ['(pet: Pet | null) => A | B', ['(pet: Pet | null) => A | B']],
      ['(a: A) -> B | C', ['(a: A) -> B | C']],
      // among a union's members it stands in parentheses, which go with the union
      ['(() => void) | undefined', ['() => void', 'undefined']],
      ['(() => A | B) | undefined', ['() => A | B', 'undefined']],
      ['((pet: Pet) => void) | (() => void)', ['(pet: Pet) => void', '() => void']],
      // an arrow inside a bracket is the member's own business
      ['Array<() => void> | null', ['Array<() => void>', 'null']],
      ['{ done: () => void; } | null', ['{ done: () => void; }', 'null']],
    ])('%j → %j', (text, members) => {
      expect(unionMembers(text)).toEqual(members);
    });
  });

  it.each([
    [''],
    ['   '],
    ['| string'],
    ['string |'],
    ['string | | number'],
    ['(string | number'],
    ['string | number)'],
    ['Array<string | number'],
    ['"string | number'],
    ['(string |) | number'],
  ])('%j does not read as a union', (text) => {
    expect(unionMembers(text)).toBeUndefined();
  });

  it('reads the member a single-type text is', () => {
    // Every text `bareTypeName` reads as one name is a union of one or of
    // the name and the absent members around it.
    for (const text of ['Foo', 'Foo[]', 'Promise<Foo>', '?Foo', 'Foo?', '*Foo', 'Optional[Foo]']) {
      expect(unionMembers(text)).toEqual([text]);
    }
  });
});

describe('soleTypeName (#752)', () => {
  it.each<[string, string]>([
    ['Foo', 'Foo'],
    ['  Foo  ', 'Foo'],
    ['Foo[]', 'Foo'],
    // every optional spelling `bareTypeName` reads through
    ['Foo | undefined', 'Foo'],
    ['undefined | Foo', 'Foo'],
    ['Foo | null', 'Foo'],
    ['Foo | null | undefined', 'Foo'],
    ['Foo | None', 'Foo'],
    ['Foo | nil', 'Foo'],
    ['?Foo', 'Foo'],
    ['Foo?', 'Foo'],
    ['*Foo', 'Foo'],
    ['Optional[Foo]', 'Foo'],
    ['typing.Optional[Foo]', 'Foo'],
    ['NotRequired[Foo]', 'Foo'],
    ['Option<Foo>', 'Foo'],
    ['Nullable<Foo>', 'Foo'],
    ['T.nilable(Foo)', 'Foo'],
    ['Union[Foo, None]', 'Foo'],
    ['null|Foo', 'Foo'],
    // an array's element, optional or not
    ['Foo[] | undefined', 'Foo'],
    ['(Foo | null)[]', 'Foo'],
    ['Foo?[]', 'Foo'],
    ['?Foo[]', 'Foo'],
    // PHP's namespace
    ['\\Acme\\Foo', 'Foo'],
    ['?\\Acme\\Models\\Foo', 'Foo'],
  ])('%j names %j', (text, name) => {
    expect(soleTypeName(text)).toBe(name);
    // ... and `bareTypeName` reads the same name there.
    expect(bareTypeName(text)).toBe(name);
  });

  it.each([
    // a generic's argument: `bareTypeName` reads `Foo`, this does not
    ['Promise<Foo>'],
    ['List<Foo>'],
    ['Array<Foo>'],
    ['list[Foo]'],
    ['Iterator[Foo]'],
    ['Vec<Foo>'],
    ['Option<Vec<Foo>>'],
    ['Promise<Foo> | undefined'],
    ['Promise<Foo | undefined>'],
    ['List<Foo>?'],
    // what names no single type in either reader
    ['Foo | Bar'],
    ['Foo | Bar | null'],
    ['Record<string, Foo>'],
    ['Foo[][]'],
    ['{ body: Foo; }'],
    ['() => Foo'],
    ['[Foo, Bar]'],
    ['"Foo"'],
    ['models.Foo'],
    ['crate::models::Foo'],
    ['[]Foo'],
    ['[Foo]'],
    ['Foo.t()'],
    ['\\Acme\\Foo|\\Acme\\Bar'],
    ['readonly Foo[]'],
    [''],
    ['?'],
    ['[]'],
    ['Foo<'],
  ])('%j names no type', (text) => {
    expect(soleTypeName(text)).toBeUndefined();
  });

  it('reads a text that is nothing but absence as `bareTypeName` does: a name no type has', () => {
    expect(soleTypeName('null')).toBe('null');
    expect(soleTypeName('null | undefined')).toBeUndefined();
  });

  it('refuses the PHP union `bareTypeName` reads as its last member', () => {
    expect(bareTypeName('\\Acme\\Other|\\Acme\\Foo')).toBe('Foo');
    expect(soleTypeName('\\Acme\\Other|\\Acme\\Foo')).toBeUndefined();
  });
});

describe('singleArgumentGeneric (#752)', () => {
  it.each<[string, string, string]>([
    ['Promise<Foo>', 'Promise', 'Foo'],
    ['  Promise<Foo>  ', 'Promise', 'Foo'],
    ['Promise<Foo | null>', 'Promise', 'Foo | null'],
    ['Promise<Foo[]>', 'Promise', 'Foo[]'],
    ['Promise<Set<Foo>>', 'Promise', 'Set<Foo>'],
    ['Promise<{ a: A; b: B; }>', 'Promise', '{ a: A; b: B; }'],
    ['Promise<[A, B]>', 'Promise', '[A, B]'],
    ['Promise<Record<string, Foo>>', 'Promise', 'Record<string, Foo>'],
    ['Promise<(a: A, b: B) => void>', 'Promise', '(a: A, b: B) => void'],
    ['Promise<"a,b">', 'Promise', '"a,b"'],
    ['Sequence[Foo]', 'Sequence', 'Foo'],
    ['typing.Sequence[Foo | None]', 'typing.Sequence', 'Foo | None'],
    ['Optional[Foo]', 'Optional', 'Foo'],
  ])('%j is %j around %j', (text, generic, argument) => {
    expect(singleArgumentGeneric(text)).toEqual({ generic, argument });
  });

  it.each([
    ['Foo'],
    ['Foo[]'],
    ['Promise<Foo>[]'],
    ['Promise<Foo> | null'],
    ['Promise<A> | Promise<B>'],
    ['Promise<A> & Extra<B>'],
    ['Record<string, Foo>'],
    ['Map<K, V>'],
    ['Promise<>'],
    ['Promise< >'],
    ['Promise<Foo'],
    ['Promise<Foo>>'],
    ['<Foo>'],
    ['[Foo]'],
    ['{ a: Promise<Foo>; }'],
    ['() => Promise<Foo>'],
    ['?Promise<Foo>'],
    [''],
  ])('%j is not one generic around one argument', (text) => {
    expect(singleArgumentGeneric(text)).toBeUndefined();
  });

  it('reads the generic `genericWrapperOf` (#750) reads, where that one reads any', () => {
    for (const text of ['Promise<Foo>', 'models.Page[Foo]', 'List<Foo>', 'Iterator[*Foo]']) {
      expect(singleArgumentGeneric(text)?.generic).toBe(genericWrapperOf(text));
    }
    // That reader looks through an optional spelling and an array to find
    // its generic; this one takes a text that is the generic itself.
    expect(genericWrapperOf('Promise<Foo>[]')).toBe('Promise');
    expect(genericWrapperOf('Promise<Foo[]>')).toBeUndefined();
    expect(singleArgumentGeneric('Promise<Foo[]>')).toEqual({ generic: 'Promise', argument: 'Foo[]' });
  });
});

describe('objectTypeMembers (#752)', () => {
  const members = (text: string) => {
    const read = objectTypeMembers(text);
    return (
      read &&
      Object.fromEntries([...read].map(([name, member]) => [name, `${member.optional ? '?' : ''}${member.type}`]))
    );
  };

  it.each<[string, Record<string, string>]>([
    // as TypeScript prints an object type
    ['{ id: string; name?: string | undefined; }', { id: 'string', name: '?string | undefined' }],
    ['{ id: string }', { id: 'string' }],
    ['{id:string;name?:number}', { id: 'string', name: '?number' }],
    ['  { id: string; }  ', { id: 'string' }],
    ['{}', {}],
    ['{ }', {}],
    ['{ readonly id: string; readonly name?: string; }', { id: 'string', name: '?string' }],
    ['{ "content-type"?: string; \'x-id\': number; }', { 'content-type': '?string', 'x-id': 'number' }],
    ['{ 0: string; 1?: number; }', { 0: 'string', 1: '?number' }],
    ['{ $ref: string; _id: string; }', { $ref: 'string', _id: 'string' }],
    // a member's type is whatever follows its colon
    ['{ filter?: { name?: string; tag: string; }; }', { filter: '?{ name?: string; tag: string; }' }],
    ['{ done: (error: Error | null) => void; }', { done: '(error: Error | null) => void' }],
    ['{ pick: Record<string, { a: A; }>; ids: string[]; }', { pick: 'Record<string, { a: A; }>', ids: 'string[]' }],
    ['{ kind: "a;b" | "c:d"; }', { kind: '"a;b" | "c:d"' }],
    ['{ which: T extends string ? A : B; }', { which: 'T extends string ? A : B' }],
    ['{ order: "asc" | "desc"; }', { order: '"asc" | "desc"' }],
  ])('%j', (text, expected) => {
    expect(members(text)).toEqual(expected);
  });

  it.each([
    // not an object type in braces
    ['RequestOptions'],
    ['string'],
    ['{ id: string; }[]'],
    ['{ id: string; } | undefined'],
    ['{ id: string; } & Extra'],
    ['[{ id: string; }]'],
    [''],
    ['{ id: string;'],
    ['{ id: string; }}'],
    // a member that is not a name and a type
    ['{ [key: string]: unknown; }'],
    ['{ id: string; [key: string]: unknown; }'],
    ['{ readonly [key: string]: string; }'],
    ['{ [K in Keys]?: string; }'],
    ['{ (attempt: number): void; }'],
    ['{ new (attempt: number): Retry; }'],
    ['{ retry(attempt: number): void; }'],
    ['{ retry?(attempt: number): void; }'],
    ['{ get id(): string; }'],
    ['{ [Symbol.iterator]: () => Iterator<string>; }'],
    ['{ id; }'],
    ['{ id: ; }'],
    ['{ : string; }'],
    ['{ a b: string; }'],
    ['{ "id: string; }'],
    // a name written twice
    ['{ id: string; id: number; }'],
    ['{ id: string; "id": number; }'],
    // a type TypeScript cut short
    ['{ a: string; b: string; ... 12 more ...; z: string; }'],
  ])('%j says nothing', (text) => {
    expect(members(text)).toBeUndefined();
  });
});
