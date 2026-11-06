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
 * `patternProperties/<pattern>` to the map's values, `oneOf/<n>` or
 * `anyOf/<n>` to the union's or the named union's n-th non-null variant,
 * and `allOf/<n>` to the member's own type for a `$ref` member and the
 * merged model's for an inline one — and writes the type it reaches into
 * the pending reference in place (`replaceTypeRef`), so every holder keeps
 * the object it holds. A pointer that leads nowhere is reported once, at
 * the site, and the site typed `unknown`: one into another section, to a
 * component the document lacks, to no schema (`Pet/properties/id/type`,
 * `Pet/enum/0`), or to a schema the parser builds no type for at that place
 * (a `null` variant, an enum's own members, a keyword it never reads, the
 * fields of an enum or primitive component), and a chain of pointers that
 * reaches itself. Pointers are followed as RFC 6901 §4 evaluates them,
 * structurally, never through a `$ref` on the way (`schemaAtPointer`); a
 * pointer that lands on a `$ref` schema is typed as that `$ref` is.
 *
 * The limits are settled with the type (#545 review). A `$ref` to a
 * primitive or array component gives the site the component's limits
 * conjoined with what is written beside the reference (`schemaConstraints`),
 * and a pointer site reads the same once its type is known: the type the
 * site is settled into carries the limits of the schema the pointer lands
 * on — what its own type carries where it stands, under any nullable
 * wrapper, the conjoined reading of a chain included — conjoined with the
 * site's own (`combineConstraints`, the component's first, the stricter
 * bound winning), and a field or parameter whose type that is carries the
 * same (`Field.constraints`, `Parameter.constraints`), so `{ $ref:
 * '#/components/schemas/Owner/properties/code', maxLength: 3 }` to `{
 * type: 'string', pattern: '^own_', maxLength: 8 }` is `{ maxLength: 3,
 * pattern: '^own_' }` on the field, the parameter and the type alike, and a
 * bare pointer `{ maxLength: 8, pattern: '^own_' }`. A pointer that lands on
 * a schema typed as a model or enum adds none: that node carries its own,
 * and the site keeps what it wrote beside the `$ref`, as beside a `$ref` to
 * a model component.
 */
import type { Constraints, Model, ModelRef, Operation, Service, TypeRef, Webhook } from '../ir/types.js';
import {
  collectRequestBodyTypes,
  collectResponseBodyTypes,
  collectResponseHeaders,
  typeRefConstraints,
  walkTypeRef,
} from '../ir/types.js';
import {
  combineConstraints,
  componentTypeRef,
  isNullSchema,
  schemaToTypeRef,
  withTypeConstraints,
  type SchemaObject,
} from './schemas.js';
import { replaceTypeRef } from './inline-models.js';
import {
  isPendingSchemaRef,
  pendingSiteLimitsOf,
  schemaAtPointer,
  schemaRefTokens,
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
 * Settle every pending reference among `sites` against the document's
 * `schemas` (see the module comment), in place. Returns the references
 * settled, so the caller can give each to the site of the model it now
 * names (`attachSharedRefs`): a merge pass that renames that model then
 * repoints the reference with the model's own.
 */
export function resolveSchemaPointers(
  sites: SchemaPointerSites,
  schemas: Record<string, SchemaObject> | undefined,
): TypeRef[] {
  const resolver = new PointerResolver(sites.models, schemas);
  const visit = (ref: TypeRef, context: string): void => {
    walkTypeRef(ref, {
      model: (reference) => {
        if (isPendingSchemaRef(reference)) resolver.settle(reference, context, new Set());
      },
    });
  };
  /** A field's or parameter's type settled, then its own limits aligned with the type's (`alignSiteLimits`). */
  const visitSite = (site: LimitedSite, context: string): void => {
    visit(site.type, context);
    resolver.alignSiteLimits(site);
  };

  for (const model of sites.models) {
    for (const field of model.fields) visitSite(field, `${model.name}.${field.name}`);
    for (const variant of model.variants ?? []) visit(variant, `${model.name}.variants`);
  }
  for (const service of sites.services) {
    for (const op of service.operations) visitOperation(op, `${service.name}.${op.name}`, visit, visitSite);
  }
  for (const webhook of sites.webhooks) {
    const context = `webhooks.${webhook.name}.${webhook.httpMethod}`;
    for (const p of [...webhook.headerParams, ...webhook.queryParams, ...(webhook.cookieParams ?? [])]) {
      visitSite(p, `${context}.${p.name}`);
    }
    if (webhook.requestBody) visit(webhook.requestBody, `${context}.requestBody`);
    for (const content of webhook.requestBodyContents ?? []) {
      if (content.type !== webhook.requestBody)
        visit(content.type, `${context}.requestBodyContents.${content.contentType}`);
    }
  }
  return resolver.settled;
}

/** Every type an operation holds, as `validateModelRefs` reads them; a parameter or envelope field through `visitSite`, which aligns its own limits too. */
function visitOperation(
  op: Operation,
  context: string,
  visit: (ref: TypeRef, context: string) => void,
  visitSite: (site: LimitedSite, context: string) => void,
): void {
  for (const p of [...op.pathParams, ...op.queryParams, ...(op.bodyOwnedQueryParams ?? []), ...op.headerParams]) {
    visitSite(p, `${context}.${p.name}`);
  }
  if (op.requestBody) visit(op.requestBody, `${context}.requestBody`);
  visit(op.response, `${context}.response`);
  if (op.pagination) visit(op.pagination.itemType, `${context}.pagination.itemType`);
  for (const field of op.pagination?.envelopeFields ?? []) visitSite(field, `${context}.pagination.${field.name}`);
  for (const error of op.errors) if (error.type) visit(error.type, `${context}.errors.${error.statusCode}`);
  for (const header of collectResponseHeaders(op)) visit(header.type, `${context}.headers.${header.name}`);
  for (const { type, source } of collectResponseBodyTypes(op)) visit(type, `${context}.${source}`);
  for (const { type, source } of collectRequestBodyTypes(op)) visit(type, `${context}.${source}`);
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
   * Write the type `pending` names into it. `stack` holds the references
   * being settled on the way here, so a pointer that leads back to a site
   * still being settled — through a field whose type is that site, or a
   * chain of pointers — is a cycle, reported and typed `unknown`.
   */
  settle(pending: ModelRef, context: string, stack: Set<ModelRef>): void {
    if (!isPendingSchemaRef(pending)) return;
    const ref = pending.name;
    let type: TypeRef | undefined;
    if (stack.has(pending)) {
      console.warn(
        `[oagen] Warning: Circular schema $ref chain starting at "${ref}" in ${context} — typing the site as unknown`,
      );
    } else {
      stack.add(pending);
      type = this.resolve(ref, context, stack);
      stack.delete(pending);
    }
    settlePendingSchemaRef(pending);
    const site = pendingSiteLimitsOf(pending);
    replaceTypeRef(pending, type ?? UNKNOWN);
    // The settled type carries the pointed schema's limits — what the type
    // reached carries, under its nullable wrapper — conjoined with the
    // site's own, as a `$ref` to a primitive component carries the
    // component's conjoined with the site's (see the module comment); a
    // model or enum carries none, and keeps the site's reading off the type.
    // `pending` is the settled type now: `replaceTypeRef` rewrote it in place.
    const settled = pending as TypeRef;
    const bare = settled.kind === 'nullable' ? settled.inner : settled;
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
   * such a field kept none of its own).
   */
  alignSiteLimits(site: LimitedSite): void {
    const settled = this.settledRefs.has(site.type)
      ? site.type
      : site.type.kind === 'nullable' && this.settledRefs.has(site.type.inner)
        ? site.type.inner
        : undefined;
    if (!settled) return;
    const bare = settled.kind === 'nullable' ? settled.inner : settled;
    if (bare.kind === 'model' || bare.kind === 'enum') return;
    const limits = typeRefConstraints(bare);
    if (limits) site.constraints = { ...limits };
    else delete site.constraints;
  }

  /** The type `ref` names, or `undefined` after one warning saying why it names none. */
  private resolve(ref: string, context: string, stack: Set<ModelRef>): TypeRef | undefined {
    const fail = (reason: string): undefined => {
      console.warn(
        `[oagen] Warning: Unresolved schema $ref "${ref}" in ${context}: ${reason} — typing the site as unknown`,
      );
      return undefined;
    };
    const tokens = schemaRefTokens(ref);
    if (!tokens) return fail('only a $ref into components/schemas is followed');
    const [key, ...path] = tokens;
    const component = this.schemas && Object.hasOwn(this.schemas, key) ? this.schemas[key] : undefined;
    if (!component) return fail(`no component schema "${key}"`);
    if (schemaAtPointer(component, path) === undefined) return fail('no schema at that pointer');

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

    let node: SchemaObject = component;
    let type: TypeRef = componentTypeRef(key);
    for (let index = 0; index < path.length; index++) {
      const keyword = path[index];
      const step = ['properties', 'patternProperties', 'allOf', 'oneOf', 'anyOf'].includes(keyword)
        ? [keyword, path[++index]]
        : [keyword];
      const next = schemaAtPointer(node, step);
      if (!next) return fail('no schema at that pointer');
      const bare = bareOf(type);
      switch (keyword) {
        case 'properties': {
          const name = step[1];
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
        case 'patternProperties':
          if (bare.kind !== 'map') return fail(`${describe(bare)} is no map to read "${keyword}" from`);
          type = bare.valueType;
          break;
        case 'oneOf':
        case 'anyOf': {
          // The IR carries a union's non-null variants only: the `null`
          // variant is its nullability, and a union of one variant beside
          // it is read as that variant.
          const members = node[keyword] ?? [];
          const position = Number(step[1]);
          if (isNullSchema(next))
            return fail(`"${keyword}/${step[1]}" is the null variant, which the IR carries as nullability`);
          const nonNull = members.filter((member) => !isNullSchema(member));
          const variant = nonNull.indexOf(next);
          const variants =
            bare.kind === 'union'
              ? bare.variants
              : bare.kind === 'model'
                ? this.modelsByName.get(bare.name)?.variants
                : undefined;
          if (variants) {
            if (variants[variant] === undefined)
              return fail(`${describe(bare)} carries no variant "${keyword}/${position}"`);
            type = variants[variant];
          } else if (nonNull.length === 1) {
            type = bare;
          } else {
            return fail(`${describe(bare)} is no union to read "${keyword}/${position}" from`);
          }
          break;
        }
        case 'allOf':
          // A `$ref` member is typed as the reference it is; an inline member
          // declares into the merged model, whose type stays at hand.
          if (next.$ref) type = schemaToTypeRef(next);
          break;
        default:
          return fail(`the parser types nothing under "${keyword}"`);
      }
      node = next;
    }
    // Whatever the type reached holds that is still pending is settled
    // before the copy is made, so the site never carries a pending copy.
    walkTypeRef(settled(type), { model: (reference) => this.settle(reference, context, stack) });
    return type;
  }
}
