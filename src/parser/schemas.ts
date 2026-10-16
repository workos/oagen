import type { Model, Enum, EnumValue, Field, TypeRef } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import {
  toPascalCase,
  toUpperSnakeCase,
  cleanSchemaName,
  singularize,
  stripListItemMarkers,
  splitWords,
} from '../utils/naming.js';

/**
 * Module-level transform set during extractSchemas(). Used by schemaToTypeRef()
 * to apply the same name transform to $ref model/enum references.
 *
 * Receives the cleaned PascalCase name and, when the name is a
 * `components.schemas` key, the raw key exactly as spelled in the document.
 * Names oagen synthesises (inline enums, request-body variant models,
 * title-derived names) pass no second argument.
 */
let activeSchemaNameTransform: SchemaNameTransform | null = null;

/**
 * Module-level set of raw `components.schemas` keys for the spec being
 * extracted. resolveSchemaName() consults it to decide whether the name it was
 * handed is a real component key (forwarded to the transform as
 * `originalName`) or a name oagen synthesised (no `originalName`).
 */
let activeComponentSchemaKeys: Set<string> = new Set();

/**
 * Module-level set of resolved schema names whose components/schemas entry is
 * an enum (i.e. has `enum:`). Populated by extractSchemas() so schemaToTypeRef()
 * can classify a `$ref` to a top-level enum schema as `kind: 'enum'` instead of
 * `kind: 'model'`. Without this, every `$ref` was naively returned as a model
 * ref, even when the target was a shared enum like `PaginationOrder`.
 */
let activeEnumSchemaNames: Set<string> = new Set();

/**
 * Subset of `activeEnumSchemaNames` whose component schema also admits
 * `null` — via an OAS 3.1 `type: [..., 'null']` array, the OAS 3.0
 * `nullable: true` flag, or a literal `null` member in `enum:`. A `$ref` to
 * one of these resolves to `nullable(enum)` so the component's own
 * nullability survives the reference, matching the shape an inline
 * `oneOf: [{ $ref }, { type: 'null' }]` already produces.
 */
let activeNullableEnumSchemaNames: Set<string> = new Set();

/** Drop `null` from an `enum:` list — it marks nullability, it is not a member. */
function nonNullEnumValues(values: SchemaObject['enum']): (string | number)[] {
  return (values ?? []).filter((v): v is string | number => v !== null);
}

/** True when an enum schema admits `null` by any OAS 3.0 / 3.1 spelling. */
function isNullableEnumSchema(schema: SchemaObject): boolean {
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  return Array.isArray(schema.enum) && schema.enum.includes(null);
}

/** Wrap `ref` in `nullable` unless it already is one, so a nullable enum `$ref` is never double-wrapped. */
function asNullable(ref: TypeRef): TypeRef {
  return ref.kind === 'nullable' ? ref : { kind: 'nullable', inner: ref };
}

/**
 * Apply cleanSchemaName + the active transform (if any) to a raw schema name.
 * When `rawName` is a `components.schemas` key the transform also receives it
 * as `originalName`, so a consumer can opt out of normalization by returning
 * the original spelling. Names oagen synthesises (request-body variant
 * models, title-derived names, ...) are not component keys and get no
 * `originalName`.
 */
export function resolveSchemaName(rawName: string): string {
  let name = cleanSchemaName(toPascalCase(rawName));
  if (activeSchemaNameTransform) {
    const originalName = activeComponentSchemaKeys.has(rawName) ? rawName : undefined;
    name = activeSchemaNameTransform(name, originalName);
  }
  return name;
}

/**
 * Signature of the `schemaNameTransform` hook. `name` is the cleaned
 * PascalCase name; `originalName` is the `components.schemas` key exactly
 * as spelled in the document, or `undefined` for names oagen synthesises.
 * See `SchemaExtractionOptions.schemaNameTransform`.
 */
export type SchemaNameTransform = (name: string, originalName?: string) => string;

export interface SchemaExtractionOptions {
  /**
   * Custom transform for schema (model/enum) names. Called with the cleaned
   * PascalCase name and, for component schemas, the original name as spelled
   * in the document (`originalName`). Returning `originalName` opts that
   * schema out of the built-in normalization; only do so when it is a valid
   * identifier, since keys like `user-profile` are otherwise fixed by
   * cleanSchemaName. `originalName` is undefined for
   * any name oagen synthesises (inline enums, request-body variant models,
   * title-derived names).
   */
  schemaNameTransform?: SchemaNameTransform;
}

export interface SchemaObject {
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject | undefined>;
  required?: string[];
  items?: SchemaObject;
  /** OAS 3.1 allows a literal `null` member when `type` also admits null. */
  enum?: (string | number | null)[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  readOnly?: boolean;
  writeOnly?: boolean;
  nullable?: boolean;
  $ref?: string;
  additionalProperties?: boolean | SchemaObject;
  const?: unknown;
  patternProperties?: Record<string, SchemaObject>;
  deprecated?: boolean;
  default?: unknown;
  example?: unknown;
  /** JSON Schema `examples` list; OAS 3.1 deprecates `example` in its favour. */
  examples?: unknown[];
  [key: string]: unknown;
}

/**
 * Narrow a raw `examples` value to a non-empty list, or undefined. Guards
 * against documents that put an OAS Example Object map (or anything else)
 * where JSON Schema expects an array, and against an empty list, so the IR
 * carries `examples` only when there is at least one value.
 */
export function nonEmptyExamples(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

/**
 * Pick the single `example` the IR carries: the document's own `example`
 * when it is set (including an explicit `null`), otherwise the first entry
 * of the resolved `examples` list.
 */
export function pickExample(example: unknown, examples: unknown[] | undefined): unknown {
  return example !== undefined ? example : examples?.[0];
}

/** One source of example values, e.g. a parameter's own declaration or its schema. */
export interface ExampleSource {
  example: unknown;
  examples: unknown[] | undefined;
}

/**
 * Resolve `example` and `examples` across ordered precedence levels: for a
 * parameter its own declaration, its inline schema, then the component its
 * `$ref` points at; for a field its own schema, then its `$ref` target.
 *
 * Each value walks the levels independently. `examples` is the first
 * non-empty list. `example` comes from the first level that has either an
 * `example` or a list, preferring that level's own `example` over its first
 * list entry — so a schema-level `example` can never mask the parameter's
 * own `examples` map. A level with neither falls through; an explicit
 * `null` is a value and stops the walk.
 */
export function resolveExamples(levels: ExampleSource[]): ExampleSource {
  let example: unknown;
  let examples: unknown[] | undefined;
  for (const level of levels) {
    if (examples === undefined) examples = level.examples;
    if (example === undefined) example = pickExample(level.example, level.examples);
  }
  return { example, examples };
}

/**
 * If a schema is a `$ref` to `#/components/schemas/X`, return the referenced
 * component schema. Used to surface schema-level metadata (default, example,
 * examples, deprecated, description) that would otherwise be invisible at the
 * field or parameter level.
 *
 * Refs are not pre-resolved by the bundler (`dereference: false` in refs.ts),
 * so without this, a param like `schema: { $ref: '.../PaginationOrder' }`
 * silently loses the target's `default: desc` and the SDK stops emitting the
 * spec-mandated default value in generated method signatures.
 */
export function resolveComponentSchemaRef(
  schema: SchemaObject | undefined,
  componentSchemas: Record<string, SchemaObject> | undefined,
): SchemaObject | undefined {
  if (!schema || !componentSchemas) return undefined;
  const ref = (schema as { $ref?: string }).$ref;
  if (!ref) return undefined;
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) return undefined;
  return componentSchemas[match[1]];
}

export interface ExtractedSchemas {
  models: Model[];
  enums: Enum[];
}

export function extractSchemas(
  schemas: Record<string, SchemaObject> | undefined,
  options?: SchemaExtractionOptions,
): ExtractedSchemas {
  const enums: Enum[] = [];

  if (!schemas) return { models: [], enums };

  // Record the raw component keys first so every resolveSchemaName() call
  // below (including the collision probe) can tell a real component key from
  // a name oagen synthesised.
  activeComponentSchemaKeys = new Set(Object.keys(schemas));

  // Build collision-safe transform if provided. The transform is probed with
  // the same (cleaned, raw) pair resolveSchemaName() will hand it, so a
  // transform that keys off the original spelling is collision-checked on the
  // names it will actually produce. Collisions are tracked by raw key: two raw
  // keys may clean to the same name yet transform to different ones (e.g.
  // `Users`/`User` with an originalName-based transform), and marking the
  // shared cleaned name unsafe would wrongly disable the transform for both.
  if (options?.schemaNameTransform) {
    const transform = options.schemaNameTransform;
    const transformedToRawKeys = new Map<string, string[]>();
    for (const raw of Object.keys(schemas)) {
      const transformed = transform(cleanSchemaName(toPascalCase(raw)), raw);
      if (!transformedToRawKeys.has(transformed)) transformedToRawKeys.set(transformed, []);
      transformedToRawKeys.get(transformed)!.push(raw);
    }
    // Raw keys whose transformed output is shared with another raw key, plus
    // their cleaned names. Component keys are guarded by raw key; synthesised
    // names (no originalName) keep the cleaned-name guard they always had.
    const unsafeRawKeys = new Set<string>();
    const unsafeCleanedNames = new Set<string>();
    for (const [, rawKeys] of transformedToRawKeys) {
      if (rawKeys.length > 1) {
        for (const raw of rawKeys) {
          unsafeRawKeys.add(raw);
          unsafeCleanedNames.add(cleanSchemaName(toPascalCase(raw)));
        }
      }
    }
    activeSchemaNameTransform = (name: string, originalName?: string) => {
      const unsafe = originalName !== undefined ? unsafeRawKeys.has(originalName) : unsafeCleanedNames.has(name);
      return unsafe ? name : transform(name, originalName);
    };
  } else {
    activeSchemaNameTransform = null;
  }

  // Pre-compute the set of resolved names whose component schema is an enum so
  // schemaToTypeRef() can classify `$ref` targets correctly. Built in a separate
  // pass because the per-schema loop mutates models/enums and we want this map
  // available before any TypeRef is resolved (operations + nested fields both
  // call schemaToTypeRef during extraction).
  activeEnumSchemaNames = new Set();
  activeNullableEnumSchemaNames = new Set();
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema.enum) continue;
    const resolved = resolveSchemaName(name);
    activeEnumSchemaNames.add(resolved);
    if (isNullableEnumSchema(schema)) activeNullableEnumSchemaNames.add(resolved);
  }

  const modelsByCleanName = new Map<string, Model>();

  for (const [name, schema] of Object.entries(schemas)) {
    const pascalName = resolveSchemaName(name);

    if (schema.enum) {
      enums.push(extractEnum(pascalName, schema));
    } else {
      const model = extractModel(pascalName, schema, schemas);
      const existing = modelsByCleanName.get(pascalName);
      if (existing) {
        // Keep the model with more fields when names collide after cleaning
        if (model.fields.length > existing.fields.length) {
          modelsByCleanName.set(pascalName, model);
        }
      } else {
        modelsByCleanName.set(pascalName, model);
      }

      for (const inlineModel of extractDiscriminatedAllOfVariantModels(schema, pascalName, schemas)) {
        const existingInline = modelsByCleanName.get(inlineModel.name);
        if (existingInline) {
          if (inlineModel.fields.length > existingInline.fields.length) {
            modelsByCleanName.set(inlineModel.name, inlineModel);
          }
        } else {
          modelsByCleanName.set(inlineModel.name, inlineModel);
        }
      }
    }
  }

  const models = [...modelsByCleanName.values()];

  // Collect inline models from nested object/oneOf properties
  // that schemaToTypeRef created model refs for but weren't extracted
  const modelNames = new Set(models.map((m) => m.name));
  const inlineQueue: Model[] = [...models];
  while (inlineQueue.length > 0) {
    const model = inlineQueue.pop()!;
    for (const field of model.fields) {
      collectNestedInlineModels(field.type, field.name, model.name, schemas ?? {}, models, modelNames, inlineQueue);
    }
  }

  // Collect inline enums from model fields
  for (const model of models) {
    collectInlineEnums(model.fields, enums);
  }

  // NOTE: activeSchemaNameTransform is intentionally NOT cleared here.
  // extractOperations() calls schemaToTypeRef() for $ref resolution and
  // needs the same transform active. parseSpec() calls clearSchemaNameTransform()
  // after all extraction is complete.
  return { models, enums };
}

/** Clear the module-level schemaNameTransform. Called by parseSpec() after all extraction phases. */
export function clearSchemaNameTransform(): void {
  activeSchemaNameTransform = null;
  activeEnumSchemaNames = new Set();
  activeNullableEnumSchemaNames = new Set();
  activeComponentSchemaKeys = new Set();
}

/**
 * Walk a single TypeRef and extract inline enum refs as top-level enum definitions.
 * Shared by both schemas.ts (field-level) and parse.ts (model-level) collection passes.
 */
export function collectInlineEnumFromRef(ref: TypeRef, enums: Enum[], seen: Set<string>): void {
  walkTypeRef(ref, {
    enum: (r) => {
      if (r.values && !seen.has(r.name)) {
        seen.add(r.name);
        enums.push({
          name: r.name,
          values: r.values.map((v) => ({
            name: toUpperSnakeCase(String(v)),
            value: v,
            description: undefined,
          })),
        });
      }
    },
  });
}

/**
 * Walk model fields and extract inline enum refs as top-level enum definitions.
 * This ensures type alias files are generated for inline enums.
 */
function collectInlineEnums(fields: Field[], enums: Enum[]): void {
  const seen = new Set(enums.map((e) => e.name));
  for (const field of fields) {
    collectInlineEnumFromRef(field.type, enums, seen);
  }
}

/**
 * Walk a TypeRef tree and extract inline models for any model refs that point
 * to schemas with inline object properties (not in components/schemas).
 * This handles nested objects like `totp: { oneOf: [{ type: object, properties: {...} }] }`
 * that schemaToTypeRef turns into model refs but aren't extracted from components.
 */
function collectNestedInlineModels(
  ref: TypeRef,
  fieldName: string,
  parentModelName: string,
  schemas: Record<string, SchemaObject>,
  models: Model[],
  modelNames: Set<string>,
  queue: Model[],
): void {
  // `extractNestedSchema` names what it extracts from the ref it is handed, so
  // it is only right for refs the field schema produces directly — its own
  // object, its array items, or its union variants. A ref deeper in the tree
  // (the items of a variant's array member, a nested union) is named from its
  // enclosing variant; handing it over here would re-derive the variants'
  // names from it and register them under the wrong names. Those models come
  // from the field extractor, which names them by construction.
  const directRefs = directModelRefNames(ref);
  walkTypeRef(ref, {
    model: (modelRef) => {
      if (modelNames.has(modelRef.name)) return; // already extracted
      if (!directRefs.has(modelRef.name)) return; // nested under a variant — field extractor's
      // Check if this model name corresponds to a component schema
      // by checking all possible original names that would map to this PascalCase name
      const isComponent = Object.keys(schemas).some((k) => resolveSchemaName(k) === modelRef.name);
      if (isComponent) return; // will be extracted from components

      // This is a reference to a nested inline model that wasn't extracted.
      // Look up the field schema in the parent model's component schema to extract it.
      const parentSchema = findSchemaByName(parentModelName, schemas);
      if (!parentSchema) return;

      const fieldSchema = findNestedFieldSchema(fieldName, parentSchema, schemas);
      if (!fieldSchema) return;

      // Extract inline models from the field schema. A union's variants are
      // named from the field's own qualified name — `extractModel` and
      // `extractAllOfModel` type every field of a component, inherited ones
      // included, under the component — which is also variant 0's name
      // unless variant 0 took its title (`CircleDrawingShape`). Rebuild the
      // base from the field rather than reading it off the ref, and keep the
      // ref as the base only if the rebuilt one does not reproduce it. The
      // variants also step around the names the component's other properties
      // mint, as the field's TypeRef did, so derive that set from the same
      // sibling set `extractModel` typed the field with.
      const reserved = reservedInlineNames(fieldName, collectProperties(parentSchema, schemas), parentModelName);
      const extracted = extractNestedSchema(
        unionBaseName(modelRef.name, fieldName, fieldSchema, parentModelName, reserved),
        fieldSchema,
        schemas,
        reserved,
      );
      for (const m of extracted) {
        if (!modelNames.has(m.name)) {
          models.push(m);
          modelNames.add(m.name);
          queue.push(m); // re-scan for deeper nesting
        }
      }
    },
  });
}

/**
 * The base name `extractNestedSchema` should name a field's `oneOf` variants
 * from: the field's qualified inline name when naming the variants from it
 * yields `refName` (the ref the walk is resolving), else `refName` itself,
 * which is right for every non-union field and for a union whose variant 0 is
 * bare.
 */
function unionBaseName(
  refName: string,
  fieldName: string,
  fieldSchema: SchemaObject,
  parentModelName: string,
  reserved: ReadonlySet<string>,
): string {
  if (!fieldSchema.oneOf) return refName;
  const fromField = qualifyInlineModelName(toPascalCase(fieldName), parentModelName);
  const names = [...nameInlineVariants(fieldSchema.oneOf, fromField, reserved).values()];
  return names.includes(refName) ? fromField : refName;
}

/**
 * The model refs a field's TypeRef produces directly: the ref itself, the
 * items of a (possibly nullable) array, or each (possibly nullable) variant of
 * a union — the shapes `extractNestedSchema` can name from a ref. Refs nested
 * any deeper are excluded.
 */
function directModelRefNames(ref: TypeRef): Set<string> {
  const names = new Set<string>();
  let root = ref;
  while (root.kind === 'nullable' || root.kind === 'array') {
    root = root.kind === 'nullable' ? root.inner : root.items;
  }
  const leaves = root.kind === 'union' ? root.variants : [root];
  for (const leaf of leaves) {
    const inner = leaf.kind === 'nullable' ? leaf.inner : leaf;
    if (inner.kind === 'model') names.add(inner.name);
  }
  return names;
}

/** Find a component schema by PascalCase name. */
function findSchemaByName(pascalName: string, schemas: Record<string, SchemaObject>): SchemaObject | null {
  for (const [k, v] of Object.entries(schemas)) {
    if (resolveSchemaName(k) === pascalName) return v;
  }
  return null;
}

/** Walk into a schema to find a field's sub-schema, resolving allOf and oneOf/anyOf. */
function findNestedFieldSchema(
  fieldName: string,
  parentSchema: SchemaObject,
  schemas: Record<string, SchemaObject>,
): SchemaObject | null {
  if (parentSchema.properties?.[fieldName]) {
    return parentSchema.properties[fieldName]!;
  }
  if (parentSchema.allOf) {
    for (const sub of parentSchema.allOf) {
      let resolved = sub;
      if (sub.$ref) {
        const segments = sub.$ref.split('/');
        const refName = segments[segments.length - 1];
        if (refName && schemas[refName]) resolved = schemas[refName];
      }
      if (resolved.properties?.[fieldName]) {
        return resolved.properties[fieldName]!;
      }
    }
  }
  // Also check inside oneOf/anyOf variants (pure oneOf schemas flatten variant
  // properties into the model, so the field may live inside a variant).
  for (const variant of [...(parentSchema.oneOf ?? []), ...(parentSchema.anyOf ?? [])]) {
    let resolved = variant;
    if (variant.$ref) {
      const segments = variant.$ref.split('/');
      const refName = segments[segments.length - 1];
      if (refName && schemas[refName]) resolved = schemas[refName];
    }
    if (resolved.properties?.[fieldName]) {
      return resolved.properties[fieldName]!;
    }
  }
  return null;
}

/**
 * Extract a model (and nested models) from an inline field schema. `reserved`
 * holds the inline names the field's sibling properties mint
 * (`reservedInlineNames`), which a `oneOf` variant must not take.
 */
function extractNestedSchema(
  name: string,
  schema: SchemaObject,
  schemas?: Record<string, SchemaObject>,
  reserved: ReadonlySet<string> = NO_RESERVED,
): Model[] {
  // Handle oneOf: extract each object variant as its own model. `name` is the
  // union's base name (the field's qualified inline name), and the variants
  // are named from it by `nameInlineVariants` — the one place that decides a
  // variant's name — so they match the union TypeRef and the field extractor
  // (`UserApiKeyOwner`, `CircleDrawingShape`, `DrawingShapeWithSide`, ...).
  // Same inline-object test as `schemaToTypeRef` and the field extractor, so
  // a `type: ['object', 'null']` variant is counted here too instead of
  // letting the next variant claim its name.
  if (schema.oneOf) {
    const models: Model[] = [];
    const variantNames = nameInlineVariants(schema.oneOf, name, reserved);

    for (const variant of schema.oneOf) {
      const variantName = variantNames.get(variant);
      if (variantName === undefined) continue;
      // Build the variant's fields under its own name: an inline object
      // nested under variant N is then referenced as `<VariantN>Child`
      // (`ThingShapeWithSideCenter`), which is the name the field extractor
      // materializes it under — not `<Variant0>Child`.
      const requiredSet = new Set(variant.required ?? []);
      const siblings = collectProperties(variant);
      const fields: Field[] = [];
      for (const [fn, fs] of Object.entries(variant.properties ?? {})) {
        if (!fs) continue;
        fields.push(buildFieldFromSchema(fn, fs, variantName, requiredSet, schemas, siblings));
      }
      models.push({ name: variantName, description: variant.description, fields });
    }
    return models;
  }

  // Handle direct object
  if (schema.properties && (schema.type === 'object' || !schema.type)) {
    const requiredSet = new Set(schema.required ?? []);
    const siblings = collectProperties(schema);
    const fields: Field[] = [];
    for (const [fn, fs] of Object.entries(schema.properties)) {
      if (!fs) continue;
      fields.push(buildFieldFromSchema(fn, fs, name, requiredSet, schemas, siblings));
    }
    return [{ name, description: schema.description, fields }];
  }

  // Handle array with inline items
  if (schema.type === 'array' && schema.items?.properties) {
    const requiredSet = new Set(schema.items.required ?? []);
    const siblings = collectProperties(schema.items);
    const fields: Field[] = [];
    for (const [fn, fs] of Object.entries(schema.items.properties)) {
      if (!fs) continue;
      fields.push(buildFieldFromSchema(fn, fs, name, requiredSet, schemas, siblings));
    }
    return [{ name, description: schema.items.description, fields }];
  }

  return [];
}

/**
 * The prefix a variant's `title` contributes to its name: the title trimmed
 * and PascalCased, or null when there is no title or it PascalCases to
 * nothing.
 */
function variantTitlePrefix(variant: SchemaObject): string | null {
  const title = typeof variant['title'] === 'string' ? variant['title'].trim() : '';
  return title ? toPascalCase(title) || null : null;
}

/** `<Prefix><Base>`, or `base` unchanged when it already starts with the prefix (no doubling). */
function prefixedVariantName(prefix: string, base: string): string {
  return base.startsWith(prefix) ? base : `${prefix}${base}`;
}

/**
 * The properties `variant` declares that no other inline object variant of
 * the same union declares, in the variant's own `properties` order.
 */
function distinguishingProperties(variant: SchemaObject, siblings: readonly SchemaObject[]): string[] {
  const declaredElsewhere = new Set<string>();
  for (const sibling of siblings) {
    if (sibling === variant) continue;
    for (const property of Object.keys(sibling.properties ?? {})) declaredElsewhere.add(property);
  }
  return Object.keys(variant.properties ?? {}).filter((property) => !declaredElsewhere.has(property));
}

/**
 * Name an inline object variant of a `oneOf`/`anyOf` that has no better
 * signal: it is not variant 0 (which keeps the union's base name) and no
 * const discriminator gave it a prefix. The name is derived from the
 * variant's own content, never from where it sits in the document (beyond
 * its position among the variants, which only the final counter reads), so
 * an SDK user can tell the variants apart and reordering them changes nothing
 * but which one is variant 0. In order, taking the first candidate that is
 * neither the base name nor a name already given to an earlier variant of
 * the same union:
 *
 *   1. the variant's `title` (trimmed and PascalCased): `<Title><Base>`
 *      (`CircleDrawingShape`), the same prefix form a const discriminator
 *      produces, including the rule that a base already starting with the
 *      prefix is not doubled (that candidate equals the base, so it falls
 *      through); a title an earlier variant already took falls through too;
 *   2. a distinguishing property — the first property, in the variant's own
 *      order, that it declares and no other inline object variant declares:
 *      `<Base>With<Property>` (`DrawingShapeWithSide`); a property that
 *      PascalCases to nothing is skipped;
 *   3. the position counter, `<Base><position + 1>` (`DrawingShape2`), which
 *      now remains only for variants whose property sets are identical, and
 *      which keeps counting past a taken name (`DrawingShape3`).
 *
 * Every candidate is also checked against `reserved`: the inline names the
 * parent's other properties mint (`reservedInlineNames`), so a variant can
 * never take a name another field's model already has — beside a
 * `shape_with_side` object, the `{ side }` variant of `shape` is not
 * `DrawingShapeWithSide` but the next candidate. Read from sibling names and
 * content only, so document order plays no part.
 *
 * `siblings` are the inline object variants of the union, this one included;
 * `emitted` are the names already given to the earlier ones, in order. Every
 * site that names a variant — the union TypeRef, the component-field,
 * request-body and response extractors, and `mintedInlineNames` — goes
 * through this function (via `nameInlineVariant`), so they cannot drift.
 */
export function nameUndiscriminatedVariant(
  variant: SchemaObject,
  siblings: readonly SchemaObject[],
  base: string,
  emitted: readonly string[],
  reserved: ReadonlySet<string> = NO_RESERVED,
): string {
  const taken = (candidate: string): boolean =>
    candidate === base || emitted.includes(candidate) || reserved.has(candidate);

  const titlePrefix = variantTitlePrefix(variant);
  if (titlePrefix !== null) {
    const candidate = prefixedVariantName(titlePrefix, base);
    if (!taken(candidate)) return candidate;
  }

  for (const property of distinguishingProperties(variant, siblings)) {
    const word = toPascalCase(property);
    if (!word) continue;
    const candidate = `${base}With${word}`;
    if (!taken(candidate)) return candidate;
  }

  for (let position = emitted.length + 1; ; position++) {
    const candidate = `${base}${position}`;
    if (!taken(candidate)) return candidate;
  }
}

/** No reserved names: for a union with no sibling properties (a request body or response that is itself a union). */
const NO_RESERVED: ReadonlySet<string> = new Set();

/**
 * True when the union's inline object variants (two or more) each carry a
 * title and no two titles PascalCase to the same prefix: the one case in
 * which variant 0 is named from its title rather than keeping the base name.
 */
function allDistinctlyTitled(siblings: readonly SchemaObject[]): boolean {
  if (siblings.length < 2) return false;
  const prefixes = siblings.map(variantTitlePrefix);
  return prefixes.every((prefix) => prefix !== null) && new Set(prefixes).size === prefixes.length;
}

/**
 * The name of one inline object variant of a `oneOf`/`anyOf`, given the
 * union's base name (the field's qualified inline name, e.g. `ApiKeyOwner`),
 * the inline object variants of the union (`siblings`, this one included),
 * the names already given to the earlier variants (`emitted`, in order), and
 * the const-valued property that distinguishes the variants when there is
 * one (`deriveConstNamingDiscriminator`).
 *
 * Variant 0 keeps the bare base name: the union TypeRef and every extractor
 * reference it under that name, and a consumer's typed field keeps the name
 * it always had. The one exception: when the union has no const discriminator
 * and every variant carries a distinct title, variant 0 is named from its
 * title like the others (`CircleDrawingShape` beside `SquareDrawingShape`)
 * instead of being the only one left bare. Whether the union is discriminated
 * is read from the variants themselves here, not from `discriminator`, so a
 * caller forcing a property (an explicit `discriminator:` without `mapping:`)
 * still agrees with the extractors on variant 0.
 *
 * A later variant takes `<ConstValue><Base>` from the discriminator
 * (`UserApiKeyOwner`) when the value PascalCases to something and the name is
 * neither the base, nor already emitted, nor minted by one of the parent's
 * other properties (`reserved`), and otherwise falls to
 * `nameUndiscriminatedVariant`: its title, a distinguishing property, then
 * the position counter, each checked the same way.
 */
export function nameInlineVariant(
  variant: SchemaObject,
  siblings: readonly SchemaObject[],
  base: string,
  emitted: readonly string[],
  discriminator: { property: string } | null,
  reserved: ReadonlySet<string> = NO_RESERVED,
): string {
  if (emitted.length === 0) {
    const undiscriminated = deriveConstNamingDiscriminator([...siblings]) === null;
    const titlePrefix = undiscriminated && allDistinctlyTitled(siblings) ? variantTitlePrefix(variant) : null;
    return titlePrefix === null ? base : prefixedVariantName(titlePrefix, base);
  }

  if (discriminator) {
    const constValue = getConstPropertyValue(variant, discriminator.property);
    const prefix = constValue ? toPascalCase(constValue) : '';
    if (prefix) {
      const candidate = prefixedVariantName(prefix, base);
      if (candidate !== base && !emitted.includes(candidate) && !reserved.has(candidate)) return candidate;
    }
  }
  return nameUndiscriminatedVariant(variant, siblings, base, emitted, reserved);
}

/**
 * Name every inline object variant of a `oneOf`/`anyOf` from the union's base
 * name, keyed by variant schema identity; non-object and `$ref` variants get
 * no entry. Positions are local to this variant list, so the union's TypeRef
 * entries and the extracted models agree no matter what else has been
 * extracted. `reserved` holds the inline names the parent's other properties
 * mint (`reservedInlineNames`); every site that has a sibling set passes the
 * same one, so the reference and the model step around them identically.
 * This is the list-level entry point every site uses: `schemaToTypeRef` (via
 * `nameInlineObjectVariants`), `extractNestedSchema`,
 * `extractInlineModelDeep`, `extractInlineModelsFromProperties` and
 * `mintedInlineNames`.
 */
export function nameInlineVariants(
  variants: readonly SchemaObject[],
  base: string,
  reserved: ReadonlySet<string> = NO_RESERVED,
): Map<SchemaObject, string> {
  const inlineObjectVariants = variants.filter((v) => isInlineObjectSchema(v));
  const discriminator = deriveConstNamingDiscriminator(inlineObjectVariants);
  const emitted: string[] = [];
  const names = new Map<SchemaObject, string>();
  for (const variant of inlineObjectVariants) {
    const name = nameInlineVariant(variant, inlineObjectVariants, base, emitted, discriminator, reserved);
    emitted.push(name);
    names.set(variant, name);
  }
  return names;
}

/**
 * Returns a discriminator descriptor when every inline object variant in a
 * oneOf has a string-const value on the same property — the signature of a
 * discriminated union without an explicit `discriminator:` keyword. Used by
 * `nameInlineVariant` to derive variant names from the const values.
 *
 * Distinct from `detectConstPropertyDiscriminator` (which requires every
 * variant to carry a `$ref` or `title` so a name mapping can be built):
 * this pass operates on inline anonymous variants, where naming is exactly
 * what we're trying to derive.
 */
function deriveConstNamingDiscriminator(variants: SchemaObject[]): { property: string } | null {
  if (variants.length < 2) return null;
  const candidates = Object.keys(variants[0]?.properties ?? {});
  for (const propName of candidates) {
    const values = variants.map((v) => getConstPropertyValue(v, propName));
    if (values.some((v) => v === null)) continue;
    if (new Set(values).size !== values.length) continue; // collisions = no signal
    return { property: propName };
  }
  return null;
}

/**
 * True for a schema that `schemaToTypeRef` turns into an inline model reference:
 * it declares `properties` directly (no `$ref`) and is an object — whether by
 * `type: 'object'`, by omitting `type`, or by an OAS 3.1 nullable array such as
 * `type: ['object', 'null']`. Every inline-model extractor must use the same
 * test, or a field's reference points at a model nobody materializes.
 */
export function isInlineObjectSchema(schema: SchemaObject | undefined): schema is SchemaObject {
  if (!schema || schema.$ref || !schema.properties) return false;
  const { type } = schema;
  return type === undefined || type === 'object' || (Array.isArray(type) && type.includes('object'));
}

/**
 * The synthetic context names a multi-type inline variant's non-object
 * members are typed and extracted under, chosen so the models they name can
 * never collide with a model named from one of the variant's own properties.
 * An `array` member's items go under `item` (`<Variant>Item`), falling back
 * to `array_item` (`<Variant>ArrayItem`) and then `array_item2`,
 * `array_item3`, ... when a property already claims that name; any other
 * member goes under `value` (`<Variant>Value`), then `member_value`,
 * `member_value2`, .... A candidate is skipped when the model name
 * `qualifyInlineModelName` derives from it equals one derived from a
 * property — compared after qualification, so a property `items`, whose
 * name singularizes to `<Variant>Item`, blocks `item` as well.
 * This is the single source of these names for the TypeRef builder
 * (`inlineVariantTypeRef`) and the extractors (`variantMemberSchemas`).
 */
export function variantMemberKeys(variant: SchemaObject, variantName: string): { item: string; value: string } {
  const modelNameFor = (key: string): string => qualifyInlineModelName(toPascalCase(key), variantName);
  const claimed = new Set(Object.keys(variant.properties ?? {}).map(modelNameFor));
  const pick = (preferred: string, fallback: string): string => {
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? preferred : i === 1 ? fallback : `${fallback}${i}`;
      if (!claimed.has(modelNameFor(candidate))) return candidate;
    }
  };
  return { item: pick('item', 'array_item'), value: pick('value', 'member_value') };
}

/**
 * The schemas carried by the non-object members of a multi-type inline
 * variant (`type: ['object', 'array']` with `items`), keyed by the synthetic
 * context name from `variantMemberKeys` that `schemaToTypeRef` types them
 * under, so an inline object item is `<Variant>Item` (or `<Variant>ArrayItem`
 * when `item` is taken) and its own nested objects `<Variant>ItemChild`.
 * Every extractor re-enters with these under the variant's name so the
 * models line up with the refs by construction. A map member cannot occur
 * here: a variant with `properties` is typed as a model, never as a map.
 */
export function variantMemberSchemas(variant: SchemaObject, variantName: string): Record<string, SchemaObject> {
  const members: Record<string, SchemaObject> = {};
  if (Array.isArray(variant.type) && variant.type.includes('array') && variant.items) {
    members[variantMemberKeys(variant, variantName).item] = variant.items;
  }
  return members;
}

/**
 * Build a single Field from a schema property entry. Shared across all
 * extraction sites. Pass `componentSchemas` where they are at hand so a
 * field whose schema is a bare `$ref` can take `example`/`examples` from the
 * component it points at, as a parameter does. `siblingProperties` are the
 * other properties of the object the field belongs to (`collectProperties`);
 * array items and map values use them to step aside from a sibling that
 * would take their singular name (`elementContextName`).
 */
export function buildFieldFromSchema(
  fieldName: string,
  fieldSchema: SchemaObject,
  contextName: string,
  requiredSet: Set<string>,
  componentSchemas?: Record<string, SchemaObject>,
  siblingProperties?: ReadonlyMap<string, SchemaObject>,
): Field {
  const refTarget = resolveComponentSchemaRef(fieldSchema, componentSchemas);
  const { example, examples } = resolveExamples([
    { example: fieldSchema.example, examples: nonEmptyExamples(fieldSchema.examples) },
    { example: refTarget?.example, examples: nonEmptyExamples(refTarget?.examples) },
  ]);
  return {
    name: fieldName,
    type: schemaToTypeRef(fieldSchema, fieldName, contextName, siblingProperties),
    required: requiredSet.has(fieldName),
    description: fieldSchema.description,
    readOnly: fieldSchema.readOnly || undefined,
    writeOnly: fieldSchema.writeOnly || undefined,
    deprecated: fieldSchema.deprecated || undefined,
    default: fieldSchema.default,
    example,
    // Only materialise the key when there is something to carry so existing
    // inline snapshots of fields without examples stay byte-identical.
    ...(examples ? { examples } : {}),
  };
}

/**
 * If every non-null oneOf/anyOf variant is a string-valued const, return the
 * list of those const values so the union can collapse into a single enum.
 * Returns null when any variant isn't a pure string-const (model ref,
 * number const, nullable, etc.).
 */
function collectLiteralStringConsts(variants: SchemaObject[]): string[] | null {
  if (variants.length === 0) return null;
  const values: string[] = [];
  for (const v of variants) {
    // A single-element enum is semantically identical to const.
    if (typeof v.const === 'string') {
      values.push(v.const);
      continue;
    }
    if (Array.isArray(v.enum) && v.enum.length === 1 && typeof v.enum[0] === 'string') {
      values.push(v.enum[0]);
      continue;
    }
    return null;
  }
  return values;
}

/** Build an EnumRef the same way the regular enum path does for naming. */
function buildSyntheticEnumRef(
  values: string[],
  contextName: string | undefined,
  parentModelName: string | undefined,
): TypeRef {
  const baseName = toPascalCase(contextName ?? 'UnknownEnum');
  const cleanParent = parentModelName ? stripListItemMarkers(parentModelName) : undefined;
  const qualifiedName = cleanParent && !baseName.startsWith(cleanParent) ? `${cleanParent}${baseName}` : baseName;
  // Run the same `schemaNameTransform` we apply to component-schema names so
  // a project-level rename map (e.g. `RadarAction` → `RadarListAction` in
  // `oagen.config.ts`) catches inline parameter enums too.
  const finalName = activeSchemaNameTransform ? activeSchemaNameTransform(qualifiedName) : qualifiedName;
  return { kind: 'enum', name: finalName, values };
}

/**
 * Detect an implicit discriminator on an oneOf where every variant is an
 * object schema that pins the same property to a const value. Returns
 * { property, mapping } so the IR can represent the union as discriminated
 * without needing an explicit `discriminator:` key in the spec.
 *
 * Both shapes are supported:
 *   { properties: { event: { const: "x" } }, required: ["event"] }
 *   { properties: { event: { type: "string", enum: ["x"] } } }
 *
 * Returns null when any variant doesn't fit the pattern or when variants
 * disagree on which property carries the discriminator.
 */
function detectConstPropertyDiscriminator(
  variants: SchemaObject[],
): { property: string; mapping: Record<string, string> } | null {
  if (variants.length < 2) return null;

  // Find properties whose const value is present on every variant.
  let candidateProperty: string | null = null;
  const candidates = Object.keys(variants[0]?.properties ?? {});
  for (const propName of candidates) {
    if (variants.every((v) => getConstPropertyValue(v, propName) !== null)) {
      candidateProperty = propName;
      break;
    }
  }

  if (!candidateProperty) return null;

  const mapping: Record<string, string> = {};
  for (const v of variants) {
    const value = getConstPropertyValue(v, candidateProperty);
    if (value === null) return null;
    // Require a $ref or title so we have a concrete model name to map to.
    const variantName = resolveVariantModelName(v);
    if (!variantName) return null;
    mapping[value] = variantName;
  }

  return { property: candidateProperty, mapping };
}

function getConstPropertyValue(schema: SchemaObject, property: string): string | null {
  const prop = schema.properties?.[property];
  if (!prop) return null;
  if (typeof prop.const === 'string') return prop.const;
  if (Array.isArray(prop.enum) && prop.enum.length === 1 && typeof prop.enum[0] === 'string') {
    return prop.enum[0];
  }
  return null;
}

function resolveVariantModelName(schema: SchemaObject): string | null {
  if (schema.$ref) {
    return resolveSchemaName(schema.$ref.replace(/^#\/components\/schemas\//, ''));
  }
  const title = typeof schema['title'] === 'string' ? (schema['title'] as string) : null;
  if (title) return resolveSchemaName(title);
  return null;
}

/** Look up the discriminator's mapped variant name for an inline object
 *  variant by reading its const-valued discriminator property. Returns null
 *  when the variant doesn't pin the property to a string const, or when
 *  the value isn't in the mapping. */
function mapVariantToDiscriminatorEntry(
  variant: SchemaObject,
  discriminator: { property: string; mapping: Record<string, string> },
): string | null {
  const value = getConstPropertyValue(variant, discriminator.property);
  if (value === null) return null;
  return discriminator.mapping[value] ?? null;
}

/**
 * Derive a discriminator value → variant model name mapping for an inline-
 * variant `oneOf` whose explicit `discriminator:` has no `mapping:` clause.
 *
 * Each variant model name is reproduced via `nameInlineVariant` so it matches
 * what `extractNestedSchema` registered when it walked the same `oneOf` to
 * pull variants out as named models. Variant 0 keeps the bare parent name
 * (e.g. `ApiKeyOwner`); subsequent variants get a const-derived prefix
 * (e.g. `UserApiKeyOwner` for the `type: const: user` variant).
 *
 * The "parent name" used here mirrors the one `collectNestedInlineModels`
 * passes to `extractNestedSchema`: it's the qualified inline model name
 * built from `contextName` (the field name) plus `parentModelName` (the
 * containing model), and the names the field's sibling properties mint are
 * reserved the same way (`siblingProperties`). Returns null when any
 * non-object variant is present or when a variant lacks a const value on the
 * discriminator property.
 */
function deriveInlineVariantMapping(
  variants: SchemaObject[],
  discriminatorProperty: string,
  contextName: string | undefined,
  parentModelName: string | undefined,
  siblingProperties: ReadonlyMap<string, SchemaObject> | undefined,
): Record<string, string> | null {
  if (variants.length === 0 || !contextName) return null;
  const inlineObjectVariants = variants.filter((v) => isInlineObjectSchema(v));
  if (inlineObjectVariants.length !== variants.length) return null;

  const baseInlineName = qualifyInlineModelName(toPascalCase(contextName), parentModelName);
  const reserved = reservedInlineNames(contextName, siblingProperties, parentModelName);
  const namingDiscriminator = { property: discriminatorProperty };
  const mapping: Record<string, string> = {};
  const emitted: string[] = [];
  for (const variant of inlineObjectVariants) {
    const constValue = getConstPropertyValue(variant, discriminatorProperty);
    if (constValue === null) return null;
    const variantName = nameInlineVariant(
      variant,
      inlineObjectVariants,
      baseInlineName,
      emitted,
      namingDiscriminator,
      reserved,
    );
    mapping[constValue] = variantName;
    emitted.push(variantName);
  }
  return mapping;
}

/**
 * Name the inline object variants of a field's `oneOf`/`anyOf` exactly as the
 * inline-model extractors do (`extractInlineModelsFromProperties` in
 * inline-models.ts, and `extractNestedSchema` / `extractInlineModelDeep`
 * here): the union's base name is the field's qualified inline name, the
 * names the field's sibling properties mint are reserved
 * (`reservedInlineNames`), and `nameInlineVariants` hands out the variant
 * names from there. Returned keyed by variant schema identity.
 */
function nameInlineObjectVariants(
  variants: SchemaObject[],
  contextName: string | undefined,
  parentModelName: string | undefined,
  siblingProperties: ReadonlyMap<string, SchemaObject> | undefined,
): Map<SchemaObject, string> {
  const baseInlineName = qualifyInlineModelName(toPascalCase(contextName ?? 'UnknownModel'), parentModelName);
  const reserved =
    contextName === undefined ? NO_RESERVED : reservedInlineNames(contextName, siblingProperties, parentModelName);
  return nameInlineVariants(variants, baseInlineName, reserved);
}

/**
 * The TypeRef for an inline object variant referenced by the name its
 * extracted model carries, keeping every other type the variant allows.
 * Mirrors what `schemaToTypeRef` builds for the same schema — one member per
 * non-null entry of a `type` array, `union`-wrapped when there is more than
 * one, `nullable`-wrapped when `null` or OAS 3.0 `nullable: true` is present
 * — with the `object` member swapped for the named ref:
 * `type: ['object', 'string']` → `union[model, string]`,
 * `['object', 'integer', 'null']` → `nullable<union[model, integer]>`,
 * `['object', 'null']` / `nullable: true` → `nullable<model>`.
 * A `oneOf: [X, { type: 'null' }]` variant has no `properties` of its own
 * and never reaches this path; `schemaToTypeRef` types it directly.
 *
 * Anything inline under a non-object member is named from the variant, never
 * from the union's field: an `array` member types its items under the
 * variant as parent with the context `variantMemberKeys` picks (`item` →
 * `<Variant>Item`, or `array_item` → `<Variant>ArrayItem` when a property
 * claims `item`), and any other member under its `value` key
 * (`<Variant>Value` for an inline enum, else `<Variant>MemberValue`). Naming
 * them from the field would hand variant 0's model name to every variant's
 * items.
 */
function inlineVariantTypeRef(variant: SchemaObject, name: string): TypeRef {
  const modelRef: TypeRef = { kind: 'model', name };
  const typeList = Array.isArray(variant.type) ? variant.type : [];
  const nullable = variant.nullable === true || typeList.includes('null');
  const keys = variantMemberKeys(variant, name);
  const members = typeList
    .filter((t) => t !== 'null')
    .map((t) =>
      t === 'object'
        ? modelRef
        : schemaToTypeRef({ ...variant, type: t, nullable: false }, t === 'array' ? keys.item : keys.value, name),
    );
  const ref: TypeRef = members.length > 1 ? { kind: 'union', variants: members } : modelRef;
  return nullable ? asNullable(ref) : ref;
}

function extractEnum(name: string, schema: SchemaObject): Enum {
  // A `null` member marks the schema as nullable (OAS 3.1); it is not a
  // value. Nullability is carried on the `$ref` side via
  // `activeNullableEnumSchemaNames`, so drop it here instead of emitting a
  // bogus `NULL = "null"` member.
  const values: EnumValue[] = nonNullEnumValues(schema.enum).map((v) => ({
    name: toUpperSnakeCase(String(v)),
    value: typeof v === 'number' ? v : String(v),
    description: undefined,
  }));

  const rawDefault = schema.default;
  const def =
    rawDefault !== undefined && values.some((v) => v.value === rawDefault)
      ? (rawDefault as string | number)
      : undefined;

  return { name, values, default: def };
}
function extractModel(name: string, schema: SchemaObject, schemas?: Record<string, SchemaObject>): Model {
  if (schema.allOf) {
    return extractAllOfModel(name, schema, schemas);
  }

  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];
  // The sibling set the field extractor derives for this component too, so
  // array items and map values are named the same on both sides.
  const siblings = collectProperties(schema, schemas);

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet, schemas, siblings));
  }

  // Pure oneOf/anyOf schemas (no allOf, no properties): merge variant fields
  // as optional. This handles schemas like UpdateOrganizationMembership which
  // is a oneOf with mutually exclusive field groups (role_slug vs role_slugs).
  if (fields.length === 0 && (schema.oneOf || schema.anyOf)) {
    const variants = schema.oneOf ?? schema.anyOf ?? [];
    const emptyRequired = new Set<string>();
    const seenFieldNames = new Set<string>();
    for (const variant of variants) {
      if (!variant.properties) continue;
      for (const [fieldName, fieldSchema] of Object.entries(variant.properties)) {
        if (!fieldSchema || seenFieldNames.has(fieldName)) continue;
        seenFieldNames.add(fieldName);
        fields.push(
          buildFieldFromSchema(fieldName, fieldSchema as SchemaObject, name, emptyRequired, schemas, siblings),
        );
      }
    }
  }

  // When additionalProperties is an object schema alongside properties,
  // surface it as a catch-all map field so emitters can generate Map<string, T>.
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && schema.properties) {
    const apKeys = Object.keys(schema.additionalProperties);
    if (apKeys.length > 0) {
      const valueType = schemaToTypeRef(schema.additionalProperties as SchemaObject, 'additionalProperties', name);
      fields.push({
        name: 'additionalProperties',
        type: { kind: 'map', valueType },
        required: false,
        description: 'Additional properties not captured by named fields',
      });
    }
  }

  return { name, description: schema.description, fields };
}

function extractAllOfModel(
  name: string,
  schema: SchemaObject,
  schemas?: Record<string, SchemaObject>,
  siblingProperties?: ReadonlyMap<string, SchemaObject>,
): Model {
  const fields: Field[] = [];
  const requiredSet = new Set<string>();
  // One sibling set for every field of the composed model, nested `allOf`
  // levels included, matching what the field extractor derives for it.
  const siblings = siblingProperties ?? collectProperties(schema, schemas);
  let resultDiscriminator: { property: string; mapping: Record<string, string> } | undefined;

  for (const subSchema of schema.allOf ?? []) {
    // Resolve $ref sub-schemas by looking up the referenced component schema
    let resolved = subSchema;
    if (subSchema.$ref && schemas) {
      const segments = subSchema.$ref.split('/');
      const refName = segments[segments.length - 1];
      if (refName && schemas[refName]) {
        resolved = schemas[refName];
      }
    }

    // If the resolved schema is itself an allOf, recursively extract its fields
    if (resolved.allOf) {
      const nested = extractAllOfModel(name, resolved, schemas, siblings);
      for (const f of nested.fields) {
        fields.push({ ...f, required: false }); // will be re-set below
        if (f.required) requiredSet.add(f.name);
      }
    } else if (resolved.oneOf || resolved.anyOf) {
      const variants = resolved.oneOf ?? resolved.anyOf ?? [];
      // Detect discriminated union: every variant pins the same property to a
      // distinct const value (e.g. EventSchema where each variant has event: const).
      // When detected, store the discriminator instead of flattening variant fields —
      // the base allOf schema already captures the common fields.
      const discriminatorInfo = detectAllOfVariantDiscriminator(variants, name);
      if (discriminatorInfo) {
        resultDiscriminator = discriminatorInfo;
      } else {
        // Flatten oneOf/anyOf variant fields into the parent model as optional
        // fields. This handles the common allOf + oneOf pattern where the spec
        // uses mutually exclusive variant groups (e.g. password vs password_hash).
        const emptyRequired = new Set<string>();
        const seenFieldNames = new Set(fields.map((f) => f.name));
        for (const variant of variants) {
          if (!variant.properties) continue;
          for (const [fieldName, fieldSchema] of Object.entries(variant.properties)) {
            if (!fieldSchema || seenFieldNames.has(fieldName)) continue;
            seenFieldNames.add(fieldName);
            fields.push(
              buildFieldFromSchema(fieldName, fieldSchema as SchemaObject, name, emptyRequired, schemas, siblings),
            );
          }
        }
        // Do NOT add variant-level required to the requiredSet — these fields
        // are optional at the parent level because they come from mutually
        // exclusive branches.
      }
    } else {
      if (resolved.required) {
        for (const r of resolved.required) requiredSet.add(r);
      }
      if (resolved.properties) {
        // Use an empty requiredSet — required flags are set in the final pass below
        const emptyRequired = new Set<string>();
        for (const [fieldName, fieldSchema] of Object.entries(resolved.properties)) {
          if (!fieldSchema) continue;
          fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, emptyRequired, schemas, siblings));
        }
      }
    }
  }

  // Also collect required from the outer schema
  if (schema.required) {
    for (const r of schema.required) requiredSet.add(r);
  }

  // Set required flags
  for (const f of fields) {
    f.required = requiredSet.has(f.name);
  }

  return {
    name,
    description: schema.description,
    fields,
    ...(resultDiscriminator ? { discriminator: resultDiscriminator } : {}),
  };
}

/**
 * Walk through `allOf` wrappers to collect the effective top-level properties
 * of a schema. Stops at `oneOf` / `anyOf` boundaries — those are different
 * variant axes, not part of the same flat object.
 *
 * Used by `detectAllOfVariantDiscriminator` and `deriveDiscriminatedVariantName`
 * so a oneOf variant of the form `{ allOf: [{ properties: { … } }, { oneOf: […] }] }`
 * still surfaces its top-level `properties` (in particular its discriminator
 * `const`) instead of being treated as having none.
 */
function getEffectiveProperties(schema: SchemaObject): Record<string, SchemaObject> {
  const props: Record<string, SchemaObject> = {};
  const visit = (s: SchemaObject): void => {
    if (s.properties) {
      for (const [k, v] of Object.entries(s.properties)) {
        if (!(k in props) && v) props[k] = v;
      }
    }
    if (s.allOf) {
      for (const sub of s.allOf) visit(sub);
    }
    // Do NOT walk into oneOf / anyOf — those are alternatives, not
    // simultaneously-present properties.
  };
  visit(schema);
  return props;
}

function getEffectiveConstPropertyValue(schema: SchemaObject, property: string): string | null {
  const direct = getConstPropertyValue(schema, property);
  if (direct !== null) return direct;
  const effective = getEffectiveProperties(schema)[property];
  if (!effective) return null;
  if (typeof effective.const === 'string') return effective.const;
  if (Array.isArray(effective.enum) && effective.enum.length === 1 && typeof effective.enum[0] === 'string') {
    return effective.enum[0];
  }
  return null;
}

/**
 * Detect an implicit discriminator on an allOf+oneOf where every variant is an
 * object that pins the same property to a distinct const value. Unlike
 * detectConstPropertyDiscriminator (which requires $ref or title for variant
 * model names), this version derives model names from the const value itself
 * using deriveDiscriminatedVariantName — matching how extractDiscriminatedAllOfVariantModels
 * names those models.
 *
 * Walks through allOf wrappers on each variant so a oneOf branch like
 *   { allOf: [{ properties: { type: { const: 'oauth' } } }, { oneOf: […] }] }
 * still surfaces `type` as a candidate discriminator.
 *
 * Returns null when no discriminator can be reliably detected.
 */
function detectAllOfVariantDiscriminator(
  variants: SchemaObject[],
  fallbackName: string,
): { property: string; mapping: Record<string, string> } | null {
  if (variants.length < 2) return null;

  // Find a property whose const value is present on every variant
  // (looking through allOf wrappers on each variant).
  const firstProps = getEffectiveProperties(variants[0] ?? {});
  let candidateProperty: string | null = null;
  for (const propName of Object.keys(firstProps)) {
    if (variants.every((v) => getEffectiveConstPropertyValue(v, propName) !== null)) {
      candidateProperty = propName;
      break;
    }
  }
  if (!candidateProperty) return null;

  const mapping: Record<string, string> = {};
  const seenModelNames = new Set<string>();
  for (const v of variants) {
    const value = getEffectiveConstPropertyValue(v, candidateProperty);
    if (value === null) return null;
    const modelName = deriveDiscriminatedVariantName(v, fallbackName);
    // If two variants map to the same model name, the discriminator is ambiguous
    if (seenModelNames.has(modelName)) return null;
    seenModelNames.add(modelName);
    mapping[value] = modelName;
  }

  return { property: candidateProperty, mapping };
}

function extractDiscriminatedAllOfVariantModels(
  schema: SchemaObject,
  fallbackName: string,
  schemas?: Record<string, SchemaObject>,
): Model[] {
  const models: Model[] = [];
  const seenNames = new Set<string>();

  // Collect base-object properties + required from the allOf wrapper so each
  // variant can be emitted as a complete, self-contained type. Schemas like
  // `EventSchema` repeat the base fields inside every variant in the spec
  // (so this merge is a no-op there), but `ConnectApplication`'s OAuth /
  // M2M variants don't — without this, dispatcher consumers would get a
  // variant that's missing the shared `id` / `name` / `object` etc.
  const baseProperties: Record<string, SchemaObject> = {};
  const baseRequired = new Set<string>();
  for (const subSchema of schema.allOf ?? []) {
    if (subSchema.oneOf) continue; // the variant axis, handled below
    const flat = subSchema.allOf ? flattenVariantForExtraction(subSchema) : subSchema;
    if (flat.properties) {
      for (const [k, v] of Object.entries(flat.properties)) {
        if (!(k in baseProperties) && v) baseProperties[k] = v;
      }
    }
    if (flat.required) for (const r of flat.required) baseRequired.add(r);
  }

  for (const subSchema of schema.allOf ?? []) {
    for (const variant of subSchema.oneOf ?? []) {
      // Flatten any allOf wrapper on the variant (e.g. `ConnectApplication`'s
      // OAuth branch is `allOf: [{ properties: {…} }, { oneOf: [first-party
      // sub-variants] }]`). The flattened object has merged properties and
      // an inlined sub-variant `oneOf` so `extractInlineModelDeep` can pull
      // out a complete variant model.
      const flat = flattenVariantForExtraction(variant);
      if (!flat.properties || (flat.type !== undefined && flat.type !== 'object')) continue;

      // Merge base fields into the variant. Variant-specific properties win
      // on name collisions because the spec may pin a base field to a more
      // specific shape inside a variant.
      const mergedProperties: Record<string, SchemaObject> = { ...baseProperties };
      for (const [k, v] of Object.entries(flat.properties)) {
        if (v) mergedProperties[k] = v;
      }
      const mergedRequired = new Set<string>([...baseRequired, ...(flat.required ?? [])]);
      const merged: SchemaObject = {
        type: 'object',
        properties: mergedProperties,
        required: [...mergedRequired],
      };

      const variantName = deriveDiscriminatedVariantName(variant, fallbackName);
      for (const model of extractInlineModelDeep(variantName, merged, schemas)) {
        if (seenNames.has(model.name)) continue;
        seenNames.add(model.name);
        models.push(model);
      }
    }
  }

  return models;
}

/**
 * Flatten a oneOf variant schema into a single object-shaped schema for
 * variant-model extraction. Recursively merges `allOf` members and folds
 * any nested `oneOf` into an inline-oneOf field group whose properties are
 * the union across sub-branches (required only when present in every
 * sub-branch). Returns the schema unchanged when no flattening is needed.
 */
function flattenVariantForExtraction(variant: SchemaObject): SchemaObject {
  if (!variant.allOf) return variant;

  const mergedProperties: Record<string, SchemaObject> = {};
  const mergedRequired = new Set<string>();
  const nestedOneOfs: SchemaObject[][] = [];

  const collect = (s: SchemaObject): void => {
    if (s.properties) {
      for (const [k, v] of Object.entries(s.properties)) {
        if (!(k in mergedProperties) && v) mergedProperties[k] = v;
      }
    }
    if (s.required) {
      for (const r of s.required) mergedRequired.add(r);
    }
    if (s.allOf) {
      for (const sub of s.allOf) collect(sub);
    }
    if (s.oneOf) nestedOneOfs.push(s.oneOf);
  };
  collect(variant);

  // Fold each nested oneOf into the merged shape: any field appearing in any
  // sub-branch is included as optional (or required iff present-and-required
  // in every sub-branch). Conflicting literal types widen to their primitive
  // base. This handles the `is_first_party: true | false` widening on the
  // OAuth variant's first-party sub-oneOf.
  for (const branches of nestedOneOfs) {
    const flatBranches = branches.map(flattenVariantForExtraction);
    const branchKeys = new Set<string>();
    for (const b of flatBranches) {
      for (const k of Object.keys(b.properties ?? {})) branchKeys.add(k);
    }
    for (const key of branchKeys) {
      const schemas: SchemaObject[] = [];
      for (const b of flatBranches) {
        const s = b.properties?.[key];
        if (s) schemas.push(s);
      }
      const merged = mergeBranchPropertySchemas(schemas);
      if (!(key in mergedProperties)) mergedProperties[key] = merged;
      const inAllBranches = flatBranches.every((b) => b.properties && key in b.properties);
      const requiredInAll = inAllBranches && flatBranches.every((b) => (b.required ?? []).includes(key));
      if (requiredInAll) mergedRequired.add(key);
    }
  }

  return {
    type: 'object',
    properties: mergedProperties,
    required: [...mergedRequired],
  };
}

/**
 * Merge same-named property schemas from across sub-variants. If every
 * occurrence is a boolean const, widen to plain boolean; if every occurrence
 * is a distinct string const, widen to plain string. Otherwise return the
 * first occurrence — emitters that build their own widened types (e.g. the
 * Node discriminated-models module) re-derive from the raw spec.
 */
function mergeBranchPropertySchemas(schemas: SchemaObject[]): SchemaObject {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0];

  const allBoolConst = schemas.every((s) => s.type === 'boolean' && typeof s.const === 'boolean');
  if (allBoolConst) {
    return { type: 'boolean', description: schemas[0].description };
  }
  const allStringConst = schemas.every((s) => s.type === 'string' && typeof s.const === 'string');
  if (allStringConst) {
    const values = schemas.map((s) => s.const as string);
    if (new Set(values).size === 1) return schemas[0];
    return { type: 'string', description: schemas[0].description };
  }
  return schemas[0];
}

function deriveDiscriminatedVariantName(schema: SchemaObject, fallbackName: string): string {
  // Walk through allOf wrappers so a variant of the form
  // `{ allOf: [{ properties: { type: const: 'oauth' } }, { oneOf: […] }] }`
  // still surfaces its discriminator const value for naming.
  const effective = getEffectiveProperties(schema);
  if (Object.keys(effective).length === 0) return fallbackName;

  const pickConst = (name: string): string | null => {
    const field = effective[name];
    if (!field) return null;
    if (typeof field.const === 'string') return field.const;
    if (field.enum && field.enum.length === 1 && typeof field.enum[0] === 'string') {
      return field.enum[0];
    }
    return null;
  };

  let constValue: string | null = null;
  for (const preferred of ['event', 'type', 'object']) {
    constValue = pickConst(preferred);
    if (constValue) break;
  }
  if (constValue === null) {
    for (const name of Object.keys(effective)) {
      constValue = pickConst(name);
      if (constValue) break;
    }
  }
  if (constValue === null) return fallbackName;

  const pascal = toPascalCase(constValue);
  if (!pascal) return fallbackName;

  // A single-word const like `oauth` or `m2m` is too generic to stand alone
  // as a top-level model name — it would collide with unrelated schemas. Pair
  // it with the parent name so the variant resolves to e.g. `ConnectApplicationOAuth`
  // / `ConnectApplicationM2M`. Multi-word consts like `action.authentication.denied`
  // are already specific enough on their own, matching the established
  // EventSchema variant naming.
  const wordCount = splitWords(constValue).length;
  if (wordCount >= 2) return pascal;
  if (pascal === fallbackName) return pascal;
  if (fallbackName.startsWith(pascal)) return fallbackName;
  if (pascal.endsWith(fallbackName)) return pascal;
  return `${fallbackName}${pascal}`;
}

function extractInlineModelDeep(name: string, schema: SchemaObject, schemas?: Record<string, SchemaObject>): Model[] {
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];
  const properties = schema.properties ?? {};
  const nestedModels: Model[] = [];

  const siblings = collectProperties(schema);
  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet, schemas, siblings));

    if (fieldSchema.type === 'object' && fieldSchema.properties) {
      nestedModels.push(...extractInlineModelDeep(qualifyNestedInlineName(name, fieldName), fieldSchema, schemas));
    }

    // Array items and map values are named like the field — or `<Field>Item` /
    // `<Field>Value` when a sibling takes the singular name — exactly as
    // `schemaToTypeRef` references them (`elementContextName`).
    if (fieldSchema.type === 'array' && fieldSchema.items?.properties) {
      const itemContext = elementContextName(fieldName, 'item', siblings, name, fieldSchema.items);
      nestedModels.push(
        ...extractInlineModelDeep(qualifyNestedInlineName(name, itemContext), fieldSchema.items, schemas),
      );
    }

    if (fieldSchema.type === 'object' && !fieldSchema.properties) {
      const valueSchema = mapValueSchema(fieldSchema);
      if (valueSchema && !valueSchema.$ref && valueSchema.properties) {
        const valueContext = elementContextName(fieldName, 'value', siblings, name, valueSchema);
        nestedModels.push(...extractInlineModelDeep(qualifyNestedInlineName(name, valueContext), valueSchema, schemas));
      }
    }

    if (fieldSchema.allOf) {
      const mergedProperties: Record<string, SchemaObject | undefined> = {};
      const mergedRequired: string[] = [];
      for (const sub of fieldSchema.allOf) {
        if (sub.properties) Object.assign(mergedProperties, sub.properties);
        if (sub.required) mergedRequired.push(...sub.required);
      }
      if (Object.keys(mergedProperties).length > 0) {
        nestedModels.push(
          ...extractInlineModelDeep(
            qualifyNestedInlineName(name, fieldName),
            {
              type: 'object',
              properties: mergedProperties,
              required: mergedRequired,
            },
            schemas,
          ),
        );
      }
    }

    if (fieldSchema.oneOf) {
      const inlineObjectVariants = fieldSchema.oneOf.filter((v) => isInlineObjectSchema(v));
      if (inlineObjectVariants.length > 0) {
        const variantNames = nameInlineVariants(
          fieldSchema.oneOf,
          qualifyNestedInlineName(name, fieldName),
          reservedInlineNames(fieldName, siblings, name),
        );
        for (const variant of inlineObjectVariants) {
          const variantName = variantNames.get(variant);
          if (variantName === undefined) continue;
          nestedModels.push(...extractInlineModelDeep(variantName, variant, schemas));
          // A multi-type variant's array member types its items under the
          // variant's name (`<Variant>Item`); extract them there too. The
          // synthetic wrapper model is dropped, only its nested models kept.
          const memberSchemas = variantMemberSchemas(variant, variantName);
          if (Object.keys(memberSchemas).length > 0) {
            nestedModels.push(...extractInlineModelDeep(variantName, { properties: memberSchemas }, schemas).slice(1));
          }
        }
      }
    }
  }

  return [{ name, description: schema.description, fields }, ...nestedModels];
}

function qualifyNestedInlineName(parentName: string, fieldName: string): string {
  const pascalField = toPascalCase(fieldName);
  if (pascalField.startsWith(parentName)) return pascalField;

  const cleanParent = stripListItemMarkers(parentName);
  const qualified = `${cleanParent}${pascalField}`;
  const match = qualified.match(/^(.+?)([A-Z][a-z]+s?)$/);
  if (match && match[2]) {
    return match[1] + singularize(match[2]);
  }
  return qualified;
}

/**
 * `elementContextName` for an optional context: with no field name there is
 * nothing to decide, and the items / values keep an undefined context.
 */
function elementContext(
  contextName: string | undefined,
  kind: 'item' | 'value',
  siblingProperties: ReadonlyMap<string, SchemaObject> | undefined,
  parentModelName: string | undefined,
  elementSchema: SchemaObject,
): string | undefined {
  return contextName === undefined
    ? undefined
    : elementContextName(contextName, kind, siblingProperties, parentModelName, elementSchema);
}

export function schemaToTypeRef(
  schema: SchemaObject,
  contextName?: string,
  parentModelName?: string,
  siblingProperties?: ReadonlyMap<string, SchemaObject>,
): TypeRef {
  // Handle $ref → ModelRef or EnumRef.
  // A `$ref` to a top-level component schema needs to preserve whether the
  // target is a model or an enum, because emitters route imports differently
  // for the two kinds (e.g. com.example.models.X vs com.example.types.X). The
  // set of enum names is precomputed by extractSchemas() in a first pass so
  // it's available even when called recursively for nested $refs.
  if (schema.$ref) {
    const segments = schema.$ref.split('/');
    const rawName = segments[segments.length - 1];
    const resolved = resolveSchemaName(rawName);
    if (activeEnumSchemaNames.has(resolved)) {
      const enumRef: TypeRef = { kind: 'enum', name: resolved };
      // Carry the component's own nullability through the reference so
      // `field: { $ref: NullableEnum }` has the same shape as the inline
      // `oneOf: [{ $ref }, { type: 'null' }]` form.
      return activeNullableEnumSchemaNames.has(resolved) ? { kind: 'nullable', inner: enumRef } : enumRef;
    }
    return { kind: 'model', name: resolved };
  }

  // Handle OAS 3.1 nullable type arrays: type: [string, null]
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((t: string) => t !== 'null');
    // type: ['null'] — only null, no real type
    if (nonNullTypes.length === 0) {
      return { kind: 'nullable', inner: { kind: 'primitive', type: 'unknown' } };
    }
    // Keep `parentModelName` through the unwrap so an inline object, map
    // value, or enum under a nullable field is qualified exactly like its
    // non-nullable twin — the inline-model extractor names it that way.
    if (schema.type.includes('null') && nonNullTypes.length === 1) {
      return asNullable(
        schemaToTypeRef(
          { ...schema, type: nonNullTypes[0], nullable: false },
          contextName,
          parentModelName,
          siblingProperties,
        ),
      );
    }
    // Multiple non-null types → union
    if (nonNullTypes.length > 1) {
      const variants = nonNullTypes.map((t: string) =>
        schemaToTypeRef({ ...schema, type: t }, contextName, parentModelName, siblingProperties),
      );
      const ref: TypeRef = { kind: 'union', variants };
      if (schema.type.includes('null')) {
        return { kind: 'nullable', inner: ref };
      }
      return ref;
    }
  }

  // Handle OAS 3.0 nullable flag
  if (schema.nullable && schema.type) {
    return asNullable(schemaToTypeRef({ ...schema, nullable: false }, contextName, parentModelName, siblingProperties));
  }

  // Handle allOf — merge properties from all sub-schemas.
  // This handles patterns like: allOf: [{ type: object, properties: {...} }, { oneOf: [...] }]
  // which are valid OAS 3.1 but weren't handled for field-level schemas.
  if (schema.allOf) {
    // If allOf contains a $ref, prefer the ref (it's a named type)
    const refItem = schema.allOf.find((s: SchemaObject) => s.$ref);
    if (refItem) {
      // If allOf has $ref AND siblings with properties, return a merged model ref
      // to avoid losing the augmentation properties
      const hasAugmentation = schema.allOf.some((s: SchemaObject) => !s.$ref && (s.properties || s.type === 'object'));
      if (hasAugmentation) {
        const baseName = toPascalCase(contextName ?? 'UnknownModel');
        return { kind: 'model', name: qualifyInlineModelName(baseName, parentModelName) };
      }
      return schemaToTypeRef(refItem, contextName, parentModelName);
    }
    // If allOf has a single item, unwrap it
    if (schema.allOf.length === 1) {
      return schemaToTypeRef(schema.allOf[0], contextName, parentModelName, siblingProperties);
    }
    // If allOf items all have properties, treat as a merged model
    const hasProperties = schema.allOf.some((s: SchemaObject) => s.properties);
    if (hasProperties) {
      const baseName = toPascalCase(contextName ?? 'UnknownModel');
      return {
        kind: 'model',
        name: qualifyInlineModelName(baseName, parentModelName),
      };
    }
    // Fall through to other checks
  }

  // Handle oneOf / anyOf → Union or Nullable
  // Valid OAS 3.1: properties can have { oneOf: [{ type: object }, { type: 'null' }] }
  // without a wrapping `type` field.
  if (schema.oneOf || schema.anyOf) {
    const compositionKind: 'oneOf' | 'anyOf' = schema.oneOf ? 'oneOf' : 'anyOf';
    const rawVariants: SchemaObject[] = schema.oneOf ?? schema.anyOf ?? [];

    // Check for nullable pattern: oneOf: [realType, { type: 'null' }]
    const nullVariant = rawVariants.find(
      (v: SchemaObject) => v.type === 'null' || (Array.isArray(v.type) && v.type.length === 1 && v.type[0] === 'null'),
    );
    const nonNullVariants = rawVariants.filter((v) => v !== nullVariant);

    if (nullVariant && nonNullVariants.length === 1) {
      // Nullable single type — unwrap as nullable. `asNullable` keeps a
      // `$ref` to an already-nullable enum component from double-wrapping.
      return asNullable(schemaToTypeRef(nonNullVariants[0], contextName, parentModelName, siblingProperties));
    }

    // Collapse an oneOf/anyOf whose non-null variants are all string-const
    // schemas into a single enum. This turns patterns like
    //   provider: { oneOf: [{ const: "AppleOAuth" }, { const: "GitHubOAuth" }, ...] }
    // into a proper enum type with one member per variant instead of a
    // structurally-opaque union of literal refs.
    const literalStrings = collectLiteralStringConsts(nonNullVariants);
    if (literalStrings !== null && literalStrings.length >= 2) {
      const enumRef = buildSyntheticEnumRef(literalStrings, contextName, parentModelName);
      return nullVariant ? { kind: 'nullable', inner: enumRef } : enumRef;
    }

    // Resolve the discriminator. Three sources, in order:
    //   1. Explicit `discriminator:` with explicit `mapping:` — trust the spec.
    //   2. Explicit `discriminator:` with no `mapping:` — derive mapping from
    //      variants' const values on the discriminator property, pairing each
    //      to its inline-extracted variant model name (built the same way
    //      `extractNestedSchema` names them via `nameInlineVariant`). This
    //      covers `ApiKey.owner`-shaped schemas where the spec uses
    //      `discriminator: { propertyName: type }` but lists inline anonymous
    //      `oneOf` variants instead of `$ref` links.
    //   3. No explicit discriminator but every variant pins the same const-
    //      valued property AND the variants are nameable via $ref/title —
    //      `detectConstPropertyDiscriminator` covers this.
    //   4. As a last resort, when (3) doesn't apply because variants are
    //      inline anonymous objects, derive the same const → variant-model-
    //      name mapping using `nameInlineVariant`. This covers
    //      `ApiKeyCreatedData.owner`-shaped schemas (oneOf with inline
    //      const-discriminating variants but no `discriminator:` keyword).
    let resolvedDiscriminator: { property: string; mapping: Record<string, string> } | undefined;
    if (schema.discriminator) {
      const property = schema.discriminator.propertyName;
      const explicitMapping = schema.discriminator.mapping ?? {};
      let mapping: Record<string, string> = Object.fromEntries(
        Object.entries(explicitMapping).map(([k, v]) => [k, v.replace(/^#\/components\/schemas\//, '')]),
      );
      if (Object.keys(mapping).length === 0) {
        const inlineMapping = deriveInlineVariantMapping(
          nonNullVariants,
          property,
          contextName,
          parentModelName,
          siblingProperties,
        );
        if (inlineMapping) mapping = inlineMapping;
      }
      resolvedDiscriminator = { property, mapping };
    } else if (compositionKind === 'oneOf') {
      const synthetic = detectConstPropertyDiscriminator(nonNullVariants);
      if (synthetic) {
        resolvedDiscriminator = synthetic;
      } else {
        const namingDisc = deriveConstNamingDiscriminator(nonNullVariants);
        if (namingDisc) {
          const inlineMapping = deriveInlineVariantMapping(
            nonNullVariants,
            namingDisc.property,
            contextName,
            parentModelName,
            siblingProperties,
          );
          if (inlineMapping) {
            resolvedDiscriminator = { property: namingDisc.property, mapping: inlineMapping };
          }
        }
      }
    }

    // Build variants. An inline object variant is referenced by the name its
    // extracted model carries: the discriminator mapping's entry when one
    // resolves for it, otherwise the position-based name from
    // `nameInlineObjectVariants`. Falling back to `schemaToTypeRef` instead
    // would hand every inline variant the same parent-derived name (e.g.
    // `ApiKeyOwner`), collapsing the union onto one repeated model ref while
    // the extractor emits `ApiKeyOwner`, `ApiKeyOwner2`, ... for them.
    // The named ref replaces only the `object` member of what `schemaToTypeRef`
    // would build for the variant: a nullable variant (`['object', 'null']`,
    // OAS 3.0 `nullable: true`) keeps its wrapper, and a multi-type variant
    // (`['object', 'string']`) keeps its other alternatives in a union — see
    // `inlineVariantTypeRef`. The extractor emits the model under the same
    // name in every case.
    const inlineVariantNames = nameInlineObjectVariants(
      nonNullVariants,
      contextName,
      parentModelName,
      siblingProperties,
    );
    const variants: TypeRef[] = [];
    for (const v of rawVariants) {
      if (v === nullVariant) continue;
      const inlineName = inlineVariantNames.get(v);
      if (inlineName) {
        const mappedName = resolvedDiscriminator ? mapVariantToDiscriminatorEntry(v, resolvedDiscriminator) : null;
        variants.push(inlineVariantTypeRef(v, mappedName ?? inlineName));
      } else {
        variants.push(schemaToTypeRef(v, contextName, parentModelName));
      }
    }
    const hasNull = !!nullVariant;

    const union: TypeRef = {
      kind: 'union',
      variants,
      compositionKind,
      ...(resolvedDiscriminator ? { discriminator: resolvedDiscriminator } : {}),
    };
    return hasNull ? { kind: 'nullable', inner: union } : union;
  }

  // Handle const → LiteralType (supports string, number, boolean)
  if (schema.const !== undefined) {
    if (typeof schema.const === 'string' || typeof schema.const === 'number' || typeof schema.const === 'boolean') {
      return { kind: 'literal', value: schema.const };
    }
    // null const → nullable unknown
    if (schema.const === null) {
      return { kind: 'nullable', inner: { kind: 'primitive', type: 'unknown' } };
    }
    // const of object/array → map or array with unknown values
    if (typeof schema.const === 'object') {
      if (Array.isArray(schema.const)) {
        return { kind: 'array', items: { kind: 'primitive', type: 'unknown' } };
      }
      return { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } };
    }
  }
  // A `null` member of an inline `enum:` marks nullability, not a value.
  // Strip it before deciding literal-vs-enum, and wrap the result so a
  // bare `type: 'string', enum: ['a', null]` is nullable even without a
  // `type: [..., 'null']` array (the array branch above already wrapped
  // us when present; `asNullable` keeps that from doubling up).
  const enumValues = nonNullEnumValues(schema.enum);
  const enumAdmitsNull = schema.enum !== undefined && enumValues.length !== schema.enum.length;
  if (schema.enum && enumValues.length === 1) {
    const v = enumValues[0];
    const literal: TypeRef = { kind: 'literal', value: typeof v === 'number' ? v : String(v) };
    return enumAdmitsNull ? asNullable(literal) : literal;
  }

  // Handle enum
  if (schema.enum) {
    const baseName = toPascalCase(contextName ?? 'UnknownEnum');
    // Strip ListItem/ByExternalId markers from parent name so enum names are clean:
    // e.g., DirectoryListItem + State → Directory + State = DirectoryState
    const cleanParent = parentModelName ? stripListItemMarkers(parentModelName) : undefined;
    // Avoid redundant prefix: Connection + ConnectionType → ConnectionType
    const qualifiedName = cleanParent && !baseName.startsWith(cleanParent) ? `${cleanParent}${baseName}` : baseName;
    // Run `schemaNameTransform` so project-level rename maps in
    // `oagen.config.ts` reach inline parameter/field enums too — without
    // this, `RadarAction` (built from path param `action` on the Radar
    // service) couldn't be redirected to `RadarListAction` from config.
    const finalName = activeSchemaNameTransform ? activeSchemaNameTransform(qualifiedName) : qualifiedName;
    const enumRef: TypeRef = {
      kind: 'enum',
      name: finalName,
      values: enumValues.map((v) => (typeof v === 'number' ? v : String(v))),
    };
    return enumAdmitsNull ? asNullable(enumRef) : enumRef;
  }

  // Handle array — pass parentModelName through to qualify inline items. The
  // items' context is the field itself, or `<field>_item` when a sibling
  // property would take the singular name (`elementContextName`), so an
  // inline object item is `<Parent><Field>` or `<Parent><Field>Item`.
  if (schema.type === 'array' && schema.items) {
    return {
      kind: 'array',
      items: schemaToTypeRef(
        schema.items,
        elementContext(contextName, 'item', siblingProperties, parentModelName, schema.items),
        parentModelName,
      ),
    };
  }
  // Handle array without explicit type but with items (valid OAS 3.1)
  if (!schema.type && schema.items) {
    return {
      kind: 'array',
      items: schemaToTypeRef(
        schema.items,
        elementContext(contextName, 'item', siblingProperties, parentModelName, schema.items),
        parentModelName,
      ),
    };
  }

  // Handle object → ModelRef (if it has properties, it's a named model reference)
  // When additionalProperties is also present, we still return a ModelRef so the
  // named properties are preserved. The extractModel path will pick up the extra
  // properties as a catch-all map field named `additionalProperties`.
  if (schema.type === 'object' && schema.properties) {
    const baseName = toPascalCase(contextName ?? 'UnknownModel');
    return {
      kind: 'model',
      name: qualifyInlineModelName(baseName, parentModelName),
    };
  }

  // Handle freeform object with additionalProperties or patternProperties → Map<string, T>
  // The value schema is typed with the field's own `contextName` and
  // `parentModelName`, exactly like array items, so an inline object value is
  // referenced as `${Parent}${SingularField}` (`layers` on
  // `CreateDrawingRequest` → `CreateDrawingRequestLayer`) and the inline-model
  // extractor (`extractInlineModelsFromProperties`) emits a model of that name.
  // When a sibling property would take that singular name the values use
  // `<field>_value` instead (`<Parent><Field>Value`, see `elementContextName`).
  if (schema.type === 'object' && !schema.properties) {
    // `mapValueSchema` picks the value schema in this branch's precedence: a
    // non-empty `additionalProperties` object, else the first
    // `patternProperties` entry; `additionalProperties: {}` or `true` means
    // "any value" and stays unknown.
    let valueType: TypeRef = { kind: 'primitive', type: 'unknown' };
    const valueSchema = mapValueSchema(schema);
    if (valueSchema) {
      const valueContext = elementContext(contextName, 'value', siblingProperties, parentModelName, valueSchema);
      valueType = schemaToTypeRef(valueSchema, valueContext, parentModelName);
    }
    return {
      kind: 'map',
      valueType,
    };
  }

  // Handle primitives
  const primitiveMap: Record<string, 'string' | 'integer' | 'number' | 'boolean'> = {
    string: 'string',
    integer: 'integer',
    number: 'number',
    boolean: 'boolean',
  };

  const typeStr = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (typeStr && primitiveMap[typeStr]) {
    return {
      kind: 'primitive',
      type: primitiveMap[typeStr],
      ...(schema.format ? { format: schema.format } : {}),
    };
  }

  // Handle schemas with no type — if it has properties, treat as model
  if (!schema.type && schema.properties) {
    const baseName = toPascalCase(contextName ?? 'UnknownModel');
    return {
      kind: 'model',
      name: qualifyInlineModelName(baseName, parentModelName),
    };
  }

  // Empty schema {} → unknown
  if (
    !schema.type &&
    !schema.$ref &&
    !schema.oneOf &&
    !schema.anyOf &&
    !schema.allOf &&
    !schema.enum &&
    !schema.properties &&
    !schema.items
  ) {
    return { kind: 'primitive', type: 'unknown' };
  }

  // Fallback: treat unknown schemas as unknown
  if (contextName) {
    console.warn(`[oagen] Warning: Unknown schema shape treated as unknown (context: ${contextName})`);
  }
  return { kind: 'primitive', type: 'unknown' };
}

import {
  collectProperties,
  elementContextName,
  mapValueSchema,
  qualifyInlineModelName,
  reservedInlineNames,
} from './inline-models.js';

export { qualifyInlineModelName, extractInlineModelsFromSchemas } from './inline-models.js';
