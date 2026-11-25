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
  supertypeName,
  typeNamesIn,
} from '../../src/compat/type-names.js';

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
    expect(names("Omit<Foo, 'id' | 'name'>")).toEqual(['Foo', 'Omit']);
    expect(names('Omit<Foo, "id">')).toEqual(['Foo', 'Omit']);
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

  it('does not read the arguments of Partial and Pick', () => {
    expect(names('Partial<Foo>')).toEqual([]);
    expect(names("Pick<Foo, 'id'>")).toEqual([]);
    expect(names('Partial<Foo> | Bar')).toEqual(['Bar']);
    expect(names('Partial<Record<string, Foo>> & Bar')).toEqual(['Bar']);
    expect(names('Partial <Foo>')).toEqual([]);
    expect(names('Promise<Partial<Foo>>')).toEqual(['Promise']);
    expect(names('Partial<(a: Foo) => Bar> | Baz')).toEqual(['Baz']);
    // The other utility types keep the required members of their argument.
    expect(names("Omit<Foo, 'id'>")).toEqual(['Foo', 'Omit']);
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

  it('does not go through Partial or Pick', () => {
    const taken = inputTypes(
      snapshot(
        callable('PetsClient.update', 'Partial<Pet>', "Pick<Owner, 'email'>", "Omit<Tag, 'id'>"),
        type('Pet', { extends: [] }),
        type('Owner', { extends: [] }),
        type('Tag', { extends: [] }),
      ),
    );
    expect([...taken.keys()]).toEqual(['Tag']);
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
