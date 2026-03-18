import type { ApiSpec, TypeRef } from '../ir/types.js';
import { walkTypeRef } from '../ir/types.js';

export function validateModelRefs(spec: ApiSpec): void {
  const knownNames = new Set<string>();
  for (const m of spec.models) knownNames.add(m.name);
  for (const e of spec.enums) knownNames.add(e.name);

  function walkRef(ref: TypeRef, context: string): void {
    walkTypeRef(ref, {
      model: (r) => {
        if (!knownNames.has(r.name)) {
          console.warn(`[oagen] Warning: Unresolved model reference "${r.name}" (context: ${context})`);
        }
      },
    });
  }

  for (const model of spec.models) {
    for (const field of model.fields) {
      walkRef(field.type, `${model.name}.${field.name}`);
    }
  }

  for (const service of spec.services) {
    for (const op of service.operations) {
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
        walkRef(p.type, `${service.name}.${op.name}.${p.name}`);
      }
      if (op.requestBody) walkRef(op.requestBody, `${service.name}.${op.name}.requestBody`);
      walkRef(op.response, `${service.name}.${op.name}.response`);
    }
  }
}
