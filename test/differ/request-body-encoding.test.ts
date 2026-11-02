import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffOperations } from '../../src/differ/operations.js';
import { diffWebhooks } from '../../src/differ/webhooks.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { requestBodyEncodingDetails, requestBodyEncodingShift } from '../../src/differ/classify.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { Operation, RequestBodyContent, TypeRef, Webhook } from '../../src/ir/types.js';

const pet: TypeRef = { kind: 'model', name: 'Pet' };
/** `Pet` again as a distinct object: a secondary media type's entry, equal by name but not the one `requestBody` shares. */
const petAgain: TypeRef = { kind: 'model', name: 'Pet' };
const newPet: TypeRef = { kind: 'model', name: 'NewPet' };
const form = 'application/x-www-form-urlencoded';
const contents = (entries: Array<[string, TypeRef]>): RequestBodyContent[] =>
  entries.map(([contentType, type]) => ({ contentType, type }));

/** `createPet` with a required `Pet` body, JSON-encoded, as the parser builds it. */
const createPet = (over: Partial<Operation> = {}): Operation => ({
  name: 'createPet',
  httpMethod: 'post',
  path: '/pets',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'primitive', type: 'unknown' },
  errors: [],
  injectIdempotencyKey: false,
  requestBody: pet,
  requestBodyEncoding: 'json',
  requestBodyRequired: true,
  ...over,
});

/** `createPet` without a body, as the parser builds one that declares none. */
const bodiless = createPet({ requestBody: undefined, requestBodyEncoding: undefined, requestBodyRequired: undefined });

/** The one `operation-modified` change a diff of two versions of `createPet` yields. */
function modified(oldOp: Operation, newOp: Operation) {
  const changes = diffOperations('Pets', [oldOp], [newOp]);
  expect(changes).toHaveLength(1);
  const [change] = changes;
  if (change.kind !== 'operation-modified') throw new Error(`expected operation-modified, got ${change.kind}`);
  return change;
}

describe('diffOperations — request body encoding (issue #290)', () => {
  it.each([
    ['json', 'form-urlencoded'],
    ['json', 'form-data'],
    ['form-urlencoded', 'json'],
    ['form-data', 'form-urlencoded'],
    ['binary', 'text'],
    ['text', 'json'],
  ] as const)('reports %s → %s as requestBodyEncodingChanged, breaking, with both sides', (from, to) => {
    expect(modified(createPet({ requestBodyEncoding: from }), createPet({ requestBodyEncoding: to }))).toMatchObject({
      requestBodyChanged: false,
      requestBodyRequiredChanged: false,
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: from,
      newRequestBodyEncoding: to,
      classification: 'breaking',
    });
  });

  it('reports nothing for an unchanged encoding, and carries no sides while the flag is false', () => {
    expect(diffOperations('Pets', [createPet()], [createPet()])).toEqual([]);
    const relaxed = modified(createPet(), createPet({ requestBodyRequired: false }));
    expect(relaxed).toMatchObject({ requestBodyEncodingChanged: false, classification: 'additive' });
    expect(relaxed).not.toHaveProperty('oldRequestBodyEncoding');
    expect(relaxed).not.toHaveProperty('newRequestBodyEncoding');
  });

  it('leaves a body appearing or disappearing to requestBodyChanged: its encoding goes with it', () => {
    for (const [before, after] of [
      [bodiless, createPet()],
      [createPet(), bodiless],
    ]) {
      const change = modified(before, after);
      expect(change).toMatchObject({
        requestBodyChanged: true,
        requestBodyEncodingChanged: false,
        classification: 'breaking',
      });
      expect(change).not.toHaveProperty('oldRequestBodyEncoding');
      expect(change).not.toHaveProperty('newRequestBodyEncoding');
    }
    // An optional body appearing stays additive: no encoding change is read off it.
    expect(modified(bodiless, createPet({ requestBodyRequired: false }))).toMatchObject({
      requestBodyChanged: true,
      requestBodyEncodingChanged: false,
      classification: 'additive',
    });
  });

  it('sets every flag that applies when the type, the required flag and the encoding change together', () => {
    const retyped = createPet({ requestBody: { kind: 'model', name: 'NewPet' }, requestBodyEncoding: 'form-data' });
    expect(modified(createPet({ requestBodyRequired: false }), retyped)).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: true,
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'form-data',
      classification: 'breaking',
    });
  });

  it('keeps the change breaking when the encoding changes beside an otherwise additive change', () => {
    // required → optional alone is additive; with the encoding changed it is not.
    const relaxedAndReencoded = createPet({ requestBodyEncoding: 'form-urlencoded', requestBodyRequired: false });
    expect(modified(createPet(), relaxedAndReencoded)).toMatchObject({
      requestBodyRequiredChanged: true,
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'form-urlencoded',
      classification: 'breaking',
    });
  });

  it('is additive while the old representation stays offered with its type, breaking once it is gone or retyped (Greptile round 1)', () => {
    /** `createPet` declaring `entries`, its body read from `picked` under `encoding`, as the parser builds it. */
    const listed = (entries: Array<[string, TypeRef]>, picked: TypeRef, encoding: Operation['requestBodyEncoding']) =>
      createPet({
        requestBody: picked,
        requestBodyEncoding: encoding,
        requestBodyContentTypes: entries.map(([contentType]) => contentType),
        requestBodyContents: contents(entries),
      });
    const formOnly = listed([[form, pet]], pet, 'form-urlencoded');
    // JSON added beside the kept form body: the parser now reads JSON, callers keep sending the form.
    const kept = listed(
      [
        [form, petAgain],
        ['application/json', pet],
      ],
      pet,
      'json',
    );
    expect(modified(formOnly, kept)).toMatchObject({
      requestBodyChanged: false,
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: 'form-urlencoded',
      newRequestBodyEncoding: 'json',
      requestBodyContentTypeChange: {
        added: ['application/json'],
        removed: [],
        retyped: [],
        classification: 'additive',
      },
      classification: 'additive',
    });
    // The form body gone: the old SDK's requests are no longer read.
    const gone = listed([['application/json', pet]], pet, 'json');
    expect(modified(formOnly, gone)).toMatchObject({
      requestBodyEncodingChanged: true,
      requestBodyContentTypeChange: {
        added: ['application/json'],
        removed: [form],
        retyped: [],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
    // The form body kept under another type: the old SDK's requests no longer fit it.
    const retyped = listed(
      [
        [form, newPet],
        ['application/json', pet],
      ],
      pet,
      'json',
    );
    expect(modified(formOnly, retyped)).toMatchObject({
      requestBodyChanged: false,
      requestBodyEncodingChanged: true,
      requestBodyContentTypeChange: {
        added: ['application/json'],
        removed: [],
        retyped: [form],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
    // The other way round, JSON dropped beside the kept form body: the old SDK sent JSON, which is gone.
    expect(modified(kept, formOnly)).toMatchObject({
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'form-urlencoded',
      requestBodyContentTypeChange: {
        added: [],
        removed: ['application/json'],
        retyped: [],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
  });

  it('compares an absent encoding as a value of its own while both sides carry a body (a hand-built IR)', () => {
    const unencoded = createPet({ requestBodyEncoding: undefined });
    const lost = modified(createPet(), unencoded);
    expect(lost).toMatchObject({ requestBodyEncodingChanged: true, classification: 'breaking' });
    expect(lost.oldRequestBodyEncoding).toBe('json');
    expect(lost.newRequestBodyEncoding).toBeUndefined();
    const gained = modified(unencoded, createPet());
    expect(gained.oldRequestBodyEncoding).toBeUndefined();
    expect(gained.newRequestBodyEncoding).toBe('json');
    expect(diffOperations('Pets', [unencoded], [unencoded])).toEqual([]);
  });
});

describe('diffWebhooks — request body encoding (issue #290)', () => {
  const petAdopted = (over: Partial<Webhook> = {}): Webhook => ({
    name: 'petAdopted',
    httpMethod: 'post',
    headerParams: [],
    queryParams: [],
    requestBody: pet,
    requestBodyEncoding: 'json',
    requestBodyRequired: true,
    responses: [{ statusCode: 200 }],
    ...over,
  });

  it('carries both sides of the encoding beside the details it already reported, breaking', () => {
    expect(diffWebhooks([petAdopted()], [petAdopted({ requestBodyEncoding: 'form-urlencoded' })])).toEqual([
      {
        kind: 'webhook-modified',
        name: 'petAdopted',
        httpMethod: 'post',
        paramChanges: [],
        requestBodyChanged: true,
        oldRequestBodyEncoding: 'json',
        newRequestBodyEncoding: 'form-urlencoded',
        responsesChanged: false,
        deprecatedChanged: false,
        securityChanged: false,
        tagsChanged: false,
        details: 'encoding json → form-urlencoded',
        classification: 'breaking',
      },
    ]);
  });

  it('carries no sides while the encoding is unchanged', () => {
    const [change] = diffWebhooks([petAdopted()], [petAdopted({ requestBodyRequired: false })]);
    expect(change).toMatchObject({ kind: 'webhook-modified', details: 'body required → optional' });
    expect(change).not.toHaveProperty('oldRequestBodyEncoding');
    expect(change).not.toHaveProperty('newRequestBodyEncoding');
  });

  it('is additive for the receiver when what the sender now uses is a representation the old handler decoded (Greptile round 1)', () => {
    const both = petAdopted({
      requestBodyEncoding: 'json',
      requestBodyContentTypes: ['application/json', form],
      requestBodyContents: contents([
        ['application/json', pet],
        [form, petAgain],
      ]),
    });
    const formOnly = petAdopted({
      requestBodyEncoding: 'form-urlencoded',
      requestBodyContentTypes: [form],
      requestBodyContents: contents([[form, pet]]),
    });
    // JSON dropped: the sender now uses the form body the handler already decoded.
    expect(diffWebhooks([both], [formOnly])[0]).toMatchObject({
      requestBodyChanged: true,
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'form-urlencoded',
      requestBodyContentTypeChange: {
        added: [],
        removed: ['application/json'],
        retyped: [],
        classification: 'additive',
      },
      details: 'encoding json → form-urlencoded; payload media type application/json removed',
      classification: 'additive',
    });
    // JSON added beside the form body: the sender now uses it, and the handler never saw it.
    expect(diffWebhooks([formOnly], [both])[0]).toMatchObject({
      requestBodyChanged: true,
      oldRequestBodyEncoding: 'form-urlencoded',
      newRequestBodyEncoding: 'json',
      details: 'encoding form-urlencoded → json; payload media type application/json added',
      classification: 'breaking',
    });
  });

  it('carries neither side when the payload appears or disappears, as an operation-modified change does (issue author review)', () => {
    const none = petAdopted({ requestBody: undefined, requestBodyEncoding: undefined, requestBodyRequired: undefined });
    const [removed] = diffWebhooks([petAdopted()], [none]);
    expect(removed).toMatchObject({
      requestBodyChanged: true,
      details: 'payload removed',
      classification: 'breaking',
    });
    expect(removed).not.toHaveProperty('oldRequestBodyEncoding');
    expect(removed).not.toHaveProperty('newRequestBodyEncoding');
    const [added] = diffWebhooks([none], [petAdopted()]);
    expect(added).toMatchObject({ details: 'payload added', classification: 'breaking' });
    expect(added).not.toHaveProperty('oldRequestBodyEncoding');
    expect(added).not.toHaveProperty('newRequestBodyEncoding');
  });

  it('spells a lost encoding as <none> in the details, as before, with the sides beside it', () => {
    const [change] = diffWebhooks([petAdopted()], [petAdopted({ requestBodyEncoding: undefined })]);
    expect(change).toMatchObject({
      requestBodyChanged: true,
      oldRequestBodyEncoding: 'json',
      details: 'encoding json → <none>',
      classification: 'breaking',
    });
    if (change.kind !== 'webhook-modified') throw new Error(`expected webhook-modified, got ${change.kind}`);
    expect(change.newRequestBodyEncoding).toBeUndefined();
  });
});

describe('requestBodyEncodingShift — the one comparison both diffs read the encoding through', () => {
  it('returns both sides when the encodings differ, undefined when they do not', () => {
    const json = { requestBody: pet, requestBodyEncoding: 'json' as const };
    expect(requestBodyEncodingShift(json, { requestBody: pet, requestBodyEncoding: 'json' })).toBeUndefined();
    expect(requestBodyEncodingShift({ requestBody: pet }, { requestBody: pet })).toBeUndefined();
    expect(requestBodyEncodingShift(json, { requestBody: pet, requestBodyEncoding: 'text' })).toEqual({
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'text',
    });
    expect(requestBodyEncodingShift({ requestBody: pet, requestBodyEncoding: 'binary' }, { requestBody: pet })).toEqual(
      { oldRequestBodyEncoding: 'binary', newRequestBodyEncoding: undefined },
    );
  });

  it('compares only while both nodes carry a body: one appearing or disappearing takes its encoding with it', () => {
    expect(requestBodyEncodingShift({ requestBody: pet, requestBodyEncoding: 'json' }, {})).toBeUndefined();
    expect(requestBodyEncodingShift({}, { requestBody: pet, requestBodyEncoding: 'json' })).toBeUndefined();
    expect(requestBodyEncodingShift({ requestBodyEncoding: 'json' }, { requestBodyEncoding: 'text' })).toBeUndefined();
  });

  it('spells the details the webhook change reports, <none> for no encoding', () => {
    expect(
      requestBodyEncodingDetails({ oldRequestBodyEncoding: 'json', newRequestBodyEncoding: 'form-urlencoded' }),
    ).toBe('encoding json → form-urlencoded');
    expect(requestBodyEncodingDetails({ oldRequestBodyEncoding: undefined, newRequestBodyEncoding: 'json' })).toBe(
      'encoding <none> → json',
    );
  });
});

describe('parseSpec to diffSpecs — the issue #290 repro', () => {
  const petRef = { schema: { $ref: '#/components/schemas/Pet' } };
  const newPetRef = { schema: { $ref: '#/components/schemas/NewPet' } };
  /** The `Pet` shape written inline, so the parser mints a model named after the body's place. */
  const inlinePet = { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } };
  /** `POST /pets` and the `petAdopted` webhook, both with a required body under the given `content` map. */
  const documentWith = (content: Record<string, unknown>) => {
    const requestBody = { required: true, content };
    return {
      openapi: '3.1.0',
      info: { title: 'Pets', version: '1' },
      paths: {
        '/pets': {
          post: { operationId: 'createPet', requestBody, responses: { '201': { description: 'created' } } },
        },
      },
      webhooks: {
        petAdopted: { post: { requestBody, responses: { '200': { description: 'ok' } } } },
      },
      components: {
        schemas: {
          Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          NewPet: {
            type: 'object',
            required: ['name', 'breed'],
            properties: { name: { type: 'string' }, breed: { type: 'string' } },
          },
        },
      },
    };
  };
  /** `old.json` / `new.json`: the issue's documents, the body under one media type referencing `Pet`. */
  const document = (mediaType: string) => documentWith({ [mediaType]: petRef });

  async function parseDocuments(oldDoc: unknown, newDoc: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'oagen-290-'));
    try {
      writeFileSync(join(dir, 'old.json'), JSON.stringify(oldDoc));
      writeFileSync(join(dir, 'new.json'), JSON.stringify(newDoc));
      return [await parseSpec(join(dir, 'old.json')), await parseSpec(join(dir, 'new.json'))];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    ['application/x-www-form-urlencoded', 'form-urlencoded'],
    ['multipart/form-data', 'form-data'],
  ] as const)(
    'reports createPet switching from application/json to %s as breaking, beside the webhook',
    async (mediaType, encoding) => {
      const [oldSpec, newSpec] = await parseDocuments(document('application/json'), document(mediaType));
      expect(oldSpec.services[0].operations[0].requestBodyEncoding).toBe('json');
      expect(newSpec.services[0].operations[0].requestBodyEncoding).toBe(encoding);

      const { changes, summary } = diffSpecs(oldSpec, newSpec);
      expect(changes.map((c) => c.kind)).toEqual(['operation-modified', 'webhook-modified']);
      expect(changes[0]).toMatchObject({
        kind: 'operation-modified',
        operationName: 'createPet',
        requestBodyChanged: false,
        requestBodyRequiredChanged: false,
        requestBodyEncodingChanged: true,
        oldRequestBodyEncoding: 'json',
        newRequestBodyEncoding: encoding,
        // The media types callers may send change with it: JSON gone, the form one new.
        requestBodyContentTypesChanged: true,
        requestBodyContentTypeChange: {
          added: [mediaType],
          removed: ['application/json'],
          retyped: [],
          classification: 'breaking',
        },
        classification: 'breaking',
      });
      expect(changes[1]).toMatchObject({
        kind: 'webhook-modified',
        name: 'petAdopted',
        httpMethod: 'post',
        requestBodyChanged: true,
        oldRequestBodyEncoding: 'json',
        newRequestBodyEncoding: encoding,
        requestBodyContentTypeChange: {
          added: [mediaType],
          removed: ['application/json'],
          retyped: [],
          classification: 'breaking',
        },
        details: expect.stringContaining(`encoding json → ${encoding}`),
        classification: 'breaking',
      });
      expect(summary).toMatchObject({ modified: 2, breaking: 2, additive: 0, behaviorChanges: 0 });
    },
  );

  it('reports a media type changing essence within one encoding as requestBodyContentTypesChanged alone', async () => {
    const [oldSpec, newSpec] = await parseDocuments(document('application/json'), document('application/vnd.api+json'));
    expect(newSpec.services[0].operations[0].requestBodyEncoding).toBe('json');

    const { changes } = diffSpecs(oldSpec, newSpec);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      operationName: 'createPet',
      requestBodyChanged: false,
      requestBodyEncodingChanged: false,
      requestBodyContentTypesChanged: true,
      requestBodyContentTypeChange: {
        added: ['application/vnd.api+json'],
        removed: ['application/json'],
        retyped: [],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
    expect(changes[0]).not.toHaveProperty('oldRequestBodyEncoding');
    expect(changes[0]).not.toHaveProperty('newRequestBodyEncoding');
  });

  it('reports JSON added beside a kept form body as additive, the encoding shift still flagged (Greptile round 1)', async () => {
    const [oldSpec, newSpec] = await parseDocuments(
      documentWith({ [form]: petRef }),
      documentWith({ [form]: petRef, 'application/json': petRef }),
    );
    expect(oldSpec.services[0].operations[0].requestBodyEncoding).toBe('form-urlencoded');
    expect(newSpec.services[0].operations[0].requestBodyEncoding).toBe('json');

    const { changes, summary } = diffSpecs(oldSpec, newSpec);
    expect(changes.map((c) => c.kind)).toEqual(['operation-modified', 'webhook-modified']);
    expect(changes[0]).toMatchObject({
      operationName: 'createPet',
      requestBodyChanged: false,
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: 'form-urlencoded',
      newRequestBodyEncoding: 'json',
      requestBodyContentTypesChanged: true,
      requestBodyContentTypeChange: {
        added: ['application/json'],
        removed: [],
        retyped: [],
        classification: 'additive',
      },
      classification: 'additive',
    });
    // The sender now uses JSON, which the old handler never saw: breaking for the receiver.
    expect(changes[1]).toMatchObject({
      name: 'petAdopted',
      requestBodyChanged: true,
      oldRequestBodyEncoding: 'form-urlencoded',
      newRequestBodyEncoding: 'json',
      details: expect.stringContaining('encoding form-urlencoded → json'),
      classification: 'breaking',
    });
    expect(summary).toMatchObject({ modified: 2, breaking: 1, additive: 1 });
  });

  it('reports the form body kept but retyped beside an added JSON body as breaking', async () => {
    const [oldSpec, newSpec] = await parseDocuments(
      documentWith({ [form]: petRef }),
      documentWith({ [form]: newPetRef, 'application/json': petRef }),
    );
    const { changes } = diffSpecs(oldSpec, newSpec);
    expect(changes.find((c) => c.kind === 'operation-modified')).toMatchObject({
      requestBodyChanged: false,
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: 'form-urlencoded',
      newRequestBodyEncoding: 'json',
      requestBodyContentTypeChange: {
        added: ['application/json'],
        removed: [],
        retyped: [form],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
  });

  it('reports the webhook mirror: JSON dropped beside a kept form body is additive for the receiver, breaking for the caller', async () => {
    const [oldSpec, newSpec] = await parseDocuments(
      documentWith({ 'application/json': petRef, [form]: petRef }),
      documentWith({ [form]: petRef }),
    );
    expect(oldSpec.services[0].operations[0].requestBodyEncoding).toBe('json');
    expect(newSpec.services[0].operations[0].requestBodyEncoding).toBe('form-urlencoded');

    const { changes, summary } = diffSpecs(oldSpec, newSpec);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'form-urlencoded',
      requestBodyContentTypeChange: {
        added: [],
        removed: ['application/json'],
        retyped: [],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
    expect(changes[1]).toMatchObject({
      kind: 'webhook-modified',
      requestBodyChanged: true,
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'form-urlencoded',
      requestBodyContentTypeChange: {
        added: [],
        removed: ['application/json'],
        retyped: [],
        classification: 'additive',
      },
      details: 'encoding json → form-urlencoded; payload media type application/json removed',
      classification: 'additive',
    });
    expect(summary).toMatchObject({ modified: 2, breaking: 1, additive: 1 });
  });

  it('keeps JSON added beside a kept inline form body additive although the parser renames its model (issue author review)', async () => {
    // The form body is `CreatePetRequest` while it is the body `requestBody`
    // is read from and `CreatePetApplicationXWwwFormUrlencodedRequest` once
    // JSON is preferred: one shape under two names, compared through the
    // two specs' models, so it is neither retyped nor a lost representation.
    const [oldSpec, newSpec] = await parseDocuments(
      documentWith({ [form]: inlinePet }),
      documentWith({ [form]: inlinePet, 'application/json': inlinePet }),
    );
    expect(oldSpec.services[0].operations[0].requestBodyEncoding).toBe('form-urlencoded');
    expect(newSpec.services[0].operations[0].requestBodyEncoding).toBe('json');

    const { changes, summary } = diffSpecs(oldSpec, newSpec);
    expect(changes.map((c) => c.kind)).not.toContain('model-removed');
    expect(changes.find((c) => c.kind === 'operation-modified')).toMatchObject({
      requestBodyChanged: false,
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: 'form-urlencoded',
      newRequestBodyEncoding: 'json',
      requestBodyContentTypeChange: {
        added: ['application/json'],
        removed: [],
        retyped: [],
        classification: 'additive',
      },
      classification: 'additive',
    });
    // Only the webhook breaks: its handler never decoded JSON.
    expect(changes.find((c) => c.kind === 'webhook-modified')).toMatchObject({ classification: 'breaking' });
    expect(summary.breaking).toBe(1);
  });

  it('keeps JSON dropped beside an unchanged inline form payload additive for the receiver although its model is renamed (Greptile round 2)', async () => {
    // The form payload is `PetAdoptedApplicationXWwwFormUrlencodedPayload`
    // while JSON is preferred and `PetAdoptedPayload` once it is the only
    // one: the handler already decoded that shape, read through the old
    // document for the old name and the new document for the new one.
    const [oldSpec, newSpec] = await parseDocuments(
      documentWith({ 'application/json': inlinePet, [form]: inlinePet }),
      documentWith({ [form]: inlinePet }),
    );
    expect(oldSpec.webhooks?.[0].requestBodyEncoding).toBe('json');
    expect(newSpec.webhooks?.[0].requestBodyEncoding).toBe('form-urlencoded');

    const { changes, summary } = diffSpecs(oldSpec, newSpec);
    expect(changes.find((c) => c.kind === 'webhook-modified')).toMatchObject({
      requestBodyChanged: true,
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'form-urlencoded',
      requestBodyContentTypeChange: {
        added: [],
        removed: ['application/json'],
        retyped: [],
        classification: 'additive',
      },
      details: 'encoding json → form-urlencoded; payload media type application/json removed',
      classification: 'additive',
    });
    // The mirror: the old SDK sent JSON, which the server no longer reads.
    expect(changes.find((c) => c.kind === 'operation-modified')).toMatchObject({
      requestBodyEncodingChanged: true,
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'form-urlencoded',
      requestBodyContentTypeChange: {
        added: [],
        removed: ['application/json'],
        retyped: [],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
    // What breaks: the operation, and the two secondary-media-type models
    // the old spec minted and the new spec no longer has.
    expect(
      changes
        .filter((c) => c.classification === 'breaking')
        .map((c) => c.kind)
        .sort(),
    ).toEqual(['model-removed', 'model-removed', 'operation-modified']);
    expect(summary.breaking).toBe(3);
  });

  it('reports nothing when both documents declare the body the same way', async () => {
    const [oldSpec, newSpec] = await parseDocuments(document('application/json'), document('application/json'));
    expect(diffSpecs(oldSpec, newSpec).changes).toEqual([]);
  });
});
