/** Test-only config that registers a minimal emitter for CLI dry-run tests. */
import type { ApiSpec, EmitterContext } from '../../src/index.js';

export default {
  emitters: [
    {
      language: 'node',
      generateModels: () => [],
      generateEnums: () => [],
      generateResources: () => [],
      generateClient: (_spec: ApiSpec, ctx: EmitterContext) => [
        { path: `${ctx.namespace}/client.ts`, content: '// client' },
      ],
      generateErrors: () => [],
      generateConfig: () => [],
      generateTypeSignatures: () => [],
      generateTests: () => [],
      fileHeader: () => '// auto-generated',
    },
  ],
};
