import type { Model, TypeRef, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { planOperation } from '../../engine/operation-plan.js';
import { mapTypeRefPublic } from './type-map.js';
import { nodeClassName, nodeFieldName, nodeFileName, nodeInterfacePath, mergeActionService } from './naming.js';

export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const serviceMap = buildModelServiceMap(ctx);

  // Group models by service
  const modelsByService = new Map<string, Model[]>();
  for (const model of models) {
    const service = serviceMap.get(model.name) ?? 'common';
    if (!modelsByService.has(service)) modelsByService.set(service, []);
    modelsByService.get(service)!.push(model);
  }

  // Generate per-service files
  for (const [serviceName, serviceModels] of modelsByService) {
    for (const model of serviceModels) {
      files.push({
        path: nodeInterfacePath(serviceName, model.name),
        content: generateInterface(model),
      });
    }

    // Per-service barrel exports
    const interfaceExports = serviceModels.map((m) => `export * from './${nodeFileName(m.name)}.interface';`);

    // Add options type exports for operations in this service
    const service = ctx.spec.services.find((s) => s.name === serviceName);
    if (service) {
      for (const op of service.operations) {
        const plan = planOperation(op);
        if (plan.hasBody || plan.hasQueryParams) {
          const optName = `${mergeActionService(nodeClassName(op.name), nodeClassName(service.name))}Options`;
          interfaceExports.push(`export * from './${nodeFileName(optName)}.interface';`);
        }
        if (plan.isIdempotentPost) {
          const reqOptsName = `${mergeActionService(nodeClassName(op.name), nodeClassName(service.name))}RequestOptions`;
          interfaceExports.push(`export * from './${nodeFileName(reqOptsName)}.interface';`);
        }
      }
    }

    files.push({
      path: `src/${nodeFileName(serviceName)}/interfaces/index.ts`,
      content: [...new Set(interfaceExports)].join('\n') + '\n',
    });
  }

  return files;
}

function generateInterface(model: Model): string {
  const lines: string[] = [];
  const className = nodeClassName(model.name);

  if (model.description) {
    lines.push(`/** ${model.description} */`);
  }
  lines.push(`export interface ${className} {`);
  for (const field of model.fields) {
    const tsType = mapTypeRefPublic(field.type);
    const camelName = nodeFieldName(field.name);
    const optional = !field.required ? '?' : '';
    if (field.description) {
      lines.push(`  /** ${field.description} */`);
    }
    lines.push(`  ${camelName}${optional}: ${tsType};`);
  }
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function buildModelServiceMap(ctx: EmitterContext): Map<string, string> {
  const modelToService = new Map<string, string>();

  for (const service of ctx.spec.services) {
    for (const op of service.operations) {
      const refs = collectAllModelRefsFromOp(op);
      for (const ref of refs) {
        // First service wins for single-service models
        if (!modelToService.has(ref)) {
          modelToService.set(ref, service.name);
        }
      }
    }
  }

  return modelToService;
}

function collectAllModelRefsFromOp(op: Operation): Set<string> {
  const refs = new Set<string>();
  collectModelRefs(op.response, refs);
  if (op.requestBody) collectModelRefs(op.requestBody, refs);
  for (const p of op.queryParams) collectModelRefs(p.type, refs);
  for (const p of op.pathParams) collectModelRefs(p.type, refs);
  return refs;
}

function collectModelRefs(typeRef: TypeRef, refs: Set<string>): void {
  switch (typeRef.kind) {
    case 'model':
      refs.add(typeRef.name);
      break;
    case 'array':
      collectModelRefs(typeRef.items, refs);
      break;
    case 'nullable':
      collectModelRefs(typeRef.inner, refs);
      break;
    case 'union':
      for (const v of typeRef.variants) collectModelRefs(v, refs);
      break;
  }
}
