/**
 * Escape a string for safe interpolation inside a JS/TS block comment.
 *
 * Free-text spec fields (schema/field/operation descriptions) are
 * attacker-influenceable data. A `*` followed by `/` inside such text would
 * terminate the surrounding `/* ... *\/` comment and turn the remainder of the
 * string into live source in the generated output. Neutralizing every comment
 * terminator keeps the text inert inside the comment.
 *
 * This is specific to languages whose block comments end at `*\/` (JS, TS,
 * Java, C#, Go, ...). Emitters for languages with other comment syntax (Python
 * `"""`, Ruby `=begin`/`#`, ...) must apply language-appropriate escaping
 * instead of, or in addition to, this helper.
 */
export function escapeBlockComment(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}

/**
 * Sanitize a string for safe interpolation into a JS/TS identifier position
 * (class name, variable, property, ...).
 *
 * Free-text spec fields flow into identifiers too — notably `info.title`, which
 * becomes the SDK namespace (and thus the client class name) when no explicit
 * `--namespace` is given. Interpolating that raw value into an identifier lets a
 * crafted title (e.g. `X {}; run(); class Y`) break out of the declaration and
 * emit arbitrary top-level source. Replacing every character that is not valid
 * in an identifier keeps the value inert.
 *
 * Already-valid identifiers pass through unchanged (`WorkOS` stays `WorkOS`), so
 * this does not disturb legitimate output. A leading digit is prefixed with `_`
 * so the result is always a usable identifier.
 */
export function sanitizeIdentifier(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
