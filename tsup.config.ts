import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    target: 'node20',
  },
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    clean: false,
    target: 'node20',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
