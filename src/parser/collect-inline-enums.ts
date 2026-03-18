import type { Enum, Model } from '../ir/types.js';
import { collectInlineEnumFromRef } from './schemas.js';

export function collectInlineEnumsFromModels(models: Model[], enums: Enum[]): void {
  const enumNames = new Set(enums.map((e) => e.name));
  for (const model of models) {
    for (const field of model.fields) {
      collectInlineEnumFromRef(field.type, enums, enumNames);
    }
  }
}
