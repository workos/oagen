import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extendsParentName, qualifyInlineModelName } from '../../src/parser/inline-models.js';
import { inlineEnumName } from '../../src/parser/schemas.js';
import { collectModelRefs, collectOperationTypeRefs, collectWebhookTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #621: `qualifyInlineModelName` left a field's inline name
 * unqualified whenever it started with the parent's name, the parent's own
 * name included, so `Reply.reply` was named `Reply` — the component's own
 * name — and stepped to `Reply2` with a rename warning, while
 * `Reply.replies` gave `ReplyReply`. A name now stands unqualified only when
 * it adds something after the parent's (`Pet.petOwner` → `PetOwner`); a
 * field named like its parent is qualified like any other field
 * (`ReplyReply`, `PetPet`), for a model and for an inline enum alike.
 */

const text = { type: 'object', properties: { text: { type: 'string' } } };
const str = { type: 'string' };
const pathParam = (name: string) => ({ name, in: 'path', required: true, schema: str });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const refTo = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (schema: unknown) => ({ '200': { description: 'OK', ...json(schema) } });

/** `GET /<plural>/{<parent>Id}` (`operationId: get<Parent>`) returning `$ref: <Parent>`, over the given components. */
function componentDoc(openapi: string, parent: string, schemas: Record<string, unknown>) {
  const id = `${parent.toLowerCase()}Id`;
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      [`/${parent.toLowerCase()}s/{${id}}`]: {
        get: { operationId: `get${parent}`, parameters: [pathParam(id)], responses: ok(refTo(parent)) },
      },
    },
    components: { schemas },
  };
}

/** The issue's repro: `getReply` returns a `Reply` component whose one field is `field`. */
const replyWith = (openapi: string, field: string, schema: unknown = text) =>
  componentDoc(openapi, 'Reply', { Reply: { type: 'object', properties: { [field]: schema } } });

const model = (name: string): TypeRef => ({ kind: 'model', name });
const enumRef = (name: string): TypeRef => ({ kind: 'enum', name });
const renamed = (from: string, to: string) =>
  `[oagen] Renamed inline model "${from}" → "${to}": its shape differs from component schema "${from}"`;

/** The same entries as an object, in the given order or reversed. */
function schemasIn(reversed: boolean, entries: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(reversed ? [...entries].reverse() : entries);
}
const orders = [
  ['as written', false],
  ['reversed', true],
] as const;

describe('#621', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-621-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));
  const modelNames = (spec: ApiSpec) => spec.models.map(({ name }) => name);
  const enumNames = (spec: ApiSpec) => spec.enums.map(({ name }) => name);
  const modelOf = (spec: ApiSpec, name: string) => spec.models.find((m) => m.name === name);
  const fieldNames = (spec: ApiSpec, name: string) => modelOf(spec, name)?.fields.map((f) => f.name);
  const fieldType = (spec: ApiSpec, name: string, field: string) =>
    modelOf(spec, name)?.fields.find((f) => f.name === field)?.type;
  const operations = (spec: ApiSpec) => spec.services.flatMap((s) => s.operations);

  /** Every model a field, an operation or a webhook references is in `spec.models`. */
  function expectResolved(spec: ApiSpec): void {
    const known = new Set(modelNames(spec));
    const refs: TypeRef[] = [
      ...spec.models.flatMap((m) => m.fields.map((f) => f.type)),
      ...operations(spec).flatMap((op) => collectOperationTypeRefs(op)),
      ...(spec.webhooks ?? []).flatMap((webhook) => collectWebhookTypeRefs(webhook)),
    ];
    for (const ref of refs) for (const name of collectModelRefs(ref)) expect(known.has(name), name).toBe(true);
  }

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    const spec = await parseSpec(specFile);
    expectResolved(spec);
    return spec;
  }

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    describe("the issue's repro", () => {
      it('reply.json: names `Reply.reply` `ReplyReply`, with no rename warning', async () => {
        const spec = await parseJson(replyWith(openapi, 'reply'));
        expect(modelNames(spec)).toEqual(['Reply', 'ReplyReply']);
        expect(fieldType(spec, 'Reply', 'reply')).toEqual(model('ReplyReply'));
        expect(fieldNames(spec, 'ReplyReply')).toEqual(['text']);
        expect(warnings()).toEqual([]);
      });

      it('replies.json: still names the array’s items `ReplyReply`', async () => {
        const spec = await parseJson(replyWith(openapi, 'replies', { type: 'array', items: text }));
        expect(modelNames(spec)).toEqual(['Reply', 'ReplyReply']);
        expect(fieldType(spec, 'Reply', 'replies')).toEqual({ kind: 'array', items: model('ReplyReply') });
        expect(warnings()).toEqual([]);
      });

      it('quote.json: still qualifies any other field as usual (`ReplyQuote`)', async () => {
        const spec = await parseJson(replyWith(openapi, 'quote'));
        expect(modelNames(spec)).toEqual(['Reply', 'ReplyQuote']);
        expect(fieldType(spec, 'Reply', 'quote')).toEqual(model('ReplyQuote'));
        expect(warnings()).toEqual([]);
      });

      it('names `Pet.pet` `PetPet`, never `Pet2`', async () => {
        const spec = await parseJson(
          componentDoc(openapi, 'Pet', { Pet: { type: 'object', properties: { pet: text } } }),
        );
        expect(modelNames(spec)).toEqual(['Pet', 'PetPet']);
        expect(fieldType(spec, 'Pet', 'pet')).toEqual(model('PetPet'));
        expect(warnings()).toEqual([]);
      });
    });

    describe('every inline name minted under the parent takes the same test', () => {
      it('an inline enum named like its component is `ReplyReply`, and the component keeps its name', async () => {
        const spec = await parseJson(replyWith(openapi, 'reply', { type: 'string', enum: ['a', 'b'] }));
        expect(modelNames(spec)).toEqual(['Reply']);
        expect(enumNames(spec)).toEqual(['ReplyReply']);
        expect(fieldType(spec, 'Reply', 'reply')).toMatchObject(enumRef('ReplyReply'));
        expect(warnings()).toEqual([]);
      });

      it('a nested object named like its parent at every level is qualified at every level, none lost', async () => {
        const spec = await parseJson(replyWith(openapi, 'reply', { type: 'object', properties: { reply: text } }));
        expect(modelNames(spec)).toEqual(['Reply', 'ReplyReply', 'ReplyReplyReply']);
        expect(fieldType(spec, 'Reply', 'reply')).toEqual(model('ReplyReply'));
        expect(fieldType(spec, 'ReplyReply', 'reply')).toEqual(model('ReplyReplyReply'));
        expect(fieldNames(spec, 'ReplyReplyReply')).toEqual(['text']);
        expect(warnings()).toEqual([]);
      });

      it('a map field’s values are `ReplyReply`', async () => {
        const spec = await parseJson(replyWith(openapi, 'reply', { type: 'object', additionalProperties: text }));
        expect(modelNames(spec)).toEqual(['Reply', 'ReplyReply']);
        expect(fieldType(spec, 'Reply', 'reply')).toMatchObject({ kind: 'map', valueType: model('ReplyReply') });
        expect(warnings()).toEqual([]);
      });

      it('an array field named like its parent: its object items are `PetPet`, its enum items the enum `PetPet`', async () => {
        const objects = await parseJson(
          componentDoc(openapi, 'Pet', {
            Pet: { type: 'object', properties: { pet: { type: 'array', items: text } } },
          }),
        );
        expect(modelNames(objects)).toEqual(['Pet', 'PetPet']);
        expect(fieldType(objects, 'Pet', 'pet')).toEqual({ kind: 'array', items: model('PetPet') });

        const enums = await parseJson(
          componentDoc(openapi, 'Pet', {
            Pet: {
              type: 'object',
              properties: { pet: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
            },
          }),
        );
        expect(modelNames(enums)).toEqual(['Pet']);
        expect(enumNames(enums)).toEqual(['PetPet']);
        expect(fieldType(enums, 'Pet', 'pet')).toMatchObject({ kind: 'array', items: enumRef('PetPet') });
        expect(warnings()).toEqual([]);
      });

      it('a nullable object field named like its parent, in this version’s spelling', async () => {
        const nullable =
          openapi === '3.0.3' ? { ...text, nullable: true } : { type: ['object', 'null'], properties: text.properties };
        const spec = await parseJson(replyWith(openapi, 'reply', nullable));
        expect(modelNames(spec)).toEqual(['Reply', 'ReplyReply']);
        expect(fieldType(spec, 'Reply', 'reply')).toEqual({ kind: 'nullable', inner: model('ReplyReply') });
        expect(warnings()).toEqual([]);
      });

      it('the inline object variants of a `oneOf` are named from `ReplyReply`', async () => {
        const spec = await parseJson(
          replyWith(openapi, 'reply', { oneOf: [text, { type: 'object', properties: { n: { type: 'integer' } } }] }),
        );
        expect(modelNames(spec)).toEqual(['Reply', 'ReplyReply', 'ReplyReplyWithN']);
        expect(fieldType(spec, 'Reply', 'reply')?.kind).toBe('union');
        expect(fieldNames(spec, 'ReplyReply')).toEqual(['text']);
        expect(fieldNames(spec, 'ReplyReplyWithN')).toEqual(['n']);
        expect(warnings()).toEqual([]);
      });

      it('a merged `allOf` is `ReplyReply`, with every member’s fields', async () => {
        const spec = await parseJson(
          replyWith(openapi, 'reply', { allOf: [text, { type: 'object', properties: { n: { type: 'integer' } } }] }),
        );
        expect(modelNames(spec)).toEqual(['Reply', 'ReplyReply']);
        expect(fieldType(spec, 'Reply', 'reply')).toEqual(model('ReplyReply'));
        expect(fieldNames(spec, 'ReplyReply')).toEqual(['text', 'n']);
        expect(warnings()).toEqual([]);
      });
    });

    describe('under a parent that is not a component', () => {
      it('a body or response named from its operation is not a name the field starts with (`CreateReplyRequestReply`)', async () => {
        const body = { type: 'object', properties: { reply: text } };
        const spec = await parseJson({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: { '/replies': { post: { operationId: 'createReply', requestBody: json(body), responses: ok(body) } } },
        });
        expect(modelNames(spec).sort()).toEqual([
          'CreateReplyRequest',
          'CreateReplyRequestReply',
          'CreateReplyResponse',
          'CreateReplyResponseReply',
        ]);
        expect(fieldType(spec, 'CreateReplyRequest', 'reply')).toEqual(model('CreateReplyRequestReply'));
        expect(fieldType(spec, 'CreateReplyResponse', 'reply')).toEqual(model('CreateReplyResponseReply'));
        expect(warnings()).toEqual([]);
      });

      it('a response named from its `object` const: `Reply.reply` is `ReplyReply`, never the response itself', async () => {
        const spec = await parseJson({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: {
            '/replies/{replyId}': {
              get: {
                operationId: 'getReply',
                parameters: [pathParam('replyId')],
                responses: ok({
                  type: 'object',
                  properties: { object: { type: 'string', const: 'reply' }, reply: text },
                }),
              },
            },
          },
        });
        expect(modelNames(spec)).toEqual(['Reply', 'ReplyReply']);
        expect(operations(spec).map((op) => op.response)).toEqual([model('Reply')]);
        expect(fieldType(spec, 'Reply', 'reply')).toEqual(model('ReplyReply'));
        expect(fieldNames(spec, 'ReplyReply')).toEqual(['text']);
        expect(warnings()).toEqual([]);
      });

      it('a webhook payload field named like the payload model is qualified by it, never the payload itself', async () => {
        const spec = await parseJson({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: {},
          webhooks: {
            'reply.created': {
              post: {
                requestBody: json({ type: 'object', properties: { replyCreatedPayload: text } }),
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        });
        expect(modelNames(spec)).toEqual(['ReplyCreatedPayload', 'ReplyCreatedPayloadReplyCreatedPayload']);
        expect(spec.webhooks?.map((webhook) => webhook.requestBody)).toEqual([model('ReplyCreatedPayload')]);
        expect(fieldType(spec, 'ReplyCreatedPayload', 'replyCreatedPayload')).toEqual(
          model('ReplyCreatedPayloadReplyCreatedPayload'),
        );
        expect(warnings()).toEqual([]);
      });

      it('a shared error body with a field named like it: `ErrorBody.errorBody` is `ErrorBodyErrorBody`', async () => {
        const failing = (operationId: string, error: unknown) => ({
          get: {
            operationId,
            parameters: [pathParam('id')],
            responses: { ...ok(text), '404': { description: 'Not found', ...json(error) } },
          },
        });
        const errorBody = { type: 'object', required: ['message'], properties: { message: str, errorBody: text } };
        const spec = await parseJson({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: {
            '/pets/{id}': failing('getPet', refTo('ErrorBody')),
            '/tags/{id}': failing('getTag', refTo('ErrorBody')),
          },
          components: { schemas: { ErrorBody: errorBody } },
        });
        expect(modelNames(spec).sort()).toEqual([
          'ErrorBody',
          'ErrorBodyErrorBody',
          'GetPetResponse',
          'GetTagResponse',
        ]);
        expect(fieldType(spec, 'ErrorBody', 'errorBody')).toEqual(model('ErrorBodyErrorBody'));
        expect(operations(spec).map((op) => op.errors?.map((error) => error.type))).toEqual([
          [model('ErrorBody')],
          [model('ErrorBody')],
        ]);
        expect(warnings()).toEqual([]);
      });
    });

    describe('when a component already holds `ReplyReply`', () => {
      const reply = { type: 'object', properties: { reply: text } };

      it.each(orders)(
        'of another shape: steps to `ReplyReply2` with the rename warning, components %s',
        async (_order, reversed) => {
          const other = { type: 'object', properties: { other: { type: 'integer' } } };
          const spec = await parseJson(
            componentDoc(
              openapi,
              'Reply',
              schemasIn(reversed, [
                ['Reply', reply],
                ['ReplyReply', other],
              ]),
            ),
          );
          expect(modelNames(spec).sort()).toEqual(['Reply', 'ReplyReply', 'ReplyReply2']);
          expect(fieldType(spec, 'Reply', 'reply')).toEqual(model('ReplyReply2'));
          expect(fieldNames(spec, 'ReplyReply')).toEqual(['other']);
          expect(fieldNames(spec, 'ReplyReply2')).toEqual(['text']);
          expect(warnings()).toEqual([renamed('ReplyReply', 'ReplyReply2')]);
        },
      );

      it.each(orders)('of the same shape: folds onto it, with no warning, components %s', async (_order, reversed) => {
        const spec = await parseJson(
          componentDoc(
            openapi,
            'Reply',
            schemasIn(reversed, [
              ['Reply', reply],
              ['ReplyReply', text],
            ]),
          ),
        );
        expect(modelNames(spec).sort()).toEqual(['Reply', 'ReplyReply']);
        expect(fieldType(spec, 'Reply', 'reply')).toEqual(model('ReplyReply'));
        expect(fieldNames(spec, 'ReplyReply')).toEqual(['text']);
        expect(warnings()).toEqual([]);
      });
    });

    describe('a name that adds something after the parent’s still stands unqualified', () => {
      it.each([
        ['Pet', 'petOwner', 'PetOwner'],
        ['Pet', 'pets_item', 'PetsItem'],
        ['Status', 'status', 'StatusStatus'],
      ])('%s.%s is %s', async (parent, field, expected) => {
        const spec = await parseJson(
          componentDoc(openapi, parent, { [parent]: { type: 'object', properties: { [field]: text } } }),
        );
        expect(modelNames(spec)).toEqual([parent, expected]);
        expect(fieldType(spec, parent, field)).toEqual(model(expected));
        expect(warnings()).toEqual([]);
      });
    });
  });

  describe('the naming helpers', () => {
    it('extendsParentName: a longer name that starts with the parent, never the parent’s own', () => {
      expect(extendsParentName('PetOwner', 'Pet')).toBe(true);
      expect(extendsParentName('PetsItem', 'Pet')).toBe(true);
      expect(extendsParentName('Pets', 'Pet')).toBe(true);
      expect(extendsParentName('Pet', 'Pet')).toBe(false);
      expect(extendsParentName('Pe', 'Pet')).toBe(false);
      expect(extendsParentName('Replies', 'Reply')).toBe(false);
      expect(extendsParentName('OwnerPet', 'Pet')).toBe(false);
    });

    it('qualifyInlineModelName qualifies a name that is the parent’s own, the parent’s markers stripped', () => {
      expect(qualifyInlineModelName('Reply', 'Reply')).toBe('ReplyReply');
      expect(qualifyInlineModelName('Reply', 'ReplyListItem')).toBe('ReplyReply');
      expect(qualifyInlineModelName('Replies', 'Reply')).toBe('ReplyReply');
      expect(qualifyInlineModelName('Pet', 'Pet')).toBe('PetPet');
      expect(qualifyInlineModelName('PetOwner', 'Pet')).toBe('PetOwner');
      expect(qualifyInlineModelName('Domains', 'ConnectionListItem')).toBe('ConnectionDomain');
      expect(qualifyInlineModelName('Reply')).toBe('Reply');
    });

    it('inlineEnumName takes the same test', () => {
      expect(inlineEnumName('reply', 'Reply')).toBe('ReplyReply');
      expect(inlineEnumName('reply', 'ReplyListItem')).toBe('ReplyReply');
      expect(inlineEnumName('connectionType', 'Connection')).toBe('ConnectionType');
      expect(inlineEnumName('state', 'DirectoryListItem')).toBe('DirectoryState');
      expect(inlineEnumName('status', undefined)).toBe('Status');
    });
  });
});
