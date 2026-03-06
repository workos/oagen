import type { ApiSpec, Enum } from '../ir/types.js';
import type { Change, DiffReport, EnumValueChange } from './types.js';
import { diffModels } from './models.js';
import { diffServices } from './services.js';

export function diffSpecs(oldSpec: ApiSpec, newSpec: ApiSpec): DiffReport {
  const changes: Change[] = [
    ...diffModels(oldSpec.models, newSpec.models),
    ...diffEnums(oldSpec.enums, newSpec.enums),
    ...diffServices(oldSpec.services, newSpec.services),
  ];

  return {
    oldVersion: oldSpec.version,
    newVersion: newSpec.version,
    changes,
    summary: summarize(changes),
  };
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
    if (valueChanges.length > 0) {
      const hasBreaking = valueChanges.some((vc) => vc.classification === 'breaking');
      changes.push({
        kind: 'enum-modified',
        name,
        valueChanges,
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
