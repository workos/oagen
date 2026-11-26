import { describe, it, expect } from 'vitest';
import type { CompatSnapshot, CompatSymbol } from '../../src/compat/ir.js';
import { getDefaultPolicy } from '../../src/compat/policy.js';
import {
  declaredTypes,
  declaresSupertype,
  inputTypes,
  isObjectAlias,
  isRecordedByNameOnly,
} from '../../src/compat/type-graph.js';
import {
  bareTypeName,
  genericWrapperOf,
  handsBackItsArgument,
  keepsMember,
  supertypeName,
  typeNamesIn,
  typesTakenIn,
  WHOLE_TYPE,
  withoutRepeatedIntersectionMembers,
} from '../../src/compat/type-names.js';
import type { TakenType, TypePart } from '../../src/compat/type-names.js';

/**
 * #750: what a snapshot says about its declared types, and the three readers
 * the differ asks: which types a text mentions, whether a type declares that
 * it extends another, and which types callers build.
 */

const symbol = (kind: CompatSymbol['kind'], fqName: string, extra: Partial<CompatSymbol> = {}): CompatSymbol => ({
  id: `${kind}:${fqName}`,
  kind,
  fqName,
  displayName: fqName,
  visibility: 'public',
  stability: 'stable',
  sourceKind: 'generated_resource_constructor',
  ...extra,
});
const type = (name: string, extra: Partial<CompatSymbol> = {}) => symbol('alias', name, extra);
const field = (owner: string, name: string, typeText: string, extra: Partial<CompatSymbol> = {}) =>
  symbol('field', `${owner}.${name}`, { ownerFqName: owner, typeRef: { name: typeText }, ...extra });
const callable = (fqName: string, ...parameterTypes: string[]) =>
  symbol('callable', fqName, {
    ownerFqName: fqName.slice(0, fqName.lastIndexOf('.')),
    parameters: parameterTypes.map((name, position) => ({
      publicName: `p${position}`,
      position,
      required: true,
      nullable: false,
      hasDefault: false,
      passing: 'positional' as const,
      type: { name },
      sensitivity: { order: true, publicName: false, requiredness: true, type: true },
    })),
  });
const snapshot = (...symbols: CompatSymbol[]): CompatSnapshot => ({
  schemaVersion: '1',
  source: { extractedAt: '2026-01-01T00:00:00.000Z' },
  policies: getDefaultPolicy('node'),
  symbols,
});

describe('#750 typeNamesIn', () => {
  const names = (text: string) => typeNamesIn(text).sort();

  it.each([
    ['Foo', ['Foo']],
    ['Foo[]', ['Foo']],
    ['Foo[][]', ['Foo']],
    ['readonly Foo[]', ['Foo', 'readonly']],
    ['Foo | undefined', ['Foo', 'undefined']],
    ['Foo | Bar', ['Bar', 'Foo']],
    ['Foo & Bar', ['Bar', 'Foo']],
    ['Promise<Foo>', ['Foo', 'Promise']],
    ['Promise<Foo[]>', ['Foo', 'Promise']],
    ['Record<string, Foo>', ['Foo', 'Record', 'string']],
    ['Map<string, Foo[]>', ['Foo', 'Map', 'string']],
    ['[Foo, Bar]', ['Bar', 'Foo']],
    ['{ body: Foo; }', ['Foo', 'body']],
    ['(owner: Foo) => Bar', ['Bar', 'Foo', 'owner']],
    ['?Foo', ['Foo']],
    ['*Foo', ['Foo']],
    ['[]*Foo', ['Foo']],
    ['map[string]Foo', ['Foo', 'map', 'string']],
    ['Optional[Foo]', ['Foo', 'Optional']],
    ['list[Foo] | None', ['Foo', 'None', 'list']],
    ['Dict[str, List[Foo]]', ['Dict', 'Foo', 'List', 'str']],
    ['Option<Vec<Foo>>', ['Foo', 'Option', 'Vec']],
    ['List<Foo?>?', ['Foo', 'List']],
    ['[String: Foo]', ['Foo', 'String']],
    ['T.nilable(Foo)', ['Foo', 'T', 'T.nilable', 'nilable']],
  ])('%s', (text, expected) => {
    expect(names(text)).toEqual(expected);
  });

  it('gives a name path as written and each of its segments', () => {
    expect(names('models.Foo')).toEqual(['Foo', 'models', 'models.Foo']);
    expect(names('crate::models::Foo')).toEqual(['Foo', 'crate', 'crate::models::Foo', 'models']);
    expect(names('\\Acme\\Models\\Foo')).toEqual(['Acme', 'Foo', 'Models', '\\Acme\\Models\\Foo']);
    expect(names('Petstore.Pets.Foo.t()')).toEqual(['Foo', 'Pets', 'Petstore', 'Petstore.Pets.Foo.t', 't']);
  });

  it('skips a string literal whole', () => {
    expect(names("Exclude<Foo, 'id' | 'name'>")).toEqual(['Exclude', 'Foo']);
    expect(names('Extract<Foo, "id">')).toEqual(['Extract', 'Foo']);
    // The keys of an `Omit` are read: it takes a part of `Foo`, not `Foo` whole.
    expect(names("Omit<Foo, 'id' | 'name'>")).toEqual([]);
    expect(names('Omit<Foo, "id">')).toEqual([]);
    expect(names("'Foo' | 'Bar'")).toEqual([]);
    expect(names('Literal["Foo", "Bar"]')).toEqual(['Literal']);
    // A quoted forward reference is not followed, as `bareTypeName` does not look one up.
    expect(names('Optional["Foo"]')).toEqual(['Optional']);
    expect(bareTypeName('"Foo"')).toBe('"Foo"');
  });

  it('reads through an apostrophe that opens no string literal', () => {
    // Rust lifetimes: one apostrophe, or two with type syntax between them.
    expect(names("&'a Foo")).toEqual(['Foo', 'a']);
    expect(names("&'a Foo, &'b Bar")).toEqual(['Bar', 'Foo', 'a', 'b']);
    expect(names("Cow<'a, Foo>")).toEqual(['Cow', 'Foo', 'a']);
    expect(names("Box<dyn Handler<'a> + 'a>")).toEqual(['Box', 'Handler', 'a', 'dyn']);
    // A template literal type's placeholders are types (and `$` is a name a type may have).
    expect(names('`${Prefix}-${Foo}`')).toEqual(['$', 'Foo', 'Prefix']);
    expect(names('`pet-${string}`')).toEqual(['$', 'pet', 'string']);
    expect(names('`pets`')).toEqual([]);
  });

  it('gives the names taken whole: not a type a Partial, a Pick or an Omit takes a part of', () => {
    expect(names('Partial<Foo>')).toEqual([]);
    expect(names("Pick<Foo, 'id'>")).toEqual([]);
    expect(names("Omit<Foo, 'id'>")).toEqual([]);
    expect(names('Partial<Foo> | Bar')).toEqual(['Bar']);
    expect(names('Partial <Foo>')).toEqual([]);
    expect(names('Promise<Partial<Foo>>')).toEqual(['Promise']);
    // What a `Partial` holds that is no declared type's name is read as any
    // other text: a value of it is built from whole `Foo`s.
    expect(names('Partial<Record<string, Foo>> & Bar')).toEqual(['Bar', 'Foo', 'Record', 'string']);
    expect(names('Partial<(a: Foo) => Bar> | Baz')).toEqual(['Bar', 'Baz', 'Foo', 'a']);
    // The other utility types keep every member of their argument.
    expect(names('Required<Foo>')).toEqual(['Foo', 'Required']);
    expect(names('Readonly<Foo>')).toEqual(['Foo', 'Readonly']);
    // A type that is merely named so, and an argument list that never closes.
    expect(names('Partial')).toEqual(['Partial']);
    expect(names('PartialFoo<Bar>')).toEqual(['Bar', 'PartialFoo']);
    expect(names('Partial<Foo')).toEqual(['Foo', 'Partial']);
  });

  it('names what bareTypeName names, for every text that names one type', () => {
    const texts = [
      'Foo',
      'Foo[]',
      'Foo | null',
      'Foo | undefined',
      'undefined | Foo',
      'Foo | None',
      '?Foo',
      'Foo?',
      '*Foo',
      'Optional[Foo]',
      'Promise<Foo>',
      'Promise<Foo | null>',
      'List<Foo>?',
      '(Foo | null)[]',
      '\\Acme\\Foo',
      '?\\Acme\\Foo',
      'Option<Vec<Foo>>',
      'Union[Foo, None]',
      'T.nilable(Foo)',
      'Iterator[*Foo]',
    ];
    for (const text of texts) {
      expect(bareTypeName(text), text).toBe('Foo');
      expect(typeNamesIn(text), text).toContain('Foo');
    }
  });

  it('returns nothing for a text with no name, and never throws', () => {
    for (const text of [
      '',
      ' ',
      '[]',
      '{}',
      '()',
      '|',
      "'",
      '"',
      '`',
      "''",
      '\\',
      '.',
      '::',
      '<',
      'Partial<',
      '<<<>',
    ]) {
      expect(() => typeNamesIn(text), text).not.toThrow();
    }
    expect(typeNamesIn('')).toEqual([]);
    expect(typeNamesIn('123')).toEqual([]);
  });
});

/** A taken type as one word: `Foo` whole, `Foo without(a,b)`, `Foo only(a)`,
 *  `Foo optional`, `Foo optional without(a)`. */
const partOf = ({ name, part }: TakenType): string => {
  if (part === WHOLE_TYPE) return name;
  const keys = [...part.keys].sort().join(',');
  const members = part.only ? ` only(${keys})` : part.keys.size > 0 ? ` without(${keys})` : '';
  return `${name}${part.optional ? ' optional' : ''}${members}`;
};
const taken = (text: string, part?: TypePart) => typesTakenIn(text, part).map(partOf);
const without = (...keys: string[]): TypePart => ({ keys: new Set(keys), only: false, optional: false });

describe('#750 typesTakenIn (#759 review: the part of a type an Omit, a Pick or a Partial takes)', () => {
  it.each<[string, string[]]>([
    // the three wrappers
    ['Omit<Foo, "a">', ['Foo without(a)']],
    ['Pick<Foo, "a">', ['Foo only(a)']],
    ['Partial<Foo>', ['Foo optional']],
    // the keys: a union, in any quotes and spacing
    ["Omit<Foo, 'a' | 'b'>", ['Foo without(a,b)']],
    ['Omit<Foo, "a" | "a">', ['Foo without(a)']],
    ['Omit<Foo, `a`>', ['Foo without(a)']],
    ['Omit < Foo , "a" >', ['Foo without(a)']],
    ["Omit<\n  Foo,\n  | 'a'\n  | 'b'\n>", ['Foo without(a,b)']],
    ['Omit<Foo, "owner-id" | "a b">', ['Foo without(a b,owner-id)']],
    ['Partial <Foo>', ['Foo optional']],
    // one inside another: the members both keep, none required under a Partial
    ['Partial<Omit<Foo, "a">>', ['Foo optional without(a)']],
    ['Omit<Partial<Foo>, "a">', ['Foo optional without(a)']],
    ['Omit<Omit<Foo, "a">, "b">', ['Foo without(a,b)']],
    ['Pick<Omit<Foo, "a">, "a" | "b">', ['Foo only(b)']],
    ['Omit<Pick<Foo, "a" | "b">, "a">', ['Foo only(b)']],
    ['Pick<Pick<Foo, "a" | "b">, "b" | "c">', ['Foo only(b)']],
    ['Partial<Pick<Foo, "a">>', ['Foo optional only(a)']],
    ['Pick<Partial<Foo>, "a">', ['Foo optional only(a)']],
    ['Partial<Partial<Foo>>', ['Foo optional']],
    // each type the first argument names at the top
    ['Omit<Foo & Bar, "a">', ['Foo without(a)', 'Bar without(a)']],
    ['Omit<Foo | Bar, "a">', ['Foo without(a)', 'Bar without(a)']],
    ['Omit<(Foo | Bar) & Baz, "a">', ['Foo without(a)', 'Bar without(a)', 'Baz without(a)']],
    ['Omit<| Foo | Bar, "a">', ['Foo without(a)', 'Bar without(a)']],
    ['Omit<(Foo), "a">', ['Foo without(a)']],
    ['Omit<models.Foo, "a">', ['models.Foo without(a)', 'models without(a)', 'Foo without(a)']],
    // wherever the wrapper stands
    ['Promise<Omit<Foo, "a">>', ['Promise', 'Foo without(a)']],
    ['Readonly<Omit<Foo, "a">>', ['Readonly', 'Foo without(a)']],
    ['Omit<Foo, "a">[]', ['Foo without(a)']],
    ['{ owner: Omit<Foo, "a"> }', ['owner', 'Foo without(a)']],
    ['(owner: Omit<Foo, "a">) => void', ['owner', 'Foo without(a)', 'void']],
    ['Omit<Foo, "a"> & { a?: Bar }', ['Foo without(a)', 'a', 'Bar']],
    // a type taken twice is given twice, each time with its part
    ['Omit<Foo, "a"> | Foo', ['Foo without(a)', 'Foo']],
    ['Foo | Omit<Foo, "a">', ['Foo', 'Foo without(a)']],
    ['Omit<Foo, "a"> | Omit<Foo, "b">', ['Foo without(a)', 'Foo without(b)']],
    ['Partial<Foo> | Foo', ['Foo optional', 'Foo']],
    ['Partial<Foo> & Pick<Foo, "a">', ['Foo optional', 'Foo only(a)']],
  ])('%j → %j', (text, expected) => {
    expect(taken(text)).toEqual(expected);
  });

  it('reads whole what a first argument holds that is no declared type by name, but under a Pick', () => {
    // Nothing names the type whose members the keys choose among.
    expect(taken('Omit<Page<Foo>, "a">')).toEqual(['Page', 'Foo']);
    expect(taken('Omit<{ foo: Foo }, "a">')).toEqual(['foo', 'Foo']);
    expect(taken('Omit<Foo[], "a">')).toEqual(['Foo']);
    expect(taken('Omit<Foo & Page<Bar>, "a">')).toEqual(['Foo without(a)', 'Page', 'Bar']);
    expect(taken('Partial<Record<string, Foo>>')).toEqual(['Record', 'string', 'Foo']);
    expect(taken('Partial<{ foo: Foo }>')).toEqual(['foo', 'Foo']);
    // A `Pick` keeps only what its keys list, and which of these that is the text does not say.
    expect(taken('Pick<{ foo: Foo }, "foo">')).toEqual([]);
    expect(taken('Pick<Page<Foo>, "a">')).toEqual([]);
    expect(taken('Pick<Foo & { bar: Bar }, "a">')).toEqual(['Foo only(a)']);
    // An argument with a function type in it is not taken apart at all.
    expect(taken('Partial<(a: Foo) => Bar | Baz>')).toEqual(['a', 'Foo', 'Bar', 'Baz']);
    expect(taken('Omit<Foo & { done: () => void }, "a">')).toEqual(['Foo', 'done', 'void']);
    expect(taken('Pick<Foo & { done: () => void }, "a">')).toEqual([]);
  });

  it('makes up no part where the text spells no keys: an Omit is read whole, a Pick not at all', () => {
    for (const keys of [
      'Keys',
      'keyof Bar',
      '"a" | Keys',
      'never',
      '1',
      '("a" | "b")',
      '`a${string}`',
      '"a\\"b"',
      '',
    ]) {
      const omitted = typesTakenIn(`Omit<Foo, ${keys}>`);
      expect(
        omitted.map(({ name }) => name),
        keys,
      ).toEqual(expect.arrayContaining(['Omit', 'Foo']));
      expect(
        omitted.every(({ part }) => part === WHOLE_TYPE),
        keys,
      ).toBe(true);
      expect(taken(`Pick<Foo, ${keys}>`), keys).toEqual([]);
    }
    // The wrong number of arguments says no part either.
    expect(taken('Omit<Foo>')).toEqual(['Omit', 'Foo']);
    expect(taken('Omit<Foo, "a", "b">')).toEqual(['Omit', 'Foo']);
    expect(taken('Pick<Foo>')).toEqual([]);
    expect(taken('Partial<Foo, Bar>')).toEqual([]);
    expect(taken('Partial<>')).toEqual([]);
    // One that spells none, under one that does.
    expect(taken('Partial<Omit<Foo, Keys>>')).toEqual(['Omit', 'Foo', 'Keys']);
    expect(taken('Omit<Omit<Foo, Keys>, "a">')).toEqual(['Omit', 'Foo', 'Keys']);
    expect(taken('Omit<Pick<Foo, Keys>, "a">')).toEqual([]);
    expect(taken('Pick<Omit<Foo, Keys>, "a">')).toEqual([]);
  });

  it('reads only the three wrappers, by name and with their angle brackets', () => {
    expect(taken('Omitted<Foo, "a">')).toEqual(['Omitted', 'Foo']);
    expect(taken('ns.Omit<Foo, "a">')).toEqual(['ns.Omit', 'ns', 'Omit', 'Foo']);
    expect(taken('Omit')).toEqual(['Omit']);
    expect(taken('Omit<Foo, "a"')).toEqual(['Omit', 'Foo']);
    expect(taken('Omit[Foo, "a"]')).toEqual(['Omit', 'Foo']);
    expect(taken('Required<Foo>')).toEqual(['Required', 'Foo']);
    expect(taken('Exclude<Foo, "a">')).toEqual(['Exclude', 'Foo']);
  });

  it('takes a text in the part its own type is taken in', () => {
    // A supertype's entry, or what an alias stands for, of a type taken without `a`.
    expect(taken('Base', without('a'))).toEqual(['Base without(a)']);
    expect(taken('A | B', without('a'))).toEqual(['A without(a)', 'B without(a)']);
    expect(taken('A & (B | C)', without('a'))).toEqual(['A without(a)', 'B without(a)', 'C without(a)']);
    expect(taken('Omit<Base, "b">', without('a'))).toEqual(['Base without(a,b)']);
    expect(taken('Pick<Base, "a" | "c">', without('a'))).toEqual(['Base only(c)']);
    expect(taken('Partial<Base>', without('a'))).toEqual(['Base optional without(a)']);
    // The part is of the type's own members, not of what those are built from.
    expect(taken('Base[]', without('a'))).toEqual(['Base']);
    expect(taken('Promise<Base>', without('a'))).toEqual(['Promise', 'Base']);
    expect(taken('{ base: Base }', without('a'))).toEqual(['base', 'Base']);
    expect(taken('Omit<Base, Keys>', without('a'))).toEqual(['Omit', 'Base', 'Keys']);
    expect(taken('Pick<Base, Keys>', without('a'))).toEqual([]);
    expect(taken('', without('a'))).toEqual([]);
  });

  it('says which members a part keeps', () => {
    const [{ part: omitted }] = typesTakenIn('Omit<Foo, "a">');
    const [{ part: picked }] = typesTakenIn('Pick<Foo, "a">');
    const [{ part: partial }] = typesTakenIn('Partial<Foo>');
    expect([keepsMember(omitted, 'a'), keepsMember(omitted, 'b')]).toEqual([false, true]);
    expect([keepsMember(picked, 'a'), keepsMember(picked, 'b')]).toEqual([true, false]);
    expect([keepsMember(partial, 'a'), partial.optional, omitted.optional]).toEqual([true, true, false]);
    expect([keepsMember(WHOLE_TYPE, 'a'), WHOLE_TYPE.optional]).toEqual([true, false]);
    // A key is a whole name.
    expect(keepsMember(typesTakenIn('Omit<Foo, "owner">')[0].part, 'ownerId')).toBe(true);
  });

  it('reads a text with none of the wrappers as before: every name, whole', () => {
    for (const text of [
      'Foo',
      'Foo[] | Bar',
      'Record<string, Promise<Foo | null>>',
      '{ body: Foo; done: (error: Failure) => void; }',
      'Optional["Foo"]',
      "Option<&'a Foo>",
      'crate::models::Foo',
      'list[models.Foo] | None',
      'Required<Foo> & Readonly<Bar>',
    ]) {
      const all = typesTakenIn(text);
      expect(
        all.every(({ part }) => part === WHOLE_TYPE),
        text,
      ).toBe(true);
      expect(
        all.map(({ name }) => name),
        text,
      ).toEqual(typeNamesIn(text));
    }
  });
});

describe('#750 genericWrapperOf', () => {
  it.each([
    ['Promise<Foo>', 'Promise'],
    ['Promise<Foo | null>', 'Promise'],
    ['Promise<Foo> | undefined', 'Promise'],
    ['Promise<Foo>[]', 'Promise'],
    ['Sink<Foo>', 'Sink'],
    ['models.Page[Foo]', 'models.Page'],
    ['list[Foo] | None', 'list'],
    ['List<Foo?>?', 'List'],
    ['Option<Vec<Foo>>', 'Vec'],
    ['Iterator[*Foo]', 'Iterator'],
  ])('%s is read through %s', (text, wrapper) => {
    expect(genericWrapperOf(text)).toBe(wrapper);
    expect(bareTypeName(text)).toBe('Foo');
  });

  it.each([
    // The name stands alone, or behind an optional spelling or an array.
    'Foo',
    'Foo[]',
    'Foo | null',
    '?Foo',
    '*Foo',
    'Optional[Foo]',
    'Option<Foo>',
    'T.nilable(Foo)',
    '(Foo | null)[]',
    '\\Acme\\Foo',
  ])('%s has no generic around its name', (text) => {
    expect(genericWrapperOf(text)).toBeUndefined();
    expect(bareTypeName(text)).toBe('Foo');
  });

  it.each(['Record<string, Foo>', 'Promise<Foo[]>', 'Foo | Bar', 'Foo[][]', '{ a: Foo }', '() => Foo', '', 'Promise<'])(
    '%s names no single type, so nothing is read through',
    (text) => {
      expect(genericWrapperOf(text)).toBeUndefined();
    },
  );
});

describe('#750 handsBackItsArgument', () => {
  it.each([
    'Promise',
    'PromiseLike',
    'Awaitable',
    'Array',
    'ReadonlyArray',
    'Set',
    'Iterable',
    'AsyncIterable',
    'list',
    'List',
    'Sequence',
    'frozenset',
  ])('%s holds values of its argument', (generic) => {
    expect(handsBackItsArgument(generic)).toBe(true);
  });

  it('reads the last segment of a qualified name', () => {
    expect(handsBackItsArgument('typing.Sequence')).toBe(true);
    expect(handsBackItsArgument('collections.abc.Iterable')).toBe(true);
    expect(handsBackItsArgument(' Promise ')).toBe(true);
  });

  it.each([
    // generics that take their argument, or may
    'Sink',
    'Observer',
    'Subject',
    'WritableStream',
    'Comparator',
    'Action',
    'Consumer',
    'Dispatch',
    // generics of the SDK's own, and names that only resemble one on the list
    'Page',
    'ListResource',
    'PromiseQueue',
    'MyPromise',
    'promise',
    'Sequence.Builder',
    '',
  ])('%s is not known to', (generic) => {
    expect(handsBackItsArgument(generic)).toBe(false);
  });
});

describe('#750 withoutRepeatedIntersectionMembers', () => {
  it.each([
    ['(() => void) & (() => void)', '() => void'],
    ['{ x: number; } & { x: number; }', '{ x: number; }'],
    ['((() => void) & (() => void)) | undefined', '(() => void) | undefined'],
    ['({ x: number; } & { x: number; }) | undefined', '{ x: number; } | undefined'],
    ['({ x: number; } & { x: number; }) | null | undefined', '{ x: number; } | null | undefined'],
    ['A & A & B', 'A & B'],
    ['(A & A & B) | undefined', '(A & B) | undefined'],
    ['(A | B) & (A | B)', 'A | B'],
    ['Promise<A> & Promise<A>', 'Promise<A>'],
    ['{ a: "x & y"; } & { a: "x & y"; }', '{ a: "x & y"; }'],
  ])('%s is %s', (text, expected) => {
    expect(withoutRepeatedIntersectionMembers(text)).toBe(expected);
  });

  it.each([
    'string',
    'string | undefined',
    '() => void',
    '(() => void) | undefined',
    '(() => void)',
    '{ x: number; } & { y: string; }',
    '({ x: number; } & { y: string; }) | undefined',
    'A & B',
    // an intersection that is not a member of the text's own union is not read
    'Promise<A & A>',
    '{ a: A & A; }',
    '(a: A & A) => void',
    'Array<(() => void) & (() => void)>',
    // a text whose brackets or quotes do not pair up is not taken apart
    '(A & A',
    'A & A)',
    "'A & A",
    '',
  ])('%s is returned as it stands', (text) => {
    expect(withoutRepeatedIntersectionMembers(text)).toBe(text);
  });
});

describe('#750 supertypeName', () => {
  it('reads a name written alone', () => {
    expect(supertypeName('ErrorBody')).toBe('ErrorBody');
    expect(supertypeName('  ErrorBody ')).toBe('ErrorBody');
    expect(supertypeName('\\Acme\\ErrorBody')).toBe('ErrorBody');
    expect(supertypeName('$Base_1')).toBe('$Base_1');
  });

  it('reads no supertype out of an instantiation or anything else', () => {
    for (const entry of [
      'Partial<ErrorBody>',
      "Omit<ErrorBody, 'code'>",
      'List<ErrorBody>',
      'Base<T>',
      'Generic[T]',
      'ns.ErrorBody',
      'crate::ErrorBody',
      'ErrorBody | null',
      'ErrorBody[]',
      '?ErrorBody',
      '',
      ' ',
      '123',
    ]) {
      expect(supertypeName(entry), entry).toBeUndefined();
    }
  });
});

describe('#750 declaredTypes', () => {
  it('indexes each type with its members', () => {
    const types = declaredTypes(
      snapshot(
        type('Pet', { extends: [] }),
        field('Pet', 'id', 'string'),
        symbol('service_accessor', 'PetsClient'),
        symbol('property', 'PetsClient.baseUrl', { ownerFqName: 'PetsClient', typeRef: { name: 'string' } }),
        callable('PetsClient.get', 'string'),
        symbol('enum', 'Status'),
        symbol('enum_member', 'Status.Active', { ownerFqName: 'Status', value: 'active' }),
        type('Id', { aliasOf: 'string' }),
      ),
    );
    expect([...types.keys()].sort()).toEqual(['Id', 'Pet', 'PetsClient', 'Status']);
    expect(types.get('Pet')?.members.map((member) => member.fqName)).toEqual(['Pet.id']);
    expect(types.get('PetsClient')?.members.map((member) => member.fqName)).toEqual(['PetsClient.baseUrl']);
    // A method and an enum member are owned, and are not members a type is built from.
    expect(types.get('Status')).toMatchObject({ members: [], ownsSymbols: true });
    expect(types.get('Id')).toMatchObject({ members: [], ownsSymbols: false });
  });

  it('keeps the members of an owner the snapshot has no symbol for', () => {
    const types = declaredTypes(snapshot(field('Orphan', 'id', 'string')));
    expect(types.get('Orphan')?.symbol).toBeUndefined();
    expect(types.get('Orphan')?.members).toHaveLength(1);
  });

  it('tells an alias with recorded members from one recorded by name', () => {
    const types = declaredTypes(
      snapshot(
        type('Options', { extends: [], aliasOf: '{ name: string; }' }),
        field('Options', 'name', 'string', { optional: false }),
        type('Empty', { extends: [], aliasOf: '{}' }),
        type('Union', { aliasOf: 'A | B' }),
        type('BeforeTheKeys'),
        type('Iface', { extends: [] }),
        type('EmptyIfaceBeforeTheKeys'),
        type('IfaceBeforeTheKeys'),
        field('IfaceBeforeTheKeys', 'id', 'string'),
        symbol('service_accessor', 'Client'),
      ),
    );
    const read = (name: string) => [isObjectAlias(types.get(name)), isRecordedByNameOnly(types.get(name))];
    expect(read('Options')).toEqual([true, false]);
    expect(read('Empty')).toEqual([true, false]);
    expect(read('Union')).toEqual([false, true]);
    expect(read('BeforeTheKeys')).toEqual([false, true]);
    expect(read('Iface')).toEqual([false, false]);
    // An empty interface of an older snapshot cannot be told from a bare alias.
    expect(read('EmptyIfaceBeforeTheKeys')).toEqual([false, true]);
    expect(read('IfaceBeforeTheKeys')).toEqual([false, false]);
    expect(read('Client')).toEqual([false, false]);
    expect(read('Missing')).toEqual([false, false]);
  });
});

describe('#750 declaresSupertype', () => {
  const types = declaredTypes(
    snapshot(
      type('ErrorBody', { extends: [] }),
      type('DetailedErrorBody', { extends: ['ErrorBody'] }),
      type('VeryDetailedErrorBody', { extends: ['Timestamped', 'DetailedErrorBody'] }),
      type('Timestamped', { extends: [] }),
      type('PartialBody', { extends: ['Partial<ErrorBody>'] }),
      type('BoxedBody', { extends: ['Box<ErrorBody>'] }),
      type('Namespaced', { extends: ['\\Acme\\ErrorBody'] }),
      type('Intersected', { extends: ['ErrorBody'], aliasOf: 'ErrorBody & { details?: string; }' }),
      type('ViaUndeclared', { extends: ['NotExported'] }),
      type('Loop1', { extends: ['Loop2'] }),
      type('Loop2', { extends: ['Loop1', 'ErrorBody'] }),
      type('Self', { extends: ['Self'] }),
      type('BeforeTheKeys'),
    ),
  );

  it.each([
    ['DetailedErrorBody', 'ErrorBody', true],
    ['VeryDetailedErrorBody', 'ErrorBody', true],
    ['VeryDetailedErrorBody', 'DetailedErrorBody', true],
    ['VeryDetailedErrorBody', 'Timestamped', true],
    ['Namespaced', 'ErrorBody', true],
    ['Intersected', 'ErrorBody', true],
    ['Loop1', 'ErrorBody', true],
    ['Loop1', 'Loop2', true],
    ['ViaUndeclared', 'NotExported', true],
    // the other way, and unrelated types
    ['ErrorBody', 'DetailedErrorBody', false],
    ['DetailedErrorBody', 'Timestamped', false],
    ['DetailedErrorBody', 'VeryDetailedErrorBody', false],
    // an instantiation declares no supertype
    ['PartialBody', 'ErrorBody', false],
    ['BoxedBody', 'ErrorBody', false],
    ['BoxedBody', 'Box', false],
    // a type is not its own supertype, declared so or not
    ['ErrorBody', 'ErrorBody', false],
    ['Self', 'Self', false],
    ['Loop1', 'Loop1', false],
    // nothing recorded
    ['BeforeTheKeys', 'ErrorBody', false],
    ['Missing', 'ErrorBody', false],
    ['ViaUndeclared', 'ErrorBody', false],
  ])('%s extends %s: %s', (typeName, supertype, expected) => {
    expect(declaresSupertype(types, typeName, supertype)).toBe(expected);
  });

  it('ends on a cycle that never reaches the supertype', () => {
    expect(declaresSupertype(types, 'Loop1', 'Missing')).toBe(false);
    expect(declaresSupertype(types, 'Self', 'ErrorBody')).toBe(false);
  });

  it('reads no supertype from an extends that is not a list of names', () => {
    for (const value of [null, true, 0, 'ErrorBody', {}, [1, null, {}, ['ErrorBody']]]) {
      const malformed = declaredTypes(snapshot(type('Odd', { extends: value as unknown as string[] })));
      expect(declaresSupertype(malformed, 'Odd', 'ErrorBody'), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('#750 inputTypes', () => {
  it('reaches the types a callable takes and the types those are built from', () => {
    const taken = inputTypes(
      snapshot(
        symbol('service_accessor', 'PetsClient'),
        callable('PetsClient.create', 'CreatePetOptions', 'RequestOptions | undefined'),
        callable('PetsClient.get', 'string'),
        symbol('callable', 'PetsClient.list', { ownerFqName: 'PetsClient', returns: { name: 'Promise<Pet[]>' } }),
        type('CreatePetOptions', { extends: ['BaseOptions'] }),
        field('CreatePetOptions', 'owner', 'Owner | null'),
        field('CreatePetOptions', 'tags', 'Record<string, Tag[]>'),
        type('BaseOptions', { extends: [] }),
        field('BaseOptions', 'audit', 'AuditAlias'),
        type('AuditAlias', { aliasOf: 'AuditA | AuditB' }),
        type('AuditA', { extends: [] }),
        type('AuditB', { extends: [] }),
        type('Owner', { extends: [] }),
        type('Tag', { extends: [] }),
        type('RequestOptions', { extends: [] }),
        type('Pet', { extends: [] }),
        field('Pet', 'owner', 'PetOwner'),
        type('PetOwner', { extends: [] }),
      ),
    );
    expect([...taken.keys()].sort()).toEqual([
      'AuditA',
      'AuditAlias',
      'AuditB',
      'BaseOptions',
      'CreatePetOptions',
      'Owner',
      'RequestOptions',
      'Tag',
    ]);
    // What is only returned is not taken, nor is what it is built from.
    expect(taken.has('Pet')).toBe(false);
    expect(taken.has('PetOwner')).toBe(false);
    expect(taken.has('PetsClient')).toBe(false);
  });

  it('credits a type to the first callable that leads to it', () => {
    const taken = inputTypes(
      snapshot(
        callable('PetsClient.first', 'A'),
        callable('PetsClient.second', 'B', 'Shared'),
        type('A', { extends: [] }),
        field('A', 'shared', 'Shared'),
        type('B', { extends: [] }),
        type('Shared', { extends: [] }),
      ),
    );
    expect(Object.fromEntries(taken)).toEqual({
      A: 'PetsClient.first',
      Shared: 'PetsClient.first',
      B: 'PetsClient.second',
    });
  });

  it('takes a constructor as a root, a service class included', () => {
    const taken = inputTypes(
      snapshot(
        symbol('service_accessor', 'PetsClient'),
        symbol('constructor', 'PetsClient.constructor', {
          ownerFqName: 'PetsClient',
          parameters: callable('x', 'ClientOptions').parameters,
        }),
        type('ClientOptions', { extends: [] }),
      ),
    );
    expect(Object.fromEntries(taken)).toEqual({ ClientOptions: 'PetsClient.constructor' });
  });

  it('goes through a class to the types of its properties, not of its methods', () => {
    const taken = inputTypes(
      snapshot(
        callable('PetsClient.send', 'Envelope'),
        symbol('service_accessor', 'Envelope'),
        symbol('property', 'Envelope.body', { ownerFqName: 'Envelope', typeRef: { name: 'Body' } }),
        symbol('callable', 'Envelope.parse', { ownerFqName: 'Envelope', returns: { name: 'Parsed' } }),
        type('Body', { extends: [] }),
        type('Parsed', { extends: [] }),
      ),
    );
    expect([...taken.keys()].sort()).toEqual(['Body', 'Envelope']);
  });

  it('ends on types that refer to themselves and to each other', () => {
    const taken = inputTypes(
      snapshot(
        callable('TreeClient.put', 'Node'),
        type('Node', { extends: ['Node'] }),
        field('Node', 'children', 'Node[]'),
        field('Node', 'a', 'A'),
        type('A', { extends: ['B'], aliasOf: 'B & { a: A; }' }),
        field('A', 'b', 'B'),
        type('B', { extends: ['A'] }),
        field('B', 'a', 'A'),
      ),
    );
    expect([...taken.keys()].sort()).toEqual(['A', 'B', 'Node']);
  });

  it('reaches a type a Partial, a Pick or an Omit takes a part of, and says which members', () => {
    const taken = inputTypes(
      snapshot(
        callable('PetsClient.update', 'Partial<Pet>', "Pick<Owner, 'email'>", "Omit<Tag, 'id'>"),
        type('Pet', { extends: [] }),
        type('Owner', { extends: [] }),
        type('Tag', { extends: [] }),
      ),
    );
    expect([...taken.keys()]).toEqual(['Pet', 'Owner', 'Tag']);
    const supplied = (owner: string, name: string) => [
      taken.member(field(owner, name, 'string')) ?? null,
      taken.requiredMember(field(owner, name, 'string')) ?? null,
    ];
    // A `Partial` takes every member and requires none.
    expect(supplied('Pet', 'name')).toEqual(['PetsClient.update', null]);
    // A `Pick` takes the members it lists, an `Omit` the ones it does not.
    expect(supplied('Owner', 'email')).toEqual(['PetsClient.update', 'PetsClient.update']);
    expect(supplied('Owner', 'ownerId')).toEqual([null, null]);
    expect(supplied('Tag', 'id')).toEqual([null, null]);
    expect(supplied('Tag', 'label')).toEqual(['PetsClient.update', 'PetsClient.update']);
  });

  it('counts a member as supplied when one way to the type keeps it', () => {
    const owner = [type('Owner', { extends: [] })];
    const required = (...callables: CompatSymbol[]) =>
      inputTypes(snapshot(...callables, ...owner)).requiredMember(field('Owner', 'ownerId', 'string'));
    const omitted = 'Omit<Owner, "ownerId">';
    expect(required(callable('C.create', omitted))).toBeUndefined();
    // the same type, whole: in the same callable, a later one, an earlier one
    expect(required(callable('C.create', omitted, 'Owner'))).toBe('C.create');
    expect(required(callable('C.create', omitted), callable('C.put', 'Owner'))).toBe('C.put');
    expect(required(callable('C.put', 'Owner'), callable('C.create', omitted))).toBe('C.put');
    expect(required(callable('C.create', `${omitted} | Owner`))).toBe('C.create');
    // another part that keeps the field
    expect(required(callable('C.create', omitted, 'Omit<Owner, "a">'))).toBe('C.create');
    expect(required(callable('C.create', omitted, 'Pick<Owner, "ownerId">'))).toBe('C.create');
    // parts that do not: a second Omit of it, a Pick of something else, a Partial
    expect(required(callable('C.create', omitted, 'Omit<Owner, "ownerId" | "a">'))).toBeUndefined();
    expect(required(callable('C.create', omitted, 'Pick<Owner, "name">'))).toBeUndefined();
    expect(required(callable('C.create', omitted, 'Partial<Owner>'))).toBeUndefined();
    // ... which is still one callers may supply
    expect(
      inputTypes(snapshot(callable('C.create', omitted, 'Partial<Owner>'), ...owner)).member(
        field('Owner', 'ownerId', 'string'),
      ),
    ).toBe('C.create');
  });

  it('goes on through the members a part keeps, and no others', () => {
    const through = (parameter: string) =>
      [
        ...inputTypes(
          snapshot(
            callable('C.create', parameter),
            type('Owner', { extends: [] }),
            field('Owner', 'name', 'string'),
            field('Owner', 'address', 'Address'),
            field('Owner', 'pets', 'Pet[]'),
            type('Address', { extends: [] }),
            field('Address', 'country', 'Country'),
            type('Country', { extends: [] }),
            type('Pet', { extends: [] }),
          ),
        ).keys(),
      ].sort();
    expect(through('Owner')).toEqual(['Address', 'Country', 'Owner', 'Pet']);
    expect(through('Omit<Owner, "ownerId">')).toEqual(['Address', 'Country', 'Owner', 'Pet']);
    expect(through('Omit<Owner, "address">')).toEqual(['Owner', 'Pet']);
    expect(through('Omit<Owner, "address" | "pets">')).toEqual(['Owner']);
    expect(through('Pick<Owner, "address">')).toEqual(['Address', 'Country', 'Owner']);
    expect(through('Pick<Owner, "name">')).toEqual(['Owner']);
    // A member a caller may leave out is still one whose type they build when they do not.
    expect(through('Partial<Owner>')).toEqual(['Address', 'Country', 'Owner', 'Pet']);
    // A member's own type is taken whole, whatever part its owner is taken in.
    expect(through('Pick<Owner, "address"> | Omit<Owner, "address">')).toEqual(['Address', 'Country', 'Owner', 'Pet']);
  });

  it('takes a supertype, and what an alias stands for, in the part the type is taken in', () => {
    const taken = inputTypes(
      snapshot(
        callable('C.create', 'Omit<Child, "ownerId">'),
        callable('C.update', 'Pick<Named, "name">'),
        callable('C.link', 'Omit<Input, "ownerId">'),
        type('Child', { extends: ['Base'] }),
        type('Base', { extends: [] }),
        // an interface that extends an Omit, and an alias written with one
        type('Named', { extends: ['Omit<Owner, "ownerId">'] }),
        type('Owner', { extends: [] }),
        type('Input', { aliasOf: 'Linked' }),
        type('Linked', { extends: ['Omit<Target, "id">'], aliasOf: 'Omit<Target, "id"> & { note?: string; }' }),
        type('Target', { extends: [] }),
      ),
    );
    const required = (owner: string, name: string) => taken.requiredMember(field(owner, name, 'string')) ?? null;
    // `Omit<Child, 'ownerId'>` leaves out the `ownerId` Child inherits as well.
    expect([required('Child', 'ownerId'), required('Base', 'ownerId')]).toEqual([null, null]);
    expect([required('Child', 'name'), required('Base', 'name')]).toEqual(['C.create', 'C.create']);
    // `Pick<Named, 'name'>`, where Named extends `Omit<Owner, 'ownerId'>`.
    expect([required('Owner', 'name'), required('Owner', 'ownerId'), required('Owner', 'age')]).toEqual([
      'C.update',
      null,
      null,
    ]);
    // Through an alias of a name, to a type whose `extends` and `aliasOf` both name the Omit.
    expect([required('Linked', 'ownerId'), required('Linked', 'note')]).toEqual([null, 'C.link']);
    expect([required('Target', 'id'), required('Target', 'ownerId'), required('Target', 'label')]).toEqual([
      null,
      null,
      'C.link',
    ]);
  });

  it('reads a member by its own name, in quotes or not, from any snapshot of the SDK', () => {
    const taken = inputTypes(
      snapshot(callable('C.create', 'Omit<Owner, "owner-id" | "ownerId">'), type('Owner', { extends: [] })),
    );
    // None of these symbols is in the snapshot: the fields are the ones a candidate added.
    expect(taken.requiredMember(field('Owner', 'owner-id', 'string'))).toBeUndefined();
    expect(taken.requiredMember(field('Owner', '"owner-id"', 'string'))).toBeUndefined();
    expect(taken.requiredMember(field('Owner', "'owner-id'", 'string'))).toBeUndefined();
    expect(taken.requiredMember(field('Owner', 'ownerId', 'string'))).toBeUndefined();
    // A key is a whole name, and a name is the member's own, not its owner's.
    expect(taken.requiredMember(field('Owner', 'owner', 'string'))).toBe('C.create');
    expect(taken.requiredMember(field('Owner', 'ownerIdentity', 'string'))).toBe('C.create');
    expect(taken.requiredMember(field('Other', 'name', 'string'))).toBeUndefined();
    // A symbol that names no owner, or is not what a snapshot holds, is supplied by no one.
    expect(taken.member(symbol('field', 'Owner.name'))).toBeUndefined();
    for (const odd of [null, 1, {}, []]) {
      const member = { ...field('Owner', 'name', 'string'), fqName: odd as never };
      expect(() => taken.member(member), JSON.stringify(odd)).not.toThrow();
      expect(() => taken.requiredMember({ ...member, ownerFqName: odd as never }), JSON.stringify(odd)).not.toThrow();
    }
  });

  it('ends on types that reach each other in parts', () => {
    const taken = inputTypes(
      snapshot(
        callable('C.put', 'Omit<A, "a">'),
        type('A', { extends: ['Omit<B, "b">'], aliasOf: 'Pick<A, "x" | "y"> & Partial<B>' }),
        field('A', 'self', 'Omit<A, "self">'),
        field('A', 'other', 'Pick<B, "x">[]'),
        type('B', { extends: ['Omit<A, "c">', 'Partial<B>'] }),
        field('B', 'x', 'Partial<A> | Omit<B, "x">'),
      ),
    );
    expect([...taken.keys()].sort()).toEqual(['A', 'B']);
    expect(taken.member(field('A', 'a', 'string'))).toBe('C.put');
  });

  it('reaches nothing in a snapshot written before the keys existed, beyond what its fields say', () => {
    const taken = inputTypes(
      snapshot(
        callable('PetsClient.create', 'CreatePetOptions', 'UpdatePetOptions'),
        type('CreatePetOptions'),
        type('UpdatePetOptions'),
        field('UpdatePetOptions', 'owner', 'Owner'),
        type('Owner'),
        type('Unrelated'),
      ),
    );
    expect([...taken.keys()].sort()).toEqual(['CreatePetOptions', 'Owner', 'UpdatePetOptions']);
  });

  it('reads past a parameter, a member or a key that is not what a snapshot holds', () => {
    const odd = [null, true, 0, 'Owner', [], ['Owner'], {}, { name: 1 }, { name: null }, { type: { name: 'Owner' } }];
    for (const value of odd) {
      const label = JSON.stringify(value);
      const build = () =>
        inputTypes(
          snapshot(
            symbol('callable', 'C.a', { parameters: value as never }),
            symbol('callable', 'C.b', { parameters: [value as never, { type: value } as never] }),
            callable('C.c', 'Options'),
            type('Options', { extends: value as never, aliasOf: value as never }),
            symbol('field', 'Options.x', { ownerFqName: 'Options', typeRef: value as never }),
            type('Owner', { extends: [] }),
          ),
        );
      expect(build, label).not.toThrow();
      expect(build().has('Options'), label).toBe(true);
    }
  });
});
