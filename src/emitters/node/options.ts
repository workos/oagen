import type { Service, Operation, TypeRef } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { planOperation } from '../../engine/operation-plan.js';
import { nodeClassName, nodeInterfacePath, mergeActionService } from './naming.js';
import { toCamelCase } from '../../utils/naming.js';
import { mapTypeRefPublic } from './type-map.js';

export function generateOptions(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const service of services) {
    for (const op of service.operations) {
      const plan = planOperation(op);
      const hasBodyOrParams = plan.hasBody || plan.hasQueryParams;
      const isIdempotentPost = plan.isIdempotentPost;
      const pathParamsInOptions = plan.pathParamsInOptions;

      if (!hasBodyOrParams && !isIdempotentPost && !pathParamsInOptions) continue;

      const serviceName = service.name;

      if (hasBodyOrParams || pathParamsInOptions) {
        const typeName = optionsTypeName(op, service);

        // Generate interface
        files.push({
          path: nodeInterfacePath(serviceName, typeName),
          content: generateOptionsInterface(op, service, ctx),
        });
      }

      // Generate request options interface for idempotent POST
      if (isIdempotentPost) {
        const reqOptsName = requestOptionsTypeName(op, service);
        files.push({
          path: nodeInterfacePath(serviceName, reqOptsName),
          content: generateRequestOptionsInterface(op, service),
        });
      }
    }
  }

  return files;
}

function optionsTypeName(op: Operation, service: { name: string }): string {
  return `${mergeActionService(nodeClassName(op.name), nodeClassName(service.name))}Options`;
}

function requestOptionsTypeName(op: Operation, service: { name: string }): string {
  return `${mergeActionService(nodeClassName(op.name), nodeClassName(service.name))}RequestOptions`;
}

function generateOptionsInterface(op: Operation, service: Service, ctx: EmitterContext): string {
  const lines: string[] = [];
  const typeName = optionsTypeName(op, service);
  const pathParamsInOptions = planOperation(op).pathParamsInOptions;

  lines.push(`export interface ${typeName} {`);

  // Path params included in options when combined with body/query or multiple params
  if (pathParamsInOptions) {
    for (const p of op.pathParams) {
      const camelName = toCamelCase(p.name);
      if (p.description) {
        lines.push(`  /** ${p.description} */`);
      }
      lines.push(`  ${camelName}: string;`);
    }
  }

  // Fields from request body
  if (op.requestBody && op.requestBody.kind === 'model') {
    const model = ctx.spec.models.find((m) => m.name === op.requestBody!.name);
    if (model) {
      for (const field of model.fields) {
        const camelName = toCamelCase(field.name);
        const tsType = mapTypeRefPublic(field.type);
        const optional = !field.required ? '?' : '';
        if (field.description) {
          lines.push(`  /** ${field.description} */`);
        }
        lines.push(`  ${camelName}${optional}: ${tsType};`);
      }
    }
  }

  // Fields from query params
  for (const param of op.queryParams) {
    const camelName = toCamelCase(param.name);
    const tsType = mapQueryParamType(param.type);
    const optional = !param.required ? '?' : '';
    if (param.description) {
      lines.push(`  /** ${param.description} */`);
    }
    lines.push(`  ${camelName}${optional}: ${tsType};`);
  }

  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function generateRequestOptionsInterface(op: Operation, service: Service): string {
  const typeName = requestOptionsTypeName(op, service);
  return `export interface ${typeName} {
  idempotencyKey?: string;
}
`;
}

function mapQueryParamType(typeRef: TypeRef): string {
  switch (typeRef.kind) {
    case 'primitive':
      if (typeRef.type === 'string') return 'string';
      if (typeRef.type === 'integer' || typeRef.type === 'number') return 'number';
      if (typeRef.type === 'boolean') return 'boolean';
      return 'string';
    case 'enum':
      return typeRef.name;
    case 'array':
      return `${mapQueryParamType(typeRef.items)}[]`;
    default:
      return 'string';
  }
}
