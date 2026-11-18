/**
 * The names two operations' bodies would both mint, settled before any
 * operation is built (#683).
 *
 * Every model and inline enum an operation's inline request and success
 * bodies mint is named from the operation's stem — its `operationId`'s
 * (`CreatePet`) or its path-derived prefix (`PetsPost`) — followed by what
 * the body is (`Request`, `Response`, `Item`) and by the fields on the way
 * down (`CreatePetResponseOwner`). The names are concatenations, so they
 * are not unique by construction: `createPet` returning a `draft_response`
 * object names it `CreatePetResponseDraftResponse`, which is exactly the
 * response of `operationId: createPetResponseDraft`. Left alone, the merge
 * passes kept one definition for both — the one with more fields, the first
 * on a tie — so one operation was typed with fields it does not return, and
 * which one followed the order of the paths.
 *
 * Such a name is _contested_, and which operation keeps it is decided by
 * the stems alone: an operation gives the name up when another operation
 * that mints it has a stem that contains its own. `CreatePetResponseDraft` contains
 * `CreatePet`, so `createPetResponseDraft` keeps
 * `CreatePetResponseDraftResponse` — the name it mints directly for its own
 * body — and the model nested in `createPet`'s response takes the next free
 * numbered name (`CreatePetResponseDraftResponse2`). Whether the two shapes
 * agree takes no part, so a field added to either later changes that model
 * and renames nothing.
 */
import type { Model, ModelRef, TypeRef } from '../ir/types.js';
import { collectModelTypeRefs, renameModelRefs, renameTypeRefModels, walkTypeRef } from '../ir/types.js';
import { numberedName } from '../utils/naming.js';
import { isInheritedModelRef } from './inline-models.js';
import { isComponentModelRef } from './schemas.js';

/**
 * What one operation's inline request and success bodies mint from its stem,
 * read off a rehearsal of them: the names that would be other names under
 * another stem. A name the document gives a model itself — a response named
 * from its `object` const (`PetOwner`), a variant named from its `title` or
 * its bare const, and what such a model nests — is no operation's: every
 * operation that returns it shares it, whatever stems its name happens to
 * hold, so it is not among these.
 */
export interface OperationBodyNames {
  /** The operation's plan key, `${method} ${path}`. */
  key: string;
  /**
   * The stem the operation's models are named from: its `operationId`'s
   * (`operationIdModelBase`), or its path-derived prefix
   * (`resolvePathModelBaseNames`).
   */
  stem: string;
  /** Every model name the bodies mint from the stem, nested models and envelope companions included. */
  models: string[];
  /** Every inline enum name the bodies mint from the stem — an enum written on a field, an item or the body itself; never a `$ref` to a component enum. */
  enums: string[];
}

/** The names one operation gives up, each with the name its model or inline enum takes instead. */
export type BodyNameYields = ReadonlyMap<string, string>;

/**
 * The stems among `stems` that contain another one or that another one
 * contains — as a prefix (`CreatePetResponseDraft` beside `CreatePet`) or
 * anywhere else (`EmailCreatePet` beside `CreatePet`). Only between two such
 * operations can a name be given up (`resolveContestedBodyNames`), so only
 * their bodies are rehearsed. An empty stem names nothing, so it contains
 * nothing and nothing contains it.
 */
export function stemsInContest(stems: Iterable<string>): Set<string> {
  const distinct = [...new Set(stems)].filter((stem) => stem.length > 0);
  const contested = new Set<string>();
  for (const inner of distinct) {
    for (const outer of distinct) {
      if (outer.length <= inner.length || !outer.includes(inner)) continue;
      contested.add(inner);
      contested.add(outer);
    }
  }
  return contested;
}

/**
 * Settle every name more than one operation's bodies would mint, from the
 * operations' stems alone, and return what each operation gives up, by its
 * key.
 *
 * An operation _claims_ every name its bodies mint from its stem
 * (`OperationBodyNames`): the stem followed by what the body is and the
 * fields on the way down — `CreatePetResponse`,
 * `CreatePetResponseDraftResponse` — or the stem behind the const a union
 * variant is named from (`EmailCreatePetRequest`). A name the document
 * gives a model is no claim, whatever it holds: `pet` and `petOwner` both
 * returning an `object: pet_owner` resource share one `PetOwner`, as every
 * operation returning it does, and a response `pet` names `GetPetResponse`
 * from its `object` const beside `getPet`'s own is left to the merge passes
 * as before. Of the operations that claim one name,
 * each one whose stem another claimant's stem contains gives the name up:
 * `createPet` (`CreatePet`) gives `CreatePetResponseDraftResponse` up to
 * `createPetResponseDraft` (`CreatePetResponseDraft`), and gives
 * `EmailCreatePetRequest`, a body variant pinning `kind: email`, up to
 * `operationId: emailCreatePet`. The claimant no other claimant's stem
 * contains keeps the name; claimants whose stems are unrelated are not
 * settled here. A stem claims a name once, however many of `bodies` are
 * named from it: two paths that `$ref` one Path Item read one Operation
 * Object under one `operationId`, mint one model, and give up the same
 * names for the same ones.
 *
 * What an operation gives up takes the name numbered (`numberedName`:
 * `CreatePetResponseDraftResponse2`, `…3`), the first number under which it
 * is no name in play: every name the bodies of `bodies` mint, every name
 * `taken` gives — the names decided before the operations (the component
 * models and enums, the models and enums their fields mint, the component
 * responses' bodies) and every name the operations pass mints with the
 * given-up names set aside — and every name already handed out here. So a
 * field `draft_response2`, a component or an enum of the numbered name, a
 * response of an operation outside the contest named
 * `CreatePetResponseDraftResponse2` from its `object` const, or a header or
 * parameter model of that name, moves it on to the next, and none of those
 * changes. `taken` is read once, and only when a name is given up: the
 * caller reads the whole pass for it, which a document with no contested
 * name never needs. The names are taken in code-unit order and, when
 * several operations give one name up (`get` and `getResponse` beside
 * `getResponseResponse`), the shorter stem takes the lower number, so the
 * outcome depends on the document's stems and never on the order of its
 * paths.
 *
 * Without `taken`, the reading is the one that learns those names: what an
 * operation gives up is set aside under a name no site can mint
 * (`setAsideName`), so every other site of the pass is named as it is when
 * the given-up models hold no name of their own yet.
 */
export function resolveContestedBodyNames(
  bodies: readonly OperationBodyNames[],
  taken?: () => Iterable<string>,
): Map<string, BodyNameYields> {
  /** The stems that claim each name. */
  const claims = new Map<string, Set<string>>();
  for (const { stem, models, enums } of bodies) {
    // An empty stem names nothing and contains nothing.
    if (stem.length === 0) continue;
    for (const name of [...models, ...enums]) {
      // One stem, one claim: two paths that read one Operation Object mint one model.
      const claimants = claims.get(name) ?? new Set<string>();
      claims.set(name, claimants.add(stem));
    }
  }

  /** Each contested name, in code-unit order, with the stems that give it up, the shorter stem first. */
  const contested: Array<{ name: string; yielding: string[] }> = [];
  for (const name of [...claims.keys()].sort()) {
    const claimants = [...claims.get(name)!];
    if (claimants.length < 2) continue;
    const yielding = claimants
      .filter((stem) => claimants.some((other) => other !== stem && other.includes(stem)))
      // The shorter stem first; two of one length by code unit.
      .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    if (yielding.length > 0) contested.push({ name, yielding });
  }
  if (contested.length === 0) return new Map();

  const inPlay = new Set(taken?.());
  for (const { models, enums } of bodies) {
    for (const name of [...models, ...enums]) inPlay.add(name);
  }
  const byStem = new Map<string, Map<string, string>>();
  for (const { name, yielding } of contested) {
    for (const stem of yielding) {
      let renamed = taken ? numberedName(name, 2) : setAsideName(name, stem);
      for (let n = 3; taken && inPlay.has(renamed); n++) renamed = numberedName(name, n);
      inPlay.add(renamed);
      const given = byStem.get(stem) ?? new Map<string, string>();
      given.set(name, renamed);
      byStem.set(stem, given);
    }
  }
  const yields = new Map<string, BodyNameYields>();
  for (const { key, stem } of bodies) {
    const given = byStem.get(stem);
    if (given) yields.set(key, given);
  }
  return yields;
}

/**
 * The name a model or enum an operation gives up is set aside under while
 * the names in play are read (`resolveContestedBodyNames` without `taken`):
 * the name and the stem that gives it up around a `#`, which is no
 * character of a model or enum name — every one is PascalCased from the
 * document's words — so no site can mint it, no site steps for it, and two
 * operations that give one name up are set aside apart.
 */
export function setAsideName(name: string, stem: string): string {
  return `${name}#${stem}`;
}

/**
 * Move what an operation gives up (`resolveContestedBodyNames`) to the names
 * it takes instead, in place: each of `models` named like one, every
 * reference to it among the `roots` — the types the operation's bodies are
 * read through — and in the models' fields and variants, a union's
 * discriminator mapping following its variant (`renameTypeRefModels`,
 * `renameModelRefs`), and every inline enum of such a name, which carries
 * its name on its reference. Only a reference the bodies themselves minted
 * moves, by its identity: an explicit `$ref` to a component of the same name
 * (`isComponentModelRef`), a reference an `allOf` merge copied from another
 * component's field (`isInheritedModelRef`) and a `$ref` to a component
 * enum, which carries no values, stay as written. A name the operation
 * takes is no name it gives up, so a reference two holders share moves once.
 */
export function yieldBodyNames(yields: BodyNameYields, roots: readonly TypeRef[], models: readonly Model[]): void {
  if (yields.size === 0) return;
  const admit = (ref: ModelRef): boolean => !isComponentModelRef(ref) && !isInheritedModelRef(ref);
  const moveEnums = (ref: TypeRef): void => {
    walkTypeRef(ref, {
      enum: (enumRef) => {
        const renamed = enumRef.values ? yields.get(enumRef.name) : undefined;
        if (renamed !== undefined) enumRef.name = renamed;
      },
    });
  };
  for (const root of roots) {
    renameTypeRefModels(root, yields, admit);
    moveEnums(root);
  }
  for (const model of models) {
    renameModelRefs(model, yields, admit);
    for (const ref of collectModelTypeRefs(model)) moveEnums(ref);
  }
  for (const model of models) {
    const renamed = yields.get(model.name);
    if (renamed !== undefined) model.name = renamed;
  }
}

/** Whether `yields` moves one of `models` or an inline enum one of their fields or variants carries. */
export function yieldsAmong(yields: BodyNameYields, models: readonly Model[]): boolean {
  if (yields.size === 0) return false;
  return models.some((model) => {
    if (yields.has(model.name)) return true;
    let found = false;
    for (const ref of collectModelTypeRefs(model)) {
      walkTypeRef(ref, { enum: (enumRef) => void (enumRef.values && yields.has(enumRef.name) && (found = true)) });
    }
    return found;
  });
}
