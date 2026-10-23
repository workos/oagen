import { describe, it, expect, vi } from 'vitest';
import {
  collapseJsonSuffixModels,
  fieldInlineModelBundles,
  mergeFieldInlineModels,
  mergeInlineResponseModels,
  reservedNamesByKind,
  reservedTypeNames,
  settleFieldInlineModels,
  type InlineModelNaming,
} from '../../src/parser/normalize-inline-models.js';
import {
  recordLiftedFieldModel,
  resetInheritedModelRefs,
  type InlineModelBundle,
} from '../../src/parser/inline-models.js';
import { collectModelRefs } from '../../src/ir/types.js';
import type { Model, Operation, Service, TypeRef } from '../../src/ir/types.js';

describe('collapseJsonSuffixModels — response content types', () => {
  it('rewrites primary, alternate-success, and error content refs when a Json-suffix model collapses', () => {
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
    const primaryType = { kind: 'primitive' as const, type: 'string' as const };
    const primaryContents = [
      { contentType: 'text/plain', type: primaryType },
      { contentType: 'application/vnd.meta+json', type: { kind: 'model' as const, name: 'MetaJson' } },
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
            response: primaryType,
            responseContentTypes: ['text/plain', 'application/vnd.meta+json'],
            responseContents: primaryContents,
            successResponses: [
              {
                statusCode: 200,
                type: primaryType,
                contentTypes: ['text/plain', 'application/vnd.meta+json'],
                contents: primaryContents,
              },
              {
                statusCode: 202,
                type: { kind: 'primitive', type: 'unknown' },
                contentTypes: ['application/vnd.meta+json'],
                contents: [
                  {
                    contentType: 'application/vnd.meta+json',
                    type: { kind: 'array', items: { kind: 'model', name: 'MetaJson' } },
                  },
                ],
              },
            ],
            errors: [
              {
                statusCode: 429,
                contentTypes: ['application/problem+json'],
                contents: [
                  {
                    contentType: 'application/problem+json',
                    type: { kind: 'nullable', inner: { kind: 'model', name: 'MetaJson' } },
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
    expect(op.responseContents?.[1].type).toEqual({ kind: 'model', name: 'Meta' });
    expect(op.successResponses?.[1].contents?.[0].type).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'Meta' },
    });
    expect(op.errors[0].contents?.[0].type).toEqual({ kind: 'nullable', inner: { kind: 'model', name: 'Meta' } });
  });
});

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

  it('rewrites the iterator item type when its Json-suffix model collapses (Greptile)', () => {
    // Under `x-pagination: { dataPath }` the body stays a wrapper and the
    // item type is a reference nothing else in the IR holds.
    const models: Model[] = [
      { name: 'Wrapper', fields: [{ name: 'total', type: { kind: 'primitive', type: 'integer' }, required: false }] },
      { name: 'Item', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      {
        name: 'ItemJson',
        fields: [
          { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
          { name: 'name', type: { kind: 'primitive', type: 'string' }, required: false },
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
            response: { kind: 'model', name: 'Wrapper' },
            errors: [],
            injectIdempotencyKey: false,
            pagination: {
              strategy: 'page',
              param: 'page',
              dataPath: 'records',
              itemType: { kind: 'nullable', inner: { kind: 'model', name: 'ItemJson' } },
            },
          },
        ],
      },
    ];

    const result = collapseJsonSuffixModels(models, services);

    expect(result.map((m) => m.name)).toEqual(['Wrapper', 'Item']);
    expect(services[0].operations[0].pagination?.itemType).toEqual({
      kind: 'nullable',
      inner: { kind: 'model', name: 'Item' },
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

  it('rewrites default and range response body and header refs when a Json-suffix model collapses', () => {
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
            errors: [],
            defaultResponse: {
              type: { kind: 'model', name: 'MetaJson' },
              headers: [{ name: 'X-Meta', type: { kind: 'model', name: 'MetaJson' }, required: false }],
            },
            rangeResponses: [
              { range: '5XX', type: { kind: 'array', items: { kind: 'model', name: 'MetaJson' } } },
              {
                range: '4XX',
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
    expect(op.defaultResponse?.type).toEqual({ kind: 'model', name: 'Meta' });
    expect(op.defaultResponse?.headers?.[0].type).toEqual({ kind: 'model', name: 'Meta' });
    expect(op.rangeResponses?.[0].type).toEqual({ kind: 'array', items: { kind: 'model', name: 'Meta' } });
    expect(op.rangeResponses?.[1].headers?.[0].type).toEqual({
      kind: 'nullable',
      inner: { kind: 'model', name: 'Meta' },
    });
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
        '[oagen] Warning: Inline model "DrawingLayer" has a different shape than component schema "DrawingLayer" and has no site to be renamed from — using the component schema',
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
        '[oagen] Warning: Inline model "DrawingLayer" has a different shape than component schema "DrawingLayer" and has no site to be renamed from — using the component schema',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('a name one of the document’s enums holds (issue #303)', () => {
  const str: TypeRef = { kind: 'primitive', type: 'string' };
  const body = (name: string, field = 'a', deprecated = false): Model => ({
    name,
    fields: [{ name: field, type: str, required: false }],
    ...(deprecated ? { deprecated: true } : {}),
  });
  /** Run `fn`, returning every warning it printed instead of printing it. */
  const warnings = (fn: () => void): string[] => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fn();
      return warnSpy.mock.calls.map(([m]) => String(m));
    } finally {
      warnSpy.mockRestore();
    }
  };

  it('renames every copy off the name through its site, live or deprecated, and repoints the site’s references', () => {
    const live = body('GetPetResponse');
    const old = body('GetPetResponse', 'a', true);
    const liveRef: TypeRef = { kind: 'model', name: 'GetPetResponse' };
    const oldRef: TypeRef = { kind: 'model', name: 'GetPetResponse' };
    let merged: Model[] = [];
    const notes = warnings(() => {
      merged = mergeInlineResponseModels([], [live, old], {
        bundles: [
          { qualifier: 'GetPet', roots: [liveRef], models: [live] },
          { qualifier: 'GetLegacyPet', roots: [oldRef], models: [old] },
        ],
        reserved: new Set(['GetPetResponse', 'GetPetResponse2']),
        enums: new Set(['GetPetResponse']),
      });
    });
    expect(merged.map((m) => m.name)).toEqual(['GetPetResponse3', 'GetLegacyPetGetPetResponse']);
    expect(liveRef).toEqual({ kind: 'model', name: 'GetPetResponse3' });
    expect(oldRef).toEqual({ kind: 'model', name: 'GetLegacyPetGetPetResponse' });
    expect(notes).toEqual([
      '[oagen] Renamed inline model "GetPetResponse" → "GetPetResponse3": enum "GetPetResponse" owns the name',
      '[oagen] Renamed inline model "GetPetResponse" → "GetLegacyPetGetPetResponse": enum "GetPetResponse" owns the name',
    ]);
  });

  it('keeps a copy with no site under the shared name, with a warning', () => {
    const copy = body('GetPetResponse');
    let merged: Model[] = [];
    const notes = warnings(() => {
      merged = mergeInlineResponseModels([], [copy], {
        bundles: [],
        reserved: new Set(['GetPetResponse']),
        enums: new Set(['GetPetResponse']),
      });
    });
    expect(merged.map((m) => m.name)).toEqual(['GetPetResponse']);
    expect(notes).toEqual([
      '[oagen] Warning: Inline model "GetPetResponse" is named like enum "GetPetResponse" and has no site to be renamed from — keeping both under the shared name',
    ]);
  });

  it('leaves a name a component model owns to the model rule: admitted copies fold, others take the component-schema note', () => {
    const owner = body('GetPetResponse');
    const admitted = body('GetPetResponse');
    const other = body('GetPetResponse', 'b');
    const otherRef: TypeRef = { kind: 'model', name: 'GetPetResponse' };
    let merged: Model[] = [];
    const notes = warnings(() => {
      merged = mergeInlineResponseModels([owner], [admitted, other], {
        bundles: [{ qualifier: 'GetPet', roots: [otherRef], models: [other] }],
        reserved: new Set(['GetPetResponse']),
        enums: new Set(['GetPetResponse']),
      });
    });
    expect(merged.map((m) => m.name)).toEqual(['GetPetResponse', 'GetPetResponse2']);
    expect(otherRef).toEqual({ kind: 'model', name: 'GetPetResponse2' });
    expect(notes).toEqual([
      '[oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": its shape differs from component schema "GetPetResponse"',
    ]);
  });

  it('applies in the field pass too (`PetOwner2`)', () => {
    const field = body('PetOwner', 'name');
    const ref: TypeRef = { kind: 'model', name: 'PetOwner' };
    let merged: Model[] = [];
    const notes = warnings(() => {
      merged = mergeFieldInlineModels([], [field], new Set(), {
        bundles: [{ qualifier: 'Pet', roots: [ref], models: [field] }],
        reserved: new Set(['PetOwner']),
        enums: new Set(['PetOwner']),
      });
    });
    expect(merged.map((m) => m.name)).toEqual(['PetOwner2']);
    expect(ref).toEqual({ kind: 'model', name: 'PetOwner2' });
    expect(notes).toEqual(['[oagen] Renamed inline model "PetOwner" → "PetOwner2": enum "PetOwner" owns the name']);
  });

  it('settles the parser’s field models past an enum name when they are settled against the components', () => {
    // The parser's own path: the components' field models are settled
    // before any operation is read (`settleFieldInlineModels`), so a
    // `Pet.owner` object beside a component enum `PetOwner` is `PetOwner2`
    // from then on, and `Pet.owner` already points at it.
    const owner = body('PetOwner', 'name');
    const pet: Model = {
      name: 'Pet',
      fields: [{ name: 'owner', type: { kind: 'model', name: 'PetOwner' }, required: false }],
    };
    let settled: Model[] = [];
    const notes = warnings(() => {
      settled = settleFieldInlineModels([pet], [owner], {
        bundles: [{ qualifier: 'Pet', roots: [pet.fields[0].type], models: [owner] }],
        reserved: new Set(['Pet', 'PetOwner']),
        enums: new Set(['PetOwner']),
      });
    });
    expect(settled.map((m) => m.name)).toEqual(['PetOwner2']);
    expect(pet.fields[0].type).toEqual({ kind: 'model', name: 'PetOwner2' });
    expect(notes).toEqual(['[oagen] Renamed inline model "PetOwner" → "PetOwner2": enum "PetOwner" owns the name']);
  });

  it('shares one model between identical copies that leave an enum’s name, as under a component (review: #355)', () => {
    // Two sites minted the same `GetPetResponse` shape; the first is renamed
    // through its site, the second repointed to that name and folded onto
    // the first, so one model survives — exactly as two identical copies of
    // a component's name of another shape share `GetPetResponse2`.
    const first = body('GetPetResponse');
    const second = body('GetPetResponse');
    const other = body('GetPetResponse', 'b');
    const refs: TypeRef[] = [
      { kind: 'model', name: 'GetPetResponse' },
      { kind: 'model', name: 'GetPetResponse' },
      { kind: 'model', name: 'GetPetResponse' },
    ];
    let merged: Model[] = [];
    const notes = warnings(() => {
      merged = mergeInlineResponseModels([], [first, second, other], {
        bundles: [
          { qualifier: 'GetPet', roots: [refs[0]], models: [first] },
          { qualifier: 'GetPet', roots: [refs[1]], models: [second] },
          { qualifier: 'GetPet', roots: [refs[2]], models: [other] },
        ],
        reserved: new Set(['GetPetResponse']),
        enums: new Set(['GetPetResponse']),
      });
    });
    expect(merged).toEqual([first, other]);
    expect(merged.map((m) => m.name)).toEqual(['GetPetResponse2', 'GetPetResponse3']);
    expect(refs.map((ref) => (ref as { name: string }).name)).toEqual([
      'GetPetResponse2',
      'GetPetResponse2',
      'GetPetResponse3',
    ]);
    expect(notes).toEqual([
      '[oagen] Renamed inline model "GetPetResponse" → "GetPetResponse2": enum "GetPetResponse" owns the name (shared by 2 sites)',
      '[oagen] Renamed inline model "GetPetResponse" → "GetPetResponse3": enum "GetPetResponse" owns the name',
    ]);
  });

  it('tells the enum names in play apart from every reserved name (`reservedNamesByKind`)', () => {
    const pet: Model = {
      name: 'Pet',
      fields: [{ name: 'kind', type: { kind: 'enum', name: 'PetKind', values: ['cat', 'dog'] }, required: false }],
    };
    const services: Service[] = [
      {
        name: 'Pets',
        operations: [
          {
            name: 'listPets',
            httpMethod: 'get',
            path: '/pets',
            pathParams: [],
            queryParams: [
              { name: 'mood', type: { kind: 'enum', name: 'PetsMood', values: ['happy'] }, required: false },
            ],
            headerParams: [],
            response: { kind: 'model', name: 'ListPetsResponse' },
            errors: [],
            injectIdempotencyKey: false,
          },
        ],
      },
    ];
    const names = reservedNamesByKind(
      [pet],
      [{ name: 'Color', values: [{ name: 'Red', value: 'red' }] }],
      [{ name: 'ListPetsResponse', fields: [] }],
      [],
      services,
    );
    expect([...names.enums].sort()).toEqual(['Color', 'PetKind', 'PetsMood']);
    expect([...names.all].sort()).toEqual(['Color', 'ListPetsResponse', 'Pet', 'PetKind', 'PetsMood']);
    expect(
      reservedTypeNames(
        [pet],
        [{ name: 'Color', values: [{ name: 'Red', value: 'red' }] }],
        [{ name: 'ListPetsResponse', fields: [] }],
        [],
        services,
      ),
    ).toEqual(names.all);
  });

  it('keeps the object the schema pass lifted from a field in that field’s site, with the references that shared it', () => {
    // The schema pass lifted `PetStatus` from `Pet.status` itself
    // (`recordLiftedFieldModel`); the field extractor's copy folds onto it
    // when the fields are settled, and a `Status` header shared it in the
    // registry (`sharedRefs`). The field's site holds the lifted object from
    // the start and, at the merges, the header's reference too, so renaming
    // it past a `status` query enum of the name repoints the field and the
    // header.
    resetInheritedModelRefs();
    try {
      const lifted = body('PetStatus', 'code');
      const copy = body('PetStatus', 'code');
      const pet: Model = {
        name: 'Pet',
        fields: [{ name: 'status', type: { kind: 'model', name: 'PetStatus' }, required: false }],
      };
      const headerRef: TypeRef = { kind: 'model', name: 'PetStatus' };
      const groups = [{ parentName: 'Pet', fieldName: 'status', models: [copy] }];
      recordLiftedFieldModel('Pet', 'status', lifted);
      expect(fieldInlineModelBundles(groups, [pet, lifted])[0].models).toEqual([copy, lifted]);
      const settled = settleFieldInlineModels([pet, lifted], [copy], {
        bundles: fieldInlineModelBundles(groups, [pet, lifted]),
        reserved: new Set(['Pet', 'PetStatus']),
        enums: new Set(),
      });
      expect(settled).toEqual([]);

      const bundles = fieldInlineModelBundles(groups, [pet, lifted], {
        sharedRefs: new Map([[lifted, [headerRef]]]),
      });
      expect(bundles[0].models).toEqual([copy, lifted]);
      expect(bundles[0].roots).toContain(headerRef);

      let merged: Model[] = [];
      const notes = warnings(() => {
        merged = mergeFieldInlineModels([pet, lifted], settled, new Set(['Pet']), {
          bundles,
          reserved: new Set(['Pet', 'PetStatus']),
          enums: new Set(['PetStatus']),
        });
      });
      expect(merged.map((m) => m.name)).toEqual(['Pet', 'PetStatus2']);
      expect(pet.fields[0].type).toEqual({ kind: 'model', name: 'PetStatus2' });
      expect(headerRef).toEqual({ kind: 'model', name: 'PetStatus2' });
      expect(notes).toEqual([
        '[oagen] Renamed inline model "PetStatus" → "PetStatus2": enum "PetStatus" owns the name',
      ]);
    } finally {
      resetInheritedModelRefs();
    }
  });
});

describe('a parent that references a renamed model leaves a shared name by its site (issue #313)', () => {
  const str: TypeRef = { kind: 'primitive', type: 'string' };
  const field = (name: string, type: TypeRef = str, deprecated = false): Model['fields'][number] => ({
    name,
    type,
    required: false,
    ...(deprecated ? { deprecated: true } : {}),
  });
  const modelRef = (name: string): TypeRef => ({ kind: 'model', name });
  const owner = (name: string, extra = false, deprecated = false): Model => ({
    name,
    fields: [field('city'), ...(extra ? [field('zip')] : [])],
    ...(deprecated ? { deprecated: true } : {}),
  });
  /** Every model name a model references, through its fields and variants. */
  const referencedBy = (model: Model): string[] =>
    [...model.fields.map((f) => f.type), ...(model.variants ?? [])].flatMap(collectModelRefs);

  /**
   * Run `merge` over `components` and `inline` with `naming`, returning the
   * merged models and every warning, and hold the pass to the invariant the
   * `…Json` fold's tests hold it to: afterwards every reference — a bundle
   * root's or a model's — names a kept model, every kept model a root or a
   * model referenced before the pass is still referenced, and no two kept
   * models share a name.
   */
  function settle(
    merge: (components: Model[], inline: Model[], naming: InlineModelNaming) => Model[],
    components: Model[],
    inline: Model[],
    naming: InlineModelNaming,
  ): { merged: Model[]; warnings: string[] } {
    const roots = naming.bundles.flatMap((b) => b.roots);
    const referencedBefore = new Set([
      ...roots.flatMap(collectModelRefs),
      ...[...components, ...inline].flatMap(referencedBy),
    ]);
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    let merged: Model[];
    try {
      merged = merge(components, inline, naming);
    } finally {
      warnSpy.mockRestore();
    }
    const names = new Set(merged.map((m) => m.name));
    const referencedAfter = new Set([...roots.flatMap(collectModelRefs), ...merged.flatMap(referencedBy)]);
    expect(
      [...referencedAfter].filter((name) => !names.has(name)),
      'dangling references',
    ).toEqual([]);
    expect(
      merged.map((m) => m.name).filter((name) => referencedBefore.has(name) && !referencedAfter.has(name)),
      'models left unreferenced',
    ).toEqual([]);
    expect(names.size, 'duplicate names').toBe(merged.length);
    return { merged, warnings };
  }

  it('qualifies the twin whose deprecated child was renamed, in one pass, and leaves the other under the name', () => {
    // `getA` and `getB` both mint `Widget { owner: WidgetOwner }`; `getB`'s
    // `WidgetOwner` is deprecated with a field more, so it is renamed first
    // (bottom-up) and `getB`'s `Widget` references it.
    const aOwner = owner('WidgetOwner');
    const bOwner = owner('WidgetOwner', true, true);
    const aWidget: Model = { name: 'Widget', fields: [field('owner', modelRef('WidgetOwner'))] };
    const bWidget: Model = { name: 'Widget', fields: [field('owner', modelRef('WidgetOwner'), true)] };
    const aRef = modelRef('Widget');
    const bRef = modelRef('Widget');
    const { merged, warnings } = settle(mergeInlineResponseModels, [], [aWidget, aOwner, bWidget, bOwner], {
      bundles: [
        { qualifier: 'GetA', roots: [aRef], models: [aWidget, aOwner] },
        { qualifier: 'GetB', roots: [bRef], models: [bWidget, bOwner] },
      ],
      reserved: new Set(['Widget', 'WidgetOwner']),
      enums: new Set(),
    });
    expect(merged.map((m) => [m.name, referencedBy(m)])).toEqual([
      ['Widget', ['WidgetOwner']],
      ['WidgetOwner', []],
      ['GetBWidget', ['GetBWidgetOwner']],
      ['GetBWidgetOwner', []],
    ]);
    expect(aRef).toEqual(modelRef('Widget'));
    expect(bRef).toEqual(modelRef('GetBWidget'));
    expect(warnings).toEqual([
      '[oagen] Renamed inline model "WidgetOwner" → "GetBWidgetOwner": it is deprecated while "WidgetOwner" is live',
      '[oagen] Renamed inline model "Widget" → "GetBWidget": it references a renamed model and "Widget" keeps another definition',
    ]);
  });

  it('reads the names an earlier pass minted from `naming.minted`, so the field merge qualifies the parent instead of dropping it', () => {
    // The response pass left `PetWidgetOwner { object }`; the field pass
    // brings `PetWidgetOwner { object, address: PetWidgetOwnerAddress2 }`,
    // whose address was renamed when the fields were settled. Without the
    // minted name the field copy is dropped for the survivor ("Two inline
    // models are named …") and the address left referenced by nothing.
    const response: Model = { name: 'PetWidgetOwner', fields: [field('object')] };
    const address: Model = { name: 'PetWidgetOwnerAddress2', fields: [field('city')] };
    const fieldCopy: Model = {
      name: 'PetWidgetOwner',
      fields: [field('object'), field('address', modelRef('PetWidgetOwnerAddress2'))],
    };
    const responseRef = modelRef('PetWidgetOwner');
    const fieldRef = modelRef('PetWidgetOwner');
    const minted = new Set(['PetWidgetOwnerAddress2']);
    const { merged, warnings } = settle(
      (components, inline, naming) => mergeFieldInlineModels([...components, response], inline, new Set(), naming),
      [],
      [fieldCopy, address],
      {
        bundles: [
          { qualifier: 'GetOwner', roots: [responseRef], models: [response] },
          { qualifier: 'PetWidget', roots: [fieldRef], models: [fieldCopy, address] },
        ],
        reserved: new Set(['PetWidgetOwner', 'PetWidgetOwnerAddress2']),
        enums: new Set(),
        minted,
      },
    );
    expect(merged.map((m) => [m.name, referencedBy(m)])).toEqual([
      ['PetWidgetOwner', []],
      ['PetWidgetOwner2', ['PetWidgetOwnerAddress2']],
      ['PetWidgetOwnerAddress2', []],
    ]);
    expect(responseRef).toEqual(modelRef('PetWidgetOwner'));
    expect(fieldRef).toEqual(modelRef('PetWidgetOwner2'));
    expect(minted).toEqual(new Set(['PetWidgetOwnerAddress2', 'PetWidgetOwner2']));
    expect(warnings).toEqual([
      '[oagen] Renamed inline model "PetWidgetOwner" → "PetWidgetOwner2": it references a renamed model and "PetWidgetOwner" keeps another definition',
    ]);
  });

  it('settles same-named models that follow no rename as before, and a group of one is left alone', () => {
    const aOwner = owner('WidgetOwner');
    const bOwner = owner('WidgetOwner');
    const aWidget: Model = { name: 'Widget', fields: [field('owner', modelRef('WidgetOwner'))] };
    const bWidget: Model = { name: 'Widget', fields: [field('owner', modelRef('WidgetOwner')), field('extra')] };
    const aRef = modelRef('Widget');
    const bRef = modelRef('Widget');
    const { merged, warnings } = settle(mergeInlineResponseModels, [], [aWidget, aOwner, bWidget, bOwner], {
      bundles: [
        { qualifier: 'GetA', roots: [aRef], models: [aWidget, aOwner] },
        { qualifier: 'GetB', roots: [bRef], models: [bWidget, bOwner] },
      ],
      reserved: new Set(['Widget', 'WidgetOwner']),
      enums: new Set(),
    });
    // The pass's own choice, as always: the definition with more fields.
    expect(merged.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
      ['Widget', ['owner', 'extra']],
      ['WidgetOwner', ['city']],
    ]);
    expect([aRef, bRef]).toEqual([modelRef('Widget'), modelRef('Widget')]);
    expect(warnings).toEqual([
      '[oagen] Warning: Inline model "Widget" has more than one definition with different fields or field types (2 vs 1) — keeping the one with more fields',
    ]);
  });

  it('keeps the leader of a cluster under its minted name when a later pass reads it, so the sites repointed to it stay resolved', () => {
    // `GetAWidget` was minted by an earlier pass for two identical copies;
    // `getB` references it through the leader's name, not its own site.
    const leader: Model = { name: 'GetAWidget', fields: [field('owner', modelRef('GetAWidgetOwner'))] };
    const child: Model = { name: 'GetAWidgetOwner', fields: [field('city'), field('zip')] };
    const aRef = modelRef('GetAWidget');
    const bRef = modelRef('GetAWidget');
    const { merged, warnings } = settle(
      (components, inline, naming) => mergeFieldInlineModels([...components, leader, child], inline, new Set(), naming),
      [],
      [],
      {
        bundles: [
          { qualifier: 'GetA', roots: [aRef], models: [leader, child] },
          { qualifier: 'GetB', roots: [bRef], models: [] },
        ],
        reserved: new Set(['GetAWidget', 'GetAWidgetOwner']),
        enums: new Set(),
        minted: new Set(['GetAWidget', 'GetAWidgetOwner']),
      },
    );
    expect(merged.map((m) => m.name)).toEqual(['GetAWidget', 'GetAWidgetOwner']);
    expect([aRef, bRef]).toEqual([modelRef('GetAWidget'), modelRef('GetAWidget')]);
    expect(warnings).toEqual([]);
  });

  it('bundles the model the schema pass lifted from a field’s own schema with that field’s site, by origin and never by name', () => {
    resetInheritedModelRefs();
    try {
      // `Foo.barThing` and `FooBar.thing` both spell `FooBarThing`; the
      // schema pass lifted one of them, from `FooBar.thing`.
      const foo: Model = { name: 'Foo', fields: [field('barThing', modelRef('FooBarThing'))] };
      const fooBar: Model = { name: 'FooBar', fields: [field('thing', modelRef('FooBarThing'))] };
      const lifted: Model = { name: 'FooBarThing', fields: [field('owner', modelRef('FooBarThingOwner'))] };
      const fooCopy: Model = { name: 'FooBarThing', fields: [field('owner', modelRef('FooBarThingOwner'), true)] };
      const fooChild: Model = { name: 'FooBarThingOwner', deprecated: true, fields: [field('city'), field('zip')] };
      const fooBarCopy: Model = { name: 'FooBarThing', fields: [field('owner', modelRef('FooBarThingOwner'))] };
      const fooBarChild: Model = { name: 'FooBarThingOwner', fields: [field('city')] };
      recordLiftedFieldModel('FooBar', 'thing', lifted);
      const groups = [
        { parentName: 'Foo', fieldName: 'barThing', models: [fooCopy, fooChild] },
        { parentName: 'FooBar', fieldName: 'thing', models: [fooBarCopy, fooBarChild] },
      ];
      const bundles = fieldInlineModelBundles(groups, [foo, fooBar, lifted]);
      // Only the site the model was lifted from claims it.
      expect(bundles[0]?.models).toEqual([fooCopy, fooChild]);
      expect(bundles[1]?.models).toEqual([fooBarCopy, fooBarChild, lifted]);
      // The roots stay each field's own reference.
      expect(bundles[0]?.roots).toEqual([foo.fields[0]?.type]);
      expect(bundles[1]?.roots).toEqual([fooBar.fields[0]?.type]);
      // A direct caller whose schemas the schema pass never read has no twins.
      resetInheritedModelRefs();
      expect(fieldInlineModelBundles(groups, [foo, fooBar, lifted]).map((b) => b.models)).toEqual([
        [fooCopy, fooChild],
        [fooBarCopy, fooBarChild],
      ]);
    } finally {
      resetInheritedModelRefs();
    }
  });
});

describe('a fold carries the copy’s references into the winner’s site (issue #313, review round 2)', () => {
  const str: TypeRef = { kind: 'primitive', type: 'string' };
  const field = (name: string, type: TypeRef = str): Model['fields'][number] => ({ name, type, required: false });
  const modelRef = (name: string): TypeRef => ({ kind: 'model', name });
  /** Run `fn`, returning every warning it printed instead of printing it. */
  const warnings = (fn: () => void): string[] => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fn();
      return warnSpy.mock.calls.map(([m]) => String(m));
    } finally {
      warnSpy.mockRestore();
    }
  };

  it('repoints a response folded onto a field model when a later pass renames the field model through its own site', () => {
    // The response merge folds `getEntry`'s `PetEntry` onto the field's
    // (`declared`); the field merge then moves the field model off an enum
    // name known only now. The response's root joined the field's site at
    // the fold, so the rename repoints it along with `Pet.entries`.
    const fieldModel: Model = { name: 'PetEntry', fields: [field('label')] };
    const copy: Model = { name: 'PetEntry', fields: [field('label')] };
    const pet: Model = { name: 'Pet', fields: [field('entries', { kind: 'map', valueType: modelRef('PetEntry') })] };
    const responseRef = modelRef('PetEntry');
    const fieldBundle: InlineModelBundle = { qualifier: 'Pet', roots: [pet.fields[0]!.type], models: [fieldModel] };
    const responseBundle = { qualifier: 'GetEntry', roots: [responseRef], models: [copy] };
    const naming: InlineModelNaming = {
      bundles: [fieldBundle, responseBundle],
      reserved: new Set(['Pet', 'PetEntry']),
      enums: new Set(),
    };
    const merged = mergeInlineResponseModels([pet], [copy], naming, [fieldModel]);
    expect(merged).toEqual([pet]);
    expect(responseRef).toEqual(modelRef('PetEntry'));
    // The response's site is carried onto the field model, by identity.
    expect(fieldBundle.carried).toEqual([{ owner: fieldModel, roots: [responseRef], models: [] }]);
    expect(fieldBundle.roots).toEqual([pet.fields[0]!.type]);

    let final: Model[] = [];
    const notes = warnings(() => {
      final = mergeFieldInlineModels(merged, [fieldModel], new Set(['Pet']), {
        ...naming,
        enums: new Set(['PetEntry']),
      });
    });
    expect(final.map((m) => m.name)).toEqual(['Pet', 'PetEntry2']);
    expect(pet.fields[0]!.type).toEqual({ kind: 'map', valueType: modelRef('PetEntry2') });
    expect(responseRef).toEqual(modelRef('PetEntry2'));
    expect(notes).toEqual(['[oagen] Renamed inline model "PetEntry" → "PetEntry2": enum "PetEntry" owns the name']);
  });

  it('carries the models minted beside the copy too, so a parent of the folded copy follows the winner’s rename', () => {
    // `getEntry`'s response `Entries { item: PetEntry }` references its own
    // `PetEntry`, which folds onto the field's; when the field's is renamed,
    // the response's parent must reference the new name as well.
    const fieldModel: Model = { name: 'PetEntry', fields: [field('label')] };
    const copy: Model = { name: 'PetEntry', fields: [field('label')] };
    const parent: Model = { name: 'Entries', fields: [field('item', modelRef('PetEntry'))] };
    const pet: Model = { name: 'Pet', fields: [field('entries', { kind: 'map', valueType: modelRef('PetEntry') })] };
    const responseRef = modelRef('Entries');
    const fieldBundle: InlineModelBundle = { qualifier: 'Pet', roots: [pet.fields[0]!.type], models: [fieldModel] };
    const naming: InlineModelNaming = {
      bundles: [fieldBundle, { qualifier: 'GetEntry', roots: [responseRef], models: [parent, copy] }],
      reserved: new Set(['Pet', 'PetEntry', 'Entries']),
      enums: new Set(),
    };
    const merged = mergeInlineResponseModels([pet], [parent, copy], naming, [fieldModel]);
    expect(merged.map((m) => m.name)).toEqual(['Pet', 'Entries']);
    expect(fieldBundle.carried).toEqual([{ owner: fieldModel, roots: [responseRef], models: [parent] }]);
    expect(fieldBundle.models).toEqual([fieldModel]);

    const final = warnings(() =>
      mergeFieldInlineModels(merged, [fieldModel], new Set(['Pet']), { ...naming, enums: new Set(['PetEntry']) }),
    );
    expect(final).toEqual(['[oagen] Renamed inline model "PetEntry" → "PetEntry2": enum "PetEntry" owns the name']);
    expect(parent.fields[0]!.type).toEqual(modelRef('PetEntry2'));
    expect(pet.fields[0]!.type).toEqual({ kind: 'map', valueType: modelRef('PetEntry2') });
  });

  it('carries nothing onto a component, which is never renamed', () => {
    const component: Model = { name: 'PetEntry', fields: [field('label')] };
    const copy: Model = { name: 'PetEntry', fields: [field('label')] };
    const responseRef = modelRef('PetEntry');
    const responseBundle = { qualifier: 'GetEntry', roots: [responseRef], models: [copy] };
    const merged = mergeInlineResponseModels([component], [copy], {
      bundles: [responseBundle],
      reserved: new Set(['PetEntry']),
      enums: new Set(),
    });
    expect(merged).toEqual([component]);
    expect(responseBundle.roots).toEqual([responseRef]);
    expect(responseBundle.models).toEqual([copy]);
    expect(responseBundle).not.toHaveProperty('carried');
  });

  it('reads a carried site by the winner’s identity: a rename of another model of the winner’s site leaves it alone', () => {
    // `getA` and `getB` both mint `Widget { owner: WidgetOwner }` beside a
    // component `Widget` of another shape. The children are decided first:
    // identical, `getB`'s `WidgetOwner` folds onto `getA`'s, so `getB`'s site
    // is carried onto it. Then `getA`'s `Widget` leaves the component's name
    // — a rename of another model of `getA`'s site — and must not take
    // `getB`'s response with it: `getB`'s `Widget` is `getB`'s own, decided
    // on its own (here, folded onto `getA`'s renamed `Widget` as its twin).
    const componentWidget: Model = { name: 'Widget', fields: [field('object'), field('extra')] };
    const componentOwner: Model = { name: 'WidgetOwner', fields: [field('city')] };
    const aOwner: Model = { name: 'WidgetOwner', fields: [field('city'), field('zip')] };
    const bOwner: Model = { name: 'WidgetOwner', fields: [field('city'), field('zip')] };
    const aWidget: Model = { name: 'Widget', fields: [field('object'), field('owner', modelRef('WidgetOwner'))] };
    const bWidget: Model = { name: 'Widget', fields: [field('object'), field('owner', modelRef('WidgetOwner'))] };
    const aRef = modelRef('Widget');
    const bRef = modelRef('Widget');
    const aBundle: InlineModelBundle = { qualifier: 'GetA', roots: [aRef], models: [aWidget, aOwner] };
    const bBundle: InlineModelBundle = { qualifier: 'GetB', roots: [bRef], models: [bWidget, bOwner] };
    let merged: Model[] = [];
    const notes = warnings(() => {
      merged = mergeInlineResponseModels([componentWidget, componentOwner], [aWidget, aOwner, bWidget, bOwner], {
        bundles: [aBundle, bBundle],
        reserved: new Set(['Widget', 'WidgetOwner']),
        enums: new Set(),
      });
    });
    expect(merged.map((m) => m.name)).toEqual(['Widget', 'WidgetOwner', 'GetAWidget', 'GetAWidgetOwner']);
    expect(aRef).toEqual(modelRef('GetAWidget'));
    expect(bRef).toEqual(modelRef('GetAWidget'));
    expect(aWidget.fields[1]!.type).toEqual(modelRef('GetAWidgetOwner'));
    expect(aBundle).toMatchObject({
      carried: [
        { owner: aOwner, roots: [bRef], models: [bWidget] },
        { owner: aWidget, roots: [bRef], models: [bOwner] },
      ],
    });
    expect(notes).toEqual([
      '[oagen] Renamed inline model "WidgetOwner" → "GetAWidgetOwner": its shape differs from component schema "WidgetOwner" (shared by 2 sites)',
      '[oagen] Renamed inline model "Widget" → "GetAWidget": its shape differs from component schema "Widget" (shared by 2 sites)',
    ]);
  });
});

describe('reservedTypeNames', () => {
  // #348 review round 2: the merge passes mint renamed models against this
  // set, so an enum reached only through a secondary request body — the
  // `text/csv` entry of `requestBodyContents`, which `requestBody` does not
  // share — must be in it, or a rename could take the enum's name and force
  // the collectors to move the enum after the fact.
  const csvEnum = { kind: 'enum' as const, name: 'CreatePetTextCsvRequest', values: ['header', 'bare'] };
  const body = { kind: 'model' as const, name: 'CreatePetRequest' };
  const createPet: Operation = {
    name: 'createPet',
    httpMethod: 'post',
    path: '/pets',
    pathParams: [],
    queryParams: [{ name: 'kind', type: { kind: 'enum', name: 'PetsKind', values: ['cat', 'dog'] }, required: false }],
    headerParams: [],
    requestBody: body,
    requestBodyContentTypes: ['application/json', 'text/csv'],
    requestBodyContents: [
      { contentType: 'application/json', type: body },
      { contentType: 'text/csv', type: csvEnum },
    ],
    response: { kind: 'primitive', type: 'unknown' },
    errors: [{ statusCode: 404, description: 'nf', type: { kind: 'enum', name: 'CreatePetError404', values: ['x'] } }],
    injectIdempotencyKey: false,
  };
  const services: Service[] = [{ name: 'Pets', operations: [createPet] }];

  it('holds every enum name an operation carries, a secondary request body’s included', () => {
    const reserved = reservedTypeNames([], [], [], [], services);
    expect([...reserved].sort()).toEqual(['CreatePetError404', 'CreatePetTextCsvRequest', 'PetsKind']);
  });

  it('holds every model and enum name given, and the enums their fields carry', () => {
    const models: Model[] = [
      {
        name: 'Pet',
        fields: [{ name: 'mood', type: { kind: 'enum', name: 'PetMood', values: ['calm'] }, required: false }],
      },
    ];
    const reserved = reservedTypeNames(
      models,
      [{ name: 'Color', values: [{ name: 'red', value: 'red' }] }],
      [],
      [],
      services,
    );
    expect([...reserved].sort()).toEqual([
      'Color',
      'CreatePetError404',
      'CreatePetTextCsvRequest',
      'Pet',
      'PetMood',
      'PetsKind',
    ]);
  });
});

describe('identical copies leaving a shared name share one model (issue #314)', () => {
  const str: TypeRef = { kind: 'primitive', type: 'string' };
  const model = (name: string, fields: string[], deprecated = false): Model => ({
    name,
    fields: fields.map((f) => ({ name: f, type: str, required: false })),
    ...(deprecated ? { deprecated: true } : {}),
  });
  const ref = (name: string): TypeRef => ({ kind: 'model', name });
  /** Run `fn`, returning every warning it printed instead of printing it. */
  const warnings = (fn: () => void): string[] => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fn();
      return warnSpy.mock.calls.map(([m]) => String(m));
    } finally {
      warnSpy.mockRestore();
    }
  };

  it('two deprecated field copies beside a live component of another shape: one `PetOwnerAddress2`, each site repointed', () => {
    const owner = model('PetOwnerAddress', ['city', 'country']);
    const a = model('PetOwnerAddress', ['city'], true);
    const b = model('PetOwnerAddress', ['city'], true);
    const aRef = ref('PetOwnerAddress');
    const bRef = ref('PetOwnerAddress');
    let settled: Model[] = [];
    const notes = warnings(() => {
      settled = settleFieldInlineModels([owner], [a, b], {
        bundles: [
          { qualifier: 'Pet', roots: [aRef], models: [a] },
          { qualifier: 'PetOwner', roots: [bRef], models: [b] },
        ],
        reserved: new Set(['Pet', 'PetOwner', 'PetOwnerAddress']),
        enums: new Set(),
      });
    });
    expect(settled).toEqual([a]);
    expect(a.name).toBe('PetOwnerAddress2');
    expect(aRef).toEqual(ref('PetOwnerAddress2'));
    expect(bRef).toEqual(ref('PetOwnerAddress2'));
    expect(owner.name).toBe('PetOwnerAddress');
    expect(notes).toEqual([
      '[oagen] Renamed inline model "PetOwnerAddress" → "PetOwnerAddress2": it is deprecated while "PetOwnerAddress" is live (shared by 2 sites)',
    ]);
  });

  it('a third copy of another shape takes a name of its own, and a copy with no site is left under the shared one', () => {
    const owner = model('PetOwnerAddress', ['city', 'country']);
    const a = model('PetOwnerAddress', ['city'], true);
    const b = model('PetOwnerAddress', ['city'], true);
    const other = model('PetOwnerAddress', ['city', 'zip'], true);
    const noSite = model('PetOwnerAddress', ['city'], true);
    const aRef = ref('PetOwnerAddress');
    const bRef = ref('PetOwnerAddress');
    const otherRef = ref('PetOwnerAddress');
    let settled: Model[] = [];
    const notes = warnings(() => {
      settled = settleFieldInlineModels([owner], [a, noSite, other, b], {
        bundles: [
          { qualifier: 'Pet', roots: [aRef], models: [a] },
          { qualifier: 'Shelter', roots: [otherRef], models: [other] },
          { qualifier: 'PetOwner', roots: [bRef], models: [b] },
        ],
        reserved: new Set(['Pet', 'PetOwner', 'PetOwnerAddress', 'Shelter']),
        enums: new Set(),
      });
    });
    // The no-site copy keeps the component's name and is dropped for it.
    expect(settled).toEqual([a, other]);
    expect(a.name).toBe('PetOwnerAddress2');
    expect(other.name).toBe('ShelterPetOwnerAddress');
    expect(aRef).toEqual(ref('PetOwnerAddress2'));
    expect(bRef).toEqual(ref('PetOwnerAddress2'));
    expect(otherRef).toEqual(ref('ShelterPetOwnerAddress'));
    expect(notes).toEqual([
      '[oagen] Warning: Inline model "PetOwnerAddress" is deprecated in one definition and live in another, with different shapes, and has no site to be renamed from — keeping the usual definition under the shared name',
      '[oagen] Renamed inline model "PetOwnerAddress" → "PetOwnerAddress2": it is deprecated while "PetOwnerAddress" is live (shared by 2 sites)',
      '[oagen] Renamed inline model "PetOwnerAddress" → "ShelterPetOwnerAddress": it is deprecated while "PetOwnerAddress" is live',
    ]);
  });

  it('two live response copies beside a deprecated component share one name the same way', () => {
    const owner = model('Widget', ['a'], true);
    const a = model('Widget', ['a']);
    const b = model('Widget', ['a']);
    const aRef = ref('Widget');
    const bRef = ref('Widget');
    let merged: Model[] = [];
    const notes = warnings(() => {
      merged = mergeInlineResponseModels([owner], [a, b], {
        bundles: [
          { qualifier: 'GetAWidget', roots: [aRef], models: [a] },
          { qualifier: 'GetBWidget', roots: [bRef], models: [b] },
        ],
        reserved: new Set(['Widget']),
        enums: new Set(),
      });
    });
    expect(merged).toEqual([owner, a]);
    expect(a.name).toBe('GetAWidgetWidget');
    expect(aRef).toEqual(ref('GetAWidgetWidget'));
    expect(bRef).toEqual(ref('GetAWidgetWidget'));
    expect(notes).toEqual([
      '[oagen] Renamed inline model "Widget" → "GetAWidgetWidget": it is live while "Widget" is deprecated (shared by 2 sites)',
    ]);
  });

  it('two identical copies of an enum-owned name share one name the same way', () => {
    const a = model('Widget', ['a']);
    const b = model('Widget', ['a']);
    const aRef = ref('Widget');
    const bRef = ref('Widget');
    let merged: Model[] = [];
    const notes = warnings(() => {
      merged = mergeInlineResponseModels([], [a, b], {
        bundles: [
          { qualifier: 'GetAWidget', roots: [aRef], models: [a] },
          { qualifier: 'GetBWidget', roots: [bRef], models: [b] },
        ],
        reserved: new Set(['Widget']),
        enums: new Set(['Widget']),
      });
    });
    expect(merged).toEqual([a]);
    expect(a.name).toBe('GetAWidgetWidget');
    expect(aRef).toEqual(ref('GetAWidgetWidget'));
    expect(bRef).toEqual(ref('GetAWidgetWidget'));
    expect(notes).toEqual([
      '[oagen] Renamed inline model "Widget" → "GetAWidgetWidget": enum "Widget" owns the name (shared by 2 sites)',
    ]);
  });
});
