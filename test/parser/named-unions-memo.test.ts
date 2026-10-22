import { describe, it, expect, vi } from 'vitest';
import { parseSpec } from '../../src/parser/parse.js';
import { schemaShapeKey } from '../../src/parser/inline-models.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Count how often the parser hashes a schema's shape while planning the
// named unions of a document: each union's plan claims every component's
// shape and every other union's variants', and the model and the extractor
// both read the plan, so without a memo a document with U unions among N
// components hashes each component 2U times.
vi.mock('../../src/parser/inline-models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/parser/inline-models.js')>();
  return { ...actual, schemaShapeKey: vi.fn(actual.schemaShapeKey) };
});

async function parseInline(specYaml: string) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-named-unions-memo-'));
  const specFile = path.join(tmpDir, 'spec.yml');
  try {
    await fs.writeFile(specFile, specYaml, 'utf-8');
    return await parseSpec(specFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
}

const plain = (name: string) => `
    ${name}:
      type: object
      properties:
        id: { type: string }`;
const union = (name: string, ref: string) => `
    ${name}:
      oneOf:
        - $ref: '#/components/schemas/${ref}'
        - type: object
          properties:
            kind: { const: a }
            a: { type: string }
        - type: object
          properties:
            kind: { const: b }
            b: { type: string }`;

const spec = `
openapi: 3.1.0
info: { title: Test, version: 1.0.0 }
paths:
  /pets:
    get:
      operationId: getPet
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Union0' }
components:
  schemas:${plain('Plain0')}${plain('Plain1')}${plain('Plain2')}${union('Union0', 'Plain0')}${union('Union1', 'Plain1')}${union('Union2', 'Plain2')}
`;

describe('named unions: the plans of a document are computed once per extraction', () => {
  it('hashes each component and each inline variant at most once while planning every union', async () => {
    const hashed = vi.mocked(schemaShapeKey);
    hashed.mockClear();
    const ir = await parseInline(spec);

    // The plans are right: three unions, each with its two variant models.
    for (const i of [0, 1, 2]) {
      const u = ir.models.find((m) => m.name === `Union${i}`);
      expect(u?.variants).toEqual([
        { kind: 'model', name: `Plain${i}` },
        { kind: 'model', name: `AUnion${i}` },
        { kind: 'model', name: `BUnion${i}` },
      ]);
    }
    // Six components and six inline variants: nothing is hashed twice. Without
    // the memo this is 96 (each of 3 unions planned twice, each plan hashing
    // 6 components, 4 other variants and its own 2 variants twice over).
    const distinct = new Set(hashed.mock.calls.map(([schema]) => schema)).size;
    expect(distinct).toBe(12);
    expect(hashed.mock.calls.length).toBe(distinct);
  });

  it('does not keep a plan from one document for the next', async () => {
    const hashed = vi.mocked(schemaShapeKey);
    hashed.mockClear();
    await parseInline(spec);
    const first = hashed.mock.calls.length;
    hashed.mockClear();
    const ir = await parseInline(
      spec.replace(
        'kind: { const: a }\n            a: { type: string }',
        'kind: { const: a }\n            z: { type: string }',
      ),
    );
    // The second document is planned afresh (its objects are new), and read
    // from its own content: the first variant's model carries `z` now.
    expect(hashed.mock.calls.length).toBe(first);
    expect(ir.models.find((m) => m.name === 'AUnion0')?.fields.map((f) => f.name)).toEqual(['kind', 'z']);
  });
});
