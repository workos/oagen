# Compatibility IR

The compatibility IR defines the types used to represent, diff, and classify SDK public API surfaces.

## CompatSnapshot

A full snapshot of an SDK's public API surface.

```ts
interface CompatSnapshot {
  schemaVersion: string;
  source: {
    specSha?: string;
    extractedAt: string;
  };
  policies: CompatPolicyHints;
  symbols: CompatSymbol[];
}
```

## CompatSymbol

A single public API symbol.

```ts
interface CompatSymbol {
  id: string;
  kind: CompatSymbolKind;
  fqName: string;
  ownerFqName?: string;
  displayName: string;
  visibility: "public" | "protected" | "internal";
  stability: "stable" | "unstable" | "deprecated";
  sourceKind: CompatSourceKind;
  operationId?: string;
  schemaName?: string;
  route?: { method: string; path: string };
  parameters?: CompatParameter[];
  returns?: CompatTypeRef;
  typeRef?: CompatTypeRef; // a field's or a property's type
  value?: string | number; // an enum member's value
  isStatic?: boolean; // a callable
  optional?: boolean; // a field: may a caller leave it out
  extends?: string[]; // a type whose members are recorded: its supertypes
  hasUnlistedMembers?: boolean; // such a type: may a value carry more than its fields
  aliasOf?: string; // a type alias: the type text it stands for
  sourceFile?: string;
}
```

### Symbol Kinds

| Kind               | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `service_accessor` | A service class (e.g., `UserManagement`)                            |
| `callable`         | A method on a service class                                         |
| `constructor`      | A constructor/initializer                                           |
| `field`            | A field on an interface/model, or a member of an object-type alias  |
| `property`         | A property on a class                                               |
| `enum`             | An enum type                                                        |
| `enum_member`      | A member of an enum                                                 |
| `alias`            | An interface, a model class or a type alias (the type's own symbol) |

### Source Kinds

| Source Kind                      | Description                      |
| -------------------------------- | -------------------------------- |
| `generated_service_wrapper`      | Generated from an API service    |
| `generated_model_constructor`    | Generated model constructor      |
| `generated_resource_constructor` | Generated resource constructor   |
| `generated_enum`                 | Generated from an enum schema    |
| `compat_alias`                   | Added for backward compatibility |

### Types and Their Members

A type is a symbol other symbols name as their owner (`ownerFqName`). An interface, a model class and a type alias are each an `alias` symbol; a service class is a `service_accessor`. Four keys say what the snapshot keeps about a type, beside its name:

| Key                  | On                                | Holds                                                                                                        |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `optional`           | a `field`                         | whether a caller that builds the owning type may leave the field out (`false`: it must be supplied)          |
| `extends`            | a type whose members are recorded | the supertypes its declaration names, as written; `[]` when it names none                                    |
| `hasUnlistedMembers` | a type whose members are recorded | whether a value may carry members no `field` lists; `false` when the extractor looked and the fields are all |
| `aliasOf`            | a type alias                      | the type text the alias stands for, as the extractor recorded it                                             |

Each is left out where it does not apply or is not known, never written as `null`.

**Members.** An interface's fields, a model class's fields and the members of a type alias that names an object shape are all `field` symbols under the type, each with its `typeRef` and its `optional`:

```ts
export interface UpdatePetOptions {
  name?: string;
  ownerId: string;
}
export type CreatePetOptions = { name: string; ownerId: string };
```

```jsonc
{ "id": "iface:UpdatePetOptions", "kind": "alias", "extends": [], "hasUnlistedMembers": false }
{ "id": "field:UpdatePetOptions.name", "kind": "field", "typeRef": { "name": "string" }, "optional": true }
{ "id": "field:UpdatePetOptions.ownerId", "kind": "field", "typeRef": { "name": "string" }, "optional": false }
{ "id": "alias:CreatePetOptions", "kind": "alias", "extends": [], "hasUnlistedMembers": false, "aliasOf": "{ name: string; ownerId: string; }" }
{ "id": "field:CreatePetOptions.name", "kind": "field", "typeRef": { "name": "string" }, "optional": false }
{ "id": "field:CreatePetOptions.ownerId", "kind": "field", "typeRef": { "name": "string" }, "optional": false }
```

The `nodeExtractor` records members for an alias whose declared type is one object shape of its own: an object type (`{ name: string }`), what a mapped type comes to (`Omit<Pet, 'id'>`, `Partial<Options>`, `Record<'a' | 'b', string>`, an instantiation of a generic object alias) and an intersection of object types (`Base & { name: string }`). The members are every member the checker resolves for the alias, an intersection's named types' members included, as an interface's fields include the ones it inherits. Each is read off the resolved member and off none of its declarations: its optionality (every member of a `Partial<…>` is optional; `a` in `{ a?: string } & { a: string | undefined }` is required) and its type text, which is the checker's less the `undefined` that optionality itself adds. Without `exactOptionalPropertyTypes`, `a?: string` and `a?: string | undefined` are one type and both are recorded as an optional `string`; with it, the second is recorded as `string | undefined`, since it accepts a value the first does not. So two aliases that `tsc` finds assignable to each other record the same members, however each is written: `{ a: string | undefined }` and `{ a?: string } & { a: string | undefined }`, `{ a?: string }` and `Partial<{ a: string }>`, `{ a: string }` and `Partial<{ a: string }> & Required<{ a?: string }>`. (An interface's field keeps the type text it has always had, decided by the `?` of its property signature, because every baseline holds it so: a member inherited through `Partial<…>` and an optional method keep their `| undefined` there.) Any other alias is its symbol alone, with `aliasOf` and no `extends`: a union, a primitive, a function or tuple type, an instantiation of an interface or a class (`Promise<Pet>`, `Pet[]`), and another declared type under a second name (`type Old = New`). Such a symbol says nothing about the type's members; it does not say there are none. The other extractors record every alias that way.

**Optionality.** `optional` is what the extractor's surface states (`ApiField.optional`), and each extractor reads it from what its language writes:

| Extractor | `optional: false` when                                                             | No `optional` at all on                                                                     |
| --------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| node      | the member has no `?` (a property or a method) and no mapped type made it optional | a class's properties                                                                        |
| python    | a model's, a dataclass's or an annotated class's field has no default              | the keys of a `TypedDict`, and of a class that extends one                                  |
| php       | a promoted constructor property has no default                                     | a class with a property declared in its body, a PHP `interface`'s methods, a resource class |
| go        | the struct tag has no `omitempty` (an embedded struct is such a field)             | —                                                                                           |
| kotlin    | the property is not nullable and has no default                                    | —                                                                                           |
| dotnet    | the property's type is not nullable (`T?`)                                         | —                                                                                           |
| rust      | the field is not an `Option<…>`                                                    | —                                                                                           |
| ios       | the property's type is not optional (`T?`)                                         | —                                                                                           |
| elixir    | the struct's `@type t` does not give the key `\| nil`                              | a struct with no `@type t`                                                                  |
| ruby      | (the surface has no fields)                                                        | —                                                                                           |

Where the surface cannot tell which fields may be left out and would only write a placeholder (`ApiInterface.fieldOptionalityUnknown`), the snapshot records no `optional` for them: `NotRequired[…]` and `total=False` decide a `TypedDict`'s keys, and a PHP property declared in the class body says nothing about the constructor.

**Supertypes.** `extends` is what the surface states (`ApiInterface.extends`, `ApiTypeAlias.extends`): the `extends` of a TypeScript interface, the types an intersection alias is written with, a PHP class's base, and a Python model's base once the extractor is told what a model is (`hints.modelBaseClasses`). The other surfaces read no supertype, and their types carry `extends: []`; a class (`service_accessor`) carries none.

**Members the fields do not list.** A value of a type may carry more than its named members: an index signature takes any key (`[key: string]: unknown`, what `Record<string, string>` comes to), a call or a construct signature makes the value a function. `hasUnlistedMembers` says whether the type has any of these, its own or inherited, as the surface states it (`ApiInterface.hasUnlistedMembers`, `ApiTypeAlias.hasUnlistedMembers`). The `nodeExtractor` asks the type checker and writes it on every interface and every alias with members, `true` or `false`; for an alias it is also `true` when a member was left out of the fields (one keyed by a symbol, a private member of a class an intersection takes in). The other extractors do not look and write no key. The differ reads it for one thing: a parameter retyped from one object type to another is weighed field by field only when both say `false` (see [Compatibility Policy → A parameter retyped to a type that takes every old argument](compatibility-policy.md#a-parameter-retyped-to-a-type-that-takes-every-old-argument)). A change of it is not reported.

**Which types callers build.** A snapshot records no direction, so the differ tells one this way: a type is one callers build when it is reachable from the type of a parameter of a callable or a constructor, through the types of its members, its supertypes and the text a type alias stands for. Each type text is read for every name it mentions (a union's members, an array's element, a generic's arguments), except the argument of `Partial<…>` and `Pick<…>`, which take the required members off it. A type that is both taken and returned counts as taken. The types are read from the baseline: the callers that exist today call its callables. Where `oagen verify` compares a baseline scoped to what the spec derives (`--scope spec-only`), which of the compared types callers build is read from the whole baseline (a method the scope leaves out still takes its options), and so is which fields the SDK already has: a field the scope leaves out of the comparison is not taken for one the candidate added. A type the scope leaves out stays outside the check, whoever takes it. An extractor that records no parameter types (Elixir's and Ruby's record each as `any` or `Object`) names no type a callable takes, so no field is reported as newly required there.

**Snapshots written before these keys.** `schemaVersion` stays `"1"`: every key above is optional, and a reader that does not know one ignores it. The differ reads each only where it is defined. A baseline without `optional` cannot show a field that became required; a baseline without `extends` credits no supertype (the candidate's own `extends` is what a retype is judged by); a type without `hasUnlistedMembers` is not weighed field by field. The same holds for `policies.parameterTypesAreStructural`: a baseline whose `policies` lack it has every retyped parameter reported as it was before the key existed. The members of a type alias are compared only when both snapshots record them: against an alias the other snapshot records by name alone, they are neither added nor removed, so a baseline written before aliases carried members reports nothing new against a candidate extracted from the same sources.

## CompatParameter

```ts
interface CompatParameter {
  publicName: string;
  wireName?: string;
  position: number;
  required: boolean;
  nullable: boolean;
  hasDefault: boolean;
  passing: CompatPassingStyle;
  type: CompatTypeRef;
  sensitivity: ParameterSensitivity;
}
```

### Passing Styles

| Style                   | Description             | Languages                      |
| ----------------------- | ----------------------- | ------------------------------ |
| `positional`            | Position-only arguments | Go, Rust                       |
| `keyword`               | Keyword arguments       | Python, Ruby, Elixir           |
| `named`                 | Named arguments         | PHP, Kotlin, C#                |
| `keyword_or_positional` | Either style            | Python (positional-or-keyword) |
| `options_object`        | Object destructuring    | Node/TypeScript                |
| `builder`               | Builder pattern         | Java-style                     |

### Parameter Sensitivity

```ts
interface ParameterSensitivity {
  order: boolean; // Position changes are breaking
  publicName: boolean; // Name changes are breaking
  requiredness: boolean; // Requiredness changes are breaking
  type: boolean; // Type changes are breaking
}
```

## Change Categories

### Breaking

| Category                                       | Description                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `symbol_removed`                               | A public symbol was removed                                                                 |
| `symbol_renamed`                               | A public symbol was renamed                                                                 |
| `parameter_removed`                            | A parameter was removed                                                                     |
| `parameter_renamed`                            | A parameter was renamed                                                                     |
| `parameter_requiredness_increased`             | Optional → required                                                                         |
| `parameter_type_narrowed`                      | Parameter type changed (soft-risk when the new type takes every value of the old one)       |
| `parameter_position_changed_order_sensitive`   | Parameter moved in order-sensitive language                                                 |
| `constructor_position_changed_order_sensitive` | Constructor param moved in order-sensitive language                                         |
| `named_arg_name_removed`                       | Named argument removed                                                                      |
| `keyword_name_removed`                         | Keyword argument removed                                                                    |
| `overload_removed`                             | Method overload removed                                                                     |
| `union_wrapper_migration_without_compat_alias` | Union wrapper migration without backward compat                                             |
| `field_requiredness_increased`                 | A type callers build gained a required field, or one of its fields went optional → required |

`parameter_type_narrowed` is reported for any parameter whose type text changed, whichever way. It keeps its category and is downgraded to `soft-risk`, with a hint, when the new type accepts every value of the old one: see [Compatibility Policy → A parameter retyped to a type that takes every old argument](compatibility-policy.md#a-parameter-retyped-to-a-type-that-takes-every-old-argument).

`field_requiredness_increased` is the counterpart of `parameter_requiredness_increased` for the members of the types a callable takes (see [Which types callers build](#types-and-their-members)): an options object's fields are its parameters in all but name. It replaces the `symbol_added` such a field was reported as; a field is never reported as both. `new.takenBy` names the callable or constructor whose parameters lead to the type.

```
[field_requiredness_increased] UpdatePetOptions.ownerId — Required field "ownerId" added to "UpdatePetOptions", which callers of "PetsClient.update" pass in
```

A required field added to a type no callable takes, and an optional field added anywhere, stays an additive `symbol_added`. Every other change of a field's optionality (required → optional, and optional → required on a type no callable takes) is not reported.

### Soft-Risk

| Category                                              | Description                                      |
| ----------------------------------------------------- | ------------------------------------------------ |
| `parameter_added_non_terminal_optional`               | Optional param added (not at end)                |
| `constructor_reordered_named_friendly`                | Constructor reordered in named-friendly language |
| `default_value_changed`                               | Default value changed                            |
| `wrapper_stricter_than_previous_sdk_but_matches_spec` | Stricter but spec-correct                        |
| `doc_surface_drift`                                   | Documentation-only drift                         |

### Additive

| Category                            | Description                 |
| ----------------------------------- | --------------------------- |
| `symbol_added`                      | New symbol added            |
| `parameter_added_optional_terminal` | Optional param added at end |
| `new_constructor_overload_added`    | New constructor overload    |
| `new_wrapper_alias_added`           | New compatibility alias     |

## Provenance Buckets

Every classified change includes a provenance field explaining the source of drift:

| Provenance                | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `spec_shape_change`       | The OpenAPI spec changed shape                 |
| `spec_ordering_change`    | The spec changed property ordering             |
| `emitter_template_change` | The emitter template was modified              |
| `compat_extractor_change` | The extractor logic changed                    |
| `operation_hint_change`   | An operation hint changed                      |
| `manual_override_change`  | A manual override was applied                  |
| `normalization_change`    | Naming normalization produced different output |
| `unknown`                 | Source not determined                          |

## Extracting Snapshots

Every extractor implements `extractSnapshot()`, which returns a `CompatSnapshot` directly:

```ts
const extractor = getExtractor("node");
const snapshot: CompatSnapshot = await extractor.extractSnapshot(sdkPath);
```

This is the primary method used by `oagen compat-extract`. Internally, extractors call `extract()` to produce an `ApiSurface`, then convert it to a `CompatSnapshot` via the bridge function.

### Extractor Interface

```ts
interface Extractor {
  language: string;
  extract(sdkPath: string): Promise<ApiSurface>;
  extractSnapshot(sdkPath: string): Promise<CompatSnapshot>;
  hints: LanguageHints;
}
```

Both `extract()` and `extractSnapshot()` are available. Use `extractSnapshot()` for the compat pipeline. Use `extract()` when you need the raw `ApiSurface` for overlay or legacy workflows.

### Spec Enrichment

When `oagen compat-extract` receives `--spec`, it enriches callable symbols with spec-derived metadata:

- **`operationId`** — the operation name from the spec, matched by the class and method name `generate` writes the operation as: the mount target and resolved method name under the config's `operationHints`, `mountRules` and `operationNaming` (any casing), then the IR's operation name on the mount target, then the IR's service + operation name
- **`route`** — the HTTP method and path (e.g., `{ method: "POST", path: "/users" }`)
- **`source.specSha`** — SHA-256 of the spec file

This enrichment happens after extraction, as a post-step in the CLI. Extractors themselves don't need spec awareness.

### Bridge: ApiSurface → CompatSnapshot

The `apiSurfaceToSnapshot()` function converts an `ApiSurface` to a `CompatSnapshot`, applying language-appropriate passing styles and sensitivity flags. This is what `extractSnapshot()` uses internally. It keeps what the surface states about each type (see [Types and Their Members](#types-and-their-members)): a field's `optional`, an interface's `extends` and `hasUnlistedMembers`, a type alias's `value` as `aliasOf`, and an alias's `fields` as `field` symbols. The snapshot's `policies` are the language's defaults (see [Compatibility Policy → Language Policy](compatibility-policy.md#language-policy)), `parameterTypesAreStructural` among them.

```ts
import { apiSurfaceToSnapshot } from "@workos/oagen";

const surface: ApiSurface = await extractor.extract(sdkPath);
const snapshot: CompatSnapshot = apiSurfaceToSnapshot(surface);
```
