import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'compat/index': 'src/compat/index.ts',
      'verify/index': 'src/verify/index.ts',
    },
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
  {
    entry: { smoke: 'scripts/smoke/shared.ts' },
    format: ['esm'],
    dts: true,
    clean: false,
    target: 'node20',
    external: ['node:fs', 'node:path', 'node:url', 'dotenv/config'],
  },
  {
    entry: {
      'scripts/smoke/baseline': 'scripts/smoke/baseline.ts',
      'scripts/smoke/sdk-test': 'scripts/smoke/sdk-test.ts',
    },
    format: ['esm'],
    clean: false,
    target: 'node20',
    external: ['node:fs', 'node:path', 'node:url', 'node:util', 'dotenv/config'],
  },
]);
