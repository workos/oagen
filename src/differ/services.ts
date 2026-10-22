import type { Service } from '../ir/types.js';
import type { Change } from './types.js';
import { diffOperations, type DocumentServers } from './operations.js';

/**
 * `documentServers` — the two documents' `servers` — lets `diffOperations`
 * resolve what each operation is actually served from; `diffSpecs` passes it,
 * a direct caller may leave it out.
 */
export function diffServices(
  oldServices: Service[],
  newServices: Service[],
  documentServers?: DocumentServers,
): Change[] {
  const changes: Change[] = [];
  const oldByName = new Map(oldServices.map((s) => [s.name, s]));
  const newByName = new Map(newServices.map((s) => [s.name, s]));

  for (const [name] of newByName) {
    if (!oldByName.has(name)) {
      changes.push({ kind: 'service-added', name, classification: 'additive' });
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push({ kind: 'service-removed', name, classification: 'breaking' });
    }
  }

  for (const [name, newService] of newByName) {
    const oldService = oldByName.get(name);
    if (!oldService) continue;

    changes.push(...diffOperations(name, oldService.operations, newService.operations, documentServers));
  }

  return changes;
}
