import type { ApiSpec, Enum, Operation } from '../ir/types.js';
import type {
  BehaviorChange,
  Change,
  DeprecatedChanged,
  DeprecatedNode,
  DiffReport,
  EnumValueChange,
} from './types.js';
import { deprecationDetails, isDeprecated } from './classify.js';
import { buildDirectionIndex } from './direction.js';
import { diffModels } from './models.js';
import { diffServices } from './services.js';

export function diffSpecs(oldSpec: ApiSpec, newSpec: ApiSpec): DiffReport {
  // Both specs seed the index so a model that was request-facing in either one
  // is still judged as request-facing here.
  const directions = buildDirectionIndex(oldSpec, newSpec);

  const changes: Change[] = [
    ...diffModels(oldSpec.models, newSpec.models, directions),
    ...diffEnums(oldSpec.enums, newSpec.enums),
    ...diffServices(oldSpec.services, newSpec.services),
  ];

  const behaviorChanges = collectBehaviorChanges(changes, oldSpec, newSpec);

  return {
    oldVersion: oldSpec.version,
    newVersion: newSpec.version,
    changes,
    behaviorChanges,
    summary: { ...summarize(changes), behaviorChanges: behaviorChanges.length },
  };
}

/**
 * One entry per flag or nested entry in `changes` that a type signature does
 * not show: a parameter default moving, and every `deprecated` flip. The
 * direction of a flip is read from the two specs, since a `-modified` change
 * only says that the flag moved; a node reported as modified exists on both
 * sides, so both lookups find it.
 */
function collectBehaviorChanges(changes: Change[], oldSpec: ApiSpec, newSpec: ApiSpec): BehaviorChange[] {
  const out: BehaviorChange[] = [];
  const flipped = (
    node: DeprecatedNode,
    oldNode: { deprecated?: boolean } | undefined,
    newNode: { deprecated?: boolean } | undefined,
  ): DeprecatedChanged => ({
    kind: 'deprecated-changed',
    ...node,
    oldDeprecated: oldNode ? isDeprecated(oldNode) : false,
    newDeprecated: newNode ? isDeprecated(newNode) : false,
    classification: 'additive',
  });

  for (const c of changes) {
    if (c.kind === 'model-modified') {
      const oldModel = oldSpec.models.find((m) => m.name === c.name);
      const newModel = newSpec.models.find((m) => m.name === c.name);
      if (c.deprecatedChanged) out.push(flipped({ node: 'model', modelName: c.name }, oldModel, newModel));
      for (const fc of c.fieldChanges) {
        if (fc.kind !== 'field-deprecated-changed') continue;
        out.push(
          flipped(
            { node: 'field', modelName: c.name, fieldName: fc.fieldName },
            oldModel?.fields.find((f) => f.name === fc.fieldName),
            newModel?.fields.find((f) => f.name === fc.fieldName),
          ),
        );
      }
      continue;
    }

    if (c.kind === 'enum-modified') {
      const oldEnum = oldSpec.enums.find((e) => e.name === c.name);
      const newEnum = newSpec.enums.find((e) => e.name === c.name);
      if (c.deprecatedChanged) out.push(flipped({ node: 'enum', enumName: c.name }, oldEnum, newEnum));
      for (const vc of c.valueChanges) {
        if (vc.kind !== 'value-deprecated-changed') continue;
        out.push(
          flipped(
            { node: 'enum-value', enumName: c.name, valueName: vc.valueName },
            oldEnum?.values.find((v) => v.name === vc.valueName),
            newEnum?.values.find((v) => v.name === vc.valueName),
          ),
        );
      }
      continue;
    }

    if (c.kind !== 'operation-modified') continue;
    const oldOp = findOperation(oldSpec, c.serviceName, c.operationName);
    const newOp = findOperation(newSpec, c.serviceName, c.operationName);
    if (c.deprecatedChanged) {
      out.push(
        flipped({ node: 'operation', serviceName: c.serviceName, operationName: c.operationName }, oldOp, newOp),
      );
    }
    for (const pc of c.paramChanges) {
      if (pc.kind === 'param-default-changed') {
        out.push({
          kind: 'param-default-changed',
          serviceName: c.serviceName,
          operationName: c.operationName,
          paramName: pc.paramName,
          paramLocation: pc.paramLocation ?? 'query',
          oldDefault: pc.oldDefault ?? null,
          newDefault: pc.newDefault ?? null,
          classification: 'breaking',
        });
      } else if (pc.kind === 'param-deprecated-changed') {
        out.push(
          flipped(
            {
              node: 'parameter',
              serviceName: c.serviceName,
              operationName: c.operationName,
              paramName: pc.paramName,
              paramLocation: pc.paramLocation ?? 'query',
            },
            findParameter(oldOp, pc.paramName),
            findParameter(newOp, pc.paramName),
          ),
        );
      }
    }
  }
  return out;
}

function findOperation(spec: ApiSpec, serviceName: string, operationName: string): Operation | undefined {
  return spec.services.find((s) => s.name === serviceName)?.operations.find((o) => o.name === operationName);
}

/** The parameter `diffParams` compared under `name`: path, query and header parameters, in that order. */
function findParameter(op: Operation | undefined, name: string) {
  if (!op) return undefined;
  return [...op.pathParams, ...op.queryParams, ...op.headerParams].find((p) => p.name === name);
}

function diffEnums(oldEnums: Enum[], newEnums: Enum[]): Change[] {
  const changes: Change[] = [];
  const oldByName = new Map(oldEnums.map((e) => [e.name, e]));
  const newByName = new Map(newEnums.map((e) => [e.name, e]));

  for (const [name] of newByName) {
    if (!oldByName.has(name)) {
      changes.push({ kind: 'enum-added', name, classification: 'additive' });
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push({ kind: 'enum-removed', name, classification: 'breaking' });
    }
  }

  for (const [name, newEnum] of newByName) {
    const oldEnum = oldByName.get(name);
    if (!oldEnum) continue;

    const valueChanges = diffEnumValues(oldEnum, newEnum);
    // A flipped flag alone is a change: the values are unchanged, but a
    // changelog has to say it.
    const deprecatedChanged = isDeprecated(oldEnum) !== isDeprecated(newEnum);
    if (valueChanges.length > 0 || deprecatedChanged) {
      const hasBreaking = valueChanges.some((vc) => vc.classification === 'breaking');
      changes.push({
        kind: 'enum-modified',
        name,
        valueChanges,
        deprecatedChanged,
        classification: hasBreaking ? 'breaking' : 'additive',
      });
    }
  }

  return changes;
}

function diffEnumValues(oldEnum: Enum, newEnum: Enum): EnumValueChange[] {
  const changes: EnumValueChange[] = [];
  const oldByName = new Map(oldEnum.values.map((v) => [v.name, v]));
  const newByName = new Map(newEnum.values.map((v) => [v.name, v]));

  for (const [name] of newByName) {
    if (!oldByName.has(name)) {
      changes.push({ kind: 'value-added', valueName: name, classification: 'additive' });
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push({ kind: 'value-removed', valueName: name, classification: 'breaking' });
    }
  }

  for (const [name, newVal] of newByName) {
    const oldVal = oldByName.get(name);
    if (!oldVal) continue;

    if (oldVal.value !== newVal.value) {
      changes.push({
        kind: 'value-changed',
        valueName: name,
        classification: 'breaking',
        details: `value changed from '${oldVal.value}' to '${newVal.value}'`,
      });
    }

    if (isDeprecated(oldVal) !== isDeprecated(newVal)) {
      // The value is still accepted and still emitted, so additive either way.
      changes.push({
        kind: 'value-deprecated-changed',
        valueName: name,
        classification: 'additive',
        details: deprecationDetails(isDeprecated(newVal)),
      });
    }
  }

  return changes;
}

function summarize(changes: Change[]) {
  let added = 0;
  let removed = 0;
  let modified = 0;
  let breaking = 0;
  let additive = 0;

  for (const c of changes) {
    if (c.kind.endsWith('-added')) added++;
    else if (c.kind.endsWith('-removed')) removed++;
    else if (c.kind.endsWith('-modified')) modified++;

    if (c.classification === 'breaking') breaking++;
    else additive++;
  }

  return { added, removed, modified, breaking, additive };
}
