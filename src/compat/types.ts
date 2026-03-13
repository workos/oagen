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
  value: string;
}

export interface ApiEnum {
  name: string;
  members: Record<string, string | number>;
}

export interface Extractor {
  language: string;
  extract(sdkPath: string): Promise<ApiSurface>;
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
