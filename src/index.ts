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

export { assertNever, walkTypeRef, mapTypeRef, IR_VERSION } from './ir/types.js';

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

// Core parse + generate
export { parseSpec } from './parser/parse.js';
export { nestjsOperationIdTransform } from './parser/operations.js';
export { generate } from './engine/orchestrator.js';
export { generateFiles, buildEmitterContext, generateAllFiles, applyFileHeaders } from './engine/generate-files.js';
export { integrateGeneratedFiles, mapFilesForTargetIntegration } from './engine/integrate.js';
export { getEmitter, registerEmitter } from './engine/registry.js';
export { diffSpecs } from './differ/diff.js';
export { mapChangesToFiles } from './differ/file-map.js';
export { generateIncremental } from './engine/incremental.js';

// Compat
export { getExtractor, registerExtractor } from './compat/extractor-registry.js';
export { buildOverlayLookup, patchOverlay } from './compat/overlay.js';
export { diffSurfaces, specDerivedNames, specDerivedFieldPaths, filterSurface } from './compat/differ.js';

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

// Built-in extractors + hints
export { nodeExtractor } from './compat/extractors/node.js';
export { phpExtractor } from './compat/extractors/php.js';
export { pythonExtractor } from './compat/extractors/python.js';
export { rubyExtractor } from './compat/extractors/ruby.js';
export { goExtractor } from './compat/extractors/go.js';
export { rustExtractor } from './compat/extractors/rust.js';
export { nodeHints, resolveHints } from './compat/language-hints.js';
export { planOperation } from './engine/operation-plan.js';
export type { OperationPlan } from './engine/operation-plan.js';

// Workflow / CLI-facing types and services
export type { OagenConfig } from './cli/config-loader.js';
export type { VerifyDiagnostics } from './verify/types.js';
export { runCompatCheck } from './verify/run-compat-check.js';
export { runOverlayRetryLoop } from './verify/run-overlay-retry-loop.js';
export { runStalenessCheck } from './verify/run-staleness-check.js';
export { runSmokeCheck } from './verify/run-smoke-check.js';
