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

export { assertNever, walkTypeRef, IR_VERSION } from './ir/types.js';

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

export type {
  ApiSurface,
  ApiClass,
  ApiMethod,
  ApiParam,
  ApiProperty,
  ApiInterface,
  ApiField,
  ApiTypeAlias,
  ApiEnum,
  Extractor,
  LanguageHints,
  MethodOverlay,
  OverlayLookup,
  ViolationCategory,
  ViolationSeverity,
  Violation,
  Addition,
  DiffResult,
} from './compat/types.js';

export { parseSpec } from './parser/parse.js';
export { generate } from './engine/orchestrator.js';
export { getEmitter, registerEmitter } from './engine/registry.js';
export { getExtractor, registerExtractor } from './compat/extractor-registry.js';
export { diffSpecs } from './differ/diff.js';
export { mapChangesToFiles } from './differ/file-map.js';
export { generateIncremental } from './engine/incremental.js';
export { buildOverlayLookup, patchOverlay } from './compat/overlay.js';
export { diffSurfaces, specDerivedNames, filterSurface } from './compat/differ.js';
export {
  toSnakeCase,
  toCamelCase,
  toPascalCase,
  toKebabCase,
  toUpperSnakeCase,
  stripBackendPrefixes,
  cleanSchemaName,
} from './utils/naming.js';

export { nodeExtractor } from './compat/extractors/node.js';
export { nodeHints, resolveHints } from './compat/language-hints.js';
export { planOperation } from './engine/operation-plan.js';
export type { OperationPlan } from './engine/operation-plan.js';
export type { OagenConfig } from './cli/config-loader.js';
export type { VerifyDiagnostics } from './cli/verify.js';
