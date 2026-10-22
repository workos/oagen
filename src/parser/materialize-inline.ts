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
import { walkTypeRef } from '../ir/types.js';
import { toPascalCase } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { schemaToTypeRef, resolveSchemaName } from './schemas.js';
import { extractInlineModelsFromProperties, modelFingerprint, qualifyInlineModelName } from './inline-models.js';

// The model-shape fingerprint lives beside the schema-shape key in
// inline-models.ts, where the extractor compares models too; re-exported here
// for the registry's readers.
export { modelFingerprint };

/**
 * Spec-wide record of every model name an inline model must not silently
 * reuse: the component models (seeded up front), each operation's primary
 * response and request body models, and each header, body and parameter
 * model materialized so far — and every enum name (`registerEnumNames`),
 * which no model may take. The value carries the model's shape fingerprint,
 * so a model whose shape matches can share the name, and — for
 * operation-owned models — which operation produced it, so a collision
 * inside one operation can be told apart from one across operations.
 */
export type InlineModelRegistry = Map<string, InlineModelOwner>;

export interface InlineModelOwner {
  fingerprint: string;
  operation?: string;
}

/** Record every model of `models` the registry does not know yet as owned by `operation`; the first owner keeps a name. */
export function registerInlineModels(registry: InlineModelRegistry, models: Model[], operation?: string): void {
  for (const model of models) {
    if (registry.has(model.name)) continue;
    registry.set(model.name, { fingerprint: modelFingerprint(model), operation });
  }
}

/**
 * The owner entry that reserves an enum's name: no model may take it, so the
 * entry never matches a model's fingerprint — every `modelFingerprint`
 * contains `#` and this one does not — and a trial that mints the name
 * clashes and steps exactly as beside a model of another shape. It records
 * no operation, so the clash reads as one with a component
 * (`deferredNamingStem`).
 */
const ENUM_OWNER: InlineModelOwner = Object.freeze({ fingerprint: 'enum' });

/**
 * Reserve every enum name the registry does not already hold — a component
 * enum's, or the name an inline enum of a parameter, field, body or header
 * will be lifted under — so no deferred model of any kind (a parameter's, a
 * header's, a secondary, fallback or error body's) takes an enum's name. A
 * name a model already owns is left to that model: the first owner keeps it.
 */
export function registerEnumNames(registry: InlineModelRegistry, names: Iterable<string>): void {
  for (const name of names) {
    if (!registry.has(name)) registry.set(name, ENUM_OWNER);
  }
}

/**
 * The stems the sites that derive from one bare name — the same header on
 * several status codes or operations, one media type's inline body on
 * several status codes — have settled on so far, in the order the sites were
 * resolved, each once. `materializeInlineSchema` tries them right after the
 * bare name, so a shape identical to an earlier site's shares that site's
 * model under whichever stem it took (`…Response200`, not a fresh
 * `…Response201`), and a different shape steps past them to the site's own
 * candidates; the stem each site settles on is appended for the sites after
 * it.
 */
export type SiblingStems = string[];

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
   * The stems earlier sites of the same bare name settled on, tried between
   * the bare name and the caller's other candidates, and appended to with the
   * stem this site settles on (see `SiblingStems`). Absent, only the caller's
   * candidates are tried and nothing is recorded.
   */
  siblings?: SiblingStems;
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
 * reference from a `$ref` to a component of the same name, so a schema that
 * both inlines a clashing `Circle` and references component `Circle` fails
 * loudly instead.
 *
 * The stems are tried in the order `candidateStem` gives: the caller's bare
 * name, then the stems earlier sites of the same bare name settled on
 * (`options.siblings`), then the caller's own qualified candidates. So the
 * `application/vnd.pet+json` body of a 201 whose bare name a component owns
 * tries the `…Response200` its 200 settled on before its own `…Response201`,
 * and shares the 200's model when the shapes are identical — a name-only
 * comparison would mint a second model of the same shape. The stem the site
 * settles on — the trial's, or the one its root moved to — is appended to
 * `options.siblings` for the sites after it.
 */
export function materializeInlineSchema(schema: SchemaObject, options: MaterializeInlineOptions): TypeRef {
  const { registry } = options;
  const reserved = new Set<string>();
  let stemIndex = 0;
  let firstClashOwners: InlineModelOwner[] = [];
  const stemAt = (index: number): string => candidateStem(index, options, firstClashOwners);
  // The last clashing trial and the move made after it.
  let previous: { trial: Trial; move: 'reserve' | 'stem' } | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const trial = runTrial(schema, stemAt(stemIndex), reserved, options);
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
      return commit(renameClashing(previous.trial, options, stemAt), options);
    }
    stemIndex++;
    previous = { trial, move: 'stem' };
  }

  return commit(renameClashing(previous!.trial, options, stemAt), options);
}

/**
 * The `index`-th stem to try: the caller's bare name (its first candidate),
 * then each stem an earlier site of the same bare name settled on
 * (`options.siblings`, the bare name left out since it was just tried), then
 * the caller's other candidates in the caller's order, leaving out any a
 * sibling settled on — the same stem tried twice in a row would read to the
 * fixed-point test as an advance that changed nothing. The caller's
 * candidates end in an unbounded numbered run, so at most as many of them as
 * there are siblings are left out and the search is bounded; past the bound
 * the caller's own `index`-th candidate is the fallback.
 */
function candidateStem(index: number, options: MaterializeInlineOptions, firstClashOwners: InlineModelOwner[]): string {
  const own = (i: number): string => options.stem(i, firstClashOwners);
  const bare = own(0);
  if (index === 0) return bare;
  const siblings = (options.siblings ?? []).filter((stem) => stem !== bare);
  if (index <= siblings.length) return siblings[index - 1];
  let remaining = index - siblings.length;
  for (let i = 1; i <= index + siblings.length; i++) {
    const candidate = own(i);
    if (siblings.includes(candidate)) continue;
    if (--remaining === 0) return candidate;
  }
  return own(index);
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
}

function runTrial(
  schema: SchemaObject,
  propertyName: string,
  reservedNames: Set<string>,
  options: MaterializeInlineOptions,
): Trial {
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
  const fingerprints = new Map(models.map((model) => [model, modelFingerprint(model)]));
  const clashing = models
    .filter((model) => {
      const owner = options.registry.get(model.name);
      return owner !== undefined && owner.fingerprint !== fingerprints.get(model);
    })
    .map((model) => model.name)
    .sort();
  return { schema, propertyName, reserved, models, fingerprints, clashing, settledStem: propertyName };
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
 * The stem the site settled on is recorded for its siblings, whether it
 * minted models or shared every one of them.
 */
function commit(trial: Trial, options: MaterializeInlineOptions): TypeRef {
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
  if (siblings && trial.settledStem !== undefined && !siblings.includes(trial.settledStem)) {
    siblings.push(trial.settledStem);
  }
  return trial.type ?? schemaToTypeRef(trial.schema, trial.propertyName, options.parentName, undefined, trial.reserved);
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
 * the schema also `$ref`s cannot be rewritten safely (see
 * `materializeInlineSchema`) and fails loudly.
 *
 * `stemAt` gives the stems in the order the loop tried them (`candidateStem`),
 * so a moved root takes the next free one of those; the stem it moved to is
 * the one recorded for the site's siblings, and a root numbered in place when
 * none is free records none.
 */
function renameClashing(trial: Trial, options: MaterializeInlineOptions, stemAt: (index: number) => string): Trial {
  const { registry } = options;
  const rootOf = (propertyName: string): string =>
    qualifyInlineModelName(toPascalCase(propertyName), options.parentName);
  let rootName = rootOf(trial.propertyName);
  let settledStem = trial.settledStem;
  const referenced = componentRefTargets(trial.schema);
  const type = schemaToTypeRef(trial.schema, trial.propertyName, options.parentName, undefined, trial.reserved);
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
    if (referenced.has(from)) {
      throw new Error(
        `Inline schema "${from}" under ${rootName} has another shape than component "${from}", which the same ` +
          `schema also references; rename the inline schema's title or the component so the two can be told apart.`,
      );
    }
    for (const model of trial.models) {
      if (model.name === from) {
        model.name = to;
        // The inline enums of its fields were named from it (`CircleStatus`),
        // so they follow (`ListPetsDefaultResponseCircleStatus`): left as they
        // were, a component enum `CircleStatus` of other values would be
        // collected first and the renamed model's field would point at it.
        for (const field of model.fields) rewriteEnumPrefix(field.type, from, to);
      }
      for (const field of model.fields) rewriteModelRef(field.type, from, to);
    }
    rewriteModelRef(type, from, to);
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
        const stem = stemAt(index);
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

/** The component model names a schema references anywhere below it. */
function componentRefTargets(schema: SchemaObject): Set<string> {
  const targets = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record['$ref'] === 'string') {
      const segments = record['$ref'].split('/');
      targets.add(resolveSchemaName(segments[segments.length - 1]));
    }
    Object.values(record).forEach(visit);
  };
  visit(schema);
  return targets;
}
