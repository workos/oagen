import type { ApiSurface, ApiInterface, Violation, OverlayLookup } from './types.js';
import type { ApiSpec, Model } from '../ir/types.js';
import { toSnakeCase } from '../utils/naming.js';

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
function findClassForProperty(surface: ApiSurface, sdkResourceProperty: string): string | undefined {
  for (const [className, cls] of Object.entries(surface.classes)) {
    // Check if the class itself maps to this property (camelCase match)
    if (sdkResourceProperty === className.charAt(0).toLowerCase() + className.slice(1)) {
      return className;
    }
    // Check constructor params or properties for a match
    for (const propName of Object.keys(cls.properties)) {
      if (propName === sdkResourceProperty) {
        return className;
      }
    }
  }
  return undefined;
}

export function buildOverlayLookup(surface: ApiSurface, manifest?: ManifestEntry[], spec?: ApiSpec): OverlayLookup {
  const lookup: OverlayLookup = {
    methodByOperation: new Map(),
    httpKeyByMethod: new Map(),
    interfaceByName: new Map(),
    typeAliasByName: new Map(),
    requiredExports: new Map(),
    modelNameByIR: new Map(),
  };

  // If manifest available, map operationId → HTTP method + path → existing method
  if (manifest) {
    for (const entry of manifest) {
      const key = `${entry.httpMethod.toUpperCase()} ${entry.path}`;
      const className = findClassForProperty(surface, entry.sdkResourceProperty);
      if (className) {
        const method = surface.classes[className]?.methods[entry.sdkMethodName];
        if (method) {
          lookup.methodByOperation.set(key, {
            className,
            methodName: entry.sdkMethodName,
            params: method.params,
            returnType: method.returnType,
          });
          lookup.httpKeyByMethod.set(`${className}.${entry.sdkMethodName}`, key);
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

  // Auto-infer IR model name → SDK interface name mappings
  if (spec) {
    buildModelNameMap(surface, spec, lookup);
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
 * Returns a value between 0 (no overlap) and 1 (identical).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
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
 * Extract the innermost type name from a return type string.
 * "Promise<AutoPaginatable<Organization>>" → "Organization"
 * "Promise<Organization>" → "Organization"
 * "Promise<void>" → null
 */
function extractReturnTypeName(returnType: string): string | null {
  // Strip Promise< >
  let inner = returnType;
  while (inner.startsWith('Promise<') && inner.endsWith('>')) {
    inner = inner.slice(8, -1);
  }
  // Strip generic wrappers like AutoPaginatable<T>, ListResponse<T>
  const genericMatch = inner.match(/^[A-Za-z]+<(.+)>$/);
  if (genericMatch) {
    inner = genericMatch[1];
  }
  // Strip array suffix
  inner = inner.replace(/\[\]$/, '');
  // Ignore primitives and void
  if (['void', 'string', 'number', 'boolean', 'any', 'unknown', 'null', 'undefined'].includes(inner)) {
    return null;
  }
  return inner;
}

/**
 * Extract the innermost type name from a param type string.
 * "CreateOrganizationOptions" → "CreateOrganizationOptions"
 */
function extractParamTypeName(paramType: string): string | null {
  if (['string', 'number', 'boolean', 'any', 'unknown'].includes(paramType)) {
    return null;
  }
  return paramType;
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
function buildModelNameMap(surface: ApiSurface, spec: ApiSpec, lookup: OverlayLookup): void {
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
          const sdkTypeName = extractReturnTypeName(methodOverlay.returnType);
          if (sdkTypeName && surface.interfaces[sdkTypeName]) {
            lookup.modelNameByIR.set(op.response.name, sdkTypeName);
            mapped.add(op.response.name);
            usedSdkNames.add(sdkTypeName);
          }
        }

        // Match request body model → SDK param type
        if (op.requestBody?.kind === 'model' && !mapped.has(op.requestBody.name)) {
          for (const param of methodOverlay.params) {
            const sdkTypeName = extractParamTypeName(param.type);
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

  for (const model of spec.models) {
    if (mapped.has(model.name)) continue;
    if (model.fields.length < 2) continue;

    const irFields = irModelFieldSignature(model);
    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const sdk of sdkSignatures) {
      if (usedSdkNames.has(sdk.name)) continue;

      const score = jaccardSimilarity(irFields, sdk.fields);

      // Require ≥60% Jaccard AND ≥3 fields in common
      let intersection = 0;
      for (const f of irFields) {
        if (sdk.fields.has(f)) intersection++;
      }

      if (score > bestScore && score >= 0.6 && intersection >= 3) {
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
  };

  for (const v of violations) {
    if (v.category === 'public-api') {
      // For missing methods: symbolPath is "ClassName.methodName"
      const parts = v.symbolPath.split('.');
      if (parts.length === 2) {
        const [className, methodName] = parts;
        // Check if this is a method on a class in the baseline
        const baseClass = baseline.classes[className];
        if (baseClass && baseClass.methods[methodName]) {
          // Use reverse map to resolve the HTTP key for this method.
          // NOTE: httpKeyByMethod is only populated when a manifest was provided
          // to buildOverlayLookup. Without a manifest, method-level violations
          // cannot be patched via overlay — the emitter must implement
          // generateManifest for the self-correcting loop to resolve these.
          const httpKey = overlay.httpKeyByMethod.get(`${className}.${methodName}`);
          if (httpKey) {
            const method = baseClass.methods[methodName];
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
