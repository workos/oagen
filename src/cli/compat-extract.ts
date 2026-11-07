import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getExtractor } from '../compat/extractor-registry.js';
import { parseSpec, type OpenApiDocument } from '../parser/parse.js';
import { apiSurfaceToSnapshot } from '../compat/ir.js';
import { readManifest } from '../engine/manifest.js';
import type { Manifest } from '../engine/manifest.js';
import type { CompatSnapshot } from '../compat/ir.js';
import type { ApiSurface, ApiClass } from '../compat/types.js';
import type { ApiSpec, Operation } from '../ir/types.js';
import { resolveOperations } from '../ir/operation-hints.js';
import type { OperationHint, OperationNaming, OperationResolution } from '../ir/operation-hints.js';
import type { SchemaNameTransform } from '../parser/schemas.js';

const SNAPSHOT_FILENAME = '.oagen-compat-snapshot.json';

/** Normalize a name for case-insensitive matching: strip underscores and lowercase. */
function normalize(name: string): string {
  return name.replace(/_/g, '').toLowerCase();
}

/**
 * Build a map of normalized service name → Set of generated method names
 * from the manifest's operations record.
 */
function buildServiceMethodMap(operations: Record<string, unknown>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const value of Object.values(operations)) {
    if (typeof value !== 'object' || value === null) continue;
    const { sdkMethod, service } = value as { sdkMethod?: string; service?: string };
    if (typeof sdkMethod !== 'string' || typeof service !== 'string') continue;
    const key = normalize(service);
    if (!result.has(key)) result.set(key, new Set());
    result.get(key)!.add(sdkMethod);
  }
  return result;
}

/**
 * Filter an ApiSurface to only include generated symbols based on the manifest.
 *
 * Two levels of filtering:
 *  1. File-level: classes/interfaces/enums from files not in the manifest are
 *     dropped entirely (they are wholly hand-written).
 *  2. Method-level: for service classes (those whose name matches a manifest
 *     service), only methods listed in the manifest operations are kept.
 *     Constructors and properties are always preserved since they are structural.
 *     Non-service classes (models, enums, etc.) keep all their symbols.
 */
function filterSurfaceByManifest(
  surface: ApiSurface,
  manifest: Manifest,
): {
  filtered: ApiSurface;
  filesExcluded: number;
  methodsExcluded: number;
} {
  const manifestFiles = new Set(manifest.files);
  const serviceMethodMap = manifest.operations
    ? buildServiceMethodMap(manifest.operations)
    : new Map<string, Set<string>>();

  let filesExcluded = 0;
  let methodsExcluded = 0;

  // Filter a record by manifest files, counting exclusions
  const filterByFile = <T extends { sourceFile?: string }>(record: Record<string, T>): Record<string, T> => {
    const result: Record<string, T> = {};
    for (const [name, entry] of Object.entries(record)) {
      if (entry.sourceFile && manifestFiles.has(entry.sourceFile)) {
        result[name] = entry;
      } else {
        filesExcluded++;
      }
    }
    return result;
  };

  // Filter classes: file-level first, then method-level for service classes
  const filteredClasses: Record<string, ApiClass> = {};
  for (const [name, cls] of Object.entries(surface.classes)) {
    if (cls.sourceFile && !manifestFiles.has(cls.sourceFile)) {
      filesExcluded++;
      continue;
    }

    // Check if this class is a service with known operations
    const generatedMethods = serviceMethodMap.get(normalize(name));
    if (generatedMethods) {
      // Service class from a generated file — keep all methods.
      // File-level filtering already ensures this is a generated file;
      // method-level filtering was dropping wrapper methods (e.g.
      // createM2MApplication) and utility methods (e.g. verify_event)
      // that aren't tracked as HTTP operations in the manifest.
      // Clear constructorParams: service constructors are internal DI
      // wiring (e.g. __construct($client)), not user-facing API.
      filteredClasses[name] = { ...cls, constructorParams: [] };
    } else {
      // Model / utility class — keep all symbols
      filteredClasses[name] = cls;
    }
  }

  // Filter exports to only include files in the manifest
  const filteredExports: Record<string, string[]> = {};
  for (const [filePath, symbols] of Object.entries(surface.exports)) {
    if (manifestFiles.has(filePath)) {
      filteredExports[filePath] = symbols;
    }
  }

  return {
    filtered: {
      ...surface,
      classes: filteredClasses,
      interfaces: filterByFile(surface.interfaces),
      typeAliases: filterByFile(surface.typeAliases),
      enums: filterByFile(surface.enums),
      exports: filteredExports,
    },
    filesExcluded,
    methodsExcluded,
  };
}

export async function compatExtractCommand(opts: {
  sdkPath: string;
  lang: string;
  output: string;
  spec?: string;
  operationIdTransform?: (id: string) => string;
  schemaNameTransform?: SchemaNameTransform;
  transformSpec?: (spec: OpenApiDocument) => OpenApiDocument;
  fieldHints?: Record<string, Record<string, string>>;
  operationHints?: Record<string, OperationHint>;
  collapseErrorBodies?: boolean;
  /**
   * What the engine resolves operations with, beside `operationHints`: the
   * class and method `generate` writes each operation as. Callables are
   * matched by those names (see {@link operationLookup}) (#567).
   */
  mountRules?: Record<string, string>;
  operationNaming?: OperationNaming;
}): Promise<void> {
  const extractor = getExtractor(opts.lang);
  console.log(`Extracting ${opts.lang} compat snapshot from ${opts.sdkPath}...`);

  let surface = await extractor.extract(opts.sdkPath);

  // If the SDK has a manifest, scope extraction to only generated symbols.
  // File-level: excludes wholly hand-written files.
  const manifest = await readManifest(opts.sdkPath);
  if (manifest) {
    const { filtered, filesExcluded } = filterSurfaceByManifest(surface, manifest);
    surface = filtered;
    if (filesExcluded > 0) {
      console.log(`Manifest filter: excluded ${filesExcluded} hand-written file(s)`);
    }
  }

  const snapshot = apiSurfaceToSnapshot(surface);

  // Enrich with spec context if provided
  if (opts.spec) {
    const specContent = readFileSync(opts.spec, 'utf-8');
    snapshot.source.specSha = createHash('sha256').update(specContent).digest('hex');

    // Parse as `generate` parses, the transform and the hints included, and
    // resolve operations as the engine does, so the operation names and
    // models matched below are the ones the SDK has: a method named by
    // `operationIdTransform`, one remounted by `mountRules` or renamed by a
    // `name` hint, the `ListPetsResponse` a pagination hint makes generation
    // write (#567).
    const parsedSpec = await parseSpec(opts.spec, {
      operationIdTransform: opts.operationIdTransform,
      schemaNameTransform: opts.schemaNameTransform,
      transformSpec: opts.transformSpec,
      fieldHints: opts.fieldHints,
      operationHints: opts.operationHints,
      collapseErrorBodies: opts.collapseErrorBodies,
    });
    enrichWithSpecContext(snapshot, parsedSpec, {
      operationHints: opts.operationHints,
      mountRules: opts.mountRules,
      operationNaming: opts.operationNaming,
    });
  }

  const outputPath = resolve(opts.output, SNAPSHOT_FILENAME);
  writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
  console.log(`Extracted ${snapshot.symbols.length} symbols → ${outputPath}`);
}

/** The spec-level identity a callable is enriched with. */
interface OperationIdentity {
  operationId: string;
  method: string;
  path: string;
}

/**
 * `Class.method` → operation identity, keyed by the names `generate` writes.
 * A key is matched with underscores stripped and case folded (see
 * `normalize`), so one key reads a method in any language's casing:
 * `Pets.list_pets`, `Pets.listPets` and `Pets.ListPets` are one key.
 *
 * An SDK's callable is matched, in this order, to:
 *
 * 1. the mount target and the resolved method name, as `resolveOperations`
 *    resolves them from the config's `operationHints`, `mountRules` and
 *    `operationNaming` — `Pets.list_all` under
 *    `operationHints: { 'GET /pets': { name: 'list_all' } }`, `Animals.get_pet`
 *    under `mountRules: { Pets: 'Animals' }` — and each split wrapper's name
 *    on that target (`Pets.create_cat` for a `split` hint on `POST /pets`);
 * 2. the mount target and the IR's operation name, for an SDK whose methods
 *    carry the operationIds on a remounted service: `Animals.get` under the
 *    same rule, which path naming resolves to `get_pet`;
 * 3. the IR's own `Service.operation` key — `Pets.get` — the one key every
 *    match used before the engine's names reached this command (#567), so
 *    a snapshot that matched before matches still.
 *
 * A later key never displaces an earlier one: the name `generate` writes
 * wins over an IR name another operation happens to spell the same way.
 */
function operationLookup(spec: ApiSpec, resolution: OperationResolution): Map<string, OperationIdentity> {
  const resolved = resolveOperations(
    spec,
    resolution.operationHints,
    resolution.mountRules,
    resolution.operationNaming,
  );
  const lookup = new Map<string, OperationIdentity>();
  const add = (owner: string, method: string, op: Operation): void => {
    const key = normalize(`${owner}.${method}`);
    if (!lookup.has(key)) lookup.set(key, { operationId: op.name, method: op.httpMethod, path: op.path });
  };
  for (const r of resolved) {
    add(r.mountOn, r.methodName, r.operation);
    for (const wrapper of r.wrappers ?? []) add(r.mountOn, wrapper.name, r.operation);
  }
  for (const r of resolved) add(r.mountOn, r.operation.name, r.operation);
  for (const r of resolved) add(r.service.name, r.operation.name, r.operation);
  return lookup;
}

/**
 * Enrich snapshot symbols with spec-level identity.
 *
 * - Callable symbols get `operationId` and `route` from spec operations,
 *   matched by the class and method names `generate` writes (see
 *   {@link operationLookup}).
 * - Property/field/constructor/service_accessor symbols get `schemaName`
 *   from spec models, enabling cross-language grouping in reports.
 *
 * The `schemaName` uses the spec-level identity (e.g. "GenerateLinkBody.admin_emails")
 * which is the same regardless of the language's naming conventions.
 */
function enrichWithSpecContext(snapshot: CompatSnapshot, spec: ApiSpec, resolution: OperationResolution): void {
  const opLookup = operationLookup(spec, resolution);

  // Build model field lookup for schema-level identity.
  // Normalized class name → { specModelName, fields: Map<normalizedFieldName, specFieldName> }
  const norm = (s: string) => s.replace(/_/g, '').toLowerCase();
  const modelLookup = new Map<string, { specName: string; fields: Map<string, string> }>();
  for (const model of spec.models) {
    const fieldMap = new Map<string, string>();
    for (const field of model.fields) {
      fieldMap.set(norm(field.name), field.name);
    }
    modelLookup.set(norm(model.name), { specName: model.name, fields: fieldMap });
  }

  for (const sym of snapshot.symbols) {
    // Enrich callables with operation identity
    if (sym.kind === 'callable') {
      const match = opLookup.get(normalize(sym.fqName));
      if (match) {
        sym.operationId = match.operationId;
        sym.route = { method: match.method, path: match.path };
      }
    }

    // Enrich all symbols with schema-level identity
    if (sym.ownerFqName) {
      // This symbol belongs to a class — try to match the class to a spec model
      const modelMatch = modelLookup.get(norm(sym.ownerFqName));
      if (modelMatch) {
        // Extract the local name (part after the dot)
        const localName = sym.fqName.includes('.') ? sym.fqName.split('.').pop()! : sym.fqName;
        const fieldMatch = modelMatch.fields.get(norm(localName));
        if (fieldMatch) {
          sym.schemaName = `${modelMatch.specName}.${fieldMatch}`;
        } else {
          // Class-level symbol (constructor, etc.) — use just the model name
          sym.schemaName = modelMatch.specName;
        }
      }
    } else {
      // Top-level symbol (class itself) — try to match to a spec model
      const modelMatch = modelLookup.get(norm(sym.fqName));
      if (modelMatch) {
        sym.schemaName = modelMatch.specName;
      }
    }
  }
}
