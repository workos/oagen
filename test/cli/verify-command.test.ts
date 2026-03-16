import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const MINIMAL_SPEC = resolve(FIXTURES, 'minimal.yml');

// Mock child_process.execFileSync to avoid launching real smoke scripts
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// Mock the extractor registry
const mockExtract = vi.fn();
vi.mock('../../src/compat/extractor-registry.js', () => ({
  getExtractor: () => ({
    language: 'test-lang',
    extract: mockExtract,
  }),
}));

import { verifyCommand } from '../../src/cli/verify.js';

/**
 * Minimal ApiSurface with one class and one interface.
 */
function makeSurface(overrides?: Partial<Record<string, unknown>>) {
  return {
    language: 'test-lang',
    extractedFrom: '/sdk',
    extractedAt: '2024-01-01T00:00:00Z',
    classes: {
      Users: {
        name: 'Users',
        methods: {
          list: { name: 'list', params: [], returnType: 'User[]', async: true },
        },
        properties: {},
        constructorParams: [],
      },
    },
    interfaces: {
      User: {
        name: 'User',
        fields: { id: { name: 'id', type: 'string', optional: false } },
        extends: [],
      },
    },
    typeAliases: {},
    enums: {},
    exports: {},
    ...overrides,
  };
}

describe('verifyCommand', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-verify-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    // Default: extractor returns same surface as baseline (100% preserved)
    mockExtract.mockResolvedValue(makeSurface());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
    // Clean up any diagnostics files
    try {
      rmSync('verify-diagnostics.json', { force: true });
    } catch {
      /* ignore */
    }
  });

  // ── Compat verification paths ─────────────────────────────────────────

  it('runs compat check with full scope when --api-surface provided without --spec', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    // Also need smoke baseline to exist — create one
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    // Mock execFileSync to succeed (smoke test passes)
    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    await verifyCommand({
      lang: 'test-lang',
      output: tmpDir,
      apiSurface: surfacePath,
      rawResults: rawPath,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Compat verification'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('compat:'));
    expect(consoleSpy).toHaveBeenCalledWith('Compat: passed');
  });

  it('runs compat check with spec-only scope when --spec is provided', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    await verifyCommand({
      spec: MINIMAL_SPEC,
      lang: 'test-lang',
      output: tmpDir,
      apiSurface: surfacePath,
      rawResults: rawPath,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('scoped to spec'));
    expect(consoleSpy).toHaveBeenCalledWith('Compat: passed');
  });

  it('exits 1 when --scope spec-only but no --spec given', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    await expect(
      verifyCommand({
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        scope: 'spec-only',
        rawResults: resolve(tmpDir, 'raw.json'),
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--scope spec-only requires --spec'));
  });

  it('exits 1 when compat violations are found', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    // Return a different surface (missing the User interface)
    mockExtract.mockResolvedValue({
      ...makeSurface(),
      interfaces: {},
    });

    await expect(
      verifyCommand({
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        rawResults: resolve(tmpDir, 'raw.json'),
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Compat violations found'));
  });

  it('writes diagnostics JSON when --diagnostics and compat passes', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await verifyCommand({
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        rawResults: rawPath,
        diagnostics: true,
      });

      expect(existsSync(resolve(tmpDir, 'verify-diagnostics.json'))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('writes diagnostics when compat fails and --diagnostics is set', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    mockExtract.mockResolvedValue({ ...makeSurface(), interfaces: {} });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await expect(
        verifyCommand({
          lang: 'test-lang',
          output: tmpDir,
          apiSurface: surfacePath,
          rawResults: resolve(tmpDir, 'raw.json'),
          diagnostics: true,
        }),
      ).rejects.toThrow('process.exit(1)');

      expect(existsSync(resolve(tmpDir, 'verify-diagnostics.json'))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('reports additions when candidate has new symbols', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    // Return a surface with extra symbols
    mockExtract.mockResolvedValue({
      ...makeSurface(),
      interfaces: {
        ...makeSurface().interfaces,
        NewInterface: { name: 'NewInterface', fields: {}, extends: [] },
      },
    });

    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    await verifyCommand({
      lang: 'test-lang',
      output: tmpDir,
      apiSurface: surfacePath,
      rawResults: rawPath,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('new symbols added'));
  });

  // ── Smoke baseline paths ──────────────────────────────────────────────

  it('exits 1 when no --spec and no raw baseline exists', async () => {
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await expect(
        verifyCommand({
          lang: 'test-lang',
          output: tmpDir,
        }),
      ).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--spec <path> or OPENAPI_SPEC_PATH env var is required'),
      );
    } finally {
      process.chdir(origCwd);
    }
  });

  it('generates spec-only baseline when no raw results and --spec provided', async () => {
    // Lines 211-223: runScript for baseline + smoke
    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await verifyCommand({
        spec: MINIMAL_SPEC,
        lang: 'test-lang',
        output: tmpDir,
      });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Generating spec-only baseline'));
      expect(consoleSpy).toHaveBeenCalledWith('\nVerify: all checks passed');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('exits 1 when baseline generation fails', async () => {
    // Lines 217-220: runScript throws → baseline gen failed
    const { execFileSync } = await import('node:child_process');
    let callCount = 0;
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('baseline script failed');
      return '';
    });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await expect(
        verifyCommand({
          spec: MINIMAL_SPEC,
          lang: 'test-lang',
          output: tmpDir,
        }),
      ).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith('Baseline generation failed');
    } finally {
      process.chdir(origCwd);
    }
  });

  // ── Smoke test success path ───────────────────────────────────────────

  it('runs smoke test and reports success', async () => {
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    await verifyCommand({
      lang: 'test-lang',
      output: tmpDir,
      rawResults: rawPath,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Smoke test + diff'));
    expect(consoleSpy).toHaveBeenCalledWith('\nVerify: all checks passed');
  });

  it('uses custom --smoke-runner when provided', async () => {
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    await verifyCommand({
      lang: 'test-lang',
      output: tmpDir,
      rawResults: rawPath,
      smokeRunner: '/custom/runner.ts',
    });

    expect(execFileSync).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['tsx', '/custom/runner.ts']),
      expect.anything(),
    );
  });

  it('uses node for .js smoke runner', async () => {
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    await verifyCommand({
      lang: 'test-lang',
      output: tmpDir,
      rawResults: rawPath,
      smokeRunner: '/custom/runner.js',
    });

    expect(execFileSync).toHaveBeenCalledWith('node', expect.arrayContaining(['/custom/runner.js']), expect.anything());
  });

  it('passes --smoke-config to smoke script', async () => {
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');
    const configPath = resolve(tmpDir, 'smoke-config.json');
    writeFileSync(configPath, '{}');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    await verifyCommand({
      lang: 'test-lang',
      output: tmpDir,
      rawResults: rawPath,
      smokeConfig: configPath,
    });

    expect(execFileSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['--smoke-config', configPath]),
      expect.anything(),
    );
  });

  // ── Smoke test failure paths ──────────────────────────────────────────

  it('exits 1 with findings when smoke test fails', async () => {
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('smoke failed');
    });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await expect(
        verifyCommand({
          lang: 'test-lang',
          output: tmpDir,
          rawResults: rawPath,
        }),
      ).rejects.toThrow('process.exit(1)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Smoke test findings'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Remediation guide'));
    } finally {
      process.chdir(origCwd);
    }
  });

  it('exits 2 when smoke-compile-errors.json exists', async () => {
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    // Create the compile errors marker file
    writeFileSync(resolve(tmpDir, 'smoke-compile-errors.json'), '["error"]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('compile error');
    });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await expect(
        verifyCommand({
          lang: 'test-lang',
          output: tmpDir,
          rawResults: rawPath,
        }),
      ).rejects.toThrow('process.exit(2)');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('compile errors'));
    } finally {
      process.chdir(origCwd);
    }
  });

  it('reads findings count from smoke-diff-findings.json when it exists', async () => {
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');
    writeFileSync(resolve(tmpDir, 'smoke-diff-findings.json'), JSON.stringify([{ id: 1 }, { id: 2 }]));

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('smoke failed');
    });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await expect(
        verifyCommand({
          lang: 'test-lang',
          output: tmpDir,
          rawResults: rawPath,
          diagnostics: true,
        }),
      ).rejects.toThrow('process.exit(1)');

      // Should have written diagnostics with findingsCount
      const diag = JSON.parse(
        (await import('node:fs')).readFileSync(resolve(tmpDir, 'verify-diagnostics.json'), 'utf-8'),
      );
      expect(diag.smokeCheck.findingsCount).toBe(2);
      expect(diag.smokeCheck.passed).toBe(false);
    } finally {
      process.chdir(origCwd);
    }
  });
});
