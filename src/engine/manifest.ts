import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Prune-manifest support for `oagen generate`.
 *
 * The manifest records every auto-generated file emitted on the previous run,
 * relative to the directory it lives in (either the `--output` standalone dir
 * or the `--target` integration dir).  On the next run we diff the previous
 * list against the current emission set and delete anything that's no longer
 * produced — preventing stale-file accumulation across regens.
 *
 * Design notes:
 *  - The manifest is versioned so future format changes can be handled safely.
 *  - Paths are stored sorted for deterministic diffs in git.
 *  - Deletion is gated on a header guard when one is available: we only remove
 *    files whose contents start with the auto-generated header.  This protects
 *    a hand-maintained file that happens to share a name with a previously
 *    generated one (extremely rare, but worth catching).
 *  - On first adoption (no previous manifest), pruning is skipped and a
 *    one-line notice is printed — no surprise deletions.
 */

export const MANIFEST_FILENAME = '.oagen-manifest.json';
const MANIFEST_VERSION = 2;

export interface Manifest {
  /** Schema version.  Bump when the format changes incompatibly. */
  version: number;
  /** Emitter language (e.g. "python").  Used only as a consistency hint. */
  language: string;
  /** Human-readable or package-level SDK identity (e.g. "workos-php"). */
  sdkName?: string;
  /** ISO-8601 timestamp of the run that produced this manifest. */
  generatedAt: string;
  /** SHA-256 hash of the source OpenAPI spec used for generation. */
  specSha?: string;
  /** Path or reference to the source spec. */
  specPath?: string;
  /** Git SHA or version of the emitter code used. */
  emitterSha?: string;
  /** Emitter version string if available. */
  emitterVersion?: string;
  /** SHA-256 hash of the effective oagen.config.ts after resolution. */
  configSha?: string;
  /** Version of the compat snapshot/report schema expected by this generation. */
  compatSchemaVersion?: string;
  /** Sorted list of paths, relative to the manifest's containing directory. */
  files: string[];
  /** Maps "METHOD /path" to SDK method + service property name. */
  operations?: Record<string, unknown>;
}

export interface PruneResult {
  /** Paths actually deleted. */
  pruned: string[];
  /** Paths skipped because the header guard didn't match (preserved). */
  preserved: string[];
  /** Paths already absent on disk (nothing to do). */
  missing: string[];
}

/** Read `.oagen-manifest.json` from a directory.  Returns null if absent or malformed. */
export async function readManifest(dir: string): Promise<Manifest | null> {
  const manifestPath = path.join(dir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (
      typeof parsed.version !== 'number' ||
      typeof parsed.language !== 'string' ||
      typeof parsed.generatedAt !== 'string' ||
      !Array.isArray(parsed.files) ||
      !parsed.files.every((p): p is string => typeof p === 'string')
    ) {
      return null;
    }
    if (parsed.version > MANIFEST_VERSION) {
      console.warn(
        `[oagen] ${MANIFEST_FILENAME} schema version ${parsed.version} is newer than supported (${MANIFEST_VERSION}); ignoring for pruning.`,
      );
      return null;
    }
    // v1 manifests are forward-compatible — new fields are simply absent
    return parsed as Manifest;
  } catch {
    return null;
  }
}

/** Options for writing a manifest. */
export interface WriteManifestOpts {
  language: string;
  files: Iterable<string>;
  sdkName?: string;
  specSha?: string;
  specPath?: string;
  emitterSha?: string;
  emitterVersion?: string;
  configSha?: string;
  compatSchemaVersion?: string;
  operations?: Record<string, unknown>;
}

/** Write `.oagen-manifest.json` to a directory with sorted paths. */
export async function writeManifest(dir: string, opts: WriteManifestOpts): Promise<void> {
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    language: opts.language,
    ...(opts.sdkName !== undefined ? { sdkName: opts.sdkName } : {}),
    generatedAt: new Date().toISOString(),
    ...(opts.specSha !== undefined ? { specSha: opts.specSha } : {}),
    ...(opts.specPath !== undefined ? { specPath: opts.specPath } : {}),
    ...(opts.emitterSha !== undefined ? { emitterSha: opts.emitterSha } : {}),
    ...(opts.emitterVersion !== undefined ? { emitterVersion: opts.emitterVersion } : {}),
    ...(opts.configSha !== undefined ? { configSha: opts.configSha } : {}),
    ...(opts.compatSchemaVersion !== undefined ? { compatSchemaVersion: opts.compatSchemaVersion } : {}),
    files: [...new Set(opts.files)].sort(),
    ...(opts.operations !== undefined ? { operations: opts.operations } : {}),
  };
  const manifestPath = path.join(dir, MANIFEST_FILENAME);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

/** Return the set of previous paths no longer present in the current emission. */
export function computeStalePaths(prev: Manifest, currentPaths: Iterable<string>): string[] {
  const current = new Set(currentPaths);
  return prev.files.filter((p) => !current.has(p)).sort();
}

/**
 * Delete stale files from `dir`.
 *
 * When `header` is provided, a file is only deleted if its contents start with
 * that header — so hand-maintained files that somehow collide with a previously
 * generated path can't be clobbered.  When `header` is omitted, the guard is
 * skipped (useful for non-source artifacts like fixture JSON).
 *
 * Returns lists for reporting.  Empty parent directories are removed after
 * deletion, up to (but not including) `dir` itself.
 */
export async function pruneStaleFiles(
  dir: string,
  paths: string[],
  opts: { header?: string } = {},
): Promise<PruneResult> {
  const pruned: string[] = [];
  const preserved: string[] = [];
  const missing: string[] = [];

  for (const relPath of paths) {
    const fullPath = path.join(dir, relPath);
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      missing.push(relPath);
      continue;
    }
    if (opts.header && !content.startsWith(opts.header)) {
      preserved.push(relPath);
      continue;
    }
    try {
      await fs.unlink(fullPath);
      pruned.push(relPath);
    } catch {
      // Racing deletion or permission issue — treat as missing rather than fatal.
      missing.push(relPath);
      continue;
    }
    await removeEmptyParents(path.dirname(fullPath), dir);
  }

  return { pruned, preserved, missing };
}

/**
 * Walk up from `startDir` removing empty directories until we hit `stopDir`
 * (exclusive) or a non-empty directory.  Silently ignores errors.
 */
async function removeEmptyParents(startDir: string, stopDir: string): Promise<void> {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current.startsWith(stop + path.sep) && current !== stop) {
    let entries: string[];
    try {
      entries = await fs.readdir(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
