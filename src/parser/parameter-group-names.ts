import type {
  ApiSpec,
  Enum,
  Model,
  Operation,
  Parameter,
  ParameterGroup,
  ParameterGroupVariant,
  Service,
  TypeRef,
} from '../ir/types.js';

/**
 * Assign `ParameterGroup.wrapperName` across the whole spec.
 *
 * Emitters derive a group's generated wrapper type name from the group name
 * alone, so two operations sharing a group name (create and update both
 * declare `protocol_options`) collapse onto a single type. That is only sound
 * while the two declarations carry the same members. Where they differ, one
 * operation ends up typed with the other's member — e.g. a connection update
 * forced to pass `CreateConnectionSAMLOptions`, which accepts three fields the
 * PATCH endpoint rejects.
 *
 * This pass fingerprints every group's members structurally and qualifies the
 * wrapper name with the operation name only for groups that genuinely diverge.
 * Groups whose declarations agree keep the bare group name, so wrapper types
 * already published in the SDKs are never renamed.
 */
export function assignParameterGroupWrapperNames(spec: ApiSpec): void {
  const modelMap = new Map(spec.models.map((m) => [m.name, m]));
  const enumMap = new Map(spec.enums.map((e) => [e.name, e]));

  // group name -> the distinct structural fingerprints seen for it
  const fingerprints = new Map<string, Set<string>>();
  const occurrences: Occurrence[] = [];

  for (const service of spec.services) {
    for (const op of service.operations) {
      for (const group of op.parameterGroups ?? []) {
        const fp = fingerprintGroup(group, modelMap, enumMap);
        let seen = fingerprints.get(group.name);
        if (!seen) {
          seen = new Set();
          fingerprints.set(group.name, seen);
        }
        seen.add(fp);
        occurrences.push({ service, op, group, fingerprint: fp });
      }
    }
  }

  for (const { op, group } of occurrences) {
    const diverges = (fingerprints.get(group.name)?.size ?? 0) > 1;
    group.wrapperName = diverges ? `${op.name}_${group.name}` : group.name;
  }

  qualifyResidualCollisions(occurrences);
  reconcileSharedGroups(occurrences.map((o) => o.group));
}

interface Occurrence {
  service: Service;
  op: Operation;
  group: ParameterGroup;
  fingerprint: string;
}

/**
 * Break the collisions the operation-qualified name can still leave behind.
 *
 * `${op.name}_${group.name}` is not a unique key, for two separate reasons:
 *
 *  - `disambiguateOperationNames` makes operation names unique only *within* a
 *    service, so two services that each own an operation named `create`, both
 *    declaring a `password` group with different members, both land on
 *    `create_password`.
 *  - Within one service it deliberately leaves same-name operations alone when
 *    they share a path (see the `uniquePaths.size <= 1` guard — "same path,
 *    different methods"), so `PUT` and `PATCH` on one path both stay `update`
 *    and a service prefix alone still produces one name for both.
 *
 * Either way `reconcileSharedGroups` would then fuse two incompatible
 * declarations into a single type — the exact failure this pass exists to
 * prevent — and it does not drop the surplus member, so the wrapper would
 * expose a field one of the operations rejects.
 *
 * So escalate in rounds, adding a qualifier at a time and re-testing what still
 * collides. `(service, path, method)` identifies an operation uniquely, and a
 * same-name collision within a service implies a shared path, so service then
 * method is sufficient to separate every case.
 *
 * Each round only touches names that *still* group differing fingerprints, so a
 * name whose sharers agree is never renamed: sharing one wrapper is exactly what
 * should happen there, and renaming it would move a type the SDKs already
 * publish. On a spec where no qualified name collides — the WorkOS spec today —
 * the whole pass is a no-op.
 */
function qualifyResidualCollisions(occurrences: Occurrence[]): void {
  // Prepended in order, matching how the operation and group names already
  // compose, so a fully-escalated name reads `<method>_<service>_<op>_<group>`.
  const qualifiers: ((o: Occurrence) => string)[] = [(o) => o.service.name, (o) => o.op.httpMethod];

  for (const qualify of qualifiers) {
    for (const sharers of collidingCandidates(occurrences)) {
      // A declaration still holding its group's own bare name owns that name.
      // A qualified name can land on some *other* group's literal name — an
      // `update` operation's `parent` group qualifies to `update_parent`, which
      // may already be a group called `update_parent` — and that group is
      // internally consistent, never diverged, and already published under it.
      // Move only the declarations that have already been escalated; anything
      // left fused falls through to the terminal round.
      //
      // This cannot strand a collision. Two groups sharing a literal name with
      // differing structures always diverge on that name and are both qualified
      // in the first assignment, so at most one member of a colliding set can
      // still be bare. When one is, moving the rest separates them; in the
      // degenerate case where none are movable, nothing moves here and the
      // terminal round separates by structure regardless.
      const movable = sharers.filter((o) => o.group.wrapperName !== o.group.name);
      for (const o of movable) {
        o.group.wrapperName = `${qualify(o)}_${o.group.wrapperName ?? o.group.name}`;
      }
    }
  }

  separateRemainingByStructure(occurrences);
}

/**
 * Terminal round: separate whatever the operation attributes could not.
 *
 * No combination of operation attributes is unique by construction. Two
 * operations in one service can share a name, a method *and* differ only by
 * path — `normalizeOperationIdForNaming` strips the `[N]` suffix, so a NestJS
 * controller method bound to several routes derives one name for all of them.
 * The WorkOS spec already contains such a pair (`Authorization`'s
 * `listRoleAssignments` on two paths); it declares no parameter groups today,
 * so nothing is wrong in the SDKs, but the shape is present rather than
 * hypothetical. Adding `path` as a fourth qualifier would only move the
 * boundary again.
 *
 * So stop enumerating attributes and separate by the thing that actually
 * matters: a name still fusing distinct structures gets one wrapper per
 * distinct fingerprint. That makes "same `wrapperName` implies same structure"
 * hold unconditionally, which is the invariant every emitter relies on.
 *
 * Suffixes are keyed on the fingerprint, not on a per-occurrence counter, so
 * declarations that agree keep sharing a wrapper.
 *
 * Ordering is by first appearance, not by sorted fingerprint: the structure
 * declared first keeps the unsuffixed name. Sorting by fingerprint would be
 * equally deterministic but less stable in the way that matters — adding a
 * member to one operation changes its fingerprint and could swap which of two
 * published wrappers holds the bare name. Under first-appearance order only
 * reordering the operations themselves can shift a name, which is both rarer
 * and visible in the spec diff.
 *
 * Either way this is a no-op wherever an earlier round already sufficed —
 * including the WorkOS spec, which never reaches this round at all.
 */
function separateRemainingByStructure(occurrences: Occurrence[]): void {
  const taken = new Set(occurrences.map((o) => o.group.wrapperName ?? o.group.name));

  for (const sharers of collidingCandidates(occurrences)) {
    const base = sharers[0].group.wrapperName ?? sharers[0].group.name;

    // First fingerprint seen keeps `base`; each new one takes the next free
    // `base_N`, skipping any name already spoken for elsewhere in the spec.
    const nameFor = new Map<string, string>();
    let n = 2;
    for (const o of sharers) {
      if (nameFor.has(o.fingerprint)) continue;
      if (nameFor.size === 0) {
        nameFor.set(o.fingerprint, base);
        continue;
      }
      while (taken.has(`${base}_${n}`)) n++;
      const name = `${base}_${n}`;
      taken.add(name);
      nameFor.set(o.fingerprint, name);
      n++;
    }

    for (const o of sharers) o.group.wrapperName = nameFor.get(o.fingerprint)!;
  }
}

/**
 * Candidate wrapper names shared by declarations that do not agree — the only
 * ones an escalation round may rename.
 */
function collidingCandidates(occurrences: Occurrence[]): Occurrence[][] {
  const byCandidate = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const key = o.group.wrapperName ?? o.group.name;
    const list = byCandidate.get(key);
    if (list) list.push(o);
    else byCandidate.set(key, [o]);
  }
  return [...byCandidate.values()].filter(
    (sharers) => sharers.length > 1 && new Set(sharers.map((o) => o.fingerprint)).size > 1,
  );
}

/**
 * Make every group that shares a `wrapperName` describe literally the same
 * type.
 *
 * Deciding two declarations may share one wrapper is only half the job. The
 * fingerprint deliberately ignores nullability and member order, so sharers can
 * still disagree on both — and each emitter renders the wrapper from whichever
 * operation it happens to reach first while rendering call sites from their own
 * operation. Kotlin showed the consequence: `ParentResource.ById.id` emitted as
 * `String` from one operation, while the Java-friendly overload built from
 * another passed a `String?` into it, and the SDK stopped compiling.
 *
 * So normalize the two axes the fingerprint waived:
 *   - a member the sharers disagree on settles as non-nullable. Widening to
 *     nullable instead reads as the friendlier choice, but the nullable form
 *     doesn't survive every emitter's group paths (Kotlin's query dispatch
 *     builds a `Pair<String, String>` from the member, which a `String?` can't
 *     satisfy), and non-nullable is what all sharers carried before group
 *     member types were resolved at all — so it changes no published surface.
 *     A member every sharer agrees is nullable stays nullable.
 *
 *     The cost: an operation whose spec really does accept null for a member
 *     (`PATCH` on a resource may clear `parent_resource_id`) can't express that
 *     through the shared wrapper. It never could — the member used to be a flat
 *     `string` everywhere — so nothing regresses, but the limitation is real and
 *     removing it means letting that group's wrapper split per operation.
 *   - member order follows the first sharer, so positional constructors and
 *     their call sites agree.
 */
function reconcileSharedGroups(groups: ParameterGroup[]): void {
  const byWrapper = new Map<string, ParameterGroup[]>();
  for (const group of groups) {
    const key = group.wrapperName ?? group.name;
    const list = byWrapper.get(key);
    if (list) list.push(group);
    else byWrapper.set(key, [group]);
  }

  for (const sharers of byWrapper.values()) {
    if (sharers.length < 2) continue;

    for (const variant of sharers[0].variants) {
      const peers = sharers
        .slice(1)
        .map((g) => g.variants.find((v) => v.name === variant.name))
        .filter((v): v is ParameterGroupVariant => v !== undefined);
      if (peers.length === 0) continue;

      // Settle nullability: unanimously-nullable members stay nullable, and any
      // member the sharers disagree on drops to non-nullable in all of them.
      for (const member of variant.parameters) {
        const all = [member, ...peers.map((p) => p.parameters.find((q) => q.name === member.name)).filter(isParameter)];
        if (all.every((p) => p.type.kind === 'nullable')) continue;
        for (const p of all) {
          if (p.type.kind === 'nullable') p.type = p.type.inner;
        }
      }

      // Align order on the first sharer's, leaving any member it doesn't
      // declare in place at the end rather than dropping it.
      const canonical = variant.parameters.map((p) => p.name);
      for (const peer of peers) {
        peer.parameters.sort((a, b) => {
          const ia = canonical.indexOf(a.name);
          const ib = canonical.indexOf(b.name);
          if (ia === -1 && ib === -1) return 0;
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        });
      }
    }
  }
}

function isParameter(p: Parameter | undefined): p is Parameter {
  return p !== undefined;
}

/**
 * Structural fingerprint of a group: its variants, their members, and each
 * member's resolved shape. Two declarations with the same fingerprint can
 * safely share one generated wrapper type.
 */
function fingerprintGroup(group: ParameterGroup, modelMap: Map<string, Model>, enumMap: Map<string, Enum>): string {
  const variants = group.variants.map((v) => {
    // Members are sorted by name: every emitter renders the wrapper as a
    // named-field type (dataclass, data class, readonly promoted properties,
    // struct variant), so two operations listing the same members in a
    // different order still describe the same type and must keep sharing one
    // wrapper rather than being renamed apart.
    const members = [...v.parameters]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `${p.name}:${fingerprintType(p.type, modelMap, enumMap, new Set())}`);
    const optional = [...(v.optionalParameters ?? [])].sort();
    return `${v.name}(${members.join(',')})[${optional.join(',')}]`;
  });
  // `optional` is deliberately excluded: whether the group as a whole may be
  // omitted is a property of the operation's signature, not of the wrapper
  // type, and create/update legitimately differ there (required vs optional)
  // while sharing an identical wrapper.
  return variants.join('|');
}

/**
 * Fingerprint a type by shape rather than by name.
 *
 * Names cannot be compared directly because the parser synthesizes a separate
 * name per declaration site for inline schemas: `create_user` and `update_user`
 * each get their own `PasswordHashType` enum, spelled `CreateUserPasswordHashType`
 * and `UpdateUserPasswordHashType`, though their values are identical. Comparing
 * names would report divergence and rename a wrapper for no reason.
 *
 * Nullability is also stripped: an update declaring a member nullable while
 * create declares it plain is not a reason to split the wrapper type.
 */
function fingerprintType(
  ref: TypeRef,
  modelMap: Map<string, Model>,
  enumMap: Map<string, Enum>,
  visiting: Set<string>,
): string {
  switch (ref.kind) {
    case 'nullable':
      // Widening only — a nullable and a non-nullable member are compatible.
      return fingerprintType(ref.inner, modelMap, enumMap, visiting);
    case 'primitive':
      return `p:${ref.type}`;
    case 'literal':
      return `l:${typeof ref.value}:${String(ref.value)}`;
    case 'array':
      return `a<${fingerprintType(ref.items, modelMap, enumMap, visiting)}>`;
    case 'map':
      return `m<${fingerprintType(ref.valueType, modelMap, enumMap, visiting)}>`;
    case 'union':
      // Sorted, like enum values and model fields: a union accepts the same set
      // of types whichever order the branches are written in, so two operations
      // listing equivalent branches differently describe the same type and must
      // keep sharing a wrapper rather than renaming a published one apart.
      return `u<${ref.variants
        .map((v) => fingerprintType(v, modelMap, enumMap, visiting))
        .sort()
        .join(',')}>`;
    case 'enum': {
      const e = enumMap.get(ref.name);
      if (!e) return `e:${ref.name}`;
      // Values, not the synthesized name — two inline copies of one enum are
      // the same type for wrapper-sharing purposes. The value's primitive type
      // is part of the fingerprint (as it is for `literal`): the IR keeps
      // numeric `5` and string `"5"` distinct, and so do the emitters, so two
      // enums that stringify alike are still different types.
      //
      // Sorted, like model fields and group members above: declaration order of
      // enum values does not change which values the member accepts, so two
      // inline enums listing one set in different orders must keep sharing a
      // wrapper rather than renaming an already-published type apart.
      return `e<${e.values
        .map((v) => `${typeof v.value}:${String(v.value)}`)
        .sort()
        .join(',')}>`;
    }
    case 'model': {
      const m = modelMap.get(ref.name);
      if (!m) return `M:${ref.name}`;
      // Recursion guard: a model reachable from itself fingerprints by name at
      // the point of recurrence, which is enough to distinguish shapes.
      if (visiting.has(ref.name)) return `M:${ref.name}`;
      const next = new Set(visiting).add(ref.name);
      const fields = [...m.fields]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => `${f.name}${f.required ? '!' : '?'}:${fingerprintType(f.type, modelMap, enumMap, next)}`);
      return `M<${fields.join(',')}>`;
    }
    default:
      return 'unknown';
  }
}
