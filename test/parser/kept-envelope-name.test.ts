import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { classifyAndExtractResponse } from '../../src/parser/responses.js';

/**
 * Issue #418: a list envelope kept as a plain response model because nothing
 * pages it was named from its `object: list` const, minting a model called
 * `List` — shadowing the list type of Kotlin and .NET, and shared by every
 * such envelope whatever it listed. A list envelope's const names the
 * envelope's kind, never what it lists, so the kept envelope is named for its
 * operation (`<Op>Response`), as one without a const always was.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function parseDoc(doc: unknown) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-kept-envelope-name-'));
  dirs.push(dir);
  const file = path.join(dir, 'spec.json');
  await fs.writeFile(file, JSON.stringify(doc));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await parseSpec(file);
  } finally {
    warn.mockRestore();
  }
}

/** The issue's WorkOS-style envelope around `items`: `{ object: const list, data, list_metadata }`. */
const listEnvelope = (items: unknown) => ({
  type: 'object',
  required: ['object', 'data', 'list_metadata'],
  properties: {
    object: { type: 'string', const: 'list' },
    data: { type: 'array', items },
    list_metadata: {
      type: 'object',
      required: ['before', 'after'],
      properties: { before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } },
    },
  },
});

const listOperation = (operationId: string, schema: unknown) => ({
  get: {
    operationId,
    responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
  },
});

describe('a list envelope kept as a plain response model (issue #418)', () => {
  it('the issue repro is named for its operation, not `List`', async () => {
    const ir = await parseDoc({
      openapi: '3.1.0',
      info: { title: 'Pets', version: '1.0.0' },
      paths: { '/pets': listOperation('PetsController_list', listEnvelope({ $ref: '#/components/schemas/Pet' })) },
      components: {
        schemas: { Pet: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    });
    const op = ir.services.flatMap((s) => s.operations)[0];
    expect(op.pagination).toBeUndefined();
    expect(op.response).toEqual({ kind: 'model', name: 'PetsListResponse' });
    const wrapper = ir.models.find((m) => m.name === 'PetsListResponse');
    expect(wrapper?.fields.map((f) => f.name)).toEqual(['object', 'data', 'list_metadata']);
    expect(ir.models.map((m) => m.name)).not.toContain('List');
  });

  it('two kept envelopes are each named for their operation, not one shared `List`', async () => {
    const ir = await parseDoc({
      openapi: '3.1.0',
      info: { title: 'Pets', version: '1.0.0' },
      paths: {
        '/pets': listOperation('listPets', listEnvelope({ type: 'string' })),
        '/owners': listOperation('listOwners', listEnvelope({ type: 'integer' })),
      },
    });
    expect(ir.services.flatMap((s) => s.operations).map((op) => op.response)).toEqual([
      { kind: 'model', name: 'ListPetsResponse' },
      { kind: 'model', name: 'ListOwnersResponse' },
    ]);
    // Each keeps its own data type: they no longer collapse onto one `List`.
    const dataOf = (name: string) =>
      ir.models.find((m) => m.name === name)?.fields.find((f) => f.name === 'data')?.type;
    expect(dataOf('ListPetsResponse')).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'string' } });
    expect(dataOf('ListOwnersResponse')).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'integer' } });
    expect(ir.models.map((m) => m.name).filter((name) => /^List\d*$/.test(name))).toEqual([]);
  });

  it('an allOf envelope kept as a plain model is named for its operation too', () => {
    const schema = {
      allOf: [
        {
          type: 'object',
          properties: { object: { type: 'string', const: 'list' }, list_metadata: { type: 'object' } },
        },
        { type: 'object', properties: { data: { type: 'array', items: { type: 'string' } } } },
      ],
    };
    const kept = classifyAndExtractResponse(schema, 'ListPetsResponse', undefined, { paginationDisabled: true });
    expect(kept.response).toEqual({ kind: 'model', name: 'ListPetsResponse' });
    expect(kept.unpagedEnvelope).toBe(true);
  });

  it('a resource body is still named from its const', () => {
    const schema = {
      type: 'object',
      properties: { object: { type: 'string', const: 'pet' }, id: { type: 'string' } },
    };
    expect(classifyAndExtractResponse(schema, 'GetPetResponse').response).toEqual({ kind: 'model', name: 'Pet' });
  });
});
