import type { ApiSpec, TypeRef } from '../ir/types.js';
import { assertNever } from '../ir/types.js';
import type { Emitter, EmitterContext } from '../engine/types.js';
import type { Change } from './types.js';

export interface AffectedFiles {
  regenerate: string[];
  delete: string[];
}

export function mapChangesToFiles(changes: Change[], emitter: Emitter, ctx: EmitterContext): AffectedFiles {
  const regenerate = new Set<string>();
  const toDelete = new Set<string>();

  const modelFiles = new Map<string, string[]>();
  const enumFiles = new Map<string, string[]>();
  const serviceFiles = new Map<string, string[]>();

  // Build file maps from emitter output
  for (const model of ctx.spec.models) {
    const files = emitter.generateModels([model], ctx);
    const sigs = emitter.generateTypeSignatures({ ...ctx.spec, models: [model], enums: [], services: [] }, ctx);
    modelFiles.set(
      model.name,
      [...files, ...sigs].map((f) => f.path),
    );
  }

  for (const enumDef of ctx.spec.enums) {
    const files = emitter.generateEnums([enumDef], ctx);
    enumFiles.set(
      enumDef.name,
      files.map((f) => f.path),
    );
  }

  for (const service of ctx.spec.services) {
    const files = [
      ...emitter.generateResources([service], ctx),
      ...emitter.generateTests({ ...ctx.spec, services: [service], models: [], enums: [] }, ctx),
    ];
    const sigs = emitter.generateTypeSignatures({ ...ctx.spec, services: [service], models: [], enums: [] }, ctx);
    serviceFiles.set(
      service.name,
      [...files, ...sigs].map((f) => f.path),
    );
  }

  // Build reference graph: which services reference which models/enums
  const modelToServices = buildReferenceGraph(ctx.spec);

  for (const change of changes) {
    switch (change.kind) {
      case 'model-added':
      case 'model-modified': {
        const files = modelFiles.get(change.name) ?? [];
        files.forEach((f) => regenerate.add(f));
        // Cascade to referencing services
        const refs = modelToServices.get(change.name) ?? [];
        for (const svc of refs) {
          const svcFiles = serviceFiles.get(svc) ?? [];
          svcFiles.forEach((f) => regenerate.add(f));
        }
        break;
      }
      case 'model-removed': {
        const files = modelFiles.get(change.name) ?? [];
        files.forEach((f) => toDelete.add(f));
        const refs = modelToServices.get(change.name) ?? [];
        for (const svc of refs) {
          const svcFiles = serviceFiles.get(svc) ?? [];
          svcFiles.forEach((f) => regenerate.add(f));
        }
        break;
      }
      case 'enum-added':
      case 'enum-modified': {
        const files = enumFiles.get(change.name) ?? [];
        files.forEach((f) => regenerate.add(f));
        const refs = modelToServices.get(change.name) ?? [];
        for (const svc of refs) {
          const svcFiles = serviceFiles.get(svc) ?? [];
          svcFiles.forEach((f) => regenerate.add(f));
        }
        break;
      }
      case 'enum-removed': {
        const files = enumFiles.get(change.name) ?? [];
        files.forEach((f) => toDelete.add(f));
        const refs = modelToServices.get(change.name) ?? [];
        for (const svc of refs) {
          const svcFiles = serviceFiles.get(svc) ?? [];
          svcFiles.forEach((f) => regenerate.add(f));
        }
        break;
      }
      case 'service-added': {
        const files = serviceFiles.get(change.name) ?? [];
        files.forEach((f) => regenerate.add(f));
        break;
      }
      case 'service-removed': {
        const files = serviceFiles.get(change.name) ?? [];
        files.forEach((f) => toDelete.add(f));
        break;
      }
      case 'operation-added':
      case 'operation-removed':
      case 'operation-modified': {
        const files = serviceFiles.get(change.serviceName) ?? [];
        files.forEach((f) => regenerate.add(f));
        break;
      }
    }
  }

  // Don't regenerate files that are being deleted
  for (const f of toDelete) {
    regenerate.delete(f);
  }

  return {
    regenerate: [...regenerate].sort(),
    delete: [...toDelete].sort(),
  };
}

function buildReferenceGraph(spec: ApiSpec): Map<string, string[]> {
  const refs = new Map<string, Set<string>>();

  function trackRef(typeRef: TypeRef, serviceName: string) {
    switch (typeRef.kind) {
      case 'model':
        if (!refs.has(typeRef.name)) refs.set(typeRef.name, new Set());
        refs.get(typeRef.name)!.add(serviceName);
        break;
      case 'enum':
        if (!refs.has(typeRef.name)) refs.set(typeRef.name, new Set());
        refs.get(typeRef.name)!.add(serviceName);
        break;
      case 'array':
        trackRef(typeRef.items, serviceName);
        break;
      case 'nullable':
        trackRef(typeRef.inner, serviceName);
        break;
      case 'union':
        typeRef.variants.forEach((v) => trackRef(v, serviceName));
        break;
      case 'literal':
        break;
      case 'primitive':
        break;
      default:
        assertNever(typeRef);
        break;
    }
  }

  for (const service of spec.services) {
    for (const op of service.operations) {
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
        trackRef(p.type, service.name);
      }
      if (op.requestBody) trackRef(op.requestBody, service.name);
      trackRef(op.response, service.name);
    }
  }

  // Build model-to-model dependency graph for transitive closure
  const modelDeps = new Map<string, Set<string>>();

  function collectDeps(typeRef: TypeRef, deps: Set<string>) {
    switch (typeRef.kind) {
      case 'model':
        deps.add(typeRef.name);
        break;
      case 'enum':
        deps.add(typeRef.name);
        break;
      case 'array':
        collectDeps(typeRef.items, deps);
        break;
      case 'nullable':
        collectDeps(typeRef.inner, deps);
        break;
      case 'union':
        typeRef.variants.forEach((v) => collectDeps(v, deps));
        break;
      case 'literal':
        break;
      case 'primitive':
        break;
      default:
        assertNever(typeRef);
        break;
    }
  }

  for (const model of spec.models) {
    const deps = new Set<string>();
    for (const field of model.fields) {
      collectDeps(field.type, deps);
    }
    deps.delete(model.name); // remove self-references
    if (deps.size > 0) {
      modelDeps.set(model.name, deps);
    }
  }

  // Propagate: if service S uses model A, and model A depends on model B,
  // then S also depends on B. Use fixed-point loop for transitive closure.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [modelName, services] of refs) {
      const deps = modelDeps.get(modelName);
      if (!deps) continue;
      for (const dep of deps) {
        if (!refs.has(dep)) refs.set(dep, new Set());
        const depServices = refs.get(dep)!;
        for (const svc of services) {
          if (!depServices.has(svc)) {
            depServices.add(svc);
            changed = true;
          }
        }
      }
    }
  }

  const result = new Map<string, string[]>();
  for (const [name, svcSet] of refs) {
    result.set(name, [...svcSet]);
  }
  return result;
}
