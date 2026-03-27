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
vi.mock('../../src/compat/extractor-registry.js', async () => {
  const { nodeHints } = await import('../../src/compat/language-hints.js');
  return {
    getExtractor: () => ({
      language: 'test-lang',
      hints: nodeHints,
      extract: mockExtract,
    }),
  };
});

// Mock overlay module for retry loop tests
const mockBuildOverlayLookup = vi.fn();
const mockPatchOverlay = vi.fn();
vi.mock('../../src/compat/overlay.js', () => ({
  buildOverlayLookup: (...args: unknown[]) => mockBuildOverlayLookup(...args),
  patchOverlay: (...args: unknown[]) => mockPatchOverlay(...args),
}));

// Mock orchestrator for retry loop tests
const mockGenerate = vi.fn();
vi.mock('../../src/engine/orchestrator.js', () => ({
  generate: (...args: unknown[]) => mockGenerate(...args),
}));

// Mock emitter registry for retry loop tests
const mockGetEmitter = vi.fn();
vi.mock('../../src/engine/registry.js', () => ({
  getEmitter: (lang: string) => mockGetEmitter(lang),
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
          listUsers: [{ name: 'listUsers', params: [], returnType: 'User[]', async: true }],
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

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = resolve(os.tmpdir(), `oagen-verify-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Default: extractor returns same surface as baseline (100% preserved)
    mockExtract.mockResolvedValue(makeSurface());

    // Default overlay mock: return a dummy overlay object
    const dummyOverlay = {
      methodByOperation: new Map(),
      httpKeyByMethod: new Map(),
      interfaceByName: new Map(),
      typeAliasByName: new Map(),
      requiredExports: new Map(),
      modelNameByIR: new Map(),
      fileBySymbol: new Map(),
    };
    mockBuildOverlayLookup.mockReturnValue(dummyOverlay);
    mockPatchOverlay.mockReturnValue(dummyOverlay);
    mockGenerate.mockResolvedValue([]);
    mockGetEmitter.mockReturnValue({ language: 'test-lang' });
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
    ).rejects.toThrow('--scope spec-only requires --spec');
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
    ).rejects.toThrow('Compat violations found');
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
      ).rejects.toThrow('Compat violations found');

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
      ).rejects.toThrow('--spec <path> or OPENAPI_SPEC_PATH env var is required');
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
      ).rejects.toThrow('Baseline generation failed');
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
      ).rejects.toThrow('Smoke test findings');
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
      ).rejects.toThrow('compile errors');
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
      ).rejects.toThrow('Smoke test findings');

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

  // ── Retry loop (--max-retries) ────────────────────────────────────────

  it('skips retry when --max-retries 0 and exits 1 on violations', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    // Candidate is missing the User interface → breaking violation
    mockExtract.mockResolvedValue({ ...makeSurface(), interfaces: {} });

    await expect(
      verifyCommand({
        spec: MINIMAL_SPEC,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        rawResults: resolve(tmpDir, 'raw.json'),
        maxRetries: 0,
      }),
    ).rejects.toThrow('Compat violations found');

    // generate should NOT be called when maxRetries is 0
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('retries and converges when emitter is fixed on second attempt', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    // First extraction: missing interface (violation). After retry: correct surface.
    mockExtract
      .mockResolvedValueOnce({ ...makeSurface(), interfaces: {} }) // attempt 0: violation
      .mockResolvedValue(makeSurface()); // attempt 1: converged

    await verifyCommand({
      spec: MINIMAL_SPEC,
      lang: 'test-lang',
      output: tmpDir,
      apiSurface: surfacePath,
      rawResults: rawPath,
      maxRetries: 3,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Retry 1/3'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('converged after 1 retry'));
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('exits 1 after exhausting max retries without convergence', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    // Return a slightly different (but still failing) surface each call so score varies.
    // attempt 0: missing interface (score low), attempt 1: still missing (same score → stall)
    // To avoid stall, make the second extraction improve slightly but not converge,
    // then the third extraction stays the same (exhausting maxRetries=1 check).
    // For a clean exhaustion test: use maxRetries=1, return violations each time.
    // attempt 0 → score X, attempt 1 → score slightly higher (> X) so no stall,
    //   but attempt === maxRetries(1) → exit 1.
    let callCount = 0;
    mockExtract.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // attempt 0: missing interface and class (score 0)
        return { ...makeSurface(), interfaces: {}, classes: {} };
      }
      // attempt 1: only missing interface (higher score — no stall)
      return { ...makeSurface(), interfaces: {} };
    });

    await expect(
      verifyCommand({
        spec: MINIMAL_SPEC,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        rawResults: resolve(tmpDir, 'raw.json'),
        maxRetries: 1,
      }),
    ).rejects.toThrow('Compat violations found');

    // One retry was attempted (generate called once), then max reached
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('exits 1 immediately when violations are not patchable', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    // Return surface with only a signature violation (not patchable by overlay)
    mockExtract.mockResolvedValue({
      ...makeSurface(),
      classes: {
        Users: {
          name: 'Users',
          methods: {
            // listUsers exists but with a changed return type → signature violation
            listUsers: [{ name: 'listUsers', params: [], returnType: 'string', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });

    await expect(
      verifyCommand({
        spec: MINIMAL_SPEC,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        rawResults: resolve(tmpDir, 'raw.json'),
        maxRetries: 3,
      }),
    ).rejects.toThrow('Compat violations found');

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No patchable violations'));
  });

  it('detects stall when preservation score does not improve', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    // Always return the same violations (same score) — stall detected on attempt 1
    mockExtract.mockResolvedValue({ ...makeSurface(), interfaces: {} });

    // Stall is detected on the second loop iteration (attempt 1) because
    // the preservation score is the same as prevScore set on attempt 0.
    // generate will be called once (for the retry after attempt 0).
    await expect(
      verifyCommand({
        spec: MINIMAL_SPEC,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        rawResults: resolve(tmpDir, 'raw.json'),
        maxRetries: 3,
      }),
    ).rejects.toThrow('Compat violations found');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Stalled at'));
    // generate is called once (the retry after attempt 0 succeeds in patching,
    // but the stall is detected when attempt 1 checks the result)
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('populates retryLoop diagnostics when converged', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));
    const rawPath = resolve(tmpDir, 'raw.json');
    writeFileSync(rawPath, '[]');

    const { execFileSync } = await import('node:child_process');
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    mockExtract
      .mockResolvedValueOnce({ ...makeSurface(), interfaces: {} }) // attempt 0: violation
      .mockResolvedValue(makeSurface()); // attempt 1: converged

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await verifyCommand({
        spec: MINIMAL_SPEC,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        rawResults: rawPath,
        maxRetries: 3,
        diagnostics: true,
      });

      expect(existsSync(resolve(tmpDir, 'verify-diagnostics.json'))).toBe(true);
      const diag = JSON.parse(
        (await import('node:fs')).readFileSync(resolve(tmpDir, 'verify-diagnostics.json'), 'utf-8'),
      );
      expect(diag.retryLoop).toBeDefined();
      expect(diag.retryLoop.converged).toBe(true);
      expect(diag.retryLoop.attempts).toBe(1);
      expect(diag.retryLoop.patchedPerIteration).toHaveLength(1);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('populates retryLoop diagnostics when not converged', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    // Always violating
    mockExtract.mockResolvedValue({ ...makeSurface(), interfaces: {} });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await expect(
        verifyCommand({
          spec: MINIMAL_SPEC,
          lang: 'test-lang',
          output: tmpDir,
          apiSurface: surfacePath,
          rawResults: resolve(tmpDir, 'raw.json'),
          maxRetries: 1,
          diagnostics: true,
        }),
      ).rejects.toThrow('Compat violations found');

      expect(existsSync(resolve(tmpDir, 'verify-diagnostics.json'))).toBe(true);
      const diag = JSON.parse(
        (await import('node:fs')).readFileSync(resolve(tmpDir, 'verify-diagnostics.json'), 'utf-8'),
      );
      expect(diag.retryLoop).toBeDefined();
      expect(diag.retryLoop.converged).toBe(false);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('does not retry when no --spec is provided (no parsedSpec)', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(makeSurface()));

    // Missing interface → violation
    mockExtract.mockResolvedValue({ ...makeSurface(), interfaces: {} });

    await expect(
      verifyCommand({
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        rawResults: resolve(tmpDir, 'raw.json'),
        maxRetries: 3, // even with retries configured, no spec means no retry
      }),
    ).rejects.toThrow('Compat violations found');

    // generate should NOT be called — no spec means shouldRetry is false
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
