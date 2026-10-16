import type { ApiSpec, ArrayType, Constraints, Enum, Field, MapType, Model, Parameter, TypeRef } from '../ir/types.js';

/**
 * Builds illustrative example values for IR types. Used by snippet emitters
 * to produce realistic argument values in call-site samples.
 *
 * Values prefer, in order:
 *   1. An explicit `example` carried on the field/param.
 *   2. The `default` from the schema.
 *   3. The first enum value, when the type is an enum.
 *   4. A type-driven value (e.g. `"string_example"`, `1`, `true`), generated
 *      inside the field's/param's `constraints` when it carries any.
 *
 * A document-given `example` or `default` is returned verbatim, never
 * adjusted, even when it violates a limit the same document declares: the
 * author's value is the better illustration, and a snippet is not a
 * validator. Only generated values are shaped by `constraints`:
 *
 *   - Numbers are chosen to satisfy every declared bound and `multipleOf`:
 *     with only a lower bound, the smallest value at or just past it (rounded
 *     up to the next multiple); with only an upper bound, the largest value
 *     at or just below it (rounded down); with both, the smallest integer
 *     inside for `integer` and the midpoint for `number`, snapped to a
 *     multiple inside the range; with none, `1` (or the first multiple).
 *     Only when no value can satisfy the limits together (contradictory
 *     bounds, or no multiple between them) is the lower bound returned as
 *     is.
 *   - Plain strings are padded (by repeating the sample) to `minLength` and
 *     truncated to `maxLength`; format-driven values (`date-time`, `email`,
 *     `uuid`, ...) are never touched. A `pattern` is not synthesized: the
 *     sample is kept even when it does not match, since generating a string
 *     from an arbitrary regex is out of scope.
 *   - Arrays emit `max(1, minItems)` items capped at `maxItems` (an explicit
 *     `maxItems: 0` gives `[]`). Under `uniqueItems`, generated primitives
 *     vary by index (strings get the index appended, numbers get it added,
 *     booleans alternate — so a unique boolean array holds at most two
 *     items); enum, literal and model items are not varied.
 *   - Maps emit `max(1, minProperties)` entries capped at `maxProperties`:
 *     one entry keeps the `key` name, more are `key1`, `key2`, ...
 *   - Model-level `minProperties` / `maxProperties` are ignored: every
 *     non-deprecated, non-readOnly field is emitted anyway.
 *
 * Snippets are illustrative, so generation has a size budget: at most
 * {@link MAX_GENERATED_LENGTH} characters per string and
 * {@link MAX_GENERATED_ITEMS} items per array or entries per map. A
 * `minLength`, `minItems` or `minProperties` above the budget yields the
 * capped size — a readable sample rather than a conforming one.
 *
 * Limits nested inside array items or map values are not carried by the
 * IR, so items and values are generated unconstrained.
 *
 * Recursion through models/arrays/maps is depth-limited; cyclic models
 * collapse to a placeholder object rather than blowing the stack.
 */
export interface ExampleBuilder {
  /**
   * Build an example value for a single type reference (no field metadata),
   * generated inside `constraints` when given.
   */
  forType(type: TypeRef, constraints?: Constraints): unknown;
  /** Build an example value for a field, honoring its `example`/`default` and `constraints`. */
  forField(field: Field): unknown;
  /** Build an example value for a parameter, honoring its `example`/`default` and `constraints`. */
  forParameter(param: Parameter): unknown;
  /** Build an example object from a model, keyed by field wire name. */
  forModel(model: Model | string): Record<string, unknown>;
}

const MAX_DEPTH = 6;
/** Longest generated string; a larger `minLength` is capped here. */
export const MAX_GENERATED_LENGTH = 64;
/** Most generated array items or map entries; a larger `minItems` / `minProperties` is capped here. */
export const MAX_GENERATED_ITEMS = 8;

export function createExampleBuilder(spec: ApiSpec): ExampleBuilder {
  const modelsByName = new Map<string, Model>();
  for (const m of spec.models) modelsByName.set(m.name, m);
  const enumsByName = new Map<string, Enum>();
  for (const e of spec.enums) enumsByName.set(e.name, e);

  /**
   * `seed` distinguishes sibling items of a `uniqueItems` array: it is
   * appended to generated strings, added to generated numbers and alternates
   * generated booleans. `0` leaves the value as is.
   */
  function buildForType(type: TypeRef, depth: number, constraints?: Constraints, seed = 0): unknown {
    if (depth > MAX_DEPTH) return null;

    switch (type.kind) {
      case 'primitive':
        return primitiveExample(type.type, type.format, constraints, seed);
      case 'literal':
        return type.value;
      case 'enum': {
        if (type.values && type.values.length > 0) return type.values[0];
        const e = enumsByName.get(type.name);
        return e?.values[0]?.value ?? null;
      }
      case 'array':
        return arrayExample(type, depth, constraints);
      case 'nullable':
        return buildForType(type.inner, depth, constraints, seed);
      case 'union': {
        const first = type.variants[0];
        return first ? buildForType(first, depth, constraints, seed) : null;
      }
      case 'map':
        return mapExample(type, depth, constraints);
      case 'model':
        return buildForModel(type.name, depth + 1);
      default:
        return null;
    }
  }

  function arrayExample(type: ArrayType, depth: number, constraints?: Constraints): unknown[] {
    let count = countWithin(constraints?.minItems, constraints?.maxItems);
    const vary = constraints?.uniqueItems === true && count > 1;
    // Booleans only have two distinct values, so a unique boolean array
    // cannot hold more than two items.
    if (vary && isBooleanType(type.items)) count = Math.min(count, 2);
    const items: unknown[] = [];
    for (let i = 0; i < count; i++) {
      items.push(buildForType(type.items, depth + 1, undefined, vary ? i : 0));
    }
    return items;
  }

  function mapExample(type: MapType, depth: number, constraints?: Constraints): Record<string, unknown> {
    const count = countWithin(constraints?.minProperties, constraints?.maxProperties);
    const result: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      const key = count === 1 ? 'key' : `key${i + 1}`;
      result[key] = buildForType(type.valueType, depth + 1);
    }
    return result;
  }

  function buildForModel(nameOrModel: string | Model, depth: number): Record<string, unknown> {
    if (depth > MAX_DEPTH) return {};
    const model = typeof nameOrModel === 'string' ? modelsByName.get(nameOrModel) : nameOrModel;
    if (!model) return {};

    // Model-level minProperties / maxProperties are not consulted: every
    // non-deprecated, non-readOnly field is emitted regardless.
    const result: Record<string, unknown> = {};
    for (const field of model.fields) {
      if (field.deprecated || field.readOnly) continue;
      result[field.name] = buildForField(field, depth);
    }
    return result;
  }

  function buildForField(field: Field, depth: number): unknown {
    if (field.example !== undefined) return field.example;
    if (field.default !== undefined) return field.default;
    return buildForType(field.type, depth, field.constraints);
  }

  function buildForParameter(param: Parameter): unknown {
    if (param.example !== undefined) return param.example;
    if (param.default !== undefined) return param.default;
    return buildForType(param.type, 0, param.constraints);
  }

  return {
    forType: (type, constraints) => buildForType(type, 0, constraints),
    forField: (field) => buildForField(field, 0),
    forParameter: (param) => buildForParameter(param),
    forModel: (model) => buildForModel(model, 0),
  };
}

/** True for a boolean primitive, looking through `nullable`. */
function isBooleanType(type: TypeRef): boolean {
  if (type.kind === 'nullable') return isBooleanType(type.inner);
  return type.kind === 'primitive' && type.type === 'boolean';
}

/**
 * `max(1, min)` capped at the size budget and then at `max`; an explicit
 * `max: 0` yields `0`.
 */
function countWithin(min: number | undefined, max: number | undefined): number {
  let count = Math.min(Math.max(1, min ?? 0), MAX_GENERATED_ITEMS);
  if (max !== undefined) count = Math.min(count, max);
  return Math.max(0, Math.floor(count));
}

function primitiveExample(type: string, format: string | undefined, constraints?: Constraints, seed = 0): unknown {
  switch (type) {
    case 'string':
      return stringExample(format, constraints, seed);
    case 'integer':
      return numberExample(true, constraints) + seed;
    case 'number':
      return numberExample(false, constraints) + seed;
    case 'boolean':
      return seed % 2 === 0;
    case 'unknown':
    default:
      return null;
  }
}

const STRING_SAMPLE = 'string_example';

/**
 * Format-driven samples are returned untouched. The plain sample is padded
 * to `minLength` (within the size budget) and truncated to `maxLength`;
 * when both conflict, `maxLength` wins so the result at least fits. A
 * `pattern` is deliberately not honored.
 */
function stringExample(format: string | undefined, constraints?: Constraints, seed = 0): string {
  if (format === 'date-time') return '2026-01-15T12:00:00.000Z';
  if (format === 'date') return '2026-01-15';
  if (format === 'email') return 'user@example.com';
  if (format === 'uri' || format === 'url') return 'https://example.com';
  if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';

  const suffix = seed > 0 ? String(seed) : '';
  let value = STRING_SAMPLE;
  const minLength = Math.min(constraints?.minLength ?? 0, MAX_GENERATED_LENGTH);
  if (value.length + suffix.length < minLength) {
    const missing = minLength - value.length - suffix.length;
    value += STRING_SAMPLE.repeat(Math.ceil(missing / STRING_SAMPLE.length)).slice(0, missing);
  }
  const maxLength = constraints?.maxLength;
  if (maxLength !== undefined && value.length + suffix.length > maxLength) {
    // Keep the distinguishing suffix when there is room for it.
    value = value.slice(0, Math.max(0, maxLength - suffix.length));
  }
  return (value + suffix).slice(0, maxLength ?? Infinity);
}

/** The tighter of an inclusive and an exclusive bound on one side, and whether that edge is exclusive. */
interface Edge {
  value: number;
  exclusive: boolean;
}

function edge(inclusive: number | undefined, exclusive: number | undefined, side: 'low' | 'high'): Edge | undefined {
  if (inclusive === undefined && exclusive === undefined) return undefined;
  if (inclusive === undefined) return { value: exclusive!, exclusive: true };
  if (exclusive === undefined) return { value: inclusive, exclusive: false };
  // Both declared (legal in 3.1): the exclusive one is the tighter edge when
  // it is at or inside the inclusive one.
  const exclusiveIsTighter = side === 'low' ? exclusive >= inclusive : exclusive <= inclusive;
  return exclusiveIsTighter ? { value: exclusive, exclusive: true } : { value: inclusive, exclusive: false };
}

/**
 * A number inside the declared bounds and on the declared `multipleOf` —
 * see the `ExampleBuilder` doc for the anchor rules. Candidates are tried
 * in order and the first that satisfies every limit wins; only when none
 * does is the lower bound returned as is.
 */
function numberExample(integer: boolean, constraints?: Constraints): number {
  if (!constraints) return 1;
  const multipleOf =
    constraints.multipleOf !== undefined && constraints.multipleOf > 0 ? constraints.multipleOf : undefined;
  const low = edge(constraints.minimum, constraints.exclusiveMinimum, 'low');
  const high = edge(constraints.maximum, constraints.exclusiveMaximum, 'high');

  // How far to move off an exclusive edge: the multiple when there is one,
  // one for integers, half the range when both sides are bounded, else one.
  const step = multipleOf ?? (integer ? 1 : low && high ? (high.value - low.value) / 2 : 1);

  const pastLow = (): number => {
    const l = low!;
    if (multipleOf !== undefined) {
      const v = ceilToMultiple(l.value, multipleOf);
      return l.exclusive && v <= l.value ? trim(v + multipleOf) : v;
    }
    if (integer) return l.exclusive ? Math.floor(l.value) + 1 : Math.ceil(l.value);
    return l.exclusive ? trim(l.value + step) : l.value;
  };
  const belowHigh = (): number => {
    const h = high!;
    if (multipleOf !== undefined) {
      const v = floorToMultiple(h.value, multipleOf);
      return h.exclusive && v >= h.value ? trim(v - multipleOf) : v;
    }
    if (integer) return h.exclusive ? Math.ceil(h.value) - 1 : Math.floor(h.value);
    return h.exclusive ? trim(h.value - step) : h.value;
  };

  const candidates: number[] = [];
  if (low && high) {
    if (integer) {
      candidates.push(pastLow());
    } else {
      const mid = (low.value + high.value) / 2;
      candidates.push(multipleOf !== undefined ? roundToMultiple(mid, multipleOf) : trim(mid), pastLow(), belowHigh());
    }
  } else if (low) {
    candidates.push(pastLow());
  } else if (high) {
    candidates.push(belowHigh());
  } else {
    candidates.push(multipleOf !== undefined ? ceilToMultiple(1, multipleOf) : 1);
  }

  for (const v of candidates) {
    if (satisfies(v, constraints, integer, multipleOf)) return v;
  }
  // Nothing satisfies every limit at once: contradictory bounds, or no
  // multiple between them. Fall back to the lower bound rather than inventing
  // a value that violates every limit; the snippet stays illustrative.
  if (!low) return candidates[0];
  const lower = low.exclusive ? trim(low.value + step) : low.value;
  return integer ? Math.ceil(lower) : lower;
}

function satisfies(v: number, c: Constraints, integer: boolean, multipleOf: number | undefined): boolean {
  if (!Number.isFinite(v)) return false;
  if (integer && !Number.isInteger(v)) return false;
  if (c.minimum !== undefined && v < c.minimum) return false;
  if (c.exclusiveMinimum !== undefined && v <= c.exclusiveMinimum) return false;
  if (c.maximum !== undefined && v > c.maximum) return false;
  if (c.exclusiveMaximum !== undefined && v >= c.exclusiveMaximum) return false;
  if (multipleOf !== undefined) {
    const q = v / multipleOf;
    if (Math.abs(q - Math.round(q)) > 1e-9) return false;
  }
  return true;
}

/** Smallest multiple of `m` that is >= `value`. */
function ceilToMultiple(value: number, m: number): number {
  return trim(Math.ceil(value / m - 1e-9) * m);
}

/** Largest multiple of `m` that is <= `value`. */
function floorToMultiple(value: number, m: number): number {
  return trim(Math.floor(value / m + 1e-9) * m);
}

/** Nearest multiple of `m` to `value`. */
function roundToMultiple(value: number, m: number): number {
  return trim(Math.round(value / m) * m);
}

/** Trim floating-point noise (`0.30000000000000004` → `0.3`). */
function trim(value: number): number {
  return Number(value.toPrecision(12));
}
