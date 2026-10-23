import type { Enum, Model, ModelRef, Service, TypeRef, Webhook } from '../ir/types.js';
import {
  walkTypeRef,
  collectResponseHeaders,
  collectModelTypeRefs,
  collectRequestBodyTypes,
  collectResponseBodyTypes,
  collectOperationTypeRefs,
  collectWebhookTypeRefs,
  renameModelRefs,
  renameTypeRefModels,
} from '../ir/types.js';
import { modelFingerprint } from './operations.js';
import { isComponentModelRef } from './schemas.js';
import { unionShapeKey } from './union-shape.js';
import { shapeWithEnumFlags } from './enum-members.js';
import {
  fieldAdmits,
  inheritedModelRefsOf,
  isInheritedModelRef,
  modelAdmits,
  recordFieldModelRename,
  typeShapeKey,
  type FieldInlineModelGroup,
  type InlineModelBundle,
  type ShapeReadOptions,
} from './inline-models.js';

/**
 * What the merge passes need to keep two definitions of one name apart — a
 * deprecated and a live one, an inline one and a component that does not
 * admit it, or an inline model and an enum (see `settleSharedNames`): the
 * site each inline model came from (`bundles`), so the copy that must leave
 * the shared name can be renamed and exactly its own references repointed;
 * every name already in play (`reserved`) — the component models and enums,
 * and every inline model of every pass — so the new name is free; and the
 * names the document's enums hold (`enums`) — those in `spec.enums` as the
 * passes run: the component enums, and the inline enums lifted from the
 * component schemas' own fields, union variants and array items — which no
 * inline model may keep, whatever its shape. A name minted here is added to
 * `reserved`, so both passes, and every mint within one, agree.
 */
export interface InlineModelNaming {
  bundles: InlineModelBundle[];
  reserved: Set<string>;
  enums: ReadonlySet<string>;
}

/**
 * Bundle the models each component field produced with the references that
 * field owns: its own type, looked up in `models` (the components), and
 * every reference an `allOf` merge has copied from it so far
 * (`inheritedModelRefsOf`), so a renamed child is repointed from the field
 * that produced it and from each copy of that field, and from nowhere else.
 * A field the model no longer has falls back to every field of its
 * component. A rename is recorded for the field (`recordFieldModelRename`),
 * so a reference an `allOf` merge copies from it afterwards — an operation's
 * or a webhook's, read after the fields are settled — is created under the
 * settled name. Read once before the operations (`settleFieldInlineModels`)
 * and again, with the copies made since, before the merges.
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
      renamed: (from, to) => recordFieldModelRename(parentName, fieldName, from, to),
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
    for (const op of service.operations) for (const ref of collectOperationTypeRefs(op)) visit(ref);
  }
  for (const webhook of webhooks) for (const ref of collectWebhookTypeRefs(webhook)) visit(ref);
  return reserved;
}

/**
 * Which references a merge pass may repoint when it renames an inline model,
 * by the reference's identity rather than its name alone: one minted for an
 * inline model, never an explicit `$ref` to a same-named component
 * (`isComponentModelRef`); and a reference an `allOf` merge copied from
 * another component's field (`isInheritedModelRef`) only for that field's
 * own site (`includeInherited`), since it belongs to that site. Handed to
 * `renameTypeRefModels`, so a union's discriminator mapping follows a
 * repointed variant and stays on a `$ref` left in place.
 */
function inlineRefAdmit(includeInherited: boolean): (ref: ModelRef) => boolean {
  return (ref) => !isComponentModelRef(ref) && (includeInherited || !isInheritedModelRef(ref));
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
 * Settle every name an inline model shares with another definition before a
 * merge pass folds same-named models together, so a live operation or field
 * never resolves to a model marked `deprecated`, and no reference resolves to
 * a component of another shape, whatever order the document declares them
 * in.
 *
 * `owners` are the models whose name, shape and flag are authoritative — the
 * component schemas (and, in the field pass, every model the response pass
 * already settled, when the caller does not say which are components) — and
 * `contenders` the inline models competing for their names. For each name,
 * the flag the name carries is its owner's or, with no owner, live as soon
 * as any contender is live (a name every contender deprecates stays
 * deprecated, and the pass leaves it alone).
 *
 * A contender whose flag disagrees with the name's
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
 * - otherwise takes a name of its own (`renameInlineCopy`). An owner is never
 *   renamed and never takes a contender's flag, in either direction: a live
 *   inline copy never folds onto a deprecated component, and a deprecated one
 *   never onto a live component, whatever their shapes.
 *
 * A contender whose flag agrees with an owner's
 *
 * - folds onto the owner when the owner admits it (`modelAdmits`: the same
 *   fields and types, the owner no stricter on requiredness or nullability,
 *   everything else identical): the copy is dropped and its references,
 *   which already carry the name, resolve to the owner. An owner is never
 *   replaced, whatever the copy's field count, so every `$ref` to a component
 *   keeps the shape the document declares;
 * - otherwise takes a name of its own (`renameInlineCopy`), with a note. Two
 *   contenders of one name without an owner are left to the pass's own choice
 *   (`keepLargestByName`).
 *
 * A contender named like one of the document's enums (`naming.enums`) with
 * no owner of that name takes a name of its own (`renameInlineCopy`)
 * whatever its shape or flag, with a note: an enum admits no model, so the
 * IR never declares a model and an enum under one name. A name both a
 * component model and a component enum hold is the document's own clash and
 * is settled as the model's.
 *
 * A renamed copy takes its site's qualifier prefixed (`mintQualifiedName`) —
 * `GetLegacyWidgetWidget` or `GetWidgetWidget` for a response of
 * `getLegacyWidget` or `getWidget` pinned by `object: widget`,
 * `GetPetResponse2` or `CreateNoteRequest2` for a body already named from
 * its operation, `PetOwner2` for a field of `Pet` — minted against every name
 * in play, and the references minted for it are repointed, by identity
 * (`repointInlineModelRefs`): the references its site owns — the operation's
 * response or body, the component field and every `allOf` copy of that
 * field — and those in the fields of the models minted beside it
 * (`InlineModelBundle`); never an explicit `$ref` to a same-named component,
 * in the same response map or anywhere else, and never a reference another
 * site's field lent.
 *
 * Names are decided bottom-up — a name after every name its contenders'
 * fields reference, as the list-envelope pass decides nested companions —
 * so when a parent is compared its children are already named: a parent
 * whose child was just renamed no longer looks identical to its twin, or
 * admitted by its component, and keeps its own model, referencing the
 * renamed child.
 *
 * A contender without a site — none the parser produces; a direct caller's —
 * cannot be renamed and is left under the shared name, with a warning: the
 * owner's definition stands and the caller drops the copy.
 *
 * Returns the contenders that still compete for a name, the renamed ones
 * under their new name, and the folded copies keyed to the definition that
 * replaced them — the live twin, or the owner that admitted the copy — so a
 * caller that keeps an owner list can seat the live copy where the folded
 * one was.
 */
function settleSharedNames(
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
    // A name one of the document's enums holds is no model's, whatever the
    // copy's shape or flag: nothing admits it and nothing folds onto it, so
    // every copy leaves the name through its site. A name both a component
    // model and a component enum hold is the document's own clash and is
    // settled as the model's, below.
    if (!owner && naming?.enums.has(name)) {
      for (const copy of group) {
        const bundle = bundleOf.get(copy);
        if (!bundle) {
          console.warn(
            `[oagen] Warning: Inline model "${name}" is named like enum "${name}" and has no site to be renamed from — keeping both under the shared name`,
          );
          continue;
        }
        const renamed = renameInlineCopy(copy, name, bundle, naming);
        console.warn(`[oagen] Renamed inline model "${name}" → "${renamed}": enum "${name}" owns the name`);
      }
      continue;
    }
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

    // The copies that agree with the name's flag and that the owner does
    // not share, clustered by shape in document order: identical copies
    // that must leave the owner's name share one model under it, as they
    // would share the bare name without the owner (`keepLargestByName`).
    const clashing = new Map<string, Model[]>();
    for (const copy of group) {
      if (!!copy.deprecated !== nameDeprecated || !owner) continue;
      const bundle = naming && bundleOf.get(copy);
      if (ownerSharesWith(owner, copy, bundle)) {
        folded.set(copy, owner);
        continue;
      }
      const shape = modelFingerprint(copy);
      clashing.set(shape, [...(clashing.get(shape) ?? []), copy]);
    }
    for (const cluster of clashing.values()) {
      let renamed: string | undefined;
      let leader: Model | undefined;
      for (const copy of cluster) {
        const bundle = naming && bundleOf.get(copy);
        if (!bundle) {
          console.warn(
            `[oagen] Warning: Inline model "${name}" has a different shape than component schema "${name}" and has no site to be renamed from — using the component schema`,
          );
          continue;
        }
        if (renamed === undefined || leader === undefined) {
          renamed = renameInlineCopy(copy, name, bundle, naming);
          leader = copy;
          continue;
        }
        repointSite(bundle, name, renamed);
        folded.set(copy, leader);
      }
      if (renamed !== undefined) {
        const sites = cluster.filter((copy) => naming && bundleOf.has(copy)).length;
        console.warn(
          `[oagen] Renamed inline model "${name}" → "${renamed}": its shape differs from component schema "${name}"${sites > 1 ? ` (shared by ${sites} sites)` : ''}`,
        );
      }
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
      const renamed = renameInlineCopy(copy, name, bundle, naming);
      console.warn(
        `[oagen] Renamed inline model "${name}" → "${renamed}": it is ${flag(copy)} while "${name}" is ${nameDeprecated ? 'deprecated' : 'live'}`,
      );
    }
  }

  return { kept: contenders.filter((m) => !folded.has(m)), folded };
}

/**
 * Whether `owner`, a component, shares its name with `copy`: when it admits
 * the shape (`modelAdmits`) — or, for a copy the SDK sends (`bundle.sent`:
 * a request body, a parameter), only when the shapes are identical, since a
 * caller typed against a looser component could leave out what the
 * operation requires. The same question `ownerShares` answers for the
 * shape registry.
 */
function ownerSharesWith(owner: Model, copy: Model, bundle: InlineModelBundle | undefined): boolean {
  return bundle?.sent ? modelFingerprint(owner) === modelFingerprint(copy) : modelAdmits(owner, copy);
}

/**
 * Move `copy` off `name` to a free name qualified by its site
 * (`mintQualifiedName`), reserve it, and repoint exactly the references its
 * site minted (`repointSite`). Returns the new name.
 */
function renameInlineCopy(copy: Model, name: string, bundle: InlineModelBundle, naming: InlineModelNaming): string {
  const renamed = mintQualifiedName(name, bundle.qualifier, naming.reserved);
  naming.reserved.add(renamed);
  copy.name = renamed;
  repointSite(bundle, name, renamed);
  return renamed;
}

/**
 * Repoint exactly the references a site minted for `name` to `renamed`
 * (`inlineRefAdmit`): the site's own roots, copies of its field included;
 * then the references in the models minted beside it, which never include
 * what another site's field lent them — every reference kind alike, a
 * union's discriminator mapping following its variant
 * (`renameTypeRefModels`, `renameModelRefs`). A site that copies references
 * later is told (`InlineModelBundle.renamed`).
 */
function repointSite(bundle: InlineModelBundle, name: string, renamed: string): void {
  const renames = new Map([[name, renamed]]);
  for (const root of bundle.roots) renameTypeRefModels(root, renames, inlineRefAdmit(true));
  for (const model of bundle.models) renameModelRefs(model, renames, inlineRefAdmit(false));
  bundle.renamed?.(name, renamed);
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
 * so equal shapes serialize identically. An inline enum serializes with its
 * per-value deprecation (`shapeWithEnumFlags`), so a member deprecated on
 * one side only is a different type.
 */
function haveSameFields(a: Model, b: Model): boolean {
  const signatures = (m: Model) =>
    new Set([
      ...m.fields.map((f) => `${f.name}:${JSON.stringify(shapeWithEnumFlags(f.type))}`),
      ...(m.variants ?? []).map((v, i) => `variant${i}:${JSON.stringify(shapeWithEnumFlags(v))}`),
    ]);
  const aSignatures = signatures(a);
  const bSignatures = signatures(b);
  return aSignatures.size === bSignatures.size && [...aSignatures].every((s) => bSignatures.has(s));
}

/**
 * Rename `oldName` to `newName` everywhere, by name: in every model's fields,
 * named-union variants and discriminator mapping, and in every reference an
 * operation or webhook holds — a union's mapping following its variants
 * (`renameTypeRefModels`).
 */
/**
 * Repoint every model reference in `models`, `services` and `webhooks`
 * through `renames` in one pass — fields, named-union variants and
 * discriminator mappings alike — each reference read once, so a name one
 * entry vacates and another takes is never chained through.
 */
function rewriteModelRefs(
  models: Model[],
  services: Service[],
  renames: ReadonlyMap<string, string>,
  webhooks: Webhook[] = [],
): void {
  for (const model of models) renameModelRefs(model, renames);
  for (const service of services) {
    for (const op of service.operations) {
      renameTypeRefModels(op.response, renames);
      if (op.requestBody) renameTypeRefModels(op.requestBody, renames);
      // The iterator's item type is its own reference when an explicit
      // `dataPath` typed it from the document (`resolveDataPathFromSchema`),
      // not the one `response` holds, so it is rewritten on its own.
      if (op.pagination) renameTypeRefModels(op.pagination.itemType, renames);
      for (const field of op.pagination?.envelopeFields ?? []) renameTypeRefModels(field.type, renames);
      for (const error of op.errors) if (error.type) renameTypeRefModels(error.type, renames);
      for (const header of collectResponseHeaders(op)) renameTypeRefModels(header.type, renames);
      for (const { type } of collectResponseBodyTypes(op)) renameTypeRefModels(type, renames);
      for (const { type } of collectRequestBodyTypes(op)) renameTypeRefModels(type, renames);
    }
  }
  for (const webhook of webhooks) {
    for (const ref of collectWebhookTypeRefs(webhook)) renameTypeRefModels(ref, renames);
  }
}

/**
 * Fold the operations' and webhooks' inline models into the component
 * models. A component's name, shape and flag are authoritative, and among
 * the inline models a live copy owns a shared name, so `settleSharedNames`
 * runs first: an inline model named like a component keeps the name only
 * when the component admits it (and is then dropped, its references
 * resolving to the component) and takes a qualified name otherwise, so a
 * component is never replaced; the fold below (`keepLargestByName`) only
 * ever joins inline models that agree on `deprecated`. An inline model named
 * like one of the document's enums (`naming.enums`) — a request body or
 * primary response named from its operation, a model nested under one, a
 * list-envelope companion — takes a qualified name the same way, whatever
 * its shape. A copy the caller gave no site to rename from (`naming`) is
 * dropped in favour of the component, with the settle pass's warning; one
 * named like an enum is kept beside it, with a warning, since nothing
 * stands in for it.
 */
export function mergeInlineResponseModels(
  schemaModels: Model[],
  inlineModels: Model[],
  naming?: InlineModelNaming,
): Model[] {
  return [...schemaModels, ...keepLargestByName(settleAgainstComponents(schemaModels, inlineModels, naming))];
}

/**
 * Settle the components' own inline field models against the components —
 * the first merge step, run as soon as both are extracted and before any
 * operation or webhook is read (see `parseSpec`): a field object, array
 * item or union variant named like a component shares the name when the
 * component admits it and is dropped, the field resolving to the component;
 * one the component does not admit, or whose flag differs, takes its
 * qualified name now (`PetOwner2`), its field and every `allOf` copy of it
 * repointed (`settleSharedNames`). Settling the fields first means every
 * later comparison with a component — the shape registry's, the response
 * merge's — reads the component's children by their final names, so a body
 * that `$ref`s a component `GetPetResponseOwner` is never admitted by a
 * component whose `owner` was an inline object of another shape that only
 * later becomes `GetPetResponseOwner2`. A field model named like one of the
 * document's enums (`naming.enums`) — a `Pet.owner` object beside a
 * component enum `PetOwner` — takes its qualified name here too (`PetOwner2`),
 * whatever its shape, so the IR never declares a model and an enum under one
 * name. Returns the field models still competing for a name, the renamed
 * ones under their new names; the merges that follow compare them with the
 * operations' survivors only (`mergeFieldInlineModels`).
 */
export function settleFieldInlineModels(
  components: Model[],
  fieldInlineModels: Model[],
  naming?: InlineModelNaming,
): Model[] {
  return settleAgainstComponents(components, fieldInlineModels, naming);
}

/**
 * `contenders` settled against `components` (`settleSharedNames`), minus
 * those that folded onto one and those still named like one — a kept copy
 * still carrying a component's name had no site to be renamed from, and the
 * component's definition stands.
 */
function settleAgainstComponents(components: Model[], contenders: Model[], naming?: InlineModelNaming): Model[] {
  const owners = new Map(components.map((m) => [m.name, m]));
  const { kept } = settleSharedNames(owners, contenders, naming);
  return kept.filter((model) => !owners.has(model.name));
}

/**
 * Fold the field extractor's inline models into the models gathered so far.
 * `componentNames` tells a clash with a real component schema apart from one
 * between two inline models: the components are the owners the field models
 * are settled against, and every other existing model — the response pass's
 * inline survivors — competes with the field models for its name like any
 * inline copy.
 *
 * `settleSharedNames` runs first with the components (every existing model,
 * when the caller does not say which are components) as owners: a field
 * model named like a component keeps the name only when the component
 * admits it (and is then dropped, the field resolving to the component) and
 * takes a qualified name otherwise, so a component is never replaced; and a
 * deprecated and a live definition of one name are told apart. The parser
 * has already settled its field models against the components
 * (`settleFieldInlineModels`), so for it this step decides only the names
 * the field models share with the response pass's survivors; a direct
 * caller's field models are settled here. The fold below then only joins
 * models that agree on the flag, and a field model named like an inline
 * survivor of another shape is dropped in favour of the survivor, with a
 * warning naming both shapes, as the earlier definition of an inline name
 * is kept everywhere. A field model named like one of the document's enums
 * (`naming.enums`) — a `Pet.owner` object beside a component enum
 * `PetOwner` — takes a qualified name (`PetOwner2`) whatever its shape, as
 * the response pass's models do; the parser's field models meet that rule
 * when they are settled (`settleFieldInlineModels`), a direct caller's here.
 * A copy without a site to rename from (`naming`) is dropped in favour of
 * the component, with the settle pass's warning; one named like an enum is
 * kept beside it, with a warning.
 */
export function mergeFieldInlineModels(
  existingModels: Model[],
  fieldInlineModels: Model[],
  componentNames?: Set<string>,
  naming?: InlineModelNaming,
): Model[] {
  const isComponent = (m: Model): boolean => !componentNames || componentNames.has(m.name);
  const owners = new Map(existingModels.filter(isComponent).map((m) => [m.name, m]));
  const { kept, folded } = settleSharedNames(
    owners,
    [...existingModels.filter((m) => !isComponent(m)), ...fieldInlineModels],
    naming,
  );
  const keptSet = new Set(kept);
  // An existing inline model folded onto a live field copy of its shape
  // gives the copy its place; a field copy folded onto anything is simply
  // dropped.
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

  const modelsByName = new Map(retainedModels.map((m) => [m.name, m]));
  const fieldList = (m: Model): string => m.fields.map((f) => f.name).join(', ') || '(no fields)';

  const deduplicatedFieldModels = fieldInlineModels.filter((model) => {
    if (!keptSet.has(model) || promoted.has(model)) return false;
    const existing = modelsByName.get(model.name);
    if (!existing) return true;
    // Still named like a component: it could not be renamed (no site), and
    // the component's definition stands.
    if (isComponent(existing)) return false;

    const existingFieldNames = new Set(existing.fields.map((f) => f.name));
    const inlineFieldNames = new Set(model.fields.map((f) => f.name));
    const hasDifference =
      model.fields.some((f) => !existingFieldNames.has(f.name)) ||
      existing.fields.some((f) => !inlineFieldNames.has(f.name));
    if (hasDifference) {
      console.warn(
        `[oagen] Warning: Two inline models are named "${model.name}" (fields: ${fieldList(existing)} | ${fieldList(model)}) — keeping the first, the second is dropped`,
      );
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
 * `name` as the fold of `jsonName` onto `baseName` leaves it: the `…Json`
 * model itself under the base's name (pass 2), every `<Json>…`-prefixed
 * child under the base's prefix (pass 3), and any other name as it is. The
 * fold renames no enum and rewrites no literal, so an enum reference and a
 * `const` value are compared as they are: a `PetJsonState` enum beside a
 * `PetState` one, or a `PetJsonA` literal beside `PetA`, is a different
 * shape, and the base keeps the values its operations accept.
 */
function foldedName(name: string, jsonName: string, baseName: string): string {
  return name.startsWith(jsonName) ? baseName + name.slice(jsonName.length) : name;
}

/**
 * One step of a `…Json` fold's plan: a model the fold renames or removes,
 * with the name every reference to it resolves to afterwards (`onto`) —
 * the `…Json` model's base; a child's folded name when the child is
 * renamed; and, when the child collapses, the name the model holding its
 * folded name (`holder`) ends under.
 */
interface FoldStep {
  readonly model: Model;
  readonly newName: string;
  readonly holder: Model | undefined;
  readonly onto: string;
}

/**
 * The plan of folding `jsonModel` onto `baseModel`, decided in the names
 * that remain after the fold rather than the ones the models hold now: the
 * `…Json` model itself, then every model named with `jsonModel`'s name as
 * a strict prefix — a child the extractor named under it, or any other
 * model spelled that way — in document order. The set is closed under
 * references: a `<Json>…` model one of them references is spelled with the
 * prefix too, so it is in the plan and decided with it. A child whose
 * folded name (`foldedName`) no model holds is renamed to it; one whose
 * folded name a model holds collapses onto that model, by identity, and
 * ends under the name that model ends under — the holder may be a model
 * the fold leaves alone, or another child the fold renames or collapses
 * in turn (`PetJsonJsonThing` folds to `PetJsonThing`, which `PetJsonThing`
 * holds and vacates for `PetThing`, so it ends under `PetThing`, never
 * under the vacated name). A model an earlier fold removed is neither a
 * child nor a holder.
 */
function planFold(
  jsonModel: Model,
  baseModel: Model,
  models: readonly Model[],
  byName: ReadonlyMap<string, Model>,
  removed: ReadonlySet<string>,
): FoldStep[] {
  const children: Array<{ child: Model; newName: string; holder: Model | undefined }> = [];
  for (const child of models) {
    if (removed.has(child.name)) continue;
    if (child.name.length <= jsonModel.name.length || !child.name.startsWith(jsonModel.name)) continue;
    const newName = foldedName(child.name, jsonModel.name, baseModel.name);
    children.push({ child, newName, holder: byName.get(newName) });
  }
  const byChild = new Map(children.map((entry) => [entry.child, entry]));
  // The name a model ends under: a holder that is itself a child follows
  // its own step; every step shortens the name, so the chain ends.
  const finalNames = new Map<Model, string>();
  const finalName = (model: Model): string => {
    const known = finalNames.get(model);
    if (known !== undefined) return known;
    const entry = byChild.get(model);
    const name =
      entry === undefined
        ? model === jsonModel
          ? baseModel.name
          : model.name
        : entry.holder
          ? finalName(entry.holder)
          : entry.newName;
    finalNames.set(model, name);
    return name;
  };
  return [
    { model: jsonModel, newName: baseModel.name, holder: baseModel, onto: baseModel.name },
    ...children.map(({ child, newName, holder }) => ({ model: child, newName, holder, onto: finalName(child) })),
  ];
}

/** The names of the models `model` dispatches to — every model reference among its variants — read under `modelName`. */
function variantModelNames(model: Model, modelName: (name: string) => string): Set<string> {
  const names = new Set<string>();
  for (const variant of model.variants ?? []) walkTypeRef(variant, { model: (r) => names.add(modelName(r.name)) });
  return names;
}

/**
 * Fold every `<Name>Json` model that is a superset of a `<Name>` model onto
 * it: `<Name>` takes the `…Json` model's shape, every reference to the
 * `…Json` model resolves to `<Name>`, and every `<Name>Json…` child is
 * renamed `<Name>…` — collapsed onto the model that holds that name when
 * there is one. Pass 1 decides, for each `…Json` model against the models
 * as the document left them, whether its base admits the fold at all (the
 * guards below). Pass 2 then takes each candidate in turn and plans its
 * whole fold (`planFold`) in the names that remain after it, against the
 * models as the folds before it left them — an earlier fold may have seated
 * a model under a name a later child folds to, and a child may fold to a
 * name another child of the same fold vacates; every child that collapses
 * must be admitted by the model it collapses onto (`modelAdmits`, every
 * reference read under the fold) before any part of the plan is applied,
 * and a refused child refuses the parent and leaves every model as it was.
 * The plan is then applied in one pass: every reference repointed through
 * the plan's renames together, then the names set. Nothing is collapsed
 * by name alone, in any order.
 */
export function collapseJsonSuffixModels(models: Model[], services: Service[], webhooks: Webhook[] = []): Model[] {
  const normalizedModels = [...models];
  const byName = new Map(normalizedModels.map((m) => [m.name, m]));

  // Pass 1: collect merge candidates. Every guard reads the models as they
  // are before any fold, and every shape through the fold it is deciding:
  // each model reference under the name the fold would give it
  // (`foldedName`, as `ShapeReadOptions.modelName`), on the base's side and
  // the Json model's alike, since the fold rewrites every reference in every
  // model.
  const mergeCandidates: Array<{ jsonModel: Model; baseModel: Model; fold: ShapeReadOptions }> = [];
  for (const model of normalizedModels) {
    if (!model.name.endsWith('Json')) continue;

    const baseName = model.name.slice(0, -4);
    const baseModel = byName.get(baseName);
    if (!baseModel || model.fields.length <= baseModel.fields.length) continue;

    const jsonFields = new Map(model.fields.map((f) => [f.name, f]));
    const isSuperset = baseModel.fields.every((f) => jsonFields.has(f.name));
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

    const fold: ShapeReadOptions = { modelName: (name) => foldedName(name, model.name, baseName) };

    // Guard: the base is a union — a named union's variants, composition
    // keyword and discriminator, or an allOf+oneOf dispatcher's mapping (such
    // a base may have no fields at all) — that the Json model does not
    // preserve: it has no variants or rules, or different ones. Folding would
    // turn the dispatcher into a plain object, or swap its variants or rules,
    // under operations that already use it (two undiscriminated unions share
    // the rules `oneOf` while dispatching to different members). The variants
    // and the mapping's targets are read under the fold on both sides, so
    // `PetJsonWithName` matches `PetWithName`; an enum or a literal as it is,
    // so a `PetJsonState` enum beside `PetState` is a different union. The
    // models those variants name are compared in pass 2, as every folded
    // child is. Identical shapes fold as before.
    const baseShape = unionShapeKey(baseModel, (v) => typeShapeKey(v, fold), fold);
    const jsonShape = unionShapeKey(model, (v) => typeShapeKey(v, fold), fold);
    if (baseShape !== '' && baseShape !== jsonShape) {
      console.warn(
        `[oagen] Warning: Json-suffix model "${model.name}" does not preserve the union rules of "${baseName}" — keeping both`,
      );
      continue;
    }

    // Guard: a field both declare must be one the Json model's describes
    // every value of the base's for (`fieldAdmits`: the same type, limits,
    // default and flags, the Json model's no stricter on requiredness or
    // nullability), since the base takes the Json model's fields under
    // operations that already use it. A field that shares only its name —
    // `a: integer` beside `a: string`, or required beside optional — would
    // retype the base, so the fold is refused.
    const retyped = baseModel.fields.find((f) => !fieldAdmits(jsonFields.get(f.name)!, f, fold));
    if (retyped) {
      console.warn(
        `[oagen] Warning: Json-suffix model "${model.name}" does not preserve the shape of "${baseName}": field "${retyped.name}" has a different shape — keeping both`,
      );
      continue;
    }

    mergeCandidates.push({ jsonModel: model, baseModel, fold });
  }

  // Pass 2: plan, decide and apply each fold as a whole, in turn.
  const removed = new Set<string>();
  for (const { jsonModel, baseModel, fold } of mergeCandidates) {
    if (removed.has(jsonModel.name) || removed.has(baseModel.name)) continue;

    // Guard: a `<Json>…` child that collapses — a variant model of the
    // union, a nested object, or any model spelled that way — must be
    // admitted by the model it collapses onto (`modelAdmits`, both read
    // under the fold), since the child's references then resolve to it and
    // a field the child adds would be lost. One refused child refuses the
    // whole fold before any of it is applied: a variant of another shape is
    // a different variant even when the fold would give it the base's name,
    // so a child the base dispatches to is refused as the union rules are;
    // any other child as a shape the fold does not preserve.
    const [parent, ...children] = planFold(jsonModel, baseModel, normalizedModels, byName, removed);
    const refused = children.find(({ model, holder }) => holder !== undefined && !modelAdmits(holder, model, fold));
    if (refused) {
      console.warn(
        variantModelNames(baseModel, fold.modelName!).has(refused.newName)
          ? `[oagen] Warning: Json-suffix model "${jsonModel.name}" does not preserve the union rules of "${baseModel.name}" — keeping both`
          : `[oagen] Warning: Json-suffix model "${jsonModel.name}" does not preserve the shape of "${baseModel.name}": "${refused.model.name}" would fold onto "${refused.newName}", which has a different shape — keeping both`,
      );
      continue;
    }

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

    // Every reference through the plan at once, then the names: a vacated
    // name is never looked up or set between two steps.
    const steps = [parent, ...children];
    rewriteModelRefs(normalizedModels, services, new Map(steps.map(({ model, onto }) => [model.name, onto])), webhooks);
    for (const { model } of steps) byName.delete(model.name);
    console.warn(
      `[oagen] Merged "${jsonModel.name}" into "${baseModel.name}" (${jsonModel.fields.length} fields, superset)`,
    );
    removed.add(jsonModel.name);
    // e.g. when AuditLogSchemaJson → AuditLogSchema, also rename
    // AuditLogSchemaJsonTarget → AuditLogSchemaTarget, or collapse it onto
    // an AuditLogSchemaTarget that already exists.
    for (const { model, newName, holder, onto } of children) {
      if (holder) {
        removed.add(model.name);
        console.warn(`[oagen] Collapsed child "${model.name}" into existing "${onto}"`);
      } else {
        model.name = newName;
        byName.set(newName, model);
        console.warn(`[oagen] Renamed child "${jsonModel.name}…" → "${newName}"`);
      }
    }
  }

  return normalizedModels.filter((m) => !removed.has(m.name));
}
