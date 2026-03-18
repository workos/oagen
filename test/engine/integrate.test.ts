import { describe, it, expect } from 'vitest';
import { mapFilesForTargetIntegration } from '../../src/engine/integrate.js';
import type { GeneratedFile } from '../../src/engine/types.js';

describe('mapFilesForTargetIntegration', () => {
  it('includes files by default (no flag set)', () => {
    const files: GeneratedFile[] = [
      { path: 'node/src/models/user.ts', content: 'export interface User {}' },
    ];
    const result = mapFilesForTargetIntegration(files, 'node');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/models/user.ts');
  });

  it('excludes files with integrateTarget: false', () => {
    const files: GeneratedFile[] = [
      { path: 'node/src/workos.ts', content: 'export class WorkOS {}', integrateTarget: false },
    ];
    const result = mapFilesForTargetIntegration(files, 'node');
    expect(result).toHaveLength(0);
  });

  it('includes files with skipIfExists: true (regression test)', () => {
    const files: GeneratedFile[] = [
      { path: 'node/src/resources/sso.ts', content: 'export class SSO {}', skipIfExists: true },
    ];
    const result = mapFilesForTargetIntegration(files, 'node');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/resources/sso.ts');
  });

  it('excludes files with both skipIfExists: true and integrateTarget: false', () => {
    const files: GeneratedFile[] = [
      { path: 'node/src/workos.ts', content: 'export class WorkOS {}', skipIfExists: true, integrateTarget: false },
    ];
    const result = mapFilesForTargetIntegration(files, 'node');
    expect(result).toHaveLength(0);
  });

  it('strips language prefix from paths', () => {
    const files: GeneratedFile[] = [
      { path: 'node/src/index.ts', content: 'export {}' },
      { path: 'src/other.ts', content: 'export {}' },
    ];
    const result = mapFilesForTargetIntegration(files, 'node');
    expect(result[0].path).toBe('src/index.ts');
    expect(result[1].path).toBe('src/other.ts');
  });
});
