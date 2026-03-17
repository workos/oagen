import type { ApiSpec, TypeRef } from '../ir/types.js';
import type { ApiSurface, ApiMethod, DiffResult, Violation, Addition } from './types.js';

/**
 * Compute the set of symbol names that are derivable from the OpenAPI spec.
 * Only these names should be compared during compat verification — everything
 * else in the baseline is hand-written and out of scope for generation.
 */
export function specDerivedNames(spec: ApiSpec): Set<string> {
  const names = new Set<string>();

  // Service classes
  for (const service of spec.services) {
    names.add(service.name);
    for (const op of service.operations) {
      // Operation methods are matched by the class diff, not by name here
      collectTypeRefNames(op.response, names);
      if (op.requestBody) collectTypeRefNames(op.requestBody, names);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
        collectTypeRefNames(p.type, names);
      }
    }
  }

  // Models → domain interface + Response interface + Serialized variant
  for (const model of spec.models) {
    names.add(model.name);
    names.add(`${model.name}Response`);
    names.add(`Serialized${model.name}`);
    for (const field of model.fields) {
      collectTypeRefNames(field.type, names);
    }
  }

  // Enums → type aliases
  for (const e of spec.enums) {
    names.add(e.name);
  }

  return names;
}

function collectTypeRefNames(ref: TypeRef, out: Set<string>): void {
  switch (ref.kind) {
    case 'model':
      out.add(ref.name);
      out.add(`${ref.name}Response`);
      out.add(`Serialized${ref.name}`);
      break;
    case 'enum':
      out.add(ref.name);
      break;
    case 'array':
      collectTypeRefNames(ref.items, out);
      break;
    case 'nullable':
      collectTypeRefNames(ref.inner, out);
      break;
    case 'union':
      ref.variants.forEach((v) => collectTypeRefNames(v, out));
      break;
    case 'map':
      collectTypeRefNames(ref.valueType, out);
      break;
    case 'literal':
    case 'primitive':
      break;
  }
}

/**
 * Filter an ApiSurface to only include symbols whose names appear in the
 * allowed set. Symbols not in the set are dropped entirely — they won't
 * count toward the total or produce violations.
 */
export function filterSurface(surface: ApiSurface, allowedNames: Set<string>): ApiSurface {
  const classes: typeof surface.classes = {};
  for (const [name, cls] of Object.entries(surface.classes)) {
    if (allowedNames.has(name)) classes[name] = cls;
  }

  const interfaces: typeof surface.interfaces = {};
  for (const [name, iface] of Object.entries(surface.interfaces)) {
    if (allowedNames.has(name)) interfaces[name] = iface;
  }

  const typeAliases: typeof surface.typeAliases = {};
  for (const [name, alias] of Object.entries(surface.typeAliases)) {
    if (allowedNames.has(name)) typeAliases[name] = alias;
  }

  const enums: typeof surface.enums = {};
  for (const [name, e] of Object.entries(surface.enums)) {
    if (allowedNames.has(name)) enums[name] = e;
  }

  return {
    ...surface,
    classes,
    interfaces,
    typeAliases,
    enums,
    exports: {}, // exports are structural, not symbol-level — skip for scoped comparison
  };
}

/**
 * Returns true if the only difference between two type strings is the presence
 * of `| null`. E.g. `string` vs `string | null` or `Foo | null` vs `Foo`.
 */
function isNullableOnlyDifference(a: string, b: string): boolean {
  const stripNull = (s: string) =>
    s
      .split('|')
      .map((p) => p.trim())
      .filter((p) => p !== 'null')
      .join(' | ');
  return stripNull(a) === stripNull(b);
}

/**
 * Returns true if two type alias values are union types with identical members
 * but in different order. TypeScript's typeToString() doesn't guarantee a
 * stable ordering for union members, so `"a" | "b"` and `"b" | "a"` should
 * be considered equivalent.
 */
function isUnionReorder(a: string, b: string): boolean {
  const parseMembers = (s: string) =>
    s
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean)
      .sort();
  const membersA = parseMembers(a);
  const membersB = parseMembers(b);
  if (membersA.length !== membersB.length || membersA.length < 2) return false;
  return membersA.every((m, i) => m === membersB[i]);
}

/**
 * Returns true if a type string looks like a generic type parameter.
 * Examples: `T`, `TCustomAttributes`, `TRawAttributes`, `T[]`
 * These are type-level variables that only exist at the declaration site
 * and cannot be matched by extraction from generated output.
 */
function isGenericTypeParam(type: string): boolean {
  // Single letter type param (T, U, V, K, etc.)
  if (/^[A-Z]$/.test(type)) return true;
  // T-prefixed PascalCase (TCustomAttributes, TRawAttributes)
  if (/^T[A-Z][a-zA-Z]*$/.test(type)) return true;
  // Array of a generic param (T[])
  if (/^[A-Z]\[\]$/.test(type) || /^T[A-Z][a-zA-Z]*\[\]$/.test(type)) return true;
  return false;
}

export function diffSurfaces(baseline: ApiSurface, candidate: ApiSurface): DiffResult {
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
        const nullableOnly = isNullableOnlyDifference(baseProp.type, candProp.type);
        violations.push({
          category: 'signature',
          severity: nullableOnly ? 'warning' : 'breaking',
          symbolPath: `${name}.${propName}`,
          baseline: baseProp.type,
          candidate: candProp.type,
          message: `Property type mismatch for "${name}.${propName}"`,
        });
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
        if (isUnionReorder(baseField.type, candField.type)) {
          preserved++;
          continue;
        }
        const nullableOnly = isNullableOnlyDifference(baseField.type, candField.type);
        // Generic type params (T, TCustomAttributes, etc.) can't be preserved
        // in generated output — the extractor resolves them to `any`.
        const genericParam = isGenericTypeParam(baseField.type);
        // When candidate resolves to `any`, it's typically an extraction artifact
        // (TS compiler couldn't resolve the type due to missing imports).
        // Downgrade to warning since the generated source likely has the correct type.
        const extractionArtifact = candField.type === 'any' && baseField.type !== 'any';
        violations.push({
          category: 'signature',
          severity: nullableOnly || genericParam || extractionArtifact ? 'warning' : 'breaking',
          symbolPath: `${name}.${fieldName}`,
          baseline: baseField.type,
          candidate: candField.type,
          message: `Field type mismatch for "${name}.${fieldName}"`,
        });
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
      // interface or class instead of a type alias, it's still "present" —
      // just in a different TypeScript declaration form.
      if (candidate.interfaces[name] || candidate.classes[name]) {
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
      // TypeScript's typeToString() doesn't guarantee union member ordering,
      // so two identical string unions can produce different strings.
      // Check for order-independent equality before flagging.
      if (isUnionReorder(baseAlias.value, candAlias.value)) {
        preserved++;
        continue;
      }
      const nullableOnly = isNullableOnlyDifference(baseAlias.value, candAlias.value);
      violations.push({
        category: 'signature',
        severity: nullableOnly ? 'warning' : 'breaking',
        symbolPath: name,
        baseline: baseAlias.value,
        candidate: candAlias.value,
        message: `Type alias value mismatch for "${name}"`,
      });
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
