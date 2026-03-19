// Core IR
export type {
  ApiSpec,
  AuthScheme,
  Service,
  Operation,
  PaginationMeta,
  HttpMethod,
  Parameter,
  TypeRef,
  PrimitiveType,
  ArrayType,
  ModelRef,
  EnumRef,
  LiteralType,
  UnionType,
  NullableType,
  MapType,
  Model,
  TypeParam,
  Field,
  Enum,
  EnumValue,
  ErrorResponse,
} from './ir/types.js';

export { assertNever, walkTypeRef, mapTypeRef } from './ir/types.js';

// Errors
export {
  OagenError,
  CommandError,
  SpecParseError,
  ConfigError,
  ConfigLoadError,
  ConfigVersionMismatchError,
  ExtractorError,
  RegistryError,
  InternalError,
} from './errors.js';

// Generation
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

// Core parse + generate
export { parseSpec } from './parser/parse.js';
export { generate } from './engine/orchestrator.js';
export { generateFiles, buildEmitterContext, generateAllFiles, applyFileHeaders } from './engine/generate-files.js';
export { integrateGeneratedFiles, mapFilesForTargetIntegration } from './engine/integrate.js';
export { getEmitter, registerEmitter } from './engine/registry.js';
export { diffSpecs } from './differ/diff.js';
export { mapChangesToFiles } from './differ/file-map.js';
export { generateIncremental } from './engine/incremental.js';

// Utilities
export {
  toSnakeCase,
  toCamelCase,
  toPascalCase,
  toKebabCase,
  toUpperSnakeCase,
  stripBackendPrefixes,
  cleanSchemaName,
  ACRONYM_SET,
} from './utils/naming.js';
export { planOperation } from './engine/operation-plan.js';
export type { OperationPlan } from './engine/operation-plan.js';

// Config typing for emitter projects
export type { OagenConfig } from './cli/config-loader.js';
