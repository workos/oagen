import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffCommand } from '../../src/cli/diff.js';
import { CommandError } from '../../src/errors.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { callbackContext } from '../../src/ir/types.js';
import { numberedName, toPascalCase } from '../../src/utils/naming.js';
import type { ApiSpec, Callback, TypeRef, Webhook } from '../../src/ir/types.js';

/**
 * Issue #634: two callbacks whose title-mapped variants `Shape` differ each
 * move the variant model under their own stem, but the inline enum inside
 * it (`ShapeSize`) embeds no stem and nothing renamed an enum reference, so
 * it was warned about and left to the collectors, which number the second
 * `ShapeSize2` in declaration order: swapping the callbacks swapped the two
 * enums' values. A contested inline enum name now moves under each group's
 * stem as a contested model does.
 */

type Document = Record<string, unknown>;

const EXPRESSION = '{$request.body#/callbackUrl}';
const info = { title: 'repro', version: '1' };
const json = (schema: unknown) => ({ 'application/json': { schema } });
const size = (...values: string[]) => ({ type: 'string', enum: values });

/** A title-mapped variant: titled, pinning `kind`, with `fields` of its own. */
const titled = (title: string, kind: string, fields: Record<string, unknown>) => ({
  title,
  type: 'object',
  properties: { kind: { type: 'string', const: kind }, ...fields },
});
const second = (title: string, kind: string) => titled(title, kind, { text: { type: 'string' } });

/** The issue's two `Shape` variants, keyed by callback. */
const shapes = {
  petAdopted: titled('Shape', 'shape', { sides: { type: 'integer' }, size: size('small', 'large') }),
  petReturned: titled('Shape', 'shape', { radius: { type: 'number' }, size: size('tiny', 'huge') }),
};
/** The issue's payloads: a `oneOf` whose first variant is titled `Shape`, the second `Note` or `Memo`. */
const payloads: Record<string, unknown> = {
  petAdopted: { oneOf: [shapes.petAdopted, second('Note', 'note')] },
  petReturned: { oneOf: [shapes.petReturned, second('Memo', 'memo')] },
};

/** A received operation: a JSON body of `schema` answered with a bare 204, with `extra` on the operation. */
const receiving = (schema: unknown, extra: Record<string, unknown> = {}) => ({
  ...extra,
  requestBody: { content: json(schema) },
  responses: { '204': { description: 'No content' } },
});
/** A Callback Object posting `schema` to `{$request.body#/callbackUrl}`. */
const posting = (schema: unknown, extra: Record<string, unknown> = {}) => ({
  [EXPRESSION]: { post: receiving(schema, extra) },
});
/** A path item whose `post` takes `{ callbackUrl }`, answers 201 and declares `callbacks`. */
const registering = (operationId: string, callbacks: Record<string, unknown>) => ({
  post: {
    operationId,
    requestBody: { content: json({ type: 'object', properties: { callbackUrl: { type: 'string' } } }) },
    responses: { '201': { description: 'Created' } },
    callbacks,
  },
});

/** The issue's document: `POST /pets` (`createPet`) declaring the callbacks of `order`, each posting its payload. */
function issueDocument(
  openapi: string,
  order: string[],
  from: Record<string, unknown> = payloads,
  rest: Record<string, unknown> = {},
): Document {
  const callbacks = Object.fromEntries(order.map((key) => [key, posting(from[key])]));
  return { openapi, info, paths: { '/pets': registering('createPet', callbacks) }, ...rest };
}

/** A type reference as one word: a model's or enum's name, a union's variants, a primitive's type. */
function typeName(ref: TypeRef | undefined): string {
  if (!ref) return '-';
  switch (ref.kind) {
    case 'model':
    case 'enum':
      return ref.name;
    case 'union':
      return ref.variants.map(typeName).join(' | ');
    case 'array':
      return `${typeName(ref.items)}[]`;
    case 'nullable':
      return `${typeName(ref.inner)}?`;
    case 'map':
      return `{${typeName(ref.valueType)}}`;
    case 'literal':
      return JSON.stringify(ref.value);
    case 'primitive':
      return ref.type;
    default:
      return (ref as { kind: string }).kind;
  }
}

/** The issue's script: every enum with its values, every model named `…Shape` with its fields, an enum field typed. */
function issueOutput({ enums, models }: ApiSpec) {
  return {
    enums: enums.map(({ name, values }) => `${name} [${values.map(({ value }) => value).join(', ')}]`),
    models: models
      .filter(({ name }) => name.endsWith('Shape'))
      .map(
        ({ fields, name }) =>
          `${name} { ${fields.map((f) => (f.type.kind === 'enum' ? `${f.name}: ${f.type.name}` : f.name)).join(', ')} }`,
      ),
  };
}

/**
 * Every model with its typed fields and every enum with its values, each
 * list sorted by name: what a reorder must not change. The owners' own
 * `…Request` models are left out.
 */
function names({ enums, models }: ApiSpec) {
  return {
    enums: enums.map(({ name, values }) => `${name} [${values.map(({ value }) => value).join(', ')}]`).sort(),
    models: models
      .filter(({ name }) => !name.endsWith('Request'))
      .map(({ fields, name }) => `${name} { ${fields.map((f) => `${f.name}: ${typeName(f.type)}`).join(', ')} }`)
      .sort(),
  };
}

/** A `oneOf` of a variant titled `Shape` with `fields` and a second one titled `other`. */
const shaped = (fields: Record<string, unknown>, other = 'Note') => ({
  oneOf: [titled('Shape', 'shape', fields), second(other, other.toLowerCase())],
});

/** Every callback of every operation and webhook, nested ones included, as `key: payload`. */
function received(spec: ApiSpec): string[] {
  const lines: string[] = [];
  const visit = (node: Webhook | Callback, label: string): void => {
    const params = [...node.headerParams, ...node.queryParams, ...(node.cookieParams ?? [])];
    lines.push(
      [`${label}: ${typeName(node.requestBody)}`, ...params.map((p) => `${p.name}=${typeName(p.type)}`)].join(' '),
    );
    for (const callback of node.callbacks ?? []) visit(callback, `${label}>${callback.name}`);
  };
  for (const webhook of spec.webhooks ?? []) visit(webhook, `webhooks.${webhook.name}`);
  for (const { operations } of spec.services) {
    for (const operation of operations) {
      for (const callback of operation.callbacks ?? []) visit(callback, `${operation.name}>${callback.name}`);
    }
  }
  return lines.sort();
}

describe('#634 a contested inline enum moves under its callback stem', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let files = 0;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-callback-inline-enum-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    log.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(doc: Document): Promise<string> {
    const file = path.join(tmpDir, `spec-${files++}.json`);
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return file;
  }

  /** Parse a document, validating that every reference names a model or enum the IR declares. */
  async function parse(doc: Document): Promise<ApiSpec> {
    const spec = await parseSpec(await write(doc));
    validateModelRefs(spec);
    return spec;
  }

  /** `oagen diff --old <before> --new <after>`: its exit code and each change as `kind name (classification)`. */
  async function diff(before: Document, after: Document): Promise<{ exit: number; changes: string[] }> {
    const [oldFile, newFile] = [await write(before), await write(after)];
    log.mockClear();
    const error = await diffCommand({ old: oldFile, new: newFile }).catch((thrown: unknown) => thrown);
    if (!(error instanceof CommandError)) throw error;
    const report = JSON.parse(String(log.mock.calls.at(-1)![0])) as {
      changes: Array<{ kind: string; name?: string; classification: string }>;
    };
    return {
      exit: error.exitCode,
      changes: report.changes.map(({ kind, name, classification }) => `${kind} ${name} (${classification})`),
    };
  }

  /**
   * Parse the document `build` makes of `order` and of `order` reversed:
   * the names and what every callback references agree, `oagen diff`
   * between the two reports nothing in either direction, and nothing
   * warns. Returns the first parse.
   */
  async function eitherOrder(
    build: (order: string[]) => Document,
    order: string[] = ['petAdopted', 'petReturned'],
  ): Promise<ApiSpec> {
    const [forward, backward] = [build(order), build([...order].reverse())];
    const spec = await parse(forward);
    const reversed = await parse(backward);
    expect(names(reversed)).toEqual(names(spec));
    expect(received(reversed)).toEqual(received(spec));
    expect(await diff(forward, backward)).toEqual({ exit: 0, changes: [] });
    expect(await diff(backward, forward)).toEqual({ exit: 0, changes: [] });
    expect(warn).not.toHaveBeenCalled();
    return spec;
  }

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    const oldDocument = () => issueDocument(openapi, ['petAdopted', 'petReturned']);
    const newDocument = () => issueDocument(openapi, ['petReturned', 'petAdopted']);
    /** `createPet` declaring the callbacks of `from`, in the order asked for. */
    const declaring =
      (from: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
      (order: string[]): Document =>
        issueDocument(openapi, order, from, rest);

    it("the issue's repro: each enum is named under its own callback's stem, in either order", async () => {
      expect(issueOutput(await parse(oldDocument()))).toEqual({
        enums: ['CreatePetPetAdoptedShapeSize [small, large]', 'CreatePetPetReturnedShapeSize [tiny, huge]'],
        models: [
          'CreatePetPetAdoptedShape { kind, sides, size: CreatePetPetAdoptedShapeSize }',
          'CreatePetPetReturnedShape { kind, radius, size: CreatePetPetReturnedShapeSize }',
        ],
      });
      expect(issueOutput(await parse(newDocument()))).toEqual({
        enums: ['CreatePetPetReturnedShapeSize [tiny, huge]', 'CreatePetPetAdoptedShapeSize [small, large]'],
        models: [
          'CreatePetPetReturnedShape { kind, radius, size: CreatePetPetReturnedShapeSize }',
          'CreatePetPetAdoptedShape { kind, sides, size: CreatePetPetAdoptedShapeSize }',
        ],
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("the issue's diff: reordering the callbacks changes nothing, exit 0", async () => {
      expect(await diff(oldDocument(), newDocument())).toEqual({ exit: 0, changes: [] });
      expect(await diff(newDocument(), oldDocument())).toEqual({ exit: 0, changes: [] });
      expect(warn).not.toHaveBeenCalled();
    });

    it('three callbacks: every permutation gives the same three enums', async () => {
      const from = {
        ...payloads,
        petLost: shaped({ depth: { type: 'number' }, size: size('mini', 'maxi') }, 'Log'),
      };
      const orders = [
        ['petAdopted', 'petReturned', 'petLost'],
        ['petAdopted', 'petLost', 'petReturned'],
        ['petReturned', 'petAdopted', 'petLost'],
        ['petReturned', 'petLost', 'petAdopted'],
        ['petLost', 'petAdopted', 'petReturned'],
        ['petLost', 'petReturned', 'petAdopted'],
      ];
      const [first, ...rest] = await Promise.all(orders.map((order) => parse(declaring(from)(order))));
      for (const spec of rest) expect(names(spec)).toEqual(names(first!));
      expect(names(first!)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetAdoptedShapeSize [small, large]",
            "CreatePetPetLostShapeSize [mini, maxi]",
            "CreatePetPetReturnedShapeSize [tiny, huge]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", sides: integer, size: CreatePetPetAdoptedShapeSize }",
            "CreatePetPetLostShape { kind: "shape", depth: number, size: CreatePetPetLostShapeSize }",
            "CreatePetPetReturnedShape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize }",
            "Log { kind: "log", text: string }",
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
          ],
        }
      `);
      expect(warn).not.toHaveBeenCalled();
    });

    it('an enum nested two levels down moves with the nested model that holds it', async () => {
      const meta = (...values: string[]) => ({ type: 'object', properties: { size: size(...values) } });
      const spec = await eitherOrder(
        declaring({
          petAdopted: shaped({ meta: meta('small', 'large') }),
          petReturned: shaped({ meta: meta('tiny', 'huge') }, 'Memo'),
        }),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetAdoptedShapeMetaSize [small, large]",
            "CreatePetPetReturnedShapeMetaSize [tiny, huge]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", meta: CreatePetPetAdoptedShapeMeta }",
            "CreatePetPetAdoptedShapeMeta { size: CreatePetPetAdoptedShapeMetaSize }",
            "CreatePetPetReturnedShape { kind: "shape", meta: CreatePetPetReturnedShapeMeta }",
            "CreatePetPetReturnedShapeMeta { size: CreatePetPetReturnedShapeMetaSize }",
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
          ],
        }
      `);
    });

    it("an enum in an array's items, in a map's values and under a nullable wrapper moves too", async () => {
      // A nullable enum as each version spells it.
      const maybe = (...values: string[]) =>
        openapi.startsWith('3.0')
          ? { type: 'string', nullable: true, enum: values }
          : { type: ['string', 'null'], enum: [...values, null] };
      const fields = (...values: string[]) => ({
        sizes: { type: 'array', items: size(...values) },
        bySize: { type: 'object', additionalProperties: size(...values) },
        maybe: maybe(...values),
      });
      const spec = await eitherOrder(
        declaring({
          petAdopted: shaped(fields('small', 'large')),
          petReturned: shaped(fields('tiny', 'huge'), 'Memo'),
        }),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetAdoptedShapeBySize [small, large]",
            "CreatePetPetAdoptedShapeMaybe [small, large]",
            "CreatePetPetAdoptedShapeSizes [small, large]",
            "CreatePetPetReturnedShapeBySize [tiny, huge]",
            "CreatePetPetReturnedShapeMaybe [tiny, huge]",
            "CreatePetPetReturnedShapeSizes [tiny, huge]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", sizes: CreatePetPetAdoptedShapeSizes[], bySize: {CreatePetPetAdoptedShapeBySize}, maybe: CreatePetPetAdoptedShapeMaybe? }",
            "CreatePetPetReturnedShape { kind: "shape", sizes: CreatePetPetReturnedShapeSizes[], bySize: {CreatePetPetReturnedShapeBySize}, maybe: CreatePetPetReturnedShapeMaybe? }",
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
          ],
        }
      `);
    });

    it('variants that differ only in the enum values still move, the model and the enum', async () => {
      const spec = await eitherOrder(
        declaring({
          petAdopted: shaped({ size: size('small', 'large') }),
          petReturned: shaped({ size: size('tiny', 'huge') }, 'Memo'),
        }),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetAdoptedShapeSize [small, large]",
            "CreatePetPetReturnedShapeSize [tiny, huge]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", size: CreatePetPetAdoptedShapeSize }",
            "CreatePetPetReturnedShape { kind: "shape", size: CreatePetPetReturnedShapeSize }",
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
          ],
        }
      `);
    });

    it('the same values with another member deprecated are two enums, each keeping its own flag', async () => {
      const members = (deprecated: boolean) => ({
        oneOf: [{ const: 'small' }, { const: 'large', ...(deprecated ? { deprecated: true } : {}) }],
      });
      const spec = await eitherOrder(
        declaring({
          petAdopted: shaped({ size: members(false) }),
          petReturned: shaped({ size: members(true) }, 'Memo'),
        }),
      );
      expect(names(spec).enums).toEqual([
        'CreatePetPetAdoptedShapeSize [small, large]',
        'CreatePetPetReturnedShapeSize [small, large]',
      ]);
      const deprecated = (name: string) =>
        spec.enums.find((e) => e.name === name)!.values.map((value) => value.deprecated === true);
      expect(deprecated('CreatePetPetAdoptedShapeSize')).toEqual([false, false]);
      expect(deprecated('CreatePetPetReturnedShapeSize')).toEqual([false, true]);
    });

    it('the same members written in another order are two enums, each as written', async () => {
      const spec = await eitherOrder(
        declaring({
          petAdopted: shaped({ size: size('small', 'large') }),
          petReturned: shaped({ size: size('large', 'small') }, 'Memo'),
        }),
      );
      expect(names(spec).enums).toEqual([
        'CreatePetPetAdoptedShapeSize [small, large]',
        'CreatePetPetReturnedShapeSize [large, small]',
      ]);
    });

    it('differing variants whose enums agree keep the one enum', async () => {
      const spec = await eitherOrder(
        declaring({
          petAdopted: shaped({ sides: { type: 'integer' }, size: size('small', 'large') }),
          petReturned: shaped({ radius: { type: 'number' }, size: size('small', 'large') }, 'Memo'),
        }),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "ShapeSize [small, large]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", sides: integer, size: ShapeSize }",
            "CreatePetPetReturnedShape { kind: "shape", radius: number, size: ShapeSize }",
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
          ],
        }
      `);
    });

    it('identical variants stay one model and one enum', async () => {
      const spec = await eitherOrder(
        declaring({
          petAdopted: payloads.petAdopted,
          petReturned: { oneOf: [shapes.petAdopted, second('Memo', 'memo')] },
        }),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "ShapeSize [small, large]",
          ],
          "models": [
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
            "Shape { kind: "shape", sides: integer, size: ShapeSize }",
          ],
        }
      `);
    });

    it('two of three callbacks agreeing: every callback minting the contested name moves, as the models do', async () => {
      const from = { ...payloads, petLost: { oneOf: [shapes.petAdopted, second('Log', 'log')] } };
      const spec = await eitherOrder(declaring(from), ['petReturned', 'petAdopted', 'petLost']);
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetAdoptedShapeSize [small, large]",
            "CreatePetPetLostShapeSize [small, large]",
            "CreatePetPetReturnedShapeSize [tiny, huge]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", sides: integer, size: CreatePetPetAdoptedShapeSize }",
            "CreatePetPetLostShape { kind: "shape", sides: integer, size: CreatePetPetLostShapeSize }",
            "CreatePetPetReturnedShape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize }",
            "Log { kind: "log", text: string }",
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
          ],
        }
      `);
    });

    it("a parameter's union and a secondary media type's are held to the same rule", async () => {
      const body = (name: string) => ({ type: 'object', properties: { [name]: { type: 'string' } } });
      const viaParameter = (schema: unknown, name: string) =>
        posting(body(name), { parameters: [{ name: 'X-Filter', in: 'header', schema }] });
      const viaSecondary = (schema: unknown, name: string) => ({
        [EXPRESSION]: {
          post: {
            requestBody: { content: { ...json(body(name)), 'application/xml': { schema } } },
            responses: { '204': { description: 'No content' } },
          },
        },
      });
      for (const via of [viaParameter, viaSecondary]) {
        const all: Record<string, unknown> = {
          petAdopted: via(payloads.petAdopted, 'a'),
          petReturned: via(payloads.petReturned, 'b'),
        };
        const spec = await eitherOrder((order) => ({
          openapi,
          info,
          paths: { '/pets': registering('createPet', Object.fromEntries(order.map((key) => [key, all[key]]))) },
        }));
        expect(names(spec).enums).toEqual([
          'CreatePetPetAdoptedShapeSize [small, large]',
          'CreatePetPetReturnedShapeSize [tiny, huge]',
        ]);
        expect(names(spec).models).toEqual(
          expect.arrayContaining([
            'CreatePetPetAdoptedShape { kind: "shape", sides: integer, size: CreatePetPetAdoptedShapeSize }',
            'CreatePetPetReturnedShape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize }',
          ]),
        );
      }
    });

    it('a parent callback, its nested callback and a sibling each take their own stem', async () => {
      const lost = shaped({ depth: { type: 'number' }, size: size('mini', 'maxi') }, 'Log');
      const spec = await eitherOrder(
        (order) => {
          const all: Record<string, unknown> = {
            petAdopted: posting(payloads.petAdopted, { callbacks: { confirmed: posting(payloads.petReturned) } }),
            other: posting(lost),
          };
          return {
            openapi,
            info,
            paths: { '/pets': registering('createPet', Object.fromEntries(order.map((key) => [key, all[key]]))) },
          };
        },
        ['petAdopted', 'other'],
      );
      expect(names(spec).enums).toEqual([
        'CreatePetOtherShapeSize [mini, maxi]',
        'CreatePetPetAdoptedConfirmedShapeSize [tiny, huge]',
        'CreatePetPetAdoptedShapeSize [small, large]',
      ]);
      expect(received(spec)).toEqual([
        'createPet>other: CreatePetOtherShape | Log',
        'createPet>petAdopted: CreatePetPetAdoptedShape | Note',
        'createPet>petAdopted>confirmed: CreatePetPetAdoptedConfirmedShape | Memo',
      ]);
    });

    it("two owners' callbacks, and a webhook's own two callbacks", async () => {
      const owners = await eitherOrder(
        (order) => {
          const all: Record<string, unknown> = {
            '/pets': registering('createPet', { changed: posting(payloads.petAdopted) }),
            '/dogs': registering('createDog', { changed: posting(payloads.petReturned) }),
          };
          return { openapi, info, paths: Object.fromEntries(order.map((key) => [key, all[key]])) };
        },
        ['/pets', '/dogs'],
      );
      expect(names(owners).enums).toEqual([
        'CreateDogChangedShapeSize [tiny, huge]',
        'CreatePetChangedShapeSize [small, large]',
      ]);

      const hooked = await eitherOrder((order) => ({
        openapi,
        info,
        paths: {},
        webhooks: {
          petEvent: {
            post: receiving(
              { type: 'object', properties: { id: { type: 'string' } } },
              { callbacks: Object.fromEntries(order.map((key) => [key, posting(payloads[key])])) },
            ),
          },
        },
      }));
      expect(names(hooked)).toMatchInlineSnapshot(`
        {
          "enums": [
            "PetEventPetAdoptedShapeSize [small, large]",
            "PetEventPetReturnedShapeSize [tiny, huge]",
          ],
          "models": [
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
            "PetEventPayload { id: string }",
            "PetEventPetAdoptedShape { kind: "shape", sides: integer, size: PetEventPetAdoptedShapeSize }",
            "PetEventPetReturnedShape { kind: "shape", radius: number, size: PetEventPetReturnedShapeSize }",
          ],
        }
      `);
    });

    it("a shared callback's two sites reference the one renamed model, whichever site comes first", async () => {
      const spec = await eitherOrder(
        (order) => {
          const all: Record<string, unknown> = {
            '/pets': registering('createPet', {
              changed: { $ref: '#/components/callbacks/Changed' },
              other: posting(payloads.petReturned),
            }),
            '/dogs': registering('createDog', { changed: { $ref: '#/components/callbacks/Changed' } }),
          };
          return {
            openapi,
            info,
            paths: Object.fromEntries(order.map((key) => [key, all[key]])),
            components: { callbacks: { Changed: posting(payloads.petAdopted, { operationId: 'onChanged' }) } },
          };
        },
        ['/pets', '/dogs'],
      );
      expect(names(spec).enums).toEqual(['CreatePetOtherShapeSize [tiny, huge]', 'OnChangedShapeSize [small, large]']);
      expect(received(spec)).toEqual([
        'createDog>changed: OnChangedShape | Note',
        'createPet>changed: OnChangedShape | Note',
        'createPet>other: CreatePetOtherShape | Memo',
      ]);
    });

    it('a replacement steps around a name a component already holds, model or enum', async () => {
      const component = (name: string) => `#/components/schemas/${name}`;
      const spec = await eitherOrder(
        declaring(payloads, {
          components: {
            schemas: {
              CreatePetPetAdoptedShapeSize: size('p', 'q'),
              CreatePetPetReturnedShapeSize: { type: 'object', properties: { z: { type: 'string' } } },
              Holder: {
                type: 'object',
                properties: {
                  a: { $ref: component('CreatePetPetAdoptedShapeSize') },
                  b: { $ref: component('CreatePetPetReturnedShapeSize') },
                },
              },
            },
          },
        }),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetAdoptedShapeSize [p, q]",
            "CreatePetPetAdoptedShapeSize2 [small, large]",
            "CreatePetPetReturnedShapeSize2 [tiny, huge]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", sides: integer, size: CreatePetPetAdoptedShapeSize2 }",
            "CreatePetPetReturnedShape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize2 }",
            "CreatePetPetReturnedShapeSize { z: string }",
            "Holder { a: CreatePetPetAdoptedShapeSize, b: CreatePetPetReturnedShapeSize }",
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
          ],
        }
      `);
    });

    it('a `$ref` to a component enum of the contested name stays on the component', async () => {
      const other = { $ref: '#/components/schemas/ShapeSize' };
      const spec = await eitherOrder(
        declaring(
          {
            petAdopted: shaped({ size: size('small', 'large'), other }),
            petReturned: shaped({ size: size('tiny', 'huge'), other }, 'Memo'),
          },
          { components: { schemas: { ShapeSize: size('x', 'y') } } },
        ),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetAdoptedShapeSize [small, large]",
            "CreatePetPetReturnedShapeSize [tiny, huge]",
            "ShapeSize [x, y]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", size: CreatePetPetAdoptedShapeSize, other: ShapeSize }",
            "CreatePetPetReturnedShape { kind: "shape", size: CreatePetPetReturnedShapeSize, other: ShapeSize }",
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
          ],
        }
      `);
    });

    it("the enum's description, link, extensions and value descriptions go with it", async () => {
      const spec = await parse(
        declaring({
          petAdopted: shaped({
            size: {
              ...size('small', 'large'),
              description: 'How big the adopted pet is.',
              externalDocs: { url: 'https://example.com/adopted-sizes' },
              'x-enum-descriptions': ['Fits a carrier.', 'Needs a crate.'],
              'x-audience': 'adopters',
            },
          }),
          petReturned: shaped(
            { size: { ...size('tiny', 'huge'), description: 'How big the returned pet is.' } },
            'Memo',
          ),
        })(['petAdopted', 'petReturned']),
      );
      expect(spec.enums).toMatchInlineSnapshot(`
        [
          {
            "description": "How big the adopted pet is.",
            "extensions": {
              "x-audience": "adopters",
            },
            "externalDocs": {
              "url": "https://example.com/adopted-sizes",
            },
            "name": "CreatePetPetAdoptedShapeSize",
            "values": [
              {
                "description": "Fits a carrier.",
                "name": "SMALL",
                "value": "small",
              },
              {
                "description": "Needs a crate.",
                "name": "LARGE",
                "value": "large",
              },
            ],
          },
          {
            "description": "How big the returned pet is.",
            "name": "CreatePetPetReturnedShapeSize",
            "values": [
              {
                "name": "TINY",
                "value": "tiny",
              },
              {
                "name": "HUGE",
                "value": "huge",
              },
            ],
          },
        ]
      `);
      expect(warn).not.toHaveBeenCalled();
    });

    it('a model and an inline enum under one contested name both move, the enum to the next free name', async () => {
      // Each callback titles a second variant `ShapeSize`, the name its
      // `Shape.size` enum takes.
      const both = (values: string[], own: string) => ({
        oneOf: [
          titled('Shape', 'shape', { size: size(...values) }),
          titled('ShapeSize', 'size', { [own]: { type: 'integer' } }),
        ],
      });
      const spec = await eitherOrder(
        declaring({ petAdopted: both(['small', 'large'], 'width'), petReturned: both(['tiny', 'huge'], 'height') }),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetAdoptedShapeSize2 [small, large]",
            "CreatePetPetReturnedShapeSize2 [tiny, huge]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", size: CreatePetPetAdoptedShapeSize2 }",
            "CreatePetPetAdoptedShapeSize { kind: "size", width: integer }",
            "CreatePetPetReturnedShape { kind: "shape", size: CreatePetPetReturnedShapeSize2 }",
            "CreatePetPetReturnedShapeSize { kind: "size", height: integer }",
          ],
        }
      `);
    });

    it('a model the callbacks agree on beside enums of its name they do not: the name is still contested', async () => {
      // Both callbacks title a second variant `ShapeSize` with the same
      // fields; only the `Shape.size` enums of that name differ.
      const both = (...values: string[]) => ({
        oneOf: [
          titled('Shape', 'shape', { size: size(...values) }),
          titled('ShapeSize', 'size', { width: { type: 'integer' } }),
        ],
      });
      const spec = await eitherOrder(
        declaring({ petAdopted: both('small', 'large'), petReturned: both('tiny', 'huge') }),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetAdoptedShapeSize2 [small, large]",
            "CreatePetPetReturnedShapeSize2 [tiny, huge]",
          ],
          "models": [
            "CreatePetPetAdoptedShape { kind: "shape", size: CreatePetPetAdoptedShapeSize2 }",
            "CreatePetPetAdoptedShapeSize { kind: "size", width: integer }",
            "CreatePetPetReturnedShape { kind: "shape", size: CreatePetPetReturnedShapeSize2 }",
            "CreatePetPetReturnedShapeSize { kind: "size", width: integer }",
          ],
        }
      `);
    });

    it("one callback's model beside another's inline enum of the name: each moves under its own stem", async () => {
      const spec = await eitherOrder(
        declaring({
          petAdopted: { oneOf: [titled('ShapeSize', 'size', { width: { type: 'integer' } }), second('Note', 'note')] },
          petReturned: payloads.petReturned,
        }),
      );
      expect(names(spec)).toMatchInlineSnapshot(`
        {
          "enums": [
            "CreatePetPetReturnedShapeSize [tiny, huge]",
          ],
          "models": [
            "CreatePetPetAdoptedShapeSize { kind: "size", width: integer }",
            "Memo { kind: "memo", text: string }",
            "Note { kind: "note", text: string }",
            "Shape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize }",
          ],
        }
      `);
    });

    it('adding the second callback moves the first one off the shared names, model and enum together', async () => {
      const one = issueDocument(openapi, ['petAdopted']);
      expect(names(await parse(one))).toEqual({
        enums: ['ShapeSize [small, large]'],
        models: ['Note { kind: "note", text: string }', 'Shape { kind: "shape", sides: integer, size: ShapeSize }'],
      });
      // The same edit already renamed the first callback's `Shape`; its
      // enum now goes with it, wherever the new callback is declared.
      const expected = {
        exit: 2,
        changes: [
          'model-added CreatePetPetAdoptedShape (additive)',
          'model-added CreatePetPetReturnedShape (additive)',
          'model-added Memo (additive)',
          'model-removed Shape (breaking)',
          'enum-added CreatePetPetAdoptedShapeSize (additive)',
          'enum-added CreatePetPetReturnedShapeSize (additive)',
          'enum-removed ShapeSize (breaking)',
          // Additive since #753: the payload moved to a model with every field of `Shape`.
          'callback-modified petAdopted (additive)',
          'callback-added petReturned (additive)',
        ],
      };
      const sorted = ({ exit, changes }: { exit: number; changes: string[] }) => ({
        exit,
        changes: [...changes].sort(),
      });
      expect(sorted(await diff(one, oldDocument()))).toEqual(sorted(expected));
      expect(sorted(await diff(one, newDocument()))).toEqual(sorted(expected));
      expect(warn).not.toHaveBeenCalled();
    });

    describe('beside a webhook', () => {
      /** A `webhooks` entry posting `schema`. */
      const hook = (schema: unknown, extra: Record<string, unknown> = {}) => ({ post: receiving(schema, extra) });
      const lost = shaped({ depth: { type: 'number' }, size: size('mini', 'maxi') }, 'Log');

      /** `createPet` declaring `callbacks` beside `webhooks`, written before `paths` or after it. */
      const besides = (webhooks: Record<string, unknown>, callbacks: string[], webhooksFirst: boolean): Document => {
        const { paths } = issueDocument(openapi, callbacks);
        return webhooksFirst ? { openapi, info, webhooks, paths } : { openapi, info, paths, webhooks };
      };

      it("a callback's `Shape` parted from the webhook's takes its `size` enum with it, whichever map is written first", async () => {
        // #631 holds the webhook's `Shape` and renames the callback's; the
        // callback's enum used to stay `ShapeSize` and was numbered
        // `ShapeSize2` after the webhook's.
        const webhooks = { petAdopted: hook(payloads.petAdopted) };
        const [first, last] = [besides(webhooks, ['petReturned'], true), besides(webhooks, ['petReturned'], false)];
        const spec = await parse(first);
        expect(names(spec)).toMatchInlineSnapshot(`
          {
            "enums": [
              "CreatePetPetReturnedShapeSize [tiny, huge]",
              "ShapeSize [small, large]",
            ],
            "models": [
              "CreatePetPetReturnedShape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize }",
              "Memo { kind: "memo", text: string }",
              "Note { kind: "note", text: string }",
              "Shape { kind: "shape", sides: integer, size: ShapeSize }",
            ],
          }
        `);
        expect(received(spec)).toEqual([
          'createPet>petReturned: CreatePetPetReturnedShape | Memo',
          'webhooks.petAdopted: Shape | Note',
        ]);
        expect(names(await parse(last))).toEqual(names(spec));
        expect(await diff(first, last)).toEqual({ exit: 0, changes: [] });
        expect(await diff(last, first)).toEqual({ exit: 0, changes: [] });
        // Nothing is merged away: no "more than one definition".
        expect(warn).not.toHaveBeenCalled();
      });

      it("of two callbacks, the one posting the webhook's shape shares its model and enum and the other moves with its own, in every order", async () => {
        const webhooks = { petLost: hook({ oneOf: [shapes.petAdopted, second('Log', 'log')] }) };
        const documents = [true, false].flatMap((webhooksFirst) =>
          [
            ['petAdopted', 'petReturned'],
            ['petReturned', 'petAdopted'],
          ].map((callbacks) => besides(webhooks, callbacks, webhooksFirst)),
        );
        const [spec, ...others] = await Promise.all(documents.map(parse));
        expect(names(spec!)).toMatchInlineSnapshot(`
          {
            "enums": [
              "CreatePetPetReturnedShapeSize [tiny, huge]",
              "ShapeSize [small, large]",
            ],
            "models": [
              "CreatePetPetReturnedShape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize }",
              "Log { kind: "log", text: string }",
              "Memo { kind: "memo", text: string }",
              "Note { kind: "note", text: string }",
              "Shape { kind: "shape", sides: integer, size: ShapeSize }",
            ],
          }
        `);
        expect(received(spec!)).toEqual([
          'createPet>petAdopted: Shape | Note',
          'createPet>petReturned: CreatePetPetReturnedShape | Memo',
          'webhooks.petLost: Shape | Log',
        ]);
        for (const other of others) expect(names(other)).toEqual(names(spec!));
        for (const other of documents.slice(1))
          expect(await diff(documents[0]!, other)).toEqual({ exit: 0, changes: [] });
        expect(warn).not.toHaveBeenCalled();
      });

      it("a callback's `Shape` of other fields whose `size` agrees with the webhook's keeps the webhook's enum", async () => {
        const agreeing = shaped({ radius: { type: 'number' }, size: size('small', 'large') }, 'Memo');
        const spec = await parse(
          issueDocument(
            openapi,
            ['petReturned'],
            { petReturned: agreeing },
            { webhooks: { petAdopted: hook(payloads.petAdopted) } },
          ),
        );
        expect(names(spec)).toMatchInlineSnapshot(`
          {
            "enums": [
              "ShapeSize [small, large]",
            ],
            "models": [
              "CreatePetPetReturnedShape { kind: "shape", radius: number, size: ShapeSize }",
              "Memo { kind: "memo", text: string }",
              "Note { kind: "note", text: string }",
              "Shape { kind: "shape", sides: integer, size: ShapeSize }",
            ],
          }
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it("a callback's variant differing from the webhook's in the enum's values alone moves, model and enum", async () => {
        const spec = await parse(
          issueDocument(
            openapi,
            ['petReturned'],
            { petReturned: shaped({ size: size('tiny', 'huge') }, 'Memo') },
            { webhooks: { petAdopted: hook(shaped({ size: size('small', 'large') })) } },
          ),
        );
        expect(names(spec)).toMatchInlineSnapshot(`
          {
            "enums": [
              "CreatePetPetReturnedShapeSize [tiny, huge]",
              "ShapeSize [small, large]",
            ],
            "models": [
              "CreatePetPetReturnedShape { kind: "shape", size: CreatePetPetReturnedShapeSize }",
              "Memo { kind: "memo", text: string }",
              "Note { kind: "note", text: string }",
              "Shape { kind: "shape", size: ShapeSize }",
            ],
          }
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      describe("an inline enum named like a model the webhook holds (a clause of #631's rule this changes)", () => {
        // The webhook `sized` titles a variant `ShapeSize`, the name the
        // `size` enum of a callback's own variant `Shape` takes. With
        // #631's rule alone (PR #690) an inline enum under a held name was
        // decided by whether the callbacks disagree, so a lone callback's
        // enum kept `ShapeSize [tiny, huge]` and the model merge then
        // renamed the WEBHOOK's model away from it, with `Renamed inline
        // model "ShapeSize" → "SizedShapeSize": enum "ShapeSize" owns the
        // name`. The webhook's model now keeps its name and the enum moves.
        const webhooks = {
          sized: hook({ oneOf: [titled('ShapeSize', 'size', { width: { type: 'integer' } }), second('Log', 'log')] }),
        };

        it("one callback: the enum moves under the callback's stem and the webhook's model keeps its name", async () => {
          const spec = await parse(issueDocument(openapi, ['petReturned'], payloads, { webhooks }));
          expect(names(spec)).toMatchInlineSnapshot(`
            {
              "enums": [
                "CreatePetPetReturnedShapeSize [tiny, huge]",
              ],
              "models": [
                "Log { kind: "log", text: string }",
                "Memo { kind: "memo", text: string }",
                "Shape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize }",
                "ShapeSize { kind: "size", width: integer }",
              ],
            }
          `);
          expect(received(spec)).toEqual(['createPet>petReturned: Shape | Memo', 'webhooks.sized: ShapeSize | Log']);
          // Not even the merge's note: nothing is renamed after the fact.
          expect(warn).not.toHaveBeenCalled();
        });

        it("two callbacks whose enums agree: each moves under its own stem, as two models of one shape off a webhook's do", async () => {
          // With #631's rule alone both kept one `ShapeSize [tiny, huge]`,
          // the callbacks agreeing, and the webhook's model became
          // `SizedShapeSize`.
          const agreeing = {
            petAdopted: shaped({ sides: { type: 'integer' }, size: size('tiny', 'huge') }),
            petReturned: shaped({ radius: { type: 'number' }, size: size('tiny', 'huge') }, 'Memo'),
          };
          const spec = await eitherOrder(declaring(agreeing, { webhooks }));
          expect(names(spec)).toMatchInlineSnapshot(`
            {
              "enums": [
                "CreatePetPetAdoptedShapeSize [tiny, huge]",
                "CreatePetPetReturnedShapeSize [tiny, huge]",
              ],
              "models": [
                "CreatePetPetAdoptedShape { kind: "shape", sides: integer, size: CreatePetPetAdoptedShapeSize }",
                "CreatePetPetReturnedShape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize }",
                "Log { kind: "log", text: string }",
                "Memo { kind: "memo", text: string }",
                "Note { kind: "note", text: string }",
                "ShapeSize { kind: "size", width: integer }",
              ],
            }
          `);
          expect(received(spec)).toContain('webhooks.sized: ShapeSize | Log');
        });
      });

      it('a callback posting the very shape the webhook posts shares its model and its enum', async () => {
        const spec = await parse(
          issueDocument(openapi, ['petAdopted'], payloads, { webhooks: { adopted: hook(payloads.petAdopted) } }),
        );
        expect(names(spec)).toEqual({
          enums: ['ShapeSize [small, large]'],
          models: ['Note { kind: "note", text: string }', 'Shape { kind: "shape", sides: integer, size: ShapeSize }'],
        });
        expect(received(spec)).toEqual(['createPet>petAdopted: Shape | Note', 'webhooks.adopted: Shape | Note']);
        expect(warn).not.toHaveBeenCalled();
      });

      it('two callbacks beside a webhook of a third shape: each callback moves, in either order', async () => {
        const spec = await eitherOrder(declaring(payloads, { webhooks: { petLost: hook(lost) } }));
        expect(names(spec)).toMatchInlineSnapshot(`
          {
            "enums": [
              "CreatePetPetAdoptedShapeSize [small, large]",
              "CreatePetPetReturnedShapeSize [tiny, huge]",
              "ShapeSize [mini, maxi]",
            ],
            "models": [
              "CreatePetPetAdoptedShape { kind: "shape", sides: integer, size: CreatePetPetAdoptedShapeSize }",
              "CreatePetPetReturnedShape { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize }",
              "Log { kind: "log", text: string }",
              "Memo { kind: "memo", text: string }",
              "Note { kind: "note", text: string }",
              "Shape { kind: "shape", depth: number, size: ShapeSize }",
            ],
          }
        `);
      });

      it("two callbacks agreeing with each other, not with the webhook: both move, the webhook's name is not theirs to share", async () => {
        const spec = await eitherOrder(
          declaring(
            { petAdopted: payloads.petAdopted, petReturned: { oneOf: [shapes.petAdopted, second('Memo', 'memo')] } },
            { webhooks: { petLost: hook(lost) } },
          ),
        );
        expect(names(spec)).toMatchInlineSnapshot(`
          {
            "enums": [
              "CreatePetPetAdoptedShapeSize [small, large]",
              "CreatePetPetReturnedShapeSize [small, large]",
              "ShapeSize [mini, maxi]",
            ],
            "models": [
              "CreatePetPetAdoptedShape { kind: "shape", sides: integer, size: CreatePetPetAdoptedShapeSize }",
              "CreatePetPetReturnedShape { kind: "shape", sides: integer, size: CreatePetPetReturnedShapeSize }",
              "Log { kind: "log", text: string }",
              "Memo { kind: "memo", text: string }",
              "Note { kind: "note", text: string }",
              "Shape { kind: "shape", depth: number, size: ShapeSize }",
            ],
          }
        `);
      });

      it("a replacement steps around a name the webhook holds, as around a component's", async () => {
        // The webhook titles variants with the very names the callback's
        // `Shape` and `ShapeSize` would move to.
        const taken = {
          oneOf: [
            shapes.petAdopted,
            titled('CreatePetPetReturnedShape', 'model', { z: { type: 'string' } }),
            titled('CreatePetPetReturnedShapeSize', 'enum', { y: { type: 'string' } }),
          ],
        };
        const spec = await parse(
          issueDocument(openapi, ['petReturned'], payloads, { webhooks: { adopted: hook(taken) } }),
        );
        expect(names(spec)).toMatchInlineSnapshot(`
          {
            "enums": [
              "CreatePetPetReturnedShapeSize2 [tiny, huge]",
              "ShapeSize [small, large]",
            ],
            "models": [
              "CreatePetPetReturnedShape { kind: "model", z: string }",
              "CreatePetPetReturnedShape2 { kind: "shape", radius: number, size: CreatePetPetReturnedShapeSize2 }",
              "CreatePetPetReturnedShapeSize { kind: "enum", y: string }",
              "Memo { kind: "memo", text: string }",
              "Shape { kind: "shape", sides: integer, size: ShapeSize }",
            ],
          }
        `);
        expect(received(spec)).toEqual([
          'createPet>petReturned: CreatePetPetReturnedShape2 | Memo',
          'webhooks.adopted: Shape | CreatePetPetReturnedShape | CreatePetPetReturnedShapeSize',
        ]);
        expect(warn).not.toHaveBeenCalled();
      });

      it("a webhook's own callback moves off the webhook's `Shape`", async () => {
        const spec = await parse({
          openapi,
          info,
          paths: {},
          webhooks: {
            petEvent: hook(payloads.petAdopted, { callbacks: { confirmed: posting(payloads.petReturned) } }),
          },
        });
        expect(names(spec).enums).toEqual(['PetEventConfirmedShapeSize [tiny, huge]', 'ShapeSize [small, large]']);
        expect(received(spec)).toEqual([
          'webhooks.petEvent: Shape | Note',
          'webhooks.petEvent>confirmed: PetEventConfirmedShape | Memo',
        ]);
        expect(warn).not.toHaveBeenCalled();
      });

      it("a nested model that differs from the webhook's moves first, then the variant holding it", async () => {
        const meta = (...values: string[]) =>
          shaped({ meta: { type: 'object', properties: { size: size(...values) } } });
        const spec = await parse(
          issueDocument(
            openapi,
            ['petAdopted'],
            { petAdopted: meta('tiny', 'huge') },
            { webhooks: { adopted: hook(meta('small', 'large')) } },
          ),
        );
        expect(names(spec)).toMatchInlineSnapshot(`
          {
            "enums": [
              "CreatePetPetAdoptedShapeMetaSize [tiny, huge]",
              "ShapeMetaSize [small, large]",
            ],
            "models": [
              "CreatePetPetAdoptedShape { kind: "shape", meta: CreatePetPetAdoptedShapeMeta }",
              "CreatePetPetAdoptedShapeMeta { size: CreatePetPetAdoptedShapeMetaSize }",
              "Note { kind: "note", text: string }",
              "Shape { kind: "shape", meta: ShapeMeta }",
              "ShapeMeta { size: ShapeMetaSize }",
            ],
          }
        `);
        expect(warn).not.toHaveBeenCalled();
      });

      it("a callback sharing a webhook's minting keeps the webhook's names while an unrelated callback moves alone, its enum with its model (#631)", async () => {
        // `webhooks.petAdopted` and `createPet`'s callback read one path
        // item (`operationId: onPetAdopted`), so the callback shares the
        // webhook's minting; `createDog`'s callback posts another `Shape`.
        const item = { post: receiving(payloads.petAdopted, { operationId: 'onPetAdopted' }) };
        const document = (webhook: boolean): Document => ({
          openapi,
          info,
          paths: {
            '/pets': registering('createPet', {
              petAdopted: { [EXPRESSION]: { $ref: '#/components/pathItems/PetAdopted' } },
            }),
            '/dogs': registering('createDog', { dogAdopted: posting(payloads.petReturned) }),
          },
          ...(webhook ? { webhooks: { petAdopted: { $ref: '#/components/pathItems/PetAdopted' } } } : {}),
          components: { pathItems: { PetAdopted: item } },
        });
        const spec = await parse(document(true));
        expect(names(spec)).toMatchInlineSnapshot(`
          {
            "enums": [
              "CreateDogDogAdoptedShapeSize [tiny, huge]",
              "ShapeSize [small, large]",
            ],
            "models": [
              "CreateDogDogAdoptedShape { kind: "shape", radius: number, size: CreateDogDogAdoptedShapeSize }",
              "Memo { kind: "memo", text: string }",
              "Note { kind: "note", text: string }",
              "Shape { kind: "shape", sides: integer, size: ShapeSize }",
            ],
          }
        `);
        expect(received(spec)).toEqual([
          'createDog>dogAdopted: CreateDogDogAdoptedShape | Memo',
          'createPet>petAdopted: Shape | Note',
          'webhooks.petAdopted: Shape | Note',
        ]);
        // Adding the webhook gives the sharing callback the webhook's names
        // (#631's exception) and leaves the unrelated callback's alone.
        const { exit, changes } = await diff(document(false), document(true));
        expect(exit).toBe(2);
        expect([...changes].sort()).toEqual(
          [
            // Additive since #753: the payload moved to a model with every field of the old one.
            'callback-modified petAdopted (additive)',
            'enum-added ShapeSize (additive)',
            'enum-removed OnPetAdoptedShapeSize (breaking)',
            'model-added Shape (additive)',
            'model-removed OnPetAdoptedShape (breaking)',
            'webhook-added petAdopted (additive)',
          ].sort(),
        );
        expect(warn).not.toHaveBeenCalled();
      });
    });

    describe('left to the model merge, as before', () => {
      const merged = 'has more than one definition with different fields or field types';

      it('two `webhooks` keys whose title-mapped variants differ keep one definition, with a warning', async () => {
        const spec = await parse({
          openapi,
          info,
          paths: {},
          webhooks: {
            petAdopted: { post: receiving(payloads.petAdopted) },
            petReturned: { post: receiving(payloads.petReturned) },
          },
        });
        expect(names(spec).enums).toEqual(['ShapeSize [small, large]']);
        expect(received(spec)).toEqual(['webhooks.petAdopted: Shape | Note', 'webhooks.petReturned: Shape | Memo']);
        expect(warn.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
          expect.stringContaining(`"Shape" ${merged}`),
        ]);
      });

      it("a callback's variant titled like an operation's inline model of another shape does too", async () => {
        const spec = await parse({
          openapi,
          info,
          paths: {
            '/things': {
              get: {
                operationId: 'getThing',
                responses: { '200': { description: 'OK', content: json(payloads.petAdopted) } },
              },
            },
            '/pets': registering('createPet', { petReturned: posting(payloads.petReturned) }),
          },
        });
        expect(names(spec).enums).toEqual(['ShapeSize [small, large]']);
        expect(received(spec)).toEqual(['createPet>petReturned: Shape | Memo']);
        expect(warn.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
          expect.stringContaining(`"Shape" ${merged}`),
        ]);
      });
    });

    describe('once the hash is spent', () => {
      // `x`'s second variant is titled with `x`'s own stem carrying all
      // forty characters of its identity's hash, so the resolution hashes
      // `x` to exhaustion — the title embeds every prefix — and `x` keeps
      // that stem, `S` (the construction `callbacks.test.ts` uses).
      const identity = callbackContext('updatePet', { name: 'x', expression: EXPRESSION, httpMethod: 'post' });
      const hash = createHash('sha1').update(identity).digest('hex');
      const base = 'UpdatePetX';
      const S = toPascalCase(toPascalCase([base, numberedName(base, hash).slice(base.length)].join('_')));
      const updatePet = (callbacks: Record<string, unknown>): Document => ({
        openapi,
        info,
        paths: { '/pets': registering('updatePet', callbacks) },
      });

      it("renames a group's contested enums as one record, so a replacement that spells another never merges two enums", async () => {
        // `x` and `y` each title two variants `Shape` and `<S>Shape`, each
        // with a `size` enum of its own: four contested models, four
        // contested enums. `x`'s `ShapeSize` takes `<S>ShapeSize`, the name
        // its own second enum leaves for `<S><S>ShapeSize`.
        const union = (first: string[], last: string[]) => ({
          oneOf: [
            titled('Shape', 'first', { size: size(...first) }),
            titled(`${S}Shape`, 'second', { size: size(...last) }),
          ],
        });
        const spec = await parse(
          updatePet({
            x: posting(union(['small', 'large'], ['wide', 'narrow'])),
            y: posting(union(['tiny', 'huge'], ['tall', 'short'])),
          }),
        );
        expect(names(spec)).toEqual({
          enums: [
            `${S}ShapeSize [small, large]`,
            `${S}${S}ShapeSize [wide, narrow]`,
            'UpdatePetYShapeSize [tiny, huge]',
            `UpdatePetY${S}ShapeSize [tall, short]`,
          ].sort(),
          models: [
            `${S}Shape { kind: "first", size: ${S}ShapeSize }`,
            `${S}${S}Shape { kind: "second", size: ${S}${S}ShapeSize }`,
            'UpdatePetYShape { kind: "first", size: UpdatePetYShapeSize }',
            `UpdatePetY${S}Shape { kind: "second", size: UpdatePetY${S}ShapeSize }`,
          ].sort(),
        });
        expect(warn).not.toHaveBeenCalled();
      });

      it('a later round steps around a name an earlier round took, one its taker also left that round', async () => {
        // Round 1: `x` renames `Shape` to `<S>Shape` and its own `<S>Shape`
        // to `<S><S>Shape`. `g` (`operationId: update_pet`, stem
        // `UpdatePet`) and `h` title a variant `T`, the rest of `S` after
        // `UpdatePet` followed by `Shape`, whose nested `meta` differs in its
        // `size` enum: `TMeta` and `TMetaSize` are contested at once, `T`
        // itself only in round 2, when the two `meta` references differ.
        // `g`'s `T` then asks for `UpdatePet` + `T`, which is `<S>Shape`,
        // the name `x` has held since round 1.
        const T = `${S.slice('UpdatePet'.length)}Shape`;
        const union = (own: Record<string, unknown>, long: Record<string, unknown>) => ({
          oneOf: [titled('Shape', 'first', own), titled(`${S}Shape`, 'second', long)],
        });
        const nesting = (...values: string[]) => ({
          oneOf: [
            titled(T, 'first', { meta: { type: 'object', properties: { size: size(...values) } } }),
            second('Note', 'note'),
          ],
        });
        const spec = await parse(
          updatePet({
            x: posting(union({ sides: { type: 'integer' } }, { width: { type: 'number' } })),
            y: posting(union({ radius: { type: 'number' } }, { height: { type: 'number' } })),
            g: posting(nesting('small', 'large'), { operationId: 'update_pet' }),
            h: posting(nesting('tiny', 'huge')),
          }),
        );
        expect(received(spec)).toEqual([
          `updatePet>g: ${S}Shape2 | Note`,
          `updatePet>h: UpdatePetH${T} | Note`,
          `updatePet>x: ${S}Shape | ${S}${S}Shape`,
          `updatePet>y: UpdatePetYShape | UpdatePetY${S}Shape`,
        ]);
        expect(names(spec).enums).toEqual(
          [`${S}ShapeMetaSize [small, large]`, `UpdatePetH${T}MetaSize [tiny, huge]`].sort(),
        );
        expect(names(spec).models).toEqual(
          expect.arrayContaining([
            `${S}Shape { kind: "first", sides: integer }`,
            `${S}Shape2 { kind: "first", meta: ${S}ShapeMeta }`,
            `${S}ShapeMeta { size: ${S}ShapeMetaSize }`,
          ]),
        );
        expect(warn).not.toHaveBeenCalled();
      });

      it("renames a parameter's inline enum, a reference the callback itself holds, off another callback's model", async () => {
        // Under the spent stem `S`, `x`'s query parameter `kind` is the
        // inline enum `<S>Kind` — the name `y` titles a variant.
        const kind = { name: 'kind', in: 'query', schema: size('created', 'deleted') };
        const union = (own: Record<string, unknown>, long: Record<string, unknown>, more: unknown[] = []) => ({
          oneOf: [titled('Shape', 'first', own), titled(`${S}Shape`, 'second', long), ...more],
        });
        const spec = await parse(
          updatePet({
            x: posting(union({ sides: { type: 'integer' } }, { width: { type: 'number' } }), { parameters: [kind] }),
            y: posting(
              union({ radius: { type: 'number' } }, { height: { type: 'number' } }, [
                titled(`${S}Kind`, 'third', { depth: { type: 'number' } }),
              ]),
            ),
          }),
        );
        expect(names(spec).enums).toEqual([`${S}${S}Kind [created, deleted]`]);
        expect(received(spec)).toEqual([
          `updatePet>x: ${S}Shape | ${S}${S}Shape kind=${S}${S}Kind`,
          `updatePet>y: UpdatePetYShape | UpdatePetY${S}Shape | UpdatePetY${S}Kind`,
        ]);
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });
});
