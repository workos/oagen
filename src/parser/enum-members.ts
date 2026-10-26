import type { EnumRef, EnumValue, Extensions, ExternalDocs, TypeRef } from '../ir/types.js';
import { assertNever } from '../ir/types.js';
import { toUpperSnakeCase } from '../utils/naming.js';
import { readExternalDocs } from './external-docs.js';

/**
 * One member of an enum as the document declares it: the value, and the
 * documentation the document can attach to that one value — a `description`
 * (from the member's own `const` schema or an `x-enum-descriptions` /
 * `x-enumDescriptions` entry) and `deprecated: true` (from a `const` member
 * only; a plain `enum:` list has no per-value keyword). `enumMembersOf` in
 * `schemas.ts` reads them; `toEnumValue` turns one into the IR's `EnumValue`.
 */
export interface EnumMember {
  value: string | number;
  description?: string;
  /** Only ever `true`; the key is absent otherwise, as on every IR node. */
  deprecated?: boolean;
}

/**
 * What an inline enum ref carries besides its `values`, for the pass that
 * lifts it to a top-level `Enum`: each member's documentation, and the
 * `description` and link its schema declared. A side table rather than keys
 * on the ref: the ref is the field's or parameter's *type*, which the
 * sameness passes compare by serialization, and documentation is not shape
 * — it sits beside the type on the `Field`, not inside it. Per-value
 * deprecation is shape, though, so every pass that serializes a ref to
 * compare shapes reads it back through `shapeWithEnumFlags`. Keyed by
 * identity because every pass between building a ref and lifting it mutates
 * refs in place (renames, nullable wraps) and none clones them; an
 * unreachable ref drops out on its own.
 */
interface InlineEnumMeta {
  members: EnumMember[];
  description?: string;
  externalDocs?: ExternalDocs;
  /** The schema's own `x-*` keys, less the consumed ones (`extensionsOf`), read like its link. */
  extensions?: Extensions;
}

const inlineEnumMeta = new WeakMap<EnumRef, InlineEnumMeta>();

/** `raw` when it is a string with non-whitespace content, kept verbatim; `undefined` otherwise. */
function textWithContent(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}

/**
 * Build an inline `EnumRef` from its members, recording for the lift pass
 * their documentation and what the schema declares for the enum as a whole:
 * its `description` (`rawDescription`, kept when it is a string with
 * non-whitespace content, as `Model.description` is) and its link
 * (`rawExternalDocs`, when usable). The schema is the one that declares the
 * members — the `enum:` list or the `oneOf`/`anyOf` of consts — as the
 * caller hands it over: `schemaToTypeRef` passes a collapsed nullable or
 * single-member `allOf` wrapper's text and link onto its branch first
 * (`withWrapperDocs`), so both are read by one rule.
 */
export function inlineEnumRef(
  name: string,
  members: readonly EnumMember[],
  rawExternalDocs: unknown,
  rawDescription?: unknown,
  extensions?: Extensions,
): EnumRef {
  const ref: EnumRef = { kind: 'enum', name, values: members.map((member) => member.value) };
  const description = textWithContent(rawDescription);
  const externalDocs = readExternalDocs(rawExternalDocs);
  inlineEnumMeta.set(ref, {
    members: [...members],
    ...(description !== undefined ? { description } : {}),
    ...(externalDocs ? { externalDocs } : {}),
    // The schema's extensions, already read by the caller (`extensionsOf`,
    // the consumed keys left out), so the lifted enum carries them as it
    // carries the link.
    ...(extensions ? { extensions } : {}),
  });
  return ref;
}

/** The `description` recorded for an inline enum ref by `inlineEnumRef`; none for a ref built any other way, or from a schema whose text has no content. */
export function inlineEnumDescriptionOf(ref: EnumRef): string | undefined {
  return inlineEnumMeta.get(ref)?.description;
}

/** The link recorded for an inline enum ref by `inlineEnumRef`; none for a ref built any other way. */
export function inlineEnumExternalDocsOf(ref: EnumRef): ExternalDocs | undefined {
  return inlineEnumMeta.get(ref)?.externalDocs;
}

/** The extensions recorded for an inline enum ref by `inlineEnumRef`; none for a ref built any other way, or from a schema that declares none. */
export function inlineEnumExtensionsOf(ref: EnumRef): Extensions | undefined {
  return inlineEnumMeta.get(ref)?.extensions;
}

/** Give `to`, a copy of `from`, the members, description and link recorded for `from`: a copy made any other way is a bare name to every pass that reads them (`cloneTypeRef`). */
export function copyInlineEnumMeta(from: EnumRef, to: EnumRef): void {
  const meta = inlineEnumMeta.get(from);
  if (meta) inlineEnumMeta.set(to, { ...meta, members: [...meta.members] });
}

/** The IR's `EnumValue` for one member: the display name is the value's UPPER_SNAKE_CASE form; `description` and `deprecated` only when the member carries them. */
export function toEnumValue(member: EnumMember): EnumValue {
  return {
    name: toUpperSnakeCase(String(member.value)),
    value: member.value,
    ...(member.description !== undefined ? { description: member.description } : {}),
    ...(member.deprecated === true ? { deprecated: true } : {}),
  };
}

/**
 * The `EnumValue`s an inline enum ref lifts to: one per entry of its
 * `values`, in that order, each with the documentation `inlineEnumRef`
 * recorded for that position — by occurrence, not by value, so a repeated
 * `const` branch keeps its own description and flag, as the same schema under
 * `components.schemas` does. Should a ref's `values` no longer match the
 * recorded members one for one (nothing in the parser edits them), each
 * value takes the first member recorded for it. A ref built without
 * `inlineEnumRef` (a test's, a plugin's) lifts to bare values; a ref without
 * `values` (a component's) lifts to none.
 */
export function enumValuesOf(ref: EnumRef): EnumValue[] {
  const values = ref.values ?? [];
  const members = inlineEnumMeta.get(ref)?.members ?? [];
  const aligned = members.length === values.length && members.every((member, i) => member.value === values[i]);
  if (aligned) return members.map(toEnumValue);
  const first = new Map<string | number, EnumMember>();
  for (const member of members) if (!first.has(member.value)) first.set(member.value, member);
  return values.map((value) => toEnumValue(first.get(value) ?? { value }));
}

/**
 * The shape of one enum member, as a JSON text so no two members read alike:
 * `[value, deprecated]`, the value with its primitive type (the IR keeps
 * numeric `5` and string `"5"` distinct, and so do the emitters) and the flag
 * as a boolean — a live `"active!deprecated"` and a deprecated `"active"` are
 * `["active!deprecated",false]` and `["active",true]`. Two inline enums with
 * the same values are shared under one name only when they also deprecate
 * the same ones, so a field whose schema does not deprecate a value never
 * resolves to an enum that marks it. `description` is documentation, not
 * shape, and does not count — a value's, and the enum's own alike: the first
 * lifted copy's text wins, as its link does.
 */
export function enumValueShapeKey(value: Pick<EnumValue, 'value' | 'deprecated'>): string {
  return JSON.stringify([value.value, value.deprecated === true]);
}

/**
 * The shape of a whole member list, order-insensitive: the sorted
 * `enumValueShapeKey`s as one JSON array text, so a fingerprint that embeds
 * it cannot read one list as another.
 */
export function enumShapeKey(values: readonly Pick<EnumValue, 'value' | 'deprecated'>[]): string {
  return `[${values.map(enumValueShapeKey).sort().join(',')}]`;
}

/**
 * Order-insensitive: a reordering of the same members (`enumValueShapeKey`)
 * is the same type. Compared as complete sorted lists (`enumShapeKey`), not
 * as sets, so a repeated member counts each time it occurs: `[a, a!, b]`
 * and `[a, a, b]` are different types, and the second never shares the
 * first's deprecation.
 */
export function sameEnumShape(
  a: readonly Pick<EnumValue, 'value' | 'deprecated'>[],
  b: readonly Pick<EnumValue, 'value' | 'deprecated'>[],
): boolean {
  return enumShapeKey(a) === enumShapeKey(b);
}

/**
 * `ref` as a plain value for shape comparison: the same tree, with each
 * inline enum ref's deprecated values spelled out beside its `values`
 * (`deprecatedValues`, in `values` order, present only when there is one),
 * so a pass that serializes types to decide whether two models are one shape
 * — `modelFingerprint`, the merge passes' field and variant signatures, the
 * named-union shape key — sees what the side table holds, and two shapes
 * that differ only in a member's deprecation never serialize alike.
 * Descriptions are documentation and are not added. The result is not a
 * `TypeRef`: it is only ever serialized, never handed back to the IR.
 */
export function shapeWithEnumFlags(ref: TypeRef): unknown {
  switch (ref.kind) {
    case 'primitive':
    case 'literal':
    case 'model':
      return ref;
    case 'enum': {
      if (!ref.values) return ref;
      const deprecatedValues = enumValuesOf(ref)
        .filter((value) => value.deprecated === true)
        .map((value) => value.value);
      return deprecatedValues.length > 0 ? { ...ref, deprecatedValues } : ref;
    }
    case 'array':
      return { ...ref, items: shapeWithEnumFlags(ref.items) };
    case 'nullable':
      return { ...ref, inner: shapeWithEnumFlags(ref.inner) };
    case 'map':
      return {
        ...ref,
        valueType: shapeWithEnumFlags(ref.valueType),
        ...(ref.keyType ? { keyType: shapeWithEnumFlags(ref.keyType) } : {}),
      };
    case 'union':
      return { ...ref, variants: ref.variants.map(shapeWithEnumFlags) };
    default:
      return assertNever(ref);
  }
}
