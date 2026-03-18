import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Emitter } from '../engine/types.js';
import type { Extractor } from '../compat/types.js';
import { IR_VERSION } from '../ir/types.js';
import { ConfigLoadError, ConfigVersionMismatchError } from '../errors.js';

export interface OagenConfig {
  emitters?: Emitter[];
  extractors?: Extractor[];
  /** Path to the emitter project (where skills scaffold new emitters, tests, smoke runners). */
  emitterProject?: string;
  /** Map from language key to custom smoke runner script path. */
  smokeRunners?: Record<string, string>;
  irVersion?: number;
  /**
   * Custom transform for operation IDs. When provided, replaces the default
   * camelCase pass-through. Receives the raw operationId string; return the
   * desired operation name (no additional conversion is applied).
   *
   * For NestJS-style operationIds (`FooController_bar` → `bar`), use the
   * built-in `nestjsOperationIdTransform` from `@workos/oagen`.
   */
  operationIdTransform?: (id: string) => string;
}

const CONFIG_NAMES = ['oagen.config.ts', 'oagen.config.js', 'oagen.config.mjs'];

export async function loadConfig(cwd: string = process.cwd()): Promise<OagenConfig | null> {
  for (const name of CONFIG_NAMES) {
    const configPath = path.resolve(cwd, name);
    if (!existsSync(configPath)) continue;
    try {
      const mod = await import(pathToFileURL(configPath).href);
      const config = (mod.default ?? mod) as OagenConfig;
      if (config.irVersion !== undefined && config.irVersion !== IR_VERSION) {
        throw new ConfigVersionMismatchError(
          `IR version mismatch: config declares irVersion ${config.irVersion} but oagen uses IR_VERSION ${IR_VERSION}.`,
          'Update your emitter to match the installed @workos/oagen version.',
        );
      }
      return config;
    } catch (err) {
      if (err instanceof ConfigVersionMismatchError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigLoadError(
        `Failed to load ${name}: ${message}`,
        name.endsWith('.ts')
          ? 'TypeScript config files require tsx or ts-node. Use .mjs instead, or run via `npx tsx`.'
          : 'Check that the config file is valid ESM.',
      );
    }
  }
  return null;
}
