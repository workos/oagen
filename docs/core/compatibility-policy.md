# Compatibility Policy

Human-authored compatibility policy lives in the `compat` section of `oagen.config.ts`. This is the single place for fail thresholds, language overrides, and intentional break approvals.

## Config Schema

```ts
export default {
  compat: {
    failOn: 'breaking',
    reportPath: 'compat-report.json',
    explain: true,
    baselinePath: 'sdk-surface.json',
    languagePolicy: {
      php: {
        // optional sparse overrides
      },
    },
    allow: [
      // intentional break approvals
    ],
  },
};
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `failOn` | `'none' \| 'breaking' \| 'soft-risk'` | `'breaking'` | Severity threshold for `verify` failure |
| `reportPath` | `string` | — | Path to write machine-readable JSON report |
| `explain` | `boolean` | `false` | Include provenance explanations in output |
| `baselinePath` | `string` | — | Path to baseline compatibility snapshot |
| `languagePolicy` | `Record<LanguageId, Partial<CompatPolicyHints>>` | — | Per-language policy overrides |
| `allow` | `CompatApproval[]` | — | Intentional break approvals |

## Language Policy

Language policy determines which aspects of the public API are breaking. Built-in defaults capture language semantics:

| Language | Caller Uses Param Names | Constructor Order | Param Names Public | Overloads Public | Arity Public |
|----------|------------------------|-------------------|-------------------|-----------------|-------------|
| PHP | yes | yes | yes | no | no |
| Python | yes | yes | yes | no | no |
| Ruby | yes | yes | yes | no | no |
| Go | no | yes | no | no | yes |
| Kotlin | yes | no | yes | yes | no |
| .NET | yes | no | yes | yes | no |
| Elixir | yes | no | yes | no | yes |
| Rust | no | yes | no | no | yes |
| Node | no | no | no | no | no |

### Overriding Language Defaults

Use `languagePolicy` only when a specific SDK intentionally diverges from language norms:

```ts
compat: {
  languagePolicy: {
    node: {
      // This Node SDK uses positional args, not options objects
      methodParameterNamesArePublicApi: true,
    },
  },
}
```

## Approvals

Approvals are concept-first: one approval covers one conceptual change across affected languages.

### Schema

```ts
interface CompatApproval {
  symbol: string;          // Fully-qualified symbol
  category: string;        // Change category (e.g., 'parameter_renamed')
  appliesTo?: string[];    // Language IDs, or omit for all
  match?: {                // Optional narrowing
    parameter?: string;
    member?: string;
    oldName?: string;
    newName?: string;
  };
  allowedReleaseLevel?: 'major' | 'minor' | 'patch';
  reason: string;          // Required explanation
  issue?: string;          // Issue tracker reference
  expiresAfterVersion?: string;
  approved?: boolean;      // Whether this approval is active (default: true)
}
```

### The `approved` Field

Approvals default to active. Set `approved: false` to deactivate an approval without removing it from the config — useful for temporarily disabling an approval or keeping a record of past approvals.

```ts
{
  symbol: 'Authorization.check',
  category: 'parameter_renamed',
  reason: 'Intentional rename for v3',
  issue: 'SDK-1234',
  approved: false, // deactivated — this break is no longer approved
}
```

When `approved` is `false`, the matching engine skips the approval entirely. When `approved` is `true` or omitted, the approval is active.

### Example

```ts
compat: {
  allow: [
    {
      symbol: 'WorkOS\\Service\\UserManagement::createUser',
      category: 'parameter_removed',
      match: { parameter: 'passwordHashType' },
      appliesTo: ['php', 'python', 'kotlin', 'dotnet'],
      allowedReleaseLevel: 'major',
      reason: 'Intentional wrapper-object migration',
      issue: 'SDK-1234',
      expiresAfterVersion: '6.0.0',
    },
  ],
}
```

### Matching Rules

Approvals must be narrow:

**Good:**
- One symbol, one category, one conceptual change
- Optionally one parameter/member
- Optionally a bounded set of affected languages

**Bad (rejected by validation):**
- Wildcard symbols (`*`, `Authorization.*`)
- Empty reason
- Missing symbol or category

### Anti-patterns

| Pattern | Problem |
|---------|---------|
| Approve all breaks in one language | Too broad — masks real regressions |
| Approve all parameter changes | Hides future unintentional breaks |
| No reason field | No audit trail |
| No issue reference | Can't trace back to decisions |

## Severity Determination

The default severity for a category comes from the classification engine. Language policy can modify this:

1. A `parameter_renamed` change is `breaking` by default
2. If the language policy says `methodParameterNamesArePublicApi: false` (e.g., Go), the classifier can downgrade to `soft-risk`
3. Approvals can further suppress changes from the failure threshold

## Fail Threshold

The `failOn` level determines which unapproved changes cause `oagen verify` to fail:

| Level | Fails on |
|-------|----------|
| `none` | Never fails for compat |
| `breaking` | Unapproved breaking changes |
| `soft-risk` | Unapproved breaking OR soft-risk changes |
