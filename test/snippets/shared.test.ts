import { describe, expect, it } from 'vitest';
import { collectSnippetArgs, collectWrapperArgs, hiddenParamSet } from '../../src/snippets/shared.js';
import { createExampleBuilder } from '../../src/snippets/example-builder.js';
import type { EmitterContext } from '../../src/engine/types.js';
import type { ApiSpec, Operation, Service } from '../../src/ir/types.js';
import type { ResolvedOperation, ResolvedWrapper } from '../../src/ir/operation-hints.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

function makeSpec(services: Service[] = [], models: ApiSpec['models'] = []): ApiSpec {
  return {
    name: 'Test',
    version: '1.0.0',
    baseUrl: '',
    services,
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

function makeOp(overrides: Partial<Operation>): Operation {
  return {
    name: 'op',
    httpMethod: 'get',
    path: '/x',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'void' } as never,
    errors: [],
    injectIdempotencyKey: false,
    ...overrides,
  };
}

function makeResolved(op: Operation, service: Service, overrides: Partial<ResolvedOperation> = {}): ResolvedOperation {
  return {
    operation: op,
    service,
    methodName: op.name,
    mountOn: 'X',
    defaults: {},
    inferFromClient: [],
    urlBuilder: false,
    ...overrides,
  };
}

describe('snippets/shared: hiddenParamSet', () => {
  it('combines defaults keys and inferFromClient entries', () => {
    const op = makeOp({});
    const service: Service = { name: 'X', operations: [op] };
    const resolved = makeResolved(op, service, {
      defaults: { grant_type: 'password' },
      inferFromClient: ['client_id', 'client_secret'],
    });
    expect(hiddenParamSet(resolved)).toEqual(new Set(['grant_type', 'client_id', 'client_secret']));
  });
});

describe('snippets/shared: collectSnippetArgs', () => {
  it('walks path → body → query, only keeping required args', () => {
    const op = makeOp({
      pathParams: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, example: 'org_1' },
        { name: 'optional_path', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
      requestBody: { kind: 'model', name: 'Req' },
      queryParams: [
        { name: 'cursor', type: { kind: 'primitive', type: 'string' }, required: true, example: 'cur' },
        { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
      ],
    });
    const service: Service = { name: 'X', operations: [op] };
    const spec = makeSpec(
      [service],
      [
        {
          name: 'Req',
          fields: [
            { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true, example: 'Foo' },
            { name: 'note', type: { kind: 'primitive', type: 'string' }, required: false },
          ],
        },
      ],
    );
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: [makeResolved(op, service)],
    };
    const examples = createExampleBuilder(spec);
    const { args, collisionNames } = collectSnippetArgs(ctx.resolvedOperations![0]!, ctx, examples);
    expect(args.map((a) => a.wireName)).toEqual(['id', 'name', 'cursor']);
    expect(args.map((a) => a.source)).toEqual(['path', 'body', 'query']);
    expect(collisionNames.size).toBe(0);
  });

  it('reports body/path wire-name collisions for the caller to rename', () => {
    const op = makeOp({
      path: '/x/{id}',
      pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, example: 'p1' }],
      requestBody: { kind: 'model', name: 'Req' },
    });
    const service: Service = { name: 'X', operations: [op] };
    const spec = makeSpec(
      [service],
      [
        {
          name: 'Req',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, example: 'b1' }],
        },
      ],
    );
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: [makeResolved(op, service)],
    };
    const examples = createExampleBuilder(spec);
    const { collisionNames } = collectSnippetArgs(ctx.resolvedOperations![0]!, ctx, examples);
    expect(collisionNames).toEqual(new Set(['id']));
  });

  it('de-duplicates a field present in both the request body and query params', () => {
    const op = makeOp({
      path: '/sso/token',
      httpMethod: 'post',
      requestBody: { kind: 'model', name: 'Req' },
      queryParams: [{ name: 'code', type: { kind: 'primitive', type: 'string' }, required: true, example: 'q_code' }],
    });
    const service: Service = { name: 'X', operations: [op] };
    const spec = makeSpec(
      [service],
      [
        {
          name: 'Req',
          fields: [{ name: 'code', type: { kind: 'primitive', type: 'string' }, required: true, example: 'b_code' }],
        },
      ],
    );
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: [makeResolved(op, service)],
    };
    const examples = createExampleBuilder(spec);
    const { args } = collectSnippetArgs(ctx.resolvedOperations![0]!, ctx, examples);
    expect(args.map((a) => a.wireName)).toEqual(['code']);
    expect(args.map((a) => a.source)).toEqual(['body']);
  });

  it('keeps a query param that only shares a name with a path param', () => {
    // Dedup is scoped to body fields; a query param colliding with a path
    // param is positional vs. options, so both are retained (no silent drop).
    const op = makeOp({
      path: '/things/{id}',
      pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, example: 'p1' }],
      queryParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true, example: 'q1' }],
    });
    const service: Service = { name: 'X', operations: [op] };
    const spec = makeSpec([service]);
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: [makeResolved(op, service)],
    };
    const examples = createExampleBuilder(spec);
    const { args } = collectSnippetArgs(ctx.resolvedOperations![0]!, ctx, examples);
    expect(args.map((a) => a.source)).toEqual(['path', 'query']);
    expect(args.map((a) => a.wireName)).toEqual(['id', 'id']);
  });

  it('hides params injected via defaults or inferFromClient', () => {
    const op = makeOp({
      requestBody: { kind: 'model', name: 'Req' },
    });
    const service: Service = { name: 'X', operations: [op] };
    const spec = makeSpec(
      [service],
      [
        {
          name: 'Req',
          fields: [
            { name: 'grant_type', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'client_id', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true, example: 'a@b.co' },
          ],
        },
      ],
    );
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: [
        makeResolved(op, service, {
          defaults: { grant_type: 'password' },
          inferFromClient: ['client_id'],
        }),
      ],
    };
    const examples = createExampleBuilder(spec);
    const { args } = collectSnippetArgs(ctx.resolvedOperations![0]!, ctx, examples);
    expect(args.map((a) => a.wireName)).toEqual(['email']);
  });

  it('skips deprecated body fields', () => {
    const op = makeOp({ requestBody: { kind: 'model', name: 'Req' } });
    const service: Service = { name: 'X', operations: [op] };
    const spec = makeSpec(
      [service],
      [
        {
          name: 'Req',
          fields: [
            { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true, example: 'Foo' },
            { name: 'old', type: { kind: 'primitive', type: 'string' }, required: true, deprecated: true },
          ],
        },
      ],
    );
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: [makeResolved(op, service)],
    };
    const examples = createExampleBuilder(spec);
    const { args } = collectSnippetArgs(ctx.resolvedOperations![0]!, ctx, examples);
    expect(args.map((a) => a.wireName)).toEqual(['name']);
  });
});

describe('snippets/shared: collectWrapperArgs', () => {
  it('keeps wrapper exposedParams marked required by the variant model', () => {
    const op = makeOp({ requestBody: { kind: 'model', name: 'PwReq' } });
    const service: Service = { name: 'X', operations: [op] };
    const spec = makeSpec(
      [service],
      [
        {
          name: 'PwReq',
          fields: [
            { name: 'grant_type', type: { kind: 'primitive', type: 'string' }, required: true },
            { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true, example: 'u@e.co' },
            { name: 'password', type: { kind: 'primitive', type: 'string' }, required: true, example: 'pw' },
          ],
        },
      ],
    );
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: [makeResolved(op, service)],
    };
    const examples = createExampleBuilder(spec);
    const wrapper: ResolvedWrapper = {
      name: 'authenticate_with_password',
      targetVariant: 'PwReq',
      defaults: { grant_type: 'password' },
      inferFromClient: ['client_id'],
      exposedParams: ['email', 'password'],
      optionalParams: [],
      responseModelName: null,
    };
    const args = collectWrapperArgs(wrapper, ctx, examples);
    expect(args.map((a) => a.wireName)).toEqual(['email', 'password']);
  });

  it('drops wrapper params marked optional via optionalParams', () => {
    const op = makeOp({ requestBody: { kind: 'model', name: 'PwReq' } });
    const service: Service = { name: 'X', operations: [op] };
    const spec = makeSpec(
      [service],
      [
        {
          name: 'PwReq',
          fields: [
            { name: 'email', type: { kind: 'primitive', type: 'string' }, required: true, example: 'u@e.co' },
            { name: 'ip', type: { kind: 'primitive', type: 'string' }, required: true, example: '1.2.3.4' },
          ],
        },
      ],
    );
    const ctx: EmitterContext = {
      namespace: 'workos',
      namespacePascal: 'WorkOS',
      spec,
      resolvedOperations: [makeResolved(op, service)],
    };
    const examples = createExampleBuilder(spec);
    const wrapper: ResolvedWrapper = {
      name: 'authenticate_with_password',
      targetVariant: 'PwReq',
      defaults: {},
      inferFromClient: [],
      exposedParams: ['email', 'ip'],
      optionalParams: ['ip'],
      responseModelName: null,
    };
    const args = collectWrapperArgs(wrapper, ctx, examples);
    expect(args.map((a) => a.wireName)).toEqual(['email']);
  });
});
