# Emitter Project Scaffold

When `{project}/package.json` does **NOT** exist, create the following boilerplate files to initialize the project. If `package.json` already exists, skip this entirely.

## `package.json`

```json
{
  "name": "@workos/oagen-emitters-{language}",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./plugin": { "types": "./dist/plugin.d.ts", "import": "./dist/plugin.js" }
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "sdk:generate": "oagen generate --lang {language} --output ./sdk",
    "sdk:verify": "oagen verify --lang {language} --output ./sdk",
    "sdk:extract": "oagen extract --lang {language} --output ./sdk-{language}-surface.json"
  },
  "dependencies": {
    "@workos/oagen": "^0.0.1"
  },
  "devDependencies": {
    "tsup": "^8.4.0",
    "tsx": "^4.19.0",
    "vitest": "^3.0.0",
    "@types/node": "^25.3.3"
  }
}
```

## `tsconfig.json`

Mirror oagen core's config: ES2022, ESNext modules, bundler resolution, strict mode, declaration output.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": ".",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src", "test"],
  "exclude": ["node_modules", "dist"]
}
```

## `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globals: true, include: ["test/**/*.test.ts"] },
});
```

## `tsup.config.ts`

```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", plugin: "src/plugin.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
});
```

## `oagen.config.ts`

Minimal config for local emitter development. The canonical consumer config lives in the consumer project.

```ts
import type { OagenConfig } from "@workos/oagen";
import { plugin } from "./src/plugin.js";
const config: OagenConfig = { ...plugin };
export default config;
```

## `src/plugin.ts`

Plugin bundle export. The consumer project imports this to get all emitters, extractors, and smoke runners.

```ts
import type { OagenConfig } from "@workos/oagen";
export const plugin: Pick<OagenConfig, "emitters" | "extractors" | "smokeRunners"> = {
  emitters: [],
  extractors: [],
  smokeRunners: {},
};
```

(Step 7 of the main skill adds the emitter to this plugin bundle.)

## `src/index.ts`

```ts
// Barrel export — re-exports all emitters and the plugin bundle
export { plugin } from "./plugin.js";
```

(Step 7 adds the emitter re-export.)

## `.gitignore`

```
node_modules/
dist/
```

After creating these files, run `npm install` in the emitter project directory.

## SDK generation scripts

The `sdk:*` scripts bake in `--lang` and `--output` so you only need to pass the remaining flags via `--`:

```bash
# Fresh generation
npm run sdk:generate -- --spec ../openapi.yaml --namespace workos

# Verify generated output
npm run sdk:verify -- --spec ../openapi.yaml

# Extract API surface from an existing SDK (Scenario A)
npm run sdk:extract -- --sdk-path ../path-to-live-sdk

# Generate with compat overlay (Scenario A)
npm run sdk:generate -- --spec ../openapi.yaml --namespace workos --api-surface ./sdk-{language}-surface.json

# Verify with compat check (Scenario A)
npm run sdk:verify -- --spec ../openapi.yaml --api-surface ./sdk-{language}-surface.json

# Integrate into live SDK (Scenario A)
npm run sdk:generate -- --spec ../openapi.yaml --namespace workos --api-surface ./sdk-{language}-surface.json --target ../path-to-live-sdk
```

The `--spec` flag can be replaced by setting `OPENAPI_SPEC_PATH` in the environment.
