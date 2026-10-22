import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffOperations } from '../../src/differ/operations.js';
import { diffWebhooks } from '../../src/differ/webhooks.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { requestBodyEncodingDetails, requestBodyEncodingShift } from '../../src/differ/classify.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { Operation, Webhook } from '../../src/ir/types.js';

const pet: Operation['requestBody'] = { kind: 'model', name: 'Pet' };

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
    expect(requestBodyEncodingShift({ requestBodyEncoding: 'json' }, { requestBodyEncoding: 'json' })).toBeUndefined();
    expect(requestBodyEncodingShift({}, {})).toBeUndefined();
    expect(requestBodyEncodingShift({ requestBodyEncoding: 'json' }, { requestBodyEncoding: 'text' })).toEqual({
      oldRequestBodyEncoding: 'json',
      newRequestBodyEncoding: 'text',
    });
    expect(requestBodyEncodingShift({ requestBodyEncoding: 'binary' }, {})).toEqual({
      oldRequestBodyEncoding: 'binary',
      newRequestBodyEncoding: undefined,
    });
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
  /** `old.json` / `new.json`: `POST /pets` and the `petAdopted` webhook, both with a required `Pet` body under the given media type. */
  const document = (mediaType: string) => {
    const requestBody = { required: true, content: { [mediaType]: { schema: { $ref: '#/components/schemas/Pet' } } } };
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
        schemas: { Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
      },
    };
  };

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
        classification: 'breaking',
      });
      expect(changes[1]).toMatchObject({
        kind: 'webhook-modified',
        name: 'petAdopted',
        httpMethod: 'post',
        requestBodyChanged: true,
        oldRequestBodyEncoding: 'json',
        newRequestBodyEncoding: encoding,
        details: expect.stringContaining(`encoding json → ${encoding}`),
        classification: 'breaking',
      });
      expect(summary).toMatchObject({ modified: 2, breaking: 2, additive: 0, behaviorChanges: 0 });
    },
  );

  it('reports nothing when both documents declare the body the same way', async () => {
    const [oldSpec, newSpec] = await parseDocuments(document('application/json'), document('application/json'));
    expect(diffSpecs(oldSpec, newSpec).changes).toEqual([]);
  });
});
