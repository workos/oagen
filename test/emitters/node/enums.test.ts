import { describe, it, expect } from 'vitest';
import { generateEnums } from '../../../src/emitters/node/enums.js';
import type { EmitterContext } from '../../../src/engine/types.js';
import type { Enum, ApiSpec } from '../../../src/ir/types.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'work_os',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateEnums (node)', () => {
  it('generates string literal union types', () => {
    const enums: Enum[] = [
      {
        name: 'OrganizationStatus',
        values: [
          { name: 'active', value: 'active' },
          { name: 'inactive', value: 'inactive' },
          { name: 'pending', value: 'pending' },
        ],
      },
    ];

    const files = generateEnums(enums, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/common/interfaces/organization-status.interface.ts');

    const content = files[0].content;
    expect(content).toContain("export type OrganizationStatus = 'active' | 'inactive' | 'pending';");
    // Should NOT contain TS enum keyword
    expect(content).not.toContain('enum OrganizationStatus');
  });

  it('generates multiple enums as separate files', () => {
    const enums: Enum[] = [
      { name: 'Status', values: [{ name: 'active', value: 'active' }] },
      { name: 'Role', values: [{ name: 'admin', value: 'admin' }] },
    ];

    const files = generateEnums(enums, ctx);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('src/common/interfaces/status.interface.ts');
    expect(files[1].path).toBe('src/common/interfaces/role.interface.ts');
  });

  it('handles single-value enums', () => {
    const enums: Enum[] = [
      { name: 'Singleton', values: [{ name: 'only', value: 'only' }] },
    ];

    const files = generateEnums(enums, ctx);
    expect(files[0].content).toContain("export type Singleton = 'only';");
  });
});
