import type { Enum } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { nodeFileName } from './naming.js';

export function generateEnums(enums: Enum[], _ctx: EmitterContext): GeneratedFile[] {
  return enums.map((e) => ({
    path: `src/common/interfaces/${nodeFileName(e.name)}.interface.ts`,
    content: generateEnum(e),
  }));
}

function generateEnum(e: Enum): string {
  const values = e.values.map((v) => `'${v.value}'`).join(' | ');
  return `export type ${e.name} = ${values};\n`;
}
