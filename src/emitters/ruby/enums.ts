import type { Enum } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { rubyFileName } from './naming.js';
import { toUpperSnakeCase } from '../../utils/naming.js';

export function generateEnums(enums: Enum[], ctx: EmitterContext): GeneratedFile[] {
  return enums.map((e) => ({
    path: `lib/${ctx.namespace}/models/${rubyFileName(e.name)}.rb`,
    content: generateEnum(e, ctx),
  }));
}

function generateEnum(e: Enum, ctx: EmitterContext): string {
  const lines: string[] = [];
  // Use PascalCase for the module name
  const pascalName = e.name;

  lines.push(`module ${ctx.namespacePascal}`);
  lines.push('  module Models');
  lines.push(`    module ${pascalName}`);
  lines.push(`      extend ${ctx.namespacePascal}::Internal::Type::Enum`);
  lines.push('');

  for (const value of e.values) {
    const constName = toUpperSnakeCase(value.name);
    lines.push(`      ${constName} = :${value.value}`);
  }

  lines.push('    end');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return lines.join('\n');
}
