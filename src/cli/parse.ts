import { parseSpec, type OpenApiDocument } from '../parser/parse.js';
import type { SchemaNameTransform } from '../parser/schemas.js';
import type { OperationHint } from '../ir/operation-hints.js';

export async function parseCommand(opts: {
  spec: string;
  operationIdTransform?: (id: string) => string;
  schemaNameTransform?: SchemaNameTransform;
  transformSpec?: (spec: OpenApiDocument) => OpenApiDocument;
  operationHints?: Record<string, OperationHint>;
  collapseErrorBodies?: boolean;
}): Promise<void> {
  const ir = await parseSpec(opts.spec, {
    operationIdTransform: opts.operationIdTransform,
    schemaNameTransform: opts.schemaNameTransform,
    transformSpec: opts.transformSpec,
    operationHints: opts.operationHints,
    collapseErrorBodies: opts.collapseErrorBodies,
  });
  console.log(JSON.stringify(ir, null, 2));
}
