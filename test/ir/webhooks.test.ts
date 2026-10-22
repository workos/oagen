import { describe, it, expect } from 'vitest';
import type { Webhook } from '../../src/ir/types.js';
import { collectWebhookTypeRefs } from '../../src/ir/types.js';

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
});
