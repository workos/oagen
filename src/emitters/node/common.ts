import type { EmitterContext, GeneratedFile } from '../../engine/types.js';

export function generateCommon(_ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // AutoPaginatable
  files.push({
    path: 'src/common/utils/pagination.ts',
    skipIfExists: true,
    content: `import type { ListResponse } from '../interfaces/list.interface';

export class AutoPaginatable<T> implements AsyncIterable<T> {
  private data: T[];
  private after?: string;

  constructor(
    private readonly response: ListResponse<any>,
    private readonly deserializer: (raw: any) => T,
    private readonly fetcher: (params: Record<string, any>) => Promise<ListResponse<any>>,
    private readonly options?: Record<string, any>,
  ) {
    this.data = response.data.map(deserializer);
    this.after = response.list_metadata?.after;
  }

  getData(): T[] {
    return this.data;
  }

  getAfter(): string | undefined {
    return this.after;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (const item of this.data) {
      yield item;
    }

    let cursor = this.after;
    while (cursor) {
      const nextResponse = await this.fetcher({ ...this.options, after: cursor });
      const items = nextResponse.data.map(this.deserializer);
      for (const item of items) {
        yield item;
      }
      cursor = nextResponse.list_metadata?.after;
    }
  }
}
`,
  });

  // fetch-and-deserialize
  files.push({
    path: 'src/common/utils/fetch-and-deserialize.ts',
    skipIfExists: true,
    content: `import type { ListResponse } from '../interfaces/list.interface';
import { AutoPaginatable } from './pagination';

export async function fetchAndDeserialize<TResponse, TPublic>(
  client: { get: (path: string, options?: any) => Promise<{ data: any }> },
  path: string,
  deserializer: (raw: TResponse) => TPublic,
  options?: Record<string, any>,
): Promise<AutoPaginatable<TPublic>> {
  const { data } = await client.get<ListResponse<TResponse>>(path, {
    query: options,
  });

  return new AutoPaginatable<TPublic>(
    data,
    deserializer as (raw: any) => TPublic,
    async (params) => {
      const { data: nextData } = await client.get<ListResponse<TResponse>>(path, {
        query: params,
      });
      return nextData;
    },
    options,
  );
}
`,
  });

  // test-utils
  files.push({
    path: 'src/common/utils/test-utils.ts',
    skipIfExists: true,
    content: `import fetch from 'jest-fetch-mock';

export function fetchOnce(body: unknown, status = 200): void {
  fetch.mockResponseOnce(JSON.stringify(body), { status });
}

export function fetchURL(): string {
  const [url] = fetch.mock.calls[fetch.mock.calls.length - 1];
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.toString();
  if (url instanceof Request) return url.url;
  return String(url);
}

export function fetchSearchParams(): URLSearchParams {
  const url = fetchURL();
  return new URL(url).searchParams;
}

export function fetchHeaders(): Record<string, string> {
  const [, options] = fetch.mock.calls[fetch.mock.calls.length - 1];
  return (options?.headers as Record<string, string>) ?? {};
}

export function fetchBody(): unknown {
  const [, options] = fetch.mock.calls[fetch.mock.calls.length - 1];
  if (typeof options?.body === 'string') {
    return JSON.parse(options.body);
  }
  return options?.body;
}
`,
  });

  // Barrel export for utils
  files.push({
    path: 'src/common/utils/index.ts',
    skipIfExists: true,
    content: `export { AutoPaginatable } from './pagination';
export { fetchAndDeserialize } from './fetch-and-deserialize';
`,
  });

  // Abstract HttpClient
  files.push({
    path: 'src/common/net/http-client.ts',
    skipIfExists: true,
    content: `export interface HttpClientResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export abstract class HttpClient {
  abstract request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<HttpClientResponse>;
}
`,
  });

  // FetchHttpClient
  files.push({
    path: 'src/common/net/fetch-client.ts',
    skipIfExists: true,
    content: `import { HttpClient, type HttpClientResponse } from './http-client';

export class FetchHttpClient extends HttpClient {
  async request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<HttpClientResponse> {
    const response = await fetch(url, {
      method,
      headers,
      body,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body: await response.text(),
    };
  }
}
`,
  });

  // Net barrel
  files.push({
    path: 'src/common/net/index.ts',
    skipIfExists: true,
    content: `export { HttpClient, type HttpClientResponse } from './http-client';
export { FetchHttpClient } from './fetch-client';
`,
  });

  return files;
}
