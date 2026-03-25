import type Parser from 'tree-sitter';

export interface MergeImport {
  key: string;
  text: string;
}

export interface MergeStatement {
  key: string | null;
  text: string;
  kind: 'reexport' | 'declaration' | 'other';
}

export interface ParsedMergeFile {
  imports: MergeImport[];
  importAnchors: string[];
  importInsertionAnchor?: string;
  statements: MergeStatement[];
}

export interface MergeMember {
  key: string;
  text: string;
}

export interface DeepMergeSymbol {
  members: MergeMember[];
  /** 0-based line number of the closing brace (for insertion point). */
  bodyEndLine: number;
  /** Indentation string for members (e.g., '  ', '    ', '\t'). Detected from existing members. */
  memberIndent?: string;
}

export interface DocstringInfo {
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface MemberDocstrings {
  docstring: DocstringInfo | null;
  declStartIndex: number;
  declColumn: number;
  /** URL path fingerprint extracted from the method body (e.g., "/organizations/{}"). Used as a fallback matching key when method names differ. */
  urlFingerprint?: string;
}

export interface SymbolDocstrings {
  docstring: DocstringInfo | null;
  declStartIndex: number;
  declColumn: number;
  members: Map<string, MemberDocstrings>;
}

/**
 * Configuration for generic tree-sitter-based URL fingerprint extraction.
 * Each language adapter provides the AST node type names specific to its grammar.
 */
export interface UrlFingerprintConfig {
  /** AST node types representing string literals or interpolated strings (e.g., ['string', 'template_string']). */
  stringNodeTypes: string[];
  /** AST node types for the literal text fragments inside strings (e.g., ['string_fragment', 'string_content']). */
  contentNodeTypes: string[];
  /** AST node types for interpolation expressions within strings (e.g., ['template_substitution']). Normalized to '{}'. */
  interpolationNodeTypes: string[];
  /** For languages where URLs are built via formatting functions (Go's fmt.Sprintf, Rust's format!). */
  formatFunctionNames?: string[];
}

export interface MergeAdapter {
  language: string;
  grammarModule: string;
  resolveGrammar?(mod: unknown): unknown;
  parseStatements(tree: Parser.Tree, source: string): ParsedMergeFile;
  normalizeReexport?(text: string): string;
  renderImports?(imports: MergeImport[]): string[];
  extractMembers?(tree: Parser.Tree, source: string): Map<string, DeepMergeSymbol>;
  extractDocstrings(tree: Parser.Tree, source: string): Map<string, SymbolDocstrings>;
  /** Patterns that identify test files. Test files are never merged into existing tests. */
  testFilePatterns?: RegExp[];
  /**
   * Return true to skip deep-merging new members into an existing symbol.
   * Use this when new members reference dependencies the existing symbol doesn't provide.
   */
  shouldSkipDeepMerge?(symbolName: string, existingMemberKeys: Set<string>, newMembers: MergeMember[]): boolean;
  /** Configuration for generic URL fingerprint extraction from method bodies. */
  urlFingerprintConfig?: UrlFingerprintConfig;
}
