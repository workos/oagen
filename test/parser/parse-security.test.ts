import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { extractSecurityRequirements } from '../../src/parser/security.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * Covers how the document-level and per-operation `security` lists reach the
 * IR (#182): the document default lands on `ApiSpec.security`, `security: []`
 * stays an empty list, and each requirement object stays a group so "either
 * of" and "all of" remain distinguishable.
 */
describe('parseSpec — security requirements', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parse-security-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  const securitySchemes = {
    userToken: { type: 'http', scheme: 'bearer' },
    partnerKey: { type: 'apiKey', in: 'header', name: 'X-Partner-Key' },
  };

  const op = (operationId: string, security?: unknown) => ({
    get: { operationId, ...(security !== undefined ? { security } : {}), responses: { '204': { description: 'ok' } } },
  });

  it('keeps the document default, an empty list, and each requirement object as a group (#182 repro)', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      security: [{ userToken: [] }],
      paths: {
        '/default': op('getDefault'),
        '/public': op('getPublic', []),
        '/either': op('getEither', [{ userToken: [] }, { partnerKey: [] }]),
        '/both': op('getBoth', [{ userToken: [], partnerKey: [] }]),
      },
      components: { securitySchemes },
    });

    expect(ir.security).toEqual([[{ schemeName: 'userToken', scopes: [] }]]);

    const byName = Object.fromEntries(ir.services.flatMap((s) => s.operations).map((o) => [o.name, o.security]));
    expect(byName).toEqual({
      // Declares nothing: inherits ApiSpec.security.
      getDefault: undefined,
      // `security: []` is "no authentication", not "use the default".
      getPublic: [],
      // Two requirement objects: either scheme suffices.
      getEither: [[{ schemeName: 'userToken', scopes: [] }], [{ schemeName: 'partnerKey', scopes: [] }]],
      // One requirement object with two schemes: both are required together.
      getBoth: [
        [
          { schemeName: 'userToken', scopes: [] },
          { schemeName: 'partnerKey', scopes: [] },
        ],
      ],
    });
    expect(Object.keys(byName.getDefault ?? {})).toEqual([]);
    // Resolution an emitter performs: the operation's own list, else the document's.
    const effective = (name: string) => byName[name] ?? ir.security;
    expect(effective('getDefault')).toEqual([[{ schemeName: 'userToken', scopes: [] }]]);
    expect(effective('getPublic')).toEqual([]);
  });

  it('keeps an empty requirement object as an anonymous alternative, and preserves scopes', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/optional': op('getOptional', [{ userToken: ['read:things', 'write:things'] }, {}]),
      },
      components: { securitySchemes },
    });

    const [optional] = ir.services.flatMap((s) => s.operations);
    expect(optional.security).toEqual([[{ schemeName: 'userToken', scopes: ['read:things', 'write:things'] }], []]);
  });

  it('leaves ApiSpec.security undefined when the document declares none, and [] when it declares none required', async () => {
    const none = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: { '/thing': op('getThing') },
      components: { securitySchemes },
    });
    expect(none.security).toBeUndefined();
    expect(Object.keys(none)).not.toContain('securityRequirements');

    const open = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      security: [],
      paths: { '/thing': op('getThing') },
      components: { securitySchemes },
    });
    expect(open.security).toEqual([]);
  });

  it('drops an entry that is not a requirement object, with a warning naming the operation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseJson({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: { '/thing': op('getThing', [{ partnerKey: [] }, null]) },
        components: { securitySchemes },
      });

      const [thing] = ir.services.flatMap((s) => s.operations);
      // Not `[[partnerKey], []]`: a null entry must not read as "or no authentication".
      expect(thing.security).toEqual([[{ schemeName: 'partnerKey', scopes: [] }]]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[oagen] Warning: Ignoring security requirement null on getThing'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps document order for sets and for the schemes within a set', async () => {
    const ir = await parseJson({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      security: [{ partnerKey: [] }, { userToken: [] }],
      paths: { '/thing': op('getThing', [{ partnerKey: [], userToken: [] }]) },
      components: { securitySchemes },
    });

    expect(ir.security?.map((set) => set.map((r) => r.schemeName))).toEqual([['partnerKey'], ['userToken']]);
    const [thing] = ir.services.flatMap((s) => s.operations);
    expect(thing.security?.map((set) => set.map((r) => r.schemeName))).toEqual([['partnerKey', 'userToken']]);
  });
});

describe('extractSecurityRequirements', () => {
  it('returns undefined when nothing is declared or the value is not a list', () => {
    expect(extractSecurityRequirements(undefined, 'op')).toBeUndefined();
    expect(extractSecurityRequirements(null as never, 'op')).toBeUndefined();
    expect(extractSecurityRequirements({ userToken: [] } as never, 'op')).toBeUndefined();
  });

  it('returns an empty list for `security: []`', () => {
    expect(extractSecurityRequirements([], 'op')).toEqual([]);
  });

  it('turns each requirement object into one set, in order', () => {
    expect(extractSecurityRequirements([{ a: ['x'] }, { b: [], c: ['y', 'z'] }], 'op')).toEqual([
      [{ schemeName: 'a', scopes: ['x'] }],
      [
        { schemeName: 'b', scopes: [] },
        { schemeName: 'c', scopes: ['y', 'z'] },
      ],
    ]);
  });

  it('keeps an empty object as an anonymous alternative and tolerates missing scopes', () => {
    expect(extractSecurityRequirements([{ a: undefined }, {}], 'op')).toEqual([[{ schemeName: 'a', scopes: [] }], []]);
  });

  it('drops entries that are not requirement objects and warns for each, naming the context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        extractSecurityRequirements([null, { a: [] }, undefined, 'bearer' as never, [] as never], 'POST /x'),
      ).toEqual([[{ schemeName: 'a', scopes: [] }]]);
      expect(warn).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring security requirement null on POST /x'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring security requirement "bearer" on POST /x'));
    } finally {
      warn.mockRestore();
    }
  });
});
