import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '../../src/compat/differ.js';
import { apiSurfaceToSnapshot } from '../../src/compat/ir.js';
import { getDefaultPolicy } from '../../src/compat/policy.js';
import type { CompatSnapshot, CompatSymbol } from '../../src/compat/ir.js';
import type { ApiSurface } from '../../src/compat/types.js';

function makeSnapshot(
  language: 'php' | 'python' | 'go' | 'node' | 'kotlin' | 'ruby' | 'dotnet' | 'elixir' | 'rust',
  symbols: CompatSymbol[],
): CompatSnapshot {
  return {
    schemaVersion: '1',
    source: { extractedAt: '2026-04-22T00:00:00.000Z' },
    policies: getDefaultPolicy(language),
    symbols,
  };
}

function sym(overrides: Partial<CompatSymbol> & { fqName: string }): CompatSymbol {
  const { fqName, ...rest } = overrides;
  return {
    id: rest.id ?? `test:${fqName}`,
    kind: rest.kind ?? 'callable',
    fqName,
    displayName: rest.displayName ?? fqName,
    visibility: 'public',
    stability: 'stable',
    sourceKind: 'generated_service_wrapper',
    ...rest,
  };
}

describe('diffSnapshots — service wrapper constructor filtering', () => {
  it('suppresses Ruby-style constructor removal on service wrappers', () => {
    const baseline = makeSnapshot('ruby', [
      sym({ fqName: 'AdminPortal', kind: 'service_accessor' }),
      sym({
        id: 'ctor:AdminPortal',
        fqName: 'AdminPortal.constructor',
        kind: 'constructor',
        ownerFqName: 'AdminPortal',
        sourceKind: 'generated_resource_constructor',
      }),
    ]);
    const candidate = makeSnapshot('ruby', [sym({ fqName: 'AdminPortal', kind: 'service_accessor' })]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes.filter((c) => c.symbol.includes('constructor'))).toHaveLength(0);
    expect(result.summary.breaking).toBe(0);
  });

  it('suppresses PHP __construct removal on service wrappers', () => {
    const baseline = makeSnapshot('php', [
      sym({ fqName: 'AdminPortal', kind: 'service_accessor' }),
      sym({
        id: 'method:AdminPortal.__construct',
        fqName: 'AdminPortal.__construct',
        kind: 'callable',
        ownerFqName: 'AdminPortal',
      }),
    ]);
    const candidate = makeSnapshot('php', [sym({ fqName: 'AdminPortal', kind: 'service_accessor' })]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes.filter((c) => c.symbol.includes('__construct'))).toHaveLength(0);
    expect(result.summary.breaking).toBe(0);
  });

  it('still reports constructor removal on non-service classes', () => {
    const baseline = makeSnapshot('ruby', [
      sym({
        id: 'ctor:Organization',
        fqName: 'Organization.constructor',
        kind: 'constructor',
        ownerFqName: 'Organization',
        sourceKind: 'generated_resource_constructor',
      }),
    ]);
    const candidate = makeSnapshot('ruby', []);
    const result = diffSnapshots(baseline, candidate);
    const removed = result.changes.find((c) => c.symbol === 'Organization.constructor');
    expect(removed).toBeDefined();
    expect(removed!.category).toBe('symbol_removed');
  });

  it('suppresses added service wrapper constructor', () => {
    const baseline = makeSnapshot('ruby', [sym({ fqName: 'NewService', kind: 'service_accessor' })]);
    const candidate = makeSnapshot('ruby', [
      sym({ fqName: 'NewService', kind: 'service_accessor' }),
      sym({
        id: 'ctor:NewService',
        fqName: 'NewService.constructor',
        kind: 'constructor',
        ownerFqName: 'NewService',
        sourceKind: 'generated_resource_constructor',
      }),
    ]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes.filter((c) => c.symbol.includes('constructor'))).toHaveLength(0);
  });
});

describe('diffSnapshots', () => {
  it('returns no changes for identical snapshots', () => {
    const symbols = [sym({ fqName: 'Svc.method' })];
    const result = diffSnapshots(makeSnapshot('node', symbols), makeSnapshot('node', symbols));
    expect(result.changes).toEqual([]);
    expect(result.summary).toEqual({ breaking: 0, softRisk: 0, additive: 0 });
  });

  it('detects removed symbols', () => {
    const baseline = makeSnapshot('php', [sym({ fqName: 'Svc.oldMethod' })]);
    const candidate = makeSnapshot('php', []);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].category).toBe('symbol_removed');
    expect(result.changes[0].severity).toBe('breaking');
    expect(result.summary.breaking).toBe(1);
  });

  it('detects added symbols', () => {
    const baseline = makeSnapshot('node', []);
    const candidate = makeSnapshot('node', [sym({ fqName: 'Svc.newMethod' })]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].category).toBe('symbol_added');
    expect(result.changes[0].severity).toBe('additive');
    expect(result.summary.additive).toBe(1);
  });

  it('detects parameter removal on a callable', () => {
    const baseline = makeSnapshot('php', [
      sym({
        fqName: 'Auth.check',
        parameters: [
          {
            publicName: 'token',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      }),
    ]);
    const candidate = makeSnapshot('php', [sym({ fqName: 'Auth.check', parameters: [] })]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes.some((c) => c.category === 'parameter_removed')).toBe(true);
  });

  it('accepts policy overrides', () => {
    const baseline = makeSnapshot('go', [
      sym({
        fqName: 'Svc.doIt',
        parameters: [
          {
            publicName: 'x',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      }),
    ]);
    const candidate = makeSnapshot('go', [
      sym({
        fqName: 'Svc.doIt',
        parameters: [
          {
            publicName: 'y',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      }),
    ]);
    // With Go defaults: param names are not public API → soft-risk
    const goResult = diffSnapshots(baseline, candidate, getDefaultPolicy('go'));
    const goRename = goResult.changes.find((c) => c.category === 'parameter_renamed');
    expect(goRename?.severity).toBe('soft-risk');

    // With PHP policy override: param names ARE public API → breaking
    const phpResult = diffSnapshots(baseline, candidate, getDefaultPolicy('php'));
    const phpRename = phpResult.changes.find((c) => c.category === 'parameter_renamed');
    expect(phpRename?.severity).toBe('breaking');
  });
});

describe('diffSnapshots — field and property type changes', () => {
  it('detects field type change as breaking', () => {
    const baseline = makeSnapshot('node', [sym({ fqName: 'Org.id', kind: 'field', typeRef: { name: 'string' } })]);
    const candidate = makeSnapshot('node', [sym({ fqName: 'Org.id', kind: 'field', typeRef: { name: 'number' } })]);
    const result = diffSnapshots(baseline, candidate);
    const change = result.changes.find((c) => c.category === 'field_type_changed');
    expect(change).toBeDefined();
    expect(change!.severity).toBe('breaking');
    expect(change!.old.type).toBe('string');
    expect(change!.new.type).toBe('number');
  });

  it('detects property type change as breaking', () => {
    const baseline = makeSnapshot('node', [
      sym({ fqName: 'Client.name', kind: 'property', typeRef: { name: 'string' } }),
    ]);
    const candidate = makeSnapshot('node', [
      sym({ fqName: 'Client.name', kind: 'property', typeRef: { name: 'string | null' } }),
    ]);
    const result = diffSnapshots(baseline, candidate);
    const change = result.changes.find((c) => c.category === 'field_type_changed');
    expect(change).toBeDefined();
    expect(change!.severity).toBe('breaking');
  });

  it('no change when field types match', () => {
    const baseline = makeSnapshot('node', [sym({ fqName: 'Org.id', kind: 'field', typeRef: { name: 'string' } })]);
    const candidate = makeSnapshot('node', [sym({ fqName: 'Org.id', kind: 'field', typeRef: { name: 'string' } })]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes).toHaveLength(0);
  });
});

describe('diffSnapshots — enum member value changes', () => {
  it('detects enum member value change as breaking', () => {
    const baseline = makeSnapshot('node', [sym({ fqName: 'Status.Active', kind: 'enum_member', value: 'active' })]);
    const candidate = makeSnapshot('node', [sym({ fqName: 'Status.Active', kind: 'enum_member', value: 'enabled' })]);
    const result = diffSnapshots(baseline, candidate);
    const change = result.changes.find((c) => c.category === 'enum_member_value_changed');
    expect(change).toBeDefined();
    expect(change!.severity).toBe('breaking');
    expect(change!.old.value).toBe('active');
    expect(change!.new.value).toBe('enabled');
  });

  it('no change when enum member values match', () => {
    const baseline = makeSnapshot('node', [sym({ fqName: 'Status.Active', kind: 'enum_member', value: 'active' })]);
    const candidate = makeSnapshot('node', [sym({ fqName: 'Status.Active', kind: 'enum_member', value: 'active' })]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes).toHaveLength(0);
  });

  it('detects removed enum member as symbol_removed', () => {
    const baseline = makeSnapshot('node', [
      sym({ fqName: 'Status.Active', kind: 'enum_member', value: 'active' }),
      sym({ fqName: 'Status.Inactive', kind: 'enum_member', value: 'inactive' }),
    ]);
    const candidate = makeSnapshot('node', [sym({ fqName: 'Status.Active', kind: 'enum_member', value: 'active' })]);
    const result = diffSnapshots(baseline, candidate);
    const removed = result.changes.find((c) => c.category === 'symbol_removed');
    expect(removed).toBeDefined();
    expect(removed!.symbol).toBe('Status.Inactive');
  });
});

describe('diffSnapshots — return type changes', () => {
  it('detects changed return type as breaking', () => {
    const baseline = makeSnapshot('node', [sym({ fqName: 'Client.get', returns: { name: 'Promise<Organization>' } })]);
    const candidate = makeSnapshot('node', [sym({ fqName: 'Client.get', returns: { name: 'Promise<Org>' } })]);
    const result = diffSnapshots(baseline, candidate);
    const change = result.changes.find((c) => c.category === 'return_type_changed');
    expect(change).toBeDefined();
    expect(change!.severity).toBe('breaking');
  });

  it('no change when return types match', () => {
    const baseline = makeSnapshot('node', [sym({ fqName: 'Client.get', returns: { name: 'Promise<Org>' } })]);
    const candidate = makeSnapshot('node', [sym({ fqName: 'Client.get', returns: { name: 'Promise<Org>' } })]);
    const result = diffSnapshots(baseline, candidate);
    expect(result.changes).toHaveLength(0);
  });
});

describe('diffSnapshots with apiSurfaceToSnapshot bridge', () => {
  function emptySurface(overrides?: Partial<ApiSurface>): ApiSurface {
    return {
      language: 'node',
      extractedFrom: '/test',
      extractedAt: '2024-01-01T00:00:00Z',
      classes: {},
      interfaces: {},
      typeAliases: {},
      enums: {},
      exports: {},
      ...overrides,
    };
  }

  it('can diff two converted ApiSurfaces', () => {
    const baseSurface: ApiSurface = {
      language: 'php',
      extractedFrom: '/sdk',
      extractedAt: '2026-01-01T00:00:00.000Z',
      classes: {
        Users: {
          name: 'Users',
          methods: {
            create: [
              {
                name: 'create',
                params: [{ name: 'email', type: 'string', optional: false }],
                returnType: 'User',
                async: false,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
      interfaces: {},
      typeAliases: {},
      enums: {},
      exports: {},
    };
    const candSurface: ApiSurface = {
      ...baseSurface,
      classes: {
        Users: {
          name: 'Users',
          methods: {
            create: [
              {
                name: 'create',
                params: [{ name: 'emailAddress', type: 'string', optional: false }],
                returnType: 'User',
                async: false,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    };

    const baseSnap = apiSurfaceToSnapshot(baseSurface);
    const candSnap = apiSurfaceToSnapshot(candSurface);
    const result = diffSnapshots(baseSnap, candSnap);

    // Should detect the parameter rename
    const rename = result.changes.find((c) => c.category === 'parameter_renamed');
    expect(rename).toBeDefined();
    expect(rename!.old.parameter).toBe('email');
    expect(rename!.new.parameter).toBe('emailAddress');
  });

  it('detects missing class as symbol_removed', () => {
    const baseline = emptySurface({
      classes: {
        Client: { name: 'Client', methods: {}, properties: {}, constructorParams: [] },
      },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(emptySurface());
    const result = diffSnapshots(baseSnap, candSnap);
    const removed = result.changes.find((c) => c.category === 'symbol_removed' && c.symbol === 'Client');
    expect(removed).toBeDefined();
    expect(removed!.severity).toBe('breaking');
  });

  it('detects missing method as symbol_removed', () => {
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            list: [{ name: 'list', params: [], returnType: 'Promise<void>', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: { name: 'Client', methods: {}, properties: {}, constructorParams: [] },
      },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(candidate);
    const result = diffSnapshots(baseSnap, candSnap);
    const removed = result.changes.find((c) => c.category === 'symbol_removed' && c.symbol === 'Client.list');
    expect(removed).toBeDefined();
  });

  it('detects changed field type as field_type_changed', () => {
    const baseline = emptySurface({
      interfaces: {
        Org: { name: 'Org', fields: { id: { name: 'id', type: 'string', optional: false } }, extends: [] },
      },
    });
    const candidate = emptySurface({
      interfaces: {
        Org: { name: 'Org', fields: { id: { name: 'id', type: 'number', optional: false } }, extends: [] },
      },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(candidate);
    const result = diffSnapshots(baseSnap, candSnap);
    const change = result.changes.find((c) => c.category === 'field_type_changed' && c.symbol === 'Org.id');
    expect(change).toBeDefined();
    expect(change!.severity).toBe('breaking');
  });

  it('detects missing interface as symbol_removed', () => {
    const baseline = emptySurface({
      interfaces: {
        Options: { name: 'Options', fields: { key: { name: 'key', type: 'string', optional: false } }, extends: [] },
      },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(emptySurface());
    const result = diffSnapshots(baseSnap, candSnap);
    const removed = result.changes.find((c) => c.category === 'symbol_removed' && c.symbol === 'Options');
    expect(removed).toBeDefined();
  });

  it('detects missing type alias as symbol_removed', () => {
    const baseline = emptySurface({
      typeAliases: { StatusType: { name: 'StatusType', value: '"active" | "inactive"' } },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(emptySurface());
    const result = diffSnapshots(baseSnap, candSnap);
    const removed = result.changes.find((c) => c.category === 'symbol_removed' && c.symbol === 'StatusType');
    expect(removed).toBeDefined();
  });

  it('detects missing enum as symbol_removed', () => {
    const baseline = emptySurface({
      enums: { Status: { name: 'Status', members: { Active: 'active', Inactive: 'inactive' } } },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(emptySurface());
    const result = diffSnapshots(baseSnap, candSnap);
    const removed = result.changes.find((c) => c.category === 'symbol_removed' && c.symbol === 'Status');
    expect(removed).toBeDefined();
  });

  it('detects enum member value change', () => {
    const baseline = emptySurface({
      enums: { Status: { name: 'Status', members: { Active: 'active' } } },
    });
    const candidate = emptySurface({
      enums: { Status: { name: 'Status', members: { Active: 'enabled' } } },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(candidate);
    const result = diffSnapshots(baseSnap, candSnap);
    const change = result.changes.find((c) => c.category === 'enum_member_value_changed');
    expect(change).toBeDefined();
    expect(change!.old.value).toBe('active');
    expect(change!.new.value).toBe('enabled');
  });

  it('reports new symbols as additive', () => {
    const baseline = emptySurface({
      classes: {
        Client: { name: 'Client', methods: {}, properties: {}, constructorParams: [] },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: { name: 'Client', methods: {}, properties: {}, constructorParams: [] },
        NewClient: { name: 'NewClient', methods: {}, properties: {}, constructorParams: [] },
      },
      interfaces: {
        NewInterface: { name: 'NewInterface', fields: {}, extends: [] },
      },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(candidate);
    const result = diffSnapshots(baseSnap, candSnap);
    const newClient = result.changes.find((c) => c.category === 'symbol_added' && c.symbol === 'NewClient');
    expect(newClient).toBeDefined();
    const newIface = result.changes.find((c) => c.category === 'symbol_added' && c.symbol === 'NewInterface');
    expect(newIface).toBeDefined();
    // No breaking changes
    expect(result.summary.breaking).toBe(0);
  });

  it('returns no changes for identical surfaces', () => {
    const surface = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            get: [
              {
                name: 'get',
                params: [{ name: 'id', type: 'string', optional: false }],
                returnType: 'Promise<Organization>',
                async: true,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const baseSnap = apiSurfaceToSnapshot(surface);
    const candSnap = apiSurfaceToSnapshot(surface);
    const result = diffSnapshots(baseSnap, candSnap);
    expect(result.changes).toHaveLength(0);
    expect(result.summary).toEqual({ breaking: 0, softRisk: 0, additive: 0 });
  });

  it('detects requiredness change (optional → required)', () => {
    const baseline = emptySurface({
      classes: {
        Auth: {
          name: 'Auth',
          methods: {
            login: [
              {
                name: 'login',
                params: [{ name: 'token', type: 'string', optional: true }],
                returnType: 'void',
                async: false,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Auth: {
          name: 'Auth',
          methods: {
            login: [
              {
                name: 'login',
                params: [{ name: 'token', type: 'string', optional: false }],
                returnType: 'void',
                async: false,
              },
            ],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(candidate);
    const result = diffSnapshots(baseSnap, candSnap);
    const change = result.changes.find((c) => c.category === 'parameter_requiredness_increased');
    expect(change).toBeDefined();
    expect(change!.severity).toBe('breaking');
  });

  it('detects changed return type via bridge', () => {
    const baseline = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            get: [{ name: 'get', params: [], returnType: 'Promise<Organization>', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const candidate = emptySurface({
      classes: {
        Client: {
          name: 'Client',
          methods: {
            get: [{ name: 'get', params: [], returnType: 'Promise<Org>', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const baseSnap = apiSurfaceToSnapshot(baseline);
    const candSnap = apiSurfaceToSnapshot(candidate);
    const result = diffSnapshots(baseSnap, candSnap);
    const change = result.changes.find((c) => c.category === 'return_type_changed');
    expect(change).toBeDefined();
    expect(change!.severity).toBe('breaking');
  });
});
