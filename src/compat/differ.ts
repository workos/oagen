import type { ApiSurface, ApiMethod, DiffResult, Violation, Addition } from './types.js';

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
        violations.push({
          category: 'signature',
          severity: 'breaking',
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
        violations.push({
          category: 'signature',
          severity: 'breaking',
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
      violations.push({
        category: 'signature',
        severity: 'breaking',
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
