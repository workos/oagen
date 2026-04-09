import { describe, it, expect } from 'vitest';
import { typescriptEmitter } from '../../../examples/reference-emitter/src/index.js';
import type { EmitterContext } from '../../../src/engine/types.js';
import type { ApiSpec, Model, Enum, Service } from '../../../src/ir/types.js';
import { defaultSdkBehavior } from '../../../src/ir/sdk-behavior.js';

const minimalCtx: EmitterContext = {
  namespace: 'git_hub',
  namespacePascal: 'GitHub',
  spec: {
    name: 'GitHub API',
    version: '1.0.0',
    baseUrl: 'https://api.github-example.com/v1',
    services: [],
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
  },
};

describe('reference emitter', () => {
  it('has language set to typescript', () => {
    expect(typescriptEmitter.language).toBe('typescript');
  });

  it('generates model interfaces', () => {
    const models: Model[] = [
      {
        name: 'Repository',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'integer' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          {
            name: 'description',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string' } },
            required: false,
          },
        ],
      },
    ];

    const files = typescriptEmitter.generateModels(models, minimalCtx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('models.ts');
    expect(files[0].content).toContain('export interface Repository');
    expect(files[0].content).toContain('id: number');
    expect(files[0].content).toContain('name: string');
    expect(files[0].content).toContain('description?: string | null');
  });

  it('generates enum types as literal unions', () => {
    const enums: Enum[] = [
      {
        name: 'Visibility',
        values: [
          { name: 'PUBLIC', value: 'public' },
          { name: 'PRIVATE', value: 'private' },
          { name: 'INTERNAL', value: 'internal' },
        ],
      },
    ];

    const files = typescriptEmitter.generateEnums(enums, minimalCtx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('enums.ts');
    expect(files[0].content).toContain('export type Visibility = "public" | "private" | "internal"');
  });

  it('generates resource classes with methods', () => {
    const services: Service[] = [
      {
        name: 'Repos',
        operations: [
          {
            name: 'listRepos',
            httpMethod: 'get',
            path: '/repos',
            pathParams: [],
            queryParams: [{ name: 'after', type: { kind: 'primitive', type: 'string' }, required: false }],
            headerParams: [],
            response: { kind: 'array', items: { kind: 'model', name: 'Repository' } },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const files = typescriptEmitter.generateResources(services, minimalCtx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('resources/repos.ts');
    expect(files[0].content).toContain('class Repos');
    expect(files[0].content).toContain('listRepos');
  });

  it('generates client class', () => {
    const spec: ApiSpec = {
      ...minimalCtx.spec,
      services: [
        {
          name: 'Repos',
          operations: [
            {
              name: 'listRepos',
              httpMethod: 'get',
              path: '/repos',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'array', items: { kind: 'model', name: 'Repository' } },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    };

    const files = typescriptEmitter.generateClient(spec, minimalCtx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('client.ts');
    expect(files[0].content).toContain('class GitHubClient');
    expect(files[0].content).toContain('repos: Repos');
  });

  it('generates error classes', () => {
    const files = typescriptEmitter.generateErrors(minimalCtx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('errors.ts');
    expect(files[0].content).toContain('class ApiError');
    expect(files[0].content).toContain('class NotFoundError');
  });

  it('returns empty models file for empty input', () => {
    const files = typescriptEmitter.generateModels([], minimalCtx);
    expect(files).toHaveLength(0);
  });

  it('returns empty enums file for empty input', () => {
    const files = typescriptEmitter.generateEnums([], minimalCtx);
    expect(files).toHaveLength(0);
  });

  it('has a file header', () => {
    expect(typescriptEmitter.fileHeader()).toContain('Auto-generated');
  });
});
