import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { collectModelRefs, collectResponseHeaders } from '../../src/ir/types.js';
import type { Model, Operation } from '../../src/ir/types.js';

/**
 * Covers issue #295 on the parser side: header names are case-insensitive
 * (RFC 9110 §5.1), but the parser merged a path item's parameters with an
 * operation's on the exact `in:name`, so a path-level `X-Pet-Token` and an
 * operation-level `x-pet-token` were kept as two header parameters. Every
 * site that asks whether two parameters are the same one now goes through
 * `parameterKey` (`src/ir/parameter-key.ts`): the operation and webhook
 * parameter merges, the `Idempotency-Key` detection, and a response's
 * `headers` map, whose keys OpenAPI declares case-insensitive too.
 */
const fixtures = resolve(import.meta.dirname, '../fixtures');

const ok = { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } } };

/** The only operation an inline paths object declares, with the models it minted. */
function single(paths: Record<string, unknown>): { op: Operation; inlineModels: Model[] } {
  const { services, inlineModels } = extractOperations(paths as never);
  const operations = services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return { op: operations[0], inlineModels };
}

/** Every model reference an operation's parameters, body, response and headers make. */
function modelRefsOf(op: Operation): string[] {
  const refs = [
    ...op.pathParams,
    ...op.queryParams,
    ...op.headerParams,
    ...(op.cookieParams ?? []),
    ...collectResponseHeaders(op),
  ].map((p) => p.type);
  if (op.requestBody) refs.push(op.requestBody);
  refs.push(op.response);
  return refs.flatMap((ref) => collectModelRefs(ref)).sort();
}

/** Nothing dangles and nothing is orphaned: every reference names a minted model and every minted model is referenced. */
function expectSound(op: Operation, inlineModels: Model[]): void {
  const minted = inlineModels.map((m) => m.name).sort();
  const referenced = [
    ...new Set([...modelRefsOf(op), ...inlineModels.flatMap((m) => m.fields.flatMap((f) => collectModelRefs(f.type)))]),
  ].sort();
  expect(referenced.filter((name) => !minted.includes(name))).toEqual([]);
  expect(minted.filter((name) => !referenced.includes(name))).toEqual([]);
}

describe('operation parameters – a path-level and an operation-level header that differ in case alone (#295)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is one parameter, the operation's, through parseSpec (the issue's document)", async () => {
    const spec = await parseSpec(resolve(fixtures, 'header-param-case-path-item.json'));
    const [getPet] = spec.services.flatMap((service) => service.operations);
    expect(getPet.name).toBe('getPet');
    expect(getPet.pathParams.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'petId', required: true },
    ]);
    // Used to be `[{ X-Pet-Token, true }, { x-pet-token, false }]`.
    expect(getPet.headerParams.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'x-pet-token', required: false },
    ]);
    expect(spec.models).toEqual([]);
  });

  it("keeps the operation's declaration in the path-level position, so parameter order is the path item's", () => {
    const { op } = single({
      '/pets/{petId}': {
        parameters: [
          { name: 'X-Pet-Token', in: 'header', required: true, description: 'Path level.', schema: { type: 'string' } },
          { name: 'Accept-Language', in: 'header', schema: { type: 'string' } },
          { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        get: {
          operationId: 'getPet',
          parameters: [
            { name: 'x-pet-token', in: 'header', description: 'Operation level.', schema: { type: 'integer' } },
          ],
          responses: ok,
        },
      },
    });
    expect(
      op.headerParams.map(({ name, required, description, type }) => ({ name, required, description, type })),
    ).toEqual([
      {
        name: 'x-pet-token',
        required: false,
        description: 'Operation level.',
        type: { kind: 'primitive', type: 'integer' },
      },
      { name: 'Accept-Language', required: false, description: undefined, type: { kind: 'primitive', type: 'string' } },
    ]);
  });

  it('lets the later of two same-level declarations win, as it does for two spelled the same', () => {
    const { op } = single({
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            { name: 'X-Pet-Token', in: 'header', required: true, schema: { type: 'string' } },
            { name: 'x-pet-token', in: 'header', schema: { type: 'string' } },
          ],
          responses: ok,
        },
      },
    });
    expect(op.headerParams.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'x-pet-token', required: false },
    ]);
  });

  it('merges a `components/parameters` ref on the same identity', () => {
    const { services } = extractOperations(
      {
        '/pets': {
          parameters: [{ $ref: '#/components/parameters/PetToken' }],
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'x-pet-token', in: 'header', schema: { type: 'string' } }],
            responses: ok,
          },
        },
      } as never,
      undefined,
      undefined,
      { PetToken: { name: 'X-Pet-Token', in: 'header', required: true, schema: { type: 'string' } } },
    );
    const [op] = services.flatMap((s) => s.operations);
    expect(op.headerParams.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'x-pet-token', required: false },
    ]);
  });

  it('keeps a header apart from a query parameter of the same folded name', () => {
    const { op } = single({
      '/pets': {
        parameters: [{ name: 'X-Pet-Token', in: 'header', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'x-pet-token', in: 'query', schema: { type: 'string' } }],
          responses: ok,
        },
      },
    });
    expect(op.headerParams.map((p) => p.name)).toEqual(['X-Pet-Token']);
    expect(op.queryParams.map((p) => p.name)).toEqual(['x-pet-token']);
  });

  it('keeps path and query names case-sensitive', () => {
    const { op } = single({
      '/pets': {
        parameters: [{ name: 'Limit', in: 'query', schema: { type: 'integer' } }],
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
          responses: ok,
        },
      },
    });
    expect(op.queryParams.map((p) => p.name)).toEqual(['Limit', 'limit']);
  });

  it('mints one model for an object-shaped header overridden across case, nothing dangling or orphaned', () => {
    const { op, inlineModels } = single({
      '/pets': {
        parameters: [
          { name: 'X-Pet-Meta', in: 'header', schema: { type: 'object', properties: { etag: { type: 'string' } } } },
        ],
        get: {
          operationId: 'listPets',
          parameters: [
            {
              name: 'x-pet-meta',
              in: 'header',
              schema: { type: 'object', properties: { etag: { type: 'string' }, origin: { type: 'string' } } },
            },
          ],
          responses: ok,
        },
      },
    });
    expect(op.headerParams.map((p) => [p.name, p.type])).toEqual([
      ['x-pet-meta', { kind: 'model', name: 'PetsXPetMeta' }],
    ]);
    expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
      ['PetsXPetMeta', ['etag', 'origin']],
    ]);
    expectSound(op, inlineModels);
  });

  it('detects `Idempotency-Key` whatever its case, once, and keeps it out of headerParams', () => {
    const { op } = single({
      '/pets': {
        parameters: [{ name: 'IDEMPOTENCY-KEY', in: 'header', schema: { type: 'string' } }],
        post: {
          operationId: 'createPet',
          parameters: [{ name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } }],
          responses: ok,
        },
      },
    });
    expect(op.injectIdempotencyKey).toBe(true);
    expect(op.headerParams).toEqual([]);
  });
});

describe('names minted from a header derive from its lower-cased name (#295, review round 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const policy = { type: 'string', enum: ['burst', 'sustained'] };
  const meta = { type: 'object', properties: { etag: { type: 'string' } } };

  it.each(['X-RateLimit-Policy', 'x-ratelimit-policy', 'X-RATELIMIT-POLICY'])(
    'names the inline enum of header parameter %s `PetsXRatelimitPolicy`',
    (name) => {
      const { op } = single({
        '/pets': {
          get: { operationId: 'listPets', parameters: [{ name, in: 'header', schema: policy }], responses: ok },
        },
      });
      expect(op.headerParams[0].type).toMatchObject({ kind: 'enum', name: 'PetsXRatelimitPolicy' });
    },
  );

  it.each(['X-RateLimit-Meta', 'x-ratelimit-meta'])(
    'names the inline object of header parameter %s `PetsXRatelimitMeta`, nothing dangling or orphaned',
    (name) => {
      const { op, inlineModels } = single({
        '/pets': {
          get: { operationId: 'listPets', parameters: [{ name, in: 'header', schema: meta }], responses: ok },
        },
      });
      expect(op.headerParams[0].type).toEqual({ kind: 'model', name: 'PetsXRatelimitMeta' });
      expect(inlineModels.map((m) => m.name)).toEqual(['PetsXRatelimitMeta']);
      expectSound(op, inlineModels);
    },
  );

  it.each(['X-RateLimit-Policy', 'x-ratelimit-policy'])(
    'names the inline enum of response header %s `PetsXRatelimitPolicy`',
    (name) => {
      const { op } = single({
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: { '200': { ...ok['200'], headers: { [name]: { schema: policy } } } },
          },
        },
      });
      expect(op.responseHeaders![0]).toMatchObject({ name, type: { kind: 'enum', name: 'PetsXRatelimitPolicy' } });
    },
  );

  it.each(['X-RateLimit-Meta', 'x-ratelimit-meta'])(
    'names the inline object of response header %s `PetsXRatelimitMeta`, nothing dangling or orphaned',
    (name) => {
      const { op, inlineModels } = single({
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: { '200': { ...ok['200'], headers: { [name]: { schema: meta } } } },
          },
        },
      });
      expect(op.responseHeaders![0]).toEqual({
        name,
        type: { kind: 'model', name: 'PetsXRatelimitMeta' },
        required: false,
        description: undefined,
        deprecated: undefined,
      });
      expect(inlineModels.map((m) => m.name)).toEqual(['PetsXRatelimitMeta']);
      expectSound(op, inlineModels);
    },
  );

  it('keeps a query parameter name as written, since only header names fold', () => {
    const { op, inlineModels } = single({
      '/pets': {
        get: { operationId: 'listPets', parameters: [{ name: 'rateLimit', in: 'query', schema: meta }], responses: ok },
      },
    });
    expect(op.queryParams[0].type).toEqual({ kind: 'model', name: 'PetsRateLimit' });
    expect(inlineModels.map((m) => m.name)).toEqual(['PetsRateLimit']);
  });

  it.each(['X-RateLimit-Policy', 'x-ratelimit-policy'])(
    'names a webhook header %s under the stem from the lower-cased name, enum and object alike',
    (name) => {
      const { webhooks, inlineModels } = extractWebhooks({
        petAdopted: {
          post: {
            parameters: [
              { name, in: 'header', schema: policy },
              { name: name.replace(/policy/i, 'Meta'), in: 'header', schema: meta },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      });
      const [hook] = webhooks;
      expect(hook.headerParams.map((p) => p.type)).toEqual([
        expect.objectContaining({ kind: 'enum', name: 'PetAdoptedXRatelimitPolicy' }),
        { kind: 'model', name: 'PetAdoptedXRatelimitMeta' },
      ]);
      expect(inlineModels.map((m) => m.name)).toEqual(['PetAdoptedXRatelimitMeta']);
    },
  );
});

describe('webhook parameters – a path-item-level and an operation-level header that differ in case alone (#295)', () => {
  it("is one parameter, the operation's, in the path-item-level position", () => {
    const { webhooks } = extractWebhooks({
      petAdopted: {
        parameters: [
          { name: 'X-Pet-Signature', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'X-Delivery-Id', in: 'header', schema: { type: 'string' } },
        ],
        post: {
          parameters: [{ name: 'x-pet-signature', in: 'header', schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    });
    const [hook] = webhooks;
    expect(hook.headerParams.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'x-pet-signature', required: false },
      { name: 'X-Delivery-Id', required: false },
    ]);
  });

  it('keeps query and cookie names case-sensitive', () => {
    const { webhooks } = extractWebhooks({
      petAdopted: {
        parameters: [
          { name: 'Attempt', in: 'query', schema: { type: 'integer' } },
          { name: 'Session', in: 'cookie', schema: { type: 'string' } },
        ],
        post: {
          parameters: [
            { name: 'attempt', in: 'query', schema: { type: 'integer' } },
            { name: 'session', in: 'cookie', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    });
    const [hook] = webhooks;
    expect(hook.queryParams.map((p) => p.name)).toEqual(['Attempt', 'attempt']);
    expect(hook.cookieParams!.map((p) => p.name)).toEqual(['Session', 'session']);
  });
});

describe('response headers – two keys of one response that differ in case alone (#295)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the later key, in the earlier position, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { op } = single({
      '/pets': {
        get: {
          operationId: 'listPets',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'string' } } },
              headers: {
                'X-Request-Id': { required: true, schema: { type: 'string' } },
                ETag: { schema: { type: 'string' } },
                'x-request-id': { description: 'Later.', schema: { type: 'integer' } },
              },
            },
          },
        },
      },
    });
    expect(
      op.responseHeaders!.map(({ name, required, description, type }) => ({ name, required, description, type })),
    ).toEqual([
      { name: 'x-request-id', required: false, description: 'Later.', type: { kind: 'primitive', type: 'integer' } },
      { name: 'ETag', required: false, description: undefined, type: { kind: 'primitive', type: 'string' } },
    ]);
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      '[oagen] Warning: Response header "x-request-id" on listPets 200 is also declared as "X-Request-Id"; header names are case-insensitive, so the later declaration is used.',
    ]);
  });

  it('ignores `Content-Type` whatever its case', () => {
    const { op } = single({
      '/pets': {
        get: {
          operationId: 'listPets',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'string' } } },
              headers: { 'content-type': { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } },
            },
          },
        },
      },
    });
    expect(op.responseHeaders!.map((h) => h.name)).toEqual(['ETag']);
  });

  it('mints one model for an object-shaped header declared twice, nothing dangling or orphaned', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { op, inlineModels } = single({
      '/pets': {
        get: {
          operationId: 'listPets',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'string' } } },
              headers: {
                'X-Meta': { schema: { type: 'object', properties: { etag: { type: 'string' } } } },
                'x-meta': {
                  schema: { type: 'object', properties: { etag: { type: 'string' }, origin: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    });
    expect(op.responseHeaders!.map((h) => [h.name, h.type])).toEqual([
      ['x-meta', { kind: 'model', name: 'PetsXMeta' }],
    ]);
    expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([['PetsXMeta', ['etag', 'origin']]]);
    expectSound(op, inlineModels);
  });
});

/**
 * Covers issue #414: OpenAPI says the definition of a header parameter named
 * `Accept`, `Content-Type` or `Authorization` "SHALL be ignored" — the
 * request's media types and `security` set those headers — but the parser
 * kept all three in `headerParams`, on operations and webhooks alike,
 * whatever their case. They are now dropped once a `components/parameters`
 * ref is resolved, before anything types them, wherever they are declared.
 */
describe('header parameters named Accept, Content-Type or Authorization, which OpenAPI says to ignore (#414)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops them from the operation and the webhook alike, whatever their case, through parseSpec (the issue's document)", async () => {
    const spec = await parseSpec(resolve(fixtures, 'header-param-ignored-after.json'));
    const [listPets] = spec.services.flatMap((service) => service.operations);
    // Used to be `['X-Pet-Token', 'Accept', 'content-type', 'AUTHORIZATION']`.
    expect(listPets.headerParams.map((p) => p.name)).toEqual(['X-Pet-Token']);
    // Used to be `['authorization', 'Content-Type', 'ACCEPT']`, the first from the path item.
    expect(spec.webhooks!.map((hook) => [hook.name, hook.headerParams])).toEqual([['petAdded', []]]);
  });

  it('drops one a Path Item declares or a `components/parameters` ref names, keeping every other header', () => {
    const { services } = extractOperations(
      {
        '/pets': {
          parameters: [
            { name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } },
            { name: 'X-Pet-Token', in: 'header', schema: { type: 'string' } },
          ],
          post: {
            operationId: 'createPet',
            parameters: [
              { $ref: '#/components/parameters/Accept' },
              { name: 'authorization', in: 'header', schema: { type: 'string' } },
              { name: 'IDEMPOTENCY-KEY', in: 'header', schema: { type: 'string' } },
              { name: 'Accept-Language', in: 'header', schema: { type: 'string' } },
            ],
            responses: ok,
          },
        },
      } as never,
      undefined,
      undefined,
      { Accept: { name: 'ACCEPT', in: 'header', required: true, schema: { type: 'string' } } },
    );
    const [op] = services.flatMap((s) => s.operations);
    expect(op.headerParams.map((p) => p.name)).toEqual(['X-Pet-Token', 'Accept-Language']);
    // The idempotency header is still detected, and still the SDK's to inject.
    expect(op.injectIdempotencyKey).toBe(true);
  });

  it('types nothing from one: no model or enum from its schema, no warning about its `content` map', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { op, inlineModels } = single({
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            { name: 'Accept', in: 'header', schema: { type: 'string', enum: ['application/json', 'text/csv'] } },
            {
              name: 'Content-Type',
              in: 'header',
              schema: { type: 'object', properties: { charset: { type: 'string' } } },
            },
            { name: 'Authorization', in: 'header', content: { 'application/xml': { schema: { type: 'string' } } } },
          ],
          responses: ok,
        },
      },
    });
    expect(op.headerParams).toEqual([]);
    expect(inlineModels).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a query parameter or a cookie of those names, since only a header is ignored', () => {
    const { op } = single({
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            { name: 'Accept', in: 'query', schema: { type: 'string' } },
            { name: 'Authorization', in: 'cookie', schema: { type: 'string' } },
            { name: 'Content-Type', in: 'header', schema: { type: 'string' } },
          ],
          responses: ok,
        },
      },
    });
    expect(op.queryParams.map((p) => p.name)).toEqual(['Accept']);
    expect(op.cookieParams!.map((p) => p.name)).toEqual(['Authorization']);
    expect(op.headerParams).toEqual([]);
  });

  it('drops them from a webhook, one its path item declares through a ref included, minting nothing for them', () => {
    const { webhooks, inlineModels } = extractWebhooks(
      {
        petAdded: {
          parameters: [
            { $ref: '#/components/parameters/Auth' },
            { name: 'X-Pet-Signature', in: 'header', required: true, schema: { type: 'string' } },
          ],
          post: {
            parameters: [
              {
                name: 'content-type',
                in: 'header',
                schema: { type: 'object', properties: { charset: { type: 'string' } } },
              },
              { name: 'Accept', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      { parameters: { Auth: { name: 'AUTHORIZATION', in: 'header', required: true, schema: { type: 'string' } } } },
    );
    const [hook] = webhooks;
    expect(hook.headerParams.map((p) => p.name)).toEqual(['X-Pet-Signature']);
    expect(hook.queryParams.map((p) => p.name)).toEqual(['Accept']);
    expect(inlineModels).toEqual([]);
  });

  // Review round 1 (MichaelDeBoey): a dropped header is missing from the
  // parameter map the group builder reads, so a variant naming it failed the
  // whole parse with `references parameter "Authorization" which does not
  // exist in the operation's parameters[]` — but the parameter is there, and
  // the document parsed before #414. The member is dropped with a warning
  // that names the cause instead, as is a variant or a group left empty.
  it('drops one an x-mutually-exclusive-parameter-groups variant names, with a warning, rather than failing the parse', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { op } = single({
      '/notes': {
        get: {
          operationId: 'listNotes',
          parameters: [
            { name: 'Authorization', in: 'header', schema: { type: 'string' } },
            { name: 'api_key', in: 'query', schema: { type: 'string' } },
            { name: 'token', in: 'query', schema: { type: 'string' } },
          ],
          'x-mutually-exclusive-parameter-groups': {
            auth: {
              optional: true,
              // `both` spells the header in another case: a header name is case-insensitive.
              variants: { header: ['Authorization'], query: ['api_key'], both: ['authorization', 'token'] },
            },
            bearer: { optional: false, variants: { header: ['Authorization'] } },
          },
          responses: ok,
        },
      },
    });
    expect(op.headerParams).toEqual([]);
    expect(
      op.parameterGroups?.map((group) => [
        group.name,
        group.optional,
        group.variants.map((variant) => [variant.name, variant.parameters.map((p) => p.name)]),
      ]),
    ).toEqual([
      [
        'auth',
        true,
        [
          ['query', ['api_key']],
          ['both', ['token']],
        ],
      ],
    ]);
    // The kept members are the operation's own parameter objects, as always.
    expect(op.parameterGroups![0].variants[1].parameters[0]).toBe(op.queryParams.find((p) => p.name === 'token'));
    const dropped = (variant: string, name: string) =>
      `[oagen] Warning: x-mutually-exclusive-parameter-groups.auth.variants.${variant} in listNotes names the header ` +
      `parameter "${name}", which OpenAPI says to ignore (an Accept, Content-Type or Authorization header is set by ` +
      "the request's media types and security, not by a parameter). Dropping it from the variant.";
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      dropped('header', 'Authorization'),
      '[oagen] Warning: x-mutually-exclusive-parameter-groups.auth.variants.header in listNotes names only header ' +
        'parameters OpenAPI says to ignore. Dropping the variant.',
      dropped('both', 'authorization'),
      '[oagen] Warning: x-mutually-exclusive-parameter-groups.bearer.variants.header in listNotes names the header ' +
        'parameter "Authorization", which OpenAPI says to ignore (an Accept, Content-Type or Authorization header is ' +
        "set by the request's media types and security, not by a parameter). Dropping it from the variant.",
      '[oagen] Warning: x-mutually-exclusive-parameter-groups.bearer.variants.header in listNotes names only header ' +
        'parameters OpenAPI says to ignore. Dropping the variant.',
      '[oagen] Warning: x-mutually-exclusive-parameter-groups.bearer in listNotes is left with no variant once the ' +
        'header parameters OpenAPI says to ignore are dropped. Dropping the group.',
    ]);
  });

  it('still fails the parse over a variant member no parameter declares, ignored header or not', () => {
    const parse = (member: string) =>
      single({
        '/notes': {
          get: {
            operationId: 'listNotes',
            parameters: [
              { name: 'Accept', in: 'header', schema: { type: 'string' } },
              { name: 'api_key', in: 'query', schema: { type: 'string' } },
            ],
            'x-mutually-exclusive-parameter-groups': {
              auth: { optional: true, variants: { header: [member], query: ['api_key'] } },
            },
            responses: ok,
          },
        },
      });
    // `Authorization` is not declared at all here, so it is no ignored header of this operation.
    for (const member of ['X-Api-Key', 'Authorization']) {
      expect(() => parse(member)).toThrow(
        `x-mutually-exclusive-parameter-groups.auth.variants.header references parameter "${member}" which does not ` +
          "exist in the operation's parameters[] (listNotes).",
      );
    }
  });
});
