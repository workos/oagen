import type { Emitter } from './types.js';

const emitters = new Map<string, Emitter>();

export function registerEmitter(emitter: Emitter): void {
  emitters.set(emitter.language, emitter);
}

export function getEmitter(language: string): Emitter {
  const emitter = emitters.get(language);
  if (!emitter) {
    const available = [...emitters.keys()].join(', ') || '(none)';
    throw new Error(`Unknown language: ${language}. Available: ${available}`);
  }
  return emitter;
}
