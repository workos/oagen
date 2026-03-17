# oagen

Generate SDKs from an OpenAPI 3.x specification.

`oagen` parses an OpenAPI spec into a language-agnostic intermediate representation (IR), then emits SDK code for a target language. Emitters are plugins — you bring your own for whatever language you need, and register them via `oagen.config.ts`.

## Quickstart

```bash
npm install @workos/oagen
```

Generate an SDK:

```bash
oagen generate --spec openapi.yml --lang ruby --output ./sdk --namespace MyService
```

When a new spec version arrives, diff and regenerate:

```bash
oagen diff --old v1.yml --new v2.yml --report          # review what changed
oagen diff --old v1.yml --new v2.yml --lang ruby --output ./sdk  # regenerate affected files
oagen verify --spec v2.yml --lang ruby --output ./sdk   # smoke test the result
```

## Commands

| Command          | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `oagen generate` | Generate SDK code from an OpenAPI spec               |
| `oagen diff`     | Review or incrementally apply spec changes           |
| `oagen extract`  | Extract public API surface from an existing SDK      |
| `oagen verify`   | Run smoke tests and compat checks on a generated SDK |
| `oagen parse`    | Parse a spec and output the IR as JSON               |

Run `oagen <command> --help` for full argument details, or see [docs/cli.md](docs/cli.md).

## Configuration

Register custom emitters, extractors, and smoke runners via `oagen.config.ts` in your project root:

```ts
// oagen.config.ts
import { myGoEmitter } from "./emitters/go/index.js";
import { myGoExtractor } from "./extractors/go/index.js"; // must include hints: LanguageHints

export default {
  emitters: [myGoEmitter],
  extractors: [myGoExtractor], // extractor.hints drives language-specific compat logic
  smokeRunners: { go: "./smoke/go-runner.ts" },
  emitterProject: "./path/to/emitter-project",
  irVersion: 1, // pin to the IR version your emitters were built against
};
```

## Using as a library

```ts
import { parseSpec, generate, registerEmitter } from "@workos/oagen";

const ir = await parseSpec("openapi.yml");

registerEmitter(myEmitter);
const files = await generate(ir, myEmitter, {
  namespace: "MyService",
  outputDir: "./sdk",
});
```

All IR, engine, differ, and compat types are exported from `@workos/oagen`.

## Adding a new language

There are two scenarios depending on whether you need to preserve an existing SDK's public API:

- **Scenario A** (existing SDK): Scaffold an emitter, build an extractor, extract the live SDK's API surface, generate with compat overlay, verify
- **Scenario B** (fresh): Scaffold an emitter, generate, verify

Both follow the same shape: scaffold, generate, verify, test. See [Workflows](docs/architecture/workflows.md) for the full step-by-step walkthrough, including the compat overlay loop and emitter-fixing loop.

## Claude Code Plugin

oagen ships as a [Claude Code plugin](https://code.claude.com/docs/en/plugins.md) with skills that automate emitter scaffolding, compat verification, smoke testing, and end-to-end language setup.

### Using the plugin

From your emitter project (where `@workos/oagen` is installed as a dependency):

```bash
claude --plugin-dir node_modules/@workos/oagen
```

This makes the following skills available:

| Skill                               | Description                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `/oagen:generate-sdk <lang>`        | End-to-end orchestrator — determines scenario and sequences the skills below |
| `/oagen:generate-emitter <lang>`    | Scaffold a new language emitter                                              |
| `/oagen:generate-extractor <lang>`  | Scaffold an API surface extractor for compat verification                    |
| `/oagen:generate-smoke-test <lang>` | Create smoke tests for a generated SDK                                       |
| `/oagen:verify-compat <lang>`       | Verify emitter output preserves backwards compatibility                      |

### Local development

If you're working in the oagen repo itself, the skills are also available directly:

```bash
claude --plugin-dir .
```

## Development

```bash
npm install
npm run build           # build CLI binary
npm test                # run tests
npm run typecheck       # type check
npm run lint:structure  # verify dependency layers
```
