import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';

describe('responses — nested inline array objects', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-resp-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts inline models from response object fields that are arrays of objects', async () => {
    // Lines 242-244 in responses.ts: array items that are inline objects
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths:
  /orders:
    get:
      operationId: listOrders
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      type: object
                      properties:
                        id:
                          type: string
                        items:
                          type: array
                          items:
                            type: object
                            properties:
                              product_id:
                                type: string
                              quantity:
                                type: integer
`;
    const specPath = resolve(tmpDir, 'nested-array.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    // Should find inline models for the nested objects
    expect(result.models.length).toBeGreaterThan(0);
  });
});
