import { describe, it, expect } from 'vitest';
import { parseSpec } from '../../src/parser/parse.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Helper: write a spec to a temp file, parse it, return the IR. Cleans up
 * the temp dir on completion.
 */
async function parseInline<T>(specYaml: string, fn: (ir: Awaited<ReturnType<typeof parseSpec>>) => T): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-oneof-naming-'));
  const specFile = path.join(tmpDir, 'spec.yml');
  try {
    await fs.writeFile(specFile, specYaml, 'utf-8');
    const ir = await parseSpec(specFile);
    return fn(ir);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
}

describe('oneOf variant naming', () => {
  it('derives names from a const-property discriminator instead of using a numeric suffix', async () => {
    // Mirrors the workos/openapi-spec ApiKey.owner shape: an inline oneOf
    // whose object variants pin the same `type` property to distinct const
    // values (`organization`, `user`). Without the const-naming pass the
    // emitter would produce `ApiKeyOwner` and `ApiKeyOwner2` — informative
    // for a robot, opaque for a human reading the generated SDK. With the
    // pass it produces `ApiKeyOwner` (the first variant, kept as the bare
    // parent name so the union TypeRef's degenerate-collapse target stays
    // valid) and `UserApiKeyOwner` (the second variant, named after its
    // discriminator value).
    await parseInline(
      `
openapi: 3.1.0
info:
  title: Test
  version: 1.0.0
servers:
  - url: https://api.example.com
paths:
  /api_keys/{id}:
    get:
      operationId: getApiKey
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ApiKey'
components:
  schemas:
    ApiKey:
      type: object
      required: [object, id, owner]
      properties:
        object: { type: string, const: api_key }
        id: { type: string }
        owner:
          oneOf:
            - type: object
              required: [type, id]
              properties:
                type: { type: string, const: organization }
                id: { type: string }
            - type: object
              required: [type, id, organization_id]
              properties:
                type: { type: string, const: user }
                id: { type: string }
                organization_id: { type: string }
`,
      (ir) => {
        const ownerModels = ir.models.filter((m) => m.name.endsWith('ApiKeyOwner'));
        const ownerNames = ir.models.map((m) => m.name).filter((n) => n.toLowerCase().includes('apikeyowner'));

        // First variant keeps the parent name so the union TypeRef has a
        // valid collapse target.
        expect(ownerNames).toContain('ApiKeyOwner');
        // Second variant gets a const-derived prefix instead of a `2` suffix.
        expect(ownerNames).toContain('UserApiKeyOwner');
        expect(ownerNames).not.toContain('ApiKeyOwner2');
        expect(ownerModels.length).toBeGreaterThanOrEqual(1);
      },
    );
  });

  it('falls back to numeric suffix when no shared const property distinguishes the variants', async () => {
    // No discriminator-style property — variants differ structurally
    // (different field sets) but neither has a `const` value pinning a
    // shared property. Numeric-suffix scheme remains the safe fallback.
    await parseInline(
      `
openapi: 3.1.0
info: { title: Test, version: 1.0.0 }
servers: [{ url: https://api.example.com }]
paths:
  /thing:
    get:
      operationId: getThing
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Thing'
components:
  schemas:
    Thing:
      type: object
      required: [data]
      properties:
        data:
          oneOf:
            - type: object
              required: [a]
              properties:
                a: { type: string }
            - type: object
              required: [b]
              properties:
                b: { type: integer }
`,
      (ir) => {
        const dataModels = ir.models.filter((m) => m.name.startsWith('ThingData'));
        const names = dataModels.map((m) => m.name);
        expect(names).toContain('ThingData');
        // Second variant has no discriminator, so falls back to numeric suffix.
        expect(names).toContain('ThingData2');
      },
    );
  });

  it('falls back to numeric suffix when two variants have identical const values on the same property', async () => {
    // The const-naming heuristic requires distinct values per variant — if
    // two variants both pin `type: organization`, naming both
    // `OrganizationApiKeyOwner` would collide. Numeric suffix is safer.
    await parseInline(
      `
openapi: 3.1.0
info: { title: Test, version: 1.0.0 }
servers: [{ url: https://api.example.com }]
paths:
  /resource:
    get:
      operationId: getResource
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Resource'
components:
  schemas:
    Resource:
      type: object
      required: [owner]
      properties:
        owner:
          oneOf:
            - type: object
              required: [type, id]
              properties:
                type: { type: string, const: organization }
                id: { type: string }
            - type: object
              required: [type, slug]
              properties:
                type: { type: string, const: organization }
                slug: { type: string }
`,
      (ir) => {
        const ownerModels = ir.models.filter((m) => m.name.includes('ResourceOwner'));
        const names = ownerModels.map((m) => m.name);
        expect(names).toContain('ResourceOwner');
        // Same const value on both — we can't derive distinct names, so
        // the fallback numeric suffix kicks in.
        expect(names).toContain('ResourceOwner2');
      },
    );
  });

  it('preserves single-variant inline schemas (one object, one null) as nullable, no naming work needed', async () => {
    // Make sure the const-naming pass doesn't accidentally fire on the
    // common `oneOf: [{ type: object … }, { type: null }]` nullable
    // pattern — there's only one *object* variant so the multi-variant
    // logic shouldn't run.
    await parseInline(
      `
openapi: 3.1.0
info: { title: Test, version: 1.0.0 }
servers: [{ url: https://api.example.com }]
paths:
  /x:
    get:
      operationId: getX
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/X'
components:
  schemas:
    X:
      type: object
      required: [box]
      properties:
        box:
          oneOf:
            - type: object
              required: [name]
              properties:
                name: { type: string }
            - type: 'null'
`,
      (ir) => {
        const names = ir.models.map((m) => m.name);
        expect(names).toContain('XBox');
        expect(names).not.toContain('XBox2');
      },
    );
  });
});
