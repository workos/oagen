import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import type { Operation } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

/**
 * Issue #235: an explicit error response (`4xx`/`5xx`) only read
 * `application/json`, so a body served as `application/problem+json`
 * (RFC 9457) or any other `+json` media type came out untyped.
 */

const PROBLEM_REF = { $ref: '#/components/schemas/Problem' };
const ERROR_REF = { $ref: '#/components/schemas/Error' };

const COMPONENT_SCHEMAS: Record<string, SchemaObject> = {
  Pet: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  Problem: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  Error: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
};

/** The only operation in a GET /pets/{petId} whose 404 declares `content`. */
function getPetWith404(content: Record<string, unknown> | undefined, extraResponses: Record<string, unknown> = {}) {
  const notFound: Record<string, unknown> = { description: 'No such pet' };
  if (content !== undefined) notFound.content = content;
  const paths = {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'The pet',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
          '404': notFound,
          ...extraResponses,
        },
      },
    },
  };
  const { services } = extractOperations(paths as never, undefined, COMPONENT_SCHEMAS);
  const operations = services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return { operation: operations[0] as Operation };
}

describe('error responses served as +json media types (issue #235)', () => {
  describe('media type selection', () => {
    it('types a body declared only as application/problem+json', () => {
      const { operation } = getPetWith404({ 'application/problem+json': { schema: PROBLEM_REF } });
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Problem' } },
      ]);
    });

    it('still types a plain application/json body', () => {
      const { operation } = getPetWith404({ 'application/json': { schema: ERROR_REF } });
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Error' } },
      ]);
    });

    it('prefers application/json over a +json type regardless of declaration order', () => {
      const { operation } = getPetWith404({
        'application/problem+json': { schema: PROBLEM_REF },
        'application/json': { schema: ERROR_REF },
      });
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Error' } },
      ]);
    });

    it('types any +json structured-syntax suffix, not only problem+json', () => {
      const { operation } = getPetWith404({ 'application/vnd.api+json': { schema: PROBLEM_REF } });
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Problem' } },
      ]);
    });

    it('matches on the media type essence: parameters stripped, case-insensitive', () => {
      const { operation } = getPetWith404({
        'APPLICATION/PROBLEM+JSON; charset=utf-8': { schema: PROBLEM_REF },
      });
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Problem' } },
      ]);
    });

    it('matches application/json by essence when it carries parameters', () => {
      const { operation } = getPetWith404({
        'application/problem+json': { schema: PROBLEM_REF },
        'application/json; charset=utf-8': { schema: ERROR_REF },
      });
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Error' } },
      ]);
    });

    it('takes the first declared +json type when several are present and none is application/json', () => {
      const { operation } = getPetWith404({
        'application/vnd.api+json': { schema: ERROR_REF },
        'application/problem+json': { schema: PROBLEM_REF },
      });
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Error' } },
      ]);
    });
  });

  describe('bodies that stay untyped', () => {
    it('leaves a text/plain-only error untyped', () => {
      const { operation } = getPetWith404({ 'text/plain': { schema: { type: 'string' } } });
      expect(operation.errors).toEqual([{ statusCode: 404, description: 'No such pet', type: undefined }]);
    });

    it('leaves a +json entry without a schema untyped', () => {
      const { operation } = getPetWith404({ 'application/problem+json': {} });
      expect(operation.errors).toEqual([{ statusCode: 404, description: 'No such pet', type: undefined }]);
    });

    it('skips a schema-less application/json in favour of a +json entry that has one', () => {
      const { operation } = getPetWith404({
        'application/json': {},
        'application/problem+json': { schema: PROBLEM_REF },
      });
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Problem' } },
      ]);
    });

    it('leaves an error with no content untyped', () => {
      const { operation } = getPetWith404(undefined);
      expect(operation.errors).toEqual([{ statusCode: 404, description: 'No such pet', type: undefined }]);
    });
  });

  describe('unchanged neighbours', () => {
    it('names an inline +json body Error<code> exactly as an inline application/json body is', () => {
      const inline = { type: 'object', properties: { detail: { type: 'string' } } };
      const viaJson = getPetWith404({ 'application/json': { schema: inline } });
      const viaProblem = getPetWith404({ 'application/problem+json': { schema: inline } });
      expect(viaProblem.operation.errors).toEqual(viaJson.operation.errors);
      expect(viaProblem.operation.errors[0].type).toEqual({ kind: 'model', name: 'Error404' });
    });

    it('keeps a 4XX range key out of errors while typing the numeric sibling', () => {
      const { operation } = getPetWith404(
        { 'application/problem+json': { schema: PROBLEM_REF } },
        {
          '4XX': { description: 'Any client error', content: { 'application/problem+json': { schema: PROBLEM_REF } } },
        },
      );
      expect(operation.errors.map((e) => e.statusCode)).toEqual([404]);
      expect(operation.errors[0].type).toEqual({ kind: 'model', name: 'Problem' });
    });

    it('does not alter how the 2xx body is read', () => {
      const { operation } = getPetWith404({ 'application/problem+json': { schema: PROBLEM_REF } });
      expect(operation.response).toEqual({ kind: 'model', name: 'Pet' });
    });

    it('types a 5xx +json body the same way', () => {
      const { operation } = getPetWith404(undefined, {
        '500': { description: 'Boom', content: { 'application/problem+json': { schema: PROBLEM_REF } } },
      });
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: undefined },
        { statusCode: 500, description: 'Boom', type: { kind: 'model', name: 'Problem' } },
      ]);
    });
  });

  describe('through parseSpec (issue repro)', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('resolves the 404 to the Problem component model', async () => {
      dir = mkdtempSync(join(tmpdir(), 'oagen-235-'));
      const specPath = join(dir, 'repro.json');
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
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
                  },
                  '404': {
                    description: 'No such pet',
                    content: { 'application/problem+json': { schema: PROBLEM_REF } },
                  },
                },
              },
            },
          },
          components: { schemas: { Pet: COMPONENT_SCHEMAS.Pet, Problem: COMPONENT_SCHEMAS.Problem } },
        }),
      );

      const spec = await parseSpec(specPath);
      const [operation] = spec.services.flatMap(({ operations }) => operations);
      expect(operation.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Problem' } },
      ]);
      expect(spec.models.map((m) => m.name).sort()).toEqual(['Pet', 'Problem']);
    });
  });
});
