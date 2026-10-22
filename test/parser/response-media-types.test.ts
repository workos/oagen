import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { collectModelRefs } from '../../src/ir/types.js';
import type { Model, Operation } from '../../src/ir/types.js';

/** The issue's inline object body: `{ name: string }`. */
const PET_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
};

/** A different inline body, to tell which media type a pick came from. */
const PROBLEM_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
};

/** Extract the only operation of a GET /pets/{petId} whose 200 declares `content`. */
function getPet(content: Record<string, unknown>): { op: Operation; inlineModels: Model[] } {
  const paths = {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'The pet', content } },
      },
    },
  };
  const { services, inlineModels } = extractOperations(paths as never);
  const operations = services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return { op: operations[0], inlineModels };
}

/** Every model the response references must be one the parser created. */
function expectResolvedResponse(op: Operation, inlineModels: Model[]): void {
  const known = new Set(inlineModels.map((m) => m.name));
  for (const name of collectModelRefs(op.response)) expect(known).toContain(name);
}

function fieldNames(models: Model[], name: string): string[] | undefined {
  return models.find((m) => m.name === name)?.fields.map((f) => f.name);
}

describe('response media types are matched by essence (issue #237)', () => {
  describe('through parseSpec (issue repro)', () => {
    let dir: string;
    let specPath: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'oagen-237-'));
      specPath = join(dir, 'repro.json');
      writeFileSync(
        specPath,
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'repro', version: '1' },
          paths: {
            '/pets/{petId}': {
              get: {
                operationId: 'getPet',
                parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
                responses: {
                  '200': {
                    description: 'The pet',
                    content: { 'application/json; charset=utf-8': { schema: PET_SCHEMA } },
                  },
                },
              },
            },
          },
          components: {},
        }),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('creates the response model and leaves no unresolved reference', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseSpec(specPath);
      const [operation] = spec.services.flatMap(({ operations }) => operations);

      expect(operation.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(spec.models.map(({ name }) => name)).toEqual(['GetPetResponse']);
      expect(fieldNames(spec.models, 'GetPetResponse')).toEqual(['name']);
      const unresolved = warn.mock.calls.filter((call) => String(call[0]).includes('Unresolved model reference'));
      expect(unresolved).toEqual([]);
    });
  });

  describe('JSON bodies', () => {
    it('reads application/json with a charset parameter as JSON', () => {
      const { op, inlineModels } = getPet({ 'application/json; charset=utf-8': { schema: PET_SCHEMA } });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
      expectResolvedResponse(op, inlineModels);
    });

    it('matches the media type case-insensitively', () => {
      const { op, inlineModels } = getPet({ 'Application/JSON': { schema: PET_SCHEMA } });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
    });

    it('ignores whitespace around the essence', () => {
      const { op, inlineModels } = getPet({ ' application/json ; charset=utf-8': { schema: PET_SCHEMA } });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
    });

    it('reads a +json media type as JSON when it is the only one declared', () => {
      const { op, inlineModels } = getPet({ 'application/hal+json': { schema: PET_SCHEMA } });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
      expectResolvedResponse(op, inlineModels);
    });

    it('prefers application/json over a +json media type declared on the same 2xx', () => {
      const { op, inlineModels } = getPet({
        'application/problem+json': { schema: PROBLEM_SCHEMA },
        'application/json': { schema: PET_SCHEMA },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
    });

    it('prefers JSON when it is listed after another media type', () => {
      const { op, inlineModels } = getPet({
        'text/csv': { schema: { type: 'string' } },
        'application/json; charset=utf-8': { schema: PET_SCHEMA },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
    });

    it('prefers a +json media type over a binary one declared beside it, now that +json is JSON', () => {
      // On main the binary entry won here; a +json body is JSON and is typed from its schema.
      const { op } = getPet({
        'application/octet-stream': {},
        'application/vnd.pet+json': { schema: { $ref: '#/components/schemas/Pet' } },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'Pet' });
    });

    it('still prefers JSON over binary and text media types declared beside it', () => {
      const { op } = getPet({
        'application/octet-stream': {},
        'text/plain; charset=utf-8': { schema: { type: 'string' } },
        'application/json; charset=utf-8': { schema: PET_SCHEMA },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
    });

    it('skips a JSON entry without a schema in favour of one that declares it', () => {
      const { op, inlineModels } = getPet({
        'application/json': {},
        'application/vnd.pet+json; charset=utf-8': { schema: PET_SCHEMA },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
    });
  });

  describe('binary and text bodies', () => {
    it('types text/plain with a charset parameter as a string', () => {
      const { op, inlineModels } = getPet({ 'text/plain; charset=utf-8': { schema: { type: 'string' } } });
      expect(op.response).toEqual({ kind: 'primitive', type: 'string' });
      expect(inlineModels).toEqual([]);
    });

    it('types application/octet-stream with a parameter as binary', () => {
      const { op } = getPet({ 'application/octet-stream; foo=bar': {} });
      expect(op.response).toEqual({ kind: 'primitive', type: 'string', format: 'binary' });
    });

    it('types application/pdf with a parameter as binary', () => {
      const { op } = getPet({ 'application/pdf; foo=bar': { schema: { type: 'string', format: 'binary' } } });
      expect(op.response).toEqual({ kind: 'primitive', type: 'string', format: 'binary' });
    });

    it('types an upper-cased XML media type as a string', () => {
      const { op } = getPet({
        'Application/XML': { schema: { type: 'object', properties: { a: { type: 'string' } } } },
      });
      expect(op.response).toEqual({ kind: 'primitive', type: 'string' });
    });

    it('prefers binary over text when both are declared, as before', () => {
      const { op } = getPet({
        'text/plain; charset=utf-8': {},
        'application/octet-stream; foo=bar': {},
      });
      expect(op.response).toEqual({ kind: 'primitive', type: 'string', format: 'binary' });
    });
  });

  describe('other media types', () => {
    it('creates the inline model for a body declared under an unknown media type', () => {
      const { op, inlineModels } = getPet({ 'application/x-ndjson': { schema: PET_SCHEMA } });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
      expectResolvedResponse(op, inlineModels);
    });

    it('creates nested inline models for a body declared under an unknown media type', () => {
      const { op, inlineModels } = getPet({
        'application/x-ndjson': {
          schema: {
            type: 'object',
            properties: {
              owner: { type: 'object', properties: { email: { type: 'string' } } },
              tags: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } },
            },
          },
        },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      const known = new Set(inlineModels.map((m) => m.name));
      for (const model of inlineModels) {
        for (const field of model.fields) {
          for (const name of collectModelRefs(field.type)) expect(known).toContain(name);
        }
      }
      expect(inlineModels.length).toBeGreaterThan(1);
    });

    it('types an unknown media type with a primitive schema from that schema', () => {
      const { op, inlineModels } = getPet({ 'text/csv': { schema: { type: 'string' } } });
      expect(op.response).toEqual({ kind: 'primitive', type: 'string' });
      expect(inlineModels).toEqual([]);
    });

    it('picks the first unknown media type that declares a schema', () => {
      const { op, inlineModels } = getPet({
        'application/x-ndjson': {},
        'application/yaml': { schema: PET_SCHEMA },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
    });

    it('classifies an unknown media type exactly like the same body under application/json', () => {
      const envelope = {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
          list_metadata: {
            type: 'object',
            properties: { before: { type: 'string' }, after: { type: 'string' } },
          },
        },
      };
      const asJson = getPet({ 'application/json': { schema: envelope } });
      const asNdjson = getPet({ 'application/x-ndjson': { schema: envelope } });
      expect(asNdjson.op.response).toEqual(asJson.op.response);
      expect(asNdjson.op.pagination).toEqual(asJson.op.pagination);
      expect(asNdjson.inlineModels).toEqual(asJson.inlineModels);
      expectResolvedResponse(asNdjson.op, asNdjson.inlineModels);
    });

    it('leaves the response unknown when content declares no schema anywhere', () => {
      const { op, inlineModels } = getPet({ 'application/x-ndjson': {}, 'application/yaml': {} });
      expect(op.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(inlineModels).toEqual([]);
    });
  });

  /** Every model reachable from the operation — primary and secondary responses, and the models' own fields. */
  function expectClosed(op: Operation, inlineModels: Model[]): void {
    const known = new Set(inlineModels.map((m) => m.name));
    const refs = [op.response, ...(op.successResponses ?? []).map((r) => r.type)];
    for (const model of inlineModels) for (const field of model.fields) refs.push(field.type);
    for (const ref of refs) for (const name of collectModelRefs(ref)) expect(known).toContain(name);
  }

  describe('several 2xx bodies', () => {
    /** Extract the only operation of a GET /pets/{petId} with the given `responses`. */
    function getPetWith(responses: Record<string, unknown>): { op: Operation; inlineModels: Model[] } {
      const paths = {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
            responses,
          },
        },
      };
      const { services, inlineModels } = extractOperations(paths as never);
      const operations = services.flatMap((s) => s.operations);
      expect(operations).toHaveLength(1);
      return { op: operations[0], inlineModels };
    }

    const ENVELOPE = {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
        list_metadata: { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } } },
      },
    };

    it('keeps the model of an earlier body when a later 2xx body is a primitive', () => {
      const { op, inlineModels } = getPetWith({
        '200': { description: 'ok', content: { 'application/json': { schema: PET_SCHEMA } } },
        '201': { description: 'created', content: { 'application/yaml': { schema: { type: 'string' } } } },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(op.successResponses?.map((r) => r.type)).toEqual([
        { kind: 'model', name: 'GetPetResponse' },
        { kind: 'primitive', type: 'string' },
      ]);
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
      expectClosed(op, inlineModels);
    });

    it('keeps the models of every 2xx body, the primary first on a name clash', () => {
      const { op, inlineModels } = getPetWith({
        '200': {
          description: 'ok',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { owner: { type: 'object', properties: { email: { type: 'string' } } } },
              },
            },
          },
        },
        '201': {
          description: 'created',
          content: {
            'application/x-ndjson': {
              schema: {
                type: 'object',
                properties: {
                  tags: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } },
                },
              },
            },
          },
        },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      // Both statuses derive `GetPetResponse`; the primary's definition is the one kept.
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['owner']);
      const names = inlineModels.map((m) => m.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain('GetPetResponseOwner');
      // The 201's `tags` item model was referenced only by the 201's own
      // `GetPetResponse`, which the 200's replaced, so it goes with it rather
      // than staying behind with nothing referencing it (issue #280).
      expect(names.some((n) => n.startsWith('GetPetResponseTag'))).toBe(false);
      expectClosed(op, inlineModels);
    });

    it('reads the paging fields from the primary response, not the last body read', () => {
      const baseline = getPetWith({
        '200': { description: 'ok', content: { 'application/json': { schema: ENVELOPE } } },
      });
      expect(baseline.op.pagination).toBeDefined();

      const laterPlain = getPetWith({
        '200': { description: 'ok', content: { 'application/json': { schema: ENVELOPE } } },
        '201': { description: 'created', content: { 'application/json': { schema: PET_SCHEMA } } },
      });
      expect(laterPlain.op.response).toEqual(baseline.op.response);
      expect(laterPlain.op.pagination).toEqual(baseline.op.pagination);
      expectClosed(laterPlain.op, laterPlain.inlineModels);

      // Document order does not matter: the lowest 2xx with a body is primary.
      const declaredFirst = getPetWith({
        '201': { description: 'created', content: { 'application/json': { schema: PET_SCHEMA } } },
        '200': { description: 'ok', content: { 'application/json': { schema: ENVELOPE } } },
      });
      expect(declaredFirst.op.response).toEqual(baseline.op.response);
      expect(declaredFirst.op.pagination).toEqual(baseline.op.pagination);
    });

    it('warns when a secondary body drops a model whose fields differ from the kept one', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { inlineModels } = getPetWith({
          '200': { description: 'ok', content: { 'application/json': { schema: PET_SCHEMA } } },
          '201': {
            description: 'created',
            content: { 'application/json': { schema: { type: 'object', properties: { age: { type: 'integer' } } } } },
          },
        });
        expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
        expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(
          expect.stringContaining(
            'Inline model "GetPetResponse" from the 201 response has different fields than the 200',
          ),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('stays silent when a secondary body repeats the kept model exactly', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        getPetWith({
          '200': { description: 'ok', content: { 'application/json': { schema: PET_SCHEMA } } },
          '201': { description: 'created', content: { 'application/json': { schema: PET_SCHEMA } } },
        });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('does not take paging fields from a secondary envelope', () => {
      const { op, inlineModels } = getPetWith({
        '200': { description: 'ok', content: { 'application/json': { schema: PET_SCHEMA } } },
        '202': { description: 'accepted', content: { 'application/json': { schema: ENVELOPE } } },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'GetPetResponse' });
      expect(op.pagination).toBeUndefined();
      expectClosed(op, inlineModels);
    });
  });

  describe('bodies typed through schemaToTypeRef still get their inline models', () => {
    const INLINE_OBJECT = { type: 'object', properties: { email: { type: 'string' } } };

    it('a map whose values are an inline object, under a non-JSON media type', () => {
      const { op, inlineModels } = getPet({
        'application/yaml': { schema: { type: 'object', additionalProperties: INLINE_OBJECT } },
      });
      expect(collectModelRefs(op.response).length).toBeGreaterThan(0);
      expectClosed(op, inlineModels);
    });

    it('a map whose values are an inline object, under application/json', () => {
      const { op, inlineModels } = getPet({
        'application/json': { schema: { type: 'object', additionalProperties: INLINE_OBJECT } },
      });
      expect(collectModelRefs(op.response).length).toBeGreaterThan(0);
      expectClosed(op, inlineModels);
    });

    it('an array declared by `items` alone, with no `type`, under application/json and under another media type', () => {
      // `schemaToTypeRef` reads `items` with no `type` as an array, so the
      // primary branch must too — or the reference names an item model
      // nobody creates (`array<GetPetResponse>` with no `GetPetResponse`).
      for (const mediaType of ['application/json', 'application/x-ndjson']) {
        const { op, inlineModels } = getPet({ [mediaType]: { schema: { items: INLINE_OBJECT } } });
        expect(op.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'GetPetItem' } });
        expect(fieldNames(inlineModels, 'GetPetItem')).toEqual(['email']);
        expectClosed(op, inlineModels);
      }
    });

    it('a nullable array written as a `oneOf`/`anyOf` beside `items` is the array it is, null kept', () => {
      // `classifyInlineSchema` types a schema with `items` beside a `oneOf` /
      // `anyOf` as a union — `schemaToTypeRef` reads it as a nullable array —
      // and the response path reads the array under the wrapper
      // (`arraySchemaOf`, #282), so its items are `<Op>Item` exactly as under
      // `type: ['array', 'null']`, and the null is kept.
      const nullableArray = (items: unknown, keyword: 'oneOf' | 'anyOf') => ({
        items,
        [keyword]: [{ type: 'array', items }, { type: 'null' }],
      });
      const byRef = getPet({
        'application/json': { schema: nullableArray({ $ref: '#/components/schemas/Pet' }, 'oneOf') },
      });
      expect(byRef.op.response).toEqual({
        kind: 'nullable',
        inner: { kind: 'array', items: { kind: 'model', name: 'Pet' } },
      });
      expect(byRef.inlineModels).toEqual([]);
      // With inline items the item model is created, whether the array keyword
      // is `type: 'array'` or `items` alone, and the null is still kept.
      for (const [keyword, schema] of [
        ['anyOf', nullableArray(INLINE_OBJECT, 'anyOf')],
        ['oneOf', { type: 'array', ...nullableArray(INLINE_OBJECT, 'oneOf') }],
      ] as const) {
        const { op, inlineModels } = getPet({ 'application/json': { schema } });
        expect(op.response, keyword).toEqual({
          kind: 'nullable',
          inner: { kind: 'array', items: { kind: 'model', name: 'GetPetItem' } },
        });
        expect(fieldNames(inlineModels, 'GetPetItem'), keyword).toEqual(['email']);
        expectClosed(op, inlineModels);
      }
    });

    it('an array whose items are a union of inline objects', () => {
      const { op, inlineModels } = getPet({
        'application/json': {
          schema: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'object', properties: { kind: { const: 'cat' }, lives: { type: 'integer' } } },
                { type: 'object', properties: { kind: { const: 'dog' }, barks: { type: 'boolean' } } },
              ],
            },
          },
        },
      });
      expect(op.response.kind).toBe('array');
      expect(collectModelRefs(op.response).length).toBeGreaterThan(1);
      expectClosed(op, inlineModels);
    });

    it('a nullable map of inline objects', () => {
      const { op, inlineModels } = getPet({
        'application/json': { schema: { type: ['object', 'null'], additionalProperties: INLINE_OBJECT } },
      });
      expect(collectModelRefs(op.response).length).toBeGreaterThan(0);
      expectClosed(op, inlineModels);
    });

    it('a map of arrays of inline objects', () => {
      const { op, inlineModels } = getPet({
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: {
              type: 'array',
              items: { type: 'object', properties: { label: { type: 'string' } } },
            },
          },
        },
      });
      expect(collectModelRefs(op.response).length).toBeGreaterThan(0);
      expectClosed(op, inlineModels);
    });

    it('a nullable inline object', () => {
      const { op, inlineModels } = getPet({
        'application/json': {
          schema: { type: ['object', 'null'], properties: { name: { type: 'string' } } },
        },
      });
      expect(collectModelRefs(op.response)).toEqual(['GetPetResponse']);
      expect(fieldNames(inlineModels, 'GetPetResponse')).toEqual(['name']);
      expectClosed(op, inlineModels);
    });

    it('does not duplicate the variants of a top-level union', () => {
      const { op, inlineModels } = getPet({
        'application/json': {
          schema: {
            oneOf: [
              { type: 'object', properties: { kind: { const: 'cat' } } },
              { type: 'object', properties: { kind: { const: 'dog' } } },
            ],
          },
        },
      });
      const names = inlineModels.map((m) => m.name);
      expect(new Set(names).size).toBe(names.length);
      expect(collectModelRefs(op.response).length).toBeGreaterThan(1);
      expectClosed(op, inlineModels);
    });

    it('leaves a primitive body without models', () => {
      const { op, inlineModels } = getPet({ 'application/json': { schema: { type: 'integer' } } });
      expect(op.response).toEqual({ kind: 'primitive', type: 'integer' });
      expect(inlineModels).toEqual([]);
    });

    describe('through parseSpec', () => {
      let dir: string;
      let specPath: string;

      beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'oagen-237-map-'));
        specPath = join(dir, 'map.json');
        writeFileSync(
          specPath,
          JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'map', version: '1' },
            paths: {
              '/pets/{petId}': {
                get: {
                  operationId: 'getPet',
                  parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
                  responses: {
                    '200': {
                      description: 'ok',
                      content: {
                        'application/yaml': { schema: { type: 'object', additionalProperties: INLINE_OBJECT } },
                      },
                    },
                    '201': {
                      description: 'created',
                      content: { 'application/json; charset=utf-8': { schema: PET_SCHEMA } },
                    },
                  },
                },
              },
            },
            components: {},
          }),
        );
      });

      afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('emits no unresolved model reference', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const spec = await parseSpec(specPath);
        const [operation] = spec.services.flatMap(({ operations }) => operations);
        const known = new Set(spec.models.map((m) => m.name));
        for (const ref of [operation.response, ...(operation.successResponses ?? []).map((r) => r.type)]) {
          for (const name of collectModelRefs(ref)) expect(known).toContain(name);
        }
        const unresolved = warn.mock.calls.filter((call) => String(call[0]).includes('Unresolved model reference'));
        expect(unresolved).toEqual([]);
      });
    });
  });
});
