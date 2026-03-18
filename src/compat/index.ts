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
} from './types.js';

export { getExtractor, registerExtractor } from './extractor-registry.js';
export { buildOverlayLookup, patchOverlay } from './overlay.js';
export { diffSurfaces, specDerivedNames, specDerivedFieldPaths, filterSurface } from './differ.js';
export { nodeExtractor } from './extractors/node.js';
export { phpExtractor } from './extractors/php.js';
export { pythonExtractor } from './extractors/python.js';
export { rubyExtractor } from './extractors/ruby.js';
export { goExtractor } from './extractors/go.js';
export { rustExtractor } from './extractors/rust.js';
export { nodeHints, resolveHints } from './language-hints.js';
