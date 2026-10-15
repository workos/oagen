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
 * An entry that is not an object (`null`, say) is not a requirement object.
 * Reading it as `{}` would declare an anonymous alternative and make the
 * operation look open, so it is dropped with an `[oagen] Warning:` naming
 * `context` (the operation, or the document).
 *
 * The previous flattening collapsed the alternatives onto one list and turned
 * `[]` into `undefined`, so "no auth" read the same as "use the default" and
 * "either of" the same as "all of" (#182).
 */
export function extractSecurityRequirements(
  security: RawSecurityRequirements | undefined,
  context: string,
): SecurityRequirementSet[] | undefined {
  if (!Array.isArray(security)) return undefined;

  const sets: SecurityRequirementSet[] = [];
  for (const entry of security) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      console.warn(
        `[oagen] Warning: Ignoring security requirement ${JSON.stringify(entry)} on ${context} — not a requirement object`,
      );
      continue;
    }
    sets.push(
      Object.entries(entry).map(([schemeName, scopes]) => ({
        schemeName,
        scopes: Array.isArray(scopes) ? scopes : [],
      })),
    );
  }
  return sets;
}
