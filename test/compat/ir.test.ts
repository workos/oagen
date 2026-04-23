import { describe, it, expect } from 'vitest';
import { apiSurfaceToSnapshot } from '../../src/compat/ir.js';
import type { ApiSurface } from '../../src/compat/types.js';

function minimalSurface(overrides?: Partial<ApiSurface>): ApiSurface {
  return {
    language: 'node',
    extractedFrom: '/test/sdk',
    extractedAt: '2026-04-22T00:00:00.000Z',
    classes: {},
    interfaces: {},
    typeAliases: {},
    enums: {},
    exports: {},
    ...overrides,
  };
}

describe('apiSurfaceToSnapshot', () => {
  it('converts an empty surface to a snapshot with no symbols', () => {
    const snapshot = apiSurfaceToSnapshot(minimalSurface());
    expect(snapshot.schemaVersion).toBe('1');
    expect(snapshot.language).toBe('node');
    expect(snapshot.symbols).toEqual([]);
  });

  it('converts classes to service_accessor + callable symbols', () => {
    const snapshot = apiSurfaceToSnapshot(
      minimalSurface({
        classes: {
          UserManagement: {
            name: 'UserManagement',
            methods: {
              createUser: [
                {
                  name: 'createUser',
                  params: [{ name: 'email', type: 'string', optional: false }],
                  returnType: 'Promise<User>',
                  async: true,
                },
              ],
            },
            properties: {
              baseUrl: { name: 'baseUrl', type: 'string', readonly: true },
            },
            constructorParams: [],
          },
        },
      }),
    );

    const kinds = snapshot.symbols.map((s) => s.kind);
    expect(kinds).toContain('service_accessor');
    expect(kinds).toContain('callable');
    expect(kinds).toContain('property');

    const callable = snapshot.symbols.find((s) => s.kind === 'callable');
    expect(callable?.fqName).toBe('UserManagement.createUser');
    expect(callable?.parameters).toHaveLength(1);
    expect(callable?.parameters?.[0].publicName).toBe('email');
    expect(callable?.parameters?.[0].required).toBe(true);
    expect(callable?.returns?.name).toBe('Promise<User>');
  });

  it('converts interfaces to alias + field symbols', () => {
    const snapshot = apiSurfaceToSnapshot(
      minimalSurface({
        interfaces: {
          Organization: {
            name: 'Organization',
            fields: {
              id: { name: 'id', type: 'string', optional: false },
              name: { name: 'name', type: 'string', optional: false },
            },
            extends: [],
          },
        },
      }),
    );

    const alias = snapshot.symbols.find((s) => s.kind === 'alias');
    expect(alias?.fqName).toBe('Organization');

    const fields = snapshot.symbols.filter((s) => s.kind === 'field');
    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.fqName).sort()).toEqual(['Organization.id', 'Organization.name']);
  });

  it('converts enums to enum + enum_member symbols', () => {
    const snapshot = apiSurfaceToSnapshot(
      minimalSurface({
        enums: {
          ConnectionState: {
            name: 'ConnectionState',
            members: { Active: 'active', Inactive: 'inactive' },
          },
        },
      }),
    );

    const enumSym = snapshot.symbols.find((s) => s.kind === 'enum');
    expect(enumSym?.fqName).toBe('ConnectionState');

    const members = snapshot.symbols.filter((s) => s.kind === 'enum_member');
    expect(members).toHaveLength(2);
  });

  it('converts constructor params on classes', () => {
    const snapshot = apiSurfaceToSnapshot(
      minimalSurface({
        language: 'php',
        classes: {
          CreateUser: {
            name: 'CreateUser',
            methods: {},
            properties: {},
            constructorParams: [
              { name: 'email', type: 'string', optional: false },
              { name: 'firstName', type: 'string', optional: true },
            ],
          },
        },
      }),
    );

    const ctor = snapshot.symbols.find((s) => s.kind === 'constructor');
    expect(ctor).toBeDefined();
    expect(ctor?.parameters).toHaveLength(2);
    expect(ctor?.parameters?.[0].publicName).toBe('email');
    expect(ctor?.parameters?.[0].position).toBe(0);
    expect(ctor?.parameters?.[1].publicName).toBe('firstName');
    expect(ctor?.parameters?.[1].position).toBe(1);
  });

  it('sets language-appropriate passing style', () => {
    const phpSnapshot = apiSurfaceToSnapshot(
      minimalSurface({
        language: 'php',
        classes: {
          Svc: {
            name: 'Svc',
            methods: {
              doIt: [
                {
                  name: 'doIt',
                  params: [{ name: 'x', type: 'string', optional: false }],
                  returnType: 'void',
                  async: false,
                },
              ],
            },
            properties: {},
            constructorParams: [],
          },
        },
      }),
    );
    const phpCallable = phpSnapshot.symbols.find((s) => s.kind === 'callable');
    expect(phpCallable?.parameters?.[0].passing).toBe('named');

    const pySnapshot = apiSurfaceToSnapshot(
      minimalSurface({
        language: 'python',
        classes: {
          Svc: {
            name: 'Svc',
            methods: {
              doIt: [
                {
                  name: 'doIt',
                  params: [{ name: 'x', type: 'str', optional: false }],
                  returnType: 'None',
                  async: false,
                },
              ],
            },
            properties: {},
            constructorParams: [],
          },
        },
      }),
    );
    const pyCallable = pySnapshot.symbols.find((s) => s.kind === 'callable');
    expect(pyCallable?.parameters?.[0].passing).toBe('keyword');
  });

  it('uses language policy for snapshot policies field', () => {
    const snapshot = apiSurfaceToSnapshot(minimalSurface({ language: 'php' }));
    expect(snapshot.policies.namedArgumentsSupported).toBe(true);
    expect(snapshot.policies.constructorOrderMatters).toBe(true);
  });

  it('uses explicit passingStyle from ApiParam when provided', () => {
    const snapshot = apiSurfaceToSnapshot(
      minimalSurface({
        language: 'python',
        classes: {
          Svc: {
            name: 'Svc',
            methods: {
              doIt: [
                {
                  name: 'doIt',
                  params: [
                    { name: 'x', type: 'str', optional: false, passingStyle: 'keyword_or_positional' },
                    { name: 'y', type: 'str', optional: false, passingStyle: 'keyword' },
                  ],
                  returnType: 'None',
                  async: false,
                },
              ],
            },
            properties: {},
            constructorParams: [],
          },
        },
      }),
    );
    const callable = snapshot.symbols.find((s) => s.kind === 'callable');
    expect(callable?.parameters?.[0].passing).toBe('keyword_or_positional');
    expect(callable?.parameters?.[1].passing).toBe('keyword');
  });

  it('falls back to language default when passingStyle is absent', () => {
    const snapshot = apiSurfaceToSnapshot(
      minimalSurface({
        language: 'go',
        classes: {
          Svc: {
            name: 'Svc',
            methods: {
              doIt: [
                {
                  name: 'doIt',
                  params: [{ name: 'x', type: 'string', optional: false }],
                  returnType: 'error',
                  async: false,
                },
              ],
            },
            properties: {},
            constructorParams: [],
          },
        },
      }),
    );
    const callable = snapshot.symbols.find((s) => s.kind === 'callable');
    // Go default inferred by inferPassingStyle
    expect(callable?.parameters?.[0].passing).toBe('positional');
  });

  it('populates typeRef on field symbols', () => {
    const snapshot = apiSurfaceToSnapshot(
      minimalSurface({
        interfaces: {
          Org: {
            name: 'Org',
            fields: { id: { name: 'id', type: 'string', optional: false } },
            extends: [],
          },
        },
      }),
    );
    const field = snapshot.symbols.find((s) => s.kind === 'field');
    expect(field?.typeRef).toEqual({ name: 'string' });
  });

  it('populates value on enum_member symbols', () => {
    const snapshot = apiSurfaceToSnapshot(
      minimalSurface({
        enums: {
          Status: { name: 'Status', members: { Active: 'active' } },
        },
      }),
    );
    const member = snapshot.symbols.find((s) => s.kind === 'enum_member');
    expect(member?.value).toBe('active');
  });
});
