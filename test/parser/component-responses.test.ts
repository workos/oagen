import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { collectModelRefs } from '../../src/ir/types.js';
import type { Model, Operation } from '../../src/ir/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/component-responses.yml');

type Components = Record<string, Record<string, unknown>>;

interface ExtractOptions {
  schemas?: Components;
  headers?: Components;
  responses?: Components;
}

/** Run operation extraction over inline paths with the given component maps. */
function extract(paths: Record<string, unknown>, components: ExtractOptions = {}) {
  return extractOperations(
    paths as never,
    undefined,
    components.schemas as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    components.headers,
    components.responses,
  );
}

function operations(paths: Record<string, unknown>, components: ExtractOptions = {}): Operation[] {
  return extract(paths, components).services.flatMap((s) => s.operations);
}

function singleOperation(paths: Record<string, unknown>, components: ExtractOptions = {}): Operation {
  const ops = operations(paths, components);
  expect(ops).toHaveLength(1);
  return ops[0];
}

/** A GET with an operationId whose responses are the given map. */
function get(operationId: string, responses: Record<string, unknown>, path = `/${operationId}`) {
  return { [path]: { get: { operationId, responses } } };
}

const PET_SCHEMA = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
const PROBLEM_SCHEMA = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };

const petFound = {
  description: 'The pet',
  headers: { 'X-Rate-Limit': { schema: { type: 'integer' } } },
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
};
const notFound = {
  description: 'No such pet',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } },
};
const ownerCard = {
  description: 'An owner',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          display_name: { type: 'string' },
          address: { type: 'object', properties: { city: { type: 'string' } } },
        },
        required: ['display_name'],
      },
    },
  },
};

describe('responses written as $ref into components/responses (issue #234)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("the issue's repro", () => {
    const paths = get('getPet', {
      '200': { $ref: '#/components/responses/PetFound' },
      '404': { $ref: '#/components/responses/NotFound' },
    });
    const components: ExtractOptions = {
      schemas: { Pet: PET_SCHEMA, Problem: PROBLEM_SCHEMA },
      responses: { PetFound: petFound, NotFound: notFound },
    };

    it('types the 2xx from the component body and keeps its headers', () => {
      const op = singleOperation(paths, components);
      expect(op.response).toEqual({ kind: 'model', name: 'Pet' });
      expect(op.responseHeaders).toEqual([
        {
          name: 'X-Rate-Limit',
          type: { kind: 'primitive', type: 'integer' },
          required: false,
          description: undefined,
          deprecated: undefined,
        },
      ]);
    });

    it('types the 4xx from the component body', () => {
      const op = singleOperation(paths, components);
      expect(op.errors).toEqual([
        { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Problem' } },
      ]);
    });

    it('mints no model for a component body that is itself a $ref', () => {
      expect(extract(paths, components).inlineModels).toEqual([]);
    });
  });

  describe('resolution edge cases', () => {
    it('follows a chain of refs (A -> B) to the body and headers at its end', () => {
      const op = singleOperation(get('getPet', { '200': { $ref: '#/components/responses/Alias' } }), {
        responses: { Alias: { $ref: '#/components/responses/PetFound' }, PetFound: petFound },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'Pet' });
      expect(op.responseHeaders?.map((h) => h.name)).toEqual(['X-Rate-Limit']);
    });

    it('throws on a circular chain, naming the ref and the response it hangs off', () => {
      expect(() =>
        operations(get('getPet', { '200': { $ref: '#/components/responses/A' } }), {
          responses: { A: { $ref: '#/components/responses/B' }, B: { $ref: '#/components/responses/A' } },
        }),
      ).toThrow('Circular response $ref chain starting at "#/components/responses/A" in 200 response of getPet.');
    });

    it('warns on a ref no component answers, with the status code and operation as context, and reads the response as before', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const [op] = operations(
        get('getPet', { '404': { $ref: '#/components/responses/Missing', description: 'Gone' } }),
        { responses: {} },
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Unresolved response $ref "#/components/responses/Missing" in 404 response of getPet: no matching entry under components/responses',
        ),
      );
      // As on main before refs were resolved: untyped, no headers, the sibling description kept.
      expect(op.errors).toEqual([{ statusCode: 404, type: undefined, description: 'Gone' }]);

      // No components/responses at all reads the same way: the 200 is `unknown`.
      const [noComponents] = operations(get('getPet', { '200': { $ref: '#/components/responses/PetFound' } }));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Unresolved response $ref "#/components/responses/PetFound" in 200 response of getPet'),
      );
      expect(noComponents.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(noComponents).not.toHaveProperty('responseHeaders');
    });

    it('reads a pointer outside components/responses (a bundler-written path pointer) as it did before, with a warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ops = operations({
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: PET_SCHEMA } } } },
          },
        },
        '/pets2': {
          get: { operationId: 'listPets2', responses: { '200': { $ref: '#/paths/~1pets/get/responses/200' } } },
        },
      });
      expect(ops.find((o) => o.name === 'listPets2')?.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Unresolved response $ref "#/paths/~1pets/get/responses/200" in 200 response of listPets2',
        ),
      );
    });

    it('names an operationId-less operation by method and path in the warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      operations(
        { '/pets/{petId}': { delete: { responses: { '200': { $ref: '#/components/responses/Missing' } } } } },
        { responses: {} },
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('in 200 response of DELETE /pets/{petId}'));
    });

    it('does not resolve a ref into another section off a same-named response component', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const [op] = operations(get('getPet', { '200': { $ref: '#/components/schemas/Pet' } }), {
        schemas: { Pet: PET_SCHEMA },
        responses: { Pet: petFound },
      });
      expect(op.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Unresolved response $ref "#/components/schemas/Pet" in 200 response of getPet'),
      );
    });

    it('keeps the sibling description beside the $ref on the resolved response (OAS 3.1)', async () => {
      // The IR carries no response description yet; the resolved object does,
      // the outermost sibling winning, so a later field reads it unchanged.
      const { resolveResponseRef } = await import('../../src/parser/response-refs.js');
      const resolved = resolveResponseRef<typeof petFound>(
        { $ref: '#/components/responses/PetFound', description: 'Found it' },
        { PetFound: petFound },
        '200 response of getPet',
      );
      expect(resolved).toEqual({ ...petFound, description: 'Found it' });
    });

    it('resolves the headers of a component response through components/headers', () => {
      const op = singleOperation(get('getPet', { '200': { $ref: '#/components/responses/PetFound' } }), {
        headers: { RequestId: { description: 'Correlates the response.', schema: { type: 'string' } } },
        responses: {
          PetFound: {
            ...petFound,
            headers: { 'X-Request-Id': { $ref: '#/components/headers/RequestId' }, ...petFound.headers },
          },
        },
      });
      expect(op.responseHeaders).toEqual([
        {
          name: 'X-Request-Id',
          type: { kind: 'primitive', type: 'string' },
          required: false,
          description: 'Correlates the response.',
          deprecated: undefined,
        },
        {
          name: 'X-Rate-Limit',
          type: { kind: 'primitive', type: 'integer' },
          required: false,
          description: undefined,
          deprecated: undefined,
        },
      ]);
    });

    it('reads a ref to a 204 with headers and no content', () => {
      const op = singleOperation(
        {
          '/pets/{petId}/adopt': {
            post: { operationId: 'adoptPet', responses: { '204': { $ref: '#/components/responses/Adopted' } } },
          },
        },
        {
          headers: { RequestId: { schema: { type: 'string' } } },
          responses: {
            Adopted: { description: 'Yours', headers: { 'X-Request-Id': { $ref: '#/components/headers/RequestId' } } },
          },
        },
      );
      expect(op.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(op.successResponses).toBeUndefined();
      expect(op.responseHeaders?.map((h) => h.name)).toEqual(['X-Request-Id']);
      expect(op.errors).toEqual([]);
    });

    it('leaves a specification extension beside the responses alone', () => {
      const op = singleOperation(
        get('getPet', { '200': { $ref: '#/components/responses/PetFound' }, 'x-internal': 'yes' }),
        { responses: { PetFound: petFound } },
      );
      expect(op.response).toEqual({ kind: 'model', name: 'Pet' });
    });

    it('resolves a 3xx ref for its headers', () => {
      const op = singleOperation(
        get('getPet', {
          '200': { $ref: '#/components/responses/PetFound' },
          '302': { $ref: '#/components/responses/Moved' },
        }),
        {
          responses: {
            PetFound: petFound,
            Moved: { description: 'Elsewhere', headers: { Location: { schema: { type: 'string' } } } },
          },
        },
      );
      expect(op.successResponses?.map((r) => [r.statusCode, r.headers?.map((h) => h.name)])).toEqual([
        [200, ['X-Rate-Limit']],
        [302, ['Location']],
      ]);
    });
  });

  describe('an inline body shared through a component', () => {
    const sharedPaths = {
      ...get('getOwner', { '200': { $ref: '#/components/responses/OwnerCard' } }, '/owners/{ownerId}'),
      ...get('previewOwner', { '200': { $ref: '#/components/responses/OwnerCard' } }, '/owners/{ownerId}/preview'),
    };

    it('is named after the component, not the operation, so both operations share one model', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { services, inlineModels } = extract(sharedPaths, { responses: { OwnerCard: ownerCard } });
      const ops = services.flatMap((s) => s.operations);
      expect(ops.map((op) => op.response)).toEqual([
        { kind: 'model', name: 'OwnerCardResponse' },
        { kind: 'model', name: 'OwnerCardResponse' },
      ]);
      // One copy per referring operation leaves extraction, identical field
      // for field, so the inline-model merge keeps a single definition
      // without a word about it.
      const copies = inlineModels.filter((m) => m.name === 'OwnerCardResponse');
      expect(copies).toHaveLength(2);
      expect(copies[0]).toEqual(copies[1]);
      expect(inlineModels.map((m) => m.name)).toEqual([
        'OwnerCardResponse',
        'OwnerCardResponseAddress',
        'OwnerCardResponse',
        'OwnerCardResponseAddress',
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not double the suffix of a component already named …Response', () => {
      const op = singleOperation(get('getOwner', { '200': { $ref: '#/components/responses/OwnerCardResponse' } }), {
        responses: { OwnerCardResponse: ownerCard },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'OwnerCardResponse' });
    });

    it('cleans the component name like an operationId-derived one', () => {
      const op = singleOperation(get('getOwner', { '200': { $ref: '#/components/responses/owners-found' } }), {
        responses: { 'owners-found': ownerCard },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'OwnerFoundResponse' });
    });

    it('names the body after the ref the operation wrote, not the end of a chain', () => {
      const op = singleOperation(get('getOwner', { '200': { $ref: '#/components/responses/Alias' } }), {
        responses: { Alias: { $ref: '#/components/responses/OwnerCard' }, OwnerCard: ownerCard },
      });
      expect(op.response).toEqual({ kind: 'model', name: 'AliasResponse' });
    });

    it('hands the error branch the component-derived context name', () => {
      // Inline error bodies are still typed as before (no model is minted
      // for them here); only the name they are typed under changes, from
      // `Error409` to the component's, so a later rename composes.
      const op = singleOperation(get('adoptPet', { '409': { $ref: '#/components/responses/Conflict' } }), {
        responses: {
          Conflict: {
            description: 'Taken',
            content: {
              'application/json': { schema: { type: 'object', properties: { adopted_by: { type: 'string' } } } },
            },
          },
        },
      });
      expect(op.errors).toEqual([
        { statusCode: 409, description: 'Taken', type: { kind: 'model', name: 'ConflictResponse' } },
      ]);
    });

    // An operationId-less `GET /owner` names its inline body `OwnerGetResponse`
    // from the path; a component response `OwnerGet` names its inline body the
    // same way. Without a reservation the two shapes would fight over one name.
    const unnamedGetOwner = {
      '/owner': {
        get: {
          responses: {
            '200': {
              description: 'An inline body named from the path',
              content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
            },
          },
        },
      },
    };

    it('reserves the component stem so a path-derived name steps around it', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { services, inlineModels } = extract(
        {
          ...get('getOwner', { '200': { $ref: '#/components/responses/OwnerGet' } }, '/owners/{ownerId}'),
          ...unnamedGetOwner,
        },
        { responses: { OwnerGet: ownerCard } },
      );
      const byPath = new Map(services.flatMap((s) => s.operations).map((op) => [op.path, op.response]));
      expect(byPath.get('/owners/{ownerId}')).toEqual({ kind: 'model', name: 'OwnerGetResponse' });
      const pathDerived = byPath.get('/owner') as { kind: string; name: string };
      expect(pathDerived.kind).toBe('model');
      expect(pathDerived.name).not.toBe('OwnerGetResponse');
      expect(pathDerived.name).toMatch(/^Owner[0-9A-Fa-f]{6}GetResponse$/);
      expect(inlineModels.filter((m) => m.name === 'OwnerGetResponse')).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps a path-derived name plain when no component response reserves its stem', () => {
      const op = singleOperation(unnamedGetOwner, { responses: { PetFound: petFound } });
      expect(op.response).toEqual({ kind: 'model', name: 'OwnerGetResponse' });
    });

    // Greptile, after the merge with main: a path stem that extends the
    // component's stem starts with no reserved stem, yet its `…Response` is a
    // name the component body mints for a nested object.
    const addressCard = {
      description: 'An owner card',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { address_get_response: { type: 'object', properties: { street: { type: 'string' } } } },
          },
        },
      },
    };
    const cardOwner = get('getOwner', { '200': { $ref: '#/components/responses/OwnerCard' } }, '/owners/{ownerId}');
    const unnamedAddress = {
      '/owner/card/response/address': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': { schema: { type: 'object', properties: { line1: { type: 'string' } } } },
              },
            },
          },
        },
      },
    };
    it.each([
      ['component first', { ...cardOwner, ...unnamedAddress }],
      ['path first', { ...unnamedAddress, ...cardOwner }],
    ])('reserves the names the component body mints, not only its stem (%s)', (_order, paths) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { services, inlineModels } = extract(paths, { responses: { OwnerCard: addressCard } });
      const byPath = new Map(services.flatMap((s) => s.operations).map((op) => [op.path, op.response]));
      expect(byPath.get('/owners/{ownerId}')).toEqual({ kind: 'model', name: 'OwnerCardResponse' });
      const nested = inlineModels.filter((m) => m.name === 'OwnerCardResponseAddressGetResponse');
      expect(nested).toHaveLength(1);
      expect(nested[0].fields.map((f) => f.name)).toEqual(['street']);
      const pathDerived = byPath.get('/owner/card/response/address') as { kind: string; name: string };
      expect(pathDerived.kind).toBe('model');
      expect(pathDerived.name).not.toBe('OwnerCardResponseAddressGetResponse');
      const own = inlineModels.filter((m) => m.name === pathDerived.name);
      expect(own).toHaveLength(1);
      expect(own[0].fields.map((f) => f.name)).toEqual(['line1']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reserves the names a non-JSON component body mints too (the first media type with a schema)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const yamlCard = {
        description: 'An owner card',
        content: { 'application/yaml': addressCard.content['application/json'] },
      };
      const { services, inlineModels } = extract(
        { ...cardOwner, ...unnamedAddress },
        { responses: { OwnerCard: yamlCard } },
      );
      const byPath = new Map(services.flatMap((s) => s.operations).map((op) => [op.path, op.response]));
      expect(byPath.get('/owners/{ownerId}')).toEqual({ kind: 'model', name: 'OwnerCardResponse' });
      expect(inlineModels.filter((m) => m.name === 'OwnerCardResponseAddressGetResponse')).toHaveLength(1);
      const pathDerived = byPath.get('/owner/card/response/address') as { kind: string; name: string };
      expect(pathDerived.name).not.toBe('OwnerCardResponseAddressGetResponse');
      expect(inlineModels.filter((m) => m.name === pathDerived.name)[0].fields.map((f) => f.name)).toEqual(['line1']);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('an operation returning different shared bodies at two success codes', () => {
    // 200 and 201 each reference a component with its own inline body, so the
    // two bodies take two names. Keeping only the body read last would leave
    // the primary `response` pointing at a model nobody returned.
    const newOwner = {
      description: 'An owner just created, with a page of its pets',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              data: { type: 'array', items: { type: 'object', properties: { nickname: { type: 'string' } } } },
              list_metadata: { type: 'object', properties: { after: { type: 'string' } } },
            },
            required: ['data', 'list_metadata'],
          },
        },
      },
    };
    const components: ExtractOptions = { responses: { OwnerCard: ownerCard, NewOwner: newOwner } };

    /** Every model a success response references, against the models extraction returned. */
    function expectNoDanglingRefs(op: Operation, inlineModels: Model[]) {
      const known = new Set(inlineModels.map((m) => m.name));
      const referenced = [op.response, ...(op.successResponses ?? []).map((r) => r.type)].flatMap(collectModelRefs);
      expect(referenced.length).toBeGreaterThan(0);
      expect(referenced.filter((name) => !known.has(name))).toEqual([]);
    }

    it('keeps both bodies, the primary first, and takes paging from the primary', () => {
      const { services, inlineModels } = extract(
        get('createOwner', {
          '200': { $ref: '#/components/responses/OwnerCard' },
          '201': { $ref: '#/components/responses/NewOwner' },
        }),
        components,
      );
      const [op] = services.flatMap((s) => s.operations);
      expect(op.response).toEqual({ kind: 'model', name: 'OwnerCardResponse' });
      expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
        [200, { kind: 'model', name: 'OwnerCardResponse' }],
        [201, { kind: 'array', items: { kind: 'model', name: 'NewOwnerItem' } }],
      ]);
      // The 201 page was read last; the primary 200 is a plain object.
      expect(op.pagination).toBeUndefined();
      expect(inlineModels.map((m) => m.name)).toEqual([
        'OwnerCardResponse',
        'OwnerCardResponseAddress',
        'NewOwnerItem',
      ]);
      expectNoDanglingRefs(op, inlineModels);
    });

    it('takes paging from the primary whatever order the status codes are declared in', () => {
      const { services, inlineModels } = extract(
        get('createOwner', {
          '201': { $ref: '#/components/responses/OwnerCard' },
          '200': { $ref: '#/components/responses/NewOwner' },
        }),
        components,
      );
      const [op] = services.flatMap((s) => s.operations);
      // The primary is still the lowest 2xx with a typed body: the 200 page.
      expect(op.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'NewOwnerItem' } });
      expect(op.pagination).toMatchObject({ dataPath: 'data', itemType: { kind: 'model', name: 'NewOwnerItem' } });
      expect(op.pagination?.envelopeFields?.map((f) => f.name)).toEqual(['list_metadata']);
      // The primary's models lead, the other body's follow; the primary
      // envelope's companion is named across operations afterwards, so it
      // comes last.
      expect(inlineModels.map((m) => m.name)).toEqual([
        'NewOwnerItem',
        'OwnerCardResponse',
        'OwnerCardResponseAddress',
        'ListMetadata',
      ]);
      expectNoDanglingRefs(op, inlineModels);
    });
  });

  describe('through parseSpec', () => {
    describe('a description written beside the $ref', () => {
      let dir: string | undefined;
      afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
      });

      // Greptile, after the merge with main: a component schema that already
      // owns `<Component>Response` must not be folded onto by the shared body,
      // which steps to the first free numbered name and stays shared.
      it.each([
        [
          'a component schema owns the name',
          { schemas: { OwnerCardResponse: { type: 'object', properties: { id: { type: 'string' } } } } },
        ],
        ['a component response named like it derives it', { responses: { OwnerCardResponse: ownerCard } }],
      ])('steps a shared body to a numbered name when %s', async (_why, extraComponents: Record<string, unknown>) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        dir = mkdtempSync(join(tmpdir(), 'oagen-234-'));
        const specPath = join(dir, 'spec.json');
        const components = {
          schemas: { ...(extraComponents.schemas as object) },
          responses: {
            OwnerCard: {
              description: 'An owner',
              content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } } } },
            },
            ...(extraComponents.responses as object),
          },
        };
        writeFileSync(
          specPath,
          JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'clash', version: '1' },
            paths: {
              '/owners/{ownerId}': {
                get: { operationId: 'getOwner', responses: { '200': { $ref: '#/components/responses/OwnerCard' } } },
              },
            },
            components,
          }),
        );
        const spec = await parseSpec(specPath);
        const op = spec.services.flatMap((s) => s.operations)[0];
        expect(op.response).toEqual({ kind: 'model', name: 'OwnerCardResponse2' });
        const own = spec.models.find((m) => m.name === 'OwnerCardResponse2');
        expect(own?.fields.map((f) => [f.name, f.type])).toEqual([['id', { kind: 'primitive', type: 'integer' }]]);
        if (extraComponents.schemas) {
          const component = spec.models.find((m) => m.name === 'OwnerCardResponse');
          expect(component?.fields.map((f) => [f.name, f.type])).toEqual([
            ['id', { kind: 'primitive', type: 'string' }],
          ]);
        }
        expect(warn).not.toHaveBeenCalled();
      });

      it('steps past a name a nested model would take too (Greptile)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        dir = mkdtempSync(join(tmpdir(), 'oagen-234-'));
        const specPath = join(dir, 'spec.json');
        writeFileSync(
          specPath,
          JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'clash', version: '1' },
            paths: {
              '/owners/{ownerId}': {
                get: { operationId: 'getOwner', responses: { '200': { $ref: '#/components/responses/OwnerCard' } } },
              },
            },
            components: {
              schemas: {
                OwnerCardResponse: { type: 'object', properties: { id: { type: 'string' } } },
                OwnerCardResponse2Detail: { type: 'object', properties: { value: { type: 'string' } } },
              },
              responses: {
                OwnerCard: {
                  description: 'An owner',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { detail: { type: 'object', properties: { value: { type: 'integer' } } } },
                      },
                    },
                  },
                },
              },
            },
          }),
        );
        const spec = await parseSpec(specPath);
        const op = spec.services.flatMap((s) => s.operations)[0];
        expect(op.response).toEqual({ kind: 'model', name: 'OwnerCardResponse3' });
        const fieldsOf = (name: string) =>
          spec.models.find((m) => m.name === name)?.fields.map((f) => [f.name, f.type]);
        expect(fieldsOf('OwnerCardResponse3')).toEqual([
          ['detail', { kind: 'model', name: 'OwnerCardResponse3Detail' }],
        ]);
        expect(fieldsOf('OwnerCardResponse3Detail')).toEqual([['value', { kind: 'primitive', type: 'integer' }]]);
        expect(fieldsOf('OwnerCardResponse2Detail')).toEqual([['value', { kind: 'primitive', type: 'string' }]]);
        expect(fieldsOf('OwnerCardResponse')).toEqual([['id', { kind: 'primitive', type: 'string' }]]);
        expect(warn).not.toHaveBeenCalled();
      });

      it('keeps stepping however many numbered names are taken (Greptile)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        dir = mkdtempSync(join(tmpdir(), 'oagen-234-'));
        const specPath = join(dir, 'spec.json');
        const schemas: Record<string, unknown> = {
          OwnerCardResponse: { type: 'object', properties: { id: { type: 'string' } } },
        };
        for (let n = 2; n <= 99; n++) {
          schemas[`OwnerCardResponse${n}`] = { type: 'object', properties: { id: { type: 'string' } } };
        }
        writeFileSync(
          specPath,
          JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'clash', version: '1' },
            paths: {
              '/owners/{ownerId}': {
                get: { operationId: 'getOwner', responses: { '200': { $ref: '#/components/responses/OwnerCard' } } },
              },
            },
            components: {
              schemas,
              responses: {
                OwnerCard: {
                  description: 'An owner',
                  content: {
                    'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } } },
                  },
                },
              },
            },
          }),
        );
        const spec = await parseSpec(specPath);
        const op = spec.services.flatMap((s) => s.operations)[0];
        expect(op.response).toEqual({ kind: 'model', name: 'OwnerCardResponse100' });
        const fieldsOf = (name: string) =>
          spec.models.find((m) => m.name === name)?.fields.map((f) => [f.name, f.type]);
        expect(fieldsOf('OwnerCardResponse100')).toEqual([['id', { kind: 'primitive', type: 'integer' }]]);
        expect(fieldsOf('OwnerCardResponse99')).toEqual([['id', { kind: 'primitive', type: 'string' }]]);
        expect(warn).not.toHaveBeenCalled();
      });

      it('keeps two stepped bodies of one operation apart (200 and 201)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        dir = mkdtempSync(join(tmpdir(), 'oagen-234-'));
        const specPath = join(dir, 'spec.json');
        const inline = (name: string, type: string) => ({
          description: name,
          content: { 'application/json': { schema: { type: 'object', properties: { [name]: { type } } } } },
        });
        writeFileSync(
          specPath,
          JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'clash', version: '1' },
            paths: {
              '/owners': {
                post: {
                  operationId: 'createOwner',
                  responses: {
                    '200': { $ref: '#/components/responses/OwnerCard' },
                    '201': { $ref: '#/components/responses/NewOwner' },
                  },
                },
              },
            },
            components: {
              schemas: {
                OwnerCardResponse: { type: 'object', properties: { id: { type: 'string' } } },
                NewOwnerResponse: { type: 'object', properties: { name: { type: 'string' } } },
              },
              responses: { OwnerCard: inline('id', 'integer'), NewOwner: inline('name', 'integer') },
            },
          }),
        );
        const spec = await parseSpec(specPath);
        const op = spec.services.flatMap((s) => s.operations)[0];
        expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
          [200, { kind: 'model', name: 'OwnerCardResponse2' }],
          [201, { kind: 'model', name: 'NewOwnerResponse2' }],
        ]);
        const fieldsOf = (name: string) =>
          spec.models.find((m) => m.name === name)?.fields.map((f) => [f.name, f.type]);
        expect(fieldsOf('OwnerCardResponse2')).toEqual([['id', { kind: 'primitive', type: 'integer' }]]);
        expect(fieldsOf('NewOwnerResponse2')).toEqual([['name', { kind: 'primitive', type: 'integer' }]]);
        expect(fieldsOf('OwnerCardResponse')).toEqual([['id', { kind: 'primitive', type: 'string' }]]);
        expect(fieldsOf('NewOwnerResponse')).toEqual([['name', { kind: 'primitive', type: 'string' }]]);
        expect(warn).not.toHaveBeenCalled();
      });

      async function parseWithVersion(openapi: string): Promise<Operation> {
        dir = mkdtempSync(join(tmpdir(), 'oagen-234-'));
        const specPath = join(dir, 'spec.json');
        writeFileSync(
          specPath,
          JSON.stringify({
            openapi,
            info: { title: 'sibling', version: '1' },
            paths: {
              '/pet': {
                get: {
                  operationId: 'getPet',
                  responses: { '200': { $ref: '#/components/responses/PetFound', description: 'Sibling.' } },
                },
              },
            },
            components: { schemas: { Pet: PET_SCHEMA }, responses: { PetFound: petFound } },
          }),
        );
        const spec = await parseSpec(specPath);
        return spec.services.flatMap((s) => s.operations)[0];
      }

      it("overrides the component's in an OAS 3.1 document", async () => {
        expect((await parseWithVersion('3.1.0')).responseDescription).toBe('Sibling.');
      });

      it('is ignored in an OAS 3.0 document, where properties beside a $ref are ignored', async () => {
        expect((await parseWithVersion('3.0.3')).responseDescription).toBe('The pet');
      });
    });

    it('resolves every component response of the fixture with no warnings and no dangling model refs', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseSpec(FIXTURE);
      validateModelRefs(spec);
      expect(warn.mock.calls).toEqual([]);

      const byName = new Map(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

      const getPet = byName.get('getPet')!;
      expect(getPet.response).toEqual({ kind: 'model', name: 'Pet' });
      expect(getPet.responseHeaders?.map((h) => [h.name, h.type, h.description])).toEqual([
        ['X-Rate-Limit', { kind: 'primitive', type: 'integer' }, undefined],
        ['X-Request-Id', { kind: 'primitive', type: 'string' }, 'Correlates the response with a request.'],
      ]);
      const notFound = { statusCode: 404, description: 'No such pet', type: { kind: 'model', name: 'Problem' } };
      expect(getPet.errors).toEqual([notFound]);

      // Two operations, one shared inline body: one model, both point at it.
      expect(byName.get('getOwner')!.response).toEqual({ kind: 'model', name: 'OwnerCardResponse' });
      expect(byName.get('previewOwner')!.response).toEqual({ kind: 'model', name: 'OwnerCardResponse' });
      expect(byName.get('getOwner')!.errors).toEqual([notFound]);

      // A shared inline list envelope: one item model, one page shape.
      const listPetPhotos = byName.get('listPetPhotos')!;
      expect(listPetPhotos.response).toEqual({ kind: 'array', items: { kind: 'model', name: 'PhotoPageItem' } });
      expect(listPetPhotos.pagination?.dataPath).toBe('data');
      expect(byName.get('getPetPhoto')!.response).toEqual(listPetPhotos.response);

      const adoptPet = byName.get('adoptPet')!;
      expect(adoptPet.response).toEqual({ kind: 'primitive', type: 'unknown' });
      expect(adoptPet.responseHeaders?.map((h) => h.name)).toEqual(['X-Request-Id']);
      expect(adoptPet.errors).toEqual([
        {
          statusCode: 409,
          description: 'Already adopted, declared inline',
          type: { kind: 'model', name: 'ConflictResponse' },
        },
      ]);

      const modelNames = spec.models.map((m: Model) => m.name).sort();
      expect(new Set(modelNames).size).toBe(modelNames.length);
      expect(modelNames).toMatchInlineSnapshot(`
        [
          "ListMetadata",
          "OwnerCardResponse",
          "OwnerCardResponseAddress",
          "Pet",
          "PhotoPageItem",
          "Problem",
        ]
      `);
      expect(spec.enums.map((e) => e.name)).toMatchInlineSnapshot(`
        [
          "OwnerCardResponseTier",
        ]
      `);
    });
  });
});
