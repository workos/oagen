import { describe, expect, it } from 'vitest';
import { buildEmitterContext, collectReferencedNames } from '../../src/engine/generate-files.js';
import { canonicalServiceKey } from '../../src/engine/scoped-services.js';
import type { ApiSpec, Model, Service } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

describe('collectReferencedNames', () => {
  it('preserves discriminated models even when they are not directly referenced by operations', () => {
    const services: Service[] = [
      {
        name: 'Events',
        operations: [
          {
            name: 'listEvents',
            httpMethod: 'get',
            path: '/events',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'array', items: { kind: 'model', name: 'EventSchema' } },
            errors: [],
            injectIdempotencyKey: false,
            pagination: undefined,
          },
        ],
      },
    ];

    const models: Model[] = [
      {
        name: 'EventSchema',
        fields: [
          { name: 'event', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'data', type: { kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } }, required: true },
        ],
      },
      {
        name: 'SessionCreated',
        fields: [
          { name: 'event', type: { kind: 'literal', value: 'session.created' }, required: true },
          { name: 'data', type: { kind: 'model', name: 'SessionCreatedData' }, required: true },
        ],
      },
      {
        name: 'SessionCreatedData',
        fields: [
          { name: 'object', type: { kind: 'literal', value: 'session' }, required: true },
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        ],
      },
    ];

    const referenced = collectReferencedNames(services, models);

    expect(referenced.models.has('EventSchema')).toBe(true);
    expect(referenced.models.has('SessionCreated')).toBe(true);
    expect(referenced.models.has('SessionCreatedData')).toBe(true);
  });
});

describe('buildEmitterContext scopedModelNames (surface, not selection-only)', () => {
  const opTo = (name: string, path: string, model: string) => ({
    name,
    httpMethod: 'get' as const,
    path,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'model' as const, name: model },
    errors: [],
    injectIdempotencyKey: false,
  });
  const spec: ApiSpec = {
    name: 'T',
    version: '1.0.0',
    baseUrl: '',
    services: [
      svc('Pipes', [opTo('getPipe', '/pipes', 'PipeModel')]),
      svc('Radar', [opTo('assess', '/radar', 'RadarModel')]),
    ],
    models: [
      { name: 'PipeModel', fields: [] },
      { name: 'RadarModel', fields: [] },
    ],
    enums: [],
    sdk: defaultSdkBehavior(),
  };
  const build = (present: Set<string>) =>
    buildEmitterContext(spec, {
      namespace: 'workos',
      outputDir: '/tmp/x',
      scopedServices: new Set(['Pipes']),
      presentServiceKeys: present,
    });

  it('includes an already-on-disk (present) service’s models, so they regenerate with their fixtures/tests', () => {
    const ctx = build(new Set([canonicalServiceKey('Radar')]));
    expect(ctx.scopedModelNames?.has('PipeModel')).toBe(true); // selected
    // Regressed before the fix: gated to selection-only, so Radar's model file
    // wasn't rewritten while its fixture + round-trip test asserted new fields.
    expect(ctx.scopedModelNames?.has('RadarModel')).toBe(true); // present-on-disk
  });

  it('still excludes a never-generated service’s models (not selected, not present) — no orphan', () => {
    const ctx = build(new Set());
    expect(ctx.scopedModelNames?.has('PipeModel')).toBe(true);
    expect(ctx.scopedModelNames?.has('RadarModel')).toBe(false);
  });
});

function svc(name: string, operations: Service['operations']): Service {
  return { name, operations };
}
