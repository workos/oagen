import { describe, it, expect } from 'vitest';
import { expandDocUrls } from '../../src/utils/expand-doc-urls.js';
import { collectResponseHeaders } from '../../src/ir/types.js';
import type { ApiSpec, Operation, Parameter, ResponseHeader } from '../../src/ir/types.js';
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

  it('expands links in an enum description, and leaves the key absent where the parser left it absent (Greptile)', () => {
    const spec = minimalSpec({
      enums: [
        { name: 'Status', description: 'See the [Status guide](/reference/status).', values: [] },
        { name: 'Bare', values: [{ name: 'A', value: 'a' }] },
      ],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    expect(result.enums[0].description).toBe('See the [Status guide](https://workos.com/docs/reference/status).');
    expect('description' in result.enums[1]).toBe(false);
    expect('description' in result.enums[1].values[0]).toBe(false);
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

  it('expands a field or parameter link beside its description and leaves the key absent otherwise (issue #247)', () => {
    const type = { kind: 'primitive', type: 'string' } as const;
    const spec = minimalSpec({
      services: [
        {
          name: 'Pets',
          operations: [
            {
              name: 'listPets',
              httpMethod: 'get',
              path: '/pets',
              pathParams: [{ name: 'id', type, required: true, externalDocs: link }],
              queryParams: [{ name: 'q', type, required: false, description: 'See [q](/reference/q).' }],
              bodyOwnedQueryParams: [{ name: 'b', type, required: false, externalDocs: link }],
              headerParams: [{ name: 'X-H', type, required: false, externalDocs: link }],
              response: type,
              errors: [],
              injectIdempotencyKey: false,
            },
          ],
        },
      ],
      models: [
        {
          name: 'Pet',
          fields: [
            { name: 'a', type, required: false, externalDocs: link, description: 'See [a](/reference/a).' },
            { name: 'b', type, required: false },
          ],
        },
      ],
    });

    const result = expandDocUrls(spec, 'https://workos.com/docs');
    const [op] = result.services[0].operations;
    expect(op.pathParams[0].externalDocs).toEqual(expanded);
    expect(op.bodyOwnedQueryParams![0].externalDocs).toEqual(expanded);
    expect(op.headerParams[0].externalDocs).toEqual(expanded);
    expect(op.queryParams[0]).toEqual({
      name: 'q',
      type,
      required: false,
      description: 'See [q](https://workos.com/docs/reference/q).',
    });
    expect('externalDocs' in op.queryParams[0]).toBe(false);
    const [a, b] = result.models[0].fields;
    expect(a).toEqual({
      name: 'a',
      type,
      required: false,
      externalDocs: expanded,
      description: 'See [a](https://workos.com/docs/reference/a).',
    });
    expect('externalDocs' in b).toBe(false);
  });
});

/**
 * PR #259 review: every collection that holds a documented node is walked —
 * `cookieParams`, each response-header list, the list envelope's companion
 * fields and `dataDescription`, and the mutually exclusive parameter groups
 * — for the description and the link alike, with `externalDocs.url` kept as
 * written. Before this, the description on those collections was not
 * expanded either (a pre-existing gap of the same class), and a grouped
 * parameter's copy in `parameterGroups` no longer shared identity with its
 * copy in `queryParams`.
 */
describe('expandDocUrls – every collection that holds a documented node', () => {
  const base = 'https://example.com/docs';
  const type = { kind: 'primitive', type: 'string' } as const;
  const relative = { url: '/guide', description: 'Read the [guide](/guide).' };
  const absolute = { url: '/guide', description: `Read the [guide](${base}/guide).` };
  const text = 'See the [guide](/guide).';
  const expandedText = `See the [guide](${base}/guide).`;
  const param = (name: string): Parameter => ({
    name,
    type,
    required: false,
    description: text,
    externalDocs: relative,
  });
  const header = (name: string): ResponseHeader => ({
    name,
    type,
    required: false,
    description: text,
    externalDocs: relative,
  });
  const operation = (overrides: Partial<Operation>): Operation => ({
    name: 'listPets',
    httpMethod: 'get',
    path: '/pets',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: type,
    errors: [],
    injectIdempotencyKey: false,
    ...overrides,
  });
  const run = (overrides: Partial<Operation>): Operation =>
    expandDocUrls(minimalSpec({ services: [{ name: 'Pets', operations: [operation(overrides)] }] }), base).services[0]
      .operations[0];
  const expectExpanded = (node: { description?: string; externalDocs?: { url: string; description?: string } }) => {
    expect(node.description).toBe(expandedText);
    expect(node.externalDocs).toEqual(absolute);
  };

  it('walks cookieParams', () => {
    const op = run({ cookieParams: [param('session')] });
    expectExpanded(op.cookieParams![0]);
  });

  it('walks the webhooks: prose, header, query and cookie parameters, and response descriptions (Greptile)', () => {
    const spec = minimalSpec({
      webhooks: [
        {
          name: 'petAdopted',
          httpMethod: 'post',
          summary: text,
          description: text,
          headerParams: [param('x-signature')],
          queryParams: [param('q')],
          cookieParams: [param('session')],
          responses: [{ statusCode: 200, description: text }],
        },
      ],
    });
    const [hook] = expandDocUrls(spec, base).webhooks!;
    expect(hook.summary).toBe(expandedText);
    expect(hook.description).toBe(expandedText);
    expectExpanded(hook.headerParams[0]);
    expectExpanded(hook.queryParams[0]);
    expectExpanded(hook.cookieParams![0]);
    expect(hook.responses[0].description).toBe(expandedText);
    // The key stays absent on a document without webhooks, and a webhook's optional keys stay absent too.
    expect('webhooks' in expandDocUrls(minimalSpec(), base)).toBe(false);
    const bare = expandDocUrls(
      minimalSpec({
        webhooks: [{ name: 'bare', httpMethod: 'post', headerParams: [], queryParams: [], responses: [] }],
      }),
      base,
    ).webhooks![0];
    expect('summary' in bare).toBe(false);
    expect('cookieParams' in bare).toBe(false);
  });

  it('walks the primary response headers', () => {
    const op = run({ responseHeaders: [header('X-Rate-Limit')] });
    expectExpanded(op.responseHeaders![0]);
  });

  it('walks the headers of each successResponses entry', () => {
    const op = run({
      successResponses: [
        { statusCode: 200, type, headers: [header('X-A')] },
        { statusCode: 202, type, headers: [header('X-B')], description: text },
      ],
    });
    expectExpanded(op.successResponses![0].headers![0]);
    expectExpanded(op.successResponses![1].headers![0]);
    expect(op.successResponses![1].description).toBe(expandedText);
  });

  it('walks the headers of each error response', () => {
    const op = run({ errors: [{ statusCode: 429, headers: [header('Retry-After')], description: text }] });
    expectExpanded(op.errors[0].headers![0]);
    expect(op.errors[0].description).toBe(expandedText);
  });

  it('reaches every header collectResponseHeaders yields, and keeps a shared primary list shared', () => {
    const primary = [header('X-Primary')];
    const op = run({
      responseHeaders: primary,
      successResponses: [
        { statusCode: 200, type, headers: primary },
        { statusCode: 202, type, headers: [header('X-Accepted')] },
      ],
      errors: [{ statusCode: 404, headers: [header('X-Missing')] }],
    });
    const all = collectResponseHeaders(op);
    expect(all.map((h) => h.name)).toEqual(['X-Primary', 'X-Accepted', 'X-Missing']);
    for (const h of all) expectExpanded(h);
    // The same array before, the same (expanded) array after.
    expect(op.responseHeaders).toBe(op.successResponses![0].headers);
  });

  it('walks the list envelope companion fields and dataDescription', () => {
    const op = run({
      pagination: {
        strategy: 'cursor',
        param: 'after',
        dataPath: 'data',
        dataDescription: text,
        itemType: type,
        envelopeFields: [{ name: 'list_metadata', type, required: false, description: text, externalDocs: relative }],
      },
    });
    expectExpanded(op.pagination!.envelopeFields![0]);
    expect(op.pagination!.dataDescription).toBe(expandedText);
  });

  it('walks parameter group members, which stay the same objects as their parameter list entries', () => {
    const byId = param('id');
    const byName = param('name');
    const op = run({
      queryParams: [byId, byName],
      parameterGroups: [
        {
          name: 'lookup',
          optional: false,
          variants: [
            { name: 'by_id', parameters: [byId] },
            { name: 'by_name', parameters: [byName], optionalParameters: ['name'] },
          ],
        },
      ],
    });
    const [group] = op.parameterGroups!;
    expectExpanded(group.variants[0].parameters[0]);
    expectExpanded(group.variants[1].parameters[0]);
    expect(group.variants[0].parameters[0]).toBe(op.queryParams[0]);
    expect(group.variants[1].parameters[0]).toBe(op.queryParams[1]);
    expect(group.variants[1].optionalParameters).toEqual(['name']);
    // The input is untouched.
    expect(byId.description).toBe(text);
  });

  it('walks bodyOwnedQueryParams and headerParams for the description too', () => {
    const op = run({ bodyOwnedQueryParams: [param('secret')], headerParams: [param('X-Trace')] });
    expectExpanded(op.bodyOwnedQueryParams![0]);
    expectExpanded(op.headerParams[0]);
  });

  it('leaves every optional collection key absent on an operation and service that lack it', () => {
    const op = run({});
    for (const key of [
      'summary',
      'responseDescription',
      'bodyOwnedQueryParams',
      'cookieParams',
      'parameterGroups',
      'responseHeaders',
      'successResponses',
      'pagination',
      'externalDocs',
    ]) {
      expect(key in op, key).toBe(false);
    }
    const service = expandDocUrls(minimalSpec({ services: [{ name: 'Pets', operations: [] }] }), base).services[0];
    expect('description' in service).toBe(false);
  });
});
