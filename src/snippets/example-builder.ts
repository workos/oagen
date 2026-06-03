import type { ApiSpec, Enum, Field, Model, TypeRef } from '../ir/types.js';

/**
 * Builds illustrative example values for IR types. Used by snippet emitters
 * to produce realistic argument values in call-site samples.
 *
 * Values prefer, in order:
 *   1. An explicit `example` carried on the field/param.
 *   2. The `default` from the schema.
 *   3. The first enum value, when the type is an enum.
 *   4. A type-driven default (e.g. `"string_example"`, `1`, `true`).
 *
 * Recursion through models/arrays/maps is depth-limited; cyclic models
 * collapse to a placeholder object rather than blowing the stack.
 */
export interface ExampleBuilder {
  /** Build an example value for a single type reference (no field metadata). */
  forType(type: TypeRef): unknown;
  /** Build an example value for a field, honoring its `example`/`default`. */
  forField(field: Field): unknown;
  /** Build an example object from a model, keyed by field wire name. */
  forModel(model: Model | string): Record<string, unknown>;
}

const MAX_DEPTH = 6;

export function createExampleBuilder(spec: ApiSpec): ExampleBuilder {
  const modelsByName = new Map<string, Model>();
  for (const m of spec.models) modelsByName.set(m.name, m);
  const enumsByName = new Map<string, Enum>();
  for (const e of spec.enums) enumsByName.set(e.name, e);

  function buildForType(type: TypeRef, depth: number): unknown {
    if (depth > MAX_DEPTH) return null;

    switch (type.kind) {
      case 'primitive':
        return primitiveExample(type.type, type.format);
      case 'literal':
        return type.value;
      case 'enum': {
        if (type.values && type.values.length > 0) return type.values[0];
        const e = enumsByName.get(type.name);
        return e?.values[0]?.value ?? null;
      }
      case 'array':
        return [buildForType(type.items, depth + 1)];
      case 'nullable':
        return buildForType(type.inner, depth);
      case 'union': {
        const first = type.variants[0];
        return first ? buildForType(first, depth) : null;
      }
      case 'map': {
        const key = 'key';
        const value = buildForType(type.valueType, depth + 1);
        return { [key]: value };
      }
      case 'model':
        return buildForModel(type.name, depth + 1);
      default:
        return null;
    }
  }

  function buildForModel(nameOrModel: string | Model, depth: number): Record<string, unknown> {
    if (depth > MAX_DEPTH) return {};
    const model = typeof nameOrModel === 'string' ? modelsByName.get(nameOrModel) : nameOrModel;
    if (!model) return {};

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
    return buildForType(field.type, depth);
  }

  return {
    forType: (type) => buildForType(type, 0),
    forField: (field) => buildForField(field, 0),
    forModel: (model) => buildForModel(model, 0),
  };
}

function primitiveExample(type: string, format?: string): unknown {
  switch (type) {
    case 'string':
      if (format === 'date-time') return '2026-01-15T12:00:00.000Z';
      if (format === 'date') return '2026-01-15';
      if (format === 'email') return 'user@example.com';
      if (format === 'uri' || format === 'url') return 'https://example.com';
      if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      return 'string_example';
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'unknown':
    default:
      return null;
  }
}
