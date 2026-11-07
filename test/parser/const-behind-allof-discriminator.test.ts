import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #607: a union derived no discriminator mapping when a variant's
 * `kind` was written as an `allOf` of its const — `kind: { allOf: [{ const:
 * 'cat' }] }`, `kind: { allOf: [{ $ref: HamsterKind }], description }`, or a
 * `$ref` to an alias written `{ allOf: [{ $ref: RabbitConst }] }` — although
 * the model's `kind` field is the same literal it is for `kind: { const:
 * 'cat' }`. `pinnedDeclarationValue` followed a bare `$ref` chain only and
 * read what it landed on as written. A pinned value is now read as the type
 * builder reads the declaration, at every hop: a `$ref` to its component, a
 * nullable wrapper to its one variant, an `allOf` read as one member to that
 * member, then the `const` or one-value `enum:` written there.
 */

type Doc = Record<string, unknown>;

const ref = (name: string): Doc => ({ $ref: `#/components/schemas/${name}` });

/** `{ const: value }`, or the OAS 3.0 spelling `{ type: 'string', enum: [value] }`. */
const constOf = (openapi: string, value: string): Doc =>
  openapi === '3.0.3' ? { type: 'string', enum: [value] } : { const: value };

/** An object requiring `kind`, declared as `kind`, with `extra` properties beside it. */
const object = (kind: Doc, extra: Record<string, Doc> = {}): Doc => ({
  type: 'object',
  required: ['kind'],
  properties: { kind, ...extra },
});

/** A `oneOf` of `variants`, under `discriminator: { propertyName: 'kind' }` when `keyword` is set. */
const union = (variants: Doc[], keyword: boolean): Doc => ({
  oneOf: variants,
  ...(keyword ? { discriminator: { propertyName: 'kind' } } : {}),
});

/** A document whose two operations return `Owner` and `Pet` from `schemas`. */
function doc(openapi: string, schemas: Record<string, Doc>, paths?: Doc): Doc {
  const get = (name: string): Doc => ({
    get: {
      operationId: `get${name}`,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref(name) } } } },
    },
  });
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: paths ?? { '/owners/{id}': get('Owner'), '/pets/{id}': get('Pet') },
    components: { schemas },
  };
}

/**
 * The issue's `repro.json`: `Cat`, `Hamster` and `Rabbit` each write `kind`
 * behind an `allOf` (of the const, of a `$ref` beside a `description`, and
 * through an alias written as an `allOf` of a `$ref`), `Dog` writes the
 * const, `Owner` holds the four unions and `Pet` is the component union. With
 * `spelled: 'const'` every `kind` is written as `Dog`'s — the issue's
 * `old.json`.
 */
function issueRepro(openapi: string, keyword: boolean, spelled: 'allOf' | 'const' = 'allOf'): Doc {
  const c = (value: string): Doc => constOf(openapi, value);
  const kinds =
    spelled === 'const'
      ? { cat: c('cat'), hamster: c('hamster'), rabbit: c('rabbit'), inline: c('cat') }
      : {
          cat: { allOf: [c('cat')] },
          hamster: { allOf: [ref('HamsterKind')], description: 'The kind of pet.' },
          rabbit: ref('RabbitKind'),
          inline: { allOf: [c('cat')] },
        };
  return doc(openapi, {
    Cat: object(kinds.cat),
    Dog: object(c('dog')),
    Hamster: object(kinds.hamster),
    HamsterKind: c('hamster'),
    Rabbit: object(kinds.rabbit),
    RabbitKind: { allOf: [ref('RabbitConst')] },
    RabbitConst: c('rabbit'),
    Owner: {
      type: 'object',
      properties: {
        cat: union([ref('Cat'), ref('Dog')], keyword),
        hamster: union([ref('Hamster'), ref('Dog')], keyword),
        rabbit: union([ref('Rabbit'), ref('Dog')], keyword),
        inline: union(
          [{ type: 'object', properties: { kind: kinds.inline, lives: { type: 'integer' } } }, ref('Dog')],
          keyword,
        ),
      },
    },
    Pet: union([ref('Cat'), ref('Dog')], keyword),
  });
}

/** `Owner.cat: oneOf [$ref Cat, $ref Dog]` and the component `Pet` of the same union, with `Cat.kind` written as `catKind` and `Dog.kind` as the const, plus `extra` components. */
function catAndDog(openapi: string, keyword: boolean, catKind: Doc, extra: Record<string, Doc> = {}): Doc {
  return doc(openapi, {
    Cat: object(catKind),
    Dog: object(constOf(openapi, 'dog')),
    ...extra,
    Owner: { type: 'object', properties: { cat: union([ref('Cat'), ref('Dog')], keyword) } },
    Pet: union([ref('Cat'), ref('Dog')], keyword),
  });
}

type UnionRef = Extract<TypeRef, { kind: 'union' }>;

describe('#607', () => {
  let tmpDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-607-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(document: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, `spec-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(specFile, JSON.stringify(document), 'utf-8');
    return parseSpec(specFile);
  }

  const model = (spec: ApiSpec, name: string): Model => {
    const found = spec.models.find((m) => m.name === name);
    expect(found, name).toBeDefined();
    return found!;
  };
  const fieldType = (spec: ApiSpec, modelName: string, field: string): TypeRef => {
    const found = model(spec, modelName).fields.find((f) => f.name === field);
    expect(found, `${modelName}.${field}`).toBeDefined();
    return found!.type;
  };
  const unionAt = (spec: ApiSpec, field: string): UnionRef => {
    const type = fieldType(spec, 'Owner', field);
    expect(type.kind, `Owner.${field}`).toBe('union');
    return type as UnionRef;
  };
  /** `Owner.<field>`'s variants and mapping, as the issue prints them. */
  const describeUnion = (spec: ApiSpec, field: string): string => {
    const { variants, discriminator } = unionAt(spec, field);
    const names = variants.map((v) => (v.kind === 'model' ? v.name : v.kind)).join(' | ');
    return `${field}: ${names} ${JSON.stringify(discriminator?.mapping)}`;
  };
  const petUnion = (spec: ApiSpec): string => {
    const pet = model(spec, 'Pet');
    const names = (pet.variants ?? []).map((v) => (v.kind === 'model' ? v.name : v.kind)).join(' | ');
    return `Pet: ${names} ${JSON.stringify(pet.discriminator?.mapping)}`;
  };

  /** `oagen diff` between two parsed documents, one line per change, and the exit code the CLI would give. */
  function diffOf(before: ApiSpec, after: ApiSpec): { changes: string[]; exit: number } {
    const changes = diffSpecs(before, after).changes.map((change) => {
      const { classification, kind, name, operationName } = change as typeof change & {
        name?: string;
        operationName?: string;
      };
      return `${classification} ${kind} ${name ?? operationName}`;
    });
    const exit = changes.some((change) => change.startsWith('breaking')) ? 2 : changes.length > 0 ? 1 : 0;
    return { changes, exit };
  }

  const expectedOwner = [
    'cat: Cat | Dog {"cat":"Cat","dog":"Dog"}',
    'hamster: Hamster | Dog {"hamster":"Hamster","dog":"Dog"}',
    'rabbit: Rabbit | Dog {"rabbit":"Rabbit","dog":"Dog"}',
    'inline: OwnerInline | Dog {"cat":"OwnerInline","dog":"Dog"}',
  ];

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    const c = (value: string): Doc => constOf(openapi, value);

    describe.each([true, false])('with the discriminator keyword: %s', (keyword) => {
      it("the issue's repro: each Owner union and the component Pet carry the mapping old.json gives", async () => {
        const spec = await parseJson(issueRepro(openapi, keyword));
        const old = await parseJson(issueRepro(openapi, keyword, 'const'));

        const fields = ['cat', 'hamster', 'rabbit', 'inline'];
        expect(fields.map((field) => describeUnion(spec, field))).toEqual(expectedOwner);
        expect(petUnion(spec)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        // Exactly what every `kind` written `{ const }` gives.
        for (const field of fields)
          expect(unionAt(spec, field).discriminator).toEqual(unionAt(old, field).discriminator);
        expect(model(spec, 'Pet').discriminator).toEqual(model(old, 'Pet').discriminator);
        for (const field of fields) expect(unionAt(spec, field).discriminator?.property).toBe('kind');
        expect(warn).not.toHaveBeenCalled();
      });

      it("the models' kind fields are the literals each spelling pins", async () => {
        const spec = await parseJson(issueRepro(openapi, keyword));
        expect(fieldType(spec, 'Cat', 'kind')).toEqual({ kind: 'literal', value: 'cat' });
        expect(fieldType(spec, 'Dog', 'kind')).toEqual({ kind: 'literal', value: 'dog' });
        expect(fieldType(spec, 'OwnerInline', 'kind')).toEqual({ kind: 'literal', value: 'cat' });
        if (openapi === '3.1.0') {
          expect(fieldType(spec, 'Hamster', 'kind')).toEqual({ kind: 'literal', value: 'hamster' });
          expect(fieldType(spec, 'Rabbit', 'kind')).toEqual({ kind: 'literal', value: 'rabbit' });
        } else {
          // In OAS 3.0 a one-value `enum:` component is an enum component,
          // and `RabbitKind` an alias of one: the field names the enum, as
          // it did before, and the pin is read through it all the same.
          expect(fieldType(spec, 'Hamster', 'kind')).toEqual({ kind: 'enum', name: 'HamsterKind' });
          expect(fieldType(spec, 'Rabbit', 'kind')).toEqual({ kind: 'enum', name: 'RabbitConst' });
          expect(spec.enums.map(({ name }) => name)).toEqual(['HamsterKind', 'RabbitConst']);
        }
      });

      it('a const beside members and wrapper keys that only annotate or limit it pins', async () => {
        const annotated = {
          allOf: [
            c('cat'),
            { description: 'The kind of pet.' },
            { title: 'Kind' },
            { deprecated: true },
            { readOnly: true },
            { writeOnly: false },
            { default: 'cat' },
            { example: 'cat' },
            { examples: ['cat'] },
            { minLength: 1, maxLength: 3, pattern: '^c' },
            { 'x-note': 'annotated' },
          ],
          description: 'Own text.',
          title: 'Own title',
          default: 'cat',
          example: 'cat',
          deprecated: false,
          ...(openapi === '3.0.3' ? { nullable: true } : {}),
        };
        const spec = await parseJson(catAndDog(openapi, keyword, annotated));
        expect(describeUnion(spec, 'cat')).toBe('cat: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        expect(petUnion(spec)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        // The literal the field carries, the wrapper's limits riding on it.
        expect(fieldType(spec, 'Cat', 'kind')).toEqual({
          kind: 'literal',
          value: 'cat',
          constraints: { minLength: 1, maxLength: 3, pattern: '^c' },
        });
      });

      it('a $ref member beside annotating members pins what the component pins, under a nullable flag too', async () => {
        const catKind = {
          allOf: [ref('CatKind'), { description: 'The kind of pet.' }, { deprecated: true }, { 'x-note': 1 }],
          title: 'Kind',
          ...(openapi === '3.0.3' ? { nullable: true } : {}),
        };
        const spec = await parseJson(catAndDog(openapi, keyword, catKind, { CatKind: c('cat') }));
        expect(describeUnion(spec, 'cat')).toBe('cat: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        expect(petUnion(spec)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
      });

      it('an alias chain mixing every shape — $ref, allOf of a $ref, a nullable wrapper — pins at every hop', async () => {
        const spec = await parseJson(
          catAndDog(openapi, keyword, ref('Kind1'), {
            Kind1: { allOf: [ref('Kind2')], description: 'An alias of an alias.' },
            Kind2: { oneOf: [ref('Kind3'), { type: 'null' }] },
            Kind3: { allOf: [ref('Kind4'), { title: 'Kind' }] },
            Kind4: { allOf: [c('cat')], description: 'The const itself, behind an allOf.' },
          }),
        );
        expect(describeUnion(spec, 'cat')).toBe('cat: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        expect(petUnion(spec)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
      });

      it('a nullable wrapper around the const on the property pins, as the nullable const written on it does', async () => {
        const wrapped = await parseJson(catAndDog(openapi, keyword, { oneOf: [c('cat'), { type: 'null' }] }));
        const flagged = await parseJson(
          catAndDog(
            openapi,
            keyword,
            openapi === '3.0.3' ? { ...c('cat'), nullable: true } : { type: ['string', 'null'], const: 'cat' },
          ),
        );
        for (const spec of [wrapped, flagged]) {
          expect(describeUnion(spec, 'cat')).toBe('cat: Cat | Dog {"cat":"Cat","dog":"Dog"}');
          expect(petUnion(spec)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
          expect(fieldType(spec, 'Cat', 'kind')).toEqual({
            kind: 'nullable',
            inner: { kind: 'literal', value: 'cat' },
          });
        }
      });

      it('an inline variant reads its own property through the same shapes, with the map for a $ref', async () => {
        const inline = (kind: Doc): Doc => ({ type: 'object', properties: { kind, lives: { type: 'integer' } } });
        const spec = await parseJson(
          doc(openapi, {
            Dog: object(c('dog')),
            CatKind: c('cat'),
            Owner: {
              type: 'object',
              properties: {
                allOfConst: union([inline({ allOf: [c('cat')] }), ref('Dog')], keyword),
                allOfRef: union([inline({ allOf: [ref('CatKind')], description: 'The kind.' }), ref('Dog')], keyword),
                wrapped: union([inline({ oneOf: [c('cat'), { type: 'null' }] }), ref('Dog')], keyword),
              },
            },
            Pet: union([ref('Dog')], keyword),
          }),
        );
        expect(['allOfConst', 'allOfRef', 'wrapped'].map((field) => describeUnion(spec, field))).toEqual([
          'allOfConst: OwnerAllOfConst | Dog {"cat":"OwnerAllOfConst","dog":"Dog"}',
          'allOfRef: OwnerAllOfRef | Dog {"cat":"OwnerAllOfRef","dog":"Dog"}',
          'wrapped: OwnerWrapped | Dog {"cat":"OwnerWrapped","dog":"Dog"}',
        ]);
      });

      it('two inline variants pinning kind behind an allOf are named and mapped as with the const written', async () => {
        const inline = (kind: Doc, extra: Record<string, Doc>): Doc => ({
          type: 'object',
          properties: { kind, ...extra },
        });
        const variants = (spelled: 'allOf' | 'const'): Doc[] => [
          inline(spelled === 'allOf' ? { allOf: [c('cat')] } : c('cat'), { lives: { type: 'integer' } }),
          inline(spelled === 'allOf' ? { allOf: [c('dog')] } : c('dog'), { bark: { type: 'string' } }),
        ];
        const document = (spelled: 'allOf' | 'const'): Doc =>
          doc(openapi, {
            Owner: { type: 'object', properties: { pet: union(variants(spelled), keyword) } },
            Pet: union(variants(spelled), keyword),
          });
        const spec = await parseJson(document('allOf'));
        const old = await parseJson(document('const'));
        expect(describeUnion(spec, 'pet')).toBe('pet: OwnerPet | DogOwnerPet {"cat":"OwnerPet","dog":"DogOwnerPet"}');
        expect(petUnion(spec)).toBe('Pet: CatPet | DogPet {"cat":"CatPet","dog":"DogPet"}');
        expect(describeUnion(spec, 'pet')).toBe(describeUnion(old, 'pet'));
        expect(petUnion(spec)).toBe(petUnion(old));
        for (const name of ['OwnerPet', 'DogOwnerPet', 'CatPet', 'DogPet']) {
          expect(fieldType(spec, name, 'kind'), name).toEqual(fieldType(old, name, 'kind'));
        }
        // The one thing the spelling still decides: the union model's own
        // `kind`, the union of its variants' declarations as written
        // (`unionOfDeclarations`), is the enum `PetKind` when they are consts
        // — the `oneOf`-of-consts enum spelling — and a union of the two
        // literals when each is an `allOf` of one, since that spelling reads
        // a variant as written. That is the enum pipeline's rule, not the
        // discriminator's, and #607 leaves it as it is.
        expect(fieldType(old, 'Pet', 'kind')).toMatchObject({ kind: 'enum', name: 'PetKind' });
        expect(fieldType(spec, 'Pet', 'kind')).toEqual({
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [
            { kind: 'literal', value: 'cat' },
            { kind: 'literal', value: 'dog' },
          ],
        });
        expect(diffOf(old, spec).changes).toEqual(['breaking model-modified Pet', 'breaking enum-removed PetKind']);
      });

      it('an allOf+oneOf dispatcher names its variants from a const behind an allOf, a $ref or an alias and dispatches on it', async () => {
        const inline = (kind: Doc, extra: Record<string, Doc>): Doc => ({
          type: 'object',
          properties: { kind, ...extra },
        });
        type Spelled = 'allOf' | 'const' | 'ref' | 'alias';
        const document = (spelled: Spelled): Doc => {
          const k = (value: string, name: string): Doc =>
            spelled === 'allOf'
              ? { allOf: [c(value)] }
              : spelled === 'ref'
                ? ref(`${name}Kind`)
                : spelled === 'alias'
                  ? ref(`${name}Alias`)
                  : c(value);
          // The const components and their aliases are declared in every
          // spelling, so the documents differ in the variants' `kind` alone.
          return doc(openapi, {
            CatKind: c('cat'),
            DogKind: c('dog'),
            CatAlias: ref('CatKind'),
            DogAlias: ref('DogKind'),
            Owner: { type: 'object', properties: { pet: ref('Pet') } },
            Pet: {
              allOf: [
                { type: 'object', properties: { id: { type: 'string' } } },
                {
                  oneOf: [
                    inline(k('cat', 'Cat'), { lives: { type: 'integer' } }),
                    inline(k('dog', 'Dog'), { bark: { type: 'string' } }),
                  ],
                },
              ],
              ...(keyword ? { discriminator: { propertyName: 'kind' } } : {}),
            },
          });
        };
        const old = await parseJson(document('const'));
        // A bare `$ref` to the const component, and a bare alias of one, were
        // read as written by the dispatcher's naming before, so the base
        // flattened `Pet` into one model with `kind`, `lives` and `bark`
        // (Michael's review of #656); they dispatch as the const does now.
        for (const spelled of ['allOf', 'ref', 'alias'] as const) {
          const spec = await parseJson(document(spelled));
          expect(model(spec, 'Pet').discriminator, spelled).toEqual({
            property: 'kind',
            mapping: { cat: 'PetCat', dog: 'PetDog' },
          });
          expect(
            model(spec, 'Pet').fields.map(({ name }) => name),
            spelled,
          ).toEqual(['id']);
          expect(
            model(spec, 'PetCat').fields.map(({ name }) => name),
            spelled,
          ).toEqual(['id', 'kind', 'lives']);
          expect(
            model(spec, 'PetDog').fields.map(({ name }) => name),
            spelled,
          ).toEqual(['id', 'kind', 'bark']);
          // The variant's `kind` is the literal — in OAS 3.0 the one-value
          // enum component a `$ref` names, through an alias too.
          const viaEnum = spelled !== 'allOf' && openapi === '3.0.3';
          expect(fieldType(spec, 'PetCat', 'kind'), spelled).toEqual(
            viaEnum ? { kind: 'enum', name: 'CatKind' } : { kind: 'literal', value: 'cat' },
          );
          expect(spec.models.map(({ name }) => name).sort(), spelled).toEqual(
            old.models.map(({ name }) => name).sort(),
          );
          expect(diffOf(old, spec).changes, spelled).toEqual(
            viaEnum ? ['breaking model-modified PetCat', 'breaking model-modified PetDog'] : [],
          );
        }
      });

      it('a member pinning the property behind an allOf outranks the open declaration another member makes, in either order', async () => {
        const pinned = { properties: { kind: { allOf: [c('cat')] } } };
        const document = (members: Doc[]): Doc =>
          doc(openapi, {
            Base: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
            Cat: { allOf: members },
            Dog: object(c('dog')),
            Owner: { type: 'object', properties: { cat: union([ref('Cat'), ref('Dog')], keyword) } },
            Pet: union([ref('Cat'), ref('Dog')], keyword),
          });
        for (const members of [
          [ref('Base'), pinned],
          [pinned, ref('Base')],
        ]) {
          const spec = await parseJson(document(members));
          expect(describeUnion(spec, 'cat'), JSON.stringify(members)).toBe('cat: Cat | Dog {"cat":"Cat","dog":"Dog"}');
          expect(petUnion(spec), JSON.stringify(members)).toBe('Pet: Cat | Dog {"cat":"Cat","dog":"Dog"}');
        }
      });

      it('an allOf of two typing members pins nothing, whether the consts disagree or agree', async () => {
        for (const [label, members] of [
          ['disagree', [c('cat'), c('dog')]],
          ['agree', [c('cat'), c('cat')]],
          ['const beside a type', [c('cat'), { type: 'string' }]],
        ] as const) {
          const spec = await parseJson(catAndDog(openapi, keyword, { allOf: [...members] }));
          // The type builder reads such an `allOf` as neither member, so the
          // field is `unknown` and no value is pinned for a discriminator.
          expect(fieldType(spec, 'Cat', 'kind'), label).toEqual({ kind: 'primitive', type: 'unknown' });
          expect(describeUnion(spec, 'cat'), label).toBe(keyword ? 'cat: Cat | Dog {}' : 'cat: Cat | Dog undefined');
          expect(petUnion(spec), label).toBe(keyword ? 'Pet: Cat | Dog {}' : 'Pet: Cat | Dog undefined');
        }
      });

      it('a chain that repeats pins nothing and ends: a self-alias, a two-step cycle, a nullable self-wrapper', async () => {
        for (const [label, kind, extra] of [
          ['self-alias', ref('Loop'), { Loop: { allOf: [ref('Loop')] } }],
          ['two-step', ref('Hop'), { Hop: ref('Back'), Back: { allOf: [ref('Hop')], description: 'Around.' } }],
          ['nullable self-wrapper', ref('Nul'), { Nul: { oneOf: [ref('Nul'), { type: 'null' }] } }],
        ] as const) {
          const spec = await parseJson(catAndDog(openapi, keyword, kind, { ...extra }));
          expect(describeUnion(spec, 'cat'), label).toBe(keyword ? 'cat: Cat | Dog {}' : 'cat: Cat | Dog undefined');
          expect(petUnion(spec), label).toBe(keyword ? 'Pet: Cat | Dog {}' : 'Pet: Cat | Dog undefined');
        }
      });
    });

    it('oagen diff from old.json to repro.json reports nothing on Owner or Pet', async () => {
      for (const keyword of [true, false]) {
        const old = await parseJson(issueRepro(openapi, keyword, 'const'));
        const spec = await parseJson(issueRepro(openapi, keyword));
        const { changes, exit } = diffOf(old, spec);
        if (openapi === '3.1.0') {
          expect(changes, `keyword: ${keyword}`).toEqual([]);
          expect(exit, `keyword: ${keyword}`).toBe(0);
        } else {
          // `Hamster.kind` and `Rabbit.kind` name the one-value enum
          // components `HamsterKind` and `RabbitConst` in OAS 3.0, where the
          // const spelling is a literal — the rule for a one-value `enum:`
          // component, which #607 leaves as it is. Nothing on the unions moves.
          expect(changes, `keyword: ${keyword}`).toEqual([
            'breaking model-modified Hamster',
            'breaking model-modified Rabbit',
          ]);
          expect(exit, `keyword: ${keyword}`).toBe(2);
        }
      }
    });

    it('folds a discriminated request body whose variants pin the discriminator behind an allOf, as one pinning consts', async () => {
      const inline = (kind: Doc, extra: Record<string, Doc>): Doc => ({
        type: 'object',
        required: ['kind'],
        properties: { kind, ...extra },
      });
      const body = (kinds: [Doc, Doc]): Doc => ({
        oneOf: [inline(kinds[0], { address: { type: 'string' } }), inline(kinds[1], { number: { type: 'string' } })],
        discriminator: { propertyName: 'kind' },
      });
      const document = (kinds: [Doc, Doc], schemas: Record<string, Doc> = {}): Doc =>
        doc(openapi, schemas, {
          '/tags': {
            post: {
              operationId: 'createTag',
              requestBody: { content: { 'application/json': { schema: body(kinds) } } },
              responses: { '204': { description: 'OK' } },
            },
          },
        });
      const old = await parseJson(document([c('email'), c('sms')]));
      const folded = (spec: ApiSpec, label: string, besides: string[] = []): void => {
        const op = spec.services.flatMap((service) => service.operations).find(({ name }) => name === 'createTag');
        expect(op?.requestBody, label).toEqual({ kind: 'model', name: 'CreateTagRequest' });
        expect(
          model(spec, 'CreateTagRequest').fields.map(({ name, required }) => `${name}${required ? '' : '?'}`),
          label,
        ).toEqual(['kind', 'address?', 'number?']);
        expect(fieldType(spec, 'CreateTagRequest', 'kind'), label).toMatchObject({
          kind: 'enum',
          name: 'CreateTagRequestKind',
        });
        expect(
          spec.enums.find(({ name }) => name === 'CreateTagRequestKind')?.values.map(({ value }) => value),
          label,
        ).toEqual(['email', 'sms']);
        expect(diffOf(old, spec).changes, label).toEqual(besides);
      };
      folded(old, 'const');
      folded(await parseJson(document([{ allOf: [c('email')] }, { allOf: [c('sms')] }])), 'allOf of the const');
      // A bare `$ref` to the const component was read as written before, so
      // the base kept the body a union of two models (Michael's review of
      // #656); it folds as the const does now.
      folded(
        await parseJson(document([ref('EmailKind'), ref('SmsKind')], { EmailKind: c('email'), SmsKind: c('sms') })),
        'a bare $ref to the const component',
        openapi === '3.0.3' ? ['additive enum-added EmailKind', 'additive enum-added SmsKind'] : [],
      );
      folded(
        await parseJson(
          document([{ allOf: [ref('EmailKind')], description: 'Email.' }, ref('SmsKind')], {
            EmailKind: c('email'),
            SmsKind: { allOf: [ref('SmsConst')] },
            SmsConst: c('sms'),
          }),
        ),
        'through the components',
        // In OAS 3.0 the one-value `enum:` components are enums of their
        // own, so the document adds two; the folded body is the same.
        openapi === '3.0.3' ? ['additive enum-added EmailKind', 'additive enum-added SmsConst'] : [],
      );
    });

    it("carries onto the folded discriminator the settings every variant's declaration agrees on, read off its levels", async () => {
      const inline = (kind: Doc, extra: Record<string, Doc>): Doc => ({
        type: 'object',
        required: ['kind'],
        properties: { kind, ...extra },
      });
      const document = (kinds: [Doc, Doc], schemas: Record<string, Doc> = {}): Doc =>
        doc(openapi, schemas, {
          '/notes': {
            post: {
              operationId: 'createNote',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      oneOf: [
                        inline(kinds[0], { address: { type: 'string' } }),
                        inline(kinds[1], { number: { type: 'string' } }),
                      ],
                      discriminator: { propertyName: 'kind' },
                    },
                  },
                },
              },
              responses: { '204': { description: 'OK' } },
            },
          },
        });
      /** The folded body's `kind` field. */
      const kindOf = async (kinds: [Doc, Doc], schemas: Record<string, Doc>, label: string) => {
        const spec = await parseJson(document(kinds, schemas));
        const [op] = spec.services.flatMap((service) => service.operations);
        expect(op?.requestBody, label).toEqual({ kind: 'model', name: 'CreateNoteRequest' });
        const field = model(spec, 'CreateNoteRequest').fields.find(({ name }) => name === 'kind');
        expect(field, label).toBeDefined();
        return field!;
      };
      const settings: Doc = { readOnly: true, deprecated: true, description: 'The kind.', 'x-note': 1 };
      const carried = {
        required: true,
        readOnly: true,
        deprecated: true,
        description: 'The kind.',
        extensions: { 'x-note': 1 },
      };
      // The flag, text and key every variant writes — on the wrapper, as
      // written, or on an annotating member — are the folded field's, as
      // they are each variant's own field's when the body is not folded
      // (Greptile review of #656: `description` alone was carried, so the
      // read-only flag was dropped and the field landed in request examples).
      const agreeing: Array<[string, [Doc, Doc]]> = [
        [
          'on the wrapper',
          [
            { allOf: [c('email')], ...settings },
            { allOf: [c('sms')], ...settings },
          ],
        ],
        [
          'as written',
          [
            { ...c('email'), ...settings },
            { ...c('sms'), ...settings },
          ],
        ],
        ['on an annotating member', [{ allOf: [c('email'), settings] }, { allOf: [c('sms'), settings] }]],
      ];
      for (const [label, kinds] of agreeing) expect(await kindOf(kinds, {}, label), label).toMatchObject(carried);
      // Through a `$ref`: a const component's keys are the field's, as a
      // primitive component's are (OAS 3.1); an enum component's stay on the
      // `Enum` (OAS 3.0, where a one-value `enum:` component is one), as for
      // a field naming it.
      const viaRef = await kindOf(
        [ref('EmailKind'), ref('SmsKind')],
        { EmailKind: { ...c('email'), ...settings }, SmsKind: { ...c('sms'), ...settings } },
        'through a $ref',
      );
      if (openapi === '3.1.0') {
        expect(viaRef).toMatchObject(carried);
      } else {
        expect(viaRef).toMatchObject({ required: true });
        expect(viaRef.readOnly).toBeUndefined();
        expect(viaRef.deprecated).toBeUndefined();
        expect(viaRef.description).toBeUndefined();
        expect(viaRef.extensions).toBeUndefined();
      }
      // A setting one variant alone writes is nobody's.
      const disagreeing = await kindOf(
        [{ allOf: [c('email')], readOnly: true, description: 'Email.', 'x-note': 1 }, { allOf: [c('sms')] }],
        {},
        'disagreeing',
      );
      expect(disagreeing).toMatchObject({ required: true });
      expect(disagreeing.readOnly).toBeUndefined();
      expect(disagreeing.description).toBeUndefined();
      expect(disagreeing.extensions).toBeUndefined();
    });

    it("keeps null on the folded discriminator when a variant's declaration admits it, in every spelling", async () => {
      const inline = (kind: Doc, extra: Record<string, Doc>): Doc => ({
        type: 'object',
        required: ['kind'],
        properties: { kind, ...extra },
      });
      const document = (kinds: [Doc, Doc], schemas: Record<string, Doc> = {}): Doc =>
        doc(openapi, schemas, {
          '/tags': {
            post: {
              operationId: 'createTag',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      oneOf: [
                        inline(kinds[0], { address: { type: 'string' } }),
                        inline(kinds[1], { number: { type: 'string' } }),
                      ],
                      discriminator: { propertyName: 'kind' },
                    },
                  },
                },
              },
              responses: { '204': { description: 'OK' } },
            },
          },
        });
      /** The const admitting `null` as written: OAS 3.0 `nullable: true`, or a 3.1 type list. */
      const nullableConst = (value: string): Doc =>
        openapi === '3.0.3' ? { ...c(value), nullable: true } : { type: ['string', 'null'], const: value };
      const kindOf = (spec: ApiSpec, label: string): TypeRef => {
        const [op] = spec.services.flatMap((service) => service.operations);
        expect(op?.requestBody, label).toEqual({ kind: 'model', name: 'CreateTagRequest' });
        expect(model(spec, 'CreateTagRequest').fields.find(({ name }) => name === 'kind')?.required, label).toBe(true);
        return fieldType(spec, 'CreateTagRequest', 'kind');
      };
      const cases: Array<[string, [Doc, Doc], Record<string, Doc>]> = [
        ['a nullable wrapper', [{ oneOf: [c('email'), { type: 'null' }] }, c('sms')], {}],
        ['the flag or a type list', [nullableConst('email'), c('sms')], {}],
        [
          'an allOf around a nullable wrapper',
          [{ allOf: [{ oneOf: [c('email'), { type: 'null' }] }], description: 'Email.' }, c('sms')],
          {},
        ],
        ['a $ref to a nullable component', [ref('EmailKind'), c('sms')], { EmailKind: nullableConst('email') }],
        ['the second variant admitting it', [c('email'), { oneOf: [c('sms'), { type: 'null' }] }], {}],
      ];
      for (const [label, kinds, schemas] of cases) {
        const spec = await parseJson(document(kinds, schemas));
        // The folded field admits `null`, as the variant's own field does.
        expect(kindOf(spec, label), label).toMatchObject({
          kind: 'nullable',
          inner: { kind: 'enum', name: 'CreateTagRequestKind' },
        });
        expect(
          spec.enums.find(({ name }) => name === 'CreateTagRequestKind')?.values.map(({ value }) => value),
          label,
        ).toEqual(['email', 'sms']);
      }
      // One value pinned by both variants, one admitting `null`: the one-value
      // enum — a literal — admits it.
      const one = await parseJson(document([{ oneOf: [c('email'), { type: 'null' }] }, c('email')]));
      expect(kindOf(one, 'one value')).toEqual({ kind: 'nullable', inner: { kind: 'literal', value: 'email' } });
      // `nullable: true` beside the `allOf` declares nothing, as beside any
      // schema without a `type`: the field stays the plain enum.
      const beside = await parseJson(document([{ allOf: [c('email')], nullable: true }, c('sms')]));
      expect(kindOf(beside, 'beside the allOf')).toMatchObject({ kind: 'enum', name: 'CreateTagRequestKind' });
      // A null keyword beside a `$ref` declares nothing either: the type
      // builder gives the `$ref` precedence over its siblings, so the field
      // the variant carries is the non-null `EmailKind`, and so is the fold's.
      const nullBesideRef: Doc =
        openapi === '3.0.3'
          ? { ...ref('EmailKind'), nullable: true }
          : { ...ref('EmailKind'), type: ['string', 'null'] };
      const besideRef = await parseJson(
        document([nullBesideRef, c('sms')], { EmailKind: c('email'), Holder: object(nullBesideRef) }),
      );
      expect(fieldType(besideRef, 'Holder', 'kind'), 'beside the $ref').toMatchObject(
        openapi === '3.0.3' ? { kind: 'enum', name: 'EmailKind' } : { kind: 'literal', value: 'email' },
      );
      expect(kindOf(besideRef, 'beside the $ref')).toMatchObject({ kind: 'enum', name: 'CreateTagRequestKind' });
      const plain = await parseJson(document([c('email'), c('sms')]));
      expect(kindOf(plain, 'no null')).toMatchObject({ kind: 'enum', name: 'CreateTagRequestKind' });
    });

    it('reserves the const prefix a nested variant takes behind an allOf, as it reserves one written as a const', async () => {
      const inline = (kind: Doc, extra: Record<string, Doc>): Doc => ({
        type: 'object',
        properties: { kind, ...extra },
      });
      const body = (spelled: 'allOf' | 'const'): Doc => ({
        type: 'object',
        properties: {
          target: {
            oneOf: [
              inline(spelled === 'allOf' ? { allOf: [c('email')] } : c('email'), { address: { type: 'string' } }),
              inline(spelled === 'allOf' ? { allOf: [c('sms')] } : c('sms'), { number: { type: 'string' } }),
            ],
          },
        },
      });
      const document = (spelled: 'allOf' | 'const'): Doc =>
        doc(
          openapi,
          { SmsTagsPostRequestTarget: { type: 'object', properties: { x: { type: 'string' } } } },
          {
            '/tags': {
              post: {
                requestBody: { content: { 'application/json': { schema: body(spelled) } } },
                responses: { '204': { description: 'OK' } },
              },
            },
          },
        );
      const spec = await parseJson(document('allOf'));
      const old = await parseJson(document('const'));
      const names = (s: ApiSpec) => s.models.map(({ name }) => name).sort();
      expect(names(spec)).toEqual(names(old));
      // The component keeps its name and fields; the nested `sms` variant
      // steps around it rather than overwriting it, in either spelling.
      expect(model(spec, 'SmsTagsPostRequestTarget').fields.map(({ name }) => name)).toEqual(['x']);
      const smsVariant = spec.models.find((m) => m.name !== 'SmsTagsPostRequestTarget' && m.name.startsWith('Sms'));
      expect(smsVariant, names(spec).join(', ')).toBeDefined();
      expect(smsVariant!.fields.map(({ name }) => name)).toEqual(['kind', 'number']);
      expect(diffOf(old, spec).changes).toEqual([]);
    });
  });
});
