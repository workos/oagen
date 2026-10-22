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
