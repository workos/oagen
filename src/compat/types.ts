export interface ApiSurface {
  language: string;
  extractedFrom: string;
  extractedAt: string;
  classes: Record<string, ApiClass>;
  interfaces: Record<string, ApiInterface>;
  typeAliases: Record<string, ApiTypeAlias>;
  enums: Record<string, ApiEnum>;
  exports: Record<string, string[]>;
}

export interface ApiClass {
  name: string;
  sourceFile?: string;
  methods: Record<string, ApiMethod>;
  properties: Record<string, ApiProperty>;
  constructorParams: ApiParam[];
}

export interface ApiMethod {
  name: string;
  params: ApiParam[];
  returnType: string;
  async: boolean;
}

export interface ApiParam {
  name: string;
  type: string;
  optional: boolean;
}

export interface ApiProperty {
  name: string;
  type: string;
  readonly: boolean;
}

export interface ApiInterface {
  name: string;
  sourceFile?: string;
  fields: Record<string, ApiField>;
  extends: string[];
}

export interface ApiField {
  name: string;
  type: string;
  optional: boolean;
}

export interface ApiTypeAlias {
  name: string;
  sourceFile?: string;
  value: string;
}

export interface ApiEnum {
  name: string;
  sourceFile?: string;
  members: Record<string, string | number>;
}

export interface LanguageHints {
  /** Strip nullable wrapper, return inner type. null if not nullable.
   *  Node: "string | null" → "string"
   *  Go: "*Organization" → "Organization"
   *  Python: "Optional[str]" → "str" */
  stripNullable(type: string): string | null;

  /** True if a and b differ only by nullability. */
  isNullableOnlyDifference(a: string, b: string): boolean;

  /** True if a and b are union types with same members in different order. */
  isUnionReorder(a: string, b: string): boolean;

  /** True if type is a generic type parameter the extractor can't resolve. */
  isGenericTypeParam(type: string): boolean;

  /** True if type is an extraction artifact (extractor couldn't resolve).
   *  Node: "any"; Python: "Any"; Go: "interface{}" */
  isExtractionArtifact(type: string): boolean;

  /** Whether a missing type alias should be tolerated when the candidate
   *  has the same name as an interface or class (TS allows this). */
  tolerateCategoryMismatch: boolean;

  /** Extract innermost meaningful type name from a return type string.
   *  Node: "Promise<AutoPaginatable<Organization>>" → "Organization" */
  extractReturnTypeName(returnType: string): string | null;

  /** Extract meaningful type name from a param type string. null for primitives. */
  extractParamTypeName(paramType: string): string | null;

  /** True if sdkResourceProperty maps to className.
   *  Node: camelCase ("organizations" → "Organizations")
   *  Ruby: snake_case ("organizations" → "Organizations") */
  propertyMatchesClass(propertyName: string, className: string): boolean;

  /** Additional names derived from a model name by this language's emitter.
   *  Node: ["FooResponse", "SerializedFoo"]
   *  Go: ["FooResponse"] */
  derivedModelNames(modelName: string): string[];

  /** True if two type strings are semantically equivalent even when
   *  structurally different — e.g., a named enum vs an inline union
   *  of its string literal values. The candidate surface is provided
   *  so the hint can look up enum definitions.
   *  Returns true to suppress the mismatch, false to report it. */
  isTypeEquivalent?(baselineType: string, candidateType: string, candidateSurface: ApiSurface): boolean;
}

export interface Extractor {
  language: string;
  extract(sdkPath: string): Promise<ApiSurface>;
  hints: LanguageHints;
}

export interface MethodOverlay {
  className: string;
  methodName: string;
  params: ApiParam[];
  returnType: string;
}

export interface OverlayLookup {
  /** HTTP method + path → existing method info */
  methodByOperation: Map<string, MethodOverlay>;
  /** Reverse map: "ClassName.methodName" → HTTP key for patchOverlay */
  httpKeyByMethod: Map<string, string>;
  /** IR interface name → existing interface name */
  interfaceByName: Map<string, string>;
  /** IR type alias name → existing type alias name */
  typeAliasByName: Map<string, string>;
  /** Barrel file path → symbols that must be exported */
  requiredExports: Map<string, Set<string>>;
  /** IR model name → SDK interface name (auto-inferred from field structure) */
  modelNameByIR: Map<string, string>;
}

export type ViolationCategory = 'public-api' | 'signature' | 'export-structure' | 'behavioral';
export type ViolationSeverity = 'breaking' | 'warning';

export interface Violation {
  category: ViolationCategory;
  severity: ViolationSeverity;
  symbolPath: string;
  baseline: string;
  candidate: string;
  message: string;
}

export interface Addition {
  symbolPath: string;
  symbolType: 'class' | 'method' | 'interface' | 'type-alias' | 'enum' | 'property';
}

export interface DiffResult {
  preservationScore: number;
  totalBaselineSymbols: number;
  preservedSymbols: number;
  violations: Violation[];
  additions: Addition[];
}
