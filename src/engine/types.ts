import type { ApiSpec, Model, Enum, Service } from "../ir/types.js";

export interface GeneratedFile {
  path: string;
  content: string;
  header?: string;
}

export interface EmitterContext {
  namespace: string;
  namespacePascal: string;
  spec: ApiSpec;
}

export interface Emitter {
  language: string;

  generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[];

  generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[];

  generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[];

  generateClient(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  generateErrors(ctx: EmitterContext): GeneratedFile[];

  generateConfig(ctx: EmitterContext): GeneratedFile[];

  generateTypeSignatures(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  generateTests(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[];

  fileHeader(): string;
}
