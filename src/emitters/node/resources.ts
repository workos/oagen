import type { Service, Operation } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { nodeClassName, nodeFileName, nodeMethodName, nodeResourcePath } from './naming.js';
import { toCamelCase, toPascalCase } from '../../utils/naming.js';

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
  const nsFile = nodeFileName(ctx.namespace);

  lines.push(`import type { ${ns} } from '../${nsFile}.js';`);

  const modelNames = new Set<string>();
  const needsPagination = service.operations.some((o) => o.paginated);
  const needsFetchAndDeserialize = needsPagination;

  for (const op of service.operations) {
    const responseModel = getResponseModelName(op);
    if (responseModel !== 'void') {
      modelNames.add(responseModel);
    }
  }

  if (modelNames.size > 0) {
    const interfaceImports: string[] = [];
    const serializerImports: string[] = [];
    for (const name of modelNames) {
      interfaceImports.push(name, `${name}Response`);
      serializerImports.push(`deserialize${name}`);
    }
    lines.push(`import type { ${interfaceImports.join(', ')} } from './interfaces/index.js';`);
    lines.push(`import { ${serializerImports.join(', ')} } from './serializers/index.js';`);
  }

  // Collect options interfaces needed
  const optionImports: string[] = [];
  for (const op of service.operations) {
    if (op.requestBody || op.queryParams.length > 0) {
      optionImports.push(`${nodeClassName(op.name)}${nodeClassName(service.name)}Options`);
    }
    if (op.requestBody) {
      optionImports.push(`serialize${nodeClassName(op.name)}${nodeClassName(service.name)}Options`);
    }
    if (op.idempotent && op.httpMethod === 'post') {
      optionImports.push(`${nodeClassName(op.name)}${nodeClassName(service.name)}RequestOptions`);
    }
  }

  if (needsPagination) {
    lines.push(`import { AutoPaginatable } from '../common/utils/pagination.js';`);
  }
  if (needsFetchAndDeserialize) {
    lines.push(`import { fetchAndDeserialize } from '../common/utils/fetch-and-deserialize.js';`);
  }

  return lines;
}

function generateMethod(op: Operation, service: Service, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const methodName = toCamelCase(op.name) + toPascalCase(service.name);
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

  // Build params
  const params: string[] = [];
  for (const p of op.pathParams) {
    params.push(`${toCamelCase(p.name)}: string`);
  }
  if (hasBody) {
    const optionsType = `${nodeClassName(op.name)}${nodeClassName(service.name)}Options`;
    params.push(`payload: ${optionsType}`);
  }
  if (op.queryParams.length > 0 && !hasBody) {
    if (op.paginated) {
      const optionsType = `${nodeClassName(op.name)}${nodeClassName(service.name)}Options`;
      params.push(`options?: ${optionsType}`);
    } else {
      const optionsType = `${nodeClassName(op.name)}${nodeClassName(service.name)}Options`;
      params.push(`options?: ${optionsType}`);
    }
  }
  if (isIdempotentPost) {
    const reqOptsType = `${nodeClassName(op.name)}${nodeClassName(service.name)}RequestOptions`;
    params.push(`requestOptions: ${reqOptsType} = {}`);
  }

  // TSDoc
  if (op.description) {
    lines.push(`/** ${op.description} */`);
  }
  lines.push(`async ${methodName}(${params.join(', ')}): Promise<${returnType}> {`);

  // Build path
  const path = buildPathExpression(op);

  if (op.paginated) {
    lines.push(`  return new AutoPaginatable(`);
    lines.push(`    await fetchAndDeserialize<${responseModel}Response, ${responseModel}>(`);
    lines.push(`      this.${clientVar}, '${stripLeadingSlash(op.path)}', deserialize${responseModel}, options,`);
    lines.push(`    ),`);
    lines.push(`    deserialize${responseModel},`);
    lines.push(`    (params) => fetchAndDeserialize<${responseModel}Response, ${responseModel}>(`);
    lines.push(`      this.${clientVar}, '${stripLeadingSlash(op.path)}', deserialize${responseModel}, params,`);
    lines.push(`    ),`);
    lines.push(`    options,`);
    lines.push(`  );`);
  } else if (isDelete) {
    lines.push(`  await this.${clientVar}.delete(${path});`);
  } else if (hasBody) {
    const serializerName = `serialize${nodeClassName(op.name)}${nodeClassName(service.name)}Options`;
    if (isIdempotentPost) {
      lines.push(`  const { data } = await this.${clientVar}.post<${responseModel}Response>(`);
      lines.push(`    ${path}, ${serializerName}(payload), requestOptions,`);
      lines.push(`  );`);
    } else if (op.httpMethod === 'post') {
      lines.push(`  const { data } = await this.${clientVar}.post<${responseModel}Response>(`);
      lines.push(`    ${path}, ${serializerName}(payload),`);
      lines.push(`  );`);
    } else if (op.httpMethod === 'put') {
      lines.push(`  const { data } = await this.${clientVar}.put<${responseModel}Response>(`);
      lines.push(`    ${path}, ${serializerName}(payload),`);
      lines.push(`  );`);
    } else if (op.httpMethod === 'patch') {
      lines.push(`  const { data } = await this.${clientVar}.patch<${responseModel}Response>(`);
      lines.push(`    ${path}, ${serializerName}(payload),`);
      lines.push(`  );`);
    }
    lines.push(`  return deserialize${responseModel}(data);`);
  } else {
    // Simple GET
    lines.push(`  const { data } = await this.${clientVar}.get<${responseModel}Response>(${path});`);
    lines.push(`  return deserialize${responseModel}(data);`);
  }

  lines.push('}');

  return lines;
}

function buildPathExpression(op: Operation): string {
  if (op.pathParams.length === 0) {
    return `'${stripLeadingSlash(op.path)}'`;
  }
  let path = stripLeadingSlash(op.path);
  for (const p of op.pathParams) {
    path = path.replace(`{${p.name}}`, `\${${toCamelCase(p.name)}}`);
  }
  return `\`${path}\``;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function getResponseModelName(op: Operation): string {
  if (op.httpMethod === 'delete') return 'void';
  if (op.response.kind === 'model') return op.response.name;
  if (op.response.kind === 'array' && op.response.items.kind === 'model') {
    return op.response.items.name;
  }
  return 'any';
}
