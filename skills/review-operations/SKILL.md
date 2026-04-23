---
name: review-operations
description: >-
  Review resolved operation names from the OpenAPI spec. Runs the resolution
  algorithm with hints applied and outputs a review table for human approval.
  Use when reviewing operation names, checking for unhinted operations, auditing
  method naming, or after spec changes. Also triggers for "operation names",
  "method names", "hint map", "operation review", "unhinted operations".
---

# /review-operations

Parse the OpenAPI spec, run operation resolution with the configured hint map, and produce a review table highlighting operations that need attention.

## Accept Arguments

Accept `--spec <path>` as an optional argument. If not provided, fall back to the `OPENAPI_SPEC_PATH` environment variable, then try `../openapi-spec/spec/open-api-spec.yaml`.

## Step 1: Resolve Paths

1. **Spec path**: from argument, `OPENAPI_SPEC_PATH` env, or `../openapi-spec/spec/open-api-spec.yaml`
2. **Consumer config project**: check if `oagen.config.ts` exists in the current directory. If not, try `../openapi-spec/oagen.config.ts`. If neither exists, use `AskUserQuestion`: "Where is your consumer config project (the project with `oagen.config.ts`)?"
3. Validate the spec file exists before proceeding.

## Step 2: Run Resolution

Run `oagen resolve` to get the full resolution output:

```bash
npx oagen resolve --spec <path> --format json
```

Parse the JSON output. Each entry has: `service`, `method`, `path`, `derivedName`, `hintApplied`, `mountOn`, `wrappers`.

## Step 3: Categorize Operations

Sort operations into three categories:

1. **Hinted** — operations with an explicit name or mount override in `operationHints` or `mountRules`
2. **Algorithm-derived (look good)** — unhinted operations where the derived name follows standard CRUD patterns and reads naturally
3. **Needs review** — unhinted operations where the derived name may be suboptimal:
   - Plural names for single-resource POST/PUT/PATCH/DELETE (e.g., `create_organizations` instead of `create_organization`)
   - Names using `list_` for non-collection GETs (e.g., `list_profile`)
   - Generic names like `create_token` that don't capture the operation's purpose
   - Names with deeply nested paths that lose context

## Step 4: Output Review Table

Print a markdown table with all operations, grouped by category:

```markdown
## Operations needing review (N)

| Service | Method | Path | Current Name | Suggested Action |
| ------- | ------ | ---- | ------------ | ---------------- |

## Algorithm-derived operations (N)

| Service | Method | Path | Derived Name | Mount On |
| ------- | ------ | ---- | ------------ | -------- |

## Hinted operations (N)

| Service | Method | Path | Hint Name | Mount On |
| ------- | ------ | ---- | --------- | -------- |
```

For "needs review" operations, suggest a concrete action:

- `add name hint: <suggested_name>` for semantic renames
- `add mountOn hint: <target>` for service remounting
- `singularize: <name>` for plural-to-singular fixes

## Step 5: Summary

Print a summary:

- Total operations
- Hinted (with name or mount overrides)
- Algorithm-derived (no action needed)
- Needs review (may need hints)

If there are operations needing review, ask the user: "Would you like me to add hints for any of these operations to the consumer project's `oagen.config.ts`?"
