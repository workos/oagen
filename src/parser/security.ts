import type { SecurityRequirementSet } from '../ir/types.js';

/**
 * An OpenAPI security requirement list as written in the document: each
 * object is one alternative whose keys are scheme names and whose values are
 * the scopes that scheme needs.
 */
export type RawSecurityRequirements = Array<Record<string, string[] | undefined> | null | undefined>;

/**
 * Convert a document- or operation-level `security` list into the IR shape,
 * preserving what the list says rather than flattening it:
 *
 * - absent (or not a list) → `undefined`: nothing declared here.
 * - `[]` → `[]`: no authentication required.
 * - `[{ a: [] }, { b: [] }]` → `[[a], [b]]`: either scheme suffices.
 * - `[{ a: [], b: [] }]` → `[[a, b]]`: both schemes are required together.
 * - `[{ a: [] }, {}]` → `[[a], []]`: the empty set is an anonymous alternative,
 *   which is how a document marks authentication optional.
 *
 * The previous flattening collapsed the last three onto one list and turned
 * `[]` into `undefined`, so "no auth" read the same as "use the default" and
 * "either of" the same as "all of" (#182).
 */
export function extractSecurityRequirements(
  security: RawSecurityRequirements | undefined,
): SecurityRequirementSet[] | undefined {
  if (!Array.isArray(security)) return undefined;

  return security.map((entry) =>
    Object.entries(entry ?? {}).map(([schemeName, scopes]) => ({
      schemeName,
      scopes: Array.isArray(scopes) ? scopes : [],
    })),
  );
}
