import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Emitter } from '../engine/types.js';
import type { OperationHint } from '../ir/operation-hints.js';
import type { Extractor } from '../compat/types.js';
import type { CompatConfig } from '../compat/config.js';
import type { OpenApiDocument } from '../parser/parse.js';
import { ConfigLoadError } from '../errors.js';

export interface OagenConfig {
  emitters?: Emitter[];
  extractors?: Extractor[];
  /** Compatibility verification policy. See docs/core/compatibility-policy.md. */
  compat?: CompatConfig;
  /** Path to the emitter project (where skills scaffold new emitters, tests, smoke runners). */
  emitterProject?: string;
  /** Map from language key to custom smoke runner script path. */
  smokeRunners?: Record<string, string>;
  /**
   * Custom transform for operation IDs. When provided, replaces the default
   * camelCase pass-through. Receives the raw operationId string; return the
   * desired operation name (no additional conversion is applied).
   *
   */
  operationIdTransform?: (id: string) => string;
  /**
   * Custom transform for schema (model/enum) names. Applied after the built-in
   * cleanSchemaName normalization. Receives the cleaned PascalCase name; return
   * the desired name. Collisions are detected automatically -- if a transform
   * would produce a duplicate name, the original is kept.
   */
  schemaNameTransform?: (name: string) => string;
  /** Base URL for documentation links. When set, relative paths in descriptions
   *  (e.g. `/reference/authkit/user`) are expanded to full URLs. */
  docUrl?: string;
  /**
   * Pre-IR overlay applied to the bundled OpenAPI document before any IR
   * extraction. Use this when the upstream spec can't be changed but a quirk
   * in it would otherwise emit a breaking SDK change — e.g. rewriting a
   * path's response `$ref` back to its prior schema, merging the new fields
   * onto the prior schema, and dropping the fork schema.
   *
   * The function may mutate the document in place and return it, or return a
   * new object. Runs once, after `$ref` bundling and before schema/operation
   * extraction. See `docs/advanced/transform-spec.md` for examples.
   */
  transformSpec?: (spec: OpenApiDocument) => OpenApiDocument;
  /**
   * Per-operation overrides keyed by "METHOD /path" (e.g. "POST /sso/token").
   * Used by the operation resolver to override derived method names, mount
   * targets, and to split union-body operations into typed wrappers.
   */
  operationHints?: Record<string, OperationHint>;
  /**
   * Service-level mount rules: maps an IR service name to a target
   * service/namespace (PascalCase). All operations in the source service
   * are mounted on the target. Per-operation mountOn in operationHints
   * takes priority.
   */
  mountRules?: Record<string, string>;
  /**
   * Pin specific models to a specific IR service for placement, overriding the
   * default "first service to reference the model wins" assignment.
   *
   * Maps IR model name → IR service name (both PascalCase). Useful when a model
   * is shared across services and the natural ordering would place it in a
   * service that's wrong for the public API.
   *
   * Both names must exist in the parsed spec; unknown names throw at generation
   * time so typos fail loud. Note that keys are post-cleanSchemaName /
   * post-schemaNameTransform model names (e.g. `User`, not `UserlandUser`).
   */
  modelHints?: Record<string, string>;
}

const CONFIG_NAMES = ['oagen.config.ts', 'oagen.config.js', 'oagen.config.mjs'];

/**
 * Load an oagen config file.
 *
 * @param configPath - Explicit path to a config file. When provided, only that
 *   file is attempted (no fallback search).
 * @param cwd - Directory to search when `configPath` is omitted. Defaults to
 *   `process.cwd()`. The loader tries each name in `CONFIG_NAMES` in order.
 */
export async function loadConfig(configPath?: string, cwd: string = process.cwd()): Promise<OagenConfig | null> {
  if (configPath) {
    const resolved = path.resolve(cwd, configPath);
    if (!existsSync(resolved)) {
      throw new ConfigLoadError(`Config file not found: ${resolved}`, 'Check that the path passed to --config exists.');
    }
    try {
      const mod = await import(pathToFileURL(resolved).href);
      return (mod.default ?? mod) as OagenConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigLoadError(
        `Failed to load ${resolved}: ${message}`,
        resolved.endsWith('.ts')
          ? 'TypeScript config files require tsx or ts-node. Use .mjs instead, or run via `npx tsx`.'
          : 'Check that the config file is valid ESM.',
      );
    }
  }

  for (const name of CONFIG_NAMES) {
    const resolved = path.resolve(cwd, name);
    if (!existsSync(resolved)) continue;
    try {
      const mod = await import(pathToFileURL(resolved).href);
      const config = (mod.default ?? mod) as OagenConfig;
      return config;
    } catch (err) {
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
