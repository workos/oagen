/**
 * Compatibility diff engine.
 *
 * Compares two API surfaces (or compat snapshots) and produces classified
 * changes with policy-aware severity, provenance, and conceptual change IDs.
 *
 * This replaces the previous unclassified diff engine with a richer model
 * that supports cross-language severity analysis and approval matching.
 */

import type { ApiSurface, ApiMethod, LanguageHints, DiffResult, Violation, Addition } from './types.js';
import type { CompatSnapshot, CompatSymbol } from './ir.js';
import type { CompatPolicyHints } from './policy.js';
import type { ClassifiedChange, ClassificationResult } from './classify.js';
import { classifySymbolChanges, classifyAddedSymbol, summarizeChanges } from './classify.js';
import { NAMED_TYPE_RE, typeExistsInSurface } from './language-hints.js';

export {
  specDerivedNames,
  specDerivedFieldPaths,
  specDerivedMethodPaths,
  specDerivedHttpKeys,
  specDerivedEnumValues,
  filterSurface,
} from './spec-filter.js';

// ---------------------------------------------------------------------------
// New: CompatSnapshot-based diff
// ---------------------------------------------------------------------------

/** Result of diffing two compat snapshots. */
export interface CompatDiffResult {
  changes: ClassifiedChange[];
  summary: ClassificationResult['summary'];
}

/**
 * Diff two compat snapshots, producing classified changes with
 * policy-aware severity.
 */
export function diffSnapshots(
  baseline: CompatSnapshot,
  candidate: CompatSnapshot,
  policy?: CompatPolicyHints,
): CompatDiffResult {
  const effectivePolicy = policy ?? baseline.policies;
  const changes: ClassifiedChange[] = [];

  // Build set of service wrapper fqNames from both snapshots so we can
  // suppress constructor noise — users never instantiate service classes
  // directly, so their constructor changes are not public-API breaking.
  const serviceAccessors = new Set<string>();
  for (const sym of baseline.symbols) {
    if (sym.kind === 'service_accessor') serviceAccessors.add(sym.fqName);
  }
  for (const sym of candidate.symbols) {
    if (sym.kind === 'service_accessor') serviceAccessors.add(sym.fqName);
  }

  // Index candidate symbols by ID and fqName for lookup
  const candById = new Map<string, CompatSymbol>();
  const candByFqName = new Map<string, CompatSymbol>();
  for (const sym of candidate.symbols) {
    candById.set(sym.id, sym);
    candByFqName.set(sym.fqName, sym);
  }

  // Index baseline symbols by fqName
  const baseByFqName = new Set<string>();
  for (const sym of baseline.symbols) {
    baseByFqName.add(sym.fqName);
  }

  // Compare each baseline symbol against candidate
  for (const baseSym of baseline.symbols) {
    if (isServiceWrapperConstructor(baseSym, serviceAccessors)) continue;
    const candSym = candById.get(baseSym.id) ?? candByFqName.get(baseSym.fqName);
    changes.push(...classifySymbolChanges(baseSym, candSym, effectivePolicy));
  }

  // Detect added symbols
  for (const candSym of candidate.symbols) {
    if (!baseByFqName.has(candSym.fqName)) {
      if (isServiceWrapperConstructor(candSym, serviceAccessors)) continue;
      changes.push(classifyAddedSymbol(candSym));
    }
  }

  return {
    changes,
    summary: summarizeChanges(changes),
  };
}

/**
 * Check if a symbol is a constructor belonging to a service wrapper class.
 *
 * Service wrapper constructors are internal plumbing (taking a client/config
 * object) — users interact with services via `client.admin_portal`, not
 * `new AdminPortal(...)`.  Changes to these constructors should not be
 * reported as breaking.
 *
 * Catches two patterns:
 *  - Ruby: kind === 'constructor', ownerFqName is a service_accessor
 *  - PHP:  kind === 'callable' with fqName ending in '.__construct'
 */
function isServiceWrapperConstructor(sym: CompatSymbol, serviceAccessors: Set<string>): boolean {
  if (!sym.ownerFqName || !serviceAccessors.has(sym.ownerFqName)) return false;
  if (sym.kind === 'constructor') return true;
  if (sym.kind === 'callable' && sym.fqName.endsWith('.__construct')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Legacy: ApiSurface-based diff (delegates to existing logic)
// ---------------------------------------------------------------------------

/**
 * Compare two ApiSurface objects and return a DiffResult.
 *
 * This preserves the existing diffing behavior used by the overlay retry loop,
 * compat check, and all existing tests. The internal implementation uses the
 * same algorithms as before to maintain full backward compatibility with
 * overlay patching and verification workflows.
 */
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
      if (!tolerated) {
        const baseFieldNamesLower = new Set(Object.keys(baseIface.fields).map((f) => f.toLowerCase()));
        if (baseFieldNamesLower.size > 0) {
          for (const [, candFieldNamesLower] of candIfaceFieldSets) {
            if (
              candFieldNamesLower.size === baseFieldNamesLower.size &&
              [...baseFieldNamesLower].every((f) => candFieldNamesLower.has(f))
            ) {
              tolerated = true;
              break;
            }
          }
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
        if (hints.isUnionReorder(baseField.type, candField.type)) {
          preserved++;
          continue;
        }
        if (hints.isTypeEquivalent?.(baseField.type, candField.type, candidate)) {
          preserved++;
          continue;
        }
        const nullableOnly = hints.isNullableOnlyDifference(baseField.type, candField.type);
        const genericParam = hints.isGenericTypeParam(baseField.type);
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
        if (isWarning) preserved++;
        continue;
      }
      preserved++;
    }

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
        continue;
      }

      const valueMatches = candValueToMembers.get(value);
      if (valueMatches && valueMatches.length > 0) {
        violations.push({
          category: 'signature',
          severity: 'warning',
          symbolPath: `${name}.${member}`,
          baseline: `${member}=${String(value)}`,
          candidate: `${valueMatches[0]}=${String(value)}`,
          message: `Enum member name differs for "${name}.${member}" (value "${value}" preserved as "${valueMatches[0]}")`,
        });
        continue;
      }

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

      const isExtractionArtifact =
        String(value) === member || member === 'JsonEnumDefaultValue' || member === 'JsonProperty';
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

// ---------------------------------------------------------------------------
// Internal helpers (legacy)
// ---------------------------------------------------------------------------

function signaturesMatch(baseline: ApiMethod, candidate: ApiMethod): boolean {
  if (baseline.returnType !== candidate.returnType) return false;
  for (let i = 0; i < baseline.params.length; i++) {
    const baseParam = baseline.params[i];
    const candParam = candidate.params[i];
    if (!candParam) return false;
    if (baseParam.type !== candParam.type) return false;
    if (baseParam.name !== candParam.name) return false;
  }
  for (let i = baseline.params.length; i < candidate.params.length; i++) {
    if (!candidate.params[i].optional) return false;
  }
  return true;
}

function formatSignature(method: ApiMethod): string {
  const params = method.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
  return `(${params}) => ${method.returnType}`;
}
