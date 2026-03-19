import { RegistryError } from '../errors.js';
import type { Emitter } from './types.js';

const emitters = new Map<string, Emitter>();

export function registerEmitter(emitter: Emitter): void {
  emitters.set(emitter.language, emitter);
}

export function getEmitter(language: string): Emitter {
  const emitter = emitters.get(language);
  if (!emitter) {
    const available = [...emitters.keys()].join(', ') || '(none)';
    throw new RegistryError(
      `Unknown language: ${language}. Available: ${available}`,
      `Register an emitter for "${language}" via registerEmitter() or check your oagen.config.ts plugin configuration.`,
    );
  }
  return emitter;
}
