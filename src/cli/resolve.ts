import { parseSpec, type OpenApiDocument } from '../parser/parse.js';
import { resolveOperations, findResolvedMethodCollisions } from '../ir/operation-hints.js';
import { expandDocUrls } from '../utils/expand-doc-urls.js';
import type { OperationHint, ResolvedOperation } from '../ir/operation-hints.js';
import { CommandError } from '../errors.js';

export async function resolveCommand(opts: {
  spec: string;
  format?: 'table' | 'json';
  operationIdTransform?: (id: string) => string;
  schemaNameTransform?: (name: string) => string;
  transformSpec?: (spec: OpenApiDocument) => OpenApiDocument;
  docUrl?: string;
  operationHints?: Record<string, OperationHint>;
  mountRules?: Record<string, string>;
}): Promise<void> {
  let ir = await parseSpec(opts.spec, {
    operationIdTransform: opts.operationIdTransform,
    schemaNameTransform: opts.schemaNameTransform,
    transformSpec: opts.transformSpec,
  });
  if (opts.docUrl) {
    ir = expandDocUrls(ir, opts.docUrl);
  }

  const resolved = resolveOperations(ir, opts.operationHints, opts.mountRules);

  // Fail before printing anything. Emitters refuse to generate on a name
  // collision, but they only run inside the per-language build matrix, so
  // without this check a colliding spec addition passes `resolve` and then
  // fails every matrix job several minutes later. This is the cheap gate.
  const collisions = findResolvedMethodCollisions(resolved);
  if (collisions.length > 0) {
    const detail = collisions
      .map(
        (c) =>
          `  ${c.key}: ${c.first.httpMethod} ${c.first.path} conflicts with ${c.second.httpMethod} ${c.second.path}`,
      )
      .join('\n');
    throw new CommandError(
      `Resolved operation name collision${collisions.length > 1 ? 's' : ''}:\n${detail}`,
      'Give one of each pair an explicit `name` in operationHints. Rename the NEW path — renaming an already-shipped method breaks released SDKs.',
      1,
    );
  }

  const format = opts.format ?? 'table';

  if (format === 'json') {
    const output = resolved.map(toJsonRow);
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Table format
  printTable(resolved, opts.operationHints);
}

interface JsonRow {
  service: string;
  method: string;
  path: string;
  derivedName: string;
  hintApplied: boolean;
  mountOn: string;
  wrappers?: string[];
}

function toJsonRow(r: ResolvedOperation): JsonRow {
  return {
    service: r.service.name,
    method: r.operation.httpMethod.toUpperCase(),
    path: r.operation.path,
    derivedName: r.methodName,
    hintApplied: r.methodName !== r.operation.name,
    mountOn: r.mountOn,
    wrappers: r.wrappers?.map((w) => w.name),
  };
}

function printTable(resolved: ResolvedOperation[], hints?: Record<string, OperationHint>): void {
  const hintMap = hints ?? {};

  // Header
  console.log('| Service | Method | Path | Resolved Name | Hint | Mount On |');
  console.log('|---|---|---|---|---|---|');

  const unhinted: ResolvedOperation[] = [];

  for (const r of resolved) {
    const key = `${r.operation.httpMethod.toUpperCase()} ${r.operation.path}`;
    const hasHint = key in hintMap;
    const hintMarker = hasHint ? 'yes' : '';
    const mountChanged = r.mountOn !== r.service.name;
    const mountCol = mountChanged ? r.mountOn : '';

    console.log(
      `| ${r.service.name} | ${r.operation.httpMethod.toUpperCase()} | ${r.operation.path} | \`${r.methodName}\` | ${hintMarker} | ${mountCol} |`,
    );

    // Track wrappers
    if (r.wrappers) {
      for (const w of r.wrappers) {
        console.log(`|  | | | \`${w.name}\` (wrapper) | yes | ${mountCol} |`);
      }
    }

    if (!hasHint && !mountChanged) {
      unhinted.push(r);
    }
  }

  console.log('');
  console.log(
    `Total: ${resolved.length} operations, ${resolved.length - unhinted.length} with hints/mounts, ${unhinted.length} algorithm-only`,
  );
}
