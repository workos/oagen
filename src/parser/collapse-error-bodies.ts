/**
 * Collapse the models the parser materializes for inline error bodies onto a
 * handful of shared models named by shape.
 *
 * Since workos/oagen#243 every inline 4xx/5xx body is a model of its own,
 * `<Op>Error<code>` (#356), and two bodies share a model only when their
 * fingerprints agree — fields, types, every `const` and every description.
 * A document that writes its errors inline, one schema per error code, as a
 * generator such as NestJS does, declares hundreds of them: the WorkOS
 * document has 834 inline error bodies in 13 shapes, 433 of them
 * `{ message }` and 344 `{ code: <const>, message }`, and no SDK runtime
 * reads a single one of the 834 models — they reach a consumer as files,
 * barrel exports and round-trip tests only. Every emitter also writes the
 * models an operation references from `errors[].type`, so the per-operation
 * names (`ConnectionCreateError4222`, `WebhookEndpointsDeleteError404 =
 * DataIntegrationsUpsertApiKeyError404`) are what a reader of the SDK sees.
 *
 * This pass runs once the operations' models are merged and before the
 * inline-enum collectors (`parseSpec`). It reads every error site — each
 * `errors[]` entry's `type` and its secondary `contents[].type`, and the body
 * and secondary bodies of a `4XX`/`5XX` range — and takes the models only
 * those sites reach (`errorOnly`): a component schema, a model a success
 * body, parameter, header, webhook or component also reaches, and a body a
 * `components/responses` entry declares (`componentSites`) are left exactly
 * as they are. The models it takes are keyed by structure alone
 * (`ModelKeys`): field names, requiredness, flags and types, a nested
 * error-only model by its own key, and a string the document pins —
 * `const: idp_metadata_fetch_failed`, an inline `enum`, a plain `string` —
 * all as one string, so the bodies that differ only in their error code,
 * their prose or their `x-` extensions fold onto one model. A string inside
 * an array, union or map keeps its value in the key, and so does a field's
 * `domainName` (a `fieldHints` entry), so neither is lost in a fold.
 *
 * Each group becomes one model, named from its shape alone (`bodyName`):
 * `ErrorBody` for `{ message }`, `OAuthErrorBody` for the OAuth error format
 * `{ error, error_description }`, else the base plus `With` and a token per
 * further field. A field's token is its name in PascalCase, qualified by what
 * its type adds so that two shapes with the same field names still read
 * apart: an array of strings is `MessageList`, a union joins its variants
 * with `Or` (`MessageOrMessageList`), and a nested error body is prefixed
 * with the field names of its own (`ErrorBodyWithCodeFieldErrors` for
 * `{ message, errors: [{ code, field }] }`). A group whose members all pin
 * one string field to one value is named from that value instead
 * (`RateLimitExceededErrorBody`, `InvalidGrantOAuthErrorBody`; the field's
 * name follows the value unless it is `code` or `error`), plus `With` and
 * the plain names of any further fields
 * (`OrganizationSelectionRequiredErrorBodyWithOrganizations`). A model only
 * another error body reaches is named from its parent and field
 * (`OrganizationSelectionRequiredErrorBodyWithOrganization`, singular for an
 * array item). `ErrorBody` rather than `ErrorResponse` because an emitter
 * may already spend that name on a component called `Error` (Go does).
 *
 * The pass never numbers a name. A shared name a component schema of exactly
 * that shape already holds — one whose string fields admit every value the
 * bodies pin — is that component: the group folds onto it. A name anything
 * else holds — a component of another shape, an enum, a shared
 * body of another shape — leaves the group's models exactly as the parser
 * materialized them, with every error-only model they reach or are reached
 * from, and says so in a warning naming both sides; the fold then runs
 * again without them, since a freed name may now suit another group.
 *
 * A string field a group pins to two or more values becomes an enum shared by
 * every error body that has a field of that name — `ErrorBodyCode` for
 * `code`, `ErrorBodyError` for an OAuth `error` — holding every value any
 * error body pins that field to, which the collectors lift as they lift any
 * inline enum (an emitter's enums admit an unlisted value, and the field's
 * prose says more may come). An enum of that name the document already holds
 * is shared when the members agree; when they do not, or a model holds the
 * name, the fields stay plain strings, with a warning. One value every
 * member pins stays that literal, and a lone pinned value beside free
 * strings widens to `string`. A field's
 * description, example and extensions survive only when every member wrote
 * the same one; the response's own `description` stays on the `errors[]`
 * entry, where it always was.
 *
 * The references are rewritten in place, so the `contents` entry that shared
 * its `type` with the entry's `type` keeps sharing it. A `oneOf` of variants
 * that fold onto one model is no longer a union: duplicate variants are
 * dropped and a lone survivor replaces the union. The models the pass folds
 * are removed; the shared ones join the list.
 *
 * `collapseErrorBodies: false` on `ParseOptions` keeps the per-operation
 * models for a consumer that names them.
 */
import type { Enum, EnumRef, Field, Model, Service, TypeRef, UnionType, Webhook } from '../ir/types.js';
import {
  collectModelRefs,
  collectModelTypeRefs,
  collectOperationTypeRefs,
  collectWebhookTypeRefs,
  renameTypeRefModels,
} from '../ir/types.js';
import { singularize, toPascalCase } from '../utils/naming.js';
import { sameEnumShape } from './enum-members.js';
import { isErrorStatusRange } from './responses.js';

/** The stem every shared error body is named from: `ErrorBody`, `ErrorBodyWithCode`, and the enums `ErrorBodyCode`, `ErrorBodyError`. */
export const ERROR_BODY_BASE = 'ErrorBody';

export interface CollapseErrorBodiesInput {
  services: Service[];
  webhooks?: readonly Webhook[];
  models: Model[];
}

export interface CollapseErrorBodiesOptions {
  /** The document's component schema names (after `schemaNameTransform`): never folded, and whatever they reach stays. */
  componentNames: ReadonlySet<string>;
  /**
   * Type references a `components/responses` entry wrote
   * (`OperationExtractionResult.componentSites`): the component's body is
   * the component's, named after it, and is left alone.
   */
  componentSites?: ReadonlySet<TypeRef>;
  /**
   * The document's enums and every enum lifted before the pass. No shared
   * model takes one of their names (bodies whose shared name an `ErrorBody`
   * enum a component's `body` field minted would take are left as they
   * are), and a shared enum takes the name of one of them only when the
   * members agree, sharing it as the collectors share any inline enum.
   */
  enums?: readonly Enum[];
}

/**
 * Where an error body's type is read and written back: an `errors[]` entry's
 * `type`, each of its `contents[].type`, and the same two on a `4XX`/`5XX`
 * range. Held as accessors so a union a fold turns into one reference can be
 * replaced at every site that held the union object.
 */
interface ErrorSlot {
  get(): TypeRef | undefined;
  set(type: TypeRef): void;
}

/** What a group's members pin a string field to: every `const` or inline `enum` value, and whether any member leaves it a plain string. */
interface PinnedValues {
  values: Set<string>;
  open: boolean;
}

/**
 * Fold the error-only models of `input.models` onto shared, shape-named
 * models; rewrite every error site of `input.services` to reference them;
 * and return the model list with the folded models removed and the shared
 * ones appended. The services are mutated in place; `input.models` is not.
 */
export function collapseErrorBodies(input: CollapseErrorBodiesInput, options: CollapseErrorBodiesOptions): Model[] {
  const operations = input.services.flatMap((service) => service.operations);
  const componentSites = options.componentSites ?? new Set<TypeRef>();
  const slots = errorSlots(operations).filter((slot) => {
    const type = slot.get();
    return type !== undefined && !componentSites.has(type);
  });
  if (slots.length === 0) return input.models;

  const byName = new Map(input.models.map((model) => [model.name, model]));
  const slotTypes = new Set(slots.map((slot) => slot.get()!));

  // Everything a non-error site reaches is kept: the components and what
  // they reach, every parameter, request body, success, default and
  // non-error range body, every header (an error's headers included — a
  // header is not a body), every webhook, and every component response site.
  const keepRoots: string[] = [...options.componentNames];
  for (const op of operations) {
    for (const ref of collectOperationTypeRefs(op)) if (!slotTypes.has(ref)) keepRoots.push(...collectModelRefs(ref));
  }
  for (const webhook of input.webhooks ?? []) {
    for (const ref of collectWebhookTypeRefs(webhook)) keepRoots.push(...collectModelRefs(ref));
  }
  for (const ref of componentSites) keepRoots.push(...collectModelRefs(ref));
  const kept = closure(keepRoots, byName);

  const errorRoots = [...slotTypes].flatMap((type) => collectModelRefs(type));
  const errorOnly = new Set(
    [...closure(errorRoots, byName)].filter(
      (name) => !kept.has(name) && !options.componentNames.has(name) && byName.has(name),
    ),
  );
  if (errorOnly.size === 0) return input.models;

  // A group whose shared name something of another shape already holds is
  // left as it is, with every error-only model it reaches or is reached
  // from, and the fold is retried without them: a name that group had taken
  // may suit another.
  let candidates: ReadonlySet<string> = errorOnly;
  for (;;) {
    const outcome = fold(candidates, { input, options, byName, slots, errorRoots });
    if (outcome.frozen.size === 0) return outcome.models;
    candidates = new Set([...candidates].filter((name) => !outcome.frozen.has(name)));
    if (candidates.size === 0) return input.models;
  }
}

interface FoldContext {
  input: CollapseErrorBodiesInput;
  options: CollapseErrorBodiesOptions;
  byName: ReadonlyMap<string, Model>;
  slots: readonly ErrorSlot[];
  /** The model names every error site references directly. */
  errorRoots: readonly string[];
}

/**
 * One attempt at folding the error-only models `errorOnly`: the model list
 * with every group folded, or — when a shared name is taken by something of
 * another shape — the names of the models to leave as they are, so the
 * caller can try again without them.
 */
function fold(
  errorOnly: ReadonlySet<string>,
  { input, options, byName, slots, errorRoots }: FoldContext,
): { models: Model[]; frozen: ReadonlySet<string> } {
  // Group by structure, each group's members in name order.
  const keys = new ModelKeys(errorOnly, byName);
  const groups = new Map<string, Model[]>();
  for (const name of [...errorOnly].sort()) {
    const key = keys.of(name);
    const group = groups.get(key);
    if (group) group.push(byName.get(name)!);
    else groups.set(key, [byName.get(name)!]);
  }
  // Groups are ordered by shape, never by the operations that produced them:
  // fewer fields first, then the key, so when two shapes ask for one name the
  // same one keeps it whichever operation declared it, and renaming an
  // operation moves no model name.
  const orderedGroups = [...groups.entries()].sort(([keyA, a], [keyB, b]) => {
    const fields = a[0].fields.length - b[0].fields.length;
    return fields !== 0 ? fields : keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  const pinnedByKey = new Map<string, Map<string, PinnedValues>>();
  for (const [key, members] of orderedGroups) pinnedByKey.set(key, pinnedValues(members));

  // The values every error body pins a field of one name to, across every
  // group: the members of the shared enum that field becomes.
  const enumValuesByField = new Map<string, Set<string>>();
  for (const pinned of pinnedByKey.values()) {
    for (const [field, { values }] of pinned) {
      const all = enumValuesByField.get(field) ?? new Set<string>();
      for (const value of values) all.add(value);
      enumValuesByField.set(field, all);
    }
  }

  // Name the groups: the ones an error site references directly first, from
  // their pinned value or their fields; then the ones only another error
  // body reaches, from their parent and field.
  const topLevel = new Set(errorRoots.filter((name) => errorOnly.has(name)));
  const existingEnums = options.enums ?? [];
  // Who holds each name a shared model or enum might take.
  const holders = new Map<string, string>();
  for (const model of input.models) if (!errorOnly.has(model.name)) holders.set(model.name, `model "${model.name}"`);
  for (const name of options.componentNames) holders.set(name, `component schema "${name}"`);
  for (const e of existingEnums) holders.set(e.name, `enum "${e.name}"`);
  const canonical = new Map<string, string>(); // group key → shared name
  const absorbed = new Set<string>(); // group keys folded onto a component of their shape
  const seeds = new Set<string>(); // the models of the groups left as they are
  const claim = (name: string, key: string, members: readonly Model[]): void => {
    const holder = holders.get(name);
    if (holder === undefined) {
      holders.set(name, `the shared error body "${name}" ${shapeOf(members[0])}`);
      canonical.set(key, name);
      return;
    }
    // A component schema of exactly this shape, admitting every value the
    // bodies pin, is the shared body.
    const component = byName.get(name);
    if (
      component &&
      !errorOnly.has(name) &&
      keys.of(name) === key &&
      componentAccepts(component, pinnedByKey.get(key)!)
    ) {
      canonical.set(key, name);
      absorbed.add(key);
      return;
    }
    for (const member of members) seeds.add(member.name);
    const list = members.map((member) => `"${member.name}"`).join(', ');
    const kept = members.length === 1 ? `model ${list} as it is` : `models ${list} as they are`;
    console.warn(
      `[oagen] Warning: The shared error body ${shapeOf(members[0])} would be named "${name}", which ${holder} already holds — keeping ${kept}; give the two the same shape, or rename one`,
    );
  };
  const frozenOut = (members: readonly Model[]): boolean => members.some((member) => seeds.has(member.name));
  for (const [key, members] of orderedGroups) {
    if (!members.some((member) => topLevel.has(member.name))) continue;
    claim(bodyName(members[0], pinnedByKey.get(key)!, errorOnly, byName), key, members);
  }
  // Every (parent, field) that reaches a nested error-only model, read on
  // the models before the fold.
  const parentsOf = new Map<string, Array<{ parent: Model; field: Field }>>();
  for (const name of errorOnly) {
    const model = byName.get(name)!;
    for (const field of model.fields) {
      for (const child of collectModelRefs(field.type)) {
        if (!errorOnly.has(child) || child === name) continue;
        const list = parentsOf.get(child) ?? [];
        list.push({ parent: model, field });
        parentsOf.set(child, list);
      }
    }
  }
  for (let progressed = true; progressed;) {
    progressed = false;
    for (const [key, members] of orderedGroups) {
      if (canonical.has(key) || frozenOut(members)) continue;
      const candidates = members
        .flatMap((member) => parentsOf.get(member.name) ?? [])
        .map(({ parent, field }) => {
          const parentName = canonical.get(keys.of(parent.name));
          return parentName === undefined ? undefined : nestedName(parentName, field);
        })
        .filter((candidate): candidate is string => candidate !== undefined)
        .sort();
      if (candidates.length === 0) continue;
      claim(candidates[0], key, members);
      progressed = true;
    }
  }
  // A group nothing named reaches — only through a cycle among error bodies,
  // or through a group left as it is — is named from its own fields.
  for (const [key, members] of orderedGroups) {
    if (!canonical.has(key) && !frozenOut(members)) {
      claim(bodyName(members[0], pinnedByKey.get(key)!, errorOnly, byName), key, members);
    }
  }
  if (seeds.size > 0) {
    // A model left as it is keeps its fields, so everything it reaches stays
    // too; and a shared parent would reference one member's child and strand
    // the others', so everything that reaches a frozen model stays as well.
    const errorOnlyClosure = (roots: readonly string[]): string[] =>
      [...closure(roots, byName)].filter((name) => errorOnly.has(name));
    const frozen = new Set(errorOnlyClosure([...seeds]));
    for (let grew = true; grew;) {
      grew = false;
      for (const name of errorOnly) {
        if (frozen.has(name)) continue;
        const reached = errorOnlyClosure([name]);
        if (reached.some((other) => frozen.has(other))) {
          for (const other of reached) frozen.add(other);
          grew = true;
        }
      }
    }
    return { models: input.models, frozen };
  }

  // The shared enums, one per field name some group pins to two or more
  // values, named from the same pool as the models so neither takes the
  // other's name; a field whose enum name is taken stays a plain string.
  const enumNamesByField = new Map<string, string>();
  const widened = new Set<string>();
  for (const [key] of orderedGroups) {
    if (absorbed.has(key)) continue;
    for (const [field, { values }] of pinnedByKey.get(key)!) {
      if (values.size < 2 || enumNamesByField.has(field) || widened.has(field)) continue;
      const base = `${ERROR_BODY_BASE}${toPascalCase(field)}`;
      const members = [...(enumValuesByField.get(field) ?? values)].sort().map((value) => ({ name: value, value }));
      // An enum of that name with the same members is shared, as the
      // collectors share any inline enum.
      const shared = existingEnums.find((e) => e.name === base && sameEnumShape(e.values, members));
      if (shared) {
        enumNamesByField.set(field, shared.name);
        continue;
      }
      const holder = holders.get(base);
      if (holder === undefined) {
        holders.set(base, `the shared enum "${base}"`);
        enumNamesByField.set(field, base);
        continue;
      }
      widened.add(field);
      console.warn(
        `[oagen] Warning: The values error bodies pin "${field}" to would be the shared enum "${base}", which ${holder} already holds — keeping those fields plain strings`,
      );
    }
  }

  // Build the shared models.
  const renames = new Map<string, string>();
  for (const name of errorOnly) renames.set(name, canonical.get(keys.of(name))!);
  const sharedModels: Model[] = [];
  for (const [key, members] of orderedGroups) {
    if (absorbed.has(key)) continue;
    sharedModels.push(
      buildSharedModel(
        canonical.get(key)!,
        members,
        pinnedByKey.get(key)!,
        enumValuesByField,
        enumNamesByField,
        renames,
      ),
    );
  }

  // Rewrite every error site, then fold the unions whose variants became one.
  for (const slot of slots) renameTypeRefModels(slot.get()!, renames);
  const simplified = new Map<TypeRef, TypeRef>();
  for (const slot of slots) {
    const type = slot.get()!;
    let replacement = simplified.get(type);
    if (replacement === undefined) {
      replacement = simplifyType(type);
      simplified.set(type, replacement);
    }
    if (replacement !== type) slot.set(replacement);
  }

  return {
    models: [
      ...input.models.filter((model) => !errorOnly.has(model.name)),
      ...sharedModels.sort((a, b) => a.name.localeCompare(b.name)),
    ],
    frozen: new Set(),
  };
}

type OperationErrorSites = Pick<Service['operations'][number], 'errors' | 'rangeResponses'>;

/** Every error site of `operations` (`ErrorSlot`), in document order. */
function errorSlots(operations: readonly OperationErrorSites[]): ErrorSlot[] {
  const slots: ErrorSlot[] = [];
  const entrySlots = (entry: { type?: TypeRef; contents?: Array<{ type: TypeRef }> }): void => {
    slots.push({
      get: () => entry.type,
      set: (type) => {
        entry.type = type;
      },
    });
    for (const content of entry.contents ?? []) {
      slots.push({
        get: () => content.type,
        set: (type) => {
          content.type = type;
        },
      });
    }
  };
  for (const op of operations) {
    for (const error of op.errors) entrySlots(error);
    for (const range of op.rangeResponses ?? []) if (isErrorStatusRange(range.range)) entrySlots(range);
  }
  return slots;
}

/** Every model name reachable from `roots` through model fields and variants. */
function closure(roots: readonly string[], byName: ReadonlyMap<string, Model>): Set<string> {
  const reached = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    const model = byName.get(name);
    if (!model) continue;
    for (const ref of collectModelTypeRefs(model)) stack.push(...collectModelRefs(ref));
  }
  return reached;
}

/**
 * The structure of an error-only model, independent of its name, its
 * documentation, its `x-` extensions and the values its string fields are
 * pinned to. Memoized per model; a cycle among error bodies reads as the
 * name on the cycle.
 */
class ModelKeys {
  private readonly keys = new Map<string, string>();
  private readonly visiting = new Set<string>();

  constructor(
    private readonly errorOnly: ReadonlySet<string>,
    private readonly byName: ReadonlyMap<string, Model>,
  ) {}

  of(name: string): string {
    const cached = this.keys.get(name);
    if (cached !== undefined) return cached;
    if (this.visiting.has(name)) return `cycle:${name}`;
    this.visiting.add(name);
    const model = this.byName.get(name)!;
    const fields = model.fields
      .map((field) => `${field.name}${field.required ? '!' : '?'}${fieldFlags(field)}=${this.type(field.type, true)}`)
      .sort()
      .join('|');
    const own = stableJson({
      deprecated: model.deprecated,
      constraints: model.constraints,
      typeParams: model.typeParams,
      compositionKind: model.compositionKind,
      variants: model.variants?.map((variant) => this.type(variant, false)).sort(),
      discriminator: model.discriminator && this.discriminator(model.discriminator),
    });
    const key = `${fields}#${own}`;
    this.visiting.delete(name);
    this.keys.set(name, key);
    return key;
  }

  /**
   * A type's structure. A field's own type (`direct`, through a nullable
   * wrapper) reads every way the document pins or frees a string as one `S`,
   * since `sharedFieldType` reads those values across the group; a string
   * inside an array, union or map keeps its value in the key (`L"a"`,
   * `E["a","b"]`), since nothing combines values there, so two bodies that
   * list different codes in an array stay two models.
   */
  type(type: TypeRef, direct: boolean): string {
    switch (type.kind) {
      case 'literal':
        return direct && typeof type.value === 'string' ? 'S' : `L${JSON.stringify(type.value)}`;
      case 'enum':
        if (isStringValuedInlineEnum(type)) return direct ? 'S' : `E${JSON.stringify([...type.values!].sort())}`;
        return type.values ? `E${JSON.stringify(type.values)}` : `E:${type.name}`;
      case 'primitive':
        return direct && type.type === 'string' && !type.format ? 'S' : `P:${type.type}:${type.format ?? ''}`;
      case 'model':
        return this.errorOnly.has(type.name) ? `M{${this.of(type.name)}}` : `R:${type.name}`;
      case 'array':
        return `A[${this.type(type.items, false)}]`;
      case 'nullable':
        return `N(${this.type(type.inner, direct)})`;
      case 'union': {
        const variants = type.variants.map((variant) => this.type(variant, false)).sort();
        const discriminator = type.discriminator ? this.discriminator(type.discriminator) : '';
        return `U${type.compositionKind ?? ''}${discriminator}(${variants.join(',')})`;
      }
      case 'map':
        return `Map(${type.keyType ? this.type(type.keyType, false) : ''};${this.type(type.valueType, false)})`;
    }
  }

  /** A discriminator's property and every mapping entry, the target read as the variants are. */
  private discriminator(discriminator: { property: string; mapping: Record<string, string> }): string {
    const entries = Object.entries(discriminator.mapping)
      .map(([value, target]) => `${value}=${this.errorOnly.has(target) ? `M{${this.of(target)}}` : `R:${target}`}`)
      .sort();
    return `@${discriminator.property}{${entries.join(',')}}`;
  }
}

/** A field's flags, limits and domain name: everything but its name, type, documentation and extensions. */
function fieldFlags(field: Field): string {
  return stableJson({
    domainName: field.domainName,
    readOnly: field.readOnly,
    writeOnly: field.writeOnly,
    deprecated: field.deprecated,
    default: field.default,
    constraints: field.constraints,
  });
}

/** For every string field of the members (by name), the values pinned and whether any member leaves it free. */
function pinnedValues(members: readonly Model[]): Map<string, PinnedValues> {
  const pinned = new Map<string, PinnedValues>();
  for (const field of members[0].fields) {
    if (!isStringLike(unwrapNullable(field.type))) continue;
    const entry: PinnedValues = { values: new Set(), open: false };
    for (const member of members) {
      const sibling = member.fields.find((f) => f.name === field.name);
      const inner = sibling ? unwrapNullable(sibling.type) : undefined;
      if (inner?.kind === 'literal' && typeof inner.value === 'string') entry.values.add(inner.value);
      else if (inner?.kind === 'enum' && isStringValuedInlineEnum(inner)) {
        for (const value of inner.values!) entry.values.add(String(value));
      } else entry.open = true;
    }
    pinned.set(field.name, entry);
  }
  return pinned;
}

/** The field set of the OAuth 2.0 error response. */
const OAUTH_ERROR_FIELDS = ['error', 'error_description'];

/** The fields that carry an error code; a body pinned on one is named from the value alone. */
const ERROR_CODE_FIELDS = ['code', 'error'];

/**
 * Whether `component` admits every value the group pins: a string field the
 * group pins is, on the component, a plain string, or — when no member leaves
 * it free — a literal or inline enum holding every pinned value. The key
 * reads every string as one, so this is what tells a component the bodies
 * can reference from one that would narrow their codes.
 */
function componentAccepts(component: Model, pinned: ReadonlyMap<string, PinnedValues>): boolean {
  for (const [name, { values, open }] of pinned) {
    const field = component.fields.find((f) => f.name === name);
    if (!field) return false;
    const type = unwrapNullable(field.type);
    if (type.kind === 'primitive' && type.type === 'string' && !type.format) continue;
    if (open) return false;
    if (type.kind === 'literal') {
      if (values.size !== 1 || !values.has(String(type.value))) return false;
      continue;
    }
    if (type.kind === 'enum' && type.values) {
      const allowed = new Set(type.values.map((value) => String(value)));
      if ([...values].some((value) => !allowed.has(value))) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** `{ code, message? }`: a model's field names, the optional ones marked. */
function shapeOf(model: Model): string {
  return `{ ${model.fields.map((field) => (field.required ? field.name : `${field.name}?`)).join(', ')} }`;
}

/** The one string field every member of a group pins to one value, when there is exactly one such field and the value can name a model. */
function singlePinned(pinned: ReadonlyMap<string, PinnedValues>): { field: string; value: string } | undefined {
  const single = [...pinned.entries()].filter(([, { values, open }]) => values.size === 1 && !open);
  if (single.length !== 1) return undefined;
  const [field, { values }] = single[0];
  const value = [...values][0];
  const word = toPascalCase(value);
  // A value that is empty or starts with a digit (`4001`) names nothing.
  if (word.length === 0 || /^\d/.test(word)) return undefined;
  return { field, value };
}

/**
 * The name a group takes: `ErrorBody` for `{ message }`, `OAuthErrorBody`
 * for `{ error, error_description }`, else the base plus `With` and a token
 * per further field (`fieldToken`). A group every member of which pins one
 * string field to one value is named from the value instead — followed by
 * the field's name unless it is `code` or `error` — plus `With` and the plain
 * names of any further fields.
 */
function bodyName(
  representative: Model,
  pinned: ReadonlyMap<string, PinnedValues>,
  errorOnly: ReadonlySet<string>,
  byName: ReadonlyMap<string, Model>,
): string {
  const fields = [...representative.fields].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (fields.length === 0) return `${ERROR_BODY_BASE}Empty`;
  const names = new Set(fields.map((field) => field.name));
  const oauth = OAUTH_ERROR_FIELDS.every((name) => names.has(name));
  const base = oauth ? `OAuth${ERROR_BODY_BASE}` : ERROR_BODY_BASE;
  const single = singlePinned(pinned);
  const isProse = (field: Field): boolean =>
    (field.name === 'message' || (oauth && field.name === 'error_description')) &&
    isStringLike(unwrapNullable(field.type));
  const core = new Set<string>([...(oauth ? ['error'] : []), ...(single ? [single.field] : [])]);
  const extras = fields
    .filter((field) => !core.has(field.name) && !isProse(field))
    .map((field) => fieldToken(field.name, field.type, names, single === undefined, errorOnly, byName));
  const suffix = extras.length === 0 ? '' : `With${extras.join('')}`;
  if (single === undefined) return `${base}${suffix}`;
  const field = ERROR_CODE_FIELDS.includes(single.field) ? '' : toPascalCase(single.field);
  return `${toPascalCase(single.value)}${field}${base}${suffix}`;
}

/**
 * The token a field contributes to a body's name: its name in PascalCase;
 * `List` appended for an array of plain values; a union's variants joined
 * with `Or`; and, when `qualify` is set, a nested error body's own field
 * names (the ones the parent lacks) prefixed, so `errors` arrays of
 * different items read apart (`CodeFieldErrors`, `ConstraintsPropertyErrors`).
 */
function fieldToken(
  name: string,
  type: TypeRef,
  parentNames: ReadonlySet<string>,
  qualify: boolean,
  errorOnly: ReadonlySet<string>,
  byName: ReadonlyMap<string, Model>,
): string {
  const word = toPascalCase(name);
  const inner = unwrapNullable(type);
  switch (inner.kind) {
    case 'union': {
      // Sorted, as the key sorts the variants: the name does not depend on
      // which member of the group wrote the union first.
      const tokens = inner.variants.map((variant) =>
        fieldToken(name, variant, parentNames, qualify, errorOnly, byName),
      );
      return [...new Set(tokens)].sort().join('Or') || word;
    }
    case 'array': {
      const items = unwrapNullable(inner.items);
      if (items.kind === 'model' || items.kind === 'union') {
        return fieldToken(name, items, parentNames, qualify, errorOnly, byName);
      }
      return `${word}List`;
    }
    case 'model': {
      const nested = qualify && errorOnly.has(inner.name) ? byName.get(inner.name) : undefined;
      const own = nested
        ? nested.fields
            .map((field) => field.name)
            .filter((fieldName) => !parentNames.has(fieldName))
            .sort()
            .map((fieldName) => toPascalCase(fieldName))
            .join('')
        : '';
      return `${own}${word}`;
    }
    default:
      return word;
  }
}

/**
 * The name of a nested error body reached through `field` of a body named
 * `parentName`: the parent's name plus the field, singular for an array
 * item, replacing the field where the parent's name already ends in it.
 */
function nestedName(parentName: string, field: Field): string {
  const word = toPascalCase(field.name);
  const inArray = unwrapNullable(field.type).kind === 'array';
  const item = inArray ? toPascalCase(singularize(field.name)) : word;
  return inArray && word.length > 0 && parentName.endsWith(word)
    ? `${parentName.slice(0, -word.length)}${item}`
    : `${parentName}${item}`;
}

/**
 * One shared model for `members`, built on the first member's field order:
 * each field's type reads as the group reads it (`sharedFieldType`); its
 * description, example and extensions are kept when every member wrote the
 * same one, and the example only while the type is still the member's own.
 */
function buildSharedModel(
  name: string,
  members: readonly Model[],
  pinned: ReadonlyMap<string, PinnedValues>,
  enumValuesByField: ReadonlyMap<string, ReadonlySet<string>>,
  enumNamesByField: ReadonlyMap<string, string>,
  renames: ReadonlyMap<string, string>,
): Model {
  const representative = members[0];
  const fields: Field[] = representative.fields.map((field) => {
    const siblings = members.map((member) => member.fields.find((f) => f.name === field.name)!);
    const agree = <K extends keyof Field>(key: K): Field[K] | undefined =>
      siblings.every((sibling) => stableJson(sibling[key]) === stableJson(field[key])) ? field[key] : undefined;
    const { type, changed } = sharedFieldType(
      field,
      pinned.get(field.name),
      enumValuesByField,
      enumNamesByField,
      renames,
    );
    const shared: Field = { name: field.name, type, required: field.required };
    // Every member agrees on the domain name: it is part of the key.
    if (field.domainName !== undefined) shared.domainName = field.domainName;
    const description = agree('description');
    if (description !== undefined) shared.description = description;
    if (field.readOnly !== undefined) shared.readOnly = field.readOnly;
    if (field.writeOnly !== undefined) shared.writeOnly = field.writeOnly;
    if (field.deprecated !== undefined) shared.deprecated = field.deprecated;
    if (field.default !== undefined) shared.default = field.default;
    if (field.constraints !== undefined) shared.constraints = field.constraints;
    const extensions = agree('extensions');
    if (extensions !== undefined) shared.extensions = extensions;
    if (!changed) {
      const example = agree('example');
      if (example !== undefined) shared.example = example;
      const examples = agree('examples');
      if (examples !== undefined) shared.examples = examples;
      const externalDocs = agree('externalDocs');
      if (externalDocs !== undefined) shared.externalDocs = externalDocs;
    }
    return shared;
  });
  const model: Model = { name, fields };
  if (representative.deprecated !== undefined) model.deprecated = representative.deprecated;
  if (representative.constraints !== undefined) model.constraints = representative.constraints;
  if (representative.typeParams !== undefined) model.typeParams = representative.typeParams;
  if (members.every((member) => stableJson(member.extensions) === stableJson(representative.extensions))) {
    if (representative.extensions !== undefined) model.extensions = representative.extensions;
  }
  if (representative.variants) {
    const union = simplifyType({
      kind: 'union',
      variants: representative.variants.map((variant) => rewritten(variant, renames)),
      ...(representative.compositionKind && { compositionKind: representative.compositionKind }),
    });
    model.variants = union.kind === 'union' ? union.variants : [union];
    if (representative.compositionKind !== undefined) model.compositionKind = representative.compositionKind;
  }
  if (representative.discriminator) {
    const mapping: Record<string, string> = {};
    for (const [value, target] of Object.entries(representative.discriminator.mapping)) {
      mapping[value] = renames.get(target) ?? target;
    }
    model.discriminator = { property: representative.discriminator.property, mapping };
  }
  return model;
}

/**
 * The type a shared model gives a field. A string the group pins — a
 * `const`, an inline `enum`, beside a plain `string` — is read as a whole:
 * two or more distinct values make the enum shared by every error body
 * with a field of that name, `<ErrorBody><Field>`, holding every value any
 * body pins it to (a string when that name is taken); one value every
 * member pins stays that literal; one value beside free strings is a
 * string. Any other type is the representative's, its references to folded
 * models repointed.
 */
function sharedFieldType(
  field: Field,
  pinned: PinnedValues | undefined,
  enumValuesByField: ReadonlyMap<string, ReadonlySet<string>>,
  enumNamesByField: ReadonlyMap<string, string>,
  renames: ReadonlyMap<string, string>,
): { type: TypeRef; changed: boolean } {
  if (pinned) {
    const nullable = field.type.kind === 'nullable';
    let type: TypeRef;
    const enumName = enumNamesByField.get(field.name);
    if (pinned.values.size >= 2 && enumName !== undefined) {
      const enumRef: EnumRef = {
        kind: 'enum',
        name: enumName,
        values: [...(enumValuesByField.get(field.name) ?? pinned.values)].sort(),
      };
      type = enumRef;
    } else if (pinned.values.size === 1 && !pinned.open) {
      type = { kind: 'literal', value: [...pinned.values][0] };
    } else {
      type = { kind: 'primitive', type: 'string' };
    }
    const wrapped: TypeRef = nullable ? { kind: 'nullable', inner: type } : type;
    return { type: wrapped, changed: stableJson(wrapped) !== stableJson(field.type) };
  }
  return { type: rewritten(field.type, renames), changed: false };
}

/** `type` with every reference to a folded model repointed, as a new tree. */
function rewritten(type: TypeRef, renames: ReadonlyMap<string, string>): TypeRef {
  const copy = structuredClone(type);
  renameTypeRefModels(copy, renames);
  return simplifyType(copy);
}

/**
 * A union whose variants fold onto fewer models, with the duplicates dropped
 * and a lone survivor standing in for the union; a nullable, array or map
 * simplified inside. Any other type is returned as it is.
 */
function simplifyType(type: TypeRef): TypeRef {
  switch (type.kind) {
    case 'union': {
      const seen = new Set<string>();
      const variants: TypeRef[] = [];
      for (const variant of type.variants) {
        const simplifiedVariant = simplifyType(variant);
        const key = stableJson(simplifiedVariant);
        if (seen.has(key)) continue;
        seen.add(key);
        variants.push(simplifiedVariant);
      }
      if (variants.length === 1) return variants[0];
      if (variants.length === type.variants.length && variants.every((variant, i) => variant === type.variants[i])) {
        return type;
      }
      const union: UnionType = { ...type, variants };
      return union;
    }
    case 'nullable': {
      const inner = simplifyType(type.inner);
      return inner === type.inner ? type : { kind: 'nullable', inner };
    }
    case 'array': {
      const items = simplifyType(type.items);
      return items === type.items ? type : { ...type, items };
    }
    case 'map': {
      const valueType = simplifyType(type.valueType);
      return valueType === type.valueType ? type : { ...type, valueType };
    }
    default:
      return type;
  }
}

function unwrapNullable(type: TypeRef): TypeRef {
  return type.kind === 'nullable' ? unwrapNullable(type.inner) : type;
}

/** A plain string, a string literal, or an inline enum of strings: the shapes the pass reads as one. */
function isStringLike(type: TypeRef): boolean {
  if (type.kind === 'literal') return typeof type.value === 'string';
  if (type.kind === 'enum') return isStringValuedInlineEnum(type);
  return type.kind === 'primitive' && type.type === 'string' && !type.format;
}

function isStringValuedInlineEnum(type: EnumRef): boolean {
  return type.values !== undefined && type.values.length > 0 && type.values.every((value) => typeof value === 'string');
}

/** JSON with object keys sorted at every level, `undefined` members dropped. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, member]) => member !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}
