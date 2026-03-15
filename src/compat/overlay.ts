import type { ApiSurface, Violation, OverlayLookup } from './types.js';

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

export function buildOverlayLookup(surface: ApiSurface, manifest?: ManifestEntry[]): OverlayLookup {
  const lookup: OverlayLookup = {
    methodByOperation: new Map(),
    httpKeyByMethod: new Map(),
    interfaceByName: new Map(),
    typeAliasByName: new Map(),
    requiredExports: new Map(),
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

  return lookup;
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
