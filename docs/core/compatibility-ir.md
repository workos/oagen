# Compatibility IR

The compatibility IR defines the types used to represent, diff, and classify SDK public API surfaces.

## CompatSnapshot

A full snapshot of an SDK's public API surface.

```ts
interface CompatSnapshot {
  schemaVersion: string;
  language: LanguageId;
  sdkName: string;
  source: {
    specSha?: string;
    emitterSha?: string;
    configSha?: string;
    extractedAt: string;
  };
  extractor: {
    name: string;
    version?: string;
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
  visibility: 'public' | 'protected' | 'internal';
  stability: 'stable' | 'unstable' | 'deprecated';
  sourceKind: CompatSourceKind;
  operationId?: string;
  schemaName?: string;
  route?: { method: string; path: string };
  parameters?: CompatParameter[];
  returns?: CompatTypeRef;
}
```

### Symbol Kinds

| Kind | Description |
|------|-------------|
| `service_accessor` | A service class (e.g., `UserManagement`) |
| `callable` | A method on a service class |
| `constructor` | A constructor/initializer |
| `field` | A field on an interface/model |
| `property` | A property on a class |
| `enum` | An enum type |
| `enum_member` | A member of an enum |
| `alias` | A type alias or interface name |

### Source Kinds

| Source Kind | Description |
|-------------|-------------|
| `generated_service_wrapper` | Generated from an API service |
| `generated_model_constructor` | Generated model constructor |
| `generated_resource_constructor` | Generated resource constructor |
| `generated_enum` | Generated from an enum schema |
| `compat_alias` | Added for backward compatibility |

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

| Style | Description | Languages |
|-------|-------------|-----------|
| `positional` | Position-only arguments | Go, Rust |
| `keyword` | Keyword arguments | Python, Ruby, Elixir |
| `named` | Named arguments | PHP, Kotlin, C# |
| `keyword_or_positional` | Either style | Python (positional-or-keyword) |
| `options_object` | Object destructuring | Node/TypeScript |
| `builder` | Builder pattern | Java-style |

### Parameter Sensitivity

```ts
interface ParameterSensitivity {
  order: boolean;       // Position changes are breaking
  publicName: boolean;  // Name changes are breaking
  requiredness: boolean; // Requiredness changes are breaking
  type: boolean;        // Type changes are breaking
}
```

## Change Categories

### Breaking

| Category | Description |
|----------|-------------|
| `symbol_removed` | A public symbol was removed |
| `symbol_renamed` | A public symbol was renamed |
| `parameter_removed` | A parameter was removed |
| `parameter_renamed` | A parameter was renamed |
| `parameter_requiredness_increased` | Optional → required |
| `parameter_type_narrowed` | Parameter type changed |
| `parameter_position_changed_order_sensitive` | Parameter moved in order-sensitive language |
| `constructor_position_changed_order_sensitive` | Constructor param moved in order-sensitive language |
| `named_arg_name_removed` | Named argument removed |
| `keyword_name_removed` | Keyword argument removed |
| `overload_removed` | Method overload removed |
| `union_wrapper_migration_without_compat_alias` | Union wrapper migration without backward compat |

### Soft-Risk

| Category | Description |
|----------|-------------|
| `parameter_added_non_terminal_optional` | Optional param added (not at end) |
| `constructor_reordered_named_friendly` | Constructor reordered in named-friendly language |
| `default_value_changed` | Default value changed |
| `wrapper_stricter_than_previous_sdk_but_matches_spec` | Stricter but spec-correct |
| `doc_surface_drift` | Documentation-only drift |

### Additive

| Category | Description |
|----------|-------------|
| `symbol_added` | New symbol added |
| `parameter_added_optional_terminal` | Optional param added at end |
| `new_constructor_overload_added` | New constructor overload |
| `new_wrapper_alias_added` | New compatibility alias |

## Provenance Buckets

Every classified change includes a provenance field explaining the source of drift:

| Provenance | Description |
|-----------|-------------|
| `spec_shape_change` | The OpenAPI spec changed shape |
| `spec_ordering_change` | The spec changed property ordering |
| `emitter_template_change` | The emitter template was modified |
| `compat_extractor_change` | The extractor logic changed |
| `operation_hint_change` | An operation hint changed |
| `manual_override_change` | A manual override was applied |
| `normalization_change` | Naming normalization produced different output |
| `unknown` | Source not determined |

## Extracting Snapshots

Every extractor implements `extractSnapshot()`, which returns a `CompatSnapshot` directly:

```ts
const extractor = getExtractor('node');
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

### Bridge: ApiSurface → CompatSnapshot

The `apiSurfaceToSnapshot()` function converts an `ApiSurface` to a `CompatSnapshot`, applying language-appropriate passing styles and sensitivity flags. This is what `extractSnapshot()` uses internally.

```ts
import { apiSurfaceToSnapshot } from '@workos/oagen';

const surface: ApiSurface = await extractor.extract(sdkPath);
const snapshot: CompatSnapshot = apiSurfaceToSnapshot(surface);
```
