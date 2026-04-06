import { describe, expect, it } from 'vitest';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import type { Model, Service } from '../../src/ir/types.js';

describe('collectReferencedNames', () => {
  it('preserves discriminated models even when they are not directly referenced by operations', () => {
    const services: Service[] = [
      {
        name: 'Events',
        operations: [
          {
            name: 'listEvents',
            httpMethod: 'get',
            path: '/events',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'array', items: { kind: 'model', name: 'EventSchema' } },
            errors: [],
            injectIdempotencyKey: false,
            pagination: undefined,
          },
        ],
      },
    ];

    const models: Model[] = [
      {
        name: 'EventSchema',
        fields: [
          { name: 'event', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'data', type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } }, required: true },
        ],
      },
      {
        name: 'SessionCreated',
        fields: [
          { name: 'event', type: { kind: 'literal', value: 'session.created' }, required: true },
          { name: 'data', type: { kind: 'model', name: 'SessionCreatedData' }, required: true },
        ],
      },
      {
        name: 'SessionCreatedData',
        fields: [
          { name: 'object', type: { kind: 'literal', value: 'session' }, required: true },
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    const referenced = collectReferencedNames(services, models);

    expect(referenced.models.has('EventSchema')).toBe(true);
    expect(referenced.models.has('SessionCreated')).toBe(true);
    expect(referenced.models.has('SessionCreatedData')).toBe(true);
  });
});
