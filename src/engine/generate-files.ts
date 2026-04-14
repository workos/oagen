import type { ApiSpec, Model, TypeRef, Service } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import type { OperationHint } from '../ir/operation-hints.js';
import { resolveOperations } from '../ir/operation-hints.js';
import type { Emitter, EmitterContext, GeneratedFile } from './types.js';
import type { ApiSurface, OverlayLookup } from '../compat/types.js';
import { toSnakeCase } from '../utils/naming.js';

export function buildEmitterContext(
  spec: ApiSpec,
  options: {
    namespace: string;
    outputDir: string;
    apiSurface?: ApiSurface;
    overlayLookup?: OverlayLookup;
    operationHints?: Record<string, OperationHint>;
    mountRules?: Record<string, string>;
    target?: string;
    priorTargetManifestPaths?: Set<string>;
  },
): EmitterContext {
  return {
    namespace: toSnakeCase(options.namespace),
    namespacePascal: options.namespace,
    spec,
    outputDir: options.outputDir,
    apiSurface: options.apiSurface,
    overlayLookup: options.overlayLookup,
    resolvedOperations: resolveOperations(spec, options.operationHints, options.mountRules),
    targetDir: options.target,
    priorTargetManifestPaths: options.priorTargetManifestPaths,
  };
}

/**
 * Collect model and enum names transitively referenced by service operations.
 * Walks operation parameters, request bodies, responses, and pagination item
 * types, then chases model field references until the set stabilizes.
 */
export function collectReferencedNames(
  services: Service[],
  models: Model[],
): { models: Set<string>; enums: Set<string> } {
  const referencedModels = new Set<string>();
  const referencedEnums = new Set<string>();

  const collectFromTypeRef = (ref: TypeRef): void => {
    walkTypeRef(ref, {
      model: (r) => referencedModels.add(r.name),
      enum: (r) => referencedEnums.add(r.name),
    });
  };

  // Seed: walk every operation's params, request body, response, errors, and pagination
  for (const service of services) {
    for (const op of service.operations) {
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
        collectFromTypeRef(p.type);
      }
      if (op.requestBody) collectFromTypeRef(op.requestBody);
      collectFromTypeRef(op.response);
      if (op.pagination) collectFromTypeRef(op.pagination.itemType);
      for (const err of op.errors) {
        if (err.type) collectFromTypeRef(err.type);
      }
      if (op.successResponses) {
        for (const sr of op.successResponses) {
          collectFromTypeRef(sr.type);
        }
      }
    }
  }

  // Preserve discriminated models as public SDK types even when no operation
  // returns them directly. This matters for event/webhook unions where the base
  // operation references a generic envelope but the variant structs are still
  // useful public surface.
  for (const model of models) {
    if (isDiscriminatedModel(model)) {
      referencedModels.add(model.name);
    }
  }

  // Chase: transitively resolve model field references until stable
  const modelsByName = new Map(models.map((m) => [m.name, m]));
  const visited = new Set<string>();
  const queue = [...referencedModels];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const model = modelsByName.get(name);
    if (!model) continue;
    for (const field of model.fields) {
      collectFromTypeRef(field.type);
      // If new models were discovered, enqueue them
      for (const m of referencedModels) {
        if (!visited.has(m)) queue.push(m);
      }
    }
  }

  return { models: referencedModels, enums: referencedEnums };
}

function isDiscriminatedModel(model: Model): boolean {
  return model.fields.some(
    (field) =>
      (field.name === 'event' || field.name === 'type' || field.name === 'object') && field.type.kind === 'literal',
  );
}

/** Collect all generated files from an emitter (no headers, no path prefixes). */
export function generateAllFiles(spec: ApiSpec, emitter: Emitter, ctx: EmitterContext): GeneratedFile[] {
  const referenced = collectReferencedNames(spec.services, spec.models);
  const reachableModels = spec.models.filter((m) => referenced.models.has(m.name));
  const reachableEnums = spec.enums.filter((e) => referenced.enums.has(e.name));
  const reachableSpec: ApiSpec = { ...spec, models: reachableModels, enums: reachableEnums };

  return [
    ...emitter.generateModels(reachableModels, ctx),
    ...emitter.generateEnums(reachableEnums, ctx),
    ...emitter.generateResources(spec.services, ctx),
    ...emitter.generateClient(spec, ctx),
    ...emitter.generateErrors(ctx),
    ...(emitter.generateTypeSignatures?.(reachableSpec, ctx) ?? []),
    ...emitter.generateTests(reachableSpec, ctx),
    ...(emitter.generateManifest?.(spec, ctx) ?? []),
  ];
}

/** Apply file header to generated files, respecting headerPlacement and JSON files. */
export function applyFileHeaders(files: GeneratedFile[], header: string): GeneratedFile[] {
  return files.map((f) => ({
    ...f,
    content:
      !header || f.path.endsWith('.json') || f.headerPlacement === 'skip' ? f.content : header + '\n\n' + f.content,
    skipIfExists: f.skipIfExists ?? false,
  }));
}

export function generateFiles(
  spec: ApiSpec,
  emitter: Emitter,
  options: {
    namespace: string;
    outputDir: string;
    apiSurface?: ApiSurface;
    overlayLookup?: OverlayLookup;
    operationHints?: Record<string, OperationHint>;
    mountRules?: Record<string, string>;
    target?: string;
    priorTargetManifestPaths?: Set<string>;
  },
): { files: GeneratedFile[]; ctx: EmitterContext; header: string } {
  const ctx = buildEmitterContext(spec, options);
  const files = generateAllFiles(spec, emitter, ctx);
  const header = emitter.fileHeader();
  return { files: applyFileHeaders(files, header), ctx, header };
}
