import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { schemesInUse } from '../../src/differ/auth.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, AuthScheme, Callback, Model, Operation, Parameter, Webhook } from '../../src/ir/types.js';
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

/** A spec with one `Pets.createPet` operation, the given webhooks, the models, and the document default and scheme definitions. */
function spec(
  operations: Operation[],
  webhooks: Webhook[] | undefined = undefined,
  models: Model[] = [adoptionEvent],
  security?: ApiSpec['security'],
  auth?: AuthScheme[],
): ApiSpec {
  return {
    name: 'Test',
    version: '1',
    baseUrl: '',
    services: operations.length > 0 ? [{ name: 'Pets', operations }] : [],
    ...(webhooks ? { webhooks } : {}),
    models,
    enums: [],
    ...(auth ? { auth } : {}),
    ...(security ? { security } : {}),
    sdk: defaultSdkBehavior(),
  };
}

/** The `sig` scheme — an API key in the `X-Sig` header — and the requirement naming it. */
const sig: AuthScheme = { kind: 'apiKey', schemeName: 'sig', in: 'header', name: 'X-Sig' };
const signed = [[{ schemeName: 'sig', scopes: [] }]];

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

    it("counts a scheme only a callback's requirement names as in use, nested callbacks and inherited defaults included (Greptile)", () => {
      // The operation overrides the default with nothing; only the callback names `sig`.
      const direct = spec([operation({ security: [], callbacks: [callback({ security: signed })] })]);
      expect(schemesInUse(direct)).toEqual(new Set(['sig']));
      const nested = spec([
        operation({
          security: [],
          callbacks: [callback({ security: [], callbacks: [callback({ name: 'confirmed', security: signed })] })],
        }),
      ]);
      expect(schemesInUse(nested)).toEqual(new Set(['sig']));
      const onHook = spec([], [webhook({ security: [], callbacks: [callback({ security: signed })] })]);
      expect(schemesInUse(onHook)).toEqual(new Set(['sig']));
      // A callback that declares no list inherits the document default, as a webhook does.
      const inherited = spec(
        [operation({ security: [], callbacks: [callback()] })],
        undefined,
        [adoptionEvent],
        signed,
      );
      expect(schemesInUse(inherited)).toEqual(new Set(['sig']));
      // Nothing names it: not in use.
      const unused = spec(
        [operation({ security: [], callbacks: [callback({ security: [] })] })],
        undefined,
        [adoptionEvent],
        signed,
      );
      expect(schemesInUse(unused)).toEqual(new Set());
    });

    it('reports a scheme only a callback names as breaking when its header is renamed or its definition removed (Greptile)', () => {
      const secured = (auth: AuthScheme[] | undefined) =>
        spec(
          [operation({ security: [], callbacks: [callback({ security: signed })] })],
          undefined,
          [adoptionEvent],
          undefined,
          auth,
        );
      const renamed: AuthScheme = { ...sig, name: 'X-Signature' };

      // The handler reads `X-Sig`; the sender now sets `X-Signature`.
      const respelled = diffSpecs(secured([sig]), secured([renamed]));
      expect(respelled.changes).toEqual([
        {
          kind: 'security-scheme-modified',
          schemeName: 'sig',
          oldScheme: sig,
          newScheme: renamed,
          details: 'apiKey in header "X-Sig" → in header "X-Signature"',
          classification: 'breaking',
        },
      ]);
      expect(respelled.behaviorChanges).toEqual([
        {
          kind: 'security-scheme-changed',
          schemeName: 'sig',
          oldScheme: sig,
          newScheme: renamed,
          classification: 'breaking',
        },
      ]);
      // One breaking change: `oagen diff` exits 2. The callback's own list is unchanged, so no `callback-modified`.
      expect(respelled.summary).toMatchObject({ modified: 1, breaking: 1, additive: 0 });

      // The definition is gone while the callback still names it.
      const dropped = diffSpecs(secured([sig]), secured(undefined));
      expect(dropped.changes).toEqual([
        { kind: 'security-scheme-removed', schemeName: 'sig', scheme: sig, classification: 'breaking' },
      ]);
      expect(dropped.summary).toMatchObject({ removed: 1, breaking: 1 });
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

    it.each([
      { site: 'a callback', nested: false },
      { site: 'a nested callback', nested: true },
    ])(
      'reports a scheme only $site names as breaking when its header is renamed or its definition removed (Greptile)',
      async ({ nested }) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const requirement = [{ sig: [] }];
        const secured = (scheme: Record<string, unknown> | undefined) => ({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: {
            '/pets': {
              post: {
                operationId: 'createPet',
                // The operation overrides the default with nothing; only the callback names `sig`.
                security: [],
                responses: { '200': { description: 'OK' } },
                callbacks: {
                  petAdopted: nested
                    ? posting({ security: [], callbacks: { confirmed: posting({ security: requirement }) } })
                    : posting({ security: requirement }),
                },
              },
            },
          },
          ...(scheme ? { components: { securitySchemes: { sig: scheme } } } : {}),
        });
        const xSig = { type: 'apiKey', in: 'header', name: 'X-Sig' };
        const before = await parseDocument(secured(xSig));
        const parsed: AuthScheme = { kind: 'apiKey', schemeName: 'sig', in: 'header', name: 'X-Sig' };
        expect(before.auth).toEqual([parsed]);

        const respelled = diffSpecs(before, await parseDocument(secured({ ...xSig, name: 'X-Signature' })));
        expect(respelled.changes).toEqual([
          {
            kind: 'security-scheme-modified',
            schemeName: 'sig',
            oldScheme: parsed,
            newScheme: { ...parsed, name: 'X-Signature' },
            details: 'apiKey in header "X-Sig" → in header "X-Signature"',
            classification: 'breaking',
          },
        ]);
        // Exit 2; the callback's own list is unchanged, so nothing else is reported.
        expect(respelled.summary).toMatchObject({ modified: 1, breaking: 1, additive: 0 });

        const dropped = diffSpecs(before, await parseDocument(secured(undefined)));
        expect(dropped.changes).toEqual([
          { kind: 'security-scheme-removed', schemeName: 'sig', scheme: parsed, classification: 'breaking' },
        ]);
        expect(dropped.summary).toMatchObject({ removed: 1, breaking: 1 });
      },
    );

    it.each([
      { order: 'direct reference first', nestedFirst: false },
      { order: 'nested reference first', nestedFirst: true },
    ])(
      'reports only the callback added when a nested-only component callback gains a direct reference, $order (Greptile)',
      async ({ nestedFirst }) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ok = { '200': { description: 'OK' } };
        const shared = (direct: boolean) => {
          const createPet = {
            post: {
              operationId: 'createPet',
              responses: ok,
              ...(direct ? { callbacks: { adopted: { $ref: '#/components/callbacks/notifyAdoption' } } } : {}),
            },
          };
          const updatePet = {
            post: {
              operationId: 'updatePet',
              responses: ok,
              callbacks: {
                petUpdated: posting({ callbacks: { confirmed: { $ref: '#/components/callbacks/notifyAdoption' } } }),
              },
            },
          };
          return {
            openapi,
            info: { title: 'repro', version: '1' },
            paths: nestedFirst
              ? { '/owners': updatePet, '/pets': createPet }
              : { '/pets': createPet, '/owners': updatePet },
            components: { callbacks: { notifyAdoption: posting({ operationId: 'notifyAdoption' }) } },
          };
        };
        const nestedOnly = await parseDocument(shared(false));
        const both = await parseDocument(shared(true));
        // One payload model on each side: the nested site and the direct
        // site read one callback operation, so they share one minting.
        expect(nestedOnly.models.map((m) => m.name).sort()).toEqual([
          'NotifyAdoptionPayload',
          'UpdatePetPetUpdatedPayload',
        ]);
        expect(both.models.map((m) => m.name).sort()).toEqual(['NotifyAdoptionPayload', 'UpdatePetPetUpdatedPayload']);

        // Adding the direct reference renames nothing: one additive change, exit 1.
        const added = diffSpecs(nestedOnly, both);
        expect(added.changes).toEqual([
          {
            kind: 'callback-added',
            name: 'adopted',
            expression: '{$request.body#/callbackUrl}',
            httpMethod: 'post',
            ...onOperation,
            classification: 'additive',
          },
        ]);
        expect(added.summary).toMatchObject({ added: 1, modified: 0, removed: 0, breaking: 0, additive: 1 });
        // And taking it away is the one breaking removal, exit 2.
        const removed = diffSpecs(both, nestedOnly);
        expect(removed.changes.map((c) => [c.kind, c.classification])).toEqual([['callback-removed', 'breaking']]);
      },
    );

    it.each([
      { order: 'createNote first', reversed: false },
      { order: 'updateNote first', reversed: true },
    ])(
      "reports only the callback added when a second operation references a shared callback that declares its own, $order (Michael's finding 1)",
      async ({ reversed }) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ok = { '200': { description: 'OK' } };
        const reference = { noteAdded: { $ref: '#/components/callbacks/NoteAdded' } };
        const createNote = { post: { operationId: 'createNote', responses: ok, callbacks: reference } };
        // `updateNote` exists on both sides; only its reference to `NoteAdded` is added.
        const bareUpdateNote = { post: { operationId: 'updateNote', responses: ok } };
        const updateNote = { post: { ...bareUpdateNote.post, callbacks: reference } };
        const document = (paths: Record<string, unknown>) => ({
          openapi,
          info: { title: 'repro', version: '1' },
          paths,
          components: {
            callbacks: {
              NoteAdded: {
                '{$request.body#/callbackUrl}': {
                  post: {
                    operationId: 'onNoteAdded',
                    ...posting({}, { type: 'object', properties: { noteId: { type: 'string' } } })[
                      '{$request.body#/callbackUrl}'
                    ].post,
                    callbacks: {
                      noteRead: {
                        '{$request.body#/readUrl}': posting(
                          {},
                          { type: 'object', properties: { read: { type: 'boolean' } } },
                        )['{$request.body#/callbackUrl}'],
                      },
                    },
                  },
                },
              },
            },
          },
        });
        const paths = (update: unknown) =>
          reversed
            ? { '/notes/update': update, '/notes': createNote }
            : { '/notes': createNote, '/notes/update': update };
        const one = await parseDocument(document(paths(bareUpdateNote)));
        const two = await parseDocument(document(paths(updateNote)));
        expect(one.models.map((m) => m.name).sort()).toEqual(['OnNoteAddedNoteReadPayload', 'OnNoteAddedPayload']);
        expect(two.models.map((m) => m.name).sort()).toEqual(['OnNoteAddedNoteReadPayload', 'OnNoteAddedPayload']);

        // The untouched `createNote` reports nothing; `updateNote`'s reference
        // is the one additive `callback-added` (its nested `noteRead` comes
        // with it and reports nothing of its own): exit 1.
        const added = diffSpecs(one, two);
        expect(added.changes).toEqual([
          {
            kind: 'callback-added',
            name: 'noteAdded',
            expression: '{$request.body#/callbackUrl}',
            httpMethod: 'post',
            serviceName: 'Notes',
            operationName: 'updateNote',
            classification: 'additive',
          },
        ]);
        expect(added.summary).toMatchObject({ added: 1, modified: 0, removed: 0, breaking: 0, additive: 1 });
      },
    );

    it('reports nothing when two operations referencing a shared callback whose nested payload is hashed are reordered (Greptile)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ok = { '200': { description: 'OK' } };
      const reference = { noteAdded: { $ref: '#/components/callbacks/NoteAdded' } };
      const createNote = { post: { operationId: 'createNote', responses: ok, callbacks: reference } };
      const updateNote = { post: { operationId: 'updateNote', responses: ok, callbacks: reference } };
      const document = (paths: Record<string, unknown>) => ({
        openapi,
        info: { title: 'repro', version: '1' },
        paths,
        components: {
          // The nested payload's plain name is taken, so it is hashed.
          schemas: { OnNoteAddedNoteReadPayload: { type: 'object', properties: { other: { type: 'integer' } } } },
          callbacks: {
            NoteAdded: {
              '{$request.body#/callbackUrl}': {
                post: {
                  operationId: 'onNoteAdded',
                  ...posting({}, { type: 'object', properties: { noteId: { type: 'string' } } })[
                    '{$request.body#/callbackUrl}'
                  ].post,
                  callbacks: {
                    noteRead: {
                      '{$request.body#/readUrl}': posting(
                        {},
                        { type: 'object', properties: { read: { type: 'boolean' } } },
                      )['{$request.body#/callbackUrl}'],
                    },
                  },
                },
              },
            },
          },
        },
      });
      const first = await parseDocument(document({ '/notes': createNote, '/notes/update': updateNote }));
      const reversed = await parseDocument(document({ '/notes/update': updateNote, '/notes': createNote }));

      // The hashed name is the shared operation's, whichever site comes first: an unchanged contract, exit 0.
      expect(diffSpecs(first, reversed).changes).toEqual([]);
      expect(diffSpecs(reversed, first).changes).toEqual([]);
      const nestedPayload = (spec: ApiSpec) =>
        spec.services.flatMap((s) => s.operations).map((op) => op.callbacks![0]!.callbacks![0]!.requestBody);
      expect(nestedPayload(first)[0]).toMatchObject({
        kind: 'model',
        name: expect.stringMatching(/^OnNoteAddedNoteRead[0-9A-Fa-f]{6}Payload$/),
      });
      expect(nestedPayload(reversed)).toEqual(nestedPayload(first));
    });

    it.each([
      { order: 'path operation first', eventsFirst: true },
      { order: 'nesting operation first', eventsFirst: false },
    ])(
      'reports only the callback added when a path operation gains a reference a callback operation of the same stem already nests, $order (Greptile)',
      async ({ eventsFirst }) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ok = { '200': { description: 'OK' } };
        const reference = { read: { $ref: '#/components/callbacks/Read' } };
        const document = (direct: boolean) => {
          const events = {
            post: { operationId: 'registerEvent', responses: ok, ...(direct ? { callbacks: reference } : {}) },
          };
          const createPet = {
            post: {
              operationId: 'createPet',
              responses: ok,
              callbacks: {
                events: {
                  '{$request.body#/eventsUrl}': {
                    post: {
                      operationId: 'register_event',
                      ...posting({}, petIdSchema)['{$request.body#/callbackUrl}'].post,
                      callbacks: reference,
                    },
                  },
                },
              },
            },
          };
          return {
            openapi,
            info: { title: 'repro', version: '1' },
            paths: eventsFirst ? { '/events': events, '/pets': createPet } : { '/pets': createPet, '/events': events },
            components: {
              callbacks: { Read: posting({}, { type: 'object', properties: { read: { type: 'boolean' } } }) },
            },
          };
        };
        const nestedOnly = await parseDocument(document(false));
        const both = await parseDocument(document(true));
        // One `RegisterEventReadPayload` on each side: the nested site and the
        // direct site read one callback operation under one stem.
        expect(nestedOnly.models.map((m) => m.name).sort()).toEqual([
          'RegisterEventPayload',
          'RegisterEventReadPayload',
        ]);
        expect(both.models.map((m) => m.name).sort()).toEqual(['RegisterEventPayload', 'RegisterEventReadPayload']);

        // The direct reference is the one additive `callback-added`, exit 1; nothing is renamed.
        const added = diffSpecs(nestedOnly, both);
        expect(added.changes).toEqual([
          {
            kind: 'callback-added',
            name: 'read',
            expression: '{$request.body#/callbackUrl}',
            httpMethod: 'post',
            serviceName: 'Events',
            operationName: 'registerEvent',
            classification: 'additive',
          },
        ]);
        expect(added.summary).toMatchObject({ added: 1, modified: 0, removed: 0, breaking: 0, additive: 1 });
        expect(diffSpecs(both, nestedOnly).changes.map((c) => [c.kind, c.classification])).toEqual([
          ['callback-removed', 'breaking'],
        ]);
      },
    );

    it.each([
      { order: 'direct callback first', directFirst: true },
      { order: 'nesting operation first', directFirst: false },
    ])(
      'reports only the callback added when a direct reference joins a nested group whose stem a direct callback shares, $order (Greptile)',
      async ({ directFirst }) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ok = { '200': { description: 'OK' } };
        const reference = { adopted: { $ref: '#/components/callbacks/Adopted' } };
        // `createPet`'s `petAdopted` declares `operationId: notify_adoption`;
        // `registerPet`'s `registered` nests `Adopted`, whose operation
        // declares `operationId: notifyAdoption`. Both stems are `NotifyAdoption`.
        const pets = {
          post: {
            operationId: 'createPet',
            responses: ok,
            callbacks: { petAdopted: posting({ operationId: 'notify_adoption' }) },
          },
        };
        // The direct reference joins `registerPet`'s own callbacks.
        const registrations = (direct: boolean) => ({
          post: {
            operationId: 'registerPet',
            responses: ok,
            callbacks: { registered: posting({ callbacks: reference }), ...(direct ? reference : {}) },
          },
        });
        const document = (direct: boolean) => ({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: directFirst
            ? { '/pets': pets, '/registrations': registrations(direct) }
            : { '/registrations': registrations(direct), '/pets': pets },
          components: {
            callbacks: {
              Adopted: posting(
                { operationId: 'notifyAdoption' },
                { type: 'object', properties: { adopted: { type: 'boolean' } } },
              ),
            },
          },
        });
        const nestedOnly = await parseDocument(document(false));
        const both = await parseDocument(document(true));
        // Both `NotifyAdoption` stems hash on each side: the same three models.
        const names = (spec: ApiSpec) => spec.models.map((m) => m.name).sort();
        expect(names(nestedOnly)).toEqual(names(both));
        expect(names(nestedOnly).filter((name) => /^NotifyAdoption[0-9A-Fa-f]{6}Payload$/.test(name))).toHaveLength(2);
        expect(names(nestedOnly)).toContain('RegisterPetRegisteredPayload');

        // The direct reference is the one additive `callback-added`, exit 1; nothing is renamed.
        const added = diffSpecs(nestedOnly, both);
        expect(added.changes).toEqual([
          {
            kind: 'callback-added',
            name: 'adopted',
            expression: '{$request.body#/callbackUrl}',
            httpMethod: 'post',
            serviceName: 'Registrations',
            operationName: 'registerPet',
            classification: 'additive',
          },
        ]);
        expect(added.summary).toMatchObject({ added: 1, modified: 0, removed: 0, breaking: 0, additive: 1 });
        expect(diffSpecs(both, nestedOnly).changes.map((c) => [c.kind, c.classification])).toEqual([
          ['callback-removed', 'breaking'],
        ]);
      },
    );

    it.each([
      { order: 'first callback first', firstFirst: true },
      { order: 'second callback first', firstFirst: false },
    ])(
      'reports only the nested callback added when a directly referenced callback of one stem is nested inside the other, $order (Greptile)',
      async ({ firstFirst }) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ok = { '200': { description: 'OK' } };
        const reference = { adopted: { $ref: '#/components/callbacks/Adopted' } };
        // `createPet`'s `petAdopted` declares `operationId: notify_adoption`;
        // `adoptPet`'s `adopted` references `Adopted`, whose operation declares
        // `operationId: notifyAdoption`. Both stems are `NotifyAdoption`.
        const document = (nested: boolean) => {
          const pets = {
            post: {
              operationId: 'createPet',
              responses: ok,
              callbacks: {
                petAdopted: posting({ operationId: 'notify_adoption', ...(nested ? { callbacks: reference } : {}) }),
              },
            },
          };
          const adoptions = { post: { operationId: 'adoptPet', responses: ok, callbacks: reference } };
          return {
            openapi,
            info: { title: 'repro', version: '1' },
            paths: firstFirst ? { '/pets': pets, '/adoptions': adoptions } : { '/adoptions': adoptions, '/pets': pets },
            components: {
              callbacks: {
                Adopted: posting(
                  { operationId: 'notifyAdoption' },
                  { type: 'object', properties: { adopted: { type: 'boolean' } } },
                ),
              },
            },
          };
        };
        const direct = await parseDocument(document(false));
        const both = await parseDocument(document(true));
        // Both `NotifyAdoption` stems hash on each side: the same two models.
        const names = (spec: ApiSpec) => spec.models.map((m) => m.name).sort();
        expect(names(direct)).toEqual(names(both));
        expect(names(direct).filter((name) => /^NotifyAdoption[0-9A-Fa-f]{6}Payload$/.test(name))).toHaveLength(2);

        // The nested reference is the one additive `callback-added`, exit 1; nothing is renamed.
        const added = diffSpecs(direct, both);
        expect(added.changes).toHaveLength(1);
        expect(added.changes[0]).toMatchObject({
          kind: 'callback-added',
          name: 'adopted',
          expression: '{$request.body#/callbackUrl}',
          httpMethod: 'post',
          parents: [identity],
          ...onOperation,
          classification: 'additive',
        });
        expect(added.summary).toMatchObject({ added: 1, modified: 0, removed: 0, breaking: 0, additive: 1 });
        expect(diffSpecs(both, direct).changes.map((c) => [c.kind, c.classification])).toEqual([
          ['callback-removed', 'breaking'],
        ]);
      },
    );

    it.each([
      { order: 'parameter before callbacks', parametersFirst: true },
      { order: 'callbacks before parameter', parametersFirst: false },
    ])(
      "reports only the nested callback added when it asks for the name the parent's parameter model holds, $order (Greptile)",
      async ({ parametersFirst }) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const parameters = [
          { name: 'confirmedPayload', in: 'query', schema: { type: 'object', properties: { at: { type: 'string' } } } },
        ];
        const confirmed = posting({}, { type: 'object', properties: { ok: { type: 'boolean' } } });
        const petAdopted = (nested: boolean) => ({
          '{$request.body#/callbackUrl}': {
            post: {
              ...(parametersFirst ? { parameters } : {}),
              ...(nested ? { callbacks: { confirmed } } : {}),
              ...(parametersFirst ? {} : { parameters }),
              requestBody: { content: { 'application/json': { schema: petIdSchema } } },
              responses: { '204': { description: 'Done' } },
            },
          },
        });
        const before = await parseDocument(document({ petAdopted: petAdopted(false) }));
        const after = await parseDocument(document({ petAdopted: petAdopted(true) }));

        // The parent is untouched: its parameter model keeps its name, so the
        // only changes are the new payload model and the callback, both additive, exit 1.
        const added = diffSpecs(before, after);
        expect(added.changes.map((c) => [c.kind, c.classification])).toEqual([
          ['model-added', 'additive'],
          ['callback-added', 'additive'],
        ]);
        expect(added.changes[0]).toMatchObject({
          name: expect.stringMatching(/^CreatePetPetAdoptedConfirmed[0-9A-Fa-f]{6}Payload$/),
        });
        expect(added.changes[1]).toMatchObject({ name: 'confirmed', parents: [identity], ...onOperation });
        expect(added.summary).toMatchObject({ added: 2, modified: 0, removed: 0, breaking: 0, additive: 2 });
        expect(diffSpecs(after, before).changes.map((c) => [c.kind, c.classification])).toEqual([
          ['model-removed', 'breaking'],
          ['callback-removed', 'breaking'],
        ]);
      },
    );

    it("reports a callback payload field made required as breaking and made optional as additive, as a webhook's (Michael's finding 4)", async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const payload = (required: boolean) => ({
        type: 'object',
        properties: { petId: { type: 'string' } },
        ...(required ? { required: ['petId'] } : {}),
      });
      const optional = await parseDocument(document({ petAdopted: posting({}, payload(false)) }));
      const required = await parseDocument(document({ petAdopted: posting({}, payload(true)) }));

      // `field-required-changed` is direction-blind on purpose: a received
      // payload's field made required is still breaking, exit 2.
      const tightened = diffSpecs(optional, required);
      expect(tightened.changes).toEqual([
        {
          kind: 'model-modified',
          name: 'CreatePetPetAdoptedPayload',
          fieldChanges: [
            {
              kind: 'field-required-changed',
              fieldName: 'petId',
              classification: 'breaking',
              details: 'optional → required',
            },
          ],
          deprecatedChanged: false,
          classification: 'breaking',
        },
      ]);
      expect(tightened.summary).toMatchObject({ modified: 1, breaking: 1, additive: 0 });
      // Made optional: additive, exit 1.
      const relaxed = diffSpecs(required, optional);
      expect(relaxed.changes[0]).toMatchObject({
        kind: 'model-modified',
        fieldChanges: [{ kind: 'field-required-changed', fieldName: 'petId', classification: 'additive' }],
        classification: 'additive',
      });
      expect(relaxed.summary).toMatchObject({ modified: 1, breaking: 0, additive: 1 });

      // A webhook's payload is judged the same way.
      const hook = (schema: unknown) =>
        parseDocument({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: {},
          webhooks: {
            petReturned: {
              post: {
                requestBody: { content: { 'application/json': { schema } } },
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        });
      const hookTightened = diffSpecs(await hook(payload(false)), await hook(payload(true)));
      expect(hookTightened.changes[0]).toMatchObject({
        kind: 'model-modified',
        name: 'PetReturnedPayload',
        fieldChanges: [{ kind: 'field-required-changed', classification: 'breaking' }],
        classification: 'breaking',
      });
    });
  });
});
