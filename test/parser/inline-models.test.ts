import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { schemaToTypeRef, type SchemaObject } from '../../src/parser/schemas.js';
import { extractInlineModelsFromProperties, extractInlineModelsFromSchemas } from '../../src/parser/inline-models.js';
import { walkTypeRef, type Model } from '../../src/ir/types.js';

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

describe('nested inline objects under later union variants', () => {
  const center: SchemaObject = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } };
  const withRadius: SchemaObject = { type: 'object', properties: { radius: { type: 'number' }, center } };
  const withSide: SchemaObject = { type: 'object', properties: { side: { type: 'number' }, center } };
  const num = { kind: 'primitive', type: 'number' };
  const point = { x: num, y: num };

  /** Every model name referenced from any field of any model. */
  function referencedModelNames(models: Model[]): Set<string> {
    const names = new Set<string>();
    for (const model of models) {
      for (const field of model.fields) walkTypeRef(field.type, { model: (ref) => void names.add(ref.name) });
    }
    return names;
  }

  // The component-schema path (`extractNestedSchema`) and the field extractor
  // must agree on the name of an inline object nested under variant N:
  // `<VariantN>Child`, never `<Variant0>Child`.
  const forms: Array<{ form: string; nullable: boolean; wrap: (schema: SchemaObject) => SchemaObject }> = [
    { form: 'plain', nullable: false, wrap: (s) => s },
    { form: 'nullable `type: ["object", "null"]`', nullable: true, wrap: (s) => ({ ...s, type: ['object', 'null'] }) },
  ];

  it.each(forms)('$form second variant at field level and array-item level', async ({ nullable, wrap }) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec({
        openapi: '3.1.0',
        info: { title: 'nested variants', version: '1' },
        paths: {},
        components: {
          schemas: {
            Thing: {
              type: 'object',
              properties: {
                shape: { oneOf: [withRadius, wrap(withSide)] },
                markers: { type: 'array', items: { oneOf: [withRadius, wrap(withSide)] } },
              },
            },
          },
        },
      });

      expect(warnSpy).not.toHaveBeenCalled();
      const second = (name: string) =>
        nullable ? { kind: 'nullable', inner: { kind: 'model', name } } : { kind: 'model', name };
      const types = fieldTypesByModel(ir.models);
      expect(types['Thing']).toEqual({
        shape: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [{ kind: 'model', name: 'ThingShape' }, second('ThingShape2')],
        },
        markers: {
          kind: 'array',
          items: {
            kind: 'union',
            compositionKind: 'oneOf',
            variants: [{ kind: 'model', name: 'ThingMarker' }, second('ThingMarker2')],
          },
        },
      });
      expect(types['ThingShape']).toEqual({ radius: num, center: { kind: 'model', name: 'ThingShapeCenter' } });
      expect(types['ThingShape2']).toEqual({ side: num, center: { kind: 'model', name: 'ThingShape2Center' } });
      expect(types['ThingMarker']).toEqual({ radius: num, center: { kind: 'model', name: 'ThingMarkerCenter' } });
      expect(types['ThingMarker2']).toEqual({ side: num, center: { kind: 'model', name: 'ThingMarker2Center' } });
      for (const nested of ['ThingShapeCenter', 'ThingShape2Center', 'ThingMarkerCenter', 'ThingMarker2Center']) {
        expect(types[nested]).toEqual(point);
      }
      expect(ir.models.map((model) => model.name).sort()).toEqual([
        'Thing',
        'ThingMarker',
        'ThingMarker2',
        'ThingMarker2Center',
        'ThingMarkerCenter',
        'ThingShape',
        'ThingShape2',
        'ThingShape2Center',
        'ThingShapeCenter',
      ]);

      // Every reference resolves, and no nested model is left orphaned.
      const referenced = referencedModelNames(ir.models);
      const known = new Set(ir.models.map((model) => model.name));
      expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
      expect([...known].filter((name) => name !== 'Thing' && !referenced.has(name))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('multi-type inline union variants keep their other types', () => {
  const center: SchemaObject = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } };
  const withRadius: SchemaObject = { type: 'object', properties: { radius: { type: 'number' }, center } };
  const objectOrString: SchemaObject = { type: ['object', 'string'], properties: { side: { type: 'number' }, center } };
  const objectOrIntegerOrNull: SchemaObject = {
    type: ['object', 'integer', 'null'],
    properties: { points: { type: 'integer' }, center },
  };
  const variants = [withRadius, objectOrString, objectOrIntegerOrNull];
  const num = { kind: 'primitive', type: 'number' };
  const int = { kind: 'primitive', type: 'integer' };
  const str = { kind: 'primitive', type: 'string' };

  // The named ref stands in for the `object` member only; the string and
  // integer alternatives survive exactly as schemaToTypeRef builds them for a
  // multi-type schema, and the numbered names are the extractor's.
  const expectedUnion = (base: string) => ({
    kind: 'union',
    compositionKind: 'oneOf',
    variants: [
      { kind: 'model', name: base },
      { kind: 'union', variants: [{ kind: 'model', name: `${base}2` }, str] },
      { kind: 'nullable', inner: { kind: 'union', variants: [{ kind: 'model', name: `${base}3` }, int] } },
    ],
  });

  it('at field level and array-item level, end to end', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec({
        openapi: '3.1.0',
        info: { title: 'multi-type variants', version: '1' },
        paths: {},
        components: {
          schemas: {
            Thing: {
              type: 'object',
              properties: {
                shape: { oneOf: variants },
                markers: { type: 'array', items: { oneOf: variants } },
              },
            },
          },
        },
      });

      expect(warnSpy).not.toHaveBeenCalled();
      const types = fieldTypesByModel(ir.models);
      expect(types['Thing']).toEqual({
        shape: expectedUnion('ThingShape'),
        markers: { kind: 'array', items: expectedUnion('ThingMarker') },
      });
      for (const base of ['ThingShape', 'ThingMarker']) {
        expect(types[base]).toEqual({ radius: num, center: { kind: 'model', name: `${base}Center` } });
        expect(types[`${base}2`]).toEqual({ side: num, center: { kind: 'model', name: `${base}2Center` } });
        expect(types[`${base}3`]).toEqual({ points: int, center: { kind: 'model', name: `${base}3Center` } });
        for (const suffix of ['', '2', '3']) {
          expect(types[`${base}${suffix}Center`]).toEqual({ x: num, y: num });
        }
      }

      // Every reference resolves, and no model is left orphaned.
      const referenced = modelRefsIn(ir.models);
      const known = new Set(ir.models.map((model) => model.name));
      expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
      expect([...known].filter((name) => name !== 'Thing' && !referenced.has(name))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('names the variants the way the extractor does, for anyOf too', () => {
    const results: Model[] = [];
    extractInlineModelsFromProperties({ type: 'object', properties: { shape: { oneOf: variants } } }, results, 'Thing');
    expect(results.map((model) => model.name)).toEqual([
      'ThingShape',
      'ThingShapeCenter',
      'ThingShape2',
      'ThingShape2Center',
      'ThingShape3',
      'ThingShape3Center',
    ]);
    expect(schemaToTypeRef({ anyOf: variants }, 'shape', 'Thing')).toEqual({
      ...expectedUnion('ThingShape'),
      compositionKind: 'anyOf',
    });
  });
});

/** Every model name referenced from any field of any model. */
function modelRefsIn(models: Model[]): Set<string> {
  const names = new Set<string>();
  for (const model of models) {
    for (const field of model.fields) walkTypeRef(field.type, { model: (ref) => void names.add(ref.name) });
  }
  return names;
}

describe('non-object members of multi-type union variants are named from the variant', () => {
  const point: SchemaObject = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } };
  const withRadius: SchemaObject = { type: 'object', properties: { radius: { type: 'number' } } };
  const side = { side: { type: 'number' } };
  const num = { kind: 'primitive', type: 'number' };
  const model = (name: string) => ({ kind: 'model', name });
  const array = (items: unknown) => ({ kind: 'array', items });

  // For each case: the second variant's schema, the TypeRef of its non-object
  // member given the variant's name, and the models that member adds (all
  // named `<Variant>Item...`, never from the union's field).
  type MemberCase = {
    label: string;
    variant: SchemaObject;
    member: (variantName: string) => unknown;
    models: (variantName: string) => string[];
    nullable?: boolean;
  };
  const cases: MemberCase[] = [
    {
      label: 'array member with inline object items',
      variant: { type: ['object', 'array'], properties: side, items: point },
      member: (v) => array(model(`${v}Item`)),
      models: (v) => [`${v}Item`],
    },
    {
      label: 'array member whose items nest another inline object',
      variant: {
        type: ['object', 'array'],
        properties: side,
        items: { type: 'object', properties: { x: { type: 'number' }, origin: point } },
      },
      member: (v) => array(model(`${v}Item`)),
      models: (v) => [`${v}Item`, `${v}ItemOrigin`],
    },
    {
      label: 'array member with oneOf items and no const field',
      variant: {
        type: ['object', 'array'],
        properties: side,
        items: { oneOf: [point, { type: 'object', properties: { label: { type: 'string' } } }] },
      },
      member: (v) =>
        array({ kind: 'union', compositionKind: 'oneOf', variants: [model(`${v}Item`), model(`${v}Item2`)] }),
      models: (v) => [`${v}Item`, `${v}Item2`],
    },
    {
      label: 'array member with const-discriminated oneOf items',
      variant: {
        type: ['object', 'array'],
        properties: side,
        items: {
          oneOf: [
            { type: 'object', properties: { kind: { type: 'string', const: 'dot' }, x: { type: 'number' } } },
            { type: 'object', properties: { kind: { type: 'string', const: 'tag' }, label: { type: 'string' } } },
          ],
        },
      },
      member: (v) =>
        array({
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model(`${v}Item`), model(`Tag${v}Item`)],
          discriminator: { property: 'kind', mapping: { dot: `${v}Item`, tag: `Tag${v}Item` } },
        }),
      models: (v) => [`${v}Item`, `Tag${v}Item`],
    },
    {
      label: 'array member with $ref items',
      variant: { type: ['object', 'array'], properties: side, items: { $ref: '#/components/schemas/Gadget' } },
      member: () => array(model('Gadget')),
      models: () => [],
    },
    {
      label: 'nullable array member with inline object items',
      variant: { type: ['object', 'array', 'null'], properties: side, items: point },
      member: (v) => array(model(`${v}Item`)),
      models: (v) => [`${v}Item`],
      nullable: true,
    },
    {
      // `properties` make the object member a model, so `additionalProperties`
      // never turns it into a map; no `<Variant>Value` model exists.
      label: 'object member with properties and additionalProperties (not a map)',
      variant: { type: ['object', 'string'], properties: side, additionalProperties: point },
      member: () => ({ kind: 'primitive', type: 'string' }),
      models: () => [],
    },
  ];

  it.each(cases)('$label, at field level and array-item level', async ({ variant, member, models, nullable }) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const variants = [withRadius, variant];
      const ir = await parseTempSpec({
        openapi: '3.1.0',
        info: { title: 'variant members', version: '1' },
        paths: {},
        components: {
          schemas: {
            Gadget: { type: 'object', properties: { id: { type: 'string' } } },
            Thing: {
              type: 'object',
              properties: {
                shape: { oneOf: variants },
                markers: { type: 'array', items: { oneOf: variants } },
              },
            },
          },
        },
      });

      expect(warnSpy).not.toHaveBeenCalled();
      const types = fieldTypesByModel(ir.models);
      const second = (v: string) => {
        const union = { kind: 'union', variants: [model(v), member(v)] };
        return nullable ? { kind: 'nullable', inner: union } : union;
      };
      expect(types['Thing']).toEqual({
        shape: { kind: 'union', compositionKind: 'oneOf', variants: [model('ThingShape'), second('ThingShape2')] },
        markers: array({
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('ThingMarker'), second('ThingMarker2')],
        }),
      });
      expect(types['ThingShape2']).toEqual({ side: num });
      expect(types['ThingMarker2']).toEqual({ side: num });
      expect(ir.models.map((m) => m.name).sort()).toEqual(
        [
          'Gadget',
          'Thing',
          'ThingShape',
          'ThingShape2',
          ...models('ThingShape2'),
          'ThingMarker',
          'ThingMarker2',
          ...models('ThingMarker2'),
        ].sort(),
      );
      expect(ir.models.some((m) => m.name.endsWith('Value'))).toBe(false);

      // Every reference resolves, and no inline model is left orphaned.
      const referenced = modelRefsIn(ir.models);
      const known = new Set(ir.models.map((m) => m.name));
      expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
      expect([...known].filter((name) => !['Thing', 'Gadget'].includes(name) && !referenced.has(name))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('the field extractor emits the item models under the variant name', () => {
    const results: Model[] = [];
    extractInlineModelsFromProperties(
      { type: 'object', properties: { shape: { oneOf: [withRadius, cases[1]!.variant] } } },
      results,
      'Thing',
    );
    expect(results.map((m) => m.name)).toEqual([
      'ThingShape',
      'ThingShape2',
      'ThingShape2Item',
      'ThingShape2ItemOrigin',
    ]);
    expect(fieldTypesByModel(results)['ThingShape2Item']).toEqual({
      x: num,
      origin: model('ThingShape2ItemOrigin'),
    });
  });
});

describe("synthetic member names never collide with the variant's own properties", () => {
  const n: SchemaObject = { type: 'number' };
  const obj = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', properties });
  const withRadius: SchemaObject = obj({ radius: n });
  const num = { kind: 'primitive', type: 'number' };
  const model = (name: string) => ({ kind: 'model', name });
  const array = (items: unknown) => ({ kind: 'array', items });

  type CollisionCase = {
    label: string;
    variant: SchemaObject;
    /** The non-object member's TypeRef, given the variant's name. */
    member: (v: string) => unknown;
    /** The variant model's own fields, given its name. */
    fields: (v: string) => Record<string, unknown>;
    /** Nested model name → its fields, given the variant's name. */
    nested: (v: string) => Record<string, Record<string, unknown>>;
    /** Inline enums expected in `ir.enums`, given the variant's name. */
    enums?: (v: string) => string[];
  };
  // The property's model keeps `<Variant>Item` / `<Variant>Value`; the
  // synthetic member steps aside to `<Variant>ArrayItem` / `<Variant>MemberValue`,
  // then `<Variant>ArrayItem2`, ... — both referenced, both extracted.
  const cases: CollisionCase[] = [
    {
      label: "a property named `item` (the reviewer's case)",
      variant: { type: ['object', 'array'], properties: { side: n, item: obj({ x: n }) }, items: obj({ y: n }) },
      member: (v) => array(model(`${v}ArrayItem`)),
      fields: (v) => ({ side: num, item: model(`${v}Item`) }),
      nested: (v) => ({ [`${v}Item`]: { x: num }, [`${v}ArrayItem`]: { y: num } }),
    },
    {
      label: 'properties named `item` and `array_item`',
      variant: {
        type: ['object', 'array'],
        properties: { side: n, item: obj({ x: n }), array_item: obj({ z: n }) },
        items: obj({ y: n }),
      },
      member: (v) => array(model(`${v}ArrayItem2`)),
      fields: (v) => ({ side: num, item: model(`${v}Item`), array_item: model(`${v}ArrayItem`) }),
      nested: (v) => ({ [`${v}Item`]: { x: num }, [`${v}ArrayItem`]: { z: num }, [`${v}ArrayItem2`]: { y: num } }),
    },
    {
      label: 'a plural property `items`, whose model name singularizes to `Item`',
      variant: { type: ['object', 'array'], properties: { side: n, items: obj({ x: n }) }, items: obj({ y: n }) },
      member: (v) => array(model(`${v}ArrayItem`)),
      fields: (v) => ({ side: num, items: model(`${v}Item`) }),
      nested: (v) => ({ [`${v}Item`]: { x: num }, [`${v}ArrayItem`]: { y: num } }),
    },
    {
      label: 'a property named `value` beside an inline enum member',
      variant: { type: ['object', 'string'], enum: ['a', 'b'], properties: { side: n, value: obj({ x: n }) } },
      member: (v) => ({ kind: 'enum', name: `${v}MemberValue`, values: ['a', 'b'] }),
      fields: (v) => ({ side: num, value: model(`${v}Value`) }),
      nested: (v) => ({ [`${v}Value`]: { x: num } }),
      enums: (v) => [`${v}MemberValue`],
    },
  ];

  it.each(cases)('$label, at field level and array-item level', async ({ variant, member, fields, nested, enums }) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const variants = [withRadius, variant];
      const ir = await parseTempSpec({
        openapi: '3.1.0',
        info: { title: 'member name collisions', version: '1' },
        paths: {},
        components: {
          schemas: {
            Thing: {
              type: 'object',
              properties: {
                shape: { oneOf: variants },
                markers: { type: 'array', items: { oneOf: variants } },
              },
            },
          },
        },
      });

      expect(warnSpy).not.toHaveBeenCalled();
      const types = fieldTypesByModel(ir.models);
      const second = (v: string) => ({ kind: 'union', variants: [model(v), member(v)] });
      expect(types['Thing']).toEqual({
        shape: { kind: 'union', compositionKind: 'oneOf', variants: [model('ThingShape'), second('ThingShape2')] },
        markers: array({
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('ThingMarker'), second('ThingMarker2')],
        }),
      });
      for (const v of ['ThingShape2', 'ThingMarker2']) {
        expect(types[v]).toEqual(fields(v));
        for (const [name, modelFields] of Object.entries(nested(v))) {
          expect(types[name]).toEqual(modelFields);
        }
        for (const enumName of enums?.(v) ?? []) {
          expect(ir.enums.map((e) => e.name)).toContain(enumName);
        }
      }

      // Every reference resolves, and no inline model is left orphaned.
      const referenced = modelRefsIn(ir.models);
      const known = new Set(ir.models.map((m) => m.name));
      expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
      expect([...known].filter((name) => name !== 'Thing' && !referenced.has(name))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('array items and map values step aside from a sibling that takes the singular name (#206)', () => {
  const str = { kind: 'primitive', type: 'string' };
  const bool = { kind: 'primitive', type: 'boolean' };
  const num = { kind: 'primitive', type: 'number' };
  const model = (name: string) => ({ kind: 'model', name });
  const layer: SchemaObject = { type: 'object', properties: { name: { type: 'string' } } };
  const layerItem: SchemaObject = {
    type: 'object',
    properties: { visible: { type: 'boolean' }, opacity: { type: 'number' } },
  };
  const layersArray: SchemaObject = { type: 'array', items: layerItem };
  const layersMap: SchemaObject = { type: 'object', additionalProperties: layerItem };
  const info = { title: 'siblings', version: '1' };

  async function parseWithoutWarnings(spec: Record<string, unknown>): Promise<Awaited<ReturnType<typeof parseSpec>>> {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(spec);
      expect(warnSpy).not.toHaveBeenCalled();
      return ir;
    } finally {
      warnSpy.mockRestore();
    }
  }

  /** Every reference resolves and no inline model is left orphaned. */
  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = modelRefsIn(ir.models);
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
  }

  it("the issue's repro: `layer` keeps DrawingLayer and the items of `layers` become DrawingLayersItem", async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/drawings': {
          get: {
            operationId: 'getDrawing',
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Drawing' } } },
              },
            },
          },
        },
      },
      components: { schemas: { Drawing: { type: 'object', properties: { layer, layers: layersArray } } } },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layer: model('DrawingLayer'),
      layers: { kind: 'array', items: model('DrawingLayersItem') },
    });
    expect(types['DrawingLayer']).toEqual({ name: str });
    expect(types['DrawingLayersItem']).toEqual({ visible: bool, opacity: num });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Drawing', 'DrawingLayer', 'DrawingLayersItem']);
    expect(ir.services.flatMap((s) => s.operations).map((o) => o.response)).toEqual([model('Drawing')]);
    expectConsistent(ir, ['Drawing']);
  });

  it('a map of inline objects beside the singular sibling becomes DrawingLayersValue', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: { schemas: { Drawing: { type: 'object', properties: { layer, layers: layersMap } } } },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layer: model('DrawingLayer'),
      layers: { kind: 'map', valueType: model('DrawingLayersValue') },
    });
    expect(types['DrawingLayer']).toEqual({ name: str });
    expect(types['DrawingLayersValue']).toEqual({ visible: bool, opacity: num });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Drawing', 'DrawingLayer', 'DrawingLayersValue']);
    expectConsistent(ir, ['Drawing']);
  });

  it('applies to an inline request body parent', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/drawings': {
          post: {
            operationId: 'createDrawing',
            requestBody: {
              content: {
                'application/json': { schema: { type: 'object', properties: { layer, layers: layersArray } } },
              },
            },
            responses: { '204': { description: 'ok' } },
          },
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['CreateDrawingRequest']).toEqual({
      layer: model('CreateDrawingRequestLayer'),
      layers: { kind: 'array', items: model('CreateDrawingRequestLayersItem') },
    });
    expect(types['CreateDrawingRequestLayer']).toEqual({ name: str });
    expect(types['CreateDrawingRequestLayersItem']).toEqual({ visible: bool, opacity: num });
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'CreateDrawingRequest',
      'CreateDrawingRequestLayer',
      'CreateDrawingRequestLayersItem',
    ]);
    expectConsistent(ir, ['CreateDrawingRequest']);
  });

  it('applies under a nested inline parent', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Drawing: {
            type: 'object',
            properties: { canvas: { type: 'object', properties: { layer, layers: layersArray } } },
          },
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({ canvas: model('DrawingCanvas') });
    expect(types['DrawingCanvas']).toEqual({
      layer: model('DrawingCanvasLayer'),
      layers: { kind: 'array', items: model('DrawingCanvasLayersItem') },
    });
    expect(types['DrawingCanvasLayer']).toEqual({ name: str });
    expect(types['DrawingCanvasLayersItem']).toEqual({ visible: bool, opacity: num });
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'Drawing',
      'DrawingCanvas',
      'DrawingCanvasLayer',
      'DrawingCanvasLayersItem',
    ]);
    expectConsistent(ir, ['Drawing']);
  });

  it('keeps the singular name when no sibling takes it', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Drawing: {
            type: 'object',
            properties: { title: { type: 'string' }, layers: layersArray, markers: layersMap },
          },
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      title: str,
      layers: { kind: 'array', items: model('DrawingLayer') },
      markers: { kind: 'map', valueType: model('DrawingMarker') },
    });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Drawing', 'DrawingLayer', 'DrawingMarker']);
    expectConsistent(ir, ['Drawing']);
  });

  it('an inline enum sibling takes the name too, and document order does not matter', async () => {
    // `layers` is declared before `layer`, and `layer` is an enum: the enum
    // mints `DrawingLayer`, so the items still step aside.
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Drawing: {
            type: 'object',
            properties: { layers: layersArray, layer: { type: 'string', enum: ['base', 'overlay'] } },
          },
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layers: { kind: 'array', items: model('DrawingLayersItem') },
      layer: { kind: 'enum', name: 'DrawingLayer', values: ['base', 'overlay'] },
    });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Drawing', 'DrawingLayersItem']);
    expect(ir.enums.map((e) => e.name)).toContain('DrawingLayer');
    expectConsistent(ir, ['Drawing']);
  });
});

describe('singular siblings: only name-minting siblings count, and identical shapes share (#206)', () => {
  const str = { kind: 'primitive', type: 'string' };
  const bool = { kind: 'primitive', type: 'boolean' };
  const num = { kind: 'primitive', type: 'number' };
  const model = (name: string) => ({ kind: 'model', name });
  const shape: SchemaObject = {
    type: 'object',
    properties: { visible: { type: 'boolean' }, opacity: { type: 'number' } },
    required: ['visible'],
  };
  const info = { title: 'sharing', version: '1' };

  async function parseWithoutWarnings(spec: Record<string, unknown>): Promise<Awaited<ReturnType<typeof parseSpec>>> {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(spec);
      expect(warnSpy).not.toHaveBeenCalled();
      return ir;
    } finally {
      warnSpy.mockRestore();
    }
  }

  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = modelRefsIn(ir.models);
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
  }

  it('shares one model when the singular sibling is an inline object of the identical shape', async () => {
    // Same shape, different wording and nullability on the sibling — the
    // WorkOS `connected_account` / `connected_accounts` pair.
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Drawing: {
            type: 'object',
            properties: {
              layer: { ...shape, type: ['object', 'null'], description: 'The active layer', title: 'Layer' },
              layers: { type: 'array', items: { ...shape, description: 'Every layer' } },
            },
          },
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layer: { kind: 'nullable', inner: model('DrawingLayer') },
      layers: { kind: 'array', items: model('DrawingLayer') },
    });
    expect(types['DrawingLayer']).toEqual({ visible: bool, opacity: num });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Drawing', 'DrawingLayer']);
    expectConsistent(ir, ['Drawing']);
  });

  it('splits into DrawingLayer and DrawingLayersItem once one property differs', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Drawing: {
            type: 'object',
            properties: {
              layer: shape,
              layers: {
                type: 'array',
                items: { ...shape, properties: { ...shape.properties, blend: { type: 'string' } } },
              },
            },
          },
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layer: model('DrawingLayer'),
      layers: { kind: 'array', items: model('DrawingLayersItem') },
    });
    expect(types['DrawingLayer']).toEqual({ visible: bool, opacity: num });
    expect(types['DrawingLayersItem']).toEqual({ visible: bool, opacity: num, blend: str });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Drawing', 'DrawingLayer', 'DrawingLayersItem']);
    expectConsistent(ir, ['Drawing']);
  });

  it('a primitive sibling claims nothing, so the items keep the singular name', async () => {
    // The WorkOS `DirectoryUser.email` / `emails` pair.
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              email: { type: ['string', 'null'] },
              emails: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { primary: { type: 'boolean' }, type: { type: 'string' }, value: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['User']).toEqual({
      email: { kind: 'nullable', inner: str },
      emails: { kind: 'array', items: model('UserEmail') },
    });
    expect(types['UserEmail']).toEqual({ primary: bool, type: str, value: str });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['User', 'UserEmail']);
    expectConsistent(ir, ['User']);
  });
});

describe('shape sharing keeps property names, and element fallbacks avoid sibling claims (#206 follow-up)', () => {
  const str = { kind: 'primitive', type: 'string' };
  const int = { kind: 'primitive', type: 'integer' };
  const num = { kind: 'primitive', type: 'number' };
  const bool = { kind: 'primitive', type: 'boolean' };
  const model = (name: string) => ({ kind: 'model', name });
  const obj = (properties: Record<string, SchemaObject>, extra: Partial<SchemaObject> = {}): SchemaObject => ({
    type: 'object',
    properties,
    ...extra,
  });
  const info = { title: 'round 8', version: '1' };

  async function parseWithoutWarnings(spec: Record<string, unknown>): Promise<Awaited<ReturnType<typeof parseSpec>>> {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(spec);
      expect(warnSpy).not.toHaveBeenCalled();
      return ir;
    } finally {
      warnSpy.mockRestore();
    }
  }

  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = modelRefsIn(ir.models);
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
  }

  it('does not share when a property named `description` differs in type', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Drawing: obj({
            layer: obj({ description: { type: 'string' } }),
            layers: { type: 'array', items: obj({ description: { type: 'integer' } }) },
          }),
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layer: model('DrawingLayer'),
      layers: { kind: 'array', items: model('DrawingLayersItem') },
    });
    expect(types['DrawingLayer']).toEqual({ description: str });
    expect(types['DrawingLayersItem']).toEqual({ description: int });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Drawing', 'DrawingLayer', 'DrawingLayersItem']);
    expectConsistent(ir, ['Drawing']);
  });

  it('keeps a property named `title` apart from the `title` keyword', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          // A `title` property of differing type: split, whatever the keywords say.
          Drawing: obj({
            layer: obj({ title: { type: 'string' } }, { title: 'Layer', description: 'The layer' }),
            layers: { type: 'array', items: obj({ title: { type: 'number' } }, { title: 'Layer' }) },
          }),
          // Same `title` property, different documentation keywords: still shared.
          Canvas: obj({
            layer: obj({ title: { type: 'string' } }, { title: 'Layer', description: 'Primary' }),
            layers: { type: 'array', items: obj({ title: { type: 'string' } }, { description: 'All of them' }) },
          }),
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layer: model('DrawingLayer'),
      layers: { kind: 'array', items: model('DrawingLayersItem') },
    });
    expect(types['DrawingLayer']).toEqual({ title: str });
    expect(types['DrawingLayersItem']).toEqual({ title: num });
    expect(types['Canvas']).toEqual({
      layer: model('CanvasLayer'),
      layers: { kind: 'array', items: model('CanvasLayer') },
    });
    expect(types['CanvasLayer']).toEqual({ title: str });
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'Canvas',
      'CanvasLayer',
      'Drawing',
      'DrawingLayer',
      'DrawingLayersItem',
    ]);
    expectConsistent(ir, ['Drawing', 'Canvas']);
  });

  it('the array fallback steps past a sibling that already claims `<Field>Item`', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Drawing: obj({
            layer: obj({ name: { type: 'string' } }),
            layers: { type: 'array', items: obj({ visible: { type: 'boolean' } }) },
            layers_item: obj({ opacity: { type: 'number' } }),
          }),
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layer: model('DrawingLayer'),
      layers: { kind: 'array', items: model('DrawingLayersArrayItem') },
      layers_item: model('DrawingLayersItem'),
    });
    expect(types['DrawingLayer']).toEqual({ name: str });
    expect(types['DrawingLayersItem']).toEqual({ opacity: num });
    expect(types['DrawingLayersArrayItem']).toEqual({ visible: bool });
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'Drawing',
      'DrawingLayer',
      'DrawingLayersArrayItem',
      'DrawingLayersItem',
    ]);
    expectConsistent(ir, ['Drawing']);
  });

  it('the map fallback steps past a sibling that already claims `<Field>Value`', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {},
      components: {
        schemas: {
          Drawing: obj({
            layer: obj({ name: { type: 'string' } }),
            layers: { type: 'object', additionalProperties: obj({ visible: { type: 'boolean' } }) },
            layers_value: obj({ opacity: { type: 'number' } }),
          }),
        },
      },
    });

    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layer: model('DrawingLayer'),
      layers: { kind: 'map', valueType: model('DrawingLayersMemberValue') },
      layers_value: model('DrawingLayersValue'),
    });
    expect(types['DrawingLayer']).toEqual({ name: str });
    expect(types['DrawingLayersValue']).toEqual({ opacity: num });
    expect(types['DrawingLayersMemberValue']).toEqual({ visible: bool });
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'Drawing',
      'DrawingLayer',
      'DrawingLayersMemberValue',
      'DrawingLayersValue',
    ]);
    expectConsistent(ir, ['Drawing']);
  });
});

describe('inline response objects materialize every variant, item and value model', () => {
  const str = { kind: 'primitive', type: 'string' };
  const num = { kind: 'primitive', type: 'number' };
  const model = (name: string) => ({ kind: 'model', name });
  const circle: SchemaObject = {
    type: 'object',
    properties: { kind: { type: 'string', const: 'circle' }, radius: { type: 'number' } },
  };
  const square: SchemaObject = {
    type: 'object',
    properties: { kind: { type: 'string', const: 'square' }, side: { type: 'number' } },
  };
  const byRadius: SchemaObject = { type: 'object', properties: { radius: { type: 'number' } } };
  const bySide: SchemaObject = { type: 'object', properties: { side: { type: 'number' } } };
  const point: SchemaObject = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } };
  // `id` keeps a single-field response from being read as a resource wrapper.
  const id: SchemaObject = { type: 'string' };
  const info = { title: 'responses', version: '1' };

  /** Every `{ kind: 'model', name }` anywhere inside a value. */
  function modelRefsAnywhere(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => modelRefsAnywhere(v, out));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record['kind'] === 'model' && typeof record['name'] === 'string') out.add(record['name']);
      for (const v of Object.values(record)) modelRefsAnywhere(v, out);
    }
    return out;
  }

  type ResponseCase = {
    label: string;
    properties: Record<string, SchemaObject>;
    /** The fields the inline model gets, given its name. */
    fields: (base: string) => Record<string, unknown>;
    /** The nested models those fields reference, given the inline model's name. */
    models: (base: string) => string[];
  };
  const cases: ResponseCase[] = [
    {
      label: 'a oneOf of two plain objects',
      properties: { id, shape: { oneOf: [byRadius, bySide] } },
      fields: (b) => ({
        id: str,
        shape: { kind: 'union', compositionKind: 'oneOf', variants: [model(`${b}Shape`), model(`${b}Shape2`)] },
      }),
      models: (b) => [`${b}Shape`, `${b}Shape2`],
    },
    {
      label: 'a const-discriminated oneOf',
      properties: { id, shape: { oneOf: [circle, square] } },
      fields: (b) => ({
        id: str,
        shape: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model(`${b}Shape`), model(`Square${b}Shape`)],
          discriminator: { property: 'kind', mapping: { circle: `${b}Shape`, square: `Square${b}Shape` } },
        },
      }),
      models: (b) => [`${b}Shape`, `Square${b}Shape`],
    },
    {
      label: 'a nullable second variant',
      properties: { id, shape: { oneOf: [byRadius, { ...bySide, type: ['object', 'null'] }] } },
      fields: (b) => ({
        id: str,
        shape: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model(`${b}Shape`), { kind: 'nullable', inner: model(`${b}Shape2`) }],
        },
      }),
      models: (b) => [`${b}Shape`, `${b}Shape2`],
    },
    {
      label: 'an array whose items are a oneOf',
      properties: { id, markers: { type: 'array', items: { oneOf: [byRadius, bySide] } } },
      fields: (b) => ({
        id: str,
        markers: {
          kind: 'array',
          items: { kind: 'union', compositionKind: 'oneOf', variants: [model(`${b}Marker`), model(`${b}Marker2`)] },
        },
      }),
      models: (b) => [`${b}Marker`, `${b}Marker2`],
    },
    {
      label: 'a map with inline object values',
      properties: { id, layers: { type: 'object', additionalProperties: point } },
      fields: (b) => ({ id: str, layers: { kind: 'map', valueType: model(`${b}Layer`) } }),
      models: (b) => [`${b}Layer`],
    },
  ];

  async function parseWithoutWarnings(spec: Record<string, unknown>): Promise<Awaited<ReturnType<typeof parseSpec>>> {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(spec);
      expect(warnSpy).not.toHaveBeenCalled();
      return ir;
    } finally {
      warnSpy.mockRestore();
    }
  }

  /** Every model ref in the operation and in every model resolves; every model is referenced. */
  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>): void {
    const referenced = modelRefsAnywhere(ir.services.flatMap((s) => s.operations));
    for (const m of ir.models) modelRefsAnywhere(m.fields, referenced);
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !referenced.has(name))).toEqual([]);
  }

  const operation = (schema: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info,
    paths: {
      '/things': {
        get: {
          operationId: 'listThings',
          responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
        },
      },
    },
  });

  it.each(cases)('$label, as a direct inline response', async ({ properties, fields, models }) => {
    const ir = await parseWithoutWarnings(operation({ type: 'object', properties }));
    const op = ir.services.flatMap((s) => s.operations)[0]!;
    expect(op.response).toEqual(model('ListThingsResponse'));
    const types = fieldTypesByModel(ir.models);
    expect(types['ListThingsResponse']).toEqual(fields('ListThingsResponse'));
    expect(ir.models.map((m) => m.name).sort()).toEqual(['ListThingsResponse', ...models('ListThingsResponse')].sort());
    expectConsistent(ir);
  });

  it.each(cases)('$label, on the items of a list envelope', async ({ properties, fields, models }) => {
    const ir = await parseWithoutWarnings(
      operation({
        type: 'object',
        properties: {
          object: { type: 'string', const: 'list' },
          data: { type: 'array', items: { type: 'object', properties } },
          list_metadata: { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } } },
        },
      }),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['ListThingsItem']).toEqual(fields('ListThingsItem'));
    const names = new Set(ir.models.map((m) => m.name));
    for (const nested of models('ListThingsItem')) expect(names.has(nested)).toBe(true);
    expectConsistent(ir);
  });

  it('shows the const-discriminated second variant with its own fields', async () => {
    const ir = await parseWithoutWarnings(operation({ type: 'object', properties: cases[1]!.properties }));
    const types = fieldTypesByModel(ir.models);
    expect(types['ListThingsResponseShape']).toEqual({ kind: { kind: 'literal', value: 'circle' }, radius: num });
    expect(types['SquareListThingsResponseShape']).toEqual({ kind: { kind: 'literal', value: 'square' }, side: num });
  });
});

describe('a field augmenting a $ref component via allOf gets its model in every context', () => {
  const str = { kind: 'primitive', type: 'string' };
  const num = { kind: 'primitive', type: 'number' };
  const model = (name: string) => ({ kind: 'model', name });
  const components: Record<string, SchemaObject> = {
    Base: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, meta: { type: 'object', properties: { tag: { type: 'string' } } } },
    },
    Other: { type: 'object', properties: { note: { type: 'string' } } },
  };
  const augmented: SchemaObject = {
    allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { extra: { type: 'string' } } }],
  };
  const id: SchemaObject = { type: 'string' };
  const info = { title: 'augmentation', version: '1' };

  /** Every `{ kind: 'model', name }` anywhere inside a value. */
  function modelRefsAnywhere(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => modelRefsAnywhere(v, out));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record['kind'] === 'model' && typeof record['name'] === 'string') out.add(record['name']);
      for (const v of Object.values(record)) modelRefsAnywhere(v, out);
    }
    return out;
  }

  async function parseWithoutWarnings(spec: Record<string, unknown>): Promise<Awaited<ReturnType<typeof parseSpec>>> {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(spec);
      expect(warnSpy).not.toHaveBeenCalled();
      return ir;
    } finally {
      warnSpy.mockRestore();
    }
  }

  /** Every ref resolves; every model other than a component is referenced. */
  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = modelRefsAnywhere(ir.services.flatMap((s) => s.operations));
    for (const m of ir.models) modelRefsAnywhere(m.fields, referenced);
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
  }

  /** The merged augmentation model: the component's fields first, then the inline ones. */
  const mergedFields = (detail: string) => ({ id: str, meta: model(`${detail}Meta`), extra: str });

  const withComponents = (schemas: Record<string, SchemaObject>) => ({
    openapi: '3.1.0',
    info,
    paths: {},
    components: { schemas: { ...components, ...schemas } },
  });
  const operation = (operationId: string, body: SchemaObject | null, response: SchemaObject) => ({
    openapi: '3.1.0',
    info,
    paths: {
      '/things': {
        post: {
          operationId,
          ...(body ? { requestBody: { content: { 'application/json': { schema: body } } } } : {}),
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: response } } } },
        },
      },
    },
    components: { schemas: components },
  });

  it('on a component schema field', async () => {
    const ir = await parseWithoutWarnings(
      withComponents({ Thing: { type: 'object', properties: { id, detail: augmented } } }),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['Thing']).toEqual({ id: str, detail: model('ThingDetail') });
    expect(types['ThingDetail']).toEqual(mergedFields('ThingDetail'));
    expect(types['ThingDetailMeta']).toEqual({ tag: str });
    expect(ir.models.find((m) => m.name === 'ThingDetail')?.fields.find((f) => f.name === 'id')?.required).toBe(true);
    expectConsistent(ir, ['Base', 'Other', 'Thing']);
  });

  it('on an inline request-body field', async () => {
    const ir = await parseWithoutWarnings(
      operation(
        'createThing',
        { type: 'object', properties: { id, detail: augmented } },
        { type: 'object', properties: { ok: { type: 'boolean' } } },
      ),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['CreateThingRequest']).toEqual({ id: str, detail: model('CreateThingRequestDetail') });
    expect(types['CreateThingRequestDetail']).toEqual(mergedFields('CreateThingRequestDetail'));
    expectConsistent(ir, ['Base', 'Other']);
  });

  it('on an inline response field, and two levels down (the reported case)', async () => {
    const ir = await parseWithoutWarnings(
      operation('getDrawing', null, {
        type: 'object',
        properties: {
          id,
          detail: augmented,
          canvas: { type: 'object', properties: { name: { type: 'string' }, detail: augmented } },
        },
      }),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['GetDrawingResponse']).toEqual({
      id: str,
      detail: model('GetDrawingResponseDetail'),
      canvas: model('GetDrawingResponseCanvas'),
    });
    expect(types['GetDrawingResponseDetail']).toEqual(mergedFields('GetDrawingResponseDetail'));
    expect(types['GetDrawingResponseCanvas']).toEqual({ name: str, detail: model('GetDrawingResponseCanvasDetail') });
    expect(types['GetDrawingResponseCanvasDetail']).toEqual(mergedFields('GetDrawingResponseCanvasDetail'));
    expectConsistent(ir, ['Base', 'Other']);
  });

  it('stays a plain reference when the allOf holds only $refs', async () => {
    const ir = await parseWithoutWarnings(
      withComponents({
        Thing: {
          type: 'object',
          properties: {
            id,
            one: { allOf: [{ $ref: '#/components/schemas/Base' }] },
            two: { allOf: [{ $ref: '#/components/schemas/Base' }, { $ref: '#/components/schemas/Other' }] },
          },
        },
      }),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['Thing']).toEqual({ id: str, one: model('Base'), two: model('Base') });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Base', 'BaseMeta', 'Other', 'Thing']);
    expectConsistent(ir, ['Base', 'Other', 'Thing']);
  });

  it('inside an array item and inside a oneOf variant', async () => {
    const ir = await parseWithoutWarnings(
      withComponents({
        Thing: {
          type: 'object',
          properties: {
            id,
            items: { type: 'array', items: { type: 'object', properties: { detail: augmented } } },
            shape: {
              oneOf: [
                { type: 'object', properties: { detail: augmented } },
                { type: 'object', properties: { side: { type: 'number' } } },
              ],
            },
          },
        },
      }),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['ThingItem']).toEqual({ detail: model('ThingItemDetail') });
    expect(types['ThingItemDetail']).toEqual(mergedFields('ThingItemDetail'));
    expect(types['ThingShape']).toEqual({ detail: model('ThingShapeDetail') });
    expect(types['ThingShapeDetail']).toEqual(mergedFields('ThingShapeDetail'));
    expect(types['ThingShape2']).toEqual({ side: num });
    expectConsistent(ir, ['Base', 'Other', 'Thing']);
  });
});
