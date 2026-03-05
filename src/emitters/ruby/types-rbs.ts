import type { ApiSpec, Model, Enum, Service, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { mapTypeRefForRbs } from './type-map.js';
import { rubyClassName, rubyFileName } from './naming.js';

export function generateRbs(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const model of spec.models) {
    files.push({
      path: `sig/${ctx.namespace}/models/${rubyFileName(model.name)}.rbs`,
      content: generateModelRbs(model, ctx),
    });
  }

  for (const e of spec.enums) {
    files.push({
      path: `sig/${ctx.namespace}/models/${rubyFileName(e.name)}.rbs`,
      content: generateEnumRbs(e, ctx),
    });
  }

  for (const service of spec.services) {
    files.push({
      path: `sig/${ctx.namespace}/resources/${rubyFileName(service.name)}.rbs`,
      content: generateResourceRbs(service, ctx),
    });
  }

  return files;
}

function generateModelRbs(model: Model, ctx: EmitterContext): string {
  const className = rubyClassName(model.name);
  const lines: string[] = [];

  lines.push(`module ${ctx.namespacePascal}`);
  lines.push('  module Models');
  lines.push(`    class ${className}`);

  for (const field of model.fields) {
    const rbsType = field.required
      ? mapTypeRefForRbs(field.type, ctx.namespacePascal)
      : `${mapTypeRefForRbs(field.type, ctx.namespacePascal)}?`;
    lines.push(`      attr_reader ${field.name}: ${rbsType}`);
  }

  lines.push('    end');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return lines.join('\n');
}

function generateEnumRbs(e: Enum, ctx: EmitterContext): string {
  const className = rubyClassName(e.name);
  const lines: string[] = [];

  lines.push(`module ${ctx.namespacePascal}`);
  lines.push('  module Models');
  lines.push(`    module ${className}`);

  for (const v of e.values) {
    lines.push(`      ${v.name}: Symbol`);
  }

  lines.push('    end');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return lines.join('\n');
}

function generateResourceRbs(service: Service, ctx: EmitterContext): string {
  const className = rubyClassName(service.name);
  const lines: string[] = [];

  lines.push(`module ${ctx.namespacePascal}`);
  lines.push('  module Resources');
  lines.push(`    class ${className}`);
  lines.push(`      def initialize: (client: ${ctx.namespacePascal}::Client) -> void`);

  for (const op of service.operations) {
    lines.push(`      ${generateMethodSigRbs(op, ctx)}`);
  }

  lines.push('    end');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return lines.join('\n');
}

function generateMethodSigRbs(op: Operation, ctx: EmitterContext): string {
  const params: string[] = [];
  for (const p of op.pathParams) {
    params.push(`${mapTypeRefForRbs(p.type, ctx.namespacePascal)} ${p.name}`);
  }
  if (op.requestBody) {
    params.push('Hash[Symbol, untyped] params');
  } else if (op.queryParams.length > 0) {
    params.push('?Hash[Symbol, untyped] params');
  }
  if (op.idempotent && op.httpMethod === 'post') {
    params.push('?idempotency_key: String');
  }
  params.push('?request_options: Hash[Symbol, untyped]');

  const isDelete = op.httpMethod === 'delete';
  const returnType = op.paginated
    ? `${ctx.namespacePascal}::Internal::CursorPage`
    : isDelete
      ? 'void'
      : mapTypeRefForRbs(op.response, ctx.namespacePascal);

  return `def ${op.name}: (${params.join(', ')}) -> ${returnType}`;
}
