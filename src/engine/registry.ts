import { RegistryError } from '../errors.js';
import { IR_VERSION } from '../ir/types.js';
import type { Emitter } from './types.js';

const emitters = new Map<string, Emitter>();

export function registerEmitter(emitter: Emitter): void {
  if (emitter.contractVersion !== undefined) {
    if (emitter.contractVersion !== IR_VERSION) {
      throw new RegistryError(
        `Emitter "${emitter.language}" declares contractVersion ${emitter.contractVersion}, but oagen requires IR_VERSION ${IR_VERSION}.`,
        `Update your emitter to match the installed @workos/oagen version (IR_VERSION ${IR_VERSION}).`,
      );
    }
  } else {
    console.warn(`Warning: Emitter "${emitter.language}" does not declare a contractVersion.`);
  }
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
