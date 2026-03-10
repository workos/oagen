import type { ApiSpec } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { nodeClassName, nodeFileName } from './naming.js';
import { toCamelCase } from '../../utils/naming.js';

export function generateClient(_spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;
  const nsKebab = ctx.namespacePascal.toLowerCase();
  const nsEnvKey = ctx.namespacePascal.toUpperCase();

  const resourceImports = ctx.spec.services
    .map((s) => {
      const className = nodeClassName(s.name);
      const fileName = nodeFileName(s.name);
      return `import { ${className} } from './${fileName}/${fileName}';`;
    })
    .join('\n');

  const resourceProps = ctx.spec.services
    .map((s) => {
      const className = nodeClassName(s.name);
      const propName = toCamelCase(s.name);
      return `  readonly ${propName} = new ${className}(this);`;
    })
    .join('\n');

  const content = `import type { ${ns}Options } from './common/interfaces/${nsKebab}-options.interface';
import type { GetOptions } from './common/interfaces/get-options.interface';
import type { PostOptions } from './common/interfaces/post-options.interface';
import type { PutOptions } from './common/interfaces/put-options.interface';
import type { PatchOptions } from './common/interfaces/patch-options.interface';
import {
  GenericServerException,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  RateLimitExceededException,
  ApiKeyRequiredException,
} from './common/exceptions/index';
import { FetchHttpClient } from './common/net/fetch-client';
import type { HttpClient } from './common/net/http-client';
${resourceImports}

const MAX_RETRY_ATTEMPTS = 3;
const BACKOFF_MULTIPLIER = 1.5;
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

export class ${ns} {
  readonly baseURL: string;
  readonly key?: string;
  readonly options: ${ns}Options;

  private readonly client: HttpClient;

${resourceProps}

  constructor(keyOrOptions?: string | ${ns}Options) {
    if (typeof keyOrOptions === 'string') {
      this.key = keyOrOptions;
      this.options = {};
    } else {
      this.key = keyOrOptions?.apiKey;
      this.options = keyOrOptions ?? {};
    }

    this.key = this.key ?? process.env.${nsEnvKey}_API_KEY;
    this.baseURL = this.options.baseURL ?? 'https://api.${ctx.namespace.replace(/_/g, '')}.com';
    this.client = new FetchHttpClient();

    if (!this.key) {
      throw new ApiKeyRequiredException();
    }
  }

  async get<Result = any>(
    path: string,
    options: GetOptions = {},
  ): Promise<{ data: Result }> {
    const url = new URL(path, this.baseURL);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await this.requestWithRetry(url.toString(), 'GET');
    const data = JSON.parse(response.body) as Result;
    return { data };
  }

  async post<Result = any, Entity = any>(
    path: string,
    entity: Entity,
    options: PostOptions = {},
  ): Promise<{ data: Result }> {
    const url = new URL(path, this.baseURL);
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    } else {
      headers['Idempotency-Key'] = crypto.randomUUID();
    }

    const response = await this.requestWithRetry(
      url.toString(),
      'POST',
      headers,
      JSON.stringify(entity),
    );
    const data = JSON.parse(response.body) as Result;
    return { data };
  }

  async put<Result = any, Entity = any>(
    path: string,
    entity: Entity,
    options: PutOptions = {},
  ): Promise<{ data: Result }> {
    const url = new URL(path, this.baseURL);
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const response = await this.requestWithRetry(
      url.toString(),
      'PUT',
      headers,
      JSON.stringify(entity),
    );
    const data = JSON.parse(response.body) as Result;
    return { data };
  }

  async patch<Result = any, Entity = any>(
    path: string,
    entity: Entity,
    options: PatchOptions = {},
  ): Promise<{ data: Result }> {
    const url = new URL(path, this.baseURL);
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const response = await this.requestWithRetry(
      url.toString(),
      'PATCH',
      headers,
      JSON.stringify(entity),
    );
    const data = JSON.parse(response.body) as Result;
    return { data };
  }

  async delete(path: string, query?: any): Promise<void> {
    const url = new URL(path, this.baseURL);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    await this.requestWithRetry(url.toString(), 'DELETE');
  }

  private async requestWithRetry(
    url: string,
    method: string,
    extraHeaders: Record<string, string> = {},
    body?: string,
  ) {
    const maxRetries = this.options.maxRetries ?? MAX_RETRY_ATTEMPTS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const headers: Record<string, string> = {
        Authorization: \`Bearer \${this.key}\`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      };

      const response = await this.client.request(url, method, headers, body);

      if (response.status < 400) {
        return response;
      }

      if (RETRYABLE_STATUSES.includes(response.status) && attempt < maxRetries) {
        const retryAfter = response.headers['retry-after'];
        const delay = retryAfter
          ? parseFloat(retryAfter) * 1000
          : Math.min(Math.pow(2, attempt) * BACKOFF_MULTIPLIER * 1000 + Math.random() * 500, 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      this.handleHttpError(response.status, response.body, url, response.headers);
    }

    throw new Error('Max retries exceeded');
  }

  private handleHttpError(
    status: number,
    body: string,
    path: string,
    headers: Record<string, string>,
  ): never {
    let parsed: any = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // ignore parse errors
    }

    const requestID = headers['x-request-id'] ?? '';
    const message = parsed.message;
    const code = parsed.code;

    switch (status) {
      case 400:
        throw new BadRequestException({ code, message, requestID });
      case 401:
        throw new UnauthorizedException({ message, requestID });
      case 404:
        throw new NotFoundException({ code, message, path, requestID });
      case 409:
        throw new ConflictException({ code, message, requestID });
      case 422:
        throw new UnprocessableEntityException({ code, errors: parsed.errors, message, requestID });
      case 429:
        throw new RateLimitExceededException({
          message,
          retryAfter: headers['retry-after'] ? parseFloat(headers['retry-after']) : undefined,
          requestID,
        });
      default:
        throw new GenericServerException(status, message, parsed, requestID);
    }
  }
}
`;

  const files: GeneratedFile[] = [
    {
      path: `src/${nsKebab}.ts`,
      content,
      skipIfExists: true,
    },
  ];

  // Factory function
  files.push({
    path: 'src/factory.ts',
    skipIfExists: true,
    content: `import { ${ns} } from './${nsKebab}';
import type { ${ns}Options } from './common/interfaces/${nsKebab}-options.interface';

export function create${ns}(keyOrOptions?: string | ${ns}Options): ${ns} {
  return new ${ns}(keyOrOptions);
}
`,
  });

  // Main barrel export
  files.push({
    path: 'src/index.ts',
    skipIfExists: true,
    content: generateBarrelExport(ctx),
  });

  return files;
}

function generateBarrelExport(ctx: EmitterContext): string {
  const ns = ctx.namespacePascal;
  const nsKebab = ctx.namespacePascal.toLowerCase();
  const lines: string[] = [];

  lines.push(`export { ${ns} } from './${nsKebab}';`);
  lines.push(`export { create${ns} } from './factory';`);
  lines.push(`export * from './common/interfaces/index';`);
  lines.push(`export * from './common/exceptions/index';`);
  lines.push(`export * from './common/utils/index';`);

  for (const service of ctx.spec.services) {
    const className = nodeClassName(service.name);
    const fileName = nodeFileName(service.name);
    lines.push(`export { ${className} } from './${fileName}/${fileName}';`);
    lines.push(`export * from './${fileName}/interfaces/index';`);
    lines.push(`export * from './${fileName}/serializers/index';`);
  }

  lines.push('');
  return lines.join('\n');
}
