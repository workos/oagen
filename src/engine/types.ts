import type { ApiSpec, Model, Enum, Service } from '../ir/types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';

export interface GeneratedFile {
  path: string;
  content: string;
  skipIfExists?: boolean;
  headerPlacement?: 'prepend' | 'skip';
  /** When false, exclude this file from --target integration. Defaults to true. */
  integrateTarget?: boolean;
  /** Controls merge behavior: 'full' (default) adds symbols/members/imports;
   *  'docstring-only' only updates docstrings and ensures the header. */
  mergeMode?: 'full' | 'docstring-only';
}

export interface EmitterContext {
  namespace: string;
  namespacePascal: string;
  spec: ApiSpec;
  outputDir?: string;
  apiSurface?: ApiSurface;
  overlayLookup?: OverlayLookup;
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
}
