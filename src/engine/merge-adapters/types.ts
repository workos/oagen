import type Parser from 'tree-sitter';

export interface MergeStatement {
  key: string | null;
  text: string;
  kind: 'import' | 'reexport' | 'declaration' | 'other';
}

export interface ParsedMergeFile {
  statements: MergeStatement[];
}

export interface MergeAdapter {
  language: string;
  grammarModule: string;
  resolveGrammar?(mod: unknown): unknown;
  parseStatements(tree: Parser.Tree, source: string): ParsedMergeFile;
  normalizeImport?(text: string): string;
  normalizeReexport?(text: string): string;
}
