import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { collectModelRefs, collectOperationTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';

/**
 * Issue #630: two success responses of one operation whose inline bodies
 * are pinned by the same `object` const resolve to one model name (`Pet`).
 * `extractResponses` kept the primary body's model and compared a later
 * status code's by `modelFingerprint`, `deprecated` included, so a live
 * `202` body identical to a deprecated `200` body was typed as the
 * deprecated `Pet`, under a "different fields" warning, and `oagen diff`
 * reported the flag flip. The within-operation merge now reads the model's
 * own flag apart, as the merge passes do across operations: the live
 * definition is kept whichever status code declares it, silently, so
 * deprecating one of two identical copies leaves no trace in the IR.
 */

/** The issue's inline body: `{ object: 'pet', name? }`, flagged when `deprecated`, with `extra` properties. */
function pet(deprecated: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'object',
    ...(deprecated ? { deprecated: true } : {}),
    properties: { object: { type: 'string', const: 'pet' }, name: { type: 'string' }, ...extra },
  };
}

/** A Response Object with a JSON body of `schema`. */
function json(schema: Record<string, unknown>): Record<string, unknown> {
  return { description: 'ok', content: { 'application/json': { schema } } };
}

/** A `responses` map declaring `entries` in the given order. */
function responses(entries: Array<[number, Record<string, unknown>]>): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const [code, schema] of entries) map[String(code)] = json(schema);
  return map;
}

/** `GET /pets/{id}` (`getPet`) declaring `entries` as its responses. */
function getPet(entries: Array<[number, Record<string, unknown>]>): Record<string, unknown> {
  return {
    '/pets/{id}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: responses(entries),
      },
    },
  };
}

/** A document on `openapi` with `paths` and the given component schemas. */
function documentWith(openapi: string, paths: Record<string, unknown>, schemas: Record<string, unknown> = {}) {
  return { openapi, info: { title: 'repro', version: '1' }, paths, components: { schemas } };
}

/** The issue's `old.json` (both bodies live) and `new.json` (the `200` body deprecated), plus the other flag combinations. */
function issueDocument(
  openapi: string,
  flags: { 200: boolean; 202: boolean },
  order: [200, 202] | [202, 200] = [200, 202],
) {
  return documentWith(
    openapi,
    getPet(order.map((code) => [code, pet(flags[code])] as [number, Record<string, unknown>])),
  );
}

describe('#630', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-630-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeJson(name: string, doc: unknown): Promise<string> {
    const file = path.join(tmpDir, `${name}.json`);
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return file;
  }

  async function parseJson(doc: unknown, name = 'spec'): Promise<ApiSpec> {
    return parseSpec(await writeJson(name, doc));
  }

  /** Every `console.warn` message so far, in order. */
  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((service) => service.operations);
  /** The issue's output: each model with its flag, and each success response's status code and type name. */
  const modelNames = (spec: ApiSpec) =>
    spec.models.map(({ deprecated, name }) => `${name}${deprecated ? ' (deprecated)' : ''}`);
  const successResponses = (spec: ApiSpec) =>
    operations(spec).flatMap((op) =>
      (op.successResponses ?? []).map(
        ({ statusCode, type }) => `${statusCode}: ${type.kind === 'model' ? type.name : type.kind}`,
      ),
    );

  /** Every model an operation references — its success responses' included — is in `spec.models`. */
  function expectResolved(spec: ApiSpec): void {
    const known = new Set(spec.models.map(({ name }) => name));
    for (const op of operations(spec)) {
      for (const ref of collectOperationTypeRefs(op)) {
        for (const name of collectModelRefs(ref)) expect(known.has(name), name).toBe(true);
      }
    }
  }

  const differentFields = (status: number, kept: number) =>
    `[oagen] Warning: Inline model "Pet" from the ${status} response has different fields than the ${kept} response's — using the ${kept} response's`;

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    it("reads the issue's repro: `Pet` stays live, the 202 keeps its live type, and nothing is warned about", async () => {
      const old = await parseJson(issueDocument(openapi, { 200: false, 202: false }), 'old');
      expect(modelNames(old)).toEqual(['Pet']);
      expect(successResponses(old)).toEqual(['200: Pet', '202: Pet']);

      // The issue's `new.json`: `deprecated: true` on the `200` body only.
      const updated = await parseJson(issueDocument(openapi, { 200: true, 202: false }), 'new');
      expect(modelNames(updated)).toEqual(['Pet']);
      expect(successResponses(updated)).toEqual(['200: Pet', '202: Pet']);
      expect(operations(updated)[0]!.response).toEqual({ kind: 'model', name: 'Pet' });
      expectResolved(updated);
      expect(warnings()).toEqual([]);
    });

    it('keeps the live definition whichever status code declares it, and whichever is declared first', async () => {
      for (const flags of [
        { 200: true, 202: false },
        { 200: false, 202: true },
      ] as const) {
        for (const order of [[200, 202] as const, [202, 200] as const]) {
          const label = `200 ${flags[200] ? 'deprecated' : 'live'}, 202 ${flags[202] ? 'deprecated' : 'live'}, ${order.join(' before ')}`;
          const spec = await parseJson(issueDocument(openapi, flags, [...order] as [200, 202] | [202, 200]));
          expect(modelNames(spec), label).toEqual(['Pet']);
          expect(successResponses(spec), label).toEqual(['200: Pet', '202: Pet']);
          expectResolved(spec);
        }
      }
      expect(warnings()).toEqual([]);
    });

    it('deprecates `Pet` only when both bodies are, still without a warning', async () => {
      for (const order of [[200, 202] as const, [202, 200] as const]) {
        const spec = await parseJson(
          issueDocument(openapi, { 200: true, 202: true }, [...order] as [200, 202] | [202, 200]),
        );
        expect(modelNames(spec), order.join(' before ')).toEqual(['Pet (deprecated)']);
        expect(successResponses(spec), order.join(' before ')).toEqual(['200: Pet', '202: Pet']);
      }
      expect(warnings()).toEqual([]);
    });

    it('keeps `Pet` live when a live 201 sits between a deprecated 200 and a deprecated 202', async () => {
      const spec = await parseJson(
        documentWith(
          openapi,
          getPet([
            [200, pet(true)],
            [201, pet(false)],
            [202, pet(true)],
          ]),
        ),
      );
      expect(modelNames(spec)).toEqual(['Pet']);
      expect(successResponses(spec)).toEqual(['200: Pet', '201: Pet', '202: Pet']);
      expect(warnings()).toEqual([]);
    });

    it('types both status codes as the live qualified copy beside a deprecated component `Pet`', async () => {
      const spec = await parseJson(
        documentWith(
          openapi,
          getPet([
            [200, pet(true)],
            [202, pet(false)],
          ]),
          { Pet: pet(true) },
        ),
      );
      // Before: `GetPetPet (deprecated)`, since the operation's model was the deprecated 200's.
      expect(modelNames(spec)).toEqual(['Pet (deprecated)', 'GetPetPet']);
      expect(successResponses(spec)).toEqual(['200: GetPetPet', '202: GetPetPet']);
      expectResolved(spec);
      expect(warnings()).toEqual([
        '[oagen] Renamed inline model "Pet" → "GetPetPet": it is live while "Pet" is deprecated',
      ]);
    });

    it("still shares a live `Pet` between two operations' copies, with the merge pass's warning", async () => {
      const spec = await parseJson(
        documentWith(openapi, {
          ...getPet([[200, pet(true)]]),
          '/legacy-pets/{id}': {
            get: {
              operationId: 'getLegacyPet',
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: responses([[200, pet(false)]]),
            },
          },
        }),
      );
      expect(modelNames(spec)).toEqual(['Pet']);
      expect(
        operations(spec).map(
          (op) => `${op.name}: ${op.response.kind === 'model' ? op.response.name : op.response.kind}`,
        ),
      ).toEqual(['getPet: Pet', 'getLegacyPet: Pet']);
      expect(warnings()).toEqual([
        '[oagen] Warning: Inline model "Pet" is declared both deprecated and live with the same shape — keeping the live definition under the shared name',
      ]);
    });

    it("keeps the primary's definition, flag included, when the copies differ in a field as well, with the existing warning", async () => {
      // The 202 adds `age`: the 200's deprecated definition is kept.
      const extra = await parseJson(
        documentWith(
          openapi,
          getPet([
            [200, pet(true)],
            [202, pet(false, { age: { type: 'integer' } })],
          ]),
        ),
        'extra',
      );
      expect(modelNames(extra)).toEqual(['Pet (deprecated)']);
      expect(successResponses(extra)).toEqual(['200: Pet', '202: Pet']);
      expect(warnings()).toEqual([differentFields(202, 200)]);

      // The other way round: the live 200 adds `age` and the deprecated 202 does not.
      warn.mockClear();
      const fewer = await parseJson(
        documentWith(
          openapi,
          getPet([
            [200, pet(false, { age: { type: 'integer' } })],
            [202, pet(true)],
          ]),
        ),
        'fewer',
      );
      expect(modelNames(fewer)).toEqual(['Pet']);
      expect(spec_fields(fewer, 'Pet')).toEqual(['object', 'name', 'age']);
      expect(warnings()).toEqual([differentFields(202, 200)]);
    });

    it("keeps the primary's references: a 200 writing `$ref: PetOwner` keeps naming the component when the live 202 nests an inline `owner` of other fields", async () => {
      // Greptile's first-round finding on #647: the two roots are the same
      // shape (both `owner` fields name `PetOwner`), but one reference is an
      // explicit `$ref` and the other an inline object the merge passes
      // rename apart. Swapping in the live copy's object carried its
      // reference into the primary's type; the kept definition now stays.
      const refOwner = { $ref: '#/components/schemas/PetOwner' };
      const inlineOwner = { type: 'object', properties: { email: { type: 'string' } } };
      const schemas = { PetOwner: { type: 'object', properties: { id: { type: 'string' } } } };
      const ownerOf = (spec: ApiSpec): string => {
        const field = spec.models.find(({ name }) => name === 'Pet')!.fields.find(({ name }) => name === 'owner')!;
        return field.type.kind === 'model' ? field.type.name : field.type.kind;
      };
      const renamed =
        '[oagen] Renamed inline model "PetOwner" → "GetPetPetOwner": its shape differs from component schema "PetOwner"';

      // The deprecated 200 writes the `$ref`; the live 202 nests the inline `owner`.
      const refFirst = await parseJson(
        documentWith(
          openapi,
          getPet([
            [200, pet(true, { owner: refOwner })],
            [202, pet(false, { owner: inlineOwner })],
          ]),
          schemas,
        ),
        'ref-first',
      );
      expect(modelNames(refFirst)).toEqual(['PetOwner', 'Pet', 'GetPetPetOwner']);
      expect(ownerOf(refFirst)).toBe('PetOwner');
      expect(successResponses(refFirst)).toEqual(['200: Pet', '202: Pet']);
      expectResolved(refFirst);
      expect(warnings()).toEqual([renamed]);

      // The other way round: the deprecated 200 nests the inline `owner` and the live 202 writes the `$ref`.
      warn.mockClear();
      const inlineFirst = await parseJson(
        documentWith(
          openapi,
          getPet([
            [200, pet(true, { owner: inlineOwner })],
            [202, pet(false, { owner: refOwner })],
          ]),
          schemas,
        ),
        'inline-first',
      );
      expect(modelNames(inlineFirst)).toEqual(['PetOwner', 'Pet', 'GetPetPetOwner']);
      expect(ownerOf(inlineFirst)).toBe('GetPetPetOwner');
      expect(successResponses(inlineFirst)).toEqual(['200: Pet', '202: Pet']);
      expectResolved(inlineFirst);
      expect(warnings()).toEqual([renamed]);
    });

    it("folds a nested `PetOwner` deprecated on the 200 only onto the 202's live copy, under a `Pet.owner` the 200 flags", async () => {
      const owner = (deprecated: boolean) => ({
        type: 'object',
        ...(deprecated ? { deprecated: true } : {}),
        properties: { object: { type: 'string', const: 'owner' }, name: { type: 'string' } },
      });
      const spec = await parseJson(
        documentWith(
          openapi,
          getPet([
            [200, pet(false, { owner: owner(true) })],
            [202, pet(false, { owner: owner(false) })],
          ]),
        ),
      );
      // The nested object's flag sits on the field that wrote it, so the two
      // `Pet`s differ in a field and the 200's is kept, with the warning; the
      // two `PetOwner`s differ in the model's own flag only, so the live one is.
      expect(modelNames(spec)).toEqual(['Pet', 'PetOwner']);
      const petModel = spec.models.find(({ name }) => name === 'Pet')!;
      expect(petModel.fields.find(({ name }) => name === 'owner')).toMatchObject({
        deprecated: true,
        type: { kind: 'model', name: 'PetOwner' },
      });
      expect(successResponses(spec)).toEqual(['200: Pet', '202: Pet']);
      expectResolved(spec);
      expect(warnings()).toEqual([differentFields(202, 200)]);
    });

    describe('unpinned bodies that share a stem', () => {
      const plain = { type: 'object', properties: { name: { type: 'string' } } };
      const other = (deprecated: boolean) => ({
        type: 'object',
        ...(deprecated ? { deprecated: true } : {}),
        properties: { id: { type: 'string' }, owner: { type: 'object', properties: { name: { type: 'string' } } } },
      });
      const stems = (flags: { 201: boolean; 202: boolean }) =>
        documentWith(
          openapi,
          getPet([
            [200, plain],
            [201, other(flags[201])],
            [202, other(flags[202])],
          ]),
        );

      it('a 202 identical to the 201 but for the flag shares `GetPetResponse201`, live in either flag order, deprecated when both are', async () => {
        for (const flags of [
          { 201: false, 202: false },
          { 201: true, 202: false },
          { 201: false, 202: true },
        ] as const) {
          const label = `201 ${flags[201] ? 'deprecated' : 'live'}, 202 ${flags[202] ? 'deprecated' : 'live'}`;
          const spec = await parseJson(stems(flags));
          // Before: a deprecated 201 or 202 took `GetPetResponse202` of its own, deprecating the 201 retyping the 202.
          expect(modelNames(spec), label).toEqual(['GetPetResponse', 'GetPetResponse201', 'GetPetResponse201Owner']);
          expect(successResponses(spec), label).toEqual([
            '200: GetPetResponse',
            '201: GetPetResponse201',
            '202: GetPetResponse201',
          ]);
          expectResolved(spec);
        }
        const both = await parseJson(stems({ 201: true, 202: true }));
        expect(modelNames(both)).toEqual([
          'GetPetResponse',
          'GetPetResponse201 (deprecated)',
          'GetPetResponse201Owner',
        ]);
        expect(successResponses(both)).toEqual([
          '200: GetPetResponse',
          '201: GetPetResponse201',
          '202: GetPetResponse201',
        ]);
        expect(warnings()).toEqual([]);
      });

      it('`oagen diff` reports nothing (exit 0) for either flag flip, in either direction', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const files = {
          live: await writeJson('stems-live', stems({ 201: false, 202: false })),
          dep201: await writeJson('stems-dep201', stems({ 201: true, 202: false })),
          dep202: await writeJson('stems-dep202', stems({ 201: false, 202: true })),
        };
        for (const [a, b] of [
          ['live', 'dep201'],
          ['live', 'dep202'],
          ['dep201', 'dep202'],
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

    it('`oagen diff` reports nothing (exit 0) in either direction for old ↔ new, and the additive flip (exit 1) once both bodies are deprecated', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const files = {
        old: await writeJson('old', issueDocument(openapi, { 200: false, 202: false })),
        new: await writeJson('new', issueDocument(openapi, { 200: true, 202: false })),
        dep202: await writeJson('dep202', issueDocument(openapi, { 200: false, 202: true })),
        both: await writeJson('both', issueDocument(openapi, { 200: true, 202: true })),
      };
      const specs = Object.fromEntries(
        await Promise.all(Object.entries(files).map(async ([label, file]) => [label, await parseSpec(file)])),
      ) as Record<keyof typeof files, ApiSpec>;

      for (const [a, b] of [
        ['old', 'new'],
        ['old', 'dep202'],
        ['new', 'dep202'],
      ] as const) {
        for (const [from, to] of [
          [a, b],
          [b, a],
        ] as const) {
          expect(diffSpecs(specs[from], specs[to]).changes, `${from} → ${to}`).toEqual([]);
          expect(await exitCodeOf(files[from], files[to]), `${from} → ${to}`).toBe(0);
        }
      }

      const flip = (oldDeprecated: boolean) => ({
        kind: 'model-modified',
        name: 'Pet',
        fieldChanges: [],
        deprecatedChanged: true,
        oldDeprecated,
        newDeprecated: !oldDeprecated,
        classification: 'additive',
      });
      for (const other of ['old', 'new', 'dep202'] as const) {
        expect(diffSpecs(specs[other], specs.both).changes, `${other} → both`).toEqual([flip(false)]);
        expect(diffSpecs(specs.both, specs[other]).changes, `both → ${other}`).toEqual([flip(true)]);
        expect(await exitCodeOf(files[other], files.both), `${other} → both`).toBe(1);
        expect(await exitCodeOf(files.both, files[other]), `both → ${other}`).toBe(1);
      }
    });
  });

  /** The exit code `oagen diff --old from --new to` ends with. */
  async function exitCodeOf(from: string, to: string): Promise<number> {
    const error = (await diffCommand({ old: from, new: to }).catch((e: unknown) => e)) as { exitCode: number };
    return error.exitCode;
  }

  /** The field names of `spec`'s model `name`, in order. */
  function spec_fields(spec: ApiSpec, name: string): string[] {
    return spec.models.find((model) => model.name === name)!.fields.map((field) => field.name);
  }
});
