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
import { toPascalCase } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { schemaToTypeRef, resolveSchemaName } from './schemas.js';
import { extractInlineModelsFromProperties, qualifyInlineModelName } from './inline-models.js';

/**
 * Spec-wide record of every model name an inline model must not silently
 * reuse: the component models (seeded up front), each operation's primary
 * response and request body models, and each header and fallback model
 * materialized so far. The value carries the model's shape fingerprint, so a
 * model whose shape matches can share the name, and — for operation-owned
 * models — which operation produced it, so a collision inside one operation
 * can be told apart from one across operations.
 */
export type InlineModelRegistry = Map<string, InlineModelOwner>;

export interface InlineModelOwner {
  fingerprint: string;
  operation?: string;
}

/** Shape of a model, independent of field order: name, requiredness, and type of every field. */
export function modelFingerprint(model: Model): string {
  return model.fields
    .map((f) => `${f.name}${f.required ? '!' : '?'}:${stableStringify(f.type)}`)
    .sort()
    .join('|');
}

/** `JSON.stringify` with object keys sorted, so equal shapes serialize equally. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Record every model of `models` the registry does not know yet as owned by `operation`; the first owner keeps a name. */
export function registerInlineModels(registry: InlineModelRegistry, models: Model[], operation?: string): void {
  for (const model of models) {
    if (registry.has(model.name)) continue;
    registry.set(model.name, { fingerprint: modelFingerprint(model), operation });
  }
}

export interface MaterializeInlineOptions {
  /**
   * The property name to extract the schema under for the `index`-th stem:
   * the bare name first, then whatever qualifies it (a status code, an
   * operation, a numeric suffix). `firstClashOwners` is who owned the names
   * the first trial clashed with, for a caller that orders its candidates by
   * where the clash came from; empty while nothing has clashed.
   */
  stem: (index: number, firstClashOwners: InlineModelOwner[]) => string;
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
 * the loop stops rather than retrying forever. The last trial is then kept
 * and the clashing names themselves are renamed, qualified by the root model
 * name (`ListPetsDefaultResponseCircle`) then numbered, with every reference
 * among the trial's models and in the returned type rewritten to match. That
 * rewrite cannot tell an inline model's reference from a `$ref` to a
 * component of the same name, so a schema that both inlines a clashing
 * `Circle` and references component `Circle` fails loudly instead.
 */
export function materializeInlineSchema(schema: SchemaObject, options: MaterializeInlineOptions): TypeRef {
  const { registry } = options;
  const reserved = new Set<string>();
  let stemIndex = 0;
  let firstClashOwners: InlineModelOwner[] = [];
  // The last clashing trial and the move made after it.
  let previous: { trial: Trial; move: 'reserve' | 'stem' } | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const trial = runTrial(schema, options.stem(stemIndex, firstClashOwners), reserved, options);
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
      return commit(renameClashing(previous.trial, options), options);
    }
    stemIndex++;
    previous = { trial, move: 'stem' };
  }

  return commit(renameClashing(previous!.trial, options), options);
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
  return { schema, propertyName, reserved, models, fingerprints, clashing };
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/** Register and emit the trial's new models; a name the registry already owns with the same shape is shared. */
function commit(trial: Trial, options: MaterializeInlineOptions): TypeRef {
  for (const model of trial.models) {
    if (options.registry.has(model.name)) continue;
    options.registry.set(model.name, { fingerprint: trial.fingerprints.get(model)!, operation: options.operation });
    options.models.push(model);
  }
  return trial.type ?? schemaToTypeRef(trial.schema, trial.propertyName, options.parentName, undefined, trial.reserved);
}

/**
 * Rename the trial's clashing models in place — qualified by the root model
 * name, then numbered — and rewrite every reference to them, so the trial can
 * be committed as it stands. See `materializeInlineSchema`.
 */
function renameClashing(trial: Trial, options: MaterializeInlineOptions): Trial {
  const rootName = qualifyInlineModelName(toPascalCase(trial.propertyName), options.parentName);
  const referenced = componentRefTargets(trial.schema);
  const taken = new Set([...options.registry.keys(), ...trial.models.map((m) => m.name)]);
  const type = schemaToTypeRef(trial.schema, trial.propertyName, options.parentName, undefined, trial.reserved);

  for (const name of trial.clashing) {
    if (referenced.has(name)) {
      throw new Error(
        `Inline schema "${name}" under ${rootName} has another shape than component "${name}", which the same ` +
          `schema also references; rename the inline schema's title or the component so the two can be told apart.`,
      );
    }
    let renamed = `${rootName}${name}`;
    for (let n = 2; taken.has(renamed); n++) renamed = `${rootName}${name}${n}`;
    taken.add(renamed);
    for (const model of trial.models) {
      if (model.name === name) model.name = renamed;
      for (const field of model.fields) rewriteModelRef(field.type, name, renamed);
    }
    rewriteModelRef(type, name, renamed);
  }

  const fingerprints = new Map(trial.models.map((model) => [model, modelFingerprint(model)]));
  return { ...trial, fingerprints, clashing: [], type };
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
