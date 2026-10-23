import type { Model, TypeRef } from '../ir/types.js';

/** A model's dispatch rules: the discriminator property and the mapping from each value to a variant model name. */
export type Discriminator = NonNullable<Model['discriminator']>;

/**
 * The part of a model's shape its named-union metadata contributes to a
 * structural fingerprint: `''` for a model that is no union, else its
 * variants — each through `variantKey`, in document order or sorted when the
 * caller treats member order as irrelevant, the list JSON-encoded so a
 * variant key containing `,` cannot read as two variants — followed by
 * `unionRulesKey`, its mapping targets read under `options.modelName` when
 * the caller gives one. Every model fingerprint (envelope companions,
 * parameter-group wrappers) appends this, so two unions with the same
 * members but different dispatch rules never fingerprint alike.
 */
export function unionShapeKey(
  model: Model,
  variantKey: (ref: TypeRef) => string,
  options: { sorted?: boolean; modelName?: (name: string) => string } = {},
): string {
  const variants = (model.variants ?? []).map(variantKey);
  if (options.sorted) variants.sort();
  const members = model.variants ? `|${model.compositionKind ?? ''}${JSON.stringify(variants)}` : '';
  return `${members}${unionRulesKey(model, options.modelName)}`;
}

/**
 * The rules a named union dispatches by, independent of its members: the
 * composition keyword and the discriminator property and mapping (entries
 * sorted by value, so key order in the document plays no part; each entry
 * JSON-encoded, so a value or target containing `=` or `,` cannot read as
 * another mapping). `''` when the model declares neither. A mapping target
 * is a model name, and is read under `modelName` when the caller gives one
 * (`readDiscriminator`).
 */
export function unionRulesKey(model: Model, modelName?: (name: string) => string): string {
  const parts: string[] = [];
  if (model.compositionKind) parts.push(`kind:${model.compositionKind}`);
  if (model.discriminator) {
    const { property, mapping } = readDiscriminator(model.discriminator, modelName);
    const entries = Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b));
    parts.push(`disc:${JSON.stringify(property)}${JSON.stringify(entries)}`);
  }
  return parts.length > 0 ? `|${parts.join('|')}` : '';
}

/**
 * `discriminator` with every mapping target — a model name — read under
 * `modelName`; the discriminator itself when no `modelName` is given. Every
 * shape comparison that reads a model reference under a renaming
 * (`ShapeReadOptions.modelName`) reads the mapping's targets through this,
 * since a rename (`renameModelRefs`) repoints them as it repoints the
 * variants.
 */
export function readDiscriminator(
  discriminator: Discriminator,
  modelName: ((name: string) => string) | undefined,
): Discriminator {
  if (!modelName) return discriminator;
  const mapping = Object.fromEntries(
    Object.entries(discriminator.mapping).map(([value, target]) => [value, modelName(target)]),
  );
  return { property: discriminator.property, mapping };
}
