import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { schemaToTypeRef, type SchemaObject } from '../../src/parser/schemas.js';
import { extractInlineModelsFromProperties, extractInlineModelsFromSchemas } from '../../src/parser/inline-models.js';
import type { Model } from '../../src/ir/types.js';

// The two shapes from workos/oagen#187: an array whose `items.oneOf` lists
// inline object variants, and a map whose `additionalProperties` value is an
// inline object. Both are referenced by name from the field TypeRef and must
// be extracted as models under exactly those names.
const circle: SchemaObject = {
  type: 'object',
  properties: { kind: { type: 'string', const: 'circle' }, radius: { type: 'number' } },
  required: ['kind', 'radius'],
};
const square: SchemaObject = {
  type: 'object',
  properties: { kind: { type: 'string', const: 'square' }, side: { type: 'number' } },
  required: ['kind', 'side'],
};
const drawingProperties: Record<string, SchemaObject> = {
  shapes: { type: 'array', items: { oneOf: [circle, square] } },
  layers: {
    type: 'object',
    additionalProperties: { type: 'object', properties: { visible: { type: 'boolean' } } },
  },
};

/** Write a spec object to a temp JSON file, parse it, return the IR. */
async function parseTempSpec(spec: Record<string, unknown>): Promise<Awaited<ReturnType<typeof parseSpec>>> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-inline-models-'));
  const specFile = path.join(tmpDir, 'spec.json');
  try {
    await fs.writeFile(specFile, JSON.stringify(spec), 'utf-8');
    return await parseSpec(specFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
}

function fieldTypesByModel(models: Model[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    models.map((model) => [model.name, Object.fromEntries(model.fields.map((field) => [field.name, field.type]))]),
  );
}

describe('inline models reached through array items and map values (#187)', () => {
  it('extracts every model an inline request body references, with no unresolved refs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/drawings': {
            post: {
              operationId: 'createDrawing',
              requestBody: {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: drawingProperties, required: ['shapes', 'layers'] },
                  },
                },
              },
              responses: { '204': { description: 'ok' } },
            },
          },
        },
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(fieldTypesByModel(ir.models)).toMatchInlineSnapshot(`
        {
          "CreateDrawingRequest": {
            "layers": {
              "kind": "map",
              "valueType": {
                "kind": "model",
                "name": "CreateDrawingRequestLayer",
              },
            },
            "shapes": {
              "items": {
                "compositionKind": "oneOf",
                "discriminator": {
                  "mapping": {
                    "circle": "CreateDrawingRequestShape",
                    "square": "SquareCreateDrawingRequestShape",
                  },
                  "property": "kind",
                },
                "kind": "union",
                "variants": [
                  {
                    "kind": "model",
                    "name": "CreateDrawingRequestShape",
                  },
                  {
                    "kind": "model",
                    "name": "SquareCreateDrawingRequestShape",
                  },
                ],
              },
              "kind": "array",
            },
          },
          "CreateDrawingRequestLayer": {
            "visible": {
              "kind": "primitive",
              "type": "boolean",
            },
          },
          "CreateDrawingRequestShape": {
            "kind": {
              "kind": "literal",
              "value": "circle",
            },
            "radius": {
              "kind": "primitive",
              "type": "number",
            },
          },
          "SquareCreateDrawingRequestShape": {
            "kind": {
              "kind": "literal",
              "value": "square",
            },
            "side": {
              "kind": "primitive",
              "type": "number",
            },
          },
        }
      `);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('extracts the same shapes from a component schema', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {},
        components: {
          schemas: {
            Drawing: { type: 'object', properties: drawingProperties, required: ['shapes', 'layers'] },
          },
        },
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(ir.models.map((model) => model.name).sort()).toEqual([
        'Drawing',
        'DrawingLayer',
        'DrawingShape',
        'SquareDrawingShape',
      ]);

      const shapes = ir.models.find((model) => model.name === 'Drawing')?.fields.find((f) => f.name === 'shapes');
      expect(shapes?.type).toEqual({
        kind: 'array',
        items: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [
            { kind: 'model', name: 'DrawingShape' },
            { kind: 'model', name: 'SquareDrawingShape' },
          ],
          discriminator: { property: 'kind', mapping: { circle: 'DrawingShape', square: 'SquareDrawingShape' } },
        },
      });
      const layers = ir.models.find((model) => model.name === 'Drawing')?.fields.find((f) => f.name === 'layers');
      expect(layers?.type).toEqual({ kind: 'map', valueType: { kind: 'model', name: 'DrawingLayer' } });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('schemaToTypeRef map values', () => {
  const layerValue: SchemaObject = { type: 'object', properties: { visible: { type: 'boolean' } } };

  it('qualifies an inline object value by the parent and singularizes the field, like array items', () => {
    expect(
      schemaToTypeRef({ type: 'object', additionalProperties: layerValue }, 'layers', 'CreateDrawingRequest'),
    ).toEqual({ kind: 'map', valueType: { kind: 'model', name: 'CreateDrawingRequestLayer' } });
    expect(
      schemaToTypeRef({ type: 'object', patternProperties: { '^x-': layerValue } }, 'layers', 'CreateDrawingRequest'),
    ).toEqual({ kind: 'map', valueType: { kind: 'model', name: 'CreateDrawingRequestLayer' } });
    // Same rule as array items: without a parent the name is the bare field.
    expect(schemaToTypeRef({ type: 'object', additionalProperties: layerValue }, 'layers')).toEqual({
      kind: 'map',
      valueType: { kind: 'model', name: 'Layers' },
    });
    expect(schemaToTypeRef({ type: 'array', items: layerValue }, 'layers')).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'Layers' },
    });
  });

  it('keeps `additionalProperties: {}` and `true` as unknown values', () => {
    expect(schemaToTypeRef({ type: 'object', additionalProperties: {} }, 'layers', 'CreateDrawingRequest')).toEqual({
      kind: 'map',
      valueType: { kind: 'primitive', type: 'unknown' },
    });
    expect(schemaToTypeRef({ type: 'object', additionalProperties: true }, 'layers', 'CreateDrawingRequest')).toEqual({
      kind: 'map',
      valueType: { kind: 'primitive', type: 'unknown' },
    });
  });

  it('keeps the parent through nullable wrappers', () => {
    const expected = {
      kind: 'nullable',
      inner: { kind: 'map', valueType: { kind: 'model', name: 'CreateDrawingRequestLayer' } },
    };
    expect(
      schemaToTypeRef({ type: ['object', 'null'], additionalProperties: layerValue }, 'layers', 'CreateDrawingRequest'),
    ).toEqual(expected);
    expect(
      schemaToTypeRef(
        { type: 'object', nullable: true, additionalProperties: layerValue },
        'layers',
        'CreateDrawingRequest',
      ),
    ).toEqual(expected);
  });
});

describe('extractInlineModelsFromProperties', () => {
  function extract(properties: Record<string, SchemaObject>, parentName = 'CreateDrawingRequest'): Model[] {
    const results: Model[] = [];
    extractInlineModelsFromProperties({ type: 'object', properties }, results, parentName);
    return results;
  }

  it('extracts array oneOf variants under the names the union references, and recurses into them', () => {
    const circleWithCenter: SchemaObject = {
      ...circle,
      properties: {
        ...circle.properties,
        center: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
    };
    const shapes: SchemaObject = { type: 'array', items: { oneOf: [circleWithCenter, square] } };

    const models = extract({ shapes });
    expect(models.map((model) => model.name)).toEqual([
      'CreateDrawingRequestShape',
      'CreateDrawingRequestShapeCenter',
      'SquareCreateDrawingRequestShape',
    ]);

    // Every name the field's union points at must be one of the extracted models.
    const ref = schemaToTypeRef(shapes, 'shapes', 'CreateDrawingRequest');
    const referenced =
      ref.kind === 'array' && ref.items.kind === 'union' ? Object.values(ref.items.discriminator?.mapping ?? {}) : [];
    expect(referenced).toEqual(['CreateDrawingRequestShape', 'SquareCreateDrawingRequestShape']);
    expect(fieldTypesByModel(models)).toMatchInlineSnapshot(`
      {
        "CreateDrawingRequestShape": {
          "center": {
            "kind": "model",
            "name": "CreateDrawingRequestShapeCenter",
          },
          "kind": {
            "kind": "literal",
            "value": "circle",
          },
          "radius": {
            "kind": "primitive",
            "type": "number",
          },
        },
        "CreateDrawingRequestShapeCenter": {
          "x": {
            "kind": "primitive",
            "type": "number",
          },
          "y": {
            "kind": "primitive",
            "type": "number",
          },
        },
        "SquareCreateDrawingRequestShape": {
          "kind": {
            "kind": "literal",
            "value": "square",
          },
          "side": {
            "kind": "primitive",
            "type": "number",
          },
        },
      }
    `);
  });

  it('extracts map values: inline objects, arrays of inline objects, and patternProperties', () => {
    const tile: SchemaObject = { type: 'object', properties: { url: { type: 'string' } } };
    const models = extract({
      layers: drawingProperties.layers!,
      tiles: { type: 'object', additionalProperties: { type: 'array', items: tile } },
      patterns: { type: 'object', patternProperties: { '^x-': tile } },
    });
    expect(models.map((model) => model.name)).toEqual([
      'CreateDrawingRequestLayer',
      'CreateDrawingRequestTile',
      'CreateDrawingRequestPattern',
    ]);
    expect(
      schemaToTypeRef(
        { type: 'object', additionalProperties: { type: 'array', items: tile } },
        'tiles',
        'CreateDrawingRequest',
      ),
    ).toEqual({
      kind: 'map',
      valueType: { kind: 'array', items: { kind: 'model', name: 'CreateDrawingRequestTile' } },
    });
  });

  it('extracts nothing for maps of unknown, primitive, or $ref values', () => {
    const models = extract({
      anything: { type: 'object', additionalProperties: {} },
      flags: { type: 'object', additionalProperties: true },
      counts: { type: 'object', additionalProperties: { type: 'integer' } },
      gadgets: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Gadget' } },
    });
    expect(models).toEqual([]);
  });

  it('still extracts a plain array of inline objects by the singularized field name', () => {
    const models = extract({
      points: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' } } } },
    });
    expect(models.map((model) => model.name)).toEqual(['CreateDrawingRequestPoint']);
  });

  it('walks component schemas through extractInlineModelsFromSchemas', () => {
    const models = extractInlineModelsFromSchemas({
      Drawing: { type: 'object', properties: drawingProperties },
    });
    expect(models.map((model) => model.name)).toEqual(['DrawingShape', 'SquareDrawingShape', 'DrawingLayer']);
  });
});

describe('nullable fields keep their inline models', () => {
  const object: SchemaObject = { type: 'object', properties: { visible: { type: 'boolean' } } };
  const fieldTypes = (ir: Awaited<ReturnType<typeof parseSpec>>, modelName: string): Record<string, unknown> =>
    fieldTypesByModel(ir.models)[modelName] ?? {};

  // Each form is what `schemaToTypeRef` unwraps as nullable; the extractor
  // must see through the same wrapper or the model behind the reference is
  // never emitted.
  const forms: Array<{ form: string; openapi: string; wrap: (schema: SchemaObject) => SchemaObject }> = [
    {
      form: 'OAS 3.1 `type: [X, "null"]`',
      openapi: '3.1.0',
      wrap: (schema) => ({ ...schema, type: [schema.type as string, 'null'] }),
    },
    { form: 'OAS 3.0 `nullable: true`', openapi: '3.0.3', wrap: (schema) => ({ ...schema, nullable: true }) },
    {
      form: '`oneOf: [X, { type: "null" }]`',
      openapi: '3.1.0',
      wrap: (schema) => ({ oneOf: [schema, { type: 'null' }] }),
    },
  ];

  it.each(forms)(
    '$form: nullable object, array of objects, map of objects, and map of nullable objects',
    async ({ openapi, wrap }) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const ir = await parseTempSpec({
          openapi,
          info: { title: 'nullable', version: '1' },
          paths: {},
          components: {
            schemas: {
              Thing: {
                type: 'object',
                properties: {
                  widget: wrap(object),
                  shapes: wrap({ type: 'array', items: object }),
                  layers: wrap({ type: 'object', additionalProperties: object }),
                  tiles: { type: 'object', additionalProperties: wrap(object) },
                },
              },
            },
          },
        });

        expect(warnSpy).not.toHaveBeenCalled();
        expect(fieldTypes(ir, 'Thing')).toEqual({
          widget: { kind: 'nullable', inner: { kind: 'model', name: 'ThingWidget' } },
          shapes: { kind: 'nullable', inner: { kind: 'array', items: { kind: 'model', name: 'ThingShape' } } },
          layers: { kind: 'nullable', inner: { kind: 'map', valueType: { kind: 'model', name: 'ThingLayer' } } },
          tiles: { kind: 'map', valueType: { kind: 'nullable', inner: { kind: 'model', name: 'ThingTile' } } },
        });
        const visible = { visible: { kind: 'primitive', type: 'boolean' } };
        expect(fieldTypes(ir, 'ThingWidget')).toEqual(visible);
        expect(fieldTypes(ir, 'ThingShape')).toEqual(visible);
        expect(fieldTypes(ir, 'ThingLayer')).toEqual(visible);
        expect(fieldTypes(ir, 'ThingTile')).toEqual(visible);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );
});

describe('oneOf variants without a shared const field', () => {
  const byRadius: SchemaObject = { type: 'object', properties: { radius: { type: 'number' } } };
  const bySide: SchemaObject = { type: 'object', properties: { side: { type: 'number' } } };
  const byPoints: SchemaObject = { type: 'object', properties: { points: { type: 'integer' } } };

  function unionVariantNames(ref: unknown): string[] {
    const union = (ref as { kind: string; items?: unknown }).kind === 'array' ? (ref as { items: unknown }).items : ref;
    return ((union as { variants: Array<{ name: string }> }).variants ?? []).map((v) => v.name);
  }

  it('numbers the TypeRef variants by position, matching the extractor', () => {
    const union = schemaToTypeRef({ oneOf: [byRadius, bySide, byPoints] }, 'shape', 'Drawing');
    expect(unionVariantNames(union)).toEqual(['DrawingShape', 'DrawingShape2', 'DrawingShape3']);
    expect(unionVariantNames(schemaToTypeRef({ anyOf: [byRadius, bySide] }, 'shape', 'Drawing'))).toEqual([
      'DrawingShape',
      'DrawingShape2',
    ]);

    const results: Model[] = [];
    extractInlineModelsFromProperties(
      { type: 'object', properties: { shape: { oneOf: [byRadius, bySide, byPoints] } } },
      results,
      'Drawing',
    );
    expect(results.map((model) => model.name)).toEqual(['DrawingShape', 'DrawingShape2', 'DrawingShape3']);
  });

  it('agrees at field level and array-item level in a component schema', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec({
        openapi: '3.1.0',
        info: { title: 'variants', version: '1' },
        paths: {},
        components: {
          schemas: {
            Drawing: {
              type: 'object',
              properties: {
                shape: { oneOf: [byRadius, bySide] },
                markers: { type: 'array', items: { oneOf: [byRadius, bySide] } },
              },
            },
          },
        },
      });

      expect(warnSpy).not.toHaveBeenCalled();
      const drawing = fieldTypesByModel(ir.models)['Drawing']!;
      expect(unionVariantNames(drawing['shape'])).toEqual(['DrawingShape', 'DrawingShape2']);
      expect(unionVariantNames(drawing['markers'])).toEqual(['DrawingMarker', 'DrawingMarker2']);
      expect(ir.models.map((model) => model.name).sort()).toEqual([
        'Drawing',
        'DrawingMarker',
        'DrawingMarker2',
        'DrawingShape',
        'DrawingShape2',
      ]);
      expect(fieldTypesByModel(ir.models)['DrawingShape2']).toEqual({ side: { kind: 'primitive', type: 'number' } });
      expect(fieldTypesByModel(ir.models)['DrawingMarker2']).toEqual({ side: { kind: 'primitive', type: 'number' } });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('agrees for an array of variants in an inline request body', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec({
        openapi: '3.1.0',
        info: { title: 'variants', version: '1' },
        paths: {
          '/drawings': {
            post: {
              operationId: 'createDrawing',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { markers: { type: 'array', items: { oneOf: [byRadius, bySide] } } },
                    },
                  },
                },
              },
              responses: { '204': { description: 'ok' } },
            },
          },
        },
      });

      expect(warnSpy).not.toHaveBeenCalled();
      const body = fieldTypesByModel(ir.models)['CreateDrawingRequest']!;
      expect(unionVariantNames(body['markers'])).toEqual(['CreateDrawingRequestMarker', 'CreateDrawingRequestMarker2']);
      expect(ir.models.map((model) => model.name).sort()).toEqual([
        'CreateDrawingRequest',
        'CreateDrawingRequestMarker',
        'CreateDrawingRequestMarker2',
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('nullable inline union variants keep their wrapper', () => {
  const byRadius: SchemaObject = { type: 'object', properties: { radius: { type: 'number' } } };
  const bySide: SchemaObject = { type: 'object', properties: { side: { type: 'number' } } };

  // A variant that admits null on its own must be referenced as
  // `nullable<model>` under the name the extractor emits for it — with a
  // const discriminator (`shape`) and without one (`markers`, numbered).
  const forms: Array<{ form: string; openapi: string; wrap: (schema: SchemaObject) => SchemaObject }> = [
    { form: 'OAS 3.1 `type: ["object", "null"]`', openapi: '3.1.0', wrap: (s) => ({ ...s, type: ['object', 'null'] }) },
    { form: 'OAS 3.0 `nullable: true`', openapi: '3.0.3', wrap: (s) => ({ ...s, nullable: true }) },
  ];

  it.each(forms)('$form variant at field level and array-item level', async ({ openapi, wrap }) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec({
        openapi,
        info: { title: 'nullable variants', version: '1' },
        paths: {},
        components: {
          schemas: {
            Drawing: {
              type: 'object',
              properties: {
                shape: { oneOf: [circle, wrap(square)] },
                markers: { type: 'array', items: { oneOf: [byRadius, wrap(bySide)] } },
              },
            },
          },
        },
      });

      expect(warnSpy).not.toHaveBeenCalled();
      const drawing = fieldTypesByModel(ir.models)['Drawing']!;
      expect(drawing['shape']).toEqual({
        kind: 'union',
        compositionKind: 'oneOf',
        variants: [
          { kind: 'model', name: 'DrawingShape' },
          { kind: 'nullable', inner: { kind: 'model', name: 'SquareDrawingShape' } },
        ],
        discriminator: { property: 'kind', mapping: { circle: 'DrawingShape', square: 'SquareDrawingShape' } },
      });
      expect(drawing['markers']).toEqual({
        kind: 'array',
        items: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [
            { kind: 'model', name: 'DrawingMarker' },
            { kind: 'nullable', inner: { kind: 'model', name: 'DrawingMarker2' } },
          ],
        },
      });
      expect(ir.models.map((model) => model.name).sort()).toEqual([
        'Drawing',
        'DrawingMarker',
        'DrawingMarker2',
        'DrawingShape',
        'SquareDrawingShape',
      ]);
      expect(fieldTypesByModel(ir.models)['SquareDrawingShape']).toEqual({
        kind: { kind: 'literal', value: 'square' },
        side: { kind: 'primitive', type: 'number' },
      });
      expect(fieldTypesByModel(ir.models)['DrawingMarker2']).toEqual({ side: { kind: 'primitive', type: 'number' } });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('wraps the ref for anyOf too, and still extracts the variant', () => {
    const nullableSide: SchemaObject = { ...bySide, type: ['object', 'null'] };
    expect(schemaToTypeRef({ anyOf: [byRadius, nullableSide] }, 'shape', 'Drawing')).toEqual({
      kind: 'union',
      compositionKind: 'anyOf',
      variants: [
        { kind: 'model', name: 'DrawingShape' },
        { kind: 'nullable', inner: { kind: 'model', name: 'DrawingShape2' } },
      ],
    });
    const results: Model[] = [];
    extractInlineModelsFromProperties(
      { type: 'object', properties: { shape: { anyOf: [byRadius, nullableSide] } } },
      results,
      'Drawing',
    );
    expect(results.map((model) => model.name)).toEqual(['DrawingShape', 'DrawingShape2']);
  });
});
