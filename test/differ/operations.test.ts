import { describe, it, expect } from 'vitest';
import { diffOperations } from '../../src/differ/operations.js';
import type { Operation } from '../../src/ir/types.js';

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
});
