import type { ApiSpec, TypeRef } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import type { ApiSurface, ApiMethod, DiffResult, Violation, Addition, LanguageHints } from './types.js';

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
 */
export function filterSurface(surface: ApiSurface, allowedNames: Set<string>): ApiSurface {
  return {
    ...surface,
    classes: filterRecord(surface.classes, allowedNames),
    interfaces: filterRecord(surface.interfaces, allowedNames),
    typeAliases: filterRecord(surface.typeAliases, allowedNames),
    enums: filterRecord(surface.enums, allowedNames),
    exports: {}, // exports are structural, not symbol-level — skip for scoped comparison
  };
}

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
      totalBaseline += Object.keys(baseClass.methods).length;
      totalBaseline += Object.keys(baseClass.properties).length;
      continue;
    }
    preserved++;

    // Diff methods
    for (const [methodName, baseMethod] of Object.entries(baseClass.methods)) {
      totalBaseline++;
      const candMethod = candClass.methods[methodName];
      if (!candMethod) {
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
      if (!signaturesMatch(baseMethod, candMethod)) {
        violations.push({
          category: 'signature',
          severity: 'breaking',
          symbolPath: `${name}.${methodName}`,
          baseline: formatSignature(baseMethod),
          candidate: formatSignature(candMethod),
          message: `Signature mismatch for "${name}.${methodName}"`,
        });
        continue;
      }
      preserved++;
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

  // Diff interfaces
  for (const [name, baseIface] of Object.entries(baseline.interfaces)) {
    totalBaseline++;
    const candIface = candidate.interfaces[name];
    if (!candIface) {
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
        violations.push({
          category: 'public-api',
          severity: 'breaking',
          symbolPath: `${name}.${fieldName}`,
          baseline: baseField.type,
          candidate: '(missing)',
          message: `Field "${name}.${fieldName}" exists in baseline but not in generated output`,
        });
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
      if (hints.tolerateCategoryMismatch && (candidate.interfaces[name] || candidate.classes[name] || candidate.enums[name])) {
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
    let enumMatch = true;
    for (const [member, value] of Object.entries(baseEnum.members)) {
      if (candEnum.members[member] !== value) {
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

  // All baseline params must exist with matching types
  for (let i = 0; i < baseline.params.length; i++) {
    const baseParam = baseline.params[i];
    const candParam = candidate.params[i];
    if (!candParam) return false;
    if (baseParam.type !== candParam.type) return false;
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
