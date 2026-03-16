/** IR contract version. Bump when a TypeRef variant is added or a required field is added to any IR node. */
export const IR_VERSION = 1;

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
export type TypeRef = PrimitiveType | ArrayType | ModelRef | EnumRef | UnionType | NullableType | LiteralType;

export interface PrimitiveType {
  kind: 'primitive';
  type: 'string' | 'integer' | 'number' | 'boolean';
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

/** Model definition (maps to an SDK model/data class) */
export interface Model {
  name: string;
  description?: string;
  fields: Field[];
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
  throw new Error(`Unexpected TypeRef kind: ${(x as TypeRef).kind}`);
}

export interface ErrorResponse {
  statusCode: number;
  type?: TypeRef;
}
