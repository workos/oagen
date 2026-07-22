/**
 * Escape a string for safe interpolation inside a block comment.
 *
 * Free-text spec fields (schema/field/operation descriptions, spec title) are
 * attacker-influenceable data. A `*` followed by `/` inside such text would
 * terminate the surrounding block comment and turn the remainder of the string
 * into live source in the generated output. Neutralizing every comment
 * terminator keeps the text inert inside the comment.
 */
export function escapeBlockComment(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}
