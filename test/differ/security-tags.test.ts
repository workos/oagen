/**
 * Issue #273: `diffSpecs` reports `security` and `tags` changes on operations
 * and webhooks, and on the document's default `security`.
 *
 * Security is compared on what a request actually carries — the node's own
 * list, else the document's (`diffSpecs` passes it), else none — as a set of
 * alternatives, each a set of schemes with scopes as sets. A node that
 * inherits on both sides is left to the document-level `security-changed`
 * change. The classification is read from the node's side of the wire: a
 * caller (an operation) built for the old list must still satisfy the new
 * one; a receiver (a webhook handler) built for the old list must still find
 * what it checked for in whatever the sender now presents. Every security
 * change is mirrored into `behaviorChanges`. Tags are compared in document
 * order and are additive always.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import type { DocumentSecurityChanged, SecurityChanged, SecurityNode } from '../../src/index.js';
import { diffOperations } from '../../src/differ/operations.js';
import { diffWebhooks } from '../../src/differ/webhooks.js';
import { tagsShift } from '../../src/differ/classify.js';
import {
  classifySecurityChange,
  securityEqual,
  securitySatisfied,
  securityShift,
  type DocumentSecurity,
} from '../../src/differ/security.js';
import type { Change } from '../../src/differ/types.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Operation, SecurityRequirementSet, Webhook } from '../../src/ir/types.js';

const fixtures = path.resolve(import.meta.dirname, '../fixtures');

const apiKey: SecurityRequirementSet[] = [[{ schemeName: 'apiKey', scopes: [] }]];
const bearer: SecurityRequirementSet[] = [[{ schemeName: 'bearer', scopes: [] }]];
/** Either scheme suffices. */
const either: SecurityRequirementSet[] = [...apiKey, ...bearer];
/** Both schemes together. */
const both: SecurityRequirementSet[] = [
  [
    { schemeName: 'apiKey', scopes: [] },
    { schemeName: 'bearer', scopes: [] },
  ],
];
/** `apiKey`, or nothing: authentication is optional. */
const optional: SecurityRequirementSet[] = [...apiKey, []];
const read: SecurityRequirementSet[] = [[{ schemeName: 'oauth', scopes: ['read'] }]];
const readWrite: SecurityRequirementSet[] = [[{ schemeName: 'oauth', scopes: ['read', 'write'] }]];
/** `security: []`: no authentication. */
const none: SecurityRequirementSet[] = [];

const listPets: Operation = {
  name: 'listPets',
  httpMethod: 'get',
  path: '/pets',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'array', items: { kind: 'model', name: 'Pet' } },
  errors: [],
  injectIdempotencyKey: false,
};

/** `listPets` carrying the given fields; an `undefined` value drops the key. */
function op(overrides: Partial<Operation> = {}): Operation {
  const merged: Operation = { ...listPets, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key as keyof Operation];
  }
  return merged;
}

const petAdopted: Webhook = {
  name: 'petAdopted',
  httpMethod: 'post',
  headerParams: [],
  queryParams: [],
  requestBody: { kind: 'model', name: 'Pet' },
  responses: [{ statusCode: 200 }],
};

function hook(overrides: Partial<Webhook> = {}): Webhook {
  const merged: Webhook = { ...petAdopted, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key as keyof Webhook];
  }
  return merged;
}

function spec(overrides: Partial<ApiSpec> = {}): ApiSpec {
  return {
    name: 'Pets',
    version: '1',
    baseUrl: 'https://api.example.com',
    services: [{ name: 'Pets', operations: [listPets] }],
    models: [{ name: 'Pet', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] }],
    enums: [],
    sdk: defaultSdkBehavior(),
    ...overrides,
  };
}

function documents(
  oldSecurity: SecurityRequirementSet[] | undefined,
  newSecurity: SecurityRequirementSet[] | undefined,
) {
  return { old: oldSecurity, new: newSecurity } satisfies DocumentSecurity;
}

/** The one change, or `undefined` when there is none; more than one fails. */
function only(changes: Change[]): Change | undefined {
  expect(changes.length).toBeLessThanOrEqual(1);
  return changes[0];
}

describe('issue #273 repro: security and tags on an operation and a webhook', () => {
  it('reports the operation and the webhook, both breaking, with both sides of each change', async () => {
    const before = await parseSpec(path.join(fixtures, 'security-tags-before.json'));
    const after = await parseSpec(path.join(fixtures, 'security-tags-after.json'));
    const diff = diffSpecs(before, after);

    expect(diff.changes).toEqual([
      {
        kind: 'operation-modified',
        serviceName: 'Pets',
        operationName: 'listPets',
        paramChanges: [],
        responseChanged: false,
        requestBodyChanged: false,
        requestBodyRequiredChanged: false,
        requestBodyContentTypesChanged: false,
        httpMethodChanged: false,
        pathChanged: false,
        paginatedChanged: false,
        paginationStrategyChanged: false,
        paginationParamChanged: false,
        paginationLimitParamChanged: false,
        paginationDataPathChanged: false,
        paginationPageStartChanged: false,
        paginationEndOfIterationChanged: false,
        injectIdempotencyKeyChanged: false,
        errorsChanged: false,
        responseContentTypesChanged: false,
        responseContentTypeChanges: [],
        fallbackResponsesChanged: false,
        serversChanged: false,
        deprecatedChanged: false,
        securityChanged: true,
        oldSecurity: apiKey,
        newSecurity: bearer,
        tagsChanged: true,
        oldTags: ['Pets'],
        newTags: ['Pets', 'Store'],
        classification: 'breaking',
      },
      {
        kind: 'webhook-modified',
        name: 'petAdopted',
        httpMethod: 'post',
        paramChanges: [],
        requestBodyChanged: false,
        responsesChanged: false,
        deprecatedChanged: false,
        securityChanged: true,
        oldSecurity: apiKey,
        newSecurity: bearer,
        tagsChanged: true,
        oldTags: ['Pets'],
        newTags: ['Pets', 'Store'],
        classification: 'breaking',
      },
    ]);
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'security-changed',
        node: 'operation',
        serviceName: 'Pets',
        operationName: 'listPets',
        oldSecurity: apiKey,
        newSecurity: bearer,
        classification: 'breaking',
      },
      {
        kind: 'security-changed',
        node: 'webhook',
        name: 'petAdopted',
        httpMethod: 'post',
        oldSecurity: apiKey,
        newSecurity: bearer,
        classification: 'breaking',
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 2, breaking: 2, additive: 0, behaviorChanges: 2 });
  });

  it('carries the operation’s tags in the IR, as a webhook’s are', async () => {
    const before = await parseSpec(path.join(fixtures, 'security-tags-before.json'));
    const after = await parseSpec(path.join(fixtures, 'security-tags-after.json'));
    expect(before.services[0].operations[0].tags).toEqual(['Pets']);
    expect(after.services[0].operations[0].tags).toEqual(['Pets', 'Store']);
    expect(after.webhooks?.[0].tags).toEqual(['Pets', 'Store']);
  });

  it('reports the swap the other way: the scheme change still breaks, the tags change is additive', async () => {
    const before = await parseSpec(path.join(fixtures, 'security-tags-before.json'));
    const after = await parseSpec(path.join(fixtures, 'security-tags-after.json'));
    const diff = diffSpecs(after, before);
    expect(diff.changes).toMatchObject([
      {
        kind: 'operation-modified',
        securityChanged: true,
        oldSecurity: bearer,
        newSecurity: apiKey,
        tagsChanged: true,
        oldTags: ['Pets', 'Store'],
        newTags: ['Pets'],
        classification: 'breaking',
      },
      { kind: 'webhook-modified', securityChanged: true, tagsChanged: true, classification: 'breaking' },
    ]);
  });

  it('reports nothing when the same document is parsed twice', async () => {
    const a = await parseSpec(path.join(fixtures, 'security-tags-after.json'));
    const b = await parseSpec(path.join(fixtures, 'security-tags-after.json'));
    expect(diffSpecs(a, b).changes).toEqual([]);
    expect(diffSpecs(a, b).behaviorChanges).toEqual([]);
  });
});

describe('diffOperations – security, read from the caller’s side', () => {
  const shift = (
    oldSecurity: SecurityRequirementSet[] | undefined,
    newSecurity: SecurityRequirementSet[] | undefined,
  ) => only(diffOperations('Pets', [op({ security: oldSecurity })], [op({ security: newSecurity })]));

  it('reports a requirement appearing where there was none as breaking: callers must now authenticate', () => {
    expect(shift(undefined, apiKey)).toMatchObject({
      kind: 'operation-modified',
      securityChanged: true,
      oldSecurity: [],
      newSecurity: apiKey,
      classification: 'breaking',
    });
    expect(shift(none, apiKey)).toMatchObject({ securityChanged: true, classification: 'breaking' });
  });

  it('reports a requirement withdrawn as additive: what callers send still passes', () => {
    expect(shift(apiKey, none)).toMatchObject({
      securityChanged: true,
      oldSecurity: apiKey,
      newSecurity: [],
      classification: 'additive',
    });
    // Without the documents an inheriting side reads as no authentication.
    expect(shift(apiKey, undefined)).toMatchObject({ securityChanged: true, classification: 'additive' });
  });

  it('reports a scheme swapped for another as breaking', () => {
    expect(shift(apiKey, bearer)).toMatchObject({ securityChanged: true, classification: 'breaking' });
  });

  it('reports an alternative added as additive and one removed as breaking', () => {
    expect(shift(apiKey, either)).toMatchObject({ securityChanged: true, classification: 'additive' });
    expect(shift(either, apiKey)).toMatchObject({ securityChanged: true, classification: 'breaking' });
  });

  it('reports a scheme added to an all-of set as breaking and one dropped from it as additive', () => {
    expect(shift(apiKey, both)).toMatchObject({ securityChanged: true, classification: 'breaking' });
    expect(shift(both, apiKey)).toMatchObject({ securityChanged: true, classification: 'additive' });
  });

  it('reports a scope added as breaking and one dropped as additive', () => {
    expect(shift(read, readWrite)).toMatchObject({ securityChanged: true, classification: 'breaking' });
    expect(shift(readWrite, read)).toMatchObject({ securityChanged: true, classification: 'additive' });
  });

  it('reports authentication made mandatory as breaking and made optional as additive', () => {
    expect(shift(optional, apiKey)).toMatchObject({ securityChanged: true, classification: 'breaking' });
    expect(shift(apiKey, optional)).toMatchObject({ securityChanged: true, classification: 'additive' });
  });

  it('compares alternatives, schemes and scopes as sets, so order and repetition are no change', () => {
    expect(shift(either, [...bearer, ...apiKey])).toBeUndefined();
    expect(shift(either, [...apiKey, ...bearer, ...apiKey])).toBeUndefined();
    expect(shift(readWrite, [[{ schemeName: 'oauth', scopes: ['write', 'read', 'read'] }]])).toBeUndefined();
    expect(shift(both, [[both[0][1], both[0][0]]])).toBeUndefined();
  });

  it('treats `security: []`, an anonymous alternative alone and nothing declared anywhere as the same', () => {
    expect(shift(none, [[]])).toBeUndefined();
    expect(shift(none, undefined)).toBeUndefined();
    expect(shift(undefined, [[]])).toBeUndefined();
  });

  it('reports nothing when both sides carry the same list', () => {
    expect(shift(apiKey, [[{ schemeName: 'apiKey', scopes: [] }]])).toBeUndefined();
    expect(diffOperations('Pets', [op()], [op()])).toHaveLength(0);
  });

  it('carries no oldSecurity/newSecurity on a change whose security did not move', () => {
    const change = only(diffOperations('Pets', [op()], [op({ path: '/pets/all' })]));
    expect(change).toMatchObject({ kind: 'operation-modified', securityChanged: false, tagsChanged: false });
    expect(change).not.toHaveProperty('oldSecurity');
    expect(change).not.toHaveProperty('newSecurity');
    expect(change).not.toHaveProperty('oldTags');
    expect(change).not.toHaveProperty('newTags');
  });

  it('keeps a breaking change breaking when the security change beside it is additive', () => {
    const change = only(
      diffOperations('Pets', [op({ security: apiKey })], [op({ security: none, path: '/pets/all' })]),
    );
    expect(change).toMatchObject({ securityChanged: true, pathChanged: true, classification: 'breaking' });
  });

  describe('against the documents (as diffSpecs calls it)', () => {
    const shiftIn = (
      oldOp: Operation,
      newOp: Operation,
      oldDocument: SecurityRequirementSet[] | undefined,
      newDocument: SecurityRequirementSet[] | undefined,
    ) => only(diffOperations('Pets', [oldOp], [newOp], undefined, documents(oldDocument, newDocument)));

    it('leaves a moved document default to the document-level diff when the operation inherits on both sides', () => {
      expect(shiftIn(op(), op(), apiKey, bearer)).toBeUndefined();
      expect(shiftIn(op(), op(), undefined, apiKey)).toBeUndefined();
    });

    it('ignores a document that moved to what the operation already declared', () => {
      // Before: the document says bearer, listPets pins apiKey. After: the
      // document says apiKey, listPets declares nothing. apiKey both times.
      expect(shiftIn(op({ security: apiKey }), op(), bearer, apiKey)).toBeUndefined();
    });

    it('ignores an override that restates what the operation already inherited', () => {
      expect(shiftIn(op(), op({ security: apiKey }), apiKey, bearer)).toBeUndefined();
    });

    it('reports an override lost while the document now asks for something else', () => {
      expect(shiftIn(op({ security: apiKey }), op(), bearer, bearer)).toMatchObject({
        securityChanged: true,
        oldSecurity: apiKey,
        newSecurity: bearer,
        classification: 'breaking',
      });
    });

    it('reports an override gained that asks for more than the document did', () => {
      expect(shiftIn(op(), op({ security: both }), apiKey, apiKey)).toMatchObject({
        securityChanged: true,
        oldSecurity: apiKey,
        newSecurity: both,
        classification: 'breaking',
      });
    });

    it('treats a document without a list as no authentication', () => {
      expect(shiftIn(op({ security: none }), op(), undefined, undefined)).toBeUndefined();
      expect(shiftIn(op({ security: apiKey }), op(), undefined, undefined)).toMatchObject({
        securityChanged: true,
        newSecurity: [],
        classification: 'additive',
      });
    });
  });
});

describe('diffWebhooks – security, read from the receiver’s side', () => {
  const shift = (
    oldSecurity: SecurityRequirementSet[] | undefined,
    newSecurity: SecurityRequirementSet[] | undefined,
  ) => only(diffWebhooks([hook({ security: oldSecurity })], [hook({ security: newSecurity })]));

  it('reports a credential the sender starts carrying as additive: the handler keeps working', () => {
    expect(shift(undefined, apiKey)).toMatchObject({
      kind: 'webhook-modified',
      securityChanged: true,
      oldSecurity: [],
      newSecurity: apiKey,
      classification: 'additive',
    });
    expect(shift(apiKey, both)).toMatchObject({ securityChanged: true, classification: 'additive' });
  });

  it('reports a credential the sender stops carrying as breaking: the handler finds nothing to check', () => {
    expect(shift(apiKey, none)).toMatchObject({
      securityChanged: true,
      oldSecurity: apiKey,
      newSecurity: [],
      classification: 'breaking',
    });
    expect(shift(both, apiKey)).toMatchObject({ securityChanged: true, classification: 'breaking' });
    expect(shift(apiKey, bearer)).toMatchObject({ securityChanged: true, classification: 'breaking' });
  });

  it('reports an alternative the sender may now use that the handler never checked for as breaking', () => {
    expect(shift(apiKey, either)).toMatchObject({ securityChanged: true, classification: 'breaking' });
    expect(shift(apiKey, optional)).toMatchObject({ securityChanged: true, classification: 'breaking' });
  });

  it('reports an alternative withdrawn as additive: whatever is still sent, the handler checked for', () => {
    expect(shift(either, apiKey)).toMatchObject({ securityChanged: true, classification: 'additive' });
    expect(shift(optional, apiKey)).toMatchObject({ securityChanged: true, classification: 'additive' });
  });

  it('compares as sets and reports nothing for an unchanged list', () => {
    expect(shift(either, [...bearer, ...apiKey])).toBeUndefined();
    expect(shift(none, undefined)).toBeUndefined();
    expect(diffWebhooks([hook()], [hook()])).toHaveLength(0);
  });

  it('leaves a moved document default to the document-level diff when the webhook inherits on both sides', () => {
    expect(only(diffWebhooks([hook()], [hook()], documents(apiKey, bearer)))).toBeUndefined();
    expect(only(diffWebhooks([hook({ security: apiKey })], [hook()], documents(bearer, apiKey)))).toBeUndefined();
    expect(only(diffWebhooks([hook({ security: apiKey })], [hook()], documents(bearer, bearer)))).toMatchObject({
      securityChanged: true,
      oldSecurity: apiKey,
      newSecurity: bearer,
      classification: 'breaking',
    });
  });

  it('keeps a breaking change breaking when the security change beside it is additive', () => {
    const change = only(
      diffWebhooks([hook({ security: either })], [hook({ security: apiKey, responses: [{ statusCode: 202 }] })]),
    );
    expect(change).toMatchObject({ securityChanged: true, responsesChanged: true, classification: 'breaking' });
  });
});

describe('diffSpecs – the document’s default security', () => {
  const inherits = (security?: SecurityRequirementSet[]) => spec({ security });

  it('reports a default appearing as security-changed, breaking, once, and not again on the operation that inherits it', () => {
    const diff = diffSpecs(inherits(undefined), inherits(apiKey));
    expect(diff.changes).toEqual([
      { kind: 'security-changed', oldSecurity: [], newSecurity: apiKey, classification: 'breaking' },
    ]);
    expect(diff.behaviorChanges).toEqual([
      { kind: 'security-changed', node: 'document', oldSecurity: [], newSecurity: apiKey, classification: 'breaking' },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 1 });
  });

  it('reports a default withdrawn as additive, from the caller’s side', () => {
    expect(diffSpecs(inherits(apiKey), inherits(undefined)).changes).toEqual([
      { kind: 'security-changed', oldSecurity: apiKey, newSecurity: [], classification: 'additive' },
    ]);
    expect(diffSpecs(inherits(apiKey), inherits(none)).changes).toMatchObject([
      { kind: 'security-changed', classification: 'additive' },
    ]);
    expect(diffSpecs(inherits(apiKey), inherits(either)).changes).toMatchObject([
      { kind: 'security-changed', classification: 'additive' },
    ]);
  });

  it('treats `security: []`, no list and a reordered list as unchanged', () => {
    expect(diffSpecs(inherits(none), inherits(undefined)).changes).toEqual([]);
    expect(diffSpecs(inherits(either), inherits([...bearer, ...apiKey])).changes).toEqual([]);
  });

  it('reads the default from the receiver’s side as well when a webhook inherits it', () => {
    // Withdrawn: additive for callers, breaking for a handler that checked for it.
    const withHook = (security?: SecurityRequirementSet[]) => spec({ security, webhooks: [hook()] });
    const diff = diffSpecs(withHook(apiKey), withHook(undefined));
    expect(diff.changes).toEqual([
      { kind: 'security-changed', oldSecurity: apiKey, newSecurity: [], classification: 'breaking' },
    ]);
    expect(diff.behaviorChanges).toEqual([
      { kind: 'security-changed', node: 'document', oldSecurity: apiKey, newSecurity: [], classification: 'breaking' },
    ]);
    // A webhook in either document is enough (the removed webhook is reported on its own).
    expect(diffSpecs(withHook(apiKey), spec({ security: undefined, webhooks: [] })).changes).toMatchObject([
      { kind: 'security-changed', classification: 'breaking' },
      { kind: 'webhook-removed' },
    ]);
    // A webhook that declares its own list does not inherit, so the caller's side alone decides.
    const pinned = (security?: SecurityRequirementSet[]) => spec({ security, webhooks: [hook({ security: bearer })] });
    expect(diffSpecs(pinned(apiKey), pinned(undefined)).changes).toEqual([
      { kind: 'security-changed', oldSecurity: apiKey, newSecurity: [], classification: 'additive' },
    ]);
  });

  it('reports an operation that declares its own list on what it actually requires, beside the document change', () => {
    const before = spec({ security: apiKey, services: [{ name: 'Pets', operations: [op({ security: apiKey })] }] });
    const after = spec({ security: bearer, services: [{ name: 'Pets', operations: [op()] }] });
    const diff = diffSpecs(before, after);
    expect(diff.changes).toMatchObject([
      { kind: 'security-changed', classification: 'breaking' },
      { kind: 'operation-modified', securityChanged: true, oldSecurity: apiKey, newSecurity: bearer },
    ]);
    expect(diff.behaviorChanges.map((b) => (b.kind === 'security-changed' ? b.node : b.kind))).toEqual([
      'document',
      'operation',
    ]);
  });

  it('is listed after the server changes and before the models', () => {
    const before = spec({ baseUrl: 'https://old.example.com', servers: [{ url: 'https://old.example.com' }] });
    const after = spec({
      baseUrl: 'https://new.example.com',
      servers: [{ url: 'https://new.example.com' }],
      security: apiKey,
      models: [],
    });
    expect(diffSpecs(before, after).changes.map((c) => c.kind)).toEqual([
      'base-url-changed',
      'server-added',
      'server-removed',
      'security-changed',
      'model-removed',
    ]);
  });
});

describe('behaviorChanges mirror every security change from the node’s own side', () => {
  it('classifies an operation’s entry as a caller and a webhook’s as a receiver', () => {
    const before = spec({
      services: [{ name: 'Pets', operations: [op({ security: none })] }],
      webhooks: [hook({ security: none })],
    });
    const after = spec({
      services: [{ name: 'Pets', operations: [op({ security: apiKey })] }],
      webhooks: [hook({ security: apiKey })],
    });
    const diff = diffSpecs(before, after);
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'security-changed',
        node: 'operation',
        serviceName: 'Pets',
        operationName: 'listPets',
        oldSecurity: [],
        newSecurity: apiKey,
        classification: 'breaking',
      },
      {
        kind: 'security-changed',
        node: 'webhook',
        name: 'petAdopted',
        httpMethod: 'post',
        oldSecurity: [],
        newSecurity: apiKey,
        classification: 'additive',
      },
    ]);
    expect(diff.changes.map((c) => c.classification)).toEqual(['breaking', 'additive']);
  });

  it('keeps its own classification when the owning change is breaking for another reason', () => {
    const before = spec({ services: [{ name: 'Pets', operations: [op({ security: apiKey })] }] });
    const after = spec({ services: [{ name: 'Pets', operations: [op({ security: none, path: '/pets/all' })] }] });
    const diff = diffSpecs(before, after);
    expect(diff.changes[0]).toMatchObject({ kind: 'operation-modified', classification: 'breaking' });
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'security-changed',
        node: 'operation',
        serviceName: 'Pets',
        operationName: 'listPets',
        oldSecurity: apiKey,
        newSecurity: [],
        classification: 'additive',
      },
    ]);
  });

  it('does not mirror a tags change: tags are not behavior', () => {
    const diff = diffSpecs(spec(), spec({ services: [{ name: 'Pets', operations: [op({ tags: ['Pets'] })] }] }));
    expect(diff.changes).toMatchObject([{ kind: 'operation-modified', tagsChanged: true }]);
    expect(diff.behaviorChanges).toEqual([]);
    expect(diff.summary.behaviorChanges).toBe(0);
  });
});

describe('tags on an operation and a webhook', () => {
  it('reports tags gained, lost or changed as the only change, additive, with both lists', () => {
    expect(only(diffOperations('Pets', [op()], [op({ tags: ['Pets'] })]))).toMatchObject({
      kind: 'operation-modified',
      tagsChanged: true,
      oldTags: [],
      newTags: ['Pets'],
      securityChanged: false,
      classification: 'additive',
    });
    expect(only(diffOperations('Pets', [op({ tags: ['Pets'] })], [op()]))).toMatchObject({
      tagsChanged: true,
      oldTags: ['Pets'],
      newTags: [],
      classification: 'additive',
    });
    expect(only(diffOperations('Pets', [op({ tags: ['Pets'] })], [op({ tags: ['Store'] })]))).toMatchObject({
      tagsChanged: true,
      oldTags: ['Pets'],
      newTags: ['Store'],
      classification: 'additive',
    });
  });

  it('compares the lists in document order, so a reorder is a change', () => {
    expect(
      only(diffOperations('Pets', [op({ tags: ['Pets', 'Store'] })], [op({ tags: ['Store', 'Pets'] })])),
    ).toMatchObject({
      tagsChanged: true,
      oldTags: ['Pets', 'Store'],
      newTags: ['Store', 'Pets'],
      classification: 'additive',
    });
    expect(diffOperations('Pets', [op({ tags: ['Pets', 'Store'] })], [op({ tags: ['Pets', 'Store'] })])).toHaveLength(
      0,
    );
  });

  it('reports a webhook’s tags the same way', () => {
    expect(only(diffWebhooks([hook()], [hook({ tags: ['Pets'] })]))).toMatchObject({
      kind: 'webhook-modified',
      tagsChanged: true,
      oldTags: [],
      newTags: ['Pets'],
      securityChanged: false,
      classification: 'additive',
    });
    expect(diffWebhooks([hook({ tags: ['Pets'] })], [hook({ tags: ['Pets'] })])).toHaveLength(0);
  });

  it('counts a tags-only change as modified and additive in the summary, so `oagen diff` exits 1', () => {
    const diff = diffSpecs(spec(), spec({ services: [{ name: 'Pets', operations: [op({ tags: ['Pets'] })] }] }));
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 0 });
  });

  it('keeps a breaking change breaking when tags change beside it', () => {
    expect(only(diffOperations('Pets', [op()], [op({ tags: ['Pets'], path: '/pets/all' })]))).toMatchObject({
      tagsChanged: true,
      pathChanged: true,
      classification: 'breaking',
    });
  });
});

describe('a first-tag change that renames the service is a service move, not a tags change (Greptile)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function writeSpec(name: string, doc: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-security-tags-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(doc));
    return file;
  }

  const responses = { '204': { description: 'ok' } };
  const document = (paths: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths,
  });

  it('reports swapping the first two tags on a document’s only operation as service-removed and service-added, exit 2', async () => {
    // The parser files `listPets` under `Store` now, so there is no `Pets`
    // service to match it in and no `operation-modified` to carry
    // `tagsChanged`. The webhook belongs to no service, so the same swap on
    // it is a plain `tagsChanged`.
    const doc = JSON.parse(await fs.readFile(path.join(fixtures, 'security-tags-after.json'), 'utf8'));
    doc.paths['/pets'].get.tags = ['Store', 'Pets'];
    doc.webhooks.petAdopted.post.tags = ['Store', 'Pets'];
    const before = await parseSpec(path.join(fixtures, 'security-tags-after.json'));
    const after = await parseSpec(await writeSpec('swapped.json', doc));
    expect(after.services.map((s) => s.name)).toEqual(['Store']);

    const diff = diffSpecs(before, after);
    expect(diff.changes).toEqual([
      { kind: 'service-added', name: 'Store', classification: 'additive' },
      { kind: 'service-removed', name: 'Pets', classification: 'breaking' },
      {
        kind: 'webhook-modified',
        name: 'petAdopted',
        httpMethod: 'post',
        paramChanges: [],
        requestBodyChanged: false,
        responsesChanged: false,
        deprecatedChanged: false,
        securityChanged: false,
        tagsChanged: true,
        oldTags: ['Pets', 'Store'],
        newTags: ['Store', 'Pets'],
        classification: 'additive',
      },
    ]);
    // `oagen diff` exits 2 on any breaking change.
    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1, breaking: 1, additive: 2, behaviorChanges: 0 });
  });

  const pets = { get: { operationId: 'listPets', tags: ['Pets'], responses } };
  const pet = { get: { operationId: 'getPet', tags: ['Pets'], responses } };
  const movedToStore = { get: { ...pets.get, tags: ['Store'] } };

  it('reports a first tag that files the operation under a service of another name as the move, breaking', async () => {
    // `/pets` tagged Store is the only `Store` operation, so it becomes the
    // `Store` service while `getPet` keeps `Pets`: nothing is matched by name
    // within one service, and no `operation-modified` carries `tagsChanged`.
    const before = await parseSpec(await writeSpec('before.json', document({ '/pets': pets, '/pets/{id}': pet })));
    const after = await parseSpec(
      await writeSpec('after.json', document({ '/pets': movedToStore, '/pets/{id}': pet })),
    );
    expect(after.services.map((s) => [s.name, s.operations.map((o) => o.name)])).toEqual([
      ['Store', ['listPets']],
      ['Pets', ['getPet']],
    ]);

    const { changes, summary } = diffSpecs(before, after);
    expect(changes).toEqual([
      { kind: 'service-added', name: 'Store', classification: 'additive' },
      { kind: 'operation-removed', serviceName: 'Pets', operationName: 'listPets', classification: 'breaking' },
    ]);
    expect(summary.breaking).toBe(1);
  });

  it('reports a first tag the path-prefix split files back under the same service as tagsChanged, additive', async () => {
    // With `/store` also tagged Store, the Store tag spans two first segments
    // and the split carves `/pets` back out as `Pets`, so `listPets` stays
    // where it was and the edit is a plain `tagsChanged`.
    const store = { get: { operationId: 'getStore', tags: ['Store'], responses } };
    const before = await parseSpec(
      await writeSpec('before.json', document({ '/pets': pets, '/pets/{id}': pet, '/store': store })),
    );
    const after = await parseSpec(
      await writeSpec('after.json', document({ '/pets': movedToStore, '/pets/{id}': pet, '/store': store })),
    );
    expect(after.services.map((s) => [s.name, s.operations.map((o) => o.name).sort()])).toEqual([
      ['Pets', ['getPet', 'listPets']],
      ['Store', ['getStore']],
    ]);

    const { changes, summary } = diffSpecs(before, after);
    expect(changes).toMatchObject([
      {
        kind: 'operation-modified',
        serviceName: 'Pets',
        operationName: 'listPets',
        tagsChanged: true,
        oldTags: ['Pets'],
        newTags: ['Store'],
        classification: 'additive',
      },
    ]);
    expect(summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 0 });
  });

  it('reports a first tag respelled to the same service name as tagsChanged, additive', async () => {
    const before = await parseSpec(
      await writeSpec(
        'lower.json',
        document({ '/pets': { get: { operationId: 'listPets', tags: ['pets'], responses } } }),
      ),
    );
    const after = await parseSpec(
      await writeSpec(
        'upper.json',
        document({ '/pets': { get: { operationId: 'listPets', tags: ['Pets'], responses } } }),
      ),
    );
    expect(before.services[0].name).toBe('Pets');
    expect(after.services[0].name).toBe('Pets');

    const { changes, summary } = diffSpecs(before, after);
    expect(changes).toMatchObject([
      {
        kind: 'operation-modified',
        serviceName: 'Pets',
        operationName: 'listPets',
        tagsChanged: true,
        oldTags: ['pets'],
        newTags: ['Pets'],
        classification: 'additive',
      },
    ]);
    expect(summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 0 });
  });
});

describe('the new diff types are part of the package’s public surface', () => {
  it('exports SecurityChanged, SecurityNode and DocumentSecurityChanged from the package index', () => {
    const diff = diffSpecs(spec({ security: undefined }), spec({ security: apiKey }));
    const change = diff.changes[0];
    if (change.kind !== 'security-changed') throw new Error(`expected security-changed, got ${change.kind}`);
    const documentChange: DocumentSecurityChanged = change;
    expect(documentChange.classification).toBe('breaking');

    const entry = diff.behaviorChanges[0];
    if (entry.kind !== 'security-changed') throw new Error(`expected security-changed, got ${entry.kind}`);
    const mirrored: SecurityChanged = entry;
    const node: SecurityNode = { node: 'document' };
    expect(mirrored.node).toBe(node.node);
  });
});

describe('the shared helpers', () => {
  it('securityEqual compares alternatives as a set of sets, scopes as sets', () => {
    expect(securityEqual(either, [...bearer, ...apiKey])).toBe(true);
    expect(securityEqual(none, [[]])).toBe(true);
    expect(securityEqual(readWrite, [[{ schemeName: 'oauth', scopes: ['write', 'read'] }]])).toBe(true);
    expect(securityEqual(apiKey, either)).toBe(false);
    expect(securityEqual(read, readWrite)).toBe(false);
    // A scheme repeated within one alternative is one scheme with the union of its scopes.
    expect(
      securityEqual(readWrite, [
        [
          { schemeName: 'oauth', scopes: ['read'] },
          { schemeName: 'oauth', scopes: ['write'] },
        ],
      ]),
    ).toBe(true);
  });

  it('securitySatisfied holds when every alternative presented carries some alternative required', () => {
    expect(securitySatisfied(apiKey, apiKey)).toBe(true);
    expect(securitySatisfied(apiKey, both)).toBe(true);
    expect(securitySatisfied(either, apiKey)).toBe(true);
    expect(securitySatisfied(none, apiKey)).toBe(true);
    expect(securitySatisfied(optional, none)).toBe(true);
    expect(securitySatisfied(apiKey, none)).toBe(false);
    expect(securitySatisfied(apiKey, either)).toBe(false);
    expect(securitySatisfied(both, apiKey)).toBe(false);
    expect(securitySatisfied(readWrite, read)).toBe(false);
  });

  it('classifySecurityChange reads the same change differently from each side', () => {
    expect(classifySecurityChange(none, apiKey, 'caller')).toBe('breaking');
    expect(classifySecurityChange(none, apiKey, 'receiver')).toBe('additive');
    expect(classifySecurityChange(apiKey, none, 'caller')).toBe('additive');
    expect(classifySecurityChange(apiKey, none, 'receiver')).toBe('breaking');
    expect(classifySecurityChange(apiKey, bearer, 'caller')).toBe('breaking');
    expect(classifySecurityChange(apiKey, bearer, 'receiver')).toBe('breaking');
  });

  it('securityShift resolves each side against the document and is undefined when both inherit', () => {
    expect(securityShift({}, {}, documents(apiKey, bearer))).toBeUndefined();
    expect(securityShift({ security: apiKey }, {}, documents(bearer, apiKey))).toBeUndefined();
    expect(securityShift({ security: apiKey }, {}, documents(bearer, bearer))).toEqual({
      oldSecurity: apiKey,
      newSecurity: bearer,
    });
    expect(securityShift({ security: apiKey }, {})).toEqual({ oldSecurity: apiKey, newSecurity: [] });
  });

  it('tagsShift reads an absent key as an empty list and compares in order', () => {
    expect(tagsShift({}, {})).toBeUndefined();
    expect(tagsShift({ tags: ['a'] }, { tags: ['a'] })).toBeUndefined();
    expect(tagsShift({}, { tags: ['a'] })).toEqual({ oldTags: [], newTags: ['a'] });
    expect(tagsShift({ tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toEqual({ oldTags: ['a', 'b'], newTags: ['b', 'a'] });
  });
});
