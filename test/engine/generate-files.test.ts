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

describe('collectReferencedNames — pagination envelope fields', () => {
  it('reaches models and enums referenced only by a list envelope companion', () => {
    const services: Service[] = [
      {
        name: 'Customers',
        operations: [
          {
            name: 'listCustomers',
            httpMethod: 'get',
            path: '/customers',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'array', items: { kind: 'model', name: 'Customer' } },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'offset',
              param: 'page',
              limitParam: 'limit',
              dataPath: 'customers',
              itemType: { kind: 'model', name: 'Customer' },
              envelopeFields: [
                { name: 'pagination', type: { kind: 'model', name: 'Pagination' }, required: true },
                { name: 'sort', type: { kind: 'enum', name: 'SortOrder' }, required: false },
              ],
            },
          },
        ],
      },
    ];
    const models: Model[] = [
      { name: 'Customer', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      {
        name: 'Pagination',
        fields: [{ name: 'links', type: { kind: 'model', name: 'PaginationLinks' }, required: false }],
      },
      {
        name: 'PaginationLinks',
        fields: [{ name: 'next', type: { kind: 'primitive', type: 'string' }, required: false }],
      },
      { name: 'Unrelated', fields: [] },
    ];

    const referenced = collectReferencedNames(services, models);

    expect(referenced.models.has('Pagination')).toBe(true);
    // Chased transitively through the companion's own fields.
    expect(referenced.models.has('PaginationLinks')).toBe(true);
    expect(referenced.enums.has('SortOrder')).toBe(true);
    expect(referenced.models.has('Unrelated')).toBe(false);
  });
});

describe('collectReferencedNames — response headers', () => {
  it('reaches models and enums referenced only by a response header', () => {
    const services: Service[] = [
      {
        name: 'Documents',
        operations: [
          {
            name: 'downloadDocument',
            httpMethod: 'get',
            path: '/documents/{id}/download',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'string', format: 'binary' },
            responseHeaders: [
              { name: 'X-Meta', type: { kind: 'model', name: 'DownloadMeta' }, required: false },
              { name: 'X-Policy', type: { kind: 'enum', name: 'RateLimitPolicy' }, required: false },
            ],
            errors: [
              {
                statusCode: 429,
                headers: [{ name: 'X-Throttle', type: { kind: 'model', name: 'ThrottleInfo' }, required: false }],
              },
            ],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const models: Model[] = [
      {
        name: 'DownloadMeta',
        fields: [{ name: 'origin', type: { kind: 'model', name: 'Origin' }, required: false }],
      },
      { name: 'Origin', fields: [] },
      { name: 'ThrottleInfo', fields: [] },
      { name: 'Unrelated', fields: [] },
    ];

    const referenced = collectReferencedNames(services, models);

    // A model reached only through a header is emitted like a body model.
    expect(referenced.models.has('DownloadMeta')).toBe(true);
    // Chased transitively through the header model's own fields.
    expect(referenced.models.has('Origin')).toBe(true);
    expect(referenced.models.has('ThrottleInfo')).toBe(true);
    expect(referenced.enums.has('RateLimitPolicy')).toBe(true);
    expect(referenced.models.has('Unrelated')).toBe(false);
  });
});
