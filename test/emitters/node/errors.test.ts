import { describe, it, expect } from 'vitest';
import { generateErrors } from '../../../src/emitters/node/errors.js';
import type { EmitterContext } from '../../../src/engine/types.js';
import type { ApiSpec } from '../../../src/ir/types.js';

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

describe('generateErrors (node)', () => {
  it('generates all exception classes', () => {
    const files = generateErrors(ctx);

    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/common/exceptions/generic-server.exception.ts');
    expect(paths).toContain('src/common/exceptions/unauthorized.exception.ts');
    expect(paths).toContain('src/common/exceptions/bad-request.exception.ts');
    expect(paths).toContain('src/common/exceptions/not-found.exception.ts');
    expect(paths).toContain('src/common/exceptions/conflict.exception.ts');
    expect(paths).toContain('src/common/exceptions/unprocessable-entity.exception.ts');
    expect(paths).toContain('src/common/exceptions/rate-limit-exceeded.exception.ts');
    expect(paths).toContain('src/common/exceptions/api-key-required.exception.ts');
    expect(paths).toContain('src/common/exceptions/index.ts');
  });

  it('generates GenericServerException with dynamic status', () => {
    const files = generateErrors(ctx);
    const generic = files.find((f) => f.path.includes('generic-server'))!;
    expect(generic.content).toContain('class GenericServerException extends Error');
    expect(generic.content).toContain('readonly status: number');
    expect(generic.content).toContain('readonly rawData: unknown');
    expect(generic.content).toContain('readonly requestID: string');
  });

  it('generates NotFoundException with status 404', () => {
    const files = generateErrors(ctx);
    const notFound = files.find((f) => f.path.includes('not-found'))!;
    expect(notFound.content).toContain('readonly status = 404');
    expect(notFound.content).toContain('class NotFoundException extends Error');
    expect(notFound.content).toContain('requestID: string');
  });

  it('generates UnauthorizedException with status 401', () => {
    const files = generateErrors(ctx);
    const unauth = files.find((f) => f.path.includes('unauthorized'))!;
    expect(unauth.content).toContain('readonly status = 401');
  });

  it('generates RateLimitExceededException with status 429 and retryAfter', () => {
    const files = generateErrors(ctx);
    const rateLimit = files.find((f) => f.path.includes('rate-limit'))!;
    expect(rateLimit.content).toContain('readonly status = 429');
    expect(rateLimit.content).toContain('retryAfter');
  });

  it('generates ApiKeyRequiredException without RequestException', () => {
    const files = generateErrors(ctx);
    const apiKey = files.find((f) => f.path.includes('api-key-required'))!;
    expect(apiKey.content).toContain('class ApiKeyRequiredException extends Error');
    expect(apiKey.content).not.toContain('implements RequestException');
  });

  it('generates barrel export with all exceptions', () => {
    const files = generateErrors(ctx);
    const barrel = files.find((f) => f.path === 'src/common/exceptions/index.ts')!;
    expect(barrel.content).toContain('GenericServerException');
    expect(barrel.content).toContain('UnauthorizedException');
    expect(barrel.content).toContain('BadRequestException');
    expect(barrel.content).toContain('NotFoundException');
    expect(barrel.content).toContain('ConflictException');
    expect(barrel.content).toContain('UnprocessableEntityException');
    expect(barrel.content).toContain('RateLimitExceededException');
    expect(barrel.content).toContain('ApiKeyRequiredException');
  });
});
