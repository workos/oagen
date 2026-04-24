import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { MANIFEST_FILENAME } from './manifest.js';

/** Minimal shape matching compat/overlay.ts ManifestEntry for cross-layer use. */
interface ManifestEntry {
  operationId: string;
  sdkResourceProperty: string;
  sdkMethodName: string;
  httpMethod: string;
  path: string;
  pathParams: string[];
  bodyFields: string[];
  queryFields: string[];
}

/**
 * Read the operations map from `.oagen-manifest.json` in the given directory
 * and convert it to `ManifestEntry[]` for the overlay builder.
 *
 * Returns undefined if the manifest is absent or has no operations field.
 */
export function readManifestSync(dir: string): ManifestEntry[] | undefined {
  const manifestPath = path.join(dir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const operations = parsed?.operations;
    if (!operations || typeof operations !== 'object') return undefined;
    return convertOperationsToManifestEntries(operations);
  } catch {
    return undefined;
  }
}

/** Convert the operations map from .oagen-manifest.json into ManifestEntry[]. */
function convertOperationsToManifestEntries(operations: Record<string, unknown>): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const [httpKey, value] of Object.entries(operations)) {
    const spaceIdx = httpKey.indexOf(' ');
    const httpMethod = httpKey.slice(0, spaceIdx);
    const httpPath = httpKey.slice(spaceIdx + 1);

    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const entry = v as { sdkMethod?: string; service?: string };
      entries.push({
        operationId: '',
        sdkResourceProperty: entry.service ?? '',
        sdkMethodName: entry.sdkMethod ?? '',
        httpMethod,
        path: httpPath,
        pathParams: [],
        bodyFields: [],
        queryFields: [],
      });
    }
  }
  return entries;
}
