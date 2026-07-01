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

describe('buildEmitterContext scopedModelNames (selected-only, minimal scope)', () => {
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

  it('scopes models to the SELECTED service only — an on-disk (present) service’s models are left untouched', () => {
    const ctx = build(new Set([canonicalServiceKey('Radar')]));
    expect(ctx.scopedModelNames?.has('PipeModel')).toBe(true); // selected → regenerated
    // Minimal scope: Radar is present on disk but NOT selected, so its model
    // file is left byte-for-byte alone (the emitters correspondingly skip its
    // fixtures + the wholesale round-trip test in a scoped run). This is the
    // deliberate revert of the surface-wide "expand" behaviour.
    expect(ctx.scopedModelNames?.has('RadarModel')).toBe(false); // present but not selected
  });

  it('a never-generated service’s models stay excluded regardless (not selected, not present)', () => {
    const ctx = build(new Set());
    expect(ctx.scopedModelNames?.has('PipeModel')).toBe(true);
    expect(ctx.scopedModelNames?.has('RadarModel')).toBe(false);
  });

  it('scopes reachability to the selected OPERATIONS, not the whole source service (per-op mountOn)', () => {
    // One source service whose two operations mount to different targets via
    // per-op hints. Scoping to one target must pull in ONLY that operation's
    // models — not the sibling operation's (mounted elsewhere).
    const split: ApiSpec = {
      name: 'T',
      version: '1.0.0',
      baseUrl: '',
      services: [svc('Multi', [opTo('a', '/alpha', 'AlphaModel'), opTo('b', '/beta', 'BetaModel')])],
      models: [
        { name: 'AlphaModel', fields: [] },
        { name: 'BetaModel', fields: [] },
      ],
      enums: [],
      sdk: defaultSdkBehavior(),
    };
    const ctx = buildEmitterContext(split, {
      namespace: 'workos',
      outputDir: '/tmp/x',
      scopedServices: new Set(['Alpha']),
      operationHints: { 'GET /alpha': { mountOn: 'Alpha' }, 'GET /beta': { mountOn: 'Beta' } },
    });
    expect(ctx.scopedModelNames?.has('AlphaModel')).toBe(true); // selected op's model
    expect(ctx.scopedModelNames?.has('BetaModel')).toBe(false); // sibling op mounts to Beta — excluded
  });
});

function svc(name: string, operations: Service['operations']): Service {
  return { name, operations };
}
