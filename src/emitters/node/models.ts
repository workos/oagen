import type { Model, Field, TypeRef, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { mapTypeRefPublic, mapTypeRefResponse } from './type-map.js';
import { nodeClassName, nodeFieldName, nodeFileName, nodeInterfacePath, nodeSerializerPath } from './naming.js';
import { toSnakeCase, toCamelCase } from '../../utils/naming.js';

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
        content: generateInterface(model, ctx, serviceMap, serviceName),
      });
      files.push({
        path: nodeSerializerPath(serviceName, model.name),
        content: generateSerializer(model, ctx, serviceMap, serviceName),
      });
    }

    // Per-service barrel exports
    files.push({
      path: `src/${nodeFileName(serviceName)}/interfaces/index.ts`,
      content: serviceModels.map((m) => `export * from './${nodeFileName(m.name)}.interface.js';`).join('\n') + '\n',
    });
    files.push({
      path: `src/${nodeFileName(serviceName)}/serializers/index.ts`,
      content: serviceModels.map((m) => `export * from './${nodeFileName(m.name)}.serializer.js';`).join('\n') + '\n',
    });
  }

  return files;
}

function generateInterface(
  model: Model,
  ctx: EmitterContext,
  serviceMap: Map<string, string>,
  currentService: string,
): string {
  const lines: string[] = [];
  const className = nodeClassName(model.name);

  // Collect imports for model refs
  const imports = collectModelImports(model, 'public');
  for (const imp of imports) {
    const impService = serviceMap.get(imp) ?? 'common';
    if (impService === currentService) {
      lines.push(`import type { ${imp}, ${imp}Response } from './${nodeFileName(imp)}.interface.js';`);
    } else {
      lines.push(
        `import type { ${imp}, ${imp}Response } from '../../${nodeFileName(impService)}/interfaces/${nodeFileName(imp)}.interface.js';`,
      );
    }
  }
  if (imports.length > 0) lines.push('');

  // Public interface (camelCase)
  if (model.description) {
    lines.push(`/** ${model.description} */`);
  }
  lines.push(`export interface ${className} {`);
  for (const field of model.fields) {
    const tsType = mapTypeRefPublic(field.type, ctx.namespacePascal);
    const camelName = nodeFieldName(field.name);
    const optional = !field.required ? '?' : '';
    if (field.description) {
      lines.push(`  /** ${field.description} */`);
    }
    lines.push(`  ${camelName}${optional}: ${tsType};`);
  }
  lines.push('}');
  lines.push('');

  // Response interface (snake_case)
  lines.push(`export interface ${className}Response {`);
  for (const field of model.fields) {
    const tsType = mapTypeRefResponse(field.type, ctx.namespacePascal);
    const snakeName = toSnakeCase(field.name);
    const optional = !field.required ? '?' : '';
    lines.push(`  ${snakeName}${optional}: ${tsType};`);
  }
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function generateSerializer(
  model: Model,
  ctx: EmitterContext,
  serviceMap: Map<string, string>,
  currentService: string,
): string {
  const lines: string[] = [];
  const className = nodeClassName(model.name);

  // Import the interfaces
  lines.push(
    `import type { ${className}, ${className}Response } from '../interfaces/${nodeFileName(model.name)}.interface.js';`,
  );

  // Import nested deserializers
  const nestedModels = collectModelImports(model, 'public');
  for (const imp of nestedModels) {
    const impService = serviceMap.get(imp) ?? 'common';
    if (impService === currentService) {
      lines.push(`import { deserialize${imp} } from './${nodeFileName(imp)}.serializer.js';`);
    } else {
      lines.push(
        `import { deserialize${imp} } from '../../${nodeFileName(impService)}/serializers/${nodeFileName(imp)}.serializer.js';`,
      );
    }
  }

  lines.push('');

  // Deserializer function
  lines.push(`export const deserialize${className} = (`);
  lines.push(`  response: ${className}Response,`);
  lines.push(`): ${className} => ({`);

  for (const field of model.fields) {
    const camelName = nodeFieldName(field.name);
    const snakeName = toSnakeCase(field.name);
    const deserExpr = buildDeserializeExpr(field.type, `response.${snakeName}`);

    if (!field.required && !isNullableType(field.type)) {
      // Optional non-nullable: use spread pattern
      lines.push(`  ...(typeof response.${snakeName} === 'undefined' ? undefined : { ${camelName}: ${deserExpr} }),`);
    } else if (isNullableType(field.type)) {
      lines.push(`  ${camelName}: ${deserExpr},`);
    } else {
      lines.push(`  ${camelName}: ${deserExpr},`);
    }
  }

  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

function buildDeserializeExpr(typeRef: TypeRef, accessor: string): string {
  switch (typeRef.kind) {
    case 'model':
      return `deserialize${typeRef.name}(${accessor})`;
    case 'array':
      if (typeRef.items.kind === 'model') {
        return `${accessor}.map(deserialize${typeRef.items.name})`;
      }
      return accessor;
    case 'nullable':
      if (typeRef.inner.kind === 'model') {
        return `${accessor} != null ? deserialize${typeRef.inner.name}(${accessor}) : null`;
      }
      return `${accessor} ?? null`;
    default:
      return accessor;
  }
}

function isNullableType(typeRef: TypeRef): boolean {
  return typeRef.kind === 'nullable';
}

function collectModelImports(model: Model, _mode: 'public' | 'response'): string[] {
  const refs = new Set<string>();
  for (const field of model.fields) {
    collectModelRefs(field.type, refs);
  }
  // Exclude self-references
  refs.delete(model.name);
  return [...refs];
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
