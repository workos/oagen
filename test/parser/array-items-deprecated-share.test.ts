import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { foldLiveCopy } from '../../src/parser/inline-models.js';
import {
  materializeInlineSchema,
  modelFingerprint,
  type InlineModelRegistry,
  type KeptDefinition,
} from '../../src/parser/materialize-inline.js';
import { collectModelRefs, collectOperationTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #672: the items of an array response body are settled against the
 * spec-wide registry as they are read (`typeInlineItems`), and the registry
 * shared an operation's model on an identical fingerprint only, the model's
 * own `deprecated` included. So when one operation's `200` and `202` returned
 * the same inline array and only one body's `items` was deprecated, the
 * `202`'s items stepped to `<Op>ResponseItem` and never reached the fold
 * `extractResponses` gives a copy identical but for the flag (#630):
 * deprecating the items of one of two identical array bodies added a model
 * and retyped the `202`, where the same edit on two object bodies pinned by
 * one `object` const leaves no trace. The items of one operation's success
 * bodies now share the model the operation's earlier body minted when the
 * two are the same shape but for the model's own flag, and the fold is the
 * one the object bodies get (`foldLiveCopy`): the kept definition stays,
 * live while any copy is, documented as the first live copy is.
 */

type Doc = Record<string, unknown>;

const info = { title: 'repro', version: '1' };
const flag = (deprecated: boolean): Doc => (deprecated ? { deprecated: true } : {});

/** The issue's item: `{ name?: string }`, flagged when `deprecated`, with the keys of `extra`. */
const item = (deprecated: boolean, extra: Doc = {}): Doc => ({
  type: 'object',
  ...flag(deprecated),
  ...extra,
  properties: { name: { type: 'string' } },
});
const arrayOf = (items: Doc): Doc => ({ type: 'array', items });
/** A Response Object with a JSON body of `schema`, described `ok` as the issue's are. */
const json = (schema: Doc): Doc => ({ description: 'ok', content: { 'application/json': { schema } } });
/** An Operation Object `operationId` declaring `responses`, with the keys of `extra`. */
const operation = (operationId: string, responses: Doc, extra: Doc = {}): Doc => ({
  get: { operationId, ...extra, responses },
});
/** `GET /pets` (`listPets`) declaring `responses`, with the keys of `extra`. */
const listPets = (responses: Doc, extra: Doc = {}): Doc => ({ '/pets': operation('listPets', responses, extra) });
/** A document on `openapi` with `paths`, and `components.schemas` when any are given. */
const document = (openapi: string, paths: Doc, schemas?: Doc): Doc => ({
  openapi,
  info,
  paths,
  ...(schemas ? { components: { schemas } } : {}),
});
/** `listPets` returning `body(deprecated)` at each status code of `flags`, declared in the order of `flags`. */
const bodies = (openapi: string, body: (deprecated: boolean) => Doc, flags: Array<[number, boolean]>): Doc =>
  document(openapi, listPets(Object.fromEntries(flags.map(([code, deprecated]) => [code, json(body(deprecated))]))));

/** A union of const-pinned, titled variants, which take their titles as names: `Circle` (flagged when `deprecated`) and `Square`. */
const shapes = (deprecated: boolean, extra: Doc = {}): Doc => ({
  oneOf: [
    {
      title: 'Circle',
      type: 'object',
      ...flag(deprecated),
      ...extra,
      required: ['kind'],
      properties: { kind: { type: 'string', const: 'circle' }, radius: { type: 'string' } },
    },
    {
      title: 'Square',
      type: 'object',
      required: ['kind'],
      properties: { kind: { type: 'string', const: 'square' }, side: { type: 'string' } },
    },
  ],
});

/** A type as the tests read it: `ListPetsItem[]`, `{[key]: ListPetsItem}`, `(A | B)`, `ListPetsItem?`. */
function show(type: TypeRef | undefined): string {
  if (!type) return '-';
  switch (type.kind) {
    case 'model':
      return type.name;
    case 'enum':
      return `enum ${type.name}`;
    case 'array':
      return `${show(type.items)}[]`;
    case 'nullable':
      return `${show(type.inner)}?`;
    case 'map':
      return `{[key]: ${show(type.valueType)}}`;
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'literal':
      return JSON.stringify(type.value);
    default:
      return type.type;
  }
}

const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((service) => service.operations);
const operationOf = (spec: ApiSpec, name: string): Operation => operations(spec).find((op) => op.name === name)!;
/** The issue's output: each model with its flag. */
const modelNames = (spec: ApiSpec) =>
  spec.models.map(({ deprecated, name }) => `${name}${deprecated ? ' (deprecated)' : ''}`);
/** The issue's output: each success response's status code and type. */
const successResponses = (spec: ApiSpec, name = 'listPets') =>
  (operationOf(spec, name).successResponses ?? []).map(({ statusCode, type }) => `${statusCode}: ${show(type)}`);
const modelOf = (spec: ApiSpec, name: string): Model => spec.models.find((model) => model.name === name)!;
/** Each field's `description` on `model`, in field order. */
const descriptions = (spec: ApiSpec, model: string) =>
  Object.fromEntries(modelOf(spec, model).fields.map(({ name, description }) => [name, description]));
/** What the issue's script prints for one document. */
const reading = (spec: ApiSpec) => ({ models: modelNames(spec), successResponses: successResponses(spec) });

describe('#672 array bodies whose items differ only in `deprecated` share one item model', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let written = 0;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `oagen diff` prints its report.
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-672-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    log.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeJson(doc: unknown): Promise<string> {
    const file = path.join(tmpDir, `spec-${written++}.json`);
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return file;
  }
  const parseJson = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeJson(doc));
  /** Every `console.warn` message so far, in order. */
  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  /** Every model name is declared once, and every model an operation references is declared. */
  function expectSound(spec: ApiSpec): void {
    const names = spec.models.map(({ name }) => name);
    expect(new Set(names).size, names.join(', ')).toBe(names.length);
    for (const op of operations(spec)) {
      for (const ref of collectOperationTypeRefs(op)) {
        for (const name of collectModelRefs(ref)) expect(names, name).toContain(name);
      }
    }
  }
  /** What `oagen diff --old from --new to` exits with. */
  async function exitCodeOf(from: Doc, to: Doc): Promise<number> {
    const error = (await diffCommand({ old: await writeJson(from), new: await writeJson(to) }).catch(
      (e: unknown) => e,
    )) as { exitCode: number };
    return error.exitCode;
  }
  /** The change kinds `oagen diff` reports from `from` to `to`, each with the name it is about. */
  async function changesOf(from: Doc, to: Doc): Promise<string[]> {
    const { changes } = diffSpecs(await parseJson(from), await parseJson(to));
    return changes.map((change) => {
      const about = change as { name?: string; operationName?: string };
      return `${change.kind} ${about.name ?? about.operationName ?? ''} (${change.classification})`;
    });
  }
  /**
   * `body` at a `200` and a `202` under every flag combination: neither
   * flagged (`old`), the `200`'s (`new`), the `202`'s (`new-202`), both.
   */
  const editsOf = (openapi: string, body: (deprecated: boolean) => Doc, wrap = bodies) => ({
    old: wrap(openapi, body, [
      [200, false],
      [202, false],
    ]),
    new: wrap(openapi, body, [
      [200, true],
      [202, false],
    ]),
    'new-202': wrap(openapi, body, [
      [200, false],
      [202, true],
    ]),
    both: wrap(openapi, body, [
      [200, true],
      [202, true],
    ]),
  });
  /** Deprecating either copy, or moving the flag from one to the other, leaves no trace: the same IR, nothing for `oagen diff`. */
  async function expectNoTrace(documents: ReturnType<typeof editsOf>): Promise<void> {
    const old = await parseJson(documents.old);
    for (const edit of ['new', 'new-202'] as const) {
      const spec = await parseJson(documents[edit]);
      expect(spec, edit).toEqual(old);
      expectSound(spec);
    }
    for (const [from, to] of [
      ['old', 'new'],
      ['new', 'old'],
      ['old', 'new-202'],
      ['new-202', 'old'],
      ['new', 'new-202'],
      ['new-202', 'new'],
    ] as const) {
      expect(await changesOf(documents[from], documents[to]), `${from} → ${to}`).toEqual([]);
      expect(await exitCodeOf(documents[from], documents[to]), `${from} → ${to}`).toBe(0);
    }
    expect(warnings()).toEqual([]);
  }

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    /** The issue's documents: `old.json` (neither flagged), `new.json` (the `200`'s items), `new-202.json` (the `202`'s), and both. */
    const issue = editsOf(openapi, (deprecated) => arrayOf(item(deprecated)));

    describe("the issue's repro", () => {
      it("prints the issue's script output with one `ListPetsItem` for every document", async () => {
        const output: Record<string, unknown> = {};
        for (const [file, doc] of [
          ['old.json', issue.old],
          ['new.json', issue.new],
          ['new-202.json', issue['new-202']],
        ] as const) {
          const spec = await parseJson(doc);
          output[file] = reading(spec);
          expectSound(spec);
        }
        // Before: `new.json` gave `ListPetsItem (deprecated)` + `ListPetsResponseItem`,
        // `new-202.json` gave `ListPetsItem` + `ListPetsResponseItem (deprecated)`, and
        // each typed its `202` as `ListPetsResponseItem[]`.
        expect(output).toMatchInlineSnapshot(`
          {
            "new-202.json": {
              "models": [
                "ListPetsItem",
              ],
              "successResponses": [
                "200: ListPetsItem[]",
                "202: ListPetsItem[]",
              ],
            },
            "new.json": {
              "models": [
                "ListPetsItem",
              ],
              "successResponses": [
                "200: ListPetsItem[]",
                "202: ListPetsItem[]",
              ],
            },
            "old.json": {
              "models": [
                "ListPetsItem",
              ],
              "successResponses": [
                "200: ListPetsItem[]",
                "202: ListPetsItem[]",
              ],
            },
          }
        `);
        expect(warnings()).toEqual([]);
      });

      it('leaves no trace of either edit: the same IR, and `oagen diff` exits 0 in either direction', async () => {
        await expectNoTrace(issue);
      });

      it('deprecates `ListPetsItem` only when both bodies deprecate their items: one additive flip, exit 1', async () => {
        const spec = await parseJson(issue.both);
        expect(reading(spec)).toEqual({
          models: ['ListPetsItem (deprecated)'],
          successResponses: ['200: ListPetsItem[]', '202: ListPetsItem[]'],
        });
        for (const other of ['old', 'new', 'new-202'] as const) {
          expect(await changesOf(issue[other], issue.both), `${other} → both`).toEqual([
            'model-modified ListPetsItem (additive)',
          ]);
          expect(await exitCodeOf(issue[other], issue.both), `${other} → both`).toBe(1);
          expect(await exitCodeOf(issue.both, issue[other]), `both → ${other}`).toBe(1);
        }
        expect(warnings()).toEqual([]);
      });

      it('gives the same IR when the `202` is declared above the `200`', async () => {
        for (const [deprecated200, deprecated202] of [
          [true, false],
          [false, true],
        ]) {
          const declared = (order: number[]) =>
            bodies(
              openapi,
              (deprecated) => arrayOf(item(deprecated)),
              order.map((code) => [code, code === 200 ? deprecated200 : deprecated202] as [number, boolean]),
            );
          expect(await parseJson(declared([202, 200]))).toEqual(await parseJson(declared([200, 202])));
        }
      });

      it('reads the two array bodies as it reads two object bodies pinned by one `object` const', async () => {
        const pinned = (deprecated: boolean): Doc => ({
          ...item(deprecated),
          required: ['object'],
          properties: { object: { type: 'string', const: 'pet' }, name: { type: 'string' } },
        });
        for (const [deprecated200, deprecated202] of [
          [false, false],
          [true, false],
          [false, true],
          [true, true],
        ]) {
          const flags: Array<[number, boolean]> = [
            [200, deprecated200],
            [202, deprecated202],
          ];
          const arrays = await parseJson(bodies(openapi, (deprecated) => arrayOf(item(deprecated)), flags));
          const objects = await parseJson(bodies(openapi, pinned, flags));
          const label = `200 ${deprecated200 ? 'deprecated' : 'live'}, 202 ${deprecated202 ? 'deprecated' : 'live'}`;
          expect(modelNames(arrays), label).toEqual(
            modelNames(objects).map((name) => name.replace('Pet', 'ListPetsItem')),
          );
          expect(successResponses(arrays), label).toEqual(
            successResponses(objects).map((entry) => entry.replace('Pet', 'ListPetsItem[]')),
          );
        }
        expect(warnings()).toEqual([]);
      });
    });

    describe('the shared model is documented as the first live copy is', () => {
      const documented = (text: string) => (deprecated: boolean) =>
        arrayOf({
          type: 'object',
          ...flag(deprecated),
          description: `${text} item.`,
          externalDocs: { url: `https://example.com/${text.toLowerCase()}` },
          'x-kind': text,
          properties: {
            name: { type: 'string', description: `${text} name.`, example: text },
            status: { type: 'string', enum: ['a', 'b'], description: `${text} status.` },
          },
        });
      /** `listPets` returning `Old` items where flagged and `New` ones where not. */
      const mixed = (flags: Array<[number, boolean]>): Doc =>
        document(
          openapi,
          listPets(
            Object.fromEntries(
              flags.map(([code, deprecated]) => [code, json(documented(deprecated ? 'Old' : 'New')(deprecated))]),
            ),
          ),
        );

      it('takes the model’s text, link and extensions, each field’s and the inline enum’s from the live `202`', async () => {
        const spec = await parseJson(
          mixed([
            [200, true],
            [202, false],
          ]),
        );
        expect(reading(spec)).toEqual({
          models: ['ListPetsItem'],
          successResponses: ['200: ListPetsItem[]', '202: ListPetsItem[]'],
        });
        const model = modelOf(spec, 'ListPetsItem');
        expect(model.description).toBe('New item.');
        expect(model.externalDocs).toEqual({ url: 'https://example.com/new' });
        expect(model.extensions).toEqual({ 'x-kind': 'New' });
        expect(descriptions(spec, 'ListPetsItem')).toEqual({ name: 'New name.', status: 'New status.' });
        expect(model.fields[0]!.example).toBe('New');
        expect(spec.enums.map(({ name, description }) => `${name}: ${description}`)).toEqual([
          'ListPetsItemStatus: New status.',
        ]);
        expect(warnings()).toEqual([]);
      });

      it('keeps a live `200`’s own documentation beside a deprecated `202`', async () => {
        const spec = await parseJson(
          mixed([
            [200, false],
            [202, true],
          ]),
        );
        expect(modelOf(spec, 'ListPetsItem').description).toBe('New item.');
        // The live copy is the `200` here; the deprecated `202`'s text is never read.
        expect(descriptions(spec, 'ListPetsItem')).toEqual({ name: 'New name.', status: 'New status.' });
        expect(JSON.stringify(spec)).not.toContain('Old');
      });

      it('removes a key the live copy does not write, as two object bodies do', async () => {
        const spec = await parseJson(
          document(
            openapi,
            listPets({
              '200': json(arrayOf(item(true, { description: 'Old item.', 'x-kind': 'Old' }))),
              '202': json(arrayOf(item(false))),
            }),
          ),
        );
        expect(modelNames(spec)).toEqual(['ListPetsItem']);
        expect(modelOf(spec, 'ListPetsItem')).toEqual({
          name: 'ListPetsItem',
          fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: false }],
        });
      });

      it('documents three status codes’ items as the first live one in status order', async () => {
        const text = (code: number, deprecated: boolean) => arrayOf(item(deprecated, { description: `The ${code}.` }));
        const expected: Record<string, string> = {
          DLL: 'ListPetsItem: The 201.',
          DDL: 'ListPetsItem: The 202.',
          DLD: 'ListPetsItem: The 201.',
          LDL: 'ListPetsItem: The 200.',
          LLD: 'ListPetsItem: The 200.',
          LDD: 'ListPetsItem: The 200.',
          DDD: 'ListPetsItem (deprecated): The 200.',
        };
        for (const [flags, model] of Object.entries(expected)) {
          const spec = await parseJson(
            document(
              openapi,
              listPets(
                Object.fromEntries([200, 201, 202].map((code, i) => [code, json(text(code, flags[i] === 'D'))])),
              ),
            ),
          );
          expect(
            spec.models.map(
              ({ deprecated, description, name }) => `${name}${deprecated ? ' (deprecated)' : ''}: ${description}`,
            ),
            flags,
          ).toEqual([model]);
          expect(successResponses(spec), flags).toEqual([
            '200: ListPetsItem[]',
            '201: ListPetsItem[]',
            '202: ListPetsItem[]',
          ]);
          expectSound(spec);
        }
        expect(warnings()).toEqual([]);
      });

      it('keeps the first body’s definition: its field order and its references', async () => {
        const first = arrayOf({
          type: 'object',
          deprecated: true,
          properties: { owner: { $ref: '#/components/schemas/Owner' }, name: { type: 'string' } },
        });
        const second = arrayOf({
          type: 'object',
          properties: { name: { type: 'string' }, owner: { $ref: '#/components/schemas/Owner' } },
        });
        const spec = await parseJson(
          document(openapi, listPets({ '200': json(first), '202': json(second) }), {
            Owner: { type: 'object', properties: { id: { type: 'string' } } },
          }),
        );
        expect(modelNames(spec)).toEqual(['Owner', 'ListPetsItem']);
        expect(modelOf(spec, 'ListPetsItem').fields.map(({ name, type }) => `${name}: ${show(type)}`)).toEqual([
          'owner: Owner',
          'name: string',
        ]);
        expectSound(spec);
      });
    });

    describe('whatever the items mint', () => {
      const nullable = (schema: Doc): Doc =>
        openapi === '3.0.3' ? { ...schema, nullable: true } : { ...schema, type: ['object', 'null'] };
      const shapesOf: Record<string, { body: (deprecated: boolean) => Doc; old: ReturnType<typeof reading> }> = {
        'an array of arrays': {
          body: (deprecated) => arrayOf(arrayOf(item(deprecated))),
          old: { models: ['ListPetsItem'], successResponses: ['200: ListPetsItem[][]', '202: ListPetsItem[][]'] },
        },
        'an array of maps': {
          body: (deprecated) => arrayOf({ type: 'object', additionalProperties: item(deprecated) }),
          old: {
            models: ['ListPetsItem'],
            successResponses: ['200: {[key]: ListPetsItem}[]', '202: {[key]: ListPetsItem}[]'],
          },
        },
        'nullable items': {
          body: (deprecated) => arrayOf(nullable(item(deprecated))),
          old: { models: ['ListPetsItem'], successResponses: ['200: ListPetsItem?[]', '202: ListPetsItem?[]'] },
        },
        'an item that nests an object': {
          body: (deprecated) =>
            arrayOf({
              type: 'object',
              ...flag(deprecated),
              properties: { owner: item(false), id: { type: 'string' } },
            }),
          old: {
            models: ['ListPetsItem', 'ListPetsItemOwner'],
            successResponses: ['200: ListPetsItem[]', '202: ListPetsItem[]'],
          },
        },
        // The flag of a nested array's items has no field to sit on, so it is the nested model's alone.
        'a nested array whose own items carry the flag': {
          body: (deprecated) =>
            arrayOf({
              type: 'object',
              properties: { owners: arrayOf(item(deprecated)), id: { type: 'string' } },
            }),
          old: {
            models: ['ListPetsItem', 'ListPetsItemOwner'],
            successResponses: ['200: ListPetsItem[]', '202: ListPetsItem[]'],
          },
        },
        'a title-named union variant': {
          body: (deprecated) => arrayOf(shapes(deprecated)),
          old: {
            models: ['Circle', 'Square'],
            successResponses: ['200: (Circle | Square)[]', '202: (Circle | Square)[]'],
          },
        },
        'a union of untitled variants': {
          body: (deprecated) =>
            arrayOf({ oneOf: [item(deprecated), { type: 'object', properties: { side: { type: 'number' } } }] }),
          old: {
            models: ['ListPetsItem', 'ListPetsItemWithSide'],
            successResponses: [
              '200: (ListPetsItem | ListPetsItemWithSide)[]',
              '202: (ListPetsItem | ListPetsItemWithSide)[]',
            ],
          },
        },
        'an item with an inline enum': {
          body: (deprecated) =>
            arrayOf({
              type: 'object',
              ...flag(deprecated),
              properties: { status: { type: 'string', enum: ['a', 'b'] } },
            }),
          old: { models: ['ListPetsItem'], successResponses: ['200: ListPetsItem[]', '202: ListPetsItem[]'] },
        },
      };

      it.each(Object.keys(shapesOf))('%s', async (name) => {
        const { body, old } = shapesOf[name]!;
        const documents = editsOf(openapi, body);
        expect(reading(await parseJson(documents.old))).toEqual(old);
        await expectNoTrace(documents);
      });

      it('the `data` array of a list envelope', async () => {
        const paged = (version: string, body: (deprecated: boolean) => Doc, flags: Array<[number, boolean]>): Doc =>
          document(
            version,
            listPets(Object.fromEntries(flags.map(([code, deprecated]) => [code, json(body(deprecated))])), {
              parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
            }),
          );
        const envelope = (deprecated: boolean): Doc => ({
          type: 'object',
          properties: { data: arrayOf(item(deprecated)), has_more: { type: 'boolean' } },
        });
        const documents = editsOf(openapi, envelope, paged);
        const old = await parseJson(documents.old);
        expect(reading(old)).toEqual({
          models: ['ListPetsItem'],
          successResponses: ['200: ListPetsItem[]', '202: ListPetsItem[]'],
        });
        expect(show(operationOf(old, 'listPets').pagination?.itemType)).toBe('ListPetsItem');
        await expectNoTrace(documents);

        // An envelope's items and an array body's are both `<Op>Item`, so they share it the same way.
        const array = (deprecated: boolean): Doc => arrayOf(item(deprecated));
        for (const [first, second] of [
          [array, envelope],
          [envelope, array],
        ] as const) {
          for (const [deprecated200, deprecated202] of [
            [true, false],
            [false, true],
          ]) {
            const spec = await parseJson(
              document(
                openapi,
                listPets(
                  { '200': json(first(deprecated200)), '202': json(second(deprecated202)) },
                  { parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }] },
                ),
              ),
            );
            expect(reading(spec)).toEqual({
              models: ['ListPetsItem'],
              successResponses: ['200: ListPetsItem[]', '202: ListPetsItem[]'],
            });
          }
        }
      });

      it('a nested model’s flag and the item’s own are each settled on their own model', async () => {
        const body = (root: boolean, nested: boolean): Doc =>
          arrayOf({ type: 'object', ...flag(root), properties: { owners: arrayOf(item(nested)) } });
        // The `200` deprecates the item and the `202` the nested one: each model has a live copy.
        const crossed = await parseJson(
          document(openapi, listPets({ '200': json(body(true, false)), '202': json(body(false, true)) })),
        );
        expect(modelNames(crossed)).toEqual(['ListPetsItem', 'ListPetsItemOwner']);
        // Both bodies deprecate the nested one only.
        const nested = await parseJson(
          document(openapi, listPets({ '200': json(body(false, true)), '202': json(body(false, true)) })),
        );
        expect(modelNames(nested)).toEqual(['ListPetsItem', 'ListPetsItemOwner (deprecated)']);
        expect(warnings()).toEqual([]);
      });
    });

    describe('only the model’s own `deprecated` is read apart', () => {
      it('steps a `202` whose items differ in anything else to `ListPetsResponseItem`, as before', async () => {
        const others: Record<string, Doc> = {
          'a field’s own flag': { type: 'object', properties: { name: { type: 'string', deprecated: true } } },
          'a field’s limit': { type: 'object', properties: { name: { type: 'string', minLength: 1 } } },
          'a field’s type': { type: 'object', properties: { name: { type: 'integer' } } },
          'a field’s requiredness': { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          'the model’s limit': { type: 'object', minProperties: 1, properties: { name: { type: 'string' } } },
          'one more field': { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } },
        };
        for (const [what, other] of Object.entries(others)) {
          for (const deprecated of [false, true]) {
            const spec = await parseJson(
              document(openapi, listPets({ '200': json(arrayOf(item(deprecated))), '202': json(arrayOf(other)) })),
            );
            expect(reading(spec), `${what}, 200 ${deprecated ? 'deprecated' : 'live'}`).toEqual({
              models: [`ListPetsItem${deprecated ? ' (deprecated)' : ''}`, 'ListPetsResponseItem'],
              successResponses: ['200: ListPetsItem[]', '202: ListPetsResponseItem[]'],
            });
            expectSound(spec);
          }
        }
        expect(warnings()).toEqual([]);
      });

      it('steps a `202` whose nested object is deprecated: that flag sits on the item’s field', async () => {
        const body = (deprecated: boolean): Doc =>
          arrayOf({ type: 'object', properties: { owner: item(deprecated), id: { type: 'string' } } });
        const spec = await parseJson(
          document(openapi, listPets({ '200': json(body(false)), '202': json(body(true)) })),
        );
        expect(reading(spec)).toEqual({
          models: [
            'ListPetsItem',
            'ListPetsItemOwner',
            'ListPetsResponseItem',
            'ListPetsResponseItemOwner (deprecated)',
          ],
          successResponses: ['200: ListPetsItem[]', '202: ListPetsResponseItem[]'],
        });
        expect(modelOf(spec, 'ListPetsResponseItem').fields[0]).toMatchObject({ name: 'owner', deprecated: true });
      });

      it('shares a later body’s stepped items with the body after it the same way', async () => {
        // The 201's items are another shape and step to `ListPetsResponseItem`; the 202's repeat them, but for the flag.
        const other = (deprecated: boolean): Doc =>
          arrayOf({ type: 'object', ...flag(deprecated), properties: { id: { type: 'integer' } } });
        for (const [deprecated201, deprecated202] of [
          [true, false],
          [false, true],
        ]) {
          const spec = await parseJson(
            document(
              openapi,
              listPets({
                '200': json(arrayOf(item(false))),
                '201': json(other(deprecated201)),
                '202': json(other(deprecated202)),
              }),
            ),
          );
          expect(reading(spec)).toEqual({
            models: ['ListPetsItem', 'ListPetsResponseItem'],
            successResponses: ['200: ListPetsItem[]', '201: ListPetsResponseItem[]', '202: ListPetsResponseItem[]'],
          });
          expectSound(spec);
        }
      });
    });

    describe('another operation’s model of the name is shared as before, the flag included', () => {
      const listA = (responses: Doc): Doc => ({ '/a': operation('listA', responses) });
      const listB = (responses: Doc): Doc => ({ '/b': operation('listB', responses) });

      it('keeps two operations’ title-named items apart when only one is deprecated, in either path order', async () => {
        const read = async (paths: Doc) => {
          const spec = await parseJson(document(openapi, paths));
          expectSound(spec);
          return {
            models: modelNames(spec),
            listA: show(operationOf(spec, 'listA').response),
            listB: show(operationOf(spec, 'listB').response),
          };
        };
        const a = (deprecated: boolean) => listA({ '200': json(arrayOf(shapes(deprecated))) });
        const b = (deprecated: boolean) => listB({ '200': json(arrayOf(shapes(deprecated))) });
        expect(await read({ ...a(false), ...b(false) })).toEqual({
          models: ['Circle', 'Square'],
          listA: '(Circle | Square)[]',
          listB: '(Circle | Square)[]',
        });
        expect(await read({ ...a(true), ...b(false) })).toEqual({
          models: ['Circle (deprecated)', 'Square', 'CircleListBItem'],
          listA: '(Circle | Square)[]',
          listB: '(CircleListBItem | Square)[]',
        });
        expect(await read({ ...a(false), ...b(true) })).toEqual({
          models: ['Circle', 'Square', 'CircleListBItem (deprecated)'],
          listA: '(Circle | Square)[]',
          listB: '(CircleListBItem | Square)[]',
        });
        expect(await read({ ...b(false), ...a(true) })).toEqual({
          models: ['Circle', 'Square', 'CircleListAItem (deprecated)'],
          listA: '(CircleListAItem | Square)[]',
          listB: '(Circle | Square)[]',
        });
        // `oagen diff` still reports that edit, as it did.
        expect(
          await exitCodeOf(
            document(openapi, { ...a(false), ...b(false) }),
            document(openapi, { ...a(false), ...b(true) }),
          ),
        ).toBe(2);
        expect(warnings()).toEqual([]);
      });

      it('tells two operations apart by what each one minted, not by a qualifier two of them share', async () => {
        // `POST /notes/{id}/pin` and `POST /pets/{id}/pin` are both qualified `ByIdPinPost` under their services.
        const pin = (deprecated: boolean): Doc => ({
          post: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': json(arrayOf(shapes(deprecated))) },
          },
        });
        const spec = await parseJson(document(openapi, { '/notes/{id}/pin': pin(true), '/pets/{id}/pin': pin(false) }));
        expect(modelNames(spec)).toEqual(['Circle (deprecated)', 'Square', 'CirclePetsByIdPinPostItem']);
        expectSound(spec);
      });

      it('reads a folded model in the registry as the IR carries it: live for the operation read after', async () => {
        const folded = (deprecated200: boolean, deprecated202: boolean) =>
          listA({ '200': json(arrayOf(shapes(deprecated200))), '202': json(arrayOf(shapes(deprecated202))) });
        for (const [deprecated200, deprecated202] of [
          [true, false],
          [false, true],
        ]) {
          // `listA`'s copies fold to one live `Circle`; a live `listB` copy shares it …
          const live = await parseJson(
            document(openapi, {
              ...folded(deprecated200, deprecated202),
              ...listB({ '200': json(arrayOf(shapes(false))) }),
            }),
          );
          expect(modelNames(live)).toEqual(['Circle', 'Square']);
          expect(show(operationOf(live, 'listB').response)).toBe('(Circle | Square)[]');
          // … and a deprecated one does not, as beside any other operation's live `Circle`.
          const deprecated = await parseJson(
            document(openapi, {
              ...folded(deprecated200, deprecated202),
              ...listB({ '200': json(arrayOf(shapes(true))) }),
            }),
          );
          expect(modelNames(deprecated)).toEqual(['Circle', 'Square', 'CircleListBItem (deprecated)']);
          expect(successResponses(deprecated, 'listA')).toEqual([
            '200: (Circle | Square)[]',
            '202: (Circle | Square)[]',
          ]);
          expect(show(operationOf(deprecated, 'listB').response)).toBe('(CircleListBItem | Square)[]');
          expectSound(deprecated);
        }
        expect(warnings()).toEqual([]);
      });
    });

    describe('beside a component of the name', () => {
      const flags: Array<[boolean, boolean]> = [
        [true, false],
        [false, true],
      ];
      const beside = (deprecated200: boolean, deprecated202: boolean, component: Doc): Doc =>
        document(
          openapi,
          listPets({ '200': json(arrayOf(item(deprecated200))), '202': json(arrayOf(item(deprecated202))) }),
          { ListPetsItem: component },
        );

      it('shares a live component that admits the items, with the warning a deprecated copy gets, as before', async () => {
        for (const [deprecated200, deprecated202] of flags) {
          warn.mockClear();
          const spec = await parseJson(beside(deprecated200, deprecated202, item(false)));
          expect(reading(spec)).toEqual({
            models: ['ListPetsItem'],
            successResponses: ['200: ListPetsItem[]', '202: ListPetsItem[]'],
          });
          expect(warnings()).toEqual([
            '[oagen] Warning: Inline model "ListPetsItem" is declared both deprecated and live with the same shape — keeping the live definition under the shared name',
          ]);
        }
      });

      it('shares one live `ListPetsResponseItem` beside a deprecated component, which admits no copy', async () => {
        for (const [deprecated200, deprecated202] of flags) {
          const spec = await parseJson(beside(deprecated200, deprecated202, item(true)));
          // Before: `ListPetsResponseItem` for the `200` and `ListPetsItem2` for the `202`, one of them deprecated.
          expect(reading(spec)).toEqual({
            models: ['ListPetsItem (deprecated)', 'ListPetsResponseItem'],
            successResponses: ['200: ListPetsResponseItem[]', '202: ListPetsResponseItem[]'],
          });
          expectSound(spec);
        }
        expect(warnings()).toEqual([]);
      });

      it('shares one live `ListPetsResponseItem` beside a component of another shape', async () => {
        const other = { type: 'object', properties: { other: { type: 'boolean' } } };
        for (const [deprecated200, deprecated202] of flags) {
          const spec = await parseJson(beside(deprecated200, deprecated202, other));
          expect(reading(spec)).toEqual({
            models: ['ListPetsItem', 'ListPetsResponseItem'],
            successResponses: ['200: ListPetsResponseItem[]', '202: ListPetsResponseItem[]'],
          });
          expectSound(spec);
        }
        expect(warnings()).toEqual([]);
      });
    });

    describe('the sites that never shared a model keep their own', () => {
      it('names a `default` and a range body’s items for the response, whatever the flags', async () => {
        for (const [deprecated200, deprecatedOther] of [
          [false, false],
          [true, false],
          [false, true],
        ]) {
          const spec = await parseJson(
            document(
              openapi,
              listPets({
                '200': json(arrayOf(item(deprecated200))),
                default: json(arrayOf(item(deprecatedOther))),
                '2XX': json(arrayOf(item(deprecatedOther))),
              }),
            ),
          );
          const op = operationOf(spec, 'listPets');
          expect(spec.models.map(({ name }) => name)).toEqual([
            'ListPetsItem',
            'ListPetsDefaultResponse',
            'ListPetsSuccessResponse',
          ]);
          expect(show(op.response)).toBe('ListPetsItem[]');
          expect(show(op.defaultResponse?.type)).toBe('ListPetsDefaultResponse[]');
          expect(op.rangeResponses?.map(({ type }) => show(type))).toEqual(['ListPetsSuccessResponse[]']);
        }
      });

      it('names an array request body’s items for each media type, whatever the flags', async () => {
        for (const [deprecatedJson, deprecatedXml] of [
          [false, false],
          [true, false],
          [false, true],
        ]) {
          const spec = await parseJson(
            document(openapi, {
              '/pets': {
                post: {
                  operationId: 'createPets',
                  requestBody: {
                    content: {
                      'application/json': { schema: arrayOf(item(deprecatedJson)) },
                      'application/xml': { schema: arrayOf(item(deprecatedXml)) },
                    },
                  },
                  responses: { '204': { description: 'done' } },
                },
              },
            }),
          );
          expect(modelNames(spec)).toEqual([
            `CreatePetsRequest${deprecatedJson ? ' (deprecated)' : ''}`,
            `CreatePetsApplicationXmlRequest${deprecatedXml ? ' (deprecated)' : ''}`,
          ]);
        }
      });

      it('gives a deprecated header schema a model of its own, the header carrying the flag', async () => {
        const header = (deprecated: boolean): Doc => ({
          description: 'ok',
          headers: { 'X-Meta': { schema: item(deprecated) } },
        });
        const spec = await parseJson(document(openapi, listPets({ '200': header(true), '202': header(false) })));
        expect(modelNames(spec)).toEqual(['PetsXMeta (deprecated)', 'PetsXMeta202']);
        const [first, second] = operationOf(spec, 'listPets').successResponses!;
        expect(first!.headers).toMatchObject([{ name: 'X-Meta', deprecated: true, type: { name: 'PetsXMeta' } }]);
        expect(second!.headers).toMatchObject([{ name: 'X-Meta', type: { name: 'PetsXMeta202' } }]);
      });
    });

    describe('two paths that `$ref` one Path Item read its bodies alike', () => {
      /** `/a` declares `listPets` with `responses`, and `/b` is a `$ref` to that Path Item: one Operation Object, read twice. */
      const sharedPathItem = (responses: Doc, schemas?: Doc): Doc =>
        document(openapi, { '/a': operation('listPets', responses), '/b': { $ref: '#/paths/~1a' } }, schemas);
      const types = (spec: ApiSpec) =>
        operations(spec).map((op) =>
          (op.successResponses ?? []).map(({ statusCode, type }) => `${statusCode}: ${show(type)}`),
        );

      it.each([
        ['both live', false, false, 'ListPetsItem'],
        ['the 200 deprecated', true, false, 'ListPetsItem'],
        ['the 202 deprecated', false, true, 'ListPetsItem'],
        ['both deprecated', true, true, 'ListPetsItem (deprecated)'],
      ])('%s', async (_label, deprecated200, deprecated202, model) => {
        const spec = await parseJson(
          sharedPathItem({ '200': json(arrayOf(item(deprecated200))), '202': json(arrayOf(item(deprecated202))) }),
        );
        // Before, with one body's items deprecated: `ListPetsItem` + `ListPetsResponseItem`, on both paths.
        expect(modelNames(spec)).toEqual([model]);
        expect(types(spec)).toEqual([
          ['200: ListPetsItem[]', '202: ListPetsItem[]'],
          ['200: ListPetsItem[]', '202: ListPetsItem[]'],
        ]);
        expectSound(spec);
        expect(warnings()).toEqual([]);
      });

      it.each([
        ['both live', false, false, false],
        ['the 201 deprecated', true, false, false],
        ['the 202 deprecated', false, true, false],
        ['both deprecated', true, true, true],
      ])('when the items move with a model they nest, %s', async (_label, deprecated201, deprecated202, deprecated) => {
        // The moved item references its moved child (`ListPetsResponse201ItemOwner`); the second path's copy
        // still mints `ListPetsResponseItemOwner`, and is compared with the definition as it settled.
        const nesting = (flagged: boolean): Doc =>
          arrayOf({
            type: 'object',
            ...flag(flagged),
            properties: { owner: { type: 'object', properties: { id: { type: 'string' } } } },
          });
        const spec = await parseJson(
          sharedPathItem(
            {
              '200': json({
                type: 'object',
                properties: { item: { type: 'object', properties: { id: { type: 'integer' } } } },
              }),
              '201': json(nesting(deprecated201)),
              '202': json(nesting(deprecated202)),
            },
            { ListPetsItem: { type: 'object', properties: { other: { type: 'boolean' } } } },
          ),
        );
        expect(modelNames(spec)).toEqual([
          'ListPetsItem',
          'ListPetsResponse',
          'ListPetsResponseItem',
          `ListPetsResponse201Item${deprecated ? ' (deprecated)' : ''}`,
          'ListPetsResponse201ItemOwner',
        ]);
        const read = ['200: ListPetsResponse', '201: ListPetsResponse201Item[]', '202: ListPetsResponse201Item[]'];
        expect(types(spec)).toEqual([read, read]);
        expect(
          modelOf(spec, 'ListPetsResponse201Item').fields.map(({ name, type }) => `${name}: ${show(type)}`),
        ).toEqual(['owner: ListPetsResponse201ItemOwner']);
        expectSound(spec);
        expect(warnings()).toEqual([]);
      });

      it.each([
        ['both live', false, false, false],
        ['the 201 deprecated', true, false, false],
        ['the 202 deprecated', false, true, false],
        ['both deprecated', true, true, true],
      ])('when the items move, %s', async (_label, deprecated201, deprecated202, deprecated) => {
        // As below: the 201's items step to `ListPetsResponseItem`, the name the primary's nested `item` holds, and move.
        const spec = await parseJson(
          sharedPathItem(
            {
              '200': json({
                type: 'object',
                properties: { item: { type: 'object', properties: { id: { type: 'integer' } } } },
              }),
              '201': json(arrayOf(item(deprecated201))),
              '202': json(arrayOf(item(deprecated202))),
            },
            { ListPetsItem: { type: 'object', properties: { other: { type: 'boolean' } } } },
          ),
        );
        expect(modelNames(spec)).toEqual([
          'ListPetsItem',
          'ListPetsResponse',
          'ListPetsResponseItem',
          `ListPetsResponse201Item${deprecated ? ' (deprecated)' : ''}`,
        ]);
        const read = ['200: ListPetsResponse', '201: ListPetsResponse201Item[]', '202: ListPetsResponse201Item[]'];
        expect(types(spec)).toEqual([read, read]);
        expectSound(spec);
      });
    });

    describe('a later body that shared the items follows them when they move', () => {
      // The primary nests an `item` object, `ListPetsResponseItem`, the name the
      // 201's items step to beside a component `ListPetsItem` of another shape:
      // the 201's body then moves to `ListPetsResponse201Item`, and the 202,
      // which shared its model and minted none, was left naming the primary's.
      const moved = (deprecated201: boolean, deprecated202: boolean): Doc =>
        document(
          openapi,
          listPets({
            '200': json({
              type: 'object',
              properties: { item: { type: 'object', properties: { id: { type: 'integer' } } } },
            }),
            '201': json(arrayOf(item(deprecated201))),
            '202': json(arrayOf(item(deprecated202))),
          }),
          { ListPetsItem: { type: 'object', properties: { other: { type: 'boolean' } } } },
        );

      it('leaves a later body that mints a model of the moved name to its own step', async () => {
        // The 202 nests an `item` of its own: `ListPetsResponseItem` is its model, not the 201's it shares.
        const nesting = (property: string): Doc =>
          json({
            type: 'object',
            properties: { item: { type: 'object', properties: { [property]: { type: 'integer' } } } },
          });
        const spec = await parseJson(
          document(
            openapi,
            listPets({ '200': nesting('id'), '201': json(arrayOf(item(false))), '202': nesting('code') }),
            { ListPetsItem: { type: 'object', properties: { other: { type: 'boolean' } } } },
          ),
        );
        expect(reading(spec)).toEqual({
          models: [
            'ListPetsItem',
            'ListPetsResponse',
            'ListPetsResponseItem',
            'ListPetsResponse201Item',
            'ListPetsResponse202',
            'ListPetsResponse202Item',
          ],
          successResponses: ['200: ListPetsResponse', '201: ListPetsResponse201Item[]', '202: ListPetsResponse202'],
        });
        expect(modelOf(spec, 'ListPetsResponse202').fields.map(({ name, type }) => `${name}: ${show(type)}`)).toEqual([
          'item: ListPetsResponse202Item',
        ]);
        expect(modelOf(spec, 'ListPetsResponse202Item').fields.map(({ name }) => name)).toEqual(['code']);
        expectSound(spec);
      });

      it('repoints a later body’s own model that references the moved one', async () => {
        // The 201's variant is titled like the object the primary nests under `shape`, so it moves; the 202's
        // own item model holds the same variant in a field.
        const variants = {
          oneOf: [
            {
              title: 'ListPetsResponseShape',
              type: 'object',
              required: ['kind'],
              properties: { kind: { type: 'string', const: 'round' }, radius: { type: 'string' } },
            },
            {
              title: 'Other',
              type: 'object',
              required: ['kind'],
              properties: { kind: { type: 'string', const: 'other' }, side: { type: 'string' } },
            },
          ],
        };
        const spec = await parseJson(
          document(
            openapi,
            listPets({
              '200': json({
                type: 'object',
                properties: { shape: { type: 'object', properties: { id: { type: 'integer' } } } },
              }),
              '201': json(arrayOf(variants)),
              '202': json(arrayOf({ type: 'object', properties: { inner: variants } })),
            }),
          ),
        );
        expect(successResponses(spec)).toEqual([
          '200: ListPetsResponse',
          '201: (ListPetsResponse201Shape | Other)[]',
          '202: ListPetsItem[]',
        ]);
        expect(modelOf(spec, 'ListPetsItem').fields.map(({ name, type }) => `${name}: ${show(type)}`)).toEqual([
          'inner: (ListPetsResponse201Shape | Other)',
        ]);
        expect(modelOf(spec, 'ListPetsResponseShape').fields.map(({ name }) => name)).toEqual(['id']);
        expect(modelOf(spec, 'ListPetsResponse201Shape').fields.map(({ name }) => name)).toEqual(['kind', 'radius']);
        expectSound(spec);
      });

      it.each([
        ['both live', false, false, false],
        ['the 201 deprecated', true, false, false],
        ['the 202 deprecated', false, true, false],
        ['both deprecated', true, true, true],
      ])('%s', async (_label, deprecated201, deprecated202, deprecated) => {
        const spec = await parseJson(moved(deprecated201, deprecated202));
        expect(reading(spec)).toEqual({
          models: [
            'ListPetsItem',
            'ListPetsResponse',
            'ListPetsResponseItem',
            `ListPetsResponse201Item${deprecated ? ' (deprecated)' : ''}`,
          ],
          successResponses: [
            '200: ListPetsResponse',
            '201: ListPetsResponse201Item[]',
            '202: ListPetsResponse201Item[]',
          ],
        });
        expect(modelOf(spec, 'ListPetsResponseItem').fields.map(({ name }) => name)).toEqual(['id']);
        expect(modelOf(spec, 'ListPetsResponse201Item').fields.map(({ name }) => name)).toEqual(['name']);
        expectSound(spec);
        expect(warnings()).toEqual([]);
      });
    });
  });

  describe('foldLiveCopy', () => {
    const str = { kind: 'primitive' as const, type: 'string' as const };
    const model = (deprecated: boolean, text: string): Model => ({
      name: 'ListPetsItem',
      ...(deprecated ? { deprecated: true } : {}),
      description: `${text} item.`,
      fields: [{ name: 'name', type: str, required: false, description: `${text} name.` }],
    });

    it('makes a deprecated definition live and documents it as the live copy is', () => {
      const kept = model(true, 'Old');
      expect(foldLiveCopy(kept, model(false, 'New'))).toBe(true);
      expect(kept).toEqual(model(false, 'New'));
    });

    it('changes nothing for a deprecated copy, or once the definition is live', () => {
      const deprecated = model(true, 'Old');
      expect(foldLiveCopy(deprecated, model(true, 'Other'))).toBe(false);
      expect(deprecated).toEqual(model(true, 'Old'));

      const live = model(false, 'First');
      expect(foldLiveCopy(live, model(true, 'Old'))).toBe(false);
      expect(foldLiveCopy(live, model(false, 'Second'))).toBe(false);
      expect(live).toEqual(model(false, 'First'));
    });
  });

  describe('materializeInlineSchema — the definitions an operation keeps (`kept`)', () => {
    const stem = (index: number): string => (index === 0 ? 'ListPetsItem' : `ListPetsItem${index + 1}`);
    const schema = (deprecated: boolean, text: string): Doc => item(deprecated, { description: text });
    /** Settle `first` then `second` as one operation's sites, with `kept` when given. */
    function settle(first: Doc, second: Doc, kept?: Map<string, KeptDefinition>) {
      const registry: InlineModelRegistry = new Map();
      const models: Model[] = [];
      const options = { stem, registry, operation: 'ListPets', models, ...(kept && { kept }) };
      const types = [materializeInlineSchema(first, options), materializeInlineSchema(second, options)];
      return { registry, models, types: types.map(show) };
    }

    it('shares the kept definition with a copy identical but for the flag, and folds the copy onto it', () => {
      const kept = new Map<string, KeptDefinition>();
      const { registry, models, types } = settle(schema(true, 'Old item.'), schema(false, 'New item.'), kept);
      expect(types).toEqual(['ListPetsItem', 'ListPetsItem']);
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({ name: 'ListPetsItem', description: 'New item.' });
      expect(models[0]!.deprecated).toBeUndefined();
      expect(kept.get('ListPetsItem')!.model).toBe(models[0]);
      // The registry reads the model as it now is.
      expect([...registry.keys()]).toEqual(['ListPetsItem']);
      expect(registry.get('ListPetsItem')).toEqual({
        fingerprint: modelFingerprint(models[0]!),
        operation: 'ListPets',
      });
    });

    it('keeps a live definition as it is beside a deprecated copy', () => {
      const kept = new Map<string, KeptDefinition>();
      const { models, types } = settle(schema(false, 'New item.'), schema(true, 'Old item.'), kept);
      expect(types).toEqual(['ListPetsItem', 'ListPetsItem']);
      expect(models).toEqual([expect.objectContaining({ name: 'ListPetsItem', description: 'New item.' })]);
      expect(models[0]!.deprecated).toBeUndefined();
    });

    it('replaces the registry entry rather than editing it, so a copy of the registry keeps what it read', () => {
      const kept = new Map<string, KeptDefinition>();
      const registry: InlineModelRegistry = new Map();
      const models: Model[] = [];
      const options = { stem, registry, operation: 'ListPets', models, kept };
      materializeInlineSchema(schema(true, 'Old item.'), options);
      const snapshot = new Map(registry);
      const before = { ...snapshot.get('ListPetsItem')! };
      materializeInlineSchema(schema(false, 'New item.'), options);
      expect(snapshot.get('ListPetsItem')).toEqual(before);
      expect(registry.get('ListPetsItem')).not.toEqual(before);
    });

    it('steps the copy to the next stem without `kept`, as every other site does', () => {
      const { models, types } = settle(schema(true, 'Old item.'), schema(false, 'New item.'));
      expect(types).toEqual(['ListPetsItem', 'ListPetsItem2']);
      expect(models.map(({ deprecated, name }) => `${name}${deprecated ? ' (deprecated)' : ''}`)).toEqual([
        'ListPetsItem (deprecated)',
        'ListPetsItem2',
      ]);
    });

    it('steps past a name another operation minted: it is in no map of this operation’s', () => {
      const registry: InlineModelRegistry = new Map();
      const models: Model[] = [];
      // The same qualifier on purpose: the map, not the name, tells the operations apart.
      const first = materializeInlineSchema(schema(true, 'Old item.'), {
        stem,
        registry,
        operation: 'ListPets',
        models,
        kept: new Map(),
      });
      const second = materializeInlineSchema(schema(false, 'New item.'), {
        stem,
        registry,
        operation: 'ListPets',
        models,
        kept: new Map(),
      });
      expect([first, second].map(show)).toEqual(['ListPetsItem', 'ListPetsItem2']);
      expect(models[0]!.deprecated).toBe(true);
    });

    it('reads a definition under the name it settled on, even once the caller has renamed the model', () => {
      const kept = new Map<string, KeptDefinition>();
      const registry: InlineModelRegistry = new Map();
      const models: Model[] = [];
      const options = { stem, registry, operation: 'ListPets', models, kept };
      materializeInlineSchema(schema(true, 'Old item.'), options);
      models[0]!.name = 'ListPetsResponse201Item';
      // The registry still files it as `ListPetsItem`, so the copy shares it there; the caller repoints the site.
      expect(show(materializeInlineSchema(schema(false, 'New item.'), options))).toBe('ListPetsItem');
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({ name: 'ListPetsResponse201Item', description: 'New item.' });
      expect(models[0]!.deprecated).toBeUndefined();
    });

    it('compares a copy with the definition as it settled, whatever its nested models are called since', () => {
      // An item that nests an `owner`: `ListPetsItem { owner: ListPetsItemOwner }`.
      const nesting = (deprecated: boolean): Doc => ({
        type: 'object',
        ...flag(deprecated),
        properties: { owner: { type: 'object', properties: { id: { type: 'string' } } } },
      });
      const kept = new Map<string, KeptDefinition>();
      const registry: InlineModelRegistry = new Map();
      const models: Model[] = [];
      const options = { stem, registry, operation: 'ListPets', models, kept };
      materializeInlineSchema(nesting(true), options);
      expect(models.map(({ name }) => name).sort()).toEqual(['ListPetsItem', 'ListPetsItemOwner']);
      // The caller moves both, as a later status code's step does: the root now references the moved child.
      const [root, owner] = [kept.get('ListPetsItem')!.model, kept.get('ListPetsItemOwner')!.model];
      root.name = 'ListPetsResponse201Item';
      owner.name = 'ListPetsResponse201ItemOwner';
      root.fields[0]!.type = { kind: 'model', name: owner.name };

      // The same schema read again mints the names it settled on, and still shares the definition.
      expect(show(materializeInlineSchema(nesting(false), options))).toBe('ListPetsItem');
      expect(models).toHaveLength(2);
      expect(root.deprecated).toBeUndefined();
      // The registry files the definition as it settled: an identical copy shares it too.
      expect(show(materializeInlineSchema(nesting(false), options))).toBe('ListPetsItem');
      expect(show(materializeInlineSchema(nesting(true), options))).toBe('ListPetsItem');
      expect(models).toHaveLength(2);
    });

    describe('in the settling pass, where a clash no stem can move renames in place', () => {
      const num = { kind: 'primitive' as const, type: 'number' as const };
      const titled = (title: string, kind: string, properties: Doc, deprecated = false): Doc => ({
        type: 'object',
        title,
        ...flag(deprecated),
        properties: { kind: { type: 'string', const: kind }, ...properties },
      });
      /** A body whose nested `shape` union holds a `Circle` no reservation reaches, a `Square` and an `owners` array. */
      const body = (deprecated: { square?: boolean; owner?: boolean }): Doc => ({
        type: 'object',
        properties: {
          shape: {
            oneOf: [
              titled('Circle', 'circle', { diameter: { type: 'number' } }),
              titled('Square', 'square', { side: { type: 'number' } }, deprecated.square),
            ],
          },
          owners: arrayOf({ type: 'object', ...flag(!!deprecated.owner), properties: { id: { type: 'string' } } }),
        },
      });
      const bodyStem = (index: number): string => (index === 0 ? 'Body' : `Body${index + 1}`);
      /** A component `Circle` of another shape. */
      const circle: Model = { name: 'Circle', fields: [{ name: 'radius', type: num, required: false }] };
      const flags = (models: Model[]) =>
        models.map(({ deprecated, name }) => `${name}${deprecated ? ' (deprecated)' : ''}`).sort();

      it('keeps a kept twin shared when another model of the trial is renamed under the root', () => {
        const registry: InlineModelRegistry = new Map([[circle.name, { fingerprint: modelFingerprint(circle) }]]);
        const models: Model[] = [];
        const options = { stem: bodyStem, registry, operation: 'Op', models, kept: new Map<string, KeptDefinition>() };
        expect(show(materializeInlineSchema(body({ square: true }), options))).toBe('Body');
        expect(flags(models)).toEqual(['Body', 'BodyCircle', 'BodyOwner', 'Square (deprecated)']);

        // The second site's `Circle` is renamed under its own root; its live `Square` still shares the kept one.
        expect(show(materializeInlineSchema(body({ square: false }), options))).toBe('Body2');
        expect(flags(models)).toEqual([
          'Body',
          'Body2',
          'Body2Circle',
          'Body2Owner',
          'BodyCircle',
          'BodyOwner',
          'Square',
        ]);
      });

      it('keeps a kept twin under the old root’s name when the root moves', () => {
        // Minted once without the component, so the registered `Body` still points at `Circle`.
        const first: InlineModelRegistry = new Map();
        const minted: Model[] = [];
        const kept = new Map<string, KeptDefinition>();
        materializeInlineSchema(body({ owner: true }), { stem: bodyStem, registry: first, models: minted, kept });
        expect(flags(minted)).toEqual(['Body', 'BodyOwner (deprecated)', 'Circle', 'Square']);
        // Then `Circle` is a component's, of another shape; `Body` and `BodyOwner` stay this operation's.
        const registry: InlineModelRegistry = new Map([
          [circle.name, { fingerprint: modelFingerprint(circle) }],
          ['Body', first.get('Body')!],
          ['BodyOwner', first.get('BodyOwner')!],
        ]);
        kept.delete('Circle');
        kept.delete('Square');
        const models: Model[] = [];

        const type = materializeInlineSchema(body({ owner: false }), { stem: bodyStem, registry, models, kept });

        // Renaming `Circle` under the root changes `Body`, which moves to `Body2` with it; `BodyOwner` stays shared and goes live.
        expect(show(type)).toBe('Body2');
        expect(flags(models)).toEqual(['Body2', 'Body2Circle', 'Square']);
        expect(models.find(({ name }) => name === 'Body2')!.fields.map(({ type: t }) => show(t))).toEqual([
          '(Body2Circle | Square)',
          'BodyOwner[]',
        ]);
        expect(kept.get('BodyOwner')!.model.deprecated).toBeUndefined();
        expect(registry.get('BodyOwner')!.fingerprint).toBe(modelFingerprint(kept.get('BodyOwner')!.model));
      });
    });

    it('still steps a copy that differs in a field’s own flag', () => {
      const kept = new Map<string, KeptDefinition>();
      const flagged = { type: 'object', properties: { name: { type: 'string', deprecated: true } } };
      const { types } = settle(schema(true, 'Old item.'), flagged, kept);
      expect(types).toEqual(['ListPetsItem', 'ListPetsItem2']);
    });
  });
});
