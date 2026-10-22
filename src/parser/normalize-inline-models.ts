import type { Enum, Model, Service, TypeRef, Webhook } from '../ir/types.js';
import {
  walkTypeRef,
  collectResponseHeaders,
  collectModelTypeRefs,
  collectRequestBodyTypes,
  collectResponseBodyTypes,
  collectWebhookTypeRefs,
  renameModelRefs,
} from '../ir/types.js';
import { modelFingerprint } from './operations.js';
import { isComponentModelRef } from './schemas.js';
import { unionShapeKey } from './union-shape.js';
import {
  inheritedModelRefsOf,
  isInheritedModelRef,
  type FieldInlineModelGroup,
  type InlineModelBundle,
} from './inline-models.js';

/**
 * What the merge passes need to keep a deprecated and a live definition of
 * one name apart (see `separateDeprecatedCopies`): the site each inline
 * model came from (`bundles`), so the copy that must leave the shared name
 * can be renamed and exactly its own references repointed, and every name
 * already in play (`reserved`) — the component models and enums, and every
 * inline model of every pass — so the new name is free. A name minted here
 * is added to `reserved`, so both passes, and every mint within one, agree.
 */
export interface InlineModelNaming {
  bundles: InlineModelBundle[];
  reserved: Set<string>;
}

/**
 * Bundle the models each component field produced with the references that
 * field owns: its own type, looked up in `models` as they stand when the
 * field pass runs — an inline response may have replaced a component's
 * fields by then — and every reference an `allOf` merge copied from it
 * (`inheritedModelRefsOf`), so a renamed child is repointed from the field
 * that produced it and from each copy of that field, and from nowhere else.
 * A field the model no longer has falls back to every field of its component.
 */
export function fieldInlineModelBundles(groups: FieldInlineModelGroup[], models: Model[]): InlineModelBundle[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  return groups.map(({ parentName, fieldName, models: fieldModels }) => {
    const parent = byName.get(parentName);
    const field = parent?.fields.find((f) => f.name === fieldName);
    const own = field ? [field.type] : (parent?.fields.map((f) => f.type) ?? []);
    return {
      qualifier: parentName,
      roots: [...own, ...inheritedModelRefsOf(parentName, fieldName)],
      models: fieldModels,
    };
  });
}

/**
 * Every type name the document will have minted by the time the IR is
 * finished, so a merge pass that must rename an inline model takes a name
 * nothing else has: the component models and enums, every inline model of
 * either pass (header models, list-envelope companions and union variants
 * included), and every inline enum — named on its `EnumRef` when the field,
 * parameter or header was typed, and only lifted into `spec.enums` after the
 * merges have run — found in any model's fields or named-union variants, or
 * anywhere on an operation.
 */
export function reservedTypeNames(
  models: Model[],
  enums: Enum[],
  inlineModels: Model[],
  fieldInlineModels: Model[],
  services: Service[],
  webhooks: Webhook[] = [],
): Set<string> {
  const reserved = new Set<string>();
  const visit = (ref: TypeRef): void => {
    walkTypeRef(ref, { enum: (r) => reserved.add(r.name) });
  };
  for (const model of [...models, ...inlineModels, ...fieldInlineModels]) {
    reserved.add(model.name);
    for (const ref of collectModelTypeRefs(model)) visit(ref);
  }
  for (const e of enums) reserved.add(e.name);
  for (const service of services) {
    for (const op of service.operations) {
      for (const param of [
        ...op.pathParams,
        ...op.queryParams,
        ...(op.bodyOwnedQueryParams ?? []),
        ...op.headerParams,
        ...(op.cookieParams ?? []),
      ]) {
        visit(param.type);
      }
      if (op.requestBody) visit(op.requestBody);
      visit(op.response);
      for (const r of op.successResponses ?? []) visit(r.type);
      for (const e of op.errors) if (e.type) visit(e.type);
      for (const field of op.pagination?.envelopeFields ?? []) visit(field.type);
      if (op.pagination) visit(op.pagination.itemType);
      for (const header of collectResponseHeaders(op)) visit(header.type);
      for (const { type } of collectResponseBodyTypes(op)) visit(type);
      for (const { type } of collectRequestBodyTypes(op)) visit(type);
    }
  }
  for (const webhook of webhooks) for (const ref of collectWebhookTypeRefs(webhook)) visit(ref);
  return reserved;
}

/**
 * Repoint every reference to the inline model `oldName` within `ref` to
 * `newName`, by the reference's identity rather than its name alone: an
 * explicit `$ref` to a same-named component (`isComponentModelRef`) is never
 * touched, and a reference an `allOf` merge copied from another component's
 * field (`isInheritedModelRef`) belongs to that field's site and is left to
 * it, unless the caller is that site (`includeInherited`).
 */
function repointInlineModelRefs(ref: TypeRef, oldName: string, newName: string, includeInherited: boolean): void {
  walkTypeRef(ref, {
    model: (r) => {
      if (r.name !== oldName || isComponentModelRef(r)) return;
      if (!includeInherited && isInheritedModelRef(r)) return;
      (r as { name: string }).name = newName;
    },
  });
}

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
    }
  }
  return [...byName.values()];
}

/**
 * Keep a deprecated and a live definition of one name apart before a merge
 * pass folds same-named models together, so a live operation or field never
 * resolves to a model marked `deprecated`, whatever order the document
 * declares them in.
 *
 * `owners` are the models whose name and flag are authoritative — the
 * component schemas (and, in the field pass, every model the response pass
 * already settled, when the caller does not say which are components) — and
 * `contenders` the inline models competing for their names. For each name,
 * the flag the name carries is its owner's or, with no owner, live as soon
 * as any contender is live (a name every contender deprecates stays
 * deprecated, and the pass leaves it alone). A contender whose flag disagrees
 * with the name's then
 *
 * - folds onto the live definition — the one `keepLargestByName` would keep
 *   among the live contenders — when there is no owner and it is identical
 *   to every live contender in everything but the flag
 *   (`differOnlyByDeprecation`): the shared name keeps the live definition,
 *   with a warning, in either order; the deprecated schema's own field or
 *   operation still carries its flag. Live contenders that disagree among
 *   themselves are settled by document order (first declared, or the one with
 *   more fields), as they always were; a deprecated copy never inherits that
 *   tie and is qualified instead, so its name is the same in every order;
 * - otherwise takes a name of its own (`mintQualifiedName`): its site's
 *   qualifier prefixed — `GetLegacyWidgetWidget` for a response of
 *   `getLegacyWidget`, `CreateNoteRequest2` for a body already named from its
 *   operation, `PetOwner2` for a field of `Pet` — minted against every name
 *   in play, and the references minted for it repointed, by identity
 *   (`repointInlineModelRefs`): the references its site owns — the
 *   operation's response or body, the component field and every `allOf` copy
 *   of that field — and those in the fields of the models minted beside it
 *   (`InlineModelBundle`); never an explicit `$ref` to a same-named
 *   component, in the same response map or anywhere else, and never a
 *   reference another site's field lent. An owner is never renamed and never
 *   takes a contender's flag, in either direction: a live inline copy never
 *   folds onto a deprecated component, and a deprecated one never onto a live
 *   component, whatever their shapes.
 *
 * Names are decided bottom-up — a name after every name its contenders'
 * fields reference, as the list-envelope pass decides nested companions —
 * so when a parent is compared its children are already named: a deprecated
 * parent whose child was just renamed no longer looks identical to the live
 * parent and keeps its own model, referencing the renamed child.
 *
 * A contender without a site — none the parser produces; a direct caller's —
 * cannot be renamed and is left to the pass's usual choice, with a warning.
 *
 * Returns the contenders that still compete for a name, the renamed ones
 * under their new name, and the folded copies keyed to the definition that
 * replaced them, so a caller that keeps an owner list can seat the live copy
 * where the folded one was.
 */
function separateDeprecatedCopies(
  owners: ReadonlyMap<string, Model>,
  contenders: Model[],
  naming: InlineModelNaming | undefined,
): { kept: Model[]; folded: Map<Model, Model> } {
  const byName = new Map<string, Model[]>();
  for (const model of contenders) {
    const group = byName.get(model.name) ?? [];
    group.push(model);
    byName.set(model.name, group);
  }
  const bundleOf = new Map<Model, InlineModelBundle>();
  for (const bundle of naming?.bundles ?? []) {
    for (const model of bundle.models) bundleOf.set(model, bundle);
  }
  const flag = (m: Model): string => (m.deprecated ? 'deprecated' : 'live');

  const folded = new Map<Model, Model>();
  for (const name of bottomUp(byName)) {
    const group = byName.get(name)!;
    const owner = owners.get(name);
    let nameDeprecated: boolean;
    /** The live contenders a deprecated copy may fold onto; empty under an owner, which is never folded onto. */
    let live: Model[] = [];
    if (owner) {
      nameDeprecated = !!owner.deprecated;
    } else {
      live = group.filter((m) => !m.deprecated);
      if (live.length === 0 || live.length === group.length) continue;
      nameDeprecated = false;
    }

    for (const copy of group) {
      if (!!copy.deprecated === nameDeprecated) continue;
      // A deprecated copy folds only when every live copy of the name is its
      // twin but for the flag: then whichever live definition the shared name
      // carries, the copy is interchangeable with it. Live copies that
      // disagree among themselves (requiredness, say) are settled by document
      // order, as always; a deprecated copy must not inherit that order, so it
      // is qualified whenever they disagree.
      if (live.length > 0 && live.every((l) => differOnlyByDeprecation(l, copy))) {
        console.warn(
          `[oagen] Warning: Inline model "${name}" is declared both deprecated and live with the same shape — keeping the live definition under the shared name`,
        );
        folded.set(copy, preferredDefinition(live));
        continue;
      }
      const bundle = naming && bundleOf.get(copy);
      if (!bundle) {
        console.warn(
          `[oagen] Warning: Inline model "${name}" is ${flag(copy)} in one definition and ${nameDeprecated ? 'deprecated' : 'live'} in another, with different shapes, and has no site to be renamed from — keeping the usual definition under the shared name`,
        );
        continue;
      }
      const renamed = mintQualifiedName(name, bundle.qualifier, naming.reserved);
      naming.reserved.add(renamed);
      copy.name = renamed;
      // The site's own references, copies of its field included; then the
      // references in the models minted beside it, which never include what
      // another site's field lent them.
      for (const root of bundle.roots) repointInlineModelRefs(root, name, renamed, true);
      for (const model of bundle.models) {
        for (const ref of collectModelTypeRefs(model)) repointInlineModelRefs(ref, name, renamed, false);
      }
      console.warn(
        `[oagen] Renamed inline model "${name}" → "${renamed}": it is ${flag(copy)} while "${name}" is ${nameDeprecated ? 'deprecated' : 'live'}`,
      );
    }
  }

  return { kept: contenders.filter((m) => !folded.has(m)), folded };
}

/**
 * The names in `groups`, each after every name the models under it reference
 * (through their fields and named-union variants, at any depth of array,
 * map, union or nullable wrapper) — a post-order walk, so a cycle is cut
 * where it closes and every name appears once. Insertion order breaks ties, so the result is as stable
 * as the document.
 */
function bottomUp(groups: ReadonlyMap<string, Model[]>): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    for (const model of groups.get(name) ?? []) {
      for (const ref of collectModelTypeRefs(model)) {
        walkTypeRef(ref, {
          model: (r) => {
            // An explicit `$ref` names a component, never a contender.
            if (!isComponentModelRef(r) && groups.has(r.name)) visit(r.name);
          },
        });
      }
    }
    order.push(name);
  };
  for (const name of groups.keys()) visit(name);
  return order;
}

/** The definition `keepLargestByName` keeps of a name: the one with the most fields, the first declared on a tie. */
function preferredDefinition(models: Model[]): Model {
  let best = models[0]!;
  for (const model of models) if (model.fields.length > best.fields.length) best = model;
  return best;
}

/**
 * A free name for a copy that must leave `name`: `qualifier` prefixed, as a
 * list-envelope companion or header model is qualified
 * (`GetLegacyWidgetWidget`), or — when the name already starts with the
 * qualifier, as a request body named from its operation does — the name
 * itself; then, while that is taken, a numeric suffix (`CreateNoteRequest2`,
 * `…3`), the fallback a header model uses. `reserved` holds every name in
 * play, so the search stops at the first free suffix and the result collides
 * with nothing any pass has minted or will mint.
 */
function mintQualifiedName(name: string, qualifier: string, reserved: ReadonlySet<string>): string {
  const base = name.startsWith(qualifier) ? name : `${qualifier}${name}`;
  if (base !== name && !reserved.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!reserved.has(candidate)) return candidate;
  }
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
      // The iterator's item type is its own reference when an explicit
      // `dataPath` typed it from the document (`resolveDataPathFromSchema`),
      // not the one `response` holds, so it is rewritten on its own.
      if (op.pagination) rewriteModelRef(op.pagination.itemType, oldName, newName);
      for (const field of op.pagination?.envelopeFields ?? []) {
        rewriteModelRef(field.type, oldName, newName);
      }
      for (const error of op.errors) {
        if (error.type) rewriteModelRef(error.type, oldName, newName);
      }
      for (const header of collectResponseHeaders(op)) {
        rewriteModelRef(header.type, oldName, newName);
      }
      for (const { type } of collectResponseBodyTypes(op)) {
        rewriteModelRef(type, oldName, newName);
      }
      for (const { type } of collectRequestBodyTypes(op)) {
        rewriteModelRef(type, oldName, newName);
      }
    }
  }
  for (const webhook of webhooks) {
    for (const ref of collectWebhookTypeRefs(webhook)) rewriteModelRef(ref, oldName, newName);
  }
}

/**
 * Fold the operations' inline models into the component models. A component's
 * name and flag are authoritative, and among the inline models a live copy
 * owns a shared name, so `separateDeprecatedCopies` runs first: the fold below
 * only ever joins models that agree on `deprecated`, except for a copy the
 * caller gave no site to rename from (`naming`), which takes the choice the
 * pass always made.
 */
export function mergeInlineResponseModels(
  schemaModels: Model[],
  inlineModels: Model[],
  naming?: InlineModelNaming,
): Model[] {
  const mergedSchemaModels = [...schemaModels];
  const schemaModelNames = new Set(mergedSchemaModels.map((m) => m.name));
  const schemaModelsByName = new Map(mergedSchemaModels.map((m) => [m.name, m]));
  const { kept } = separateDeprecatedCopies(schemaModelsByName, inlineModels, naming);

  const deduplicatedInlineModels = kept.filter((model) => {
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
      // its `deprecated` — present or absent — always. The two agree on the
      // flag by now unless the response could not be renamed (no site), and
      // then the component's still wins: a deprecated response that adds a
      // field must not deprecate every operation referencing the live
      // component, and a live one must not clear a deprecated component's
      // flag. The response's own flag is not read; the operation that
      // declared it still carries its own.
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
 *
 * A component's flag is authoritative and the other existing models — the
 * response pass's inline survivors — compete with the field models for their
 * names like any inline copy, so `separateDeprecatedCopies` runs first with
 * the components (every existing model, when the caller does not say which
 * are components) as owners: a deprecated and a live definition of one name
 * are told apart before the fold below, which then only joins models that
 * agree on the flag — except for a copy without a site to rename from
 * (`naming`), which takes the choice the pass always made.
 */
export function mergeFieldInlineModels(
  existingModels: Model[],
  fieldInlineModels: Model[],
  componentNames?: Set<string>,
  naming?: InlineModelNaming,
): Model[] {
  const isComponent = (m: Model): boolean => !componentNames || componentNames.has(m.name);
  const owners = new Map(existingModels.filter(isComponent).map((m) => [m.name, m]));
  const { kept, folded } = separateDeprecatedCopies(
    owners,
    [...existingModels.filter((m) => !isComponent(m)), ...fieldInlineModels],
    naming,
  );
  const keptSet = new Set(kept);
  // An existing inline model folded onto a live field copy of its shape
  // gives the copy its place; a field copy folded onto an existing model is
  // simply dropped.
  const promoted = new Set<Model>();
  const retainedModels: Model[] = [];
  for (const model of existingModels) {
    if (isComponent(model) || keptSet.has(model)) {
      retainedModels.push(model);
      continue;
    }
    const winner = folded.get(model);
    if (winner) {
      retainedModels.push(winner);
      promoted.add(winner);
    }
  }

  const modelNames = new Set(retainedModels.map((m) => m.name));
  const modelsByName = new Map(retainedModels.map((m) => [m.name, m]));
  const fieldList = (m: Model): string => m.fields.map((f) => f.name).join(', ') || '(no fields)';

  const deduplicatedFieldModels = fieldInlineModels.filter((model) => {
    if (!keptSet.has(model) || promoted.has(model)) return false;
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
    }

    return false;
  });

  return [...retainedModels, ...keepLargestByName(deduplicatedFieldModels)];
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

    // Guard: a live Json model never folds onto a deprecated base — every
    // live reference to it would then resolve to a deprecated type. (The
    // other way round still folds: `<Name>` keeps its own, live, flag.)
    if (baseModel.deprecated && !model.deprecated) {
      console.warn(
        `[oagen] Not merging "${model.name}" into "${baseName}": "${baseName}" is deprecated and "${model.name}" is live`,
      );
      continue;
    }

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
