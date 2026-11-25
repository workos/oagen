import { describe, it, expect } from 'vitest';
import type { CompatSnapshot, CompatSymbol } from '../../src/compat/ir.js';
import { acceptsEveryValue } from '../../src/compat/parameter-types.js';
import type { ParameterTypeAcceptance } from '../../src/compat/parameter-types.js';
import { declaredTypes } from '../../src/compat/type-graph.js';

/**
 * #752: `acceptsEveryValue` answers whether a parameter's new type takes
 * every value of its old one, from the two type texts and what each snapshot
 * records about the types they name. These are the rules on hand-built
 * snapshots; test/compat/assignable-parameter-retype.test.ts runs them on
 * SDKs, through the extractors.
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

/**
 * An object type with its fields, as a snapshot records an interface: each
 * field is `name: 'type'`, or `name: '?type'` when a caller may leave it out.
 */
const objectType = (
  name: string,
  fields: Record<string, string>,
  extra: Partial<CompatSymbol> = {},
): CompatSymbol[] => [
  symbol('alias', name, { extends: [], hasUnlistedMembers: false, ...extra }),
  ...Object.entries(fields).map(([fieldName, text]) =>
    symbol('field', `${name}.${fieldName}`, {
      ownerFqName: name,
      typeRef: { name: text.startsWith('?') ? text.slice(1) : text },
      optional: text.startsWith('?'),
    }),
  ),
];
/** A type alias recorded by the text it stands for. */
const alias = (name: string, aliasOf: string): CompatSymbol => symbol('alias', name, { aliasOf });

const types = (...symbols: Array<CompatSymbol | CompatSymbol[]>) =>
  declaredTypes({
    schemaVersion: '1',
    source: { extractedAt: '2026-01-01T00:00:00.000Z' },
    policies: {} as CompatSnapshot['policies'],
    symbols: symbols.flat(),
  });
const NOTHING = types();

/** By shape, both snapshots declaring the same types unless told otherwise. */
const byShape = (
  oldText: string,
  newText: string,
  candidate = NOTHING,
  baseline = candidate,
): ParameterTypeAcceptance | undefined =>
  acceptsEveryValue(oldText, newText, { structural: true, baselineTypes: baseline, candidateTypes: candidate });
const byDeclaration = (oldText: string, newText: string, candidate = NOTHING, baseline = candidate) =>
  acceptsEveryValue(oldText, newText, { structural: false, baselineTypes: baseline, candidateTypes: candidate });

const ACCEPTED = true;
const REFUSED = false;

describe('#752 acceptsEveryValue: which rule is asked', () => {
  const candidate = types(
    objectType('BaseOptions', { timeout: '?number' }),
    objectType('RetryOptions', { timeout: '?number' }, { extends: ['BaseOptions'] }),
  );

  it('asks the shape of the types where the policy says parameter types are structural', () => {
    expect(byShape('string', 'string | number')).toEqual({ rule: 'shape', fields: [] });
    expect(byShape('RetryOptions', 'BaseOptions', candidate)).toEqual({
      rule: 'shape',
      fields: [{ oldType: 'RetryOptions', newType: 'BaseOptions' }],
    });
  });

  it('asks the declaration where it says they are not', () => {
    expect(byDeclaration('RetryOptions', 'BaseOptions', candidate)).toEqual({
      rule: 'declared-supertype',
      oldType: 'RetryOptions',
      newType: 'BaseOptions',
    });
    // A union that kept every member is the shape rule's: not asked here.
    expect(byDeclaration('string', 'string | number')).toBeUndefined();
  });

  it.each([[undefined], [null], ['true'], ['false'], [1], [0], [[]], [{}]])(
    'asks neither when the policy states %j for the hint',
    (structural) => {
      const context = { structural, baselineTypes: candidate, candidateTypes: candidate };
      expect(acceptsEveryValue('string', 'string | number', context)).toBeUndefined();
      expect(acceptsEveryValue('RetryOptions', 'BaseOptions', context)).toBeUndefined();
    },
  );

  it.each([[undefined], [null], [true], [1], [['string']], [{ name: 'string' }]])(
    'answers no for a type text that is %j',
    (text) => {
      const context = { structural: true, baselineTypes: NOTHING, candidateTypes: NOTHING };
      expect(acceptsEveryValue(text, 'string', context)).toBeUndefined();
      expect(acceptsEveryValue('string', text, context)).toBeUndefined();
      expect(acceptsEveryValue(text, text, context)).toBeUndefined();
    },
  );
});

describe('#752 by shape: a union that kept every member', () => {
  it.each<[string, string, boolean]>([
    ['string', 'string | number', ACCEPTED],
    ['string | number', 'string', REFUSED],
    ['string', 'string | null', ACCEPTED],
    ['string', 'string | undefined', ACCEPTED],
    ['string | null', 'string', REFUSED],
    ['string | undefined', 'string', REFUSED],
    // `null` and `undefined` are members like any other
    ['string | null', 'string | undefined', REFUSED],
    ['string | null', 'string | null | undefined', ACCEPTED],
    ['string | number', 'number | string', ACCEPTED],
    ['string | number', 'string | boolean', REFUSED],
    ['string|number', 'string | number | boolean', ACCEPTED],
    ['(string | number)', 'string | number | boolean', ACCEPTED],
    ['"asc" | "desc"', '"asc" | "desc" | "none"', ACCEPTED],
    ['"asc" | "desc"', '"asc"', REFUSED],
    ['string', 'number', REFUSED],
    // an array of a type that accepts the old array's
    ['string[]', '(string | number)[]', ACCEPTED],
    ['(string | number)[]', 'string[]', REFUSED],
    ['string[][]', '(string | number)[][]', ACCEPTED],
    ['string[]', 'string[] | undefined', ACCEPTED],
    ['string', 'string[]', REFUSED],
    ['string[]', 'string', REFUSED],
    ['string[]', 'string[][]', REFUSED],
    // a function among the members, in its parentheses or out of them
    ['() => void', '(() => void) | undefined', ACCEPTED],
    ['(() => void) | undefined', '() => void', REFUSED],
    // a readonly array takes a writable one, not the other way around
    ['readonly string[]', 'readonly (string | number)[]', ACCEPTED],
    ['string[]', 'readonly string[]', ACCEPTED],
    ['string[]', 'readonly (string | number)[]', ACCEPTED],
    ['readonly string[]', 'string[]', REFUSED],
    ['readonly string[]', '(string | number)[]', REFUSED],
    ['readonly string[][]', 'readonly (string | number)[][]', ACCEPTED],
    ['(readonly string[])[]', '(readonly (string | number)[])[]', ACCEPTED],
    // a generic known to hand its argument back, of a type that accepts the old one's
    ['Promise<string>', 'Promise<string | number>', ACCEPTED],
    ['Promise<string | number>', 'Promise<string>', REFUSED],
    ['PromiseLike<string>', 'PromiseLike<string | null>', ACCEPTED],
    ['Array<string>', 'Array<string | number>', ACCEPTED],
    ['Set<string>', 'Set<string | number>', ACCEPTED],
    ['ReadonlySet<string>', 'ReadonlySet<string | number>', ACCEPTED],
    ['Iterable<string>', 'Iterable<string | number>', ACCEPTED],
    ['Promise<string[]>', 'Promise<(string | number)[]>', ACCEPTED],
    ['Promise<Set<string>>', 'Promise<Set<string | number>>', ACCEPTED],
    ['Promise<string> | undefined', 'Promise<string | number> | null | undefined', ACCEPTED],
    ['Sequence[str]', 'Sequence[str | int]', ACCEPTED],
    ['typing.Sequence[str]', 'typing.Sequence[str | int]', ACCEPTED],
    // ... of the same name on both sides
    ['Promise<string>', 'PromiseLike<string | number>', REFUSED],
    ['Set<string>', 'ReadonlySet<string | number>', REFUSED],
    ['string[]', 'Array<string | number>', REFUSED],
    ['Promise<string>', 'Promise<string>[]', REFUSED],
    // any other generic may take its argument as well as hand it back
    ['Sink<string>', 'Sink<string | number>', REFUSED],
    ['Box<string>', 'Box<string | number>', REFUSED],
    ['Partial<string>', 'Partial<string | number>', REFUSED],
    ['Map<string, string>', 'Map<string, string | number>', REFUSED],
    ['Record<string, string>', 'Record<string, string | number>', REFUSED],
    ['Promise<>', 'Promise<string>', REFUSED],
    // nothing else is read into: each of these is the same text or it is not
    ['[string]', '[string | number]', REFUSED],
    ['readonly [string]', 'readonly [string | number]', REFUSED],
    ['() => string', '() => string | number', REFUSED],
    ['(value: string | number) => void', '(value: string) => void', REFUSED],
    ['"asc"', 'string', REFUSED],
    ['1', 'number', REFUSED],
    ['string', 'unknown', REFUSED],
    ['string', 'any', REFUSED],
    ['Promise<string>', 'Promise<string> | null', ACCEPTED],
    // a text that does not read as a union
    ['string', 'string |', REFUSED],
    ['| string', 'string', REFUSED],
    ['(string', '(string | number', REFUSED],
    ['', 'string', REFUSED],
  ])('%j → %j: %s', (oldText, newText, accepted) => {
    expect(byShape(oldText, newText) !== undefined).toBe(accepted);
  });

  it('does not take a text the extractor cut short for the type, the same text included', () => {
    // What was left out of the old union may be missing from the new one.
    const cut = '"a" | "b" | ... 12 more ... | "z"';
    expect(byShape(cut, cut)).toBeUndefined();
    expect(byShape(cut, `${cut} | "zz"`)).toBeUndefined();
    expect(byShape(`${cut} | null`, `${cut} | null | undefined`)).toBeUndefined();
    expect(byShape(cut, 'string')).toBeUndefined();
    const object = '{ a: string; ... 4 more ...; z: string; }';
    expect(byShape(object, `${object} | undefined`)).toBeUndefined();
    expect(byShape(`Promise<${object}>`, `Promise<${object}> | null`)).toBeUndefined();
    // A member the new union does show is one it has, whatever else it holds.
    expect(byShape('"a"', cut)).toEqual({ rule: 'shape', fields: [] });
    expect(byShape('"a" | "z"', cut)).toEqual({ rule: 'shape', fields: [] });
    expect(byShape('"c"', cut)).toBeUndefined();
    // Three dots that cut nothing short are text like any other.
    expect(byShape('[...string[]]', '[...string[]] | undefined')).toEqual({ rule: 'shape', fields: [] });
  });
});

describe('#752 by shape: a generic that hands its argument back', () => {
  const OPTIONS = [
    objectType('OldOptions', { timeout: '?number' }),
    objectType('NewOptions', { timeout: '?number', maxRetries: '?number' }),
  ];

  it('is read through as an array is, with the rule the argument is under', () => {
    const declared = types(...OPTIONS);
    for (const holder of ['Promise', 'PromiseLike', 'Set', 'ReadonlySet', 'Iterable', 'AsyncIterable', 'Array']) {
      expect([holder, byShape(`${holder}<OldOptions>`, `${holder}<NewOptions>`, declared)]).toEqual([
        holder,
        { rule: 'shape', fields: [{ oldType: 'OldOptions', newType: 'NewOptions' }] },
      ]);
      // A member dropped is a member dropped, whatever holds the value.
      expect(byShape(`${holder}<NewOptions>`, `${holder}<OldOptions>`, declared)).toBeUndefined();
    }
  });

  it('is not read through when a snapshot declares a type of its name', () => {
    // The SDK's own `Sequence<T>` is as unknown as its `Sink<T>`.
    for (const declaration of [
      symbol('alias', 'Sequence', { extends: [], hasUnlistedMembers: false }),
      symbol('service_accessor', 'Sequence'),
      symbol('alias', 'Sequence'),
    ]) {
      const declared = types(...OPTIONS, declaration);
      const without = types(...OPTIONS);
      expect(byShape('Sequence<OldOptions>', 'Sequence<NewOptions>', without)).toBeDefined();
      expect(byShape('Sequence<OldOptions>', 'Sequence<NewOptions>', declared)).toBeUndefined();
      // Declared by either snapshot.
      expect(byShape('Sequence<OldOptions>', 'Sequence<NewOptions>', without, declared)).toBeUndefined();
      expect(byShape('Sequence<OldOptions>', 'Sequence<NewOptions>', declared, without)).toBeUndefined();
    }
  });

  it('is not read through where a value is accepted by its declared type', () => {
    // A `list[RetryOptions]` is no `list[BaseOptions]`: a list is written to.
    const declared = types(objectType('BaseOptions', {}), objectType('RetryOptions', {}, { extends: ['BaseOptions'] }));
    expect(byDeclaration('RetryOptions', 'BaseOptions', declared)).toBeDefined();
    for (const holder of ['list', 'List', 'Sequence', 'Promise', 'Set', 'Iterable']) {
      expect(byDeclaration(`${holder}[RetryOptions]`, `${holder}[BaseOptions]`, declared)).toBeUndefined();
      expect(byDeclaration(`${holder}<RetryOptions>`, `${holder}<BaseOptions>`, declared)).toBeUndefined();
    }
  });
});

describe('#752 by shape: a type alias recorded by its text', () => {
  const declared = types(
    alias('PetId', 'string'),
    alias('AnyId', 'string | number'),
    alias('Ids', 'string[]'),
    alias('Callback', '() => void'),
    alias('Options', 'RequestOptions'),
    alias('AnyOptions', 'RequestOptions | string'),
    objectType('RequestOptions', { timeout: '?number' }),
    objectType('RetryRequestOptions', { timeout: '?number', maxRetries: '?number' }),
    // an alias of an alias, and aliases that stand for themselves
    alias('Id', 'PetId'),
    alias('Loop', 'Loop'),
    alias('LoopOrString', 'LoopOrString | string'),
    alias('Ping', 'Pong'),
    alias('Pong', 'Ping'),
    alias('Broken', 'string |'),
  );

  it.each<[string, string, boolean]>([
    ['PetId', 'string | number', ACCEPTED],
    ['string', 'AnyId', ACCEPTED],
    ['PetId', 'AnyId', ACCEPTED],
    ['AnyId', 'PetId', REFUSED],
    ['AnyId', 'string', REFUSED],
    ['AnyId', 'string | number', ACCEPTED],
    ['Id', 'string', ACCEPTED],
    ['Id', 'AnyId', ACCEPTED],
    ['PetId | undefined', 'AnyId | undefined', ACCEPTED],
    ['PetId[]', 'AnyId[]', ACCEPTED],
    ['Ids', '(string | number)[]', ACCEPTED],
    ['Ids', 'AnyId[]', ACCEPTED],
    ['Callback', '(() => void) | undefined', ACCEPTED],
    // an alias of a declared type, and of a union with one
    ['Options', 'RequestOptions', ACCEPTED],
    ['Options', 'RetryRequestOptions', ACCEPTED],
    ['AnyOptions', 'RetryRequestOptions | string', ACCEPTED],
    ['AnyOptions', 'RetryRequestOptions', REFUSED],
    ['RequestOptions | string', 'AnyOptions', ACCEPTED],
    // behind a promise as anywhere else, and not behind a generic of the SDK's own
    ['Promise<PetId>', 'Promise<AnyId>', ACCEPTED],
    ['Promise<AnyId>', 'Promise<PetId>', REFUSED],
    ['Box<PetId>', 'Box<AnyId>', REFUSED],
    // an alias that stands for itself has nothing behind it
    ['Loop', 'string', REFUSED],
    ['string', 'Loop', REFUSED],
    ['Loop', 'Loop | string', REFUSED],
    ['Ping', 'string', REFUSED],
    ['Ping', 'Pong', REFUSED],
    // ... but for what else it stands for
    ['LoopOrString', 'string', ACCEPTED],
    ['LoopOrString', 'number', REFUSED],
    ['string', 'LoopOrString', ACCEPTED],
    ['Broken', 'string', REFUSED],
    ['string', 'Broken', REFUSED],
  ])('%j → %j: %s', (oldText, newText, accepted) => {
    expect(byShape(oldText, newText, declared) !== undefined).toBe(accepted);
  });

  it('reads an alias of an object shape by its fields, not by its text', () => {
    const objectAlias = types(
      objectType('OldOptions', { timeout: '?number' }, { aliasOf: '{ timeout?: number | undefined; }' }),
      objectType(
        'NewOptions',
        { timeout: '?number', maxRetries: '?number' },
        { aliasOf: '{ timeout?: number | undefined; maxRetries?: number | undefined; }' },
      ),
    );
    expect(byShape('OldOptions', 'NewOptions', objectAlias)).toEqual({
      rule: 'shape',
      fields: [{ oldType: 'OldOptions', newType: 'NewOptions' }],
    });
    expect(byShape('NewOptions', 'OldOptions', objectAlias)).toBeUndefined();
  });

  it('does not read an alias a snapshot written before `aliasOf` records by name alone', () => {
    const byNameOnly = types(symbol('alias', 'PetId'));
    expect(byShape('PetId', 'string', byNameOnly)).toBeUndefined();
    expect(byShape('string', 'PetId', byNameOnly)).toBeUndefined();
  });

  it('reads each alias once, however many lead to it', () => {
    // 40 levels, each a union of the two aliases below: 2^40 ways down.
    const levels = 40;
    const ladder = (prefix: string) =>
      Array.from({ length: levels }, (_, level) => [
        alias(
          `${prefix}A${level}`,
          level === levels - 1 ? 'string' : `${prefix}A${level + 1} | ${prefix}B${level + 1}`,
        ),
        alias(
          `${prefix}B${level}`,
          level === levels - 1 ? 'number' : `${prefix}A${level + 1} | ${prefix}B${level + 1}`,
        ),
      ]).flat();
    const declaredLadders = types(...ladder('Old'), ...ladder('New'));
    const started = Date.now();
    expect(byShape('OldA0', 'NewA0', declaredLadders)).toEqual({ rule: 'shape', fields: [] });
    expect(byShape('OldA0', 'string', declaredLadders)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("#752 by shape: an object type that keeps the old one's fields", () => {
  const pair = (oldFields: Record<string, string>, newFields: Record<string, string>) =>
    byShape(
      'OldOptions',
      'NewOptions',
      types(objectType('OldOptions', oldFields), objectType('NewOptions', newFields)),
    );

  it.each<[string, Record<string, string>, Record<string, string>, boolean]>([
    ['the same fields', { timeout: '?number' }, { timeout: '?number' }, ACCEPTED],
    ['an optional field added', { timeout: '?number' }, { timeout: '?number', maxRetries: '?number' }, ACCEPTED],
    ['a required field added', { timeout: '?number' }, { timeout: '?number', retryKey: 'string' }, REFUSED],
    ['a field made optional', { name: 'string' }, { name: '?string' }, ACCEPTED],
    ['a field made required', { name: '?string' }, { name: 'string' }, REFUSED],
    ['a required field kept required', { name: 'string' }, { name: 'string', tag: '?string' }, ACCEPTED],
    ['a field retyped', { timeout: '?number' }, { timeout: '?string' }, REFUSED],
    ['a field widened', { timeout: '?number' }, { timeout: '?number | string' }, ACCEPTED],
    ['a field narrowed', { timeout: '?number | string' }, { timeout: '?number' }, REFUSED],
    ['a field whose union is reordered', { order: '"asc" | "desc"' }, { order: '"desc" | "asc"' }, ACCEPTED],
    ['an optional field dropped', { timeout: '?number', maxRetries: '?number' }, { timeout: '?number' }, REFUSED],
    ['a required field dropped', { name: 'string', timeout: '?number' }, { timeout: '?number' }, REFUSED],
    ['a field renamed', { timeout: '?number' }, { timeoutMs: '?number' }, REFUSED],
    ['a field renamed in case only', { timeout: '?number' }, { Timeout: '?number' }, REFUSED],
    // An interface's optional field is recorded with or without the
    // `undefined` its `?` adds, so between two optional fields it is left out.
    ['an optional field gains `| undefined`', { timeout: '?number' }, { timeout: '?number | undefined' }, ACCEPTED],
    ['an optional field loses `| undefined`', { timeout: '?number | undefined' }, { timeout: '?number' }, ACCEPTED],
    ['a field that is only ever undefined', { never: '?undefined' }, { never: '?undefined' }, ACCEPTED],
    ['a field that is only ever undefined, retyped', { never: '?undefined' }, { never: '?string' }, REFUSED],
    // A required field that may be `undefined` still has to be written.
    ['required `T | undefined` made optional `T`', { name: 'string | undefined' }, { name: '?string' }, REFUSED],
    ['optional `T` made required `T | undefined`', { name: '?string' }, { name: 'string | undefined' }, REFUSED],
    ['a required field gains `| undefined`', { name: 'string' }, { name: 'string | undefined' }, ACCEPTED],
    ['a required field loses `| undefined`', { name: 'string | undefined' }, { name: 'string' }, REFUSED],
    // A type without fields takes any object: nothing says what callers pass.
    ['an old type without fields', {}, { timeout: '?number' }, REFUSED],
    ['a new type without fields', { timeout: '?number' }, {}, REFUSED],
    // ... and a type without fields takes whatever the other one took.
    ['two types without fields', {}, {}, ACCEPTED],
    ['a field name with a dot in it', { 'a.b': '?number' }, { 'a.b': '?number', c: '?number' }, ACCEPTED],
  ])('%s: %s', (_, oldFields, newFields, accepted) => {
    expect(pair(oldFields, newFields) !== undefined).toBe(accepted);
  });

  it('weighs the `undefined` of an optional field as written between two type aliases, and leaves it out beside an interface', () => {
    // Under `exactOptionalPropertyTypes` a type alias's member is recorded
    // with the `undefined` the SDK wrote: `name?: string | undefined` takes a
    // value `name?: string` does not. An interface's field is recorded by
    // where its `?` stands, so its `undefined` says nothing (#750).
    const WITH = { name: '?string | undefined' };
    const WITHOUT = { name: '?string' };
    const declare = (kind: 'interface' | 'alias', name: string, fields: Record<string, string>) =>
      objectType(name, fields, kind === 'alias' ? { aliasOf: '{ … }' } : {});
    const accepted = (
      oldKind: 'interface' | 'alias',
      newKind: 'interface' | 'alias',
      oldFields = WITH,
      newFields = WITHOUT,
    ) =>
      byShape(
        'OldOptions',
        'NewOptions',
        types(declare(oldKind, 'OldOptions', oldFields), declare(newKind, 'NewOptions', newFields)),
      ) !== undefined;

    expect(accepted('alias', 'alias')).toBe(false);
    expect(accepted('alias', 'alias', WITHOUT, WITH)).toBe(true);
    expect(accepted('alias', 'alias', WITH, WITH)).toBe(true);
    for (const [oldKind, newKind] of [
      ['interface', 'interface'],
      ['interface', 'alias'],
      ['alias', 'interface'],
    ] as const) {
      expect([oldKind, newKind, accepted(oldKind, newKind)]).toEqual([oldKind, newKind, true]);
      expect(accepted(oldKind, newKind, WITHOUT, WITH)).toBe(true);
      // Only the `undefined` of two optional fields: a required one's is a value.
      expect(accepted(oldKind, newKind, { name: 'string | undefined' }, { name: 'string' })).toBe(false);
      expect(accepted(oldKind, newKind, { name: 'string | undefined' }, WITHOUT)).toBe(false);
      // ... and nothing else of the type.
      expect(accepted(oldKind, newKind, { name: '?string | null' }, WITHOUT)).toBe(false);
      expect(accepted(oldKind, newKind, { name: '?string | number | undefined' }, WITHOUT)).toBe(false);
    }
  });

  it('asks the same question of each field, through unions, arrays, aliases and nested types', () => {
    const declared = types(
      objectType('Retry', { max: '?number' }),
      objectType('Retry2', { max: '?number', delay: '?number' }),
      objectType('Retry3', { max: '?number', delay: 'number' }),
      alias('Order', '"asc" | "desc"'),
      alias('WiderOrder', '"asc" | "desc" | "none"'),
      objectType('OldOptions', { retry: '?Retry', retries: 'Retry[]', order: '?Order', either: 'Retry | string' }),
      objectType('NewOptions', {
        retry: '?Retry2',
        retries: 'Retry2[]',
        order: '?WiderOrder',
        either: 'string | Retry2',
      }),
      objectType('StricterOptions', {
        retry: '?Retry3',
        retries: 'Retry2[]',
        order: '?WiderOrder',
        either: 'string | Retry2',
      }),
      objectType('NarrowerOptions', { retry: '?Retry2', retries: 'Retry2[]', order: '?Order', either: 'Retry2' }),
    );
    expect(byShape('OldOptions', 'NewOptions', declared)).toEqual({
      rule: 'shape',
      fields: [
        { oldType: 'Retry', newType: 'Retry2' },
        { oldType: 'OldOptions', newType: 'NewOptions' },
      ],
    });
    // A nested type that requires a field more.
    expect(byShape('OldOptions', 'StricterOptions', declared)).toBeUndefined();
    // A union field that lost a member.
    expect(byShape('OldOptions', 'NarrowerOptions', declared)).toBeUndefined();
    // And never the other way around.
    expect(byShape('NewOptions', 'OldOptions', declared)).toBeUndefined();
  });

  it('weighs each member of a union of object types on its own', () => {
    const declared = types(
      objectType('A', { a: 'string' }),
      objectType('B', { b: 'string' }),
      objectType('AB', { a: '?string', b: '?string' }),
      objectType('NeedsA', { a: 'string', b: '?string' }),
    );
    expect(byShape('A | B', 'AB', declared)).toBeDefined();
    expect(byShape('A | B', 'AB | undefined', declared)).toBeDefined();
    // `B` has no `a` to give.
    expect(byShape('A | B', 'NeedsA', declared)).toBeUndefined();
    expect(byShape('A', 'NeedsA | B', declared)).toBeDefined();
    expect(byShape('A | B', 'NeedsA | B', declared)).toBeDefined();
  });

  it('settles two types that refer to themselves: their pair holds unless a field says otherwise', () => {
    const declared = types(
      objectType('Tree', { children: '?Tree[]', depth: '?number' }),
      objectType('Tree2', { children: '?Tree2[]', depth: '?number', label: '?string' }),
      objectType('BadTree', { children: '?BadTree[]', depth: '?string' }),
      objectType('NeedyTree', { children: '?NeedyTree[]', depth: '?number', root: 'string' }),
      objectType('Ping', { pong: '?Pong' }),
      objectType('Pong', { ping: '?Ping' }),
      objectType('Ping2', { pong: '?Pong2', more: '?string' }),
      objectType('Pong2', { ping: '?Ping2' }),
      objectType('BadPing', { pong: '?BadPong' }),
      objectType('BadPong', { ping: '?BadPing', must: 'string' }),
    );
    expect(byShape('Tree', 'Tree2', declared)).toEqual({
      rule: 'shape',
      fields: [{ oldType: 'Tree', newType: 'Tree2' }],
    });
    expect(byShape('Tree', 'Tree | undefined', declared)).toEqual({ rule: 'shape', fields: [] });
    expect(byShape('Tree[]', 'Tree2[]', declared)).toBeDefined();
    expect(byShape('Ping', 'Ping2', declared)).toBeDefined();
    expect(byShape('Pong', 'Pong2', declared)).toBeDefined();
    // A field that does not fit, on the type itself or on one it leads to.
    expect(byShape('Tree', 'BadTree', declared)).toBeUndefined();
    expect(byShape('Tree', 'NeedyTree', declared)).toBeUndefined();
    expect(byShape('Tree2', 'Tree', declared)).toBeUndefined();
    expect(byShape('Ping', 'BadPing', declared)).toBeUndefined();
    expect(byShape('Pong', 'BadPong', declared)).toBeUndefined();
  });

  it('forgets what it settled on the strength of a pair that turns out not to hold', () => {
    // `Q` → `Q2` holds if `P` → `P2` does, and is reached while that pair is
    // open; `P` → `P2` then fails on `bad`. `P` is taken by `P3`, and `Q` by
    // nothing: not by `Q2`, whatever was thought of it on the way.
    const declared = types(
      objectType('P', { q: '?Q', bad: '?number' }),
      objectType('Q', { p: '?P' }),
      objectType('P2', { q: '?Q2', bad: '?string' }),
      objectType('Q2', { p: '?P2' }),
      objectType('P3', { q: '?Q3', bad: '?number' }),
      objectType('Q3', { p: '?P3' }),
    );
    expect(byShape('P', 'P2', declared)).toBeUndefined();
    expect(byShape('Q', 'Q2', declared)).toBeUndefined();
    expect(byShape('P', 'P3', declared)).toBeDefined();
    expect(byShape('P | Q', 'P2 | Q2 | P3', declared)).toBeUndefined();
    expect(byShape('P | Q', 'P2 | Q2 | P3 | Q3', declared)).toEqual({
      rule: 'shape',
      fields: [
        { oldType: 'Q', newType: 'Q3' },
        { oldType: 'P', newType: 'P3' },
      ],
    });
  });

  it('settles each pair of types once, however many fields lead to it', () => {
    // 30 levels, each type with two fields of the type below.
    const levels = 30;
    const tower = (prefix: string, leaf: Record<string, string>) =>
      Array.from({ length: levels }, (_, level) =>
        objectType(
          `${prefix}${level}`,
          level === levels - 1 ? leaf : { left: `?${prefix}${level + 1}`, right: `?${prefix}${level + 1}` },
        ),
      ).flat();
    const declared = types(
      ...tower('Old', { timeout: '?number' }),
      ...tower('New', { timeout: '?number', maxRetries: '?number' }),
      ...tower('Bad', { timeout: '?string' }),
    );
    const started = Date.now();
    expect(byShape('Old0', 'New0', declared)).toBeDefined();
    expect(byShape('Old0', 'Bad0', declared)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  describe('where the old type declares that it extends the new one', () => {
    const declared = (
      retry: Record<string, string>,
      base: Record<string, string>,
      declaration: string[] = ['BaseOptions'],
    ) => types(objectType('BaseOptions', base), objectType('RetryOptions', retry, { extends: declaration }));

    it('still needs the new type to have every field of the old one', () => {
      // `get(id, { maxRetries: 2 })` names a field `BaseOptions` does not have.
      const widened = declared({ timeout: '?number', maxRetries: '?number' }, { timeout: '?number' });
      expect(byShape('RetryOptions', 'BaseOptions', widened)).toBeUndefined();
      expect(byShape('RetryOptions | undefined', 'BaseOptions | undefined', widened)).toBeUndefined();
      // Where a value is accepted by its declared type, the declaration is enough.
      expect(byDeclaration('RetryOptions', 'BaseOptions', widened)).toBeDefined();
    });

    it('does not take the declaration for the fields: they are weighed with it as without', () => {
      const same = declared({ timeout: '?number' }, { timeout: '?number' });
      expect(byShape('RetryOptions', 'BaseOptions', same)).toBeDefined();
      expect(
        byShape('RetryOptions', 'BaseOptions', declared({ timeout: '?number' }, { timeout: '?number' }, [])),
      ).toBeDefined();
      // A member the subtype narrows: a literal's primitive is not read, declared or not.
      const narrowed = declared({ mode: '?"fast" | "slow"' }, { mode: '?string' });
      expect(byShape('RetryOptions', 'BaseOptions', narrowed)).toBeUndefined();
    });

    it('does not let the candidate vouch for what callers pass today', () => {
      // Both SDKs are valid. The baseline has `BaseOptions.mode: string |
      // number`; the candidate narrows it to `string` on both types and moves
      // the parameter to the base. `get({ mode: 1 })` no longer compiles.
      const baseline = declared({ mode: '?string | number' }, { mode: '?string | number' });
      const candidate = declared({ mode: '?string' }, { mode: '?string' });
      expect(byShape('RetryOptions', 'BaseOptions', candidate)).toBeDefined();
      expect(byShape('RetryOptions', 'BaseOptions', candidate, baseline)).toBeUndefined();
    });
  });
});

describe('#752 by shape: one text on both sides is two declarations', () => {
  // The same name may stand for another type in the candidate, and nothing
  // else may say so: a type alias's text is compared nowhere, and a type the
  // spec does not derive is outside what `oagen verify` compares.
  it('reads a type alias behind an unchanged name from each snapshot', () => {
    const baseline = types(alias('Id', 'string | number'));
    const narrowed = types(alias('Id', 'string | boolean'));
    const widened = types(alias('Id', 'string | number | boolean'));
    // `get([1])` compiles against the baseline alone.
    expect(byShape('Id[]', 'Id[] | null', narrowed, baseline)).toBeUndefined();
    expect(byShape('Id', 'Id | null', narrowed, baseline)).toBeUndefined();
    expect(byShape('Promise<Id>', 'Promise<Id> | null', narrowed, baseline)).toBeUndefined();
    expect(byShape('{ id: Id; }', '{ id: Id; } | null', narrowed, baseline)).toBeUndefined();
    expect(byShape('Id[]', 'Id[] | null', widened, baseline)).toEqual({ rule: 'shape', fields: [] });
    expect(byShape('Id[]', 'Id[] | null', baseline, baseline)).toEqual({ rule: 'shape', fields: [] });
    // ... and from the candidate, for the code that names the alias: it
    // widens under the callers' feet where the parameter does not follow.
    expect(byShape('Id', 'string | number', widened, baseline)).toBeUndefined();
  });

  it('reads an alias inside a text that is not taken apart', () => {
    const baseline = types(alias('Id', 'string | number'), alias('Key', 'Id'));
    const narrowed = types(alias('Id', 'string'), alias('Key', 'Id'));
    for (const [text, orNull] of [
      ['Record<string, Id>', 'Record<string, Id> | null'],
      ['Map<Id, string>', 'Map<Id, string> | null'],
      ['[Id, string]', '[Id, string] | null'],
      ['(id: Id) => void', '((id: Id) => void) | null'],
      ['Box<Id>', 'Box<Id> | null'],
      // through an alias of the alias
      ['Box<Key>', 'Box<Key> | null'],
    ]) {
      expect([text, byShape(text, orNull, baseline, baseline) !== undefined]).toEqual([text, true]);
      expect([text, byShape(text, orNull, narrowed, baseline) !== undefined]).toEqual([text, false]);
    }
    // An alias only one snapshot declares is not one type.
    expect(byShape('Box<Id>', 'Box<Id> | null', types(), baseline)).toBeUndefined();
    expect(byShape('Box<Id>', 'Box<Id> | null', baseline, types())).toBeUndefined();
    // A name no snapshot declares is: a primitive, a type of another package.
    expect(byShape('Box<Buffer>', 'Box<Buffer> | null', baseline, baseline)).toBeDefined();
  });

  it('reads an object type behind an unchanged name from each snapshot', () => {
    const baseline = types(objectType('Options', { timeout: '?number', maxRetries: '?number' }));
    const lostAField = types(objectType('Options', { timeout: '?number' }));
    const gainedAField = types(objectType('Options', { timeout: '?number', maxRetries: '?number', signal: '?string' }));
    const requiresMore = types(objectType('Options', { timeout: '?number', maxRetries: 'number' }));
    expect(byShape('Options', 'Options | undefined', baseline, baseline)).toEqual({ rule: 'shape', fields: [] });
    expect(byShape('Options', 'Options | undefined', gainedAField, baseline)).toEqual({ rule: 'shape', fields: [] });
    expect(byShape('Options', 'Options | undefined', lostAField, baseline)).toBeUndefined();
    expect(byShape('Options', 'Options | undefined', requiresMore, baseline)).toBeUndefined();
    expect(byShape('Options[]', 'Options[] | undefined', lostAField, baseline)).toBeUndefined();
    // Inside a text that is not taken apart it has to be the same declaration.
    expect(byShape('Box<Options>', 'Box<Options> | null', baseline, baseline)).toBeDefined();
    expect(byShape('Box<Options>', 'Box<Options> | null', gainedAField, baseline)).toBeUndefined();
    expect(byShape('Box<Options>', 'Box<Options> | null', lostAField, baseline)).toBeUndefined();
  });

  it('reads a type whose fields one snapshot does not record whole as no answer', () => {
    const [symbolOf, fieldOf] = objectType('Options', { timeout: '?number' });
    const whole = types(symbolOf, fieldOf);
    const older = types({ ...symbolOf, hasUnlistedMembers: undefined }, fieldOf);
    expect(byShape('Options', 'Options | undefined', whole, older)).toBeUndefined();
    expect(byShape('Options', 'Options | undefined', older, whole)).toBeUndefined();
    // Neither records them: a class, an enum, a type of two older snapshots.
    // What changes of it is its own lines, and the text is all there is.
    expect(byShape('Options', 'Options | undefined', older, older)).toBeDefined();
    const classes = types(symbol('service_accessor', 'Client'));
    expect(byShape('Client', 'Client | null', classes, classes)).toBeDefined();
    expect(byShape('Status', 'Status | null', types(symbol('enum', 'Status')))).toBeDefined();
  });
});

describe('#752 by shape: an object type written in place', () => {
  const declared = types(
    objectType('RequestOptions', { timeout: '?number' }),
    objectType('RetryRequestOptions', { timeout: '?number', maxRetries: '?number' }),
    objectType('ThreeFields', { a: '?string', b: '?number', c: 'boolean' }),
    objectType('ThreeFieldsAlias', { a: '?string', b: '?number', c: 'boolean' }, { aliasOf: '{ … }' }),
  );

  it.each<[string, string, boolean]>([
    [
      '{ timeout?: number | undefined; }',
      '{ timeout?: number | undefined; maxRetries?: number | undefined; }',
      ACCEPTED,
    ],
    [
      '{ timeout?: number | undefined; maxRetries?: number | undefined; }',
      '{ timeout?: number | undefined; }',
      REFUSED,
    ],
    ['{ timeout?: number | undefined; }', '{ timeout?: number | undefined; retryKey: string; }', REFUSED],
    ['{ name: string; }', '{ name?: string | undefined; }', ACCEPTED],
    ['{ name?: string | undefined; }', '{ name: string; }', REFUSED],
    ['{ timeout?: number | undefined; }', '{ timeout?: string | undefined; }', REFUSED],
    ['{ timeout?: number | undefined; }', '{ timeout?: string | number | undefined; }', ACCEPTED],
    // nested, in an array, in a union
    ['{ filter?: { name?: string; }; }', '{ filter?: { name?: string; tag?: string; }; }', ACCEPTED],
    ['{ filter?: { name?: string; tag?: string; }; }', '{ filter?: { name?: string; }; }', REFUSED],
    ['{ timeout?: number; }[]', '{ timeout?: number; maxRetries?: number; }[]', ACCEPTED],
    ['{ timeout?: number; } | string', '{ timeout?: number; maxRetries?: number; } | string | number', ACCEPTED],
    // one side declared, the other written in place
    ['RequestOptions', '{ timeout?: number | undefined; maxRetries?: number | undefined; }', ACCEPTED],
    ['{ timeout?: number; }', 'RetryRequestOptions', ACCEPTED],
    ['{ timeout?: number | undefined; }', 'RetryRequestOptions', ACCEPTED],
    ['RetryRequestOptions', '{ timeout?: number | undefined; }', REFUSED],
    ['{ timeout?: number | undefined; maxRetries?: number | undefined; }', 'RequestOptions', REFUSED],
    ['{ retry?: RequestOptions; }', '{ retry?: RetryRequestOptions; }', ACCEPTED],
    // An optional member's `undefined`: printed by TypeScript for every
    // optional member, or written by an SDK compiled with
    // `exactOptionalPropertyTypes`. Beside an interface it is left out, as
    // the interface's own is; beside a type alias or another type written in
    // place it is weighed as written.
    ['{ a?: string | undefined; b?: number | undefined; c: boolean; }', 'ThreeFields', ACCEPTED],
    ['{ a?: string | undefined; b?: number | undefined; c: boolean; }', 'ThreeFieldsAlias', REFUSED],
    ['{ a?: string; b?: number; c: boolean; }', 'ThreeFieldsAlias', ACCEPTED],
    ['ThreeFieldsAlias', '{ a?: string | undefined; b?: number | undefined; c: boolean; }', ACCEPTED],
    ['{ a?: string; b?: number; c: boolean; }', 'ThreeFields', ACCEPTED],
    ['ThreeFields', '{ a?: string | undefined; b?: number | undefined; c: boolean; }', ACCEPTED],
    ['{ a?: string | undefined; b?: number; }', '{ a?: string; b?: number; }', REFUSED],
    ['{ a?: string; b?: number; }', '{ a?: string | undefined; b?: number; }', ACCEPTED],
    ['{ a?: (() => void) | undefined; }', '{ a?: (() => void) | undefined; b?: string | undefined; }', ACCEPTED],
    ['{ a: string | undefined; }', '{ a: string; }', REFUSED],
    // a type whose members do not say all a value may carry
    ['{ timeout?: number; [key: string]: unknown; }', '{ timeout?: number; }', REFUSED],
    ['{ timeout?: number; }', '{ timeout?: number; [key: string]: unknown; }', REFUSED],
    ['{ retry(attempt: number): void; }', '{ retry(attempt: number): void; timeout?: number; }', REFUSED],
    ['{}', '{ timeout?: number; }', REFUSED],
    ['{ a: string; ... 4 more ...; z: string; }', '{ a: string; ... 4 more ...; z: string; } | undefined', REFUSED],
  ])('%j → %j: %s', (oldText, newText, accepted) => {
    expect(byShape(oldText, newText, declared) !== undefined).toBe(accepted);
  });
});

describe('#752 by shape: what the snapshot has to record of a type', () => {
  const NEW = objectType('NewOptions', { timeout: '?number', maxRetries: '?number' });
  const accepts = (...oldType: CompatSymbol[]) =>
    byShape('OldOptions', 'NewOptions', types(oldType, NEW)) !== undefined;
  const [oldSymbol, oldField] = objectType('OldOptions', { timeout: '?number' });

  it('settles a type recorded whole', () => {
    expect(accepts(oldSymbol, oldField)).toBe(true);
  });

  it.each<[string, CompatSymbol[]]>([
    ['a type the snapshot does not declare', []],
    ['a type recorded by name only', [symbol('alias', 'OldOptions')]],
    ['a type without `extends`', [{ ...oldSymbol, extends: undefined }, oldField]],
    [
      'a type that does not say its fields are all there is',
      [{ ...oldSymbol, hasUnlistedMembers: undefined }, oldField],
    ],
    ['a type with an index or a call signature', [{ ...oldSymbol, hasUnlistedMembers: true }, oldField]],
    ['a class', [symbol('service_accessor', 'OldOptions'), { ...oldField, kind: 'property' }]],
    ['an enum', [symbol('enum', 'OldOptions')]],
    ['a field of unknown optionality', [oldSymbol, { ...oldField, optional: undefined }]],
    ['a field without a type', [oldSymbol, { ...oldField, typeRef: undefined }]],
    [
      'a property among the fields',
      [oldSymbol, oldField, { ...oldField, id: 'p', fqName: 'OldOptions.extra', kind: 'property' }],
    ],
    ['a type that extends one the snapshot does not declare', [{ ...oldSymbol, extends: ['Elsewhere'] }, oldField]],
    ['a type that extends an instantiation', [{ ...oldSymbol, extends: ['Partial<Base>'] }, oldField]],
  ])('does not settle %s', (_, oldType) => {
    expect(accepts(...oldType)).toBe(false);
    // ... on the new side either.
    const renamed = oldType.map((sym) => ({
      ...sym,
      fqName: sym.fqName.replace('OldOptions', 'NewOptions'),
      ...(sym.ownerFqName ? { ownerFqName: 'NewOptions' } : {}),
    }));
    expect(byShape('OldOptions', 'NewOptions', types(oldSymbol, oldField, renamed))).toBeUndefined();
  });
});

describe('#752 by shape: the old type is read from both snapshots', () => {
  const NEW = objectType('NewOptions', { timeout: '?number', tag: '?number' });

  it("refuses a retype the candidate's declaration of the old type does not fit", () => {
    // The old type gains an optional `tag: string`; code that names it and
    // sets `tag` no longer passes for a `NewOptions`, whose `tag` is a number.
    const baseline = types(objectType('OldOptions', { timeout: '?number' }));
    const candidate = types(objectType('OldOptions', { timeout: '?number', tag: '?string' }), NEW);
    expect(byShape('OldOptions', 'NewOptions', candidate, baseline)).toBeUndefined();
    expect(
      byShape('OldOptions', 'NewOptions', types(objectType('OldOptions', { timeout: '?number' }), NEW), baseline),
    ).toBeDefined();
  });

  it("refuses a retype the baseline's declaration of the old type does not fit", () => {
    // What callers pass today has a `mode` the new type does not know.
    const baseline = types(objectType('OldOptions', { timeout: '?number', mode: '?string' }));
    const candidate = types(objectType('OldOptions', { timeout: '?number' }), NEW);
    expect(byShape('OldOptions', 'NewOptions', candidate, baseline)).toBeUndefined();
  });

  it('reads a type alias on both sides as well', () => {
    // `PetId` was `string | number`; the candidate narrows it to `string` and
    // retypes the parameter to `string`. A caller passing `5` no longer may.
    expect(
      byShape('PetId', 'string', types(alias('PetId', 'string')), types(alias('PetId', 'string | number'))),
    ).toBeUndefined();
    // The other way: the alias widens under the callers' feet.
    expect(
      byShape('PetId', 'string', types(alias('PetId', 'string | number')), types(alias('PetId', 'string'))),
    ).toBeUndefined();
    expect(byShape('PetId', 'string', types(alias('PetId', 'string')), types(alias('PetId', 'string')))).toBeDefined();
  });

  it('reads a type the candidate dropped as the baseline declares it', () => {
    const baseline = types(objectType('OldOptions', { timeout: '?number' }));
    expect(byShape('OldOptions', 'NewOptions', types(NEW), baseline)).toBeDefined();
    expect(
      byShape('OldOptions', 'NewOptions', types(objectType('NewOptions', { tag: '?number' })), baseline),
    ).toBeUndefined();
  });

  it('reads the new type from the candidate alone', () => {
    const baseline = types(
      objectType('OldOptions', { timeout: '?number' }),
      objectType('NewOptions', { timeout: '?string' }),
    );
    const candidate = types(objectType('OldOptions', { timeout: '?number' }), NEW);
    expect(byShape('OldOptions', 'NewOptions', candidate, baseline)).toBeDefined();
    expect(byShape('OldOptions', 'NewOptions', baseline, candidate)).toBeUndefined();
  });
});

describe('#752 by declaration: the old type declares that it extends the new one', () => {
  const candidate = types(
    objectType('BaseOptions', { timeout: '?number' }),
    objectType('MidOptions', {}, { extends: ['BaseOptions'] }),
    objectType('RetryOptions', { maxRetries: '?number' }, { extends: ['MidOptions'] }),
    objectType('SameFields', { timeout: '?number' }),
    objectType('PartOptions', {}, { extends: ['Partial<BaseOptions>'] }),
    objectType('Options', {}, { extends: ['BaseOptions'] }),
    objectType('Optional', {}, { extends: ['BaseOptions'] }),
  );
  const accepted = (oldText: string, newText: string, declared = candidate, baseline = declared) =>
    byDeclaration(oldText, newText, declared, baseline) !== undefined;

  it.each<[string, string]>([
    ['MidOptions', 'BaseOptions'],
    // through a chain
    ['RetryOptions', 'BaseOptions'],
    ['RetryOptions', 'MidOptions'],
    // under the same optional spelling, as each language writes one
    ['?RetryOptions', '?BaseOptions'],
    ['RetryOptions?', 'BaseOptions?'],
    ['RetryOptions | None', 'BaseOptions | None'],
    ['Optional[RetryOptions]', 'Optional[BaseOptions]'],
    ['RetryOptions | null', 'BaseOptions | null'],
    ['RetryOptions | undefined', 'BaseOptions | undefined'],
    ['null|RetryOptions', 'null|BaseOptions'],
    ['*RetryOptions', '*BaseOptions'],
    ['Option<RetryOptions>', 'Option<BaseOptions>'],
    ['T.nilable(RetryOptions)', 'T.nilable(BaseOptions)'],
    // one array suffix, and PHP's namespace
    ['RetryOptions[]', 'BaseOptions[]'],
    ['?RetryOptions[]', '?BaseOptions[]'],
    ['\\Acme\\RetryOptions', '\\Acme\\BaseOptions'],
    ['?\\Acme\\RetryOptions', '?\\Acme\\BaseOptions'],
    // a name that is part of the other, and one a wrapper shares
    ['Options', 'BaseOptions'],
    ['Optional[Options]', 'Optional[BaseOptions]'],
  ])('%j → %j is accepted', (oldText, newText) => {
    expect(accepted(oldText, newText)).toBe(true);
    // The new type that extends the old one asks for more than callers pass.
    expect(accepted(newText, oldText)).toBe(false);
  });

  it.each<[string, string]>([
    // the retype also changes what stands around the name
    ['RetryOptions', '?BaseOptions'],
    ['?RetryOptions', 'BaseOptions'],
    ['RetryOptions', 'BaseOptions | None'],
    ['RetryOptions | None', 'BaseOptions'],
    ['RetryOptions | null', 'BaseOptions | undefined'],
    ['Optional[RetryOptions]', 'BaseOptions | None'],
    ['RetryOptions', 'BaseOptions[]'],
    ['RetryOptions[]', 'BaseOptions'],
    ['RetryOptions', 'Promise<BaseOptions>'],
    ['\\Acme\\RetryOptions', '\\Other\\BaseOptions'],
    ['RetryOptions | null', 'BaseOptions|null'],
    // a generic's argument: whether a list of the subtype is taken depends on the list
    ['List<RetryOptions>', 'List<BaseOptions>'],
    ['list[RetryOptions]', 'list[BaseOptions]'],
    ['Array<RetryOptions>', 'Array<BaseOptions>'],
    ['Promise<RetryOptions>', 'Promise<BaseOptions>'],
    ['Vec<RetryOptions>', 'Vec<BaseOptions>'],
    ['RetryOptions[][]', 'BaseOptions[][]'],
    ['Record<string, RetryOptions>', 'Record<string, BaseOptions>'],
    // a union with another type
    ['RetryOptions | string', 'BaseOptions | string'],
    ['RetryOptions', 'BaseOptions | string'],
    // no declaration: the same fields, an instantiation, the same type
    ['SameFields', 'BaseOptions'],
    ['BaseOptions', 'SameFields'],
    ['PartOptions', 'BaseOptions'],
    ['BaseOptions', 'BaseOptions'],
    ['RetryOptions', 'Elsewhere'],
    ['Elsewhere', 'BaseOptions'],
    ['string', 'string | int'],
    ['string', '?string'],
    ['', 'BaseOptions'],
  ])('%j → %j is not', (oldText, newText) => {
    expect(accepted(oldText, newText)).toBe(false);
  });

  it('reads a type named like a wrapper by its name, and does not tell it from the wrapper around it', () => {
    expect(accepted('Optional', 'BaseOptions')).toBe(true);
    expect(accepted('Optional[]', 'BaseOptions[]')).toBe(true);
    expect(accepted('Optional', 'Optional[BaseOptions]')).toBe(false);
    // `Optional` the type under `Optional` the wrapper: what stands around
    // the name is not told apart from the name, so the retype is not credited.
    expect(accepted('Optional[Optional]', 'Optional[BaseOptions]')).toBe(false);
  });

  it('reads the declaration from the candidate, whatever the baseline says', () => {
    const without = types(objectType('BaseOptions', {}), objectType('RetryOptions', {}));
    // Declared since: the value callers pass is built from the type as it is now.
    expect(accepted('RetryOptions', 'BaseOptions', candidate, without)).toBe(true);
    // No longer declared, or the old type is gone.
    expect(accepted('RetryOptions', 'BaseOptions', without, candidate)).toBe(false);
    expect(accepted('RetryOptions', 'BaseOptions', types(objectType('BaseOptions', {})), candidate)).toBe(false);
    // A snapshot written before `extends`.
    expect(
      accepted('RetryOptions', 'BaseOptions', types(symbol('alias', 'BaseOptions'), symbol('alias', 'RetryOptions'))),
    ).toBe(false);
  });

  it('needs no field of either type, only the declaration', () => {
    const classes = types(
      symbol('alias', 'BaseOptions', { extends: [] }),
      symbol('alias', 'RetryOptions', { extends: ['BaseOptions'] }),
      symbol('field', 'RetryOptions.maxRetries', { ownerFqName: 'RetryOptions', typeRef: { name: 'int' } }),
    );
    expect(accepted('RetryOptions', 'BaseOptions', classes)).toBe(true);
    // A supertype the snapshot does not declare itself is still declared.
    expect(accepted('RetryOptions', 'Vendor', types(symbol('alias', 'RetryOptions', { extends: ['Vendor'] })))).toBe(
      true,
    );
  });
});
