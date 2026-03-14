import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Emitter } from '../engine/types.js';
import type { Extractor } from '../compat/types.js';

export interface OagenConfig {
  emitters?: Emitter[];
  extractors?: Extractor[];
  /** Map from language key to custom smoke runner script path. */
  smokeRunners?: Record<string, string>;
  /** @deprecated Use `smokeRunners` (per-language map) instead. */
  smokeRunner?: string;
}

const CONFIG_NAMES = ['oagen.config.ts', 'oagen.config.js', 'oagen.config.mjs'];

export async function loadConfig(cwd: string = process.cwd()): Promise<OagenConfig | null> {
  for (const name of CONFIG_NAMES) {
    const configPath = path.resolve(cwd, name);
    if (!existsSync(configPath)) continue;
    try {
      const mod = await import(pathToFileURL(configPath).href);
      return (mod.default ?? mod) as OagenConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to load ${name}: ${message}`);
      console.error(
        name.endsWith('.ts')
          ? 'TypeScript config files require tsx or ts-node. Use .mjs instead, or run via `npx tsx`.'
          : 'Check that the config file is valid ESM.',
      );
      process.exit(1);
    }
  }
  return null;
}
