import type { ApiSurface, ApiInterface, ApiMethod, Violation, OverlayLookup, LanguageHints } from './types.js';
import type { ApiSpec, Model } from '../ir/types.js';
import { toSnakeCase, splitWords } from '../utils/naming.js';
import { nodeHints as defaultNodeHints } from './language-hints.js';

export type { MethodOverlay, OverlayLookup } from './types.js';

export interface ManifestEntry {
  operationId: string;
  sdkResourceProperty: string;
  sdkMethodName: string;
  httpMethod: string;
  path: string;
  pathParams: string[];
  bodyFields: string[];
  queryFields: string[];
}

/**
 * Find the class name that owns a given SDK resource property.
 * E.g. if the surface has a class "Organizations" with property "organizations",
 * and sdkResourceProperty is "organizations", return "Organizations".
 */
function findClassForProperty(
  surface: ApiSurface,
  sdkResourceProperty: string,
  hints: LanguageHints,
): string | undefined {
  for (const [className, cls] of Object.entries(surface.classes)) {
    // Check if the class itself maps to this property (language-specific match)
    if (hints.propertyMatchesClass(sdkResourceProperty, className)) {
      return className;
    }
    // Check properties — resolve to the property's type class, not the parent.
    // This prevents generic parent classes (e.g., WorkOS) from being returned
    // when the actual resource class (e.g., ApiKeys) should be used.
    for (const [propName, prop] of Object.entries(cls.properties)) {
      if (propName === sdkResourceProperty) {
        const propType = (prop as { type?: string }).type;
        if (propType && surface.classes[propType]) {
          return propType;
        }
        // Property type not in surface — skip rather than return the parent
        return undefined;
      }
    }
  }

  // Strategy 3: Word-suffix fallback
  // "adminPortal" → ["admin","portal"]; class "Portal" → ["portal"]
  // ["portal"] is a suffix of ["admin","portal"] → match
  const propWords = splitWords(sdkResourceProperty).map((w) => w.toLowerCase());
  if (propWords.length > 1) {
    for (const [className] of Object.entries(surface.classes)) {
      const classWords = splitWords(className).map((w) => w.toLowerCase());
      if (classWords.length > 0 && classWords.length < propWords.length) {
        const suffix = propWords.slice(propWords.length - classWords.length);
        if (classWords.every((w, i) => w === suffix[i])) {
          return className;
        }
      }
    }
  }

  return undefined;
}

export function buildOverlayLookup(
  surface: ApiSurface,
  manifest?: ManifestEntry[],
  spec?: ApiSpec,
  hints?: LanguageHints,
  options?: { strictModelMatch?: boolean },
): OverlayLookup {
  const resolvedHints = hints ?? defaultNodeHints;
  const lookup: OverlayLookup = {
    methodByOperation: new Map(),
    httpKeyByMethod: new Map(),
    interfaceByName: new Map(),
    typeAliasByName: new Map(),
    requiredExports: new Map(),
    modelNameByIR: new Map(),
    fileBySymbol: new Map(),
  };

  // If manifest available, map operationId → HTTP method + path → existing method
  if (manifest) {
    for (const entry of manifest) {
      const key = `${entry.httpMethod.toUpperCase()} ${entry.path}`;
      const className = findClassForProperty(surface, entry.sdkResourceProperty, resolvedHints);
      if (className) {
        let resolvedMethodName = entry.sdkMethodName;
        let methods = surface.classes[className]?.methods[resolvedMethodName];

        // Exact match failed — try prefix match on the resolved class.
        // Handles cases where the generated name is shorter than the existing name
        // (e.g., manifest says "delete" but existing SDK has "deleteApiKey").
        // Only accept when exactly one candidate matches — ambiguous matches are worse than no match.
        if (!methods) {
          const classMethods = surface.classes[className]?.methods ?? {};
          const prefix = resolvedMethodName.toLowerCase();
          const candidates: [string, ApiMethod[]][] = [];
          for (const [name, overloads] of Object.entries(classMethods)) {
            if (name.toLowerCase().startsWith(prefix) && name !== resolvedMethodName) {
              candidates.push([name, overloads]);
            }
          }
          if (candidates.length === 1) {
            methods = candidates[0][1];
            resolvedMethodName = candidates[0][0];
          }
        }

        // Suffix match: the existing SDK may use a longer controller-prefixed
        // method name that ends with the transformed name.
        // (e.g., manifest says "validate_api_key" but existing SDK has
        // "api_keys_controller_validate_api_key").
        // Only accept when exactly one candidate matches — ambiguous matches are worse than no match.
        if (!methods) {
          const classMethods = surface.classes[className]?.methods ?? {};
          const suffix = resolvedMethodName.toLowerCase();
          const candidates: [string, ApiMethod[]][] = [];
          for (const [name, overloads] of Object.entries(classMethods)) {
            if (name.toLowerCase().endsWith(suffix) && name !== resolvedMethodName) {
              candidates.push([name, overloads]);
            }
          }
          if (candidates.length === 1) {
            methods = candidates[0][1];
            resolvedMethodName = candidates[0][0];
          }
        }

        const method = methods?.[0];
        if (method) {
          lookup.methodByOperation.set(key, {
            className,
            methodName: resolvedMethodName,
            params: method.params,
            returnType: method.returnType,
          });
          lookup.httpKeyByMethod.set(`${className}.${resolvedMethodName}`, key);
        }
      }
    }
  }

  // Map interface and type alias names
  for (const name of Object.keys(surface.interfaces)) {
    lookup.interfaceByName.set(name, name);
  }
  for (const name of Object.keys(surface.typeAliases)) {
    lookup.typeAliasByName.set(name, name);
  }

  // Map barrel exports
  for (const [path, symbols] of Object.entries(surface.exports)) {
    lookup.requiredExports.set(path, new Set(symbols));
  }

  // Populate fileBySymbol from enriched surface
  for (const record of [surface.classes, surface.interfaces, surface.typeAliases, surface.enums] as Record<
    string,
    { sourceFile?: string }
  >[]) {
    for (const [name, item] of Object.entries(record)) {
      if (item.sourceFile) lookup.fileBySymbol.set(name, item.sourceFile);
    }
  }

  // Auto-infer IR model name → SDK interface name mappings
  if (spec) {
    buildModelNameMap(surface, spec, lookup, resolvedHints, options);

    // Remap fileBySymbol so IR model names point to the SDK symbol's file
    for (const [irName, sdkName] of lookup.modelNameByIR) {
      const filePath = lookup.fileBySymbol.get(sdkName);
      if (filePath) {
        lookup.fileBySymbol.set(irName, filePath);
      }
    }
  }

  return lookup;
}

// ---------------------------------------------------------------------------
// Automatic model name inference
// ---------------------------------------------------------------------------

/**
 * Normalize a field name to a canonical form for comparison.
 * Handles camelCase → snake_case so "createdAt" and "created_at" match.
 */
function normalizeFieldName(name: string): string {
  return toSnakeCase(name);
}

/**
 * Compute the Jaccard similarity between two sets of normalized field names.
 * Returns score (0–1) and raw intersection count.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): { score: number; intersection: number } {
  if (a.size === 0 && b.size === 0) return { score: 0, intersection: 0 };
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return { score: union === 0 ? 0 : intersection / union, intersection };
}

/**
 * Build a set of normalized field names from an IR model.
 */
function irModelFieldSignature(model: Model): Set<string> {
  return new Set(model.fields.map((f) => normalizeFieldName(f.name)));
}

/**
 * Build a set of normalized field names from an SDK interface.
 */
function sdkInterfaceFieldSignature(iface: ApiInterface): Set<string> {
  return new Set(Object.keys(iface.fields).map(normalizeFieldName));
}

/**
 * Populate the modelNameByIR map using two strategies:
 *
 * 1. Operation-based matching (high confidence):
 *    When a manifest maps an HTTP operation to an SDK method, extract the
 *    method's return type and parameter types. Match them against the IR
 *    operation's response model and request body model.
 *
 * 2. Field-structure matching (fallback):
 *    For IR models not matched by operations, compare their field names
 *    against all SDK interfaces using Jaccard similarity. A match requires
 *    ≥60% field overlap with ≥3 fields in common.
 */
function buildModelNameMap(
  surface: ApiSurface,
  spec: ApiSpec,
  lookup: OverlayLookup,
  hints: LanguageHints,
  options?: { strictModelMatch?: boolean },
): void {
  const mapped = new Set<string>(); // IR model names already mapped
  const usedSdkNames = new Set<string>(); // SDK names already claimed

  // --- Strategy 1: Operation-based matching ---
  if (lookup.methodByOperation.size > 0) {
    for (const service of spec.services) {
      for (const op of service.operations) {
        const httpKey = `${op.httpMethod.toUpperCase()} ${op.path}`;
        const methodOverlay = lookup.methodByOperation.get(httpKey);
        if (!methodOverlay) continue;

        // Match response model → SDK return type
        if (op.response.kind === 'model' && !mapped.has(op.response.name)) {
          const sdkTypeName = hints.extractReturnTypeName(methodOverlay.returnType);
          if (sdkTypeName && surface.interfaces[sdkTypeName]) {
            lookup.modelNameByIR.set(op.response.name, sdkTypeName);
            mapped.add(op.response.name);
            usedSdkNames.add(sdkTypeName);
          }
        }

        // Match request body model → SDK param type
        if (op.requestBody?.kind === 'model' && !mapped.has(op.requestBody.name)) {
          for (const param of methodOverlay.params) {
            const sdkTypeName = hints.extractParamTypeName(param.type);
            if (sdkTypeName && surface.interfaces[sdkTypeName]) {
              lookup.modelNameByIR.set(op.requestBody.name, sdkTypeName);
              mapped.add(op.requestBody.name);
              usedSdkNames.add(sdkTypeName);
              break;
            }
          }
        }
      }
    }
  }

  // --- Strategy 2: Field-structure matching ---
  // Pre-compute SDK interface field signatures
  const sdkSignatures: { name: string; fields: Set<string>; fieldCount: number }[] = [];
  for (const [name, iface] of Object.entries(surface.interfaces)) {
    if (usedSdkNames.has(name)) continue;
    const fields = sdkInterfaceFieldSignature(iface);
    if (fields.size >= 2) {
      sdkSignatures.push({ name, fields, fieldCount: fields.size });
    }
  }

  const sdkSignatureNames = new Set(sdkSignatures.map((s) => s.name));

  for (const model of spec.models) {
    if (mapped.has(model.name)) continue;
    if (model.fields.length < 2) continue;

    // Strategy 2a: Prefer exact name match — if the IR model name matches an SDK
    // interface name exactly, use it without Jaccard scoring. This prevents
    // false positives when a superset interface (e.g., DirectoryUserWithGroups)
    // scores higher than the exact match (DirectoryUser).
    if (sdkSignatureNames.has(model.name) && !usedSdkNames.has(model.name)) {
      lookup.modelNameByIR.set(model.name, model.name);
      mapped.add(model.name);
      usedSdkNames.add(model.name);
      continue;
    }

    // Strategy 2a+: Try derived model names before falling back to Jaccard
    const derivedNames = hints.derivedModelNames(model.name);
    for (const derived of derivedNames) {
      if (sdkSignatureNames.has(derived) && !usedSdkNames.has(derived)) {
        lookup.modelNameByIR.set(model.name, derived);
        mapped.add(model.name);
        usedSdkNames.add(derived);
        break;
      }
    }
    if (mapped.has(model.name)) continue;

    // In strict mode, skip Jaccard entirely
    if (options?.strictModelMatch) continue;

    // Strategy 2b: Fall back to Jaccard field-similarity matching
    const irFields = irModelFieldSignature(model);
    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const sdk of sdkSignatures) {
      if (usedSdkNames.has(sdk.name)) continue;

      const { score, intersection } = jaccardSimilarity(irFields, sdk.fields);

      // Require ≥60% Jaccard AND enough fields in common (scaled by model size)
      const minIntersection = Math.max(3, Math.ceil(irFields.size * 0.5));
      if (score > bestScore && score >= 0.6 && intersection >= minIntersection) {
        bestScore = score;
        bestMatch = sdk.name;
      }
    }

    if (bestMatch) {
      lookup.modelNameByIR.set(model.name, bestMatch);
      mapped.add(model.name);
      usedSdkNames.add(bestMatch);
    }
  }
}

/**
 * Patch overlay with violations from a failed verification.
 * Adds explicit name mappings for symbols that were generated with wrong names.
 * Returns a new OverlayLookup (immutable).
 */
export function patchOverlay(overlay: OverlayLookup, violations: Violation[], baseline: ApiSurface): OverlayLookup {
  const patched: OverlayLookup = {
    methodByOperation: new Map(overlay.methodByOperation),
    httpKeyByMethod: new Map(overlay.httpKeyByMethod),
    interfaceByName: new Map(overlay.interfaceByName),
    typeAliasByName: new Map(overlay.typeAliasByName),
    requiredExports: new Map(Array.from(overlay.requiredExports.entries()).map(([k, v]) => [k, new Set(v)])),
    modelNameByIR: new Map(overlay.modelNameByIR),
    fileBySymbol: new Map(overlay.fileBySymbol),
  };

  let warnedManifest = false;

  for (const v of violations) {
    if (v.category === 'public-api') {
      // For missing methods: symbolPath is "ClassName.methodName"
      const parts = v.symbolPath.split('.');
      if (parts.length === 2) {
        const [className, methodName] = parts;
        // Check if this is a method on a class in the baseline
        const baseClass = baseline.classes[className];
        if (baseClass && baseClass.methods[methodName]?.length > 0) {
          // Use reverse map to resolve the HTTP key for this method.
          // NOTE: httpKeyByMethod is only populated when a manifest was provided
          // to buildOverlayLookup. Without a manifest, method-level violations
          // cannot be patched via overlay — the emitter must implement
          // generateManifest for the self-correcting loop to resolve these.
          const httpKey = overlay.httpKeyByMethod.get(`${className}.${methodName}`);
          if (!httpKey && overlay.httpKeyByMethod.size === 0 && !warnedManifest) {
            console.warn(
              'Warning: No smoke-manifest.json available. Method-level violations cannot be auto-patched. ' +
                'Implement generateManifest in your emitter for the self-correcting loop to resolve these.',
            );
            warnedManifest = true;
          }
          if (httpKey) {
            const method = baseClass.methods[methodName][0];
            patched.methodByOperation.set(httpKey, {
              className,
              methodName,
              params: method.params,
              returnType: method.returnType,
            });
          }
        }
        // Also check if it's an interface field
        const baseIface = baseline.interfaces[className];
        if (baseIface) {
          patched.interfaceByName.set(className, className);
        }
      } else if (parts.length === 1) {
        // Top-level symbol: class, interface, type alias, or enum
        const name = parts[0];
        if (baseline.interfaces[name]) {
          patched.interfaceByName.set(name, name);
        }
        if (baseline.typeAliases[name]) {
          patched.typeAliasByName.set(name, name);
        }
      }
    }

    if (v.category === 'export-structure') {
      // symbolPath is "exports[path].symbolName"
      const match = v.symbolPath.match(/^exports\[(.+?)\]\.(.+)$/);
      if (match) {
        const [, path, symbol] = match;
        if (!patched.requiredExports.has(path)) {
          patched.requiredExports.set(path, new Set());
        }
        patched.requiredExports.get(path)!.add(symbol);
      }
    }
  }

  return patched;
}
