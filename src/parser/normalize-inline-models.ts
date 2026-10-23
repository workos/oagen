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
  modelShares,
  recordFieldModelRename,
  shapeFingerprint,
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
 * enum names among them (`enums`), which no inline model may keep, whatever
 * its shape: when the component fields are settled before the operations
 * are read (`settleFieldInlineModels`), the names `spec.enums` holds — the
 * component enums and the inline enums lifted from the component schemas'
 * own fields, union variants and array items; when the merges run, every
 * enum name in play — those, and every inline enum an operation's or a
 * webhook's reference carries (`reservedNamesByKind`). A name minted here is
 * added to `reserved`, so both passes, and every mint within one, agree.
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
export function fieldInlineModelBundles(
  groups: FieldInlineModelGroup[],
  models: Model[],
  survivors?: FieldModelSurvivors,
): InlineModelBundle[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const survivorOf = (model: Model): Model => {
    if (!survivors) return model;
    const winner = survivors.folded.get(model);
    return winner && !survivors.componentNames.has(winner.name) ? winner : model;
  };
  return groups.map(({ parentName, fieldName, models: fieldModels }) => {
    const parent = byName.get(parentName);
    const field = parent?.fields.find((f) => f.name === fieldName);
    const own = field ? [field.type] : (parent?.fields.map((f) => f.type) ?? []);
    const siteModels = fieldModels.map(survivorOf);
    const shared = siteModels.flatMap((model) => survivors?.sharedRefs.get(model) ?? []);
    return {
      qualifier: parentName,
      roots: [...own, ...inheritedModelRefsOf(parentName, fieldName), ...shared],
      models: siteModels,
      renamed: (from, to) => recordFieldModelRename(parentName, fieldName, from, to),
    };
  });
}

/**
 * What a field's site holds once the fields are settled and the operations
 * read (`fieldInlineModelBundles` at the merges): `folded`, from
 * `settleFieldInlineModels`, names the definition each dropped copy folded
 * onto, so an object the component pass itself minted for the field stands
 * in for the copy and can be renamed through the field — never a component
 * (`componentNames`), which is never renamed; `sharedRefs`, from
 * `extractOperations`, are the references a header, parameter or fallback
 * body wrote by sharing such a model, which the site repoints with the
 * field's own.
 */
export interface FieldModelSurvivors {
  folded: ReadonlyMap<Model, Model>;
  componentNames: ReadonlySet<string>;
  sharedRefs: ReadonlyMap<Model, readonly TypeRef[]>;
}

/**
 * Every type name the document will have minted by the time the IR is
 * finished, so a merge pass that must rename an inline model takes a name
 * nothing else has: the component models and enums, every inline model of
 * either pass (header models, list-envelope companions and union variants
 * included), and every inline enum — named on its `EnumRef` when the field,
 * parameter or header was typed, and only lifted into `spec.enums` after the
 * merges have run — found in any model's fields or named-union variants, or
 * anywhere on an operation or webhook. `reservedNamesByKind` gives the same
 * set beside the enum names among it.
 */
export function reservedTypeNames(
  models: Model[],
  enums: Enum[],
  inlineModels: Model[],
  fieldInlineModels: Model[],
  services: Service[],
  webhooks: Webhook[] = [],
): Set<string> {
  return reservedNamesByKind(models, enums, inlineModels, fieldInlineModels, services, webhooks).all;
}

/**
 * `reservedTypeNames` (`all`) beside the enum names among them (`enums`):
 * every enum in `enums` and every inline enum a model's field or variant, an
 * operation's reference or a webhook's carries — every enum name in play,
 * which no inline model the merge passes settle may keep
 * (`InlineModelNaming.enums`). One walk decides both, so the two sets
 * always agree on what an `EnumRef` names.
 */
export function reservedNamesByKind(
  models: Model[],
  enums: Enum[],
  inlineModels: Model[],
  fieldInlineModels: Model[],
  services: Service[],
  webhooks: Webhook[] = [],
): { all: Set<string>; enums: Set<string> } {
  const all = new Set<string>();
  const enumNames = new Set<string>();
  const visit = (ref: TypeRef): void => {
    walkTypeRef(ref, {
      enum: (r) => {
        all.add(r.name);
        enumNames.add(r.name);
      },
    });
  };
  for (const model of [...models, ...inlineModels, ...fieldInlineModels]) {
    all.add(model.name);
    for (const ref of collectModelTypeRefs(model)) visit(ref);
  }
  for (const e of enums) {
    all.add(e.name);
    enumNames.add(e.name);
  }
  for (const service of services) {
    for (const op of service.operations) for (const ref of collectOperationTypeRefs(op)) visit(ref);
  }
  for (const webhook of webhooks) for (const ref of collectWebhookTypeRefs(webhook)) visit(ref);
  return { all, enums: enumNames };
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
 * - folds onto a live owner, with the same warning, when the owner shares
 *   its name with it (`ownerSharesWith`, the flag read apart from the shape
 *   by `flagAdmits`): the copy is dropped and its references resolve to the
 *   owner, the deprecated schema's own field, parameter or envelope field
 *   still carrying the flag (a request body or response has no flag of its
 *   own to carry it). An owner is never renamed and never takes a
 *   contender's flag; a deprecated owner shares its name with no live copy,
 *   whatever their shapes, so a live inline copy never folds onto a
 *   deprecated component;
 * - otherwise takes a name of its own (`renameInlineCopy`).
 *
 * A contender whose flag agrees with an owner's
 *
 * - folds onto the owner when the owner shares its name with it
 *   (`ownerSharesWith`: `modelAdmits` — the same fields and types, the owner
 *   no stricter on requiredness or nullability, everything else identical —
 *   or an identical shape for a copy the SDK sends): the copy is dropped and
 *   its references, which already carry the name, resolve to the owner. An
 *   owner is never replaced, whatever the copy's field count, so every
 *   `$ref` to a component keeps the shape the document declares;
 * - otherwise takes a name of its own (`renameInlineCopy`), with a note. Two
 *   contenders of one name without an owner are left to the pass's own choice
 *   (`keepLargestByName`).
 *
 * A contender named like an enum (`naming.enums`) with no owner of that
 * name takes a name of its own whatever its shape or flag, with a note —
 * identical copies one name per shape, as under an owner (`renameClusters`):
 * an enum admits no model, so the IR never declares a model and an enum
 * under one name. A name both a component model and an enum hold is the
 * document's own clash and is settled as the model's.
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
    // A name an enum holds (`naming.enums`) is no model's, whatever the
    // copy's shape or flag: nothing admits it and nothing folds onto it, so
    // every copy leaves the name through its site, identical copies sharing
    // one model under the new name as they do under an owner's
    // (`renameClusters`). Live and deprecated copies never share a model
    // (`differOnlyByDeprecation`), so each flag's copies cluster on their
    // own. A name both a component model and an enum hold is the document's
    // own clash and is settled as the model's, below.
    if (!owner && naming?.enums.has(name)) {
      for (const deprecated of [false, true]) {
        renameClusters(
          name,
          group.filter((copy) => !!copy.deprecated === deprecated),
          naming,
          bundleOf,
          folded,
          `enum "${name}" owns the name`,
          `[oagen] Warning: Inline model "${name}" is named like enum "${name}" and has no site to be renamed from — keeping both under the shared name`,
        );
      }
      continue;
    }
    let nameDeprecated: boolean;
    /** The live contenders a deprecated copy may fold onto; empty under an owner, which every copy is measured against instead (`ownerSharesWith`). */
    let live: Model[] = [];
    if (owner) {
      nameDeprecated = !!owner.deprecated;
    } else {
      live = group.filter((m) => !m.deprecated);
      if (live.length === 0 || live.length === group.length) continue;
      nameDeprecated = false;
    }

    // Under an owner, every copy is measured against it first: one the
    // owner shares its name with (`ownerSharesWith`, the flag read by
    // `flagAdmits`) is folded onto it — a deprecated copy onto a live owner
    // with the warning two inline copies get, since the shared name keeps
    // the live definition; a deprecated owner shares with no live copy. The
    // copies that agree with the name's flag and that the owner does not
    // share leave the owner's name, one model per shape (`renameClusters`).
    // A copy whose flag disagrees and that the owner does not share is
    // renamed below.
    const clashing: Model[] = [];
    for (const copy of group) {
      if (!owner) continue;
      const bundle = naming && bundleOf.get(copy);
      if (ownerSharesWith(owner, copy, bundle)) {
        if (!!copy.deprecated !== nameDeprecated) {
          console.warn(
            `[oagen] Warning: Inline model "${name}" is declared both deprecated and live with the same shape — keeping the live definition under the shared name`,
          );
        }
        folded.set(copy, owner);
        continue;
      }
      if (!!copy.deprecated !== nameDeprecated) continue;
      clashing.push(copy);
    }
    renameClusters(
      name,
      clashing,
      naming,
      bundleOf,
      folded,
      `its shape differs from component schema "${name}"`,
      `[oagen] Warning: Inline model "${name}" has a different shape than component schema "${name}" and has no site to be renamed from — using the component schema`,
    );

    for (const copy of group) {
      if (!!copy.deprecated === nameDeprecated || folded.has(copy)) continue;
      // Without an owner, a deprecated copy folds only when every live copy
      // of the name is its twin but for the flag: then whichever live
      // definition the shared name carries, the copy is interchangeable with
      // it. Live copies that disagree among themselves (requiredness, say)
      // are settled by document order, as always; a deprecated copy must not
      // inherit that order, so it is qualified whenever they disagree.
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
 * Whether `owner`, a component, shares its name with `copy` (`modelShares`):
 * when it admits the shape (`modelAdmits`) — or, for a copy the SDK sends
 * (`bundle.sent`: a request body, a parameter), only when the shapes are
 * identical, since a caller typed against a looser component could leave
 * out what the operation requires — the flag read apart from the shape
 * either way (`flagAdmits`: a live owner shares with a deprecated copy, a
 * deprecated owner only with a deprecated one). The same question
 * `ownerShares` answers for the shape registry.
 */
function ownerSharesWith(owner: Model, copy: Model, bundle: InlineModelBundle | undefined): boolean {
  return modelShares(owner, copy, !!bundle?.sent);
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
 * Move `copies` — contenders of `name` that may not keep it, whether a
 * component of another shape or an enum holds it — off the name, one model
 * per shape: the copies are clustered by shape in document order
 * (`modelFingerprint`), the first of a cluster with a site is renamed
 * through it (`renameInlineCopy`) and every later one is repointed to that
 * name (`repointSite`) and folded onto it, so identical copies that must
 * leave a name share one model under the new one, as they would share the
 * bare name with no claimant (`keepLargestByName`). Each cluster's rename is
 * noted as `[oagen] Renamed inline model "<name>" → "<renamed>": <reason>`,
 * with the number of sites when more than one shares it. A copy without a
 * site cannot be renamed and is left under `name`, `noSite` said for each.
 * The copies must agree on `deprecated`: a cluster never joins a live copy
 * to a deprecated one (`differOnlyByDeprecation`).
 */
function renameClusters(
  name: string,
  copies: readonly Model[],
  naming: InlineModelNaming | undefined,
  bundleOf: ReadonlyMap<Model, InlineModelBundle>,
  folded: Map<Model, Model>,
  reason: string,
  noSite: string,
): void {
  const clusters = new Map<string, Model[]>();
  for (const copy of copies) {
    const shape = modelFingerprint(copy);
    clusters.set(shape, [...(clusters.get(shape) ?? []), copy]);
  }
  for (const cluster of clusters.values()) {
    let renamed: string | undefined;
    let leader: Model | undefined;
    for (const copy of cluster) {
      const bundle = naming && bundleOf.get(copy);
      if (!naming || !bundle) {
        console.warn(noSite);
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
        `[oagen] Renamed inline model "${name}" → "${renamed}": ${reason}${sites > 1 ? ` (shared by ${sites} sites)` : ''}`,
      );
    }
  }
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
  return shapeFingerprint(a) === shapeFingerprint(b);
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

/** Every type reference in play: each model's fields and variants, each operation's, each webhook's. */
function typeRefsInPlay(
  models: readonly Model[],
  services: readonly Service[],
  webhooks: readonly Webhook[],
): TypeRef[] {
  const refs: TypeRef[] = [];
  for (const model of models) refs.push(...collectModelTypeRefs(model));
  for (const service of services) for (const op of service.operations) refs.push(...collectOperationTypeRefs(op));
  for (const webhook of webhooks) refs.push(...collectWebhookTypeRefs(webhook));
  return refs;
}

/**
 * Repoint every model reference in `models`, `services` and `webhooks`
 * through `renames` in one pass — fields, named-union variants and
 * discriminator mappings alike — each reference read once, so a name one
 * entry vacates and another takes is never chained through; and, when
 * `inlineEnumName` is given, rename every inline enum reference — one
 * carrying its `values`, named by the extractor after the model and field
 * it sits in — through it the same way, returning each name so renamed with
 * the name it was given. A component enum reference carries no values and
 * is left as written.
 */
function rewriteModelRefs(
  models: Model[],
  services: Service[],
  renames: ReadonlyMap<string, string>,
  webhooks: Webhook[] = [],
  inlineEnumName?: (name: string) => string,
): Map<string, string> {
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
  const enumRenames = new Map<string, string>();
  if (!inlineEnumName) return enumRenames;
  for (const ref of typeRefsInPlay(models, services, webhooks)) {
    walkTypeRef(ref, {
      enum: (r) => {
        if (!r.values) return;
        const name = inlineEnumName(r.name);
        if (name === r.name) return;
        enumRenames.set(r.name, name);
        r.name = name;
      },
    });
  }
  return enumRenames;
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
 * component admits it — a deprecated one beside a live component included,
 * the field keeping the flag — and is dropped, the field resolving to the
 * component; one the component does not admit, a live one beside a
 * deprecated component included, takes its qualified name now
 * (`PetOwner2`), its field and every `allOf` copy of it repointed
 * (`settleSharedNames`). Settling the fields first means every
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
 * operations' survivors only (`mergeFieldInlineModels`). `folded`, when
 * given, receives each dropped copy keyed to the model it folded onto — the
 * component, or the object the component pass itself minted for the same
 * field — so the field's site can stand in for the survivor later
 * (`fieldInlineModelBundles`).
 */
export function settleFieldInlineModels(
  components: Model[],
  fieldInlineModels: Model[],
  naming?: InlineModelNaming,
  folded?: Map<Model, Model>,
): Model[] {
  return settleAgainstComponents(components, fieldInlineModels, naming, folded);
}

/**
 * `contenders` settled against `components` (`settleSharedNames`), minus
 * those that folded onto one and those still named like one — a kept copy
 * still carrying a component's name had no site to be renamed from, and the
 * component's definition stands. `folded`, when given, receives each folded
 * copy keyed to the definition that replaced it.
 */
function settleAgainstComponents(
  components: Model[],
  contenders: Model[],
  naming?: InlineModelNaming,
  folded?: Map<Model, Model>,
): Model[] {
  const owners = new Map(components.map((m) => [m.name, m]));
  const settled = settleSharedNames(owners, contenders, naming);
  for (const [copy, winner] of settled.folded) folded?.set(copy, winner);
  return settled.kept.filter((model) => !owners.has(model.name));
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
 * The shape `base` has once `json` folds onto it, as a model of its own:
 * `json`'s fields and its named-union metadata — `variants`,
 * `compositionKind` and `discriminator`, each present or absent exactly as
 * on `json`, so a fold never turns a named union back into a plain object —
 * the two models' own limits (minProperties, dependentRequired, ...) merged
 * with `json`'s winning where both speak, `base`'s own link or `json`'s
 * where it has none, and `base`'s name, description and `deprecated`:
 * deprecation names the type the SDK exposes, and that is `base`, so a
 * deprecated `<Name>Json` folded into a live `<Name>` leaves `<Name>` live.
 * A base that dispatches by rules `json` does not preserve is never folded
 * (`collapseJsonSuffixModels` refuses it), so this only ever adds union
 * metadata to a plain base or replaces a union's with identical rules. The
 * plan reads it to decide what the folded base admits before anything is
 * written; `applyFold` writes it. Every site that copies one model's shape
 * onto another goes through these two.
 */
function foldedShape(base: Model, json: Model): Model {
  const shape: Model = { ...base, fields: json.fields };
  delete shape.variants;
  delete shape.compositionKind;
  delete shape.discriminator;
  if (json.variants) shape.variants = json.variants;
  if (json.compositionKind) shape.compositionKind = json.compositionKind;
  if (json.discriminator) shape.discriminator = json.discriminator;
  if (json.constraints || base.constraints) shape.constraints = { ...base.constraints, ...json.constraints };
  if (!base.externalDocs && json.externalDocs) shape.externalDocs = json.externalDocs;
  return shape;
}

/** Write `foldedShape(base, json)` onto `base`, in place. */
function applyFold(base: Model, json: Model): void {
  const shape = foldedShape(base, json);
  delete base.variants;
  delete base.compositionKind;
  delete base.discriminator;
  Object.assign(base, shape);
}

/** A `<Name>Json` model and the `<Name>` model it may fold onto. */
interface FoldCandidate {
  readonly jsonModel: Model;
  readonly baseModel: Model;
}

/**
 * How every name reads once the `accepted` folds are applied, as a function
 * of the names the models hold now: a name that begins with an accepted
 * `…Json` model's name is read with that prefix replaced by its base's —
 * the longest such prefix first, then again, until no accepted `…Json` name
 * is a prefix — so `PetJson` reads as `Pet`, `PetJsonWithA` as `PetWithA`,
 * `PetJsonJsonThing` as `PetThing` by way of `PetJsonThing`, and
 * `NoteJsonPetJsonToy` as `NotePetToy` under the folds of `NoteJsonPetJson`
 * and `NoteJson`, whichever the document declares first. Every step
 * shortens the name, so the reading ends. A name no accepted fold touches
 * reads as it is: the fold renames no literal and no component enum.
 */
function foldReading(accepted: readonly FoldCandidate[]): (name: string) => string {
  const swaps = accepted
    .map((candidate) => [candidate.jsonModel.name, candidate.baseModel.name] as const)
    .sort(([a], [b]) => b.length - a.length);
  const read = new Map<string, string>();
  const reading = (name: string): string => {
    const known = read.get(name);
    if (known !== undefined) return known;
    const swap = swaps.find(([json]) => name.startsWith(json));
    const result = swap ? reading(swap[1] + name.slice(swap[0].length)) : name;
    read.set(name, result);
    return result;
  };
  return reading;
}

/** The accepted fold whose `…Json` name is the longest prefix of `name` — the one `foldReading` applies to it first — or none when no fold renames it. */
function innermostFold(accepted: readonly FoldCandidate[], name: string): FoldCandidate | undefined {
  let innermost: FoldCandidate | undefined;
  for (const candidate of accepted) {
    if (!name.startsWith(candidate.jsonModel.name)) continue;
    if (!innermost || candidate.jsonModel.name.length > innermost.jsonModel.name.length) innermost = candidate;
  }
  return innermost;
}

/** The names of the models `model` dispatches to — every model reference among its variants — read under `readName`. */
function variantModelNames(model: Model, readName: (name: string) => string): Set<string> {
  const names = new Set<string>();
  for (const variant of model.variants ?? []) walkTypeRef(variant, { model: (r) => names.add(readName(r.name)) });
  return names;
}

/**
 * Fold every `<Name>Json` model that is a superset of a `<Name>` model onto
 * it: `<Name>` takes the `…Json` model's shape, every reference to the
 * `…Json` model resolves to `<Name>`, and every `<Name>Json…` child — a
 * model the extractor named under it, or any model spelled that way, inline
 * enums included — is renamed `<Name>…`, or collapsed onto the model that
 * ends under that name when there is one.
 *
 * Pass 1 keeps, as a candidate, each `…Json` model whose base admits the
 * fold on its own terms (the guards below, read against the models as the
 * document left them). Pass 2 decides the candidates together, so the
 * result depends on the document's names and shapes and never on the order
 * it declares them in: every name is read as it ends once the accepted
 * folds are applied (`foldReading`, every model and inline enum reference
 * through `ShapeReadOptions.readName`), a base as the shape it takes
 * (`foldedShape`), and
 *
 * - a candidate whose base dispatches by union rules the `…Json` model does
 *   not preserve, or declares a field the `…Json` model's does not admit
 *   (`fieldAdmits`), is refused;
 * - the models that end under one name are one group: with a model the
 *   folds leave under its own name among them, that model is the holder and
 *   must admit every other (`modelAdmits`), which collapses onto it;
 *   without one, every member must be equivalent (each admits each) and the
 *   first declared keeps the name while the others collapse onto it. A
 *   member not admitted refuses the fold that renames it — the innermost,
 *   when several do — with the union-rules warning when that fold's base
 *   dispatches to the name, else a shape warning. Two folds whose children
 *   would end under one name with different shapes refuse each other.
 *
 * A refusal changes how the remaining names read, so the decision is
 * repeated over the folds still accepted until none is refused; a fold is
 * only ever refused, never re-admitted, so this ends. Only then is anything
 * written: each base takes its shape (`applyFold`), every reference is
 * repointed through the reading at once (`rewriteModelRefs`), the folded
 * `…Json` models and the collapsed members are dropped, and the names are
 * set. Nothing is collapsed by name alone, and nothing is half-applied.
 *
 * An inline enum a fold renames was lifted into `enums` under its old name
 * by the component pass (a `…Json` component's field enum): once no
 * reference carries that name, the entry is dropped and the collectors
 * that run after the fold lift the renamed reference afresh — onto the
 * base's own enum when one has its members (`PetJsonStatus` folds into
 * `PetStatus`), under the new name otherwise (`PetJsonMode` becomes
 * `PetMode`), stepping around a different enum of that name as they do
 * for any inline enum. An enum in `componentNames` is declared by the
 * document and stays whether referenced or not.
 */
export function collapseJsonSuffixModels(
  models: Model[],
  services: Service[],
  webhooks: Webhook[] = [],
  enums: Enum[] = [],
  componentNames: ReadonlySet<string> = new Set(),
): Model[] {
  const normalizedModels = [...models];
  const byName = new Map(normalizedModels.map((m) => [m.name, m]));

  // Pass 1: the candidates, each pair on its own, as the document left them.
  const candidates: FoldCandidate[] = [];
  for (const model of normalizedModels) {
    if (!model.name.endsWith('Json')) continue;

    const baseName = model.name.slice(0, -4);
    const baseModel = byName.get(baseName);
    if (!baseModel || model.fields.length <= baseModel.fields.length) continue;

    const jsonFields = new Set(model.fields.map((f) => f.name));
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

    candidates.push({ jsonModel: model, baseModel });
  }

  // Pass 2: the folds that hold together, decided as a whole.
  const unionRulesWarning = ({ jsonModel, baseModel }: FoldCandidate): string =>
    `[oagen] Warning: Json-suffix model "${jsonModel.name}" does not preserve the union rules of "${baseModel.name}" — keeping both`;
  const shapeWarning = ({ jsonModel, baseModel }: FoldCandidate, detail: string): string =>
    `[oagen] Warning: Json-suffix model "${jsonModel.name}" does not preserve the shape of "${baseModel.name}": ${detail} — keeping both`;

  let accepted = candidates;
  let read = foldReading(accepted);
  for (;;) {
    const readName = read;
    const options: ShapeReadOptions = { readName };
    const jsonOf = new Map(accepted.map((candidate) => [candidate.baseModel, candidate.jsonModel]));
    const shapeOf = (model: Model): Model => {
      const json = jsonOf.get(model);
      return json ? foldedShape(model, json) : model;
    };
    const refused = new Set<FoldCandidate>();
    const refuse = (candidate: FoldCandidate, warning: string): void => {
      if (refused.has(candidate)) return;
      refused.add(candidate);
      console.warn(warning);
    };

    for (const candidate of accepted) {
      const { jsonModel, baseModel } = candidate;

      // Guard: the base is a union — a named union's variants, composition
      // keyword and discriminator, or an allOf+oneOf dispatcher's mapping
      // (such a base may have no fields at all) — that the Json model does
      // not preserve: it has no variants or rules, or different ones.
      // Folding would turn the dispatcher into a plain object, or swap its
      // variants or rules, under operations that already use it (two
      // undiscriminated unions share the rules `oneOf` while dispatching to
      // different members). The variants and the mapping's targets are read
      // under the folds on both sides, so `PetJsonWithName` matches
      // `PetWithName`, and an inline `PetJsonState` enum matches `PetState`
      // with the same members and no other; a literal, or a component
      // enum, as it is. The models the variants name are compared below, as
      // every folded child is. Identical shapes fold as before.
      const baseShape = unionShapeKey(baseModel, (v) => typeShapeKey(v, options), { modelName: readName });
      const jsonShape = unionShapeKey(jsonModel, (v) => typeShapeKey(v, options), { modelName: readName });
      if (baseShape !== '' && baseShape !== jsonShape) {
        refuse(candidate, unionRulesWarning(candidate));
        continue;
      }

      // Guard: a field both declare must be one the Json model's describes
      // every value of the base's for (`fieldAdmits`: the same type, limits,
      // default and flags, the Json model's no stricter on requiredness or
      // nullability), since the base takes the Json model's fields under
      // operations that already use it. A field that shares only its name
      // — `a: integer` beside `a: string`, or required beside optional —
      // would retype the base, so the fold is refused.
      const jsonFields = new Map(jsonModel.fields.map((f) => [f.name, f]));
      const retyped = baseModel.fields.find((f) => !fieldAdmits(jsonFields.get(f.name)!, f, options));
      if (retyped) refuse(candidate, shapeWarning(candidate, `field "${retyped.name}" has a different shape`));
    }

    // Guard: the models that end under one name. A `<Json>…` child that
    // collapses — a variant model of the union, a nested object, or any
    // model spelled that way — must be admitted by the model it collapses
    // onto (both read under the folds), since the child's references then
    // resolve to it and a field the child adds would be lost: a variant of
    // another shape is a different variant even when the fold would give it
    // the base's name. The flag is read as `modelAdmits` reads it
    // (`flagAdmits`): a deprecated child collapses onto a live holder, as a
    // deprecated `<Name>Json` folds onto a live `<Name>`, and a live child
    // never onto a deprecated one.
    const folded = new Set(accepted.map((candidate) => candidate.jsonModel));
    const groups = new Map<string, Model[]>();
    for (const model of normalizedModels) {
      if (folded.has(model)) continue;
      const name = readName(model.name);
      const group = groups.get(name);
      if (group) group.push(model);
      else groups.set(name, [model]);
    }
    for (const [name, members] of groups) {
      if (members.length < 2) continue;
      const admits = (owner: Model, member: Model): boolean => modelAdmits(shapeOf(owner), shapeOf(member), options);
      const refuseMember = (member: Model, detail: string): void => {
        const fold = innermostFold(accepted, member.name)!;
        refuse(
          fold,
          variantModelNames(fold.baseModel, readName).has(name) ? unionRulesWarning(fold) : shapeWarning(fold, detail),
        );
      };
      const holder = members.find((member) => member.name === name);
      if (holder) {
        for (const member of members) {
          if (member !== holder && !admits(holder, member)) {
            refuseMember(member, `"${member.name}" would fold onto "${name}", which has a different shape`);
          }
        }
        continue;
      }
      const equivalent = (a: Model, b: Model): boolean => admits(a, b) && admits(b, a);
      for (const member of members) {
        const other = members.find((candidate) => candidate !== member && !equivalent(member, candidate));
        if (other) {
          refuseMember(
            member,
            `"${member.name}" would fold onto "${name}" beside "${other.name}", which has a different shape`,
          );
        }
      }
    }

    if (refused.size === 0) break;
    accepted = accepted.filter((candidate) => !refused.has(candidate));
    read = foldReading(accepted);
  }

  // Apply: shapes, then every reference at once, then names.
  const renames = new Map<string, string>();
  for (const model of normalizedModels) {
    const name = read(model.name);
    if (name !== model.name) renames.set(model.name, name);
  }
  for (const { baseModel, jsonModel } of accepted) applyFold(baseModel, jsonModel);
  const enumRenames = rewriteModelRefs(normalizedModels, services, renames, webhooks, read);

  const removed = new Set<Model>(accepted.map((candidate) => candidate.jsonModel));
  // The model that keeps each name: the one the folds leave under it, else
  // the first declared of those that end under it.
  const keepers = new Map<string, Model>();
  for (const model of normalizedModels) {
    if (removed.has(model)) continue;
    const name = read(model.name);
    if (!keepers.has(name) || model.name === name) keepers.set(name, model);
  }
  for (const candidate of accepted) {
    const { jsonModel, baseModel } = candidate;
    console.warn(
      `[oagen] Merged "${jsonModel.name}" into "${read(baseModel.name)}" (${jsonModel.fields.length} fields, superset)`,
    );
    // e.g. when AuditLogSchemaJson → AuditLogSchema, also rename
    // AuditLogSchemaJsonTarget → AuditLogSchemaTarget, or collapse it onto
    // an AuditLogSchemaTarget that already exists.
    for (const model of normalizedModels) {
      if (removed.has(model) || innermostFold(accepted, model.name) !== candidate) continue;
      const name = read(model.name);
      if (keepers.get(name) === model) {
        console.warn(`[oagen] Renamed child "${jsonModel.name}…" → "${name}"`);
      } else {
        removed.add(model);
        console.warn(`[oagen] Collapsed child "${model.name}" into existing "${name}"`);
      }
    }
  }
  for (const model of normalizedModels) if (!removed.has(model)) model.name = read(model.name);
  const kept = normalizedModels.filter((m) => !removed.has(m));

  // A lifted enum the renames left unreferenced.
  if (enumRenames.size > 0) {
    const inPlay = new Set<string>();
    for (const ref of typeRefsInPlay(kept, services, webhooks)) walkTypeRef(ref, { enum: (r) => inPlay.add(r.name) });
    for (const [oldName, newName] of enumRenames) {
      if (componentNames.has(oldName) || inPlay.has(oldName)) continue;
      const index = enums.findIndex((e) => e.name === oldName);
      if (index < 0) continue;
      enums.splice(index, 1);
      console.warn(`[oagen] Folded enum "${oldName}" into "${newName}"`);
    }
  }

  return kept;
}
