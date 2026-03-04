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

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface Parameter {
  name: string;
  type: TypeRef;
  required: boolean;
  description?: string;
}

/** Type reference — the core type system of the IR */
export type TypeRef =
  | PrimitiveType
  | ArrayType
  | ModelRef
  | EnumRef
  | UnionType
  | NullableType;

export interface PrimitiveType {
  kind: "primitive";
  type: "string" | "integer" | "number" | "boolean";
  format?: string;
}

export interface ArrayType {
  kind: "array";
  items: TypeRef;
}

export interface ModelRef {
  kind: "model";
  name: string;
}

export interface EnumRef {
  kind: "enum";
  name: string;
}

export interface UnionType {
  kind: "union";
  variants: TypeRef[];
  discriminator?: { property: string; mapping: Record<string, string> };
}

export interface NullableType {
  kind: "nullable";
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

export interface ErrorResponse {
  statusCode: number;
  type?: TypeRef;
}
