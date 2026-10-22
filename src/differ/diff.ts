import type { ApiSpec, Enum } from '../ir/types.js';
import type {
  BehaviorChange,
  Change,
  DeprecatedChanged,
  DeprecatedNode,
  DiffReport,
  EnumValueChange,
} from './types.js';
import { deprecationDetails, deprecationFlip } from './classify.js';
import { buildDirectionIndex } from './direction.js';
import { diffModels } from './models.js';
import { diffServers } from './servers.js';
import { diffServices } from './services.js';
import { diffWebhooks } from './webhooks.js';

export function diffSpecs(oldSpec: ApiSpec, newSpec: ApiSpec): DiffReport {
  // Both specs seed the index so a model that was request-facing in either one
  // is still judged as request-facing here.
  const directions = buildDirectionIndex(oldSpec, newSpec);

  const changes: Change[] = [
    // Where the client sends requests comes first: it is the one change that
    // touches every operation.
    ...diffServers(oldSpec, newSpec),
    ...diffModels(oldSpec.models, newSpec.models, directions),
    ...diffEnums(oldSpec.enums, newSpec.enums),
    ...diffServices(oldSpec.services, newSpec.services),
    ...diffWebhooks(oldSpec.webhooks ?? [], newSpec.webhooks ?? []),
  ];

  const behaviorChanges = collectBehaviorChanges(changes);

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
 * not show: a parameter default moving, and every `deprecated` flip. Each
 * change carries `oldDeprecated`/`newDeprecated` beside its flag, so this is
 * a single pass over `changes` that never looks a node up in the IR.
 */
function collectBehaviorChanges(changes: Change[]): BehaviorChange[] {
  const out: BehaviorChange[] = [];
  const flipped = (
    node: DeprecatedNode,
    change: { oldDeprecated?: boolean; newDeprecated?: boolean },
  ): DeprecatedChanged => ({
    kind: 'deprecated-changed',
    ...node,
    oldDeprecated: change.oldDeprecated === true,
    newDeprecated: change.newDeprecated === true,
    classification: 'additive',
  });

  for (const c of changes) {
    if (c.kind === 'model-modified') {
      if (c.deprecatedChanged) out.push(flipped({ node: 'model', modelName: c.name }, c));
      for (const fc of c.fieldChanges) {
        if (fc.kind !== 'field-deprecated-changed') continue;
        out.push(flipped({ node: 'field', modelName: c.name, fieldName: fc.fieldName }, fc));
      }
      continue;
    }

    if (c.kind === 'enum-modified') {
      if (c.deprecatedChanged) out.push(flipped({ node: 'enum', enumName: c.name }, c));
      for (const vc of c.valueChanges) {
        if (vc.kind !== 'value-deprecated-changed') continue;
        out.push(flipped({ node: 'enum-value', enumName: c.name, valueName: vc.valueName }, vc));
      }
      continue;
    }

    if (c.kind === 'webhook-modified') {
      // Only the flag is mirrored: a webhook parameter's default is the
      // sender's concern, not an SDK-method behavior (see `diffWebhookParams`).
      if (c.deprecatedChanged) out.push(flipped({ node: 'webhook', name: c.name, httpMethod: c.httpMethod }, c));
      for (const pc of c.paramChanges) {
        if (pc.kind !== 'param-deprecated-changed') continue;
        out.push(
          flipped(
            {
              node: 'webhook-parameter',
              name: c.name,
              httpMethod: c.httpMethod,
              paramName: pc.paramName,
              paramLocation: pc.paramLocation ?? 'header',
            },
            pc,
          ),
        );
      }
      continue;
    }

    if (c.kind !== 'operation-modified') continue;
    if (c.deprecatedChanged) {
      out.push(flipped({ node: 'operation', serviceName: c.serviceName, operationName: c.operationName }, c));
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
            pc,
          ),
        );
      }
    }
  }
  return out;
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
    const deprecation = deprecationFlip(oldEnum, newEnum);
    if (valueChanges.length > 0 || deprecation) {
      const hasBreaking = valueChanges.some((vc) => vc.classification === 'breaking');
      changes.push({
        kind: 'enum-modified',
        name,
        valueChanges,
        deprecatedChanged: deprecation !== undefined,
        ...deprecation,
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

    const deprecation = deprecationFlip(oldVal, newVal);
    if (deprecation) {
      // The value is still accepted and still emitted, so additive either way.
      changes.push({
        kind: 'value-deprecated-changed',
        valueName: name,
        classification: 'additive',
        ...deprecation,
        details: deprecationDetails(deprecation.newDeprecated),
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
    // `base-url-changed` is a modification of the document root, so every
    // change lands in exactly one of the three counts.
    else if (c.kind.endsWith('-modified') || c.kind.endsWith('-changed')) modified++;

    if (c.classification === 'breaking') breaking++;
    else additive++;
  }

  return { added, removed, modified, breaking, additive };
}
