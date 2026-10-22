# CLI Reference

All commands support `--help` for full usage details.

## `oagen generate`

Generate SDK code from an OpenAPI spec.

```bash
oagen generate --spec openapi.yml --lang node --output ./sdk --namespace Acme
```

| Argument               | Required | Default                 | Description                                                                                                                                                                                              |
| ---------------------- | -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <path>`        | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file.                                                                                                                                                                        |
| `--lang <language>`    | Yes      |                         | Target language — must have a registered emitter (via `oagen.config.ts`)                                                                                                                                 |
| `--output <dir>`       | Yes      |                         | Directory to write generated files into                                                                                                                                                                  |
| `--namespace <name>`   | No       | Spec's `info.title`     | SDK namespace in PascalCase — used directly for code identifiers (e.g., `Acme::Client`) and converted to `snake_case` for file paths (e.g., `lib/acme/`). Use PascalCase with the exact casing you want. |
| `--dry-run`            | No       | `false`                 | Print the list of file paths that would be generated, without writing anything to disk                                                                                                                   |
| `--api-surface <path>` | No       |                         | Path to baseline API surface JSON for compat overlay                                                                                                                                                     |
| `--target <dir>`       | No       |                         | Target directory for live SDK integration — generated files are merged into this directory instead of `--output`                                                                                         |
| `--no-compat-check`    | No       | `false`                 | Skip compat overlay even if `--api-surface` is provided                                                                                                                                                  |

## `oagen diff`

Compare two OpenAPI specs and output a diff report as JSON. Use this to review what changed before regenerating.

An `operation-modified` change carries `serversChanged` (breaking) when the servers the operation is actually served from — its own `servers`, else the document's — changed: the two lists are matched on URL template and variables, ignoring descriptions, enum order and position, except that a reorder that moves the first entry's resolved URL counts. An operation that inherits the document's servers on both sides is not reported here even when the document's own list moved.

```bash
oagen diff --old v1.yml --new v2.yml
```

| Argument       | Required | Description                   |
| -------------- | -------- | ----------------------------- |
| `--old <path>` | Yes      | Path to the old/previous spec |
| `--new <path>` | Yes      | Path to the new/current spec  |

**Exit codes:** 0 = no changes, 1 = additive or modified changes, 2 = breaking changes.

### Change kinds

Every entry in `changes` carries a `kind` and a `classification` (`additive` or `breaking`). A `-modified` change also lists what changed inside it and is breaking when any of those is.

| `kind`               | Classification                                                                                                                             | Fields                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base-url-changed`   | breaking; additive when the old spec declared no server                                                                                    | `oldBaseUrl`, `newBaseUrl` (`''` for no server)                                                                                                                |
| `server-added`       | additive                                                                                                                                   | `url` (the template as written)                                                                                                                                |
| `server-removed`     | breaking                                                                                                                                   | `url`                                                                                                                                                          |
| `server-modified`    | from `variableChanges`                                                                                                                     | `url`, `variableChanges[]`                                                                                                                                     |
| `security-changed`   | breaking when a caller built for the old default — or a webhook handler, when a webhook inherits it — no longer passes; additive otherwise | `oldSecurity`, `newSecurity` (`[]` for none)                                                                                                                   |
| `model-added`        | additive                                                                                                                                   | `name`                                                                                                                                                         |
| `model-removed`      | breaking                                                                                                                                   | `name`                                                                                                                                                         |
| `model-modified`     | from `fieldChanges`                                                                                                                        | `name`, `fieldChanges[]`                                                                                                                                       |
| `enum-added`         | additive                                                                                                                                   | `name`                                                                                                                                                         |
| `enum-removed`       | breaking                                                                                                                                   | `name`                                                                                                                                                         |
| `enum-modified`      | from `valueChanges`                                                                                                                        | `name`, `valueChanges[]`                                                                                                                                       |
| `service-added`      | additive                                                                                                                                   | `name`                                                                                                                                                         |
| `service-removed`    | breaking                                                                                                                                   | `name`                                                                                                                                                         |
| `operation-added`    | additive                                                                                                                                   | `serviceName`, `operationName`                                                                                                                                 |
| `operation-removed`  | breaking                                                                                                                                   | `serviceName`, `operationName`                                                                                                                                 |
| `operation-modified` | from `paramChanges` and the `…Changed` flags                                                                                               | `serviceName`, `operationName`, `paramChanges[]`, `responseChanged`, `requestBodyChanged`, `pathChanged`, … (see `OperationModified` in `src/differ/types.ts`) |

**Servers.** `baseUrl` is `servers[0]` with its variables' defaults filled in, so `base-url-changed` is reported once whenever that resolved host differs: alongside whichever server change moved it, and on its own when the list was only reordered. Servers are matched on their `url` template, independent of position, so a changed template is a `server-removed` plus a `server-added`. A template declared more than once is matched as a multiset: its old and new entries pair up by the strongest signal available, each pass taking the first unmatched candidate in declaration order — identical variables first (so a reordered list, or one whose duplicates are unchanged, reports nothing), then the same variable defaults, then the same resolved URL, then position — and the surplus on either side is a `server-added` or a `server-removed`. Within a matched server, `variableChanges` lists each variable by name; descriptions are not compared.

| `variableChanges[].kind`      | Classification | Meaning                                                      |
| ----------------------------- | -------------- | ------------------------------------------------------------ |
| `variable-added`              | additive       | A client can now pick it                                     |
| `variable-removed`            | breaking       | A client can no longer pick it                               |
| `variable-default-changed`    | breaking       | The server's resolved URL moves (`oldDefault`, `newDefault`) |
| `variable-enum-added`         | breaking       | Any value was accepted; now only the listed ones are         |
| `variable-enum-removed`       | additive       | The restriction is lifted                                    |
| `variable-enum-value-added`   | additive       | `value` can now be picked                                    |
| `variable-enum-value-removed` | breaking       | `value` can no longer be picked                              |

**Deprecation.** A node becoming deprecated, or no longer being deprecated, is reported and is additive in either direction (nothing a caller compiles against changes): `deprecatedChanged: true` on an `operation-modified`, `model-modified`, `enum-modified` or `webhook-modified` change, with `oldDeprecated`/`newDeprecated` beside it, and a `param-deprecated-changed`, `field-deprecated-changed` or `value-deprecated-changed` entry — carrying the same two values and `details` reading `live → deprecated` or `deprecated → live` — in that change's `paramChanges` (an operation's or a webhook's), `fieldChanges` or `valueChanges`. A change whose only content is the flag is still reported (so the command exits 1), and a breaking change on the same node keeps the change breaking. Only `true` counts as deprecated: `false` and an absent key are the same thing. Each flip is also mirrored into `behaviorChanges` as a `deprecated-changed` entry naming the node (`operation`, `parameter`, `model`, `field`, `enum`, `enum-value`, `webhook` or `webhook-parameter`) and copying `oldDeprecated`/`newDeprecated` from the change, beside the `param-default-changed` entries that were already collected there.

**Security.** What a request must carry is compared on the document and on every operation and webhook. `ApiSpec.security` — the default every operation and webhook that declares none of its own inherits — differing between the two documents is one `security-changed` change, with `oldSecurity`/`newSecurity` beside it (`[]` when a document declares none; `security: []` and an undeclared list both mean no authentication). An operation or webhook that declares its own list on either side is compared on what it actually requires — its own list, else that document's — and reported with `securityChanged: true` on its `operation-modified` or `webhook-modified` change, with `oldSecurity`/`newSecurity` beside it; one that inherits on both sides is not reported again for a moved default. Lists are compared as sets of alternatives, each a set of schemes with scopes as sets, so order and repetition are not changes. The classification is read from the node's side of the wire. For an operation, a caller built for the old list must still satisfy the new one: breaking when some old alternative satisfies no new one (a scheme or scope now required, an alternative removed, an anonymous alternative withdrawn), additive otherwise (an alternative added, a scheme or scope no longer needed, authentication made optional). For a webhook, a handler built for the old list must still find what it checked for in whatever the sender now presents: breaking when some new alternative carries no old one (a credential the sender stops presenting, an alternative it may now use that the old list never offered), additive otherwise (a credential the sender starts carrying beside the old ones, an alternative withdrawn). The document-level change is read from the caller's side, and from the receiver's side as well when a webhook in either document inherits the default, breaking if either side breaks. A change whose only content is security is still reported, and a breaking change on the same node keeps the change breaking. Every security change is mirrored into `behaviorChanges` as a `security-changed` entry naming the node (`document`, `operation` or `webhook`), copying the two lists and carrying the security change's own classification, which stays additive when the owning change is breaking for another reason.

**Tags.** Operations are matched by name within a service, and the parser groups an operation into a service by the document's first tag entry (then the path-prefix split, see [Service naming](architecture/ir-types.md#service--operation)), so a `tags` edit is reported by where the operation ends up. When it stays in a service of the same name — any edit that leaves the first entry alone, a first tag respelled to the same service name (`pets` → `Pets`), or a first tag changed to one the split files back under the same path-named service — it is `tagsChanged: true` on the `operation-modified` change, with `oldTags`/`newTags` beside it (`[]` for none; the lists are compared in document order, so a reorder after the first entry counts). When the first entry moves it to a service of another name, there is no `operation-modified` to carry a flag: the diff reports the move, `operation-removed` from the old service (breaking) and `operation-added` to the new one (additive), or `service-removed` (breaking) and `service-added` (additive) when a service goes or comes with it — so swapping `['Pets', 'Store']` to `['Store', 'Pets']` on a document's only operation exits 2. A webhook belongs to no service, so every edit to its `tags` is `tagsChanged` on its `webhook-modified` change. `tagsChanged` is always additive: tags group and document a method and change nothing a caller compiles against. A change whose only content is such a tags edit is still reported (so the command exits 1), and tags are not mirrored into `behaviorChanges`.

**Parameters.** Parameters are matched by location and name — OpenAPI allows a path `id` beside a query `id` on one operation — and every `paramChanges` entry carries `paramLocation` (`path`, `query` or `header` on an operation; `header`, `query` or `cookie` on a webhook) to say which one it is about.

**Response media types.** An `operation-modified` change lists, per response entry both specs declare, the media types the new spec `added` (additive), `removed` (breaking) or `retyped` (breaking) under `responseContentTypeChanges`, keyed by `statusCode` or, for the `default` and range responses, by `fallback`. Media types are matched by essence — `type/subtype`, case folded, parameters stripped — the rule the parser types a body by, so `Text/HTML` is `text/html` and `application/problem+json; charset=utf-8` is `application/problem+json`: a key that only changed case, whitespace or `charset` is no change, and reordering the keys is none either. A pair whose parameters other than `charset` differ (`application/pdf; version=1.7` → `; version=2.0`, a `profile` on `application/ld+json`) is listed under `reparameterized` with both spellings, additive: the body is typed the same, but the parameter may select another representation, so the change stays visible without being called breaking. Parameters are read as RFC 9110 writes them — a `;` inside a quoted value does not end the parameter, backslash escapes are decoded, the quotes are not part of the value — and compared as name/value pairs with names case-folded, in any order (never as one joined string, so `title="report; version=2"` and `title=report; version=2` are different parameters). Each media type is reported as written in the spec that declares it. Two keys of one essence declared side by side (`application/json` beside `application/json; charset=utf-8`) stay two media types: each pairs, in this order of preference, with the key spelled the same way on the other side, else one of its essence with the same parameters other than `charset` (so `Application/YAML; version=1` is still `application/yaml; version=1` wherever it moved), else one of its essence whose body is the same shape (so a key that only edited a parameter finds its body), else the other side's next unpaired key of its essence in document order; one left over is added or removed. A model the parser mints for a secondary media type is named from the essence too (`GetReportApplicationYamlResponse` for `application/yaml` and for `application/yaml; charset=utf-8` alike), so a key that only respells itself keeps its model name and is not reported as retyped. `retyped` means the body's shape changed: two bodies that are both models are compared field by field through the two specs' models (nested models and enums included, documentation aside), not by name. So when a key declared beside another spelling of its essence edits a parameter (`application/yaml; version=1` → `application/yaml; version=3`), which renames the model the parser mints for it, the body is reported as `reparameterized` (additive) and not as `retyped`; the rename surfaces as `model-removed` + `model-added`, which is what the generated SDK actually loses and gains. A schema change under such a key is still `retyped`. The same holds for a secondary body on an error, `default` or range response.

**Request body media types.** The media types a request body may be sent as — the `content` keys of the Request Body Object, carried as `requestBodyContentTypes` / `requestBodyContents` — are compared the same way, while both specs declare a body (a body appearing or disappearing is `requestBodyChanged` alone). On an `operation-modified` change, `requestBodyContentTypesChanged: true` comes with `requestBodyContentTypeChange` listing the media types `added` (additive: callers can newly send it), `removed` (breaking: a representation callers could send is gone) and `retyped` (breaking; only ever a secondary media type, since the body `requestBody` is read from is `requestBodyChanged`'s). As for responses, `retyped` is decided by shape, not by name: a `<Op><MediaType>Request` model that a parameter edit on a sibling-distinguished key only renamed is not a retype and surfaces as `model-removed` + `model-added`, and a changed parameter other than `charset` is `reparameterized`, additive, on an operation and on a webhook alike (`details` reads `payload media type text/csv; version=1 → text/csv; version=2`). On a `webhook-modified` change the same comparison is read from the receiver's side and sets `requestBodyChanged` with `details` such as `payload media type text/csv added`, beside a `requestBodyContentTypeChange` with the lists: a media type the sender can newly use, or whose body changed shape, is breaking (the handler must decode it); one it can no longer use is additive.

## `oagen extract`

Extract the public API surface from an existing SDK. Produces a JSON file used as input for compat overlay and verification.

```bash
oagen extract --sdk-path ./existing-sdk --lang ruby --output ./sdk/sdk-ruby-surface.json
oagen extract --sdk-path ./existing-sdk --lang ruby --output my-surface.json
```

| Argument            | Required | Default                   | Description                                                                                                     |
| ------------------- | -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--sdk-path <path>` | Yes      |                           | Path to the live SDK                                                                                            |
| `--lang <language>` | Yes      |                           | Target language                                                                                                 |
| `--output <path>`   | No       | `sdk-{lang}-surface.json` | Output file path (recommend writing to your output dir, e.g. `./sdk/sdk-ruby-surface.json`, and gitignoring it) |

## `oagen compat-extract`

Extract a compat snapshot from a live SDK and write it to a JSON file. The snapshot is a machine-readable record of the SDK's public API surface, used as input to `compat-diff`.

```bash
oagen compat-extract --sdk-path ./existing-sdk --lang node --output .
oagen compat-extract --sdk-path ./existing-sdk --lang php --output ./sdk --spec openapi.yml
```

| Argument            | Required | Default                 | Description                                                                        |
| ------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `--sdk-path <path>` | Yes      |                         | Path to the live SDK                                                               |
| `--lang <language>` | Yes      |                         | Target language                                                                    |
| `--output <dir>`    | Yes      |                         | Directory to write `.oagen-compat-snapshot.json` into                              |
| `--spec <path>`     | No       | `OPENAPI_SPEC_PATH` env | Path to OpenAPI spec — enriches symbols with `operationId`, `route`, and `specSha` |

Always writes `.oagen-compat-snapshot.json` in the specified directory. The snapshot file is meant to be committed to the repository and updated on each release.

When `--spec` is provided, the command parses the spec and enriches callable symbols with `operationId` and `route` (HTTP method + path) by matching against spec operations. It also computes a SHA-256 of the spec file and stores it as `source.specSha` in the snapshot.

## `oagen compat-diff`

Diff two compat snapshot files and produce a classified change report. No extraction or spec required — pure file-in, report-out.

```bash
# Basic diff with terminal output
oagen compat-diff --baseline .oagen-compat-snapshot.json --candidate /tmp/candidate.json

# With machine-readable report and failure threshold
oagen compat-diff \
  --baseline .oagen-compat-snapshot.json \
  --candidate /tmp/candidate.json \
  --output compat-report.json \
  --fail-on breaking
```

| Argument             | Required | Default    | Description                                        |
| -------------------- | -------- | ---------- | -------------------------------------------------- |
| `--baseline <path>`  | Yes      |            | Path to the baseline compat snapshot JSON          |
| `--candidate <path>` | Yes      |            | Path to the candidate compat snapshot JSON         |
| `--output <path>`    | No       |            | Write machine-readable JSON report to this path    |
| `--fail-on <level>`  | No       | `breaking` | Fail threshold: `none`, `breaking`, or `soft-risk` |
| `--explain`          | No       | `false`    | Include provenance explanations in terminal output |

**Exit codes:** 0 = no changes exceed threshold, 1 = changes exceed threshold.

## `oagen compat-summary`

Format a compat report as a markdown PR comment. Reads the JSON report produced by `compat-diff --output` and outputs markdown to stdout or a file.

```bash
# Single language
oagen compat-summary --report compat-report.json | gh pr comment --body-file -

# Cross-language rollup (multiple reports)
oagen compat-summary --report php.json --report python.json --report go.json

# Write to a file
oagen compat-summary --report compat-report.json --output summary.md
```

| Argument             | Required | Default | Description                                                                |
| -------------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `--report <path...>` | Yes      |         | Path(s) to compat report JSON(s) — pass multiple for cross-language rollup |
| `--output <path>`    | No       | stdout  | Write markdown to this file instead of stdout                              |

**Single report** output includes:

- Status header (pass/warning/fail)
- Summary table with breaking, soft-risk, and additive counts
- Breaking changes table (always visible)
- Soft-risk and additive changes in collapsible `<details>` sections

**Multiple reports** produce a cross-language rollup:

- Per-language summary table (breaking/soft-risk/additive per language)
- Conceptual changes table showing per-language severity for each change
- Same conceptual change across languages is shown as one row, not N separate rows

## `oagen verify`

Verify an already-generated SDK — run smoke tests and optional compat checks. Use after `oagen generate`.

```bash
oagen verify --lang node --output ./sdk --spec openapi.yml

# With compat check
oagen verify --lang node --output ./sdk --spec openapi.yml \
  --api-surface ./sdk/sdk-node-surface.json
```

| Argument                | Required | Default                         | Description                                                                                                   |
| ----------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--lang <language>`     | Yes      |                                 | Target language                                                                                               |
| `--output <dir>`        | Yes      |                                 | Path to the generated SDK                                                                                     |
| `--spec <path>`         | No       | `OPENAPI_SPEC_PATH` env         | Path to an OpenAPI 3.x spec file                                                                              |
| `--api-surface <path>`  | No       |                                 | Baseline API surface JSON — enables compat verification                                                       |
| `--raw-results <path>`  | No       | auto-generated                  | Path to an existing smoke baseline file to diff against                                                       |
| `--smoke-config <path>` | No       |                                 | Smoke config JSON for skip lists and service mappings                                                         |
| `--smoke-runner <path>` | No       |                                 | Custom smoke runner script (overrides built-in `sdk-test.ts`)                                                 |
| `--scope <mode>`        | No       | `spec-only` when `--spec` given | Compat scope: `full` compares all baseline symbols, `spec-only` only compares symbols derivable from the spec |
| `--diagnostics`         | No       | `false`                         | Output `verify-diagnostics.json` with structured violation breakdown                                          |
| `--max-retries <n>`     | No       | `3`                             | Max retry iterations for self-correcting overlay loop (set to 0 for single-pass)                              |

**Exit codes:**

| Code | Meaning                                                                 | Details                     |
| ---- | ----------------------------------------------------------------------- | --------------------------- |
| 0    | Clean — all checks passed                                               |                             |
| 1    | Findings — CRITICAL smoke mismatches, compat violations, or missing ops | `smoke-diff-findings.json`  |
| 2    | Compile error — SDK failed type check                                   | `smoke-compile-errors.json` |

## `oagen init`

Scaffold a new emitter project with all boilerplate files and a compilable stub emitter.

```bash
oagen init --lang ruby
oagen init --lang go --project ./my-emitter
```

| Argument            | Required | Default | Description                          |
| ------------------- | -------- | ------- | ------------------------------------ |
| `--lang <language>` | Yes      |         | Target language (e.g., `ruby`, `go`) |
| `--project <dir>`   | No       | `.`     | Directory to create the project in   |

Creates:

- `package.json` with `@workos/oagen` dependency and `sdk:generate`/`sdk:verify`/`sdk:extract` scripts
- `tsconfig.json`, `vitest.config.ts`, `tsup.config.ts` — build/test tooling
- `oagen.config.ts` — minimal config for local development, imports the plugin bundle
- `src/plugin.ts` — plugin bundle export registering the stub emitter
- `src/{language}/index.ts` — stub emitter implementing the full `Emitter` interface
- `src/index.ts` — barrel export including the plugin bundle
- Empty directories: `test/`, `smoke/`, `docs/sdk-architecture/`

After initialization, `npm run typecheck` passes immediately. Implement your emitter methods in `src/{language}/` to start generating SDK code.

## `oagen parse`

Parse an OpenAPI spec and output the IR as JSON to stdout. Useful for inspecting what the parser extracts.

```bash
oagen parse --spec openapi.yml
```

| Argument        | Required | Default                 | Description                                      |
| --------------- | -------- | ----------------------- | ------------------------------------------------ |
| `--spec <path>` | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file (YAML or JSON). |

## `oagen resolve`

Resolve operation names from the spec using the algorithm and optional hints. Outputs a review table (markdown) or JSON for programmatic use.

```bash
# Markdown review table (default)
oagen resolve --spec openapi.yml

# JSON output for CI/scripting
oagen resolve --spec openapi.yml --format json
```

| Argument            | Required | Default                 | Description                                      |
| ------------------- | -------- | ----------------------- | ------------------------------------------------ |
| `--spec <path>`     | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file (YAML or JSON). |
| `--format <format>` | No       | `table`                 | Output format: `table` (markdown) or `json`.     |

When `oagen.config.ts` defines `operationHints` and/or `mountRules`, they are applied automatically. The table format flags operations that have no hint and are resolved purely by algorithm.

## `--config <path>`

All commands accept a global `--config <path>` option to load a specific config file instead of the default cwd-based discovery.

```bash
# Explicit config
oagen generate --config ../openapi-spec/oagen.config.ts --spec openapi.yml --lang node --output ./sdk

# Default: searches for oagen.config.ts in the current directory
oagen generate --spec openapi.yml --lang node --output ./sdk
```

When `--config` is omitted, the CLI searches the current working directory for `oagen.config.ts`, `oagen.config.js`, or `oagen.config.mjs` in that order.

## Configuration (`oagen.config.ts`)

Place an `oagen.config.ts` (or `.js`/`.mjs`) in the project that drives generation. The CLI loads this file at startup before any command runs.

The config file belongs to the **consumer project** (the project that owns spec interpretation policy), not the emitter library. Emitter packages export plugin bundles that the consumer config composes.

### Consumer config (recommended)

```ts
import type { OagenConfig } from "@workos/oagen";
import { acmeEmittersPlugin } from "@acme/oagen-emitters";

const config: OagenConfig = {
  ...acmeEmittersPlugin,
  docUrl: "https://docs.example.com",
  operationIdTransform: (id) => id.replace(/Controller_/, ""),
  operationHints,
  mountRules,
};

export default config;
```

### Standalone emitter config

For standalone emitter projects that also serve as the consumer:

```ts
import type { OagenConfig } from "@workos/oagen";
import { nodeEmitter } from "./src/node/index.js";

const config: OagenConfig = {
  emitters: [nodeEmitter],
};

export default config;
```

### Composing multiple plugin bundles

```ts
import type { OagenConfig } from "@workos/oagen";
import { acmeEmittersPlugin } from "@acme/oagen-emitters";
import { experimentalPlugin } from "@workos/oagen-experimental";

const config: OagenConfig = {
  emitters: [
    ...(acmeEmittersPlugin.emitters ?? []),
    ...(experimentalPlugin.emitters ?? []),
  ],
  extractors: [
    ...(acmeEmittersPlugin.extractors ?? []),
    ...(experimentalPlugin.extractors ?? []),
  ],
  smokeRunners: {
    ...(acmeEmittersPlugin.smokeRunners ?? {}),
    ...(experimentalPlugin.smokeRunners ?? {}),
  },
  operationHints,
  mountRules,
};

export default config;
```

### Options

| Key                    | Type                                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emitters`             | `Emitter[]`                                       | Language emitters to register. Each emitter implements the `Emitter` interface and generates SDK files for one target language.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `extractors`           | `Extractor[]`                                     | API surface extractors to register. Each extractor parses a live SDK and produces an `ApiSurface` JSON used for compat verification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `emitterProject`       | `string`                                          | Path to the emitter project directory. Used by skills to scaffold new emitters, tests, and smoke runners in the correct location.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `smokeRunners`         | `Record<string, string>`                          | Map from language key to custom smoke runner script path. Overrides the built-in `sdk-test.ts` for `oagen verify`. Can also be set per-invocation with `--smoke-runner`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `operationIdTransform` | `(id: string) => string`                          | Custom transform for operation IDs. Receives the raw `operationId` from the spec; return the desired operation name. No additional casing conversion is applied. When omitted, `operationId` values are converted to `camelCase`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `schemaNameTransform`  | `(name: string, originalName?: string) => string` | Custom transform for schema (model/enum) names. Applied after the built-in `cleanSchemaName` normalization. Receives the cleaned PascalCase name (`name`) and, for component schemas, the original name exactly as spelled in the document (`originalName`); return the desired name. Return `originalName` to opt a schema out of normalization, but only when its spelling is already a valid identifier: a bare `originalName ?? name` would also keep keys like `user-profile` or `Foo.Bar` that `cleanSchemaName` would otherwise have fixed. For example `(name, originalName) => (originalName && /^[A-Za-z_$][\w$]*$/.test(originalName) ? originalName : name)` keeps `HTTPConfig`, `URL`, and `Settings` instead of `HttpConfig`, `Url`, and `Setting`. `originalName` is `undefined` for any name oagen synthesises (inline enums, request-body variant models, title-derived names), so fall back to `name` for those. Collisions are detected automatically: if a transform would produce a duplicate name, the cleaned name is kept. |
| `transformSpec`        | `(spec: OpenApiDocument) => OpenApiDocument`      | Pre-IR overlay applied to the bundled OpenAPI document before any IR extraction. Use to patch around upstream spec quirks that would otherwise emit a breaking SDK change. See [`transformSpec` — Pre-IR Spec Overlay](advanced/transform-spec.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docUrl`               | `string`                                          | Base URL for documentation links. When set, relative markdown paths in descriptions (e.g. `[User](/reference/users/user)`) are expanded to full URLs (e.g. `[User](https://docs.example.com/reference/users/user)`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `operationHints`       | `Record<string, OperationHint>`                   | Per-operation overrides keyed by `"METHOD /path"`. Override derived method names, remount to a different service, split union-body operations into typed wrappers, or state an operation's pagination explicitly (`pagination`, the same object as the spec's `x-pagination` extension; it wins over the extension and over detection). See [Operation Resolution](architecture/ir-types.md#operation-resolution).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mountRules`           | `Record<string, string>`                          | Service-level remounting. Maps IR service name to target service/namespace (PascalCase). Keys may be exact names or trailing-`*` prefix patterns (e.g. `"UserManagement*"`); an exact key wins over any wildcard, and among wildcards the longest prefix wins. All operations in the source service are mounted on the target unless overridden per-operation in `operationHints`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `modelHints`           | `Record<string, string>`                          | Pin specific models to a specific IR service for placement. Maps IR model name (post-`cleanSchemaName`/`schemaNameTransform`) → IR service name (PascalCase). Overrides the default "first service to reference the model wins" assignment. Both names must exist in the parsed spec; unknown names throw at generation time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
