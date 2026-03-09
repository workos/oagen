import { describe, it, expect } from 'vitest';
import { mapChangesToFiles } from '../../src/differ/file-map.js';
import type { Change } from '../../src/differ/types.js';
import type { Emitter, EmitterContext } from '../../src/engine/types.js';
import type { ApiSpec, Model, Service } from '../../src/ir/types.js';

function mockEmitter(): Emitter {
  return {
    language: 'mock',
    generateModels: (models) => models.map((m) => ({ path: `models/${m.name.toLowerCase()}.rb`, content: '' })),
    generateEnums: (enums) => enums.map((e) => ({ path: `models/${e.name.toLowerCase()}.rb`, content: '' })),
    generateResources: (services) =>
      services.map((s) => ({ path: `resources/${s.name.toLowerCase()}.rb`, content: '' })),
    generateClient: () => [{ path: 'client.rb', content: '' }],
    generateErrors: () => [{ path: 'errors.rb', content: '' }],
    generateConfig: () => [{ path: 'config.rb', content: '' }],
    generateTypeSignatures: (spec) => [
      ...spec.models.map((m) => ({ path: `sig/${m.name.toLowerCase()}.rbs`, content: '' })),
      ...spec.services.map((s) => ({ path: `sig/${s.name.toLowerCase()}.rbs`, content: '' })),
    ],
    generateTests: (spec) => spec.services.map((s) => ({ path: `test/test_${s.name.toLowerCase()}.rb`, content: '' })),
    fileHeader: () => '# generated',
  };
}

const spec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
  models: [
    {
      name: 'User',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    },
    {
      name: 'Team',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    },
  ],
  enums: [{ name: 'Status', values: [{ name: 'active', value: 'active' }] }],
  services: [
    {
      name: 'Users',
      operations: [
        {
          name: 'getUser',
          httpMethod: 'get',
          path: '/users/{id}',
          pathParams: [],
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
};

const ctx: EmitterContext = {
  namespace: 'test',
  namespacePascal: 'Test',
  spec,
};

describe('mapChangesToFiles', () => {
  it('model added maps to model + sig files', () => {
    const changes: Change[] = [{ kind: 'model-added', name: 'Team', classification: 'additive' }];
    const result = mapChangesToFiles(changes, mockEmitter(), ctx);
    expect(result.regenerate).toContain('models/team.rb');
    expect(result.regenerate).toContain('sig/team.rbs');
    expect(result.delete).toHaveLength(0);
  });

  it('model removed maps to delete list', () => {
    const changes: Change[] = [{ kind: 'model-removed', name: 'Team', classification: 'breaking' }];
    const result = mapChangesToFiles(changes, mockEmitter(), ctx);
    expect(result.delete).toContain('models/team.rb');
    expect(result.delete).toContain('sig/team.rbs');
  });

  it('model modified cascades to referencing service', () => {
    const changes: Change[] = [
      {
        kind: 'model-modified',
        name: 'User',
        fieldChanges: [{ kind: 'field-added', fieldName: 'avatar', classification: 'additive' }],
        classification: 'additive',
      },
    ];
    const result = mapChangesToFiles(changes, mockEmitter(), ctx);
    expect(result.regenerate).toContain('models/user.rb');
    expect(result.regenerate).toContain('sig/user.rbs');
    // Cascades to Users service since it references User model
    expect(result.regenerate).toContain('resources/users.rb');
    expect(result.regenerate).toContain('test/test_users.rb');
  });

  it('operation added maps to service files', () => {
    const changes: Change[] = [
      {
        kind: 'operation-added',
        serviceName: 'Users',
        operationName: 'deleteUser',
        classification: 'additive',
      },
    ];
    const result = mapChangesToFiles(changes, mockEmitter(), ctx);
    expect(result.regenerate).toContain('resources/users.rb');
    expect(result.regenerate).toContain('test/test_users.rb');
  });

  it('service removed maps to delete list', () => {
    const changes: Change[] = [{ kind: 'service-removed', name: 'Users', classification: 'breaking' }];
    const result = mapChangesToFiles(changes, mockEmitter(), ctx);
    expect(result.delete).toContain('resources/users.rb');
    expect(result.delete).toContain('test/test_users.rb');
    expect(result.delete).toContain('sig/users.rbs');
  });

  it('enum added maps to enum file', () => {
    const changes: Change[] = [{ kind: 'enum-added', name: 'Status', classification: 'additive' }];
    const result = mapChangesToFiles(changes, mockEmitter(), ctx);
    expect(result.regenerate).toContain('models/status.rb');
  });

  it('deleted files are not in regenerate list', () => {
    const changes: Change[] = [{ kind: 'model-removed', name: 'Team', classification: 'breaking' }];
    const result = mapChangesToFiles(changes, mockEmitter(), ctx);
    for (const f of result.delete) {
      expect(result.regenerate).not.toContain(f);
    }
  });

  it('enum modified cascades to referencing services', () => {
    const specWithEnumRef: ApiSpec = {
      ...spec,
      services: [
        {
          name: 'Users',
          operations: [
            {
              name: 'getUser',
              httpMethod: 'get',
              path: '/users/{id}',
              pathParams: [],
              queryParams: [{ name: 'status', type: { kind: 'enum', name: 'Status' }, required: false }],
              headerParams: [],
              response: { kind: 'model', name: 'User' },
              errors: [],
              paginated: false,
              idempotent: false,
            },
          ],
        },
      ],
    };
    const ctxWithRef: EmitterContext = { namespace: 'test', namespacePascal: 'Test', spec: specWithEnumRef };
    const changes: Change[] = [
      {
        kind: 'enum-modified',
        name: 'Status',
        valueChanges: [{ kind: 'value-added', valueName: 'pending', classification: 'additive' }],
        classification: 'additive',
      },
    ];
    const result = mapChangesToFiles(changes, mockEmitter(), ctxWithRef);
    expect(result.regenerate).toContain('models/status.rb');
    expect(result.regenerate).toContain('resources/users.rb');
  });

  it('enum removed cascades to referencing services', () => {
    const specWithEnumRef: ApiSpec = {
      ...spec,
      services: [
        {
          name: 'Users',
          operations: [
            {
              name: 'getUser',
              httpMethod: 'get',
              path: '/users/{id}',
              pathParams: [],
              queryParams: [{ name: 'status', type: { kind: 'enum', name: 'Status' }, required: false }],
              headerParams: [],
              response: { kind: 'model', name: 'User' },
              errors: [],
              paginated: false,
              idempotent: false,
            },
          ],
        },
      ],
    };
    const ctxWithRef: EmitterContext = { namespace: 'test', namespacePascal: 'Test', spec: specWithEnumRef };
    const changes: Change[] = [{ kind: 'enum-removed', name: 'Status', classification: 'breaking' }];
    const result = mapChangesToFiles(changes, mockEmitter(), ctxWithRef);
    expect(result.delete).toContain('models/status.rb');
    expect(result.regenerate).toContain('resources/users.rb');
  });

  it('model referenced by multiple services cascades to all', () => {
    const multiServiceSpec: ApiSpec = {
      ...spec,
      services: [
        {
          name: 'Users',
          operations: [
            {
              name: 'getUser',
              httpMethod: 'get',
              path: '/users/{id}',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'User' },
              errors: [],
              paginated: false,
              idempotent: false,
            },
          ],
        },
        {
          name: 'Admin',
          operations: [
            {
              name: 'getAdminUser',
              httpMethod: 'get',
              path: '/admin/users/{id}',
              pathParams: [],
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
    };
    const ctxMulti: EmitterContext = { namespace: 'test', namespacePascal: 'Test', spec: multiServiceSpec };
    const changes: Change[] = [
      {
        kind: 'model-modified',
        name: 'User',
        fieldChanges: [{ kind: 'field-added', fieldName: 'avatar', classification: 'additive' }],
        classification: 'additive',
      },
    ];
    const result = mapChangesToFiles(changes, mockEmitter(), ctxMulti);
    expect(result.regenerate).toContain('resources/users.rb');
    expect(result.regenerate).toContain('resources/admin.rb');
  });

  it('model not referenced by any service has no cascade', () => {
    const noRefSpec: ApiSpec = {
      ...spec,
      services: [
        {
          name: 'Teams',
          operations: [
            {
              name: 'getTeam',
              httpMethod: 'get',
              path: '/teams/{id}',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'model', name: 'Team' },
              errors: [],
              paginated: false,
              idempotent: false,
            },
          ],
        },
      ],
    };
    const ctxNoRef: EmitterContext = { namespace: 'test', namespacePascal: 'Test', spec: noRefSpec };
    const changes: Change[] = [
      {
        kind: 'model-modified',
        name: 'User',
        fieldChanges: [{ kind: 'field-added', fieldName: 'avatar', classification: 'additive' }],
        classification: 'additive',
      },
    ];
    const result = mapChangesToFiles(changes, mockEmitter(), ctxNoRef);
    expect(result.regenerate).toContain('models/user.rb');
    expect(result.regenerate).not.toContain('resources/teams.rb');
  });
});
