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
});
