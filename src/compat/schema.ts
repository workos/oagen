/**
 * Schema versioning for compatibility snapshots.
 *
 * Snapshots are versioned so consumers can detect format changes and
 * apply migration logic if needed.
 */

import type { CompatSnapshot } from './ir.js';

/** Current schema version for compatibility snapshots. */
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
    typeof obj.language === 'string' &&
    typeof obj.sdkName === 'string' &&
    typeof obj.source === 'object' &&
    obj.source !== null &&
    typeof obj.extractor === 'object' &&
    obj.extractor !== null &&
    typeof obj.policies === 'object' &&
    obj.policies !== null &&
    Array.isArray(obj.symbols)
  );
}
