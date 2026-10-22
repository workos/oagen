import { describe, it, expect } from 'vitest';
import { expandDocUrls } from '../../src/utils/expand-doc-urls.js';
import type { ApiSpec } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

function minimalSpec(overrides: Partial<ApiSpec> = {}): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services: [],
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
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

describe('expandDocUrls operation summaries', () => {
  const operation: ApiSpec['services'][number]['operations'][number] = {
    name: 'getUser',
    description: 'Get a [User](/reference/authkit/user).',
    httpMethod: 'get',
    path: '/users/{id}',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'string' },
    errors: [],
    injectIdempotencyKey: false,
  };

  it('expands relative links in an operation summary alongside its description', () => {
    const spec = minimalSpec({
      services: [
        {
          name: 'Users',
          operations: [{ ...operation, summary: 'Get a [User](/reference/authkit/user)' }],
        },
      ],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    expect(result.services[0].operations[0].summary).toBe(
      'Get a [User](https://workos.com/docs/reference/authkit/user)',
    );
    expect(result.services[0].operations[0].description).toBe(
      'Get a [User](https://workos.com/docs/reference/authkit/user).',
    );
  });

  it('leaves the summary key absent on an operation that has none', () => {
    const spec = minimalSpec({
      services: [{ name: 'Users', operations: [{ ...operation }] }],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    expect(result.services[0].operations[0]).not.toHaveProperty('summary');
    expect(result.services[0].operations[0].description).toBe(
      'Get a [User](https://workos.com/docs/reference/authkit/user).',
    );
  });
});

describe('expandDocUrls response descriptions', () => {
  const operation: ApiSpec['services'][number]['operations'][number] = {
    name: 'getUser',
    httpMethod: 'get',
    path: '/users/{id}',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'model', name: 'User' },
    errors: [],
    injectIdempotencyKey: false,
  };

  it('expands relative links in the operation, success, and error response descriptions', () => {
    const spec = minimalSpec({
      services: [
        {
          name: 'Users',
          operations: [
            {
              ...operation,
              responseDescription: 'The [User](/reference/authkit/user).',
              successResponses: [
                {
                  statusCode: 200,
                  type: { kind: 'model', name: 'User' },
                  description: 'The [User](/reference/authkit/user).',
                },
                { statusCode: 204, type: { kind: 'primitive', type: 'unknown' } },
              ],
              errors: [
                { statusCode: 404, description: 'No [User](/reference/authkit/user) has that id.' },
                { statusCode: 429 },
              ],
            },
          ],
        },
      ],
    });

    const op = expandDocUrls(spec, 'https://workos.com/docs').services[0].operations[0];
    expect(op.responseDescription).toBe('The [User](https://workos.com/docs/reference/authkit/user).');
    expect(op.successResponses?.[0].description).toBe('The [User](https://workos.com/docs/reference/authkit/user).');
    expect(op.errors[0].description).toBe('No [User](https://workos.com/docs/reference/authkit/user) has that id.');
    // Entries without a description keep their shape.
    expect(op.successResponses?.[1]).not.toHaveProperty('description');
    expect(op.errors[1]).not.toHaveProperty('description');
  });

  it('expands relative links in default and range response descriptions (Greptile)', () => {
    const spec = minimalSpec({
      services: [
        {
          name: 'Users',
          operations: [
            {
              ...operation,
              defaultResponse: { type: { kind: 'model', name: 'Error' }, description: 'See [errors](/errors).' },
              rangeResponses: [{ range: '5XX', description: 'See [errors](/errors).' }, { range: '2XX' }],
            },
          ],
        },
      ],
    });
    const op = expandDocUrls(spec, 'https://workos.com/docs').services[0].operations[0];
    expect(op.defaultResponse?.description).toBe('See [errors](https://workos.com/docs/errors).');
    expect(op.rangeResponses?.[0].description).toBe('See [errors](https://workos.com/docs/errors).');
    expect(op.rangeResponses?.[1]).not.toHaveProperty('description');
  });

  it('leaves the keys absent on an operation whose responses have no descriptions', () => {
    const spec = minimalSpec({
      services: [{ name: 'Users', operations: [{ ...operation, errors: [{ statusCode: 404 }] }] }],
    });

    const op = expandDocUrls(spec, 'https://workos.com/docs').services[0].operations[0];
    expect(op).not.toHaveProperty('responseDescription');
    expect(op).not.toHaveProperty('successResponses');
    expect(op.errors).toEqual([{ statusCode: 404 }]);
    expect(op.errors[0]).not.toHaveProperty('description');
  });
});

describe('expandDocUrls – externalDocs (issue #217)', () => {
  const link = { url: '/reference/pets', description: 'See [pets](/reference/pets).' };
  const expanded = {
    url: '/reference/pets',
    description: 'See [pets](https://workos.com/docs/reference/pets).',
  };

  it('expands relative links in externalDocs descriptions and keeps every url verbatim', () => {
    const spec = minimalSpec({
      externalDocs: link,
      services: [
        {
          name: 'Pets',
          externalDocs: link,
          operations: [
            {
              name: 'listPets',
              externalDocs: link,
              httpMethod: 'get',
              path: '/pets',
              pathParams: [],
              queryParams: [],
              headerParams: [],
              response: { kind: 'primitive', type: 'string' },
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
      models: [{ name: 'Pet', externalDocs: link, fields: [] }],
      enums: [{ name: 'Status', externalDocs: link, values: [{ name: 'ACTIVE', value: 'active' }] }],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    // A relative url is relative to the document, not the doc site, so the
    // base is never prepended to it; only the CommonMark description changes.
    expect(result.externalDocs).toEqual(expanded);
    expect(result.services[0].externalDocs).toEqual(expanded);
    expect(result.services[0].operations[0].externalDocs).toEqual(expanded);
    expect(result.models[0].externalDocs).toEqual(expanded);
    expect(result.enums[0].externalDocs).toEqual(expanded);
  });

  it('keeps a link without a description as it is and leaves the key absent on nodes without one', () => {
    const spec = minimalSpec({
      services: [{ name: 'Pets', externalDocs: { url: 'https://docs.example.com/pets' }, operations: [] }],
      models: [{ name: 'Pet', fields: [] }],
      enums: [{ name: 'Status', values: [] }],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    expect(result.services[0].externalDocs).toEqual({ url: 'https://docs.example.com/pets' });
    expect('externalDocs' in result).toBe(false);
    expect('externalDocs' in result.models[0]).toBe(false);
    expect('externalDocs' in result.enums[0]).toBe(false);
  });
});
