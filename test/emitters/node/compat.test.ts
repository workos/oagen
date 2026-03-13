import { describe, it, expect } from 'vitest';
import { generateResources } from '../../../src/emitters/node/resources.js';
import { generateModels } from '../../../src/emitters/node/models.js';
import { generateOptions } from '../../../src/emitters/node/options.js';
import type { EmitterContext } from '../../../src/engine/types.js';
import type { Service, ApiSpec, Model } from '../../../src/ir/types.js';
import type { OverlayLookup } from '../../../src/compat/overlay.js';

const emptySpec: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: '',
  services: [],
  models: [],
  enums: [],
};

function makeCtx(overlay?: OverlayLookup): EmitterContext {
  return {
    namespace: 'work_os',
    namespacePascal: 'WorkOS',
    spec: emptySpec,
    overlayLookup: overlay,
  };
}

function makeOverlay(overrides?: Partial<OverlayLookup>): OverlayLookup {
  return {
    methodByOperation: new Map(),
    interfaceByName: new Map(),
    typeAliasByName: new Map(),
    requiredExports: new Map(),
    ...overrides,
  };
}

const orgService: Service = {
  name: 'Organizations',
  operations: [
    {
      name: 'ListOrganizations',
      httpMethod: 'get',
      path: '/organizations',
      pathParams: [],
      queryParams: [
        { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
      ],
      headerParams: [],
      response: { kind: 'model', name: 'Organization' },
      errors: [],
      paginated: true,
      idempotent: false,
    },
    {
      name: 'GetOrganization',
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
};

describe('Node emitter with overlay', () => {
  describe('generateResources', () => {
    it('uses overlay method name when HTTP method+path matches', () => {
      const overlay = makeOverlay({
        methodByOperation: new Map([
          ['GET /organizations', {
            className: 'Organizations',
            methodName: 'listOrgs',
            params: [],
            returnType: 'Promise<Organization[]>',
          }],
        ]),
      });

      const files = generateResources([orgService], makeCtx(overlay));
      expect(files).toHaveLength(1);
      const content = files[0].content;
      expect(content).toContain('async listOrgs(');
      // getOrganization should use computed name since no overlay entry
      expect(content).toContain('async getOrganization(');
    });

    it('uses computed method name when no overlay is provided', () => {
      const files = generateResources([orgService], makeCtx());
      const content = files[0].content;
      expect(content).toContain('async listOrganizations(');
      expect(content).toContain('async getOrganization(');
    });

    it('uses computed method name when overlay has no matching entry', () => {
      const overlay = makeOverlay(); // empty overlay
      const files = generateResources([orgService], makeCtx(overlay));
      const content = files[0].content;
      expect(content).toContain('async listOrganizations(');
    });
  });

  describe('generateModels', () => {
    it('uses overlay interface name when available', () => {
      const models: Model[] = [
        {
          name: 'Organization',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
      ];

      const overlay = makeOverlay({
        interfaceByName: new Map([['Organization', 'Org']]),
      });

      const ctx = makeCtx(overlay);
      ctx.spec = { ...emptySpec, models, services: [orgService] };
      const files = generateModels(models, ctx);

      const modelFile = files.find((f) => f.path.includes('organization.interface.ts'));
      expect(modelFile).toBeDefined();
      expect(modelFile!.content).toContain('export interface Org {');
    });

    it('uses computed interface name when no overlay', () => {
      const models: Model[] = [
        {
          name: 'Organization',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
      ];

      const ctx = makeCtx();
      ctx.spec = { ...emptySpec, models, services: [orgService] };
      const files = generateModels(models, ctx);

      const modelFile = files.find((f) => f.path.includes('organization.interface.ts'));
      expect(modelFile).toBeDefined();
      expect(modelFile!.content).toContain('export interface Organization {');
    });
  });

  describe('generateOptions', () => {
    it('uses overlay option type name when available', () => {
      const service: Service = {
        name: 'Organizations',
        operations: [
          {
            name: 'ListOrganizations',
            httpMethod: 'get',
            path: '/organizations',
            pathParams: [],
            queryParams: [
              { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            paginated: true,
            idempotent: false,
          },
        ],
      };

      const overlay = makeOverlay({
        interfaceByName: new Map([['ListOrganizationsOptions', 'ListOrgsOptions']]),
      });

      const ctx = makeCtx(overlay);
      ctx.spec = { ...emptySpec, services: [service] };
      const files = generateOptions([service], ctx);

      expect(files.length).toBeGreaterThan(0);
      const optionsFile = files[0];
      expect(optionsFile.content).toContain('export interface ListOrgsOptions {');
    });

    it('uses computed option type name when no overlay', () => {
      const service: Service = {
        name: 'Organizations',
        operations: [
          {
            name: 'ListOrganizations',
            httpMethod: 'get',
            path: '/organizations',
            pathParams: [],
            queryParams: [
              { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'Organization' },
            errors: [],
            paginated: true,
            idempotent: false,
          },
        ],
      };

      const ctx = makeCtx();
      ctx.spec = { ...emptySpec, services: [service] };
      const files = generateOptions([service], ctx);

      expect(files.length).toBeGreaterThan(0);
      const optionsFile = files[0];
      expect(optionsFile.content).toContain('export interface ListOrganizationsOptions {');
    });
  });

  describe('generateModels barrel exports', () => {
    it('includes requiredExports from overlay in barrel', () => {
      const models: Model[] = [
        {
          name: 'Organization',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
      ];

      const overlay = makeOverlay({
        requiredExports: new Map([
          ['src/organizations/interfaces/index.ts', new Set(['LegacyOrgType'])],
        ]),
      });

      const ctx = makeCtx(overlay);
      ctx.spec = { ...emptySpec, models, services: [orgService] };
      const files = generateModels(models, ctx);

      const barrel = files.find((f) => f.path === 'src/organizations/interfaces/index.ts');
      expect(barrel).toBeDefined();
      // Should include both the IR-generated export and the overlay-required export
      expect(barrel!.content).toContain("export * from './organization.interface';");
      expect(barrel!.content).toContain("export * from './legacy-org-type.interface';");
    });

    it('does not duplicate overlay exports that already exist', () => {
      const models: Model[] = [
        {
          name: 'Organization',
          fields: [
            { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          ],
        },
      ];

      const overlay = makeOverlay({
        requiredExports: new Map([
          ['src/organizations/interfaces/index.ts', new Set(['Organization'])],
        ]),
      });

      const ctx = makeCtx(overlay);
      ctx.spec = { ...emptySpec, models, services: [orgService] };
      const files = generateModels(models, ctx);

      const barrel = files.find((f) => f.path === 'src/organizations/interfaces/index.ts');
      expect(barrel).toBeDefined();
      // Should not have duplicate entries
      const lines = barrel!.content.split('\n').filter((l) => l.includes('organization.interface'));
      expect(lines).toHaveLength(1);
    });
  });
});
