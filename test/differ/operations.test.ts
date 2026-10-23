import { describe, it, expect } from 'vitest';
import { diffOperations } from '../../src/differ/operations.js';
import { extractOperations } from '../../src/parser/operations.js';
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
    // A hand-built lone 2xx that carries no `responseStatusCode` reports none.
    expect(
      Object.keys((changes[0] as { responseContentTypeChanges: object[] }).responseContentTypeChanges[0]),
    ).not.toContain('statusCode');
  });

  it('pairs entries by status code across a primary change, and reports a vanished 2xx as its formats removed (Greptile)', () => {
    // Old: 200 (PDF) primary, 201 (PDF + HTML). New: the 200 is gone and the 201,
    // now the lone 2xx, dropped HTML. This hand-built lone 2xx carries no
    // `responseStatusCode`, so the new primary pairs with the old primary
    // by shape (PDF vs PDF: nothing), and the
    // old 201 — which nothing else reports — is reported with its formats removed.
    const pdf = contents([['application/pdf', binary]]);
    const pdfHtml = contents([
      ['application/pdf', binary],
      ['text/html', string],
    ]);
    const old = card([['application/pdf', binary]], {
      successResponses: [
        { statusCode: 200, type: binary, contentTypes: ['application/pdf'], contents: pdf },
        { statusCode: 201, type: binary, contentTypes: ['application/pdf', 'text/html'], contents: pdfHtml },
      ],
    });
    (old.responseContents as ResponseContent[]) = pdf;
    const next = card([['application/pdf', binary]]);
    const changes = diffOperations('Pets', [old], [next]);
    expect(changes[0]).toMatchObject({
      responseContentTypesChanged: true,
      responseContentTypeChanges: [
        {
          statusCode: 201,
          added: [],
          removed: ['application/pdf', 'text/html'],
          retyped: [],
          classification: 'breaking',
        },
      ],
      classification: 'breaking',
    });

    // Both sides listing several 2xx: the primary pairs by its own code even when it moves.
    const oldTwo = card([['application/pdf', binary]], {
      successResponses: [
        { statusCode: 200, type: binary, contentTypes: ['application/pdf'], contents: pdf },
        { statusCode: 201, type: binary, contentTypes: ['application/pdf', 'text/html'], contents: pdfHtml },
      ],
    });
    (oldTwo.responseContents as ResponseContent[]) = pdf;
    const newPrimary201 = card([['application/pdf', binary]], {
      successResponses: [
        { statusCode: 201, type: binary, contentTypes: ['application/pdf'], contents: pdf },
        { statusCode: 202, type: { kind: 'primitive', type: 'unknown' } },
      ],
    });
    (newPrimary201.responseContents as ResponseContent[]) = pdf;
    const moved = diffOperations('Pets', [oldTwo], [newPrimary201]);
    expect(moved[0]).toMatchObject({
      responseContentTypeChanges: [
        { statusCode: 201, added: [], removed: ['text/html'], retyped: [], classification: 'breaking' },
        { statusCode: 200, added: [], removed: ['application/pdf'], retyped: [], classification: 'breaking' },
      ],
    });
  });

  it('pairs a lone 2xx with the entry that still offers its media types, not blindly with the other primary (Greptile)', () => {
    const pdf = contents([['application/pdf', binary]]);
    const pdfHtml = contents([
      ['application/pdf', binary],
      ['text/html', string],
    ]);
    // Old: a lone 201 offering PDF and HTML. New: a 200 offering PDF is added
    // and the 201 is untouched. The lone 201 pairs with the new 201, which
    // offers its media types, so the added 200 is not read as the 201 having
    // lost HTML: nothing changed for callers.
    const lone = card([
      ['application/pdf', binary],
      ['text/html', string],
    ]);
    const withAdded200 = card([['application/pdf', binary]], {
      successResponses: [
        { statusCode: 200, type: binary, contentTypes: ['application/pdf'], contents: pdf },
        { statusCode: 201, type: binary, contentTypes: ['application/pdf', 'text/html'], contents: pdfHtml },
      ],
    });
    (withAdded200.responseContents as ResponseContent[]) = pdf;
    expect(diffOperations('Pets', [lone], [withAdded200])).toEqual([]);

    // The other way round, the lone 201 pairs with the old 201, and the 200 that
    // is gone is reported with its formats removed.
    expect(diffOperations('Pets', [withAdded200], [lone])[0]).toMatchObject({
      responseContentTypeChanges: [
        { statusCode: 200, added: [], removed: ['application/pdf'], retyped: [], classification: 'breaking' },
      ],
      classification: 'breaking',
    });

    // When no entry offers the lone 2xx's media types any more, it pairs with
    // the other primary, and the formats that are gone are still reported.
    const htmlDropped = card([['application/pdf', binary]], {
      successResponses: [
        { statusCode: 200, type: binary, contentTypes: ['application/pdf'], contents: pdf },
        { statusCode: 201, type: binary, contentTypes: ['application/pdf'], contents: pdf },
      ],
    });
    (htmlDropped.responseContents as ResponseContent[]) = pdf;
    expect(diffOperations('Pets', [lone], [htmlDropped])[0]).toMatchObject({
      responseContentTypeChanges: [
        { statusCode: 200, added: [], removed: ['text/html'], retyped: [], classification: 'breaking' },
      ],
      classification: 'breaking',
    });
  });

  it('reports the own body of a lone 2xx that pairs with an old alternate entry, which responseChanged does not compare (Greptile)', () => {
    const integer: TypeRef = { kind: 'primitive', type: 'integer' };
    // Old: 200 (JSON string + HTML) primary, 201 (JSON integer). New: a lone
    // 201 (JSON string). `responseChanged` compares the two primaries — string
    // on both sides — so the 201's integer-to-string change is only ever seen
    // by this pairing, and must not be suppressed as covered elsewhere.
    const old = card(
      [
        ['application/json', string],
        ['text/html', string],
      ],
      {
        successResponses: [
          {
            statusCode: 200,
            type: string,
            contentTypes: ['application/json', 'text/html'],
            contents: contents([
              ['application/json', string],
              ['text/html', string],
            ]),
          },
          {
            statusCode: 201,
            type: integer,
            contentTypes: ['application/json'],
            contents: contents([['application/json', integer]]),
          },
        ],
      },
    );
    (old.responseContents as ResponseContent[]) = old.successResponses![0].contents!;
    old.response = old.successResponses![0].type;
    const next = card([['application/json', string]], { response: string });
    next.responseContents![0].type = next.response;
    const changes = diffOperations('Pets', [old], [next]);
    expect(changes[0]).toMatchObject({
      responseChanged: false,
      responseContentTypesChanged: true,
      responseContentTypeChanges: [
        { added: [], removed: [], retyped: ['application/json'], classification: 'breaking' },
        {
          statusCode: 200,
          added: [],
          removed: ['application/json', 'text/html'],
          retyped: [],
          classification: 'breaking',
        },
      ],
      classification: 'breaking',
    });
    expect(
      Object.keys((changes[0] as { responseContentTypeChanges: object[] }).responseContentTypeChanges[0]),
    ).not.toContain('statusCode');
  });

  it('covers the default and range responses by key, reported with `fallback` in place of a status code', () => {
    const integer: TypeRef = { kind: 'primitive', type: 'integer' };
    const problem: TypeRef = { kind: 'model', name: 'Problem' };
    const withFallbacks = (defaultTypes: Array<[string, TypeRef]>, rangeTypes: Array<[string, TypeRef]>): Operation =>
      card([['application/pdf', binary]], {
        defaultResponse: {
          type: problem,
          contentTypes: defaultTypes.map(([contentType]) => contentType),
          contents: contents(defaultTypes),
        },
        rangeResponses: [
          {
            range: '4XX',
            type: problem,
            contentTypes: rangeTypes.map(([contentType]) => contentType),
            contents: contents(rangeTypes),
          },
        ],
      });
    const old = withFallbacks(
      [
        ['application/json', problem],
        ['text/plain', string],
      ],
      [['application/json', problem]],
    );
    const next = withFallbacks(
      [['application/json', problem]],
      [
        ['application/json', problem],
        ['application/yaml', integer],
      ],
    );
    expect(diffOperations('Pets', [old], [next])[0]).toMatchObject({
      fallbackResponsesChanged: false,
      responseContentTypesChanged: true,
      responseContentTypeChanges: [
        { fallback: 'default', added: [], removed: ['text/plain'], retyped: [], classification: 'breaking' },
        { fallback: '4XX', added: ['application/yaml'], removed: [], retyped: [], classification: 'additive' },
      ],
      classification: 'breaking',
    });
    const [lost] = (diffOperations('Pets', [old], [next])[0] as { responseContentTypeChanges: object[] })
      .responseContentTypeChanges;
    expect(Object.keys(lost)).not.toContain('statusCode');

    // A fallback only one spec declares is the fallback diff's business, not a media-type change.
    const none = card([['application/pdf', binary]]);
    expect(diffOperations('Pets', [old], [none])[0]).toMatchObject({
      fallbackResponsesChanged: true,
      responseContentTypesChanged: false,
    });
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

describe('diffOperations — response content types, as the parser builds them', () => {
  /** The operations the parser extracts from an inline paths object. */
  const parsed = (paths: Record<string, unknown>): Operation[] =>
    extractOperations(paths as never).services.flatMap((s) => s.operations);
  const ref = (name: string) => ({ schema: { $ref: `#/components/schemas/${name}` } });

  const card = (notFound: Record<string, unknown>) => ({
    '/pets/{petId}/card': {
      get: {
        operationId: 'renderPetCard',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
          },
          '404': { description: 'missing', content: notFound },
        },
      },
    },
  });
  const jsonAndHtml = card({ 'application/json': ref('Error'), 'text/html': { schema: { type: 'string' } } });
  // A lone application/json error with a schema carries no lists in the IR.
  const jsonOnly = card({ 'application/json': ref('Error') });

  it('reports a 404 that loses text/html but keeps its JSON schema as breaking, though the IR drops its lists', () => {
    expect(parsed(jsonOnly)[0].errors[0].contentTypes).toBeUndefined();
    const changes = diffOperations('Pets', parsed(jsonAndHtml), parsed(jsonOnly));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      errorsChanged: false,
      responseContentTypesChanged: true,
      responseContentTypeChanges: [
        { statusCode: 404, added: [], removed: ['text/html'], retyped: [], classification: 'breaking' },
      ],
      classification: 'breaking',
    });
  });

  it('reports a listless JSON-only 404 that gains text/html as additive', () => {
    const changes = diffOperations('Pets', parsed(jsonOnly), parsed(jsonAndHtml));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      errorsChanged: false,
      responseContentTypeChanges: [
        { statusCode: 404, added: ['text/html'], removed: [], retyped: [], classification: 'additive' },
      ],
      classification: 'additive',
    });
  });

  it('reports nothing for a listless JSON-only error on both sides', () => {
    expect(diffOperations('Pets', parsed(jsonOnly), parsed(jsonOnly))).toHaveLength(0);
  });

  it('reports an alternate 2xx whose own body and vendor body both change, which no other comparison covers', () => {
    const startJob = (type: string) => ({
      '/jobs': {
        post: {
          operationId: 'startJob',
          responses: {
            '200': { description: 'running', content: { 'application/json': ref('Job') } },
            '201': {
              description: 'started',
              content: { 'application/json': { schema: { type } }, 'application/vnd.job+json': { schema: { type } } },
            },
          },
        },
      },
    });
    const changes = diffOperations('Jobs', parsed(startJob('string')), parsed(startJob('integer')));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      responseChanged: false,
      responseContentTypeChanges: [
        { statusCode: 201, retyped: ['application/json', 'application/vnd.job+json'], classification: 'breaking' },
      ],
      classification: 'breaking',
    });
  });

  it('reports a secondary body that comes to equal the primary type on one side only', () => {
    const report = (vendor: string) => ({
      '/reports': {
        get: {
          operationId: 'getReport',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': ref('Report'), 'application/vnd.report+json': ref(vendor) },
            },
          },
        },
      },
    });
    const changes = diffOperations('Reports', parsed(report('Thing')), parsed(report('Report')));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      responseChanged: false,
      responseContentTypeChanges: [
        { added: [], removed: [], retyped: ['application/vnd.report+json'], classification: 'breaking' },
      ],
      classification: 'breaking',
    });
  });

  it("leaves the primary's own retype to responseChanged even when its secondary body is identical", () => {
    const report = (primary: string) => ({
      '/reports': {
        get: {
          operationId: 'getReport',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': ref(primary), 'application/json; charset=utf-8': ref(primary) },
            },
          },
        },
      },
    });
    const changes = diffOperations('Reports', parsed(report('Report')), parsed(report('Thing')));
    expect(changes).toHaveLength(1);
    // The charset variant is a separate object, so it is not the own entry and its retype is reported.
    expect(changes[0]).toMatchObject({
      responseChanged: true,
      responseContentTypeChanges: [{ retyped: ['application/json; charset=utf-8'], classification: 'breaking' }],
      classification: 'breaking',
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
      requestBodyRequired: true,
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

  it('detects a default response added as additive', () => {
    const modified: Operation = { ...getUser, defaultResponse: { type: { kind: 'model', name: 'ApiError' } } };
    const changes = diffOperations('Users', [getUser], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].fallbackResponsesChanged).toBe(true);
      expect(changes[0].errorsChanged).toBe(false);
      expect(changes[0].classification).toBe('additive');
    }
  });

  it('detects a default response removed as breaking', () => {
    const withDefault: Operation = { ...getUser, defaultResponse: { type: { kind: 'model', name: 'ApiError' } } };
    const changes = diffOperations('Users', [withDefault], [getUser]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].fallbackResponsesChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects a default response type changed as breaking', () => {
    const before: Operation = { ...getUser, defaultResponse: { type: { kind: 'model', name: 'ApiError' } } };
    const after: Operation = { ...getUser, defaultResponse: { type: { kind: 'model', name: 'Problem' } } };
    const changes = diffOperations('Users', [before], [after]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].fallbackResponsesChanged).toBe(true);
      expect(changes[0].classification).toBe('breaking');
    }
  });

  it('detects a range response added as additive and one removed as breaking', () => {
    const withRange: Operation = {
      ...getUser,
      rangeResponses: [{ range: '5XX', type: { kind: 'model', name: 'Outage' } }],
    };
    const added = diffOperations('Users', [getUser], [withRange]);
    expect(added).toHaveLength(1);
    if (added[0].kind === 'operation-modified') {
      expect(added[0].fallbackResponsesChanged).toBe(true);
      expect(added[0].classification).toBe('additive');
    }
    const removed = diffOperations('Users', [withRange], [getUser]);
    expect(removed).toHaveLength(1);
    if (removed[0].kind === 'operation-modified') {
      expect(removed[0].fallbackResponsesChanged).toBe(true);
      expect(removed[0].classification).toBe('breaking');
    }
  });

  it('detects no change when fallback responses are the same, or bodiless on both sides', () => {
    const before: Operation = {
      ...getUser,
      defaultResponse: { type: { kind: 'model', name: 'ApiError' } },
      rangeResponses: [{ range: '4XX' }],
    };
    const after: Operation = {
      ...getUser,
      defaultResponse: { type: { kind: 'model', name: 'ApiError' } },
      rangeResponses: [{ range: '4XX' }],
    };
    expect(diffOperations('Users', [before], [after])).toHaveLength(0);
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

describe('diffOperations – requestBodyRequired (issue #213)', () => {
  const noBody: Operation = { ...getUser, httpMethod: 'post' };
  const optionalBody: Operation = {
    ...noBody,
    requestBody: { kind: 'model', name: 'UpdateUser' },
    requestBodyRequired: false,
  };
  const requiredBody: Operation = { ...optionalBody, requestBodyRequired: true };

  it('reports optional → required as breaking', () => {
    const changes = diffOperations('Users', [optionalBody], [requiredBody]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      requestBodyChanged: false,
      requestBodyRequiredChanged: true,
      classification: 'breaking',
    });
  });

  it('reports required → optional as additive', () => {
    const changes = diffOperations('Users', [requiredBody], [optionalBody]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      requestBodyChanged: false,
      requestBodyRequiredChanged: true,
      classification: 'additive',
    });
  });

  it('reports nothing when the flag is unchanged', () => {
    expect(diffOperations('Users', [requiredBody], [requiredBody])).toHaveLength(0);
    expect(diffOperations('Users', [optionalBody], [optionalBody])).toHaveLength(0);
  });

  it('treats an absent flag as optional, as OpenAPI does', () => {
    const unflagged: Operation = { ...optionalBody, requestBodyRequired: undefined };
    expect(diffOperations('Users', [unflagged], [optionalBody])).toHaveLength(0);
    expect(diffOperations('Users', [optionalBody], [unflagged])).toHaveLength(0);

    const changes = diffOperations('Users', [unflagged], [requiredBody]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ requestBodyRequiredChanged: true, classification: 'breaking' });
  });

  it('leaves a body appearing or disappearing to requestBodyChanged', () => {
    const added = diffOperations('Users', [noBody], [requiredBody]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: false,
      classification: 'breaking',
    });

    const removed = diffOperations('Users', [requiredBody], [noBody]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: false,
      classification: 'breaking',
    });
  });

  it('reports both when the body type and its flag change together', () => {
    const retyped: Operation = { ...requiredBody, requestBody: { kind: 'model', name: 'CreateUser' } };
    const changes = diffOperations('Users', [optionalBody], [retyped]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: true,
      classification: 'breaking',
    });
  });

  it('keeps a required → optional flip additive only while nothing else breaks', () => {
    const relaxedAndRetyped: Operation = { ...optionalBody, requestBody: { kind: 'model', name: 'CreateUser' } };
    const changes = diffOperations('Users', [requiredBody], [relaxedAndRetyped]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: true,
      classification: 'breaking',
    });
  });
});

describe('diffOperations response descriptions', () => {
  it('ignores a changed response description, the way a changed operation description is ignored', () => {
    const old: Operation = {
      ...getUser,
      description: 'Get a user.',
      responseDescription: 'A user.',
      errors: [{ statusCode: 404, description: 'Not found.' }],
    };
    const modified: Operation = {
      ...getUser,
      description: 'Fetch a user.',
      responseDescription: 'The user, with its organization.',
      errors: [{ statusCode: 404, description: 'No user has that id.' }],
    };

    expect(diffOperations('Users', [old], [modified])).toEqual([]);
  });

  it('ignores a response description appearing or disappearing', () => {
    const described: Operation = { ...getUser, responseDescription: 'The user.' };

    expect(diffOperations('Users', [getUser], [described])).toEqual([]);
    expect(diffOperations('Users', [described], [getUser])).toEqual([]);
  });
});
