import { describe, it, expect } from 'vitest';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
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
