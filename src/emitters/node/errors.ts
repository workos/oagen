import type { EmitterContext, GeneratedFile } from '../../engine/types.js';

export function generateErrors(_ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // RequestException interface
  files.push({
    path: 'src/common/interfaces/request-exception.interface.ts',
    skipIfExists: true,
    content: `export interface RequestException {
  readonly status: number;
  readonly name: string;
  readonly message: string;
  readonly requestID: string;
}
`,
  });

  // GenericServerException
  files.push({
    path: 'src/common/exceptions/generic-server.exception.ts',
    skipIfExists: true,
    content: `import type { RequestException } from '../interfaces/request-exception.interface';

export class GenericServerException extends Error implements RequestException {
  readonly name: string = 'GenericServerException';
  readonly message: string = 'The request could not be completed.';

  constructor(
    readonly status: number,
    message: string | undefined,
    readonly rawData: unknown,
    readonly requestID: string,
  ) {
    super();
    if (message) {
      this.message = message;
    }
  }
}
`,
  });

  // UnauthorizedException
  files.push({
    path: 'src/common/exceptions/unauthorized.exception.ts',
    skipIfExists: true,
    content: `import type { RequestException } from '../interfaces/request-exception.interface';

export class UnauthorizedException extends Error implements RequestException {
  readonly status = 401;
  readonly name = 'UnauthorizedException';
  readonly message: string;
  readonly requestID: string;

  constructor({ message, requestID }: { message?: string; requestID: string }) {
    super();
    this.message = message ?? 'Unauthorized';
    this.requestID = requestID;
  }
}
`,
  });

  // BadRequestException
  files.push({
    path: 'src/common/exceptions/bad-request.exception.ts',
    skipIfExists: true,
    content: `import type { RequestException } from '../interfaces/request-exception.interface';

export class BadRequestException extends Error implements RequestException {
  readonly status = 400;
  readonly name = 'BadRequestException';
  readonly message: string;
  readonly code?: string;
  readonly requestID: string;

  constructor({
    code,
    message,
    requestID,
  }: {
    code?: string;
    message?: string;
    requestID: string;
  }) {
    super();
    this.code = code;
    this.message = message ?? 'Bad request';
    this.requestID = requestID;
  }
}
`,
  });

  // NotFoundException
  files.push({
    path: 'src/common/exceptions/not-found.exception.ts',
    skipIfExists: true,
    content: `import type { RequestException } from '../interfaces/request-exception.interface';

export class NotFoundException extends Error implements RequestException {
  readonly status = 404;
  readonly name = 'NotFoundException';
  readonly message: string;
  readonly code?: string;
  readonly requestID: string;

  constructor({
    code,
    message,
    path,
    requestID,
  }: {
    code?: string;
    message?: string;
    path: string;
    requestID: string;
  }) {
    super();
    this.code = code;
    this.message = message ?? \`The requested path '\${path}' could not be found.\`;
    this.requestID = requestID;
  }
}
`,
  });

  // ConflictException
  files.push({
    path: 'src/common/exceptions/conflict.exception.ts',
    skipIfExists: true,
    content: `import type { RequestException } from '../interfaces/request-exception.interface';

export class ConflictException extends Error implements RequestException {
  readonly status = 409;
  readonly name = 'ConflictException';
  readonly message: string;
  readonly code?: string;
  readonly requestID: string;

  constructor({
    code,
    message,
    requestID,
  }: {
    code?: string;
    message?: string;
    requestID: string;
  }) {
    super();
    this.code = code;
    this.message = message ?? 'Conflict';
    this.requestID = requestID;
  }
}
`,
  });

  // UnprocessableEntityException
  files.push({
    path: 'src/common/exceptions/unprocessable-entity.exception.ts',
    skipIfExists: true,
    content: `import type { RequestException } from '../interfaces/request-exception.interface';

export class UnprocessableEntityException extends Error implements RequestException {
  readonly status = 422;
  readonly name = 'UnprocessableEntityException';
  readonly message: string;
  readonly code?: string;
  readonly requestID: string;

  constructor({
    code,
    errors,
    message,
    requestID,
  }: {
    code?: string;
    errors?: Array<{ code: string }>;
    message?: string;
    requestID: string;
  }) {
    super();
    this.requestID = requestID;
    this.code = code;
    this.message = message ?? 'Unprocessable entity';

    if (errors && errors.length > 0) {
      const requirement = errors.length === 1 ? 'requirement' : 'requirements';
      this.message = \`The following \${requirement} must be met:\\n\`;
      for (const { code: errCode } of errors) {
        this.message = this.message.concat(\`\\t\${errCode}\\n\`);
      }
    }
  }
}
`,
  });

  // RateLimitExceededException
  files.push({
    path: 'src/common/exceptions/rate-limit-exceeded.exception.ts',
    skipIfExists: true,
    content: `import type { RequestException } from '../interfaces/request-exception.interface';

export class RateLimitExceededException extends Error implements RequestException {
  readonly status = 429;
  readonly name = 'RateLimitExceededException';
  readonly message: string;
  readonly retryAfter?: number;
  readonly requestID: string;

  constructor({
    message,
    retryAfter,
    requestID,
  }: {
    message?: string;
    retryAfter?: number;
    requestID: string;
  }) {
    super();
    this.message = message ?? 'Too many requests';
    this.retryAfter = retryAfter;
    this.requestID = requestID;
  }
}
`,
  });

  // ApiKeyRequiredException
  files.push({
    path: 'src/common/exceptions/api-key-required.exception.ts',
    skipIfExists: true,
    content: `export class ApiKeyRequiredException extends Error {
  readonly status = 403;
  readonly name = 'ApiKeyRequiredException';

  constructor() {
    super('An API key is required to make requests.');
  }
}
`,
  });

  // Barrel export
  files.push({
    path: 'src/common/exceptions/index.ts',
    skipIfExists: true,
    content: `export { GenericServerException } from './generic-server.exception';
export { UnauthorizedException } from './unauthorized.exception';
export { BadRequestException } from './bad-request.exception';
export { NotFoundException } from './not-found.exception';
export { ConflictException } from './conflict.exception';
export { UnprocessableEntityException } from './unprocessable-entity.exception';
export { RateLimitExceededException } from './rate-limit-exceeded.exception';
export { ApiKeyRequiredException } from './api-key-required.exception';
`,
  });

  return files;
}
