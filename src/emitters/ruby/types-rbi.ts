import type { ApiSpec, Model, Enum, Service, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { mapTypeRefForSorbet } from './type-map.js';
import { rubyClassName, rubyFileName } from './naming.js';

export function generateRbi(spec: ApiSpec, ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const model of spec.models) {
    files.push({
      path: `rbi/${ctx.namespace}/models/${rubyFileName(model.name)}.rbi`,
      content: generateModelRbi(model, ctx),
    });
  }

  for (const e of spec.enums) {
    files.push({
      path: `rbi/${ctx.namespace}/models/${rubyFileName(e.name)}.rbi`,
      content: generateEnumRbi(e, ctx),
    });
  }

  for (const service of spec.services) {
    files.push({
      path: `rbi/${ctx.namespace}/resources/${rubyFileName(service.name)}.rbi`,
      content: generateResourceRbi(service, ctx),
    });
  }

  return files;
}

function generateModelRbi(model: Model, ctx: EmitterContext): string {
  const className = rubyClassName(model.name);
  const lines: string[] = [];

  lines.push('# typed: strong');
  lines.push('');
  lines.push(`module ${ctx.namespacePascal}`);
  lines.push('  module Models');
  lines.push(`    class ${className}`);

  for (const field of model.fields) {
    const sorbetType = field.required
      ? mapTypeRefForSorbet(field.type, ctx.namespacePascal)
      : `T.nilable(${mapTypeRefForSorbet(field.type, ctx.namespacePascal)})`;
    lines.push(`      sig { returns(${sorbetType}) }`);
    lines.push(`      attr_reader :${field.name}`);
    lines.push('');
  }

  lines.push('    end');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return lines.join('\n');
}

function generateEnumRbi(e: Enum, ctx: EmitterContext): string {
  const className = rubyClassName(e.name);
  const lines: string[] = [];

  lines.push('# typed: strong');
  lines.push('');
  lines.push(`module ${ctx.namespacePascal}`);
  lines.push('  module Models');
  lines.push(`    module ${className}`);

  for (const v of e.values) {
    lines.push(`      ${v.name} = T.let(:${v.value}, Symbol)`);
  }

  lines.push('    end');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return lines.join('\n');
}

function generateResourceRbi(service: Service, ctx: EmitterContext): string {
  const className = rubyClassName(service.name);
  const lines: string[] = [];

  lines.push('# typed: strong');
  lines.push('');
  lines.push(`module ${ctx.namespacePascal}`);
  lines.push('  module Resources');
  lines.push(`    class ${className}`);

  for (const op of service.operations) {
    lines.push(...generateMethodSigRbi(op, ctx).map((l) => `      ${l}`));
    lines.push('');
  }

  lines.push('    end');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return lines.join('\n');
}

function generateMethodSigRbi(op: Operation, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const sigParams: string[] = [];

  for (const p of op.pathParams) {
    sigParams.push(`${p.name}: ${mapTypeRefForSorbet(p.type, ctx.namespacePascal)}`);
  }
  if (op.requestBody) {
    sigParams.push('params: T::Hash[Symbol, T.untyped]');
  } else if (op.queryParams.length > 0) {
    sigParams.push('params: T::Hash[Symbol, T.untyped]');
  }
  if (op.idempotent && op.httpMethod === 'post') {
    sigParams.push('idempotency_key: T.nilable(String)');
  }
  sigParams.push('request_options: T.nilable(T::Hash[Symbol, T.untyped])');

  const isDelete = op.httpMethod === 'delete';
  const returnType = op.paginated
    ? `${ctx.namespacePascal}::Internal::CursorPage`
    : isDelete
      ? 'NilClass'
      : mapTypeRefForSorbet(op.response, ctx.namespacePascal);

  lines.push(`sig { params(${sigParams.join(', ')}).returns(${returnType}) }`);
  lines.push(`def ${op.name}; end`);

  return lines;
}
