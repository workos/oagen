import { RegistryError } from '../errors.js';
import type { Extractor } from './types.js';

const extractors = new Map<string, Extractor>();

export function registerExtractor(extractor: Extractor): void {
  extractors.set(extractor.language, extractor);
}

export function getExtractor(language: string): Extractor {
  const extractor = extractors.get(language);
  if (!extractor) {
    const available = [...extractors.keys()].join(', ') || '(none)';
    throw new RegistryError(
      `No extractor registered for language: ${language}. Available: ${available}`,
      `Register an extractor for "${language}" via registerExtractor() or add one in your oagen.config.ts plugin.`,
    );
  }
  return extractor;
}
