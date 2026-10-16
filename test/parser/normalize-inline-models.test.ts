import { describe, it, expect, vi } from 'vitest';
import { collapseJsonSuffixModels, mergeFieldInlineModels } from '../../src/parser/normalize-inline-models.js';
import type { Model, Service } from '../../src/ir/types.js';

describe('collapseJsonSuffixModels', () => {
  it('rewrites model field refs when collapsing Json suffix models', () => {
    const models: Model[] = [
      {
        name: 'Widget',
        fields: [{ name: 'name', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'WidgetJson',
        fields: [
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'version', type: { kind: 'primitive', type: 'number' }, required: true },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'Widgets',
        operations: [
          {
            name: 'getWidget',
            httpMethod: 'get',
            path: '/widgets/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'WidgetJson' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const result = collapseJsonSuffixModels(models, services);

    // WidgetJson should be removed
    expect(result.find((m) => m.name === 'WidgetJson')).toBeUndefined();

    // Widget should have the merged fields
    const widget = result.find((m) => m.name === 'Widget');
    expect(widget).toBeDefined();
    expect(widget!.fields).toHaveLength(2);

    // Service operation ref should be rewritten
    expect(services[0].operations[0].response).toEqual({ kind: 'model', name: 'Widget' });
  });

  it('does not merge when both models have const discriminant fields', () => {
    const models: Model[] = [
      {
        name: 'AuditLogSchema',
        fields: [
          { name: 'object', type: { kind: 'literal', value: 'audit_log_schema_input' }, required: true },
          { name: 'targets', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: true },
        ],
      },
      {
        name: 'AuditLogSchemaJson',
        fields: [
          { name: 'object', type: { kind: 'literal', value: 'audit_log_schema' }, required: true },
          { name: 'version', type: { kind: 'primitive', type: 'number' }, required: true },
          { name: 'targets', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: true },
        ],
      },
    ];

    const services: Service[] = [];

    const result = collapseJsonSuffixModels(models, services);

    // Both models should be preserved — they are distinct entities
    expect(result.find((m) => m.name === 'AuditLogSchema')).toBeDefined();
    expect(result.find((m) => m.name === 'AuditLogSchemaJson')).toBeDefined();
    expect(result).toHaveLength(2);
  });

  it('does not merge when a third model references the Json-suffix model', () => {
    const models: Model[] = [
      {
        name: 'AuditLogSchema',
        fields: [
          { name: 'targets', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: true },
        ],
      },
      {
        name: 'AuditLogSchemaJson',
        fields: [
          { name: 'object', type: { kind: 'literal', value: 'audit_log_schema' }, required: true },
          { name: 'version', type: { kind: 'primitive', type: 'number' }, required: true },
          { name: 'targets', type: { kind: 'array', items: { kind: 'primitive', type: 'string' } }, required: true },
        ],
      },
      {
        name: 'AuditLogAction',
        fields: [
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'schema', type: { kind: 'model', name: 'AuditLogSchemaJson' }, required: true },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'AuditLogs',
        operations: [
          {
            name: 'getSchema',
            httpMethod: 'get',
            path: '/audit-log-schemas/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'model', name: 'AuditLogSchemaJson' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const result = collapseJsonSuffixModels(models, services);

    // AuditLogSchemaJson should be preserved — AuditLogAction references it
    expect(result.find((m) => m.name === 'AuditLogSchemaJson')).toBeDefined();
    expect(result.find((m) => m.name === 'AuditLogSchema')).toBeDefined();
    expect(result.find((m) => m.name === 'AuditLogAction')).toBeDefined();
    expect(result).toHaveLength(3);

    // AuditLogAction.schema ref should still point to AuditLogSchemaJson
    const action = result.find((m) => m.name === 'AuditLogAction');
    const schemaField = action!.fields.find((f) => f.name === 'schema');
    expect(schemaField!.type).toEqual({ kind: 'model', name: 'AuditLogSchemaJson' });

    // Service operation ref should still point to AuditLogSchemaJson
    expect(services[0].operations[0].response).toEqual({ kind: 'model', name: 'AuditLogSchemaJson' });
  });

  it('processes all adjacent Json-suffix models without skipping (splice bug)', () => {
    const models: Model[] = [
      {
        name: 'Alpha',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'AlphaJson',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'extra', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
      {
        name: 'Beta',
        fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
      },
      {
        name: 'BetaJson',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'extra', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];

    const services: Service[] = [];

    const result = collapseJsonSuffixModels(models, services);

    // Both Json models should be merged away
    expect(result.find((m) => m.name === 'AlphaJson')).toBeUndefined();
    expect(result.find((m) => m.name === 'BetaJson')).toBeUndefined();

    // Both base models should have merged fields
    const alpha = result.find((m) => m.name === 'Alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.fields).toHaveLength(2);

    const beta = result.find((m) => m.name === 'Beta');
    expect(beta).toBeDefined();
    expect(beta!.fields).toHaveLength(2);

    expect(result).toHaveLength(2);
  });
});

describe('collapseJsonSuffixModels — pagination envelope fields', () => {
  it('rewrites a list envelope companion ref when its Json-suffix model collapses', () => {
    const models: Model[] = [
      {
        name: 'ListMetadata',
        fields: [{ name: 'after', type: { kind: 'primitive', type: 'string' }, required: false }],
      },
      {
        name: 'ListMetadataJson',
        fields: [
          { name: 'after', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'before', type: { kind: 'primitive', type: 'string' }, required: false },
        ],
      },
    ];

    const services: Service[] = [
      {
        name: 'Widgets',
        operations: [
          {
            name: 'listWidgets',
            httpMethod: 'get',
            path: '/widgets',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'cursor',
              param: 'after',
              dataPath: 'data',
              itemType: { kind: 'primitive', type: 'string' },
              envelopeFields: [
                { name: 'list_metadata', type: { kind: 'model', name: 'ListMetadataJson' }, required: false },
              ],
            },
          },
        ],
      },
    ];

    const result = collapseJsonSuffixModels(models, services);

    expect(result.map((m) => m.name)).toEqual(['ListMetadata']);
    expect(services[0].operations[0].pagination?.envelopeFields?.[0].type).toEqual({
      kind: 'model',
      name: 'ListMetadata',
    });
  });
});

describe('collapseJsonSuffixModels — response headers', () => {
  it('rewrites primary, alternate-success, and error header refs when a Json-suffix model collapses', () => {
    const models: Model[] = [
      { name: 'Meta', fields: [{ name: 'etag', type: { kind: 'primitive', type: 'string' }, required: false }] },
      {
        name: 'MetaJson',
        fields: [
          { name: 'etag', type: { kind: 'primitive', type: 'string' }, required: false },
          { name: 'version', type: { kind: 'primitive', type: 'integer' }, required: false },
        ],
      },
    ];
    // The primary list is shared with its successResponses entry, as the parser builds it.
    const primaryHeaders = [{ name: 'X-Meta', type: { kind: 'model' as const, name: 'MetaJson' }, required: false }];
    const services: Service[] = [
      {
        name: 'Widgets',
        operations: [
          {
            name: 'getWidget',
            httpMethod: 'get',
            path: '/widgets/{id}',
            pathParams: [],
            queryParams: [],
            headerParams: [],
            response: { kind: 'primitive', type: 'string' },
            responseHeaders: primaryHeaders,
            successResponses: [
              { statusCode: 200, type: { kind: 'primitive', type: 'string' }, headers: primaryHeaders },
              {
                statusCode: 202,
                type: { kind: 'primitive', type: 'unknown' },
                headers: [
                  {
                    name: 'X-Meta',
                    type: { kind: 'array', items: { kind: 'model', name: 'MetaJson' } },
                    required: false,
                  },
                ],
              },
            ],
            errors: [
              {
                statusCode: 429,
                headers: [
                  {
                    name: 'X-Meta',
                    type: { kind: 'nullable', inner: { kind: 'model', name: 'MetaJson' } },
                    required: false,
                  },
                ],
              },
            ],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];

    const result = collapseJsonSuffixModels(models, services);

    expect(result.map((m) => m.name)).toEqual(['Meta']);
    const op = services[0].operations[0];
    expect(op.responseHeaders?.[0].type).toEqual({ kind: 'model', name: 'Meta' });
    expect(op.successResponses?.[1].headers?.[0].type).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'Meta' },
    });
    expect(op.errors[0].headers?.[0].type).toEqual({ kind: 'nullable', inner: { kind: 'model', name: 'Meta' } });
  });
});

describe('mergeFieldInlineModels', () => {
  const field = (name: string): Model['fields'][number] => ({
    name,
    type: { kind: 'primitive', type: 'string' },
    required: false,
  });
  const existing: Model[] = [{ name: 'DrawingLayer', fields: [field('name')] }];
  const incoming: Model[] = [{ name: 'DrawingLayer', fields: [field('visible'), field('opacity')] }];

  it('names both inline models when two inline models collide', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(mergeFieldInlineModels(existing, incoming, new Set(['Drawing']))).toEqual(existing);
      expect(warnSpy).toHaveBeenCalledWith(
        '[oagen] Warning: Two inline models are named "DrawingLayer" (fields: name | visible, opacity) — keeping the first, the second is dropped',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still reports a clash with a component schema as such', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(mergeFieldInlineModels(existing, incoming, new Set(['DrawingLayer']))).toEqual(existing);
      expect(warnSpy).toHaveBeenCalledWith(
        '[oagen] Warning: Inline model "DrawingLayer" has different fields than component schema — using component schema',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps the component-schema wording when no component names are given', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(mergeFieldInlineModels(existing, incoming)).toEqual(existing);
      expect(warnSpy).toHaveBeenCalledWith(
        '[oagen] Warning: Inline model "DrawingLayer" has different fields than component schema — using component schema',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
