import type { Constraints, TypeRef } from '../ir/types.js';
import { typeRefConstraints } from '../ir/types.js';
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
  /** Whether the limits tightened at some level (`constraintsTightened`): a value the old limits admitted can now be rejected. */
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

/** Keywords that bound a value from above on their own: lowered is tighter, raised looser. */
const UPPER_BOUNDS: ReadonlySet<keyof Constraints> = new Set(['maxLength', 'maxItems', 'maxContains', 'maxProperties']);

/**
 * Keywords that bound a value from below on their own, each with the value
 * its absence means (JSON Schema's default: a string, an array or an
 * object may be empty, and `contains` must match once), read in its place
 * on either side: raised is tighter and lowered looser, so one added at its
 * default — `minLength: 0`, which the parser keeps as written — rejects
 * nothing (Greptile, #659 review round 2) and `minContains: 0` removed
 * requires one match again (round 3).
 */
const LOWER_BOUNDS: ReadonlyMap<keyof Constraints, number> = new Map([
  ['minLength', 0],
  ['minItems', 0],
  ['minContains', 1],
  ['minProperties', 0],
]);

/**
 * One level of a site where the limits differ: the path to it (`''` for the
 * site's own, `items.`, `variants[1].items.`) and the limits on each side,
 * both carried so the level is judged as a whole (`constraintsTightened`
 * reads `minimum` and `exclusiveMinimum` together).
 */
interface LevelShift {
  path: string;
  before?: Constraints;
  after?: Constraints;
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
    levels.push({ path: '', before: oldConstraints, after: newConstraints });
  }
  if (oldSite.type && newSite.type) levels.push(...childLevels('', oldSite.type, newSite.type, memo));
  if (levels.length === 0) return undefined;
  return {
    ...(oldConstraints ? { oldConstraints } : {}),
    ...(newConstraints ? { newConstraints } : {}),
    details: levels.flatMap(renderLevel).join('; '),
    tightened: levels.some((level) => constraintsTightened(level.before, level.after)),
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
    if (!sameConstraints(x, y)) levels.push({ path: '', before: x, after: y });
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
 * Every other keyword is judged on its own (`keywordTightened`), and the
 * level is tightened when any of them is.
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
 * old declaration admitted. A lower bound (`minLength`, `minItems`,
 * `minProperties`, `minContains`; `LOWER_BOUNDS`) is read on each side as
 * the value its absence means when it is absent — JSON Schema's default,
 * `0`, and `1` for `minContains` — and is tightened when the new reading
 * is above the old: raised, added above its default, or removed from
 * below it (`minContains: 0` removed requires one match again; Greptile,
 * #659 review round 3), while one added at or removed from its default
 * (`minLength: 0`) is reported but rejects nothing (round 2).
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
