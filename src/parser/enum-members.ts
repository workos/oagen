import type { EnumRef, EnumValue, ExternalDocs } from '../ir/types.js';
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
 * lifts it to a top-level `Enum`: each member's documentation and the link
 * its schema declared. A side table rather than keys on the ref: the ref is
 * the field's or parameter's *type*, which the sameness passes compare by
 * serialization, and documentation is not shape — it sits beside the type on
 * the `Field`, not inside it. Keyed by identity because every pass between
 * building a ref and lifting it mutates refs in place (renames, nullable
 * wraps) and none clones them; an unreachable ref drops out on its own.
 */
interface InlineEnumMeta {
  members: EnumMember[];
  externalDocs?: ExternalDocs;
}

const inlineEnumMeta = new WeakMap<EnumRef, InlineEnumMeta>();

/** Build an inline `EnumRef` from its members, recording their documentation and the schema's link (if usable) for the lift pass. */
export function inlineEnumRef(name: string, members: readonly EnumMember[], rawExternalDocs: unknown): EnumRef {
  const ref: EnumRef = { kind: 'enum', name, values: members.map((member) => member.value) };
  const externalDocs = readExternalDocs(rawExternalDocs);
  inlineEnumMeta.set(ref, { members: [...members], ...(externalDocs ? { externalDocs } : {}) });
  return ref;
}

/** The link recorded for an inline enum ref by `inlineEnumRef`; none for a ref built any other way. */
export function inlineEnumExternalDocsOf(ref: EnumRef): ExternalDocs | undefined {
  return inlineEnumMeta.get(ref)?.externalDocs;
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
 * `values`, in that order, with the documentation `inlineEnumRef` recorded
 * for that value. A ref built without `inlineEnumRef` (a test's, a plugin's)
 * lifts to bare values. Empty when the ref carries no `values`.
 */
export function enumValuesOf(ref: EnumRef): EnumValue[] {
  const byValue = new Map((inlineEnumMeta.get(ref)?.members ?? []).map((member) => [member.value, member]));
  return (ref.values ?? []).map((value) => toEnumValue(byValue.get(value) ?? { value }));
}

/**
 * The shape of one enum member: the value's primitive type and text — the
 * IR keeps numeric `5` and string `"5"` distinct, and so do the emitters —
 * and whether it is deprecated. Two inline enums with the same values are
 * shared under one name only when they also deprecate the same ones, so a
 * field whose schema does not deprecate a value never resolves to an enum
 * that marks it. `description` is documentation, not shape, and does not
 * count: the first lifted copy's text wins, as its link does.
 */
export function enumValueShapeKey(value: Pick<EnumValue, 'value' | 'deprecated'>): string {
  return `${typeof value.value}:${String(value.value)}${value.deprecated === true ? '!deprecated' : ''}`;
}

/** Order-insensitive: a reordering of the same members (`enumValueShapeKey`) is the same type. */
export function sameEnumShape(
  a: readonly Pick<EnumValue, 'value' | 'deprecated'>[],
  b: readonly Pick<EnumValue, 'value' | 'deprecated'>[],
): boolean {
  if (a.length !== b.length) return false;
  const have = new Set(a.map(enumValueShapeKey));
  return b.every((value) => have.has(enumValueShapeKey(value)));
}
