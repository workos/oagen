import { describe, it, expect } from 'vitest';
import { generateModels } from '../../../src/emitters/node/models.js';
import type { EmitterContext } from '../../../src/engine/types.js';
import type { Model, ApiSpec } from '../../../src/ir/types.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [
    {
      name: 'Organizations',
      operations: [
        {
          name: 'getOrganization',
          httpMethod: 'get',
          path: '/organizations/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'Organization' },
          errors: [],
          paginated: false,
          idempotent: false,
        },
      ],
    },
    {
      name: 'UserManagement',
      operations: [
        {
          name: 'getUser',
          httpMethod: 'get',
          path: '/users/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'User' },
          errors: [],
          paginated: false,
          idempotent: false,
        },
      ],
    },
  ],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'work_os',
  namespacePascal: 'WorkOS',
  spec: emptySpec,
};

describe('generateModels (node)', () => {
  it('generates public interface with camelCase fields', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        description: 'An organization record',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string', format: 'uuid' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true, description: 'The org name' },
          { name: 'created_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: true },
          {
            name: 'external_id',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];

    const files = generateModels(models, ctx);

    const interfaceFile = files.find((f) => f.path.includes('interfaces/organization.interface.ts'));
    expect(interfaceFile).toBeDefined();

    const content = interfaceFile!.content;

    // Public interface (camelCase)
    expect(content).toContain('export interface Organization {');
    expect(content).toContain('/** An organization record */');
    expect(content).toContain('/** The org name */');
    expect(content).toContain('  id: string;');
    expect(content).toContain('  name: string;');
    expect(content).toContain('  createdAt: string;');
    expect(content).toContain('  externalId?: string | null;');

    // No Response interface
    expect(content).not.toContain('OrganizationResponse');
  });

  it('does not generate serializer files', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'created_at', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    const serializerFiles = files.filter((f) => f.path.includes('.serializer.'));
    expect(serializerFiles).toHaveLength(0);
  });

  it('generates model with nested model refs (public type only)', () => {
    const models: Model[] = [
      {
        name: 'Team',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'owner', type: { kind: 'model', name: 'User' }, required: true },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    const interfaceFile = files.find((f) => f.path.includes('interfaces/team.interface.ts'));
    expect(interfaceFile).toBeDefined();

    const content = interfaceFile!.content;
    expect(content).toContain('  owner: User;');
    // No Response type references
    expect(content).not.toContain('UserResponse');
  });

  it('generates model with enum refs', () => {
    const models: Model[] = [
      {
        name: 'Organization',
        fields: [{ name: 'status', type: { kind: 'enum', name: 'OrganizationStatus' }, required: true }],
      },
    ];

    const files = generateModels(models, ctx);
    const interfaceFile = files.find((f) => f.path.includes('interfaces/organization.interface.ts'));
    expect(interfaceFile!.content).toContain('  status: OrganizationStatus;');
  });

  it('generates model with array fields (public type only)', () => {
    const models: Model[] = [
      {
        name: 'Team',
        fields: [
          {
            name: 'members',
            type: { kind: 'array', items: { kind: 'model', name: 'User' } },
            required: true,
          },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    const interfaceFile = files.find((f) => f.path.includes('interfaces/team.interface.ts'));
    expect(interfaceFile!.content).toContain('  members: User[];');
    // No Response type references
    expect(interfaceFile!.content).not.toContain('UserResponse');
  });

  it('generates model with union fields (public type only)', () => {
    const models: Model[] = [
      {
        name: 'Pet',
        fields: [
          {
            name: 'data',
            type: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'Dog' },
                { kind: 'model', name: 'Cat' },
              ],
            },
            required: true,
          },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    const interfaceFile = files.find((f) => f.path.includes('interfaces/pet.interface.ts'));
    expect(interfaceFile!.content).toContain('  data: Dog | Cat;');
    // No Response type references
    expect(interfaceFile!.content).not.toContain('DogResponse');
    expect(interfaceFile!.content).not.toContain('CatResponse');
  });

  it('generates per-service barrel index files (interfaces only, no serializers)', () => {
    const models: Model[] = [
      { name: 'User', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ];

    const files = generateModels(models, ctx);

    // Organizations service barrel
    const orgInterfaceIndex = files.find((f) => f.path === 'src/organizations/interfaces/index.ts');
    expect(orgInterfaceIndex).toBeDefined();
    expect(orgInterfaceIndex!.content).toContain("export * from './organization.interface';");
    expect(orgInterfaceIndex!.content).not.toContain('user');

    // No serializer barrels
    const serializerBarrels = files.filter((f) => f.path.includes('serializers/index.ts'));
    expect(serializerBarrels).toHaveLength(0);

    // UserManagement service barrel
    const umInterfaceIndex = files.find((f) => f.path === 'src/user-management/interfaces/index.ts');
    expect(umInterfaceIndex).toBeDefined();
    expect(umInterfaceIndex!.content).toContain("export * from './user.interface';");
    expect(umInterfaceIndex!.content).not.toContain('organization');
  });

  it('maps primitive types correctly', () => {
    const models: Model[] = [
      {
        name: 'Stats',
        fields: [
          { name: 'count', type: { kind: 'primitive', type: 'integer' }, required: true },
          { name: 'ratio', type: { kind: 'primitive', type: 'number' }, required: true },
          { name: 'active', type: { kind: 'primitive', type: 'boolean' }, required: true },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    const interfaceFile = files.find((f) => f.path.includes('interfaces/stats.interface.ts'));
    expect(interfaceFile!.content).toContain('  count: number;');
    expect(interfaceFile!.content).toContain('  ratio: number;');
    expect(interfaceFile!.content).toContain('  active: boolean;');
  });

  it('distributes models to their owning service', () => {
    const models: Model[] = [
      { name: 'Organization', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      { name: 'User', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ];

    const files = generateModels(models, ctx);

    const orgInterface = files.find((f) => f.path.includes('organization.interface.ts'));
    expect(orgInterface!.path).toBe('src/organizations/interfaces/organization.interface.ts');

    const userInterface = files.find((f) => f.path.includes('user.interface.ts'));
    expect(userInterface!.path).toBe('src/user-management/interfaces/user.interface.ts');
  });

  it('falls back to common for unreferenced models', () => {
    const models: Model[] = [
      { name: 'Orphan', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
    ];

    const files = generateModels(models, ctx);

    const orphanInterface = files.find((f) => f.path.includes('orphan.interface.ts'));
    expect(orphanInterface!.path).toBe('src/common/interfaces/orphan.interface.ts');

    // No serializer files
    const orphanSerializer = files.find((f) => f.path.includes('orphan.serializer.ts'));
    expect(orphanSerializer).toBeUndefined();
  });

  it('distributes inline response models to owning service', () => {
    const specWithInline: ApiSpec = {
      ...emptySpec,
      services: [
        {
          name: 'Organizations',
          operations: [
            {
              name: 'getOrganization',
              httpMethod: 'get',
              path: '/organizations/{id}',
              pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'OrganizationDetail' },
              errors: [],
              paginated: false,
              idempotent: false,
            },
          ],
        },
      ],
    };
    const ctxWithInline: EmitterContext = { ...ctx, spec: specWithInline };

    const models: Model[] = [
      {
        name: 'OrganizationDetail',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    const files = generateModels(models, ctxWithInline);
    const interfaceFile = files.find((f) => f.path.includes('organization-detail.interface.ts'));
    expect(interfaceFile).toBeDefined();
    expect(interfaceFile!.path).toBe('src/organizations/interfaces/organization-detail.interface.ts');
  });
});
