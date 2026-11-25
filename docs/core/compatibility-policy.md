# Compatibility Policy

Human-authored compatibility policy lives in the `compat` section of `oagen.config.ts`. This is the single place for fail thresholds, language overrides, and intentional break approvals.

## Config Schema

```ts
export default {
  compat: {
    failOn: "breaking",
    reportPath: "compat-report.json",
    explain: true,
    baselinePath: "sdk-surface.json",
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

| Field            | Type                                             | Default      | Description                                |
| ---------------- | ------------------------------------------------ | ------------ | ------------------------------------------ |
| `failOn`         | `'none' \| 'breaking' \| 'soft-risk'`            | `'breaking'` | Severity threshold for `verify` failure    |
| `reportPath`     | `string`                                         | —            | Path to write machine-readable JSON report |
| `explain`        | `boolean`                                        | `false`      | Include provenance explanations in output  |
| `baselinePath`   | `string`                                         | —            | Path to baseline compatibility snapshot    |
| `languagePolicy` | `Record<LanguageId, Partial<CompatPolicyHints>>` | —            | Per-language policy overrides              |
| `allow`          | `CompatApproval[]`                               | —            | Intentional break approvals                |

## Language Policy

Language policy determines which aspects of the public API are breaking. Built-in defaults capture language semantics:

| Language | Caller Uses Param Names | Constructor Order | Param Names Public | Overloads Public | Arity Public |
| -------- | ----------------------- | ----------------- | ------------------ | ---------------- | ------------ |
| PHP      | yes                     | yes               | yes                | no               | no           |
| Python   | yes                     | yes               | yes                | no               | no           |
| Ruby     | yes                     | yes               | yes                | no               | no           |
| Go       | no                      | yes               | no                 | no               | yes          |
| Kotlin   | yes                     | no                | yes                | yes              | no           |
| .NET     | yes                     | no                | yes                | yes              | no           |
| Elixir   | yes                     | no                | yes                | no               | yes          |
| Rust     | no                      | yes               | no                 | no               | yes          |
| Node     | no                      | no                | no                 | no               | no           |

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
  symbol: string; // Fully-qualified symbol
  category: string; // Change category (e.g., 'parameter_renamed')
  appliesTo?: string[]; // Language IDs, or omit for all
  match?: {
    // Optional narrowing
    parameter?: string;
    member?: string;
    oldName?: string;
    newName?: string;
  };
  allowedReleaseLevel?: "major" | "minor" | "patch";
  reason: string; // Required explanation
  issue?: string; // Issue tracker reference
  expiresAfterVersion?: string;
  approved?: boolean; // Whether this approval is active (default: true)
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
      symbol: 'Acme\\Service\\Users::createUser',
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

| Pattern                            | Problem                            |
| ---------------------------------- | ---------------------------------- |
| Approve all breaks in one language | Too broad — masks real regressions |
| Approve all parameter changes      | Hides future unintentional breaks  |
| No reason field                    | No audit trail                     |
| No issue reference                 | Can't trace back to decisions      |

## Severity Determination

The default severity for a category comes from the classification engine. Language policy can modify this:

1. A `parameter_renamed` change is `breaking` by default
2. If the language policy says `methodParameterNamesArePublicApi: false` (e.g., Go), the classifier can downgrade to `soft-risk`
3. Approvals can further suppress changes from the failure threshold

## Fail Threshold

The `failOn` level determines which unapproved changes cause `oagen verify` to fail:

| Level       | Fails on                                 |
| ----------- | ---------------------------------------- |
| `none`      | Never fails for compat                   |
| `breaking`  | Unapproved breaking changes              |
| `soft-risk` | Unapproved breaking OR soft-risk changes |

## Remediation Hints

Some changes have a recognized upstream root cause that the spec author can fix. When the differ detects one, it attaches a `remediation` string to the classified change. The hint surfaces in both the machine-readable report (`CompatReportChange.remediation`) and the human-readable summary (printed as `hint: ...` underneath the change).

The hint is advisory: it tells the spec author how to make the change non-breaking. It never changes a change's category; where a pattern also changes the severity, the pattern says so below.

### Detected patterns

| Pattern              | Trigger                                                                                                                                                                                  | Hint                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema fork**      | A `return_type_changed` or `field_type_changed` where the new type was newly added in the candidate snapshot _and_ its field set is a non-strict superset of the prior type's field set. | "Schema `NewType` looks like `OldType` with additional fields. Consider adding the new fields to `OldType` instead of forking a new schema." Forking forces a breaking type-name change in typed SDKs; extending the existing schema is additive. |
| **Declared subtype** | A `return_type_changed` or `field_type_changed` where the candidate declares that the new type extends the old one, directly or through the types it extends.                            | "Field type swap from `OldType` to `NewType` narrows to a declared subtype." Code that reads the value continues to work; only code that produces one has to supply the new type.                                                                 |

A schema fork is reported as `soft-risk`, not `breaking`: the new type has every field a caller read on the old one, so only an explicit annotation with the old type's name has to move. A retype to a type that already existed, or to one that drops a field, stays `breaking` and gets no hint, unless the new type is a declared subtype of the old one.

A retype to a declared subtype is `soft-risk` as well, whether or not the new type is new: `DetailedErrorBody extends ErrorBody` says every `DetailedErrorBody` is an `ErrorBody`. The declaration is read from the candidate snapshot's `extends` (see [Compatibility IR → Types and Their Members](compatibility-ir.md#types-and-their-members)), by name: an interface's `extends`, the types an intersection alias is written with, a model class's base. Two types with the same fields are not related by it, and neither is a type that extends an instantiation (`extends Partial<ErrorBody>`, `extends Box<ErrorBody>`). The retype has to narrow the type and do nothing else: the two type texts are one text with the name swapped (`ErrorBody[] | undefined` → `DetailedErrorBody[] | undefined`), so `ErrorBody` → `DetailedErrorBody[]` and `ErrorBody` → `DetailedErrorBody | undefined` stay `breaking`. So does a retype under a generic that may take its argument: `Sink<ErrorBody>` → `Sink<DetailedErrorBody>` narrows what `Sink<T>.accept(value: T)` takes, and nothing in a type text or in the snapshot says how a generic uses its argument. The name is read through a generic only when it is one known to hand its argument back, a promise (`Promise<T>`, `PromiseLike<T>`, `Awaitable[T]`) or a collection (`Array<T>`, `Set<T>`, `Iterable<T>`, `list[T]`, `Sequence[T]`), and the SDK declares no type of that name itself. It holds for a position callers read: a return, and a field of a type no callable takes. A field of a type callers build keeps its severity, since the subtype may ask for more than the value they pass today, and so does a parameter (`parameter_type_narrowed`).

```
Compat report:
  0 breaking, 1 soft-risk, 0 additive

  Soft-risk:
    [field_type_changed] PetsError.body — Type changed for "PetsError.body" from "ErrorBody" to "DetailedErrorBody"
      hint: Field type swap from "ErrorBody" to "DetailedErrorBody" narrows to a declared subtype — "DetailedErrorBody" extends "ErrorBody", so every value of the new type is still a value of the old one. Code that reads the value continues to work; only code that produces one (a test double, an override) has to supply "DetailedErrorBody".
```

### How the two types are found

A snapshot records a type as the text its extractor wrote (`CompatTypeRef.name`), and the differ looks the old and the new type up by the name that text carries (`bareTypeName` in `src/compat/type-names.ts`). It reads the name through:

- an optional or nullable spelling, in any order and spacing: `X | undefined`, `X | null`, `null | X`, `X | None`, `Union[X, None]`, `X | nil`, `?X`, `X?`, `*X`, `Optional[X]`, `NotRequired[X]`, `Option<X>`, `Nullable<X>`, `T.nilable(X)`
- one array suffix: `X[]`
- one single-argument generic: `Promise<X>`, `List<X>`, `Iterator[X]`

An optional spelling says nothing about the type the value has when it is there, so it is read through wherever the lookup looks: around the whole type, around an array's element (`(X | null)[]`, `X?[]`) and around a generic's argument (`Promise<X | undefined>`, `list[Optional[X]]`). A text is looked up exactly as the same text without its optional spellings is: `ErrorBody | undefined` → `ErrorBodyWithCode | undefined` on an optional class property, `ErrorBody | None` → `ErrorBodyWithCode | None` on a Python model field and `?ErrorBody` → `?ErrorBodyWithCode` on a PHP promoted property are each the retype `ErrorBody` → `ErrorBodyWithCode`.

```
Compat report:
  0 breaking, 1 soft-risk, 3 additive

  Soft-risk:
    [field_type_changed] PetsError.body — Type changed for "PetsError.body" from "ErrorBody | undefined" to "ErrorBodyWithCode | undefined"
      hint: Schema "ErrorBodyWithCode" looks like "ErrorBody" with additional fields. Consider adding the new fields to "ErrorBody" instead of forking a new schema — forking forces a breaking type-name change in typed SDKs, while extending the existing schema is additive.
```

A text that names no single type is not looked up, with or without an optional spelling, and a retype there stays `breaking`: a union of several types (`A | B`, `A | B | null`), a generic with several arguments (`Record<string, X>`), a nested array or generic (`X[][]`, `Promise<X[]>`), an object or function type.

The lookup reads the name only; it does not compare what stands around it. A retype that also adds or drops an optional spelling (`ErrorBody` → `ErrorBodyWithCode | null`) is found the same way. A change of the spelling alone (`ErrorBody` → `ErrorBody | null`) names the same type on both sides, so it is an ordinary `field_type_changed` and stays `breaking`.

### Example: schema fork

A path's response `$ref` is redirected from `MembershipBaseList` to a brand-new `MembershipBaseWithUserList` whose only difference is an added `user` field. The differ reports a `return_type_changed` (soft-risk) for the affected method, plus the remediation hint pointing the spec author at the additive alternative.

If the upstream fix can't land in time, `transformSpec` is the local escape hatch — see [`transformSpec` — Pre-IR Spec Overlay](../advanced/transform-spec.md).

### Adding new patterns

Detection rules live in `detectForkedSchemas` (`src/compat/differ.ts`). To add a rule:

1. Add a heuristic that examines the existing `changes` list plus the baseline/candidate snapshots.
2. When the pattern matches, set `change.remediation` on the relevant existing change. Don't introduce a new change for the same pattern — pile remediation onto what's already classified.
3. Keep the rule scoped: it should match a recognizable upstream antipattern, not generic shape changes.
