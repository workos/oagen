/**
 * Materialize an inline schema that is not a model field — a response
 * header, a `default`/`nXX` body, a secondary content type — under names no
 * other model owns, through the extractor every field goes through.
 *
 * The schema is extracted as if it were a property of a parent (or of no
 * parent), so every shape a field can take is materialized under the name
 * `schemaToTypeRef` references it by, by construction. The resulting models
 * are checked against a spec-wide registry of model shapes; the rules for a
 * taken name are the same everywhere this is used (see
 * `materializeInlineSchema`).
 */
import type { Model, TypeRef } from '../ir/types.js';
import { collectModelTypeRefs, walkTypeRef } from '../ir/types.js';
import { toPascalCase } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { isComponentModelRef, schemaToTypeRef } from './schemas.js';
import { extractInlineModelsFromProperties, modelFingerprint, qualifyInlineModelName } from './inline-models.js';

// The model-shape fingerprint lives beside the schema-shape key in
// inline-models.ts, where the extractor compares models too; re-exported here
// for the registry's readers.
export { modelFingerprint };

/**
 * Spec-wide record of every name an inline model must not silently reuse:
 * the component models (seeded up front), each operation's primary response
 * and request body models, each header and fallback model materialized so
 * far — and every enum name, component or minted (`reserveEnumNames`), since
 * a model and an enum under one name reach an emitter as one public symbol.
 * A model's entry carries its shape fingerprint, so a model whose shape
 * matches can share the name, and — for operation-owned models — which
 * operation produced it, so a collision inside one operation can be told
 * apart from one across operations. An enum's entry carries
 * `ENUM_NAME_FINGERPRINT`, which no model's fingerprint equals, so a model
 * minted under an enum's name always clashes and moves on.
 */
export type InlineModelRegistry = Map<string, InlineModelOwner>;

export interface InlineModelOwner {
  fingerprint: string;
  operation?: string;
}

/**
 * The fingerprint an enum name is registered under. Every model fingerprint
 * (`modelFingerprint`) carries a `#` between its fields and the rest, so no
 * model can match this and share an enum's name.
 */
export const ENUM_NAME_FINGERPRINT = 'enum';

/** Record every model of `models` the registry does not know yet as owned by `operation`; the first owner keeps a name. */
export function registerInlineModels(registry: InlineModelRegistry, models: Model[], operation?: string): void {
  for (const model of models) {
    if (registry.has(model.name)) continue;
    registry.set(model.name, { fingerprint: modelFingerprint(model), operation });
  }
}

/**
 * Record every name of `names` the registry does not know yet as an enum's,
 * so no inline model is materialized under it (`ENUM_NAME_FINGERPRINT`). A
 * name a model already owns keeps the model's entry: that is the document's
 * own clash, not one the registry can move.
 */
export function reserveEnumNames(registry: InlineModelRegistry, names: Iterable<string>): void {
  for (const name of names) {
    if (!registry.has(name)) registry.set(name, { fingerprint: ENUM_NAME_FINGERPRINT });
  }
}

/**
 * One site's settlement, kept for the sites of the same bare name after it:
 * the stem it settled on and, in order, every rename made under that stem —
 * the ones `renameClashing` made (`Circle` → `BodyCircle`) and the ones it
 * replayed from an earlier site. A later site trying the stem replays the
 * renames on its own trial before comparing (`runTrial`), so a schema
 * identical to the earlier site's builds exactly the earlier site's names
 * and shares every model; compared as extracted, its root would still
 * reference `Circle`, fingerprint differently from the earlier root, and a
 * second root and child would be minted.
 */
export interface SettledSite {
  stem: string;
  renames: ReadonlyArray<readonly [from: string, to: string]>;
}

/**
 * The settlements of the sites that derive from one bare name — the same
 * header on several status codes or operations, one media type's inline body
 * on several status codes — in the order the sites were resolved, one per
 * stem: the one container `materializeInlineSchema` writes to. The caller
 * creates it (`createSiblingSites`) and hands the same object to every site
 * of the bare name. Each call reads `settled`, tries those stems right after
 * the bare name (the bare name itself with the renames of the site that
 * settled on it), so a shape identical to an earlier site's shares that
 * site's model under whichever stem it took (`…Response200`, not a fresh
 * `…Response201`), and a different shape steps past them to the site's own
 * candidates; then it appends the site it settles — the only argument a call
 * mutates, and only this field of it.
 */
export interface SiblingSites {
  /** The settlements so far, in the order the sites were resolved; appended to by `materializeInlineSchema`. */
  readonly settled: SettledSite[];
}

/**
 * A settlement container for one bare name: empty, or seeded from `stems` —
 * the earlier string form (`SiblingStems`) read as settlements without
 * renames. The strings are copied, never written.
 */
export function createSiblingSites(stems: SiblingStems = []): SiblingSites {
  return { settled: stems.map((stem) => ({ stem, renames: [] })) };
}

/**
 * The form `siblings` took before a settlement carried its renames: the
 * stems earlier sites settled on, and nothing else. Read-only in type
 * (`readonly`, so a push is a type error) and in fact: `materializeInlineSchema`
 * copies it into a container of its own (`siblingSitesOf`), to the same result
 * a `SiblingSites` would give, and records this call's settlement in that
 * private container only — the array given, empty or frozen, is never
 * touched. A caller that wants the sites after this one to see the settlement
 * creates a `SiblingSites` and passes it to each of them.
 */
export type SiblingStems = readonly string[];

/**
 * The form `siblings` took between the string form and the container: a
 * bare list of settlements. Accepted so a caller on that form keeps
 * compiling. A non-empty list is used as the container's `settled` list
 * itself — this call appends to it, as it did then. An empty array has no
 * element to tell it from the string form, so it is read as that form:
 * read-only, never written (`siblingSitesOf`).
 */
export type SettledSites = SettledSite[];

export interface MaterializeInlineOptions {
  /**
   * The property name to extract the schema under for the `index`-th stem:
   * the bare name first, then whatever qualifies it (a status code, an
   * operation, a numeric suffix). `firstClashOwners` is who owned the names
   * the first trial clashed with, for a caller that orders its candidates by
   * where the clash came from; empty while nothing has clashed.
   */
  stem: (index: number, firstClashOwners: InlineModelOwner[]) => string;
  /**
   * The settlements of the earlier sites of the same bare name, whose stems
   * are tried between the bare name and the caller's other candidates with
   * their renames replayed, and which this site's settlement is appended to:
   * a `SiblingSites` container the caller created, or a non-empty bare list
   * of settlements (`SettledSites`) — in either, the settled list is the one
   * thing this call mutates — or the read-only string form, `SiblingStems`,
   * copied into a container of this call's own; an empty array is read as
   * the string form. Absent, only the caller's candidates are tried and
   * nothing is recorded.
   */
  siblings?: SiblingSites | SettledSites | SiblingStems;
  /** The parent the schema is a property of; none for a body. */
  parentName?: string;
  componentSchemas?: Record<string, SchemaObject>;
  registry: InlineModelRegistry;
  /** Recorded as the owner of every model registered here. */
  operation?: string;
  /** Where the materialized models go. */
  models: Model[];
}

/**
 * Attempts before the loop gives up moving names and numbers the clashing
 * ones in place. Each attempt either reserves names or advances the stem, and
 * the fixed-point test below stops it long before this; the cap is the
 * guarantee that no input can keep it going.
 */
const MAX_ATTEMPTS = 32;

/**
 * Rename rounds before settling gives up. Every rename picks a name nothing
 * owns and nothing in the trial uses, so each round settles at least one
 * model for good and the rounds end within the trial's size; the cap only
 * backs that.
 */
const MAX_RENAME_ROUNDS = 64;

/**
 * Type `schema` and materialize every model it names into `options.models`,
 * under names the registry does not already give another shape.
 *
 * A trial extracts the schema under the current stem and compares every model
 * it minted with the registry: a name whose owner has the same shape is
 * shared (so a header or body matching a component simply references it); a
 * name whose owner has another shape clashes. On a clash the loop makes the
 * cheapest move that can still change something:
 *
 *   1. reserve the clashing names — a `oneOf`/`anyOf` variant named from its
 *      own `title` or const (`Circle`) is minted from the schema, not the
 *      stem, so no stem would move it; reserved, variant naming steps around
 *      it the way it steps around a sibling's model (`CircleListPetsDefault…`);
 *   2. when every clashing name is already reserved and still minted (the
 *      root, nested objects, array items: names derived from the stem),
 *      advance the stem (`…2`, `…3`, or the caller's qualified candidates).
 *
 * The clashing set is compared between attempts: when a stem advance leaves
 * it unchanged, neither move can clear it (a titled variant nested below the
 * top level, where the reservation does not reach) — the fixed point — and
 * the loop stops rather than retrying forever. The earlier trial is then kept
 * and settled in place (`renameClashing`): the clashing names themselves are
 * renamed, qualified by the root model name (`ListPetsDefaultResponseCircle`)
 * then numbered, with every reference among the trial's models and in the
 * returned type rewritten to match; and because renaming a child changes its
 * parent's shape, the trial is checked again on its new fingerprints, so a
 * parent that matched a registered model before and differs from it now
 * moves to the next free stem with its children, instead of being dropped at
 * commit as already defined. That rewrite cannot tell an inline model's
 * reference from a `$ref` to a component MODEL of the same name, so a schema
 * that both inlines a clashing `Circle` and references component model
 * `Circle` fails loudly instead (`componentModelRefTargets`). A component
 * ENUM of the name is no such bar: a `$ref` to it is an `EnumRef`, which the
 * rewrite never touches, so the inline `Circle` is renamed under the root
 * and the enum reference stays. A rename replayed from an earlier site that
 * such a `$ref` to a component model would make unsafe is skipped, not failed
 * (`runTrial`).
 *
 * The stems are tried in the order `candidateStem` gives: the caller's bare
 * name, then the stems earlier sites of the same bare name settled on
 * (`options.siblings`), then the caller's own qualified candidates. A trial
 * under an earlier site's stem replays that site's renames first, so the
 * `application/vnd.pet+json` body of a 201 whose bare name a component owns
 * tries the `…Response200` its 200 settled on before its own `…Response201`,
 * and shares the 200's models when the shapes are identical — nested
 * `…Response200Circle` included — where a name-only comparison would mint a
 * second model of the same shape. The site's own settlement — the stem the
 * trial was under or the one its root moved to, with the renames made under
 * it — is appended to `options.siblings` for the sites after it.
 */
export function materializeInlineSchema(schema: SchemaObject, given: MaterializeInlineOptions): TypeRef {
  const options: ResolvedOptions = { ...given, siblings: siblingSitesOf(given.siblings) };
  const { registry } = options;
  const reserved = new Set<string>();
  let stemIndex = 0;
  let firstClashOwners: InlineModelOwner[] = [];
  const candidateAt = (index: number): Candidate => candidateStem(index, options, firstClashOwners);
  // The last clashing trial and the move made after it.
  let previous: { trial: Trial; move: 'reserve' | 'stem' } | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const trial = runTrial(schema, candidateAt(stemIndex), reserved, options);
    if (trial.clashing.length === 0) return commit(trial, options);

    if (firstClashOwners.length === 0) {
      firstClashOwners = trial.clashing.map((name) => registry.get(name)).filter((o): o is InlineModelOwner => !!o);
    }
    const unreserved = trial.clashing.filter((name) => !reserved.has(name));
    if (unreserved.length > 0) {
      for (const name of unreserved) reserved.add(name);
      previous = { trial, move: 'reserve' };
      continue;
    }
    if (previous?.move === 'stem' && sameNames(previous.trial.clashing, trial.clashing)) {
      // The stem advance changed nothing: the fixed point. The earlier of the
      // two identical trials carries the lower stem, so it is the one kept.
      return commit(renameClashing(previous.trial, options, candidateAt), options);
    }
    stemIndex++;
    previous = { trial, move: 'stem' };
  }

  return commit(renameClashing(previous!.trial, options, candidateAt), options);
}

/** `MaterializeInlineOptions` with `siblings` in the one form the loop reads (`siblingSitesOf`). */
interface ResolvedOptions extends Omit<MaterializeInlineOptions, 'siblings'> {
  siblings?: SiblingSites;
}

/**
 * `siblings` as the loop reads it, the three accepted forms told apart by
 * shape, never by emptiness: the `SiblingSites` container as given (it
 * carries `settled`) — the very object, since this call's settlement is
 * appended to it; a non-empty array of settlement objects (`SettledSites`),
 * wrapped as the container's settled list itself, so the call appends to the
 * caller's list as it did on that form; and an array of strings
 * (`SiblingStems`) — an empty array among them, which has no element to say
 * otherwise — copied into a fresh container (`createSiblingSites`), so the
 * array given is only read. Absent stays absent.
 */
function siblingSitesOf(siblings: SiblingSites | SettledSites | SiblingStems | undefined): SiblingSites | undefined {
  if (siblings === undefined) return undefined;
  if ('settled' in siblings) return siblings;
  if (siblings.length > 0 && typeof siblings[0] !== 'string') return { settled: siblings as SettledSites };
  return createSiblingSites(siblings as SiblingStems);
}

/** A stem to try, with the renames to replay on the trial extracted under it (none for the caller's own candidates). */
interface Candidate {
  stem: string;
  renames: SettledSite['renames'];
}

/**
 * The `index`-th candidate to try: the caller's bare name (its first
 * candidate) — with the renames of the earlier site that settled on that
 * very stem, when one did — then each other stem an earlier site of the same
 * bare name settled on (`options.siblings`), with its renames, then the
 * caller's other candidates in the caller's order, leaving out any stem a
 * sibling settled on — the same stem tried twice in a row would read to the
 * fixed-point test as an advance that changed nothing. The caller's
 * candidates end in an unbounded numbered run, so at most as many of them as
 * there are siblings are left out and the search is bounded; past the bound
 * the caller's own `index`-th candidate is the fallback.
 */
function candidateStem(index: number, options: ResolvedOptions, firstClashOwners: InlineModelOwner[]): Candidate {
  const own = (i: number): string => options.stem(i, firstClashOwners);
  const bare = own(0);
  const sites = options.siblings?.settled ?? [];
  if (index === 0) return { stem: bare, renames: sites.find((site) => site.stem === bare)?.renames ?? [] };
  const others = sites.filter((site) => site.stem !== bare);
  if (index <= others.length) return others[index - 1];
  let remaining = index - others.length;
  for (let i = 1; i <= index + others.length; i++) {
    const stem = own(i);
    if (others.some((site) => site.stem === stem)) continue;
    if (--remaining === 0) return { stem, renames: [] };
  }
  return { stem: own(index), renames: [] };
}

interface Trial {
  schema: SchemaObject;
  propertyName: string;
  reserved: ReadonlySet<string> | undefined;
  models: Model[];
  fingerprints: Map<Model, string>;
  /** Names the registry gives another shape, sorted. */
  clashing: string[];
  /** Set once the trial's references have been rewritten and the type must not be rebuilt. */
  type?: TypeRef;
  /**
   * The stem the root is settled under — the trial's own, or the one the root
   * moved to in `renameClashing`; unset when the root was numbered in place
   * and no stem names it. Recorded for the site's siblings at commit.
   */
  settledStem: string | undefined;
  /** Every rename made on the trial so far, in order: replayed from an earlier site, then `renameClashing`'s own. */
  renames: Array<readonly [string, string]>;
}

/**
 * Extract the schema under the candidate's stem and compare every model with
 * the registry. The candidate's renames — an earlier site's, see
 * `SettledSite` — are replayed first, each only where it applies: the model
 * to move must be among the trial's, the name moved to free in it, and the
 * name moved not one this schema `$ref`s as a component model
 * (`renameModel`), so a schema that differs from the earlier site's (no
 * `Circle` to move, a model of its own already named `BodyCircle`, or an
 * inline `Circle` beside a `$ref` to component `Circle`, which the rewrite
 * could not tell apart) is compared as extracted and settles on its own
 * merits — an inline `Circle` of the component's shape shares the component,
 * and the root takes the site's own next candidate — rather than failing the
 * parse. A replayed rename rewrites the type as the settling pass does, so
 * the type is kept with the trial.
 */
function runTrial(
  schema: SchemaObject,
  candidate: Candidate,
  reservedNames: Set<string>,
  options: ResolvedOptions,
): Trial {
  const { stem: propertyName } = candidate;
  const reserved = reservedNames.size > 0 ? new Set(reservedNames) : undefined;
  const models: Model[] = [];
  extractInlineModelsFromProperties(
    { properties: { [propertyName]: schema } },
    models,
    options.parentName,
    options.componentSchemas,
    undefined,
    reserved,
  );
  const renames: Array<readonly [string, string]> = [];
  let type: TypeRef | undefined;
  if (candidate.renames.length > 0) {
    const rewritten = schemaToTypeRef(schema, propertyName, options.parentName, undefined, reserved);
    const referenced = componentModelRefTargets(rewritten, models);
    for (const [from, to] of candidate.renames) {
      if (!models.some((model) => model.name === from) || models.some((model) => model.name === to)) continue;
      if (!renameModel(models, rewritten, referenced, from, to)) continue;
      renames.push([from, to]);
    }
    if (renames.length > 0) type = rewritten;
  }
  const fingerprints = new Map(models.map((model) => [model, modelFingerprint(model)]));
  const clashing = models
    .filter((model) => {
      const owner = options.registry.get(model.name);
      return owner !== undefined && owner.fingerprint !== fingerprints.get(model);
    })
    .map((model) => model.name)
    .sort();
  return { schema, propertyName, reserved, models, fingerprints, clashing, type, settledStem: propertyName, renames };
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * Register and emit the trial's new models. A name the registry already owns
 * is shared only when the owner has the same shape — decided on the trial's
 * final fingerprints, after every rename — so a model whose references were
 * rewritten is never dropped as "already defined" in favour of an owner that
 * no longer matches it. The trial has no such clash left when it gets here
 * (`runTrial` found none, or `renameClashing` cleared them all), so the
 * remaining branch is a guard against a regression, not an expected path.
 * The site's settlement — the stem it settled on and the renames made under
 * it — is recorded for its siblings, whether it minted models or shared every
 * one of them; a stem an earlier site already recorded keeps that site's.
 */
function commit(trial: Trial, options: ResolvedOptions): TypeRef {
  for (const model of trial.models) {
    const fingerprint = trial.fingerprints.get(model)!;
    const owner = options.registry.get(model.name);
    if (owner?.fingerprint === fingerprint) continue;
    if (owner !== undefined) {
      throw new Error(
        `Inline model "${model.name}" would overwrite a model of another shape; this is a bug in materializeInlineSchema.`,
      );
    }
    options.registry.set(model.name, { fingerprint, operation: options.operation });
    options.models.push(model);
  }
  const { siblings } = options;
  const { settledStem } = trial;
  if (siblings && settledStem !== undefined && !siblings.settled.some((site) => site.stem === settledStem)) {
    siblings.settled.push({ stem: settledStem, renames: [...trial.renames] });
  }
  return trial.type ?? schemaToTypeRef(trial.schema, trial.propertyName, options.parentName, undefined, trial.reserved);
}

/**
 * Rename, in place, the model named `from` among `models` to `to` and rewrite
 * every reference to it — in the models' fields, in `type`, and in the inline
 * enums named from it (`CircleStatus` → `BodyCircleStatus`, since a component
 * enum `CircleStatus` of other values would otherwise be collected first and
 * the renamed model's field would point at it). Returns `false`, having
 * changed nothing, when `from` is a name the schema also `$ref`s as a
 * component model (`referenced`, see `componentModelRefTargets`): the rewrite
 * cannot tell the inline reference from the `$ref`, so the rename is unsafe
 * and the caller decides — the settling pass fails loudly, a sibling's replay
 * skips it (`runTrial`).
 */
function renameModel(
  models: readonly Model[],
  type: TypeRef,
  referenced: ReadonlySet<string>,
  from: string,
  to: string,
): boolean {
  if (referenced.has(from)) return false;
  for (const model of models) {
    if (model.name === from) {
      model.name = to;
      for (const field of model.fields) rewriteEnumPrefix(field.type, from, to);
    }
    for (const field of model.fields) rewriteModelRef(field.type, from, to);
  }
  rewriteModelRef(type, from, to);
  return true;
}

/**
 * Settle the fixed-point trial in place so it can be committed as it stands:
 * rename every model whose name the registry gives another shape, rewrite
 * every reference to it among the trial's models and in the returned type,
 * and check again, since renaming a child changes its parent's shape. Round
 * by round, until no name is owned by another shape:
 *
 *   - a clashing name other than the root — a titled or const-named variant
 *     the reservation did not reach — is qualified by the root model name
 *     (`ListPetsDefaultResponseCircle`), or kept as is when it already starts
 *     with it, then numbered until free;
 *   - a clashing root — its shape changed when a child under it moved, so a
 *     registered model of that name no longer matches it — moves the body to
 *     the next free stem the caller would have tried next
 *     (`ListPetsDefaultResponse2`; a header's qualified candidates), and with
 *     it every model named under it (`ListPetsDefaultResponse2Circle`), as a
 *     stem advance would have named them — except one whose name an
 *     identical definition already owns, which stays shared under that name
 *     with the moved parent still referencing it, exactly as it is shared
 *     when nothing moves.
 *
 * Every new name is one nothing owns and nothing in the trial uses, so a
 * renamed model can never clash again, a shared model never changes and so
 * never starts a round, and the rounds end within the trial's size. A name
 * the schema also `$ref`s as a component model cannot be rewritten safely
 * (see `materializeInlineSchema`) and fails loudly.
 *
 * `candidateAt` gives the stems in the order the loop tried them
 * (`candidateStem`), so a moved root takes the next free one of those; the
 * stem it moved to is the one recorded for the site's siblings, and a root
 * numbered in place when none is free records none. Every rename made here
 * is appended to the trial's, after any replayed from an earlier site, so a
 * later site can replay them all in order.
 */
function renameClashing(trial: Trial, options: ResolvedOptions, candidateAt: (index: number) => Candidate): Trial {
  const { registry } = options;
  const rootOf = (propertyName: string): string =>
    qualifyInlineModelName(toPascalCase(propertyName), options.parentName);
  let rootName = rootOf(trial.propertyName);
  let settledStem = trial.settledStem;
  // A trial that replayed an earlier site's renames carries its rewritten type.
  const type =
    trial.type ?? schemaToTypeRef(trial.schema, trial.propertyName, options.parentName, undefined, trial.reserved);
  const referenced = componentModelRefTargets(type, trial.models);
  const taken = new Set([...registry.keys(), ...trial.models.map((m) => m.name)]);

  /** `candidate(1)`, `candidate(2)`, ... until one nothing owns or uses; claimed. */
  const claim = (candidate: (n: number) => string): string => {
    let n = 1;
    let name = candidate(n);
    while (taken.has(name)) name = candidate(++n);
    taken.add(name);
    return name;
  };
  const rename = (from: string, to: string): void => {
    // Only a reference to a component MODEL of this name is indistinguishable
    // from the inline model's own references once both are plain names; a
    // reference to a component enum of the name is an `EnumRef`, which the
    // rewrite never touches, so the inline model is simply renamed past it.
    if (!renameModel(trial.models, type, referenced, from, to)) {
      throw new Error(
        `Inline schema "${from}" under ${rootName} has another shape than component "${from}", which the same ` +
          `schema also references; rename the inline schema's title or the component so the two can be told apart.`,
      );
    }
    trial.renames.push([from, to]);
  };

  let fingerprints = trial.fingerprints;
  let clashing = trial.clashing;
  for (let round = 0; clashing.length > 0; round++) {
    if (round >= MAX_RENAME_ROUNDS) {
      throw new Error(
        `Could not settle the inline models under ${rootName} in ${MAX_RENAME_ROUNDS} rounds; ` +
          `this is a bug in materializeInlineSchema.`,
      );
    }
    if (clashing.includes(rootName)) {
      const oldRoot = rootName;
      let movedRoot: string | undefined;
      settledStem = undefined;
      for (let index = 1; index <= MAX_RENAME_ROUNDS && movedRoot === undefined; index++) {
        const { stem } = candidateAt(index);
        const candidate = rootOf(stem);
        if (!taken.has(candidate)) {
          movedRoot = candidate;
          settledStem = stem;
        }
      }
      if (movedRoot === undefined) movedRoot = claim((n) => `${oldRoot}${n + 1}`);
      taken.add(movedRoot);
      // Decided per model, by shape: a model named under the root whose name
      // an identical definition already owns (a component, an earlier
      // operation's model) stays shared under that name, exactly as it would
      // had the root not moved, and the moved parent keeps referencing it.
      // The root itself, and every other model named under it, moves.
      const moving = trial.models
        .filter((model) => {
          if (model.name === oldRoot) return true;
          if (!model.name.startsWith(oldRoot)) return false;
          return registry.get(model.name)?.fingerprint !== fingerprints.get(model);
        })
        .map((model) => model.name);
      for (const name of moving) {
        const suffix = name.slice(oldRoot.length);
        rename(name, name === oldRoot ? movedRoot : claim((n) => `${movedRoot}${suffix}${n === 1 ? '' : n}`));
      }
      rootName = movedRoot;
    } else {
      for (const name of clashing) {
        const base = name.startsWith(rootName) ? name : `${rootName}${name}`;
        rename(
          name,
          claim((n) => `${base}${n === 1 ? '' : n}`),
        );
      }
    }

    fingerprints = new Map(trial.models.map((model) => [model, modelFingerprint(model)]));
    clashing = trial.models
      .filter((model) => {
        const owner = registry.get(model.name);
        return owner !== undefined && owner.fingerprint !== fingerprints.get(model);
      })
      .map((model) => model.name)
      .sort();
  }

  return { ...trial, fingerprints, clashing: [], type, settledStem };
}

/** Rename, in place, every inline enum under `ref` whose name was built from `oldPrefix` so it is built from `newPrefix`. */
function rewriteEnumPrefix(ref: TypeRef, oldPrefix: string, newPrefix: string): void {
  walkTypeRef(ref, {
    enum: (r) => {
      if (r.values && r.name.startsWith(oldPrefix))
        (r as { name: string }).name = newPrefix + r.name.slice(oldPrefix.length);
    },
  });
}

/** Rewrite every reference to `oldName` in `ref` in place — a union's discriminator mapping included. */
function rewriteModelRef(ref: TypeRef, oldName: string, newName: string): void {
  switch (ref.kind) {
    case 'model':
      if (ref.name === oldName) (ref as { name: string }).name = newName;
      return;
    case 'array':
      rewriteModelRef(ref.items, oldName, newName);
      return;
    case 'nullable':
      rewriteModelRef(ref.inner, oldName, newName);
      return;
    case 'map':
      rewriteModelRef(ref.valueType, oldName, newName);
      if (ref.keyType) rewriteModelRef(ref.keyType, oldName, newName);
      return;
    case 'union':
      for (const variant of ref.variants) rewriteModelRef(variant, oldName, newName);
      for (const [value, target] of Object.entries(ref.discriminator?.mapping ?? {})) {
        if (target === oldName) ref.discriminator!.mapping[value] = newName;
      }
      return;
    default:
      return;
  }
}

/**
 * The names of the component models `type` and the fields of `models`
 * reference: every `ModelRef` that `schemaToTypeRef` built from a `$ref`
 * (`isComponentModelRef`, an identity mark). Only such a reference is
 * indistinguishable from an inline model's own references once the inline
 * model is renamed, so only these block a rename. A `$ref` to a component
 * enum is an `EnumRef`, which `rewriteModelRef` leaves alone, so it is never
 * collected. One predicate for both renames — the settling pass and a
 * sibling's replay — so the two agree on which `$ref` a rename could hit.
 */
function componentModelRefTargets(type: TypeRef, models: readonly Model[]): Set<string> {
  const targets = new Set<string>();
  const collect = (ref: TypeRef): void => {
    walkTypeRef(ref, {
      model: (r) => {
        if (isComponentModelRef(r)) targets.add(r.name);
      },
    });
  };
  collect(type);
  for (const model of models) for (const ref of collectModelTypeRefs(model)) collect(ref);
  return targets;
}
