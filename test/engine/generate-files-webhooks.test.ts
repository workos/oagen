import { describe, expect, it } from 'vitest';
import { buildEmitterContext, collectReferencedNames, generateAllFiles } from '../../src/engine/generate-files.js';
import type { Emitter } from '../../src/engine/types.js';
import type { ApiSpec, Enum, Model, Service, Webhook } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

const models: Model[] = [
  {
    name: 'AdoptionEvent',
    fields: [{ name: 'pet', type: { kind: 'model', name: 'AdoptionEventPet' }, required: true }],
  },
  { name: 'AdoptionEventPet', fields: [] },
  { name: 'DeliveryMeta', fields: [] },
  { name: 'Unrelated', fields: [] },
];

const webhooks: Webhook[] = [
  {
    name: 'petAdopted',
    httpMethod: 'post',
    headerParams: [
      { name: 'X-Meta', type: { kind: 'model', name: 'DeliveryMeta' }, required: false },
      { name: 'X-Source', type: { kind: 'enum', name: 'Source', values: ['app'] }, required: false },
    ],
    queryParams: [],
    requestBody: { kind: 'model', name: 'AdoptionEvent' },
    responses: [],
  },
];

const services: Service[] = [
  {
    name: 'Pets',
    operations: [
      {
        name: 'listPets',
        httpMethod: 'get',
        path: '/pets',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        response: { kind: 'primitive', type: 'unknown' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

describe('collectReferencedNames — webhooks', () => {
  it('reaches models and enums referenced only by a webhook, payload fields chased transitively', () => {
    const referenced = collectReferencedNames(services, models, { webhooks });

    expect(referenced.models.has('AdoptionEvent')).toBe(true);
    expect(referenced.models.has('AdoptionEventPet')).toBe(true);
    expect(referenced.models.has('DeliveryMeta')).toBe(true);
    expect(referenced.enums.has('Source')).toBe(true);
    expect(referenced.models.has('Unrelated')).toBe(false);
  });

  it('leaves webhook-only models unreached when no webhooks are passed', () => {
    const referenced = collectReferencedNames(services, models);
    expect(referenced.models.size).toBe(0);
    expect(referenced.enums.size).toBe(0);
  });
});

describe('generateAllFiles — webhooks', () => {
  const spec: ApiSpec = {
    name: 'Test',
    version: '1',
    baseUrl: '',
    services,
    webhooks,
    models,
    enums: [{ name: 'Source', values: [{ name: 'APP', value: 'app' }] }],
    sdk: defaultSdkBehavior(),
  };

  /** An emitter that records which models and enums it was asked to generate. */
  function recordingEmitter(seen: { models: string[]; enums: string[] }): Emitter {
    return {
      language: 'recording',
      fileHeader: () => '',
      generateModels: (ms: Model[]) => {
        seen.models = ms.map((m) => m.name);
        return [];
      },
      generateEnums: (es: Enum[]) => {
        seen.enums = es.map((e) => e.name);
        return [];
      },
      generateResources: () => [],
      generateClient: () => [],
      generateErrors: () => [],
      generateTests: () => [],
    } as unknown as Emitter;
  }

  it('hands webhook payload models to the emitter in a full run and in a scoped one', () => {
    for (const scopedServices of [undefined, new Set(['Pets'])]) {
      const seen = { models: [] as string[], enums: [] as string[] };
      const ctx = buildEmitterContext(spec, { namespace: 'test', outputDir: '/tmp/out', scopedServices });
      generateAllFiles(spec, recordingEmitter(seen), ctx);

      expect(seen.models).toEqual(['AdoptionEvent', 'AdoptionEventPet', 'DeliveryMeta']);
      expect(seen.enums).toEqual(['Source']);
    }
  });
});
