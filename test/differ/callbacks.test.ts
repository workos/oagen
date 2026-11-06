import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Callback, Model, Operation, Parameter, Webhook } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

/**
 * Issue #382: a callback added, removed or changed was invisible to
 * `oagen diff`, which exited 0. Each pair of operations or webhooks both
 * documents carry now has its callbacks compared as webhooks are, from the
 * receiver's side, as `callback-added` / `callback-removed` /
 * `callback-modified` changes keyed by `name` + `expression` + `httpMethod`
 * and carrying the owner's site.
 */

const adoptionEvent: Model = {
  name: 'AdoptionEvent',
  fields: [{ name: 'pet_id', type: { kind: 'primitive', type: 'string' }, required: true }],
};

function callback(overrides: Partial<Callback> = {}): Callback {
  return {
    name: 'petAdopted',
    expression: '{$request.body#/callbackUrl}',
    httpMethod: 'post',
    headerParams: [],
    queryParams: [],
    requestBody: { kind: 'model', name: 'AdoptionEvent' },
    responses: [{ statusCode: 200 }],
    ...overrides,
  };
}

function header(name: string, overrides: Partial<Parameter> = {}): Parameter {
  return { name, type: { kind: 'primitive', type: 'string' }, required: false, ...overrides };
}

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'createPet',
    httpMethod: 'post',
    path: '/pets',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'unknown' },
    errors: [],
    injectIdempotencyKey: false,
    ...overrides,
  };
}

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return { name: 'petReturned', httpMethod: 'post', headerParams: [], queryParams: [], responses: [], ...overrides };
}

/** A spec with one `Pets.createPet` operation, the given webhooks, and the models. */
function spec(
  operations: Operation[],
  webhooks: Webhook[] | undefined = undefined,
  models: Model[] = [adoptionEvent],
  security?: ApiSpec['security'],
): ApiSpec {
  return {
    name: 'Test',
    version: '1',
    baseUrl: '',
    services: operations.length > 0 ? [{ name: 'Pets', operations }] : [],
    ...(webhooks ? { webhooks } : {}),
    models,
    enums: [],
    ...(security ? { security } : {}),
    sdk: defaultSdkBehavior(),
  };
}

const onOperation = { serviceName: 'Pets', operationName: 'createPet' };
const onWebhook = { webhookName: 'petReturned', webhookMethod: 'post' };
const identity = { name: 'petAdopted', expression: '{$request.body#/callbackUrl}', httpMethod: 'post' };

/** The fields every `callback-modified` change carries, on `site`, with nothing changed but what `overrides` says. */
function modified(overrides: Record<string, unknown>, site: Record<string, string> = onOperation) {
  return {
    kind: 'callback-modified',
    ...identity,
    ...site,
    paramChanges: [],
    requestBodyChanged: false,
    responsesChanged: false,
    deprecatedChanged: false,
    securityChanged: false,
    tagsChanged: false,
    ...overrides,
  };
}

describe('#382', () => {
  describe('through diffSpecs, hand-built IR', () => {
    it('reports no change for identical callbacks, and none between an absent list and an empty one', () => {
      const withCallback = spec([operation({ callbacks: [callback()] })]);
      expect(diffSpecs(withCallback, withCallback).changes).toEqual([]);

      const absent = spec([operation()]);
      const empty = spec([operation({ callbacks: [] })]);
      expect(diffSpecs(absent, empty).changes).toEqual([]);
      expect(diffSpecs(empty, absent).changes).toEqual([]);
      expect(diffSpecs(absent, empty).summary).toMatchObject({ added: 0, removed: 0, modified: 0 });
    });

    it('reports a callback added as additive (exit 1) and one removed as breaking (exit 2), on the operation that owns it', () => {
      const without = spec([operation()]);
      const withCallback = spec([operation({ callbacks: [callback()] })]);

      const added = diffSpecs(without, withCallback);
      expect(added.changes).toEqual([
        { kind: 'callback-added', ...identity, ...onOperation, classification: 'additive' },
      ]);
      expect(added.summary).toMatchObject({ added: 1, removed: 0, modified: 0, additive: 1, breaking: 0 });

      const removed = diffSpecs(withCallback, without);
      expect(removed.changes).toEqual([
        { kind: 'callback-removed', ...identity, ...onOperation, classification: 'breaking' },
      ]);
      expect(removed.summary).toMatchObject({ added: 0, removed: 1, modified: 0, additive: 0, breaking: 1 });
    });

    it('reports a callback on a webhook under the webhook, after the webhook-modified change', () => {
      const before = spec([], [webhook({ callbacks: [callback()] })]);
      const after = spec(
        [],
        [webhook({ deprecated: true, callbacks: [callback({ responses: [{ statusCode: 202 }] })] })],
      );

      const { changes } = diffSpecs(before, after);
      expect(changes.map((c) => c.kind)).toEqual(['webhook-modified', 'callback-modified']);
      expect(changes[1]).toEqual(
        modified(
          {
            responsesChanged: true,
            details: 'accepted response 200 removed; accepted response 202 added',
            classification: 'breaking',
          },
          onWebhook,
        ),
      );
      // The webhook's site, not an operation's.
      expect(changes[1]).not.toHaveProperty('serviceName');
    });

    it('reports a callback change even when its owner has no change of its own, where the owner change would be', () => {
      const before = spec([operation({ callbacks: [callback()] }), operation({ name: 'listPets', httpMethod: 'get' })]);
      const after = spec([
        operation({ callbacks: [callback({ headerParams: [header('X-Signature')] })] }),
        operation({ name: 'listPets', httpMethod: 'get', deprecated: true }),
      ]);

      const { changes } = diffSpecs(before, after);
      expect(changes.map((c) => c.kind)).toEqual(['callback-modified', 'operation-modified']);
      expect(changes[0]).toEqual(
        modified({
          paramChanges: [
            { kind: 'param-added', paramName: 'X-Signature', classification: 'additive', paramLocation: 'header' },
          ],
          classification: 'additive',
        }),
      );
    });

    it('reports nothing for the callbacks of an owner only one document carries', () => {
      const listPets = () => operation({ name: 'listPets', httpMethod: 'get' });
      const without = spec([listPets()]);
      const withOwner = spec([listPets(), operation({ callbacks: [callback()] })]);

      expect(diffSpecs(without, withOwner).changes.map((c) => c.kind)).toEqual(['operation-added']);
      expect(diffSpecs(withOwner, without).changes.map((c) => c.kind)).toEqual(['operation-removed']);
      // A service that comes or goes with its operations reports the service alone.
      expect(diffSpecs(spec([]), withOwner).changes.map((c) => c.kind)).toEqual(['service-added']);
      expect(diffSpecs(withOwner, spec([])).changes.map((c) => c.kind)).toEqual(['service-removed']);

      const hooks = spec([], [webhook({ callbacks: [callback()] })]);
      expect(diffSpecs(spec([]), hooks).changes.map((c) => c.kind)).toEqual(['webhook-added']);
      expect(diffSpecs(hooks, spec([])).changes.map((c) => c.kind)).toEqual(['webhook-removed']);
    });

    it('identifies a callback by name, expression and method, so an expression or method edit is a removal beside an addition', () => {
      const before = spec([operation({ callbacks: [callback()] })]);
      const otherExpression = spec([operation({ callbacks: [callback({ expression: '{$request.body#/url}' })] })]);
      const otherMethod = spec([operation({ callbacks: [callback({ httpMethod: 'put' })] })]);

      expect(diffSpecs(before, otherExpression).changes).toEqual([
        {
          kind: 'callback-added',
          ...identity,
          expression: '{$request.body#/url}',
          ...onOperation,
          classification: 'additive',
        },
        { kind: 'callback-removed', ...identity, ...onOperation, classification: 'breaking' },
      ]);
      expect(
        diffSpecs(before, otherMethod).changes.map((c) => [c.kind, (c as { httpMethod: string }).httpMethod]),
      ).toEqual([
        ['callback-added', 'put'],
        ['callback-removed', 'post'],
      ]);
      expect(diffSpecs(before, otherMethod).summary).toMatchObject({ added: 1, removed: 1, breaking: 1, additive: 1 });
    });

    it("judges a callback payload's fields from the receiver's side: a required field added is additive, one removed breaking", () => {
      const grown: Model = {
        ...adoptionEvent,
        fields: [...adoptionEvent.fields, { name: 'at', type: { kind: 'primitive', type: 'string' }, required: true }],
      };
      const before = spec([operation({ callbacks: [callback()] })], undefined, [adoptionEvent]);
      const after = spec([operation({ callbacks: [callback()] })], undefined, [grown]);

      // The model is reached only through the callback, so it is received:
      // the sender now always provides the field.
      const added = diffSpecs(before, after);
      expect(added.changes).toEqual([
        {
          kind: 'model-modified',
          name: 'AdoptionEvent',
          fieldChanges: [
            {
              kind: 'field-added',
              fieldName: 'at',
              classification: 'additive',
              details: 'required on a response-only model',
            },
          ],
          deprecatedChanged: false,
          classification: 'additive',
        },
      ]);
      const removed = diffSpecs(after, before);
      expect(removed.changes[0]).toMatchObject({
        kind: 'model-modified',
        fieldChanges: [{ kind: 'field-removed', fieldName: 'at', classification: 'breaking' }],
        classification: 'breaking',
      });
    });

    it('reports a header parameter removed as breaking and the payload type changed as breaking, from the receiver', () => {
      const before = spec([operation({ callbacks: [callback({ headerParams: [header('X-Signature')] })] })]);
      const after = spec([operation({ callbacks: [callback()] })]);
      expect(diffSpecs(before, after).changes).toEqual([
        modified({
          paramChanges: [
            { kind: 'param-removed', paramName: 'X-Signature', classification: 'breaking', paramLocation: 'header' },
          ],
          classification: 'breaking',
        }),
      ]);

      const retyped = spec(
        [operation({ callbacks: [callback({ requestBody: { kind: 'model', name: 'Adoption' } })] })],
        undefined,
        [adoptionEvent, { ...adoptionEvent, name: 'Adoption' }],
      );
      expect(diffSpecs(spec([operation({ callbacks: [callback()] })]), retyped).changes).toEqual([
        { kind: 'model-added', name: 'Adoption', classification: 'additive' },
        modified({ requestBodyChanged: true, details: 'payload type changed', classification: 'breaking' }),
      ]);
    });

    it("mirrors a callback's deprecated flip, and its parameter's, into behaviorChanges as callback nodes carrying the site", () => {
      const before = spec([operation({ callbacks: [callback({ headerParams: [header('X-Signature')] })] })]);
      const after = spec([
        operation({
          callbacks: [callback({ deprecated: true, headerParams: [header('X-Signature', { deprecated: true })] })],
        }),
      ]);

      const report = diffSpecs(before, after);
      expect(report.changes).toEqual([
        modified({
          paramChanges: [
            {
              kind: 'param-deprecated-changed',
              paramName: 'X-Signature',
              classification: 'additive',
              paramLocation: 'header',
              oldDeprecated: false,
              newDeprecated: true,
              details: 'live → deprecated',
            },
          ],
          deprecatedChanged: true,
          oldDeprecated: false,
          newDeprecated: true,
          classification: 'additive',
        }),
      ]);
      expect(report.behaviorChanges).toEqual([
        {
          kind: 'deprecated-changed',
          node: 'callback',
          ...identity,
          ...onOperation,
          oldDeprecated: false,
          newDeprecated: true,
          classification: 'additive',
        },
        {
          kind: 'deprecated-changed',
          node: 'callback-parameter',
          ...identity,
          ...onOperation,
          paramName: 'X-Signature',
          paramLocation: 'header',
          oldDeprecated: false,
          newDeprecated: true,
          classification: 'additive',
        },
      ]);
      // One additive change, mirrored twice: `oagen diff` exits 1.
      expect(report.summary).toMatchObject({ modified: 1, additive: 1, breaking: 0, behaviorChanges: 2 });
    });

    it("reads a callback's security from the receiver's side and mirrors it as a callback node", () => {
      const signed = [[{ schemeName: 'sig', scopes: [] }]];
      const open = spec([operation({ callbacks: [callback({ security: [] })] })]);
      const signing = spec([operation({ callbacks: [callback({ security: signed })] })]);

      // The sender starts carrying a credential beside nothing: the handler
      // still finds what it checked for — additive.
      const tightened = diffSpecs(open, signing);
      expect(tightened.changes).toEqual([
        modified({ securityChanged: true, oldSecurity: [], newSecurity: signed, classification: 'additive' }),
      ]);
      expect(tightened.behaviorChanges).toEqual([
        {
          kind: 'security-changed',
          node: 'callback',
          ...identity,
          ...onOperation,
          oldSecurity: [],
          newSecurity: signed,
          classification: 'additive',
        },
      ]);
      // The sender stops presenting it: breaking.
      const relaxed = diffSpecs(signing, open);
      expect(relaxed.changes[0]).toMatchObject({ securityChanged: true, classification: 'breaking' });
      expect(relaxed.behaviorChanges[0]).toMatchObject({ node: 'callback', classification: 'breaking' });
      expect(relaxed.summary).toMatchObject({ breaking: 1 });
    });

    it('classifies a document-level security change from the receiver when only a callback inherits it in both documents', () => {
      const signed = [[{ schemeName: 'sig', scopes: [] }]];
      // The operation declares its own list, so no caller inherits the
      // document's; the callback inherits it on both sides.
      const op = () => operation({ security: [], callbacks: [callback()] });
      const before = spec([op()], undefined, [adoptionEvent], signed);
      const after = spec([op()], undefined, [adoptionEvent], []);

      // From the receiver's side the sender stops presenting the credential: breaking.
      expect(diffSpecs(before, after).changes).toEqual([
        { kind: 'security-changed', oldSecurity: signed, newSecurity: [], classification: 'breaking' },
      ]);
      // From the caller's side alone the same edit would be additive.
      const callerOnly = (security: ApiSpec['security']) => spec([operation()], undefined, [adoptionEvent], security);
      expect(diffSpecs(callerOnly(signed), callerOnly([])).changes[0]).toMatchObject({ classification: 'additive' });
    });

    it('reports a nested callback under its parents, outermost first, and only when nested', () => {
      const nested = (responses: Callback['responses']) =>
        callback({
          callbacks: [
            callback({
              name: 'confirmed',
              expression: '{$request.body#/confirmUrl}',
              requestBody: undefined,
              responses,
              callbacks: [callback({ name: 'deep', expression: '{$request.body#/deepUrl}', requestBody: undefined })],
            }),
          ],
        });
      const before = spec([operation({ callbacks: [nested([{ statusCode: 200 }])] })]);
      const after = spec([operation({ callbacks: [nested([{ statusCode: 200 }, { statusCode: 202 }])] })]);

      const { changes } = diffSpecs(before, after);
      expect(changes).toEqual([
        modified({
          name: 'confirmed',
          expression: '{$request.body#/confirmUrl}',
          parents: [identity],
          responsesChanged: true,
          details: 'accepted response 202 added',
          classification: 'additive',
        }),
      ]);
      // The outer callback is unchanged and reported nowhere; the deepest, unchanged, neither.
      expect(changes).toHaveLength(1);

      // A nested callback added or removed carries its parents too, and
      // its own callbacks report nothing.
      const stripped = spec([operation({ callbacks: [callback()] })]);
      expect(diffSpecs(stripped, before).changes).toEqual([
        {
          kind: 'callback-added',
          name: 'confirmed',
          expression: '{$request.body#/confirmUrl}',
          httpMethod: 'post',
          ...onOperation,
          parents: [identity],
          classification: 'additive',
        },
      ]);
      // A top-level callback carries no `parents` key at all.
      expect(diffSpecs(spec([operation()]), stripped).changes[0]).not.toHaveProperty('parents');
    });
  });

  describe.each(['3.0.3', '3.1.0'])('through parseSpec, OpenAPI %s', (openapi) => {
    const petIdSchema = { type: 'object', properties: { petId: { type: 'string' } } };
    const posting = (extra: Record<string, unknown> = {}, schema: unknown = petIdSchema) => ({
      '{$request.body#/callbackUrl}': {
        post: {
          ...extra,
          requestBody: { content: { 'application/json': { schema } } },
          responses: { '204': { description: 'Done' } },
        },
      },
    });
    const document = (callbacks?: unknown, webhookCallbacks?: unknown) => ({
      openapi,
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            responses: { '200': { description: 'OK' } },
            ...(callbacks ? { callbacks } : {}),
          },
        },
      },
      ...(webhookCallbacks
        ? {
            webhooks: {
              petReturned: {
                post: { responses: { '200': { description: 'OK' } }, callbacks: webhookCallbacks },
              },
            },
          }
        : {}),
    });

    async function parseDocument(doc: unknown): Promise<ApiSpec> {
      const dir = mkdtempSync(join(tmpdir(), 'oagen-callbacks-diff-'));
      try {
        const file = join(dir, 'spec.json');
        writeFileSync(file, JSON.stringify(doc));
        return await parseSpec(file);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reports a callback added with its payload model, and removed with it, in either direction', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const without = await parseDocument(document());
      const withCallback = await parseDocument(document({ petAdopted: posting() }));

      const added = diffSpecs(without, withCallback);
      expect(added.changes).toEqual([
        { kind: 'model-added', name: 'CreatePetPetAdoptedPayload', classification: 'additive' },
        { kind: 'callback-added', ...identity, ...onOperation, classification: 'additive' },
      ]);
      // Additive only: `oagen diff` exits 1.
      expect(added.summary).toMatchObject({ added: 2, breaking: 0, additive: 2 });

      const removed = diffSpecs(withCallback, without);
      expect(removed.changes).toEqual([
        { kind: 'model-removed', name: 'CreatePetPetAdoptedPayload', classification: 'breaking' },
        { kind: 'callback-removed', ...identity, ...onOperation, classification: 'breaking' },
      ]);
      // Breaking: `oagen diff` exits 2.
      expect(removed.summary).toMatchObject({ removed: 2, breaking: 2, additive: 0 });

      // Nothing between a document and itself: exit 0.
      expect(diffSpecs(withCallback, withCallback).changes).toEqual([]);
    });

    it("reports a payload field added as additive and a header added as additive, from the receiver's side", async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const before = await parseDocument(document({ petAdopted: posting() }));
      const after = await parseDocument(
        document({
          petAdopted: posting(
            { parameters: [{ name: 'X-Signature', in: 'header', required: true, schema: { type: 'string' } }] },
            { type: 'object', properties: { petId: { type: 'string' }, at: { type: 'string' } }, required: ['at'] },
          ),
        }),
      );

      const grown = diffSpecs(before, after);
      expect(grown.changes).toEqual([
        {
          kind: 'model-modified',
          name: 'CreatePetPetAdoptedPayload',
          fieldChanges: [
            {
              kind: 'field-added',
              fieldName: 'at',
              classification: 'additive',
              details: 'required on a response-only model',
            },
          ],
          deprecatedChanged: false,
          classification: 'additive',
        },
        modified({
          paramChanges: [
            { kind: 'param-added', paramName: 'X-Signature', classification: 'additive', paramLocation: 'header' },
          ],
          classification: 'additive',
        }),
      ]);
      expect(grown.summary).toMatchObject({ modified: 2, breaking: 0, additive: 2 });

      const shrunk = diffSpecs(after, before);
      expect(shrunk.changes.map((c) => [c.kind, c.classification])).toEqual([
        ['model-modified', 'breaking'],
        ['callback-modified', 'breaking'],
      ]);
      expect(shrunk.summary).toMatchObject({ modified: 2, breaking: 2 });
    });

    it("reports a deprecated flip as additive with its mirror, and a webhook's callback under the webhook", async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const live = await parseDocument(document(undefined, { adoptionConfirmed: posting() }));
      const deprecated = await parseDocument(document(undefined, { adoptionConfirmed: posting({ deprecated: true }) }));

      const flipped = diffSpecs(live, deprecated);
      expect(flipped.changes).toEqual([
        {
          ...modified(
            { deprecatedChanged: true, oldDeprecated: false, newDeprecated: true, classification: 'additive' },
            onWebhook,
          ),
          name: 'adoptionConfirmed',
        },
      ]);
      expect(flipped.changes[0]).not.toHaveProperty('serviceName');
      expect(flipped.behaviorChanges).toEqual([
        {
          kind: 'deprecated-changed',
          node: 'callback',
          ...identity,
          name: 'adoptionConfirmed',
          ...onWebhook,
          oldDeprecated: false,
          newDeprecated: true,
          classification: 'additive',
        },
      ]);
      expect(flipped.summary).toMatchObject({ modified: 1, additive: 1, breaking: 0, behaviorChanges: 1 });
      expect(diffSpecs(deprecated, live).changes[0]).toMatchObject({ oldDeprecated: true, newDeprecated: false });
    });
  });
});
