import type { Extractor } from './types.js';

const extractors = new Map<string, Extractor>();

export function registerExtractor(extractor: Extractor): void {
  extractors.set(extractor.language, extractor);
}

export function getExtractor(language: string): Extractor {
  const extractor = extractors.get(language);
  if (!extractor) {
    const available = [...extractors.keys()].join(', ') || '(none)';
    throw new Error(`No extractor registered for language: ${language}. Available: ${available}`);
  }
  return extractor;
}
