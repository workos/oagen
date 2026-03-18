/**
 * Deep merge two parsed JSON values.
 *
 * - Objects: recursively merge, preserving existing keys not in generated
 * - Arrays: generated replaces existing entirely (generated owns array contents)
 * - Primitives: generated wins
 */
export function deepMergeJson(existing: unknown, generated: unknown): unknown {
  if (
    typeof existing === 'object' &&
    existing !== null &&
    !Array.isArray(existing) &&
    typeof generated === 'object' &&
    generated !== null &&
    !Array.isArray(generated)
  ) {
    const merged: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
    for (const [key, value] of Object.entries(generated as Record<string, unknown>)) {
      if (key in merged) {
        merged[key] = deepMergeJson(merged[key], value);
      } else {
        merged[key] = value;
      }
    }
    return merged;
  }

  // Arrays and primitives: generated wins
  return generated;
}
