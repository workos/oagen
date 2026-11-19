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
 *
 * A name an operation mints from its stem is that operation's against the
 * document's names too (#712). `listDogs` returning an object that pins
 * `object: get_pet_response` names it `GetPetResponse` from the const, the
 * name `getPet` mints for its own response: the name stays `getPet`'s, and
 * what the document names so keeps it only while it is that very model —
 * the same kind, a model or an inline enum, of the same shape. Otherwise it
 * takes the next free numbered name (`GetPetResponse2`), one name for every
 * operation that returns it, with a note (`resolveDocumentNames`).
 */
import type { EnumRef, Model, ModelRef, TypeRef } from '../ir/types.js';
import { collectModelTypeRefs, renameModelRefs, renameTypeRefModels, walkTypeRef } from '../ir/types.js';
import { numberedName } from '../utils/naming.js';
import { shapeWithEnumFlags } from './enum-members.js';
import { isInheritedModelRef, shapeFingerprint } from './inline-models.js';
import { isComponentModelRef } from './schemas.js';

/**
 * What one operation's inline request and success bodies mint from its stem,
 * read off a rehearsal of them: the names that would be other names under
 * another stem. A name the document gives a model itself — a response named
 * from its `object` const (`PetOwner`), a variant named from its `title` or
 * its bare const, and what such a model nests — is no operation's: every
 * operation that returns it shares it, whatever stems its name happens to
 * hold, so it is not among these. It is among `documentNames`, read apart.
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
  /**
   * The names the bodies hold that the document gives — the ones the
   * operation holds under any stem — less every name decided before the
   * operations (a component schema's, a model or enum a component's field
   * mints), which is its owner's and settled against it by the merge passes.
   * What another operation's stem may turn out to mint
   * (`resolveDocumentNames`); absent, the operation holds none.
   */
  documentNames?: { models: string[]; enums: string[] };
  /**
   * The bodies as the rehearsal read them, for comparing what two operations
   * hold under one name: the types the bodies are read through and every
   * model they mint, the ones under `models` and `documentNames` among them.
   * The rehearsal's own, kept by nothing: what the operation gives up is
   * moved in them (`yieldBodyNames`) as it is decided, so a model is
   * compared as it ends. Absent, nothing of the operation is compared.
   */
  definitions?: { roots: readonly TypeRef[]; models: readonly Model[] };
}

/** The names one operation gives up, each with the name its model or inline enum takes instead. */
export type BodyNameYields = ReadonlyMap<string, string>;

/**
 * The stems among `stems` that contain another one or that another one
 * contains — as a prefix (`CreatePetResponseDraft` beside `CreatePet`) or
 * anywhere else (`EmailCreatePet` beside `CreatePet`). Only between two such
 * operations can a name both mint be given up by one of them
 * (`resolveContestedBodyNames`), so their bodies are the ones read under a
 * stand-in whatever names they hold; a name one operation mints and the
 * document gives another's is found among the names the operations hold
 * (`namesHeldAcrossStems`). An empty stem names nothing, so it contains
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
 * The names operations of more than one stem hold of which one of those
 * stems is a part: `GetPetResponse` beside `getPet` and `listDogs`, never a
 * `Pet` both return. Only such a name can be one operation's own and
 * another's by the document — a name minted from a stem carries the stem —
 * so only its holders are read once more to tell the two apart
 * (`OperationBodyNames.documentNames`). An empty stem names nothing, and is
 * part of no name.
 */
export function namesHeldAcrossStems(holders: Iterable<{ stem: string; names: Iterable<string> }>): Set<string> {
  const stemsOf = new Map<string, Set<string>>();
  for (const { stem, names } of holders) {
    for (const name of names) stemsOf.set(name, (stemsOf.get(name) ?? new Set<string>()).add(stem));
  }
  const shared = new Set<string>();
  for (const [name, stems] of stemsOf) {
    if (stems.size > 1 && [...stems].some((stem) => stem.length > 0 && name.includes(stem))) shared.add(name);
  }
  return shared;
}

/**
 * Settle every name more than one operation's bodies would hold — a name
 * two of them mint from their stems, by the stems alone, and a name one
 * mints and the document gives another's, by what the two hold under it —
 * and return what each operation gives up, by its key.
 *
 * An operation _claims_ every name its bodies mint from its stem
 * (`OperationBodyNames`): the stem followed by what the body is and the
 * fields on the way down — `CreatePetResponse`,
 * `CreatePetResponseDraftResponse` — or the stem behind the const a union
 * variant is named from (`EmailCreatePetRequest`). A name the document
 * gives a model is no claim, whatever it holds: `pet` and `petOwner` both
 * returning an `object: pet_owner` resource share one `PetOwner`, as every
 * operation returning it does. Of the operations that claim one name,
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
 * A name a claimant keeps is its own against the document's names as well:
 * a response `listDogs` names `GetPetResponse` from its `object` const
 * beside `getPet`'s own leaves the name to `getPet` unless it is that very
 * model (`resolveDocumentNames`).
 *
 * What an operation gives up takes the name numbered (`numberedName`:
 * `CreatePetResponseDraftResponse2`, `…3`), the first number under which it
 * is no name in play: every name the bodies of `bodies` mint or hold, every
 * name `taken` gives — the names decided before the operations (the
 * component models and enums, the models and enums their fields mint, the
 * component responses' bodies) and every name the operations pass mints with
 * the given-up names set aside — and every name already handed out here. So
 * a field `draft_response2`, a component or an enum of the numbered name, a
 * response of an operation outside the contest named
 * `CreatePetResponseDraftResponse2` from its `object` const, or a header or
 * parameter model of that name, moves it on to the next, and none of those
 * changes. `taken` is read once, and only when a name is given up: the
 * caller reads the whole pass for it, which a document with no contested
 * name never needs. The names are taken in code-unit order and, when
 * several operations give one name up (`get` and `getResponse` beside
 * `getResponseResponse`), the shorter stem takes the lower number, and what
 * the document names so the next one after the stems', one name for every
 * operation that holds it — so the outcome depends on the document's stems
 * and never on the order of its paths.
 *
 * Without `taken`, the reading is the one that learns those names: what an
 * operation gives up is set aside under a name no site can mint
 * (`setAsideName`), so every other site of the pass is named as it is when
 * the given-up models hold no name of their own yet. Nothing is announced
 * there: the note a document's name is moved with is printed once, by the
 * reading that takes the names.
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

  /** The stems that give each contested name up to another claimant, the shorter stem first. */
  const yielding = new Map<string, string[]>();
  for (const [name, stems] of claims) {
    const claimants = [...stems];
    if (claimants.length < 2) continue;
    const given = claimants
      .filter((stem) => claimants.some((other) => other !== stem && other.includes(stem)))
      // The shorter stem first; two of one length by code unit.
      .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    if (given.length > 0) yielding.set(name, given);
  }
  const documentNames = resolveDocumentNames(bodies, claims, yielding);
  if (yielding.size === 0 && documentNames.size === 0) return new Map();

  const inPlay = new Set(taken?.());
  for (const { models, enums, documentNames: held } of bodies) {
    for (const name of [...models, ...enums, ...(held?.models ?? []), ...(held?.enums ?? [])]) inPlay.add(name);
  }
  /** The first numbered form of `name` that is no name in play, or `aside` for the reading that learns them. */
  const freeName = (name: string, aside: string): string => {
    let renamed = taken ? numberedName(name, 2) : aside;
    for (let n = 3; taken && inPlay.has(renamed); n++) renamed = numberedName(name, n);
    inPlay.add(renamed);
    return renamed;
  };
  const byStem = new Map<string, Map<string, string>>();
  const giveUp = (stem: string, name: string, renamed: string): void => {
    const given = byStem.get(stem) ?? new Map<string, string>();
    given.set(name, renamed);
    byStem.set(stem, given);
  };
  // Each name in code-unit order: the stems that give it up, the shorter
  // first, then what the document names so.
  for (const name of [...new Set([...yielding.keys(), ...documentNames.keys()])].sort()) {
    for (const stem of yielding.get(name) ?? []) giveUp(stem, name, freeName(name, setAsideName(name, stem)));
    const moved = documentNames.get(name);
    if (!moved) continue;
    const renamed = freeName(name, setAsideName(name, ''));
    for (const stem of moved.stems) giveUp(stem, name, renamed);
    if (taken) {
      const shared = moved.stems.size > 1 ? ` (shared by ${moved.stems.size} operations)` : '';
      console.warn(
        `[oagen] Renamed inline ${moved.kind} "${name}" → "${renamed}": its shape differs from operation ${moved.keeper}'s own "${name}"${shared}`,
      );
    }
  }
  const yields = new Map<string, BodyNameYields>();
  for (const { key, stem } of bodies) {
    const given = byStem.get(stem);
    if (given) yields.set(key, given);
  }
  return yields;
}

/** A name the document gives that leaves it to the operation minting it from its stem (`resolveDocumentNames`). */
interface DocumentNameMove {
  /** The stems of the operations that hold what leaves the name. */
  stems: Set<string>;
  /** What leaves it: a model when any of those operations holds one, else an inline enum. */
  kind: 'model' | 'enum';
  /** The operation that keeps the name, as a note names it: `GET /pets/{petId}`. */
  keeper: string;
}

/**
 * The names the document gives that an operation's stem mints as well, each
 * with the operations whose model or inline enum leaves it (#712).
 *
 * `listDogs` returning an object that pins `object: get_pet_response` names
 * it `GetPetResponse`, as it would under any stem
 * (`OperationBodyNames.documentNames`); `getPet` mints the same name from
 * its stem for its own response. The merge kept one definition for both —
 * the one with more fields — so one operation was typed with the other's
 * fields, and adding either operation to a document retyped the other. The
 * name is the minting operation's — the claimant that keeps it once the
 * stems are settled (`yielding`) — whichever path is written first and
 * whichever body is larger: its own body is named from nothing else, and
 * adding an operation elsewhere never renames or retypes it. What the
 * document names so keeps the name only while it is that very model: the
 * same kind, a model or an inline enum, of the same shape
 * (`definitionShape`; the model's own `deprecated` aside, which the merge
 * passes settle between copies of one shape). An `owner` pinned
 * `object: get_pet_response_owner` that `getPet` nests and `listDogs`
 * returns is therefore still one `GetPetResponseOwner`, as before. Any
 * other definition leaves the name, in every operation that holds it, for
 * one name: the document names one thing, so the operations that return it
 * keep sharing it, settled among themselves as two bodies pinning one const
 * always were.
 *
 * A definition is compared as it ends. What each operation gives up to
 * another stem has left its name first, and a name is decided after every
 * name its two definitions reference, each moved as it is decided
 * (`OperationBodyNames.definitions`): a parent whose child has just left
 * `GetPetResponseOwner` no longer reads as `getPet`'s own parent and
 * leaves too, where one whose child is `getPet`'s very child is compared
 * on its own fields. A name read while it is being decided — two models
 * that reference each other — is read as kept, which ends the walk. An
 * operation given no definitions takes no part, on either side, and a name
 * no compared operation keeps is left to the merge passes, as is a name
 * only the document gives (two operations pinning one const to two
 * shapes).
 */
function resolveDocumentNames(
  bodies: readonly OperationBodyNames[],
  claims: ReadonlyMap<string, ReadonlySet<string>>,
  yielding: ReadonlyMap<string, readonly string[]>,
): Map<string, DocumentNameMove> {
  const moves = new Map<string, DocumentNameMove>();
  const holds = (body: OperationBodyNames, name: string): boolean =>
    body.documentNames?.models.includes(name) === true || body.documentNames?.enums.includes(name) === true;
  const compared = bodies.filter((body) => body.definitions !== undefined);
  if (
    !compared.some((body) => (body.documentNames?.models.length ?? 0) + (body.documentNames?.enums.length ?? 0) > 0)
  ) {
    return moves;
  }
  const move = (body: OperationBodyNames, given: BodyNameYields): void =>
    yieldBodyNames(given, body.definitions!.roots, body.definitions!.models);
  // What a stem gives up to another leaves its name before anything is compared.
  for (const body of compared) {
    const given = new Map<string, string>();
    for (const [name, stems] of yielding) if (stems.includes(body.stem)) given.set(name, setAsideName(name, body.stem));
    move(body, given);
  }
  /** The operations that keep `name`, in the order of their keys: those that mint it from a stem that gives it up to no other. */
  const keepersOf = (name: string): OperationBodyNames[] =>
    compared
      .filter(
        (body) =>
          claims.get(name)?.has(body.stem) === true &&
          yielding.get(name)?.includes(body.stem) !== true &&
          (body.models.includes(name) || body.enums.includes(name)),
      )
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const read = new Map<OperationBodyNames, Set<string>>();
  const decide = (body: OperationBodyNames, name: string): void => {
    const seen = read.get(body) ?? new Set<string>();
    read.set(body, seen);
    if (seen.has(name) || !holds(body, name)) return;
    seen.add(name);
    const keepers = keepersOf(name).filter((keeper) => keeper.stem !== body.stem);
    if (keepers.length === 0) return;
    // Every name either definition references first, in the operation that holds it.
    for (const holder of [body, ...keepers]) {
      for (const nested of referencedNames(holder, name)) decide(holder, nested);
    }
    const shape = definitionShape(body, name);
    if (shape === undefined || keepers.every((keeper) => definitionShape(keeper, name) === shape)) return;
    const moved = moves.get(name);
    moves.set(name, {
      stems: (moved?.stems ?? new Set<string>()).add(body.stem),
      kind: moved?.kind === 'model' || shape.startsWith('model:') ? 'model' : 'enum',
      keeper: operationLabelOf(keepers[0]!.key),
    });
    move(body, new Map([[name, setAsideName(name, '')]]));
  };
  for (const body of compared) {
    for (const name of [...(body.documentNames?.models ?? []), ...(body.documentNames?.enums ?? [])])
      decide(body, name);
  }
  return moves;
}

/**
 * What `body` holds under `name` as one string, for comparison with another
 * operation's (`resolveDocumentNames`): a model's shape — its fields, each
 * with its type, requiredness, limits and flags, and the model's own limits
 * and union structure, its `deprecated` and its documentation aside
 * (`shapeFingerprint`) — or an inline enum's members as a model's shape
 * reads them, in the order written with each one's deprecation
 * (`shapeWithEnumFlags`), each under its kind, so a model and an enum of
 * one name never compare alike. Undefined when the operation's bodies hold
 * neither.
 */
function definitionShape(body: OperationBodyNames, name: string): string | undefined {
  const { roots, models } = body.definitions!;
  const model = models.find((candidate) => candidate.name === name);
  if (model) return `model:${shapeFingerprint(model)}`;
  const found: EnumRef[] = [];
  for (const ref of [...roots, ...models.flatMap(collectModelTypeRefs)]) {
    walkTypeRef(ref, { enum: (enumRef) => void (enumRef.values && enumRef.name === name && found.push(enumRef)) });
  }
  return found[0] && `enum:${JSON.stringify(shapeWithEnumFlags(found[0]))}`;
}

/** Every model and inline enum name the model `body` holds under `name` references, its own aside; none for an enum. */
function referencedNames(body: OperationBodyNames, name: string): string[] {
  const model = body.definitions!.models.find((candidate) => candidate.name === name);
  const names = new Set<string>();
  for (const ref of model ? collectModelTypeRefs(model) : []) {
    walkTypeRef(ref, {
      model: (modelRef) => void names.add(modelRef.name),
      enum: (enumRef) => void (enumRef.values && names.add(enumRef.name)),
    });
  }
  names.delete(name);
  return [...names];
}

/** An operation's plan key (`get /pets/{petId}`) as a note names the operation: `GET /pets/{petId}`. */
function operationLabelOf(key: string): string {
  const space = key.indexOf(' ');
  return space < 0 ? key : `${key.slice(0, space).toUpperCase()}${key.slice(space)}`;
}

/**
 * The name a model or enum an operation gives up is set aside under while
 * the names in play are read (`resolveContestedBodyNames` without `taken`):
 * the name and the stem that gives it up around a `#`, which is no
 * character of a model or enum name — every one is PascalCased from the
 * document's words — so no site can mint it, no site steps for it, and two
 * operations that give one name up are set aside apart. What the document
 * names so, which leaves the name in every operation as one thing
 * (`resolveDocumentNames`), is set aside under the name and no stem
 * (`GetPetResponse#`), which no stem's own is: an empty stem gives nothing
 * up.
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
