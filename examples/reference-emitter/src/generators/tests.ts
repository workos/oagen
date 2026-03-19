import type { ApiSpec, GeneratedFile, EmitterContext } from '@workos/oagen';

export function generateTests(_spec: ApiSpec, _ctx: EmitterContext): GeneratedFile[] {
  // Production emitters generate per-resource test stubs.
  // This reference emitter returns an empty array to keep things minimal.
  return [];
}
