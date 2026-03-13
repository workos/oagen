import { describe, it, expect } from 'vitest';
import { planOperation, resolveResponseModelName } from '../../src/engine/operation-plan.js';
import type { Operation } from '../../src/ir/types.js';

function makeOp(overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'test',
    httpMethod: 'get',
    path: '/test',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'string' },
    errors: [],
    paginated: false,
    idempotent: false,
    ...overrides,
  };
}

describe('planOperation', () => {
  it('DELETE operation', () => {
    const plan = planOperation(makeOp({ httpMethod: 'delete' }));
    expect(plan).toMatchInlineSnapshot(`
      {
        "hasBody": false,
        "hasQueryParams": false,
        "isDelete": true,
        "isIdempotentPost": false,
        "isModelResponse": false,
        "isPaginated": false,
        "operation": {
          "errors": [],
          "headerParams": [],
          "httpMethod": "delete",
          "idempotent": false,
          "name": "test",
          "paginated": false,
          "path": "/test",
          "pathParams": [],
          "queryParams": [],
          "response": {
            "kind": "primitive",
            "type": "string",
          },
        },
        "pathParamsInOptions": false,
        "responseModelName": null,
      }
    `);
  });

  it('GET with model response', () => {
    const plan = planOperation(
      makeOp({ response: { kind: 'model', name: 'Organization' } }),
    );
    expect(plan).toMatchInlineSnapshot(`
      {
        "hasBody": false,
        "hasQueryParams": false,
        "isDelete": false,
        "isIdempotentPost": false,
        "isModelResponse": true,
        "isPaginated": false,
        "operation": {
          "errors": [],
          "headerParams": [],
          "httpMethod": "get",
          "idempotent": false,
          "name": "test",
          "paginated": false,
          "path": "/test",
          "pathParams": [],
          "queryParams": [],
          "response": {
            "kind": "model",
            "name": "Organization",
          },
        },
        "pathParamsInOptions": false,
        "responseModelName": "Organization",
      }
    `);
  });

  it('POST with body and idempotent', () => {
    const plan = planOperation(
      makeOp({
        httpMethod: 'post',
        idempotent: true,
        requestBody: { kind: 'model', name: 'CreateOrgPayload' },
        response: { kind: 'model', name: 'Organization' },
      }),
    );
    expect(plan).toMatchInlineSnapshot(`
      {
        "hasBody": true,
        "hasQueryParams": false,
        "isDelete": false,
        "isIdempotentPost": true,
        "isModelResponse": true,
        "isPaginated": false,
        "operation": {
          "errors": [],
          "headerParams": [],
          "httpMethod": "post",
          "idempotent": true,
          "name": "test",
          "paginated": false,
          "path": "/test",
          "pathParams": [],
          "queryParams": [],
          "requestBody": {
            "kind": "model",
            "name": "CreateOrgPayload",
          },
          "response": {
            "kind": "model",
            "name": "Organization",
          },
        },
        "pathParamsInOptions": false,
        "responseModelName": "Organization",
      }
    `);
  });

  it('single path param, no body/query → pathParamsInOptions false', () => {
    const plan = planOperation(
      makeOp({
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      }),
    );
    expect(plan.pathParamsInOptions).toBe(false);
  });

  it('single path param + body → pathParamsInOptions true', () => {
    const plan = planOperation(
      makeOp({
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        requestBody: { kind: 'model', name: 'UpdatePayload' },
      }),
    );
    expect(plan.pathParamsInOptions).toBe(true);
  });

  it('single path param + query → pathParamsInOptions true', () => {
    const plan = planOperation(
      makeOp({
        pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        queryParams: [{ name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false }],
      }),
    );
    expect(plan.pathParamsInOptions).toBe(true);
  });

  it('multiple path params → pathParamsInOptions true', () => {
    const plan = planOperation(
      makeOp({
        pathParams: [
          { name: 'org_id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'user_id', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      }),
    );
    expect(plan.pathParamsInOptions).toBe(true);
  });

  it('paginated operation', () => {
    const plan = planOperation(
      makeOp({
        paginated: true,
        response: { kind: 'model', name: 'Organization' },
      }),
    );
    expect(plan.isPaginated).toBe(true);
    expect(plan.responseModelName).toBe('Organization');
  });

  it('array response extracts inner model name', () => {
    const plan = planOperation(
      makeOp({
        response: { kind: 'array', items: { kind: 'model', name: 'User' } },
      }),
    );
    expect(plan.responseModelName).toBe('User');
    expect(plan.isModelResponse).toBe(true);
  });

  it('nullable response extracts inner model name', () => {
    const plan = planOperation(
      makeOp({
        response: { kind: 'nullable', inner: { kind: 'model', name: 'Session' } },
      }),
    );
    expect(plan.responseModelName).toBe('Session');
    expect(plan.isModelResponse).toBe(true);
  });

  it('union response extracts first model variant', () => {
    const plan = planOperation(
      makeOp({
        response: {
          kind: 'union',
          variants: [
            { kind: 'primitive', type: 'string' },
            { kind: 'model', name: 'Connection' },
          ],
        },
      }),
    );
    expect(plan.responseModelName).toBe('Connection');
    expect(plan.isModelResponse).toBe(true);
  });

  it('primitive response → null responseModelName', () => {
    const plan = planOperation(
      makeOp({
        response: { kind: 'primitive', type: 'boolean' },
      }),
    );
    expect(plan.responseModelName).toBeNull();
    expect(plan.isModelResponse).toBe(false);
  });

  it('enum response → null responseModelName', () => {
    const plan = planOperation(
      makeOp({
        response: { kind: 'enum', name: 'Status' },
      }),
    );
    expect(plan.responseModelName).toBeNull();
    expect(plan.isModelResponse).toBe(false);
  });
});

describe('resolveResponseModelName', () => {
  it('returns null for DELETE regardless of response type', () => {
    expect(
      resolveResponseModelName(makeOp({ httpMethod: 'delete', response: { kind: 'model', name: 'Foo' } })),
    ).toBeNull();
  });
});
