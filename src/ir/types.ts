import type { SdkBehavior } from './sdk-behavior.js';

/** Authentication scheme extracted from OpenAPI securitySchemes */
export type AuthScheme =
  | { kind: 'bearer' }
  | { kind: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string }
  | { kind: 'oauth2'; flows: Record<string, unknown> };

/** Root IR node representing the full API surface */
/** A server entry from the OpenAPI servers array */
export interface ServerEntry {
  url: string;
  description?: string;
}

/** Root IR node representing the full API surface */
export interface ApiSpec {
  name: string;
  version: string;
  description?: string;
  baseUrl: string;
  servers?: ServerEntry[];
  services: Service[];
  models: Model[];
  enums: Enum[];
  auth?: AuthScheme[];
  /** Language-agnostic runtime policies (retry, errors, telemetry, etc.). */
  sdk: SdkBehavior;
}

/** A service groups related operations (maps to an SDK resource class) */
export interface Service {
  name: string;
  description?: string;
  operations: Operation[];
}

/** A single API operation (maps to an SDK method) */
/** Per-operation security requirement: scheme name → scope list. */
export interface SecurityRequirement {
  schemeName: string;
  scopes: string[];
}

export interface Operation {
  name: string;
  description?: string;
  httpMethod: HttpMethod;
  path: string;
  pathParams: Parameter[];
  queryParams: Parameter[];
  headerParams: Parameter[];
  cookieParams?: Parameter[];
  requestBody?: TypeRef;
  requestBodyEncoding?: 'json' | 'form-data' | 'form-urlencoded' | 'binary' | 'text';
  response: TypeRef;
  successResponses?: SuccessResponse[];
  errors: ErrorResponse[];
  pagination?: PaginationMeta;
  injectIdempotencyKey: boolean;
  deprecated?: boolean;
  async?: boolean;
  /** Per-operation security overrides. When present, overrides the global spec-level security. */
  security?: SecurityRequirement[];
}

/** Structured pagination metadata for auto-paging iterator generation */
export interface PaginationMeta {
  strategy: 'cursor' | 'offset' | 'link-header';
  param: string;
  limitParam?: string;
  dataPath?: string;
  itemType: TypeRef;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'trace';

export interface Parameter {
  name: string;
  type: TypeRef;
  required: boolean;
  description?: string;
  deprecated?: boolean;
  default?: unknown;
  example?: unknown;
  style?: 'form' | 'simple' | 'label' | 'matrix';
  explode?: boolean;
}

/** Type reference — the core type system of the IR */
export type TypeRef = PrimitiveType | ArrayType | ModelRef | EnumRef | UnionType | NullableType | LiteralType | MapType;

export interface PrimitiveType {
  kind: 'primitive';
  type: 'string' | 'integer' | 'number' | 'boolean' | 'unknown';
  format?: string;
}

export interface ArrayType {
  kind: 'array';
  items: TypeRef;
}

export interface ModelRef {
  kind: 'model';
  name: string;
}

export interface EnumRef {
  kind: 'enum';
  name: string;
  values?: (string | number)[];
}

export interface LiteralType {
  kind: 'literal';
  value: string | number | boolean | null;
}

export interface UnionType {
  kind: 'union';
  variants: TypeRef[];
  discriminator?: { property: string; mapping: Record<string, string> };
  /** Which OAS composition keyword produced this union. Emitters can use this to
   *  distinguish inheritance (allOf) from exclusive union (oneOf) from open union (anyOf). */
  compositionKind?: 'allOf' | 'oneOf' | 'anyOf';
}

export interface NullableType {
  kind: 'nullable';
  inner: TypeRef;
}

export interface MapType {
  kind: 'map';
  valueType: TypeRef;
  keyType?: TypeRef;
}

/**
 * A generic type parameter on a model.
 * Example: `DirectoryUser<TCustomAttributes = Record<string, unknown>>`
 * → `{ name: 'TCustomAttributes', default: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } } }`
 */
export interface TypeParam {
  name: string;
  /** Default type when the param is not specified. */
  default?: TypeRef;
}

/** Model definition (maps to an SDK model/data class) */
export interface Model {
  name: string;
  description?: string;
  fields: Field[];
  /** Generic type parameters. Empty/undefined for non-generic models. */
  typeParams?: TypeParam[];
}

export interface Field {
  name: string;
  type: TypeRef;
  required: boolean;
  description?: string;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  default?: unknown;
  example?: unknown;
}

/** Enum definition */
export interface Enum {
  name: string;
  values: EnumValue[];
}

export interface EnumValue {
  name: string;
  value: string | number;
  description?: string;
  deprecated?: boolean;
}

/**
 * Exhaustive check helper for TypeRef switches.
 * If a new kind is added to TypeRef, any switch that doesn't handle it
 * will fail to compile because `never` won't accept the unhandled variant.
 *
 * Usage:
 *   switch (ref.kind) {
 *     case 'primitive': ...
 *     case 'array': ...
 *     // If you forget 'literal', TypeScript errors here:
 *     default: assertNever(ref);
 *   }
 */
export function assertNever(x: never): never {
  // Inline to avoid importing from ../errors.js (ir/ is layer 0, must not import upward)
  const kind = (x as TypeRef).kind;
  const err = new Error(
    `Unexpected TypeRef kind: ${kind}\nHint: If you added a new TypeRef variant, handle it in every switch/case that calls assertNever.`,
  );
  err.name = 'InternalError';
  throw err;
}

/**
 * Generic depth-first walker for TypeRef trees.
 * Handles recursion into array/nullable/union/map children and provides
 * an exhaustive `assertNever` check so callers don't need to repeat the
 * switch boilerplate.  Supply callbacks only for the leaf kinds you care about.
 */
export function walkTypeRef(
  ref: TypeRef,
  visitor: {
    model?: (ref: ModelRef) => void;
    enum?: (ref: EnumRef) => void;
    primitive?: (ref: PrimitiveType) => void;
    literal?: (ref: LiteralType) => void;
  },
): void {
  switch (ref.kind) {
    case 'model':
      visitor.model?.(ref);
      break;
    case 'enum':
      visitor.enum?.(ref);
      break;
    case 'array':
      walkTypeRef(ref.items, visitor);
      break;
    case 'nullable':
      walkTypeRef(ref.inner, visitor);
      break;
    case 'union':
      for (const v of ref.variants) walkTypeRef(v, visitor);
      break;
    case 'map':
      if (ref.keyType) walkTypeRef(ref.keyType, visitor);
      walkTypeRef(ref.valueType, visitor);
      break;
    case 'literal':
      visitor.literal?.(ref);
      break;
    case 'primitive':
      visitor.primitive?.(ref);
      break;
    default:
      assertNever(ref);
  }
}

/**
 * Generic depth-first mapper for TypeRef trees.
 * Like walkTypeRef but returns a transformed value instead of void.
 * Handles recursion into array/nullable/union/map children, passing
 * already-mapped child values to the parent callback.
 */
export function mapTypeRef<T>(
  ref: TypeRef,
  mapper: {
    primitive: (ref: PrimitiveType) => T;
    array: (ref: ArrayType, mappedItems: T) => T;
    model: (ref: ModelRef) => T;
    enum: (ref: EnumRef) => T;
    union: (ref: UnionType, mappedVariants: T[]) => T;
    nullable: (ref: NullableType, mappedInner: T) => T;
    literal: (ref: LiteralType) => T;
    map: (ref: MapType, mappedValue: T, mappedKey?: T) => T;
  },
): T {
  switch (ref.kind) {
    case 'primitive':
      return mapper.primitive(ref);
    case 'array':
      return mapper.array(ref, mapTypeRef(ref.items, mapper));
    case 'model':
      return mapper.model(ref);
    case 'enum':
      return mapper.enum(ref);
    case 'union':
      return mapper.union(
        ref,
        ref.variants.map((v) => mapTypeRef(v, mapper)),
      );
    case 'nullable':
      return mapper.nullable(ref, mapTypeRef(ref.inner, mapper));
    case 'literal':
      return mapper.literal(ref);
    case 'map':
      return mapper.map(
        ref,
        mapTypeRef(ref.valueType, mapper),
        ref.keyType ? mapTypeRef(ref.keyType, mapper) : undefined,
      );
    default:
      return assertNever(ref);
  }
}

// --- IR traversal utilities ---

/**
 * Collect all model names referenced (directly or transitively) by a TypeRef.
 */
export function collectModelRefs(ref: TypeRef): string[] {
  const names: string[] = [];
  walkTypeRef(ref, { model: (r) => names.push(r.name) });
  return names;
}

/**
 * Collect all enum names referenced by a TypeRef.
 */
export function collectEnumRefs(ref: TypeRef): string[] {
  const names: string[] = [];
  walkTypeRef(ref, { enum: (r) => names.push(r.name) });
  return names;
}

/**
 * Collect all TypeRef-referenced model and enum names from a model's fields.
 * Returns { models, enums } sets for generating import statements.
 */
export function collectFieldDependencies(model: Model): {
  models: Set<string>;
  enums: Set<string>;
} {
  const models = new Set<string>();
  const enums = new Set<string>();

  for (const field of model.fields) {
    for (const name of collectModelRefs(field.type)) {
      if (name !== model.name) models.add(name);
    }
    for (const name of collectEnumRefs(field.type)) {
      enums.add(name);
    }
  }

  return { models, enums };
}

/**
 * Assign each model to the service that first references it.
 * Models referenced by multiple services are assigned to the first.
 * Models not referenced by any service are unassigned (absent from the map).
 */
export function assignModelsToServices(models: Model[], services: Service[]): Map<string, string> {
  const modelToService = new Map<string, string>();
  const modelNames = new Set(models.map((m) => m.name));

  for (const service of services) {
    const referencedModels = new Set<string>();

    for (const op of service.operations) {
      if (op.requestBody) {
        for (const name of collectModelRefs(op.requestBody)) {
          referencedModels.add(name);
        }
      }
      for (const name of collectModelRefs(op.response)) {
        referencedModels.add(name);
      }
      for (const param of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        for (const name of collectModelRefs(param.type)) {
          referencedModels.add(name);
        }
      }
      if (op.pagination) {
        for (const name of collectModelRefs(op.pagination.itemType)) {
          referencedModels.add(name);
        }
      }
    }

    // Transitively collect models referenced by the directly-referenced models
    const toVisit = [...referencedModels];
    while (toVisit.length > 0) {
      const name = toVisit.pop()!;
      const model = models.find((m) => m.name === name);
      if (!model) continue;
      for (const field of model.fields) {
        for (const ref of collectModelRefs(field.type)) {
          if (!referencedModels.has(ref) && modelNames.has(ref)) {
            referencedModels.add(ref);
            toVisit.push(ref);
          }
        }
      }
    }

    for (const name of referencedModels) {
      if (!modelToService.has(name)) {
        modelToService.set(name, service.name);
      }
    }
  }

  return modelToService;
}

/**
 * Collect all model names referenced as request bodies across all services.
 */
export function collectRequestBodyModels(services: Service[]): Set<string> {
  const result = new Set<string>();
  for (const service of services) {
    for (const op of service.operations) {
      if (op.requestBody) {
        for (const name of collectModelRefs(op.requestBody)) {
          result.add(name);
        }
      }
    }
  }
  return result;
}

export interface ErrorResponse {
  statusCode: number;
  type?: TypeRef;
}

/** A successful response entry from a 2xx status code */
export interface SuccessResponse {
  statusCode: number;
  type: TypeRef;
}
