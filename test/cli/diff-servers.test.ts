import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const BEFORE = resolve(FIXTURES, 'servers-before.json');
const AFTER = resolve(FIXTURES, 'servers-after.json');
const MOVED = resolve(FIXTURES, 'servers-moved.json');
const ROOT_THEN_HOST = resolve(FIXTURES, 'servers-root-then-host.json');
const HOST_THEN_ROOT = resolve(FIXTURES, 'servers-host-then-root.json');
const REGION_UPPER = resolve(FIXTURES, 'servers-region-case-before.json');
const REGION_LOWER = resolve(FIXTURES, 'servers-region-case-after.json');

import { diffCommand } from '../../src/cli/diff.js';

/** `oagen diff` on documents that differ only in `servers` (#252). */
describe('diffCommand — servers', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /** The JSON report the command printed. */
  function printedReport(): {
    changes: Array<{ kind: string; classification: string }>;
    summary: { breaking: number };
  } {
    const jsonCall = consoleSpy.mock.calls.find((call: unknown[]) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    return JSON.parse(jsonCall![0] as string);
  }

  it('exits 2 when a variable default moves the base URL', async () => {
    const err: any = await diffCommand({ old: BEFORE, new: AFTER }).catch((e) => e);
    expect(err.exitCode).toBe(2);

    const diff = printedReport();
    expect(diff.summary.breaking).toBe(2);
    expect(diff.changes.map((c) => c.kind)).toEqual(['base-url-changed', 'server-modified']);
    expect(diff.changes[0]).toEqual({
      kind: 'base-url-changed',
      oldBaseUrl: 'https://eu.api.example.com',
      newBaseUrl: 'https://us.api.example.com',
      classification: 'breaking',
    });
  });

  it('exits 2 when the only server is replaced', async () => {
    const err: any = await diffCommand({ old: BEFORE, new: MOVED }).catch((e) => e);
    expect(err.exitCode).toBe(2);

    const diff = printedReport();
    expect(diff.changes.map((c) => [c.kind, c.classification])).toEqual([
      ['base-url-changed', 'breaking'],
      ['server-added', 'additive'],
      ['server-removed', 'breaking'],
    ]);
  });

  it('exits 0 for the same document', async () => {
    const err: any = await diffCommand({ old: BEFORE, new: BEFORE }).catch((e) => e);
    expect(err.exitCode).toBe(0);
    expect(printedReport().changes).toEqual([]);
  });

  it('exits 2 when a host is moved in front of a listed `/` (#405)', async () => {
    const err: any = await diffCommand({ old: ROOT_THEN_HOST, new: HOST_THEN_ROOT }).catch((e) => e);
    expect(err.exitCode).toBe(2);
    expect(printedReport().changes).toEqual([
      {
        kind: 'base-url-changed',
        oldBaseUrl: '/',
        newBaseUrl: 'https://notes.example.com',
        classification: 'breaking',
      },
    ]);
  });

  it("exits 1 when a variable default only changes the host's case (#406)", async () => {
    const err: any = await diffCommand({ old: REGION_UPPER, new: REGION_LOWER }).catch((e) => e);
    expect(err.exitCode).toBe(1);
    expect(printedReport().changes.map((c) => [c.kind, c.classification])).toEqual([['server-modified', 'additive']]);
  });
});

/**
 * `oagen diff` on documents that differ only in an operation's `servers`
 * (#299): the exit code is the one the same edit to the document's `servers`
 * gets, `1` for an additive change and `2` for a breaking one.
 */
describe("diffCommand — an operation's servers (#299)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  /** `GET /notes` served from `https://{region}.notes.example.com` under a document at `https://api.example.com`. */
  const document = (region: { default: string; enum?: string[] }): object => ({
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/notes': {
        get: {
          operationId: 'listNotes',
          servers: [{ url: 'https://{region}.notes.example.com', variables: { region } }],
          responses: { '204': { description: 'ok' } },
        },
      },
    },
  });
  /** `GET /notes` with its own `servers`, or inheriting when none is given, under a document with `servers` or none. */
  const documentWith = (
    documentServers: Array<{ url: string }> | undefined,
    operationServers?: Array<{ url: string }>,
  ) => ({
    openapi: '3.1.0',
    info: { title: 'repro', version: '1' },
    ...(documentServers ? { servers: documentServers } : {}),
    paths: {
      '/notes': {
        get: {
          operationId: 'listNotes',
          ...(operationServers ? { servers: operationServers } : {}),
          responses: { '204': { description: 'ok' } },
        },
      },
    },
  });
  const a = { url: 'https://a.example.com' };
  const b = { url: 'https://b.example.com' };
  const files: Record<'old' | 'wider' | 'moved' | 'inherits' | 'overrides' | 'overrideA' | 'movedDocument', string> = {
    old: '',
    wider: '',
    moved: '',
    inherits: '',
    overrides: '',
    overrideA: '',
    movedDocument: '',
  };

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'oagen-cli-diff-299-'));
    const writeDocument = async (name: keyof typeof files, doc: object): Promise<void> => {
      files[name] = join(tmpDir, `${name}.json`);
      await fs.writeFile(files[name], JSON.stringify(doc), 'utf-8');
    };
    const write = (name: keyof typeof files, region: { default: string; enum?: string[] }): Promise<void> =>
      writeDocument(name, document(region));
    await write('old', { default: 'eu', enum: ['eu'] });
    await write('wider', { default: 'eu', enum: ['eu', 'us'] });
    await write('moved', { default: 'us', enum: ['eu', 'us'] });
    // Inheriting on one side (#349 review): the operation under a document
    // at `a` inherits, then declares `[a, b]`; and the operation's `[a]`
    // override under a document without servers disappears because the
    // document moved to `[a, b]`.
    await writeDocument('inherits', documentWith([a]));
    await writeDocument('overrides', documentWith([a], [a, b]));
    await writeDocument('overrideA', documentWith(undefined, [a]));
    await writeDocument('movedDocument', documentWith([a, b]));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /** The JSON report the command printed. */
  function printedReport(): {
    changes: Array<Record<string, unknown>>;
    summary: { breaking: number; additive: number };
  } {
    const jsonCall = consoleSpy.mock.calls.find((call: unknown[]) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    return JSON.parse(jsonCall![0] as string);
  }

  it('exits 1 when an operation server gains an enum value, as the document would', async () => {
    const err: any = await diffCommand({ old: files.old, new: files.wider }).catch((e) => e);
    expect(err.exitCode).toBe(1);

    const diff = printedReport();
    expect(diff.summary).toMatchObject({ breaking: 0, additive: 1 });
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'operation-modified',
      operationName: 'listNotes',
      serversChanged: true,
      serverChanges: [
        {
          kind: 'server-modified',
          url: 'https://{region}.notes.example.com',
          variableChanges: [
            { kind: 'variable-enum-value-added', variableName: 'region', value: 'us', classification: 'additive' },
          ],
          classification: 'additive',
        },
      ],
      classification: 'additive',
    });
  });

  it("exits 2 when an operation server's default moves its resolved URL", async () => {
    const err: any = await diffCommand({ old: files.wider, new: files.moved }).catch((e) => e);
    expect(err.exitCode).toBe(2);

    const diff = printedReport();
    expect(diff.summary).toMatchObject({ breaking: 1, additive: 0 });
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'operation-modified',
      serversChanged: true,
      serverChanges: [
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://eu.notes.example.com',
          newBaseUrl: 'https://us.notes.example.com',
          classification: 'breaking',
        },
        {
          kind: 'server-modified',
          variableChanges: [
            { kind: 'variable-default-changed', variableName: 'region', oldDefault: 'eu', newDefault: 'us' },
          ],
          classification: 'breaking',
        },
      ],
      classification: 'breaking',
    });
  });

  it('exits 1 when an operation under a document at `a` starts declaring `[a, b]` (#349 review)', async () => {
    const err: any = await diffCommand({ old: files.inherits, new: files.overrides }).catch((e) => e);
    expect(err.exitCode).toBe(1);

    const diff = printedReport();
    expect(diff.summary).toMatchObject({ breaking: 0, additive: 1 });
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'operation-modified',
      operationName: 'listNotes',
      serversChanged: true,
      serverChanges: [{ kind: 'server-added', url: 'https://b.example.com', classification: 'additive' }],
      classification: 'additive',
    });
  });

  it("exits 1 when an operation's `[a]` override disappears because the document moved to `[a, b]` (#349 review)", async () => {
    const err: any = await diffCommand({ old: files.overrideA, new: files.movedDocument }).catch((e) => e);
    expect(err.exitCode).toBe(1);

    const diff = printedReport();
    // The document gained its first host and a second one beside it, all
    // additive; the operation, served from `[a]` before, gains `b`.
    expect(diff.summary).toMatchObject({ breaking: 0, additive: 4 });
    expect(diff.changes.map((c) => [c.kind, c.classification])).toEqual([
      ['base-url-changed', 'additive'],
      ['server-added', 'additive'],
      ['server-added', 'additive'],
      ['operation-modified', 'additive'],
    ]);
    expect(diff.changes[3]).toMatchObject({
      operationName: 'listNotes',
      serversChanged: true,
      serverChanges: [{ kind: 'server-added', url: 'https://b.example.com', classification: 'additive' }],
      classification: 'additive',
    });
  });
});
