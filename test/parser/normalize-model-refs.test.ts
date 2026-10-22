import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec } from '../../src/ir/types.js';

describe('validateModelRefs — pagination', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    warn.mockClear();
  });

  it('reports an iterator item type that names no model, under its own context', () => {
    // Under `x-pagination: { dataPath }` the body stays a wrapper, so the
    // item type is reached from nothing but `pagination.itemType`.
    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [
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
              response: { kind: 'model', name: 'Wrapper' },
              errors: [],
              injectIdempotencyKey: false,
              pagination: {
                strategy: 'page',
                param: 'page',
                dataPath: 'records',
                itemType: { kind: 'array', items: { kind: 'model', name: 'Ghost' } },
              },
            },
          ],
        },
      ],
      models: [{ name: 'Wrapper', fields: [] }],
      enums: [],
      sdk: defaultSdkBehavior(),
    };
    validateModelRefs(spec);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      '[oagen] Warning: Unresolved model reference "Ghost" (context: Pets.listPets.pagination.itemType)',
    ]);
  });
});
