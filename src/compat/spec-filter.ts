import type { ApiSpec, TypeRef } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import type { ApiSurface, LanguageHints } from './types.js';

/**
 * Compute the set of symbol names that are derivable from the OpenAPI spec.
 * Only these names should be compared during compat verification — everything
 * else in the baseline is hand-written and out of scope for generation.
 */
export function specDerivedNames(spec: ApiSpec, hints: LanguageHints): Set<string> {
  const names = new Set<string>();

  // Service classes
  for (const service of spec.services) {
    names.add(service.name);
    for (const op of service.operations) {
      // Operation methods are matched by the class diff, not by name here
      collectTypeRefNames(op.response, names, hints);
      if (op.requestBody) collectTypeRefNames(op.requestBody, names, hints);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
        collectTypeRefNames(p.type, names, hints);
      }
    }
  }

  // Models → domain interface + language-specific derived names
  for (const model of spec.models) {
    names.add(model.name);
    for (const derived of hints.derivedModelNames(model.name)) {
      names.add(derived);
    }
    for (const field of model.fields) {
      collectTypeRefNames(field.type, names, hints);
    }
  }

  // Enums → type aliases
  for (const e of spec.enums) {
    names.add(e.name);
  }

  return names;
}

/**
 * Compute the set of field paths (e.g., "Organization.name") that are defined
 * in the OpenAPI spec's model schemas. Used by filterSurface to exclude
 * hand-added SDK fields that reference spec-derived types.
 */
export function specDerivedFieldPaths(spec: ApiSpec, hints: LanguageHints): Set<string> {
  const paths = new Set<string>();
  for (const model of spec.models) {
    for (const field of model.fields) {
      paths.add(`${model.name}.${field.name}`);
    }
    // Also add field paths for derived model names (e.g., OrganizationResponse.name)
    for (const derived of hints.derivedModelNames(model.name)) {
      for (const field of model.fields) {
        paths.add(`${derived}.${field.name}`);
      }
    }
  }
  return paths;
}

function collectTypeRefNames(ref: TypeRef, out: Set<string>, hints: LanguageHints): void {
  walkTypeRef(ref, {
    model: (r) => {
      out.add(r.name);
      for (const derived of hints.derivedModelNames(r.name)) {
        out.add(derived);
      }
    },
    enum: (r) => {
      out.add(r.name);
    },
  });
}

function filterRecord<T>(record: Record<string, T>, allowed: Set<string>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [name, value] of Object.entries(record)) {
    if (allowed.has(name)) result[name] = value;
  }
  return result;
}

/**
 * Filter an ApiSurface to only include symbols whose names appear in the
 * allowed set. Symbols not in the set are dropped entirely — they won't
 * count toward the total or produce violations.
 *
 * For interfaces: when fieldPaths is provided, only keeps fields that appear
 * in the spec-derived field paths. This prevents false positives from hand-added
 * SDK fields that reference spec-derived types but aren't defined in the spec.
 */
export function filterSurface(surface: ApiSurface, allowedNames: Set<string>, fieldPaths?: Set<string>): ApiSurface {
  const filteredInterfaces = filterRecord(surface.interfaces, allowedNames);

  // Filter interface fields by spec-derived field paths if provided
  if (fieldPaths) {
    for (const [name, iface] of Object.entries(filteredInterfaces)) {
      const filteredFields: Record<string, (typeof iface.fields)[string]> = {};
      for (const [fieldName, field] of Object.entries(iface.fields)) {
        // Keep the field if its path is spec-derived
        if (fieldPaths.has(`${name}.${fieldName}`)) {
          filteredFields[fieldName] = field;
        }
      }
      filteredInterfaces[name] = { ...iface, fields: filteredFields };
    }
  }

  return {
    ...surface,
    classes: filterRecord(surface.classes, allowedNames),
    interfaces: filteredInterfaces,
    typeAliases: filterRecord(surface.typeAliases, allowedNames),
    enums: filterRecord(surface.enums, allowedNames),
    exports: {}, // exports are structural, not symbol-level — skip for scoped comparison
  };
}
