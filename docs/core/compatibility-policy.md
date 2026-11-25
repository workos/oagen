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

| Language | Caller Uses Param Names | Constructor Order | Param Names Public | Overloads Public | Arity Public | Param Types Structural |
| -------- | ----------------------- | ----------------- | ------------------ | ---------------- | ------------ | ---------------------- |
| PHP      | yes                     | yes               | yes                | no               | no           | no                     |
| Python   | yes                     | yes               | yes                | no               | no           | no                     |
| Ruby     | yes                     | yes               | yes                | no               | no           | no                     |
| Go       | no                      | yes               | no                 | no               | yes          | no                     |
| Kotlin   | yes                     | no                | yes                | yes              | no           | no                     |
| .NET     | yes                     | no                | yes                | yes              | no           | no                     |
| Elixir   | yes                     | no                | yes                | no               | yes          | no                     |
| Rust     | no                      | yes               | no                 | no               | yes          | no                     |
| Node     | no                      | no                | no                 | no               | no           | yes                    |

`parameterTypesAreStructural` says how a value is accepted for a parameter: by its shape (TypeScript takes any value with the members the type asks for, written in place as an object literal if the caller likes) or by the type it was declared as (a class). It decides which rule finds a retyped parameter to still take every argument callers pass; see [A parameter retyped to a type that takes every old argument](#a-parameter-retyped-to-a-type-that-takes-every-old-argument). Unlike the other hints it may be absent: a snapshot written before the key existed does not carry it in its `policies`, and a policy that does not state it asks neither rule.

### Overriding Language Defaults

Use `languagePolicy` only when a specific SDK intentionally diverges from language norms:

```ts
compat: {
  languagePolicy: {
    node: {
      // This Node SDK uses positional args, not options objects
      methodParameterNamesArePublicApi: true,
      // Its options are classes callers construct, not object literals
      parameterTypesAreStructural: false,
    },
  },
}
```

Setting `parameterTypesAreStructural` to `true` for another language asks the shape rule of that language's type texts in place of the declared one: a union written with `|` is read (`string|int`), and two object types are compared field by field only where the extractor says the fields are all a value may carry (`hasUnlistedMembers`), which the `nodeExtractor` alone does.

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

| Pattern                     | Trigger                                                                                                                                                                                   | Hint                                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema fork**             | A `return_type_changed` or `field_type_changed` where the new type was newly added in the candidate snapshot _and_ its field set is a non-strict superset of the prior type's field set.  | "Schema `NewType` looks like `OldType` with additional fields. Consider adding the new fields to `OldType` instead of forking a new schema." Forking forces a breaking type-name change in typed SDKs; extending the existing schema is additive. |
| **Declared subtype**        | A `return_type_changed` or `field_type_changed` where the candidate declares that the new type extends the old one, directly or through the types it extends.                             | "Field type swap from `OldType` to `NewType` narrows to a declared subtype." Code that reads the value continues to work; only code that produces one has to supply the new type.                                                                 |
| **Accepted parameter type** | A `parameter_type_narrowed` where the new type accepts every value of the old one: by its members where the language's parameter types are structural, by a declared supertype elsewhere. | "Parameter type swap from `OldType` to `NewType` accepts every argument callers pass today." Call sites continue to compile; only code that names the old type explicitly may want the new one.                                                   |

A schema fork is reported as `soft-risk`, not `breaking`: the new type has every field a caller read on the old one, so only an explicit annotation with the old type's name has to move. A retype to a type that already existed, or to one that drops a field, stays `breaking` and gets no hint, unless the new type is a declared subtype of the old one.

A retype to a declared subtype is `soft-risk` as well, whether or not the new type is new: `DetailedErrorBody extends ErrorBody` says every `DetailedErrorBody` is an `ErrorBody`. The declaration is read from the candidate snapshot's `extends` (see [Compatibility IR → Types and Their Members](compatibility-ir.md#types-and-their-members)), by name: an interface's `extends`, the types an intersection alias is written with, a model class's base. Two types with the same fields are not related by it, and neither is a type that extends an instantiation (`extends Partial<ErrorBody>`, `extends Box<ErrorBody>`). The retype has to narrow the type and do nothing else: the two type texts are one text with the name swapped (`ErrorBody[] | undefined` → `DetailedErrorBody[] | undefined`), so `ErrorBody` → `DetailedErrorBody[]` and `ErrorBody` → `DetailedErrorBody | undefined` stay `breaking`. So does a retype under a generic that may take its argument: `Sink<ErrorBody>` → `Sink<DetailedErrorBody>` narrows what `Sink<T>.accept(value: T)` takes, and nothing in a type text or in the snapshot says how a generic uses its argument. The name is read through a generic only when it is one known to hand its argument back, a promise (`Promise<T>`, `PromiseLike<T>`, `Awaitable[T]`) or a collection (`Array<T>`, `Set<T>`, `Iterable<T>`, `list[T]`, `Sequence[T]`), and the SDK declares no type of that name itself. It holds for a position callers read: a return, and a field of a type no callable takes. A field of a type callers build keeps its severity, since the subtype may ask for more than the value they pass today. A parameter is asked the reverse question, below.

```
Compat report:
  0 breaking, 1 soft-risk, 0 additive

  Soft-risk:
    [field_type_changed] PetsError.body — Type changed for "PetsError.body" from "ErrorBody" to "DetailedErrorBody"
      hint: Field type swap from "ErrorBody" to "DetailedErrorBody" narrows to a declared subtype — "DetailedErrorBody" extends "ErrorBody", so every value of the new type is still a value of the old one. Code that reads the value continues to work; only code that produces one (a test double, an override) has to supply "DetailedErrorBody".
```

### A parameter retyped to a type that takes every old argument

`parameter_type_narrowed` is reported for every parameter whose type text changed, whichever way. It is `soft-risk` when the new type accepts every value of the old one, since no call site then stops compiling, and `breaking` otherwise. The category does not change.

This is the reverse of what a field or a return is asked. A value callers read may narrow to a subtype: what they get is still what they expected. A value callers pass may widen to a supertype, or to a shape that takes more: what they give is still taken.

```
Compat report:
  0 breaking, 1 soft-risk, 3 additive

  Soft-risk:
    [parameter_type_narrowed] PetsClient.get — Parameter type changed for "options" on "PetsClient.get"
      hint: Parameter type swap from "RequestOptions | undefined" to "RetryRequestOptions | undefined" accepts every argument callers pass today — "RetryRequestOptions" keeps every field of "RequestOptions" and requires none that "RequestOptions" did not. Call sites continue to compile; only code that names "RequestOptions" explicitly may want the new type.
```

Which rule decides is the policy's `parameterTypesAreStructural`.

**By shape, where it is `true` (Node).** Both type texts are read as unions, a text that is no union as a union of one, and each member of the old union has to be accepted by a member of the new one. A member accepts another when it is

- the same text;
- an array, or a generic known to hand its argument back, of a type that accepts the old one's: `Old[]` → `New[]`, `Promise<Old>` → `Promise<New>`, `Set<Old>` → `Set<New>`. The generics are the ones a narrowed field or return is read through (a promise, a collection; see [above](#detected-patterns)), on the same condition that the SDK declares no type of that name itself. A `readonly` array takes a writable one (`Old[]` → `readonly New[]`), and a writable array does not take a `readonly` one;
- an object type that keeps the old one's fields, each of the two declared (an interface, an object type alias) or written in place (`{ timeout?: number }`). It keeps them when it
  - has every field of the old type. A caller may write any of them in an object literal at the call site, and TypeScript refuses a literal that names a field the parameter's type does not have (TS2353), though it would take the same value from a variable;
  - gives each a type that accepts the old field's, which is this same question asked of the two field types, or the candidate declares that the old type extends the new one, which a compiler has then checked field by field;
  - requires no field the old type did not require.

  A field's type is weighed as it stands, with one exception for the `undefined` of an optional field. Under `exactOptionalPropertyTypes` an optional `name?: string | undefined` takes a value an optional `name?: string` does not, and a type alias's members are recorded apart there, so between two type aliases, or object types written in place, it is a member like any other. An interface's optional field is recorded with or without it by where its `?` is written, whatever the SDK meant (see [Compatibility IR → Types and Their Members](compatibility-ir.md#types-and-their-members)), so where either type is an interface it is left out of two optional fields, as it is when the same field is compared across the two snapshots. An object type written in place is printed with `| undefined` on each optional member unless the SDK is compiled with that option, and nothing in its text says which: `options: { timeout?: number }` → an interface `RequestOptions` is `soft-risk`, → a type alias `RequestOptions` stays `breaking`.

A type alias the snapshot records by its text (`type PetId = string | number`) is read as that text, on either side.

So the new type may add optional fields, make required fields optional, widen a field's type and add members to a union, and `string` → `string | number`, `T` → `T | null` and a required parameter made optional (`T` → `T | undefined`) are all `soft-risk`. Nothing else is read into, and each of these is accepted as the same text only: any other generic's argument (`Sink<Old>` → `Sink<New>`, `Record<string, Old>` → `Record<string, New>`, since whether a `Sink<Old>` is taken where a `Sink<New>` is expected depends on how `Sink` uses its argument), a tuple, a function type, a literal its primitive would take (`'asc'` → `string`) and `unknown`.

**By declaration, where it is `false` (every other language).** The old type declares, directly or through the types it extends, that it extends the new one, as the candidate's `extends` records it (a PHP class's base, a Python model's base under `hints.modelBaseClasses`), and the retype does nothing else: both texts are one type's name under the same optional spelling and at most one array suffix (`?RetryOptions` → `?BaseOptions`). Two classes with the same fields are not related by it, and a generic's argument is not read: a Python `list[RetryOptions]` is no `list[BaseOptions]`, since a list is written to as well as read.

| A parameter retyped from → to                                                                                 | Node      | PHP, Python models |
| ------------------------------------------------------------------------------------------------------------- | --------- | ------------------ |
| a type → one that extends it and adds an optional field (`RequestOptions` → `RetryRequestOptions`)            | soft-risk | breaking           |
| a type → one that extends it and adds a required field                                                        | breaking  | breaking           |
| a type → one it extends (`RetryOptions` → `BaseOptions`), where the old type has a field of its own           | breaking  | soft-risk          |
| a type → one it extends, where the old type adds no field                                                     | soft-risk | soft-risk          |
| a type → an unrelated one with the same fields, or with those and optional ones more                          | soft-risk | breaking           |
| a type → one where a field is now optional, or a field's type is wider                                        | soft-risk | breaking           |
| a type → one where a field is now required, is retyped to a type that does not take the old one's, or is gone | breaking  | breaking           |
| `string` → `string \| number`, `T` → `T \| null`, a required parameter made optional                          | soft-risk | breaking           |
| `string \| number` → `string`, `T \| null` → `T \| undefined`, an optional parameter made required            | breaking  | breaking           |
| `Old[]` → `New[]`, `Promise<Old>` → `Promise<New>`, where `New` takes every `Old`                             | soft-risk | breaking           |
| `Old` → `New[]`, `Old` → `Promise<New>`, `Sink<Old>` → `Sink<New>`                                            | breaking  | breaking           |

The right column holds where the surface records the old type with its supertype: a PHP class with a public property of its own (one that declares none is recorded as a plain class, without a base, and its retype stays `breaking`), a Python model under `hints.modelBaseClasses`. The other extractors record no supertype, so every row is `breaking` there. The row of arrays and promises is Python's `list[RetryOptions]` → `list[BaseOptions]` in that column; PHP has no typed arrays.

The third row is the one where the two kinds of language part. A PHP caller passes a `RetryOptions` it built, which is a `BaseOptions`. A TypeScript caller may write `get(id, { maxRetries: 2 })`, and `BaseOptions` has no `maxRetries`: the declaration says nothing a literal can use, so the new type has to keep every field there as well.

The old type is read from both snapshots. A value callers pass today is a value of the type as the baseline declares it, and the code that names the type will be compiled against the candidate's declaration of it; the retype is `soft-risk` only when the new type accepts both. A type alias the candidate widens to `string | number` while the parameter moves from the alias to `string` is `breaking` for that reason.

Where the snapshots do not say, the retype stays `breaking`:

- the policy does not state `parameterTypesAreStructural`, as in every snapshot written before the key existed;
- a type is not declared in the snapshot (another package's, a generic's instantiation), or is a class, whose properties carry no optionality;
- a type's fields are not all a value may carry: it has an index signature or a call signature, or the extractor does not say (`hasUnlistedMembers`, see [Compatibility IR → Types and Their Members](compatibility-ir.md#types-and-their-members));
- a field's optionality is not recorded, or a type extends something the snapshot does not record the same way (`extends Partial<Base>`);
- the old type has no fields, so it takes any object and does not say what callers pass;
- the extractor cut a type text short (`"a" | "b" | ... 12 more ... | "z"`): what it left out of the old type may be missing from the new one, so the cut member is accepted by nothing, the same text included;
- two types refer to themselves (`Tree.children: Tree[]` → `Tree2.children: Tree2[]`).

A parameter's old and new type are not recorded as a rename: the change of an unrelated field or return between the same two types is judged on its own.

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
