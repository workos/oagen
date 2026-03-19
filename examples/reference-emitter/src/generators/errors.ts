import type { GeneratedFile, EmitterContext } from '@workos/oagen';

export function generateErrors(_ctx: EmitterContext): GeneratedFile[] {
  const content = `export class ApiError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(message: string, statusCode: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, body?: unknown) {
    super(message, 404, body);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message: string, body?: unknown) {
    super(message, 401, body);
    this.name = 'UnauthorizedError';
  }
}

export class UnprocessableEntityError extends ApiError {
  constructor(message: string, body?: unknown) {
    super(message, 422, body);
    this.name = 'UnprocessableEntityError';
  }
}
`;

  return [{ path: 'errors.ts', content }];
}
