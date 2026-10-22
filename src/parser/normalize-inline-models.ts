import type { Model, Service, TypeRef, Webhook } from '../ir/types.js';
import {
  walkTypeRef,
  collectResponseHeaders,
  collectModelTypeRefs,
  collectResponseBodyTypes,
  collectWebhookTypeRefs,
  renameModelRefs,
} from '../ir/types.js';
import { modelFingerprint } from './operations.js';
import { unionShapeKey } from './union-shape.js';

function keepLargestByName(models: Model[]): Model[] {
  const byName = new Map<string, Model>();
  for (const model of models) {
    const existing = byName.get(model.name);
    if (existing && !haveSameFields(existing, model)) {
      // Two inline models resolved to one name but describe different shapes
      // (e.g. two operationIds that PascalCase to the same word). Only one can
      // survive, so say which, instead of silently handing every other
      // reference a model with someone else's fields.
      const kept =
        model.fields.length === existing.fields.length
          ? 'keeping the first definition'
          : 'keeping the one with more fields';
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" has more than one definition with different fields or field types (${model.fields.length} vs ${existing.fields.length}) — ${kept}`,
      );
    }
    if (!existing || model.fields.length > existing.fields.length) {
      byName.set(model.name, model);
    } else if (differOnlyByDeprecation(existing, model) && !model.deprecated) {
      // Identical in everything but the flag, the earlier copy deprecated and
      // this one not. The shared name must not carry deprecation onto every
      // live reference, so the live definition is kept; the deprecated
      // schema's own field or operation still carries its flag. A copy that
      // differs in anything else — requiredness, a type, a limit — is not
      // interchangeable and takes the usual largest-or-first choice above.
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" is declared both deprecated and live with the same shape — keeping the live definition under the shared name`,
      );
      byName.set(model.name, model);
    }
  }
  return [...byName.values()];
}

/**
 * Whether `a` and `b` are the same model but for `deprecated` — one flagged,
 * the other not, and otherwise identical in everything the header registry's
 * `modelFingerprint` reads: every field's name, type, requiredness, limits,
 * default and access flags, and the model's own limits, type parameters and
 * discriminator (names and documentation aside). Only such a pair is
 * interchangeable under one name; a difference in requiredness alone would
 * make a deprecated response promise a field the wire may omit.
 */
function differOnlyByDeprecation(a: Model, b: Model): boolean {
  if (!!a.deprecated === !!b.deprecated) return false;
  const shape = (m: Model): string => modelFingerprint({ ...m, deprecated: undefined });
  return shape(a) === shape(b);
}

/**
 * Same field names with the same types, in any order, and the same
 * named-union variants. Types are compared by their JSON serialization: the
 * parser builds a given shape's TypeRef with the same key order every time,
 * so equal shapes serialize identically.
 */
function haveSameFields(a: Model, b: Model): boolean {
  const signatures = (m: Model) =>
    new Set([
      ...m.fields.map((f) => `${f.name}:${JSON.stringify(f.type)}`),
      ...(m.variants ?? []).map((v, i) => `variant${i}:${JSON.stringify(v)}`),
    ]);
  const aSignatures = signatures(a);
  const bSignatures = signatures(b);
  return aSignatures.size === bSignatures.size && [...aSignatures].every((s) => bSignatures.has(s));
}

function rewriteModelRef(ref: TypeRef, oldName: string, newName: string): void {
  walkTypeRef(ref, {
    model: (r) => {
      if (r.name === oldName) (r as { name: string }).name = newName;
    },
  });
}

function rewriteModelRefs(
  models: Model[],
  services: Service[],
  oldName: string,
  newName: string,
  webhooks: Webhook[] = [],
): void {
  // Fields, named-union variants and discriminator mappings alike.
  const renames = new Map([[oldName, newName]]);
  for (const model of models) renameModelRefs(model, renames);
  for (const service of services) {
    for (const op of service.operations) {
      rewriteModelRef(op.response, oldName, newName);
      if (op.requestBody) {
        rewriteModelRef(op.requestBody, oldName, newName);
      }
      for (const field of op.pagination?.envelopeFields ?? []) {
        rewriteModelRef(field.type, oldName, newName);
      }
      for (const header of collectResponseHeaders(op)) {
        rewriteModelRef(header.type, oldName, newName);
      }
      for (const { type } of collectResponseBodyTypes(op)) {
        rewriteModelRef(type, oldName, newName);
      }
    }
  }
  for (const webhook of webhooks) {
    for (const ref of collectWebhookTypeRefs(webhook)) rewriteModelRef(ref, oldName, newName);
  }
}

export function mergeInlineResponseModels(schemaModels: Model[], inlineModels: Model[]): Model[] {
  const mergedSchemaModels = [...schemaModels];
  const schemaModelNames = new Set(mergedSchemaModels.map((m) => m.name));
  const schemaModelsByName = new Map(mergedSchemaModels.map((m) => [m.name, m]));

  const deduplicatedInlineModels = inlineModels.filter((model) => {
    if (!schemaModelNames.has(model.name)) return true;

    const existing = schemaModelsByName.get(model.name)!;
    const existingFieldNames = new Set(existing.fields.map((f) => f.name));
    const inlineFieldNames = new Set(model.fields.map((f) => f.name));
    const hasDifference =
      model.fields.some((f) => !existingFieldNames.has(f.name)) ||
      existing.fields.some((f) => !inlineFieldNames.has(f.name));

    // A named union's merged fields are not its shape — its variants are —
    // so a field count never argues for replacing it with a plain object.
    if (hasDifference && existing.variants && !model.variants) {
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" has different fields than the named union component — using component schema`,
      );
    } else if (hasDifference && model.fields.length > existing.fields.length) {
      // The component's name is the type the SDK exposes, so what documents
      // and flags that name stays the component's: its `description` and
      // `externalDocs` where it has them (the response's fill in only where
      // the component has none, as the Json fold fills the base's link), and
      // its `deprecated` — present or absent — always, as a component's flag
      // is never replaced anywhere else (see mergeFieldInlineModels): a
      // deprecated response that adds a field must not deprecate every
      // operation referencing the live component, and a live one must not
      // clear a deprecated component's flag. The response's own flag is not
      // read; the operation that declared it still carries its own.
      const replacement: Model = {
        ...model,
        ...(existing.description ? { description: existing.description } : {}),
        ...(existing.externalDocs ? { externalDocs: existing.externalDocs } : {}),
        ...(existing.deprecated ? { deprecated: true } : {}),
      };
      if (!existing.deprecated) delete replacement.deprecated;
      const idx = mergedSchemaModels.indexOf(existing);
      if (idx !== -1) mergedSchemaModels[idx] = replacement;
      schemaModelsByName.set(model.name, replacement);
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" has more fields than component schema (${model.fields.length} vs ${existing.fields.length}) — using inline response model`,
      );
      if (!!existing.deprecated !== !!model.deprecated) {
        console.warn(
          `[oagen] Warning: Inline model "${model.name}" is ${model.deprecated ? 'deprecated' : 'live'} but component schema "${model.name}" is ${existing.deprecated ? 'deprecated' : 'live'} — keeping the component's flag`,
        );
      }
    } else if (hasDifference) {
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" has different fields than component schema — using component schema`,
      );
    }

    return false;
  });

  return [...mergedSchemaModels, ...keepLargestByName(deduplicatedInlineModels)];
}

/**
 * Fold the field extractor's inline models into the models gathered so far,
 * keeping the earlier definition on a name clash. `componentNames` tells a
 * clash with a real component schema apart from one between two inline
 * models, so the warning can say which happened and name both shapes.
 */
export function mergeFieldInlineModels(
  existingModels: Model[],
  fieldInlineModels: Model[],
  componentNames?: Set<string>,
): Model[] {
  const modelNames = new Set(existingModels.map((m) => m.name));
  const modelsByName = new Map(existingModels.map((m) => [m.name, m]));
  const fieldList = (m: Model): string => m.fields.map((f) => f.name).join(', ') || '(no fields)';
  /** An earlier inline model replaced by a live copy of the same name and shape. */
  const replacements = new Map<Model, Model>();

  const deduplicatedFieldModels = fieldInlineModels.filter((model) => {
    if (!modelNames.has(model.name)) return true;

    const existing = modelsByName.get(model.name)!;
    const existingFieldNames = new Set(existing.fields.map((f) => f.name));
    const inlineFieldNames = new Set(model.fields.map((f) => f.name));
    const hasDifference =
      model.fields.some((f) => !existingFieldNames.has(f.name)) ||
      existing.fields.some((f) => !inlineFieldNames.has(f.name));

    if (hasDifference) {
      if (componentNames && !componentNames.has(model.name)) {
        console.warn(
          `[oagen] Warning: Two inline models are named "${model.name}" (fields: ${fieldList(existing)} | ${fieldList(model)}) — keeping the first, the second is dropped`,
        );
      } else {
        console.warn(
          `[oagen] Warning: Inline model "${model.name}" has different fields than component schema — using component schema`,
        );
      }
    } else if (
      !model.deprecated &&
      componentNames &&
      !componentNames.has(model.name) &&
      differOnlyByDeprecation(existing, model)
    ) {
      // Two inline models of one name, identical but for the flag, the
      // earlier deprecated and this one live: keep the live definition under
      // the shared name so deprecation does not reach every reference. A
      // component's own flag, by contrast, is authoritative and is never
      // replaced, and a copy that differs in anything else keeps the earlier
      // definition exactly as before.
      console.warn(
        `[oagen] Warning: Inline model "${model.name}" is declared both deprecated and live with the same shape — keeping the live definition under the shared name`,
      );
      replacements.set(existing, model);
    }

    return false;
  });

  return [...existingModels.map((m) => replacements.get(m) ?? m), ...keepLargestByName(deduplicatedFieldModels)];
}

function hasModelConstDiscriminant(model: Model): boolean {
  return model.fields.some(
    (f) => (f.name === 'object' || f.name === 'type') && f.type.kind === 'literal' && typeof f.type.value === 'string',
  );
}

function isModelReferencedByOthers(name: string, models: Model[], excludeNames: Set<string>): boolean {
  for (const model of models) {
    if (excludeNames.has(model.name)) continue;
    for (const ref of collectModelTypeRefs(model)) {
      let found = false;
      walkTypeRef(ref, {
        model: (r) => {
          if (r.name === name) found = true;
        },
      });
      if (found) return true;
    }
  }
  return false;
}

/**
 * Make `target` describe `source`'s shape: its fields and its named-union
 * metadata — `variants`, `compositionKind` and `discriminator`, each present
 * or absent exactly as on `source` — so a fold never turns a named union back
 * into a plain object. A target that dispatches by rules the source does not
 * preserve is never handed here (`collapseJsonSuffixModels` refuses that
 * fold), so this only ever adds union metadata to a plain target or replaces
 * a union's with identical rules. Every site that copies one model's shape
 * onto another goes through this.
 */
function adoptShape(target: Model, source: Model): void {
  target.fields = source.fields;
  if (source.variants) target.variants = source.variants;
  else delete target.variants;
  if (source.compositionKind) target.compositionKind = source.compositionKind;
  else delete target.compositionKind;
  if (source.discriminator) target.discriminator = source.discriminator;
  else delete target.discriminator;
}

/**
 * A `…Json` model's variant as the fold would leave it on the base: every
 * model reference the fold renames — the `…Json` model itself (pass 2) and
 * every `<Json>…`-prefixed child (pass 3) — read under the base's prefix, and
 * nothing else. The fold renames no enum and rewrites no literal, so an enum
 * reference and a `const` value are compared as they are: a `PetJsonState`
 * enum beside a `PetState` one, or a `PetJsonA` literal beside `PetA`, is a
 * different shape, and the base keeps the values its operations accept.
 */
function foldedVariantKey(ref: TypeRef, jsonName: string, baseName: string): string {
  const folded = structuredClone(ref);
  walkTypeRef(folded, {
    model: (r) => {
      if (r.name.startsWith(jsonName)) r.name = baseName + r.name.slice(jsonName.length);
    },
  });
  return JSON.stringify(folded);
}

export function collapseJsonSuffixModels(models: Model[], services: Service[], webhooks: Webhook[] = []): Model[] {
  const normalizedModels = [...models];
  const byName = new Map(normalizedModels.map((m) => [m.name, m]));

  // Pass 1: collect merge candidates
  const mergeCandidates: Array<{ jsonModel: Model; baseModel: Model }> = [];
  for (const model of normalizedModels) {
    if (!model.name.endsWith('Json')) continue;

    const baseName = model.name.slice(0, -4);
    const baseModel = byName.get(baseName);
    if (!baseModel || model.fields.length <= baseModel.fields.length) continue;

    const isSuperset = baseModel.fields.every((f) => model.fields.some((mf) => mf.name === f.name));
    if (!isSuperset) continue;

    // Guard: both models have a const discriminant — they are distinct entities
    if (hasModelConstDiscriminant(model) && hasModelConstDiscriminant(baseModel)) continue;

    // Guard: a third model explicitly references the Json-suffix model
    if (isModelReferencedByOthers(model.name, normalizedModels, new Set([model.name, baseName]))) continue;

    // Guard: the base is a union — a named union's variants, composition
    // keyword and discriminator, or an allOf+oneOf dispatcher's mapping (such
    // a base may have no fields at all) — that the Json model does not
    // preserve: it has no variants or rules, or different ones. Folding would
    // turn the dispatcher into a plain object, or swap its variants or rules,
    // under operations that already use it (two undiscriminated unions share
    // the rules `oneOf` while dispatching to different members). A Json
    // model's variants are read as the fold would leave them
    // (`foldedVariantKey`): its model references under the base's name, as
    // pass 3 renames them, so `PetJsonWithName` matches `PetWithName`; an
    // enum or a literal as it is, since the fold renames neither, so a
    // `PetJsonState` enum beside `PetState` is a different union. Identical
    // shapes fold as before.
    const baseShape = unionShapeKey(baseModel, (v) => JSON.stringify(v));
    const jsonShape = unionShapeKey(model, (v) => foldedVariantKey(v, model.name, baseName));
    if (baseShape !== '' && baseShape !== jsonShape) {
      console.warn(
        `[oagen] Warning: Json-suffix model "${model.name}" does not preserve the union rules of "${baseName}" — keeping both`,
      );
      continue;
    }

    mergeCandidates.push({ jsonModel: model, baseModel });
  }

  // Pass 2: apply merges
  const toRemove = new Set<string>();
  for (const { jsonModel, baseModel } of mergeCandidates) {
    adoptShape(baseModel, jsonModel);
    // The base model now describes the Json schema's shape, so carry that
    // schema's own limits (minProperties, dependentRequired, ...) with the
    // fields; the base's keywords fill in wherever the Json model is silent.
    if (jsonModel.constraints || baseModel.constraints) {
      baseModel.constraints = { ...baseModel.constraints, ...jsonModel.constraints };
    }
    // The base keeps its own documentation, link included, as it keeps its
    // description; the Json model's link only fills in where the base has none,
    // so folding the shape never drops the one link the document gave it.
    if (!baseModel.externalDocs && jsonModel.externalDocs) baseModel.externalDocs = jsonModel.externalDocs;
    // `deprecated` is deliberately not carried over: it names the type the SDK
    // exposes, and that is `baseModel.name`, which keeps its own flag. A
    // deprecated `<Name>Json` folded into a live `<Name>` leaves `<Name>` live.
    toRemove.add(jsonModel.name);
    rewriteModelRefs(normalizedModels, services, jsonModel.name, baseModel.name, webhooks);
    console.warn(
      `[oagen] Merged "${jsonModel.name}" into "${baseModel.name}" (${jsonModel.fields.length} fields, superset)`,
    );
  }

  // Pass 3: cascade renames to inline children of collapsed Json-suffix models.
  // e.g. when AuditLogSchemaJson → AuditLogSchema, also rename
  // AuditLogSchemaJsonTarget → AuditLogSchemaTarget.
  for (const { jsonModel, baseModel } of mergeCandidates) {
    const jsonPrefix = jsonModel.name;
    const basePrefix = baseModel.name;

    for (const model of normalizedModels) {
      if (toRemove.has(model.name)) continue;
      if (model.name.length <= jsonPrefix.length) continue;
      if (!model.name.startsWith(jsonPrefix)) continue;

      const newName = basePrefix + model.name.slice(jsonPrefix.length);
      const existing = byName.get(newName);

      if (existing && !toRemove.has(existing.name)) {
        toRemove.add(model.name);
        rewriteModelRefs(normalizedModels, services, model.name, newName, webhooks);
        console.warn(`[oagen] Collapsed child "${model.name}" into existing "${newName}"`);
      } else {
        rewriteModelRefs(normalizedModels, services, model.name, newName, webhooks);
        model.name = newName;
        byName.set(newName, model);
        console.warn(`[oagen] Renamed child "${jsonPrefix}…" → "${newName}"`);
      }
    }
  }

  return normalizedModels.filter((m) => !toRemove.has(m.name));
}
