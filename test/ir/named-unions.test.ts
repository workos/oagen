import { describe, it, expect } from 'vitest';
import type { Model, Service } from '../../src/ir/types.js';
import {
  collectModelTypeRefs,
  collectFieldDependencies,
  assignModelsToServices,
  renameModelRefs,
} from '../../src/ir/types.js';

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

describe('renameModelRefs', () => {
  const union = (): Model => ({
    name: 'Pet',
    fields: [{ name: 'best_friend', type: { kind: 'array', items: { kind: 'model', name: 'Dog' } }, required: false }],
    variants: [
      { kind: 'model', name: 'Cat' },
      { kind: 'nullable', inner: { kind: 'model', name: 'Dog' } },
    ],
    compositionKind: 'oneOf',
    discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } },
  });

  it('repoints fields, variants and discriminator mapping targets together', () => {
    const model = union();
    renameModelRefs(model, new Map([['Dog', 'Hound']]));
    expect(model.fields[0]!.type).toEqual({ kind: 'array', items: { kind: 'model', name: 'Hound' } });
    expect(model.variants).toEqual([
      { kind: 'model', name: 'Cat' },
      { kind: 'nullable', inner: { kind: 'model', name: 'Hound' } },
    ]);
    expect(model.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Hound' } });
    expect(model.name).toBe('Pet');
  });

  it('looks each reference up once, so chained renames do not cascade', () => {
    const model = union();
    renameModelRefs(
      model,
      new Map([
        ['Cat', 'Dog'],
        ['Dog', 'Hound'],
      ]),
    );
    expect(model.variants).toEqual([
      { kind: 'model', name: 'Dog' },
      { kind: 'nullable', inner: { kind: 'model', name: 'Hound' } },
    ]);
    expect(model.discriminator?.mapping).toEqual({ cat: 'Dog', dog: 'Hound' });
  });

  it('is a no-op for a model without variants or discriminator', () => {
    const plain: Model = { name: 'Cat', fields: [] };
    renameModelRefs(plain, new Map([['Cat', 'Kitten']]));
    expect(plain).toEqual({ name: 'Cat', fields: [] });
  });
});

describe('package exports', () => {
  it('exposes the model traversal helpers and the differ change types', async () => {
    const pkg = await import('../../src/index.js');
    expect(typeof pkg.collectModelTypeRefs).toBe('function');
    expect(typeof pkg.renameModelRefs).toBe('function');
    // `VariantChange` is a type-only export; a value typed with it compiles.
    const change: import('../../src/index.js').VariantChange = {
      kind: 'variant-added',
      variant: 'Cat',
      classification: 'additive',
    };
    expect(change.kind).toBe('variant-added');
  });

  it('exposes the extension types an emitter author imports (issue #352)', async () => {
    const pkg = await import('../../src/index.js');
    expect(typeof pkg.parseSpec).toBe('function');
    // `Extensions`, `ExtensionsChanged` and `ExtensionsNode` are type-only
    // exports; a value typed with each compiles against the package entry.
    const extensions: import('../../src/index.js').Extensions = { 'x-since': '1.2.0', 'x-idempotent': true };
    const node: import('../../src/index.js').ExtensionsNode = { node: 'model', modelName: 'Pet' };
    const change: import('../../src/index.js').ExtensionsChanged = {
      kind: 'extensions-changed',
      ...node,
      newExtensions: extensions,
      classification: 'additive',
    };
    const operation: Pick<import('../../src/index.js').Operation, 'extensions'> = { extensions };
    const model: Pick<import('../../src/index.js').Model, 'extensions'> = { extensions };
    const field: Pick<import('../../src/index.js').Field, 'extensions'> = { extensions };
    const anEnum: Pick<import('../../src/index.js').Enum, 'extensions'> = { extensions };
    expect(change.kind).toBe('extensions-changed');
    expect([operation, model, field, anEnum].every((n) => n.extensions === extensions)).toBe(true);
  });
});
