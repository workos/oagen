/** Test-only config that registers a minimal emitter for CLI dry-run tests. */
export default {
  emitters: [
    {
      language: 'node',
      generateModels: () => [],
      generateEnums: () => [],
      generateResources: () => [],
      generateClient: (_spec, ctx) => [{ path: `${ctx.namespace}/client.ts`, content: '// client' }],
      generateErrors: () => [],
      generateConfig: () => [],
      generateTypeSignatures: () => [],
      generateTests: () => [],
      fileHeader: () => '// auto-generated',
    },
  ],
};
