import type { Constraints, TypeRef } from '../ir/types.js';
import { assertNever, typeRefConstraints } from '../ir/types.js';
import { addedUnionVariants, typeRefsEqual } from './models.js';

/**
 * A site whose validation keywords the differ compares (#599): a field or a
 * parameter, which carries its own `constraints` (equal to its type's, see
 * `Constraints` in `ir/types.ts`); a response header, which carries none of
 * its own, so its type's are read; a model, which carries its own and has
 * no type; a union variant, which is a type alone.
 */
export interface ConstrainedSite {
  /** The site's own validation keywords; a response header and a variant carry none here. */
  constraints?: Constraints;
  /** The site's type, whose nested levels (`items`, `valueType`, `variants[i]`) are read too; a model has none. */
  type?: TypeRef;
}

/**
 * The two sides of a limits change at one site, carried on the
 * `field-constraints-changed`, `param-constraints-changed`,
 * `header-constraints-changed` or `variant-constraints-changed` entry, or
 * the `model-modified` change, that reports it.
 */
export interface ConstraintsShift {
  /** The site's own limits in the old spec (its type's for a header or a variant); absent when it declared none. */
  oldConstraints?: Constraints;
  /** The site's own limits in the new spec (its type's for a header or a variant); absent when it declares none. */
  newConstraints?: Constraints;
  /**
   * Every keyword that moved, old → new, joined with `; `: `maxLength 100
   * → 10`, `pattern '^pet_' → '^pt_'`, `minimum <unset> → 5` for one
   * added, `maxItems 10 → <unset>` for one removed, `uniqueItems <unset> →
   * true`, `dependentRequired {"a":["b"]} → {"a":["b","c"]}`; a keyword
   * on a nested level is prefixed with the path to it (`items.pattern`,
   * `valueType.maxLength`, `variants[1].minimum`, `items.items.maxLength`,
   * `variants[1].variants[0].maxLength`).
   */
  details: string;
  /** Whether the limits tightened at some level (`levelTightened`): a value the old limits admitted can now be rejected. */
  tightened: boolean;
}

/** The two sides of `shift` alone, each present when the site declares limits there, to spread onto the entry that reports it. */
export function constraintsSides(shift: ConstraintsShift): Pick<ConstraintsShift, 'oldConstraints' | 'newConstraints'> {
  return {
    ...(shift.oldConstraints ? { oldConstraints: shift.oldConstraints } : {}),
    ...(shift.newConstraints ? { newConstraints: shift.newConstraints } : {}),
  };
}

/** The keywords in one fixed order, so `details` never depends on the order a document wrote them in. */
const KEYWORDS: ReadonlyArray<keyof Constraints> = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minContains',
  'maxContains',
  'minProperties',
  'maxProperties',
  'dependentRequired',
];

/** The four numeric bounds, judged as two pairs (`lowerBound`, `upperBound`): a value is admitted by the stricter of each pair. */
const NUMERIC_BOUNDS: ReadonlySet<keyof Constraints> = new Set([
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'exclusiveMaximum',
]);

/**
 * The two keywords that only bound what `contains` matches, which the IR
 * does not carry (an emitter has nothing to type from it), so the differ
 * cannot tell whether they apply: without `contains` they constrain
 * nothing, and the parser keeps them either way. A change to one is
 * reported in `details` but never tightened or loosened (Greptile, #659
 * review round 4); an IR that carries `contains` could judge them as
 * `minItems` / `maxItems` are.
 */
const CONTAINS_BOUNDS: ReadonlySet<keyof Constraints> = new Set(['minContains', 'maxContains']);

/** Keywords that bound a value from above on their own: lowered is tighter, raised looser. */
const UPPER_BOUNDS: ReadonlySet<keyof Constraints> = new Set(['maxLength', 'maxItems', 'maxProperties']);

/**
 * Keywords that bound a value from below on their own, each with the value
 * its absence means (JSON Schema's default: a string, an array or an
 * object may be empty), read in its place on either side: raised is
 * tighter and lowered looser, so one added at its default — `minLength:
 * 0`, which the parser keeps as written — rejects nothing (Greptile, #659
 * review round 2) and one removed from below its default would require
 * more again (round 3; only `minContains` has a default above `0`, and it
 * is `CONTAINS_BOUNDS`).
 */
const LOWER_BOUNDS: ReadonlyMap<keyof Constraints, number> = new Map([
  ['minLength', 0],
  ['minItems', 0],
  ['minProperties', 0],
]);

/**
 * One level of a site where the limits differ: the path to it (`''` for the
 * site's own, `items.`, `variants[1].items.`), the limits on each side as
 * the document wrote them — what `details` and the sides report — and as
 * the differ reads them for the level's type (`readLimits`: the keywords
 * that can constrain the type, an integer side's exclusive bounds made
 * inclusive), which is what decides whether the level tightened
 * (`constraintsTightened` reads `minimum` and `exclusiveMinimum` together).
 */
interface LevelShift {
  path: string;
  before?: Constraints;
  after?: Constraints;
  readBefore?: Constraints;
  readAfter?: Constraints;
  /** Whether the level tightened (`levelTightened`): a value the old limits admitted can now be rejected. */
  tightened: boolean;
}

/** A `LevelShift` for two sides written `before` / `after` on types `oldType` / `newType`, each read for its own type (`readLimits`). */
function levelShift(
  path: string,
  before: Constraints | undefined,
  after: Constraints | undefined,
  oldType: TypeRef | undefined,
  newType: TypeRef | undefined,
): LevelShift {
  const readBefore = readLimits(before, oldType);
  const readAfter = readLimits(after, newType);
  return {
    path,
    before,
    after,
    readBefore,
    readAfter,
    tightened: levelTightened(readBefore, readAfter, oldType, newType),
  };
}

/**
 * Whether one level tightened from `readBefore` to `readAfter` (each as
 * `readLimits` reads them) for a value of `newType`. A type that admits a
 * known set of values — a literal (`const`, or a single-member `enum`),
 * which admits exactly its value, or an enum reference the IR carries the
 * `values` of (`admittedValues`) — tightened only when some value the old
 * limits admitted the new reject (`admits`): `{ const: 'abc', maxLength:
 * 5 }` → `maxLength: 3` is reported but still admits `'abc'`, while
 * `maxLength: 2` rejects it (Greptile, #659 review round 6). Where the old
 * type's values are known too, only a value it listed counts: one the new
 * type adds was never admitted, whatever the old limits say, so `{ enum:
 * ['a', 'bb'], maxLength: 5 }` → `{ enum: ['a', 'bb', 'cccc'], maxLength:
 * 3 }` tightens nothing — `'a'` and `'bb'` still fit, and `'cccc'`, which
 * fits the old limit alone, was no value of the old enum (round 7). A
 * keyword the
 * differ cannot evaluate on the value — a `pattern`, or a `multipleOf`
 * where either is not an integer — is judged as on any string or number
 * (`keywordTightened`). Every other type is judged keyword by keyword
 * (`constraintsTightened`).
 */
function levelTightened(
  readBefore: Constraints | undefined,
  readAfter: Constraints | undefined,
  oldType: TypeRef | undefined,
  newType: TypeRef | undefined,
): boolean {
  const listed = admittedValues(newType);
  if (listed === undefined) return constraintsTightened(readBefore, readAfter);
  const before = admittedValues(oldType);
  const values = before === undefined ? listed : listed.filter((value) => before.includes(value));
  if (values.some((value) => admits(readBefore, value) && !admits(readAfter, value))) return true;
  return UNDECIDABLE_KEYWORDS.some((keyword) => {
    const [x, y] = [readBefore?.[keyword], readAfter?.[keyword]];
    if (sameKeyword(keyword, x, y)) return false;
    if (keyword === 'multipleOf' && values.every((value) => integerMultiple(value, x) && integerMultiple(value, y))) {
      return false;
    }
    return keywordTightened(keyword, x, y);
  });
}

/** The keywords `admits` cannot evaluate on a value: a `pattern` (no regular expression is built from a document), a `multipleOf` of or on a non-integer. */
const UNDECIDABLE_KEYWORDS: ReadonlyArray<keyof Constraints> = ['pattern', 'multipleOf'];

/** Whether `value % multipleOf` can be evaluated exactly: both integers, or no `multipleOf` at all. */
function integerMultiple(value: LiteralValue, multipleOf: unknown): boolean {
  return multipleOf === undefined || (Number.isInteger(value) && Number.isInteger(multipleOf));
}

type LiteralValue = string | number | boolean | null;

/**
 * The values a type admits when the IR knows them all: a literal's `value`
 * (under any nullable wrapper), an enum reference's `values` when the
 * parser carried them; `undefined` for every other type, or an enum
 * reference without `values`.
 */
function admittedValues(type: TypeRef | undefined): LiteralValue[] | undefined {
  if (!type) return undefined;
  const value = unwrap(type);
  if (value.kind === 'literal') return [value.value];
  if (value.kind === 'enum' && value.values) return value.values;
  return undefined;
}

/**
 * Whether `limits` admit `value`, by the keywords the differ can evaluate
 * on it: a string's length in code points against `minLength` /
 * `maxLength`, a number against `minimum`, `maximum`, `exclusiveMinimum`,
 * `exclusiveMaximum` and an integer `multipleOf` on an integer value; a
 * `pattern`, a `multipleOf` on or of a non-integer, and every keyword on a
 * boolean or `null` are passed over (`UNDECIDABLE_KEYWORDS`,
 * `levelTightened` judges them on their own).
 */
function admits(limits: Constraints | undefined, value: LiteralValue): boolean {
  if (!limits) return true;
  if (typeof value === 'string') {
    const length = [...value].length;
    if (limits.minLength !== undefined && length < limits.minLength) return false;
    if (limits.maxLength !== undefined && length > limits.maxLength) return false;
    return true;
  }
  if (typeof value === 'number') {
    if (limits.minimum !== undefined && value < limits.minimum) return false;
    if (limits.exclusiveMinimum !== undefined && value <= limits.exclusiveMinimum) return false;
    if (limits.maximum !== undefined && value > limits.maximum) return false;
    if (limits.exclusiveMaximum !== undefined && value >= limits.exclusiveMaximum) return false;
    if (limits.multipleOf !== undefined && integerMultiple(value, limits.multipleOf)) {
      return value % limits.multipleOf === 0;
    }
    return true;
  }
  return true;
}

/**
 * The levels two types differ at, memoized by the two types' identity for
 * one `constraintsShift` or `pairVariants` call, so a pair of types the
 * variant pairing tries and the walk then descends is compared once
 * (Greptile, #659 review round 1: without it a chain of nested unions is
 * walked once per level it sits under).
 */
type PairMemo = WeakMap<TypeRef, WeakMap<TypeRef, LevelShift[]>>;

/**
 * How the limits a site carries differ between the two specs, or
 * `undefined` when they do not (#599). The site's own keywords are compared
 * first — a field's or parameter's `constraints`, which equal its type's
 * (under a nullable wrapper) whenever the type can carry them, else the
 * type's own; a response header's or a variant's type's, since neither
 * carries any of its own; a model's own, which has no type — and then,
 * while both sides have a type, the limits the type carries at every level
 * under it, in lockstep: an array's `items`, a map's `valueType`, a union's
 * variants (paired by `pairVariants`, which pairs a union that only gained
 * variants with the union it widened, so the kept variants of a widened
 * inner union are compared too), through every nullable wrapper, whose
 * `inner` carries the value's keywords. Two levels of different kinds —
 * an array become a string — are left to the type change that reports
 * them; a model or enum reference carries none (the model's own are
 * compared with the model).
 *
 * Each keyword is compared on its own, in one fixed order, a number,
 * string or boolean by value and `dependentRequired` as a map of sets, so
 * `{ a: ['b', 'c'] }` and `{ a: ['c', 'b'] }` are one declaration; every
 * keyword added, removed or changed is named in `details`, old → new, with
 * the path to its level before it (`items.pattern`), and `tightened` says
 * whether the limits tightened at some level (`constraintsTightened`).
 * `oldConstraints` / `newConstraints` are the site's own, each present when
 * it declares any on that side, so a change on a nested level alone carries
 * two equal sides (or none) and names the level in `details`.
 */
export function constraintsShift(oldSite: ConstrainedSite, newSite: ConstrainedSite): ConstraintsShift | undefined {
  const memo: PairMemo = new WeakMap();
  const levels: LevelShift[] = [];
  const oldConstraints = siteLimits(oldSite);
  const newConstraints = siteLimits(newSite);
  if (!sameConstraints(oldConstraints, newConstraints)) {
    levels.push(levelShift('', oldConstraints, newConstraints, oldSite.type, newSite.type));
  }
  if (oldSite.type && newSite.type) levels.push(...childLevels('', oldSite.type, newSite.type, memo));
  if (levels.length === 0) return undefined;
  return {
    ...(oldConstraints ? { oldConstraints } : {}),
    ...(newConstraints ? { newConstraints } : {}),
    details: levels.flatMap(renderLevel).join('; '),
    tightened: levels.some((level) => level.tightened),
  };
}

/**
 * The levels at which `a` and `b` carry different limits, each path
 * prefixed with `path`: their own (`limitsOf`, through a nullable wrapper)
 * and, under it, their children's (`childLevels`). Memoized by the two
 * types' identity, with the paths relative to the pair.
 */
function typeLevels(path: string, a: TypeRef, b: TypeRef, memo: PairMemo): LevelShift[] {
  let byNew = memo.get(a);
  if (!byNew) {
    byNew = new WeakMap();
    memo.set(a, byNew);
  }
  let levels = byNew.get(b);
  if (!levels) {
    levels = [];
    const [x, y] = [limitsOf(a), limitsOf(b)];
    if (!sameConstraints(x, y)) levels.push(levelShift('', x, y, a, b));
    levels.push(...childLevels('', a, b, memo));
    byNew.set(b, levels);
  }
  return path === '' ? levels : levels.map((level) => ({ ...level, path: `${path}${level.path}` }));
}

/**
 * The levels under two types of one kind that differ, each path prefixed
 * with `path` and the child's key: an array's `items.`, a map's
 * `valueType.`, a union's `variants[i].` for each new variant paired with
 * an old one (`pairVariants`), `i` the new variant's index. Two types of
 * different kinds, or two leaves, have no children to compare.
 */
function childLevels(path: string, a: TypeRef, b: TypeRef, memo: PairMemo): LevelShift[] {
  const [x, y] = [unwrap(a), unwrap(b)];
  if (x.kind === 'array' && y.kind === 'array') return typeLevels(`${path}items.`, x.items, y.items, memo);
  if (x.kind === 'map' && y.kind === 'map') return typeLevels(`${path}valueType.`, x.valueType, y.valueType, memo);
  if (x.kind === 'union' && y.kind === 'union') {
    return [...pairVariants(x.variants, y.variants, memo)].flatMap(([i, old]) =>
      typeLevels(`${path}variants[${i}].`, old, y.variants[i], memo),
    );
  }
  return [];
}

/** The lines of `details` one level contributes: each keyword that differs, in `KEYWORDS` order, old → new, after the level's path. */
function renderLevel({ path, before, after }: LevelShift): string[] {
  return KEYWORDS.filter((keyword) => !sameKeyword(keyword, before?.[keyword], after?.[keyword])).map(
    (keyword) =>
      `${path}${keyword} ${renderKeyword(keyword, before?.[keyword])} → ${renderKeyword(keyword, after?.[keyword])}`,
  );
}

/**
 * Whether the limits at one level tightened from `before` to `after`: some
 * value the old limits admitted can now be rejected. The numeric bounds are
 * judged as the two bounds they make, a lower one from `minimum` and
 * `exclusiveMinimum` and an upper one from `maximum` and
 * `exclusiveMaximum` (`lowerBound`, `upperBound`): tightened when a bound
 * appears, moves inward, or is made exclusive at the same value, so
 * `exclusiveMinimum: 0` becoming `minimum: 0` — the OpenAPI 3.0
 * `exclusiveMinimum: true` flipped off, which the parser reads as exactly
 * that — admits the `0` it rejected and is loosened (Greptile, #659 review
 * round 1), while `minimum: 0` becoming `exclusiveMinimum: 0` is tightened.
 * The caller passes an integer site's bounds already read as inclusive
 * (`integerBounds`), so `exclusiveMinimum: 0` becoming `minimum: 1` on an
 * integer tightens nothing. Every other keyword is judged on its own
 * (`keywordTightened`), and the level is tightened when any of them is.
 */
export function constraintsTightened(before: Constraints | undefined, after: Constraints | undefined): boolean {
  if (boundTightened(lowerBound(before), lowerBound(after), 'lower')) return true;
  if (boundTightened(upperBound(before), upperBound(after), 'upper')) return true;
  return KEYWORDS.some((keyword) => {
    if (NUMERIC_BOUNDS.has(keyword)) return false;
    const [x, y] = [before?.[keyword], after?.[keyword]];
    return !sameKeyword(keyword, x, y) && keywordTightened(keyword, x, y);
  });
}

/**
 * Whether a keyword's move from `oldValue` to `newValue` rejects a value the
 * old declaration admitted. `minContains` and `maxContains` never do, as
 * far as the IR can tell (`CONTAINS_BOUNDS`): they bound what `contains`
 * matches, which the IR does not carry, and constrain nothing without it,
 * so a change to them is reported but never tightened (Greptile, #659
 * review round 4). A lower bound (`minLength`, `minItems`,
 * `minProperties`; `LOWER_BOUNDS`) is read on each side as the value its
 * absence means when it is absent — JSON Schema's default, `0` — and is
 * tightened when the new reading is above the old: raised, added above its
 * default, or removed from below it (round 3), while one added at or
 * removed from its default (`minLength: 0`) is reported but rejects
 * nothing (round 2).
 * `dependentRequired` is read as an empty map when absent and is tightened
 * when a property requires a name it did not — one newly listed with
 * names, or the keyword added with any — even if another loses one, so
 * `{ a: [] }` added tightens nothing; `uniqueItems` is tightened when it
 * becomes `true`. Every other keyword is tightened when added and loosened
 * when removed, since it admits fewer values than none: a changed upper
 * bound is tightened when lowered, and a changed `pattern` or `multipleOf`
 * is tightened, since the new value admits other values than the old in
 * general (a pattern rewritten, a multiple the old one does not divide).
 * One of the four numeric bounds is judged on its own here, as if its twin
 * were absent on both sides; a level is judged with the twins together by
 * `constraintsTightened`.
 */
export function keywordTightened(keyword: keyof Constraints, oldValue: unknown, newValue: unknown): boolean {
  if (CONTAINS_BOUNDS.has(keyword)) return false;
  if (NUMERIC_BOUNDS.has(keyword)) {
    return constraintsTightened({ [keyword]: oldValue } as Constraints, { [keyword]: newValue } as Constraints);
  }
  const floor = LOWER_BOUNDS.get(keyword);
  if (floor !== undefined) {
    return ((newValue as number | undefined) ?? floor) > ((oldValue as number | undefined) ?? floor);
  }
  if (keyword === 'dependentRequired') {
    return dependentRequiredTightened(
      (oldValue as DependentRequired | undefined) ?? {},
      (newValue as DependentRequired | undefined) ?? {},
    );
  }
  if (keyword === 'uniqueItems') return newValue === true && oldValue !== true;
  if (newValue === undefined) return false;
  if (oldValue === undefined) return true;
  if (UPPER_BOUNDS.has(keyword)) return (newValue as number) < (oldValue as number);
  // `pattern` and `multipleOf`: changed is tightened.
  return true;
}

/**
 * `limits` as the differ reads them for a value of `type`, for the
 * tightened judgement alone (`details` still names the keywords as the
 * document wrote them): on an integer — a `primitive` of type `integer`,
 * under any nullable wrapper — a bound admits the same integers as the
 * inclusive one beside it, so `exclusiveMinimum: n` is read as `minimum:
 * ⌊n⌋ + 1` and `exclusiveMaximum: n` as `maximum: ⌈n⌉ − 1`, a fractional
 * inclusive bound is rounded inward (`minimum: 0.5` is `minimum: 1`), and
 * the stricter of the two on a side wins when both are declared. So
 * `exclusiveMinimum: 0` → `minimum: 1`, OpenAPI 3.0's `{ minimum: 0,
 * exclusiveMinimum: true }` → `{ minimum: 1 }` and `maximum: 9` →
 * `exclusiveMaximum: 10` on an integer are reported, since the declaration
 * changed, but tighten nothing (MichaelDeBoey, #659 review). An exclusive
 * bound whose neighbor is not a safe integer (at or beyond 2^53) stays as
 * written, since the neighbor cannot be represented, so `minimum: 2^53` →
 * `exclusiveMinimum: 2^53` is still tightened. On a number, or a type the
 * differ cannot read as one integer (a union, a model), the bounds are read
 * as written: `0 < x` admits `0.5` and `1 <= x` does not.
 */
export function integerBounds(limits: Constraints | undefined, type: TypeRef | undefined): Constraints | undefined {
  if (!limits || !type) return limits;
  const value = unwrap(type);
  if (value.kind !== 'primitive' || value.type !== 'integer') return limits;
  const read: Constraints = { ...limits };
  // An exclusive bound is the inclusive one beside it only while that
  // integer is exact: beyond `Number.MAX_SAFE_INTEGER` adding or taking one
  // rounds back to the bound itself, which would read `minimum: 2^53` and
  // `exclusiveMinimum: 2^53` as one bound though the second rejects it
  // (Greptile, #659 review round 5), so such a bound stays as written.
  const beside = (bound: number | undefined, next: (n: number) => number): number | undefined => {
    if (bound === undefined) return undefined;
    const neighbor = next(bound);
    return Number.isSafeInteger(neighbor) ? neighbor : undefined;
  };
  const exclusiveLower = beside(limits.exclusiveMinimum, (n) => Math.floor(n) + 1);
  const exclusiveUpper = beside(limits.exclusiveMaximum, (n) => Math.ceil(n) - 1);
  const lower = defined([limits.minimum === undefined ? undefined : Math.ceil(limits.minimum), exclusiveLower]);
  const upper = defined([limits.maximum === undefined ? undefined : Math.floor(limits.maximum), exclusiveUpper]);
  if (lower.length > 0) read.minimum = Math.max(...lower);
  if (upper.length > 0) read.maximum = Math.min(...upper);
  if (exclusiveLower !== undefined) delete read.exclusiveMinimum;
  if (exclusiveUpper !== undefined) delete read.exclusiveMaximum;
  return read;
}

/** The numbers among `values`. */
function defined(values: Array<number | undefined>): number[] {
  return values.filter((v): v is number => v !== undefined);
}

/** The keywords that constrain a string. */
const STRING_KEYWORDS: ReadonlySet<keyof Constraints> = new Set(['minLength', 'maxLength', 'pattern']);
/** The keywords that constrain an integer or a number. */
const NUMERIC_KEYWORDS: ReadonlySet<keyof Constraints> = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);
/** The keywords that constrain an array. */
const ARRAY_KEYWORDS: ReadonlySet<keyof Constraints> = new Set([
  'minItems',
  'maxItems',
  'uniqueItems',
  'minContains',
  'maxContains',
]);
/** The keywords that constrain an object (a map, a model's own schema). */
const OBJECT_KEYWORDS: ReadonlySet<keyof Constraints> = new Set([
  'minProperties',
  'maxProperties',
  'dependentRequired',
]);
/** No keyword constrains a boolean or a `null`. */
const NO_KEYWORDS: ReadonlySet<keyof Constraints> = new Set();

/**
 * The keywords that can constrain a value of `type`, by what the type is
 * under any nullable wrapper — a string's on a `string` primitive or
 * literal, the numeric ones on an `integer` or `number`, an array's on an
 * `array`, an object's on a `map`, none on a `boolean`, a union's by every
 * variant's — or `undefined` when any keyword may: an `unknown` primitive,
 * a model or enum reference (the site's own keywords written beside a
 * `$ref`, whose target the differ does not read here), a union with such a
 * variant, or no type at all (a model's own keywords, a hand-built site).
 */
function applicableKeywords(type: TypeRef | undefined): ReadonlySet<keyof Constraints> | undefined {
  if (!type) return undefined;
  const value = unwrap(type);
  switch (value.kind) {
    case 'primitive':
      if (value.type === 'string') return STRING_KEYWORDS;
      if (value.type === 'integer' || value.type === 'number') return NUMERIC_KEYWORDS;
      if (value.type === 'boolean') return NO_KEYWORDS;
      return undefined;
    case 'literal':
      if (typeof value.value === 'string') return STRING_KEYWORDS;
      if (typeof value.value === 'number') return NUMERIC_KEYWORDS;
      return NO_KEYWORDS;
    case 'array':
      return ARRAY_KEYWORDS;
    case 'map':
      return OBJECT_KEYWORDS;
    case 'union': {
      const sets = value.variants.map(applicableKeywords);
      if (sets.some((set) => set === undefined)) return undefined;
      return new Set(sets.flatMap((set) => [...(set ?? [])]));
    }
    case 'model':
    case 'enum':
    case 'nullable':
      return undefined;
  }
  return assertNever(value);
}

/**
 * `limits` as the differ reads them for a value of `type`, for the
 * tightened judgement alone (`details` and the sides still carry the
 * keywords as the document wrote them): only the keywords that can
 * constrain the type (`applicableKeywords`) — a `maxLength` written on an
 * integer, legal in OpenAPI 3.1 and kept by the parser, rejects no integer,
 * so adding one is reported but tightens nothing (Greptile, #659 review
 * round 5) — and, on an integer, the exclusive bounds read as the
 * inclusive ones beside them (`integerBounds`).
 */
export function readLimits(limits: Constraints | undefined, type: TypeRef | undefined): Constraints | undefined {
  if (!limits) return undefined;
  const keep = applicableKeywords(type);
  const applicable = keep
    ? (Object.fromEntries(
        Object.entries(limits).filter(([keyword]) => keep.has(keyword as keyof Constraints)),
      ) as Constraints)
    : limits;
  return integerBounds(applicable, type);
}

/** A numeric bound as it admits a value: `exclusive` when the value itself is rejected. */
interface Bound {
  value: number;
  exclusive: boolean;
}

/**
 * The lower bound `minimum` and `exclusiveMinimum` make together: the
 * stricter of the two when both are declared — the exclusive one when it
 * is at or above the inclusive one (`v > 0` implies `v >= 0`), else the
 * inclusive one — or whichever is declared; `undefined` when neither is.
 */
function lowerBound(limits: Constraints | undefined): Bound | undefined {
  const [inclusive, exclusive] = [limits?.minimum, limits?.exclusiveMinimum];
  if (exclusive !== undefined && (inclusive === undefined || exclusive >= inclusive)) {
    return { value: exclusive, exclusive: true };
  }
  return inclusive === undefined ? undefined : { value: inclusive, exclusive: false };
}

/** The upper bound `maximum` and `exclusiveMaximum` make together, as `lowerBound` reads the lower one: the exclusive one when it is at or below the inclusive one. */
function upperBound(limits: Constraints | undefined): Bound | undefined {
  const [inclusive, exclusive] = [limits?.maximum, limits?.exclusiveMaximum];
  if (exclusive !== undefined && (inclusive === undefined || exclusive <= inclusive)) {
    return { value: exclusive, exclusive: true };
  }
  return inclusive === undefined ? undefined : { value: inclusive, exclusive: false };
}

/** Whether `after` admits fewer values than `before` on its side: a bound where there was none, one moved inward, or the same value made exclusive. */
function boundTightened(before: Bound | undefined, after: Bound | undefined, side: 'lower' | 'upper'): boolean {
  if (!after) return false;
  if (!before) return true;
  if (after.value !== before.value) return side === 'lower' ? after.value > before.value : after.value < before.value;
  return after.exclusive && !before.exclusive;
}

type DependentRequired = NonNullable<Constraints['dependentRequired']>;

/** Whether some property of `after` requires a name `before` did not require with it (a property `before` lacks included). */
function dependentRequiredTightened(before: DependentRequired, after: DependentRequired): boolean {
  return Object.entries(after).some(([property, names]) => {
    const was = new Set(own(before, property) ?? []);
    return names.some((name) => !was.has(name));
  });
}

/** Whether two levels carry the same limits, keyword by keyword (`sameKeyword`). */
function sameConstraints(a: Constraints | undefined, b: Constraints | undefined): boolean {
  return KEYWORDS.every((keyword) => sameKeyword(keyword, a?.[keyword], b?.[keyword]));
}

/** Whether a keyword reads the same on both sides: by value, or for `dependentRequired` as a map of sets. */
function sameKeyword(keyword: keyof Constraints, x: unknown, y: unknown): boolean {
  if (keyword !== 'dependentRequired') return x === y;
  if (x === undefined || y === undefined) return x === y;
  const [a, b] = [x as DependentRequired, y as DependentRequired];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.every((property) => {
    const [p, q] = [own(a, property), own(b, property)];
    if (!p || !q) return p === q;
    const names = new Set(p);
    return q.every((name) => names.has(name)) && p.every((name) => q.includes(name));
  });
}

/** `map[key]` for an own key, so a property spelled like an inherited one (`constructor`) is read from the document alone. */
function own(map: DependentRequired, key: string): string[] | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * A keyword's value as `details` prints it: `<unset>` for none, a `pattern`
 * verbatim in single quotes, `dependentRequired` as JSON with its
 * properties and names sorted (so two documents that list them in another
 * order print alike), a number or boolean as written.
 */
function renderKeyword(keyword: keyof Constraints, value: unknown): string {
  if (value === undefined) return '<unset>';
  if (keyword === 'pattern') return `'${String(value)}'`;
  if (keyword === 'dependentRequired') {
    const map = value as DependentRequired;
    const sorted = Object.keys(map)
      .sort()
      .map((property) => [property, [...(own(map, property) ?? [])].sort()]);
    return JSON.stringify(Object.fromEntries(sorted));
  }
  return String(value);
}

/** The site's own limits: a field's, parameter's or model's `constraints`, else its type's (a response header's, a variant's). */
function siteLimits(site: ConstrainedSite): Constraints | undefined {
  return site.constraints ?? (site.type ? limitsOf(site.type) : undefined);
}

/** The limits `ref` carries, read through every nullable wrapper, whose `inner` carries the value's. */
function limitsOf(ref: TypeRef): Constraints | undefined {
  return typeRefConstraints(unwrap(ref));
}

/** `ref` with every nullable wrapper taken off: the type whose limits are the value's. */
function unwrap(ref: TypeRef): TypeRef {
  return ref.kind === 'nullable' ? unwrap(ref.inner) : ref;
}

/**
 * Which old variant each new variant's limits are compared with, by the
 * new variant's index: the first old variant not yet paired that is the
 * same type — `typeRefsEqual`, or a union (bare or under the same wrapper)
 * the new variant only widened (`addedUnionVariants`), so the kept
 * variants of a widened inner union are still compared, as
 * `addedUnionVariants` keeps the widening additive (Greptile, #659 review
 * round 1) — and carries the same limits at every level, else the first
 * unpaired one of the same type. The first pass runs over every new
 * variant before the second, so two variants of one type that differ only
 * in their limits (`anyOf: [{ type: string, pattern: '^pet_' }, { type:
 * string }]`) each find their own whatever order the document lists them
 * in, and a reorder reports nothing; a new variant no old variant has the
 * type of — one added, which the type change or `variant-added` reports —
 * pairs with nothing, and an old one left over is one removed.
 * `typeRefsEqual` passes over limits, so this is what tells a kept variant
 * whose `pattern` moved from one that was swapped for another type. `memo`
 * is the comparison's own (`PairMemo`); a direct caller may leave it out.
 */
export function pairVariants(
  oldVariants: readonly TypeRef[],
  newVariants: readonly TypeRef[],
  memo: PairMemo = new WeakMap(),
): Map<number, TypeRef> {
  const pairs = new Map<number, TypeRef>();
  const taken = new Set<number>();
  const sameType = (old: TypeRef, variant: TypeRef): boolean =>
    typeRefsEqual(old, variant) || addedUnionVariants(old, variant) !== undefined;
  // The old variants each new one may pair with, by index, read once per pair.
  const candidates = newVariants.map((variant) => oldVariants.flatMap((old, k) => (sameType(old, variant) ? [k] : [])));
  const claim = (i: number, accept: (old: TypeRef) => boolean): void => {
    const j = candidates[i].find((k) => !taken.has(k) && accept(oldVariants[k]));
    if (j === undefined) return;
    taken.add(j);
    pairs.set(i, oldVariants[j]);
  };
  newVariants.forEach((variant, i) => claim(i, (old) => typeLevels('', old, variant, memo).length === 0));
  newVariants.forEach((_, i) => {
    if (!pairs.has(i)) claim(i, () => true);
  });
  return new Map([...pairs].sort(([a], [b]) => a - b));
}
