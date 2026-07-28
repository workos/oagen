import type { ApiSpec, Model, TypeRef } from '../ir/types.js';

/**
 * Which side of the wire a model sits on, from the caller's point of view.
 *
 * Requiredness only binds callers on the request side — they must construct
 * every required request field, but they only ever *read* responses. The differ
 * needs that distinction before it can call a newly-required field breaking.
 */
export type ModelDirection = 'request' | 'response' | 'both' | 'unknown';

export type DirectionIndex = ReadonlyMap<string, ModelDirection>;

/**
 * Classify every model in `specs` as request-facing, response-facing, both, or
 * unknown.
 *
 * Pass both the baseline and the candidate spec: a model that was request-facing
 * in either one keeps its request direction for the whole diff, so a schema that
 * moves request → response mid-release doesn't get that release's requiredness
 * changes silently downgraded.
 *
 * Models reachable from neither side (unreferenced schemas, or a spec whose
 * operations weren't supplied) stay `unknown`, which preserves the conservative
 * pre-direction classification.
 */
export function buildDirectionIndex(...specs: ApiSpec[]): DirectionIndex {
  const models = new Map<string, Model>();
  for (const spec of specs) {
    for (const model of spec.models) if (!models.has(model.name)) models.set(model.name, model);
  }

  const requestSeeds: TypeRef[] = [];
  const responseSeeds: TypeRef[] = [];

  for (const spec of specs) {
    for (const service of spec.services) {
      for (const op of service.operations) {
        if (op.requestBody) requestSeeds.push(op.requestBody);
        // Parameters are caller-supplied too, so a model reached through one is
        // request-facing even when the operation has no body.
        for (const param of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
          requestSeeds.push(param.type);
        }
        responseSeeds.push(op.response);
        for (const success of op.successResponses ?? []) responseSeeds.push(success.type);
        for (const error of op.errors) if (error.type) responseSeeds.push(error.type);
      }
    }
  }

  const request = reachableModels(requestSeeds, models);
  const response = reachableModels(responseSeeds, models);

  const index = new Map<string, ModelDirection>();
  for (const name of models.keys()) {
    const inRequest = request.has(name);
    const inResponse = response.has(name);
    index.set(name, inRequest && inResponse ? 'both' : inRequest ? 'request' : inResponse ? 'response' : 'unknown');
  }
  return index;
}

export function directionOf(index: DirectionIndex | undefined, modelName: string): ModelDirection {
  return index?.get(modelName) ?? 'unknown';
}

/**
 * Every model name reachable from `seeds`, following model fields (and
 * discriminated-union variants) transitively.
 */
function reachableModels(seeds: TypeRef[], models: ReadonlyMap<string, Model>): Set<string> {
  const found = new Set<string>();
  const queue = [...seeds];

  while (queue.length > 0) {
    const ref = queue.pop()!;
    switch (ref.kind) {
      case 'model': {
        if (found.has(ref.name)) break;
        found.add(ref.name);
        const model = models.get(ref.name);
        if (!model) break;
        for (const field of model.fields) queue.push(field.type);
        // A dispatcher model reaches its variants by name, not by field type.
        for (const variant of Object.values(model.discriminator?.mapping ?? {})) {
          queue.push({ kind: 'model', name: variant });
        }
        break;
      }
      case 'array':
        queue.push(ref.items);
        break;
      case 'nullable':
        queue.push(ref.inner);
        break;
      case 'map':
        queue.push(ref.valueType);
        break;
      case 'union':
        queue.push(...ref.variants);
        break;
      case 'primitive':
      case 'enum':
      case 'literal':
        break;
    }
  }

  return found;
}
