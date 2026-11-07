import type { ApiSurface, LanguageHints, Violation } from './types.js';
import type { ApiSpec } from '../ir/types.js';
import type { OperationResolution } from '../ir/operation-hints.js';
import {
  specDerivedNames,
  specDerivedFieldPaths,
  specDerivedMethodPaths,
  memberKeysByClass,
  normalizeMemberName,
} from './spec-filter.js';

/**
 * Detect symbols that exist in the live SDK surface but are no longer defined
 * in the current OpenAPI spec. These are "stale" — they compile and run but
 * represent dead code from a previous spec version.
 *
 * Requires both the old and new spec so we can distinguish hand-written SDK
 * symbols (never in any spec) from genuinely removed spec symbols.
 *
 * Both specs are read as `generate` writes them, under the `resolution`'s
 * `mountRules`, `operationHints` and `operationNaming` (see
 * `specDerivedNames` and `specDerivedMethodPaths`): a service class is the
 * mount target, so under `mountRules: { Pets: 'Animals' }` a live `Animals`
 * class is stale once the new spec drops the `Pets` tag, and a method is stale
 * when the old spec's resolution names it on its class — by the resolved name,
 * a split wrapper's name or the IR's operation name, matched with underscores
 * stripped and case folded — and the new spec's does not: a live
 * `Animals.listAll` under `operationHints: { 'GET /pets': { name: 'list_all' } }`
 * once the new spec drops `GET /pets`, whether or not another service still
 * mounts on `Animals`. A class the new spec no longer names is reported once,
 * at the class level, not again per method.
 */
export function detectStaleSymbols(
  liveSurface: ApiSurface,
  oldSpec: ApiSpec,
  newSpec: ApiSpec,
  hints: LanguageHints,
  resolution?: OperationResolution,
): Violation[] {
  const violations: Violation[] = [];

  // Step 1-3: Name-set difference for top-level symbols
  const oldNames = specDerivedNames(oldSpec, hints, resolution);
  const newNames = specDerivedNames(newSpec, hints, resolution);

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

  // Step 7: Method-level staleness on classes that still exist in the new
  // spec: a live method the old spec's resolution named on its class, by any
  // of its keys, and the new spec's resolution does not. Read per class, not
  // from the differ's `operation-removed` changes: those are keyed by the
  // IR's service and operation names, and a removed service yields none at
  // all, so the methods of a service merged onto a surviving mount target
  // were never found.
  const oldMembers = memberKeysByClass(specDerivedMethodPaths(oldSpec, resolution));
  const newMembers = memberKeysByClass(specDerivedMethodPaths(newSpec, resolution));

  for (const [className, members] of oldMembers) {
    // A class the new spec no longer names is reported above, once.
    if (removedNames.has(className)) continue;
    const cls = liveSurface.classes[className];
    if (!cls) continue;
    const surviving = newMembers.get(className);
    for (const methodName of Object.keys(cls.methods)) {
      const key = normalizeMemberName(methodName);
      if (!members.has(key) || surviving?.has(key)) continue;
      violations.push({
        category: 'staleness',
        severity: 'warning',
        symbolPath: `${className}.${methodName}`,
        baseline: methodName,
        candidate: '(removed from spec)',
        message: `Method "${className}.${methodName}" is no longer defined in the OpenAPI spec`,
      });
    }
  }

  return violations;
}
