/**
 * How one HTTP authentication scheme name is told apart from another. A
 * Security Scheme Object of `type: http` names its scheme in `scheme`
 * (`basic`, `bearer`, `Digest`, `HOBA`, `Negotiate`, …), the `auth-scheme`
 * of an `Authorization` header, and RFC 9110 §11.1 makes that name a
 * case-insensitive token. The IR keeps the name as written — on
 * `AuthScheme`'s `http` kind — and only the comparison folds: the parser
 * deciding that `BASIC` is `kind: 'basic'` and `Bearer` is `kind: 'bearer'`,
 * and the differ deciding that `Digest` → `digest` is no change, both go
 * through this module, so one rule answers it.
 */

/** RFC 9110 §5.6.2 `token`: one or more `tchar`. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * An HTTP authentication scheme name as it is compared: lower-cased, since
 * RFC 9110 §11.1 makes scheme names case-insensitive (`Digest`, `digest`
 * and `DIGEST` name one scheme). A scheme name is an ASCII token, so plain
 * case folding is exact. Compare an `http` scheme's `scheme` through it:
 * `foldHttpAuthScheme(auth.scheme) === 'digest'`.
 */
export function foldHttpAuthScheme(scheme: string): string {
  return scheme.toLowerCase();
}

/**
 * Whether `value` can name an HTTP authentication scheme: a string that is
 * an RFC 9110 `token` (`auth-scheme = token`, §11.1), so it has at least
 * one character and no whitespace, control character or delimiter. `Digest`
 * and `SCRAM-SHA-256` are; `''`, `' Bearer '`, `my scheme` and a value that
 * is no string are not — none of them could be written before the
 * credentials of an `Authorization` header.
 */
export function isHttpAuthScheme(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}
