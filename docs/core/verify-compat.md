# Verify Compat

`oagen verify` runs compatibility checks as part of its verification pipeline. This document covers the compat-specific CLI flags, report outputs, and CI integration.

## CLI Flags

### Existing Flags (Compat-Related)

| Flag                   | Description                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `--api-surface <path>` | Baseline API surface JSON — enables compat verification             |
| `--spec <path>`        | OpenAPI spec for spec-scoped comparison                             |
| `--scope <mode>`       | `full` or `spec-only` (default: `spec-only` when `--spec` provided) |
| `--max-retries <n>`    | Max overlay patch iterations (default: 3)                           |
| `--diagnostics`        | Write `verify-diagnostics.json`                                     |

### New Flags (Classified Compat)

| Flag                       | Description                                                  |
| -------------------------- | ------------------------------------------------------------ |
| `--compat-report <path>`   | Write machine-readable classified compat report to this path |
| `--compat-fail-on <level>` | Override fail threshold: `none`, `breaking`, or `soft-risk`  |
| `--compat-baseline <path>` | Path to baseline compatibility snapshot                      |
| `--compat-explain`         | Include provenance explanations in terminal output           |

CLI flags take precedence over `oagen.config.ts` settings.

## Report Outputs

### Machine-Readable Report (`--compat-report`)

```json
{
  "schemaVersion": "1",
  "language": "php",
  "summary": {
    "breaking": 3,
    "softRisk": 2,
    "additive": 11
  },
  "changes": [
    {
      "severity": "breaking",
      "category": "parameter_renamed",
      "symbol": "Authorization.check",
      "conceptualChangeId": "chg_parameter_renamed_authorization.check_resourceid",
      "provenance": "emitter_template_change",
      "old": { "parameter": "resourceId" },
      "new": { "parameter": "resourceTarget" }
    }
  ]
}
```

### Human Summary (`--compat-explain`)

```
Compat report for php:
  3 breaking, 2 soft-risk, 11 additive

  Breaking:
    [parameter_renamed] Authorization.check — Parameter "resourceId" renamed to "resourceTarget"
      provenance: emitter_template_change
    [parameter_removed] UserManagement.createUser — Parameter "passwordHashType" removed
      provenance: spec_shape_change

  Soft-risk:
    [constructor_reordered_named_friendly] CreateUser.constructor — reordered (named-friendly)
      provenance: normalization_change

  Additive: 11 new symbol(s)
```

### Diagnostics (`--diagnostics`)

The existing `verify-diagnostics.json` continues to include legacy compat data (preservation score, violations by category/severity). The new classified report is written separately via `--compat-report`.

## Failure Thresholds

The verify command fails when unapproved changes meet or exceed the fail threshold:

| `--compat-fail-on` | Fails on                                 |
| ------------------ | ---------------------------------------- |
| `none`             | Never fails for compat changes           |
| `breaking`         | Unapproved breaking changes (default)    |
| `soft-risk`        | Unapproved breaking OR soft-risk changes |

Approved changes (matched by `compat.allow` in config) are excluded from the failure threshold.

## CI Integration

There are two CI models: **integrated** (via `oagen verify`) and **file-based** (via standalone `compat-extract` / `compat-diff` / `compat-summary` commands). The file-based model is recommended for new setups.

### File-Based CI (Recommended)

The file-based model uses `.oagen-compat-snapshot.json` as a committed baseline artifact. On each PR, the candidate SDK is extracted, diffed against the baseline, and a summary is posted as a PR comment.

```yaml
name: Compat Check
on: [pull_request]

jobs:
  compat:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        lang: [node, php, python, ruby, go, kotlin, dotnet, elixir, rust]
    steps:
      - uses: actions/checkout@v4

      - name: Generate candidate SDK
        run: oagen generate --spec openapi.yml --lang ${{ matrix.lang }} --output ./generated

      - name: Extract candidate snapshot
        run: |
          oagen compat-extract \
            --sdk-path ./generated \
            --lang ${{ matrix.lang }} \
            --output /tmp \
            --spec openapi.yml

      - name: Diff against baseline
        run: |
          oagen compat-diff \
            --baseline .oagen-compat-snapshot.json \
            --candidate /tmp/.oagen-compat-snapshot.json \
            --output compat-report-${{ matrix.lang }}.json \
            --fail-on breaking

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: compat-report-${{ matrix.lang }}
          path: compat-report-${{ matrix.lang }}.json

  summary:
    needs: compat
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          pattern: compat-report-*
          merge-multiple: true

      - name: Post cross-language PR summary
        run: |
          oagen compat-summary \
            --report compat-report-*.json \
            | gh pr comment ${{ github.event.pull_request.number }} --body-file -
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For a single-language project, simplify to one job without the matrix:

```bash
oagen compat-extract --sdk-path ./generated --lang node --output /tmp --spec openapi.yml
oagen compat-diff --baseline .oagen-compat-snapshot.json --candidate /tmp/.oagen-compat-snapshot.json --output report.json --fail-on breaking
oagen compat-summary --report report.json | gh pr comment --body-file -
```

#### Baseline Management

The baseline snapshot is committed to the repository and updated as part of the release process:

```bash
# After releasing a new SDK version, update the baseline
oagen compat-extract --sdk-path . --lang node --output .
git add .oagen-compat-snapshot.json
git commit -m "chore: update compat baseline for v2.1.0"
```

#### Report-Only Mode (Phase 4)

To run compat checks without blocking PRs, set `--fail-on none`:

```bash
oagen compat-diff \
  --baseline .oagen-compat-snapshot.json \
  --candidate /tmp/candidate-snapshot.json \
  --output compat-report.json \
  --fail-on none
```

The PR summary will still be posted, but the job will not fail. Switch to `--fail-on breaking` when ready for hard enforcement.

### Integrated CI (via `oagen verify`)

The `oagen verify` command runs compat checks as part of its verification pipeline. This is suitable when you want smoke tests and compat checks in a single step.

```yaml
- name: Verify SDK
  run: |
    oagen verify \
      --lang php \
      --output ./generated \
      --api-surface sdk-php-surface.json \
      --spec openapi.yaml \
      --compat-report compat-report.json \
      --compat-fail-on breaking \
      --diagnostics
```

### Exit Codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | All checks passed                        |
| 1    | Compat violations or smoke test findings |
| 2    | SDK compile errors                       |

## How to Read and Act on Findings

### Breaking Changes

1. Check the `provenance` field — is this from a spec change or an emitter change?
2. If spec-driven: this may need a major version release
3. If emitter-driven: fix the emitter to preserve backward compatibility
4. If intentional: add an approval to `oagen.config.ts`

### Soft-Risk Changes

1. Review whether callers are likely affected
2. If safe: no action needed (or add approval for documentation)
3. If risky: fix the emitter or bump the release level

### Additive Changes

Safe to ship. No action needed.

## Overlay Retry Loop

The existing overlay retry loop (`--max-retries`) continues to work with the legacy compat system. It patches `public-api` and `export-structure` violations by correcting overlay mappings and regenerating. The classified compat report runs after the overlay loop has converged.
