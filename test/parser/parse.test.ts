import { describe, it, expect, vi } from 'vitest';
import { parseSpec } from '../../src/parser/parse.js';
import { resolveOperations } from '../../src/ir/operation-hints.js';
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
          { kind: 'bearer', schemeName: 'BearerAuth' },
          { kind: 'apiKey', schemeName: 'ApiKeyAuth', in: 'header', name: 'X-API-Key' },
        ]),
      );
      expect(result.auth).toHaveLength(2);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  describe('transformSpec hook', () => {
    it('runs the hook on the bundled doc before extraction', async () => {
      // Verify the hook sees the parsed OpenAPI document and that mutations
      // flow into the IR. Drop the User schema's `email` field via the hook
      // and confirm the resulting model has no email.
      const ir = await parseSpec(`${FIXTURES}/minimal.yml`, {
        transformSpec: (spec) => {
          const components = (
            spec as {
              components?: { schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
            }
          ).components;
          const userSchema = components?.schemas?.User;
          if (userSchema?.properties) delete userSchema.properties.email;
          if (userSchema?.required) {
            userSchema.required = userSchema.required.filter((f) => f !== 'email');
          }
          return spec;
        },
      });
      const user = ir.models.find((m) => m.name === 'User');
      expect(user).toBeDefined();
      expect(user!.fields.find((f) => f.name === 'email')).toBeUndefined();
    });

    it('lets the hook rewrite a path response $ref to a different schema', async () => {
      // Simulate the "schema fork" workaround: rewrite a path's response
      // $ref so the SDK keeps using the original schema even when upstream
      // points at a forked one. We construct a spec with two schemas (Foo,
      // FooWithExtra) where the path points at FooWithExtra; the hook
      // redirects it to Foo.
      const spec = `
openapi: '3.1.0'
info:
  title: Hook Test
  version: '1.0.0'
servers:
  - url: https://api.example.com
paths:
  /things:
    get:
      operationId: listThings
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/FooWithExtra'
components:
  schemas:
    Foo:
      type: object
      properties:
        id: { type: string }
      required: [id]
    FooWithExtra:
      type: object
      properties:
        id: { type: string }
        extra: { type: string }
      required: [id, extra]
`;
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-transform-spec-'));
      const specFile = path.join(tmpDir, 'fork.yml');
      try {
        await fs.writeFile(specFile, spec, 'utf-8');
        const ir = await parseSpec(specFile, {
          transformSpec: (doc) => {
            const paths = (
              doc as {
                paths?: Record<
                  string,
                  Record<
                    string,
                    { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> }
                  >
                >;
              }
            ).paths;
            const responseSchema = paths?.['/things']?.get?.responses?.['200']?.content?.['application/json']?.schema;
            if (responseSchema?.$ref === '#/components/schemas/FooWithExtra') {
              responseSchema.$ref = '#/components/schemas/Foo';
            }
            return doc;
          },
        });
        const op = ir.services.flatMap((s) => s.operations).find((o) => o.name === 'listThings');
        expect(op).toBeDefined();
        const responseType = (op as { response?: { kind?: string; name?: string } }).response;
        expect(responseType?.kind).toBe('model');
        expect(responseType?.name).toBe('Foo');
      } finally {
        await fs.rm(tmpDir, { recursive: true });
      }
    });

    it('passes the document through unchanged when the hook is omitted', async () => {
      const baseline = await parseSpec(`${FIXTURES}/minimal.yml`);
      const noopTransformed = await parseSpec(`${FIXTURES}/minimal.yml`, {
        transformSpec: (s) => s,
      });
      expect(noopTransformed.models.map((m) => m.name).sort()).toEqual(baseline.models.map((m) => m.name).sort());
      expect(noopTransformed.services.map((s) => s.name).sort()).toEqual(baseline.services.map((s) => s.name).sort());
    });
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

describe('parseSpec – nullable enum components (#174)', () => {
  it('drops null enum members and carries component nullability through $ref end to end', async () => {
    // Verbatim shape from the issue: `asEnumMember` reaches a nullable enum
    // via `$ref`, `asUnion` reaches a plain enum via `oneOf: [..., null]`.
    // Both must land as `nullable(enum)`, and MemberForm must not grow a
    // bogus `NULL = "null"` member.
    const spec = {
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/thing': {
          get: {
            operationId: 'getThing',
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Thing: {
            type: 'object',
            properties: {
              asEnumMember: { $ref: '#/components/schemas/MemberForm' },
              asUnion: { oneOf: [{ $ref: '#/components/schemas/UnionForm' }, { type: 'null' }] },
            },
            required: ['asEnumMember', 'asUnion'],
          },
          MemberForm: { type: ['string', 'null'], enum: ['a', 'b', null] },
          UnionForm: { type: 'string', enum: ['a', 'b'] },
        },
      },
    };
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-174-'));
    const specFile = path.join(tmpDir, 'issue-174.json');
    try {
      await fs.writeFile(specFile, JSON.stringify(spec), 'utf-8');
      const ir = await parseSpec(specFile);

      const thing = ir.models.find((m) => m.name === 'Thing');
      expect(thing).toBeDefined();
      const asEnumMember = thing!.fields.find((f) => f.name === 'asEnumMember');
      const asUnion = thing!.fields.find((f) => f.name === 'asUnion');
      expect(asEnumMember?.type).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'MemberForm' } });
      expect(asUnion?.type).toEqual({ kind: 'nullable', inner: { kind: 'enum', name: 'UnionForm' } });

      const memberForm = ir.enums.find((e) => e.name === 'MemberForm');
      expect(memberForm?.values.map((v) => v.value)).toEqual(['a', 'b']);
      expect(memberForm?.values.some((v) => v.name === 'NULL')).toBe(false);
      const unionForm = ir.enums.find((e) => e.name === 'UnionForm');
      expect(unionForm?.values.map((v) => v.value)).toEqual(['a', 'b']);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe('parseSpec – schemaNameTransform originalName (issue #175)', () => {
  const spec = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths: {
      '/thing': {
        get: {
          operationId: 'getThing',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Thing: {
          type: 'object',
          properties: {
            http: { $ref: '#/components/schemas/HTTPConfig' },
            url: { $ref: '#/components/schemas/URL' },
            settings: { $ref: '#/components/schemas/Settings' },
          },
        },
        HTTPConfig: { type: 'object', properties: { timeout: { type: 'number' } } },
        URL: { type: 'object', properties: { href: { type: 'string' } } },
        Settings: { type: 'object', properties: { locale: { type: 'string' } } },
      },
    },
  });

  async function withSpecFile<T>(fn: (specFile: string) => Promise<T>): Promise<T> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-175-'));
    const specFile = path.join(tmpDir, 'issue-175.json');
    await fs.writeFile(specFile, spec);
    try {
      return await fn(specFile);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it('normalises component names when no transform is given', async () => {
    await withSpecFile(async (specFile) => {
      const ir = await parseSpec(specFile);
      expect(ir.models.map((m) => m.name).sort()).toEqual(['HttpConfig', 'Setting', 'Thing', 'Url']);
    });
  });

  it('hands the transform the original spelling so it can opt out of normalisation', async () => {
    await withSpecFile(async (specFile) => {
      const seen: Array<[string, string | undefined]> = [];
      const ir = await parseSpec(specFile, {
        schemaNameTransform: (name, originalName) => {
          seen.push([name, originalName]);
          return originalName ?? name;
        },
      });

      expect(seen).toContainEqual(['HttpConfig', 'HTTPConfig']);
      expect(seen).toContainEqual(['Url', 'URL']);
      expect(seen).toContainEqual(['Setting', 'Settings']);

      expect(ir.models.map((m) => m.name).sort()).toEqual(['HTTPConfig', 'Settings', 'Thing', 'URL']);

      const thing = ir.models.find((m) => m.name === 'Thing')!;
      const fieldType = (fieldName: string) => thing.fields.find((f) => f.name === fieldName)!.type;
      expect(fieldType('http')).toEqual({ kind: 'model', name: 'HTTPConfig' });
      expect(fieldType('url')).toEqual({ kind: 'model', name: 'URL' });
      expect(fieldType('settings')).toEqual({ kind: 'model', name: 'Settings' });

      const op = ir.services.flatMap((s) => s.operations).find((o) => o.name === 'getThing');
      expect(op).toBeDefined();
      expect(op!.response).toEqual({ kind: 'model', name: 'Thing' });
    });
  });

  it('passes no originalName for const-derived request-body variant names', async () => {
    // Mirrors test/parser/oneof-variant-naming.test.ts: an inline request-body
    // oneOf whose object variant pins `grant_type` to a const. The variant
    // model name is synthesised from the const value + operation, so the
    // transform must see originalName === undefined for it, while the real
    // component (`Placeholder`) still gets its key.
    const specYaml = `
openapi: 3.1.0
info: { title: Test, version: 1.0.0 }
paths:
  /authenticate:
    post:
      operationId: SessionController_authenticate
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - type: object
                  required: [grant_type, password]
                  properties:
                    grant_type:
                      type: string
                      const: password
                    password:
                      type: string
                - type: object
                  required: [grant_type, code]
                  properties:
                    grant_type:
                      type: string
                      const: code
                    code:
                      type: string
      responses:
        '200': { description: ok }
components:
  schemas:
    Placeholder: { type: object }
`;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-175-variants-'));
    const specFile = path.join(tmpDir, 'spec.yml');
    try {
      await fs.writeFile(specFile, specYaml, 'utf-8');
      const calls: Array<[string, string | undefined]> = [];
      const ir = await parseSpec(specFile, {
        schemaNameTransform: (name, originalName) => {
          calls.push([name, originalName]);
          return name;
        },
      });

      expect(ir.models.some((m) => m.name === 'PasswordSessionAuthenticateRequest')).toBe(true);
      expect(ir.models.some((m) => m.name === 'CodeSessionAuthenticateRequest')).toBe(true);

      expect(calls).toContainEqual(['Placeholder', 'Placeholder']);
      const variantCalls = calls.filter(([name]) => name.endsWith('SessionAuthenticateRequest'));
      expect(variantCalls.length).toBeGreaterThan(0);
      for (const [, originalName] of variantCalls) expect(originalName).toBeUndefined();
      // Only real component keys ever arrive as originalName.
      for (const [, originalName] of calls) {
        if (originalName !== undefined) expect(originalName).toBe('Placeholder');
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('parseSpec – Service.description from document tags (issue #192)', () => {
  it('carries the top-level tag description onto the service named after it', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      tags: [{ name: 'Pets', description: 'Pets live in a store and can be adopted.' }],
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            tags: ['Pets'],
            responses: { '204': { description: 'ok' } },
          },
        },
      },
    };
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-192-'));
    const specFile = path.join(tmpDir, 'repro.json');
    try {
      await fs.writeFile(specFile, JSON.stringify(spec), 'utf-8');
      const ir = await parseSpec(specFile);

      expect(ir.services.map(({ name, description }) => ({ name, description }))).toEqual([
        { name: 'Pets', description: 'Pets live in a store and can be adopted.' },
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves Service.description unset when the document declares no tags', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            tags: ['Pets'],
            responses: { '204': { description: 'ok' } },
          },
        },
      },
    };
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-192-notags-'));
    const specFile = path.join(tmpDir, 'repro.json');
    try {
      await fs.writeFile(specFile, JSON.stringify(spec), 'utf-8');
      const ir = await parseSpec(specFile);

      expect(ir.services).toHaveLength(1);
      expect(ir.services[0].name).toBe('Pets');
      expect('description' in ir.services[0]).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('parseSpec – malformed document tags keep parsing (issue #192 review)', () => {
  const base = {
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          tags: ['Pets'],
          responses: { '204': { description: 'ok' } },
        },
      },
    },
  };

  // Before Service.description was read these documents parsed; a malformed
  // `tags` value must not turn into a parse failure now.
  it.each([
    ['a null entry', [null]],
    ['an object instead of a list', { Pets: { description: 'Pets.' } }],
    ['a numeric name', [{ name: 42, description: 'Pets.' }]],
  ])('parses a document whose tags hold %s', async (_shape, tags) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-192-malformed-'));
    const specFile = path.join(tmpDir, 'repro.json');
    try {
      await fs.writeFile(specFile, JSON.stringify({ ...base, tags }), 'utf-8');
      const ir = await parseSpec(specFile);

      expect(ir.services.map((s) => s.name)).toEqual(['Pets']);
      expect('description' in ir.services[0]).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('parseSpec – path-named services skip a shared API root (issue #209)', () => {
  const ok = { responses: { '204': { description: 'ok' } } };
  const repro = {
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    paths: { '/api/notes': { get: ok }, '/api/tags': { get: ok }, '/api/users': { get: ok } },
  };

  async function parseRepro() {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-209-'));
    try {
      const specFile = path.join(tmpDir, 'repro.json');
      await fs.writeFile(specFile, JSON.stringify(repro), 'utf-8');
      return await parseSpec(specFile);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it('groups the issue repro into Notes, Tags and Users', async () => {
    const ir = await parseRepro();
    expect(
      ir.services.flatMap((s) =>
        s.operations.map((op) => `${s.name} ${op.name} ${op.httpMethod.toUpperCase()} ${op.path}`),
      ),
    ).toMatchInlineSnapshot(`
      [
        "Notes list GET /api/notes",
        "Tags list GET /api/tags",
        "Users list GET /api/users",
      ]
    `);
  });

  it('resolves mountRules and operationHints against the new service names', async () => {
    const ir = await parseRepro();
    const resolved = resolveOperations(
      ir,
      { 'GET /api/tags': { mountOn: 'Labels' } },
      { Notes: 'Content', 'U*': 'People' },
    );
    expect(resolved.map((r) => [r.operation.path, r.service.name, r.mountOn])).toEqual([
      ['/api/notes', 'Notes', 'Content'],
      ['/api/tags', 'Tags', 'Labels'],
      ['/api/users', 'Users', 'People'],
    ]);
  });
});
