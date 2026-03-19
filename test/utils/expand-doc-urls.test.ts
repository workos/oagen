import { describe, it, expect } from 'vitest';
import { expandDocUrls } from '../../src/utils/expand-doc-urls.js';
import type { ApiSpec } from '../../src/ir/types.js';

function minimalSpec(overrides: Partial<ApiSpec> = {}): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services: [],
    models: [],
    enums: [],
    ...overrides,
  };
}

describe('expandDocUrls', () => {
  it('expands relative paths in markdown links', () => {
    const spec = minimalSpec({
      models: [
        {
          name: 'Foo',
          fields: [
            {
              name: 'user_id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
              description: 'A [User](/reference/authkit/user) identifier.',
            },
          ],
        },
      ],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    expect(result.models[0].fields[0].description).toBe(
      'A [User](https://workos.com/docs/reference/authkit/user) identifier.',
    );
  });

  it('expands multiple links in one description', () => {
    const spec = minimalSpec({
      models: [
        {
          name: 'Foo',
          fields: [
            {
              name: 'org_id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
              description: 'An [Organization](/reference/organization) or [User](/reference/authkit/user) identifier.',
            },
          ],
        },
      ],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs/');
    expect(result.models[0].fields[0].description).toBe(
      'An [Organization](https://workos.com/docs/reference/organization) or [User](https://workos.com/docs/reference/authkit/user) identifier.',
    );
  });

  it('does not modify absolute URLs', () => {
    const spec = minimalSpec({
      models: [
        {
          name: 'Foo',
          fields: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
              description: 'See [docs](https://example.com/reference/foo).',
            },
          ],
        },
      ],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    expect(result.models[0].fields[0].description).toBe('See [docs](https://example.com/reference/foo).');
  });

  it('expands links in operation descriptions', () => {
    const spec = minimalSpec({
      services: [
        {
          name: 'Users',
          description: 'Manage [Users](/reference/users).',
          operations: [
            {
              name: 'getUser',
              description: 'Get a [User](/reference/authkit/user).',
              httpMethod: 'get',
              path: '/users/{id}',
              pathParams: [
                {
                  name: 'id',
                  type: { kind: 'primitive', type: 'string' },
                  required: true,
                  description: 'A [User](/reference/authkit/user) identifier.',
                },
              ],
              queryParams: [],
              headerParams: [],
              response: { kind: 'primitive', type: 'string' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    expect(result.services[0].description).toBe('Manage [Users](https://workos.com/docs/reference/users).');
    expect(result.services[0].operations[0].description).toBe(
      'Get a [User](https://workos.com/docs/reference/authkit/user).',
    );
    expect(result.services[0].operations[0].pathParams[0].description).toBe(
      'A [User](https://workos.com/docs/reference/authkit/user) identifier.',
    );
  });

  it('expands links in enum value descriptions', () => {
    const spec = minimalSpec({
      enums: [
        {
          name: 'Status',
          values: [
            {
              name: 'ACTIVE',
              value: 'active',
              description: 'See [statuses](/reference/statuses).',
            },
          ],
        },
      ],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    expect(result.enums[0].values[0].description).toBe('See [statuses](https://workos.com/docs/reference/statuses).');
  });

  it('leaves descriptions without relative links unchanged', () => {
    const spec = minimalSpec({
      models: [
        {
          name: 'Foo',
          fields: [
            {
              name: 'id',
              type: { kind: 'primitive', type: 'string' },
              required: true,
              description: 'A plain description with no links.',
            },
          ],
        },
      ],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    expect(result.models[0].fields[0].description).toBe('A plain description with no links.');
  });
});
