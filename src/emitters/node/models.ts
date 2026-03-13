import type { Model, TypeRef, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import type { OverlayLookup } from '../../compat/types.js';
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
        content: generateInterface(model, ctx.overlayLookup),
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
          let optName = `${mergeActionService(nodeClassName(op.name), nodeClassName(service.name))}Options`;
          if (ctx.overlayLookup) {
            const existing = ctx.overlayLookup.interfaceByName.get(optName);
            if (existing) optName = existing;
          }
          interfaceExports.push(`export * from './${nodeFileName(optName)}.interface';`);
        }
        if (plan.isIdempotentPost) {
          let reqOptsName = `${mergeActionService(nodeClassName(op.name), nodeClassName(service.name))}RequestOptions`;
          if (ctx.overlayLookup) {
            const existing = ctx.overlayLookup.interfaceByName.get(reqOptsName);
            if (existing) reqOptsName = existing;
          }
          interfaceExports.push(`export * from './${nodeFileName(reqOptsName)}.interface';`);
        }
      }
    }

    // Ensure overlay-required exports are included in the barrel
    const barrelPath = `src/${nodeFileName(serviceName)}/interfaces/index.ts`;
    if (ctx.overlayLookup) {
      const required = ctx.overlayLookup.requiredExports.get(barrelPath);
      if (required) {
        const existingExports = new Set(interfaceExports);
        for (const symbol of required) {
          const exportLine = `export * from './${nodeFileName(symbol)}.interface';`;
          if (!existingExports.has(exportLine)) {
            interfaceExports.push(exportLine);
          }
        }
      }
    }

    files.push({
      path: barrelPath,
      content: [...new Set(interfaceExports)].join('\n') + '\n',
    });
  }

  return files;
}

function resolveInterfaceName(irName: string, overlay?: OverlayLookup): string {
  if (overlay) {
    const existing = overlay.interfaceByName.get(irName);
    if (existing) return existing;
  }
  return nodeClassName(irName);
}

function generateInterface(model: Model, overlay?: OverlayLookup): string {
  const lines: string[] = [];
  const className = resolveInterfaceName(model.name, overlay);

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
