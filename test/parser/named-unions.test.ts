import { describe, it, expect, vi } from 'vitest';
import { parseSpec, type ParseOptions } from '../../src/parser/parse.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';
import { collectModelRefs } from '../../src/ir/types.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Write a spec to a temp file, parse it, return the IR. Cleans up the temp
 * dir on completion.
 */
async function parseInline(specYaml: string, options?: ParseOptions): Promise<ApiSpec> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-named-unions-'));
  const specFile = path.join(tmpDir, 'spec.yml');
  try {
    await fs.writeFile(specFile, specYaml, 'utf-8');
    return await parseSpec(specFile, options);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
}

const model = (ir: ApiSpec, name: string): Model => {
  const found = ir.models.find((m) => m.name === name);
  if (!found) throw new Error(`model ${name} not in [${ir.models.map((m) => m.name).join(', ')}]`);
  return found;
};

const modelRef = (name: string): TypeRef => ({ kind: 'model', name });

/** Every model ref reachable from a model's fields, variants and discriminator mapping must name a model or enum. */
function unresolvedRefs(ir: ApiSpec): string[] {
  const known = new Set([...ir.models.map((m) => m.name), ...ir.enums.map((e) => e.name)]);
  const unresolved: string[] = [];
  for (const m of ir.models) {
    for (const f of m.fields) for (const n of collectModelRefs(f.type)) if (!known.has(n)) unresolved.push(n);
    for (const v of m.variants ?? []) for (const n of collectModelRefs(v)) if (!known.has(n)) unresolved.push(n);
    for (const n of Object.values(m.discriminator?.mapping ?? {})) if (!known.has(n)) unresolved.push(n);
  }
  for (const s of ir.services) {
    for (const op of s.operations) {
      if (op.requestBody) for (const n of collectModelRefs(op.requestBody)) if (!known.has(n)) unresolved.push(n);
      for (const n of collectModelRefs(op.response)) if (!known.has(n)) unresolved.push(n);
    }
  }
  return unresolved;
}

const header = `
openapi: 3.1.0
info: { title: Test, version: 1.0.0 }
paths:
  /pets:
    post:
      operationId: createPet
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Pet' }
      responses:
        '204': { description: Created }
`;

const animals = `
    Cat:
      type: object
      properties:
        kind: { const: cat }
        livesLeft: { type: integer }
      required: [kind, livesLeft]
    Dog:
      type: object
      properties:
        kind: { const: dog }
        goodBoy: { type: boolean }
      required: [kind, goodBoy]
`;

describe('named unions: a component schema that is a oneOf/anyOf keeps its variants', () => {
  it('keeps the variants and the explicit discriminator of a oneOf of $refs (issue #220)', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
      discriminator:
        propertyName: kind
        mapping:
          cat: '#/components/schemas/Cat'
          dog: '#/components/schemas/Dog'
${animals}`);

    expect(model(ir, 'Pet')).toEqual({
      name: 'Pet',
      description: undefined,
      fields: [],
      variants: [modelRef('Cat'), modelRef('Dog')],
      compositionKind: 'oneOf',
      discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } },
    });
    // The reference to the union is unchanged: the model carries the union.
    expect(ir.services[0]?.operations[0]?.requestBody).toEqual(modelRef('Pet'));
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('types the same union identically whether named or inline', async () => {
    const ir = await parseInline(`
openapi: 3.1.0
info: { title: Test, version: 1.0.0 }
paths:
  /pets:
    post:
      operationId: createPet
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - $ref: '#/components/schemas/Cat'
                - $ref: '#/components/schemas/Dog'
              discriminator:
                propertyName: kind
                mapping:
                  cat: '#/components/schemas/Cat'
                  dog: '#/components/schemas/Dog'
      responses:
        '204': { description: Created }
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
      discriminator:
        propertyName: kind
        mapping:
          cat: '#/components/schemas/Cat'
          dog: '#/components/schemas/Dog'
${animals}`);

    const body = ir.services[0]?.operations[0]?.requestBody;
    expect(body?.kind).toBe('union');
    if (body?.kind !== 'union') return;
    const pet = model(ir, 'Pet');
    expect(pet.variants).toEqual(body.variants);
    expect(pet.compositionKind).toBe('oneOf');
    expect(pet.discriminator?.property).toBe(body.discriminator?.property);
    expect(Object.keys(pet.discriminator?.mapping ?? {})).toEqual(Object.keys(body.discriminator?.mapping ?? {}));
  });

  it('normalizes explicit mapping targets to IR model names, schemaNameTransform included', async () => {
    const ir = await parseInline(
      `${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/CatDto'
        - $ref: '#/components/schemas/DogDto'
      discriminator:
        propertyName: kind
        mapping:
          cat: '#/components/schemas/CatDto'
          dog: DogDto
    CatDto:
      type: object
      properties:
        kind: { const: cat }
    DogDto:
      type: object
      properties:
        kind: { const: dog }
`,
      { schemaNameTransform: (name) => name.replace(/Dto$/, '') },
    );

    expect(model(ir, 'Pet').variants).toEqual([modelRef('Cat'), modelRef('Dog')]);
    expect(model(ir, 'Pet').discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } });
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('derives the mapping of a discriminator without one from the const each $ref variant pins', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
      discriminator:
        propertyName: kind
${animals}`);

    expect(model(ir, 'Pet').discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } });
  });

  it('reads a $ref variant const through its allOf wrappers, like an allOf+oneOf variant', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
      discriminator:
        propertyName: kind
    Base:
      type: object
      properties:
        id: { type: string }
    Cat:
      allOf:
        - $ref: '#/components/schemas/Base'
        - type: object
          properties:
            kind: { const: cat }
    Dog:
      allOf:
        - $ref: '#/components/schemas/Base'
        - type: object
          properties:
            kind: { type: string, enum: [dog] }
`);

    expect(model(ir, 'Pet').discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } });
  });

  it('leaves the mapping empty when a variant pins no const on the property, as an inline union does', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Fish'
      discriminator:
        propertyName: kind
    Cat:
      type: object
      properties:
        kind: { const: cat }
    Fish:
      type: object
      properties:
        kind: { type: string }
`);

    expect(model(ir, 'Pet').discriminator).toEqual({ property: 'kind', mapping: {} });
    expect(model(ir, 'Pet').variants).toEqual([modelRef('Cat'), modelRef('Fish')]);
  });

  it('keeps a mapping entry that points outside the variant list as the spec wrote it', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
      discriminator:
        propertyName: kind
        mapping:
          cat: '#/components/schemas/Cat'
          dog: '#/components/schemas/Dog'
          bird: '#/components/schemas/Bird'
    Bird:
      type: object
      properties:
        kind: { const: bird }
${animals}`);

    const pet = model(ir, 'Pet');
    expect(pet.variants).toEqual([modelRef('Cat'), modelRef('Dog')]);
    expect(pet.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog', bird: 'Bird' } });
  });

  it('discriminates a oneOf of $refs implicitly when every component pins the same const property', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
${animals}`);

    expect(model(ir, 'Pet').discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } });
  });

  it('does not discriminate implicitly when two variants pin the same value or one pins none', async () => {
    const same = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
    Cat:
      type: object
      properties:
        kind: { const: pet }
    Dog:
      type: object
      properties:
        kind: { const: pet }
`);
    expect(model(same, 'Pet').discriminator).toBeUndefined();
    expect(model(same, 'Pet').variants).toEqual([modelRef('Cat'), modelRef('Dog')]);

    const none = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - type: string
${animals}`);
    expect(model(none, 'Pet').discriminator).toBeUndefined();
    expect(model(none, 'Pet').variants).toEqual([modelRef('Cat'), { kind: 'primitive', type: 'string' }]);
  });

  it('drops a type: null variant and keeps the rest, as an inline union lifts null into a wrapper', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
        - type: 'null'
${animals}`);

    const pet = model(ir, 'Pet');
    expect(pet.variants).toEqual([modelRef('Cat'), modelRef('Dog')]);
    expect(pet.compositionKind).toBe('oneOf');
  });

  it.each([
    [
      'a type: null variant',
      "      oneOf:\n        - $ref: '#/components/schemas/Cat'\n        - $ref: '#/components/schemas/Dog'\n        - type: 'null'",
    ],
    [
      'an OAS 3.0 nullable: true',
      "      nullable: true\n      oneOf:\n        - $ref: '#/components/schemas/Cat'\n        - $ref: '#/components/schemas/Dog'",
    ],
    [
      'a type list with null',
      "      type: [object, 'null']\n      oneOf:\n        - $ref: '#/components/schemas/Cat'\n        - $ref: '#/components/schemas/Dog'",
    ],
  ])(
    'carries %s on every $ref to the union as nullable(model), like the inline form (MichaelDeBoey)',
    async (_, petSchema) => {
      const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
${petSchema}
    Owner:
      type: object
      properties:
        pet: { $ref: '#/components/schemas/Pet' }
        inline:
          oneOf:
            - $ref: '#/components/schemas/Cat'
            - $ref: '#/components/schemas/Dog'
            - type: 'null'
${animals}`);

      const pet = model(ir, 'Pet');
      expect(pet.variants).toEqual([modelRef('Cat'), modelRef('Dog')]);
      const owner = model(ir, 'Owner');
      expect(owner.fields.find((f) => f.name === 'pet')?.type).toEqual({ kind: 'nullable', inner: modelRef('Pet') });
      expect(owner.fields.find((f) => f.name === 'inline')?.type.kind).toBe('nullable');
      // The request body is a `$ref` to Pet as well.
      expect(ir.services[0].operations[0].requestBody).toEqual({ kind: 'nullable', inner: modelRef('Pet') });
      expect(unresolvedRefs(ir)).toEqual([]);
    },
  );

  it('keeps an anyOf as an open union and never discriminates it implicitly', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      anyOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
${animals}`);

    const pet = model(ir, 'Pet');
    expect(pet.variants).toEqual([modelRef('Cat'), modelRef('Dog')]);
    expect(pet.compositionKind).toBe('anyOf');
    expect(pet.discriminator).toBeUndefined();
  });

  it('references another named union as a variant, and both resolve', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Mammal'
        - $ref: '#/components/schemas/Bird'
    Mammal:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
    Bird:
      type: object
      properties:
        kind: { const: bird }
${animals}`);

    expect(model(ir, 'Pet').variants).toEqual([modelRef('Mammal'), modelRef('Bird')]);
    expect(model(ir, 'Mammal').variants).toEqual([modelRef('Cat'), modelRef('Dog')]);
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('keeps a primitive variant as a primitive', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - type: string
        - $ref: '#/components/schemas/Cat'
${animals}`);

    expect(model(ir, 'Pet').variants).toEqual([{ kind: 'primitive', type: 'string' }, modelRef('Cat')]);
  });

  it('extracts an inline object variant as its own model, named off the union with the inline rules', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - type: object
          properties:
            kind: { const: cat }
            livesLeft: { type: integer }
            home:
              type: object
              properties:
                city: { type: string }
          required: [kind, livesLeft]
        - type: object
          properties:
            kind: { const: dog }
            goodBoy: { type: boolean }
          required: [kind]
      discriminator:
        propertyName: kind
`);

    const pet = model(ir, 'Pet');
    // Variant 0 steps off the base name (the union's own model holds it)
    // exactly as a later variant does: by its const prefix.
    expect(pet.variants).toEqual([modelRef('CatPet'), modelRef('DogPet')]);
    expect(pet.discriminator).toEqual({ property: 'kind', mapping: { cat: 'CatPet', dog: 'DogPet' } });
    // Today's merged optional fields are kept beside the variants.
    expect(pet.fields.map((f) => [f.name, f.required])).toEqual([
      ['kind', false],
      ['livesLeft', false],
      ['home', false],
      ['goodBoy', false],
    ]);
    // Each variant is a complete model of its own, nested objects included.
    expect(model(ir, 'CatPet').fields.map((f) => [f.name, f.required, f.type])).toEqual([
      ['kind', true, { kind: 'literal', value: 'cat' }],
      ['livesLeft', true, { kind: 'primitive', type: 'integer' }],
      ['home', false, modelRef('CatPetHome')],
    ]);
    expect(model(ir, 'CatPetHome').fields.map((f) => f.name)).toEqual(['city']);
    expect(model(ir, 'DogPet').fields.map((f) => f.name)).toEqual(['kind', 'goodBoy']);
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('names const-less inline variants by a distinguishing property, and keeps the merged fields intact', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - type: object
          properties:
            role_slug: { type: string }
          required: [role_slug]
        - type: object
          properties:
            role_slugs:
              type: array
              items: { type: string }
          required: [role_slugs]
`);

    const pet = model(ir, 'Pet');
    expect(pet.variants).toEqual([modelRef('PetWithRoleSlug'), modelRef('PetWithRoleSlugs')]);
    expect(pet.compositionKind).toBe('oneOf');
    expect(pet.discriminator).toBeUndefined();
    // The UpdateOrganizationMembership-style merge is unchanged: both fields, optional.
    expect(pet.fields.map((f) => [f.name, f.required])).toEqual([
      ['role_slug', false],
      ['role_slugs', false],
    ]);
    expect(model(ir, 'PetWithRoleSlug').fields.map((f) => [f.name, f.required])).toEqual([['role_slug', true]]);
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('never lets an inline variant shadow a component: a variant titled like one takes a qualified name', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - title: Cat
          type: object
          properties:
            kind: { const: cat }
            whiskers: { type: integer }
        - title: Dog
          type: object
          properties:
            kind: { const: dog }
            goodBoy: { type: boolean }
    Cat:
      type: object
      properties:
        name: { type: string }
`);

    const pet = model(ir, 'Pet');
    expect(pet.variants).toEqual([modelRef('CatPet'), modelRef('Dog')]);
    expect(pet.discriminator).toEqual({ property: 'kind', mapping: { cat: 'CatPet', dog: 'Dog' } });
    expect(model(ir, 'Cat').fields.map((f) => f.name)).toEqual(['name']);
    expect(model(ir, 'CatPet').fields.map((f) => f.name)).toEqual(['kind', 'whiskers']);
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('types an inline enum variant and an array variant under the union, and materializes what is inline', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - type: string
          enum: [happy, sad]
        - type: array
          items:
            type: object
            properties:
              tag: { type: string }
${animals}`);

    // Each non-object variant is typed as `variant_<n>` (its 1-based position
    // among the non-null variants) of a synthetic object under the union, so
    // what it mints is `PetVariant<n>…` and never shared with another variant.
    expect(model(ir, 'Pet').variants).toEqual([
      modelRef('Cat'),
      { kind: 'enum', name: 'PetVariant2', values: ['happy', 'sad'] },
      { kind: 'array', items: modelRef('PetVariant3') },
    ]);
    expect(ir.enums.find((e) => e.name === 'PetVariant2')?.values.map((v) => v.value)).toEqual(['happy', 'sad']);
    expect(model(ir, 'PetVariant3').fields.map((f) => f.name)).toEqual(['tag']);
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it("keeps today's object model for a oneOf written beside properties", async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      type: object
      properties:
        name: { type: string }
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
${animals}`);

    const pet = model(ir, 'Pet');
    expect(pet.fields.map((f) => f.name)).toEqual(['name']);
    expect(pet.variants).toBeUndefined();
    expect(pet.compositionKind).toBeUndefined();
    expect(pet.discriminator).toBeUndefined();
  });

  it('keeps a nullable wrapper around one inline object as that object, and makes a wrapper around one $ref a union of one', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - type: object
          properties:
            a: { type: string }
          required: [a]
        - type: 'null'
    MaybeCat:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - type: 'null'
${animals}`);

    const pet = model(ir, 'Pet');
    expect(pet.fields.map((f) => f.name)).toEqual(['a']);
    expect(pet.variants).toBeUndefined();
    expect(ir.models.some((m) => m.name.startsWith('Pet') && m.name !== 'Pet')).toBe(false);

    expect(model(ir, 'MaybeCat').variants).toEqual([modelRef('Cat')]);
    expect(model(ir, 'MaybeCat').compositionKind).toBe('oneOf');
  });

  it('leaves allOf models, plain objects and enums alone', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      allOf:
        - $ref: '#/components/schemas/Cat'
        - type: object
          properties:
            extra: { type: string }
    Mood:
      type: string
      enum: [happy, sad]
${animals}`);

    for (const m of ir.models) {
      expect(m.variants).toBeUndefined();
      expect(m.compositionKind).toBeUndefined();
    }
    expect(model(ir, 'Pet').fields.map((f) => f.name)).toEqual(['kind', 'livesLeft', 'extra']);
  });

  it('warns about an unresolved variant through validateModelRefs like an unresolved field type', async () => {
    const { validateModelRefs } = await import('../../src/parser/normalize-model-refs.js');
    const { defaultSdkBehavior } = await import('../../src/ir/sdk-behavior.js');
    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [],
      models: [
        { name: 'Cat', fields: [] },
        { name: 'Pet', fields: [], variants: [modelRef('Cat'), modelRef('Ghost')], compositionKind: 'oneOf' },
      ],
      sdk: defaultSdkBehavior(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      validateModelRefs(spec);
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages).toEqual(['[oagen] Warning: Unresolved model reference "Ghost" (context: Pet.variants)']);
    } finally {
      warn.mockRestore();
    }
  });

  it('assigns a model reached only as a variant to the service that references the union', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
${animals}`);
    const { assignModelsToServices } = await import('../../src/ir/types.js');
    const assigned = assignModelsToServices(ir.models, ir.services);
    expect(assigned.get('Pet')).toBe(ir.services[0]?.name);
    expect(assigned.get('Cat')).toBe(ir.services[0]?.name);
    expect(assigned.get('Dog')).toBe(ir.services[0]?.name);
  });
});

describe('named unions: every variant is typed and extracted under its own context', () => {
  it('gives two array variants with different item shapes their own item models', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - type: array
          items:
            type: object
            properties:
              a: { type: string }
        - type: array
          items:
            type: object
            properties:
              b: { type: integer }
`);

    expect(model(ir, 'Pet').variants).toEqual([
      { kind: 'array', items: modelRef('PetVariant1') },
      { kind: 'array', items: modelRef('PetVariant2') },
    ]);
    expect(model(ir, 'PetVariant1').fields.map((f) => f.name)).toEqual(['a']);
    expect(model(ir, 'PetVariant2').fields.map((f) => f.name)).toEqual(['b']);
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('gives two inline enum variants their own enums, keeping both value lists', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - type: string
          enum: [happy, sad]
        - type: string
          enum: [hot, cold]
`);

    expect(model(ir, 'Pet').variants).toEqual([
      { kind: 'enum', name: 'PetVariant1', values: ['happy', 'sad'] },
      { kind: 'enum', name: 'PetVariant2', values: ['hot', 'cold'] },
    ]);
    const values = (name: string) => ir.enums.find((e) => e.name === name)?.values.map((v) => v.value);
    expect(values('PetVariant1')).toEqual(['happy', 'sad']);
    expect(values('PetVariant2')).toEqual(['hot', 'cold']);
  });

  it('materializes every object shape nested under a variant: untyped objects, map values, allOf, nested unions', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - type: object
          properties:
            kind: { const: cat }
            config:
              properties:
                city: { type: string }
        - type: object
          properties:
            kind: { const: dog }
            home:
              type: object
              additionalProperties:
                properties:
                  street: { type: string }
        - allOf:
            - properties:
                x: { type: string }
            - properties:
                y: { type: string }
        - oneOf:
            - type: object
              properties:
                p: { type: string }
            - type: object
              properties:
                q: { type: string }
`);

    const pet = model(ir, 'Pet');
    expect(pet.variants).toEqual([
      modelRef('CatPet'),
      modelRef('DogPet'),
      modelRef('PetVariant3'),
      { kind: 'union', variants: [modelRef('PetVariant4'), modelRef('PetVariant4WithQ')], compositionKind: 'oneOf' },
    ]);
    // An untyped nested object (no `type: object`) is extracted under the variant.
    expect(model(ir, 'CatPet').fields.find((f) => f.name === 'config')?.type).toEqual(modelRef('CatPetConfig'));
    expect(model(ir, 'CatPetConfig').fields.map((f) => f.name)).toEqual(['city']);
    expect(model(ir, 'DogPet').fields.find((f) => f.name === 'home')?.type).toEqual({
      kind: 'map',
      valueType: modelRef('DogPetHome'),
    });
    expect(model(ir, 'DogPetHome').fields.map((f) => f.name)).toEqual(['street']);
    expect(model(ir, 'PetVariant3').fields.map((f) => f.name)).toEqual(['x', 'y']);
    expect(model(ir, 'PetVariant4').fields.map((f) => f.name)).toEqual(['p']);
    expect(model(ir, 'PetVariant4WithQ').fields.map((f) => f.name)).toEqual(['q']);
    // Everything a variant references resolves (the merged fields' own
    // nested refs are the pre-existing merged-field path, checked apart).
    const known = new Set([...ir.models.map((m) => m.name), ...ir.enums.map((e) => e.name)]);
    for (const v of pet.variants ?? []) for (const n of collectModelRefs(v)) expect(known.has(n)).toBe(true);
    for (const name of ['CatPet', 'DogPet', 'PetVariant3', 'PetVariant4', 'PetVariant4WithQ']) {
      for (const f of model(ir, name).fields) for (const n of collectModelRefs(f.type)) expect(known.has(n)).toBe(true);
    }
  });

  it('keeps the other type of a single multi-type object variant as a union of one', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - type: [object, string]
          properties:
            a: { type: string }
`);

    const pet = model(ir, 'Pet');
    expect(pet.variants).toEqual([
      { kind: 'union', variants: [modelRef('PetWithA'), { kind: 'primitive', type: 'string' }] },
    ]);
    expect(pet.compositionKind).toBe('oneOf');
    expect(model(ir, 'PetWithA').fields.map((f) => f.name)).toEqual(['a']);
  });
});

describe('named unions: titled variants across unions', () => {
  const shape = `
    Shape:
      oneOf:
        - title: Circle
          type: object
          properties:
            kind: { const: circle }
            radius: { type: number }
        - title: Square
          type: object
          properties:
            kind: { const: square }
            side: { type: number }
`;
  const marker = `
    Marker:
      oneOf:
        - title: Circle
          type: object
          properties:
            kind: { const: circle }
            diameter: { type: number }
        - title: Cross
          type: object
          properties:
            kind: { const: cross }
            arm: { type: number }
`;
  const twin = `
    Twin:
      oneOf:
        - title: Square
          type: object
          properties:
            kind: { const: square }
            side: { type: number }
        - title: Dot
          type: object
          properties:
            kind: { const: dot }
`;
  const unions = (...components: string[]) => `${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Shape'
        - $ref: '#/components/schemas/Marker'
        - $ref: '#/components/schemas/Twin'
${components.join('')}`;

  it('qualifies a title two unions give different shapes, symmetrically, and lets identical shapes share one model', async () => {
    const ir = await parseInline(unions(shape, marker, twin));

    // `Circle` is { radius } on Shape and { diameter } on Marker: neither keeps it.
    expect(model(ir, 'Shape').variants).toEqual([modelRef('CircleShape'), modelRef('Square')]);
    expect(model(ir, 'Marker').variants).toEqual([modelRef('CircleMarker'), modelRef('Cross')]);
    expect(model(ir, 'Shape').discriminator).toEqual({
      property: 'kind',
      mapping: { circle: 'CircleShape', square: 'Square' },
    });
    expect(model(ir, 'Marker').discriminator).toEqual({
      property: 'kind',
      mapping: { circle: 'CircleMarker', cross: 'Cross' },
    });
    expect(model(ir, 'CircleShape').fields.map((f) => f.name)).toEqual(['kind', 'radius']);
    expect(model(ir, 'CircleMarker').fields.map((f) => f.name)).toEqual(['kind', 'diameter']);
    expect(ir.models.some((m) => m.name === 'Circle')).toBe(false);
    // `Square` is the same shape on Shape and Twin: one model, shared.
    expect(model(ir, 'Twin').variants).toEqual([modelRef('Square'), modelRef('Dot')]);
    expect(ir.models.filter((m) => m.name === 'Square')).toHaveLength(1);
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('does not depend on the order the unions are declared in', async () => {
    for (const order of [
      [twin, marker, shape],
      [marker, shape, twin],
    ]) {
      const ir = await parseInline(unions(...order));
      expect(model(ir, 'Shape').variants).toEqual([modelRef('CircleShape'), modelRef('Square')]);
      expect(model(ir, 'Marker').variants).toEqual([modelRef('CircleMarker'), modelRef('Cross')]);
      expect(model(ir, 'Twin').variants).toEqual([modelRef('Square'), modelRef('Dot')]);
      expect(ir.models.filter((m) => m.name === 'Square')).toHaveLength(1);
    }
  });
});

describe('named unions: discriminator derivation', () => {
  it('maps values spelled like inherited properties', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - type: object
          properties:
            kind: { const: constructor }
            a: { type: string }
        - type: object
          properties:
            kind: { const: toString }
            b: { type: string }
      discriminator:
        propertyName: kind
`);

    const pet = model(ir, 'Pet');
    expect(pet.discriminator).toEqual({
      property: 'kind',
      mapping: { constructor: 'ConstructorPet', toString: 'ToStringPet' },
    });
    expect(Object.hasOwn(pet.discriminator!.mapping, 'constructor')).toBe(true);
    expect(pet.variants).toEqual([modelRef('ConstructorPet'), modelRef('ToStringPet')]);
  });

  it('passes over a constant every variant shares to find the property that tells them apart', async () => {
    const ir = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - $ref: '#/components/schemas/Dog'
    Cat:
      type: object
      properties:
        version: { const: v1 }
        kind: { const: cat }
    Dog:
      type: object
      properties:
        version: { const: v1 }
        kind: { const: dog }
`);

    expect(model(ir, 'Pet').discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } });
  });
});

describe('named unions: renames and folds', () => {
  it('carries variants and discriminator onto the base when a Json-suffixed union folds into it', async () => {
    const ir = await parseInline(`
openapi: 3.1.0
info: { title: Test, version: 1.0.0 }
paths:
  /foos:
    post:
      operationId: createFoo
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/FooJson' }
      responses:
        '204': { description: Created }
components:
  schemas:
    Foo:
      type: object
    FooJson:
      oneOf:
        - type: object
          properties:
            kind: { const: a }
            a: { type: string }
          required: [kind]
        - type: object
          properties:
            kind: { const: b }
            b: { type: string }
          required: [kind]
      discriminator:
        propertyName: kind
`);

    expect(ir.models.some((m) => m.name === 'FooJson')).toBe(false);
    const foo = model(ir, 'Foo');
    expect(foo.fields.map((f) => f.name)).toEqual(['kind', 'a', 'b']);
    expect(foo.variants).toEqual([modelRef('AFooJson'), modelRef('BFooJson')]);
    expect(foo.compositionKind).toBe('oneOf');
    expect(foo.discriminator).toEqual({ property: 'kind', mapping: { a: 'AFooJson', b: 'BFooJson' } });
    expect(ir.services[0]?.operations[0]?.requestBody).toEqual(modelRef('Foo'));
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('never replaces a named union component with a same-named inline response model on field count', async () => {
    const { mergeInlineResponseModels } = await import('../../src/parser/normalize-inline-models.js');
    const union: Model = { name: 'Pet', fields: [], variants: [modelRef('Cat')], compositionKind: 'oneOf' };
    const inline: Model = {
      name: 'Pet',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const merged = mergeInlineResponseModels([union], [inline]);
      expect(merged).toEqual([union]);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        '[oagen] Warning: Inline model "Pet" has different fields than the named union component — using component schema',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to fold a Json-suffixed model onto a base whose union rules it does not preserve', async () => {
    const { collapseJsonSuffixModels } = await import('../../src/parser/normalize-inline-models.js');
    // An allOf+oneOf dispatcher: no fields of its own, but a mapping.
    const dispatcher: Model = {
      name: 'Foo',
      fields: [],
      discriminator: { property: 'type', mapping: { a: 'FooA', b: 'FooB' } },
    };
    const plainJson: Model = {
      name: 'FooJson',
      fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const kept = collapseJsonSuffixModels([dispatcher, plainJson], []);
      expect(kept.map((m) => m.name)).toEqual(['Foo', 'FooJson']);
      expect(kept[0]?.discriminator).toEqual({ property: 'type', mapping: { a: 'FooA', b: 'FooB' } });
      expect(kept[0]?.fields).toEqual([]);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        '[oagen] Warning: Json-suffix model "FooJson" does not preserve the union rules of "Foo" — keeping both',
      ]);

      // Different rules on a Json union are refused the same way.
      warn.mockClear();
      const otherRules: Model = {
        ...plainJson,
        variants: [modelRef('FooA')],
        compositionKind: 'oneOf',
        discriminator: { property: 'kind', mapping: { a: 'FooA' } },
      };
      expect(collapseJsonSuffixModels([dispatcher, otherRules], []).map((m) => m.name)).toEqual(['Foo', 'FooJson']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to fold when two undiscriminated unions dispatch to different members (MichaelDeBoey)', async () => {
    const { collapseJsonSuffixModels } = await import('../../src/parser/normalize-inline-models.js');
    // `Pet: oneOf [$ref Cat, $ref Dog]` beside `PetJson: oneOf [{ name }, { tag }]`: the rules
    // agree (`oneOf`, no discriminator) and a union of refs has no merged fields, so only
    // the variants tell them apart.
    const pet: Model = {
      name: 'Pet',
      fields: [],
      variants: [modelRef('Cat'), modelRef('Dog')],
      compositionKind: 'oneOf',
    };
    const petJson: Model = {
      name: 'PetJson',
      fields: [
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'tag', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
      variants: [modelRef('PetJsonWithName'), modelRef('PetJsonWithTag')],
      compositionKind: 'oneOf',
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const kept = collapseJsonSuffixModels([pet, petJson], []);
      expect(kept.map((m) => m.name)).toEqual(['Pet', 'PetJson']);
      expect(kept[0]?.variants).toEqual([modelRef('Cat'), modelRef('Dog')]);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        '[oagen] Warning: Json-suffix model "PetJson" does not preserve the union rules of "Pet" — keeping both',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("still folds a Json-suffixed union whose variants are the base's under the Json name", async () => {
    const { collapseJsonSuffixModels } = await import('../../src/parser/normalize-inline-models.js');
    // Pass 3 renames `PetJsonWithName` → `PetWithName`, so the variants are compared under the base's name.
    const pet: Model = {
      name: 'Pet',
      fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: false }],
      variants: [modelRef('PetWithName'), modelRef('PetWithTag')],
      compositionKind: 'oneOf',
    };
    const petJson: Model = {
      name: 'PetJson',
      fields: [
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'tag', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
      variants: [modelRef('PetJsonWithName'), modelRef('PetJsonWithTag')],
      compositionKind: 'oneOf',
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const kept = collapseJsonSuffixModels([pet, petJson], []);
      expect(kept.map((m) => m.name)).toEqual(['Pet']);
      expect(kept[0]?.variants).toEqual([modelRef('PetJsonWithName'), modelRef('PetJsonWithTag')]);
    } finally {
      warn.mockRestore();
    }
  });

  it('still folds a Json-suffixed union onto a base union with identical rules, carrying the shape', async () => {
    const { collapseJsonSuffixModels } = await import('../../src/parser/normalize-inline-models.js');
    const rules = { property: 'kind', mapping: { a: 'A', b: 'B' } };
    const base: Model = {
      name: 'Foo',
      fields: [{ name: 'a', type: { kind: 'primitive', type: 'string' }, required: false }],
      variants: [modelRef('A'), modelRef('B')],
      compositionKind: 'oneOf',
      discriminator: rules,
    };
    const json: Model = {
      name: 'FooJson',
      fields: [
        { name: 'a', type: { kind: 'primitive', type: 'string' }, required: false },
        { name: 'b', type: { kind: 'primitive', type: 'string' }, required: false },
      ],
      variants: [modelRef('A'), modelRef('B')],
      compositionKind: 'oneOf',
      discriminator: { ...rules },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const folded = collapseJsonSuffixModels([base, json], []);
      expect(folded.map((m) => m.name)).toEqual(['Foo']);
      expect(folded[0]?.fields.map((f) => f.name)).toEqual(['a', 'b']);
      expect(folded[0]?.variants).toEqual([modelRef('A'), modelRef('B')]);
      expect(folded[0]?.discriminator).toEqual(rules);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps an allOf+oneOf dispatcher with no fields when a plain Json-suffixed component appears beside it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseInline(`
openapi: 3.1.0
info: { title: Test, version: 1.0.0 }
paths:
  /foos:
    post:
      operationId: createFoo
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/FooJson' }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Foo' }
components:
  schemas:
    Foo:
      allOf:
        - oneOf:
            - type: object
              properties:
                type: { const: a }
                a: { type: string }
            - type: object
              properties:
                type: { const: b }
                b: { type: string }
    FooJson:
      type: object
      properties:
        id: { type: string }
`);
      const foo = model(ir, 'Foo');
      expect(foo.fields).toEqual([]);
      expect(foo.discriminator).toEqual({ property: 'type', mapping: { a: 'FooA', b: 'FooB' } });
      expect(model(ir, 'FooJson').fields.map((f) => f.name)).toEqual(['id']);
      expect(ir.services[0]?.operations[0]?.requestBody).toEqual(modelRef('FooJson'));
      expect(ir.services[0]?.operations[0]?.response).toEqual(modelRef('Foo'));
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        '[oagen] Warning: Json-suffix model "FooJson" does not preserve the union rules of "Foo" — keeping both',
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('named unions: variant contexts step around claimed names', () => {
  const union = (first: string) => `${header}
components:
  schemas:
    Pet:
      oneOf:
${first}
        - $ref: '#/components/schemas/Cat'
${animals}`;

  it('steps an array variant off a component that already owns its item name, keeping the component intact', async () => {
    const ir = await parseInline(`${union(`
        - type: array
          items:
            type: object
            properties:
              a: { type: string }`)}
    PetVariant1:
      type: object
      properties:
        a: { type: string }
        b: { type: string }
        c: { type: string }
`);

    expect(model(ir, 'Pet').variants).toEqual([{ kind: 'array', items: modelRef('PetVariant1Item') }, modelRef('Cat')]);
    expect(model(ir, 'PetVariant1Item').fields.map((f) => f.name)).toEqual(['a']);
    expect(model(ir, 'PetVariant1').fields.map((f) => f.name)).toEqual(['a', 'b', 'c']);
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it('shares a component of the identical shape instead of stepping', async () => {
    const ir = await parseInline(`${union(`
        - type: array
          items:
            type: object
            properties:
              a: { type: string }`)}
    PetVariant1:
      type: object
      description: The same shape, documented.
      properties:
        a: { type: string }
`);

    expect(model(ir, 'Pet').variants).toEqual([{ kind: 'array', items: modelRef('PetVariant1') }, modelRef('Cat')]);
    expect(ir.models.filter((m) => m.name === 'PetVariant1')).toHaveLength(1);
    expect(model(ir, 'PetVariant1').fields.map((f) => f.name)).toEqual(['a']);
    expect(ir.models.some((m) => m.name === 'PetVariant1Item')).toBe(false);
  });

  it('moves every name nested under a stepped variant with it', async () => {
    const ir = await parseInline(`${union(`
        - type: array
          items:
            type: object
            properties:
              a: { type: string }
              child:
                properties:
                  x: { type: string }
              tags:
                type: array
                items:
                  type: object
                  properties:
                    t: { type: string }`)}
    PetVariant1:
      type: string
`);

    expect(model(ir, 'Pet').variants).toEqual([{ kind: 'array', items: modelRef('PetVariant1Item') }, modelRef('Cat')]);
    const item = model(ir, 'PetVariant1Item');
    // Nested names derive from the chosen context (`PetVariant1Item…`), not
    // from the base it stepped off (`PetVariant1…`).
    expect(item.fields.map((f) => [f.name, f.type])).toEqual([
      ['a', { kind: 'primitive', type: 'string' }],
      ['child', modelRef('PetVariant1ItemChild')],
      ['tags', { kind: 'array', items: modelRef('PetVariant1ItemTags') }],
    ]);
    expect(model(ir, 'PetVariant1ItemChild').fields.map((f) => f.name)).toEqual(['x']);
    expect(model(ir, 'PetVariant1ItemTags').fields.map((f) => f.name)).toEqual(['t']);
    // Nothing lands under the base the variant stepped off; only the component owns it.
    const underBase = ir.models.filter(
      (m) => m.name.startsWith('PetVariant1') && !m.name.startsWith('PetVariant1Item'),
    );
    expect(underBase.map((m) => m.name)).toEqual(['PetVariant1']);
    expect(unresolvedRefs(ir)).toEqual([]);
  });

  it("steps an inline enum variant off a component enum with other values, and off another union's variant", async () => {
    const ir = await parseInline(`${union(`
        - type: string
          enum: [happy, sad]`)}
    PetVariant1:
      type: string
      enum: [hot, cold]
    Other:
      oneOf:
        - title: PetVariant2
          type: object
          properties:
            kind: { const: x }
            v: { type: string }
        - title: Spare
          type: object
          properties:
            kind: { const: y }
            w: { type: string }
`);

    expect(model(ir, 'Pet').variants).toEqual([
      { kind: 'enum', name: 'PetVariant1Value', values: ['happy', 'sad'] },
      modelRef('Cat'),
    ]);
    const values = (name: string) => ir.enums.find((e) => e.name === name)?.values.map((v) => v.value);
    expect(values('PetVariant1')).toEqual(['hot', 'cold']);
    expect(values('PetVariant1Value')).toEqual(['happy', 'sad']);

    // A second union's titled variant `PetVariant2` claims that name too.
    const stepped = await parseInline(`${header}
components:
  schemas:
    Pet:
      oneOf:
        - $ref: '#/components/schemas/Cat'
        - type: string
          enum: [happy, sad]
    Other:
      oneOf:
        - title: PetVariant2
          type: object
          properties:
            kind: { const: x }
            v: { type: string }
        - title: Spare
          type: object
          properties:
            kind: { const: y }
            w: { type: string }
${animals}`);
    expect(model(stepped, 'Pet').variants).toEqual([
      modelRef('Cat'),
      { kind: 'enum', name: 'PetVariant2Value', values: ['happy', 'sad'] },
    ]);
    expect(model(stepped, 'Other').variants).toEqual([modelRef('PetVariant2'), modelRef('Spare')]);
    expect(unresolvedRefs(stepped)).toEqual([]);
  });
});
