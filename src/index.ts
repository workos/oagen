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
} from './ir/types.js';

export type { GeneratedFile, EmitterContext, Emitter } from './engine/types.js';

export { parseSpec } from './parser/parse.js';
export { generate } from './engine/orchestrator.js';
export { getEmitter, registerEmitter } from './engine/registry.js';
