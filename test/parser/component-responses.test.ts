import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { collectModelRefs, collectOperationTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, ResponseContent, ResponseHeader, TypeRef } from '../../src/ir/types.js';

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
function get(
  operationId: string,
  responses: Record<string, unknown>,
  path = `/${operationId}`,
  operation: Record<string, unknown> = {},
) {
  return { [path]: { get: { operationId, ...operation, responses } } };
}

/** A cursor parameter, so a list envelope is unwrapped for the iterator it drives (#309). */
const afterParam = { parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }] };

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
        get(
          'createOwner',
          {
            '200': { $ref: '#/components/responses/OwnerCard' },
            '201': { $ref: '#/components/responses/NewOwner' },
          },
          undefined,
          afterParam,
        ),
        components,
      );
      const [op] = services.flatMap((s) => s.operations);
      expect(op.response).toEqual({ kind: 'model', name: 'OwnerCardResponse' });
      expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
        [200, { kind: 'model', name: 'OwnerCardResponse' }],
        [201, { kind: 'array', items: { kind: 'model', name: 'NewOwnerItem' } }],
      ]);
      // The 201 page was read last; the primary 200 is a plain object, so the
      // `after` parameter pages the plain body and none of the 201's page
      // fields — its data path, its companions — are read.
      expect(op.pagination).toEqual({
        strategy: 'cursor',
        param: 'after',
        itemType: { kind: 'model', name: 'OwnerCardResponse' },
      });
      expect(inlineModels.map((m) => m.name)).toEqual([
        'OwnerCardResponse',
        'OwnerCardResponseAddress',
        'NewOwnerItem',
      ]);
      expectNoDanglingRefs(op, inlineModels);
    });

    it('takes paging from the primary whatever order the status codes are declared in', () => {
      const { services, inlineModels } = extract(
        get(
          'createOwner',
          {
            '201': { $ref: '#/components/responses/OwnerCard' },
            '200': { $ref: '#/components/responses/NewOwner' },
          },
          undefined,
          afterParam,
        ),
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
      // The component response's inline error body is materialized under the component's name (#236).
      expect(spec.models.find((m: Model) => m.name === 'ConflictResponse')?.fields.map((f) => f.name)).toEqual([
        'adopted_by',
      ]);

      // A shared inline body returned as `default` by two operations and in a
      // `5XX` range by a third: one model, named after the component (#301).
      const failure = { kind: 'model', name: 'FailureResponse' };
      expect(getPet.defaultResponse?.type).toEqual(failure);
      expect(byName.get('getOwner')!.rangeResponses?.map((r) => [r.range, r.type])).toEqual([['5XX', failure]]);
      expect(adoptPet.defaultResponse?.type).toEqual(failure);
      expect(spec.models.find((m: Model) => m.name === 'FailureResponse')?.fields.map((f) => f.name)).toEqual(['code']);

      const modelNames = spec.models.map((m: Model) => m.name).sort();
      expect(new Set(modelNames).size).toBe(modelNames.length);
      expect(modelNames).toMatchInlineSnapshot(`
        [
          "ConflictResponse",
          "FailureResponse",
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

describe('a shared inline body returned as default or in a range (issue #301)', () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const model = (name: string): TypeRef => ({ kind: 'model', name });
  const unknown: TypeRef = { kind: 'primitive', type: 'unknown' };
  const ref = (component: string) => ({ $ref: `#/components/responses/${component}` });
  const inline = (properties: Record<string, unknown>, description: string) => ({
    description,
    content: { 'application/json': { schema: { type: 'object', properties } } },
  });
  /** The media-type lists a `application/json`-only body carries, its entry sharing the body's type. */
  const jsonBody = (type: TypeRef) => ({
    contentTypes: ['application/json'],
    contents: [{ contentType: 'application/json', type }],
  });
  const found = inline({ id: { type: 'string' } }, 'Found');
  const problem = inline({ title: { type: 'string' } }, 'A problem');

  /** Parse a document through the whole pipeline, as the issue's repro does. */
  async function parseDocument(paths: Record<string, unknown>, components: Record<string, unknown>): Promise<ApiSpec> {
    dir = mkdtempSync(join(tmpdir(), 'oagen-301-'));
    const specPath = join(dir, 'spec.json');
    const document = { openapi: '3.1.0', info: { title: 'shared', version: '1' }, paths, components };
    writeFileSync(specPath, JSON.stringify(document));
    return parseSpec(specPath);
  }

  const opsByName = (spec: ApiSpec): Map<string, Operation> =>
    new Map(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
  const fieldsOf = (spec: ApiSpec, name: string): string[] | undefined =>
    spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);

  /** Every `model` ref anywhere under `value` — fallback responses, ranges and errors included. */
  function modelRefsAnywhere(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => modelRefsAnywhere(v, out));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record['kind'] === 'model' && typeof record['name'] === 'string') out.add(record['name']);
      for (const v of Object.values(record)) modelRefsAnywhere(v, out);
    }
    return out;
  }

  /** Every model reference resolves, and no model but the named component schemas is orphaned. */
  function expectSound(spec: ApiSpec, componentSchemas: string[] = []): void {
    validateModelRefs(spec);
    const referenced = modelRefsAnywhere(spec.services.flatMap((s) => s.operations));
    for (const m of spec.models) modelRefsAnywhere(m.fields, referenced);
    const known = new Set(spec.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !componentSchemas.includes(name) && !referenced.has(name))).toEqual([]);
  }

  it("the issue's repro: one ProblemResponse, which the default and 4XX of both operations point at", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const responses = { '200': ref('Found'), '4XX': ref('Problem'), default: ref('Problem') };
    const spec = await parseDocument(
      {
        '/notes': { get: { operationId: 'getNote', responses } },
        '/pets': { get: { operationId: 'getPet', responses } },
      },
      { responses: { Found: found, Problem: problem } },
    );

    expect(spec.models.map(({ name }) => name)).toEqual(['FoundResponse', 'ProblemResponse']);
    const ops = opsByName(spec);
    for (const name of ['getNote', 'getPet']) {
      const op = ops.get(name)!;
      expect(op.response).toEqual(model('FoundResponse'));
      expect(op.defaultResponse).toEqual({
        type: model('ProblemResponse'),
        ...jsonBody(model('ProblemResponse')),
        description: 'A problem',
      });
      expect(op.rangeResponses).toEqual([
        {
          range: '4XX',
          type: model('ProblemResponse'),
          ...jsonBody(model('ProblemResponse')),
          description: 'A problem',
        },
      ]);
    }
    expect(fieldsOf(spec, 'ProblemResponse')).toEqual(['title']);
    expectSound(spec);
    expect(warn).not.toHaveBeenCalled();
  });

  // The component at a 404 (an error entry) of one operation, as `default`
  // of a second and in a `5XX` range of a third; `Found` at a 200 and in a
  // `2XX` range. One model each, whichever kind of site is read first.
  const errorFirst = {
    '/a': { get: { operationId: 'opA', responses: { '200': ref('Found'), '404': ref('Problem') } } },
    '/b': { get: { operationId: 'opB', responses: { '2XX': ref('Found'), default: ref('Problem') } } },
    '/c': { get: { operationId: 'opC', responses: { '5XX': ref('Problem') } } },
  };
  const fallbackFirst = { '/c': errorFirst['/c'], '/b': errorFirst['/b'], '/a': errorFirst['/a'] };
  it.each([
    ['the error entry first', errorFirst],
    ['the fallback entries first', fallbackFirst],
  ])('shares one model across a status code, default and a range of three operations (%s)', async (_order, paths) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(paths, { responses: { Found: found, Problem: problem } });

    expect(spec.models.map(({ name }) => name).sort()).toEqual(['FoundResponse', 'ProblemResponse']);
    const ops = opsByName(spec);
    expect(ops.get('opA')!.response).toEqual(model('FoundResponse'));
    expect(ops.get('opA')!.errors.map((e) => [e.statusCode, e.type])).toEqual([[404, model('ProblemResponse')]]);
    // A `2XX` range is never promoted into `response`.
    expect(ops.get('opB')!.response).toEqual(unknown);
    expect(ops.get('opB')!.rangeResponses?.map((r) => [r.range, r.type])).toEqual([['2XX', model('FoundResponse')]]);
    expect(ops.get('opB')!.defaultResponse?.type).toEqual(model('ProblemResponse'));
    expect(ops.get('opC')!.rangeResponses?.map((r) => [r.range, r.type])).toEqual([['5XX', model('ProblemResponse')]]);
    expectSound(spec);
    expect(warn).not.toHaveBeenCalled();
  });

  it('mints the shared model once at extraction, so no merge pass has to fold copies', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { services, inlineModels } = extract(
      {
        '/a': { get: { operationId: 'opA', responses: { '404': ref('Problem') } } },
        '/b': { get: { operationId: 'opB', responses: { default: ref('Problem') } } },
        '/c': { get: { operationId: 'opC', responses: { '4XX': ref('Problem') } } },
      },
      { responses: { Problem: problem } },
    );
    expect(inlineModels.map((m) => m.name)).toEqual(['ProblemResponse']);
    const ops = services.flatMap((s) => s.operations);
    expect(ops.map((op) => op.errors[0]?.type ?? op.defaultResponse?.type ?? op.rangeResponses?.[0].type)).toEqual([
      model('ProblemResponse'),
      model('ProblemResponse'),
      model('ProblemResponse'),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('names the body after the component for an operation without an operationId too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(
      {
        '/notes': { get: { responses: { '200': ref('Found'), default: ref('Problem') } } },
        '/pets': { get: { responses: { '200': ref('Found'), '4XX': ref('Problem') } } },
      },
      { responses: { Found: found, Problem: problem } },
    );

    expect(spec.models.map(({ name }) => name).sort()).toEqual(['FoundResponse', 'ProblemResponse']);
    const [notes, pets] = spec.services.flatMap((s) => s.operations);
    expect(notes.defaultResponse?.type).toEqual(model('ProblemResponse'));
    expect(pets.rangeResponses?.map((r) => [r.range, r.type])).toEqual([['4XX', model('ProblemResponse')]]);
    expectSound(spec);
    expect(warn).not.toHaveBeenCalled();
  });

  it('names the body after the ref the operation wrote, not the end of a chain, at default as at a status code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(
      {
        '/notes': { get: { operationId: 'getNote', responses: { '200': ref('Found'), default: ref('Alias') } } },
        '/pets': { get: { operationId: 'getPet', responses: { '200': ref('Found'), '404': ref('Alias') } } },
      },
      { responses: { Found: found, Alias: ref('Problem'), Problem: problem } },
    );

    expect(spec.models.map(({ name }) => name).sort()).toEqual(['AliasResponse', 'FoundResponse']);
    const ops = opsByName(spec);
    expect(ops.get('getNote')!.defaultResponse?.type).toEqual(model('AliasResponse'));
    expect(ops.get('getPet')!.errors[0].type).toEqual(model('AliasResponse'));
    expectSound(spec);
    expect(warn).not.toHaveBeenCalled();
  });

  it('steps every site to the numbered name the pre-pass chose when a component schema owns <Component>Response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(
      {
        '/notes': {
          get: {
            operationId: 'getNote',
            responses: { '200': ref('Found'), '404': ref('Problem'), default: ref('Problem') },
          },
        },
      },
      {
        schemas: { ProblemResponse: { type: 'object', properties: { id: { type: 'string' } } } },
        responses: { Found: found, Problem: problem },
      },
    );

    expect(spec.models.map(({ name }) => name).sort()).toEqual([
      'FoundResponse',
      'ProblemResponse',
      'ProblemResponse2',
    ]);
    expect(fieldsOf(spec, 'ProblemResponse')).toEqual(['id']);
    expect(fieldsOf(spec, 'ProblemResponse2')).toEqual(['title']);
    const op = opsByName(spec).get('getNote')!;
    expect(op.errors[0].type).toEqual(model('ProblemResponse2'));
    expect(op.defaultResponse?.type).toEqual(model('ProblemResponse2'));
    expectSound(spec, ['ProblemResponse']);
    expect(warn).not.toHaveBeenCalled();
  });

  it("steps a 404 and a default of the component the same way when an operation's own model holds its name", async () => {
    // `problem`'s inline 200 body is `ProblemResponse`, a name the pre-pass
    // does not reserve against, so both component sites step past it — by
    // number alike, whichever kind of site each is, so they still share.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(
      {
        '/problems': {
          get: { operationId: 'problem', responses: { '200': inline({ detail: { type: 'string' } }, 'Own') } },
        },
        '/notes': { get: { operationId: 'getNote', responses: { '200': ref('Found'), '404': ref('Problem') } } },
        '/pets': { get: { operationId: 'getPet', responses: { '200': ref('Found'), default: ref('Problem') } } },
      },
      { responses: { Found: found, Problem: problem } },
    );

    expect(spec.models.map(({ name }) => name).sort()).toEqual([
      'FoundResponse',
      'ProblemResponse',
      'ProblemResponse2',
    ]);
    expect(fieldsOf(spec, 'ProblemResponse')).toEqual(['detail']);
    expect(fieldsOf(spec, 'ProblemResponse2')).toEqual(['title']);
    const ops = opsByName(spec);
    expect(ops.get('problem')!.response).toEqual(model('ProblemResponse'));
    expect(ops.get('getNote')!.errors[0].type).toEqual(model('ProblemResponse2'));
    expect(ops.get('getPet')!.defaultResponse?.type).toEqual(model('ProblemResponse2'));
    expectSound(spec);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the component's headers and description, and names a secondary media type's body after the component", async () => {
    // A component's secondary media types are named after the component
    // (#302), at `default` and in a range as at an explicit status code, so
    // the two operations share one `ProblemApplicationYamlResponse`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yamlProblem = {
      description: 'A problem',
      headers: { 'Retry-After': { schema: { type: 'integer' } } },
      content: {
        'application/json': { schema: { type: 'object', properties: { title: { type: 'string' } } } },
        'application/yaml': { schema: { type: 'object', properties: { text: { type: 'string' } } } },
      },
    };
    const spec = await parseDocument(
      {
        '/notes': { get: { operationId: 'getNote', responses: { '200': ref('Found'), default: ref('Problem') } } },
        '/pets': { get: { operationId: 'getPet', responses: { '200': ref('Found'), '5XX': ref('Problem') } } },
      },
      { responses: { Found: found, Problem: yamlProblem } },
    );

    const ops = opsByName(spec);
    const shared = {
      type: model('ProblemResponse'),
      contentTypes: ['application/json', 'application/yaml'],
      contents: [
        { contentType: 'application/json', type: model('ProblemResponse') },
        { contentType: 'application/yaml', type: model('ProblemApplicationYamlResponse') },
      ],
      headers: [{ name: 'Retry-After', type: { kind: 'primitive', type: 'integer' }, required: false }],
      description: 'A problem',
    };
    expect(ops.get('getNote')!.defaultResponse).toEqual(shared);
    expect(ops.get('getPet')!.rangeResponses).toEqual([{ range: '5XX', ...shared }]);
    expect(spec.models.map(({ name }) => name).sort()).toEqual([
      'FoundResponse',
      'ProblemApplicationYamlResponse',
      'ProblemResponse',
    ]);
    expectSound(spec);
    expect(warn).not.toHaveBeenCalled();
  });

  it("steps a component's 404 bodies by number when an operation's own model holds its name, with no default or range anywhere", async () => {
    // The numbered stepping of a component body applies at an error site on
    // its own (review on #353): `problem`'s inline 200 body is
    // `ProblemResponse`, and two operations return the component at a 404
    // only. Both step to `ProblemResponse2` — not to the error kind's
    // `ProblemResponseBody` — nested object included, and share it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const detailed = inline(
      { title: { type: 'string' }, detail: { type: 'object', properties: { code: { type: 'string' } } } },
      'A problem',
    );
    const spec = await parseDocument(
      {
        '/problems': {
          get: { operationId: 'problem', responses: { '200': inline({ other: { type: 'string' } }, 'Own') } },
        },
        '/notes': { get: { operationId: 'getNote', responses: { '200': ref('Found'), '404': ref('Problem') } } },
        '/pets': { get: { operationId: 'getPet', responses: { '200': ref('Found'), '404': ref('Problem') } } },
      },
      { responses: { Found: found, Problem: detailed } },
    );

    expect(spec.models.map(({ name }) => name).sort()).toEqual([
      'FoundResponse',
      'ProblemResponse',
      'ProblemResponse2',
      'ProblemResponse2Detail',
    ]);
    expect(fieldsOf(spec, 'ProblemResponse')).toEqual(['other']);
    expect(fieldsOf(spec, 'ProblemResponse2')).toEqual(['title', 'detail']);
    expect(
      spec.models.find((m) => m.name === 'ProblemResponse2')?.fields.find((f) => f.name === 'detail')?.type,
    ).toEqual(model('ProblemResponse2Detail'));
    const ops = opsByName(spec);
    expect(ops.get('problem')!.response).toEqual(model('ProblemResponse'));
    expect(ops.get('getNote')!.errors.map((e) => [e.statusCode, e.type])).toEqual([[404, model('ProblemResponse2')]]);
    expect(ops.get('getPet')!.errors.map((e) => [e.statusCode, e.type])).toEqual([[404, model('ProblemResponse2')]]);
    expectSound(spec);
    expect(warn).not.toHaveBeenCalled();
  });

  // `listNotes`'s own inline `default` is `ListNotesDefaultResponse`; so is
  // the body of a component `ListNotesDefault`. A component's site is named
  // before every operation's own (#423), so the component keeps the name in
  // either document order and the operation's own steps by number; the two
  // shapes are never folded onto each other.
  const ownDefault = {
    get: {
      operationId: 'listNotes',
      responses: { '200': ref('Found'), default: inline({ a: { type: 'string' } }, 'Own') },
    },
  };
  const viaComponent = {
    get: { operationId: 'getPet', responses: { '200': ref('Found'), default: ref('ListNotesDefault') } },
  };
  it.each([
    [
      'the operation returning the component first',
      { '/pets': viaComponent, '/notes': ownDefault },
      'getPet',
      'listNotes',
    ],
    [
      'the operation with its own default first',
      { '/notes': ownDefault, '/pets': viaComponent },
      'getPet',
      'listNotes',
    ],
  ])(
    "keeps an operation's own default apart from a component body that derives the same name (%s)",
    async (_order, paths, named, numbered) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parseDocument(paths, { responses: { Found: found, ListNotesDefault: problem } });

      const ops = opsByName(spec);
      expect(ops.get(named)!.defaultResponse?.type).toEqual(model('ListNotesDefaultResponse'));
      expect(ops.get(numbered)!.defaultResponse?.type).toEqual(model('ListNotesDefaultResponse2'));
      const fieldsByOperation = { listNotes: ['a'], getPet: ['title'] };
      expect(fieldsOf(spec, 'ListNotesDefaultResponse')).toEqual(fieldsByOperation[named as 'listNotes' | 'getPet']);
      expect(fieldsOf(spec, 'ListNotesDefaultResponse2')).toEqual(
        fieldsByOperation[numbered as 'listNotes' | 'getPet'],
      );
      expectSound(spec);
      expect(warn).not.toHaveBeenCalled();
    },
  );
});

describe("a component response's other media types and headers (issue #302)", () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** The issue's `Card`: an inline JSON body, an inline YAML body and a header whose schema is an inline object. */
  const card = {
    description: 'A card',
    headers: { 'X-Meta': { schema: { type: 'object', properties: { trace: { type: 'string' } } } } },
    content: {
      'application/json': { schema: { type: 'object', properties: { text: { type: 'string' } } } },
      'application/yaml': { schema: { type: 'object', properties: { y: { type: 'string' } } } },
    },
  };
  const cardRef = { $ref: '#/components/responses/Card' };
  const ok = { description: 'ok' };

  /** `GET /notes` (`getNote`) and `GET /pets` (`getPet`), two services, each mounting `Card` at its own key. */
  const twoOperations = (noteKey: string, petKey: string, extra: Record<string, unknown> = {}) => ({
    '/notes': { get: { operationId: 'getNote', responses: { ...extra, [noteKey]: cardRef } } },
    '/pets': { get: { operationId: 'getPet', responses: { ...extra, [petKey]: cardRef } } },
  });

  async function parse(
    paths: Record<string, unknown>,
    components: {
      schemas?: Record<string, unknown>;
      responses?: Record<string, unknown>;
      headers?: Record<string, unknown>;
    } = {},
  ): Promise<ApiSpec> {
    dir ??= mkdtempSync(join(tmpdir(), 'oagen-302-'));
    const specPath = join(dir, 'spec.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: '302', version: '1' },
        paths,
        components: {
          schemas: components.schemas ?? {},
          responses: components.responses ?? { Card: card },
          headers: components.headers ?? {},
        },
      }),
    );
    return parseSpec(specPath);
  }

  const typeName = (type: TypeRef | undefined): string | undefined =>
    type?.kind === 'model' || type?.kind === 'enum'
      ? type.name
      : type?.kind === 'primitive'
        ? type.type
        : JSON.stringify(type);
  const contentsOf = (entry: { contents?: ResponseContent[] } | undefined): string[] =>
    (entry?.contents ?? []).map((c) => `${c.contentType}: ${typeName(c.type)}`);
  const headersOf = (entry: { headers?: ResponseHeader[] } | undefined): string[] =>
    (entry?.headers ?? []).map((h) => `${h.name}: ${typeName(h.type)}`);
  const fieldsOf = (spec: ApiSpec, name: string) =>
    spec.models.find((m) => m.name === name)?.fields.map((f) => [f.name, typeName(f.type)]);
  const modelNames = (spec: ApiSpec): string[] => spec.models.map((m) => m.name).sort();
  /** Every model minted for an `X-Meta` header and for an `application/yaml` body, whichever stem named it. */
  const mintedFor = (spec: ApiSpec) => ({
    meta: modelNames(spec).filter((name) => /XMeta\d*$/.test(name)),
    yaml: modelNames(spec).filter((name) => /ApplicationYaml(Response|Error)\d*$/.test(name)),
  });
  const byName = (spec: ApiSpec): Map<string, Operation> =>
    new Map(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

  /** Every model reference an operation or a model field makes that no model answers, as `owner → Model`. */
  function unresolved(spec: ApiSpec): string[] {
    const names = new Set(spec.models.map((m) => m.name));
    const found: string[] = [];
    for (const op of spec.services.flatMap((s) => s.operations)) {
      for (const ref of collectOperationTypeRefs(op)) {
        for (const name of collectModelRefs(ref)) if (!names.has(name)) found.push(`${op.name} → ${name}`);
      }
    }
    for (const model of spec.models) {
      for (const field of model.fields) {
        for (const name of collectModelRefs(field.type))
          if (!names.has(name)) found.push(`${model.name}.${field.name} → ${name}`);
      }
    }
    return found;
  }

  /** Every model no operation and no model field reaches, the component schemas aside. */
  function orphaned(spec: ApiSpec, componentNames: string[]): string[] {
    const referenced = new Set<string>();
    for (const op of spec.services.flatMap((s) => s.operations)) {
      for (const ref of collectOperationTypeRefs(op)) for (const name of collectModelRefs(ref)) referenced.add(name);
    }
    for (const model of spec.models) {
      for (const field of model.fields) for (const name of collectModelRefs(field.type)) referenced.add(name);
    }
    return spec.models.map((m) => m.name).filter((name) => !referenced.has(name) && !componentNames.includes(name));
  }

  /** Nothing dangles and nothing is orphaned. */
  function expectSound(spec: ApiSpec, componentNames: string[] = []): void {
    expect(unresolved(spec)).toEqual([]);
    expect(orphaned(spec, componentNames)).toEqual([]);
  }

  it("the issue's repro: one YAML model and one header model, named after the component and shared by both operations", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parse(twoOperations('200', '200'));
    expect(warn).not.toHaveBeenCalled();

    // Before: `GetNoteApplicationYamlResponse` + `GetPetApplicationYamlResponse`, `NotesXMeta` + `PetsXMeta`.
    expect(modelNames(spec)).toEqual(['CardApplicationYamlResponse', 'CardResponse', 'CardXMeta']);
    for (const op of ['getNote', 'getPet']) {
      const operation = byName(spec).get(op)!;
      expect(contentsOf({ contents: operation.responseContents }), op).toEqual([
        'application/json: CardResponse',
        'application/yaml: CardApplicationYamlResponse',
      ]);
      expect(headersOf({ headers: operation.responseHeaders }), op).toEqual(['X-Meta: CardXMeta']);
    }
    expect(fieldsOf(spec, 'CardApplicationYamlResponse')).toEqual([['y', 'string']]);
    expect(fieldsOf(spec, 'CardXMeta')).toEqual([['trace', 'string']]);
    expectSound(spec);
  });

  it('as a 404 on both operations: the same two models, suffixed `Response` as the body is, not `…Error`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parse(twoOperations('404', '404', { '200': ok }));
    expect(warn).not.toHaveBeenCalled();

    // Before: `GetNoteApplicationYamlError` + `GetPetApplicationYamlError`, `NotesXMeta` + `PetsXMeta`.
    expect(modelNames(spec)).toEqual(['CardApplicationYamlResponse', 'CardResponse', 'CardXMeta']);
    for (const op of ['getNote', 'getPet']) {
      const [error] = byName(spec).get(op)!.errors;
      expect(error.statusCode, op).toBe(404);
      expect(typeName(error.type), op).toBe('CardResponse');
      expect(contentsOf(error), op).toEqual([
        'application/json: CardResponse',
        'application/yaml: CardApplicationYamlResponse',
      ]);
      expect(headersOf(error), op).toEqual(['X-Meta: CardXMeta']);
    }
    expectSound(spec);
  });

  it('mounted at 200 by one operation and at 404 by the other: still one model of each', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parse(twoOperations('200', '404', { '204': ok }));
    expect(warn).not.toHaveBeenCalled();

    expect(modelNames(spec)).toEqual(['CardApplicationYamlResponse', 'CardResponse', 'CardXMeta']);
    const getNote = byName(spec).get('getNote')!;
    const getPet = byName(spec).get('getPet')!;
    const success = getNote.successResponses!.find((r) => r.statusCode === 200)!;
    expect(contentsOf(success)).toEqual(contentsOf(getPet.errors[0]));
    expect(headersOf(success)).toEqual(headersOf(getPet.errors[0]));
    expect(headersOf(success)).toEqual(['X-Meta: CardXMeta']);
    expectSound(spec);
  });

  it('on a `default` and a `4XX` written as a $ref: named after the component, as at an explicit status code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parse(twoOperations('default', '4XX', { '200': ok }));
    expect(warn).not.toHaveBeenCalled();

    // Before: `GetNoteDefaultApplicationYamlResponse` + `GetPetClientErrorApplicationYamlResponse`,
    // `NotesXMeta` + `PetsXMeta`. (The fallback body itself is #301's.)
    expect(mintedFor(spec)).toEqual({ meta: ['CardXMeta'], yaml: ['CardApplicationYamlResponse'] });
    const fallback = byName(spec).get('getNote')!.defaultResponse;
    const range = byName(spec).get('getPet')!.rangeResponses?.[0];
    expect(range?.range).toBe('4XX');
    for (const entry of [fallback, range]) {
      expect(contentsOf(entry)).toContain('application/yaml: CardApplicationYamlResponse');
      expect(headersOf(entry)).toEqual(['X-Meta: CardXMeta']);
    }
    expectSound(spec);
  });

  it('on a 302 written as a $ref: every media type typed on its own, each named after the component', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parse(twoOperations('302', '302', { '200': ok }));
    expect(warn).not.toHaveBeenCalled();

    expect(modelNames(spec)).toEqual(['CardApplicationJsonResponse', 'CardApplicationYamlResponse', 'CardXMeta']);
    for (const op of ['getNote', 'getPet']) {
      const redirect = byName(spec)
        .get(op)!
        .successResponses!.find((r) => r.statusCode === 302)!;
      expect(contentsOf(redirect), op).toEqual([
        'application/json: CardApplicationJsonResponse',
        'application/yaml: CardApplicationYamlResponse',
      ]);
      expect(headersOf(redirect), op).toEqual(['X-Meta: CardXMeta']);
    }
    expectSound(spec);
  });

  it('from an operation without an operationId: the component names them, not the path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parse({
      '/notes': { get: { responses: { '200': cardRef } } },
      '/pets': { get: { operationId: 'getPet', responses: { '200': cardRef } } },
    });
    expect(warn).not.toHaveBeenCalled();

    // Before: `NotesGetApplicationYamlResponse` beside `GetPetApplicationYamlResponse`.
    expect(modelNames(spec)).toEqual(['CardApplicationYamlResponse', 'CardResponse', 'CardXMeta']);
    for (const op of spec.services.flatMap((s) => s.operations)) {
      expect(contentsOf({ contents: op.responseContents }), op.name).toContain(
        'application/yaml: CardApplicationYamlResponse',
      );
      expect(headersOf({ headers: op.responseHeaders }), op.name).toEqual(['X-Meta: CardXMeta']);
    }
    expectSound(spec);
  });

  it('a component already named `…Response` keeps one stem: `CardXMeta`, not `CardResponseXMeta`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ref = { $ref: '#/components/responses/CardResponse' };
    const spec = await parse(
      {
        '/notes': { get: { operationId: 'getNote', responses: { '200': ref } } },
        '/pets': { get: { operationId: 'getPet', responses: { '200': ref } } },
      },
      { responses: { CardResponse: card } },
    );
    expect(warn).not.toHaveBeenCalled();

    expect(modelNames(spec)).toEqual(['CardApplicationYamlResponse', 'CardResponse', 'CardXMeta']);
    expect(headersOf({ headers: byName(spec).get('getPet')!.responseHeaders })).toEqual(['X-Meta: CardXMeta']);
    expectSound(spec);
  });

  it('qualifies the objects nested under the header and the YAML body by the component', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nested = {
      description: 'A card',
      headers: {
        'X-Meta': {
          schema: {
            type: 'object',
            properties: { trace: { type: 'object', properties: { id: { type: 'string' } } } },
          },
        },
      },
      content: {
        'application/json': { schema: { type: 'object', properties: { text: { type: 'string' } } } },
        'application/yaml': {
          schema: { type: 'object', properties: { y: { type: 'object', properties: { z: { type: 'string' } } } } },
        },
      },
    };
    const spec = await parse(twoOperations('200', '200'), { responses: { Card: nested } });
    expect(warn).not.toHaveBeenCalled();

    expect(modelNames(spec)).toEqual([
      'CardApplicationYamlResponse',
      'CardApplicationYamlResponseY',
      'CardResponse',
      'CardXMeta',
      'CardXMetaTrace',
    ]);
    expect(fieldsOf(spec, 'CardXMeta')).toEqual([['trace', 'CardXMetaTrace']]);
    expect(fieldsOf(spec, 'CardApplicationYamlResponse')).toEqual([['y', 'CardApplicationYamlResponseY']]);
    expectSound(spec);
  });

  it('steps a name a component schema owns with another shape by number, the same from a 200 and from a 404', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = { type: 'object', properties: { other: { type: 'integer' } } };
    const components = { schemas: { CardXMeta: other, CardApplicationYamlResponse: other }, responses: { Card: card } };
    const spec = await parse(twoOperations('200', '404', { '204': ok }), components);
    expect(warn).not.toHaveBeenCalled();

    // A component site steps by number (`componentSite`), as the component's
    // body steps to `CardResponse2` — never to the operation's candidate
    // (`CardGetNoteXMeta`) or the status code's (`CardApplicationYamlResponse200`),
    // which belong to an inline response's sites — so the 200 of one
    // operation and the 404 of the other settle on one name (MichaelDeBoey).
    const getNote = byName(spec).get('getNote')!;
    const getPet = byName(spec).get('getPet')!;
    expect(headersOf({ headers: getNote.responseHeaders })).toEqual(['X-Meta: CardXMeta2']);
    expect(headersOf(getPet.errors[0])).toEqual(['X-Meta: CardXMeta2']);
    expect(contentsOf({ contents: getNote.responseContents })).toEqual([
      'application/json: CardResponse',
      'application/yaml: CardApplicationYamlResponse2',
    ]);
    expect(contentsOf(getPet.errors[0])).toEqual(contentsOf({ contents: getNote.responseContents }));
    expect(mintedFor(spec)).toEqual({
      meta: ['CardXMeta', 'CardXMeta2'],
      yaml: ['CardApplicationYamlResponse', 'CardApplicationYamlResponse2'],
    });
    // The components keep their own shape.
    expect(fieldsOf(spec, 'CardXMeta')).toEqual([['other', 'integer']]);
    expect(fieldsOf(spec, 'CardApplicationYamlResponse')).toEqual([['other', 'integer']]);
    expectSound(spec, ['CardXMeta', 'CardApplicationYamlResponse']);

    // Removing one operation leaves the other's stepped names unchanged, so
    // `oagen diff` reports the `Notes` service (and its one operation) gone
    // and nothing else: no model removed or added, no header retyped.
    const petOnly = await parse(
      { '/pets': { get: { operationId: 'getPet', responses: { '204': ok, '404': cardRef } } } },
      components,
    );
    const petError = byName(petOnly).get('getPet')!.errors[0];
    expect(headersOf(petError)).toEqual(['X-Meta: CardXMeta2']);
    expect(contentsOf(petError)).toEqual(contentsOf(getPet.errors[0]));
    expect(diffSpecs(spec, petOnly).changes.map((change) => change.kind)).toEqual(['service-removed']);
  });

  it('steps by number beside a component response whose body owns the YAML name, so a 200 and a 404 agree', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `CardApplicationYaml`'s own body is `CardApplicationYamlResponse`, the
    // name `Card`'s YAML body derives; before, `Card`'s was
    // `CardApplicationYamlResponse200` at the 200 and `…404` at the 404.
    const spec = await parse(
      {
        ...twoOperations('200', '404', { '204': ok }),
        '/cards': {
          get: { operationId: 'getCard', responses: { '200': { $ref: '#/components/responses/CardApplicationYaml' } } },
        },
      },
      {
        responses: {
          Card: card,
          CardApplicationYaml: {
            description: 'Owns the name',
            content: { 'application/json': { schema: { type: 'object', properties: { owner: { type: 'string' } } } } },
          },
        },
      },
    );
    expect(warn).not.toHaveBeenCalled();

    expect(typeName(byName(spec).get('getCard')!.response)).toBe('CardApplicationYamlResponse');
    expect(fieldsOf(spec, 'CardApplicationYamlResponse')).toEqual([['owner', 'string']]);
    const getNote = byName(spec).get('getNote')!;
    const getPet = byName(spec).get('getPet')!;
    expect(contentsOf({ contents: getNote.responseContents })).toContain(
      'application/yaml: CardApplicationYamlResponse2',
    );
    expect(contentsOf(getPet.errors[0])).toContain('application/yaml: CardApplicationYamlResponse2');
    expect(mintedFor(spec).yaml).toEqual(['CardApplicationYamlResponse', 'CardApplicationYamlResponse2']);
    expect(fieldsOf(spec, 'CardApplicationYamlResponse2')).toEqual([['y', 'string']]);
    expectSound(spec);
  });

  it('names an inline enum header after the component: one `CardXMode`, not one enum per service', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withMode = {
      ...card,
      headers: { ...card.headers, 'X-Mode': { schema: { type: 'string', enum: ['compact', 'full'] } } },
    };
    const spec = await parse(twoOperations('200', '200'), { responses: { Card: withMode } });
    expect(warn).not.toHaveBeenCalled();

    // Before: `NotesXMode` and `PetsXMode`.
    expect(spec.enums.map((e) => e.name)).toEqual(['CardXMode']);
    for (const op of ['getNote', 'getPet']) {
      expect(headersOf({ headers: byName(spec).get(op)!.responseHeaders }), op).toEqual([
        'X-Meta: CardXMeta',
        'X-Mode: CardXMode',
      ]);
    }
    expectSound(spec);
  });

  describe('an inline enum a component site carries, beside an enum that owns its name (Greptile)', () => {
    const modeHeader = { 'X-Mode': { schema: { type: 'string', enum: ['compact', 'full'] } } };
    /** `CardXMode` is a component enum with other members, so the header's enum must step. */
    const components = {
      schemas: { CardXMode: { type: 'string', enum: ['x', 'y'] } },
      responses: { Card: { ...card, headers: modeHeader } },
    };
    const enumNames = (spec: ApiSpec) => spec.enums.map((e) => e.name).sort();
    const members = (spec: ApiSpec, name: string) =>
      spec.enums.find((e) => e.name === name)?.values.map((v) => v.value);

    it('steps a header enum by number through `default` and `4XX`: one `CardXMode2`, not one per fallback label', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parse(twoOperations('default', '4XX', { '200': ok }), components);
      expect(warn).not.toHaveBeenCalled();

      // Before: `CardXModeDefault` and `CardXModeClientError`.
      expect(enumNames(spec)).toEqual(['CardXMode', 'CardXMode2']);
      expect(members(spec, 'CardXMode')).toEqual(['x', 'y']);
      expect(members(spec, 'CardXMode2')).toEqual(['compact', 'full']);
      expect(headersOf(byName(spec).get('getNote')!.defaultResponse)).toEqual(['X-Mode: CardXMode2']);
      expect(headersOf(byName(spec).get('getPet')!.rangeResponses?.[0])).toEqual(['X-Mode: CardXMode2']);
      expectSound(spec);

      // Removing one operation leaves the enum name unchanged: `oagen diff`
      // reports the service gone and nothing about the enum.
      const petOnly = await parse(
        { '/pets': { get: { operationId: 'getPet', responses: { '200': ok, '4XX': cardRef } } } },
        components,
      );
      expect(headersOf(byName(petOnly).get('getPet')!.rangeResponses?.[0])).toEqual(['X-Mode: CardXMode2']);
      expect(diffSpecs(spec, petOnly).changes.map((change) => change.kind)).toEqual(['service-removed']);
    });

    it('steps a header enum by number through a 404 on two operations: `CardXMode2`, not `CardXMode404`', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spec = await parse(twoOperations('404', '404', { '200': ok }), components);
      expect(warn).not.toHaveBeenCalled();

      expect(enumNames(spec)).toEqual(['CardXMode', 'CardXMode2']);
      for (const op of ['getNote', 'getPet']) {
        expect(headersOf(byName(spec).get(op)!.errors[0]), op).toEqual(['X-Mode: CardXMode2']);
      }
      expectSound(spec);
    });

    it('steps a secondary-body enum by number through `4XX` and `default`: one `CardApplicationYamlResponse2`', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const enumCard = {
        description: 'A card',
        content: {
          'application/json': { schema: { type: 'object', properties: { text: { type: 'string' } } } },
          'application/yaml': { schema: { type: 'string', enum: ['compact', 'full'] } },
        },
      };
      const spec = await parse(twoOperations('4XX', 'default', { '200': ok }), {
        schemas: { CardApplicationYamlResponse: { type: 'string', enum: ['x', 'y'] } },
        responses: { Card: enumCard },
      });
      expect(warn).not.toHaveBeenCalled();

      expect(enumNames(spec)).toEqual(['CardApplicationYamlResponse', 'CardApplicationYamlResponse2']);
      expect(members(spec, 'CardApplicationYamlResponse2')).toEqual(['compact', 'full']);
      expect(contentsOf(byName(spec).get('getNote')!.rangeResponses?.[0])).toContain(
        'application/yaml: CardApplicationYamlResponse2',
      );
      expect(contentsOf(byName(spec).get('getPet')!.defaultResponse)).toContain(
        'application/yaml: CardApplicationYamlResponse2',
      );
      expectSound(spec);
    });
  });

  it('derives the stem from the body name the component stepped to: `CardResponse2XMeta`, `CardResponse2ApplicationYamlResponse`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parse(twoOperations('200', '200'), {
      schemas: { CardResponse: { type: 'object', properties: { id: { type: 'string' } } } },
      responses: { Card: card },
    });
    expect(warn).not.toHaveBeenCalled();

    for (const op of ['getNote', 'getPet']) {
      const operation = byName(spec).get(op)!;
      expect(typeName(operation.response), op).toBe('CardResponse2');
      expect(contentsOf({ contents: operation.responseContents }), op).toEqual([
        'application/json: CardResponse2',
        'application/yaml: CardResponse2ApplicationYamlResponse',
      ]);
      expect(headersOf({ headers: operation.responseHeaders }), op).toEqual(['X-Meta: CardResponse2XMeta']);
    }
    expect(modelNames(spec)).toEqual([
      'CardResponse',
      'CardResponse2',
      'CardResponse2ApplicationYamlResponse',
      'CardResponse2XMeta',
    ]);
    expect(fieldsOf(spec, 'CardResponse')).toEqual([['id', 'string']]);
    expectSound(spec, ['CardResponse']);
  });

  it('names a header through components/headers, and one declared with `content`, after the component too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const viaRefAndContent = {
      ...card,
      headers: {
        'X-Meta': { $ref: '#/components/headers/Meta' },
        'X-Extra': {
          content: { 'application/json': { schema: { type: 'object', properties: { note: { type: 'string' } } } } },
        },
      },
    };
    const spec = await parse(twoOperations('200', '200'), {
      headers: { Meta: { schema: { type: 'object', properties: { trace: { type: 'string' } } } } },
      responses: { Card: viaRefAndContent },
    });
    expect(warn).not.toHaveBeenCalled();

    for (const op of ['getNote', 'getPet']) {
      expect(headersOf({ headers: byName(spec).get(op)!.responseHeaders }), op).toEqual([
        'X-Meta: CardXMeta',
        'X-Extra: CardXExtra',
      ]);
    }
    expect(fieldsOf(spec, 'CardXMeta')).toEqual([['trace', 'string']]);
    expect(fieldsOf(spec, 'CardXExtra')).toEqual([['note', 'string']]);
    expect(modelNames(spec)).toEqual(['CardApplicationYamlResponse', 'CardResponse', 'CardXExtra', 'CardXMeta']);
    expectSound(spec);
  });

  it('shares a component schema that admits the shape instead of minting a model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parse(twoOperations('200', '200'), {
      schemas: {
        CardXMeta: { description: 'the component', type: 'object', properties: { trace: { type: 'string' } } },
      },
      responses: { Card: card },
    });
    expect(warn).not.toHaveBeenCalled();

    expect(modelNames(spec)).toEqual(['CardApplicationYamlResponse', 'CardResponse', 'CardXMeta']);
    expect(spec.models.find((m) => m.name === 'CardXMeta')?.description).toBe('the component');
    for (const op of ['getNote', 'getPet']) {
      expect(headersOf({ headers: byName(spec).get(op)!.responseHeaders }), op).toEqual(['X-Meta: CardXMeta']);
    }
    expectSound(spec);
  });

  it('leaves an inline response named after its operation and service', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parse({
      '/notes': { get: { operationId: 'getNote', responses: { '200': card, '404': card } } },
    });
    expect(warn).not.toHaveBeenCalled();

    const getNote = byName(spec).get('getNote')!;
    expect(contentsOf({ contents: getNote.responseContents })).toEqual([
      'application/json: GetNoteResponse',
      'application/yaml: GetNoteApplicationYamlResponse',
    ]);
    expect(headersOf({ headers: getNote.responseHeaders })).toEqual(['X-Meta: NotesXMeta']);
    expect(contentsOf(getNote.errors[0])).toEqual([
      'application/json: GetNoteError404',
      'application/yaml: GetNoteError404ApplicationYaml',
    ]);
    expect(headersOf(getNote.errors[0])).toEqual(['X-Meta: NotesXMeta']);
    expectSound(spec);
  });

  describe("named before every operation's own site, whatever the path order (issue #423)", () => {
    // A component's headers, secondary bodies and error or fallback body used
    // to be named among every other deferred site in path order, the first
    // owner keeping a name, so moving or adding an operation renamed the
    // model of another, unchanged one.
    const object = (field: string) => ({ type: 'object', properties: { [field]: { type: 'string' } } });
    const metaCard = { description: 'A card', headers: { 'X-Meta': { schema: object('trace') } } };
    const getNote = { '/notes': { get: { operationId: 'getNote', responses: { '200': cardRef } } } };
    /** `GET /card` (`getCard`): an inline 200 whose own `X-Meta` derives `CardXMeta` from its service. */
    const getCard = {
      '/card': {
        get: {
          operationId: 'getCard',
          responses: { '200': { description: 'ok', headers: { 'X-Meta': { schema: object('other') } } } },
        },
      },
    };
    /** Every header and every `application/yaml` body of every operation, as the issue's repro prints them, sorted. */
    const sites = (spec: ApiSpec): string[] =>
      spec.services
        .flatMap((s) => s.operations)
        .flatMap(({ name, responseContents = [], responseHeaders = [] }) => [
          ...responseHeaders.map((h) => `${name} ${h.name}: ${typeName(h.type)}`),
          ...responseContents
            .filter((c) => c.contentType === 'application/yaml')
            .map((c) => `${name} ${c.contentType}: ${typeName(c.type)}`),
        ])
        .sort();

    it('two components whose headers derive `CardXMeta`: the one `components/responses` lists first keeps it, in either path order', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cardX = { description: 'Another card', headers: { Meta: { schema: object('other') } } };
      const getPet = {
        '/pets': { get: { operationId: 'getPet', responses: { '200': { $ref: '#/components/responses/CardX' } } } },
      };
      const components = { responses: { Card: metaCard, CardX: cardX } };
      const notesFirst = await parse({ ...getNote, ...getPet }, components);
      const petsFirst = await parse({ ...getPet, ...getNote }, components);
      // The components' own order decides, as it does between their bodies.
      const cardXListedFirst = await parse({ ...getNote, ...getPet }, { responses: { CardX: cardX, Card: metaCard } });
      expect(warn).not.toHaveBeenCalled();

      // Before: `getPet Meta: CardXMeta` and `getNote X-Meta: CardXMeta2` with `/pets` first.
      for (const spec of [notesFirst, petsFirst]) {
        expect(sites(spec)).toEqual(['getNote X-Meta: CardXMeta', 'getPet Meta: CardXMeta2']);
        expect(fieldsOf(spec, 'CardXMeta')).toEqual([['trace', 'string']]);
        expect(fieldsOf(spec, 'CardXMeta2')).toEqual([['other', 'string']]);
        expectSound(spec);
      }
      // Moving an operation is no change.
      expect(diffSpecs(notesFirst, petsFirst).changes).toEqual([]);
      expect(sites(cardXListedFirst)).toEqual(['getNote X-Meta: CardXMeta2', 'getPet Meta: CardXMeta']);
      expectSound(cardXListedFirst);
    });

    it("an operation's own header that derives `CardXMeta` steps by operation, in either path order", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const components = { responses: { Card: metaCard } };
      const cardFirst = await parse({ ...getCard, ...getNote }, components);
      const notesFirst = await parse({ ...getNote, ...getCard }, components);
      expect(warn).not.toHaveBeenCalled();

      // Before: `getCard X-Meta: CardXMeta` and `getNote X-Meta: CardXMeta2` with `/card` first.
      for (const spec of [cardFirst, notesFirst]) {
        expect(sites(spec)).toEqual(['getCard X-Meta: CardGetCardXMeta', 'getNote X-Meta: CardXMeta']);
        expect(fieldsOf(spec, 'CardXMeta')).toEqual([['trace', 'string']]);
        expect(fieldsOf(spec, 'CardGetCardXMeta')).toEqual([['other', 'string']]);
        expectSound(spec);
      }
      expect(diffSpecs(cardFirst, notesFirst).changes).toEqual([]);
    });

    it("an operation that returns the component steps its own header past the component's by operation, in either path order", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const components = { responses: { Card: metaCard } };
      // `getCard` mounts `Card` at its 404, so with `/card` first it is the
      // first operation to read the component's `X-Meta`; the component's
      // site is still nobody's own, so `getCard`'s 200 header steps past it
      // by operation, as beside a component, never by its status code.
      const getCardToo = {
        '/card': {
          get: {
            operationId: 'getCard',
            responses: { ...getCard['/card'].get.responses, '404': cardRef },
          },
        },
      };
      const cardFirst = await parse({ ...getCardToo, ...getNote }, components);
      const notesFirst = await parse({ ...getNote, ...getCardToo }, components);
      expect(warn).not.toHaveBeenCalled();

      // Before, with `/card` first: `CardXMeta` for the 200 and `CardXMeta2` for the 404.
      for (const spec of [cardFirst, notesFirst]) {
        const operation = byName(spec).get('getCard')!;
        expect(headersOf({ headers: operation.responseHeaders })).toEqual(['X-Meta: CardGetCardXMeta']);
        expect(headersOf(operation.errors[0])).toEqual(['X-Meta: CardXMeta']);
        expect(headersOf({ headers: byName(spec).get('getNote')!.responseHeaders })).toEqual(['X-Meta: CardXMeta']);
        expect(fieldsOf(spec, 'CardXMeta')).toEqual([['trace', 'string']]);
        expect(fieldsOf(spec, 'CardGetCardXMeta')).toEqual([['other', 'string']]);
        expectSound(spec);
      }
      expect(diffSpecs(cardFirst, notesFirst).changes).toEqual([]);
    });

    it("an operation's own `application/yaml` body that derives the component's name steps by status code, in either path order", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const components = {
        responses: {
          Card: {
            description: 'A card',
            content: { 'application/json': { schema: object('text') }, 'application/yaml': { schema: object('y') } },
          },
        },
      };
      const card = {
        '/card': {
          get: {
            operationId: 'card',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': { schema: { type: 'string' } },
                  'application/yaml': { schema: object('other') },
                },
              },
            },
          },
        },
      };
      const cardFirst = await parse({ ...card, ...getNote }, components);
      const notesFirst = await parse({ ...getNote, ...card }, components);
      expect(warn).not.toHaveBeenCalled();

      // Before: `card`'s took `CardApplicationYamlResponse` and the component's
      // stepped to `CardApplicationYamlResponse2` with `/card` first.
      for (const spec of [cardFirst, notesFirst]) {
        expect(sites(spec)).toEqual([
          'card application/yaml: CardApplicationYamlResponse200',
          'getNote application/yaml: CardApplicationYamlResponse',
        ]);
        expect(fieldsOf(spec, 'CardApplicationYamlResponse')).toEqual([['y', 'string']]);
        expect(fieldsOf(spec, 'CardApplicationYamlResponse200')).toEqual([['other', 'string']]);
        expectSound(spec);
      }
      expect(diffSpecs(cardFirst, notesFirst).changes).toEqual([]);
    });

    it("removing one of the operations that return the component leaves the others' names unchanged", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const components = { responses: { Card: metaCard } };
      const getPet = { '/pets': { get: { operationId: 'getPet', responses: { '200': cardRef } } } };
      const all = await parse({ ...getNote, ...getCard, ...getPet }, components);
      const withoutNote = await parse({ ...getCard, ...getPet }, components);
      expect(warn).not.toHaveBeenCalled();

      expect(sites(all)).toEqual([
        'getCard X-Meta: CardGetCardXMeta',
        'getNote X-Meta: CardXMeta',
        'getPet X-Meta: CardXMeta',
      ]);
      // Before: `getCard`, first once `getNote` was gone, took `CardXMeta`,
      // and `getPet`'s header stepped to `CardXMeta2`.
      expect(sites(withoutNote)).toEqual(['getCard X-Meta: CardGetCardXMeta', 'getPet X-Meta: CardXMeta']);
      expect(diffSpecs(all, withoutNote).changes.map((change) => change.kind)).toEqual(['service-removed']);
    });

    it("lists the models where the document reads their sites, though a component's are named first", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const problem = {
        description: 'A problem',
        headers: { 'X-Trace': { schema: object('id') } },
        content: { 'application/json': { schema: object('title') } },
      };
      const spec = await parse(
        {
          '/pets': {
            get: {
              operationId: 'listPets',
              responses: { '200': { description: 'ok', headers: { 'X-Meta': { schema: object('page') } } } },
            },
          },
          '/notes': {
            get: {
              operationId: 'getNote',
              responses: { '200': ok, '404': { $ref: '#/components/responses/Problem' } },
            },
          },
        },
        { responses: { Problem: problem } },
      );
      expect(warn).not.toHaveBeenCalled();

      // No name changes, so neither does the order the IR lists the models in.
      expect(spec.models.map((m) => m.name)).toEqual(['PetsXMeta', 'ProblemXTrace', 'ProblemResponse']);
      expectSound(spec);
    });
  });
});

describe('a component list envelope is reserved under both readings (#309 review)', () => {
  // `bodyModelNames` used to classify the body unwrapped only, so an
  // operation that keeps the envelope (no paging parameter) minted names the
  // reservation never saw: `NotePageResponseData` beside a schema of that name
  // was renamed late instead of the stem stepping, and the one item schema
  // took one name per reading with nothing keeping them together.
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const notePage = {
    description: 'A page of notes',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } },
            has_more: { type: 'boolean' },
          },
        },
      },
    },
  };
  const after = [{ name: 'after', in: 'query', schema: { type: 'string' } }];
  const returnsNotePage = (operationId: string, parameters?: unknown[]) => ({
    get: {
      operationId,
      ...(parameters && { parameters }),
      responses: { '200': { $ref: '#/components/responses/NotePage' } },
    },
  });

  async function parseNotes(
    paths: Record<string, unknown>,
    schemas: Record<string, unknown> = {},
  ): Promise<{ spec: ApiSpec; warnings: string[] }> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      dir = mkdtempSync(join(tmpdir(), 'oagen-309-'));
      const specPath = join(dir, 'spec.json');
      writeFileSync(
        specPath,
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'notes', version: '1' },
          paths,
          components: { responses: { NotePage: notePage }, schemas },
        }),
      );
      const spec = await parseSpec(specPath);
      validateModelRefs(spec);
      return { spec, warnings: warn.mock.calls.map((call) => String(call[0])) };
    } finally {
      warn.mockRestore();
    }
  }

  const fieldsOf = (spec: ApiSpec, name: string) =>
    spec.models.find((m) => m.name === name)?.fields.map((f) => [f.name, f.type]);
  const opsByName = (spec: ApiSpec) => new Map(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
  const unpagedWarning = expect.stringContaining('listNotes returns a list envelope but no query parameter');

  it('steps the stem when the kept reading clashes with a component schema, instead of renaming late', async () => {
    const { spec, warnings } = await parseNotes(
      { '/notes': returnsNotePage('listNotes') },
      { NotePageResponseData: { type: 'object', properties: { other: { type: 'string' } } } },
    );
    const op = opsByName(spec).get('listNotes')!;
    expect(op.pagination).toBeUndefined();
    expect(op.response).toEqual({ kind: 'model', name: 'NotePageResponse2' });
    expect(fieldsOf(spec, 'NotePageResponse2')).toEqual([
      ['data', { kind: 'array', items: { kind: 'model', name: 'NotePageResponse2Data' } }],
      ['has_more', { kind: 'primitive', type: 'boolean' }],
    ]);
    expect(fieldsOf(spec, 'NotePageResponse2Data')).toEqual([['title', { kind: 'primitive', type: 'string' }]]);
    // The component schema keeps its name and its shape.
    expect(fieldsOf(spec, 'NotePageResponseData')).toEqual([['other', { kind: 'primitive', type: 'string' }]]);
    expect(spec.models.map((m) => m.name).sort()).toEqual(
      ['NotePageResponse2', 'NotePageResponse2Data', 'NotePageResponseData'].sort(),
    );
    expect(warnings).toEqual([unpagedWarning]);
  });

  it('keeps both readings of one body on names the reservation saw, when two operations read it differently', async () => {
    const { spec, warnings } = await parseNotes({
      '/notes': returnsNotePage('listNotes'),
      '/notes/recent': returnsNotePage('listRecentNotes', after),
    });
    const ops = opsByName(spec);
    expect(ops.get('listNotes')!.response).toEqual({ kind: 'model', name: 'NotePageResponse' });
    expect(ops.get('listNotes')!.pagination).toBeUndefined();
    expect(ops.get('listRecentNotes')!.response).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'NotePageItem' },
    });
    expect(ops.get('listRecentNotes')!.pagination).toMatchObject({
      strategy: 'cursor',
      param: 'after',
      itemType: { kind: 'model', name: 'NotePageItem' },
      endOfIteration: { kind: 'hasMore', path: 'has_more' },
    });
    expect(fieldsOf(spec, 'NotePageResponse')).toEqual([
      ['data', { kind: 'array', items: { kind: 'model', name: 'NotePageResponseData' } }],
      ['has_more', { kind: 'primitive', type: 'boolean' }],
    ]);
    expect(fieldsOf(spec, 'NotePageResponseData')).toEqual([['title', { kind: 'primitive', type: 'string' }]]);
    expect(fieldsOf(spec, 'NotePageItem')).toEqual([['title', { kind: 'primitive', type: 'string' }]]);
    expect(spec.models.map((m) => m.name).sort()).toEqual(['NotePageItem', 'NotePageResponse', 'NotePageResponseData']);
    expect(warnings).toEqual([unpagedWarning]);
  });

  it('moves both readings together when the unwrapped one clashes with a component schema', async () => {
    const { spec, warnings } = await parseNotes(
      { '/notes': returnsNotePage('listNotes'), '/notes/recent': returnsNotePage('listRecentNotes', after) },
      { NotePageItem: { type: 'object', properties: { other: { type: 'string' } } } },
    );
    const ops = opsByName(spec);
    expect(ops.get('listNotes')!.response).toEqual({ kind: 'model', name: 'NotePageResponse2' });
    expect(ops.get('listRecentNotes')!.response).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'NotePageResponse2Item' },
    });
    expect(fieldsOf(spec, 'NotePageResponse2')).toEqual([
      ['data', { kind: 'array', items: { kind: 'model', name: 'NotePageResponse2Data' } }],
      ['has_more', { kind: 'primitive', type: 'boolean' }],
    ]);
    expect(fieldsOf(spec, 'NotePageItem')).toEqual([['other', { kind: 'primitive', type: 'string' }]]);
    expect(spec.models.map((m) => m.name).sort()).toEqual(
      ['NotePageItem', 'NotePageResponse2', 'NotePageResponse2Data', 'NotePageResponse2Item'].sort(),
    );
    expect(warnings).toEqual([unpagedWarning]);
  });

  it('reserves the kept reading at a secondary status code too, beside another primary body', async () => {
    // The component is returned at the 201 of an operation whose 200 is a
    // plain `{ id }`; the kept envelope keeps the component's stem, stepped
    // past the clashing schema, and never the operation's primary stem.
    const { spec, warnings } = await parseNotes(
      {
        '/notes': {
          get: {
            operationId: 'listNotes',
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
              },
              '201': { $ref: '#/components/responses/NotePage' },
            },
          },
        },
      },
      { NotePageResponseData: { type: 'object', properties: { other: { type: 'string' } } } },
    );
    const op = opsByName(spec).get('listNotes')!;
    expect(op.pagination).toBeUndefined();
    expect(op.response).toEqual({ kind: 'model', name: 'ListNotesResponse' });
    expect(op.successResponses?.map((r) => [r.statusCode, r.type])).toEqual([
      [200, { kind: 'model', name: 'ListNotesResponse' }],
      [201, { kind: 'model', name: 'NotePageResponse2' }],
    ]);
    expect(fieldsOf(spec, 'ListNotesResponse')).toEqual([['id', { kind: 'primitive', type: 'string' }]]);
    expect(fieldsOf(spec, 'NotePageResponse2')).toEqual([
      ['data', { kind: 'array', items: { kind: 'model', name: 'NotePageResponse2Data' } }],
      ['has_more', { kind: 'primitive', type: 'boolean' }],
    ]);
    expect(fieldsOf(spec, 'NotePageResponseData')).toEqual([['other', { kind: 'primitive', type: 'string' }]]);
    expect(spec.models.map((m) => m.name).sort()).toEqual(
      ['ListNotesResponse', 'NotePageResponse2', 'NotePageResponse2Data', 'NotePageResponseData'].sort(),
    );
    // The primary 200 is no envelope, so nothing warns.
    expect(warnings).toEqual([]);
  });
});
