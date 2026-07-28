import { describe, it, expect } from 'vitest';
import { buildDirectionIndex, directionOf } from '../../src/differ/direction.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Model, Operation } from '../../src/ir/types.js';

const op = (over: Partial<Operation>): Operation => ({
  name: 'get',
  httpMethod: 'get',
  path: '/things',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'primitive', type: 'unknown' },
  errors: [],
  injectIdempotencyKey: false,
  ...over,
});

const spec = (models: Model[], operations: Operation[]): ApiSpec => ({
  name: 'test',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
  services: [{ name: 'Things', operations }],
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
});

describe('buildDirectionIndex', () => {
  it('marks a model reached only from a response as response-facing', () => {
    const index = buildDirectionIndex(
      spec([{ name: 'Thing', fields: [] }], [op({ response: { kind: 'model', name: 'Thing' } })]),
    );
    expect(directionOf(index, 'Thing')).toBe('response');
  });

  it('marks a model reached only from a request body as request-facing', () => {
    const index = buildDirectionIndex(
      spec(
        [{ name: 'CreateThing', fields: [] }],
        [op({ httpMethod: 'post', requestBody: { kind: 'model', name: 'CreateThing' } })],
      ),
    );
    expect(directionOf(index, 'CreateThing')).toBe('request');
  });

  it('marks a model used on both sides as both', () => {
    const index = buildDirectionIndex(
      spec(
        [{ name: 'Thing', fields: [] }],
        [
          op({
            httpMethod: 'put',
            requestBody: { kind: 'model', name: 'Thing' },
            response: { kind: 'model', name: 'Thing' },
          }),
        ],
      ),
    );
    expect(directionOf(index, 'Thing')).toBe('both');
  });

  it('treats a model reached through a parameter as request-facing', () => {
    const index = buildDirectionIndex(
      spec(
        [{ name: 'Filter', fields: [] }],
        [op({ queryParams: [{ name: 'filter', type: { kind: 'model', name: 'Filter' }, required: false }] })],
      ),
    );
    expect(directionOf(index, 'Filter')).toBe('request');
  });

  it('follows nested refs transitively through arrays, nullables, maps and unions', () => {
    const models: Model[] = [
      {
        name: 'Page',
        fields: [
          { name: 'data', type: { kind: 'array', items: { kind: 'model', name: 'Thing' } }, required: true },
          { name: 'meta', type: { kind: 'nullable', inner: { kind: 'model', name: 'Meta' } }, required: false },
          { name: 'tags', type: { kind: 'map', valueType: { kind: 'model', name: 'Tag' } }, required: false },
        ],
      },
      {
        name: 'Thing',
        fields: [
          {
            name: 'owner',
            type: {
              kind: 'union',
              variants: [
                { kind: 'model', name: 'Owner' },
                { kind: 'primitive', type: 'string' },
              ],
            },
            required: true,
          },
        ],
      },
      { name: 'Meta', fields: [] },
      { name: 'Tag', fields: [] },
      { name: 'Owner', fields: [] },
    ];
    const index = buildDirectionIndex(spec(models, [op({ response: { kind: 'model', name: 'Page' } })]));
    for (const name of ['Page', 'Thing', 'Meta', 'Tag', 'Owner']) {
      expect(directionOf(index, name)).toBe('response');
    }
  });

  it('reaches discriminated-union variants through the dispatcher mapping', () => {
    const models: Model[] = [
      { name: 'Event', fields: [], discriminator: { property: 'type', mapping: { created: 'CreatedEvent' } } },
      { name: 'CreatedEvent', fields: [] },
    ];
    const index = buildDirectionIndex(spec(models, [op({ response: { kind: 'model', name: 'Event' } })]));
    expect(directionOf(index, 'CreatedEvent')).toBe('response');
  });

  it('reaches models referenced only from error responses', () => {
    const index = buildDirectionIndex(
      spec(
        [{ name: 'ApiError', fields: [] }],
        [op({ errors: [{ statusCode: 404, type: { kind: 'model', name: 'ApiError' } }] })],
      ),
    );
    expect(directionOf(index, 'ApiError')).toBe('response');
  });

  it('leaves unreferenced models unknown', () => {
    const index = buildDirectionIndex(spec([{ name: 'Orphan', fields: [] }], [op({})]));
    expect(directionOf(index, 'Orphan')).toBe('unknown');
  });

  it('keeps request direction for a model that moves request → response across the two specs', () => {
    const models: Model[] = [{ name: 'Thing', fields: [] }];
    const before = spec(models, [op({ httpMethod: 'post', requestBody: { kind: 'model', name: 'Thing' } })]);
    const after = spec(models, [op({ response: { kind: 'model', name: 'Thing' } })]);
    expect(directionOf(buildDirectionIndex(before, after), 'Thing')).toBe('both');
  });

  it('reports unknown for an absent model and for a missing index', () => {
    const index = buildDirectionIndex(spec([], [op({})]));
    expect(directionOf(index, 'Nope')).toBe('unknown');
    expect(directionOf(undefined, 'Nope')).toBe('unknown');
  });

  it('terminates on self-referential models', () => {
    const models: Model[] = [
      { name: 'Node', fields: [{ name: 'parent', type: { kind: 'model', name: 'Node' }, required: false }] },
    ];
    const index = buildDirectionIndex(spec(models, [op({ response: { kind: 'model', name: 'Node' } })]));
    expect(directionOf(index, 'Node')).toBe('response');
  });
});
