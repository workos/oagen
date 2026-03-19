import { describe, it, expect } from 'vitest';
import { parseSpec, generateFiles } from '../../../src/index.js';
import { typescriptEmitter } from '../../../examples/reference-emitter/src/index.js';
import * as path from 'node:path';

const specPath = path.resolve(__dirname, '../../../examples/reference-emitter/spec/github-subset.yml');

describe('reference emitter integration', () => {
  it('parses fixture spec and generates files via full pipeline', async () => {
    const ir = await parseSpec(specPath);
    const { files } = generateFiles(ir, typescriptEmitter, {
      namespace: 'GitHub',
      outputDir: '/tmp/test-output',
    });

    expect(files.length).toBeGreaterThan(0);

    const paths = files.map((f) => f.path);

    // Core files expected
    expect(paths).toContain('models.ts');
    expect(paths).toContain('enums.ts');
    expect(paths).toContain('client.ts');
    expect(paths).toContain('errors.ts');
    expect(paths).toContain('config.ts');

    // Resource files per service
    expect(paths.some((p) => p.startsWith('resources/'))).toBe(true);
  });

  it('produces deterministic output across runs', async () => {
    const ir = await parseSpec(specPath);

    const run1 = generateFiles(ir, typescriptEmitter, {
      namespace: 'GitHub',
      outputDir: '/tmp/test-1',
    });
    const run2 = generateFiles(ir, typescriptEmitter, {
      namespace: 'GitHub',
      outputDir: '/tmp/test-2',
    });

    expect(run1.files.length).toBe(run2.files.length);

    for (let i = 0; i < run1.files.length; i++) {
      expect(run1.files[i].path).toBe(run2.files[i].path);
      expect(run1.files[i].content).toBe(run2.files[i].content);
    }
  });

  it('models file contains expected interfaces from fixture spec', async () => {
    const ir = await parseSpec(specPath);
    const { files } = generateFiles(ir, typescriptEmitter, {
      namespace: 'GitHub',
      outputDir: '/tmp/test-output',
    });

    const modelsFile = files.find((f) => f.path === 'models.ts');
    expect(modelsFile).toBeDefined();
    expect(modelsFile!.content).toContain('interface Repository');
    expect(modelsFile!.content).toContain('interface Issue');
    expect(modelsFile!.content).toContain('interface Label');
    expect(modelsFile!.content).toContain('interface User');
  });

  it('detects pagination using generic envelope (results + meta)', async () => {
    const ir = await parseSpec(specPath);

    // Find the Repos service's listRepos operation
    const reposService = ir.services.find((s) => s.name === 'Repos');
    expect(reposService).toBeDefined();

    const listRepos = reposService!.operations.find((op) => op.name === 'listRepos');
    expect(listRepos).toBeDefined();
    expect(listRepos!.pagination).toBeDefined();
    expect(listRepos!.pagination!.dataPath).toBe('results');
    expect(listRepos!.pagination!.strategy).toBe('cursor');
    expect(listRepos!.pagination!.param).toBe('after');
  });

  it('detects offset pagination for labels endpoint', async () => {
    const ir = await parseSpec(specPath);

    const labelsService = ir.services.find((s) => s.name === 'Labels');
    expect(labelsService).toBeDefined();

    const listLabels = labelsService!.operations.find((op) => op.name === 'listLabels');
    expect(listLabels).toBeDefined();
    expect(listLabels!.pagination).toBeDefined();
    expect(listLabels!.pagination!.dataPath).toBe('items');
    expect(listLabels!.pagination!.strategy).toBe('offset');
    expect(listLabels!.pagination!.param).toBe('page');
    expect(listLabels!.pagination!.limitParam).toBe('per_page');
  });
});
