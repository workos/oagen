import { describe, it, expect } from 'vitest';
import { generateEnums } from '../../../src/emitters/ruby/enums.js';
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

describe('generateEnums', () => {
  it('generates a module-based enum with symbol values', () => {
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
    expect(files[0].path).toBe('lib/work_os/models/organization_status.rb');

    const content = files[0].content;
    expect(content).toContain('module OrganizationStatus');
    expect(content).toContain('extend WorkOS::Internal::Type::Enum');
    expect(content).toContain('ACTIVE = :active');
    expect(content).toContain('INACTIVE = :inactive');
    expect(content).toContain('PENDING = :pending');
    // Should NOT contain class-based enum
    expect(content).not.toContain('class OrganizationStatus');
  });

  it('generates multiple enums as separate files', () => {
    const enums: Enum[] = [
      { name: 'Status', values: [{ name: 'active', value: 'active' }] },
      { name: 'Role', values: [{ name: 'admin', value: 'admin' }] },
    ];

    const files = generateEnums(enums, ctx);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('lib/work_os/models/status.rb');
    expect(files[1].path).toBe('lib/work_os/models/role.rb');
  });
});
