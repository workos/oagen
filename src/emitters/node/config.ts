import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { nodeFileName } from './naming.js';

export function generateConfig(ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;
  const nsKebab = nodeFileName(ctx.namespace);

  const files: GeneratedFile[] = [];

  // {Namespace}Options interface
  files.push({
    path: `src/common/interfaces/${nsKebab}-options.interface.ts`,
    skipIfExists: true,
    content: `export interface ${ns}Options {
  apiKey?: string;
  baseURL?: string;
  clientId?: string;
  maxRetries?: number;
}
`,
  });

  // HTTP method options interfaces
  files.push({
    path: 'src/common/interfaces/get-options.interface.ts',
    skipIfExists: true,
    content: `export interface GetOptions {
  query?: Record<string, any>;
  accessToken?: string;
}
`,
  });

  files.push({
    path: 'src/common/interfaces/post-options.interface.ts',
    skipIfExists: true,
    content: `export interface PostOptions {
  query?: Record<string, any>;
  idempotencyKey?: string;
}
`,
  });

  files.push({
    path: 'src/common/interfaces/put-options.interface.ts',
    skipIfExists: true,
    content: `export interface PutOptions {
  query?: Record<string, any>;
  idempotencyKey?: string;
}
`,
  });

  files.push({
    path: 'src/common/interfaces/patch-options.interface.ts',
    skipIfExists: true,
    content: `export interface PatchOptions {
  query?: Record<string, any>;
  idempotencyKey?: string;
}
`,
  });

  // List metadata and List interface
  files.push({
    path: 'src/common/interfaces/list.interface.ts',
    skipIfExists: true,
    content: `export interface ListMetadata {
  before?: string;
  after?: string;
}

export interface List<T> {
  object: 'list';
  data: T[];
  listMetadata: ListMetadata;
}

export interface ListResponse<T> {
  object: 'list';
  data: T[];
  list_metadata: {
    before?: string;
    after?: string;
  };
}
`,
  });

  // PaginationOptions
  files.push({
    path: 'src/common/interfaces/pagination-options.interface.ts',
    skipIfExists: true,
    content: `export interface PaginationOptions {
  limit?: number;
  before?: string;
  after?: string;
  order?: 'asc' | 'desc';
}
`,
  });

  // Common interfaces barrel
  files.push({
    path: 'src/common/interfaces/index.ts',
    skipIfExists: true,
    content: `export * from './${nsKebab}-options.interface';
export * from './get-options.interface';
export * from './post-options.interface';
export * from './put-options.interface';
export * from './patch-options.interface';
export * from './list.interface';
export * from './pagination-options.interface';
export * from './request-exception.interface';
`,
  });

  return files;
}
