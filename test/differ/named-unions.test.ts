import { describe, it, expect } from 'vitest';
import { diffModels } from '../../src/differ/models.js';
import { buildDirectionIndex, directionOf } from '../../src/differ/direction.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Model, Operation } from '../../src/ir/types.js';

const pet: Model = {
  name: 'Pet',
  fields: [],
  variants: [
    { kind: 'model', name: 'Cat' },
    { kind: 'model', name: 'Dog' },
  ],
  compositionKind: 'oneOf',
  discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } },
};

describe('diffModels — named unions', () => {
  it('reports nothing for identical unions, or for reordered variants', () => {
    expect(diffModels([pet], [pet])).toEqual([]);
    const reordered: Model = { ...pet, variants: [...pet.variants!].reverse() };
    expect(diffModels([pet], [reordered])).toEqual([]);
  });

  it('reports an added variant as additive', () => {
    const grown: Model = {
      ...pet,
      variants: [...pet.variants!, { kind: 'model', name: 'Bird' }],
    };
    const changes = diffModels([pet], [grown]);
    expect(changes).toEqual([
      {
        kind: 'model-modified',
        name: 'Pet',
        fieldChanges: [],
        variantChanges: [{ kind: 'variant-added', variant: 'Bird', classification: 'additive' }],
        classification: 'additive',
      },
    ]);
  });

  it('reports a removed variant as breaking', () => {
    const shrunk: Model = { ...pet, variants: [{ kind: 'model', name: 'Cat' }] };
    const changes = diffModels([pet], [shrunk]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'model-modified',
      classification: 'breaking',
      variantChanges: [{ kind: 'variant-removed', variant: 'Dog', classification: 'breaking' }],
    });
  });

  it('labels non-model variants readably', () => {
    const before: Model = { name: 'Id', fields: [], variants: [{ kind: 'primitive', type: 'string' }] };
    const after: Model = {
      name: 'Id',
      fields: [],
      variants: [
        { kind: 'primitive', type: 'string', format: 'uuid' },
        { kind: 'nullable', inner: { kind: 'array', items: { kind: 'model', name: 'Cat' } } },
        { kind: 'literal', value: 7 },
      ],
    };
    const changes = diffModels([before], [after]);
    expect(changes[0]).toMatchObject({
      variantChanges: [
        { kind: 'variant-added', variant: 'string:uuid' },
        { kind: 'variant-added', variant: 'nullable<array<Cat>>' },
        { kind: 'variant-added', variant: 'literal:7' },
        { kind: 'variant-removed', variant: 'string' },
      ],
    });
  });

  it('reports a discriminator property change, mapping change, addition and removal as breaking', () => {
    const property: Model = { ...pet, discriminator: { property: 'type', mapping: pet.discriminator!.mapping } };
    expect(diffModels([pet], [property])[0]).toMatchObject({
      classification: 'breaking',
      variantChanges: [
        { kind: 'discriminator-changed', variant: 'type', details: "property changed from 'kind' to 'type'" },
      ],
    });

    const mapping: Model = { ...pet, discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Hound' } } };
    expect(diffModels([pet], [mapping])[0]).toMatchObject({
      classification: 'breaking',
      variantChanges: [{ kind: 'discriminator-changed', variant: 'kind', details: "mapping changed for 'dog'" }],
    });

    const { discriminator: _dropped, ...undiscriminated } = pet;
    expect(diffModels([pet], [undiscriminated])[0]).toMatchObject({
      variantChanges: [{ kind: 'discriminator-changed', variant: 'kind', details: 'discriminator removed' }],
    });
    expect(diffModels([undiscriminated], [pet])[0]).toMatchObject({
      variantChanges: [{ kind: 'discriminator-changed', variant: 'kind', details: 'discriminator added' }],
    });
  });

  it('reports a model that becomes a union as every variant added, without a variantChanges key otherwise', () => {
    const plain: Model = { name: 'Pet', fields: [] };
    const { discriminator: _d, ...union } = pet;
    const changes = diffModels([plain], [union]);
    expect(changes[0]).toMatchObject({
      classification: 'additive',
      variantChanges: [
        { kind: 'variant-added', variant: 'Cat' },
        { kind: 'variant-added', variant: 'Dog' },
      ],
    });
    // A field-only change carries no variantChanges key at all.
    const renamed: Model = {
      name: 'Pet',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: false }],
    };
    expect(diffModels([plain], [renamed])[0]).not.toHaveProperty('variantChanges');
  });

  it('reports a change of composition keyword between two unions as breaking', () => {
    const { discriminator: _d, ...oneOf } = pet;
    const anyOf: Model = { ...oneOf, compositionKind: 'anyOf' };
    expect(diffModels([anyOf], [oneOf])).toEqual([
      {
        kind: 'model-modified',
        name: 'Pet',
        fieldChanges: [],
        variantChanges: [
          {
            kind: 'composition-changed',
            variant: 'oneOf',
            classification: 'breaking',
            details: "composition changed from 'anyOf' to 'oneOf'",
          },
        ],
        classification: 'breaking',
      },
    ]);
    // Becoming a union is reported through its variants, not as a composition change.
    const plain: Model = { name: 'Pet', fields: [] };
    const gained = diffModels([plain], [oneOf])[0];
    expect(gained?.kind === 'model-modified' && gained.variantChanges?.map((c) => c.kind)).toEqual([
      'variant-added',
      'variant-added',
    ]);
  });

  it('compares mapping entries by own key, so an inherited name is not read off the prototype', () => {
    const withProto: Model = {
      ...pet,
      discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog', constructor: 'ConstructorPet' } },
    };
    expect(diffModels([pet], [withProto])[0]).toMatchObject({
      variantChanges: [{ kind: 'discriminator-changed', details: "mapping changed for 'constructor'" }],
    });
    expect(diffModels([withProto], [withProto])).toEqual([]);
  });
});

const op = (over: Partial<Operation>): Operation => ({
  name: 'get',
  httpMethod: 'get',
  path: '/pets',
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
  services: [{ name: 'Pets', operations }],
  models,
  enums: [],
  sdk: defaultSdkBehavior(),
});

describe('buildDirectionIndex — named unions', () => {
  it('gives a variant the direction of the union it belongs to', () => {
    const { discriminator: _d, ...undiscriminated } = pet;
    const cat: Model = { name: 'Cat', fields: [] };
    const dog: Model = { name: 'Dog', fields: [] };
    const index = buildDirectionIndex(
      spec([undiscriminated, cat, dog], [op({ requestBody: { kind: 'model', name: 'Pet' } })]),
    );
    expect(directionOf(index, 'Pet')).toBe('request');
    expect(directionOf(index, 'Cat')).toBe('request');
    expect(directionOf(index, 'Dog')).toBe('request');
  });
});
