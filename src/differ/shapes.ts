import type { ApiSpec, Enum, Model, TypeRef } from '../ir/types.js';
import { typeRefsEqual } from './models.js';

/** The named types of one document, so a body's model or enum ref can be read through to its shape. */
export interface DocumentTypes {
  models: ReadonlyMap<string, Model>;
  enums: ReadonlyMap<string, Enum>;
}

/**
 * The two documents' named types. `diffSpecs` supplies them so paired bodies
 * compare by shape (`sameShape`); a direct caller may leave them out, in
 * which case bodies compare by name alone, as `typeRefsEqual` does.
 */
export interface DocumentShapes {
  old: DocumentTypes;
  new: DocumentTypes;
}

export function documentTypes(spec: Pick<ApiSpec, 'models' | 'enums'>): DocumentTypes {
  return {
    models: new Map(spec.models.map((model) => [model.name, model])),
    enums: new Map(spec.enums.map((entry) => [entry.name, entry])),
  };
}

/** Field properties that only document a field — its extensions included; two shapes that differ in these alone are one shape. */
const FIELD_DOC_KEYS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'description',
  'externalDocs',
  'example',
  'examples',
  'extensions',
]);
/** Model properties outside its shape: the name, its documentation (extensions included), and what is compared on its own (fields, variants, discriminator). */
const MODEL_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'externalDocs',
  'extensions',
  'fields',
  'variants',
  'discriminator',
]);
/** Enum value properties that only document the value. */
const ENUM_VALUE_DOC_KEYS: ReadonlySet<string> = new Set(['description']);

/**
 * Whether two body types are one shape, whatever names they carry. A type
 * equal by name (`typeRefsEqual`) is one shape; otherwise a model ref is read
 * through to its model in its own document and compared field by field —
 * the same field names, each with the same requiredness, access flags,
 * deprecation, default and limits, and a type that is itself one shape, so
 * nested models and enums are read through too — plus the model's own
 * limits, type parameters, deprecation, variants (pairwise, in order) and
 * discriminator (property and mapped shapes); an enum ref is read through to
 * its values (name, value, deprecation). Documentation (descriptions, links,
 * examples) does not count. Without `shapes`, or for a name either document
 * lacks, the two refs are different shapes. A pair of models met again while
 * comparing their own fields (a self-referential shape) is taken as equal, so
 * the comparison terminates.
 *
 * This is what lets a body the parser names after its media type keep
 * comparing equal across a rename: a parameter edit on a key declared beside
 * another spelling of its essence (`application/yaml; version=1` →
 * `; version=3`) renames the model minted for it, and that rename is the
 * models diff's to report (`model-removed` + `model-added`), not a retype.
 */
export function sameShape(a: TypeRef, b: TypeRef, shapes?: DocumentShapes): boolean {
  return sameShapeWithin(a, b, shapes, new Set());
}

function sameShapeWithin(a: TypeRef, b: TypeRef, shapes: DocumentShapes | undefined, seen: Set<string>): boolean {
  if (typeRefsEqual(a, b)) return true;
  if (!shapes || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'model': {
      if (b.kind !== 'model') return false;
      const oldModel = shapes.old.models.get(a.name);
      const newModel = shapes.new.models.get(b.name);
      if (!oldModel || !newModel) return false;
      const pair = `model:${a.name}\u0000${b.name}`;
      if (seen.has(pair)) return true;
      seen.add(pair);
      return sameModelShape(oldModel, newModel, shapes, seen);
    }
    case 'enum': {
      if (b.kind !== 'enum') return false;
      const oldEnum = shapes.old.enums.get(a.name);
      const newEnum = shapes.new.enums.get(b.name);
      if (!oldEnum || !newEnum) return false;
      return sameEnumShape(oldEnum, newEnum);
    }
    case 'array':
      return b.kind === 'array' && sameShapeWithin(a.items, b.items, shapes, seen);
    case 'map':
      return b.kind === 'map' && sameShapeWithin(a.valueType, b.valueType, shapes, seen);
    case 'nullable':
      return b.kind === 'nullable' && sameShapeWithin(a.inner, b.inner, shapes, seen);
    case 'union':
      return (
        b.kind === 'union' &&
        sameVariants(a.variants, b.variants, shapes, seen) &&
        sameDiscriminator(a.discriminator, b.discriminator, shapes, seen)
      );
    default:
      // Primitives and literals are equal exactly when `typeRefsEqual` says so.
      return false;
  }
}

function sameModelShape(oldModel: Model, newModel: Model, shapes: DocumentShapes, seen: Set<string>): boolean {
  const oldFields = new Map(oldModel.fields.map((field) => [field.name, field]));
  const newFields = new Map(newModel.fields.map((field) => [field.name, field]));
  if (oldFields.size !== newFields.size) return false;
  for (const [name, oldField] of oldFields) {
    const newField = newFields.get(name);
    if (!newField) return false;
    if (stableStringify(omitKeys(oldField, FIELD_DOC_KEYS)) !== stableStringify(omitKeys(newField, FIELD_DOC_KEYS))) {
      return false;
    }
    if (!sameShapeWithin(oldField.type, newField.type, shapes, seen)) return false;
  }
  if (
    stableStringify(omitKeys(oldModel, MODEL_IDENTITY_KEYS)) !==
    stableStringify(omitKeys(newModel, MODEL_IDENTITY_KEYS))
  ) {
    return false;
  }
  if (!!oldModel.variants !== !!newModel.variants) return false;
  if (oldModel.variants && newModel.variants && !sameVariants(oldModel.variants, newModel.variants, shapes, seen)) {
    return false;
  }
  return sameDiscriminator(oldModel.discriminator, newModel.discriminator, shapes, seen);
}

function sameVariants(a: TypeRef[], b: TypeRef[], shapes: DocumentShapes, seen: Set<string>): boolean {
  return a.length === b.length && a.every((variant, i) => sameShapeWithin(variant, b[i], shapes, seen));
}

/** The same `property`, the same mapping keys, each mapped to one shape; absent on both sides is the same too. */
function sameDiscriminator(
  a: { property: string; mapping: Record<string, string> } | undefined,
  b: { property: string; mapping: Record<string, string> } | undefined,
  shapes: DocumentShapes,
  seen: Set<string>,
): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.property !== b.property) return false;
  const aKeys = Object.keys(a.mapping).sort();
  const bKeys = Object.keys(b.mapping).sort();
  if (aKeys.length !== bKeys.length || !aKeys.every((key, i) => key === bKeys[i])) return false;
  return aKeys.every((key) =>
    sameShapeWithin({ kind: 'model', name: a.mapping[key] }, { kind: 'model', name: b.mapping[key] }, shapes, seen),
  );
}

function sameEnumShape(a: Enum, b: Enum): boolean {
  const values = (entry: Enum): string =>
    entry.values
      .map((value) => stableStringify(omitKeys(value, ENUM_VALUE_DOC_KEYS)))
      .sort()
      .join('|');
  return values(a) === values(b) && (a.default ?? null) === (b.default ?? null) && !!a.deprecated === !!b.deprecated;
}

/** The entries of `value` whose key is not in `keys` and whose value is set. */
function omitKeys(value: object, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, entryValue]) => entryValue !== undefined && !keys.has(key)),
  );
}

/** `JSON.stringify` with object keys sorted and unset entries dropped, so equal shapes serialize equally. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
