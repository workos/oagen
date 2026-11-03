import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { resolveResponseRef } from '../../src/parser/response-refs.js';

type Response = { description?: string; content?: Record<string, unknown> };

const problem: Response = { description: 'A problem', content: { 'application/json': { schema: { type: 'object' } } } };

describe('resolveResponseRef', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an inline Response Object as it is', () => {
    const inline: Response = { description: 'ok' };
    expect(resolveResponseRef(inline, undefined, 'ctx')).toBe(inline);
  });

  it('resolves a ref into components/responses', () => {
    expect(resolveResponseRef<Response>({ $ref: '#/components/responses/Problem' }, { Problem: problem }, 'ctx')).toBe(
      problem,
    );
  });

  it('follows a chain of refs', () => {
    const components = { Alias: { $ref: '#/components/responses/Problem' }, Problem: problem };
    expect(resolveResponseRef<Response>({ $ref: '#/components/responses/Alias' }, components, 'ctx')).toBe(problem);
  });

  it('unescapes JSON Pointer tokens (~1 then ~0)', () => {
    expect(resolveResponseRef<Response>({ $ref: '#/components/responses/a~1b~0c' }, { 'a/b~c': problem }, 'ctx')).toBe(
      problem,
    );
  });

  it("keeps a sibling description beside the $ref, the outermost winning over inner refs' and the component's", () => {
    const components = {
      Alias: { $ref: '#/components/responses/Problem', description: 'inner' },
      Problem: problem,
    };
    expect(
      resolveResponseRef<Response>({ $ref: '#/components/responses/Alias', description: 'outer' }, components, 'ctx'),
    ).toEqual({ ...problem, description: 'outer' });
    expect(resolveResponseRef<Response>({ $ref: '#/components/responses/Alias' }, components, 'ctx')).toEqual({
      ...problem,
      description: 'inner',
    });
    // Without a sibling description, the component is returned untouched.
    expect(resolveResponseRef<Response>({ $ref: '#/components/responses/Problem' }, components, 'ctx')).toBe(problem);
  });

  it('warns on a ref no component response answers, naming the ref and the context, and returns it as written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = { $ref: '#/components/responses/Missing' };
    expect(resolveResponseRef(missing, { Problem: problem }, 'default of op')).toBe(missing);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unresolved response $ref "#/components/responses/Missing" in default of op: no matching entry under components/responses',
      ),
    );
    expect(resolveResponseRef({ $ref: '#/components/responses/Problem' }, undefined, 'ctx')).toEqual({
      $ref: '#/components/responses/Problem',
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("ignores a sibling description under 'ignore' (OAS 3.0), keeping the component's own", () => {
    const components = { Problem: problem, Alias: { $ref: '#/components/responses/Problem', description: 'Inner' } };
    expect(
      resolveResponseRef<Response>(
        { $ref: '#/components/responses/Alias', description: 'Outer' },
        components,
        'ctx',
        'ignore',
      ),
    ).toBe(problem);
  });

  it('keeps the sibling description on a ref it cannot resolve', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      resolveResponseRef({ $ref: '#/components/responses/Missing', description: 'Gone' }, { Problem: problem }, 'ctx'),
    ).toEqual({ $ref: '#/components/responses/Missing', description: 'Gone' });
  });

  it('does not resolve a ref into another section off a same-named response', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elsewhere = { $ref: '#/components/schemas/Problem' };
    expect(resolveResponseRef(elsewhere, { Problem: problem }, 'ctx')).toBe(elsewhere);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unresolved response $ref "#/components/schemas/Problem"'),
    );
  });

  it('throws on a circular chain instead of looping', () => {
    const components = { A: { $ref: '#/components/responses/B' }, B: { $ref: '#/components/responses/A' } };
    expect(() => resolveResponseRef({ $ref: '#/components/responses/A' }, components, 'ctx')).toThrow(
      'Circular response $ref chain starting at "#/components/responses/A" in ctx.',
    );
  });
});

/**
 * Covers issue #444: under `'ignore'` (OAS 3.0) a ref nothing under
 * `components/responses` answers was returned with the `description`
 * written beside it, though no other ref's is read there. It is now returned
 * without it, written beside the operation's ref or one a component writes.
 */
describe('resolveResponseRef on a ref it cannot resolve, under ignore (#444)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the ref without the description beside it, direct or at the end of a chain', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const beside = { $ref: '#/components/schemas/Pet', description: 'Not adopted yet.' };
    const components = { NotAdopted: beside, Problem: problem };

    expect(resolveResponseRef<Response>(beside, components, '404 of getPet', 'ignore')).toEqual({
      $ref: '#/components/schemas/Pet',
    });
    expect(
      resolveResponseRef<Response>(
        { $ref: '#/components/responses/NotAdopted' },
        components,
        '404 of getPet',
        'ignore',
      ),
    ).toEqual({ $ref: '#/components/schemas/Pet' });
    // Still warned about, and read as written; a ref that resolves keeps the component's own description.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(
      resolveResponseRef<Response>(
        { $ref: '#/components/responses/Problem', description: 'Beside.' },
        components,
        'ctx',
        'ignore',
      ),
    ).toBe(problem);
  });
});

/**
 * Covers issue #563: a response whose `$ref` is not a string ended the walk
 * as `malformed` and was returned as written without a word, while the
 * webhook reader warned about the same ref. It is now warned about as a ref
 * nothing answers is, naming the value and the context, and still returned
 * as written: no body, no headers, its sibling `description` kept under
 * `'override'` and ignored under `'ignore'`.
 */
describe('#563', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns on a $ref that is not a string, naming the value and the context, and returns the response as written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformed = { $ref: 42 };
    expect(resolveResponseRef(malformed, { Problem: problem }, '404 response of getPet')).toBe(malformed);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[oagen] Warning: Malformed response $ref 42 in 404 response of getPet: a $ref must be a string — reading the response as written, without a body or headers',
    );
    // At a fallback key, and with no component responses at all.
    expect(resolveResponseRef(malformed, undefined, 'default response of getPet')).toBe(malformed);
    expect(warn).toHaveBeenLastCalledWith(
      expect.stringContaining('Malformed response $ref 42 in default response of getPet: a $ref must be a string'),
    );
  });

  it('names a $ref of any other type as String() renders it; a $ref holding undefined is no reference', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveResponseRef({ $ref: null }, undefined, 'ctx');
    resolveResponseRef({ $ref: true }, undefined, 'ctx');
    resolveResponseRef({ $ref: { $ref: '#/components/responses/Problem' } }, undefined, 'ctx');
    // An array of one string renders as that string: only the message's
    // "must be a string" tells it from a ref nothing answers.
    resolveResponseRef({ $ref: ['#/components/responses/Problem'] }, undefined, 'ctx');
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('Malformed response $ref null in ctx: a $ref must be a string'),
      expect.stringContaining('Malformed response $ref true in ctx: a $ref must be a string'),
      expect.stringContaining('Malformed response $ref [object Object] in ctx: a $ref must be a string'),
      expect.stringContaining('Malformed response $ref #/components/responses/Problem in ctx: a $ref must be a string'),
    ]);
    const unset = { $ref: undefined, description: 'Inline after all.' };
    expect(resolveResponseRef(unset, undefined, 'ctx')).toBe(unset);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("warns on a malformed $ref at the end of a chain and returns the chain's last object", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const components = { Alias: { $ref: 42 }, Problem: problem };
    expect(resolveResponseRef({ $ref: '#/components/responses/Alias' }, components, '404 response of getPet')).toBe(
      components.Alias,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Malformed response $ref 42 in 404 response of getPet: a $ref must be a string'),
    );
  });

  it("keeps the sibling description under 'override' and drops it under 'ignore', as beside a ref nothing answers", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const beside = { $ref: 42, description: 'Not found.' };
    expect(resolveResponseRef(beside, undefined, 'ctx')).toBe(beside);
    expect(resolveResponseRef(beside, undefined, 'ctx', 'ignore')).toEqual({ $ref: 42 });
    // Through a chain the outermost description still wins under 'override',
    // and none is read under 'ignore'.
    const components = { Alias: { $ref: 42, description: 'inner' } };
    const outer = { $ref: '#/components/responses/Alias', description: 'outer' };
    expect(resolveResponseRef(outer, components, 'ctx')).toEqual({ $ref: 42, description: 'outer' });
    expect(resolveResponseRef(outer, components, 'ctx', 'ignore')).toEqual({ $ref: 42 });
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("reports nothing under onFailure 'silent'", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformed = { $ref: 42 };
    expect(resolveResponseRef(malformed, undefined, 'ctx', 'override', 'silent')).toBe(malformed);
    expect(resolveResponseRef(malformed, undefined, 'ctx', 'ignore', 'silent')).toBe(malformed);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('in a parsed document', () => {
    /**
     * The issue's repro: `getPet` returns `Pet` at 200 and `{ $ref: 42 }`
     * under `key`, beside a webhook that returns the same ref at 200.
     */
    const document = (openapi: string, key: string): Record<string, unknown> => ({
      openapi,
      info: { title: 'Pets', version: '1.0.0' },
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              '200': {
                description: 'A pet',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
              },
              [key]: { $ref: 42 },
            },
          },
        },
      },
      webhooks: {
        petAdopted: {
          post: {
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
            responses: { '200': { $ref: 42 } },
          },
        },
      },
      components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } },
    });

    async function parseDocument(spec: Record<string, unknown>) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-response-refs-'));
      const file = path.join(dir, 'spec.json');
      try {
        await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
        return await parseSpec(file);
      } finally {
        await fs.rm(dir, { recursive: true });
      }
    }

    const malformedWarning = (key: string) =>
      `[oagen] Warning: Malformed response $ref 42 in ${key} response of getPet: a $ref must be a string — reading the response as written, without a body or headers`;
    const webhookWarning =
      '[oagen] Warning: Circular or malformed response $ref for status 200 in webhooks.petAdopted.post; keeping the status code only.';

    for (const openapi of ['3.0.3', '3.1.0']) {
      it(`warns about the operation's 404 as about the webhook's 200, keeping both, in an OAS ${openapi} document`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { services, webhooks } = await parseDocument(document(openapi, '404'));
        const [op] = services.flatMap(({ operations }) => operations);
        expect(op.errors.map(({ statusCode }) => statusCode)).toEqual([404]);
        expect(op.defaultResponse).toBeUndefined();
        expect(webhooks?.flatMap(({ responses }) => responses.map(({ statusCode }) => statusCode))).toEqual([200]);
        expect(warn.mock.calls.map(([message]) => message)).toEqual([malformedWarning('404'), webhookWarning]);
      });

      it(`warns about the operation's default response, keeping it without a body, in an OAS ${openapi} document`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { services, webhooks } = await parseDocument(document(openapi, 'default'));
        const [op] = services.flatMap(({ operations }) => operations);
        expect(op.errors).toEqual([]);
        expect(op.defaultResponse).toEqual({});
        expect(webhooks?.flatMap(({ responses }) => responses.map(({ statusCode }) => statusCode))).toEqual([200]);
        expect(warn.mock.calls.map(([message]) => message)).toEqual([malformedWarning('default'), webhookWarning]);
      });
    }
  });
});

/**
 * Covers issue #562: a response `$ref` nothing under `components/responses`
 * answers, or one that is not a string, was returned with every key written
 * beside it, less only its text under `'ignore'`, so a `content` or
 * `headers` there gave the error entry a body and headers — although the
 * warning says the response is read without either, and a ref that
 * resolves ignores both. A Reference Object carries nothing but its `$ref`
 * and, in OAS 3.1, the text beside it; OpenAPI says any other property is
 * ignored. A failed ref is now returned with its `$ref` and that text
 * alone, in a 3.0 and a 3.1 document alike, so the entry has no `type` and
 * no `headers`, as beside a ref that resolves.
 */
describe('#562', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The issue's siblings: a body and a header written beside the `$ref`. */
  const beside = {
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } },
    headers: { 'X-Rate-Limit': { schema: { type: 'integer' } } },
  };

  it('returns a ref nothing answers with its $ref alone, the content and headers beside it left out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dangling = { $ref: '#/components/schemas/Pet', ...beside };
    const expected = { $ref: '#/components/schemas/Pet' };
    expect(resolveResponseRef(dangling, { Problem: problem }, '404 response of getPet')).toEqual(expected);
    expect(resolveResponseRef(dangling, { Problem: problem }, '404 response of getPet', 'ignore')).toEqual(expected);
    // At the end of a chain, written beside the ref a component writes.
    const components = { NotAdopted: dangling, Problem: problem };
    expect(resolveResponseRef({ $ref: '#/components/responses/NotAdopted' }, components, 'ctx')).toEqual(expected);
    // Still warned about, once each.
    expect(warn.mock.calls.map(([message]) => message)).toEqual(
      Array(3).fill(expect.stringContaining('Unresolved response $ref "#/components/schemas/Pet"')),
    );
  });

  it("keeps the description beside it under 'override' and nothing else, and only the $ref under 'ignore'", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const described = { $ref: '#/components/schemas/Pet', description: 'Not adopted yet.', ...beside };
    expect(resolveResponseRef(described, undefined, 'ctx')).toEqual({
      $ref: '#/components/schemas/Pet',
      description: 'Not adopted yet.',
    });
    expect(resolveResponseRef(described, undefined, 'ctx', 'ignore')).toEqual({ $ref: '#/components/schemas/Pet' });
    // Through a chain the outermost description still wins, and the inner
    // ref's content and headers are left out with it.
    const components = { NotAdopted: described };
    const outer = { $ref: '#/components/responses/NotAdopted', description: 'Outer.' };
    expect(resolveResponseRef(outer, components, 'ctx')).toEqual({
      $ref: '#/components/schemas/Pet',
      description: 'Outer.',
    });
    expect(resolveResponseRef(outer, components, 'ctx', 'ignore')).toEqual({ $ref: '#/components/schemas/Pet' });
  });

  it('reads a malformed $ref the same way, direct or at the end of a chain', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformed = { $ref: 42, description: 'Beside.', ...beside };
    expect(resolveResponseRef(malformed, undefined, 'ctx')).toEqual({ $ref: 42, description: 'Beside.' });
    expect(resolveResponseRef(malformed, undefined, 'ctx', 'ignore')).toEqual({ $ref: 42 });
    const components = { Alias: malformed };
    expect(resolveResponseRef({ $ref: '#/components/responses/Alias' }, components, 'ctx')).toEqual({
      $ref: 42,
      description: 'Beside.',
    });
    expect(warn.mock.calls.map(([message]) => message)).toEqual(
      Array(3).fill(expect.stringContaining('Malformed response $ref 42 in ctx: a $ref must be a string')),
    );
  });

  it("leaves the same keys out under onFailure 'silent', and a ref with nothing beside it keeps its identity", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dangling = { $ref: '#/components/schemas/Pet', ...beside };
    expect(resolveResponseRef(dangling, undefined, 'ctx', 'override', 'silent')).toEqual({
      $ref: '#/components/schemas/Pet',
    });
    expect(resolveResponseRef(dangling, undefined, 'ctx', 'ignore', 'silent')).toEqual({
      $ref: '#/components/schemas/Pet',
    });
    expect(warn).not.toHaveBeenCalled();
    const bare = { $ref: '#/components/schemas/Pet' };
    expect(resolveResponseRef(bare, undefined, 'ctx', 'override', 'silent')).toBe(bare);
    expect(resolveResponseRef(bare, undefined, 'ctx', 'ignore', 'silent')).toBe(bare);
  });

  it('ignores the content and headers beside a ref that resolves, as before', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolving = { $ref: '#/components/responses/Problem', ...beside };
    expect(resolveResponseRef<Response>(resolving, { Problem: problem }, 'ctx')).toBe(problem);
    expect(resolveResponseRef<Response>(resolving, { Problem: problem }, 'ctx', 'ignore')).toBe(problem);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('in a parsed document', () => {
    /**
     * The issue's repro: `getPet` returns `Pet` at 200 and, under `key`, a
     * ref with a `Note` body and an `X-Rate-Limit` header written beside it.
     */
    const document = (openapi: string, key: string, response: Record<string, unknown>): Record<string, unknown> => ({
      openapi,
      info: { title: 'Pets', version: '1.0.0' },
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              '200': {
                description: 'A pet',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
              },
              [key]: response,
            },
          },
        },
      },
      components: {
        schemas: {
          Note: { type: 'object', properties: { text: { type: 'string' } } },
          Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        },
        responses: { PetMissing: { description: 'Missing.' } },
      },
    });

    async function parseDocument(spec: Record<string, unknown>) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-response-refs-'));
      const file = path.join(dir, 'spec.json');
      try {
        await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
        return await parseSpec(file);
      } finally {
        await fs.rm(dir, { recursive: true });
      }
    }

    /** The entry `key` names on `getPet`: the one error, or the fallback. */
    async function entryOf(openapi: string, key: string, response: Record<string, unknown>) {
      const { services } = await parseDocument(document(openapi, key, response));
      const [op] = services.flatMap(({ operations }) => operations);
      if (key === 'default') {
        expect(op.errors).toEqual([]);
        return op.defaultResponse;
      }
      expect(op.defaultResponse).toBeUndefined();
      expect(op.errors).toHaveLength(1);
      return op.errors[0];
    }

    const unresolvedWarning = (key: string) =>
      `[oagen] Warning: Unresolved response $ref "#/components/schemas/Pet" in ${key} response of getPet: no matching entry under components/responses — reading the response as written, without a body or headers`;
    const malformedWarning = (key: string) =>
      `[oagen] Warning: Malformed response $ref 42 in ${key} response of getPet: a $ref must be a string — reading the response as written, without a body or headers`;

    for (const openapi of ['3.0.3', '3.1.0']) {
      // OAS 3.0 ignores the text beside a `$ref`; 3.1 reads it.
      const text = openapi === '3.1.0' ? { description: 'Not adopted yet.' } : {};
      for (const key of ['404', 'default']) {
        const code = key === 'default' ? {} : { statusCode: 404 };

        it(`gives the ${key} of an OAS ${openapi} document no body and no headers beside a ref nothing answers`, async () => {
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const dangling = { $ref: '#/components/schemas/Pet', description: 'Not adopted yet.', ...beside };
          expect(await entryOf(openapi, key, dangling)).toEqual({ ...code, ...text });
          expect(warn.mock.calls.map(([message]) => message)).toEqual([unresolvedWarning(key)]);
        });

        it(`gives the ${key} of an OAS ${openapi} document no body and no headers beside a malformed $ref`, async () => {
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const malformed = { $ref: 42, description: 'Not adopted yet.', ...beside };
          expect(await entryOf(openapi, key, malformed)).toEqual({ ...code, ...text });
          expect(warn.mock.calls.map(([message]) => message)).toEqual([malformedWarning(key)]);
        });

        it(`reads the ${key} of an OAS ${openapi} document from the component beside a ref that resolves`, async () => {
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const resolving = { $ref: '#/components/responses/PetMissing', ...beside };
          expect(await entryOf(openapi, key, resolving)).toEqual({ ...code, description: 'Missing.' });
          expect(warn).not.toHaveBeenCalled();
        });
      }
    }
  });
});
