import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Field } from '../../src/ir/types.js';

/**
 * End-to-end coverage for the `$ref`-target example fallback on response
 * fields (PR #198 review): a response field such as
 * `category: { $ref: '#/components/schemas/Category' }` takes the component's
 * `example`/`examples` exactly as a request-body or component-model field
 * does, through every later parse pass, including nested inline objects and
 * list-envelope companions.
 */
describe('parseSpec — response fields take example/examples from a referenced component', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parse-field-examples-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  const projected = (fields: Field[]) => fields.map(({ name, example, examples }) => ({ name, example, examples }));
  const components = {
    Category: { type: 'string', enum: ['dog', 'cat'], examples: ['dog', 'cat'] },
    Direction: { type: 'string', enum: ['asc', 'desc'], example: 'asc' },
  };
  const ok = (schema: unknown) => ({ '200': { description: 'ok', content: { 'application/json': { schema } } } });
  const modelRef = (field: Field | undefined): string => {
    expect(field?.type.kind).toBe('model');
    return (field!.type as { kind: 'model'; name: string }).name;
  };

  it('reaches an inline response object and the inline objects nested under it', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets/{id}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: ok({
              type: 'object',
              properties: {
                id: { type: 'string' },
                category: { $ref: '#/components/schemas/Category' },
                direction: { $ref: '#/components/schemas/Direction' },
                owner: {
                  type: 'object',
                  properties: { preference: { $ref: '#/components/schemas/Category' } },
                },
              },
              required: ['id'],
            }),
          },
        },
      },
      components: { schemas: components },
    });

    const [operation] = ir.services.flatMap((s) => s.operations);
    expect(operation.response.kind).toBe('model');
    const response = ir.models.find((m) => m.name === (operation.response as { name: string }).name)!;
    expect(projected(response.fields)).toEqual([
      { name: 'id', example: undefined, examples: undefined },
      { name: 'category', example: 'dog', examples: ['dog', 'cat'] },
      { name: 'direction', example: 'asc', examples: undefined },
      { name: 'owner', example: undefined, examples: undefined },
    ]);
    expect(response.fields[2]).not.toHaveProperty('examples');

    const owner = ir.models.find((m) => m.name === modelRef(response.fields[3]))!;
    expect(projected(owner.fields)).toEqual([{ name: 'preference', example: 'dog', examples: ['dog', 'cat'] }]);
  });

  it('reaches a list-envelope companion field and the companion model it references', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
            responses: ok({
              type: 'object',
              properties: {
                data: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
                sort: { $ref: '#/components/schemas/Direction' },
                list_metadata: {
                  type: 'object',
                  properties: {
                    after: { type: ['string', 'null'] },
                    order: { $ref: '#/components/schemas/Direction' },
                    kinds: { $ref: '#/components/schemas/Category' },
                  },
                },
              },
              required: ['data', 'list_metadata'],
            }),
          },
        },
      },
      components: {
        schemas: { ...components, Pet: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    });

    const [operation] = ir.services.flatMap((s) => s.operations);
    const envelopeFields = operation.pagination?.envelopeFields ?? [];
    expect(projected(envelopeFields)).toEqual([
      { name: 'sort', example: 'asc', examples: undefined },
      { name: 'list_metadata', example: undefined, examples: undefined },
    ]);

    const metadata = ir.models.find((m) => m.name === modelRef(envelopeFields[1]))!;
    expect(projected(metadata.fields)).toEqual([
      { name: 'after', example: undefined, examples: undefined },
      { name: 'order', example: 'asc', examples: undefined },
      { name: 'kinds', example: 'dog', examples: ['dog', 'cat'] },
    ]);
  });
});
