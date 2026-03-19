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
}

export interface DocstringInfo {
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface SymbolDocstrings {
  docstring: DocstringInfo | null;
  declStartIndex: number;
  declColumn: number;
  members: Map<
    string,
    {
      docstring: DocstringInfo | null;
      declStartIndex: number;
      declColumn: number;
    }
  >;
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
}
