import { describe, expect, it } from 'vitest';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import type { Model, Service } from '../../src/ir/types.js';

const services: Service[] = [
  {
    name: 'Pets',
    operations: [
      {
        name: 'createPet',
        httpMethod: 'post',
        path: '/pets',
        pathParams: [],
        queryParams: [],
        headerParams: [],
        requestBody: { kind: 'model', name: 'Pet' },
        response: { kind: 'primitive', type: 'unknown' },
        errors: [],
        injectIdempotencyKey: false,
      },
    ],
  },
];

const models: Model[] = [
  {
    name: 'Pet',
    fields: [],
    variants: [
      { kind: 'model', name: 'Cat' },
      { kind: 'array', items: { kind: 'model', name: 'Dog' } },
      { kind: 'enum', name: 'Mood' },
    ],
    compositionKind: 'oneOf',
  },
  { name: 'Cat', fields: [{ name: 'toy', type: { kind: 'model', name: 'Toy' }, required: false }] },
  { name: 'Dog', fields: [] },
  { name: 'Toy', fields: [] },
  { name: 'Unrelated', fields: [] },
];

describe('collectReferencedNames — named unions', () => {
  it("reaches a union's variants, and what they reference, from the operation that references the union", () => {
    for (const preserveAllDiscriminated of [true, false]) {
      const referenced = collectReferencedNames(services, models, { preserveAllDiscriminated });
      expect([...referenced.models].sort()).toEqual(['Cat', 'Dog', 'Pet', 'Toy']);
      expect([...referenced.enums]).toEqual(['Mood']);
    }
  });
});
