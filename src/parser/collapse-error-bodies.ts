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
 * as they are. The models it takes are keyed by their shape (`ModelKeys`),
 * and a body's shape is its required fields — a body that requires none, all
 * of them (`namedFields`): each one's name, its domain name (a `fieldHints`
 * entry) and its type, a nested error-only model by its own key, and a
 * string the document pins — `const: idp_metadata_fetch_failed`, an inline
 * `enum`, a plain `string` — all as one string, so the bodies that differ
 * only in their error code, their prose or their `x-` extensions fold onto
 * one model. An optional field is not shape (#506, #516): a body gains one
 * without leaving its group, and the group's model carries every optional
 * field any member declares. A named field's `deprecated` is shape (#629),
 * as it is wherever an inline model is compared (`fieldFlagAgrees`): a
 * field's flag has no carrier but the field, so a body whose `message` is
 * deprecated and one whose `message` is live never share a model, and the
 * name spells the flag (`ErrorBodyWithDeprecatedMessage`). The body's own
 * `deprecated` is read apart from its shape, as a copy's is wherever an
 * inline model is compared (`flagAdmits`): a body's name never depends on
 * its own flag (#441), the shared model is deprecated only when every
 * member is, and a deprecated member folds onto a live model with a
 * warning. A field's other flags, default and limits are not shape, and
 * the shared model keeps them where every member agrees, as it keeps a
 * description; an optional field's domain name, and its `deprecated`, are
 * kept when the members that carry the field agree, and dropped with a
 * warning when they do not. A string
 * inside an array, union or map keeps its value in the key (`L"a"`,
 * `E["a","b"]`), since nothing combines values there, so two bodies that
 * list different codes in an array stay two models.
 *
 * Each group becomes one model, named from its shape alone (`bodyName`), so
 * that a name is a function of the shape and two shapes never ask for one
 * name (#515): `ErrorBody` for `{ message }`, `OAuthErrorBody` for the OAuth
 * error format `{ error, error_description }`, else the base plus `With` and
 * a token per further required field. The fields a family implies — a
 * `message`, or `error` and `error_description` in the OAuth format — and
 * the field a value-named group pins are left out of the name only while
 * they are plain strings (no `null`, no format, no domain name); otherwise
 * their token is spelled like any other (`ErrorBodyWithNullableMessage`,
 * `OAuthErrorBodyWithErrorInteger`, `GoneErrorBodyWithNullableCode`). A
 * body that has no required `message` says so
 * (`ErrorBodyWithCodeWithoutMessage` for `{ code }`). A field's token is its
 * name in PascalCase, qualified by what its type adds so that two shapes
 * with the same field names still read apart: `Nullable` leads a field that
 * admits `null` (`NullableMessage`), a scalar that is not a plain string
 * follows the name (`CodeInteger`, `CreatedAtDateTime`), a non-string
 * `const` or inline `enum` spells its values (`Status404`, `OkTrue`,
 * `Status404Or410`; behind `No` after a name ending in a digit), a domain
 * name follows it after `As` (`MessageAsDetail`), an array of plain values
 * ends in `List` (`MessageList`), a union joins its variants with `Or`
 * (`MessageOrMessageList`), and a nested error body is prefixed with the
 * tokens of every required field of its own, the ones the parent also has
 * included (`ErrorBodyWithCodeFieldErrors` for
 * `{ message, errors: [{ code, field }] }`, `ErrorBodyWithCodeMessageErrors`
 * for items `{ code, message }`). A body that requires no
 * field is named from every field it has, under `Optional`, so it never
 * takes a required shape's name (`OptionalErrorBody` for `{ message? }`,
 * `OptionalErrorBodyWithCode` for `{ code?, message? }`). A group whose
 * members all pin one required string field to one value is named from that
 * value instead (`RateLimitExceededErrorBody`, `InvalidGrantOAuthErrorBody`;
 * the field's name follows the value unless it is `code` or `error`), plus
 * `With` and the tokens of any further fields, a nested body's fields left
 * out (`OrganizationSelectionRequiredErrorBodyWithOrganizations`). A model
 * only another error body reaches is named from its parent and field
 * (`OrganizationSelectionRequiredErrorBodyWithOrganization`, singular for an
 * array item), plus its own fields when the field is optional in the parent,
 * whose name then says nothing of it (`ErrorBodyDetailWithReason` for
 * `{ message, detail?: { reason } }`). `ErrorBody` rather than
 * `ErrorResponse` because an emitter may already spend that name on a
 * component called `Error` (Go does).
 *
 * The pass never numbers a name. A shared name a component schema of that
 * shape already holds is that component for every member it can stand for
 * (`componentAccepts`) — one that is live (a deprecated component takes no
 * body, as it takes no inline copy anywhere else, #441, #629), that
 * declares every field the member has, required or optional and deprecated
 * or live as the member has it, of its type and domain name, no stricter
 * in its limits, and admitting every value the member pins:
 * those members fold onto it, and a member it cannot stand for is left as
 * it is, with a warning that prints that member's shape, so a body that
 * gains a field the component lacks moves alone. A name anything else holds
 * — a component of another shape, an enum, a shared body whose shape
 * differs in what no name can spell (a value pinned inside an array, a
 * discriminator mapping, the component or named enum a field references, a
 * field named like another field's qualifier, a pinned value that spells a
 * family prefix) — leaves the group's models exactly as the parser
 * materialized them, with every error-only model they reach or are reached
 * from, and says so in a warning that prints both shapes with their types;
 * the fold then runs again without them, since a freed name may now suit
 * another group. The groups are ordered by shape, never by operation: fewer
 * named fields first, a shape whose name is its field names alone before
 * one a qualifier spelled (`qualified`), then the key, so the same shape
 * keeps a contested name whichever operation declared it, and adding
 * `{ message, code: integer }` beside `{ message, code_integer }` (both
 * `ErrorBodyWithCodeInteger`) leaves the latter's model as it is.
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
 * strings widens to `string`. An optional field the members type
 * differently is the union of the types they wrote. A field's description,
 * example and extensions survive only when every member wrote the same one;
 * the response's own `description` stays on the `errors[]` entry, where it
 * always was.
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
import type { Constraints, Enum, EnumRef, Field, Model, Service, TypeRef, UnionType, Webhook } from '../ir/types.js';
import {
  collectModelRefs,
  collectModelTypeRefs,
  collectOperationTypeRefs,
  collectWebhookTypeRefs,
  renameTypeRefModels,
} from '../ir/types.js';
import { numberedName, singularize, toPascalCase } from '../utils/naming.js';
import { sameEnumShape } from './enum-members.js';
import { isErrorStatusRange } from './responses.js';

/** The stem every shared error body is named from: `ErrorBody`, `ErrorBodyWithCode`, and the enums `ErrorBodyCode`, `ErrorBodyError`. */
export const ERROR_BODY_BASE = 'ErrorBody';

/** The prefix of the family a body that requires no field is named in: `OptionalErrorBody` for `{ message? }` (#515). */
const OPTIONAL_PREFIX = 'Optional';

/** The clause ending the name of a body that has no required `message`: `ErrorBodyWithCodeWithoutMessage` for `{ code }` (#515). */
const WITHOUT_MESSAGE = 'WithoutMessage';

/** What leads the token of a deprecated field (`ErrorBodyWithDeprecatedMessage`), so a shape that deprecates a field never asks for the live shape's name (#629). */
const DEPRECATED_PREFIX = 'Deprecated';

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

/** What a name reads of the models around a body: which are error-only, and each by name. */
interface NamingContext {
  errorOnly: ReadonlySet<string>;
  byName: ReadonlyMap<string, Model>;
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
  const naming: NamingContext = { errorOnly, byName };
  // Group by shape, each group's members in name order.
  const keys = new ModelKeys(errorOnly, byName);
  const groups = new Map<string, Model[]>();
  for (const name of [...errorOnly].sort()) {
    const key = keys.of(name);
    const group = groups.get(key);
    if (group) group.push(byName.get(name)!);
    else groups.set(key, [byName.get(name)!]);
  }
  // Groups are ordered by shape, never by the operations that produced them:
  // fewer named fields first, then a shape whose name is its field names
  // alone before one a qualifier spelled, then the key, so when two shapes
  // ask for one name the same one keeps it whichever operation declared it,
  // renaming an operation moves no model name, and a field named like
  // another field's qualifier (`code_integer` beside `code: integer`, both
  // `ErrorBodyWithCodeInteger`) keeps its model when the qualified shape is
  // added.
  const orderedGroups = [...groups.entries()].sort(([keyA, a], [keyB, b]) => {
    const fields = namedFields(a[0]).length - namedFields(b[0]).length;
    if (fields !== 0) return fields;
    const plain = Number(qualified(a[0], naming)) - Number(qualified(b[0], naming));
    return plain !== 0 ? plain : keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
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
  for (const name of options.componentNames) {
    holders.set(name, `${byName.get(name)?.deprecated ? 'deprecated ' : ''}component schema "${name}"`);
  }
  for (const e of existingEnums) holders.set(e.name, `enum "${e.name}"`);
  const canonical = new Map<string, string>(); // group key → shared name
  const absorbed = new Set<string>(); // group keys folded onto a component of their shape
  const seeds = new Set<string>(); // the models of the groups left as they are
  const leave = (name: string, holder: string, left: readonly Model[]): void => {
    for (const member of left) seeds.add(member.name);
    const list = left.map((member) => `"${member.name}"`).join(', ');
    const kept = left.length === 1 ? `model ${list} as it is` : `models ${list} as they are`;
    console.warn(
      `[oagen] Warning: The shared error body ${shapeOf(left[0])} would be named "${name}", which ${holder} already holds — keeping ${kept}; give the two the same shape, or rename one`,
    );
  };
  const claim = (name: string, key: string, members: readonly Model[]): void => {
    const holder = holders.get(name);
    if (holder === undefined) {
      holders.set(name, `the shared error body "${name}" ${shapeOf(members[0])}`);
      canonical.set(key, name);
      return;
    }
    // A component schema of this shape is the shared body of every member
    // it can stand for; a member it cannot — one with a field, a domain
    // name, a limit, a field flag or a pinned value the component does not
    // admit, or any member when the component is deprecated — is left as it
    // is, alone, with its own shape in the warning, and the fold runs again
    // with the rest (#506, #629).
    const component = byName.get(name);
    if (component && !errorOnly.has(name) && keys.of(name) === key) {
      const left = members.filter((member) => !componentAccepts(component, member, keys));
      if (left.length === 0) {
        // A deprecated body a live component takes is announced, as a
        // deprecated inline copy a live component admits is (#441, #629):
        // the body's flag has no carrier once the body folds.
        const deprecated = members.filter((member) => member.deprecated);
        if (deprecated.length > 0) warnDeprecatedFold(name, deprecated, `component schema "${name}"`);
        canonical.set(key, name);
        absorbed.add(key);
        return;
      }
      leave(name, holder, left);
      return;
    }
    leave(name, holder, members);
  };
  const frozenOut = (members: readonly Model[]): boolean => members.some((member) => seeds.has(member.name));
  for (const [key, members] of orderedGroups) {
    if (!members.some((member) => topLevel.has(member.name))) continue;
    claim(bodyName(members[0], pinnedByKey.get(key)!, naming), key, members);
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
          return parentName === undefined ? undefined : nestedName(parentName, parent, field, members[0], naming);
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
      claim(bodyName(members[0], pinnedByKey.get(key)!, naming), key, members);
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
 * The fields a body's key and name read: its required fields, since an
 * optional one added later must not move the body to another model (#506,
 * #516) — or, for a body that requires none, every field it has, which is
 * all there is to name it from (#515).
 */
function namedFields(model: Model): Field[] {
  const required = model.fields.filter((field) => field.required);
  return required.length > 0 ? required : model.fields;
}

const byFieldName = (a: Field, b: Field): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The shape of an error-only model, independent of its name, its optional
 * fields, its documentation, its own `deprecated`, its limits and other
 * flags, its `x-` extensions and the values its string fields are pinned
 * to; each named field's `deprecated` is part of it (#629), as the name
 * spells it. Memoized per model; a cycle among error bodies reads as the
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
    // Each named field's name, requiredness, `deprecated`, domain name and
    // type: exactly what `bodyName` spells, so two keys never ask for one
    // name (#515, #629).
    const fields = namedFields(model)
      .map(
        (field) =>
          `${field.name}${field.required ? '!' : '?'}${field.deprecated ? '(deprecated)' : ''}${field.domainName === undefined ? '' : `~${field.domainName}`}=${this.type(field.type, true)}`,
      )
      .sort()
      .join('|');
    const own = stableJson({
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
   * list different codes in an array stay two models. An inline enum's
   * values are read sorted (`sortedEnumValues`), as the name spells them,
   * so reordering its entries moves no body.
   */
  type(type: TypeRef, direct: boolean): string {
    switch (type.kind) {
      case 'literal':
        return direct && typeof type.value === 'string' ? 'S' : `L${JSON.stringify(type.value)}`;
      case 'enum':
        if (direct && isStringValuedInlineEnum(type)) return 'S';
        return type.values ? `E${JSON.stringify(sortedEnumValues(type.values))}` : `E:${type.name}`;
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

/**
 * One field per name the members declare, in the order the shared model
 * lists them: the first member's fields, then the optional fields each
 * later member adds, in its order.
 */
function sharedFieldOrder(members: readonly Model[]): Field[] {
  const order: Field[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    for (const field of member.fields) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      order.push(field);
    }
  }
  return order;
}

/** The members' fields of one name, in member order; a member without the field adds none. */
function siblingsOf(members: readonly Model[], name: string): Field[] {
  return members.flatMap((member) => member.fields.filter((field) => field.name === name));
}

/**
 * For every field the members type as a string (by name), the values pinned
 * and whether any member leaves it free. An optional field a member lacks
 * neither pins nor frees it: that member's body never carries the field.
 */
function pinnedValues(members: readonly Model[]): Map<string, PinnedValues> {
  const pinned = new Map<string, PinnedValues>();
  for (const field of sharedFieldOrder(members)) {
    const inners = siblingsOf(members, field.name).map((sibling) => unwrapNullable(sibling.type));
    if (!inners.every(isStringLike)) continue;
    const entry: PinnedValues = { values: new Set(), open: false };
    for (const inner of inners) {
      if (inner.kind === 'literal' && typeof inner.value === 'string') entry.values.add(inner.value);
      else if (inner.kind === 'enum' && isStringValuedInlineEnum(inner)) {
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
 * Whether `component`, whose key is the group's, can stand for `member`: it
 * is live — a deprecated component takes no body, live or deprecated, as it
 * takes no inline copy anywhere else (`ownerFlagAdmits`, #441, #629), so no
 * live site resolves to a deprecated model; it declares every field the
 * member has, required or optional and deprecated or live as the member has
 * it (`fieldFlagAgrees`: a field's flag has no carrier but the field, so a
 * component whose field is live would drop the notice the member's gave
 * its readers, and one whose field is deprecated would give them a notice
 * the member's schema never wrote), of the member's type and domain name,
 * so no body loses a field or a hint by folding onto it; it is no stricter
 * than the member — every
 * limit it writes, on itself, a field or the field's type, the member
 * writes the same, so no body is narrowed by folding onto it (the key
 * leaves limits out, as the shared model merges them); and it admits every
 * value the member pins — a string field the member pins is, on the
 * component, a plain string, or, when the member does not leave it free, a
 * literal or inline enum holding every pinned value. The key reads every
 * string as one, so this is what tells a component the body can reference
 * from one that would narrow its codes.
 */
function componentAccepts(component: Model, member: Model, keys: ModelKeys): boolean {
  if (component.deprecated) return false;
  if (!noStricter(component.constraints, member.constraints)) return false;
  for (const field of member.fields) {
    const own = component.fields.find((f) => f.name === field.name);
    if (
      !own ||
      own.required !== field.required ||
      !!own.deprecated !== !!field.deprecated ||
      own.domainName !== field.domainName ||
      keys.type(own.type, true) !== keys.type(field.type, true) ||
      !noStricter(own.constraints, field.constraints) ||
      !noStricter(typeConstraints(own.type), typeConstraints(field.type))
    ) {
      return false;
    }
  }
  for (const [name, { values, open }] of pinnedValues([member])) {
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

/** Whether every limit `component` writes, `member` writes the same: the component admits at least what the member does. */
function noStricter(component: Constraints | undefined, member: Constraints | undefined): boolean {
  if (component === undefined) return true;
  const own = member ?? {};
  return Object.entries(component).every(
    ([keyword, value]) => stableJson(value) === stableJson(own[keyword as keyof Constraints]),
  );
}

/** The validation keywords `type` carries at its top level, through a nullable wrapper. */
function typeConstraints(type: TypeRef): Constraints | undefined {
  const inner = unwrapNullable(type);
  return inner.kind === 'model' || inner.kind === 'enum' || inner.kind === 'nullable' ? undefined : inner.constraints;
}

/**
 * `{ code: string, message?: string | null, detail as reason: Note }`: a
 * model's fields with their requiredness, domain name and type, so that a
 * warning printing two shapes says what tells them apart (#515), and
 * `(deprecated)` after a deprecated field's name
 * (`{ message (deprecated): string }`), since a field's flag is shape too
 * (#629); the model's own flag is not, and is not printed.
 */
function shapeOf(model: Model): string {
  if (model.fields.length === 0) return '{ }';
  const fields = model.fields.map(
    (field) =>
      `${field.name}${field.required ? '' : '?'}${field.deprecated ? ' (deprecated)' : ''}${field.domainName === undefined ? '' : ` as ${field.domainName}`}: ${describeType(field.type)}`,
  );
  return `{ ${fields.join(', ')} }`;
}

/** A type as a warning prints it: `string`, `string (date-time)`, `"gone"`, `Note`, `string | null`, `(Note | Tag)[]`, `map<string>`. */
function describeType(type: TypeRef): string {
  switch (type.kind) {
    case 'model':
      return type.name;
    case 'enum':
      return type.name || `enum (${(type.values ?? []).map((value) => JSON.stringify(value)).join(' | ')})`;
    case 'literal':
      return JSON.stringify(type.value);
    case 'primitive':
      return type.format ? `${type.type} (${type.format})` : type.type;
    case 'array': {
      const items = describeType(type.items);
      return type.items.kind === 'union' || type.items.kind === 'nullable' ? `(${items})[]` : `${items}[]`;
    }
    case 'nullable':
      return `${describeType(type.inner)} | null`;
    case 'union':
      return type.variants.map(describeType).join(' | ');
    case 'map':
      return `map<${describeType(type.valueType)}>`;
  }
}

/**
 * The one string field among `names` every member of a group pins to one
 * value, when there is exactly one such field and the value can name a
 * model.
 */
function singlePinned(
  pinned: ReadonlyMap<string, PinnedValues>,
  names: ReadonlySet<string>,
): { field: string; value: string } | undefined {
  const single = [...pinned.entries()].filter(
    ([field, { values, open }]) => names.has(field) && values.size === 1 && !open,
  );
  if (single.length !== 1) return undefined;
  const [field, { values }] = single[0];
  const value = [...values][0];
  const word = toPascalCase(value);
  // A value that is empty or starts with a digit (`4001`) names nothing.
  if (word.length === 0 || /^\d/.test(word)) return undefined;
  return { field, value };
}

/**
 * Whether a body's name spells more than its named fields' names: some
 * field's token carries a qualifier — `Deprecated`, `Nullable`, a type or
 * format, a value, a domain name after `As`, `List`, `Or`, a nested body's
 * fields. No
 * qualifier is beyond what a field name can spell, in the IR or once an
 * emitter re-cases it (`code_integer` is `CodeInteger`, as `code: integer`
 * is), so the fold cannot keep the two apart by spelling; it orders a plain
 * shape before a qualified one instead, so that adding the qualified shape
 * leaves the plain one's model as it is.
 */
function qualified(model: Model, naming: NamingContext): boolean {
  const visiting = new Set([model.name]);
  return namedFields(model).some((field) => fieldToken(field, true, naming, visiting) !== toPascalCase(field.name));
}

/** A plain string a name need not spell: a free, pinned or enumerated string under no `null`, no format and no domain name, on a field that is not deprecated. */
function isPlainString(field: Field): boolean {
  return field.domainName === undefined && !field.deprecated && isStringLike(field.type);
}

/**
 * The name a group takes, read from the fields `namedFields` gives — the
 * required ones, or every field under `Optional` when none is required:
 * `ErrorBody` for `{ message }`, `OAuthErrorBody` for
 * `{ error, error_description }`, else the base plus `With` and a token per
 * further field (`fieldToken`). The fields the family implies — `message`,
 * or `error` and `error_description` in the OAuth format — and the field a
 * value-named group pins are left out only while they are plain strings;
 * one that admits `null`, has a format, carries a domain name or is
 * deprecated is spelled like any other field (`ErrorBodyWithNullableMessage`,
 * `OAuthErrorBodyWithErrorInteger`, `GoneErrorBodyWithNullableCode`,
 * `ErrorBodyWithDeprecatedMessage`), so two shapes that differ there never
 * ask for one name. A body of the
 * `ErrorBody` family with no required `message` ends in `WithoutMessage`. A
 * group every member of which pins one named string field to one value is
 * named from the value instead — followed by the field's name unless it is
 * `code` or `error` — plus `With` and the tokens of any further fields, a
 * nested body's own fields left out.
 */
function bodyName(representative: Model, pinned: ReadonlyMap<string, PinnedValues>, naming: NamingContext): string {
  if (representative.fields.length === 0) return `${ERROR_BODY_BASE}Empty`;
  const read = namedFields(representative);
  const optional = !read[0].required;
  const fields = [...read].sort(byFieldName);
  const names = new Set(fields.map((field) => field.name));
  const oauth = OAUTH_ERROR_FIELDS.every((name) => names.has(name));
  const base = `${optional ? OPTIONAL_PREFIX : ''}${oauth ? 'OAuth' : ''}${ERROR_BODY_BASE}`;
  const single = singlePinned(pinned, names);
  const implied = new Set<string>(oauth ? OAUTH_ERROR_FIELDS : ['message']);
  if (single) implied.add(single.field);
  const extras = fields
    .filter((field) => !(implied.has(field.name) && isPlainString(field)))
    .map((field) => fieldToken(field, single === undefined, naming, new Set([representative.name])));
  const suffix = extras.length === 0 ? '' : `With${extras.join('')}`;
  const without = !oauth && !names.has('message') ? WITHOUT_MESSAGE : '';
  if (single === undefined) return `${base}${suffix}${without}`;
  const field = ERROR_CODE_FIELDS.includes(single.field) ? '' : toPascalCase(single.field);
  return `${toPascalCase(single.value)}${field}${base}${suffix}${without}`;
}

/**
 * The token a field contributes to a body's name: its name in PascalCase,
 * its domain name after `As` when it has one, what its type adds
 * (`typeToken`), and `Deprecated` leading the whole when the field is
 * deprecated (`DeprecatedMessage`, `DeprecatedNullableMessage`), outside
 * what the type adds as the flag is outside the type (#629).
 */
function fieldToken(field: Field, qualify: boolean, naming: NamingContext, visiting: ReadonlySet<string>): string {
  const word = `${toPascalCase(field.name)}${field.domainName === undefined ? '' : `As${toPascalCase(field.domainName)}`}`;
  const token = typeToken(word, field.type, qualify, naming, visiting);
  return field.deprecated ? `${DEPRECATED_PREFIX}${token}` : token;
}

/**
 * `word` qualified by what `type` adds: `Nullable` first for a type that
 * admits `null`; a union's variants joined with `Or`; `List` appended for
 * an array of plain values, after what the item scalar adds; and, when
 * `qualify` is set, a nested error body's own required fields prefixed, so
 * `errors` arrays of different items read apart (`CodeFieldErrors`,
 * `ConstraintsPropertyErrors`). A scalar that is not a plain string follows
 * the word, a non-string `const` or inline `enum` by its values
 * (`scalarToken`). A reference to a component or a named enum, a map and an
 * untyped schema add nothing.
 */
function typeToken(
  word: string,
  type: TypeRef,
  qualify: boolean,
  naming: NamingContext,
  visiting: ReadonlySet<string>,
): string {
  switch (type.kind) {
    case 'nullable':
      return `Nullable${typeToken(word, type.inner, qualify, naming, visiting)}`;
    case 'union': {
      // Sorted, as the key sorts the variants: the name does not depend on
      // which member of the group wrote the union first.
      const tokens = type.variants.map((variant) => typeToken(word, variant, qualify, naming, visiting));
      return [...new Set(tokens)].sort().join('Or') || word;
    }
    case 'array': {
      const items = unwrapNullable(type.items);
      if (items.kind === 'model' || items.kind === 'union') {
        return typeToken(word, items, qualify, naming, visiting);
      }
      return `${scalarToken(word, type.items)}List`;
    }
    case 'model': {
      const nested = qualify && naming.errorOnly.has(type.name) ? naming.byName.get(type.name) : undefined;
      // A cycle among error bodies reads as the field's name alone.
      const own = nested && !visiting.has(nested.name) ? nestedPrefix(nested, naming, visiting) : '';
      return `${own}${word}`;
    }
    case 'primitive':
    case 'literal':
    case 'enum':
      return scalarToken(word, type);
    default:
      return word;
  }
}

/**
 * `word` followed by what a scalar adds: nothing for a plain string, a
 * string literal, an inline enum of strings, a named enum or an untyped
 * schema; `Nullable` for an array item that admits `null` (`TagsNullableList`
 * for `(string | null)[]`, apart from `NullableTagsList` for
 * `string[] | null`); a format (`DateTime`, `Int64`) or type (`Integer`,
 * `Number`, `Boolean`) in PascalCase; a non-string `const` by its value
 * (`Status404`, `OkTrue`, `RatioMinus1Point5`) and an inline
 * enum of non-string values by its values, sorted as the key sorts them
 * (`sortedEnumValues`) so that reordering the entries renames nothing, and
 * joined with `Or` (`Status404Or410`), since the key keeps those values and
 * nothing combines them (#515). A number is set off by `No` from a word
 * that ends in a digit (`V2No3`), as every number in a name is
 * (`numberedName`).
 */
function scalarToken(word: string, type: TypeRef): string {
  switch (type.kind) {
    case 'nullable':
      return scalarToken(`${word}Nullable`, type.inner);
    case 'primitive':
      if (type.type === 'unknown' || (type.type === 'string' && !type.format)) return word;
      return `${word}${toPascalCase(type.format ?? type.type)}`;
    case 'literal':
      return typeof type.value === 'string' ? word : valueToken(word, type.value);
    case 'enum':
      if (!type.values || isStringValuedInlineEnum(type)) return word;
      return sortedEnumValues(type.values)
        .map((value, i) => valueToken(i === 0 ? word : 'Or', value))
        .join('');
    default:
      return word;
  }
}

/** `word` followed by a literal's value: `True`, `False`, `Null`, a number with `-` as `Minus` and `.` as `Point`, a string in PascalCase. */
function valueToken(word: string, value: string | number | boolean | null): string {
  if (typeof value === 'string') return `${word}${toPascalCase(value)}`;
  if (typeof value === 'boolean') return `${word}${value ? 'True' : 'False'}`;
  if (value === null) return `${word}Null`;
  const spelled = String(value)
    .replace('-', 'Minus')
    .replace('.', 'Point')
    .replace(/[^A-Za-z0-9]/g, '');
  return numberedName(word, spelled);
}

/**
 * The tokens of a nested error body's own named fields — every one, the
 * ones its parent also has included, so `[{ code, message }]` and
 * `[{ code }]` read apart (`CodeMessageErrors`, `CodeErrors`) — sorted by
 * field name and joined, each read as a body's own are so a body nested
 * deeper reads the same way.
 */
function nestedPrefix(item: Model, naming: NamingContext, visiting: ReadonlySet<string>): string {
  const inner = new Set([...visiting, item.name]);
  return [...namedFields(item)]
    .sort(byFieldName)
    .map((field) => fieldToken(field, true, naming, inner))
    .join('');
}

/**
 * The name of a nested error body `item` reached through `field` of a body
 * `parent` named `parentName`: the parent's name plus the field, singular
 * for an array item, replacing the field where the parent's name already
 * ends in it. When the field is not among the ones the parent's name reads
 * (an optional one), that name says nothing of the item, so the item's own
 * fields follow after `With`, as they prefix the field in a required
 * parent's name — `ErrorBodyDetailWithReason` for
 * `{ message, detail?: { reason } }` — so two items under one optional field
 * never ask for one name.
 */
function nestedName(parentName: string, parent: Model, field: Field, item: Model, naming: NamingContext): string {
  const word = toPascalCase(field.name);
  const inArray = unwrapNullable(field.type).kind === 'array';
  const itemWord = inArray ? toPascalCase(singularize(field.name)) : word;
  const base =
    inArray && word.length > 0 && parentName.endsWith(word)
      ? `${parentName.slice(0, -word.length)}${itemWord}`
      : `${parentName}${itemWord}`;
  if (namedFields(parent).includes(field)) return base;
  const own = nestedPrefix(item, naming, new Set([parent.name]));
  return own.length === 0 ? base : `${base}With${own}`;
}

/**
 * One shared model for `members`, carrying every field any member declares
 * (`sharedFieldOrder`): each field's type reads as the group reads it
 * (`sharedFieldType`); its description, access flags, default, limits and
 * extensions are kept when every member that has the field wrote the same
 * one, the example only while the type is still the member's own, its
 * domain name when every member that hints the field agrees
 * (`sharedDomainName`), and its `deprecated` when every member that carries
 * the field agrees (`sharedDeprecated`: a named field's is part of the key,
 * an optional field's is settled with a warning, #629). The model is
 * deprecated only when every member is (`sharedModelDeprecated`): a
 * deprecated member folds onto a live model with a warning, as a deprecated
 * inline copy folds onto its live twin (#441).
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
  const fields: Field[] = sharedFieldOrder(members).map((field) => {
    const siblings = siblingsOf(members, field.name);
    const agree = <K extends keyof Field>(key: K): Field[K] | undefined =>
      siblings.every((sibling) => stableJson(sibling[key]) === stableJson(field[key])) ? field[key] : undefined;
    const constraints = agree('constraints');
    const { type, changed } = sharedFieldType(
      siblings,
      pinned.get(field.name),
      enumValuesByField,
      enumNamesByField,
      renames,
      constraints,
    );
    const shared: Field = { name: field.name, type, required: field.required };
    const domainName = sharedDomainName(name, members, field.name);
    if (domainName !== undefined) shared.domainName = domainName;
    const description = agree('description');
    if (description !== undefined) shared.description = description;
    const readOnly = agree('readOnly');
    if (readOnly !== undefined) shared.readOnly = readOnly;
    const writeOnly = agree('writeOnly');
    if (writeOnly !== undefined) shared.writeOnly = writeOnly;
    if (sharedDeprecated(name, members, field.name)) shared.deprecated = true;
    const defaultValue = agree('default');
    if (defaultValue !== undefined) shared.default = defaultValue;
    if (constraints !== undefined) shared.constraints = constraints;
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
  const agree = <K extends keyof Model>(key: K): Model[K] | undefined =>
    members.every((member) => stableJson(member[key]) === stableJson(representative[key]))
      ? representative[key]
      : undefined;
  if (sharedModelDeprecated(name, members)) model.deprecated = true;
  const constraints = agree('constraints');
  if (constraints !== undefined) model.constraints = constraints;
  if (representative.typeParams !== undefined) model.typeParams = representative.typeParams;
  const extensions = agree('extensions');
  if (extensions !== undefined) model.extensions = extensions;
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
 * The domain name the shared model `name` gives its field `field`: the one
 * every member that hints the field gives it (a named field's is part of the
 * key, so the members agree; an optional field's is applied by whichever
 * members carry it, #506), or none, with a warning, when two members hint
 * it differently — a hint keyed by the shared name applies after the fold.
 */
function sharedDomainName(name: string, members: readonly Model[], field: string): string | undefined {
  const hinted = members.flatMap((member) => {
    const own = member.fields.find((f) => f.name === field);
    return own?.domainName === undefined ? [] : [{ member: member.name, domainName: own.domainName }];
  });
  const distinct = new Set(hinted.map(({ domainName }) => domainName));
  if (distinct.size <= 1) return hinted[0]?.domainName;
  const list = hinted.map(({ member, domainName }) => `"${member}" as "${domainName}"`).join(', ');
  console.warn(
    `[oagen] Warning: The shared error body "${name}" keeps "${field}" under its own name: its bodies hint it apart (${list}); hint it once, keyed by "${name}"`,
  );
  return undefined;
}

/**
 * Whether the shared model `name` is deprecated: every member is. A body's
 * own `deprecated` is not shape (its name never depends on its own flag,
 * #441), so a group may mix the flags; it then stays live, since a
 * deprecated model would type the live members' sites as deprecated, and
 * the deprecated members are announced (`warnDeprecatedFold`, #629).
 */
function sharedModelDeprecated(name: string, members: readonly Model[]): boolean {
  const deprecated = members.filter((member) => member.deprecated);
  if (deprecated.length === members.length) return members.length > 0;
  if (deprecated.length > 0) {
    const live = members.filter((member) => !member.deprecated).map((member) => `"${member.name}"`);
    warnDeprecatedFold(name, deprecated, live.join(', '));
  }
  return false;
}

/**
 * The warning a deprecated body folding onto a live model of its shape is
 * announced with — the shared model its live twins make, or a live
 * component of the name (`claim`) — as a deprecated inline copy a live
 * declared model admits is announced everywhere else (`deprecatedFoldWarning`):
 * the body's flag has no carrier once the body folds, so the readers of
 * its site lose the notice (#629).
 */
function warnDeprecatedFold(name: string, deprecated: readonly Model[], live: string): void {
  const list = deprecated.map((member) => `"${member.name}"`).join(', ');
  console.warn(
    `[oagen] Warning: The shared error body "${name}" is declared deprecated by ${list} and live by ${live} — keeping it live`,
  );
}

/**
 * Whether the shared model `name` deprecates its field `field`: every
 * member that carries the field does (a named field's flag is part of the
 * key, so the members agree; an optional field's is not, #506). When the
 * members disagree the field stays live, with a warning naming each body's
 * flag, since a flag no body wrote would give a live site's readers a
 * notice, and the one dropped is said (#629).
 */
function sharedDeprecated(name: string, members: readonly Model[], field: string): boolean {
  const flagged = members.flatMap((member) => {
    const own = member.fields.find((f) => f.name === field);
    return own === undefined ? [] : [{ member: member.name, deprecated: own.deprecated === true }];
  });
  const distinct = new Set(flagged.map(({ deprecated }) => deprecated));
  if (distinct.size <= 1) return flagged[0]?.deprecated === true;
  const list = flagged.map(({ member, deprecated }) => `"${member}" ${deprecated ? 'deprecated' : 'live'}`).join(', ');
  console.warn(
    `[oagen] Warning: The shared error body "${name}" keeps "${field}" live: its bodies flag it apart (${list}); deprecate it on every body, or on none`,
  );
  return false;
}

/**
 * The type a shared model gives a field, read from the members' `siblings`
 * of it. A string the group pins — a `const`, an inline `enum`, beside a
 * plain `string` — is read as a whole: two or more distinct values make the
 * enum shared by every error body with a field of that name,
 * `<ErrorBody><Field>`, holding every value any body pins it to (a string
 * when that name is taken); one value every member pins stays that literal;
 * one value beside free strings is a string; and the field admits `null`
 * when any member's does. Any other type every member wrote alike is that
 * type, its references to folded models repointed; an optional field the
 * members type differently is the union of the types they wrote, sorted so
 * the order does not depend on the members' (`unionOf`). The type carries
 * the limits the field does: `constraints`, the ones every member wrote,
 * or none when they differ.
 */
function sharedFieldType(
  siblings: readonly Field[],
  pinned: PinnedValues | undefined,
  enumValuesByField: ReadonlyMap<string, ReadonlySet<string>>,
  enumNamesByField: ReadonlyMap<string, string>,
  renames: ReadonlyMap<string, string>,
  constraints: Constraints | undefined,
): { type: TypeRef; changed: boolean } {
  const first = siblings[0];
  if (pinned) {
    const nullable = siblings.some((sibling) => sibling.type.kind === 'nullable');
    let type: TypeRef;
    const enumName = enumNamesByField.get(first.name);
    if (pinned.values.size >= 2 && enumName !== undefined) {
      const enumRef: EnumRef = {
        kind: 'enum',
        name: enumName,
        values: [...(enumValuesByField.get(first.name) ?? pinned.values)].sort(),
      };
      type = enumRef;
    } else if (pinned.values.size === 1 && !pinned.open) {
      type = { kind: 'literal', value: [...pinned.values][0], ...(constraints && { constraints }) };
    } else {
      type = { kind: 'primitive', type: 'string', ...(constraints && { constraints }) };
    }
    const wrapped: TypeRef = nullable ? { kind: 'nullable', inner: type } : type;
    return { type: wrapped, changed: stableJson(wrapped) !== stableJson(first.type) };
  }
  // An inline enum reads by its sorted values, as the key reads it, and not
  // by the name the parser minted it under per operation: two members that
  // list the same values, in any order, share the first member's enum.
  const seen = new Map<string, TypeRef>();
  for (const sibling of siblings) {
    const own = normalizeInlineEnums(rewritten(sibling.type, renames), true);
    const type = constraints === undefined ? stripConstraints(own) : own;
    const key = stableJson(normalizeInlineEnums(type, false));
    if (!seen.has(key)) seen.set(key, type);
  }
  if (seen.size === 1) return { type: [...seen.values()][0], changed: false };
  const types = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, type]) => type);
  return { type: unionOf(types, constraints), changed: true };
}

/**
 * An inline enum's values in the one order the key and the name read them
 * — numbers ascending, then strings in code-unit order — so that reordering
 * the entries in the document changes no shape and no name.
 */
function sortedEnumValues(values: readonly (string | number)[]): (string | number)[] {
  return [...values].sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * `type` with every inline enum's values sorted (`sortedEnumValues`), and,
 * unless `keepNames`, without the names the parser minted them under, as a
 * new tree; a reference to a component enum, and every other type, is
 * returned as it is.
 */
function normalizeInlineEnums(type: TypeRef, keepNames: boolean): TypeRef {
  switch (type.kind) {
    case 'enum':
      if (!type.values) return type;
      return { kind: 'enum', name: keepNames ? type.name : '', values: sortedEnumValues(type.values) };
    case 'nullable':
      return { kind: 'nullable', inner: normalizeInlineEnums(type.inner, keepNames) };
    case 'array':
      return { ...type, items: normalizeInlineEnums(type.items, keepNames) };
    case 'map':
      return { ...type, valueType: normalizeInlineEnums(type.valueType, keepNames) };
    case 'union':
      return { ...type, variants: type.variants.map((variant) => normalizeInlineEnums(variant, keepNames)) };
    default:
      return type;
  }
}

/**
 * The union of `types`, written as the parser writes a type list's: `null`
 * hoisted out of any member onto the whole, a member that is itself a plain
 * union spread into it, and one member standing alone. The union carries
 * `constraints`, the limits the field agreed on, since a spread member's
 * are left behind with it.
 */
function unionOf(types: readonly TypeRef[], constraints: Constraints | undefined): TypeRef {
  const nullable = types.some((type) => type.kind === 'nullable');
  const variants: TypeRef[] = [];
  const seen = new Set<string>();
  const add = (type: TypeRef): void => {
    const key = stableJson(type);
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(type);
  };
  for (const type of types) {
    const inner = unwrapNullable(type);
    if (inner.kind === 'union' && !inner.discriminator && !inner.compositionKind) {
      for (const variant of inner.variants) add(variant);
    } else add(inner);
  }
  const union: TypeRef =
    variants.length === 1 ? variants[0] : { kind: 'union', variants, ...(constraints && { constraints }) };
  return nullable ? { kind: 'nullable', inner: union } : union;
}

/** `type` with every reference to a folded model repointed, as a new tree. */
function rewritten(type: TypeRef, renames: ReadonlyMap<string, string>): TypeRef {
  const copy = structuredClone(type);
  renameTypeRefModels(copy, renames);
  return simplifyType(copy);
}

/** `type` without the validation keywords it carries at its top level — through a nullable wrapper — as a new tree. */
function stripConstraints(type: TypeRef): TypeRef {
  switch (type.kind) {
    case 'nullable':
      return { kind: 'nullable', inner: stripConstraints(type.inner) };
    case 'primitive':
    case 'literal':
    case 'array':
    case 'map':
    case 'union': {
      if (type.constraints === undefined) return type;
      const { constraints: _constraints, ...rest } = type;
      return rest as TypeRef;
    }
    default:
      return type;
  }
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
