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

  // Post-pass: attach spec-level remediation hints when recognized upstream
  // patterns are detected. Currently flags the "schema fork" antipattern —
  // a path's response type was redirected to a brand-new schema whose field
  // set is a superset of the prior schema, which forces a breaking SDK
  // signature change instead of an additive field on the existing schema.
  detectForkedSchemas(changes, baseline, candidate);

  // Post-pass: detect type and enum *renames* — cases where a baseline
  // symbol disappears and a structurally-equivalent symbol takes its place
  // in the candidate. These are reported as `symbol_removed` (breaking) by
  // the symbol-level walker because the fqName is gone, but consumer code
  // that uses the type's fields/methods or the enum's wire values continues
  // to work — only explicit type annotations and (in dotnet) un-aliased
  // enum class references actually need to migrate. Downgrade these to
  // soft-risk so CI gates default-pass while the change stays visible.
  //
  // Ordered after detectForkedSchemas so the fork detector's remediation
  // hint is preserved on the typed cases it owns; renames operate on
  // pure removals where no fork hint applies.
  const typeRenames = detectTypeRenames(changes, baseline, candidate);
  const enumRenames = detectEnumRenames(changes, baseline, candidate);
  // Transitive pass: when a typed field on a renamed parent points at an
  // alias type that has no extractable children of its own (common for
  // discriminated-union owner types — e.g. Go's `APIKeyWithValueOwner`,
  // generated alongside its parent type), the structural detector can't
  // pair them on its own. Use the recorded parent rename + the field
  // typeRefs to derive the secondary rename.
  inferTransitiveTypeRenames(typeRenames, baseline, candidate, changes);
  cascadeRenameDowngrades(changes, typeRenames, enumRenames, baseline, candidate);

  return {
    changes,
    summary: summarizeChanges(changes),
  };
}

/**
 * Detect "schema fork" antipattern and attach a remediation hint.
 *
 * Fires when:
 *  1. A return type or field type changed from `OldType` → `NewType`.
 *  2. `NewType` is newly added in the candidate snapshot.
 *  3. `NewType.fields ⊇ OldType.fields` (every field on the old type still
 *     exists on the new one — the new schema is a strict superset, so the
 *     same fields could have been added to the existing schema additively).
 *
 * Mutates `changes` in place: sets `remediation` on the matching change.
 * Leaves the original category and severity alone — this is just a hint.
 *
 * Identity match is by `displayName` of the type symbol, which corresponds
 * to the type name as it appears in `change.old.returnType` / `.type` and
 * `change.new.returnType` / `.type`.
 */
function detectForkedSchemas(changes: ClassifiedChange[], baseline: CompatSnapshot, candidate: CompatSnapshot): void {
  // Build name → field-name set maps from each snapshot. A "type" here is any
  // symbol that owns field/property children (alias, service_accessor, enum).
  const baselineTypeFields = collectTypeFieldSets(baseline);
  const candidateTypeFields = collectTypeFieldSets(candidate);
  const baselineTypeNames = new Set(baselineTypeFields.keys());

  for (const change of changes) {
    if (change.remediation) continue;

    let oldType: string | undefined;
    let newType: string | undefined;
    if (change.category === 'return_type_changed') {
      oldType = change.old.returnType;
      newType = change.new.returnType;
    } else if (change.category === 'field_type_changed') {
      oldType = change.old.type;
      newType = change.new.type;
    } else {
      continue;
    }
    if (!oldType || !newType || oldType === newType) continue;

    // Strip array/nullable decorations so we compare bare type names. This
    // covers e.g. `FooList` vs `BarList`, plus simple `Foo[]` vs `Bar[]`.
    const oldTypeBare = bareTypeName(oldType);
    const newTypeBare = bareTypeName(newType);

    // The new type must be newly introduced.
    if (baselineTypeNames.has(newTypeBare)) continue;

    const oldFields = baselineTypeFields.get(oldTypeBare);
    const newFields = candidateTypeFields.get(newTypeBare);
    if (!oldFields || !newFields) continue;
    if (oldFields.size === 0) continue;

    // newFields must be a (non-strict) superset of oldFields.
    let isSuperset = true;
    for (const f of oldFields) {
      if (!newFields.has(f)) {
        isSuperset = false;
        break;
      }
    }
    if (!isSuperset) continue;

    change.remediation =
      `Schema "${newTypeBare}" looks like "${oldTypeBare}" with additional fields. ` +
      `Consider adding the new fields to "${oldTypeBare}" instead of forking a new schema — ` +
      `forking forces a breaking type-name change in typed SDKs, while extending the existing ` +
      `schema is additive.`;
  }
}

/**
 * Build a map from type fqName → set of (lowercased) child field names.
 * Used by `detectForkedSchemas` for superset comparison.
 */
function collectTypeFieldSets(snapshot: CompatSnapshot): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const sym of snapshot.symbols) {
    if (sym.kind !== 'field' && sym.kind !== 'property') continue;
    if (!sym.ownerFqName) continue;
    const localName = sym.fqName.includes('.') ? sym.fqName.slice(sym.fqName.lastIndexOf('.') + 1) : sym.fqName;
    let set = result.get(sym.ownerFqName);
    if (!set) {
      set = new Set<string>();
      result.set(sym.ownerFqName, set);
    }
    set.add(localName.toLowerCase());
  }
  return result;
}

/**
 * Detect type renames: a baseline type symbol disappears and a candidate
 * type symbol with the same (or superset) field set takes its place.
 *
 * Common when an upstream spec promotes a single schema into multiple
 * (e.g. `ApiKey` → `OrganizationApiKey` + `UserApiKey`). The wire shape
 * returned by individual endpoints is unchanged — `OrganizationApiKey`
 * has the same fields `ApiKey` had — so consumer code accessing those
 * fields keeps working. The compat report flags `ApiKey` as removed
 * because its symbol is gone; this pass downgrades the removal to
 * soft-risk and records the rename so its child fields/methods cascade.
 *
 * Identity criteria (must all hold):
 *   1. The removed symbol owns ≥ 1 field/property in the baseline (i.e.
 *      it's a type-shaped symbol — model/interface/class — not a plain
 *      function or constant).
 *   2. Some candidate type that did *not* exist in the baseline has a
 *      field set that is a non-strict superset of the removed type's
 *      fields. (Strict-subset would mean fields were lost — a real break.)
 *   3. The candidate type is the alphabetically-first such match, so
 *      pairing is deterministic when multiple candidates fit (e.g. both
 *      `OrganizationApiKey` and `UserApiKey` share the original fields).
 *
 * Returns a `removedName -> newName` map so a downstream cascade pass
 * can downgrade owned-field removals and `*_type_changed` pointing at
 * the same pair.
 *
 * Mutates matching `symbol_removed` entries in `changes`: severity →
 * `soft-risk`, attaches a `remediation` describing the rename.
 */
function detectTypeRenames(
  changes: ClassifiedChange[],
  baseline: CompatSnapshot,
  candidate: CompatSnapshot,
): Map<string, string> {
  const renameMap = new Map<string, string>();
  const baselineTypeFields = collectTypeFieldSets(baseline);
  const candidateTypeFields = collectTypeFieldSets(candidate);
  const baselineTypeNames = new Set(baselineTypeFields.keys());
  const candidateTypesSorted = [...candidateTypeFields.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Index parent `symbol_removed` changes by fqName so we can downgrade
  // them when a rename is detected. Some languages (Go's enum-alias path
  // for ordering enums; emitters that emit `type Old = New`) preserve the
  // old fqName as a candidate alias and never report a removal — that's
  // fine, the rename map is still populated for the cascade pass.
  const parentRemovalByName = new Map<string, ClassifiedChange>();
  for (const change of changes) {
    if (change.category === 'symbol_removed' && change.severity === 'breaking') {
      parentRemovalByName.set(change.old.symbol ?? '', change);
    }
  }

  // Walk every baseline type *directly*, not via `symbol_removed` events.
  // The parent-removal path alone misses rename-as-alias cases (e.g. Go
  // emits `type ApiKey = OrganizationApiKey` to preserve the old name)
  // because no `symbol_removed` fires for the old name. The structural
  // match (field-set superset) is what matters, regardless of whether
  // the old fqName persists as an alias.
  for (const [baselineTypeName, baselineFields] of baselineTypeFields) {
    if (baselineFields.size === 0) continue;

    // No-op: same name, same fields still in candidate.
    const sameNameFields = candidateTypeFields.get(baselineTypeName);
    if (sameNameFields && setEquals(baselineFields, sameNameFields)) continue;

    // Find a newly-added candidate type (not in baseline) whose field set
    // is a non-strict superset of the baseline type's fields.
    const match = candidateTypesSorted.find(([candName, candFields]) => {
      if (baselineTypeNames.has(candName)) return false;
      for (const f of baselineFields) {
        if (!candFields.has(f)) return false;
      }
      return true;
    });
    if (!match) continue;
    const [newName] = match;

    renameMap.set(baselineTypeName, newName);

    // Downgrade the parent removal if one was reported. Languages that
    // emit a `type Old = New` alias keep the parent symbol alive, so this
    // branch may not fire — but the rename is still recorded for the
    // cascade pass to use on field/return-type swaps.
    const parentRemoval = parentRemovalByName.get(baselineTypeName);
    if (parentRemoval) {
      parentRemoval.severity = 'soft-risk';
      parentRemoval.remediation =
        `Type "${baselineTypeName}" appears to have been renamed to "${newName}" — ` +
        `the new type has every field of the old (a non-strict superset). ` +
        `Field accesses and method calls on values of type "${newName}" continue to work; ` +
        `only explicit "${baselineTypeName}" type annotations need to migrate. ` +
        `Consider emitting a deprecated alias \`type ${baselineTypeName} = ${newName}\` in languages that support it.`;
    }
  }

  return renameMap;
}

/**
 * Transitive rename inference. After `detectTypeRenames` records direct
 * structural matches (e.g. `ApiKeyWithValue → OrganizationApiKeyWithValue`),
 * walk the parent's fields and follow the `typeRef.name` of each: if the
 * baseline parent's field references an alias-type `OldOwner` and the new
 * parent's same-named field references a different alias `NewOwner`, the
 * pair is the same type-concept under a renamed name. Record the
 * secondary rename so the cascade can downgrade `OldOwner`'s
 * `symbol_removed` and any `field_type_changed` pointing at the pair.
 *
 * Why this is necessary: discriminated-union owner types (Go's
 * `APIKeyWithValueOwner`, PHP/Python's nested constructor params) are
 * frequently emitted as `kind: 'alias'` symbols with no extractable
 * field children — so `collectTypeFieldSets` returns empty for them and
 * the structural matcher can't pair them directly. The transitive
 * lookup gives us a deterministic, conservative way to propagate the
 * rename: it only fires when the parent rename has already been
 * positively identified, and only follows fields that share the same
 * wire name across baseline and candidate.
 */
function inferTransitiveTypeRenames(
  typeRenames: Map<string, string>,
  baseline: CompatSnapshot,
  candidate: CompatSnapshot,
  changes: ClassifiedChange[],
): void {
  if (typeRenames.size === 0) return;

  // Index field/property symbols by `${ownerFqName}.${localName}` so we
  // can read the typeRef both sides of the rename.
  const baselineFieldType = new Map<string, string>();
  for (const sym of baseline.symbols) {
    if (sym.kind !== 'field' && sym.kind !== 'property') continue;
    if (!sym.ownerFqName || !sym.typeRef) continue;
    const localName = sym.fqName.includes('.') ? sym.fqName.slice(sym.fqName.lastIndexOf('.') + 1) : sym.fqName;
    baselineFieldType.set(`${sym.ownerFqName}.${localName.toLowerCase()}`, sym.typeRef.name);
  }
  const candidateFieldType = new Map<string, string>();
  for (const sym of candidate.symbols) {
    if (sym.kind !== 'field' && sym.kind !== 'property') continue;
    if (!sym.ownerFqName || !sym.typeRef) continue;
    const localName = sym.fqName.includes('.') ? sym.fqName.slice(sym.fqName.lastIndexOf('.') + 1) : sym.fqName;
    candidateFieldType.set(`${sym.ownerFqName}.${localName.toLowerCase()}`, sym.typeRef.name);
  }

  // Index parent `symbol_removed` changes for downgrade.
  const parentRemovalByName = new Map<string, ClassifiedChange>();
  for (const change of changes) {
    if (change.category === 'symbol_removed' && change.severity === 'breaking') {
      parentRemovalByName.set(change.old.symbol ?? '', change);
    }
  }

  // Walk a snapshot of the rename map — we may mutate it inside the loop
  // but only via `set`, never `delete`, and we don't re-iterate on the
  // additions in the same pass (one transitive hop is enough; deeper
  // chains can be handled by re-running, which we don't need today).
  const initialEntries = [...typeRenames.entries()];
  for (const [oldOwner, newOwner] of initialEntries) {
    // Find every baseline field on the renamed owner whose typeRef points
    // at a *different* type than the same-named field on the new owner.
    for (const [baselineKey, baselineFieldTypeRef] of baselineFieldType) {
      if (!baselineKey.startsWith(`${oldOwner}.`)) continue;
      const localName = baselineKey.slice(oldOwner.length + 1);
      const candidateKey = `${newOwner}.${localName}`;
      const candidateFieldTypeRef = candidateFieldType.get(candidateKey);
      if (!candidateFieldTypeRef) continue;

      const oldT = bareTypeName(baselineFieldTypeRef);
      const newT = bareTypeName(candidateFieldTypeRef);
      if (!oldT || !newT || oldT === newT) continue;
      if (typeRenames.has(oldT)) continue; // already recorded

      typeRenames.set(oldT, newT);
      const removal = parentRemovalByName.get(oldT);
      if (removal) {
        removal.severity = 'soft-risk';
        removal.remediation =
          `Type "${oldT}" appears to have been renamed to "${newT}" — ` +
          `inferred transitively because the renamed parent "${oldOwner}" → "${newOwner}" ` +
          `has a "${localName}" field whose type swapped from "${oldT}" to "${newT}". ` +
          `Consider emitting a deprecated alias \`type ${oldT} = ${newT}\` in languages that support it.`;
      }
    }
  }
}

/**
 * Detect enum canonical-flips: a baseline enum disappears and a candidate
 * enum with the **same wire-value set** takes its place.
 *
 * Caused by the emitter's enum-dedup heuristic picking a different
 * canonical name when a new same-shape enum joins the spec. Languages
 * that emit type aliases (Go, Ruby, Python, PHP, Kotlin) handle this
 * transparently via `type Old = New`; languages without first-class
 * aliases (dotnet) report the old enum as removed. The wire values are
 * unchanged — every legal value still serializes to the same JSON — so
 * consumer code constructing or matching on these enum values keeps
 * working. Only references to the typed enum class need migration.
 *
 * Identity criterion: a removed enum's value set is *exactly* equal to
 * a newly-added enum's value set (not superset — narrowing the value
 * set would be a real break for consumers expecting the dropped values).
 */
function detectEnumRenames(
  changes: ClassifiedChange[],
  baseline: CompatSnapshot,
  candidate: CompatSnapshot,
): Map<string, string> {
  const renameMap = new Map<string, string>();
  const baselineEnumValues = collectEnumValueSets(baseline);
  const candidateEnumValues = collectEnumValueSets(candidate);
  const baselineEnumNames = new Set(baselineEnumValues.keys());

  const candidateEnumsSorted = [...candidateEnumValues.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Index `symbol_removed` changes by fqName for O(1) lookup when downgrading
  // a parent removal (only some languages report one; others alias).
  const parentRemovalByName = new Map<string, ClassifiedChange>();
  for (const change of changes) {
    if (change.category === 'symbol_removed' && change.severity === 'breaking') {
      parentRemovalByName.set(change.old.symbol ?? '', change);
    }
  }

  // Walk every baseline enum *directly*, not via `symbol_removed` events.
  // The parent-removal path alone misses canonical-flips in languages that
  // alias non-canonical enums (Go, Ruby, Python, PHP, Kotlin): the old
  // fqName persists as `type ApplicationsOrder = APIKeysOrder`, no parent
  // `symbol_removed` fires, and the rename map stays empty — so the
  // member-removal cascade never runs. Iterating baseline enums fixes this
  // by deciding "did this enum's value set move to a different owner?"
  // independent of whether the parent symbol survived.
  for (const [baselineEnumName, baselineValues] of baselineEnumValues) {
    if (baselineValues.size === 0) continue;

    // No-op case: same name, same value set still present in candidate.
    const sameNameValues = candidateEnumValues.get(baselineEnumName);
    if (sameNameValues && setEquals(baselineValues, sameNameValues)) continue;

    // Find a newly-added candidate enum (not present under that name in
    // the baseline) with an exactly-equal wire-value set.
    const match = candidateEnumsSorted.find(
      ([candName, candValues]) => !baselineEnumNames.has(candName) && setEquals(baselineValues, candValues),
    );
    if (!match) continue;
    const [newName] = match;

    renameMap.set(baselineEnumName, newName);

    // Downgrade the parent removal if one was reported (dotnet path).
    const parentRemoval = parentRemovalByName.get(baselineEnumName);
    if (parentRemoval) {
      parentRemoval.severity = 'soft-risk';
      parentRemoval.remediation =
        `Enum "${baselineEnumName}" appears to have been renamed to "${newName}" — ` +
        `both enums have identical wire values, so on-the-wire serialization is unchanged. ` +
        `This is typically the emitter's dedup canonical-flip after a new same-shape enum joined the spec. ` +
        `Consider emitting a deprecated alias in languages that support it, or pinning the canonical via emitter config.`;
    }
  }

  return renameMap;
}

/**
 * Cascade rename downgrades to changes whose meaning depends on a renamed
 * symbol. Walks every change and:
 *
 *   - Downgrades child removals (`Owner.field` removed where `Owner` was
 *     renamed) — the field still exists, just under a new owner fqName.
 *     Same logic for enum members under a renamed enum.
 *   - Downgrades `return_type_changed` / `field_type_changed` whose
 *     old → new pair matches a recorded rename — the type swap is the
 *     rename itself, not a meaningful signature break.
 *
 * Each cascaded change gets a remediation pointing at the parent rename
 * so the reviewer can find the explanation in the report.
 */
function cascadeRenameDowngrades(
  changes: ClassifiedChange[],
  typeRenames: Map<string, string>,
  enumRenames: Map<string, string>,
  baseline: CompatSnapshot,
  candidate: CompatSnapshot,
): void {
  // Lazy-built field-set maps for the structural-equivalence fallback used
  // by `*_type_changed`. Both maps are needed even when no renames were
  // recorded — the structural test handles cases where both old and new
  // types coexist (e.g. a method's return type was redirected from an
  // existing schema to a structurally-equivalent newly-added schema, the
  // canonical fork antipattern).
  let baselineTypeFields: Map<string, Set<string>> | undefined;
  let candidateTypeFields: Map<string, Set<string>> | undefined;
  const getBaselineFields = (): Map<string, Set<string>> => {
    if (!baselineTypeFields) baselineTypeFields = collectTypeFieldSets(baseline);
    return baselineTypeFields;
  };
  const getCandidateFields = (): Map<string, Set<string>> => {
    if (!candidateTypeFields) candidateTypeFields = collectTypeFieldSets(candidate);
    return candidateTypeFields;
  };

  /**
   * Structural equivalence: candidate type's field set is a non-strict
   * superset of baseline type's field set, AND the candidate type was
   * newly added in this diff (not a swap to a pre-existing type, which
   * is a real signature break the consumer chose). When `New ⊇ Old` and
   * `New` is new, every field the consumer accessed on the old type
   * still exists on the value they receive — so the swap is non-breaking
   * at the value level even though the declared type changed. This is
   * the fork-detector's positive signal, applied as a severity
   * downgrade in addition to the existing remediation hint.
   */
  const isStructurallyEquivalent = (oldT: string, newT: string): boolean => {
    if (!oldT || !newT || oldT === newT) return false;
    const baselineFields = getBaselineFields();
    const candidateFields = getCandidateFields();
    // The new type must be newly introduced — a swap to an existing type
    // is a real signature change the consumer chose, not a rename.
    if (baselineFields.has(newT)) return false;
    const oldFields = baselineFields.get(oldT);
    const newFields = candidateFields.get(newT);
    if (!oldFields || !newFields) return false;
    if (oldFields.size === 0) return false;
    for (const f of oldFields) {
      if (!newFields.has(f)) return false;
    }
    return true;
  };

  for (const change of changes) {
    if (change.severity !== 'breaking') continue;

    if (change.category === 'symbol_removed') {
      const removed = change.old.symbol ?? '';
      const dotIdx = removed.indexOf('.');
      if (dotIdx <= 0) continue;
      const ownerName = removed.slice(0, dotIdx);
      const renamedTo = typeRenames.get(ownerName) ?? enumRenames.get(ownerName);
      if (!renamedTo) continue;
      change.severity = 'soft-risk';
      change.remediation =
        `Owned by renamed symbol "${ownerName}" (now "${renamedTo}"). ` +
        `The same member exists on the new symbol under "${renamedTo}.${removed.slice(dotIdx + 1)}".`;
      continue;
    }

    if (change.category === 'return_type_changed') {
      const oldT = bareTypeName(change.old.returnType ?? '');
      const newT = bareTypeName(change.new.returnType ?? '');
      if (typeRenames.get(oldT) === newT) {
        change.severity = 'soft-risk';
        change.remediation =
          `Return type swap matches recorded rename "${oldT}" → "${newT}". ` +
          `The underlying field set is preserved (see the rename advisory on "${oldT}").`;
      } else if (isStructurallyEquivalent(oldT, newT)) {
        // Downgrade severity for the structural-equivalence case (the
        // fork-detector's positive signal). Preserve any remediation
        // already attached by `detectForkedSchemas` — its message
        // already explains the situation; we only need to flip severity.
        change.severity = 'soft-risk';
        if (!change.remediation) {
          change.remediation =
            `Return type swap from "${oldT}" to "${newT}" is structurally equivalent — ` +
            `every field on "${oldT}" still exists on "${newT}". ` +
            `Consumer code accessing fields on the returned value continues to work; ` +
            `only explicit "${oldT}" type annotations need to migrate.`;
        }
      }
      continue;
    }

    if (change.category === 'field_type_changed') {
      const oldT = bareTypeName(change.old.type ?? '');
      const newT = bareTypeName(change.new.type ?? '');
      const renamedTo = typeRenames.get(oldT) ?? enumRenames.get(oldT);
      if (renamedTo === newT) {
        change.severity = 'soft-risk';
        change.remediation =
          `Field type swap matches recorded rename "${oldT}" → "${newT}". ` +
          `On-the-wire shape is unchanged (see the rename advisory on "${oldT}").`;
      } else if (isStructurallyEquivalent(oldT, newT)) {
        change.severity = 'soft-risk';
        if (!change.remediation) {
          change.remediation =
            `Field type swap from "${oldT}" to "${newT}" is structurally equivalent — ` +
            `every field on "${oldT}" still exists on "${newT}".`;
        }
      }
    }
  }
}

/**
 * Build a map from enum fqName → set of wire values. Used by
 * `detectEnumRenames` to find structurally-identical enums across
 * baseline and candidate. Wire values come from `enum_member.value`
 * (the JSON-level value) — not the member names, which are
 * language-specific PascalCase forms.
 *
 * Members whose `value` is undefined are skipped — they contribute no
 * identity information.
 */
function collectEnumValueSets(snapshot: CompatSnapshot): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const sym of snapshot.symbols) {
    if (sym.kind !== 'enum_member') continue;
    if (!sym.ownerFqName) continue;
    if (sym.value === undefined) continue;
    let set = result.get(sym.ownerFqName);
    if (!set) {
      set = new Set<string>();
      result.set(sym.ownerFqName, set);
    }
    set.add(String(sym.value));
  }
  return result;
}

/** Set equality for the small string sets used by rename detection. */
function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/**
 * Strip array/nullable suffixes so we compare bare type names. Languages
 * encode these differently (`Foo[]`, `Foo | null`, `Foo?`, `List<Foo>`,
 * `Optional[Foo]`); this is a best-effort common-case stripper, not an
 * exhaustive parser.
 */
function bareTypeName(t: string): string {
  let s = t.trim();
  // Go pointer prefix: `*Foo` → `Foo`. Strip first because the rest of the
  // patterns expect a leading identifier character.
  s = s.replace(/^\*/, '');
  // PHP namespace prefix: `\Vendor\Pkg\Foo` → `Foo`. PHP fully-qualified
  // type references in generated method signatures lead with a backslash
  // and use backslash-separated segments. Split on the last segment to
  // preserve nested generics inside the path.
  if (s.startsWith('\\')) {
    const lastBackslash = s.lastIndexOf('\\');
    s = s.slice(lastBackslash + 1);
  }
  // Nullable suffixes: `Foo | null`, `Foo?`.
  s = s.replace(/\s*\|\s*null$/, '').replace(/\?$/, '');
  // Array suffix: `Foo[]`.
  s = s.replace(/\[\]$/, '');
  // Single-arg generic. Two encodings to support:
  //   - angle brackets: `Iterator<Foo>`, `Optional<Foo>`, `List<Foo>`
  //   - square brackets: `Iterator[Foo]` (Go iterator returns from the
  //     emitter, e.g. `*Iterator[APIKey]`)
  const angleGeneric = s.match(/^[A-Za-z_][A-Za-z0-9_.]*<\s*([A-Za-z_*][A-Za-z0-9_.*]*)\s*>$/);
  if (angleGeneric) return bareTypeName(angleGeneric[1]);
  const bracketGeneric = s.match(/^[A-Za-z_][A-Za-z0-9_.]*\[\s*([A-Za-z_*][A-Za-z0-9_.*]*)\s*\]$/);
  if (bracketGeneric) return bareTypeName(bracketGeneric[1]);
  return s;
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
