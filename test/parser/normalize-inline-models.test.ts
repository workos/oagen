import { describe, it, expect, vi } from 'vitest';
import {
  collapseJsonSuffixModels,
  mergeFieldInlineModels,
  mergeInlineResponseModels,
  reservedTypeNames,
  settleFieldInlineModels,
} from '../../src/parser/normalize-inline-models.js';
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
