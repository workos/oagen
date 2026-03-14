import { registerEmitter } from '../engine/registry.js';
import { registerExtractor } from '../compat/extractor-registry.js';
import type { OagenConfig } from './config-loader.js';

export function applyConfig(config: OagenConfig): void {
  for (const emitter of config.emitters ?? []) {
    registerEmitter(emitter);
  }
  for (const extractor of config.extractors ?? []) {
    registerExtractor(extractor);
  }
}
