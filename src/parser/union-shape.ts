import type { Model, TypeRef } from '../ir/types.js';

/**
 * The part of a model's shape its named-union metadata contributes to a
 * structural fingerprint: `''` for a model that is no union, else its
 * variants — each through `variantKey`, in document order or sorted when the
 * caller treats member order as irrelevant, the list JSON-encoded so a
 * variant key containing `,` cannot read as two variants — followed by
 * `unionRulesKey`. Every model fingerprint (envelope companions,
 * parameter-group wrappers) appends this, so two unions with the same
 * members but different dispatch rules never fingerprint alike.
 */
export function unionShapeKey(
  model: Model,
  variantKey: (ref: TypeRef) => string,
  options: { sorted?: boolean } = {},
): string {
  const variants = (model.variants ?? []).map(variantKey);
  if (options.sorted) variants.sort();
  const members = model.variants ? `|${model.compositionKind ?? ''}${JSON.stringify(variants)}` : '';
  return `${members}${unionRulesKey(model)}`;
}

/**
 * The rules a named union dispatches by, independent of its members: the
 * composition keyword and the discriminator property and mapping (entries
 * sorted by value, so key order in the document plays no part; each entry
 * JSON-encoded, so a value or target containing `=` or `,` cannot read as
 * another mapping). `''` when the model declares neither.
 */
export function unionRulesKey(model: Model): string {
  const parts: string[] = [];
  if (model.compositionKind) parts.push(`kind:${model.compositionKind}`);
  if (model.discriminator) {
    const entries = Object.entries(model.discriminator.mapping).sort(([a], [b]) => a.localeCompare(b));
    parts.push(`disc:${JSON.stringify(model.discriminator.property)}${JSON.stringify(entries)}`);
  }
  return parts.length > 0 ? `|${parts.join('|')}` : '';
}
