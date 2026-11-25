/**
 * Schema versioning for compatibility snapshots.
 *
 * Snapshots are versioned so consumers can detect format changes and
 * apply migration logic if needed.
 */

import type { CompatSnapshot } from './ir.js';

/**
 * Current schema version for compatibility snapshots.
 *
 * It changes when a reader of the current version could no longer read a
 * snapshot, or would misread one. A key added as optional (`isStatic`,
 * `optional`, `extends`, `aliasOf`) does not change it, and neither do the
 * `field` symbols a type alias's members are written as: the differ reads
 * each only where both snapshots record it, so a snapshot written without
 * them diffs as it did, against one written with them as well.
 */
export const COMPAT_SCHEMA_VERSION = '1';

/** Validate that a parsed snapshot has a compatible schema version. */
export function isCompatibleSchemaVersion(snapshot: { schemaVersion?: string }): boolean {
  return snapshot.schemaVersion === COMPAT_SCHEMA_VERSION;
}

/** Validate the basic structure of a parsed compat snapshot. */
export function validateSnapshot(data: unknown): data is CompatSnapshot {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.schemaVersion === 'string' &&
    typeof obj.source === 'object' &&
    obj.source !== null &&
    typeof obj.policies === 'object' &&
    obj.policies !== null &&
    Array.isArray(obj.symbols)
  );
}
