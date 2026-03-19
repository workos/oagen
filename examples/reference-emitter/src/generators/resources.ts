import type { Service, GeneratedFile, EmitterContext } from '@workos/oagen';
import { planOperation } from '@workos/oagen';
import { tsClassName, tsMethodName } from '../naming.js';
import { toTsType } from '../type-mapper.js';

export function generateResources(services: Service[], _ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const service of services) {
    const lines: string[] = [];
    const className = tsClassName(service.name);

    lines.push(`import { BaseResource } from './config.js';`);
    lines.push('');
    lines.push(`export class ${className} extends BaseResource {`);

    for (const op of service.operations) {
      const plan = planOperation(op);
      const method = tsMethodName(op.name);
      const returnType = plan.isDelete ? 'void' : toTsType(op.response);
      const params: string[] = [];

      for (const p of op.pathParams) {
        params.push(`${tsMethodName(p.name)}: ${toTsType(p.type)}`);
      }

      if (op.requestBody) {
        params.push(`body: ${toTsType(op.requestBody)}`);
      }

      if (op.queryParams.length > 0) {
        const queryFields = op.queryParams
          .map((p) => `${tsMethodName(p.name)}${p.required ? '' : '?'}: ${toTsType(p.type)}`)
          .join('; ');
        params.push(`options?: { ${queryFields} }`);
      }

      const paramStr = params.join(', ');
      const asyncPrefix = plan.isAsync ? 'async ' : '';

      if (op.description) {
        lines.push(`  /** ${op.description} */`);
      }
      lines.push(`  ${asyncPrefix}${method}(${paramStr}): Promise<${returnType}> {`);
      lines.push(`    // Production emitters generate real HTTP calls here`);
      lines.push(`    throw new Error('Not implemented');`);
      lines.push(`  }`);
      lines.push('');
    }

    lines.push('}');

    files.push({
      path: `resources/${service.name.toLowerCase()}.ts`,
      content: lines.join('\n'),
    });
  }

  return files;
}
