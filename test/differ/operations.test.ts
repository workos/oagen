import { describe, it, expect } from 'vitest';
import { diffOperations } from '../../src/differ/operations.js';
import type { Operation, ResponseContent, TypeRef } from '../../src/ir/types.js';

const listUsers: Operation = {
  name: 'listUsers',
  httpMethod: 'get',
  path: '/users',
  pathParams: [],
  queryParams: [
    { name: 'cursor', type: { kind: 'primitive', type: 'string' }, required: false },
    { name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false },
  ],
  headerParams: [],
  response: { kind: 'array', items: { kind: 'model', name: 'User' } },
  errors: [],
  pagination: { strategy: 'cursor', param: 'cursor', dataPath: 'data', itemType: { kind: 'model', name: 'User' } },
  injectIdempotencyKey: false,
};

const getUser: Operation = {
  name: 'getUser',
  httpMethod: 'get',
  path: '/users/{user_id}',
  pathParams: [{ name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true }],
  queryParams: [],
  headerParams: [],
  response: { kind: 'model', name: 'User' },
  errors: [],
  injectIdempotencyKey: false,
};

describe('diffOperations — response content types', () => {
  const string: TypeRef = { kind: 'primitive', type: 'string' };
  const binary: TypeRef = { kind: 'primitive', type: 'string', format: 'binary' };
  const contents = (entries: Array<[string, TypeRef]>): ResponseContent[] =>
    entries.map(([contentType, type]) => ({ contentType, type }));
  /** The issue's card operation, as the parser builds it: `response` is the PDF, the entry for it shares the object. */
  const card = (entries: Array<[string, TypeRef]>, over: Partial<Operation> = {}): Operation => ({
    name: 'renderPetCard',
    httpMethod: 'get',
    path: '/pets/{petId}/card',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: binary,
    responseContentTypes: entries.map(([contentType]) => contentType),
    responseContents: contents(entries),
    errors: [],
    injectIdempotencyKey: false,
    ...over,
  });

  it('reports a removed media type as breaking', () => {
    const changes = diffOperations(
      'Pets',
      [
        card([
          ['text/html', string],
          ['application/pdf', binary],
        ]),
      ],
      [card([['application/pdf', binary]])],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      responseChanged: false,
      responseContentTypesChanged: true,
      responseContentTypeChanges: [{ added: [], removed: ['text/html'], retyped: [], classification: 'breaking' }],
      classification: 'breaking',
    });
    // The primary of a single-2xx operation carries no status code.
    expect(
      Object.keys((changes[0] as { responseContentTypeChanges: object[] }).responseContentTypeChanges[0]),
    ).not.toContain('statusCode');
  });

  it('reports an added media type as additive', () => {
    const changes = diffOperations(
      'Pets',
      [card([['application/pdf', binary]])],
      [
        card([
          ['application/pdf', binary],
          ['text/html', string],
        ]),
      ],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      responseContentTypesChanged: true,
      responseContentTypeChanges: [{ added: ['text/html'], removed: [], retyped: [], classification: 'additive' }],
      classification: 'additive',
    });
  });

  it('reports a retyped secondary media type as breaking', () => {
    const changes = diffOperations(
      'Pets',
      [
        card([
          ['text/html', string],
          ['application/pdf', binary],
        ]),
      ],
      [
        card([
          ['text/html', { kind: 'model', name: 'CardPage' }],
          ['application/pdf', binary],
        ]),
      ],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      responseChanged: false,
      responseContentTypeChanges: [{ added: [], removed: [], retyped: ['text/html'], classification: 'breaking' }],
      classification: 'breaking',
    });
  });

  it('reports no change for the same media types in another order', () => {
    const changes = diffOperations(
      'Pets',
      [
        card([
          ['text/html', string],
          ['application/pdf', binary],
        ]),
      ],
      [
        card([
          ['application/pdf', binary],
          ['text/html', string],
        ]),
      ],
    );
    expect(changes).toHaveLength(0);
  });

  it("does not report the primary media type's own retyping a second time", () => {
    const report: TypeRef = { kind: 'model', name: 'Report' };
    const thing: TypeRef = { kind: 'model', name: 'Thing' };
    const changes = diffOperations(
      'Reports',
      [card([['application/json', report]], { name: 'getReport', response: report })],
      [card([['application/json', thing]], { name: 'getReport', response: thing })],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      responseChanged: true,
      responseContentTypesChanged: false,
      responseContentTypeChanges: [],
      classification: 'breaking',
    });
  });

  it('covers error entries, by status code, in both directions', () => {
    const error: TypeRef = { kind: 'model', name: 'Error' };
    const withError = (entries: Array<[string, TypeRef]>) =>
      card([['application/pdf', binary]], {
        errors: [
          {
            statusCode: 404,
            type: error,
            contentTypes: entries.map(([contentType]) => contentType),
            contents: contents(entries),
          },
        ],
      });
    const both = withError([
      ['application/json', error],
      ['text/html', string],
    ]);
    const jsonOnly = withError([['application/json', error]]);

    const dropped = diffOperations('Pets', [both], [jsonOnly]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      errorsChanged: false,
      responseContentTypeChanges: [{ statusCode: 404, removed: ['text/html'], classification: 'breaking' }],
      classification: 'breaking',
    });

    const gained = diffOperations('Pets', [jsonOnly], [both]);
    expect(gained).toHaveLength(1);
    expect(gained[0]).toMatchObject({
      responseContentTypeChanges: [{ statusCode: 404, added: ['text/html'], classification: 'additive' }],
      classification: 'additive',
    });
  });

  it('covers alternate 2xx entries by status code, listing the primary once', () => {
    const job: TypeRef = { kind: 'model', name: 'Job' };
    const startJob = (created: Array<[string, TypeRef]>): Operation => {
      const primary = contents([['application/json', job]]);
      return card([], {
        name: 'startJob',
        httpMethod: 'post',
        path: '/jobs',
        response: job,
        responseContentTypes: ['application/json'],
        responseContents: primary,
        successResponses: [
          { statusCode: 200, type: job, contentTypes: ['application/json'], contents: primary },
          {
            statusCode: 201,
            type: job,
            contentTypes: created.map(([contentType]) => contentType),
            contents: contents(created),
          },
        ],
      });
    };
    const changes = diffOperations(
      'Jobs',
      [startJob([['application/json', job]])],
      [
        startJob([
          ['application/json', job],
          ['application/x-ndjson', string],
        ]),
      ],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      responseChanged: false,
      responseContentTypeChanges: [{ statusCode: 201, added: ['application/x-ndjson'], classification: 'additive' }],
      classification: 'additive',
    });
  });
});

describe('diffOperations', () => {
  it('returns empty for identical operations', () => {
    const changes = diffOperations('Users', [listUsers, getUser], [listUsers, getUser]);
    expect(changes).toHaveLength(0);
  });

  it('detects operation added', () => {
    const changes = diffOperations('Users', [listUsers], [listUsers, getUser]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-added',
      serviceName: 'Users',
      operationName: 'getUser',
      classification: 'additive',
    });
  });

  it('detects operation removed', () => {
    const changes = diffOperations('Users', [listUsers, getUser], [listUsers]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-removed',
      serviceName: 'Users',
      operationName: 'getUser',
      classification: 'breaking',
    });
  });

  it('detects param added (optional = additive)', () => {
    const modified: Operation = {
      ...listUsers,
      queryParams: [
        ...listUsers.queryParams,
        { name: 'filter', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
    };
    const changes = diffOperations('Users', [listUsers], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].classification).toBe('additive');
      expect(changes[0].paramChanges[0]).toMatchObject({
        kind: 'param-added',
        paramName: 'filter',
        classification: 'additive',
      });
    }
  });

  it('detects param added (required = breaking)', () => {
    const modified: Operation = {
      ...listUsers,
      queryParams: [
        ...listUsers.queryParams,
        { name: 'org_id', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    };
    const changes = diffOperations('Users', [listUsers], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects param removed (breaking)', () => {
    const modified: Operation = {
      ...listUsers,
      queryParams: [listUsers.queryParams[0]],
    };
    const changes = diffOperations('Users', [listUsers], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].classification).toBe('breaking');
      expect(changes[0].paramChanges[0]).toMatchObject({ kind: 'param-removed', paramName: 'limit' });
    }
  });

  it('detects response type changed (breaking)', () => {
    const modified: Operation = {
      ...getUser,
      response: { kind: 'model', name: 'Team' },
    };
    const changes = diffOperations('Users', [getUser], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].responseChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects param type changed (breaking)', () => {
    const modified: Operation = {
      ...listUsers,
      queryParams: listUsers.queryParams.map((p) =>
        p.name === 'limit' ? { ...p, type: { kind: 'primitive' as const, type: 'string' as const } } : p,
      ),
    };
    const changes = diffOperations('Users', [listUsers], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paramChanges[0]).toMatchObject({ kind: 'param-type-changed', paramName: 'limit' });
    }
  });

  it('classifies adding format to a primitive param as additive (param-format-changed)', () => {
    const modified: Operation = {
      ...listUsers,
      queryParams: listUsers.queryParams.map((p) =>
        p.name === 'cursor'
          ? { ...p, type: { kind: 'primitive' as const, type: 'string' as const, format: 'uuid' } }
          : p,
      ),
    };
    const changes = diffOperations('Users', [listUsers], [modified]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'operation-modified', classification: 'additive' });
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paramChanges[0]).toMatchObject({
        kind: 'param-format-changed',
        paramName: 'cursor',
        classification: 'additive',
      });
      expect(changes[0].paramChanges[0].details).toContain('uuid');
    }
  });

  it('still reports a real param base-type change as breaking', () => {
    const modified: Operation = {
      ...listUsers,
      queryParams: listUsers.queryParams.map((p) =>
        p.name === 'limit'
          ? { ...p, type: { kind: 'primitive' as const, type: 'string' as const, format: 'int64' } }
          : p,
      ),
    };
    const changes = diffOperations('Users', [listUsers], [modified]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'operation-modified', classification: 'breaking' });
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paramChanges[0]).toMatchObject({ kind: 'param-type-changed', paramName: 'limit' });
    }
  });

  it('detects param required changed', () => {
    const modified: Operation = {
      ...listUsers,
      queryParams: listUsers.queryParams.map((p) => (p.name === 'cursor' ? { ...p, required: true } : p)),
    };
    const changes = diffOperations('Users', [listUsers], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paramChanges[0]).toMatchObject({
        kind: 'param-required-changed',
        paramName: 'cursor',
        classification: 'breaking',
      });
    }
  });

  it('detects header param changes', () => {
    const withHeader: Operation = {
      ...getUser,
      headerParams: [{ name: 'X-Request-Id', type: { kind: 'primitive', type: 'string' }, required: false }],
    };
    const changes = diffOperations('Users', [getUser], [withHeader]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paramChanges[0]).toMatchObject({ kind: 'param-added', paramName: 'X-Request-Id' });
    }
  });

  it('detects requestBody added (breaking)', () => {
    const withBody: Operation = {
      ...getUser,
      requestBody: { kind: 'model', name: 'UpdateUser' },
    };
    const changes = diffOperations('Users', [getUser], [withBody]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].requestBodyChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects requestBody removed (breaking)', () => {
    const withBody: Operation = { ...getUser, requestBody: { kind: 'model', name: 'UpdateUser' } };
    const changes = diffOperations('Users', [withBody], [getUser]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].requestBodyChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects requestBody type changed (breaking)', () => {
    const old: Operation = { ...getUser, requestBody: { kind: 'model', name: 'CreateUser' } };
    const modified: Operation = { ...getUser, requestBody: { kind: 'model', name: 'UpdateUser' } };
    const changes = diffOperations('Users', [old], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].requestBodyChanged).toBe(true);
    }
  });

  it('detects httpMethod changed (breaking)', () => {
    const modified: Operation = { ...getUser, httpMethod: 'post' };
    const changes = diffOperations('Users', [getUser], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].httpMethodChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects path changed (breaking)', () => {
    const modified: Operation = { ...getUser, path: '/v2/users/{user_id}' };
    const changes = diffOperations('Users', [getUser], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].pathChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects paginated true→false as breaking', () => {
    const modified: Operation = { ...listUsers, pagination: undefined };
    const changes = diffOperations('Users', [listUsers], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paginatedChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects paginated false→true as additive', () => {
    const modified: Operation = {
      ...getUser,
      pagination: {
        strategy: 'cursor',
        param: 'after',
        dataPath: 'data',
        itemType: { kind: 'primitive', type: 'string' },
      },
    };
    const changes = diffOperations('Users', [getUser], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paginatedChanged).toBe(true);
      expect(changes[0].classification).toBe('additive');
    }
  });

  it('detects injectIdempotencyKey true→false as breaking', () => {
    const idempotentOp: Operation = { ...getUser, injectIdempotencyKey: true };
    const modified: Operation = { ...getUser, injectIdempotencyKey: false };
    const changes = diffOperations('Users', [idempotentOp], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].injectIdempotencyKeyChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects injectIdempotencyKey false→true as additive', () => {
    const modified: Operation = { ...getUser, injectIdempotencyKey: true };
    const changes = diffOperations('Users', [getUser], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].injectIdempotencyKeyChanged).toBe(true);
      expect(changes[0].classification).toBe('additive');
    }
  });

  it('detects error responses added as additive', () => {
    const modified: Operation = {
      ...getUser,
      errors: [{ statusCode: 404, type: { kind: 'model', name: 'NotFoundError' } }],
    };
    const changes = diffOperations('Users', [getUser], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].errorsChanged).toBe(true);
      expect(changes[0].classification).toBe('additive');
    }
  });

  it('detects error responses removed as breaking', () => {
    const withErrors: Operation = {
      ...getUser,
      errors: [{ statusCode: 404, type: { kind: 'model', name: 'NotFoundError' } }],
    };
    const changes = diffOperations('Users', [withErrors], [getUser]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].errorsChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects error response type changed as breaking', () => {
    const old: Operation = {
      ...getUser,
      errors: [{ statusCode: 404, type: { kind: 'model', name: 'NotFoundError' } }],
    };
    const modified: Operation = {
      ...getUser,
      errors: [{ statusCode: 404, type: { kind: 'model', name: 'GenericError' } }],
    };
    const changes = diffOperations('Users', [old], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].errorsChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('classifies as breaking when error code added AND removed simultaneously (breaking wins)', () => {
    const old: Operation = {
      ...getUser,
      errors: [{ statusCode: 401, type: { kind: 'model', name: 'UnauthorizedError' } }],
    };
    const modified: Operation = {
      ...getUser,
      errors: [{ statusCode: 404, type: { kind: 'model', name: 'NotFoundError' } }],
    };
    const changes = diffOperations('Users', [old], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].errorsChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('classifies as breaking when shared error code has type added where none existed', () => {
    const old: Operation = {
      ...getUser,
      errors: [{ statusCode: 422 }],
    };
    const modified: Operation = {
      ...getUser,
      errors: [{ statusCode: 422, type: { kind: 'model', name: 'ValidationError' } }],
    };
    const changes = diffOperations('Users', [old], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].errorsChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects no change when shared error code has both types undefined', () => {
    const old: Operation = {
      ...getUser,
      errors: [{ statusCode: 500 }],
    };
    const modified: Operation = {
      ...getUser,
      errors: [{ statusCode: 500 }],
    };
    const changes = diffOperations('Users', [old], [modified]);
    expect(changes).toHaveLength(0);
  });

  it('detects no change when both error arrays are empty', () => {
    const old: Operation = { ...getUser, errors: [] };
    const modified: Operation = { ...getUser, errors: [] };
    const changes = diffOperations('Users', [old], [modified]);
    expect(changes).toHaveLength(0);
  });

  it('detects param default removed (breaking behavior change)', () => {
    const orderParam = {
      name: 'order',
      type: { kind: 'primitive' as const, type: 'string' as const },
      required: false,
      default: 'desc',
    };
    const old: Operation = { ...listUsers, queryParams: [...listUsers.queryParams, orderParam] };
    const modified: Operation = {
      ...listUsers,
      queryParams: [...listUsers.queryParams, { ...orderParam, default: undefined }],
    };
    const changes = diffOperations('Users', [old], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].classification).toBe('breaking');
      const defaultChange = changes[0].paramChanges.find((pc) => pc.kind === 'param-default-changed');
      expect(defaultChange).toMatchObject({
        kind: 'param-default-changed',
        paramName: 'order',
        classification: 'breaking',
        oldDefault: 'desc',
        newDefault: null,
        paramLocation: 'query',
      });
    }
  });

  it('detects param default value changed (breaking behavior change)', () => {
    const limitParam = {
      name: 'limit',
      type: { kind: 'primitive' as const, type: 'integer' as const },
      required: false,
      default: 10,
    };
    const old: Operation = {
      ...listUsers,
      queryParams: [listUsers.queryParams[0], limitParam],
    };
    const modified: Operation = {
      ...listUsers,
      queryParams: [listUsers.queryParams[0], { ...limitParam, default: 50 }],
    };
    const changes = diffOperations('Users', [old], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      const defaultChange = changes[0].paramChanges.find((pc) => pc.kind === 'param-default-changed');
      expect(defaultChange).toMatchObject({
        kind: 'param-default-changed',
        paramName: 'limit',
        oldDefault: '10',
        newDefault: '50',
      });
    }
  });

  it('does not emit param-default-changed when default is unchanged', () => {
    const orderParam = {
      name: 'order',
      type: { kind: 'primitive' as const, type: 'string' as const },
      required: false,
      default: 'desc',
    };
    const op: Operation = { ...listUsers, queryParams: [...listUsers.queryParams, orderParam] };
    const changes = diffOperations('Users', [op], [op]);
    expect(changes).toHaveLength(0);
  });

  it('detects param default added (also a behavior change)', () => {
    const orderParam = {
      name: 'order',
      type: { kind: 'primitive' as const, type: 'string' as const },
      required: false,
    };
    const old: Operation = { ...listUsers, queryParams: [...listUsers.queryParams, orderParam] };
    const modified: Operation = {
      ...listUsers,
      queryParams: [...listUsers.queryParams, { ...orderParam, default: 'asc' }],
    };
    const changes = diffOperations('Users', [old], [modified]);
    if (changes[0].kind === 'operation-modified') {
      const defaultChange = changes[0].paramChanges.find((pc) => pc.kind === 'param-default-changed');
      expect(defaultChange).toMatchObject({
        oldDefault: null,
        newDefault: 'asc',
      });
    }
  });
});
