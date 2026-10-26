import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffModels } from '../../src/differ/models.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { buildDirectionIndex, directionOf } from '../../src/differ/direction.js';
import type { Change, DiffReport, ModelModified } from '../../src/differ/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Field, Model, Operation, TypeRef } from '../../src/ir/types.js';
import { parseSpec } from '../../src/parser/parse.js';

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
        deprecatedChanged: false,
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
        deprecatedChanged: false,
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

/** The `model-modified` change for `name` among `changes`. */
function modifiedModel(changes: Change[], name: string): ModelModified {
  const change = changes.find((c) => c.kind === 'model-modified' && c.name === name);
  if (!change || change.kind !== 'model-modified') throw new Error(`no model-modified change for ${name}`);
  return change;
}

/** `Pet` with `Bird` in its variants and `bird` in its mapping, as the parser builds it from either of the issue's documents. */
const grownPet: Model = {
  ...pet,
  variants: [...pet.variants!, { kind: 'model', name: 'Bird' }],
  discriminator: { property: 'kind', mapping: { ...pet.discriminator!.mapping, bird: 'Bird' } },
};

describe('diffModels — a variant added to a discriminated union (issue #306)', () => {
  it('folds the mapping entry an added variant brings into its variant-added entry, additive', () => {
    expect(diffModels([pet], [grownPet])).toEqual([
      {
        kind: 'model-modified',
        deprecatedChanged: false,
        name: 'Pet',
        fieldChanges: [],
        variantChanges: [
          { kind: 'variant-added', variant: 'Bird', classification: 'additive', details: "mapping added for 'bird'" },
        ],
        classification: 'additive',
      },
    ]);
  });

  it('names every key the added variant brings, sorted, whatever the mapping order', () => {
    const aliased: Model = {
      ...grownPet,
      discriminator: { property: 'kind', mapping: { ...grownPet.discriminator!.mapping, birb: 'Bird' } },
    };
    expect(diffModels([pet], [aliased])[0]).toMatchObject({
      classification: 'additive',
      variantChanges: [{ kind: 'variant-added', variant: 'Bird', details: "mapping added for 'birb', 'bird'" }],
    });
  });

  it('reads a nullable or multi-type variant through its wrapper', () => {
    const nullableBird: Model = {
      ...grownPet,
      variants: [...pet.variants!, { kind: 'nullable', inner: { kind: 'model', name: 'Bird' } }],
    };
    expect(diffModels([pet], [nullableBird])[0]).toMatchObject({
      classification: 'additive',
      variantChanges: [{ kind: 'variant-added', variant: 'nullable<Bird>', details: "mapping added for 'bird'" }],
    });
    const multiTypeBird: Model = {
      ...grownPet,
      variants: [
        ...pet.variants!,
        {
          kind: 'union',
          variants: [
            { kind: 'model', name: 'Bird' },
            { kind: 'primitive', type: 'string' },
          ],
        },
      ],
    };
    expect(diffModels([pet], [multiTypeBird])[0]).toMatchObject({
      classification: 'additive',
      variantChanges: [{ kind: 'variant-added', variant: 'union<Bird|string>', details: "mapping added for 'bird'" }],
    });
  });

  it('decides "new" on the model under every wrapper on both sides, so a wrapped copy of a kept model folds no key', () => {
    const nullableCat: TypeRef = { kind: 'nullable', inner: { kind: 'model', name: 'Cat' } };
    const kitty = { ...pet.discriminator!.mapping, kitty: 'Cat' };
    const anyOfPet: Model = { ...pet, compositionKind: 'anyOf' };
    // Greptile's case: `Cat` kept bare, `nullable<Cat>` added beside it with an alias `kitty: Cat`.
    const wrappedCopy: Model = {
      ...anyOfPet,
      variants: [...pet.variants!, nullableCat],
      discriminator: { property: 'kind', mapping: kitty },
    };
    const overlapped = modifiedModel(diffModels([anyOfPet], [wrappedCopy]), 'Pet');
    expect(overlapped).toMatchObject({
      classification: 'breaking',
      variantChanges: [
        { kind: 'variant-added', variant: 'nullable<Cat>', classification: 'additive' },
        {
          kind: 'discriminator-changed',
          variant: 'kind',
          classification: 'breaking',
          details: "mapping changed for 'kitty'",
        },
      ],
    });
    expect(overlapped.variantChanges![0]).not.toHaveProperty('details');
    // The mirror: the old side wrapped and the new side bare, the alias going with the wrapper.
    const unwrapped = modifiedModel(diffModels([wrappedCopy], [anyOfPet]), 'Pet');
    expect(unwrapped).toMatchObject({
      classification: 'breaking',
      variantChanges: [
        { kind: 'variant-removed', variant: 'nullable<Cat>', classification: 'breaking' },
        {
          kind: 'discriminator-changed',
          variant: 'kind',
          classification: 'breaking',
          details: "mapping changed for 'kitty'",
        },
      ],
    });
    expect(unwrapped.variantChanges![0]).not.toHaveProperty('details');
    // The wrapper swapped for the bare model with a key added for it: the same model on both sides.
    const wrappedOnly: Model = { ...pet, variants: [nullableCat, { kind: 'model', name: 'Dog' }] };
    const aliasedBare: Model = { ...pet, discriminator: { property: 'kind', mapping: kitty } };
    const swapped = modifiedModel(diffModels([wrappedOnly], [aliasedBare]), 'Pet');
    expect(swapped).toMatchObject({
      classification: 'breaking',
      variantChanges: [
        { kind: 'variant-added', variant: 'Cat', classification: 'additive' },
        { kind: 'variant-removed', variant: 'nullable<Cat>', classification: 'breaking' },
        { kind: 'discriminator-changed', classification: 'breaking', details: "mapping changed for 'kitty'" },
      ],
    });
    expect(swapped.variantChanges![0]).not.toHaveProperty('details');
    expect(swapped.variantChanges![1]).not.toHaveProperty('details');
    // A genuine addition inside a new wrapper still folds its key (see above), and so does its removal.
    const nullableBird: Model = {
      ...grownPet,
      variants: [...pet.variants!, { kind: 'nullable', inner: { kind: 'model', name: 'Bird' } }],
    };
    expect(diffModels([nullableBird], [pet])).toEqual([
      {
        kind: 'model-modified',
        deprecatedChanged: false,
        name: 'Pet',
        fieldChanges: [],
        variantChanges: [
          {
            kind: 'variant-removed',
            variant: 'nullable<Bird>',
            classification: 'breaking',
            details: "mapping removed for 'bird'",
          },
        ],
        classification: 'breaking',
      },
    ]);
  });

  it('lists the keys of a multi-type variant once each and sorted, whatever the order of its members', () => {
    const bird: Model = {
      name: 'Pet',
      fields: [],
      variants: [{ kind: 'model', name: 'Bird' }],
      compositionKind: 'oneOf',
      discriminator: { property: 'kind', mapping: { bird: 'Bird' } },
    };
    const members: TypeRef[] = [
      { kind: 'model', name: 'Cat' },
      { kind: 'model', name: 'Dog' },
    ];
    const orders: Array<[string, TypeRef[]]> = [
      ['union<Cat|Dog>', members],
      ['union<Dog|Cat>', [...members].reverse()],
    ];
    for (const [label, variants] of orders) {
      const grown: Model = {
        ...bird,
        variants: [...bird.variants!, { kind: 'union', variants }],
        discriminator: { property: 'kind', mapping: { bird: 'Bird', z: 'Cat', a: 'Dog' } },
      };
      expect(diffModels([bird], [grown])[0]).toMatchObject({
        classification: 'additive',
        variantChanges: [{ kind: 'variant-added', variant: label, details: "mapping added for 'a', 'z'" }],
      });
      expect(diffModels([grown], [bird])[0]).toMatchObject({
        classification: 'breaking',
        variantChanges: [{ kind: 'variant-removed', variant: label, details: "mapping removed for 'a', 'z'" }],
      });
    }
  });

  it('folds the mapping entry a removed variant takes with it into its variant-removed entry, breaking', () => {
    expect(diffModels([grownPet], [pet])).toEqual([
      {
        kind: 'model-modified',
        deprecatedChanged: false,
        name: 'Pet',
        fieldChanges: [],
        variantChanges: [
          {
            kind: 'variant-removed',
            variant: 'Bird',
            classification: 'breaking',
            details: "mapping removed for 'bird'",
          },
        ],
        classification: 'breaking',
      },
    ]);
  });

  it('carries no details when the mapping did not move, nor on an undiscriminated union', () => {
    const { discriminator: _d, ...undiscriminated } = pet;
    const unmapped: Model = { ...grownPet, discriminator: pet.discriminator };
    const grownUndiscriminated: Model = { ...undiscriminated, variants: grownPet.variants };
    for (const [before, after] of [
      [pet, unmapped],
      [undiscriminated, grownUndiscriminated],
    ]) {
      const change = modifiedModel(diffModels([before], [after]), 'Pet');
      expect(change).toMatchObject({
        classification: 'additive',
        variantChanges: [{ kind: 'variant-added', variant: 'Bird', classification: 'additive' }],
      });
      expect(change.variantChanges![0]).not.toHaveProperty('details');
    }
    // Same for the removal.
    const shrunk = modifiedModel(diffModels([grownUndiscriminated], [undiscriminated]), 'Pet');
    expect(shrunk).toMatchObject({
      classification: 'breaking',
      variantChanges: [{ kind: 'variant-removed', variant: 'Bird', classification: 'breaking' }],
    });
    expect(shrunk.variantChanges![0]).not.toHaveProperty('details');
  });

  it('keeps a mapping change for an existing variant breaking beside the addition', () => {
    const retargeted: Model = {
      ...grownPet,
      discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Hound', bird: 'Bird' } },
    };
    expect(diffModels([pet], [retargeted])).toEqual([
      {
        kind: 'model-modified',
        deprecatedChanged: false,
        name: 'Pet',
        fieldChanges: [],
        variantChanges: [
          { kind: 'variant-added', variant: 'Bird', classification: 'additive', details: "mapping added for 'bird'" },
          {
            kind: 'discriminator-changed',
            variant: 'kind',
            classification: 'breaking',
            details: "mapping changed for 'dog'",
          },
        ],
        classification: 'breaking',
      },
    ]);
  });

  it('reports a key added for a variant the old union already had, or for none, or removed while its variant stays, as breaking', () => {
    const breaking = (details: string) => ({
      classification: 'breaking',
      variantChanges: [{ kind: 'discriminator-changed', variant: 'kind', classification: 'breaking', details }],
    });
    // An alias for an existing variant.
    const alias: Model = {
      ...pet,
      discriminator: { property: 'kind', mapping: { ...pet.discriminator!.mapping, kitty: 'Cat' } },
    };
    expect(diffModels([pet], [alias])[0]).toMatchObject(breaking("mapping changed for 'kitty'"));
    expect(diffModels([alias], [pet])[0]).toMatchObject(breaking("mapping changed for 'kitty'"));
    // A key for a model that is not a variant on either side.
    const stray: Model = {
      ...pet,
      discriminator: { property: 'kind', mapping: { ...pet.discriminator!.mapping, bird: 'Bird' } },
    };
    expect(diffModels([pet], [stray])[0]).toMatchObject(breaking("mapping changed for 'bird'"));
    expect(diffModels([stray], [pet])[0]).toMatchObject(breaking("mapping changed for 'bird'"));
    // A key removed while `Dog` stays a variant.
    const unmappedDog: Model = { ...pet, discriminator: { property: 'kind', mapping: { cat: 'Cat' } } };
    expect(diffModels([pet], [unmappedDog])[0]).toMatchObject(breaking("mapping changed for 'dog'"));
    // A variant added beside the stray key: the addition folds its own key only.
    const grownBesideStray: Model = {
      ...grownPet,
      discriminator: { property: 'kind', mapping: { ...grownPet.discriminator!.mapping, fish: 'Fish' } },
    };
    expect(diffModels([pet], [grownBesideStray])[0]).toMatchObject({
      classification: 'breaking',
      variantChanges: [
        { kind: 'variant-added', variant: 'Bird', classification: 'additive', details: "mapping added for 'bird'" },
        { kind: 'discriminator-changed', classification: 'breaking', details: "mapping changed for 'fish'" },
      ],
    });
  });

  it('reads an allOf+oneOf dispatcher, whose mapping alone names its variants, the same way', () => {
    const event: Model = {
      name: 'Event',
      fields: [],
      discriminator: { property: 'event', mapping: { 'pet.created': 'PetCreated', 'pet.deleted': 'PetDeleted' } },
    };
    const grownEvent: Model = {
      ...event,
      discriminator: { property: 'event', mapping: { ...event.discriminator!.mapping, 'pet.updated': 'PetUpdated' } },
    };
    expect(diffModels([event], [grownEvent])).toEqual([
      {
        kind: 'model-modified',
        deprecatedChanged: false,
        name: 'Event',
        fieldChanges: [],
        variantChanges: [
          {
            kind: 'variant-added',
            variant: 'PetUpdated',
            classification: 'additive',
            details: "mapping added for 'pet.updated'",
          },
        ],
        classification: 'additive',
      },
    ]);
    expect(diffModels([grownEvent], [event])[0]).toMatchObject({
      classification: 'breaking',
      variantChanges: [
        {
          kind: 'variant-removed',
          variant: 'PetUpdated',
          classification: 'breaking',
          details: "mapping removed for 'pet.updated'",
        },
      ],
    });
    // A key retargeted swaps a variant and changes dispatch for an existing payload.
    const retargeted: Model = {
      ...event,
      discriminator: { property: 'event', mapping: { 'pet.created': 'PetCreated', 'pet.deleted': 'PetRemoved' } },
    };
    const swapped = modifiedModel(diffModels([event], [retargeted]), 'Event');
    expect(swapped).toMatchObject({
      classification: 'breaking',
      variantChanges: [
        { kind: 'variant-added', variant: 'PetRemoved', classification: 'additive' },
        { kind: 'variant-removed', variant: 'PetDeleted', classification: 'breaking' },
        {
          kind: 'discriminator-changed',
          variant: 'event',
          classification: 'breaking',
          details: "mapping changed for 'pet.deleted'",
        },
      ],
    });
    expect(swapped.variantChanges![0]).not.toHaveProperty('details');
    expect(swapped.variantChanges![1]).not.toHaveProperty('details');
    // Two keys for one target are one variant; identical dispatchers report nothing.
    const twoKeys: Model = {
      ...event,
      discriminator: { property: 'event', mapping: { ...event.discriminator!.mapping, 'pet.updated': 'PetCreated' } },
    };
    expect(diffModels([event], [twoKeys])[0]).toMatchObject({
      classification: 'breaking',
      variantChanges: [{ kind: 'discriminator-changed', details: "mapping changed for 'pet.updated'" }],
    });
    expect(diffModels([event], [event])).toEqual([]);
    expect(diffModels([grownEvent], [grownEvent])).toEqual([]);
  });

  it('is additive from either side of the wire; a required field is judged by direction on its own', () => {
    const kind = (value: string): Field => ({ name: 'kind', type: { kind: 'literal', value }, required: true });
    const cat: Model = { name: 'Cat', fields: [kind('cat')] };
    const dog: Model = { name: 'Dog', fields: [kind('dog')] };
    const bird: Model = { name: 'Bird', fields: [kind('bird')] };
    const name: Field = { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true };
    const namedCat: Model = { ...cat, fields: [...cat.fields, name] };
    for (const side of ['request', 'response'] as const) {
      const seed =
        side === 'request'
          ? op({ requestBody: { kind: 'model', name: 'Pet' } })
          : op({ response: { kind: 'model', name: 'Pet' } });
      const oldSpec = spec([pet, cat, dog], [seed]);
      const newSpec = spec([grownPet, namedCat, dog, bird], [seed]);
      const directions = buildDirectionIndex(oldSpec, newSpec);
      expect(directionOf(directions, 'Pet')).toBe(side);
      expect(directionOf(directions, 'Cat')).toBe(side);
      const changes = diffModels(oldSpec.models, newSpec.models, directions);
      expect(changes).toContainEqual({ kind: 'model-added', name: 'Bird', classification: 'additive' });
      expect(modifiedModel(changes, 'Pet')).toMatchObject({
        classification: 'additive',
        variantChanges: [
          { kind: 'variant-added', variant: 'Bird', classification: 'additive', details: "mapping added for 'bird'" },
        ],
      });
      // The required field `Cat` gains is the one breaking change, and only when callers send it.
      const classification = side === 'request' ? 'breaking' : 'additive';
      expect(modifiedModel(changes, 'Cat')).toMatchObject({
        classification,
        fieldChanges: [{ kind: 'field-added', fieldName: 'name', classification }],
      });
      expect(changes.filter((c) => c.classification === 'breaking').map((c) => c.kind)).toEqual(
        side === 'request' ? ['model-modified'] : [],
      );
    }
  });
});

describe('diffSpecs — a variant added to a discriminated union, end to end (issue #306)', () => {
  const ref = (name: string) => `#/components/schemas/${name}`;
  const variant = (kind: string) => ({
    type: 'object',
    required: ['kind'],
    properties: { kind: { type: 'string', const: kind } },
  });
  /**
   * The issue's documents: `Pet` is a `oneOf` over `$ref` variants
   * discriminated on `kind`, with or without a written `mapping`, and `Bird`,
   * `Cat` and `Dog` are components on both sides. `GET /pets` returns it;
   * `POST /pets` takes it when `side` is `request`.
   */
  const petsDocument = (
    variants: string[],
    mapping?: Record<string, string>,
    side: 'request' | 'response' = 'response',
  ) => ({
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1.0.0' },
    paths: {
      '/pets':
        side === 'response'
          ? {
              get: {
                operationId: 'getPet',
                responses: {
                  '200': { description: 'ok', content: { 'application/json': { schema: { $ref: ref('Pet') } } } },
                },
              },
            }
          : {
              post: {
                operationId: 'createPet',
                requestBody: { required: true, content: { 'application/json': { schema: { $ref: ref('Pet') } } } },
                responses: { '204': { description: 'created' } },
              },
            },
    },
    components: {
      schemas: {
        Pet: {
          oneOf: variants.map((name) => ({ $ref: ref(name) })),
          discriminator: { propertyName: 'kind', ...(mapping ? { mapping } : {}) },
        },
        Bird: variant('bird'),
        Cat: variant('cat'),
        Dog: variant('dog'),
      },
    },
  });

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oagen-306-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  async function parse(name: string, document: object): Promise<ApiSpec> {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(document));
    return parseSpec(file);
  }
  const summarize = (report: DiffReport) => ({
    changes: report.changes.map((c) => `${'name' in c ? c.name : c.kind}: ${c.classification}`),
    variantChanges: report.changes.flatMap((c) =>
      c.kind === 'model-modified'
        ? (c.variantChanges ?? []).map((v) => `${v.kind} ${v.details ?? v.variant}: ${v.classification}`)
        : [],
    ),
    summary: report.summary,
  });

  it.each([
    ['implicit', undefined, undefined],
    ['explicit', { cat: ref('Cat'), dog: ref('Dog') }, { cat: ref('Cat'), dog: ref('Dog'), bird: ref('Bird') }],
  ] as const)(
    "%s mapping: the issue's repro is additive, and its reverse breaking",
    async (pair, oldMapping, newMapping) => {
      const oldSpec = await parse(`${pair}-old`, petsDocument(['Cat', 'Dog'], oldMapping));
      const newSpec = await parse(`${pair}-new`, petsDocument(['Cat', 'Dog', 'Bird'], newMapping));
      expect(newSpec.models.find((m) => m.name === 'Pet')?.discriminator?.mapping).toEqual({
        cat: 'Cat',
        dog: 'Dog',
        bird: 'Bird',
      });
      expect(summarize(diffSpecs(oldSpec, newSpec))).toEqual({
        changes: ['Pet: additive'],
        variantChanges: ["variant-added mapping added for 'bird': additive"],
        summary: { added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 0 },
      });
      expect(summarize(diffSpecs(newSpec, oldSpec))).toEqual({
        changes: ['Pet: breaking'],
        variantChanges: ["variant-removed mapping removed for 'bird': breaking"],
        summary: { added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 0 },
      });
      expect(diffSpecs(newSpec, newSpec).changes).toEqual([]);
    },
  );

  it('is additive for a union the SDK sends as well', async () => {
    const oldSpec = await parse('request-old', petsDocument(['Cat', 'Dog'], undefined, 'request'));
    const newSpec = await parse('request-new', petsDocument(['Cat', 'Dog', 'Bird'], undefined, 'request'));
    expect(directionOf(buildDirectionIndex(oldSpec, newSpec), 'Pet')).toBe('request');
    expect(summarize(diffSpecs(oldSpec, newSpec))).toEqual({
      changes: ['Pet: additive'],
      variantChanges: ["variant-added mapping added for 'bird': additive"],
      summary: { added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 0 },
    });
  });

  it('keeps a mapping entry retargeted beside the addition breaking', async () => {
    const oldSpec = await parse('retarget-old', petsDocument(['Cat', 'Dog'], { cat: ref('Cat'), dog: ref('Dog') }));
    const newSpec = await parse(
      'retarget-new',
      petsDocument(['Cat', 'Dog', 'Bird'], { cat: ref('Cat'), dog: ref('Bird'), bird: ref('Bird') }),
    );
    expect(summarize(diffSpecs(oldSpec, newSpec))).toEqual({
      changes: ['Pet: breaking'],
      variantChanges: [
        "variant-added mapping added for 'bird': additive",
        "discriminator-changed mapping changed for 'dog': breaking",
      ],
      summary: { added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 0 },
    });
  });

  it('is additive for an allOf+oneOf dispatcher that gains an inline variant', async () => {
    const inlineVariant = (event: string) => ({
      type: 'object',
      required: ['event', 'data'],
      properties: {
        event: { type: 'string', const: event },
        data: { type: 'object', properties: { id: { type: 'string' } } },
      },
    });
    const eventsDocument = (events: string[]) => ({
      openapi: '3.1.0',
      info: { title: 'Events', version: '1.0.0' },
      paths: {
        '/events': {
          get: {
            operationId: 'getEvent',
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema: { $ref: ref('Event') } } } },
            },
          },
        },
      },
      components: {
        schemas: {
          Event: {
            allOf: [
              {
                type: 'object',
                properties: { id: { type: 'string' }, event: { type: 'string' } },
                required: ['id', 'event'],
              },
              { oneOf: events.map(inlineVariant) },
            ],
          },
        },
      },
    });
    const oldSpec = await parse('events-old', eventsDocument(['pet.created', 'pet.deleted']));
    const newSpec = await parse('events-new', eventsDocument(['pet.created', 'pet.deleted', 'pet.updated']));
    const event = newSpec.models.find((m) => m.name === 'Event');
    expect(event).not.toHaveProperty('variants');
    expect(event?.discriminator).toEqual({
      property: 'event',
      mapping: { 'pet.created': 'PetCreated', 'pet.deleted': 'PetDeleted', 'pet.updated': 'PetUpdated' },
    });
    expect(summarize(diffSpecs(oldSpec, newSpec))).toEqual({
      changes: ['PetUpdated: additive', 'PetUpdatedData: additive', 'Event: additive'],
      variantChanges: ["variant-added mapping added for 'pet.updated': additive"],
      summary: { added: 2, removed: 0, modified: 1, breaking: 0, additive: 3, behaviorChanges: 0 },
    });
    expect(summarize(diffSpecs(newSpec, oldSpec))).toMatchObject({
      changes: ['PetUpdated: breaking', 'PetUpdatedData: breaking', 'Event: breaking'],
      variantChanges: ["variant-removed mapping removed for 'pet.updated': breaking"],
    });
  });
});
