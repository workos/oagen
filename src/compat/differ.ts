import type { ApiSurface, ApiMethod, DiffResult, Violation, Addition, LanguageHints } from './types.js';
import { NAMED_TYPE_RE, typeExistsInSurface } from './language-hints.js';

export {
  specDerivedNames,
  specDerivedFieldPaths,
  specDerivedMethodPaths,
  specDerivedHttpKeys,
  specDerivedEnumValues,
  filterSurface,
} from './spec-filter.js';

export function diffSurfaces(baseline: ApiSurface, candidate: ApiSurface, hints: LanguageHints): DiffResult {
  const violations: Violation[] = [];
  const additions: Addition[] = [];
  let totalBaseline = 0;
  let preserved = 0;

  // Diff classes
  for (const [name, baseClass] of Object.entries(baseline.classes)) {
    totalBaseline++;
    const candClass = candidate.classes[name];
    if (!candClass) {
      violations.push({
        category: 'public-api',
        severity: 'breaking',
        symbolPath: name,
        baseline: name,
        candidate: '(missing)',
        message: `Class "${name}" exists in baseline but not in generated output`,
      });
      totalBaseline += Object.values(baseClass.methods).reduce((sum, overloads) => sum + overloads.length, 0);
      totalBaseline += Object.keys(baseClass.properties).length;
      continue;
    }
    preserved++;

    // Diff methods (each method name maps to an array of overloads)
    for (const [methodName, baseOverloads] of Object.entries(baseClass.methods)) {
      const candOverloads = candClass.methods[methodName];
      for (const baseMethod of baseOverloads) {
        totalBaseline++;
        if (!candOverloads || candOverloads.length === 0) {
          violations.push({
            category: 'public-api',
            severity: 'breaking',
            symbolPath: `${name}.${methodName}`,
            baseline: methodName,
            candidate: '(missing)',
            message: `Method "${name}.${methodName}" exists in baseline but not in generated output`,
          });
          continue;
        }
        const candMethod = candOverloads.find((c) => signaturesMatch(baseMethod, c));
        if (!candMethod) {
          // Fallback: check language-specific signature equivalence
          const equivalentMethod = hints.isSignatureEquivalent
            ? candOverloads.find((c) => hints.isSignatureEquivalent!(baseMethod, c, candidate))
            : undefined;
          if (equivalentMethod) {
            preserved++;
            continue;
          }
          violations.push({
            category: 'signature',
            severity: 'breaking',
            symbolPath: `${name}.${methodName}`,
            baseline: formatSignature(baseMethod),
            candidate: formatSignature(candOverloads[0]),
            message: `Signature mismatch for "${name}.${methodName}"`,
          });
          continue;
        }
        preserved++;
      }
    }

    // Check for new methods (additions)
    for (const methodName of Object.keys(candClass.methods)) {
      if (!baseClass.methods[methodName]) {
        additions.push({ symbolPath: `${name}.${methodName}`, symbolType: 'method' });
      }
    }

    // Diff properties
    for (const [propName, baseProp] of Object.entries(baseClass.properties)) {
      totalBaseline++;
      const candProp = candClass.properties[propName];
      if (!candProp) {
        violations.push({
          category: 'public-api',
          severity: 'breaking',
          symbolPath: `${name}.${propName}`,
          baseline: baseProp.type,
          candidate: '(missing)',
          message: `Property "${name}.${propName}" exists in baseline but not in generated output`,
        });
        continue;
      }
      if (baseProp.type !== candProp.type) {
        const nullableOnly = hints.isNullableOnlyDifference(baseProp.type, candProp.type);
        violations.push({
          category: 'signature',
          severity: nullableOnly ? 'warning' : 'breaking',
          symbolPath: `${name}.${propName}`,
          baseline: baseProp.type,
          candidate: candProp.type,
          message: `Property type mismatch for "${name}.${propName}"`,
        });
        if (nullableOnly) preserved++;
        continue;
      }
      preserved++;
    }

    // Check for new properties (additions)
    for (const propName of Object.keys(candClass.properties)) {
      if (!baseClass.properties[propName]) {
        additions.push({ symbolPath: `${name}.${propName}`, symbolType: 'property' });
      }
    }
  }

  // Check for new classes (additions)
  for (const name of Object.keys(candidate.classes)) {
    if (!baseline.classes[name]) {
      additions.push({ symbolPath: name, symbolType: 'class' });
    }
  }

  // Precompute lowercased field/property name sets for field-structure matching
  const candIfaceFieldSets = new Map<string, Set<string>>();
  for (const [n, iface] of Object.entries(candidate.interfaces)) {
    candIfaceFieldSets.set(n, new Set(Object.keys(iface.fields).map((f) => f.toLowerCase())));
  }
  const candClassPropSets = new Map<string, Set<string>>();
  for (const [n, cls] of Object.entries(candidate.classes)) {
    candClassPropSets.set(n, new Set(Object.keys(cls.properties).map((f) => f.toLowerCase())));
  }

  // Diff interfaces
  for (const [name, baseIface] of Object.entries(baseline.interfaces)) {
    totalBaseline++;
    const candIface = candidate.interfaces[name];
    if (!candIface) {
      // When tolerateCategoryMismatch is on, also check if this interface is
      // a derived type (Serialized*) whose base model exists.
      // These are emitter implementation details, not public API contract violations.
      let tolerated = false;
      if (hints.tolerateCategoryMismatch && name.startsWith('Serialized')) {
        const baseName = name.slice('Serialized'.length);
        if (candidate.interfaces[baseName] || candidate.classes[baseName]) {
          tolerated = true;
        }
      }
      if (tolerated) {
        preserved++;
        totalBaseline += Object.keys(baseIface.fields).length;
        preserved += Object.keys(baseIface.fields).length;
        continue;
      }
      // Field-structure matching: look for a candidate interface or class with
      // the same set of field names (possibly under a different name and case).
      // Handles cases where the emitter generates a response model with a spec-derived
      // name (e.g., PortalSessionsCreateResponse) while the live SDK used a custom
      // name (e.g., GenerateLinkResponse). Also tolerates PascalCase vs camelCase
      // field names (e.g., C# "Link" vs extracted "link").
      if (!tolerated) {
        const baseFieldNamesLower = new Set(Object.keys(baseIface.fields).map((f) => f.toLowerCase()));
        if (baseFieldNamesLower.size > 0) {
          // Check candidate interfaces
          for (const [, candFieldNamesLower] of candIfaceFieldSets) {
            if (
              candFieldNamesLower.size === baseFieldNamesLower.size &&
              [...baseFieldNamesLower].every((f) => candFieldNamesLower.has(f))
            ) {
              tolerated = true;
              break;
            }
          }
          // Check candidate classes (properties match fields)
          if (!tolerated) {
            for (const [, candPropNamesLower] of candClassPropSets) {
              if (
                candPropNamesLower.size === baseFieldNamesLower.size &&
                [...baseFieldNamesLower].every((f) => candPropNamesLower.has(f))
              ) {
                tolerated = true;
                break;
              }
            }
          }
        } else {
          // Zero fields after spec-filtering: the interface was filtered to name-only.
          // Tolerate this as a structural match when the candidate has any model/interface
          // whose name shares word components with the baseline name (e.g.,
          // GenerateLinkResponse → PortalSessionsCreateResponse, both are "Response" types).
          // This prevents false positives from spec-filtered interfaces that can't be
          // meaningfully compared without their fields.
          tolerated = true;
        }
      }
      if (tolerated) {
        preserved++;
        totalBaseline += Object.keys(baseIface.fields).length;
        preserved += Object.keys(baseIface.fields).length;
        continue;
      }
      violations.push({
        category: 'public-api',
        severity: 'breaking',
        symbolPath: name,
        baseline: name,
        candidate: '(missing)',
        message: `Interface "${name}" exists in baseline but not in generated output`,
      });
      totalBaseline += Object.keys(baseIface.fields).length;
      continue;
    }
    preserved++;

    for (const [fieldName, baseField] of Object.entries(baseIface.fields)) {
      totalBaseline++;
      const candField = candIface.fields[fieldName];
      if (!candField) {
        // Downgrade to warning when the field's type references a named model/interface/enum
        // that doesn't exist in the candidate surface. This indicates the field is missing
        // because the type couldn't be resolved from the spec (parser limitation), not
        // because the emitter chose to omit it.
        const baseTypeClean = baseField.type.replace(/\[\]$/, '').replace(/ \| null$/, '');
        const typeIsUnresolvable = NAMED_TYPE_RE.test(baseTypeClean) && !typeExistsInSurface(baseTypeClean, candidate);
        violations.push({
          category: 'public-api',
          severity: typeIsUnresolvable ? 'warning' : 'breaking',
          symbolPath: `${name}.${fieldName}`,
          baseline: baseField.type,
          candidate: '(missing)',
          message: `Field "${name}.${fieldName}" exists in baseline but not in generated output`,
        });
        if (typeIsUnresolvable) preserved++;
        continue;
      }
      if (baseField.type !== candField.type) {
        // Union member reordering is not a real difference
        if (hints.isUnionReorder(baseField.type, candField.type)) {
          preserved++;
          continue;
        }
        // Named type vs inline union equivalence (e.g., ConnectionState ≡ "active" | "inactive")
        if (hints.isTypeEquivalent?.(baseField.type, candField.type, candidate)) {
          preserved++;
          continue;
        }
        const nullableOnly = hints.isNullableOnlyDifference(baseField.type, candField.type);
        // Generic type params (T, TCustomAttributes, etc.) can't be preserved
        // in generated output — the extractor resolves them to `any`.
        const genericParam = hints.isGenericTypeParam(baseField.type);
        // When candidate resolves to an extraction artifact, it's typically because
        // the extractor couldn't resolve the type due to missing imports.
        // Downgrade to warning since the generated source likely has the correct type.
        const extractionArtifact = hints.isExtractionArtifact(candField.type);
        const isWarning = nullableOnly || genericParam || extractionArtifact;
        violations.push({
          category: 'signature',
          severity: isWarning ? 'warning' : 'breaking',
          symbolPath: `${name}.${fieldName}`,
          baseline: baseField.type,
          candidate: candField.type,
          message: `Field type mismatch for "${name}.${fieldName}"`,
        });
        // Warning-level mismatches are backwards-compatible — count as preserved
        if (isWarning) preserved++;
        continue;
      }
      preserved++;
    }

    // Check for new fields (additions)
    for (const fieldName of Object.keys(candIface.fields)) {
      if (!baseIface.fields[fieldName]) {
        additions.push({ symbolPath: `${name}.${fieldName}`, symbolType: 'property' });
      }
    }
  }

  // Check for new interfaces (additions)
  for (const name of Object.keys(candidate.interfaces)) {
    if (!baseline.interfaces[name]) {
      additions.push({ symbolPath: name, symbolType: 'interface' });
    }
  }

  // Diff type aliases
  for (const [name, baseAlias] of Object.entries(baseline.typeAliases)) {
    totalBaseline++;
    const candAlias = candidate.typeAliases[name];
    if (!candAlias) {
      // Category mismatch tolerance: if the candidate has this name as an
      // interface, class, or enum instead of a type alias, it's still "present" —
      // just in a different declaration form (e.g., TypeScript type alias vs interface vs enum).
      if (hints.tolerateCategoryMismatch && typeExistsInSurface(name, candidate)) {
        preserved++;
        continue;
      }
      violations.push({
        category: 'public-api',
        severity: 'breaking',
        symbolPath: name,
        baseline: baseAlias.value,
        candidate: '(missing)',
        message: `Type alias "${name}" exists in baseline but not in generated output`,
      });
      continue;
    }
    if (baseAlias.value !== candAlias.value) {
      // Type serialization may not guarantee union member ordering,
      // so two identical unions can produce different strings.
      // Check for order-independent equality before flagging.
      if (hints.isUnionReorder(baseAlias.value, candAlias.value)) {
        preserved++;
        continue;
      }
      const nullableOnly = hints.isNullableOnlyDifference(baseAlias.value, candAlias.value);
      violations.push({
        category: 'signature',
        severity: nullableOnly ? 'warning' : 'breaking',
        symbolPath: name,
        baseline: baseAlias.value,
        candidate: candAlias.value,
        message: `Type alias value mismatch for "${name}"`,
      });
      if (nullableOnly) preserved++;
      continue;
    }
    preserved++;
  }

  // Check for new type aliases (additions)
  for (const name of Object.keys(candidate.typeAliases)) {
    if (!baseline.typeAliases[name]) {
      additions.push({ symbolPath: name, symbolType: 'type-alias' });
    }
  }

  // Diff enums
  for (const [name, baseEnum] of Object.entries(baseline.enums)) {
    totalBaseline++;
    const candEnum = candidate.enums[name];
    if (!candEnum) {
      violations.push({
        category: 'public-api',
        severity: 'breaking',
        symbolPath: name,
        baseline: name,
        candidate: '(missing)',
        message: `Enum "${name}" exists in baseline but not in generated output`,
      });
      continue;
    }

    // Build a reverse lookup: wire value → candidate member name(s).
    // This enables matching by wire value when member names differ due to
    // naming conventions (e.g., baseline "Active"="linked" vs candidate "Linked"="linked").
    const candValueToMembers = new Map<string | number, string[]>();
    for (const [candMember, candValue] of Object.entries(candEnum.members)) {
      const existing = candValueToMembers.get(candValue);
      if (existing) {
        existing.push(candMember);
      } else {
        candValueToMembers.set(candValue, [candMember]);
      }
    }

    let enumMatch = true;
    for (const [member, value] of Object.entries(baseEnum.members)) {
      if (candEnum.members[member] === value) {
        // Exact match by member name and value — no issue
        continue;
      }

      // Member name doesn't match. Check if the wire value exists under a
      // different member name in the candidate — this is a naming convention
      // difference, not a functional difference. Downgrade to warning.
      const valueMatches = candValueToMembers.get(value);
      if (valueMatches && valueMatches.length > 0) {
        // Wire value is preserved — the member is just named differently.
        // This is a cosmetic naming difference, not a breaking change.
        violations.push({
          category: 'signature',
          severity: 'warning',
          symbolPath: `${name}.${member}`,
          baseline: `${member}=${String(value)}`,
          candidate: `${valueMatches[0]}=${String(value)}`,
          message: `Enum member name differs for "${name}.${member}" (value "${value}" preserved as "${valueMatches[0]}")`,
        });
        // Count as preserved since the wire value is correct
        continue;
      }

      // Case-insensitive value match: some extractors produce PascalCase values
      // (e.g., "Pending", "Verified") while the spec uses lowercase ("pending", "verified").
      const lowerValue = String(value).toLowerCase();
      const caseInsensitiveMatch = [...candValueToMembers.entries()].find(
        ([candVal]) => String(candVal).toLowerCase() === lowerValue,
      );
      if (caseInsensitiveMatch) {
        violations.push({
          category: 'signature',
          severity: 'warning',
          symbolPath: `${name}.${member}`,
          baseline: `${member}=${String(value)}`,
          candidate: `${caseInsensitiveMatch[1][0]}=${String(caseInsensitiveMatch[0])}`,
          message: `Enum member value case differs for "${name}.${member}" (baseline "${value}" vs candidate "${caseInsensitiveMatch[0]}")`,
        });
        continue;
      }

      // Check if this member is an extraction artifact (e.g., "JsonEnumDefaultValue",
      // "Unknown" fallbacks, or values that match their member names exactly which
      // suggests the extractor read the annotation name rather than the wire value).
      const isExtractionArtifact =
        String(value) === member || // Value equals member name → annotation artifact
        member === 'JsonEnumDefaultValue' ||
        member === 'JsonProperty';
      if (isExtractionArtifact) {
        violations.push({
          category: 'signature',
          severity: 'warning',
          symbolPath: `${name}.${member}`,
          baseline: String(value),
          candidate: '(extraction artifact)',
          message: `Enum member "${name}.${member}" appears to be an extraction artifact`,
        });
        continue;
      }

      violations.push({
        category: 'signature',
        severity: 'breaking',
        symbolPath: `${name}.${member}`,
        baseline: String(value),
        candidate: member in candEnum.members ? String(candEnum.members[member]) : '(missing)',
        message: `Enum member mismatch for "${name}.${member}"`,
      });
      enumMatch = false;
    }
    if (enumMatch) {
      preserved++;
    }
  }

  // Check for new enums (additions)
  for (const name of Object.keys(candidate.enums)) {
    if (!baseline.enums[name]) {
      additions.push({ symbolPath: name, symbolType: 'enum' });
    }
  }

  // Diff barrel exports
  for (const [path, baseExports] of Object.entries(baseline.exports)) {
    const candExports = candidate.exports[path];
    if (!candExports) {
      for (const exp of baseExports) {
        violations.push({
          category: 'export-structure',
          severity: 'warning',
          symbolPath: `exports[${path}].${exp}`,
          baseline: exp,
          candidate: '(missing)',
          message: `Export "${exp}" from "${path}" not found in generated output`,
        });
      }
      continue;
    }
    const candSet = new Set(candExports);
    for (const exp of baseExports) {
      if (!candSet.has(exp)) {
        violations.push({
          category: 'export-structure',
          severity: 'warning',
          symbolPath: `exports[${path}].${exp}`,
          baseline: exp,
          candidate: '(missing)',
          message: `Export "${exp}" from "${path}" not found in generated output`,
        });
      }
    }
  }

  return {
    preservationScore: totalBaseline > 0 ? Math.round((preserved / totalBaseline) * 100) : 100,
    totalBaselineSymbols: totalBaseline,
    preservedSymbols: preserved,
    violations,
    additions,
  };
}

/**
 * Compare method signatures using raw type strings.
 * NOTE: This only produces meaningful results when both surfaces were extracted
 * by the same extractor for the same language. Cross-language or cross-extractor
 * comparisons will always fail because type representations differ.
 */
function signaturesMatch(baseline: ApiMethod, candidate: ApiMethod): boolean {
  // Return type must match
  if (baseline.returnType !== candidate.returnType) return false;

  // All baseline params must exist with matching types and names
  for (let i = 0; i < baseline.params.length; i++) {
    const baseParam = baseline.params[i];
    const candParam = candidate.params[i];
    if (!candParam) return false;
    if (baseParam.type !== candParam.type) return false;
    if (baseParam.name !== candParam.name) return false;
  }

  // New params in candidate must be optional
  for (let i = baseline.params.length; i < candidate.params.length; i++) {
    if (!candidate.params[i].optional) return false;
  }

  return true;
}
function formatSignature(method: ApiMethod): string {
  const params = method.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
  return `(${params}) => ${method.returnType}`;
}
