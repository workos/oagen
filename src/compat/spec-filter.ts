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

  // Build set of top-level enum names for filtering inline enums
  const topLevelEnumNames = new Set(spec.enums.map((e) => e.name));

  // Service classes
  for (const service of spec.services) {
    names.add(service.name);
    for (const op of service.operations) {
      // Operation methods are matched by the class diff, not by name here
      collectTypeRefNames(op.response, names, hints, topLevelEnumNames);
      if (op.requestBody) collectTypeRefNames(op.requestBody, names, hints, topLevelEnumNames);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collectTypeRefNames(p.type, names, hints, topLevelEnumNames);
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
      collectTypeRefNames(field.type, names, hints, topLevelEnumNames);
    }
  }

  // Enums → type aliases
  for (const e of spec.enums) {
    names.add(e.name);
  }

  return names;
}

/**
 * Compute a map of enum name → set of wire values that appear in the spec.
 * Used by filterSurface to exclude hand-added enum members that aren't in the spec.
 */
export function specDerivedEnumValues(spec: ApiSpec): Map<string, Set<string | number>> {
  const result = new Map<string, Set<string | number>>();
  for (const e of spec.enums) {
    result.set(e.name, new Set(e.values.map((v) => v.value)));
  }
  return result;
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

/**
 * Compute the set of method paths (e.g., "SSO.authorize") that are defined
 * as operations in the OpenAPI spec's services. Used by filterSurface to
 * exclude hand-written SDK methods that don't correspond to spec operations.
 */
export function specDerivedMethodPaths(spec: ApiSpec): Set<string> {
  const paths = new Set<string>();
  for (const service of spec.services) {
    for (const op of service.operations) {
      paths.add(`${service.name}.${op.name}`);
    }
  }
  return paths;
}

/**
 * Compute the set of HTTP operation keys (e.g., "GET /sso/authorize") that
 * exist in the spec. Used for overlay-based method matching.
 */
export function specDerivedHttpKeys(spec: ApiSpec): Set<string> {
  const keys = new Set<string>();
  for (const service of spec.services) {
    for (const op of service.operations) {
      keys.add(`${op.httpMethod.toUpperCase()} ${op.path}`);
    }
  }
  return keys;
}

function collectTypeRefNames(ref: TypeRef, out: Set<string>, hints: LanguageHints, topLevelEnums?: Set<string>): void {
  walkTypeRef(ref, {
    model: (r) => {
      out.add(r.name);
      for (const derived of hints.derivedModelNames(r.name)) {
        out.add(derived);
      }
    },
    enum: (r) => {
      // Only include enums that are top-level (in spec.enums). Inline enums
      // embedded in TypeRefs (e.g., query parameter enums) may not be emitted
      // by all emitters, so they should not create false-positive violations.
      if (!topLevelEnums || topLevelEnums.has(r.name)) {
        out.add(r.name);
      }
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
 *
 * For classes: when methodPaths is provided, only keeps methods whose names
 * appear in the spec-derived method paths. This prevents false positives from
 * hand-written SDK methods (e.g., SSO.authorization_url, Webhooks.construct_event)
 * that don't correspond to spec operations. Properties on service classes are
 * also filtered: only UPPER_CASE constants that are spec-derivable are kept.
 */
export function filterSurface(
  surface: ApiSurface,
  allowedNames: Set<string>,
  opts?: {
    fieldPaths?: Set<string>;
    methodPaths?: Set<string>;
    enumValues?: Map<string, Set<string | number>>;
  },
): ApiSurface {
  const { fieldPaths, methodPaths, enumValues } = opts ?? {};
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

  let filteredClasses = filterRecord(surface.classes, allowedNames);

  // Filter class methods and properties by spec-derived method paths if provided
  if (methodPaths) {
    // Build a set of service-class names that have spec-derived methods.
    // Only filter methods on these classes; non-service model classes keep all members.
    const serviceClassNames = new Set<string>();
    for (const path of methodPaths) {
      const dot = path.indexOf('.');
      if (dot !== -1) serviceClassNames.add(path.slice(0, dot));
    }

    const newClasses: Record<string, (typeof filteredClasses)[string]> = {};
    for (const [name, cls] of Object.entries(filteredClasses)) {
      if (serviceClassNames.has(name)) {
        // Service class — filter methods and properties by spec-derived method paths
        const filteredMethods: typeof cls.methods = {};
        for (const [methodName, overloads] of Object.entries(cls.methods)) {
          if (methodPaths.has(`${name}.${methodName}`)) {
            filteredMethods[methodName] = overloads;
          }
        }

        // Filter properties: only keep properties that are spec-derivable.
        // Hand-written constants (PROVIDERS, DEFAULT_TOLERANCE, WIDGET_SCOPES)
        // are not derivable from the spec and should be excluded.
        const filteredProperties: typeof cls.properties = {};
        for (const [propName, prop] of Object.entries(cls.properties)) {
          if (methodPaths.has(`${name}.${propName}`)) {
            filteredProperties[propName] = prop;
          }
        }

        newClasses[name] = {
          ...cls,
          methods: filteredMethods,
          properties: filteredProperties,
        };
      } else if (fieldPaths) {
        // Non-service (model) class — filter properties by spec-derived field paths.
        // In some languages (Ruby, PHP), models are represented as classes with
        // properties rather than interfaces with fields. Apply the same field-level
        // filtering used for interfaces to exclude hand-added SDK fields.
        const filteredProperties: typeof cls.properties = {};
        for (const [propName, prop] of Object.entries(cls.properties)) {
          if (fieldPaths.has(`${name}.${propName}`)) {
            filteredProperties[propName] = prop;
          }
        }

        // Also filter methods on model classes: convenience methods like
        // `primary_email` are hand-written and not spec-derivable.
        // Keep utility methods (from_json, to_json, etc.) if they appear in fieldPaths,
        // otherwise drop non-spec methods.
        const filteredMethods: typeof cls.methods = {};
        for (const [methodName, overloads] of Object.entries(cls.methods)) {
          if (fieldPaths.has(`${name}.${methodName}`) || methodPaths.has(`${name}.${methodName}`)) {
            filteredMethods[methodName] = overloads;
          }
        }

        newClasses[name] = {
          ...cls,
          methods: filteredMethods,
          properties: filteredProperties,
        };
      } else {
        // No filtering available — keep as-is
        newClasses[name] = cls;
      }
    }
    filteredClasses = newClasses;
  }

  // Filter enum members by spec-derived values if provided
  let filteredEnums = filterRecord(surface.enums, allowedNames);
  if (enumValues) {
    const newEnums: Record<string, (typeof filteredEnums)[string]> = {};
    for (const [name, enumDef] of Object.entries(filteredEnums)) {
      const specValues = enumValues.get(name);
      if (!specValues) {
        // Enum not in spec values map — keep as-is
        newEnums[name] = enumDef;
        continue;
      }
      // Filter members: keep only those whose wire value is in the spec.
      // Use case-insensitive comparison since some extractors produce
      // PascalCase values (e.g., "Pending") while the spec has lowercase.
      const specValuesLower = new Set([...specValues].map((v) => String(v).toLowerCase()));
      const filteredMembers: typeof enumDef.members = {};
      for (const [member, value] of Object.entries(enumDef.members)) {
        if (specValues.has(value) || specValuesLower.has(String(value).toLowerCase())) {
          filteredMembers[member] = value;
        }
      }
      newEnums[name] = { ...enumDef, members: filteredMembers };
    }
    filteredEnums = newEnums;
  }

  return {
    ...surface,
    classes: filteredClasses,
    interfaces: filteredInterfaces,
    typeAliases: filterRecord(surface.typeAliases, allowedNames),
    enums: filteredEnums,
    exports: {}, // exports are structural, not symbol-level — skip for scoped comparison
  };
}
