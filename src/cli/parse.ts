import { parseSpec, type OpenApiDocument } from '../parser/parse.js';

export async function parseCommand(opts: {
  spec: string;
  operationIdTransform?: (id: string) => string;
  schemaNameTransform?: (name: string) => string;
  transformSpec?: (spec: OpenApiDocument) => OpenApiDocument;
}): Promise<void> {
  const ir = await parseSpec(opts.spec, {
    operationIdTransform: opts.operationIdTransform,
    schemaNameTransform: opts.schemaNameTransform,
    transformSpec: opts.transformSpec,
  });
  console.log(JSON.stringify(ir, null, 2));
}
