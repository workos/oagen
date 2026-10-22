/**
 * The differ compares an operation's cookie parameters (#294).
 *
 * `diffParams` built both sides from `pathParams`, `queryParams` and
 * `headerParams` only, so deprecating, retyping or removing an operation's
 * cookie parameter came out as no change, while the same change on a
 * webhook's cookie parameter was reported. Operations and webhooks now walk
 * every location they carry through one `locatedParams`, keyed by `paramKey`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffOperations } from '../../src/differ/operations.js';
import { diffWebhooks } from '../../src/differ/webhooks.js';
import { locatedParams, paramKey } from '../../src/differ/params.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Operation, Parameter, Webhook } from '../../src/ir/types.js';

const stringType = { kind: 'primitive', type: 'string' } as const;
const integerType = { kind: 'primitive', type: 'integer' } as const;

/** The issue's optional `session` cookie (`{ type: 'string' }`). */
const session: Parameter = { name: 'session', type: stringType, required: false };

/** `GET /pets` (`listPets`) with no parameters at all. */
const bare: Operation = {
  name: 'listPets',
  httpMethod: 'get',
  path: '/pets',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: stringType,
  errors: [],
  injectIdempotencyKey: false,
};

/** The issue's `before.json` operation: `listPets` with the `session` cookie. */
const listPets: Operation = { ...bare, cookieParams: [session] };

/** A webhook carrying the same `session` cookie. */
const petAdopted: Webhook = {
  name: 'petAdopted',
  httpMethod: 'post',
  headerParams: [],
  queryParams: [],
  cookieParams: [session],
  requestBody: stringType,
  responses: [{ statusCode: 200 }],
};

const specOf = (op: Operation): ApiSpec => ({
  name: 'Pets',
  version: '1',
  baseUrl: 'https://api.example.com',
  models: [],
  enums: [],
  services: [{ name: 'Pets', operations: [op] }],
  sdk: defaultSdkBehavior(),
});

const paramChangesOf = (changes: ReturnType<typeof diffOperations>) =>
  changes[0]?.kind === 'operation-modified' ? changes[0].paramChanges : [];

describe('locatedParams', () => {
  it('walks an operation’s path, query, header and cookie parameters, in that order, each tagged with its location', () => {
    const op: Operation = {
      ...bare,
      pathParams: [{ name: 'id', type: stringType, required: true }],
      queryParams: [{ name: 'limit', type: integerType, required: false }],
      headerParams: [{ name: 'X-Trace', type: stringType, required: false }],
      cookieParams: [session],
    };
    expect(locatedParams(op)).toEqual([
      { p: op.pathParams[0], loc: 'path' },
      { p: op.queryParams[0], loc: 'query' },
      { p: op.headerParams[0], loc: 'header' },
      { p: session, loc: 'cookie' },
    ]);
  });

  it('yields nothing for an operation with no parameters, cookieParams absent included', () => {
    expect(locatedParams(bare)).toEqual([]);
  });

  it('walks a webhook’s query, header and cookie parameters in the same order, with no path entries', () => {
    const hook: Webhook = {
      ...petAdopted,
      headerParams: [{ name: 'X-Signature', type: stringType, required: true }],
      queryParams: [{ name: 'attempt', type: integerType, required: false }],
    };
    expect(locatedParams(hook)).toEqual([
      { p: hook.queryParams[0], loc: 'query' },
      { p: hook.headerParams[0], loc: 'header' },
      { p: session, loc: 'cookie' },
    ]);
  });

  it('leaves a query parameter the request body owns out', () => {
    const op: Operation = { ...bare, bodyOwnedQueryParams: [{ name: 'name', type: stringType, required: false }] };
    expect(locatedParams(op)).toEqual([]);
  });
});

describe('paramKey', () => {
  it('joins the location to the name, so a cookie and a query parameter of one name are two parameters', () => {
    expect(paramKey('cookie', 'session')).toBe('cookie:session');
    expect(paramKey('query', 'session')).not.toBe(paramKey('cookie', 'session'));
  });

  it("folds a header's name and no other, as `parameterKey` in ir/parameter-key.ts does (#295)", () => {
    expect(paramKey('header', 'X-Pet-Token')).toBe('header:x-pet-token');
    expect(paramKey('header', 'X-Pet-Token')).toBe(paramKey('header', 'x-pet-token'));
    expect(paramKey('cookie', 'Session')).not.toBe(paramKey('cookie', 'session'));
    expect(paramKey('query', 'Limit')).not.toBe(paramKey('query', 'limit'));
    expect(paramKey('path', 'petId')).not.toBe(paramKey('path', 'petid'));
  });
});

describe('diffOperations – cookie parameters (issue #294)', () => {
  it('reports nothing when the cookie parameter is unchanged', () => {
    expect(diffOperations('Pets', [listPets], [listPets])).toHaveLength(0);
  });

  it('reports the cookie parameter becoming deprecated, additive, and mirrors it into behaviorChanges', () => {
    const deprecated: Operation = { ...listPets, cookieParams: [{ ...session, deprecated: true }] };
    const changes = diffOperations('Pets', [listPets], [deprecated]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      deprecatedChanged: false,
      classification: 'additive',
    });
    // Used to be `[]`.
    expect(paramChangesOf(changes)).toEqual([
      {
        kind: 'param-deprecated-changed',
        paramName: 'session',
        classification: 'additive',
        paramLocation: 'cookie',
        oldDeprecated: false,
        newDeprecated: true,
        details: 'live → deprecated',
      },
    ]);
    expect(diffSpecs(specOf(listPets), specOf(deprecated)).behaviorChanges).toEqual([
      {
        kind: 'deprecated-changed',
        node: 'parameter',
        serviceName: 'Pets',
        operationName: 'listPets',
        paramName: 'session',
        paramLocation: 'cookie',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
    ]);
  });

  it('reports the cookie parameter removed, breaking', () => {
    const changes = diffOperations('Pets', [listPets], [bare]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'operation-modified', classification: 'breaking' });
    // Used to be `[]`.
    expect(paramChangesOf(changes)).toEqual([
      { kind: 'param-removed', paramName: 'session', classification: 'breaking', paramLocation: 'cookie' },
    ]);
  });

  it('reports the cookie parameter changing type, breaking', () => {
    const retyped: Operation = { ...listPets, cookieParams: [{ ...session, type: integerType }] };
    // Used to be `[]`.
    expect(paramChangesOf(diffOperations('Pets', [listPets], [retyped]))).toEqual([
      { kind: 'param-type-changed', paramName: 'session', classification: 'breaking', paramLocation: 'cookie' },
    ]);
  });

  it('reports a cookie parameter added: additive when optional, breaking when required', () => {
    expect(paramChangesOf(diffOperations('Pets', [bare], [listPets]))).toEqual([
      { kind: 'param-added', paramName: 'session', classification: 'additive', paramLocation: 'cookie' },
    ]);
    const required: Operation = { ...listPets, cookieParams: [{ ...session, required: true }] };
    expect(paramChangesOf(diffOperations('Pets', [bare], [required]))).toEqual([
      { kind: 'param-added', paramName: 'session', classification: 'breaking', paramLocation: 'cookie' },
    ]);
  });

  it('reports the cookie parameter’s requiredness flipping: breaking when it becomes required, additive when it stops', () => {
    const required: Operation = { ...listPets, cookieParams: [{ ...session, required: true }] };
    expect(paramChangesOf(diffOperations('Pets', [listPets], [required]))).toEqual([
      { kind: 'param-required-changed', paramName: 'session', classification: 'breaking', paramLocation: 'cookie' },
    ]);
    expect(paramChangesOf(diffOperations('Pets', [required], [listPets]))).toEqual([
      { kind: 'param-required-changed', paramName: 'session', classification: 'additive', paramLocation: 'cookie' },
    ]);
  });

  it('reports a default appearing on the cookie parameter, breaking, and mirrors it into behaviorChanges', () => {
    const defaulted: Operation = { ...listPets, cookieParams: [{ ...session, default: 'guest' }] };
    expect(paramChangesOf(diffOperations('Pets', [listPets], [defaulted]))).toEqual([
      {
        kind: 'param-default-changed',
        paramName: 'session',
        classification: 'breaking',
        paramLocation: 'cookie',
        oldDefault: null,
        newDefault: 'guest',
        details: 'default <unset> → guest',
      },
    ]);
    expect(diffSpecs(specOf(listPets), specOf(defaulted)).behaviorChanges).toEqual([
      {
        kind: 'param-default-changed',
        serviceName: 'Pets',
        operationName: 'listPets',
        paramName: 'session',
        paramLocation: 'cookie',
        oldDefault: null,
        newDefault: 'guest',
        classification: 'breaking',
      },
    ]);
  });

  it('reports a format change on the cookie parameter, additive', () => {
    const formatted: Operation = {
      ...listPets,
      cookieParams: [{ ...session, type: { ...stringType, format: 'uuid' } }],
    };
    expect(paramChangesOf(diffOperations('Pets', [listPets], [formatted]))).toEqual([
      {
        kind: 'param-format-changed',
        paramName: 'session',
        classification: 'additive',
        paramLocation: 'cookie',
        details: 'format <unset> → uuid',
      },
    ]);
  });

  it('keeps a cookie `session` apart from a query `session` on the same operation', () => {
    const both: Operation = { ...listPets, queryParams: [session] };
    const cookieRetyped: Operation = { ...both, cookieParams: [{ ...session, type: integerType }] };
    expect(paramChangesOf(diffOperations('Pets', [both], [cookieRetyped]))).toEqual([
      { kind: 'param-type-changed', paramName: 'session', classification: 'breaking', paramLocation: 'cookie' },
    ]);
    const queryGone: Operation = { ...both, queryParams: [] };
    expect(paramChangesOf(diffOperations('Pets', [both], [queryGone]))).toEqual([
      { kind: 'param-removed', paramName: 'session', classification: 'breaking', paramLocation: 'query' },
    ]);
  });

  it('reports the same entry for a retyped cookie on an operation and on a webhook', () => {
    const expected = {
      kind: 'param-type-changed',
      paramName: 'session',
      classification: 'breaking',
      paramLocation: 'cookie',
    };
    const retyped = [{ ...session, type: integerType }];
    const onHook = diffWebhooks([petAdopted], [{ ...petAdopted, cookieParams: retyped }]);
    expect(onHook[0]?.kind === 'webhook-modified' ? onHook[0].paramChanges : []).toEqual([expected]);
    expect(paramChangesOf(diffOperations('Pets', [listPets], [{ ...listPets, cookieParams: retyped }]))).toEqual([
      expected,
    ]);
  });
});

describe('diffOperations – query parameters the request body owns', () => {
  const name: Parameter = { name: 'name', type: stringType, required: false };
  const createPet: Operation = {
    ...bare,
    name: 'createPet',
    httpMethod: 'post',
    requestBody: { kind: 'model', name: 'CreatePetRequest' },
  };

  it('reports a query parameter the body takes over as removed at `query`, with no entry for the body-owned one', () => {
    const asQuery: Operation = { ...createPet, queryParams: [name] };
    const asBody: Operation = { ...createPet, bodyOwnedQueryParams: [name] };
    expect(paramChangesOf(diffOperations('Pets', [asQuery], [asBody]))).toEqual([
      { kind: 'param-removed', paramName: 'name', classification: 'breaking', paramLocation: 'query' },
    ]);
  });

  it('reports nothing for a body-owned query parameter that changes: its body field is what the differ compares', () => {
    const before: Operation = { ...createPet, bodyOwnedQueryParams: [name] };
    const after: Operation = { ...createPet, bodyOwnedQueryParams: [{ ...name, type: integerType, required: true }] };
    expect(diffOperations('Pets', [before], [after])).toEqual([]);
  });
});

describe('diffSpecs – end to end (issue #294 repro)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  const sessionCookie = (over: Record<string, unknown> = {}) => ({
    name: 'session',
    in: 'cookie',
    schema: { type: 'string' },
    ...over,
  });

  /** `GET /pets` (`operationId: listPets`) with the given parameters, as the issue's documents are written. */
  const doc = (parameters: unknown[]) => ({
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters,
          responses: {
            '200': { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } },
          },
        },
      },
    },
  });

  async function parse(name: string, document: unknown): Promise<ApiSpec> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-cookie-params-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(document));
    return parseSpec(file);
  }

  it('reports deprecated.json against before.json as param-deprecated-changed at cookie', async () => {
    const before = await parse('before.json', doc([sessionCookie()]));
    const diff = diffSpecs(before, await parse('deprecated.json', doc([sessionCookie({ deprecated: true })])));
    // Used to be `[]`.
    expect(diff.changes).toMatchObject([
      {
        kind: 'operation-modified',
        operationName: 'listPets',
        classification: 'additive',
        paramChanges: [
          {
            kind: 'param-deprecated-changed',
            paramName: 'session',
            classification: 'additive',
            paramLocation: 'cookie',
            oldDeprecated: false,
            newDeprecated: true,
            details: 'live → deprecated',
          },
        ],
      },
    ]);
    expect(diff.behaviorChanges).toMatchObject([
      {
        kind: 'deprecated-changed',
        node: 'parameter',
        operationName: 'listPets',
        paramName: 'session',
        paramLocation: 'cookie',
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
  });

  it('reports removed.json against before.json as param-removed at cookie, breaking', async () => {
    const before = await parse('before.json', doc([sessionCookie()]));
    const diff = diffSpecs(before, await parse('removed.json', doc([])));
    // Used to be `[]`.
    expect(diff.changes).toMatchObject([
      {
        kind: 'operation-modified',
        operationName: 'listPets',
        classification: 'breaking',
        paramChanges: [
          { kind: 'param-removed', paramName: 'session', classification: 'breaking', paramLocation: 'cookie' },
        ],
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 0 });
  });

  it('reports retyped.json against before.json as param-type-changed at cookie, breaking', async () => {
    const before = await parse('before.json', doc([sessionCookie()]));
    const diff = diffSpecs(before, await parse('retyped.json', doc([sessionCookie({ schema: { type: 'integer' } })])));
    // Used to be `[]`.
    expect(diff.changes).toMatchObject([
      {
        kind: 'operation-modified',
        operationName: 'listPets',
        classification: 'breaking',
        paramChanges: [
          { kind: 'param-type-changed', paramName: 'session', classification: 'breaking', paramLocation: 'cookie' },
        ],
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 0 });
  });

  it('reports the same retype on a webhook’s session cookie, as the issue shows', async () => {
    const hookDoc = (schema: unknown) => ({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {},
      webhooks: {
        petAdopted: {
          post: {
            parameters: [{ name: 'session', in: 'cookie', schema }],
            requestBody: { content: { 'application/json': { schema: { type: 'string' } } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });
    const before = await parse('hook-before.json', hookDoc({ type: 'string' }));
    const diff = diffSpecs(before, await parse('hook-retyped.json', hookDoc({ type: 'integer' })));
    expect(diff.changes).toMatchObject([
      {
        kind: 'webhook-modified',
        classification: 'breaking',
        paramChanges: [
          { kind: 'param-type-changed', paramName: 'session', classification: 'breaking', paramLocation: 'cookie' },
        ],
      },
    ]);
  });

  it('reports nothing when before.json is parsed twice', async () => {
    const a = await parse('before-a.json', doc([sessionCookie()]));
    const b = await parse('before-b.json', doc([sessionCookie()]));
    expect(diffSpecs(a, b).changes).toEqual([]);
  });
});
