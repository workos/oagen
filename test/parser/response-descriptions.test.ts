import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import type { Operation } from '../../src/ir/types.js';

/** Extract the only operation declared by a GET /pets with the given responses. */
function singleOperation(responses: Record<string, unknown> | undefined): Operation {
  const paths = { '/pets': { get: { operationId: 'listPets', responses } } };
  const { services } = extractOperations(paths as never);
  const operations = services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return operations[0];
}

const petSchema = { type: 'object', properties: { name: { type: 'string' } } };
const json = (schema: unknown) => ({ 'application/json': { schema } });

describe('response descriptions', () => {
  describe('on the primary success response', () => {
    it('keeps the description of the only 2xx on the operation (issue #212 repro)', () => {
      const op = singleOperation({
        '200': { description: 'The pet, with its owner.', content: json(petSchema) },
      });

      expect(op.responseDescription).toBe('The pet, with its owner.');
      // A single 2xx never materializes `successResponses`, so the operation
      // field is the only home the description has.
      expect(op.successResponses).toBeUndefined();
      expect(JSON.stringify(op).includes('The pet, with its owner.')).toBe(true);
    });

    it('takes the description from the primary response, not the first declared', () => {
      // Declared 204 first, but the primary is the lowest 2xx with a body.
      const op = singleOperation({
        '204': { description: 'Nothing to return.' },
        '200': { description: 'The pet.', content: json(petSchema) },
      });

      expect(op.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
      expect(op.responseDescription).toBe('The pet.');
    });

    it('takes the description from the lowest bodiless 2xx when no 2xx has a body', () => {
      const op = singleOperation({
        '204': { description: 'Deleted.' },
        '202': { description: 'Accepted for deletion.' },
      });

      expect(op.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(op.responseDescription).toBe('Accepted for deletion.');
    });

    it('agrees with the primary entry of successResponses', () => {
      const op = singleOperation({
        '201': { description: 'The created pet.', content: json(petSchema) },
        '200': { description: 'The existing pet.', content: json(petSchema) },
      });

      const primary = op.successResponses?.find((r) => r.statusCode === 200);
      expect(primary?.description).toBe('The existing pet.');
      expect(op.responseDescription).toBe(primary?.description);
    });

    it('keeps a 3xx description, since redirects count as success entries', () => {
      const op = singleOperation({
        '302': { description: 'Redirects to the identity provider.' },
      });

      expect(op.responseDescription).toBe('Redirects to the identity provider.');
    });
  });

  describe('on each success and error entry', () => {
    it('keeps every 2xx description in successResponses', () => {
      const op = singleOperation({
        '200': { description: 'The pet.', content: json(petSchema) },
        '201': { description: 'The created pet.', content: json(petSchema) },
        '204': { description: 'No pet.' },
      });

      expect(op.successResponses?.map((r) => [r.statusCode, r.description])).toEqual([
        [200, 'The pet.'],
        [201, 'The created pet.'],
        [204, 'No pet.'],
      ]);
    });

    it('keeps 4xx and 5xx descriptions, with or without a body', () => {
      const op = singleOperation({
        '200': { description: 'The pet.', content: json(petSchema) },
        '404': { description: 'Not found.' },
        '422': {
          description: 'The pet is invalid.',
          content: json({ type: 'object', properties: { message: { type: 'string' } } }),
        },
        '500': { description: 'Something went wrong.' },
      });

      expect(op.errors.map((e) => [e.statusCode, e.description])).toEqual([
        [404, 'Not found.'],
        [422, 'The pet is invalid.'],
        [500, 'Something went wrong.'],
      ]);
      // The inline 422 body is materialized under the operation-qualified error name (#236).
      expect(op.errors[1].type).toEqual({ kind: 'model', name: 'ListPetsError422' });
    });

    it('keeps headers and description side by side on the same entry', () => {
      const op = singleOperation({
        '200': { description: 'The pet.', content: json(petSchema) },
        '429': {
          description: 'Throttled.',
          headers: { 'Retry-After': { schema: { type: 'integer' } } },
        },
      });

      expect(op.errors).toMatchInlineSnapshot(`
        [
          {
            "description": "Throttled.",
            "headers": [
              {
                "deprecated": undefined,
                "description": undefined,
                "name": "Retry-After",
                "required": false,
                "type": {
                  "kind": "primitive",
                  "type": "integer",
                },
              },
            ],
            "statusCode": 429,
            "type": undefined,
          },
        ]
      `);
    });
  });

  describe('absent, blank, or malformed descriptions', () => {
    it('omits the keys when no response declares a description', () => {
      const op = singleOperation({
        '200': { content: json(petSchema) },
        '201': { content: json(petSchema) },
        '404': {},
      });

      expect(op).not.toHaveProperty('responseDescription');
      for (const entry of op.successResponses ?? []) expect(entry).not.toHaveProperty('description');
      expect(op.errors[0]).not.toHaveProperty('description');
    });

    it('treats an empty or whitespace-only description as absent', () => {
      const op = singleOperation({
        '200': { description: '', content: json(petSchema) },
        '201': { description: ' \n\t ', content: json(petSchema) },
        '404': { description: '   ' },
      });

      expect(op).not.toHaveProperty('responseDescription');
      for (const entry of op.successResponses ?? []) expect(entry).not.toHaveProperty('description');
      expect(op.errors[0]).not.toHaveProperty('description');
    });

    it('ignores a description that is not a string rather than failing the parse', () => {
      const op = singleOperation({
        '200': { description: null, content: json(petSchema) },
        '404': { description: 42 },
      });

      expect(op).not.toHaveProperty('responseDescription');
      expect(op.errors[0]).not.toHaveProperty('description');
    });

    it('keeps text with content verbatim, surrounding whitespace included', () => {
      const op = singleOperation({
        '200': { description: '  The pet.\n', content: json(petSchema) },
      });

      expect(op.responseDescription).toBe('  The pet.\n');
    });

    it('omits responseDescription when the operation declares no responses', () => {
      const op = singleOperation(undefined);

      expect(op).not.toHaveProperty('responseDescription');
      expect(op.successResponses).toBeUndefined();
    });

    it('does not borrow a description from another status code', () => {
      const op = singleOperation({
        '200': { content: json(petSchema) },
        '404': { description: 'Not found.' },
      });

      expect(op).not.toHaveProperty('responseDescription');
      expect(op.errors[0].description).toBe('Not found.');
    });
  });

  describe('$ref responses', () => {
    it('reads a description written next to a $ref (OAS 3.1 sibling override)', () => {
      const op = singleOperation({
        '200': { $ref: '#/components/responses/Pet', description: 'The pet.' },
      });

      expect(op.responseDescription).toBe('The pet.');
    });

    it('leaves the description absent on a bare $ref, since components/responses is not resolved', () => {
      const op = singleOperation({
        '200': { $ref: '#/components/responses/Pet' },
        '404': { $ref: '#/components/responses/NotFound' },
      });

      expect(op).not.toHaveProperty('responseDescription');
      expect(op.errors[0]).not.toHaveProperty('description');
    });
  });

  describe('through parseSpec (issue #212 repro)', () => {
    const document = {
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              '200': { description: 'The pet, with its owner.', content: json(petSchema) },
              '404': { description: 'No pet has that id.' },
            },
          },
        },
      },
    };

    it('keeps the response descriptions all the way through the pipeline', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oagen-response-descriptions-'));
      try {
        const file = join(dir, 'repro.json');
        writeFileSync(file, JSON.stringify(document));
        const spec = await parseSpec(file);
        const [operation] = spec.services.flatMap(({ operations }) => operations);

        expect(JSON.stringify(operation).includes('The pet, with its owner.')).toBe(true);
        expect(operation.responseDescription).toBe('The pet, with its owner.');
        expect(operation.successResponses).toBeUndefined();
        expect(operation.errors).toEqual([{ statusCode: 404, type: undefined, description: 'No pet has that id.' }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
