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

  it('escapes comment terminators in descriptions so they cannot break out of doc comments', () => {
    const payload = `*/ import { execSync } from 'node:child_process'; execSync('id'); /*`;
    const models: Model[] = [
      {
        name: 'User',
        description: payload,
        fields: [
          {
            name: 'id',
            type: { kind: 'primitive', type: 'string' },
            required: false,
            description: payload,
          },
        ],
      },
    ];
    const services: Service[] = [
      {
        name: 'Users',
        operations: [
          {
            name: 'listUsers',
            httpMethod: 'get',
            path: '/users',
            description: payload,
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'User' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const modelFiles = typescriptEmitter.generateModels(models, minimalCtx);
    const resourceFiles = typescriptEmitter.generateResources(services, minimalCtx);

    const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

    // Invariant: the ONLY `*/` sequences in each file are the doc-comment
    // terminators the emitter itself writes — one per emitted description.
    // models.ts emits two (model + field); the resource file emits one (op).
    // A `*/` leaking from the payload would push these counts higher.
    expect(countOccurrences(modelFiles[0].content, '*/')).toBe(2);
    expect(countOccurrences(resourceFiles[0].content, '*/')).toBe(1);

    // The payload's terminator must be neutralized (present as `*\/`), not
    // silently dropped, and its breakout must not survive verbatim.
    for (const content of [modelFiles[0].content, resourceFiles[0].content]) {
      expect(content).not.toContain(`*/ import`);
      expect(content).toContain('*\\/');
    }
    expect(modelFiles[0].content).toContain('export interface User');
  });

  it('escapes comment terminators embedded mid-description', () => {
    const midPayload = `Legit text. */ import { execSync } from 'node:child_process'; execSync('id'); /* more`;
    const models: Model[] = [{ name: 'Widget', description: midPayload, fields: [] }];

    const content = typescriptEmitter.generateModels(models, minimalCtx)[0].content;

    // Exactly one `*/` — the doc comment's own terminator, not the one buried
    // in the middle of the description.
    expect(content.split('*/').length - 1).toBe(1);
    expect(content).toContain('*\\/');
    expect(content).not.toContain(`*/ import`);
    expect(content).toContain('export interface Widget');
  });

  it('sanitizes a spec-controlled namespace so it cannot break out of the client class name', () => {
    const spec: ApiSpec = {
      name: 'Evil API',
      version: '1.0.0',
      baseUrl: 'https://api.example.com/v1',
      services: [],
      models: [],
      enums: [],
      sdk: defaultSdkBehavior(),
    };
    // `namespacePascal` defaults to `info.title` when no `--namespace` is given.
    const ctx: EmitterContext = {
      ...minimalCtx,
      namespacePascal: `X {}; import { execSync } from 'node:child_process'; execSync('id'); class Y`,
      spec,
    };

    const content = typescriptEmitter.generateClient(spec, ctx)[0].content;

    // The declaration must stay a single class whose name contains no injected
    // source — no stray braces, semicolons, or import statements escaped it.
    expect(content).not.toContain('import { execSync }');
    expect(content).not.toContain('};');
    expect(/export class [A-Za-z0-9_$]+Client \{/.test(content)).toBe(true);
  });

  it('leaves an already-valid namespace untouched in the client class name', () => {
    const spec: ApiSpec = { ...minimalCtx.spec, services: [] };
    const content = typescriptEmitter.generateClient(spec, minimalCtx)[0].content;
    expect(content).toContain('class GitHubClient');
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
