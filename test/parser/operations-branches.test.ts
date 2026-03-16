import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';

describe('operations — method inference branches', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-ops-branch-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('infers create/update/delete when no operationId is set', async () => {
    // Lines 109-121: post→create, put→update, patch→update, delete→delete
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths:
  /items:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
  /items/{item_id}:
    put:
      parameters:
        - name: item_id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
    patch:
      parameters:
        - name: item_id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
    delete:
      parameters:
        - name: item_id
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Deleted
`;
    const specPath = resolve(tmpDir, 'no-opid.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    const opNames = result.services.flatMap((s) => s.operations).map((o) => o.name);

    expect(opNames).toContain('create');
    expect(opNames).toContain('delete');
    // put and patch both infer 'update'
    expect(opNames.filter((n) => n === 'update').length).toBe(2);
  });

  it('handles parameters without explicit schema', async () => {
    // Line 167: param.schema is undefined → fallback to primitive string
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths:
  /search:
    get:
      parameters:
        - name: q
          in: query
          required: true
        - name: page
          in: query
          schema:
            type: integer
      responses:
        '200':
          description: Results
          content:
            application/json:
              schema:
                type: object
                properties:
                  results:
                    type: array
                    items:
                      type: string
`;
    const specPath = resolve(tmpDir, 'no-schema-param.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    const searchOp = result.services.flatMap((s) => s.operations).find((o) => o.name === 'list');
    expect(searchOp).toBeDefined();
    const qParam = searchOp!.queryParams.find((p) => p.name === 'q');
    expect(qParam).toBeDefined();
    expect(qParam!.type).toEqual({ kind: 'primitive', type: 'string' });
  });
});
