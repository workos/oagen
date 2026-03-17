import { describe, it, expect } from 'vitest';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec } from '../../src/ir/types.js';

const v1: ApiSpec = {
  name: 'Test API',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
  models: [
    {
      name: 'User',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    },
  ],
  enums: [
    {
      name: 'Status',
      values: [
        { name: 'active', value: 'active' },
        { name: 'inactive', value: 'inactive' },
      ],
    },
  ],
  services: [
    {
      name: 'Users',
      operations: [
        {
          name: 'listUsers',
          httpMethod: 'get',
          path: '/users',
          pathParams: [],
          queryParams: [{ name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false }],
          headerParams: [],
          response: { kind: 'array', items: { kind: 'model', name: 'User' } },
          errors: [],
          pagination: { cursorParam: 'after', dataPath: 'data', itemType: { kind: 'model', name: 'User' } },
          idempotent: false,
        },
      ],
    },
  ],
};

describe('diffSpecs', () => {
  it('returns empty diff for identical specs', () => {
    const diff = diffSpecs(v1, v1);
    expect(diff.changes).toHaveLength(0);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 0, breaking: 0, additive: 0 });
    expect(diff.oldVersion).toBe('1.0.0');
    expect(diff.newVersion).toBe('1.0.0');
  });

  it('detects additive changes only', () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        ...v1.models,
        { name: 'Team', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      ],
      enums: [{ name: 'Status', values: [...v1.enums[0].values, { name: 'pending', value: 'pending' }] }],
    };

    const diff = diffSpecs(v1, v2);
    expect(diff.summary.breaking).toBe(0);
    expect(diff.summary.added).toBeGreaterThan(0);
    expect(diff.changes.every((c) => c.classification === 'additive')).toBe(true);
  });

  it('detects breaking changes', () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        {
          ...v1.models[0],
          fields: v1.models[0].fields.filter((f) => f.name !== 'email'),
        },
      ],
    };

    const diff = diffSpecs(v1, v2);
    expect(diff.summary.breaking).toBeGreaterThan(0);
  });

  it('detects mixed changes', () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        {
          ...v1.models[0],
          fields: [
            ...v1.models[0].fields,
            { name: 'avatar', type: { kind: 'primitive', type: 'string' }, required: false },
          ],
        },
      ],
      enums: [],
    };

    const diff = diffSpecs(v1, v2);
    expect(diff.summary.additive).toBeGreaterThan(0);
    expect(diff.summary.breaking).toBeGreaterThan(0);
  });

  it('detects service and operation changes', () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      services: [
        ...v1.services,
        {
          name: 'Teams',
          operations: [
            {
              name: 'listTeams',
              httpMethod: 'get' as const,
              path: '/teams',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'array' as const, items: { kind: 'model' as const, name: 'Team' } },
              errors: [],
              idempotent: false,
            },
          ],
        },
      ],
    };

    const diff = diffSpecs(v1, v2);
    const serviceAdded = diff.changes.find((c) => c.kind === 'service-added');
    expect(serviceAdded).toBeDefined();
    expect(serviceAdded!.classification).toBe('additive');
  });

  it('detects enum removed as breaking', () => {
    const v2: ApiSpec = { ...v1, version: '2.0.0', enums: [] };
    const diff = diffSpecs(v1, v2);
    const enumRemoved = diff.changes.find((c) => c.kind === 'enum-removed');
    expect(enumRemoved).toBeDefined();
    expect(enumRemoved!.classification).toBe('breaking');
  });

  it('detects enum value added as additive', () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      enums: [{ name: 'Status', values: [...v1.enums[0].values, { name: 'pending', value: 'pending' }] }],
    };
    const diff = diffSpecs(v1, v2);
    const enumModified = diff.changes.find((c) => c.kind === 'enum-modified');
    expect(enumModified).toBeDefined();
    expect(enumModified!.classification).toBe('additive');
  });

  it('detects enum value removed as breaking', () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      enums: [{ name: 'Status', values: [v1.enums[0].values[0]] }],
    };
    const diff = diffSpecs(v1, v2);
    const enumModified = diff.changes.find((c) => c.kind === 'enum-modified');
    expect(enumModified).toBeDefined();
    expect(enumModified!.classification).toBe('breaking');
  });

  it('sets version strings correctly', () => {
    const v2: ApiSpec = { ...v1, version: '2.0.0' };
    const diff = diffSpecs(v1, v2);
    expect(diff.oldVersion).toBe('1.0.0');
    expect(diff.newVersion).toBe('2.0.0');
  });

  it('detects enum value string changed (breaking)', () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      enums: [
        {
          name: 'Status',
          values: [
            { name: 'active', value: 'ACTIVE' },
            { name: 'inactive', value: 'inactive' },
          ],
        },
      ],
    };
    const diff = diffSpecs(v1, v2);
    const enumMod = diff.changes.find((c) => c.kind === 'enum-modified');
    expect(enumMod).toBeDefined();
    expect(enumMod!.classification).toBe('breaking');
    if (enumMod?.kind === 'enum-modified') {
      const valueChanged = enumMod.valueChanges.find((vc) => vc.kind === 'value-changed');
      expect(valueChanged).toBeDefined();
      expect(valueChanged!.valueName).toBe('active');
      expect(valueChanged!.details).toContain('ACTIVE');
    }
  });

  it('returns empty diff for empty specs', () => {
    const empty: ApiSpec = {
      name: 'Empty',
      version: '1.0.0',
      baseUrl: '',
      models: [],
      enums: [],
      services: [],
    };
    const diff = diffSpecs(empty, empty);
    expect(diff.changes).toHaveLength(0);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 0, breaking: 0, additive: 0 });
  });

  it('detects multiple simultaneous changes across models + enums + services', () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        {
          ...v1.models[0],
          fields: v1.models[0].fields.filter((f) => f.name !== 'email'),
        },
        { name: 'Team', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      ],
      enums: [{ name: 'Status', values: [...v1.enums[0].values, { name: 'pending', value: 'pending' }] }],
      services: [],
    };
    const diff = diffSpecs(v1, v2);
    expect(diff.changes.length).toBeGreaterThanOrEqual(4); // model-modified, model-added, enum-modified, service-removed
    expect(diff.summary.breaking).toBeGreaterThan(0);
    expect(diff.summary.additive).toBeGreaterThan(0);
  });
});
