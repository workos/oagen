import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Enum, Field, Model, Operation, Parameter } from '../../src/ir/types.js';

/**
 * Issue #679: since #658 a component that writes a union beside an `allOf`
 * whose members only annotate it is the named union the plain spelling is,
 * described by the member (`allOfWrapperLayer`). A parameter whose schema
 * is a `$ref` to such a component still read the component's own keys
 * alone, so `PetId: { allOf: [{ description: 'A pet id.', deprecated: true
 * }], oneOf: [...] }` left the parameter without text and live while the
 * same two keys beside the `oneOf` made it deprecated and described, and
 * `oagen diff` between the two spellings exited 1. The parameter now reads
 * the component through the layer the model built from it reads
 * (`referencedComponentLayer`), and a field takes a referenced model's
 * `example`/`examples` through the same layer.
 */

type Doc = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const variants = [{ type: 'string' }, { type: 'integer' }];
const link = { url: 'https://example.com/pet-ids', description: 'Pet ids' };
const responses = { '204': { description: 'No content' } };
const info = { title: 'Repro 679', version: '1.0.0' };

/** The issue's `plain.json`: the two keys beside the `oneOf`. */
const plainPetId = { description: 'A pet id.', deprecated: true, oneOf: variants };
/** The issue's `beside.json`: the two keys as an `allOf` member. */
const besidePetId = { allOf: [{ description: 'A pet id.', deprecated: true }], oneOf: variants };

const after = { name: 'after', in: 'query', schema: ref('PetId') };

/** The issue's document: `GET /pets` (`operationId: listPets`) with `parameters`, returning `204`. */
function petsDoc(openapi: string, schemas: Doc, parameters: unknown[] = [after], operation: Doc = {}): Doc {
  return {
    openapi,
    info,
    paths: { '/pets': { get: { operationId: 'listPets', parameters, responses, ...operation } } },
    components: { schemas },
  };
}

const Pet = { type: 'object', properties: { name: { type: 'string' } } };
const Toy = { type: 'object', properties: { toy: { type: 'string' } } };
const object = { type: 'object', properties: { id: { type: 'string' } } };

/** `schema` or `null`, in the spelling the OpenAPI version has. */
const nullable = (openapi: string, schema: Doc): Doc =>
  openapi === '3.0.3' ? { oneOf: [schema], nullable: true } : { oneOf: [schema, { type: 'null' }] };

/** `keys` written on `base` itself. */
const beside = (base: Doc, keys: Doc): Doc => ({ ...keys, ...base });
/** `keys` written as one more `allOf` member of `base`, which declares no type and so only annotates it. */
const inMember = (base: Doc, keys: Doc): Doc => ({ ...base, allOf: [...((base.allOf as unknown[]) ?? []), keys] });

/** Every key a parameter falls back to the component its `$ref` names for. */
const layer = {
  description: 'A pet id.',
  deprecated: true,
  externalDocs: link,
  default: 'pet_1',
  example: 'pet_2',
  examples: ['pet_3', 'pet_4'],
};

const jsonBody = {
  content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } } } } },
};

/** Every way a parameter whose schema is `{ $ref: PetId }` reaches the IR, and where it lands. */
const SITES: Record<string, { doc: (openapi: string, schemas: Doc) => Doc; read: (spec: ApiSpec) => Parameter[] }> = {
  'a query parameter': {
    doc: (openapi, schemas) => petsDoc(openapi, schemas),
    read: (spec) => spec.services[0].operations[0].queryParams,
  },
  'a header parameter': {
    doc: (openapi, schemas) => petsDoc(openapi, schemas, [{ name: 'X-After', in: 'header', schema: ref('PetId') }]),
    read: (spec) => spec.services[0].operations[0].headerParams,
  },
  'a cookie parameter': {
    doc: (openapi, schemas) => petsDoc(openapi, schemas, [{ name: 'after', in: 'cookie', schema: ref('PetId') }]),
    read: (spec) => spec.services[0].operations[0].cookieParams ?? [],
  },
  'a path parameter': {
    doc: (openapi, schemas) => ({
      openapi,
      info,
      paths: {
        '/pets/{after}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'after', in: 'path', required: true, schema: ref('PetId') }],
            responses,
          },
        },
      },
      components: { schemas },
    }),
    read: (spec) => spec.services[0].operations[0].pathParams,
  },
  'a path-level parameter': {
    doc: (openapi, schemas) => ({
      openapi,
      info,
      paths: { '/pets': { parameters: [after], get: { operationId: 'listPets', responses } } },
      components: { schemas },
    }),
    read: (spec) => spec.services[0].operations[0].queryParams,
  },
  'a `components/parameters` entry': {
    doc: (openapi, schemas) => ({
      ...petsDoc(openapi, schemas, [{ $ref: '#/components/parameters/After' }]),
      components: { schemas, parameters: { After: after } },
    }),
    read: (spec) => spec.services[0].operations[0].queryParams,
  },
  'a parameter declared with `content`': {
    doc: (openapi, schemas) =>
      petsDoc(openapi, schemas, [
        { name: 'after', in: 'query', content: { 'application/json': { schema: ref('PetId') } } },
      ]),
    read: (spec) => spec.services[0].operations[0].queryParams,
  },
  "a webhook's parameter": {
    doc: (openapi, schemas) => ({
      ...petsDoc(openapi, schemas, []),
      webhooks: {
        petEvent: {
          post: {
            operationId: 'petEvent',
            parameters: [{ name: 'X-After', in: 'header', schema: ref('PetId') }],
            requestBody: jsonBody,
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    }),
    read: (spec) => spec.webhooks?.[0]?.headerParams ?? [],
  },
  "a callback's parameter": {
    doc: (openapi, schemas) =>
      petsDoc(openapi, schemas, [], {
        callbacks: {
          onEvent: {
            '{$request.query.url}': {
              post: {
                operationId: 'onEvent',
                parameters: [after],
                requestBody: jsonBody,
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        },
      }),
    read: (spec) => spec.services[0].operations[0].callbacks?.[0]?.queryParams ?? [],
  },
};

describe.each(['3.1.0', '3.0.3'])(
  '#679 a `$ref` parameter reads its component through the wrapper layer (OAS %s)',
  (openapi) => {
    let warn: ReturnType<typeof vi.spyOn>;
    let tmpDir: string;
    let written = 0;

    beforeEach(async () => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-679-'));
    });

    afterEach(async () => {
      warn.mockRestore();
      vi.restoreAllMocks();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function write(doc: unknown): Promise<string> {
      const file = path.join(tmpDir, `spec-${written++}.json`);
      await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
      return file;
    }

    const parse = async (doc: unknown): Promise<ApiSpec> => parseSpec(await write(doc));

    const model = (spec: ApiSpec, name: string): Model => {
      const found = spec.models.find((m) => m.name === name);
      if (!found) throw new Error(`no model ${name} among ${spec.models.map((m) => m.name).join(', ')}`);
      return found;
    };
    const enumOf = (spec: ApiSpec, name: string): Enum => {
      const found = spec.enums.find((e) => e.name === name);
      if (!found) throw new Error(`no enum ${name} among ${spec.enums.map((e) => e.name).join(', ')}`);
      return found;
    };
    const operation = (spec: ApiSpec): Operation => spec.services.flatMap((s) => s.operations)[0];
    const field = (spec: ApiSpec, modelName: string, name: string): Field => {
      const found = model(spec, modelName).fields.find((f) => f.name === name);
      if (!found) throw new Error(`no field ${modelName}.${name}`);
      return found;
    };
    /** The one query parameter of the one operation. */
    const param = (spec: ApiSpec): Parameter => {
      const [found, ...rest] = operation(spec).queryParams;
      if (!found || rest.length > 0) throw new Error('expected exactly one query parameter');
      return found;
    };
    /** What a parameter documents itself with: every key it can take from the component. */
    const documented = ({ description, deprecated, externalDocs, default: def, example, examples }: Parameter) => ({
      description,
      deprecated,
      externalDocs,
      default: def,
      example,
      examples,
    });
    const undocumented = documented({} as Parameter);

    /** The issue's script output for one document. */
    const issueOutput = (spec: ApiSpec) => {
      const { deprecated, description, variants: unionVariants } = model(spec, 'PetId');
      return {
        after: operation(spec).queryParams.map(({ deprecated, description }) => ({ deprecated, description })),
        petId: { deprecated, description, variants: unionVariants?.length },
      };
    };

    /** `oagen diff` between two documents, both ways: no change, exit 0. */
    async function expectNoDiff(a: Doc, b: Doc): Promise<void> {
      const [fileA, fileB] = [await write(a), await write(b)];
      const [specA, specB] = [await parseSpec(fileA), await parseSpec(fileB)];
      for (const [from, to] of [
        [specA, specB],
        [specB, specA],
      ]) {
        const diff = diffSpecs(from, to);
        expect(diff.changes).toEqual([]);
        expect(diff.behaviorChanges).toEqual([]);
      }
      vi.spyOn(console, 'log').mockImplementation(() => {});
      for (const [from, to] of [
        [fileA, fileB],
        [fileB, fileA],
      ]) {
        const error = (await diffCommand({ old: from, new: to }).catch((e: unknown) => e)) as { exitCode: number };
        expect(error.exitCode).toBe(0);
      }
    }

    /** Both spellings of one document parse to one IR, and `oagen diff` between them reports nothing. */
    async function expectOneReading(plainDoc: Doc, memberDoc: Doc): Promise<{ plain: ApiSpec; member: ApiSpec }> {
      const [plain, member] = [await parse(plainDoc), await parse(memberDoc)];
      expect(member).toEqual(plain);
      await expectNoDiff(plainDoc, memberDoc);
      return { plain, member };
    }

    describe("the issue's repro", () => {
      it('`after` is deprecated and described "A pet id." in `plain.json` and `beside.json` alike', async () => {
        const plain = await parse(petsDoc(openapi, { PetId: plainPetId }));
        const member = await parse(petsDoc(openapi, { PetId: besidePetId }));
        expect(issueOutput(plain)).toMatchInlineSnapshot(`
          {
            "after": [
              {
                "deprecated": true,
                "description": "A pet id.",
              },
            ],
            "petId": {
              "deprecated": true,
              "description": "A pet id.",
              "variants": 2,
            },
          }
        `);
        expect(issueOutput(member)).toEqual(issueOutput(plain));
        expect(member).toEqual(plain);
      });

      it('`oagen diff` between `plain.json` and `beside.json` reports nothing and exits 0, both ways', async () => {
        await expectNoDiff(petsDoc(openapi, { PetId: plainPetId }), petsDoc(openapi, { PetId: besidePetId }));
      });

      it("an `externalDocs` in the member is the parameter's link, as beside the `oneOf`", async () => {
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: { ...plainPetId, externalDocs: link } }),
          petsDoc(openapi, {
            PetId: { allOf: [{ description: 'A pet id.', deprecated: true, externalDocs: link }], oneOf: variants },
          }),
        );
        expect(param(member)).toMatchObject({ description: 'A pet id.', deprecated: true, externalDocs: link });
        expect(model(member, 'PetId')).toMatchObject({
          description: 'A pet id.',
          deprecated: true,
          externalDocs: link,
        });
      });

      it('a header parameter reads the member too', async () => {
        const header = { name: 'X-After', in: 'header', schema: ref('PetId') };
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: plainPetId }, [header]),
          petsDoc(openapi, { PetId: besidePetId }, [header]),
        );
        expect(operation(member).headerParams).toMatchObject([
          { name: 'X-After', description: 'A pet id.', deprecated: true },
        ]);
      });

      describe('`Owner: { allOf: [{ $ref: Base }, { description, deprecated }] }` as the schema of a parameter', () => {
        const owner = { name: 'owner', in: 'query', schema: ref('Owner') };
        const member = { allOf: [ref('Base'), { description: 'An owner.', deprecated: true }] };
        const own = { description: 'An owner.', deprecated: true, allOf: [ref('Base')] };

        it('`Base` an object component: deprecated and described, as with the keys beside the `allOf`', async () => {
          const { member: spec } = await expectOneReading(
            petsDoc(openapi, { Base: object, Owner: own }, [owner]),
            petsDoc(openapi, { Base: object, Owner: member }, [owner]),
          );
          expect(param(spec)).toMatchObject({
            type: { kind: 'model', name: 'Owner' },
            description: 'An owner.',
            deprecated: true,
          });
          expect(model(spec, 'Owner')).toMatchObject({ description: 'An owner.', deprecated: true });
        });

        it('`Base` a string component: both spellings already carried the text and the flag, and still do', async () => {
          const Base = { type: 'string' };
          const { member: spec } = await expectOneReading(
            petsDoc(openapi, { Base, Owner: own }, [owner]),
            petsDoc(openapi, { Base, Owner: member }, [owner]),
          );
          expect(param(spec)).toMatchObject({
            type: { kind: 'primitive', type: 'string' },
            description: 'An owner.',
            deprecated: true,
          });
          // `Owner` is a primitive component there: no model carries its text.
          expect(spec.models).toEqual([]);
        });

        it('the reading does not depend on the order of the components', async () => {
          const forward = await parse(petsDoc(openapi, { Base: object, Owner: member }, [owner]));
          const reversed = await parse(petsDoc(openapi, { Owner: member, Base: object }, [owner]));
          expect(param(reversed)).toEqual(param(forward));
          expect(model(reversed, 'Owner')).toEqual(model(forward, 'Owner'));
          expect(param(reversed)).toMatchObject({ description: 'An owner.', deprecated: true });
        });
      });
    });

    describe('every key the parameter falls back to the component for', () => {
      it.each(Object.keys(layer) as (keyof typeof layer)[])(
        '`%s` in the member reads as the same key beside the `oneOf`',
        async (key) => {
          const keys = { [key]: layer[key] };
          const { member } = await expectOneReading(
            petsDoc(openapi, { PetId: beside({ oneOf: variants }, keys) }),
            petsDoc(openapi, { PetId: inMember({ oneOf: variants }, keys) }),
          );
          expect(documented(param(member))).toEqual({
            ...undocumented,
            ...keys,
            // `example` is the first of `examples` when the component gives the list alone.
            ...(key === 'examples' ? { example: 'pet_3' } : {}),
          });
        },
      );

      it('all of them in one member', async () => {
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: beside({ oneOf: variants }, layer) }),
          petsDoc(openapi, { PetId: inMember({ oneOf: variants }, layer) }),
        );
        expect(param(member)).toMatchInlineSnapshot(`
          {
            "default": "pet_1",
            "deprecated": true,
            "description": "A pet id.",
            "example": "pet_2",
            "examples": [
              "pet_3",
              "pet_4",
            ],
            "explode": undefined,
            "externalDocs": {
              "description": "Pet ids",
              "url": "https://example.com/pet-ids",
            },
            "name": "after",
            "required": false,
            "style": undefined,
            "type": {
              "kind": "model",
              "name": "PetId",
            },
          }
        `);
      });

      it('each key in a member of its own', async () => {
        const members = Object.entries(layer).map(([key, value]) => ({ [key]: value }));
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: beside({ oneOf: variants }, layer) }),
          petsDoc(openapi, { PetId: { oneOf: variants, allOf: members } }),
        );
        expect(documented(param(member))).toEqual(layer);
      });

      it("a member's limits were already the parameter's, and still are", async () => {
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: beside({ oneOf: variants }, { minProperties: 1 }) }),
          petsDoc(openapi, { PetId: inMember({ oneOf: variants }, { minProperties: 1 }) }),
        );
        expect(param(member).constraints).toEqual({ minProperties: 1 });
        expect(model(member, 'PetId').constraints).toEqual({ minProperties: 1 });
      });
    });

    describe('precedence is what it was: the Parameter Object, its schema, then the component', () => {
      const first = { description: 'First.', externalDocs: { url: 'https://example.com/first' }, default: 1 };
      const second = { description: 'Second.', externalDocs: { url: 'https://example.com/second' }, default: 2 };

      it("the component's own keys win over a member's, and the first member's over the next", async () => {
        const own = { description: 'Own.', externalDocs: { url: 'https://example.com/own' }, default: 0 };
        const members = await parse(petsDoc(openapi, { PetId: { oneOf: variants, allOf: [first, second] } }));
        expect(param(members)).toMatchObject(first);
        const withOwn = await parse(petsDoc(openapi, { PetId: { ...own, oneOf: variants, allOf: [first, second] } }));
        expect(param(withOwn)).toMatchObject(own);
        // The model reads the same layer.
        expect(model(members, 'PetId')).toMatchObject({ description: 'First.', externalDocs: first.externalDocs });
        expect(model(withOwn, 'PetId')).toMatchObject({ description: 'Own.', externalDocs: own.externalDocs });
      });

      it("a blank text or an unusable link on the component leaves the member's standing", async () => {
        const spec = await parse(
          petsDoc(openapi, { PetId: { description: '', externalDocs: {}, oneOf: variants, allOf: [first] } }),
        );
        expect(param(spec)).toMatchObject({ description: 'First.', externalDocs: first.externalDocs });
      });

      it("the Parameter Object's own text wins, and its `deprecated: false` does not unset the member's flag", async () => {
        const spec = await parse(
          petsDoc(openapi, { PetId: besidePetId }, [{ ...after, description: 'The cursor.', deprecated: false }]),
        );
        expect(param(spec)).toMatchObject({ description: 'The cursor.', deprecated: true });
      });

      it('keys written beside the `$ref` win over the member, key by key', async () => {
        const schema = { ...ref('PetId'), description: 'Beside the ref.', default: 'own' };
        const spec = await parse(
          petsDoc(openapi, { PetId: inMember({ oneOf: variants }, layer) }, [{ ...after, schema }]),
        );
        expect(documented(param(spec))).toEqual({ ...layer, description: 'Beside the ref.', default: 'own' });
      });

      it('a `false` or `0` default and a `null` example in the member are kept', async () => {
        for (const keys of [{ default: false }, { default: 0 }, { example: null }]) {
          const { member } = await expectOneReading(
            petsDoc(openapi, { PetId: beside({ oneOf: variants }, keys) }),
            petsDoc(openapi, { PetId: inMember({ oneOf: variants }, keys) }),
          );
          expect(param(member)).toMatchObject(keys);
        }
      });

      it("the member's `example` is the component's, so it stands before the first of the component's own `examples`", async () => {
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: { example: 'pet_2', examples: ['pet_3'], oneOf: variants } }),
          petsDoc(openapi, { PetId: { examples: ['pet_3'], oneOf: variants, allOf: [{ example: 'pet_2' }] } }),
        );
        expect(param(member)).toMatchObject({ example: 'pet_2', examples: ['pet_3'] });
      });

      it("a typing member's keys stay on that member, and a `$ref` member's on its component", async () => {
        const documentedBase = { ...object, description: 'A base.', deprecated: true, example: { id: 'b' } };
        const typing = { ...Pet, description: 'Typing.', deprecated: true, default: {}, example: { name: 'Rex' } };
        const spec = await parse(
          petsDoc(openapi, { Base: documentedBase, Owner: { allOf: [ref('Base'), typing] } }, [
            { name: 'owner', in: 'query', schema: ref('Owner') },
          ]),
        );
        expect(documented(param(spec))).toEqual(undocumented);
        expect(model(spec, 'Owner')).toMatchObject({ name: 'Owner' });
        expect(model(spec, 'Owner').description).toBeUndefined();
        expect(model(spec, 'Owner').deprecated).toBeUndefined();
        expect(model(spec, 'Base')).toMatchObject({ description: 'A base.', deprecated: true });
      });
    });

    describe('in every place a parameter is declared', () => {
      it.each(Object.keys(SITES))('%s', async (site) => {
        const { doc, read } = SITES[site];
        const { member } = await expectOneReading(
          doc(openapi, { PetId: beside({ oneOf: variants }, layer) }),
          doc(openapi, { PetId: inMember({ oneOf: variants }, layer) }),
        );
        const params = read(member);
        expect(params).toHaveLength(1);
        expect(documented(params[0])).toEqual(layer);
      });
    });

    describe('whatever the component is', () => {
      /** Components that become a model: the parameter read their own keys alone. */
      const MODELS: Record<string, { base: Doc; extra?: Doc }> = {
        'an object': { base: object },
        'a map': { base: { type: 'object', additionalProperties: { type: 'string' } } },
        'an `anyOf` of primitives': { base: { anyOf: variants } },
        'a union of `$ref`s': { base: { oneOf: [ref('Pet'), ref('Toy')] }, extra: { Pet, Toy } },
        'a discriminated union': {
          base: { oneOf: [ref('Cat'), ref('Dog')], discriminator: { propertyName: 'kind' } },
          extra: {
            Cat: { type: 'object', properties: { kind: { type: 'string', enum: ['cat'] } }, required: ['kind'] },
            Dog: { type: 'object', properties: { kind: { type: 'string', enum: ['dog'] } }, required: ['kind'] },
          },
        },
        'a nullable `$ref` to a model': { base: nullable(openapi, ref('Pet')), extra: { Pet } },
        'an `allOf` of one `$ref`': { base: { allOf: [ref('Pet')] }, extra: { Pet } },
        'an `allOf` of a `$ref` and an inline object': { base: { allOf: [ref('Pet'), object] }, extra: { Pet } },
        'an object beside a `oneOf`': {
          base: {
            ...object,
            oneOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'string' } } }],
          },
        },
      };

      it.each(Object.keys(MODELS))('%s: a model, described by the member as by its own keys', async (kind) => {
        const { base, extra = {} } = MODELS[kind];
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: beside(base, layer), ...extra }),
          petsDoc(openapi, { PetId: inMember(base, layer), ...extra }),
        );
        expect(documented(param(member))).toEqual(layer);
        // The parameter carries the text, flag and link the model built from the component carries.
        const { description, deprecated, externalDocs } = model(member, 'PetId');
        expect({ description, deprecated, externalDocs }).toEqual({
          description: layer.description,
          deprecated: true,
          externalDocs: link,
        });
      });

      /** Components the parameter already read the members of: an enum on its declaration, the others level by level. */
      const OTHERS: Record<string, { base: Doc; extra?: Doc; keys?: Doc }> = {
        'an enum': { base: { type: 'string', enum: ['pet_1', 'pet_2'] } },
        'a union of consts': { base: { oneOf: [{ const: 'pet_1' }, { const: 'pet_2' }] } },
        'an alias of an enum': {
          base: { allOf: [ref('Kind')] },
          extra: { Kind: { type: 'string', enum: ['pet_1', 'pet_2'] } },
        },
        'an array': { base: { type: 'array', items: { type: 'string' } }, keys: { default: ['pet_1'] } },
        'a primitive': { base: { type: 'string' } },
        'an alias of a primitive': { base: { allOf: [ref('Id')] }, extra: { Id: { type: 'string' } } },
      };

      it.each(Object.keys(OTHERS))('%s: read through the members before, and still', async (kind) => {
        const { base, extra = {}, keys = {} } = OTHERS[kind];
        const all = { ...layer, ...keys };
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: beside(base, all), ...extra }),
          petsDoc(openapi, { PetId: inMember(base, all), ...extra }),
        );
        expect(documented(param(member))).toEqual(all);
      });

      it('an enum component: the parameter carries what the `Enum` carries', async () => {
        const base = { type: 'string', enum: ['pet_1', 'pet_2'] };
        const spec = await parse(petsDoc(openapi, { PetId: inMember(base, layer) }));
        const { description, deprecated, externalDocs } = enumOf(spec, 'PetId');
        expect({ description, deprecated, externalDocs }).toEqual({
          description: param(spec).description,
          deprecated: param(spec).deprecated,
          externalDocs: param(spec).externalDocs,
        });
      });
    });

    describe('an alias of the component', () => {
      it('`Alias: { $ref: PetId }` is a model of its own, so the parameter reads what `Alias` writes, in both spellings', async () => {
        const alias = { name: 'after', in: 'query', schema: ref('Alias') };
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: plainPetId, Alias: ref('PetId') }, [alias]),
          petsDoc(openapi, { PetId: besidePetId, Alias: ref('PetId') }, [alias]),
        );
        expect(param(member).type).toEqual({ kind: 'model', name: 'Alias' });
        expect(documented(param(member))).toEqual(undocumented);
        // As the model `Alias` does: `PetId`'s text and flag stay on `PetId`.
        expect(model(member, 'Alias').description).toBeUndefined();
        expect(model(member, 'Alias').deprecated).toBeUndefined();
        expect(model(member, 'PetId')).toMatchObject({ description: 'A pet id.', deprecated: true });
      });

      it('what `Alias` writes beside its `$ref` is the parameter’s, as it is the model `Alias`’s', async () => {
        const alias = { name: 'after', in: 'query', schema: ref('Alias') };
        const keys = { description: 'An alias.', deprecated: true };
        const spec = await parse(
          petsDoc(openapi, { PetId: besidePetId, Alias: { ...ref('PetId'), ...keys } }, [alias]),
        );
        expect(param(spec)).toMatchObject({ type: { kind: 'model', name: 'Alias' }, ...keys });
        expect(model(spec, 'Alias')).toMatchObject(keys);
      });

      it("the alias's own member documents the parameter, as its own keys do", async () => {
        const alias = { name: 'after', in: 'query', schema: ref('Alias') };
        const keys = { description: 'An alias.', deprecated: true };
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: plainPetId, Alias: { ...keys, allOf: [ref('PetId')] } }, [alias]),
          petsDoc(openapi, { PetId: plainPetId, Alias: { allOf: [ref('PetId'), keys] } }, [alias]),
        );
        expect(param(member)).toMatchObject({ type: { kind: 'model', name: 'Alias' }, ...keys });
        expect(model(member, 'Alias')).toMatchObject(keys);
      });
    });

    describe('a JSON Pointer deeper into a component', () => {
      const pointer = {
        name: 'after',
        in: 'query',
        schema: { $ref: '#/components/schemas/Holder/properties/owner' },
      };
      const holder = (owner: Doc) => ({ type: 'object', properties: { owner } });

      it.each([
        ['a `$ref` member', { allOf: [ref('Pet')] }],
        ['a string', { type: 'string' }],
      ])('the schema it lands on (%s) is read through its members too', async (_kind, base) => {
        const keys = { description: 'The owner.', deprecated: true, externalDocs: link };
        const { member } = await expectOneReading(
          petsDoc(openapi, { Pet, Holder: holder(beside(base, keys)) }, [pointer]),
          petsDoc(openapi, { Pet, Holder: holder(inMember(base, keys)) }, [pointer]),
        );
        expect(param(member)).toMatchObject(keys);
        // As the field the pointer names reads them.
        expect(field(member, 'Holder', 'owner')).toMatchObject(keys);
      });
    });

    describe('a field whose schema is a `$ref`', () => {
      const holder = (pet: Doc) => ({ type: 'object', properties: { pet } });
      const examples = { example: { name: 'Rex' }, examples: [{ name: 'Rex' }, { name: 'Max' }] };

      it("takes the model's `example` and `examples` from a member as from the model's own keys", async () => {
        const { member } = await expectOneReading(
          petsDoc(openapi, { Pet: beside(Pet, examples), Holder: holder(ref('Pet')) }, []),
          petsDoc(openapi, { Pet: inMember(Pet, examples), Holder: holder(ref('Pet')) }, []),
        );
        expect(field(member, 'Holder', 'pet')).toMatchObject({ type: { kind: 'model', name: 'Pet' }, ...examples });
      });

      it('and nothing else: the text, flag, link and default stay on the model', async () => {
        const keys = { description: 'A pet.', deprecated: true, externalDocs: link, default: { name: 'Rex' } };
        const { member } = await expectOneReading(
          petsDoc(openapi, { Pet: beside(Pet, keys), Holder: holder(ref('Pet')) }, []),
          petsDoc(openapi, { Pet: inMember(Pet, keys), Holder: holder(ref('Pet')) }, []),
        );
        const pet = field(member, 'Holder', 'pet');
        expect(pet.description).toBeUndefined();
        expect(pet.deprecated).toBeUndefined();
        expect(pet.externalDocs).toBeUndefined();
        expect(pet.default).toBeUndefined();
        expect(model(member, 'Pet')).toMatchObject({ description: 'A pet.', deprecated: true, externalDocs: link });
      });

      it("a field's own `example` still wins over the member's", async () => {
        const own = { ...ref('Pet'), example: { name: 'Own' } };
        const spec = await parse(petsDoc(openapi, { Pet: inMember(Pet, examples), Holder: holder(own) }, []));
        expect(field(spec, 'Holder', 'pet')).toMatchObject({
          example: { name: 'Own' },
          examples: examples.examples,
        });
      });
    });

    describe('sites that read no component a `$ref` names read none still, in either spelling', () => {
      const wrappers: Record<string, (schema: Doc) => Doc> = {
        'under an `allOf`': (schema) => ({ allOf: [schema] }),
        'under a nullable wrapper': (schema) => nullable(openapi, schema),
        'as array items': (schema) => ({ type: 'array', items: schema }),
      };
      const targets: Record<string, Doc> = {
        'a named union': { oneOf: variants },
        'a model': object,
        'an enum': { type: 'string', enum: ['pet_1', 'pet_2'] },
      };
      const cases = Object.keys(wrappers).flatMap((wrapper) =>
        Object.keys(targets).map((target) => [wrapper, target] as const),
      );

      it.each(cases)('a parameter schema with the `$ref` %s, to %s, documents itself', async (wrapper, target) => {
        const wrapped = { ...after, schema: wrappers[wrapper](ref('PetId')) };
        const { member } = await expectOneReading(
          petsDoc(openapi, { PetId: beside(targets[target], layer) }, [wrapped]),
          petsDoc(openapi, { PetId: inMember(targets[target], layer) }, [wrapped]),
        );
        expect(documented(param(member))).toEqual(undocumented);
      });

      it('a response header reads the Header Object and its own schema, never the component', async () => {
        const withHeader = (PetId: Doc) =>
          petsDoc(openapi, { PetId }, [], {
            responses: { '200': { description: 'OK', headers: { 'X-After': { schema: ref('PetId') } } } },
          });
        const { member } = await expectOneReading(
          withHeader(beside({ oneOf: variants }, layer)),
          withHeader(inMember({ oneOf: variants }, layer)),
        );
        const [header] = operation(member).responseHeaders ?? [];
        expect(header).toMatchObject({ name: 'X-After', type: { kind: 'model', name: 'PetId' } });
        expect(header.description).toBeUndefined();
        expect(header.deprecated).toBeUndefined();
        expect(header.externalDocs).toBeUndefined();
      });

      it("a request body's description is the Request Body Object's or its schema's own, never the component's", async () => {
        const withBody = (Body: Doc) =>
          petsDoc(openapi, { Body }, [], {
            requestBody: { content: { 'application/json': { schema: ref('Body') } } },
          });
        const { member } = await expectOneReading(
          withBody(beside(object, { description: 'A body.' })),
          withBody(inMember(object, { description: 'A body.' })),
        );
        expect(operation(member).requestBody).toEqual({ kind: 'model', name: 'Body' });
        expect(operation(member).requestBodyDescription).toBeUndefined();
        expect(model(member, 'Body').description).toBe('A body.');
      });
    });
  },
);
