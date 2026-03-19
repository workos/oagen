import type { GeneratedFile, EmitterContext } from '@workos/oagen';

export function generateConfig(_ctx: EmitterContext): GeneratedFile[] {
  const content = `export interface ClientConfig {
  apiKey: string;
  baseUrl?: string;
}

export abstract class BaseResource {
  protected readonly config: ClientConfig;

  constructor(config: ClientConfig) {
    this.config = config;
  }
}
`;

  return [{ path: 'config.ts', content }];
}
