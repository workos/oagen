import { describe, it, expect } from 'vitest';
import { diffOperations } from '../../src/differ/operations.js';
import { diffWebhooks } from '../../src/differ/webhooks.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Model, Operation, Webhook } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

/**
 * Issue #316: `requestBodyDescription` is documentation, not shape. A change
 * to it — on an operation or on a webhook — is not reported, the same as a
 * changed response or operation description, so it is never breaking.
 */

const createPet: Operation = {
  name: 'createPet',
  httpMethod: 'post',
  path: '/pets',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  requestBody: { kind: 'model', name: 'CreatePetRequest' },
  requestBodyEncoding: 'json',
  requestBodyContentType: 'application/json',
  requestBodyRequired: true,
  requestBodyContentTypes: ['application/json'],
  requestBodyContents: [{ contentType: 'application/json', type: { kind: 'model', name: 'CreatePetRequest' } }],
  response: { kind: 'model', name: 'Pet' },
  errors: [],
  injectIdempotencyKey: false,
};

const petAdopted: Webhook = {
  name: 'petAdopted',
  httpMethod: 'post',
  headerParams: [],
  queryParams: [],
  requestBody: { kind: 'model', name: 'PetAdoptedPayload' },
  requestBodyEncoding: 'json',
  requestBodyContentType: 'application/json',
  responses: [{ statusCode: 200 }],
};

const models: Model[] = [
  { name: 'CreatePetRequest', fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }] },
  { name: 'Pet', fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }] },
  { name: 'PetAdoptedPayload', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
];

function spec(operations: Operation[], webhooks: Webhook[]): ApiSpec {
  return {
    name: 'Pets',
    version: '1',
    baseUrl: '',
    services: [{ name: 'Pets', operations }],
    ...(webhooks.length > 0 ? { webhooks } : {}),
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

describe('diff — request body descriptions (issue #316)', () => {
  it('ignores a changed request body description on an operation, the way a changed response description is ignored', () => {
    const old: Operation = { ...createPet, requestBodyDescription: 'The pet to add.' };
    const modified: Operation = { ...createPet, requestBodyDescription: 'The pet to add to the shelter.' };

    expect(diffOperations('Pets', [old], [modified])).toEqual([]);
  });

  it('ignores a request body description appearing or disappearing on an operation', () => {
    const described: Operation = { ...createPet, requestBodyDescription: 'The pet to add.' };

    expect(diffOperations('Pets', [createPet], [described])).toEqual([]);
    expect(diffOperations('Pets', [described], [createPet])).toEqual([]);
  });

  it('ignores a changed, appearing or disappearing request body description on a webhook', () => {
    const described: Webhook = { ...petAdopted, requestBodyDescription: 'The adoption.' };
    const reworded: Webhook = { ...petAdopted, requestBodyDescription: 'The adoption, with the adopter.' };

    expect(diffWebhooks([described], [reworded])).toEqual([]);
    expect(diffWebhooks([petAdopted], [described])).toEqual([]);
    expect(diffWebhooks([described], [petAdopted])).toEqual([]);
  });

  it('reports nothing for a document whose only change is a request body description', () => {
    const before = spec(
      [{ ...createPet, requestBodyDescription: 'The pet to add.' }],
      [{ ...petAdopted, requestBodyDescription: 'The adoption.' }],
    );
    const after = spec(
      [{ ...createPet, requestBodyDescription: 'The pet to add to the shelter.' }],
      [{ ...petAdopted, requestBodyDescription: 'The adoption, with the adopter.' }],
    );

    const report = diffSpecs(before, after);
    expect(report.changes).toEqual([]);
    expect(report.behaviorChanges).toEqual([]);
    expect(report.summary).toEqual({ added: 0, removed: 0, modified: 0, breaking: 0, additive: 0, behaviorChanges: 0 });
  });

  it('still reports the body itself changing beside a description change, with the description playing no part', () => {
    const old: Operation = { ...createPet, requestBodyDescription: 'The pet to add.' };
    const retyped: Operation = {
      ...createPet,
      requestBody: { kind: 'model', name: 'Pet' },
      requestBodyContents: [{ contentType: 'application/json', type: { kind: 'model', name: 'Pet' } }],
      requestBodyDescription: 'The pet to add to the shelter.',
    };

    const changes = diffOperations('Pets', [old], [retyped]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      requestBodyChanged: true,
      classification: 'breaking',
    });
    expect(JSON.stringify(changes)).not.toContain('The pet to add');
  });
});
