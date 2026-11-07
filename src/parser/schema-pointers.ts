/**
 * Settling the references `schemaToTypeRef` leaves pending for a schema
 * `$ref` that names no component (#539): a JSON Pointer deeper into one
 * (`#/components/schemas/Pet/properties/owner`), or a `$ref` into another
 * section of the document.
 *
 * Such a site is typed as the schema the pointer lands on is typed where it
 * stands — `Pet.owner`'s field type for `Pet/properties/owner`, so the
 * site references `PetOwner`, the model the component pass built for the
 * field, and never a copy of it; `string` for `Pet/properties/id`; the
 * items of the array `Pets` resolves to for `Pets/items`. The parser knows
 * that type only once every model is built, so the type builder marks the
 * site pending (`pendingSchemaRef`) and this pass, run once the components,
 * their fields' models, the operations and the webhooks are extracted and
 * before any merge pass renames a model, walks the pointer through the IR
 * alongside the document — from the component's own type
 * (`componentTypeRef`), through `properties/<name>` to that field's type,
 * `items` to the array's items, `additionalProperties` or
 * `patternProperties/<pattern>` to the map's values — through the member
 * of a multi-type schema's union that carries the keyword (`type:
 * ['object', 'string']` is a union of one member per type, so its
 * `properties/<name>` are the object member's fields, its `items` the
 * array member's) — when that schema is
 * the one the map's values are typed from (`mapValueSchema`: a non-empty
 * `additionalProperties`, else the first pattern; `additionalProperties:
 * {}` types them `unknown`), so `patternProperties/^n` beside a first
 * pattern `^s` names no type, never the other pattern's — or, for a model
 * with named properties, to the catch-all `additionalProperties` field's
 * values (`Box/additionalProperties` is `integer` for `Box: { properties:
 * { id }, additionalProperties: { type: integer } }`), `oneOf/<n>` or
 * `anyOf/<n>` to the union's or the named union's n-th non-null variant
 * (the one non-null member of a union collapsed to a nullable wrapper is
 * the wrapper's inner type whole, a union of its own or a named union
 * included),
 * and `allOf/<n>` to the member's own type: a `$ref` member's reference,
 * or, for the one member the `allOf` is read as (its one typing member
 * beside members that only annotate it; #555), the `allOf`'s own type —
 * and writes the type it reaches into the pending reference in place
 * (`replaceTypeRef`), so every holder keeps the object it holds. A pointer
 * that leads nowhere is reported once, at the site, and the site typed
 * `unknown`: one into another section, to a component the document lacks,
 * to no schema (`Pet/properties/id/type`, `Pet/enum/0`), or to a schema
 * the parser builds no type for at that place (a `null` variant, an enum's
 * own members, a keyword it never reads, the fields of an enum or
 * primitive component, and any other inline `allOf` member, which declares
 * into the merged model and has no type of its own — `Pet/allOf/1` beside
 * a `$ref` member, though `Pet/allOf/1/properties/nickname` reads on
 * through it to the merged model's field), and a chain of pointers that
 * reaches itself — through a field whose type is the site, or through an
 * array component whose items point back into it. Pointers are followed as
 * RFC 6901 §4 evaluates them, structurally, never through a `$ref` on the
 * way (`schemaAtPointer`); a pointer that lands on a `$ref` schema is typed
 * as that `$ref` is.
 *
 * The limits are settled with the type (#545 review). A `$ref` to a
 * primitive or array component gives the site the component's limits
 * conjoined with what is written beside the reference (`schemaConstraints`),
 * and a pointer site reads the same once its type is known: the type the
 * site is settled into carries the limits of the schema the pointer lands
 * on — what its own type carries where it stands, under every nullable
 * wrapper it settles into (`underNullableWrappers`: a chain through a
 * nullable link to a nullable schema wears two), the conjoined reading of
 * a chain included — conjoined with the
 * site's own (`combineConstraints`, the component's first, the stricter
 * bound winning: what is written beside the pointer, then around a
 * wrapper the type builder reads through, as `withTypeConstraints`
 * records them), and a field or parameter whose type that is carries the
 * same (`Field.constraints`, `Parameter.constraints`), so `{ $ref:
 * '#/components/schemas/Owner/properties/code', maxLength: 3 }` to `{
 * type: 'string', pattern: '^own_', maxLength: 8 }` is `{ maxLength: 3,
 * pattern: '^own_' }` on the field, the parameter and the type alike, and a
 * bare pointer `{ maxLength: 8, pattern: '^own_' }`. A pointer that lands on
 * a schema typed as a model or enum adds none: that node carries its own,
 * and the site keeps what it wrote beside the `$ref`, as beside a `$ref` to
 * a model component.
 *
 * What a site decided from the pending reference before the settle is
 * decided again from the settled type: an operation whose primary response
 * was pending chooses its iterator's item type from the settled response
 * (`paginatedItemType`), so a paginated response pointing at an array of
 * strings yields strings; an explicit `dataPath` whose walk through the IR
 * crossed a pending reference — that response, or a field on the way — is
 * walked again from the settled types, under every nullable wrapper the
 * site settled into, so the iterator yields the model the pointed schema's
 * items are built as, never a copy read from the document
 * (`settleDeferredDataPathItemType`; #608; a path that forks at a union on
 * the way was read from the document at extraction, as any union's is);
 * and a discriminator mapping entry written as a pointer is written as the
 * model the schema it points at is built as — a pointer variant's, settled
 * by the walk, or, for a target outside the variants, one settled here at
 * the mapping site (`settleDeferredMappingEntries`).
 */
import type {
  Callback,
  Constraints,
  MapType,
  Model,
  ModelRef,
  Operation,
  Service,
  TypeRef,
  UnionType,
  Webhook,
} from '../ir/types.js';
import {
  callbackContext,
  collectRequestBodyTypes,
  collectResponseBodyTypes,
  collectResponseHeaders,
  typeRefConstraints,
  walkTypeRef,
} from '../ir/types.js';
import {
  arraySchemaOf,
  combineConstraints,
  componentTypeRef,
  isArrayComponentRef,
  isArrayPointerRef,
  isNullSchema,
  referenceTypesAsUnknown,
  schemaToTypeRef,
  withTypeConstraints,
  type SchemaObject,
} from './schemas.js';
import { allOfTypingMember, cloneTypeRef, mapValueSchema, readInlineAllOf, replaceTypeRef } from './inline-models.js';
import {
  collectObjectProperties,
  isDeferredDataPathItemType,
  paginatedItemType,
  settleDeferredDataPathItemType,
} from './pagination.js';
import {
  isPendingSchemaRef,
  isPendingVariant,
  pendingSiteLimitsOf,
  schemaAtPointer,
  schemaRefTokens,
  settleDeferredMappingEntries,
  settlePendingSchemaRef,
} from './schema-refs.js';

/** Where pending references are held: every model built so far — the components', their fields', the operations', the webhooks' — and the operations and webhooks themselves. */
export interface SchemaPointerSites {
  models: readonly Model[];
  services: readonly Service[];
  webhooks: readonly Webhook[];
}

const UNKNOWN: TypeRef = { kind: 'primitive', type: 'unknown' };

/** A site that carries its own limits beside its type — a field, an envelope field, a parameter — which stay one reading with the type's (`Field.constraints`, `Parameter.constraints`). */
interface LimitedSite {
  type: TypeRef;
  constraints?: Constraints;
}

/**
 * `type` under every nullable wrapper: the node that carries a value's
 * limits (`withTypeConstraints` puts them there). A settled site can wear
 * more than one — a pointer to a schema that admits null, written under a
 * nullable wrapper of its own, or reached through a chain whose link is
 * such a wrapper (`Alias.code: { oneOf: [{ $ref: …/Owner/properties/code
 * }, { type: 'null' }] }` to a nullable `Owner.code`), settles into a
 * wrapper around the copied wrapper — so one level is not enough
 * (Greptile, #545 review round 4: a field pointing through that chain with
 * `maxLength: 20` read no target limits, replaced the target's `8` with
 * the `20` and lost its own).
 */
function underNullableWrappers(type: TypeRef): TypeRef {
  let bare = type;
  while (bare.kind === 'nullable') bare = bare.inner;
  return bare;
}

/**
 * Settle every pending reference among `sites` against the document's
 * `schemas` (see the module comment), in place. Returns the references
 * settled, so the caller can give each to the site of the model it now
 * names (`attachSharedRefs`): a merge pass that renames that model then
 * repoints the reference with the model's own. A reference settled as a
 * variant of a discriminated union is returned as the union — the inline
 * union holding it, or a view onto a named union model's `variants` and
 * `discriminator` — so the rename reaches the mapping entry naming the
 * variant with the variant (`renameVariants`), as it does for a union a
 * site minted; a bare reference would be repointed alone and leave the
 * mapping naming the old name. A mapping entry written as a pointer
 * outside the union's variants (`dog: Shelter/properties/dog` beside a
 * variant `Zoo/properties/dog`; #619) is settled here too, at the mapping
 * site, to the model the schema it points at is built as (`ShelterDog`),
 * and the union — an allOf+oneOf dispatcher's mapping alone, since it
 * holds no variants — is returned as a view with a copy of each settled
 * entry's reference put before its variants, so every entry has a variant
 * of its own there and the rename reaches it as it reaches a variant's:
 * whether the reference is a target's own, a redirected inline variant's
 * held inside a multi-type variant's union, or a variant the union holds
 * that several keys name at once (`mappingEntriesByVariant` hands the j-th
 * entry naming a model to the j-th variant naming it, so a third key on
 * two such variants would be left behind).
 */
export function resolveSchemaPointers(
  sites: SchemaPointerSites,
  schemas: Record<string, SchemaObject> | undefined,
): TypeRef[] {
  const resolver = new PointerResolver(sites.models, schemas);
  /** Every discriminated union met — the named union models' and the dispatchers' as views — with the site it was met at; their mapping entries are settled once the walk is done. */
  const unions: Array<{ union: UnionType; context: string }> = [];
  const visit = (ref: TypeRef, context: string): void => {
    walkTypeRef(ref, {
      model: (reference) => {
        if (isPendingSchemaRef(reference)) resolver.settle(reference, context, new Set());
      },
    });
    collectDiscriminatedUnions(ref, context, unions);
  };
  /** A field's or parameter's type settled, then its own limits aligned with the type's (`alignSiteLimits`). */
  const visitSite = (site: LimitedSite, context: string): void => {
    visit(site.type, context);
    resolver.alignSiteLimits(site);
  };

  for (const model of sites.models) {
    for (const field of model.fields) visitSite(field, `${model.name}.${field.name}`);
    for (const variant of model.variants ?? []) visit(variant, `${model.name}.variants`);
    // A named union's variants and mapping, or an allOf+oneOf dispatcher's
    // mapping alone (a dispatcher holds no variants), as a view.
    if (model.discriminator) {
      unions.push({
        union: {
          kind: 'union',
          variants: model.variants ?? [],
          ...(model.compositionKind ? { compositionKind: model.compositionKind } : {}),
          discriminator: model.discriminator,
        },
        context: model.name,
      });
    }
  }
  for (const service of sites.services) {
    for (const op of service.operations) {
      visitOperation(op, `${service.name}.${op.name}`, visit, visitSite, sites.models);
    }
  }
  for (const webhook of sites.webhooks) {
    visitReceived(webhook, `webhooks.${webhook.name}.${webhook.httpMethod}`, visit, visitSite);
  }

  // Every variant is settled: a mapping entry written as a pointer takes
  // the model the schema it points at is built as — a variant's, settled
  // by the walk, or a target of its own, settled now at the mapping site —
  // and a union holding a settled variant, or whose entry settled to a
  // model, stands in for them among the references returned, as a view
  // with a copy of each such entry's reference put before its variants:
  // `mappingEntriesByVariant` hands the j-th entry naming a model to the
  // j-th variant naming it, so every entry has a variant of its own there
  // and follows the rename whatever else names the model (Greptile, #619
  // review rounds 2 and 4: a reference held inside a multi-type variant's
  // union, and a third key sharing one pointed model, kept the old name).
  // A reference settled by the walk is renamed through the view, never
  // again as a bare reference.
  const bare = new Set(resolver.settled);
  const roots: TypeRef[] = [];
  for (const { union, context } of unions) {
    const references = settleDeferredMappingEntries(union.discriminator?.mapping, (target, value) =>
      resolver.settle(target, `${context}.discriminator.mapping.${value}`, new Set(), 'leaving the entry as written'),
    );
    const own = union.variants
      .map(variantModelRef)
      .filter((ref): ref is ModelRef => ref !== undefined && bare.has(ref));
    const followed: TypeRef[] = [];
    for (const reference of references) {
      const model = variantModelRef(reference);
      if (model === undefined) continue;
      followed.push(cloneTypeRef(reference));
      bare.delete(model);
    }
    if (own.length === 0 && followed.length === 0) continue;
    for (const ref of own) bare.delete(ref);
    roots.push(followed.length === 0 ? union : { ...union, variants: [...followed, ...union.variants] });
  }
  return [...roots, ...resolver.settled.filter((ref) => bare.has(ref))];
}

/** The map a model carries its `additionalProperties` values in: the last field named `additionalProperties` that is a map (`extractModel` pushes it after the named properties). */
function catchAllField(model: Model | undefined): MapType | undefined {
  for (let index = (model?.fields.length ?? 0) - 1; index >= 0; index--) {
    const field = model!.fields[index]!;
    if (field.name === 'additionalProperties' && field.type.kind === 'map') return field.type;
  }
  return undefined;
}

/** The model reference `variant` is, directly or under its nullable wrapper; `undefined` for any other variant. */
function variantModelRef(variant: TypeRef): ModelRef | undefined {
  if (variant.kind === 'nullable') return variantModelRef(variant.inner);
  return variant.kind === 'model' ? variant : undefined;
}

/** Collect every discriminated union under `ref`, met at `context`, into `out`, the nested ones first. */
function collectDiscriminatedUnions(
  ref: TypeRef,
  context: string,
  out: Array<{ union: UnionType; context: string }>,
): void {
  switch (ref.kind) {
    case 'union':
      for (const variant of ref.variants) collectDiscriminatedUnions(variant, context, out);
      if (ref.discriminator) out.push({ union: ref, context });
      break;
    case 'array':
      collectDiscriminatedUnions(ref.items, context, out);
      break;
    case 'nullable':
      collectDiscriminatedUnions(ref.inner, context, out);
      break;
    case 'map':
      if (ref.keyType) collectDiscriminatedUnions(ref.keyType, context, out);
      collectDiscriminatedUnions(ref.valueType, context, out);
      break;
    default:
      break;
  }
}

/**
 * Every type an operation holds, as `validateModelRefs` reads them and
 * `collectOperationTypeRefs` lists them: every parameter location, the
 * cookies' included, the bodies, the primary response and every other
 * success entry's own type, the iterator's, the errors', the headers',
 * every secondary media type's, and the members of its mutually-exclusive
 * parameter groups — a query group's are the operation's own parameters,
 * settled with them; a body group's are built afresh from the body's
 * variant schemas (`extractBodyParameterGroups`), so a member written as a
 * pointer holds a pending reference of its own. A parameter, a group member
 * or an envelope field goes through `visitSite`, which aligns its own
 * limits with its settled type's too. The iterator's item type an explicit
 * `dataPath` deferred (`deferDataPathItemType`) is decided once the
 * response and the envelope fields are settled, by walking the path through
 * `models`, every model built (`settleDeferredDataPathItemType`; #608).
 */
function visitOperation(
  op: Operation,
  context: string,
  visit: (ref: TypeRef, context: string) => void,
  visitSite: (site: LimitedSite, context: string) => void,
  models: readonly Model[],
): void {
  for (const p of [
    ...op.pathParams,
    ...op.queryParams,
    ...(op.bodyOwnedQueryParams ?? []),
    ...op.headerParams,
    ...(op.cookieParams ?? []),
  ]) {
    visitSite(p, `${context}.${p.name}`);
  }
  if (op.requestBody) visit(op.requestBody, `${context}.requestBody`);
  // The iterator's item type was chosen from the response as the pending
  // reference it was — the response itself, since no reference is an array
  // — so it is chosen again from the settled response: an array's items, as
  // `detectPagination` reads any response (`paginatedItemType`). Only the
  // item type taken from the response itself is reread that way — a body
  // written as the pointer, or a list envelope unwrapped on a `data` written
  // as one, which hands the pending response over as its item type for this
  // very reread (`extractListResponse`; #609); one an override or an
  // envelope decided from an array it could type stands, and one an
  // explicit `dataPath` deferred is decided below.
  const responseWasPending = isPendingVariant(op.response);
  visit(op.response, `${context}.response`);
  if (responseWasPending && op.pagination && op.pagination.itemType === op.response) {
    op.pagination.itemType = paginatedItemType(op.response);
  }
  for (const entry of op.successResponses ?? []) visit(entry.type, `${context}.successResponses.${entry.statusCode}`);
  for (const field of op.pagination?.envelopeFields ?? []) visitSite(field, `${context}.pagination.${field.name}`);
  // An explicit `dataPath` whose walk crossed a pending reference at
  // extraction — the response itself, a companion or a field on the way —
  // left a placeholder (`deferDataPathItemType`): with the response, the
  // companions and every model's fields settled, the path is walked again
  // through the IR, so the iterator yields the model the pointed schema's
  // items are built as, never a copy read from the document (#608).
  if (op.pagination && isDeferredDataPathItemType(op.pagination.itemType)) {
    settleDeferredDataPathItemType(op.pagination, op.response, models, context);
  }
  if (op.pagination) visit(op.pagination.itemType, `${context}.pagination.itemType`);
  for (const error of op.errors) if (error.type) visit(error.type, `${context}.errors.${error.statusCode}`);
  for (const header of collectResponseHeaders(op)) visit(header.type, `${context}.headers.${header.name}`);
  for (const { type, source } of collectResponseBodyTypes(op)) visit(type, `${context}.${source}`);
  for (const { type, source } of collectRequestBodyTypes(op)) visit(type, `${context}.${source}`);
  for (const group of op.parameterGroups ?? []) {
    for (const variant of group.variants) {
      for (const p of variant.parameters)
        visitSite(p, `${context}.parameterGroups.${group.name}.${variant.name}.${p.name}`);
    }
  }
  visitCallbacks(op, context, visit, visitSite);
}

/** A webhook's or a callback's sites — its parameters, payload and secondary payloads — and its callbacks' after them. */
function visitReceived(
  node: Webhook,
  context: string,
  visit: (ref: TypeRef, context: string) => void,
  visitSite: (site: LimitedSite, context: string) => void,
): void {
  for (const p of [...node.headerParams, ...node.queryParams, ...(node.cookieParams ?? [])]) {
    visitSite(p, `${context}.${p.name}`);
  }
  if (node.requestBody) visit(node.requestBody, `${context}.requestBody`);
  for (const content of node.requestBodyContents ?? []) {
    if (content.type !== node.requestBody) visit(content.type, `${context}.requestBodyContents.${content.contentType}`);
  }
  visitCallbacks(node, context, visit, visitSite);
}

/** Each callback of an operation, webhook or callback, under `<context>.callbacks.<name>.<expression>.<method>` (#382). */
function visitCallbacks(
  node: { callbacks?: Callback[] },
  context: string,
  visit: (ref: TypeRef, context: string) => void,
  visitSite: (site: LimitedSite, context: string) => void,
): void {
  for (const callback of node.callbacks ?? []) {
    visitReceived(callback, callbackContext(context, callback), visit, visitSite);
  }
}

/** The keywords a pointer steps through with a name or index after them; every other keyword the walk reads holds one schema. */
const KEYED_STEP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'allOf',
  'oneOf',
  'anyOf',
]);

/** One step of a pointer's walk: from `node`, through `keyword` (and the `name` or index after it), to `next`. */
export interface PointerStep {
  keyword: string;
  name: string | undefined;
  node: SchemaObject;
  next: SchemaObject;
}

/**
 * The steps a pointer `path` makes from `component`, read from the document
 * alone, or the reason the parser types nothing at the end of it: the one
 * grammar the settle walks (`PointerResolver.resolve`, which then reads the
 * IR along the steps) and the primary-response pick reads ahead of the IR
 * (`pointerTypesAsUnknown`), so a pointer counts as typed exactly when the
 * settle types it. Each step goes through a keyword the IR holds a type
 * under — `properties/<name>`, `items`, `additionalProperties`,
 * `patternProperties/<pattern>`, `oneOf/<n>`, `anyOf/<n>`, `allOf/<n>` —
 * to a schema (`schemaAtPointer`); a `oneOf`/`anyOf` step to the `null`
 * variant leads to no type (the IR carries it as nullability), nor does any
 * other keyword (`not`, `prefixItems`, `$defs`, …: the parser types nothing
 * under it), nor an `additionalProperties` or `patternProperties/<p>` step
 * to a schema the map's values are not typed from (`mapValueSchema`: a
 * non-empty `additionalProperties` wins, else the first pattern, and
 * `additionalProperties: {}` types the values `unknown` on its own) or to
 * a pattern beside named properties, which no field carries, nor an
 * `allOf` step that ends the pointer at an inline member
 * the `allOf` is not read as (`readInlineAllOf`): the member declares into
 * the merged model, or only annotates the member the `allOf` is read as,
 * and has no type of its own — while an `allOf` step on the way through
 * (`allOf/1/properties/nickname`) reads on to the merged model's field.
 */
export function pointerSteps(
  component: SchemaObject,
  path: readonly string[],
  schemas: Record<string, SchemaObject> | undefined,
): PointerStep[] | { problem: string } {
  const steps: PointerStep[] = [];
  let node = component;
  for (let index = 0; index < path.length; index++) {
    const keyword = path[index]!;
    const name = KEYED_STEP_KEYWORDS.has(keyword) ? path[++index] : undefined;
    const next = schemaAtPointer(node, name === undefined ? [keyword] : [keyword, name]);
    if (!next) return { problem: 'no schema at that pointer' };
    switch (keyword) {
      case 'properties':
      case 'items':
        break;
      case 'additionalProperties':
      case 'patternProperties': {
        // The IR types a map's values from one schema; a model with named
        // properties carries a non-empty `additionalProperties` as its
        // catch-all field and no pattern at all.
        const represented = mapValueSchema(node);
        const named = Object.keys(node.properties ?? {}).length > 0;
        if (keyword === 'patternProperties' && named)
          return { problem: `a schema with named properties types no "${keyword}/${name}" values` };
        if (represented !== next && !(keyword === 'additionalProperties' && represented === null && !named))
          return {
            problem: `the values are typed from another schema than "${keyword}${name === undefined ? '' : `/${name}`}"`,
          };
        break;
      }
      case 'oneOf':
      case 'anyOf':
        if (isNullSchema(next))
          return { problem: `"${keyword}/${name}" is the null variant, which the IR carries as nullability` };
        break;
      case 'allOf':
        if (!next.$ref && index === path.length - 1 && !allOfReadAsMember(node, next, schemas))
          return { problem: `"${keyword}/${name}" is an inline allOf member, which has no type of its own` };
        break;
      default:
        return { problem: `the parser types nothing under "${keyword}"` };
    }
    steps.push({ keyword, name, node, next });
    node = next;
  }
  return steps;
}

/** Whether `schema`'s `allOf` is read as its inline `member` — the one typing member beside members that only annotate it — so the member's type is the `allOf`'s own. */
function allOfReadAsMember(
  schema: SchemaObject,
  member: SchemaObject,
  schemas: Record<string, SchemaObject> | undefined,
): boolean {
  const members = schema.allOf ?? [];
  if (readInlineAllOf(members, schema, schemas) !== 'unwrapped') return false;
  return (allOfTypingMember(members) ?? members[0]) === member;
}

/**
 * The schema a pointer `ref` lands on, read ahead of the IR from the
 * document alone — the component the `$ref` starts from, then the steps
 * the settle will walk (`pointerSteps`) — or `undefined` when the settle
 * types nothing at the end of it: a `$ref` into another section, to a
 * component the document lacks, to no schema, or to a schema the parser
 * builds no type for at that place. The one read for every reader that
 * must know what a pointer settles to before a body is typed
 * (`pointerTypesAsUnknown`, `pointerTypesAsArray`), so each counts a
 * pointer as typed exactly when the settle types it.
 *
 * A pointer that ends at a `properties/<name>` step lands on the
 * declaration the settle types that step from: the field of the model at
 * hand, which an `allOf` merges from every member that declares the name
 * (`combineDeclarations`: the first declaration that declares a type
 * types it, a typeless one only annotating it) — so the declaration is
 * read as `collectObjectProperties` merges it, from the schema whose
 * `allOf` the step goes through (`Holder` for `Holder/allOf/1/properties/
 * owners`, however many inline `allOf` steps lead there; `box` for
 * `Holder/properties/box/allOf/1/properties/owners`) or the schema the
 * step reads directly (its own `allOf` and sibling `properties` folded
 * in), never as the member's own text alone: `Holder/allOf/1/properties/
 * owners` to a member declaring `owners: { description }` beside one
 * declaring `owners: Owner[]`, or a `$ref` member to a component that
 * does, is the array the merged `Holder.owners` is (Greptile, #609
 * review: the member's text alone read no array, and the envelope's data
 * was not one here while the settle typed it `Owner[]`).
 */
function pointerLanding(ref: string, schemas: Record<string, SchemaObject> | undefined): SchemaObject | undefined {
  const tokens = schemaRefTokens(ref);
  if (!tokens) return undefined;
  const [key, ...path] = tokens;
  const component = schemas && Object.hasOwn(schemas, key!) ? schemas[key!] : undefined;
  if (!component) return undefined;
  const steps = pointerSteps(component, path, schemas);
  if ('problem' in steps) return undefined;
  if (steps.length === 0) return component;
  const last = steps[steps.length - 1]!;
  if (last.keyword !== 'properties') return last.next;
  // The schema whose merge the field belongs to: the one before the run of
  // inline `allOf` steps the `properties` step sits in, else the step's own.
  let first = steps.length - 1;
  while (first > 0 && steps[first - 1]!.keyword === 'allOf') first--;
  const owner = steps[first]!.node;
  return collectObjectProperties(owner, schemas).properties[last.name!] ?? last.next;
}

/** The pointers being read ahead of the IR (`pointerTypesAsUnknown`), so a chain that reaches itself ends. */
const pointersBeingRead = new Set<string>();

/**
 * Whether a site written as `ref`, a schema `$ref` that names no component,
 * settles to the bare `unknown` — decided from the document before any
 * model is built, for the reader that must know before a body is typed
 * (`referenceTypesAsUnknown`, choosing the primary response: a `200` body
 * pointing at an untyped schema loses to a typed `201`, as the same schema
 * written inline would). True when the pointer leads nowhere (into another
 * section, to a component the document lacks, to no schema) or to a schema
 * the parser builds no type for at that place (`pointerLanding`), and
 * otherwise exactly when the schema it lands on is typed `unknown` where
 * it stands, read as a body written there is (`referenceTypesAsUnknown`:
 * `{}`, a `$ref` to an untyped primitive component, an `allOf` read as
 * one) — a `properties/<name>` step landing on the declaration the merged
 * model's field is typed from, every `allOf` member's combined
 * (`pointerLanding`), so a member's `{ description }` beside a typed
 * declaration is typed. A chain of pointers that reaches itself is read as
 * the settle reads it, `unknown`.
 */
export function pointerTypesAsUnknown(ref: string, schemas: Record<string, SchemaObject> | undefined): boolean {
  if (pointersBeingRead.has(ref)) return true;
  const landed = pointerLanding(ref, schemas);
  if (!landed) return true;
  pointersBeingRead.add(ref);
  try {
    return referenceTypesAsUnknown(landed);
  } finally {
    pointersBeingRead.delete(ref);
  }
}

/** The pointers being read for the array they settle to (`pointerTypesAsArray`), so a chain that reaches itself ends. */
const pointersBeingTyped = new Set<string>();

/**
 * Whether a site written as `ref`, a schema `$ref` that names no component,
 * settles to an array (#609) — decided from the document before any model
 * is built, for the reader that asks whether a property is an array before
 * a body is typed (`isArrayPointerRef`, for `detectListEnvelope`: a list
 * envelope's `data` written as `{ $ref: '#/components/schemas/Holder/
 * properties/owners' }` is the array `Holder.owners` is, so the envelope is
 * unwrapped on it as it is on `{ $ref: Owners }`). True exactly when the
 * pointer lands on a schema (`pointerLanding`) typed as an array where it
 * stands, read as a property written there is read: an array in any
 * spelling, under any nullable wrapper or `allOf` read as its member
 * (`arraySchemaOf`), a `$ref` to an array component under the same
 * (`isArrayComponentRef`), or another such pointer in turn
 * (`isArrayPointerRef`). False when the pointer leads nowhere or to a
 * schema the parser builds no type for at that place — the settle reports
 * it and types the site `unknown`, no array — and for a chain of pointers
 * that reaches itself, which the settle types `unknown` too. What the
 * document alone cannot refuse is left to the settle, as
 * `pointerTypesAsUnknown` leaves it: a `properties` step through a
 * component typed as a primitive or an enum reads on to the array here,
 * and the settle reports the site and types it `unknown`.
 */
export function pointerTypesAsArray(ref: string, schemas: Record<string, SchemaObject> | undefined): boolean {
  if (pointersBeingTyped.has(ref)) return false;
  const landed = pointerLanding(ref, schemas);
  if (!landed) return false;
  pointersBeingTyped.add(ref);
  try {
    return arraySchemaOf(landed) !== undefined || isArrayComponentRef(landed) || isArrayPointerRef(landed, schemas);
  } finally {
    pointersBeingTyped.delete(ref);
  }
}

/** The walk one document's pending references are settled by; `settled` collects them. */
class PointerResolver {
  readonly settled: TypeRef[] = [];
  /** `settled`, by identity, so a site can tell whether its type was one. */
  private readonly settledRefs = new Set<TypeRef>();
  private readonly modelsByName = new Map<string, Model>();

  constructor(
    models: readonly Model[],
    private readonly schemas: Record<string, SchemaObject> | undefined,
  ) {
    for (const model of models) if (!this.modelsByName.has(model.name)) this.modelsByName.set(model.name, model);
  }

  /**
   * Write the type `pending` names into it. `stack` holds the `$ref`s being
   * settled on the way here, so a pointer that leads back to one still
   * being settled — through a field whose type is that site, a chain of
   * pointers, or an array component whose items point back into it — is a
   * cycle, reported and typed `unknown`. The `$ref`s, not the references:
   * an array component's items are built afresh at every read
   * (`componentTypeRef`), so the reference met on the way back is never
   * the one the walk started from, while its `$ref` is. `outcome` is what
   * a warning says becomes of the site when the pointer names no type:
   * typed `unknown`, which the reference is settled to, unless the site
   * reads the reference for a name alone — a mapping entry, left as
   * written.
   */
  settle(pending: ModelRef, context: string, stack: Set<string>, outcome = 'typing the site as unknown'): void {
    if (!isPendingSchemaRef(pending)) return;
    const ref = pending.name;
    let type: TypeRef | undefined;
    if (stack.has(ref)) {
      console.warn(`[oagen] Warning: Circular schema $ref chain starting at "${ref}" in ${context} — ${outcome}`);
    } else {
      stack.add(ref);
      type = this.resolve(ref, context, stack, outcome);
      stack.delete(ref);
    }
    settlePendingSchemaRef(pending);
    const site = pendingSiteLimitsOf(pending);
    replaceTypeRef(pending, type ?? UNKNOWN);
    // The settled type carries the pointed schema's limits — what the type
    // reached carries, under every nullable wrapper it settled into
    // (`underNullableWrappers`) — conjoined with the site's own, as a `$ref`
    // to a primitive component carries the component's conjoined with the
    // site's (see the module comment); a model or enum carries none, and
    // keeps the site's reading off the type. `pending` is the settled type
    // now: `replaceTypeRef` rewrote it in place.
    const settled = pending as TypeRef;
    const bare = underNullableWrappers(settled);
    withTypeConstraints(settled, combineConstraints(typeRefConstraints(bare), site));
    this.settled.push(pending);
    this.settledRefs.add(pending);
  }

  /**
   * Give `site` — a field or parameter — the limits its type carries, when
   * that type is a reference this pass settled into one that can carry
   * them: the pointed schema's conjoined with the site's own (`settle`), so
   * the field or parameter and its type stay one reading, as they are for
   * a `$ref` to a primitive component (`Field.constraints`; #545 review).
   * A site whose pointer landed on a model or enum keeps what it wrote
   * beside the `$ref`: that node carries its own. The settled reference is
   * the site's type itself, or the inner type of a nullable wrapper the
   * site wrote around the pointer (`oneOf: [{ $ref }, { type: 'null' }]`),
   * and is looked up before it is unwrapped: a pointer to a schema that
   * admits null (`{ type: ['string', 'null'], maxLength: 8 }`) settles into
   * a nullable wrapper itself, whose inner type carries the limits
   * (Greptile, #545 review round 2: the wrapper was unwrapped first, so
   * such a field kept none of its own) — into more than one through a
   * chain whose link is itself a nullable wrapper, so every wrapper is read
   * through (`underNullableWrappers`; review round 4).
   */
  alignSiteLimits(site: LimitedSite): void {
    const settled = this.settledRefs.has(site.type)
      ? site.type
      : site.type.kind === 'nullable' && this.settledRefs.has(site.type.inner)
        ? site.type.inner
        : undefined;
    if (!settled) return;
    const bare = underNullableWrappers(settled);
    if (bare.kind === 'model' || bare.kind === 'enum') return;
    const limits = typeRefConstraints(bare);
    if (limits) site.constraints = { ...limits };
    else delete site.constraints;
  }

  /** The type `ref` names, or `undefined` after one warning saying why it names none and what becomes of the site (`outcome`, as `settle` takes it). */
  private resolve(ref: string, context: string, stack: Set<string>, outcome: string): TypeRef | undefined {
    const fail = (reason: string): undefined => {
      console.warn(`[oagen] Warning: Unresolved schema $ref "${ref}" in ${context}: ${reason} — ${outcome}`);
      return undefined;
    };
    const tokens = schemaRefTokens(ref);
    if (!tokens) return fail('only a $ref into components/schemas is followed');
    const [key, ...path] = tokens;
    const component = this.schemas && Object.hasOwn(this.schemas, key!) ? this.schemas[key!] : undefined;
    if (!component) return fail(`no component schema "${key}"`);
    const steps = pointerSteps(component, path, this.schemas);
    if ('problem' in steps) return fail(steps.problem);

    // The reference being settled: a type reached on the way that is itself
    // pending is settled first, in place, so the walk reads what it names.
    const settled = (type: TypeRef): TypeRef => {
      if (type.kind === 'model') this.settle(type, context, stack);
      return type;
    };
    /** `type` under any nullable wrapper, each level settled. */
    const bareOf = (type: TypeRef): TypeRef => {
      const own = settled(type);
      return own.kind === 'nullable' ? settled(own.inner) : own;
    };
    const describe = (type: TypeRef): string =>
      type.kind === 'model' || type.kind === 'enum' ? `${type.kind} "${type.name}"` : type.kind;
    /**
     * The member of a multi-type schema's union that carries `keyword`: a
     * `type: ['object', 'string']` schema is typed as a union of one member
     * per type (`schemaToTypeRef`), so its `properties/<name>` are the
     * object member's fields, its `items` the array member's, its
     * `additionalProperties` the map member's values — or the object
     * member's catch-all field, beside named properties. Any other type,
     * and a union of some other making, is itself.
     */
    const memberCarrying = (bare: TypeRef, node: SchemaObject, keyword: string): TypeRef => {
      if (bare.kind !== 'union' || !Array.isArray(node.type)) return bare;
      const kinds = keyword === 'properties' ? ['model'] : keyword === 'items' ? ['array'] : ['map', 'model'];
      for (const kind of kinds) {
        const members = bare.variants.map(bareOf).filter((member) => member.kind === kind);
        if (members.length === 1) return members[0]!;
      }
      return bare;
    };

    let type: TypeRef = componentTypeRef(key!);
    for (const { keyword, name, node, next } of steps) {
      const bare = memberCarrying(bareOf(type), node, keyword);
      switch (keyword) {
        case 'properties': {
          const model = bare.kind === 'model' ? this.modelsByName.get(bare.name) : undefined;
          if (!model) return fail(`${describe(bare)} has no fields to read "${name}" from`);
          const field = model.fields.find((candidate) => candidate.name === name);
          if (!field) return fail(`model "${model.name}" declares no field "${name}"`);
          type = field.type;
          break;
        }
        case 'items':
          if (bare.kind !== 'array') return fail(`${describe(bare)} is no array to read "items" from`);
          type = bare.items;
          break;
        case 'additionalProperties':
        case 'patternProperties': {
          if (bare.kind === 'map') {
            type = bare.valueType;
            break;
          }
          // A model with named properties carries its `additionalProperties`
          // as a catch-all map field (`extractModel`), the last of its fields
          // so named; its values are that field's. `pointerSteps` admits no
          // pattern beside named properties.
          const model = bare.kind === 'model' ? this.modelsByName.get(bare.name) : undefined;
          const catchAll = keyword === 'additionalProperties' ? catchAllField(model) : undefined;
          if (!catchAll) return fail(`${describe(bare)} is no map to read "${keyword}" from`);
          type = catchAll.valueType;
          break;
        }
        case 'oneOf':
        case 'anyOf': {
          // The IR carries a union's non-null variants only: the `null`
          // variant is its nullability (`pointerSteps` stops at it), and a
          // union of one member beside it is collapsed to a nullable wrapper
          // (`nullableUnionBranch`), so that member is the wrapper's inner
          // type whatever it is — a union of its own (`type: ['array',
          // 'string']`), a named union — read before any variants are
          // indexed, which would take the member's own first variant for it.
          const members = node[keyword] ?? [];
          const nonNull = members.filter((member) => !isNullSchema(member));
          if (nonNull.length === 1 && members.length > nonNull.length) {
            type = bare;
            break;
          }
          const variant = nonNull.indexOf(next);
          const variants =
            bare.kind === 'union'
              ? bare.variants
              : bare.kind === 'model'
                ? this.modelsByName.get(bare.name)?.variants
                : undefined;
          if (variants) {
            if (variants[variant] === undefined)
              return fail(`${describe(bare)} carries no variant "${keyword}/${name}"`);
            type = variants[variant];
          } else if (nonNull.length === 1) {
            type = bare;
          } else {
            return fail(`${describe(bare)} is no union to read "${keyword}/${name}" from`);
          }
          break;
        }
        case 'allOf':
          // A `$ref` member is typed as the reference it is; an inline member
          // is the merged model's, or the `allOf`'s own when it is read as
          // that member — `pointerSteps` has ruled out a pointer that ends
          // at any other inline member — so the type at hand stays.
          if (next.$ref) type = schemaToTypeRef(next);
          break;
        default:
          return fail(`the parser types nothing under "${keyword}"`);
      }
    }
    // Whatever the type reached holds that is still pending is settled
    // before the copy is made, so the site never carries a pending copy.
    walkTypeRef(settled(type), { model: (reference) => this.settle(reference, context, stack) });
    return type;
  }
}
