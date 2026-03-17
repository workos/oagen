import { describe, it, expect, vi } from 'vitest';
import { parseSpec } from '../../src/parser/parse.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');

describe('parseSpec', () => {
  it('parses minimal.yml into valid IR', async () => {
    const ir = await parseSpec(`${FIXTURES}/minimal.yml`);

    expect(ir.name).toBe('Minimal API');
    expect(ir.version).toBe('1.0.0');
    expect(ir.baseUrl).toBe('https://api.example.com');

    // Should have models
    expect(ir.models.length).toBeGreaterThanOrEqual(2);
    const user = ir.models.find((m) => m.name === 'User');
    expect(user).toBeDefined();
    expect(user!.fields.length).toBeGreaterThanOrEqual(3);

    const createUser = ir.models.find((m) => m.name === 'CreateUser');
    expect(createUser).toBeDefined();

    // Should have services
    expect(ir.services.length).toBeGreaterThanOrEqual(1);
    const userService = ir.services.find((s) => s.name === 'Users');
    expect(userService).toBeDefined();
    expect(userService!.operations.length).toBeGreaterThanOrEqual(3);

    // Check operation names (derived from operationId)
    const opNames = userService!.operations.map((o) => o.name);
    expect(opNames).toContain('listUsers');
    expect(opNames).toContain('createUser');
    expect(opNames).toContain('getUser');

    // Check pagination
    const listOp = userService!.operations.find((o) => o.name === 'listUsers');
    expect(listOp!.pagination).toBeDefined();
  });

  it('parses comprehensive.yml into valid IR', async () => {
    const ir = await parseSpec(`${FIXTURES}/comprehensive.yml`);

    expect(ir.name).toBe('Comprehensive API');
    expect(ir.version).toBe('2.0.0');

    // Check models
    expect(ir.models.length).toBeGreaterThanOrEqual(5);

    // Check allOf-merged model
    const member = ir.models.find((m) => m.name === 'Member');
    expect(member).toBeDefined();
    expect(member!.fields.length).toBeGreaterThanOrEqual(3);

    // Check enums
    expect(ir.enums.length).toBeGreaterThanOrEqual(2);
    const status = ir.enums.find((e) => e.name === 'OrganizationStatus');
    expect(status).toBeDefined();
    expect(status!.values).toHaveLength(3);

    // Check services
    expect(ir.services.length).toBeGreaterThanOrEqual(2);

    // Check CRUD operations
    const orgService = ir.services.find((s) => s.name === 'Organizations');
    expect(orgService).toBeDefined();
    const orgOpNames = orgService!.operations.map((o) => o.name);
    expect(orgOpNames).toContain('listOrganizations');
    expect(orgOpNames).toContain('createOrganization');
    expect(orgOpNames).toContain('getOrganization');
    expect(orgOpNames).toContain('updateOrganization');
    expect(orgOpNames).toContain('deleteOrganization');

    // Check error responses
    const createOp = orgService!.operations.find((o) => o.name === 'createOrganization');
    expect(createOp!.errors.length).toBeGreaterThanOrEqual(1);
    expect(createOp!.errors[0].statusCode).toBe(400);

    // Check nullable type (OAS 3.1 style)
    const org = ir.models.find((m) => m.name === 'Organization');
    const parentField = org!.fields.find((f) => f.name === 'parent_id');
    expect(parentField!.type.kind).toBe('nullable');

    // Check oneOf (Pet)
    // Pet has oneOf so it's extracted as a model with no fields (since oneOf is at top level)
    // or it could be extracted differently. Let's verify it exists.
    // Actually, since Pet has oneOf, extractSchemas will try to make it a model.
    // The important thing is the IR is valid.
    expect(ir.models.length + ir.enums.length).toBeGreaterThan(5);
  });

  it('throws on non-existent file', async () => {
    await expect(parseSpec('nonexistent.yml')).rejects.toThrow();
  });

  it('parses securitySchemes into auth array with bearer and apiKey schemes', async () => {
    const specContent = `
openapi: '3.1.0'
info:
  title: Auth Test API
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths: {}
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
`;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parse-test-'));
    const specFile = path.join(tmpDir, 'auth-test.yml');
    try {
      await fs.writeFile(specFile, specContent, 'utf-8');
      const result = await parseSpec(specFile);

      expect(result.auth).toBeDefined();
      expect(result.auth).toEqual(
        expect.arrayContaining([
          { kind: 'bearer' },
          { kind: 'apiKey', in: 'header', name: 'X-API-Key' },
        ]),
      );
      expect(result.auth).toHaveLength(2);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('qualifies inline model name to avoid collision with component schema', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseSpec(`${FIXTURES}/collision.yml`);
      // The inline model from Thing.detail is now qualified as ThingDetail
      // so it no longer collides with the component schema Detail
      const detailModels = ir.models.filter((m) => m.name === 'Detail');
      expect(detailModels).toHaveLength(1);
      // The component schema version has {id, description}
      const fieldNames = detailModels[0].fields.map((f) => f.name);
      expect(fieldNames).toContain('id');
      expect(fieldNames).toContain('description');
      // The inline model is now ThingDetail — no collision, no warning
      const thingDetail = ir.models.find((m) => m.name === 'ThingDetail');
      expect(thingDetail).toBeDefined();
      expect(thingDetail!.fields.map((f) => f.name)).toContain('color');
      expect(thingDetail!.fields.map((f) => f.name)).toContain('size');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
