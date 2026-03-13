import type { Service, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { planOperation } from '../../engine/operation-plan.js';
import { rubyClassName, rubyFileName } from './naming.js';

export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  return services.map((service) => ({
    path: `lib/${ctx.namespace}/resources/${rubyFileName(service.name)}.rb`,
    content: generateResource(service, ctx),
  }));
}

function generateResource(service: Service, ctx: EmitterContext): string {
  const className = rubyClassName(service.name);
  const lines: string[] = [];

  lines.push(`module ${ctx.namespacePascal}`);
  lines.push('  module Resources');
  lines.push(`    class ${className}`);
  lines.push('      # @param client [#{ctx.namespacePascal}::Client]');
  lines.push('      def initialize(client:)');
  lines.push('        @client = client');
  lines.push('      end');

  for (const op of service.operations) {
    lines.push('');
    lines.push(...generateMethod(op, ctx).map((l) => `      ${l}`));
  }

  lines.push('    end');
  lines.push('  end');
  lines.push('end');
  lines.push('');

  return lines.join('\n');
}

function generateMethod(op: Operation, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const path = stripLeadingSlash(op.path);
  const convertedPath = convertPath(path);

  const plan = planOperation(op);
  const pathParams = op.pathParams;
  const hasBody = plan.hasBody;
  const hasQuery = plan.hasQueryParams;
  const isCreate = plan.isIdempotentPost;
  const isDelete = plan.isDelete;
  const responseModelName = plan.responseModelName ?? 'Object';

  // YARD documentation
  if (op.description) {
    lines.push(`# ${op.description}`);
    lines.push('#');
  }
  for (const p of pathParams) {
    lines.push(`# @param ${p.name} [String] ${p.description || `The ${p.name}`}`);
  }
  if (hasBody) {
    lines.push('# @param params [Hash] Request body');
  }
  if (hasQuery && !hasBody) {
    lines.push('# @param params [Hash] Query parameters');
  }
  if (isCreate) {
    lines.push('# @param idempotency_key [String, nil] Unique key for idempotent requests');
  }
  lines.push('# @param request_options [Hash, nil] Override request options');

  const returnTypeYard = op.paginated
    ? `${ctx.namespacePascal}::Internal::CursorPage[${ctx.namespacePascal}::Models::${responseModelName}]`
    : isDelete
      ? 'nil'
      : `${ctx.namespacePascal}::Models::${responseModelName}`;
  lines.push(`# @return [${returnTypeYard}]`);

  // Build method signature
  const params: string[] = [];
  for (const p of pathParams) {
    params.push(p.name);
  }
  if (hasBody) {
    params.push('params');
  }
  if (hasQuery && !hasBody) {
    params.push('params = {}');
  }
  if (isCreate) {
    params.push('idempotency_key: nil');
  }
  params.push('request_options: nil');

  lines.push(`def ${op.name}(${params.join(', ')})`);

  // Build request kwargs
  const kwargs: string[] = [];
  kwargs.push(`method: :${op.httpMethod}`);

  if (pathParams.length > 0) {
    const formatArgs = pathParams.map((p) => p.name).join(', ');
    kwargs.push(`path: ["${convertedPath}", ${formatArgs}]`);
  } else {
    kwargs.push(`path: "${path}"`);
  }

  if (hasQuery && !hasBody) {
    kwargs.push('query: params');
  }
  if (hasBody) {
    kwargs.push('body: params');
  }

  if (plan.isPaginated) {
    kwargs.push(`page: ${ctx.namespacePascal}::Internal::CursorPage`);
    kwargs.push(`model: ${ctx.namespacePascal}::Models::${responseModelName}`);
  } else if (isDelete) {
    kwargs.push('model: NilClass');
  } else {
    kwargs.push(`model: ${ctx.namespacePascal}::Models::${responseModelName}`);
  }

  if (isCreate) {
    kwargs.push('idempotency_key: idempotency_key');
  }
  kwargs.push('options: request_options');

  // Format the request call
  lines.push('  @client.request(');
  for (let i = 0; i < kwargs.length; i++) {
    const comma = i < kwargs.length - 1 ? ',' : '';
    lines.push(`    ${kwargs[i]}${comma}`);
  }
  lines.push('  )');

  lines.push('end');

  return lines;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function convertPath(path: string): string {
  let counter = 0;
  return path.replace(/\{[^}]+\}/g, () => {
    counter++;
    return `%${counter}$s`;
  });
}

