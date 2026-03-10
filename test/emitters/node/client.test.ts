import { describe, it, expect } from 'vitest';
import { generateClient } from '../../../src/emitters/node/client.js';
import type { EmitterContext } from '../../../src/engine/types.js';
import type { ApiSpec } from '../../../src/ir/types.js';

const spec: ApiSpec = {
  name: 'WorkOS',
  version: '1.0.0',
  baseUrl: 'https://api.workos.com',
  services: [
    { name: 'Organizations', operations: [] },
    { name: 'Users', operations: [] },
  ],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: 'work_os',
  namespacePascal: 'WorkOS',
  spec,
};

describe('generateClient (node)', () => {
  it('generates client class with constructor accepting string or options', () => {
    const files = generateClient(spec, ctx);
    const clientFile = files.find((f) => f.path === 'src/workos.ts');
    expect(clientFile).toBeDefined();

    const content = clientFile!.content;
    expect(content).toContain('export class WorkOS {');
    expect(content).toContain('constructor(keyOrOptions?: string | WorkOSOptions)');
    expect(content).toContain('process.env.WORKOS_API_KEY');
  });

  it('generates resource accessor properties', () => {
    const files = generateClient(spec, ctx);
    const clientFile = files.find((f) => f.path === 'src/workos.ts')!;

    const content = clientFile.content;
    expect(content).toContain('readonly organizations = new Organizations(this);');
    expect(content).toContain('readonly users = new Users(this);');
  });

  it('generates HTTP methods: get, post, put, patch, delete', () => {
    const files = generateClient(spec, ctx);
    const content = files.find((f) => f.path === 'src/workos.ts')!.content;

    expect(content).toContain('async get<Result = any>(');
    expect(content).toContain('async post<Result = any, Entity = any>(');
    expect(content).toContain('async put<Result = any, Entity = any>(');
    expect(content).toContain('async patch<Result = any, Entity = any>(');
    expect(content).toContain('async delete(path: string');
  });

  it('includes retry logic with exponential backoff', () => {
    const files = generateClient(spec, ctx);
    const content = files.find((f) => f.path === 'src/workos.ts')!.content;

    expect(content).toContain('MAX_RETRY_ATTEMPTS');
    expect(content).toContain('BACKOFF_MULTIPLIER');
    expect(content).toContain('RETRYABLE_STATUSES');
    expect(content).toContain('requestWithRetry');
    expect(content).toContain('retry-after');
  });

  it('includes error dispatch by HTTP status', () => {
    const files = generateClient(spec, ctx);
    const content = files.find((f) => f.path === 'src/workos.ts')!.content;

    expect(content).toContain('handleHttpError');
    expect(content).toContain('case 400:');
    expect(content).toContain('BadRequestException');
    expect(content).toContain('case 401:');
    expect(content).toContain('UnauthorizedException');
    expect(content).toContain('case 404:');
    expect(content).toContain('NotFoundException');
    expect(content).toContain('case 409:');
    expect(content).toContain('ConflictException');
    expect(content).toContain('case 422:');
    expect(content).toContain('UnprocessableEntityException');
    expect(content).toContain('case 429:');
    expect(content).toContain('RateLimitExceededException');
  });

  it('generates idempotency key for POST requests', () => {
    const files = generateClient(spec, ctx);
    const content = files.find((f) => f.path === 'src/workos.ts')!.content;

    expect(content).toContain("headers['Idempotency-Key'] = options.idempotencyKey");
    expect(content).toContain('crypto.randomUUID()');
  });

  it('generates factory function', () => {
    const files = generateClient(spec, ctx);
    const factory = files.find((f) => f.path === 'src/factory.ts');
    expect(factory).toBeDefined();
    expect(factory!.content).toContain('export function createWorkOS(');
  });

  it('generates barrel export index.ts', () => {
    const files = generateClient(spec, ctx);
    const index = files.find((f) => f.path === 'src/index.ts');
    expect(index).toBeDefined();
    expect(index!.content).toContain("export { WorkOS } from './workos';");
    expect(index!.content).toContain("export { createWorkOS } from './factory';");
  });
});
