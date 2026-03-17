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

  it('disambiguates colliding operation names across different sub-resources', async () => {
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths:
  /user_management/users:
    get:
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
                      $ref: '#/components/schemas/User'
                  list_metadata:
                    type: object
                    properties:
                      after:
                        type: string
  /user_management/invitations:
    get:
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
                      $ref: '#/components/schemas/Invitation'
                  list_metadata:
                    type: object
                    properties:
                      after:
                        type: string
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                email:
                  type: string
              required:
                - email
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Invitation'
  /user_management/users/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
    delete:
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Deleted
  /user_management/users/{userId}/auth_factors:
    get:
      parameters:
        - name: userId
          in: path
          required: true
          schema:
            type: string
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
                      $ref: '#/components/schemas/AuthFactor'
                  list_metadata:
                    type: object
                    properties:
                      after:
                        type: string
  /user_management/organization_memberships:
    get:
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
                      $ref: '#/components/schemas/OrgMembership'
                  list_metadata:
                    type: object
                    properties:
                      after:
                        type: string
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: string
        email:
          type: string
    Invitation:
      type: object
      properties:
        id:
          type: string
        email:
          type: string
    AuthFactor:
      type: object
      properties:
        id:
          type: string
        type:
          type: string
    OrgMembership:
      type: object
      properties:
        id:
          type: string
`;
    const specPath = resolve(tmpDir, 'disambiguate.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    const um = result.services.find((s) => s.name === 'UserManagement');
    expect(um).toBeDefined();
    const opNames = um!.operations.map((o) => o.name);

    // Each list operation should have a unique name
    expect(opNames).toContain('listUsers');
    expect(opNames).toContain('listInvitations');
    expect(opNames).toContain('listAuthFactors');
    expect(opNames).toContain('listOrganizationMemberships');

    // Non-list operations should also be unique
    expect(opNames).toContain('getUsers');
    expect(opNames).toContain('deleteUsers');
    expect(opNames).toContain('createInvitations');

    // No bare "list" should remain (all were disambiguated)
    expect(opNames).not.toContain('list');
  });

  it('does not disambiguate same-path different-method operations', async () => {
    // PUT and PATCH on the same path should both be "update"
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths:
  /widgets/{id}:
    put:
      parameters:
        - name: id
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
        - name: id
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
`;
    const specPath = resolve(tmpDir, 'same-path.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    const opNames = result.services.flatMap((s) => s.operations).map((o) => o.name);
    // Both should remain "update" since they operate on the same resource
    expect(opNames.filter((n) => n === 'update').length).toBe(2);
  });

  it('keeps unique names unchanged even when other operations collide', async () => {
    const specContent = `
openapi: '3.1.0'
info:
  title: Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths:
  /things:
    get:
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
                  list_metadata:
                    type: object
                    properties:
                      after:
                        type: string
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
`;
    const specPath = resolve(tmpDir, 'unique.yml');
    writeFileSync(specPath, specContent);

    const result = await parseSpec(specPath);
    const opNames = result.services.flatMap((s) => s.operations).map((o) => o.name);
    // Only one "list" and one "create" — no collision, should stay as-is
    expect(opNames).toContain('list');
    expect(opNames).toContain('create');
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
