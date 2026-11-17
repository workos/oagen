import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { takeModelDocumentation } from '../../src/parser/inline-models.js';
import { enumValuesOf, inlineEnumDescriptionOf, inlineEnumRef } from '../../src/parser/enum-members.js';
import type { ApiSpec, EnumRef, Field, Model } from '../../src/ir/types.js';

/**
 * Issue #673: since #647, when one operation's `200` and `202` bodies
 * resolve to one model and differ only in the model's own `deprecated`,
 * `extractResponses` keeps the primary's definition, clears its flag and
 * takes the model's `description`, `externalDocs` and extensions from the
 * first live copy (`takeModelDocumentation`). The fields stayed the
 * primary's, their documentation included, so `name: { description: 'Use
 * nickname instead.' }` written for the deprecated `200` documented the live
 * `Pet`, while the same two copies on two operations gave the live copy's
 * `The name.`. The fold now takes what documents the model from the live
 * copy at every place the kept definition carries it: the model's own keys,
 * each field's (`description`, `externalDocs`, `example`, `examples`,
 * extensions) and what an inline enum in a field's type lifts (its text,
 * link, extensions and each member's description) — the kept definition's
 * structure, flags and references untouched. The merge passes clear a kept
 * model's flag the same way for the copies a deprecated component refuses
 * (`settleRefusedCopies`), and document the model the same way now.
 */

type Doc = Record<string, unknown>;

const info = { title: 'repro', version: '1' };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const link = (label: string) => ({ url: `https://example.com/${label}`, description: `${label} guide` });

/** A Response Object with a JSON body of `schema`, described `ok` as the issue's are. */
const json = (schema: Doc): Doc => ({ description: 'ok', content: { 'application/json': { schema } } });

/** An operation `operationId` whose `responses` map declares `entries` in the given order. */
function operation(operationId: string, entries: Array<[number, Doc]>): Doc {
  const responses: Doc = {};
  for (const [code, schema] of entries) responses[String(code)] = json(schema);
  return { operationId, parameters: [idParam], responses };
}

/** `GET /pets/{id}` (`getPet`) declaring `entries` as its responses. */
const getPet = (entries: Array<[number, Doc]>): Doc => ({ '/pets/{id}': { get: operation('getPet', entries) } });
/** `GET /legacy/pets/{id}` (`getLegacyPet`), the issue's second operation. */
const getLegacyPet = (entries: Array<[number, Doc]>): Doc => ({
  '/legacy/pets/{id}': { get: operation('getLegacyPet', entries) },
});

/** A document on `openapi` with `paths`, and `components.schemas` when any are given. */
function document(openapi: string, paths: Doc, schemas?: Doc): Doc {
  return { openapi, info, paths, ...(schemas ? { components: { schemas } } : {}) };
}

/**
 * The issue's inline body: `{ object: 'pet', name? }` requiring `object`,
 * flagged when `deprecated`. `name` carries the keys of `nameDocs` and the
 * body those of `docs`, beside `extra` properties.
 */
function pet(deprecated: boolean, nameDocs: Doc = {}, extra: Doc = {}, docs: Doc = {}): Doc {
  return {
    type: 'object',
    ...(deprecated ? { deprecated: true } : {}),
    ...docs,
    required: ['object'],
    properties: { object: { type: 'string', const: 'pet' }, name: { type: 'string', ...nameDocs }, ...extra },
  };
}

/** The issue's two bodies. */
const deprecatedPet = pet(true, { description: 'Use nickname instead.' });
const livePet = pet(false, { description: 'The name.' });

/** The within-operation document (`repro.json`): `getPet` returning `deprecated` as its `200` and `live` as its `202`. */
const within = (openapi: string, deprecated: Doc, live: Doc, schemas?: Doc): Doc =>
  document(
    openapi,
    getPet([
      [200, deprecated],
      [202, live],
    ]),
    schemas,
  );
/** The across-operations document (`two-operations.json`): the same two bodies as the `200` of `getPet` and of `getLegacyPet`. */
const across = (openapi: string, deprecated: Doc, live: Doc, schemas?: Doc): Doc =>
  document(openapi, { ...getPet([[200, deprecated]]), ...getLegacyPet([[200, live]]) }, schemas);

const sharedFold = (name: string) =>
  `[oagen] Warning: Inline model "${name}" is declared both deprecated and live with the same shape — keeping the live definition under the shared name`;

const byName = <T extends { name: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name));
/** The models and enums of `spec`, by name: what two documents that should read alike are compared by. */
const declared = (spec: ApiSpec) => ({ models: byName(spec.models), enums: byName(spec.enums) });

const modelNames = (spec: ApiSpec) =>
  spec.models.map(({ deprecated, name }) => `${name}${deprecated ? ' (deprecated)' : ''}`);
const modelOf = (spec: ApiSpec, name: string): Model => spec.models.find((model) => model.name === name)!;
const fieldOf = (spec: ApiSpec, model: string, field: string): Field =>
  modelOf(spec, model).fields.find(({ name }) => name === field)!;
/** What documents a field: the keys the fold reads from the live copy. */
const docsOf = ({ description, externalDocs, example, examples, extensions }: Field) => ({
  description,
  externalDocs,
  example,
  examples,
  extensions,
});
const undocumented = {
  description: undefined,
  externalDocs: undefined,
  example: undefined,
  examples: undefined,
  extensions: undefined,
};
/** Each field's `description` on `model`, in field order. */
const descriptions = (spec: ApiSpec, model: string) =>
  Object.fromEntries(modelOf(spec, model).fields.map(({ name, description }) => [name, description]));
/** An enum of `spec` as its documentation reads: its text, link, extensions and each member's value and text. */
function enumDocs(spec: ApiSpec, name: string) {
  const { description, externalDocs, extensions, values } = spec.enums.find((e) => e.name === name)!;
  return {
    description,
    externalDocs,
    extensions,
    values: values.map((value) => `${value.value}: ${value.description ?? ''}`),
  };
}

describe('#673 a model a fold makes live takes the live copy’s field documentation', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-673-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  let written = 0;
  async function writeJson(doc: unknown, name = `spec-${written++}`): Promise<string> {
    const file = path.join(tmpDir, `${name}.json`);
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return file;
  }

  async function parseJson(doc: unknown, name?: string): Promise<ApiSpec> {
    return parseSpec(await writeJson(doc, name));
  }

  /** Every `console.warn` message so far, in order. */
  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  /** The exit code `oagen diff --old from --new to` ends with. */
  async function exitCodeOf(from: string, to: string): Promise<number> {
    const error = (await diffCommand({ old: from, new: to }).catch((e: unknown) => e)) as { exitCode: number };
    return error.exitCode;
  }

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    /** `schema` or `null`, described `description`, in the spelling the OpenAPI version has. */
    const nullable = (schema: Doc, description: string): Doc =>
      openapi === '3.0.3'
        ? { ...schema, nullable: true, description }
        : { description, oneOf: [schema, { type: 'null' }] };

    it("reads the issue's repro: `Pet.name` is described `The name.`, as across operations", async () => {
      /** The issue's script: each model with its flag and the description of its `name` field. */
      const output = async (doc: Doc, name: string) => {
        const { models } = await parseJson(doc, name);
        return models.map(({ deprecated, fields, name: model }) => ({
          model: `${model}${deprecated ? ' (deprecated)' : ''}`,
          name: fields.find((field) => field.name === 'name')!.description,
        }));
      };

      // `repro.json`: before, `[ { model: 'Pet', name: 'Use nickname instead.' } ]`.
      expect(await output(within(openapi, deprecatedPet, livePet), 'repro')).toEqual([
        { model: 'Pet', name: 'The name.' },
      ]);
      expect(warnings()).toEqual([]);

      // `two-operations.json`: the yardstick, unchanged.
      expect(await output(across(openapi, deprecatedPet, livePet), 'two-operations')).toEqual([
        { model: 'Pet', name: 'The name.' },
      ]);
      expect(warnings()).toEqual([sharedFold('Pet')]);
    });

    it('gives the same IR whichever status code is declared first, and whichever operation holds the live copy', async () => {
      const forward = await parseJson(within(openapi, deprecatedPet, livePet), 'forward');
      const reversed = await parseJson(
        document(
          openapi,
          getPet([
            [202, livePet],
            [200, deprecatedPet],
          ]),
        ),
        'reversed',
      );
      expect(reversed).toEqual(forward);
      expect(forward.models).toMatchInlineSnapshot(`
        [
          {
            "fields": [
              {
                "default": undefined,
                "deprecated": undefined,
                "name": "object",
                "readOnly": undefined,
                "required": true,
                "type": {
                  "kind": "literal",
                  "value": "pet",
                },
                "writeOnly": undefined,
              },
              {
                "default": undefined,
                "deprecated": undefined,
                "description": "The name.",
                "name": "name",
                "readOnly": undefined,
                "required": false,
                "type": {
                  "kind": "primitive",
                  "type": "string",
                },
                "writeOnly": undefined,
              },
            ],
            "name": "Pet",
          },
        ]
      `);

      // Across operations, the live copy on `getPet` and the deprecated one on `getLegacyPet`.
      const swapped = await parseJson(
        document(openapi, { ...getPet([[200, livePet]]), ...getLegacyPet([[200, deprecatedPet]]) }),
        'swapped',
      );
      expect(declared(swapped)).toEqual(declared(forward));
    });

    it('takes every documentation key of a field from the live copy: text, link, example, examples and extensions', async () => {
      const old = { description: 'Old name.', externalDocs: link('old'), example: 'rex', 'x-label': 'old' };
      const current = {
        description: 'The name.',
        externalDocs: link('names'),
        examples: ['max', 'bo'],
        'x-label': 'new',
        'x-shown': true,
      };
      const spec = await parseJson(within(openapi, pet(true, old), pet(false, current)), 'every-key');
      expect(modelNames(spec)).toEqual(['Pet']);
      expect(fieldOf(spec, 'Pet', 'name')).toEqual({
        name: 'name',
        type: { kind: 'primitive', type: 'string' },
        required: false,
        description: 'The name.',
        externalDocs: link('names'),
        example: 'max',
        examples: ['max', 'bo'],
        extensions: { 'x-label': 'new', 'x-shown': true },
      });
      // Exactly the field the live copy parsed alone gives, and the one two operations give.
      const alone = await parseJson(document(openapi, getPet([[202, pet(false, current)]])), 'alone');
      expect(fieldOf(spec, 'Pet', 'name')).toEqual(fieldOf(alone, 'Pet', 'name'));
      const control = await parseJson(across(openapi, pet(true, old), pet(false, current)), 'every-key-control');
      expect(declared(spec)).toEqual(declared(control));
      expect(warnings()).toEqual([sharedFold('Pet')]);
    });

    it('removes a key only the deprecated copy writes, and adds one only the live copy writes, as the model’s own are', async () => {
      const documented = { description: 'A name.', externalDocs: link('names'), example: 'rex', 'x-label': 'name' };

      // Only the deprecated `200` documents `name`: the live `Pet.name` carries none of it.
      const onlyDeprecated = await parseJson(within(openapi, pet(true, documented), pet(false)), 'only-deprecated');
      expect(docsOf(fieldOf(onlyDeprecated, 'Pet', 'name'))).toEqual(undocumented);
      expect(declared(onlyDeprecated)).toEqual(
        declared(await parseJson(across(openapi, pet(true, documented), pet(false)), 'only-deprecated-control')),
      );

      // Only the live `202` documents it: before, the kept field stayed bare.
      const onlyLive = await parseJson(within(openapi, pet(true), pet(false, documented)), 'only-live');
      expect(docsOf(fieldOf(onlyLive, 'Pet', 'name'))).toEqual({
        description: 'A name.',
        externalDocs: link('names'),
        example: 'rex',
        examples: undefined,
        extensions: { 'x-label': 'name' },
      });
      expect(declared(onlyLive)).toEqual(
        declared(await parseJson(across(openapi, pet(true), pet(false, documented)), 'only-live-control')),
      );
    });

    it('documents the fields as the first live copy in status order does, and never from a deprecated copy', async () => {
      const copy = (deprecated: boolean, text: string) => pet(deprecated, { description: text });
      const named = async (entries: Array<[number, Doc]>, name: string) => {
        const spec = await parseJson(document(openapi, getPet(entries)), name);
        return { models: modelNames(spec), name: fieldOf(spec, 'Pet', 'name').description };
      };

      // Deprecated 200, live 201 and 202: the 201's text, not the 202's.
      expect(
        await named(
          [
            [200, copy(true, 'Old.')],
            [201, copy(false, 'A.')],
            [202, copy(false, 'B.')],
          ],
          'three',
        ),
      ).toEqual({ models: ['Pet'], name: 'A.' });
      // Two deprecated copies before the live one: the 202's.
      expect(
        await named(
          [
            [200, copy(true, 'Old.')],
            [201, copy(true, 'Older.')],
            [202, copy(false, 'B.')],
          ],
          'late',
        ),
      ).toEqual({ models: ['Pet'], name: 'B.' });
      // A live primary keeps its own text; a deprecated later copy's is never read.
      expect(
        await named(
          [
            [200, copy(false, 'The name.')],
            [202, copy(true, 'Use nickname instead.')],
          ],
          'live-primary',
        ),
      ).toEqual({ models: ['Pet'], name: 'The name.' });
      // Both deprecated, or both live: the primary's, as before.
      expect(
        await named(
          [
            [200, copy(true, 'Old.')],
            [202, copy(true, 'Older.')],
          ],
          'both-deprecated',
        ),
      ).toEqual({ models: ['Pet (deprecated)'], name: 'Old.' });
      expect(
        await named(
          [
            [200, copy(false, 'First.')],
            [202, copy(false, 'Second.')],
          ],
          'both-live',
        ),
      ).toEqual({ models: ['Pet'], name: 'First.' });
      expect(warnings()).toEqual([]);
    });

    it('takes the model’s own documentation and its fields’ from the same copy', async () => {
      const spec = await parseJson(
        within(
          openapi,
          pet(
            true,
            { description: 'Use nickname instead.' },
            {},
            { description: 'Old pet.', externalDocs: link('old') },
          ),
          pet(false, { description: 'The name.' }, {}, { description: 'A pet.', 'x-kind': 'pet' }),
        ),
      );
      const { description, externalDocs, extensions } = modelOf(spec, 'Pet');
      expect({ description, externalDocs, extensions }).toEqual({
        description: 'A pet.',
        externalDocs: undefined,
        extensions: { 'x-kind': 'pet' },
      });
      expect(descriptions(spec, 'Pet')).toEqual({ object: undefined, name: 'The name.' });
    });

    it('documents an enum a field lifts as the live copy does: its text, link, extensions and each member’s description', async () => {
      const typed = (label: string): Doc => ({
        status: {
          type: 'string',
          enum: ['active', 'gone'],
          description: `${label} status.`,
          externalDocs: link(label),
          'x-enum-descriptions': [`${label} active`, `${label} gone`],
          'x-group': label,
        },
        // An enum under an array, a map, a union and a nullable wrapper, and one a `oneOf` of consts collapses to.
        sizes: {
          type: 'array',
          description: `${label} sizes.`,
          items: { type: 'string', enum: ['s', 'l'], description: `${label} size.` },
        },
        moods: {
          type: 'object',
          description: `${label} moods.`,
          additionalProperties: { type: 'string', enum: ['up', 'down'], description: `${label} mood.` },
        },
        code: {
          description: `${label} code.`,
          anyOf: [{ type: 'string', enum: ['a', 'b'], description: `${label} letter.` }, { type: 'integer' }],
        },
        kind: {
          description: `${label} kind.`,
          oneOf: [
            { type: 'string', const: 'cat', description: `${label} cat` },
            { type: 'string', const: 'dog', description: `${label} dog` },
          ],
        },
        tone: nullable({ type: 'string', enum: ['warm', 'cold'] }, `${label} tone.`),
      });
      const spec = await parseJson(within(openapi, pet(true, {}, typed('Old')), pet(false, {}, typed('New'))), 'enums');
      expect(warnings()).toEqual([]);
      expect(modelNames(spec)).toEqual(['Pet']);
      expect(descriptions(spec, 'Pet')).toEqual({
        object: undefined,
        name: undefined,
        status: 'New status.',
        sizes: 'New sizes.',
        moods: 'New moods.',
        code: 'New code.',
        kind: 'New kind.',
        tone: 'New tone.',
      });
      // Before: `Old status.`, `Old active`, … — the text of the schema the field's description was just taken from.
      expect(enumDocs(spec, 'PetStatus')).toEqual({
        description: 'New status.',
        externalDocs: link('New'),
        extensions: { 'x-group': 'New' },
        values: ['active: New active', 'gone: New gone'],
      });
      expect(spec.enums.map(({ name, description }) => `${name}: ${description}`).sort()).toEqual(
        [
          'PetStatus: New status.',
          'PetSizes: New size.',
          'PetMoods: New mood.',
          'PetCode: New letter.',
          'PetKind: New kind.',
          'PetTone: New tone.',
        ].sort(),
      );
      expect(enumDocs(spec, 'PetKind').values).toEqual(['cat: New cat', 'dog: New dog']);

      // The yardstick: two operations lift the live copy's enums.
      const control = await parseJson(
        across(openapi, pet(true, {}, typed('Old')), pet(false, {}, typed('New'))),
        'enums-control',
      );
      expect(declared(spec)).toEqual(declared(control));
    });

    it('keeps a nested inline model by its own flag: live in both copies, it stays the primary’s, as the first declared does across operations', async () => {
      const nested = (label: string): Doc => ({
        owner: {
          type: 'object',
          description: `${label} owner.`,
          properties: { name: { type: 'string', description: `${label} owner name.` } },
        },
        tags: {
          type: 'array',
          description: `${label} tags.`,
          items: { type: 'object', properties: { label: { type: 'string', description: `${label} tag label.` } } },
        },
      });
      const spec = await parseJson(
        within(openapi, pet(true, {}, nested('Old')), pet(false, {}, nested('New'))),
        'nested',
      );
      expect(warnings()).toEqual([]);
      expect(modelNames(spec)).toEqual(['Pet', 'PetOwner', 'PetTags']);
      // `Pet`'s own fields are the live copy's, the two that reference the nested models included.
      expect(descriptions(spec, 'Pet')).toEqual({
        object: undefined,
        name: undefined,
        owner: 'New owner.',
        tags: 'New tags.',
      });
      // `deprecated: true` on the `200` body flags `Pet`, not the objects nested in it: `PetOwner` and
      // `PetTags` are live in both copies, so each is the primary's, as any model two live copies share.
      expect(modelOf(spec, 'PetOwner').description).toBe('Old owner.');
      expect(descriptions(spec, 'PetOwner')).toEqual({ name: 'Old owner name.' });
      expect(descriptions(spec, 'PetTags')).toEqual({ label: 'Old tag label.' });

      // The same two bodies on two operations, the deprecated one declared first, read the same.
      const control = await parseJson(
        across(openapi, pet(true, {}, nested('Old')), pet(false, {}, nested('New'))),
        'nested-control',
      );
      expect(declared(spec)).toEqual(declared(control));

      // Two live copies in one operation: nothing is folded by flag, and every model is the primary's.
      const bothLive = await parseJson(
        within(openapi, pet(false, {}, nested('First')), pet(false, {}, nested('Second'))),
        'nested-both-live',
      );
      expect(descriptions(bothLive, 'Pet')).toMatchObject({ owner: 'First owner.', tags: 'First tags.' });
      expect(descriptions(bothLive, 'PetOwner')).toEqual({ name: 'First owner name.' });
    });

    it('documents a nested model deprecated on the `200` only as the `202`’s live copy, fields included', async () => {
      const owner = (deprecated: boolean, label: string): Doc => ({
        owner: {
          type: 'object',
          ...(deprecated ? { deprecated: true } : {}),
          description: `${label} owner.`,
          properties: {
            object: { type: 'string', const: 'owner' },
            name: { type: 'string', description: `${label} owner name.` },
          },
        },
      });
      const spec = await parseJson(
        within(openapi, pet(false, {}, owner(true, 'Old')), pet(false, {}, owner(false, 'New'))),
        'nested-flag',
      );
      // The nested object's flag sits on the field that wrote it, so the two `Pet`s differ in a field and
      // the 200's is kept whole, with the warning; the two `PetOwner`s differ in the model's own flag only.
      expect(modelNames(spec)).toEqual(['Pet', 'PetOwner']);
      expect(fieldOf(spec, 'Pet', 'owner')).toMatchObject({ deprecated: true, description: 'Old owner.' });
      expect(modelOf(spec, 'PetOwner').description).toBe('New owner.');
      // Before: `Old owner name.`, under the `202`'s `New owner.`.
      expect(descriptions(spec, 'PetOwner')).toEqual({ object: undefined, name: 'New owner name.' });
      expect(warnings()).toEqual([
        `[oagen] Warning: Inline model "Pet" from the 202 response has different fields than the 200 response's — using the 200 response's`,
      ]);
    });

    it('leaves the kept definition otherwise as the primary wrote it: field order, types, flags and references', async () => {
      // The live copy declares its properties in another order and documents the pin; the deprecated
      // one names a component where the live one nests an inline object of the component's shape.
      const schemas = { PetOwner: { type: 'object', properties: { id: { type: 'string' } } } };
      const primary = {
        type: 'object',
        deprecated: true,
        required: ['object'],
        properties: {
          object: { type: 'string', const: 'pet' },
          name: { type: 'string', description: 'Use nickname instead.', deprecated: true, maxLength: 8 },
          owner: { allOf: [{ $ref: '#/components/schemas/PetOwner' }], description: 'Old owner.' },
        },
      };
      const later = {
        type: 'object',
        required: ['object'],
        properties: {
          owner: { type: 'object', description: 'The owner.', properties: { id: { type: 'string' } } },
          name: { type: 'string', description: 'The name.', deprecated: true, maxLength: 8 },
          object: { type: 'string', const: 'pet', description: 'Always `pet`.' },
        },
      };
      const spec = await parseJson(within(openapi, primary, later, schemas), 'kept');
      expect(warnings()).toEqual([]);
      expect(modelNames(spec)).toEqual(['PetOwner', 'Pet']);
      expect(modelOf(spec, 'Pet').fields).toEqual([
        { name: 'object', type: { kind: 'literal', value: 'pet' }, required: true, description: 'Always `pet`.' },
        {
          name: 'name',
          type: { kind: 'primitive', type: 'string', constraints: { maxLength: 8 } },
          required: false,
          description: 'The name.',
          deprecated: true,
          constraints: { maxLength: 8 },
        },
        { name: 'owner', type: { kind: 'model', name: 'PetOwner' }, required: false, description: 'The owner.' },
      ]);
      // The component is the document's: the live copy's nested `owner` shares it and never documents it.
      expect(modelOf(spec, 'PetOwner')).toEqual({
        name: 'PetOwner',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: false }],
      });
    });

    it('folds a later body onto an earlier later body’s stem the same way (`GetPetResponse201`)', async () => {
      const plain = { type: 'object', properties: { title: { type: 'string' } } };
      const body = (deprecated: boolean, label: string): Doc => ({
        type: 'object',
        ...(deprecated ? { deprecated: true } : {}),
        description: `${label} body.`,
        properties: { id: { type: 'string', description: `${label} id.` } },
      });
      const stems = (flags: { 201: boolean; 202: boolean }) =>
        document(
          openapi,
          getPet([
            [200, plain],
            [201, body(flags[201], flags[201] ? 'Old' : 'New')],
            [202, body(flags[202], flags[202] ? 'Old' : 'New')],
          ]),
        );
      for (const flags of [
        { 201: true, 202: false },
        { 201: false, 202: true },
      ]) {
        const spec = await parseJson(stems(flags));
        const label = `201 ${flags[201] ? 'deprecated' : 'live'}`;
        expect(modelNames(spec), label).toEqual(['GetPetResponse', 'GetPetResponse201']);
        expect(modelOf(spec, 'GetPetResponse201').description, label).toBe('New body.');
        // Before, with the 201 deprecated: `Old id.` under `New body.`.
        expect(descriptions(spec, 'GetPetResponse201'), label).toEqual({ id: 'New id.' });
      }
      expect(warnings()).toEqual([]);
    });

    it('folds beside a deprecated component of the name the same way: the qualified copy is documented as the live `202`', async () => {
      const spec = await parseJson(
        within(
          openapi,
          pet(true, { description: 'Use nickname instead.' }, {}, { description: 'Old pet.' }),
          pet(false, { description: 'The name.' }, {}, { description: 'A pet.' }),
          { Pet: pet(true, { description: 'The component’s name.' }) },
        ),
      );
      expect(modelNames(spec)).toEqual(['Pet (deprecated)', 'GetPetPet']);
      expect(modelOf(spec, 'GetPetPet').description).toBe('A pet.');
      expect(descriptions(spec, 'GetPetPet')).toEqual({ object: undefined, name: 'The name.' });
      // The component keeps its own text.
      expect(descriptions(spec, 'Pet')).toEqual({ object: undefined, name: 'The component’s name.' });
    });

    describe('copies a deprecated component refuses, sharing one qualified model (`settleRefusedCopies`)', () => {
      const widget = (deprecated: boolean, label?: string): Doc => ({
        type: 'object',
        ...(deprecated ? { deprecated: true } : {}),
        ...(label ? { description: `${label} widget.` } : {}),
        properties: {
          object: { type: 'string', const: 'widget' },
          name: { type: 'string', ...(label ? { description: `${label} name.` } : {}) },
        },
      });
      const component = { Widget: widget(true) };
      const get = (operationId: string, schema: Doc): Doc => ({
        [`/${operationId}/{id}`]: { get: operation(operationId, [[200, schema]]) },
      });
      const documentation = (spec: ApiSpec, name: string) => ({
        description: modelOf(spec, name).description,
        name: fieldOf(spec, name, 'name').description,
      });

      it('documents the shared model as its first live copy is, whichever copy is declared first', async () => {
        // Before: `Old widget.` / `Old name.` on a live `GetLegacyWidgetWidget`, the deprecated first site's text.
        const deprecatedFirst = await parseJson(
          document(
            openapi,
            { ...get('getLegacyWidget', widget(true, 'Old')), ...get('getWidget', widget(false, 'New')) },
            component,
          ),
          'deprecated-first',
        );
        expect(modelNames(deprecatedFirst)).toEqual(['Widget (deprecated)', 'GetLegacyWidgetWidget']);
        expect(documentation(deprecatedFirst, 'GetLegacyWidgetWidget')).toEqual({
          description: 'New widget.',
          name: 'New name.',
        });
        expect(warnings()).toEqual([
          sharedFold('Widget'),
          '[oagen] Renamed inline model "Widget" → "GetLegacyWidgetWidget": it is live while "Widget" is deprecated (shared by 2 sites)',
        ]);

        const liveFirst = await parseJson(
          document(
            openapi,
            { ...get('getWidget', widget(false, 'New')), ...get('getLegacyWidget', widget(true, 'Old')) },
            component,
          ),
          'live-first',
        );
        expect(modelNames(liveFirst)).toEqual(['Widget (deprecated)', 'GetWidgetWidget']);
        expect(documentation(liveFirst, 'GetWidgetWidget')).toEqual({ description: 'New widget.', name: 'New name.' });

        // With no component the two copies share `Widget`, documented the same way.
        const noComponent = await parseJson(
          document(openapi, {
            ...get('getLegacyWidget', widget(true, 'Old')),
            ...get('getWidget', widget(false, 'New')),
          }),
          'no-component',
        );
        expect(modelNames(noComponent)).toEqual(['Widget']);
        expect(documentation(noComponent, 'Widget')).toEqual({ description: 'New widget.', name: 'New name.' });
      });

      it('takes the first live copy’s text of several, removes what only the deprecated copy wrote, and keeps a deprecated cluster’s own', async () => {
        const three = await parseJson(
          document(
            openapi,
            {
              ...get('getLegacyWidget', widget(true, 'Old')),
              ...get('getAWidget', widget(false, 'A')),
              ...get('getBWidget', widget(false, 'B')),
            },
            component,
          ),
          'three',
        );
        expect(modelNames(three)).toEqual(['Widget (deprecated)', 'GetLegacyWidgetWidget']);
        expect(documentation(three, 'GetLegacyWidgetWidget')).toEqual({ description: 'A widget.', name: 'A name.' });

        const bare = await parseJson(
          document(
            openapi,
            { ...get('getLegacyWidget', widget(true, 'Old')), ...get('getWidget', widget(false)) },
            component,
          ),
          'bare',
        );
        expect(modelNames(bare)).toEqual(['Widget (deprecated)', 'GetLegacyWidgetWidget']);
        expect(documentation(bare, 'GetLegacyWidgetWidget')).toEqual({ description: undefined, name: undefined });

        // Every copy deprecated: the first site's own text, as before.
        const allDeprecated = await parseJson(
          document(
            openapi,
            { ...get('getLegacyWidget', widget(true, 'Old')), ...get('getOldWidget', widget(true, 'Older')) },
            component,
          ),
          'all-deprecated',
        );
        expect(modelNames(allDeprecated)).toEqual(['Widget (deprecated)', 'GetLegacyWidgetWidget (deprecated)']);
        expect(documentation(allDeprecated, 'GetLegacyWidgetWidget')).toEqual({
          description: 'Old widget.',
          name: 'Old name.',
        });
      });

      it('takes what a field’s enum lifts from the live copy too, and leaves a nested model to its own flag, as with no component', async () => {
        const detailed = (deprecated: boolean, label: string): Doc => {
          const base = widget(deprecated, label);
          return {
            ...base,
            properties: {
              ...(base.properties as Doc),
              status: {
                type: 'string',
                enum: ['on', 'off'],
                description: `${label} status.`,
                'x-enum-descriptions': [`${label} on`, `${label} off`],
              },
              part: {
                type: 'object',
                description: `${label} part.`,
                properties: { id: { type: 'string', description: `${label} part id.` } },
              },
            },
          };
        };
        const paths = {
          ...get('getLegacyWidget', detailed(true, 'Old')),
          ...get('getWidget', detailed(false, 'New')),
        };
        const read = (spec: ApiSpec, name: string) => ({
          fields: descriptions(spec, name),
          status: enumDocs(spec, 'WidgetStatus'),
          part: { description: modelOf(spec, 'WidgetPart').description, fields: descriptions(spec, 'WidgetPart') },
        });

        const spec = await parseJson(document(openapi, paths, component), 'detailed');
        expect(modelNames(spec)).toEqual(['Widget (deprecated)', 'GetLegacyWidgetWidget', 'WidgetPart']);
        expect(read(spec, 'GetLegacyWidgetWidget')).toEqual({
          fields: { object: undefined, name: 'New name.', status: 'New status.', part: 'New part.' },
          status: {
            description: 'New status.',
            externalDocs: undefined,
            extensions: undefined,
            values: ['on: New on', 'off: New off'],
          },
          // Live in both copies, `WidgetPart` is the first declared's.
          part: { description: 'Old part.', fields: { id: 'Old part id.' } },
        });

        // With no component, the two copies share `Widget`, read the same way.
        const control = await parseJson(document(openapi, paths), 'detailed-control');
        expect(modelNames(control)).toEqual(['WidgetPart', 'Widget']);
        expect(read(control, 'Widget')).toEqual(read(spec, 'GetLegacyWidgetWidget'));
      });

      it('documents a model minted for a deprecated field as the live copy that joins it and makes it live', async () => {
        const owner = (deprecated: boolean, label: string): Doc => ({
          type: 'object',
          ...(deprecated ? { deprecated: true } : {}),
          description: `${label} owner.`,
          properties: { name: { type: 'string', description: `${label} owner name.` } },
        });
        const spec = await parseJson(
          document(
            openapi,
            get('getA', {
              type: 'object',
              properties: { object: { type: 'string', const: 'pet' }, owner: owner(false, 'New') },
            }),
            {
              PetOwner: { type: 'object', deprecated: true, properties: { name: { type: 'string' } } },
              Pet: {
                type: 'object',
                properties: { object: { type: 'string', const: 'pet' }, owner: owner(true, 'Old') },
              },
            },
          ),
          'minted',
        );
        expect(modelNames(spec)).toEqual(['PetOwner (deprecated)', 'Pet', 'GetAPet', 'PetOwner2']);
        // `Pet.owner` keeps its flag and its own text; the model both sites share is live, and documented
        // as the live site wrote it. Before: `Old owner.` / `Old owner name.`.
        expect(fieldOf(spec, 'Pet', 'owner')).toMatchObject({ deprecated: true, description: 'Old owner.' });
        expect(fieldOf(spec, 'GetAPet', 'owner').description).toBe('New owner.');
        expect(modelOf(spec, 'PetOwner2').deprecated).toBeUndefined();
        expect(modelOf(spec, 'PetOwner2').description).toBe('New owner.');
        expect(descriptions(spec, 'PetOwner2')).toEqual({ name: 'New owner name.' });
      });
    });

    it('`oagen diff` reports nothing (exit 0) for deprecating the `200` body, in either direction: documentation is not shape', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const files = {
        // Both bodies live, each with its own text; then the issue's `repro.json`; then the `202` flagged instead.
        live: await writeJson(
          within(openapi, pet(false, { description: 'Use nickname instead.' }), livePet),
          'diff-live',
        ),
        repro: await writeJson(within(openapi, deprecatedPet, livePet), 'diff-repro'),
        swapped: await writeJson(
          within(
            openapi,
            pet(false, { description: 'Use nickname instead.' }),
            pet(true, { description: 'The name.' }),
          ),
          'diff-swapped',
        ),
      };
      for (const [a, b] of [
        ['live', 'repro'],
        ['live', 'swapped'],
        ['repro', 'swapped'],
      ] as const) {
        for (const [from, to] of [
          [a, b],
          [b, a],
        ] as const) {
          expect(
            diffSpecs(await parseSpec(files[from]), await parseSpec(files[to])).changes,
            `${from} → ${to}`,
          ).toEqual([]);
          expect(await exitCodeOf(files[from], files[to]), `${from} → ${to}`).toBe(0);
        }
      }
    });
  });

  describe('takeModelDocumentation', () => {
    const text = (label: string): Field => ({
      name: 'name',
      type: { kind: 'primitive', type: 'string' },
      required: false,
      description: `${label} name.`,
    });

    it('gives a model and each field the other’s documentation keys, removing a key the other lacks, and nothing else', () => {
      const base = { kind: 'model', name: 'Animal' } as const;
      const into: Model = {
        name: 'Pet',
        description: 'Old pet.',
        externalDocs: link('old'),
        deprecated: true,
        bases: [base],
        fields: [
          { ...text('Old'), example: 'rex', examples: ['rex'], extensions: { 'x-old': true }, inheritedFrom: base },
          { name: 'age', type: { kind: 'primitive', type: 'integer' }, required: true, deprecated: true, default: 1 },
        ],
      };
      const from: Model = {
        name: 'Other',
        description: 'A pet.',
        extensions: { 'x-kind': 'pet' },
        fields: [
          {
            name: 'age',
            type: { kind: 'primitive', type: 'integer' },
            required: true,
            deprecated: true,
            default: 1,
            description: 'In years.',
            externalDocs: link('ages'),
          },
          { ...text('New'), examples: ['max'], example: 'max' },
        ],
      };
      const nameType = into.fields[0]!.type;
      takeModelDocumentation(into, from);
      expect(into).toEqual({
        name: 'Pet',
        description: 'A pet.',
        extensions: { 'x-kind': 'pet' },
        deprecated: true,
        bases: [base],
        fields: [
          { ...text('New'), example: 'max', examples: ['max'], inheritedFrom: base },
          {
            name: 'age',
            type: { kind: 'primitive', type: 'integer' },
            required: true,
            deprecated: true,
            default: 1,
            description: 'In years.',
            externalDocs: link('ages'),
          },
        ],
      });
      // The kept field objects and their types are the model's own, edited in place.
      expect(into.fields[0]!.type).toBe(nameType);
      expect(from.fields.map(({ name }) => name)).toEqual(['age', 'name']);
    });

    it('carries what an inline enum lifts — in a field’s type at any depth and in a variant — and leaves alone an enum the other model does not match', () => {
      const members = (label: string) => [
        { value: 'a', description: `${label} a` },
        { value: 'b', description: `${label} b` },
      ];
      const status = (label: string): EnumRef =>
        inlineEnumRef('PetStatus', members(label), link(label), `${label} status.`);
      const kept = {
        direct: status('Old'),
        nested: status('Old'),
        variant: status('Old'),
        lone: status('Old'),
        otherValues: status('Old'),
        otherKind: status('Old'),
      };
      const live = { direct: status('New'), nested: status('New'), variant: status('New') };
      const otherValues = inlineEnumRef('PetStatus', [{ value: 'a' }, { value: 'c' }], undefined, 'Other values.');
      const into: Model = {
        name: 'Pet',
        fields: [
          { name: 'status', type: kept.direct, required: false },
          {
            name: 'history',
            type: { kind: 'nullable', inner: { kind: 'array', items: { kind: 'map', valueType: kept.nested } } },
            required: false,
          },
          { name: 'only', type: kept.lone, required: false, description: 'Only here.' },
          { name: 'values', type: kept.otherValues, required: false },
          { name: 'kind', type: { kind: 'array', items: kept.otherKind }, required: false },
        ],
        variants: [{ kind: 'union', variants: [kept.variant, { kind: 'model', name: 'Cat' }] }],
      };
      const from: Model = {
        name: 'Pet',
        fields: [
          { name: 'status', type: live.direct, required: false },
          {
            name: 'history',
            type: { kind: 'nullable', inner: { kind: 'array', items: { kind: 'map', valueType: live.nested } } },
            required: false,
          },
          { name: 'values', type: otherValues, required: false },
          { name: 'kind', type: { kind: 'map', valueType: status('New') }, required: false },
        ],
        variants: [{ kind: 'union', variants: [live.variant, { kind: 'model', name: 'Cat' }] }],
      };
      takeModelDocumentation(into, from);
      for (const ref of [kept.direct, kept.nested, kept.variant]) {
        expect(inlineEnumDescriptionOf(ref)).toBe('New status.');
        expect(enumValuesOf(ref).map(({ description }) => description)).toEqual(['New a', 'New b']);
      }
      // The references themselves are the kept model's own objects still.
      expect(into.fields[0]!.type).toBe(kept.direct);
      // A field with no namesake on the other model keeps what it has.
      expect(inlineEnumDescriptionOf(kept.lone)).toBe('Old status.');
      expect(into.fields[2]!.description).toBe('Only here.');
      // So does an enum the other model does not hold at the same place: one of other values, or under another kind.
      expect(inlineEnumDescriptionOf(kept.otherValues)).toBe('Old status.');
      expect(enumValuesOf(kept.otherValues).map(({ description }) => description)).toEqual(['Old a', 'Old b']);
      expect(inlineEnumDescriptionOf(kept.otherKind)).toBe('Old status.');
    });
  });
});
