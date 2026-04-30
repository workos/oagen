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
import type { ApiSpec } from '../ir/types.js';

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
  schemaNameTransform?: (name: string) => string;
  transformSpec?: (spec: OpenApiDocument) => OpenApiDocument;
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

    const parsedSpec = await parseSpec(opts.spec, {
      schemaNameTransform: opts.schemaNameTransform,
      transformSpec: opts.transformSpec,
    });
    enrichWithSpecContext(snapshot, parsedSpec);
  }

  const outputPath = resolve(opts.output, SNAPSHOT_FILENAME);
  writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
  console.log(`Extracted ${snapshot.symbols.length} symbols → ${outputPath}`);
}

/**
 * Enrich snapshot symbols with spec-level identity.
 *
 * - Callable symbols get `operationId` and `route` from spec operations.
 * - Property/field/constructor/service_accessor symbols get `schemaName`
 *   from spec models, enabling cross-language grouping in reports.
 *
 * The `schemaName` uses the spec-level identity (e.g. "GenerateLinkBody.admin_emails")
 * which is the same regardless of the language's naming conventions.
 */
function enrichWithSpecContext(snapshot: CompatSnapshot, spec: ApiSpec): void {
  // Build lookup: "ServiceName.methodName" → { operationId, method, path }
  const opLookup = new Map<string, { operationId: string; method: string; path: string }>();
  for (const service of spec.services) {
    for (const op of service.operations) {
      const key = `${service.name}.${op.name}`;
      opLookup.set(key, {
        operationId: op.name,
        method: op.httpMethod,
        path: op.path,
      });
    }
  }

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
      const match = opLookup.get(sym.fqName);
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
