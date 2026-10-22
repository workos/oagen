import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffOperations } from '../../src/differ/operations.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Operation, Parameter, Webhook } from '../../src/ir/types.js';

/**
 * Covers issue #295: header names are case-insensitive (RFC 9110 §5.1), but
 * `diffSpecs` matched header parameters by their exact name, so a header
 * renamed from `X-Pet-Token` to `x-pet-token` was a breaking `param-removed`
 * beside a `param-added`, on operations and webhooks alike, and a
 * deprecation flip made in the same step was lost. Parameters are now
 * paired on `parameterKey` (location and name, a header's name
 * case-folded), the spelling change is a `param-name-changed` entry
 * (additive), and everything else about the header is compared as usual.
 * Path, query and cookie names stay case-sensitive.
 */
const fixtures = resolve(import.meta.dirname, '../fixtures');

const str = { kind: 'primitive', type: 'string' } as const;

function param(name: string, overrides: Partial<Parameter> = {}): Parameter {
  return { name, type: str, required: false, ...overrides };
}

/** `GET /pets` with the given header parameters and nothing else to compare. */
function listPets(headerParams: Parameter[], overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'listPets',
    httpMethod: 'get',
    path: '/pets',
    pathParams: [],
    queryParams: [],
    headerParams,
    response: str,
    errors: [],
    injectIdempotencyKey: false,
    ...overrides,
  };
}

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    name: 'petAdopted',
    httpMethod: 'post',
    headerParams: [],
    queryParams: [],
    requestBody: str,
    responses: [{ statusCode: 200 }],
    ...overrides,
  };
}

function specOf(op: Operation): ApiSpec {
  return {
    name: 'Pets',
    version: '1',
    baseUrl: '',
    models: [],
    enums: [],
    services: [{ name: 'Pets', operations: [op] }],
    sdk: defaultSdkBehavior(),
  };
}

function specOfWebhook(hook: Webhook): ApiSpec {
  return {
    name: 'Pets',
    version: '1',
    baseUrl: '',
    models: [],
    enums: [],
    services: [],
    webhooks: [hook],
    sdk: defaultSdkBehavior(),
  };
}

const paramChangesOf = (changes: ReturnType<typeof diffOperations>) =>
  changes[0]?.kind === 'operation-modified' ? changes[0].paramChanges : [];

const renamed = {
  kind: 'param-name-changed',
  paramName: 'x-pet-token',
  classification: 'additive',
  paramLocation: 'header',
  oldName: 'X-Pet-Token',
  newName: 'x-pet-token',
  details: 'name X-Pet-Token → x-pet-token',
} as const;

describe("diffSpecs – the issue's documents (#295)", () => {
  it('reports the header deprecated and respelled, additive, on the operation and the webhook alike', async () => {
    const [before, after] = await Promise.all([
      parseSpec(resolve(fixtures, 'header-param-case-before.json')),
      parseSpec(resolve(fixtures, 'header-param-case-after.json')),
    ]);
    const diff = diffSpecs(before, after);

    // What the issue printed, minus the `param-removed` beside a `param-added`.
    expect(
      diff.changes.map((change) =>
        change.kind === 'operation-modified' || change.kind === 'webhook-modified'
          ? { classification: change.classification, kind: change.kind, paramChanges: change.paramChanges }
          : change,
      ),
    ).toEqual([
      {
        classification: 'additive',
        kind: 'operation-modified',
        paramChanges: [
          renamed,
          {
            kind: 'param-deprecated-changed',
            paramName: 'x-pet-token',
            classification: 'additive',
            paramLocation: 'header',
            oldDeprecated: false,
            newDeprecated: true,
            details: 'live → deprecated',
          },
        ],
      },
      {
        classification: 'additive',
        kind: 'webhook-modified',
        paramChanges: [
          {
            ...renamed,
            paramName: 'x-pet-signature',
            oldName: 'X-Pet-Signature',
            newName: 'x-pet-signature',
            details: 'name X-Pet-Signature → x-pet-signature',
          },
          {
            kind: 'param-deprecated-changed',
            paramName: 'x-pet-signature',
            classification: 'additive',
            paramLocation: 'header',
            oldDeprecated: false,
            newDeprecated: true,
            details: 'live → deprecated',
          },
        ],
      },
    ]);
    // The flips reach `behaviorChanges` under the new spelling; the respelling itself is not mirrored.
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'deprecated-changed',
        node: 'parameter',
        serviceName: 'Pets',
        operationName: 'listPets',
        paramName: 'x-pet-token',
        paramLocation: 'header',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
      {
        kind: 'deprecated-changed',
        node: 'webhook-parameter',
        name: 'petAdopted',
        httpMethod: 'post',
        paramName: 'x-pet-signature',
        paramLocation: 'header',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
    ]);
    // `oagen diff` exits 1, not 2.
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 2, breaking: 0, additive: 2, behaviorChanges: 2 });
  });
});

describe('diffSpecs – headers with inline enum and object schemas, respelled (#295, review round 1)', () => {
  it('keeps every minted type where it was, so the only change is the spelling', async () => {
    const [before, after] = await Promise.all([
      parseSpec(resolve(fixtures, 'header-param-case-inline-before.json')),
      parseSpec(resolve(fixtures, 'header-param-case-inline-after.json')),
    ]);
    // The names derive from the lower-cased header name on both sides.
    const minted = (spec: ApiSpec) => [...spec.models.map((m) => m.name), ...spec.enums.map((e) => e.name)].sort();
    expect(minted(before)).toEqual(minted(after));
    expect(minted(after)).toEqual([
      'PetAdoptedPayload',
      'PetAdoptedXPetMeta',
      'PetAdoptedXPetSignatureAlgo',
      'PetsXPetMeta',
      'PetsXPetOrigin',
      'PetsXRatelimitPolicy',
      'PetsXRatelimitScope',
    ]);

    const diff = diffSpecs(before, after);
    // Used to be `param-type-changed` (breaking) beside `enum-removed` / `enum-added`
    // and `model-removed` / `model-added` for every header: exit 2 for a header
    // whose accepted values had not changed.
    expect(diff.changes.map((change) => change.kind)).toEqual(['operation-modified', 'webhook-modified']);
    expect(
      diff.changes.map((change) =>
        change.kind === 'operation-modified' || change.kind === 'webhook-modified' ? change.paramChanges : [],
      ),
    ).toEqual([
      [
        {
          ...renamed,
          paramName: 'x-ratelimit-policy',
          oldName: 'X-RateLimit-Policy',
          newName: 'x-ratelimit-policy',
          details: 'name X-RateLimit-Policy → x-ratelimit-policy',
        },
        {
          ...renamed,
          paramName: 'x-pet-meta',
          oldName: 'X-Pet-Meta',
          newName: 'x-pet-meta',
          details: 'name X-Pet-Meta → x-pet-meta',
        },
      ],
      [
        {
          ...renamed,
          paramName: 'x-pet-signature-algo',
          oldName: 'X-Pet-Signature-Algo',
          newName: 'x-pet-signature-algo',
          details: 'name X-Pet-Signature-Algo → x-pet-signature-algo',
        },
        {
          ...renamed,
          paramName: 'x-pet-meta',
          oldName: 'X-Pet-Meta',
          newName: 'x-pet-meta',
          details: 'name X-Pet-Meta → x-pet-meta',
        },
      ],
    ]);
    // `oagen diff` exits 1, not 2.
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 2, breaking: 0, additive: 2, behaviorChanges: 0 });
  });
});

describe('diffOperations – a header parameter whose name changed case alone', () => {
  const before = listPets([param('X-Pet-Token')]);

  it('reports one additive `param-name-changed`, not a removal beside an addition', () => {
    const after = listPets([param('x-pet-token')]);
    const changes = diffOperations('Pets', [before], [after]);
    expect(paramChangesOf(changes)).toEqual([renamed]);
    expect(changes[0]).toMatchObject({ kind: 'operation-modified', classification: 'additive' });
  });

  it('reports nothing when the spelling is unchanged', () => {
    expect(diffOperations('Pets', [before], [listPets([param('X-Pet-Token')])])).toHaveLength(0);
  });

  it('compares the header across the respelling: a type change is still breaking', () => {
    const after = listPets([param('x-pet-token', { type: { kind: 'primitive', type: 'integer' } })]);
    const changes = diffOperations('Pets', [before], [after]);
    expect(paramChangesOf(changes)).toEqual([
      renamed,
      { kind: 'param-type-changed', paramName: 'x-pet-token', classification: 'breaking', paramLocation: 'header' },
    ]);
    expect(changes[0].classification).toBe('breaking');
  });

  it('compares the header across the respelling: requiredness and default', () => {
    const after = listPets([param('x-pet-token', { required: true, default: 'abc' })]);
    expect(paramChangesOf(diffOperations('Pets', [before], [after]))).toEqual([
      renamed,
      { kind: 'param-required-changed', paramName: 'x-pet-token', classification: 'breaking', paramLocation: 'header' },
      {
        kind: 'param-default-changed',
        paramName: 'x-pet-token',
        classification: 'breaking',
        paramLocation: 'header',
        oldDefault: null,
        newDefault: 'abc',
        details: 'default <unset> → abc',
      },
    ]);
  });

  it('pairs any two spellings, upper case included, and names the entry as the new spec writes it', () => {
    const after = listPets([param('X-PET-TOKEN')]);
    expect(paramChangesOf(diffOperations('Pets', [before], [after]))).toEqual([
      { ...renamed, paramName: 'X-PET-TOKEN', newName: 'X-PET-TOKEN', details: 'name X-Pet-Token → X-PET-TOKEN' },
    ]);
  });

  it('mirrors a deprecation flip made in the same step into behaviorChanges under the new spelling', () => {
    const after = listPets([param('x-pet-token', { deprecated: true })]);
    expect(diffSpecs(specOf(before), specOf(after)).behaviorChanges).toEqual([
      {
        kind: 'deprecated-changed',
        node: 'parameter',
        serviceName: 'Pets',
        operationName: 'listPets',
        paramName: 'x-pet-token',
        paramLocation: 'header',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
    ]);
  });

  it('still tells a header apart from a query parameter of the same folded name', () => {
    const after = listPets([], { queryParams: [param('x-pet-token')] });
    expect(paramChangesOf(diffOperations('Pets', [before], [after]))).toEqual([
      { kind: 'param-added', paramName: 'x-pet-token', classification: 'additive', paramLocation: 'query' },
      { kind: 'param-removed', paramName: 'X-Pet-Token', classification: 'breaking', paramLocation: 'header' },
    ]);
  });
});

describe('diffOperations – path and query names stay case-sensitive', () => {
  it('reports a query parameter respelled `Limit` → `limit` as removed and added', () => {
    const before = listPets([], { queryParams: [param('Limit')] });
    const after = listPets([], { queryParams: [param('limit')] });
    expect(paramChangesOf(diffOperations('Pets', [before], [after]))).toEqual([
      { kind: 'param-added', paramName: 'limit', classification: 'additive', paramLocation: 'query' },
      { kind: 'param-removed', paramName: 'Limit', classification: 'breaking', paramLocation: 'query' },
    ]);
  });

  it('reports a path parameter respelled `petId` → `petid` as removed and added', () => {
    const before = listPets([], { path: '/pets/{petId}', pathParams: [param('petId', { required: true })] });
    const after = listPets([], { path: '/pets/{petid}', pathParams: [param('petid', { required: true })] });
    expect(paramChangesOf(diffOperations('Pets', [before], [after]))).toEqual([
      { kind: 'param-added', paramName: 'petid', classification: 'breaking', paramLocation: 'path' },
      { kind: 'param-removed', paramName: 'petId', classification: 'breaking', paramLocation: 'path' },
    ]);
  });
});

describe('diffSpecs – a webhook header whose name changed case alone', () => {
  const signature = {
    ...renamed,
    paramName: 'x-pet-signature',
    oldName: 'X-Pet-Signature',
    newName: 'x-pet-signature',
    details: 'name X-Pet-Signature → x-pet-signature',
  };

  it('reports one additive `param-name-changed`, not a removal beside an addition', () => {
    const before = webhook({ headerParams: [param('X-Pet-Signature')] });
    const after = webhook({ headerParams: [param('x-pet-signature')] });
    const { changes } = diffSpecs(specOfWebhook(before), specOfWebhook(after));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'webhook-modified',
      paramChanges: [signature],
      classification: 'additive',
    });
  });

  it("compares the header across the respelling from the receiver's side", () => {
    const before = webhook({ headerParams: [param('X-Pet-Signature')] });
    const after = webhook({ headerParams: [param('x-pet-signature', { required: true, deprecated: true })] });
    const { changes } = diffSpecs(specOfWebhook(before), specOfWebhook(after));
    expect(changes[0]).toMatchObject({
      kind: 'webhook-modified',
      paramChanges: [
        signature,
        {
          kind: 'param-required-changed',
          paramName: 'x-pet-signature',
          classification: 'additive',
          paramLocation: 'header',
          details: 'optional → required',
        },
        {
          kind: 'param-deprecated-changed',
          paramName: 'x-pet-signature',
          classification: 'additive',
          paramLocation: 'header',
          oldDeprecated: false,
          newDeprecated: true,
          details: 'live → deprecated',
        },
      ],
      classification: 'additive',
    });
  });

  it('keeps query and cookie names case-sensitive', () => {
    const before = webhook({ queryParams: [param('Attempt')], cookieParams: [param('Session')] });
    const after = webhook({ queryParams: [param('attempt')], cookieParams: [param('session')] });
    const { changes } = diffSpecs(specOfWebhook(before), specOfWebhook(after));
    expect(changes[0]).toMatchObject({
      kind: 'webhook-modified',
      paramChanges: [
        { kind: 'param-added', paramName: 'attempt', classification: 'additive', paramLocation: 'query' },
        { kind: 'param-added', paramName: 'session', classification: 'additive', paramLocation: 'cookie' },
        { kind: 'param-removed', paramName: 'Attempt', classification: 'breaking', paramLocation: 'query' },
        { kind: 'param-removed', paramName: 'Session', classification: 'breaking', paramLocation: 'cookie' },
      ],
      classification: 'breaking',
    });
  });
});
