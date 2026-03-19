import type { Model, GeneratedFile, EmitterContext } from '@workos/oagen';
import { tsTypeName, tsPropertyName } from '../naming.js';
import { toTsType } from '../type-mapper.js';

export function generateModels(models: Model[], _ctx: EmitterContext): GeneratedFile[] {
  if (models.length === 0) return [];

  const lines: string[] = [];

  for (const model of models) {
    if (model.description) {
      lines.push(`/** ${model.description} */`);
    }
    lines.push(`export interface ${tsTypeName(model.name)} {`);
    for (const field of model.fields) {
      const tsName = tsPropertyName(field.name);
      const tsType = toTsType(field.type);
      const optional = field.required ? '' : '?';
      if (field.description) {
        lines.push(`  /** ${field.description} */`);
      }
      lines.push(`  ${tsName}${optional}: ${tsType};`);
    }
    lines.push('}');
    lines.push('');
  }

  return [{ path: 'models.ts', content: lines.join('\n') }];
}
