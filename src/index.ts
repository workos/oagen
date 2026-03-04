export type {
  ApiSpec,
  Service,
  Operation,
  HttpMethod,
  Parameter,
  TypeRef,
  PrimitiveType,
  ArrayType,
  ModelRef,
  EnumRef,
  UnionType,
  NullableType,
  Model,
  Field,
  Enum,
  EnumValue,
  ErrorResponse,
} from "./ir/types.js";

export { parseSpec } from "./parser/parse.js";
