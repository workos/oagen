import type { Enum, GeneratedFile, EmitterContext } from '@workos/oagen';
import { tsTypeName } from '../naming.js';

export function generateEnums(enums: Enum[], _ctx: EmitterContext): GeneratedFile[] {
  if (enums.length === 0) return [];

  const lines: string[] = [];

  for (const e of enums) {
    const values = e.values.map((v) => JSON.stringify(v.value)).join(' | ');
    lines.push(`export type ${tsTypeName(e.name)} = ${values};`);
    lines.push('');
  }

  return [{ path: 'enums.ts', content: lines.join('\n') }];
}
