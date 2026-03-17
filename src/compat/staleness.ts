import type { ApiSurface, LanguageHints, Violation } from './types.js';
import type { ApiSpec } from '../ir/types.js';
import { specDerivedNames, specDerivedFieldPaths } from './spec-filter.js';
import { diffSpecs } from '../differ/diff.js';

/**
 * Detect symbols that exist in the live SDK surface but are no longer defined
 * in the current OpenAPI spec. These are "stale" — they compile and run but
 * represent dead code from a previous spec version.
 *
 * Requires both the old and new spec so we can distinguish hand-written SDK
 * symbols (never in any spec) from genuinely removed spec symbols.
 */
export function detectStaleSymbols(
  liveSurface: ApiSurface,
  oldSpec: ApiSpec,
  newSpec: ApiSpec,
  hints: LanguageHints,
): Violation[] {
  const violations: Violation[] = [];

  // Step 1-3: Name-set difference for top-level symbols
  const oldNames = specDerivedNames(oldSpec, hints);
  const newNames = specDerivedNames(newSpec, hints);

  const removedNames = new Set<string>();
  for (const name of oldNames) {
    if (!newNames.has(name)) removedNames.add(name);
  }

  for (const name of removedNames) {
    if (liveSurface.classes[name]) {
      violations.push({
        category: 'staleness',
        severity: 'warning',
        symbolPath: name,
        baseline: name,
        candidate: '(removed from spec)',
        message: `Class "${name}" is no longer defined in the OpenAPI spec`,
      });
    }
    if (liveSurface.interfaces[name]) {
      violations.push({
        category: 'staleness',
        severity: 'warning',
        symbolPath: name,
        baseline: name,
        candidate: '(removed from spec)',
        message: `Interface "${name}" is no longer defined in the OpenAPI spec`,
      });
    }
    if (liveSurface.typeAliases[name]) {
      violations.push({
        category: 'staleness',
        severity: 'warning',
        symbolPath: name,
        baseline: name,
        candidate: '(removed from spec)',
        message: `Type alias "${name}" is no longer defined in the OpenAPI spec`,
      });
    }
    if (liveSurface.enums[name]) {
      violations.push({
        category: 'staleness',
        severity: 'warning',
        symbolPath: name,
        baseline: name,
        candidate: '(removed from spec)',
        message: `Enum "${name}" is no longer defined in the OpenAPI spec`,
      });
    }
  }

  // Step 4-6: Field-level staleness for models that still exist in new spec
  const oldFieldPaths = specDerivedFieldPaths(oldSpec, hints);
  const newFieldPaths = specDerivedFieldPaths(newSpec, hints);

  for (const fieldPath of oldFieldPaths) {
    if (newFieldPaths.has(fieldPath)) continue;

    const [modelName, fieldName] = fieldPath.split('.');
    // Only flag field-level staleness for models that still exist in the new spec
    // (fully removed models are already caught above)
    if (removedNames.has(modelName)) continue;

    const iface = liveSurface.interfaces[modelName];
    if (iface?.fields[fieldName]) {
      violations.push({
        category: 'staleness',
        severity: 'warning',
        symbolPath: fieldPath,
        baseline: fieldName,
        candidate: '(removed from spec)',
        message: `Field "${fieldPath}" is no longer defined in the OpenAPI spec`,
      });
    }
  }

  // Step 7: Operation-level staleness via diffSpecs
  const diff = diffSpecs(oldSpec, newSpec);
  for (const change of diff.changes) {
    if (change.kind === 'operation-removed') {
      const cls = liveSurface.classes[change.serviceName];
      if (cls?.methods[change.operationName]) {
        violations.push({
          category: 'staleness',
          severity: 'warning',
          symbolPath: `${change.serviceName}.${change.operationName}`,
          baseline: change.operationName,
          candidate: '(removed from spec)',
          message: `Method "${change.serviceName}.${change.operationName}" is no longer defined in the OpenAPI spec`,
        });
      }
    }
  }

  return violations;
}
