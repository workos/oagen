import type { ApiSpec, Model, Enum, Service } from '../ir/types.js';
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
}

export interface FormatCommand {
  /** The executable to run (e.g., "npx", "gofmt", "bundle"). */
  cmd: string;
  /** Arguments before the file list (e.g., ["prettier", "--write"]). */
  args: string[];
  /** Max files per invocation (to avoid OS arg-length limits). Defaults to 100. */
  batchSize?: number;
}

export interface Emitter {
  language: string;

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[];

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[];

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[];

  generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  generateErrors(ctx: EmitterContext): GeneratedFile[];

  generateConfig(ctx: EmitterContext): GeneratedFile[];

  generateTypeSignatures?(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  /** Optional: generate a smoke-manifest.json mapping operationIds to SDK methods */
  generateManifest?(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  fileHeader(): string;

  /**
   * Optional: return a format command to run on generated files after target
   * integration.  The emitter can inspect the target directory to detect the
   * project's formatter (e.g., prettier config, .editorconfig, Gemfile).
   * Return null to skip formatting.
   */
  formatCommand?(targetDir: string): FormatCommand | null;
}
