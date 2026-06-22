import type { ApiSpec, Model, Enum, Service } from '../ir/types.js';
import type { ResolvedOperation } from '../ir/operation-hints.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';

export interface GeneratedFile {
  path: string;
  content: string;
  skipIfExists?: boolean;
  headerPlacement?: 'prepend' | 'skip';
  /** When false, exclude this file from --target integration. Defaults to true. */
  integrateTarget?: boolean;
  /** When true, always overwrite existing file instead of merging. Defaults to false. */
  overwriteExisting?: boolean;
}

export interface EmitterContext {
  namespace: string;
  namespacePascal: string;
  spec: ApiSpec;
  outputDir?: string;
  apiSurface?: ApiSurface;
  overlayLookup?: OverlayLookup;
  /** Resolved operations from the hint-aware resolver. Populated by buildEmitterContext(). */
  resolvedOperations?: ResolvedOperation[];
  /**
   * Model-placement pins from `OagenConfig.modelHints`. Emitters that call
   * `assignModelsToServices` should pass this through so hinted models land in
   * the configured service instead of the default first-reference winner.
   */
  modelHints?: Record<string, string>;
  /** Language-specific emitter options from config for the active emitter. */
  emitterOptions?: Record<string, unknown>;
  /** Absolute path to the integration target directory (when --target is used). */
  targetDir?: string;
  /**
   * Scoped-generation signal: the set of POST-MOUNT service names a `--services`
   * run selected. When present and non-empty, emitters must emit ONLY these
   * services' per-service resource/test files, while still emitting models,
   * enums, the root client, and all aggregate/barrel files from the FULL spec
   * (so shared files stay byte-identical and a brand-new selected service is
   * wired into the client automatically). Absent/empty ⇒ full generation.
   */
  scopedServices?: Set<string>;
  /**
   * Scoped-generation model/enum allow-lists: names of models/enums reachable
   * from the selected services. When `scopedServices` is active,
   * emitters must write a per-model/per-enum FILE only when its name is in these
   * sets — but must still include EVERY model/enum (the full set passed to
   * generateModels/generateEnums) in barrels/indexes, so on-disk files for
   * out-of-scope models (left untouched) stay importable. Absent ⇒ write all.
   */
  scopedModelNames?: Set<string>;
  scopedEnumNames?: Set<string>;
  /**
   * Paths (relative to the output/target dir) that the previous run wrote,
   * loaded from that directory's `.oagen-manifest.json`. Emitters can use this
   * to distinguish "file exists because oagen wrote it last time" from "file
   * exists because a human wrote it" — the former is safe to overwrite, the
   * latter should be merged.
   */
  priorTargetManifestPaths?: Set<string>;
}

export interface FormatCommand {
  /** The executable to run (e.g., "npx", "gofmt", "bundle"). */
  cmd: string;
  /** Arguments before the file list (e.g., ["prettier", "--write"]). */
  args: string[];
  /** Max files per invocation (to avoid OS arg-length limits). Defaults to 100. */
  batchSize?: number;
}

/** Maps "METHOD /path" to SDK method info. Values may be arrays for polymorphic operations. */
export type OperationsMapEntry = { sdkMethod: string; service: string };
export type OperationsMap = Record<string, OperationsMapEntry | OperationsMapEntry[]>;

export interface Emitter {
  language: string;

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[];

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[];

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[];

  generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  generateErrors(ctx: EmitterContext): GeneratedFile[];

  generateTypeSignatures?(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  /** Optional: build operation-to-SDK-method mapping, stored in .oagen-manifest.json */
  buildOperationsMap?(spec: ApiSpec, ctx: EmitterContext): OperationsMap;

  fileHeader(): string;

  /**
   * Optional: return a format command to run on generated files after target
   * integration.  The emitter can inspect the target directory to detect the
   * project's formatter (e.g., prettier config, .editorconfig, Gemfile).
   * Return null to skip formatting.
   */
  formatCommand?(targetDir: string): FormatCommand | null;
}
