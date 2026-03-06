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

export type {
  DiffReport,
  Change,
  ModelAdded,
  ModelRemoved,
  ModelModified,
  FieldChange,
  EnumAdded,
  EnumRemoved,
  EnumModified,
  EnumValueChange,
  ServiceAdded,
  ServiceRemoved,
  OperationAdded,
  OperationRemoved,
  OperationModified,
  ParamChange,
} from './differ/types.js';

export { parseSpec } from './parser/parse.js';
export { generate } from './engine/orchestrator.js';
export { getEmitter, registerEmitter } from './engine/registry.js';
export { diffSpecs } from './differ/diff.js';
export { mapChangesToFiles } from './differ/file-map.js';
export { generateIncremental } from './engine/incremental.js';
