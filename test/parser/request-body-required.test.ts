import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import type { Operation } from '../../src/ir/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/request-body-required.yml');

type ComponentRequestBodies = Record<string, Record<string, unknown>>;

/** Extract the only operation declared in an inline paths object. */
function singleOperation(paths: Record<string, unknown>, componentRequestBodies?: ComponentRequestBodies): Operation {
  const { services } = extractOperations(paths as never, undefined, undefined, undefined, componentRequestBodies);
  const operations = services.flatMap((s) => s.operations);
  expect(operations).toHaveLength(1);
  return operations[0];
}

const ok = { '204': { description: 'ok' } };
const noteSchema = { type: 'object', properties: { text: { type: 'string' } } };

/** A single `addNote` operation whose request body is the given Request Body Object (or `$ref`). */
function withBody(requestBody: unknown, method = 'post') {
  return { '/notes': { [method]: { operationId: 'addNote', requestBody, responses: ok } } };
}

/** The request-body fields an emitter reads together, plus whether the flag key exists at all. */
function bodyFields(op: Operation) {
  return {
    requestBody: op.requestBody,
    requestBodyEncoding: op.requestBodyEncoding,
    requestBodyRequired: op.requestBodyRequired,
    hasFlag: Object.keys(op).includes('requestBodyRequired'),
  };
}

describe('request body required (issue #213)', () => {
  describe('through parseSpec (issue repro)', () => {
    it('tells a body the document marks required from one it does not', async () => {
      const spec = await parseSpec(FIXTURE);
      const projected = spec.services
        .flatMap((s) => s.operations)
        .map(({ name, requestBody, requestBodyEncoding, requestBodyRequired }) => ({
          name,
          requestBody,
          requestBodyEncoding,
          requestBodyRequired,
        }));
      expect(projected).toMatchInlineSnapshot(`
        [
          {
            "name": "listPets",
            "requestBody": undefined,
            "requestBodyEncoding": undefined,
            "requestBodyRequired": undefined,
          },
          {
            "name": "createPet",
            "requestBody": {
              "kind": "model",
              "name": "CreatePetRequest",
            },
            "requestBodyEncoding": "json",
            "requestBodyRequired": true,
          },
          {
            "name": "addNote",
            "requestBody": {
              "kind": "model",
              "name": "AddNoteRequest",
            },
            "requestBodyEncoding": "json",
            "requestBodyRequired": false,
          },
          {
            "name": "setPhoto",
            "requestBody": {
              "kind": "model",
              "name": "SetPhotoRequest",
            },
            "requestBodyEncoding": "form-data",
            "requestBodyRequired": true,
          },
        ]
      `);
    });

    it('omits the field from an operation without a body', async () => {
      const spec = await parseSpec(FIXTURE);
      const listPets = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'listPets');
      expect(listPets).toBeDefined();
      expect(Object.keys(listPets!)).not.toContain('requestBodyRequired');
    });
  });

  describe('the flag', () => {
    it('is true for required: true', () => {
      const op = singleOperation(withBody({ required: true, content: { 'application/json': { schema: noteSchema } } }));
      expect(op.requestBodyRequired).toBe(true);
    });

    it('is false, and present, when the document omits required (the OpenAPI default)', () => {
      const op = singleOperation(withBody({ content: { 'application/json': { schema: noteSchema } } }));
      expect(op.requestBodyRequired).toBe(false);
      expect(Object.keys(op)).toContain('requestBodyRequired');
    });

    it('is false for an explicit required: false', () => {
      const op = singleOperation(
        withBody({ required: false, content: { 'application/json': { schema: noteSchema } } }),
      );
      expect(op.requestBodyRequired).toBe(false);
    });

    it('is false for a non-boolean required, which declares nothing', () => {
      const op = singleOperation(
        withBody({ required: 'true', content: { 'application/json': { schema: noteSchema } } }),
      );
      expect(op.requestBodyRequired).toBe(false);
    });

    it('is absent when the operation declares no body', () => {
      const get = singleOperation({ '/notes': { get: { operationId: 'listNotes', responses: ok } } });
      expect(Object.keys(get)).not.toContain('requestBodyRequired');

      const post = singleOperation({ '/notes': { post: { operationId: 'addNote', responses: ok } } });
      expect(Object.keys(post)).not.toContain('requestBodyRequired');
    });

    it('is absent when a declared body yields no IR body', () => {
      // No `content` at all: nothing to type, so nothing to require.
      const contentless = singleOperation(withBody({ required: true }));
      expect(contentless.requestBody).toBeUndefined();
      expect(Object.keys(contentless)).not.toContain('requestBodyRequired');

      // JSON without a schema is dropped by the parser; the flag follows the body.
      const schemaless = singleOperation(withBody({ required: true, content: { 'application/json': {} } }));
      expect(schemaless.requestBody).toBeUndefined();
      expect(Object.keys(schemaless)).not.toContain('requestBodyRequired');
    });

    it('does not leak into the body type', () => {
      const op = singleOperation(withBody({ required: true, content: { 'application/json': { schema: noteSchema } } }));
      expect(op.requestBody).toEqual({ kind: 'model', name: 'AddNoteRequest' });
    });
  });

  describe('is read after $ref resolution', () => {
    const note = { required: true, content: { 'application/json': { schema: noteSchema } } };

    it('honours required on a components/requestBodies entry', () => {
      const op = singleOperation(withBody({ $ref: '#/components/requestBodies/Note' }), { Note: note });
      expect(bodyFields(op)).toEqual({
        requestBody: { kind: 'model', name: 'AddNoteRequest' },
        requestBodyEncoding: 'json',
        requestBodyRequired: true,
        hasFlag: true,
      });
    });

    it('follows a $ref chain to the body that carries the flag', () => {
      const componentRequestBodies = { Alias: { $ref: '#/components/requestBodies/Note' }, Note: note };
      const op = singleOperation(withBody({ $ref: '#/components/requestBodies/Alias' }), componentRequestBodies);
      expect(op.requestBodyRequired).toBe(true);
    });

    it('defaults a referenced body without the flag to false', () => {
      const unflagged = { content: { 'application/json': { schema: noteSchema } } };
      const op = singleOperation(withBody({ $ref: '#/components/requestBodies/Note' }), { Note: unflagged });
      expect(op.requestBodyRequired).toBe(false);
    });

    it('gives every operation sharing a component body the same flag', () => {
      const paths = {
        '/notes': {
          post: { operationId: 'addNote', requestBody: { $ref: '#/components/requestBodies/Note' }, responses: ok },
        },
        '/notes/{id}': {
          put: { operationId: 'replaceNote', requestBody: { $ref: '#/components/requestBodies/Note' }, responses: ok },
        },
      };
      const { services } = extractOperations(paths as never, undefined, undefined, undefined, { Note: note });
      const flags = services.flatMap((s) => s.operations).map((o) => [o.name, o.requestBodyRequired]);
      expect(flags).toEqual([
        ['addNote', true],
        ['replaceNote', true],
      ]);
    });
  });

  describe('follows the body whatever its encoding or shape', () => {
    it.each([
      [
        'multipart/form-data',
        'form-data',
        { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
      ],
      ['application/x-www-form-urlencoded', 'form-urlencoded', noteSchema],
    ])('a %s body', (mediaType, encoding, schema) => {
      const op = singleOperation(withBody({ required: true, content: { [mediaType]: { schema } } }));
      expect(op.requestBodyEncoding).toBe(encoding);
      expect(op.requestBodyRequired).toBe(true);
    });

    it('a schema-less binary body', () => {
      const op = singleOperation(withBody({ required: true, content: { 'application/octet-stream': {} } }));
      expect(bodyFields(op)).toEqual({
        requestBody: { kind: 'primitive', type: 'string', format: 'binary' },
        requestBodyEncoding: 'binary',
        requestBodyRequired: true,
        hasFlag: true,
      });
    });

    it('a schema-less text body the document leaves optional', () => {
      const op = singleOperation(withBody({ content: { 'text/plain': {} } }));
      expect(bodyFields(op)).toEqual({
        requestBody: { kind: 'primitive', type: 'string' },
        requestBodyEncoding: 'text',
        requestBodyRequired: false,
        hasFlag: true,
      });
    });

    it('a body whose schema is a bare $ref', () => {
      const op = singleOperation(
        withBody({
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } },
        }),
      );
      expect(op.requestBody).toEqual({ kind: 'model', name: 'Note' });
      expect(op.requestBodyRequired).toBe(true);
    });

    it('a oneOf body', () => {
      const schema = { oneOf: [{ $ref: '#/components/schemas/Text' }, { $ref: '#/components/schemas/Link' }] };
      const op = singleOperation(withBody({ required: true, content: { 'application/json': { schema } } }));
      expect(op.requestBody?.kind).toBe('union');
      expect(op.requestBodyRequired).toBe(true);
    });

    it('a body on a method that does not usually carry one', () => {
      const op = singleOperation(
        withBody({ required: true, content: { 'application/json': { schema: noteSchema } } }, 'delete'),
      );
      expect(op.httpMethod).toBe('delete');
      expect(op.requestBodyRequired).toBe(true);
    });
  });
});
