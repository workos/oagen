import type { ApiSpec, Model, TypeRef, Service } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';
import type { OperationHint } from '../ir/operation-hints.js';
import { resolveOperations } from '../ir/operation-hints.js';
import type { Emitter, EmitterContext, GeneratedFile, OperationsMap } from './types.js';
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
    modelHints?: Record<string, string>;
    emitterOptions?: Record<string, unknown>;
    target?: string;
    priorTargetManifestPaths?: Set<string>;
    scopedServices?: Set<string>;
  },
): EmitterContext {
  const resolvedOperations = resolveOperations(spec, options.operationHints, options.mountRules);

  // In a scoped run, derive the model/enum allow-lists = names reachable
  // from the SELECTED source services (those whose post-mount target is selected).
  // Emitters write a model/enum FILE only when it is in these sets, so a
  // non-selected service's exclusive models are left untouched (no leak) while
  // shared models reachable from the selection still emit. Barrels stay full.
  let scopedModelNames: Set<string> | undefined;
  let scopedEnumNames: Set<string> | undefined;
  if (options.scopedServices && options.scopedServices.size > 0) {
    const selected = options.scopedServices;
    const selectedSourceServices = spec.services.filter((s) =>
      resolvedOperations.some((r) => r.service.name === s.name && selected.has(r.mountOn)),
    );
    const reachable = collectReferencedNames(selectedSourceServices, spec.models, { preserveAllDiscriminated: false });
    scopedModelNames = reachable.models;
    scopedEnumNames = reachable.enums;
  }

  return {
    namespace: toSnakeCase(options.namespace),
    namespacePascal: options.namespace,
    spec,
    outputDir: options.outputDir,
    apiSurface: options.apiSurface,
    overlayLookup: options.overlayLookup,
    resolvedOperations,
    modelHints: options.modelHints,
    emitterOptions: options.emitterOptions,
    targetDir: options.target,
    priorTargetManifestPaths: options.priorTargetManifestPaths,
    scopedServices: options.scopedServices,
    scopedModelNames,
    scopedEnumNames,
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
  opts: { preserveAllDiscriminated?: boolean } = {},
): { models: Set<string>; enums: Set<string> } {
  // Default: preserve EVERY discriminated/event model as public surface (full
  // emission). Strict mode (`preserveAllDiscriminated: false`, used to compute a
  // scoped run's reachable set) skips that blanket and instead chases the mapping
  // variants of discriminated models that are actually reached — so a scoped
  // service doesn't pull in the entire unrelated event tree.
  const preserveAllDiscriminated = opts.preserveAllDiscriminated !== false;
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
  //
  // Also preserve the variants mapped from an `allOf [base, oneOf […]]` base
  // (carried as `Model.discriminator.mapping`). The base model is reached
  // through the operation; without explicitly chasing its mapping, the
  // variant structs would be unreachable and the dispatcher would dangle
  // imports.
  if (preserveAllDiscriminated) {
    for (const model of models) {
      if (isDiscriminatedModel(model)) {
        referencedModels.add(model.name);
      }
      const disc = model.discriminator;
      if (disc?.mapping) {
        for (const variantName of Object.values(disc.mapping)) {
          referencedModels.add(variantName);
        }
      }
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
    // A reached discriminated base pulls in its mapping variants (the dispatcher
    // would otherwise dangle). In full mode this is redundant with the blanket
    // pass above; in strict mode it is the only path that includes variants.
    const disc = model.discriminator;
    if (disc?.mapping) {
      for (const variantName of Object.values(disc.mapping)) {
        if (!referencedModels.has(variantName)) {
          referencedModels.add(variantName);
          queue.push(variantName);
        }
      }
    }
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

/**
 * Collect all generated files from an emitter (no headers, no path prefixes).
 *
 * In a scoped (`--services`) run the spec is NOT filtered: every generator runs
 * over the full spec so model placement, dedup, the root client, and all
 * aggregate/barrel files are byte-identical to a full run (and a brand-new
 * selected service is wired into the client automatically). The emitters
 * themselves consult `ctx.scopedServices` to emit only the selected services'
 * per-service resource/test files.
 */
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
    modelHints?: Record<string, string>;
    emitterOptions?: Record<string, unknown>;
    target?: string;
    priorTargetManifestPaths?: Set<string>;
    /** Scoped-generation signal (POST-MOUNT names); set on ctx for emitters to gate per-service emission. */
    scopedServices?: Set<string>;
  },
): { files: GeneratedFile[]; ctx: EmitterContext; header: string; operations?: OperationsMap } {
  const ctx = buildEmitterContext(spec, options);
  const files = generateAllFiles(spec, emitter, ctx);
  const operations = emitter.buildOperationsMap?.(spec, ctx);
  const header = emitter.fileHeader();
  return { files: applyFileHeaders(files, header), ctx, header, operations };
}
