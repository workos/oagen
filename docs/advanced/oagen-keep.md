# `@oagen-keep` — Preserving Hand-Written Docstrings

The merger's docstring refresh unconditionally replaces existing JSDoc/docstrings with the version from the generated output (typically derived from the OpenAPI spec). Any hand-written documentation is lost on every regeneration.

## Solution

Add `@oagen-keep` anywhere inside a docstring to prevent the merger from overwriting it. The tag is a simple substring match: if the existing docstring text contains `@oagen-keep`, the merger skips the replacement entirely, regardless of what the generated output says.

### Examples

```typescript
/**
 * Exchange an authorization code for a profile and access token.
 *
 * Auto-detects public vs confidential client mode:
 * - If codeVerifier is provided: Uses PKCE flow (public client)
 * - If no codeVerifier: Uses client_secret from API key (confidential client)
 *
 * @oagen-keep
 * @throws Error if neither codeVerifier nor API key is available
 */
async getProfileAndToken(...) { ... }
```

### Python

```python
def get_profile_and_token(self, ...):
    """Exchange an authorization code for a profile and access token.

    Auto-detects public vs confidential client mode.

    @oagen-keep
    """
```

## Scope

`@oagen-keep` protects:

- **Top-level symbol docstrings** — classes, interfaces, type aliases, enums
- **Member-level docstrings** — methods, fields, properties

It applies in both merge modes:

- **Full merge** (additive symbol merge + docstring refresh)
- **Docstring-only mode** (`{ docstringOnly: true }`)

## Behavior Details

- The tag is matched via `text.includes('@oagen-keep')` — no regex, no parsing.
- If the generated output has a docstring and the existing docstring contains `@oagen-keep`, the existing docstring is kept as-is.
- If the existing symbol has no docstring at all, a generated docstring is still inserted (there's nothing to preserve).
- The tag is language-agnostic: it works for any language whose tree-sitter merge adapter implements `extractDocstrings`.
