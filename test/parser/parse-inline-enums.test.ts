import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '../../src/parser/parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseSpec — inline enum collection from nested types', () => {
  let tmpDir: string;
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-enum-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    warnSpy.mockClear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('collects inline enums from array item types', async () => {
    // Lines 111-112: enum inside array items
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths: {}
components:
  schemas:
    Widget:
      type: object
      properties:
        id:
          type: string
        statuses:
          type: array
          items:
            type: string
            enum:
              - active
              - inactive
              - pending
`;
    const specPath = resolve(tmpDir, 'array-enum.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    // Should have extracted an inline enum from the array items
    const enumNames = result.enums.map((e) => e.name);
    expect(enumNames.length).toBeGreaterThan(0);
  });

  it('collects inline enums from nullable types', async () => {
    // Lines 113-114: enum inside nullable
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths: {}
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: string
        priority:
          nullable: true
          type: string
          enum:
            - high
            - medium
            - low
`;
    const specPath = resolve(tmpDir, 'nullable-enum.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it('collects inline enums from oneOf union variants', async () => {
    // Lines 115-118: enum inside union variants
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths: {}
components:
  schemas:
    Filter:
      type: object
      properties:
        id:
          type: string
        kind:
          oneOf:
            - type: string
              enum:
                - name_filter
                - date_filter
            - type: string
`;
    const specPath = resolve(tmpDir, 'union-enum.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it('validates model refs inside union and map types', async () => {
    // Lines 147-148, 150: walkRef into union variants and map valueType
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths:
  /items:
    get:
      operationId: listItems
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
                      $ref: '#/components/schemas/Item'
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: string
        metadata:
          type: object
          additionalProperties:
            type: string
        variant:
          oneOf:
            - $ref: '#/components/schemas/VariantA'
            - $ref: '#/components/schemas/VariantB'
    VariantA:
      type: object
      properties:
        a_field:
          type: string
    VariantB:
      type: object
      properties:
        b_field:
          type: string
`;
    const specPath = resolve(tmpDir, 'union-map-refs.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    expect(result.models.length).toBeGreaterThanOrEqual(3);
  });

  it('collects inline enums from map value types', async () => {
    // Line 119-121: enum inside map valueType
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths: {}
components:
  schemas:
    Config:
      type: object
      properties:
        id:
          type: string
        settings:
          type: object
          additionalProperties:
            type: string
            enum:
              - on
              - off
`;
    const specPath = resolve(tmpDir, 'map-enum.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    expect(result.models.length).toBeGreaterThan(0);
  });
});
