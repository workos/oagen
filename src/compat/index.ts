// Legacy types (preserved for backward compatibility)
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

// New compat IR types
export type {
  LanguageId,
  CompatSnapshot,
  CompatSymbol,
  CompatSymbolKind,
  CompatVisibility,
  CompatStability,
  CompatSourceKind,
  CompatParameter,
  CompatPassingStyle,
  ParameterSensitivity,
  CompatTypeRef,
} from './ir.js';
export { apiSurfaceToSnapshot } from './ir.js';

// Schema versioning
export { COMPAT_SCHEMA_VERSION, isCompatibleSchemaVersion, validateSnapshot } from './schema.js';

// Language policy
export type { CompatPolicyHints } from './policy.js';
export { getDefaultPolicy, mergePolicy, ALL_LANGUAGE_IDS } from './policy.js';

// Compat config types
export type {
  CompatConfig,
  CompatApproval,
  CompatChangeCategory,
  BreakingChangeCategory,
  SoftRiskChangeCategory,
  AdditiveChangeCategory,
  CompatChangeSeverity,
  CompatProvenance,
  CompatFailLevel,
} from './config.js';
export { defaultSeverityForCategory, severityMeetsThreshold } from './config.js';

// Classification
export type { ClassifiedChange, ClassificationResult } from './classify.js';
export { classifySymbolChanges, classifyAddedSymbol, summarizeChanges } from './classify.js';

// Differ (legacy + new)
export type { CompatDiffResult } from './differ.js';
export {
  diffSurfaces,
  diffSnapshots,
  specDerivedNames,
  specDerivedFieldPaths,
  specDerivedMethodPaths,
  specDerivedEnumValues,
  specDerivedHttpKeys,
  filterSurface,
} from './differ.js';

// Conceptual change grouping
export type { ConceptualChange, ConceptualRollup } from './concepts.js';
export { buildConceptualRollup, highestSeverity, summarizeConceptualChanges } from './concepts.js';

// Reports
export type { CompatReport, CompatReportChange, ConceptualReport } from './report.js';
export { generateReport, formatHumanSummary, generateConceptualReport, formatConceptualSummary } from './report.js';

// Approvals
export type { ApprovalMatch, ApprovalValidation } from './approvals.js';
export { validateApproval, validateApprovals, matchApproval, applyApprovals, unapprovedChanges } from './approvals.js';

// Existing infrastructure
export { getExtractor, registerExtractor } from './extractor-registry.js';
export { buildOverlayLookup, patchOverlay, isPatchableChange } from './overlay.js';
export { nodeExtractor } from './extractors/node.js';
export { phpExtractor } from './extractors/php.js';
export { pythonExtractor } from './extractors/python.js';
export { rubyExtractor } from './extractors/ruby.js';
export { goExtractor } from './extractors/go.js';
export { rustExtractor } from './extractors/rust.js';
export { kotlinExtractor } from './extractors/kotlin.js';
export { dotnetExtractor } from './extractors/dotnet.js';
export { elixirExtractor } from './extractors/elixir.js';
export { nodeHints, resolveHints } from './language-hints.js';
