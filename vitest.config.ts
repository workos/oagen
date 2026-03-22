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
  },
});
