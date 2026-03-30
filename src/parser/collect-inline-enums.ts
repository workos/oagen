import type { Enum, Model, Service } from '../ir/types.js';
import { collectInlineEnumFromRef } from './schemas.js';

export function collectInlineEnumsFromModels(models: Model[], enums: Enum[]): void {
  const enumNames = new Set(enums.map((e) => e.name));
  for (const model of models) {
    for (const field of model.fields) {
      collectInlineEnumFromRef(field.type, enums, enumNames);
    }
  }
}

/**
 * Collect inline enum definitions from operation parameters (query, path, header)
 * and promote them to top-level enums so emitters can generate typed enum files.
 */
export function collectInlineEnumsFromOperations(services: Service[], enums: Enum[]): void {
  const enumNames = new Set(enums.map((e) => e.name));
  for (const service of services) {
    for (const op of service.operations) {
      for (const param of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collectInlineEnumFromRef(param.type, enums, enumNames);
      }
    }
  }
}
