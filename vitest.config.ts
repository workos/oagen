import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Let examples/ resolve @workos/oagen without a workspace link
      '@workos/oagen': resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    // The CLI tests spawn the CLI per case, and a few parser tests parse large
    // documents; under a loaded machine they pass the default 5 s and time out
    // without hanging. 20 s keeps a real hang visible and stops the reruns.
    testTimeout: 20_000,
  },
});
