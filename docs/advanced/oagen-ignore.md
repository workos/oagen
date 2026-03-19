# `@oagen-ignore` — Preserving Hand-Written Code

The `@oagen-ignore` system lets you protect hand-written code from being overwritten during regeneration. It operates at three scopes: docstring, region, and file.

> **Migration note:** `@oagen-keep` has been renamed to `@oagen-ignore`. The old tag no longer works.

## Docstring-Level: `@oagen-ignore`

Add `@oagen-ignore` anywhere inside a docstring to prevent the merger from overwriting it. The tag is a simple substring match — no regex, no parsing.

### TypeScript

```typescript
/**
 * Exchange an authorization code for a profile and access token.
 *
 * Auto-detects public vs confidential client mode:
 * - If codeVerifier is provided: Uses PKCE flow (public client)
 * - If no codeVerifier: Uses client_secret from API key (confidential client)
 *
 * @oagen-ignore
 * @throws Error if neither codeVerifier nor API key is available
 */
async getProfileAndToken(...) { ... }
```

### Python

```python
def get_profile_and_token(self, ...):
    """Exchange an authorization code for a profile and access token.

    Auto-detects public vs confidential client mode.

    @oagen-ignore
    """
```

### Scope

Protects:

- **Top-level symbol docstrings** — classes, interfaces, type aliases, enums
- **Member-level docstrings** — methods, fields, properties

Applies in both merge modes (full merge and docstring-only).

### Behavior

- Matched via `text.includes('@oagen-ignore')`.
- If the existing docstring contains `@oagen-ignore`, it is kept as-is regardless of what the generated output says.
- If the existing symbol has no docstring at all, a generated docstring is still inserted (there's nothing to preserve).
- Language-agnostic: works for any language whose merge adapter implements `extractDocstrings`.

## Region-Level: `@oagen-ignore-start` / `@oagen-ignore-end`

Wrap one or more symbols in a region to protect them from **both** deep merge (new members) and docstring refresh.

### TypeScript

```typescript
// @oagen-ignore-start
/**
 * Hand-written SSO class with custom PKCE flow logic.
 * The merger will not add new methods or update this docstring.
 */
export class SSO {
  getProfileAndToken() { /* custom implementation */ }
}
// @oagen-ignore-end

// This class is NOT protected — normal merge rules apply
export class Users {
  list() {}
}
```

### Python

```python
# @oagen-ignore-start
class SSO:
    """Hand-written SSO class."""

    def get_profile_and_token(self):
        """Custom PKCE flow."""
        pass
# @oagen-ignore-end
```

### Scope

For each symbol whose declaration start falls within a region:

- **Deep merge** is skipped — no new members are added
- **Docstring refresh** is skipped — both top-level and member docstrings are preserved
- **Top-level append** still works — new symbols outside the region are appended normally

### Behavior

- Markers are matched as literal substrings in comments. The comment style doesn't matter (`//`, `#`, `/* */`).
- Regions are paired: each `@oagen-ignore-start` must have a matching `@oagen-ignore-end`. An unclosed start does **not** protect anything.
- Multiple regions per file are supported.
- New symbols (not present in the existing file) are still appended even if existing symbols are in ignored regions.

## File-Level: `@oagen-ignore-file`

Add `@oagen-ignore-file` anywhere in an existing file to prevent the writer from touching it at all. The file is completely skipped — no merge, no docstring refresh, no overwrite.

### TypeScript

```typescript
// @oagen-ignore-file
// This entire file is hand-maintained and should never be regenerated.

export class CustomClient {
  // ...
}
```

### Python

```python
# @oagen-ignore-file

class CustomClient:
    """Fully hand-written client."""
    pass
```

### Behavior

- Only checked on **existing** files. A brand-new file is always written, even if the generated content contains `@oagen-ignore-file`.
- Matched via `existingContent.includes('@oagen-ignore-file')`.
- The file appears in `WriteResult.ignored` and is logged as `Ignored N files (@oagen-ignore-file)`.
- Does not affect other files in the same batch.

## Summary

| Marker | Scope | Protects |
|--------|-------|----------|
| `@oagen-ignore` | Docstring | That specific docstring from overwrite |
| `@oagen-ignore-start` / `@oagen-ignore-end` | Region | Enclosed symbols from deep merge + docstring refresh |
| `@oagen-ignore-file` | File | Entire file from any writer action |
