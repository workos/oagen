import { describe, it, expect } from 'vitest';
import { resolveResponseRef } from '../../src/parser/response-refs.js';

type Response = { description?: string; content?: Record<string, unknown> };

const problem: Response = { description: 'A problem', content: { 'application/json': { schema: { type: 'object' } } } };

describe('resolveResponseRef', () => {
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

  it('throws on a ref no component response answers, naming the ref and the context', () => {
    expect(() =>
      resolveResponseRef({ $ref: '#/components/responses/Missing' }, { Problem: problem }, 'default of op'),
    ).toThrow(
      'Unresolved response $ref "#/components/responses/Missing" in default of op: no matching entry under components/responses.',
    );
    expect(() => resolveResponseRef({ $ref: '#/components/responses/Problem' }, undefined, 'ctx')).toThrow(
      'Unresolved response $ref',
    );
  });

  it('does not resolve a ref into another section off a same-named response', () => {
    expect(() => resolveResponseRef({ $ref: '#/components/schemas/Problem' }, { Problem: problem }, 'ctx')).toThrow(
      'Unresolved response $ref "#/components/schemas/Problem"',
    );
  });

  it('throws on a circular chain instead of looping', () => {
    const components = { A: { $ref: '#/components/responses/B' }, B: { $ref: '#/components/responses/A' } };
    expect(() => resolveResponseRef({ $ref: '#/components/responses/A' }, components, 'ctx')).toThrow(
      'Circular response $ref chain starting at "#/components/responses/A" in ctx.',
    );
  });
});
