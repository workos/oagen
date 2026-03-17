/** IR contract version. Bump when a TypeRef variant is added or a required field is added to any IR node. */
export const IR_VERSION = 4;

/** Root IR node representing the full API surface */
export interface ApiSpec {
  name: string;
  version: string;
  description?: string;
  baseUrl: string;
  services: Service[];
  models: Model[];
  enums: Enum[];
}

/** A service groups related operations (maps to an SDK resource class) */
export interface Service {
  name: string;
  description?: string;
  operations: Operation[];
}

/** A single API operation (maps to an SDK method) */
export interface Operation {
  name: string;
  description?: string;
  httpMethod: HttpMethod;
  path: string;
  pathParams: Parameter[];
  queryParams: Parameter[];
  headerParams: Parameter[];
  requestBody?: TypeRef;
  response: TypeRef;
  errors: ErrorResponse[];
  paginated: boolean;
  idempotent: boolean;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface Parameter {
  name: string;
  type: TypeRef;
  required: boolean;
  description?: string;
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
  values?: string[];
}

export interface LiteralType {
  kind: 'literal';
  value: string;
}

export interface UnionType {
  kind: 'union';
  variants: TypeRef[];
  discriminator?: { property: string; mapping: Record<string, string> };
}

export interface NullableType {
  kind: 'nullable';
  inner: TypeRef;
}

export interface MapType {
  kind: 'map';
  valueType: TypeRef;
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
}

/** Enum definition */
export interface Enum {
  name: string;
  values: EnumValue[];
}

export interface EnumValue {
  name: string;
  value: string;
  description?: string;
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

export interface ErrorResponse {
  statusCode: number;
  type?: TypeRef;
}
