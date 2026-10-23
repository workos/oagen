import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractOperations } from '../../src/parser/operations.js';
import { resolveServerUrl } from '../../src/ir/server-url.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';

/**
 * Covers `Operation.servers` (issue #251): a Path Item's or an Operation's
 * `servers` reach the IR, with OpenAPI precedence (operation > path item >
 * document), and only when they differ from the document's.
 */
describe('parseSpec — operation-level servers (issue #251)', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parse-op-servers-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Write `content` to a temp YAML spec file and parse it. */
  async function parseYaml(content: string): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.yml');
    await fs.writeFile(specFile, content, 'utf-8');
    return parseSpec(specFile);
  }

  /** Every `[oagen] Warning:` the parse emitted. */
  function warnings(): string[] {
    const messages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    for (const message of messages) expect(message).toContain('[oagen] Warning:');
    return messages;
  }

  /** The operation named `name`, wherever the parser grouped it. */
  function operation(ir: ApiSpec, name: string): Operation {
    const found = ir.services.flatMap((s) => s.operations).find((op) => op.name === name);
    if (!found) throw new Error(`no operation ${name} in ${ir.services.map((s) => s.name).join(', ')}`);
    return found;
  }

  const ok = `responses: { '204': { description: ok } }`;

  it('carries path-level and operation-level servers, as the issue expects (end to end)', async () => {
    // The issue's repro.json, as raw JSON so nothing is reshaped on the way in.
    const specFile = path.join(tmpDir, 'repro.json');
    await fs.writeFile(
      specFile,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/pets': {
            servers: [{ url: 'https://pets.example.com' }],
            get: { operationId: 'listPets', responses: { '200': { description: 'ok' } } },
          },
          '/notes': {
            get: {
              operationId: 'listNotes',
              servers: [
                {
                  url: 'https://{region}.notes.example.com',
                  variables: { region: { default: 'eu', enum: ['eu', 'us'] } },
                },
              ],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      }),
      'utf-8',
    );
    const ir = await parseSpec(specFile);

    // The document's own list is untouched: `servers` is the document's and
    // `baseUrl` is still its first server.
    expect(ir.baseUrl).toBe('https://api.example.com');
    expect(ir.servers).toEqual([{ url: 'https://api.example.com' }]);

    const listPets = operation(ir, 'listPets');
    expect(listPets.servers).toEqual([{ url: 'https://pets.example.com' }]);

    const listNotes = operation(ir, 'listNotes');
    expect(listNotes.servers).toEqual([
      {
        url: 'https://{region}.notes.example.com',
        variables: { region: { default: 'eu', enum: ['eu', 'us'] } },
      },
    ]);
    // Same shape as the document's entries, so the same helper resolves them.
    expect(resolveServerUrl(listNotes.servers![0])).toEqual({ url: 'https://eu.notes.example.com', unresolved: [] });
    expect(warnings()).toEqual([]);
  });

  it("gives an operation's own servers precedence over its Path Item's", async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
paths:
  /pets:
    servers:
      - url: https://pets.example.com
    get:
      operationId: listPets
      servers:
        - url: https://read.pets.example.com
      ${ok}
    post:
      operationId: createPet
      ${ok}
`);

    expect(operation(ir, 'listPets').servers).toEqual([{ url: 'https://read.pets.example.com' }]);
    // A sibling without its own list takes the Path Item's.
    expect(operation(ir, 'createPet').servers).toEqual([{ url: 'https://pets.example.com' }]);
    expect(warnings()).toEqual([]);
  });

  it('leaves the key absent when the operation inherits the document servers', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
paths:
  /pets:
    get:
      operationId: listPets
      ${ok}
`);

    const listPets = operation(ir, 'listPets');
    expect('servers' in listPets).toBe(false);
    expect(listPets.servers).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('leaves the key absent when the declared list restates the document servers', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://{region}.api.example.com
    description: Regional API
    variables:
      region: { default: eu, enum: [eu, us], description: The region. }
paths:
  /pets:
    servers:
      - url: https://{region}.api.example.com
        description: Regional API
        variables:
          region: { default: eu, enum: [eu, us], description: The region. }
    get:
      operationId: listPets
      ${ok}
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: https://{region}.api.example.com
          description: Regional API
          variables:
            region: { default: eu, enum: [eu, us], description: The region. }
      ${ok}
`);

    expect('servers' in operation(ir, 'listPets')).toBe(false);
    expect('servers' in operation(ir, 'listNotes')).toBe(false);
    expect(warnings()).toEqual([]);
  });

  it('treats a different description, variable or order as a different list', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
    description: Production
  - url: https://{region}.api.example.com
    variables:
      region: { default: eu, enum: [eu, us] }
paths:
  /described:
    get:
      operationId: described
      servers:
        - url: https://api.example.com
          description: Main
        - url: https://{region}.api.example.com
          variables:
            region: { default: eu, enum: [eu, us] }
      ${ok}
  /defaulted:
    get:
      operationId: defaulted
      servers:
        - url: https://api.example.com
          description: Production
        - url: https://{region}.api.example.com
          variables:
            region: { default: us, enum: [eu, us] }
      ${ok}
  /enum-order:
    get:
      operationId: enumOrder
      servers:
        - url: https://api.example.com
          description: Production
        - url: https://{region}.api.example.com
          variables:
            region: { default: eu, enum: [us, eu] }
      ${ok}
  /reordered:
    get:
      operationId: reordered
      servers:
        - url: https://{region}.api.example.com
          variables:
            region: { default: eu, enum: [eu, us] }
        - url: https://api.example.com
          description: Production
      ${ok}
  /shorter:
    get:
      operationId: shorter
      servers:
        - url: https://api.example.com
          description: Production
      ${ok}
`);

    expect(operation(ir, 'described').servers![0]).toEqual({ url: 'https://api.example.com', description: 'Main' });
    expect(operation(ir, 'defaulted').servers![1].variables).toStrictEqual({
      region: { default: 'us', enum: ['eu', 'us'] },
    });
    expect(operation(ir, 'enumOrder').servers![1].variables).toStrictEqual({
      region: { default: 'eu', enum: ['us', 'eu'] },
    });
    expect(operation(ir, 'reordered').servers!.map((s) => s.url)).toEqual([
      'https://{region}.api.example.com',
      'https://api.example.com',
    ]);
    expect(operation(ir, 'shorter').servers).toEqual([{ url: 'https://api.example.com', description: 'Production' }]);
    expect(warnings()).toEqual([]);
  });

  it('applies precedence before the comparison: an operation restating the document under a diverging Path Item inherits', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
paths:
  /pets:
    servers:
      - url: https://pets.example.com
    get:
      operationId: listPets
      servers:
        - url: https://api.example.com
      ${ok}
    post:
      operationId: createPet
      ${ok}
`);

    // Its own list wins and equals the document's, so nothing is carried —
    // not the Path Item's, which it overrides.
    expect('servers' in operation(ir, 'listPets')).toBe(false);
    expect(operation(ir, 'createPet').servers).toEqual([{ url: 'https://pets.example.com' }]);
    expect(warnings()).toEqual([]);
  });

  it('treats an empty servers list as absent at both levels', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
paths:
  /pets:
    servers:
      - url: https://pets.example.com
    get:
      operationId: listPets
      servers: []
      ${ok}
  /notes:
    servers: []
    get:
      operationId: listNotes
      ${ok}
`);

    // `[]` on the operation does not override: it falls through to the Path Item.
    expect(operation(ir, 'listPets').servers).toEqual([{ url: 'https://pets.example.com' }]);
    // `[]` on the Path Item does not override either: the document's apply.
    expect('servers' in operation(ir, 'listNotes')).toBe(false);
    expect(warnings()).toEqual([]);
  });

  it('treats a list of unusable entries as absent and keeps only the usable ones of a mixed list', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
paths:
  /pets:
    servers:
      - description: No URL here
      - url: ''
      - null
      - not an object
    get:
      operationId: listPets
      ${ok}
  /notes:
    get:
      operationId: listNotes
      servers:
        - description: No URL here
        - url: https://notes.example.com
        - 42
      ${ok}
`);

    expect('servers' in operation(ir, 'listPets')).toBe(false);
    expect(operation(ir, 'listNotes').servers).toEqual([{ url: 'https://notes.example.com' }]);
    expect(warnings()).toEqual([]);
  });

  it('normalises variables the way the document servers are, naming where the problem is', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
paths:
  /pets:
    servers:
      - url: https://{region}.pets.example.com/{tenant}
        variables:
          region: { enum: [eu, us] }
          tenant: { default: acme }
    get:
      operationId: listPets
      ${ok}
    post:
      operationId: createPet
      ${ok}
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: https://notes.example.com:{port}/{version}
          variables:
            port: { default: 8443, enum: [8443, 443] }
            version: { default: v3, enum: [v1, v2] }
      ${ok}
`);

    // The variable without a default is omitted and its placeholder kept, as
    // for the document; `default`/`enum` are carried as text.
    const pathLevel = [
      { url: 'https://{region}.pets.example.com/{tenant}', variables: { tenant: { default: 'acme' } } },
    ];
    expect(operation(ir, 'listPets').servers).toEqual(pathLevel);
    expect(operation(ir, 'createPet').servers).toEqual(pathLevel);
    expect(resolveServerUrl(operation(ir, 'listPets').servers![0])).toEqual({
      url: 'https://{region}.pets.example.com/acme',
      unresolved: ['region'],
    });
    expect(operation(ir, 'listNotes').servers![0].variables).toStrictEqual({
      port: { default: '8443', enum: ['8443', '443'] },
      version: { default: 'v3', enum: ['v1', 'v2'] },
    });

    // One warning per problem: the Path Item's is reported once although two
    // operations inherit it, and each names the level it sits at.
    const messages = warnings();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('"region"');
    expect(messages[0]).toContain('has no default');
    expect(messages[0]).toContain('path item /pets');
    expect(messages[1]).toContain('"version"');
    expect(messages[1]).toContain('"v3"');
    expect(messages[1]).toContain('operation listNotes');
  });

  it('names an operation without an operationId by method and path in its warnings', async () => {
    await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
paths:
  /pets:
    get:
      servers:
        - url: https://{region}.pets.example.com
      ${ok}
`);

    const messages = warnings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('{region}');
    expect(messages[0]).toContain('declares no such variable');
    expect(messages[0]).toContain('operation GET /pets');
  });

  it('carries operation servers when the document declares none, leaving baseUrl empty', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
paths:
  /pets:
    get:
      operationId: listPets
      servers:
        - url: https://pets.example.com
      ${ok}
  /notes:
    get:
      operationId: listNotes
      ${ok}
`);

    expect(ir.baseUrl).toBe('');
    expect(ir.servers).toBeUndefined();
    expect(operation(ir, 'listPets').servers).toEqual([{ url: 'https://pets.example.com' }]);
    expect('servers' in operation(ir, 'listNotes')).toBe(false);
    expect(warnings()).toEqual([]);
  });

  it('keeps an operation server variable named __proto__ as an own key', async () => {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(
      specFile,
      '{"openapi":"3.1.0","info":{"title":"repro","version":"1"},' +
        '"servers":[{"url":"https://api.example.com"}],' +
        '"paths":{"/pets":{"get":{"operationId":"listPets",' +
        '"servers":[{"url":"https://{__proto__}.pets.example.com/{constructor}",' +
        '"variables":{"__proto__":{"default":"eu"},"constructor":{"default":"ctor"}}}],' +
        '"responses":{"204":{"description":"ok"}}}}}}',
      'utf-8',
    );
    const ir = await parseSpec(specFile);

    const variables = operation(ir, 'listPets').servers![0].variables!;
    expect(Object.getPrototypeOf(variables)).toBe(Object.prototype);
    expect(Object.keys(variables)).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(variables, '__proto__')).toBe(true);
    expect(resolveServerUrl(operation(ir, 'listPets').servers![0]).url).toBe('https://eu.pets.example.com/ctor');

    // Survives serialization as data, the way `oagen parse` prints the IR. (An
    // object literal with `__proto__:` would set the prototype, so the
    // round-tripped keys are checked one by one.)
    const printed = JSON.parse(JSON.stringify(operation(ir, 'listPets'))) as {
      servers: Array<{ url: string; variables: Record<string, unknown> }>;
    };
    expect(printed.servers).toHaveLength(1);
    expect(printed.servers[0].url).toBe('https://{__proto__}.pets.example.com/{constructor}');
    expect(Object.keys(printed.servers[0].variables)).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(printed.servers[0].variables, '__proto__')).toBe(true);
    expect(printed.servers[0].variables['__proto__']).toEqual({ default: 'eu' });
    expect(printed.servers[0].variables['constructor']).toEqual({ default: 'ctor' });
    expect(warnings()).toEqual([]);
  });

  it('reads the same shape from an OpenAPI 3.0 document', async () => {
    const ir = await parseYaml(`
openapi: '3.0.3'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
paths:
  /pets:
    servers:
      - url: https://{region}.pets.example.com
        variables:
          region: { default: eu, enum: [eu, us] }
    get:
      operationId: listPets
      ${ok}
`);

    expect(operation(ir, 'listPets').servers).toEqual([
      { url: 'https://{region}.pets.example.com', variables: { region: { default: 'eu', enum: ['eu', 'us'] } } },
    ]);
    expect(warnings()).toEqual([]);
  });

  describe('through extractOperations', () => {
    const paths = {
      '/pets': {
        servers: [{ url: 'https://pets.example.com' }],
        get: { operationId: 'listPets', responses: { '204': { description: 'ok' } } },
      },
    };

    it('compares against the document servers it is given', () => {
      const { services } = extractOperations(
        paths as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // componentResponses
        undefined, // componentFieldModels
        [{ url: 'https://pets.example.com' }],
      );
      expect('servers' in services[0].operations[0]).toBe(false);
    });

    it('treats no document servers as an empty list', () => {
      const { services } = extractOperations(paths as never);
      expect(services[0].operations[0].servers).toEqual([{ url: 'https://pets.example.com' }]);
    });
  });

  describe("OpenAPI's default server (issue #291)", () => {
    it("leaves the key absent when an operation writes `/` out under a document without servers (the issue's comment)", async () => {
      const ir = await parseYaml(`
openapi: 3.1.0
info: { title: repro, version: '1' }
paths:
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: /
      ${ok}
`);

      expect(ir.baseUrl).toBe('');
      expect(ir.servers).toBeUndefined();
      expect('servers' in operation(ir, 'listNotes')).toBe(false);
      expect(warnings()).toEqual([]);
    });

    it('leaves the key absent under `servers: []`, and for a Path Item that writes `/` out', async () => {
      const ir = await parseYaml(`
openapi: 3.1.0
info: { title: repro, version: '1' }
servers: []
paths:
  /notes:
    servers:
      - url: /
    get:
      operationId: listNotes
      ${ok}
`);

      expect(ir.baseUrl).toBe('');
      expect(ir.servers).toBeUndefined();
      expect('servers' in operation(ir, 'listNotes')).toBe(false);
      expect(warnings()).toEqual([]);
    });

    it('does not carry a description on `/`: the default server has none', async () => {
      const ir = await parseYaml(`
openapi: 3.1.0
info: { title: repro, version: '1' }
paths:
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: /
          description: Same origin
      ${ok}
`);

      expect('servers' in operation(ir, 'listNotes')).toBe(false);
      expect(warnings()).toEqual([]);
    });

    it('leaves the key absent when both the document and the operation write `/` out', async () => {
      const ir = await parseYaml(`
openapi: 3.1.0
info: { title: repro, version: '1' }
servers:
  - url: /
paths:
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: /
      ${ok}
`);

      // The document's own list is carried as written.
      expect(ir.baseUrl).toBe('/');
      expect(ir.servers).toEqual([{ url: '/' }]);
      expect('servers' in operation(ir, 'listNotes')).toBe(false);
      expect(warnings()).toEqual([]);
    });

    it('keeps `/` under a document that names a host', async () => {
      const ir = await parseYaml(`
openapi: 3.1.0
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
paths:
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: /
      ${ok}
`);

      expect(ir.baseUrl).toBe('https://api.example.com');
      expect(operation(ir, 'listNotes').servers).toEqual([{ url: '/' }]);
      expect(warnings()).toEqual([]);
    });

    it('keeps a named host under a document that writes `/` out', async () => {
      const ir = await parseYaml(`
openapi: 3.1.0
info: { title: repro, version: '1' }
servers:
  - url: /
paths:
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: https://notes.example.com
      ${ok}
`);

      expect(ir.baseUrl).toBe('/');
      expect(operation(ir, 'listNotes').servers).toEqual([{ url: 'https://notes.example.com' }]);
      expect(warnings()).toEqual([]);
    });

    it('keeps a named host alone under a document that lists `/` before it: position decides the default host', async () => {
      const ir = await parseYaml(`
openapi: 3.1.0
info: { title: repro, version: '1' }
servers:
  - url: /
  - url: https://notes.example.com
paths:
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: https://notes.example.com
      ${ok}
`);

      expect(ir.baseUrl).toBe('/');
      expect(operation(ir, 'listNotes').servers).toEqual([{ url: 'https://notes.example.com' }]);
      expect(warnings()).toEqual([]);
    });

    it('leaves the key absent when the operation writes `/` out twice under a document without servers', async () => {
      const ir = await parseYaml(`
openapi: 3.1.0
info: { title: repro, version: '1' }
paths:
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: /
        - url: /
      ${ok}
`);

      expect('servers' in operation(ir, 'listNotes')).toBe(false);
      expect(warnings()).toEqual([]);
    });

    it('keeps `/` with a variable under a document without servers: a variable is not the default', async () => {
      const ir = await parseYaml(`
openapi: 3.1.0
info: { title: repro, version: '1' }
paths:
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: /
          variables:
            port: { default: '443' }
      ${ok}
`);

      expect(operation(ir, 'listNotes').servers).toEqual([{ url: '/', variables: { port: { default: '443' } } }]);
      expect(warnings()).toEqual([]);
    });

    describe('through extractOperations', () => {
      const paths = {
        '/notes': {
          servers: [{ url: '/' }],
          get: { operationId: 'listNotes', responses: { '204': { description: 'ok' } } },
        },
      };

      it('treats a Path Item that writes `/` out under no document servers as inheriting', () => {
        const { services } = extractOperations(paths as never);
        expect('servers' in services[0].operations[0]).toBe(false);
      });

      it('treats a Path Item that writes `/` out under a document that writes `/` out as inheriting', () => {
        const { services } = extractOperations(
          paths as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined, // componentResponses
          undefined, // componentFieldModels
          [{ url: '/' }],
        );
        expect('servers' in services[0].operations[0]).toBe(false);
      });

      it('keeps a Path Item that writes `/` out under a document that names a host', () => {
        const { services } = extractOperations(
          paths as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined, // componentResponses
          undefined, // componentFieldModels
          [{ url: 'https://api.example.com' }],
        );
        expect(services[0].operations[0].servers).toEqual([{ url: '/' }]);
      });
    });
  });
});
