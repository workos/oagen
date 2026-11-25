import { describe, it, expect } from 'vitest';
import { bareTypeName } from '../../src/compat/type-names.js';

/**
 * `bareTypeName` reads the declared type a recorded type text names. #751:
 * an optional or nullable spelling is transparent to it, in every spelling
 * and order a language writes, and at every place the function looks (the
 * top, an array's element, a single generic argument).
 */
describe('bareTypeName (#751)', () => {
  // What the function returned before #751, text by text: none of these may move.
  describe('a text without an optional spelling reads as it always has', () => {
    it.each([
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
      ['\\Acme\\Models\\ErrorBody', 'ErrorBody'],
      ['\\Acme\\Models\\ErrorBody[]', 'ErrorBody'],
      // one array suffix and one generic are read through, not two
      ['ErrorBody[][]', 'ErrorBody[]'],
      ['Promise<ErrorBody[]>', 'Promise<ErrorBody[]>'],
      ['Promise<Array<ErrorBody>>', 'Promise<Array<ErrorBody>>'],
      // several arguments, several types, or no name at all
      ['Record<string, ErrorBody>', 'Record<string, ErrorBody>'],
      ['Dict[str, ErrorBody]', 'Dict[str, ErrorBody]'],
      ['ErrorBody | Unrelated', 'ErrorBody | Unrelated'],
      ['ErrorBody|Unrelated', 'ErrorBody|Unrelated'],
      ['Union[ErrorBody, Unrelated]', 'Union[ErrorBody, Unrelated]'],
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
    ])('%j → %j', (text, name) => {
      expect(bareTypeName(text)).toBe(name);
    });

    // The spellings the function read before #751.
    it.each([
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
    ])('%j → %j, as before', (text, name) => {
      expect(bareTypeName(text)).toBe(name);
    });
  });

  describe('an optional spelling is transparent', () => {
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

    // The rule behind the tables: whatever a text reads as, it reads the same
    // with an optional spelling around it.
    it('every spelling around every text reads as the text does', () => {
      const texts = [
        'ErrorBody',
        ' ErrorBody ',
        'ErrorBody[]',
        'ErrorBody[][]',
        'ErrorBody []',
        'Array<ErrorBody>',
        'Iterator[ErrorBody]',
        'Promise<ErrorBody[]>',
        'Record<string, ErrorBody>',
        'Dict[str, ErrorBody]',
        'ErrorBody | Unrelated',
        'ErrorBody|Unrelated',
        'Union[ErrorBody, Unrelated]',
        '\\Acme\\ErrorBody',
        '\\Acme\\ErrorBody[]',
        'models.ErrorBody',
        '{ body: ErrorBody; }',
        '() => ErrorBody',
        '(a: ErrorBody) => void',
        '(ErrorBody)',
        '"ErrorBody"',
        '[]ErrorBody',
        'map[string]ErrorBody',
        '[ErrorBody]',
        'ErrorBody.t()',
        'string',
        'NoneBody',
        'Nullable',
        'Option[]',
        // already optional, in a spelling read before #751 and in a new one
        'ErrorBody | null',
        'ErrorBody?',
        '*ErrorBody',
        'ErrorBody | Unrelated | null',
        'ErrorBody | undefined',
        '?ErrorBody',
      ];
      const spellings: ((text: string) => string)[] = [
        (t) => `${t} | undefined`,
        (t) => `undefined | ${t}`,
        (t) => `${t}|undefined`,
        (t) => `undefined|${t}`,
        (t) => `${t} | null`,
        (t) => `null | ${t}`,
        (t) => `${t}|null`,
        (t) => `null|${t}`,
        (t) => `${t}|NULL`,
        (t) => `${t} | null | undefined`,
        (t) => `undefined | null | ${t}`,
        (t) => `${t} | None`,
        (t) => `None | ${t}`,
        (t) => `${t}|None`,
        (t) => `${t} | nil`,
        (t) => `nil | ${t}`,
        (t) => `?${t}`,
        (t) => `${t}?`,
        (t) => `*${t}`,
        (t) => `Optional[${t}]`,
        (t) => `typing.Optional[${t}]`,
        (t) => `Optional[${t} | None]`,
        (t) => `NotRequired[${t}]`,
        (t) => `Union[${t}, None]`,
        (t) => `Union[None, ${t}]`,
        (t) => `Optional<${t}>`,
        (t) => `Option<${t}>`,
        (t) => `Nullable<${t}>`,
        (t) => `T.nilable(${t})`,
      ];
      const moved: string[] = [];
      for (const text of texts) {
        for (const spelled of spellings.map((spell) => spell(text))) {
          if (bareTypeName(spelled) !== bareTypeName(text)) {
            moved.push(`${JSON.stringify(spelled)} → ${JSON.stringify(bareTypeName(spelled))}`);
          }
        }
      }
      expect(moved).toEqual([]);
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
      ['Promise<ErrorBody | Unrelated | undefined>', 'Promise<ErrorBody | Unrelated | undefined>'],
      // several arguments
      ['Record<string, ErrorBody> | undefined', 'Record<string, ErrorBody>'],
      ['Record<string, ErrorBody | undefined>', 'Record<string, ErrorBody | undefined>'],
      ['Optional[Dict[str, ErrorBody]]', 'Dict[str, ErrorBody]'],
      ['Option<HashMap<String, ErrorBody>>', 'HashMap<String, ErrorBody>'],
      // an array or a generic two deep
      ['ErrorBody[][] | undefined', 'ErrorBody[]'],
      ['Promise<ErrorBody[] | undefined>', 'Promise<ErrorBody[] | undefined>'],
      ['Promise<Array<ErrorBody> | undefined>', 'Promise<Array<ErrorBody> | undefined>'],
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
