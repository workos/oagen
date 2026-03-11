import type { Service, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { nodeClassName, nodeMethodName, nodeResourcePath, mergeActionService } from './naming.js';
import { toCamelCase } from '../../utils/naming.js';

export function generateResources(services: Service[], ctx: EmitterContext): GeneratedFile[] {
  return services.map((service) => ({
    path: nodeResourcePath(service.name),
    content: generateResource(service, ctx),
  }));
}

function generateResource(service: Service, ctx: EmitterContext): string {
  const className = nodeClassName(service.name);
  const ns = ctx.namespacePascal;
  const lines: string[] = [];

  // Collect imports
  const imports = collectImports(service, ctx);
  lines.push(...imports);
  lines.push('');

  lines.push(`export class ${className} {`);
  lines.push(`  constructor(private readonly ${toCamelCase(ctx.namespace)}: ${ns}) {}`);

  for (const op of service.operations) {
    lines.push('');
    lines.push(...generateMethod(op, service, ctx).map((l) => `  ${l}`));
  }

  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function collectImports(service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const ns = ctx.namespacePascal;
  const nsFile = ctx.namespacePascal.toLowerCase();

  lines.push(`import type { ${ns} } from '../${nsFile}';`);
  lines.push(`import { deserialize, serialize } from '../common/utils/serialization';`);

  // Import model types (public only, no Response)
  const modelNames = new Set<string>();
  for (const op of service.operations) {
    if (isModelResponse(op)) {
      modelNames.add(getResponseModelName(op));
    }
  }
  if (modelNames.size > 0) {
    lines.push(`import type { ${[...modelNames].join(', ')} } from './interfaces/index';`);
  }

  // Collect options interfaces needed
  const optionTypeImports: string[] = [];
  for (const op of service.operations) {
    if (op.requestBody || op.queryParams.length > 0) {
      optionTypeImports.push(optionsTypeName(op, service));
    }
    if (op.idempotent && op.httpMethod === 'post') {
      optionTypeImports.push(requestOptionsTypeName(op, service));
    }
  }
  if (optionTypeImports.length > 0) {
    lines.push(`import type { ${optionTypeImports.join(', ')} } from './interfaces/index';`);
  }

  const needsPagination = service.operations.some((o) => o.paginated);
  if (needsPagination) {
    lines.push(`import { AutoPaginatable } from '../common/utils/pagination';`);
    lines.push(`import { fetchAndDeserialize } from '../common/utils/fetch-and-deserialize';`);
  }

  return lines;
}

function generateMethod(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name);
  const responseModel = getResponseModelName(op);
  const isDelete = op.httpMethod === 'delete';
  const hasBody = !!op.requestBody;
  const isIdempotentPost = op.idempotent && op.httpMethod === 'post';
  const clientVar = toCamelCase(ctx.namespace);

  // Build return type
  let returnType: string;
  if (isDelete) {
    returnType = 'void';
  } else if (op.paginated) {
    returnType = `AutoPaginatable<${responseModel}>`;
  } else {
    returnType = responseModel;
  }

  // Path params go into the options object when there are multiple path params
  // or when combined with body/query params (matches standard SDK conventions)
  const pathParamsInOptions = op.pathParams.length > 1 ||
    (op.pathParams.length > 0 && (hasBody || op.queryParams.length > 0));
  const optionsParamName = hasBody ? 'payload' : 'options';

  // Build params
  const params: string[] = [];
  if (!pathParamsInOptions) {
    for (const p of op.pathParams) {
      params.push(`${toCamelCase(p.name)}: string`);
    }
  }
  if (hasBody) {
    const optionsType = optionsTypeName(op, service);
    params.push(`payload: ${optionsType}`);
  } else if (pathParamsInOptions || op.queryParams.length > 0) {
    const optionsType = optionsTypeName(op, service);
    const optional = pathParamsInOptions ? '' : '?';
    params.push(`options${optional}: ${optionsType}`);
  }
  if (isIdempotentPost) {
    const reqOptsType = requestOptionsTypeName(op, service);
    params.push(`requestOptions: ${reqOptsType} = {}`);
  }

  // TSDoc
  if (op.description) {
    lines.push(`/** ${op.description} */`);
  }
  lines.push(`async ${methodName}(${params.join(', ')}): Promise<${returnType}> {`);

  // Build path
  const pathSource = pathParamsInOptions ? optionsParamName : undefined;
  const path = buildPathExpression(op, pathSource);

  if (op.paginated) {
    if (pathParamsInOptions) {
      lines.push(`  const resolvedPath = ${path};`);
    }
    const pathArg = pathParamsInOptions ? 'resolvedPath' : `'${stripLeadingSlash(op.path)}'`;
    lines.push(`  return new AutoPaginatable(`);
    lines.push(`    await fetchAndDeserialize(`);
    lines.push(`      this.${clientVar}, ${pathArg}, (raw: unknown) => deserialize<${responseModel}>(raw), ${optionsParamName},`);
    lines.push(`    ),`);
    lines.push(`    (raw: unknown) => deserialize<${responseModel}>(raw),`);
    lines.push(`    (params) => fetchAndDeserialize(`);
    lines.push(`      this.${clientVar}, ${pathArg}, (raw: unknown) => deserialize<${responseModel}>(raw), params,`);
    lines.push(`    ),`);
    lines.push(`    ${optionsParamName},`);
    lines.push(`  );`);
  } else if (isDelete) {
    lines.push(`  await this.${clientVar}.delete(${path});`);
  } else if (hasBody) {
    const hasModelResponse = isModelResponse(op);
    if (isIdempotentPost) {
      if (hasModelResponse) {
        lines.push(`  const { data } = await this.${clientVar}.post(`);
      } else {
        lines.push(`  await this.${clientVar}.post(`);
      }
      lines.push(`    ${path}, serialize(payload as any), requestOptions,`);
      lines.push(`  );`);
    } else if (op.httpMethod === 'post') {
      if (hasModelResponse) {
        lines.push(`  const { data } = await this.${clientVar}.post(`);
      } else {
        lines.push(`  await this.${clientVar}.post(`);
      }
      lines.push(`    ${path}, serialize(payload as any),`);
      lines.push(`  );`);
    } else if (op.httpMethod === 'put') {
      if (hasModelResponse) {
        lines.push(`  const { data } = await this.${clientVar}.put(`);
      } else {
        lines.push(`  await this.${clientVar}.put(`);
      }
      lines.push(`    ${path}, serialize(payload as any),`);
      lines.push(`  );`);
    } else if (op.httpMethod === 'patch') {
      if (hasModelResponse) {
        lines.push(`  const { data } = await this.${clientVar}.patch(`);
      } else {
        lines.push(`  await this.${clientVar}.patch(`);
      }
      lines.push(`    ${path}, serialize(payload as any),`);
      lines.push(`  );`);
    }
    if (hasModelResponse) {
      lines.push(`  return deserialize<${responseModel}>(data);`);
    }
  } else if (isModelResponse(op)) {
    // Simple GET with model response
    lines.push(`  const { data } = await this.${clientVar}.get(${path});`);
    lines.push(`  return deserialize<${responseModel}>(data);`);
  } else {
    // Simple GET with no model response
    lines.push(`  await this.${clientVar}.get(${path});`);
  }

  lines.push('}');

  return lines;
}

function buildPathExpression(op: Operation, pathParamsSource?: string): string {
  if (op.pathParams.length === 0) {
    return `'${stripLeadingSlash(op.path)}'`;
  }
  let path = stripLeadingSlash(op.path);
  for (const p of op.pathParams) {
    const name = toCamelCase(p.name);
    const ref = pathParamsSource ? `${pathParamsSource}.${name}` : name;
    path = path.replace(`{${p.name}}`, `\${${ref}}`);
  }
  return `\`${path}\``;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function optionsTypeName(op: Operation, service: { name: string }): string {
  return `${mergeActionService(nodeClassName(op.name), nodeClassName(service.name))}Options`;
}

function requestOptionsTypeName(op: Operation, service: { name: string }): string {
  return `${mergeActionService(nodeClassName(op.name), nodeClassName(service.name))}RequestOptions`;
}

function getResponseModelName(op: Operation): string {
  if (op.httpMethod === 'delete') return 'void';
  if (op.response.kind === 'model') return op.response.name;
  if (op.response.kind === 'array' && op.response.items.kind === 'model') {
    return op.response.items.name;
  }
  if (op.response.kind === 'nullable' && op.response.inner.kind === 'model') {
    return op.response.inner.name;
  }
  if (op.response.kind === 'union') {
    const firstModel = op.response.variants.find((v) => v.kind === 'model');
    if (firstModel && firstModel.kind === 'model') return firstModel.name;
  }
  if (op.response.kind === 'primitive') {
    return 'void'; // primitives don't need deserialization
  }
  return 'void';
}

function isModelResponse(op: Operation): boolean {
  const name = getResponseModelName(op);
  return name !== 'void';
}
