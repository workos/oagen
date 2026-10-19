import { describe, it, expect } from 'vitest';
import type { Model, Service } from '../../src/ir/types.js';
import { collectModelTypeRefs, collectFieldDependencies, assignModelsToServices } from '../../src/ir/types.js';

const cat: Model = {
  name: 'Cat',
  fields: [{ name: 'kind', type: { kind: 'literal', value: 'cat' }, required: true }],
};
const dog: Model = {
  name: 'Dog',
  fields: [
    { name: 'kind', type: { kind: 'literal', value: 'dog' }, required: true },
    { name: 'mood', type: { kind: 'enum', name: 'Mood' }, required: false },
  ],
};
const pet: Model = {
  name: 'Pet',
  fields: [],
  variants: [
    { kind: 'model', name: 'Cat' },
    { kind: 'nullable', inner: { kind: 'model', name: 'Dog' } },
    { kind: 'enum', name: 'PetValue', values: ['none'] },
  ],
  compositionKind: 'oneOf',
  discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } },
};

describe('collectModelTypeRefs', () => {
  it('yields every field type, then every variant', () => {
    expect(collectModelTypeRefs(dog)).toEqual([dog.fields[0]!.type, dog.fields[1]!.type]);
    expect(collectModelTypeRefs(pet)).toEqual(pet.variants);
  });

  it('yields only the field types for a model without variants', () => {
    expect(collectModelTypeRefs({ name: 'Empty', fields: [] })).toEqual([]);
  });
});

describe('collectFieldDependencies', () => {
  it('counts the models and enums a named union is a union of as dependencies', () => {
    const deps = collectFieldDependencies(pet);
    expect([...deps.models].sort()).toEqual(['Cat', 'Dog']);
    expect([...deps.enums]).toEqual(['PetValue']);
  });

  it('still excludes a self reference', () => {
    const recursive: Model = { name: 'Tree', fields: [], variants: [{ kind: 'model', name: 'Tree' }] };
    expect(collectFieldDependencies(recursive).models.size).toBe(0);
  });
});

describe('assignModelsToServices', () => {
  it("reaches a named union's variants transitively from the operation that references the union", () => {
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
    const assigned = assignModelsToServices([pet, cat, dog], services);
    expect(assigned.get('Pet')).toBe('Pets');
    expect(assigned.get('Cat')).toBe('Pets');
    expect(assigned.get('Dog')).toBe('Pets');
  });
});
