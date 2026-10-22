import { describe, it, expect } from 'vitest';
import { diffSpecs } from '../../src/differ/diff.js';
import { buildDirectionIndex } from '../../src/differ/direction.js';
import type { ApiSpec, Model, Parameter, Webhook } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    name: 'petAdopted',
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

const adoptionEvent: Model = {
  name: 'AdoptionEvent',
  fields: [{ name: 'pet_id', type: { kind: 'primitive', type: 'string' }, required: true }],
};

function spec(webhooks: Webhook[] | undefined, models: Model[] = [adoptionEvent]): ApiSpec {
  return {
    name: 'Test',
    version: '1',
    baseUrl: '',
    services: [],
    ...(webhooks ? { webhooks } : {}),
    models,
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

describe('diffSpecs — webhooks', () => {
  it('returns no change for identical webhooks, with or without the key', () => {
    expect(diffSpecs(spec([webhook()]), spec([webhook()])).changes).toEqual([]);
    expect(diffSpecs(spec(undefined), spec(undefined)).changes).toEqual([]);
  });

  it('reports a new webhook as additive and a removed one as breaking', () => {
    const added = diffSpecs(spec(undefined), spec([webhook()]));
    expect(added.changes).toEqual([
      { kind: 'webhook-added', name: 'petAdopted', httpMethod: 'post', classification: 'additive' },
    ]);
    expect(added.summary).toMatchObject({ added: 1, additive: 1, breaking: 0 });

    const removed = diffSpecs(spec([webhook()]), spec([]));
    expect(removed.changes).toEqual([
      { kind: 'webhook-removed', name: 'petAdopted', httpMethod: 'post', classification: 'breaking' },
    ]);
    expect(removed.summary).toMatchObject({ removed: 1, breaking: 1, additive: 0 });
  });

  it('reports an accepted response code removed as breaking and one added as additive (Greptile)', () => {
    const was200 = webhook({ responses: [{ statusCode: 200 }] });
    const is202 = webhook({ responses: [{ statusCode: 202 }] });
    const swapped = diffSpecs(spec([was200]), spec([is202]));
    expect(swapped.changes).toEqual([
      {
        kind: 'webhook-modified',
        name: 'petAdopted',
        httpMethod: 'post',
        paramChanges: [],
        requestBodyChanged: false,
        responsesChanged: true,
        details: 'accepted response 200 removed; accepted response 202 added',
        classification: 'breaking',
      },
    ]);
    const widened = diffSpecs(
      spec([was200]),
      spec([webhook({ responses: [{ statusCode: 200 }, { statusCode: 202 }] })]),
    );
    expect(widened.changes[0]).toMatchObject({ responsesChanged: true, classification: 'additive' });
    // A description change alone is not reported.
    const described = diffSpecs(
      spec([was200]),
      spec([webhook({ responses: [{ statusCode: 200, description: 'ok' }] })]),
    );
    expect(described.changes).toEqual([]);
  });

  it('identifies a webhook by name and method, so a method change is a removal plus an addition', () => {
    const { changes } = diffSpecs(spec([webhook({ httpMethod: 'post' })]), spec([webhook({ httpMethod: 'put' })]));
    expect(changes.map((c) => c.kind)).toEqual(['webhook-added', 'webhook-removed']);
  });

  it('classifies a payload type change, or a payload gained or lost, as breaking', () => {
    const renamed = diffSpecs(spec([webhook()]), spec([webhook({ requestBody: { kind: 'model', name: 'Adoption' } })]));
    expect(renamed.changes).toEqual([
      {
        kind: 'webhook-modified',
        name: 'petAdopted',
        httpMethod: 'post',
        paramChanges: [],
        requestBodyChanged: true,
        responsesChanged: false,
        details: 'payload type changed',
        classification: 'breaking',
      },
    ]);
    expect(renamed.summary).toMatchObject({ modified: 1, breaking: 1 });

    const lost = diffSpecs(spec([webhook()]), spec([webhook({ requestBody: undefined })]));
    expect(lost.changes[0]).toMatchObject({
      kind: 'webhook-modified',
      requestBodyChanged: true,
      responsesChanged: false,
      details: 'payload removed',
      classification: 'breaking',
    });

    const gained = diffSpecs(spec([webhook({ requestBody: undefined })]), spec([webhook()]));
    expect(gained.changes[0]).toMatchObject({
      requestBodyChanged: true,
      responsesChanged: false,
      details: 'payload added',
      classification: 'breaking',
    });
  });

  it("reports a body requirement or encoding change under an unchanged payload type, from the receiver's side", () => {
    const required = webhook({ requestBodyRequired: true, requestBodyEncoding: 'json' });
    const optional = webhook({ requestBodyEncoding: 'json' });

    const relaxed = diffSpecs(spec([required]), spec([optional]));
    expect(relaxed.changes[0]).toMatchObject({
      kind: 'webhook-modified',
      requestBodyChanged: true,
      responsesChanged: false,
      details: 'body required → optional',
      classification: 'breaking',
    });

    const tightened = diffSpecs(spec([optional]), spec([required]));
    expect(tightened.changes[0]).toMatchObject({
      requestBodyChanged: true,
      responsesChanged: false,
      details: 'body optional → required',
      classification: 'additive',
    });

    const reencoded = diffSpecs(
      spec([required]),
      spec([webhook({ requestBodyRequired: true, requestBodyEncoding: 'form-urlencoded' })]),
    );
    expect(reencoded.changes[0]).toMatchObject({
      requestBodyChanged: true,
      responsesChanged: false,
      details: 'encoding json → form-urlencoded',
      classification: 'breaking',
    });

    const both = diffSpecs(spec([required]), spec([webhook({ requestBody: { kind: 'model', name: 'Other' } })]));
    expect(both.changes[0]).toMatchObject({
      details: 'payload type changed; encoding json → <none>; body required → optional',
      classification: 'breaking',
    });
  });

  it('matches parameters by location and name, so a header and a query parameter may share a name', () => {
    const before = webhook({ headerParams: [header('delivery_id')], queryParams: [header('delivery_id')] });
    const after = webhook({ headerParams: [], queryParams: [header('delivery_id')] });

    const { changes } = diffSpecs(spec([before]), spec([after]));

    expect(changes).toEqual([
      {
        kind: 'webhook-modified',
        name: 'petAdopted',
        httpMethod: 'post',
        paramChanges: [
          { kind: 'param-removed', paramName: 'delivery_id', classification: 'breaking', paramLocation: 'header' },
        ],
        requestBodyChanged: false,
        responsesChanged: false,
        classification: 'breaking',
      },
    ]);

    const cookie = diffSpecs(spec([webhook()]), spec([webhook({ cookieParams: [header('session')] })]));
    expect(cookie.changes[0]).toMatchObject({
      paramChanges: [
        { kind: 'param-added', paramName: 'session', classification: 'additive', paramLocation: 'cookie' },
      ],
      classification: 'additive',
    });
  });

  it("classifies parameter changes from the receiver's side", () => {
    const before = webhook({
      headerParams: [
        header('X-Removed'),
        header('X-Retyped'),
        header('X-Reformatted'),
        header('X-Now-Required'),
        header('X-Now-Optional', { required: true }),
        header('X-Defaulted', { default: 'a' }),
      ],
    });
    const after = webhook({
      headerParams: [
        header('X-Added', { required: true }),
        header('X-Retyped', { type: { kind: 'primitive', type: 'integer' } }),
        header('X-Reformatted', { type: { kind: 'primitive', type: 'string', format: 'uuid' } }),
        header('X-Now-Required', { required: true }),
        header('X-Now-Optional'),
        header('X-Defaulted', { default: 'b' }),
      ],
    });

    const { changes } = diffSpecs(spec([before]), spec([after]));
    expect(changes).toHaveLength(1);
    const change = changes[0];
    expect(change.kind).toBe('webhook-modified');
    if (change.kind !== 'webhook-modified') return;
    expect(change.requestBodyChanged).toBe(false);
    expect(change.classification).toBe('breaking');
    expect(change.paramChanges.map((pc) => [pc.kind, pc.paramName, pc.classification])).toEqual([
      ['param-added', 'X-Added', 'additive'],
      ['param-removed', 'X-Removed', 'breaking'],
      ['param-type-changed', 'X-Retyped', 'breaking'],
      ['param-format-changed', 'X-Reformatted', 'additive'],
      ['param-required-changed', 'X-Now-Required', 'additive'],
      ['param-required-changed', 'X-Now-Optional', 'breaking'],
      ['param-default-changed', 'X-Defaulted', 'additive'],
    ]);
    expect(change.paramChanges.find((pc) => pc.paramName === 'X-Defaulted')).toMatchObject({
      oldDefault: 'a',
      newDefault: 'b',
      details: 'default a → b',
    });
    expect(change.paramChanges.every((pc) => pc.paramLocation === 'header')).toBe(true);
  });

  it('is additive when only additive parameter changes occur', () => {
    const { changes } = diffSpecs(spec([webhook()]), spec([webhook({ queryParams: [header('attempt')] })]));
    expect(changes[0]).toMatchObject({ kind: 'webhook-modified', classification: 'additive' });
  });

  it('does not add a webhook parameter default change to behaviorChanges, which are an SDK-method concern', () => {
    const { behaviorChanges } = diffSpecs(
      spec([webhook({ headerParams: [header('X-Defaulted', { default: 'a' })] })]),
      spec([webhook({ headerParams: [header('X-Defaulted', { default: 'b' })] })]),
    );
    expect(behaviorChanges).toEqual([]);
  });
});

describe('buildDirectionIndex — webhooks', () => {
  it('treats a model reached only through a webhook payload or header as response-facing', () => {
    const meta: Model = { name: 'DeliveryMeta', fields: [] };
    const nested: Model = {
      name: 'AdoptionEventPet',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const event: Model = {
      ...adoptionEvent,
      fields: [
        ...adoptionEvent.fields,
        { name: 'pet', type: { kind: 'model', name: 'AdoptionEventPet' }, required: true },
      ],
    };
    const hook = webhook({ headerParams: [header('X-Meta', { type: { kind: 'model', name: 'DeliveryMeta' } })] });

    const index = buildDirectionIndex(spec([hook], [event, nested, meta]));

    expect(index.get('AdoptionEvent')).toBe('response');
    expect(index.get('AdoptionEventPet')).toBe('response');
    expect(index.get('DeliveryMeta')).toBe('response');
  });

  it('makes a required field added to a payload-only model additive', () => {
    const grown: Model = {
      ...adoptionEvent,
      fields: [
        ...adoptionEvent.fields,
        { name: 'adopted_at', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    };

    const { changes } = diffSpecs(spec([webhook()]), spec([webhook()], [grown]));

    expect(changes).toEqual([
      {
        kind: 'model-modified',
        name: 'AdoptionEvent',
        deprecatedChanged: false,
        fieldChanges: [
          {
            kind: 'field-added',
            fieldName: 'adopted_at',
            classification: 'additive',
            details: 'required on a response-only model',
          },
        ],
        classification: 'additive',
      },
    ]);
  });
});
