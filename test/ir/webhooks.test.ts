import { describe, it, expect } from 'vitest';
import type { Callback, Operation, Webhook } from '../../src/ir/types.js';
import { callbackContext, collectOperationTypeRefs, collectWebhookTypeRefs } from '../../src/ir/types.js';

describe('collectWebhookTypeRefs', () => {
  it('yields every parameter type and the request body, in that order', () => {
    const webhook: Webhook = {
      name: 'petAdopted',
      httpMethod: 'post',
      headerParams: [{ name: 'X-Meta', type: { kind: 'model', name: 'Meta' }, required: false }],
      queryParams: [{ name: 'attempt', type: { kind: 'primitive', type: 'integer' }, required: false }],
      cookieParams: [{ name: 'session', type: { kind: 'primitive', type: 'string' }, required: false }],
      requestBody: { kind: 'model', name: 'AdoptionEvent' },
      responses: [],
    };

    expect(collectWebhookTypeRefs(webhook)).toEqual([
      { kind: 'model', name: 'Meta' },
      { kind: 'primitive', type: 'integer' },
      { kind: 'primitive', type: 'string' },
      { kind: 'model', name: 'AdoptionEvent' },
    ]);
  });

  it('yields nothing for a webhook with no parameters and no body', () => {
    const webhook: Webhook = { name: 'ping', httpMethod: 'post', headerParams: [], queryParams: [], responses: [] };
    expect(collectWebhookTypeRefs(webhook)).toEqual([]);
  });

  describe('#382', () => {
    const nested: Callback = {
      name: 'confirmed',
      expression: '{$request.body#/confirmUrl}',
      httpMethod: 'post',
      headerParams: [{ name: 'X-Deep', type: { kind: 'model', name: 'DeepMeta' }, required: false }],
      queryParams: [],
      responses: [],
    };
    const callback: Callback = {
      name: 'petAdopted',
      expression: '{$request.body#/callbackUrl}',
      httpMethod: 'post',
      headerParams: [],
      queryParams: [],
      requestBody: { kind: 'model', name: 'AdoptionEvent' },
      responses: [],
      callbacks: [nested],
    };

    it("yields a webhook's callbacks' references after its own, nested callbacks included", () => {
      const webhook: Webhook = {
        name: 'petReturned',
        httpMethod: 'post',
        headerParams: [],
        queryParams: [],
        requestBody: { kind: 'model', name: 'ReturnEvent' },
        responses: [],
        callbacks: [callback],
      };

      expect(collectWebhookTypeRefs(webhook)).toEqual([
        { kind: 'model', name: 'ReturnEvent' },
        { kind: 'model', name: 'AdoptionEvent' },
        { kind: 'model', name: 'DeepMeta' },
      ]);
    });

    it("yields an operation's callbacks' references last, nested callbacks included", () => {
      const op: Operation = {
        name: 'createPet',
        httpMethod: 'post',
        path: '/pets',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        requestBody: { kind: 'model', name: 'CreatePetRequest' },
        response: { kind: 'model', name: 'Pet' },
        errors: [],
        injectIdempotencyKey: false,
        callbacks: [callback],
      };

      expect(collectOperationTypeRefs(op)).toEqual([
        { kind: 'model', name: 'CreatePetRequest' },
        { kind: 'model', name: 'Pet' },
        { kind: 'model', name: 'AdoptionEvent' },
        { kind: 'model', name: 'DeepMeta' },
      ]);
    });

    it('labels a callback site under its owner, down to the method', () => {
      expect(callbackContext('createPet', callback)).toBe(
        'createPet.callbacks.petAdopted.{$request.body#/callbackUrl}.post',
      );
      expect(callbackContext(callbackContext('webhooks.petReturned.post', callback), nested)).toBe(
        'webhooks.petReturned.post.callbacks.petAdopted.{$request.body#/callbackUrl}.post' +
          '.callbacks.confirmed.{$request.body#/confirmUrl}.post',
      );
    });
  });
});
