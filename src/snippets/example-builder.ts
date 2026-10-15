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
 *   - Numbers start at the inclusive `minimum`, else one step past the
 *     `exclusiveMinimum`, else at the inclusive `maximum`, else one step
 *     below the `exclusiveMaximum`, else `1`; a step is `multipleOf` when
 *     declared, otherwise `1`. The result is rounded up to the next
 *     `multipleOf` and kept integral for `integer`. When the bounds are
 *     contradictory (the candidate overshoots the upper bound) the lower
 *     bound is returned as is.
 *   - Plain strings are padded (by repeating the sample) to `minLength` and
 *     truncated to `maxLength`; format-driven values (`date-time`, `email`,
 *     `uuid`, ...) are never touched. A `pattern` is not synthesized: the
 *     sample is kept even when it does not match, since generating a string
 *     from an arbitrary regex is out of scope.
 *   - Arrays emit `max(1, minItems)` items capped at `maxItems` (an explicit
 *     `maxItems: 0` gives `[]`). Under `uniqueItems`, generated primitives
 *     vary by index (strings get the index appended, numbers get it added)
 *     so the items are distinct; enum, literal and model items are not
 *     varied.
 *   - Maps emit `max(1, minProperties)` entries capped at `maxProperties`:
 *     one entry keeps the `key` name, more are `key1`, `key2`, ...
 *   - Model-level `minProperties` / `maxProperties` are ignored: every
 *     non-deprecated, non-readOnly field is emitted anyway.
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

export function createExampleBuilder(spec: ApiSpec): ExampleBuilder {
  const modelsByName = new Map<string, Model>();
  for (const m of spec.models) modelsByName.set(m.name, m);
  const enumsByName = new Map<string, Enum>();
  for (const e of spec.enums) enumsByName.set(e.name, e);

  /**
   * `seed` distinguishes sibling items of a `uniqueItems` array: it is
   * appended to generated strings and added to generated numbers. `0` leaves
   * the value as is.
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
    const count = countWithin(constraints?.minItems, constraints?.maxItems);
    const vary = constraints?.uniqueItems === true && count > 1;
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

/** `max(1, min)` capped at `max`; an explicit `max: 0` yields `0`. */
function countWithin(min: number | undefined, max: number | undefined): number {
  let count = Math.max(1, min ?? 0);
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
      return true;
    case 'unknown':
    default:
      return null;
  }
}

const STRING_SAMPLE = 'string_example';

/**
 * Format-driven samples are returned untouched. The plain sample is clamped
 * to `minLength` / `maxLength`; when both conflict, `maxLength` wins so the
 * result at least fits. A `pattern` is deliberately not honored.
 */
function stringExample(format: string | undefined, constraints?: Constraints, seed = 0): string {
  if (format === 'date-time') return '2026-01-15T12:00:00.000Z';
  if (format === 'date') return '2026-01-15';
  if (format === 'email') return 'user@example.com';
  if (format === 'uri' || format === 'url') return 'https://example.com';
  if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';

  const suffix = seed > 0 ? String(seed) : '';
  let value = STRING_SAMPLE;
  const minLength = constraints?.minLength;
  if (minLength !== undefined && value.length + suffix.length < minLength) {
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

/**
 * A number inside the declared bounds — see the `ExampleBuilder` doc for the
 * anchor order. `step` is `multipleOf` when declared, otherwise `1`, so one
 * step past an exclusive bound is itself a valid multiple.
 */
function numberExample(integer: boolean, constraints?: Constraints): number {
  if (!constraints) return 1;
  const { minimum, exclusiveMinimum, maximum, exclusiveMaximum, multipleOf } = constraints;
  const step = multipleOf !== undefined && multipleOf > 0 ? multipleOf : 1;

  const lower = minimum ?? (exclusiveMinimum !== undefined ? exclusiveMinimum + step : undefined);
  const upper = maximum ?? (exclusiveMaximum !== undefined ? exclusiveMaximum - step : undefined);

  let candidate = lower ?? upper ?? 1;
  if (multipleOf !== undefined && multipleOf > 0) candidate = ceilToMultiple(candidate, multipleOf);
  if (integer && !Number.isInteger(candidate)) candidate = Math.ceil(candidate);
  if (upper !== undefined && candidate > upper) {
    // Contradictory bounds (or a multipleOf that cannot fit): fall back to the
    // lower bound rather than inventing a value outside every limit.
    return lower ?? candidate;
  }
  return candidate;
}

/** Smallest multiple of `m` that is >= `value`, with floating-point noise trimmed. */
function ceilToMultiple(value: number, m: number): number {
  const k = Math.ceil(value / m - 1e-9);
  return Number((k * m).toPrecision(12));
}
