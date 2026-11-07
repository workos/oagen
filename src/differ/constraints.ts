import type { Constraints, TypeRef } from '../ir/types.js';
import { typeRefConstraints } from '../ir/types.js';
import { typeRefsEqual } from './models.js';

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
   * `valueType.maxLength`, `variants[1].minimum`, `items.items.maxLength`).
   */
  details: string;
  /** Whether some keyword was tightened (`keywordTightened`): a value the old limits admitted can now be rejected. */
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

/** Keywords that bound a value from above: lowered is tighter, raised looser. */
const UPPER_BOUNDS: ReadonlySet<keyof Constraints> = new Set([
  'maximum',
  'exclusiveMaximum',
  'maxLength',
  'maxItems',
  'maxContains',
  'maxProperties',
]);

/** Keywords that bound a value from below: raised is tighter, lowered looser. */
const LOWER_BOUNDS: ReadonlySet<keyof Constraints> = new Set([
  'minimum',
  'exclusiveMinimum',
  'minLength',
  'minItems',
  'minContains',
  'minProperties',
]);

/**
 * How the limits a site carries differ between the two specs, or
 * `undefined` when they do not (#599). The site's own keywords are compared
 * first — a field's or parameter's `constraints`, which equal its type's
 * (under a nullable wrapper) whenever the type can carry them, else the
 * type's own; a response header's or a variant's type's, since neither
 * carries any of its own; a model's own, which has no type — and then,
 * while both sides have a type, the limits the type carries at every level
 * under it, in lockstep: an array's `items`, a map's `valueType`, a union's
 * variants (paired by `pairVariants`), through every nullable wrapper, whose
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
 * whether any of them was (`keywordTightened`). `oldConstraints` /
 * `newConstraints` are the site's own, each present when it declares any on
 * that side, so a change on a nested level alone carries two equal sides
 * (or none) and names the level in `details`.
 */
export function constraintsShift(oldSite: ConstrainedSite, newSite: ConstrainedSite): ConstraintsShift | undefined {
  const moves: string[] = [];
  let tightened = false;
  const compare = (path: string, before: Constraints | undefined, after: Constraints | undefined): void => {
    for (const keyword of KEYWORDS) {
      const [x, y] = [before?.[keyword], after?.[keyword]];
      if (sameKeyword(keyword, x, y)) continue;
      moves.push(`${path}${keyword} ${renderKeyword(keyword, x)} → ${renderKeyword(keyword, y)}`);
      if (keywordTightened(keyword, x, y)) tightened = true;
    }
  };
  const walk = (path: string, before: TypeRef, after: TypeRef): void => {
    const [a, b] = [unwrap(before), unwrap(after)];
    if (a.kind === 'array' && b.kind === 'array') {
      compare(`${path}items.`, limitsOf(a.items), limitsOf(b.items));
      walk(`${path}items.`, a.items, b.items);
    } else if (a.kind === 'map' && b.kind === 'map') {
      compare(`${path}valueType.`, limitsOf(a.valueType), limitsOf(b.valueType));
      walk(`${path}valueType.`, a.valueType, b.valueType);
    } else if (a.kind === 'union' && b.kind === 'union') {
      for (const [i, old] of pairVariants(a.variants, b.variants)) {
        const variant = b.variants[i];
        compare(`${path}variants[${i}].`, limitsOf(old), limitsOf(variant));
        walk(`${path}variants[${i}].`, old, variant);
      }
    }
  };

  const oldConstraints = siteLimits(oldSite);
  const newConstraints = siteLimits(newSite);
  compare('', oldConstraints, newConstraints);
  if (oldSite.type && newSite.type) walk('', oldSite.type, newSite.type);
  if (moves.length === 0) return undefined;
  return {
    ...(oldConstraints ? { oldConstraints } : {}),
    ...(newConstraints ? { newConstraints } : {}),
    details: moves.join('; '),
    tightened,
  };
}

/**
 * Whether a keyword's move from `oldValue` to `newValue` rejects a value the
 * old declaration admitted. A keyword added is tightened and one removed
 * loosened, whichever it is: every keyword admits fewer values than none. A
 * changed upper bound is tightened when lowered and a changed lower bound
 * when raised; a changed `pattern` or `multipleOf` is tightened, since the
 * new value admits other values than the old in general (a pattern
 * rewritten, a multiple the old one does not divide); `uniqueItems` is
 * tightened when it becomes `true`; `dependentRequired` when a property
 * gains a name or a property is listed that was not, even if another loses
 * one — something was tightened, so a value can be rejected.
 */
export function keywordTightened(keyword: keyof Constraints, oldValue: unknown, newValue: unknown): boolean {
  if (newValue === undefined) return false;
  if (oldValue === undefined) return true;
  if (UPPER_BOUNDS.has(keyword)) return (newValue as number) < (oldValue as number);
  if (LOWER_BOUNDS.has(keyword)) return (newValue as number) > (oldValue as number);
  if (keyword === 'uniqueItems') return newValue === true;
  if (keyword === 'dependentRequired') {
    return dependentRequiredTightened(oldValue as DependentRequired, newValue as DependentRequired);
  }
  // `pattern` and `multipleOf`: changed is tightened.
  return true;
}

type DependentRequired = NonNullable<Constraints['dependentRequired']>;

/** Whether some property of `after` requires a name `before` did not require with it (a property `before` lacks included). */
function dependentRequiredTightened(before: DependentRequired, after: DependentRequired): boolean {
  return Object.entries(after).some(([property, names]) => {
    const was = new Set(own(before, property) ?? []);
    return names.some((name) => !was.has(name));
  });
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
 * new variant's index: the first old variant not yet paired that
 * `typeRefsEqual` reads as the same type and that carries the same limits
 * at every level, else the first unpaired one of the same type. The first
 * pass runs over every new variant before the second, so two variants of
 * one type that differ only in their limits (`anyOf: [{ type: string,
 * pattern: '^pet_' }, { type: string }]`) each find their own whatever
 * order the document lists them in, and a reorder reports nothing; a new
 * variant no old variant has the type of — one added, which the type
 * change or `variant-added` reports — pairs with nothing, and an old one
 * left over is one removed. `typeRefsEqual` passes over limits, so this is
 * what tells a kept variant whose `pattern` moved from one that was swapped
 * for another type.
 */
export function pairVariants(oldVariants: readonly TypeRef[], newVariants: readonly TypeRef[]): Map<number, TypeRef> {
  const pairs = new Map<number, TypeRef>();
  const taken = new Set<number>();
  const claim = (i: number, accept: (old: TypeRef) => boolean): void => {
    const j = oldVariants.findIndex((old, k) => !taken.has(k) && typeRefsEqual(old, newVariants[i]) && accept(old));
    if (j === -1) return;
    taken.add(j);
    pairs.set(i, oldVariants[j]);
  };
  newVariants.forEach((variant, i) =>
    claim(i, (old) => constraintsShift({ type: old }, { type: variant }) === undefined),
  );
  newVariants.forEach((_, i) => {
    if (!pairs.has(i)) claim(i, () => true);
  });
  return new Map([...pairs].sort(([a], [b]) => a - b));
}
