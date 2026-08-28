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
 * `disambiguateOperationNames` makes operation names unique only *within* a
 * service, so `${op.name}_${group.name}` is not a unique key: two services that
 * each own an operation named `create`, both declaring a `password` group with
 * different members, both land on `create_password`. That is the same failure
 * this pass exists to prevent, one level up — `reconcileSharedGroups` would then
 * force the two incompatible declarations into a single type.
 *
 * Escalate only those names to a service-qualified form. A name whose sharers
 * all fingerprint identically is left alone: sharing one wrapper is exactly
 * what should happen there, and renaming it would move a type the SDKs already
 * publish. On a spec where no qualified name collides — the WorkOS spec today —
 * this pass is a no-op.
 */
function qualifyResidualCollisions(occurrences: Occurrence[]): void {
  const byCandidate = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const key = o.group.wrapperName ?? o.group.name;
    const list = byCandidate.get(key);
    if (list) list.push(o);
    else byCandidate.set(key, [o]);
  }

  for (const sharers of byCandidate.values()) {
    if (sharers.length < 2) continue;
    // Sharers that agree structurally are meant to share one wrapper.
    if (new Set(sharers.map((o) => o.fingerprint)).size < 2) continue;
    for (const o of sharers) {
      o.group.wrapperName = `${o.service.name}_${o.group.wrapperName ?? o.group.name}`;
    }
  }
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
      return `u<${ref.variants.map((v) => fingerprintType(v, modelMap, enumMap, visiting)).join(',')}>`;
    case 'enum': {
      const e = enumMap.get(ref.name);
      if (!e) return `e:${ref.name}`;
      // Values, not the synthesized name — two inline copies of one enum are
      // the same type for wrapper-sharing purposes. The value's primitive type
      // is part of the fingerprint (as it is for `literal`): the IR keeps
      // numeric `5` and string `"5"` distinct, and so do the emitters, so two
      // enums that stringify alike are still different types.
      return `e<${e.values.map((v) => `${typeof v.value}:${String(v.value)}`).join(',')}>`;
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
