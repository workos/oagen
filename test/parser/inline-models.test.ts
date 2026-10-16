import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { nameInlineVariantEntries, schemaToTypeRef, type SchemaObject } from '../../src/parser/schemas.js';
import {
  MAX_ELEMENT_CONTEXT_ATTEMPTS,
  elementContextDecision,
  extractInlineModelsFromProperties,
  extractInlineModelsFromSchemas,
  firstFreeElementContext,
  mintedInlineNameEntries,
} from '../../src/parser/inline-models.js';
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

  it('names the TypeRef variants from their distinguishing property, matching the extractor', () => {
    const union = schemaToTypeRef({ oneOf: [byRadius, bySide, byPoints] }, 'shape', 'Drawing');
    expect(unionVariantNames(union)).toEqual(['DrawingShape', 'DrawingShapeWithSide', 'DrawingShapeWithPoints']);
    expect(unionVariantNames(schemaToTypeRef({ anyOf: [byRadius, bySide] }, 'shape', 'Drawing'))).toEqual([
      'DrawingShape',
      'DrawingShapeWithSide',
    ]);

    const results: Model[] = [];
    extractInlineModelsFromProperties(
      { type: 'object', properties: { shape: { oneOf: [byRadius, bySide, byPoints] } } },
      results,
      'Drawing',
    );
    expect(results.map((model) => model.name)).toEqual([
      'DrawingShape',
      'DrawingShapeWithSide',
      'DrawingShapeWithPoints',
    ]);
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
      expect(unionVariantNames(drawing['shape'])).toEqual(['DrawingShape', 'DrawingShapeWithSide']);
      expect(unionVariantNames(drawing['markers'])).toEqual(['DrawingMarker', 'DrawingMarkerWithSide']);
      expect(ir.models.map((model) => model.name).sort()).toEqual([
        'Drawing',
        'DrawingMarker',
        'DrawingMarkerWithSide',
        'DrawingShape',
        'DrawingShapeWithSide',
      ]);
      expect(fieldTypesByModel(ir.models)['DrawingShapeWithSide']).toEqual({
        side: { kind: 'primitive', type: 'number' },
      });
      expect(fieldTypesByModel(ir.models)['DrawingMarkerWithSide']).toEqual({
        side: { kind: 'primitive', type: 'number' },
      });
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
      expect(unionVariantNames(body['markers'])).toEqual([
        'CreateDrawingRequestMarker',
        'CreateDrawingRequestMarkerWithSide',
      ]);
      expect(ir.models.map((model) => model.name).sort()).toEqual([
        'CreateDrawingRequest',
        'CreateDrawingRequestMarker',
        'CreateDrawingRequestMarkerWithSide',
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
  // const discriminator (`shape`) and without one (`markers`, named from the
  // variant's distinguishing property).
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
            { kind: 'nullable', inner: { kind: 'model', name: 'DrawingMarkerWithSide' } },
          ],
        },
      });
      expect(ir.models.map((model) => model.name).sort()).toEqual([
        'Drawing',
        'DrawingMarker',
        'DrawingMarkerWithSide',
        'DrawingShape',
        'SquareDrawingShape',
      ]);
      expect(fieldTypesByModel(ir.models)['SquareDrawingShape']).toEqual({
        kind: { kind: 'literal', value: 'square' },
        side: { kind: 'primitive', type: 'number' },
      });
      expect(fieldTypesByModel(ir.models)['DrawingMarkerWithSide']).toEqual({
        side: { kind: 'primitive', type: 'number' },
      });
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
        { kind: 'nullable', inner: { kind: 'model', name: 'DrawingShapeWithSide' } },
      ],
    });
    const results: Model[] = [];
    extractInlineModelsFromProperties(
      { type: 'object', properties: { shape: { anyOf: [byRadius, nullableSide] } } },
      results,
      'Drawing',
    );
    expect(results.map((model) => model.name)).toEqual(['DrawingShape', 'DrawingShapeWithSide']);
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
          variants: [{ kind: 'model', name: 'ThingShape' }, second('ThingShapeWithSide')],
        },
        markers: {
          kind: 'array',
          items: {
            kind: 'union',
            compositionKind: 'oneOf',
            variants: [{ kind: 'model', name: 'ThingMarker' }, second('ThingMarkerWithSide')],
          },
        },
      });
      expect(types['ThingShape']).toEqual({ radius: num, center: { kind: 'model', name: 'ThingShapeCenter' } });
      expect(types['ThingShapeWithSide']).toEqual({
        side: num,
        center: { kind: 'model', name: 'ThingShapeWithSideCenter' },
      });
      expect(types['ThingMarker']).toEqual({ radius: num, center: { kind: 'model', name: 'ThingMarkerCenter' } });
      expect(types['ThingMarkerWithSide']).toEqual({
        side: num,
        center: { kind: 'model', name: 'ThingMarkerWithSideCenter' },
      });
      for (const nested of [
        'ThingShapeCenter',
        'ThingShapeWithSideCenter',
        'ThingMarkerCenter',
        'ThingMarkerWithSideCenter',
      ]) {
        expect(types[nested]).toEqual(point);
      }
      expect(ir.models.map((model) => model.name).sort()).toEqual([
        'Thing',
        'ThingMarker',
        'ThingMarkerCenter',
        'ThingMarkerWithSide',
        'ThingMarkerWithSideCenter',
        'ThingShape',
        'ThingShapeCenter',
        'ThingShapeWithSide',
        'ThingShapeWithSideCenter',
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
  // multi-type schema, and the names (from each variant's distinguishing
  // property) are the extractor's.
  const expectedUnion = (base: string) => ({
    kind: 'union',
    compositionKind: 'oneOf',
    variants: [
      { kind: 'model', name: base },
      { kind: 'union', variants: [{ kind: 'model', name: `${base}WithSide` }, str] },
      { kind: 'nullable', inner: { kind: 'union', variants: [{ kind: 'model', name: `${base}WithPoints` }, int] } },
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
        expect(types[`${base}WithSide`]).toEqual({
          side: num,
          center: { kind: 'model', name: `${base}WithSideCenter` },
        });
        expect(types[`${base}WithPoints`]).toEqual({
          points: int,
          center: { kind: 'model', name: `${base}WithPointsCenter` },
        });
        for (const suffix of ['', 'WithSide', 'WithPoints']) {
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
      'ThingShapeWithSide',
      'ThingShapeWithSideCenter',
      'ThingShapeWithPoints',
      'ThingShapeWithPointsCenter',
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
        array({ kind: 'union', compositionKind: 'oneOf', variants: [model(`${v}Item`), model(`${v}ItemWithLabel`)] }),
      models: (v) => [`${v}Item`, `${v}ItemWithLabel`],
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
        shape: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('ThingShape'), second('ThingShapeWithSide')],
        },
        markers: array({
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('ThingMarker'), second('ThingMarkerWithSide')],
        }),
      });
      expect(types['ThingShapeWithSide']).toEqual({ side: num });
      expect(types['ThingMarkerWithSide']).toEqual({ side: num });
      expect(ir.models.map((m) => m.name).sort()).toEqual(
        [
          'Gadget',
          'Thing',
          'ThingShape',
          'ThingShapeWithSide',
          ...models('ThingShapeWithSide'),
          'ThingMarker',
          'ThingMarkerWithSide',
          ...models('ThingMarkerWithSide'),
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
      'ThingShapeWithSide',
      'ThingShapeWithSideItem',
      'ThingShapeWithSideItemOrigin',
    ]);
    expect(fieldTypesByModel(results)['ThingShapeWithSideItem']).toEqual({
      x: num,
      origin: model('ThingShapeWithSideItemOrigin'),
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
        shape: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('ThingShape'), second('ThingShapeWithSide')],
        },
        markers: array({
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('ThingMarker'), second('ThingMarkerWithSide')],
        }),
      });
      for (const v of ['ThingShapeWithSide', 'ThingMarkerWithSide']) {
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
        shape: { kind: 'union', compositionKind: 'oneOf', variants: [model(`${b}Shape`), model(`${b}ShapeWithSide`)] },
      }),
      models: (b) => [`${b}Shape`, `${b}ShapeWithSide`],
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
          variants: [model(`${b}Shape`), { kind: 'nullable', inner: model(`${b}ShapeWithSide`) }],
        },
      }),
      models: (b) => [`${b}Shape`, `${b}ShapeWithSide`],
    },
    {
      label: 'an array whose items are a oneOf',
      properties: { id, markers: { type: 'array', items: { oneOf: [byRadius, bySide] } } },
      fields: (b) => ({
        id: str,
        markers: {
          kind: 'array',
          items: {
            kind: 'union',
            compositionKind: 'oneOf',
            variants: [model(`${b}Marker`), model(`${b}MarkerWithSide`)],
          },
        },
      }),
      models: (b) => [`${b}Marker`, `${b}MarkerWithSide`],
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

  /**
   * The merged augmentation model: the component's fields first, typed as
   * the component types them (`meta` stays `BaseMeta`, no copy under the
   * merged model's name), then the inline ones.
   */
  const mergedFields = (_detail: string) => ({ id: str, meta: model('BaseMeta'), extra: str });

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
    expect(types['BaseMeta']).toEqual({ tag: str });
    expect(types['ThingDetailMeta']).toBeUndefined();
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
    expect(types['ThingShapeWithSide']).toEqual({ side: num });
    expectConsistent(ir, ['Base', 'Other', 'Thing']);
  });
});

describe('a component that extends itself through a field stays finite', () => {
  const str = { kind: 'primitive', type: 'string' };
  const model = (name: string) => ({ kind: 'model', name });
  const info = { title: 'cycles', version: '1' };
  const withComponents = (schemas: Record<string, SchemaObject>) => ({
    openapi: '3.1.0',
    info,
    paths: {},
    components: { schemas },
  });

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

  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = modelRefsAnywhere(ir.services.flatMap((s) => s.operations));
    for (const m of ir.models) modelRefsAnywhere(m.fields, referenced);
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
  }

  it('the reported self-reference: Base.child extends Base, terminates, inherits, and points back at BaseChild', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(
        withComponents({
          Base: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              meta: { type: 'object', properties: { tag: { type: 'string' } } },
              child: { allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { extra: { type: 'string' } } }] },
            },
          },
        }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
      const types = fieldTypesByModel(ir.models);
      expect(types['Base']).toEqual({ id: str, meta: model('BaseMeta'), child: model('BaseChild') });
      expect(types['BaseChild']).toEqual({ id: str, meta: model('BaseMeta'), child: model('BaseChild'), extra: str });
      expect(types['BaseMeta']).toEqual({ tag: str });
      expect(ir.models.map((m) => m.name).sort()).toEqual(['Base', 'BaseChild', 'BaseMeta']);
      expectConsistent(ir, ['Base']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a two-component cycle: A.child extends B and B.child extends A', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(
        withComponents({
          A: {
            type: 'object',
            properties: {
              a: { type: 'string' },
              child: { allOf: [{ $ref: '#/components/schemas/B' }, { properties: { x: { type: 'string' } } }] },
            },
          },
          B: {
            type: 'object',
            properties: {
              b: { type: 'string' },
              child: { allOf: [{ $ref: '#/components/schemas/A' }, { properties: { y: { type: 'string' } } }] },
            },
          },
        }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
      const types = fieldTypesByModel(ir.models);
      expect(types['A']).toEqual({ a: str, child: model('AChild') });
      expect(types['AChild']).toEqual({ b: str, child: model('BChild'), x: str });
      expect(types['B']).toEqual({ b: str, child: model('BChild') });
      expect(types['BChild']).toEqual({ a: str, child: model('AChild'), y: str });
      expect(ir.models.map((m) => m.name).sort()).toEqual(['A', 'AChild', 'B', 'BChild']);
      expectConsistent(ir, ['A', 'B']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reusing a component in nested augmentations is not a cycle: every level inherits the full field list', async () => {
    // Greptile's case: `Thing.detail` extends `Base` and adds `again`, which
    // extends `Base` too. The inner model keeps `id` and its `required` flag.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(
        withComponents({
          Base: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          Thing: {
            type: 'object',
            properties: {
              detail: {
                allOf: [
                  { $ref: '#/components/schemas/Base' },
                  {
                    properties: {
                      again: {
                        allOf: [{ $ref: '#/components/schemas/Base' }, { properties: { z: { type: 'string' } } }],
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
      const types = fieldTypesByModel(ir.models);
      expect(types['ThingDetail']).toEqual({ id: str, again: model('ThingDetailAgain') });
      expect(types['ThingDetailAgain']).toEqual({ id: str, z: str });
      for (const name of ['ThingDetail', 'ThingDetailAgain']) {
        const idField = ir.models.find((m) => m.name === name)?.fields.find((f) => f.name === 'id');
        expect(idField?.required).toBe(true);
      }
      expect(ir.models.map((m) => m.name).sort()).toEqual(['Base', 'Thing', 'ThingDetail', 'ThingDetailAgain']);
      expectConsistent(ir, ['Base', 'Thing']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a component extending itself twice over still terminates, with no warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec(
        withComponents({
          A: {
            type: 'object',
            properties: {
              a: { type: 'string' },
              child: {
                allOf: [
                  { $ref: '#/components/schemas/A' },
                  {
                    properties: {
                      again: {
                        allOf: [{ $ref: '#/components/schemas/A' }, { properties: { z: { type: 'string' } } }],
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
      const types = fieldTypesByModel(ir.models);
      expect(types['AChild']).toEqual({ a: str, child: model('AChild'), again: model('AChildAgain') });
      expect(types['AChildAgain']).toEqual({ a: str, child: model('AChild'), z: str });
      expect(ir.models.map((m) => m.name).sort()).toEqual(['A', 'AChild', 'AChildAgain']);
      expectConsistent(ir, ['A']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a deliberately deep document (70 nested arrays of inline objects) parses with every reference resolved', async () => {
    let items: SchemaObject = { type: 'object', properties: { leaf: { type: 'string' } } };
    let expected: unknown = model('CreateThingRequestLevel');
    for (let depth = 0; depth < 70; depth++) {
      items = { type: 'array', items };
      expected = { kind: 'array', items: expected };
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseTempSpec({
        openapi: '3.1.0',
        info,
        paths: {
          '/things': {
            post: {
              operationId: 'createThing',
              requestBody: {
                content: { 'application/json': { schema: { type: 'object', properties: { level: items } } } },
              },
              responses: { '204': { description: 'ok' } },
            },
          },
        },
      });
      expect(warnSpy).not.toHaveBeenCalled();
      const types = fieldTypesByModel(ir.models);
      expect(types['CreateThingRequest']).toEqual({ level: expected });
      expect(types['CreateThingRequestLevel']).toEqual({ leaf: str });
      expect(ir.models.map((m) => m.name).sort()).toEqual(['CreateThingRequest', 'CreateThingRequestLevel']);
      expectConsistent(ir, []);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('undiscriminated inline variants are named from their content', () => {
  const num = { kind: 'primitive', type: 'number' };
  const str = { kind: 'primitive', type: 'string' };
  const int = { kind: 'primitive', type: 'integer' };
  const model = (name: string) => ({ kind: 'model', name });
  const nullable = (inner: unknown) => ({ kind: 'nullable', inner });
  const union = (variants: unknown[], compositionKind: 'oneOf' | 'anyOf' = 'oneOf') => ({
    kind: 'union',
    compositionKind,
    variants,
  });
  const n: SchemaObject = { type: 'number' };
  const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
    type: 'object',
    properties,
    ...extra,
  });
  const center = obj({ x: n, y: n });
  const point = { x: num, y: num };
  const byRadius = obj({ radius: n });
  const bySide = obj({ side: n });
  const byPoints = obj({ points: { type: 'integer' } });
  const circle = obj({ radius: n, center }, { title: 'Circle' });
  const square = obj({ side: n, center }, { title: 'Square' });

  /** Every model name referenced from any model field or any operation's body or response. */
  function referencedEverywhere(ir: Awaited<ReturnType<typeof parseSpec>>): Set<string> {
    const names = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record['kind'] === 'model' && typeof record['name'] === 'string') names.add(record['name']);
        Object.values(record).forEach(visit);
      }
    };
    for (const m of ir.models) visit(m.fields);
    for (const op of ir.services.flatMap((s) => s.operations)) {
      visit([op.requestBody, op.response, op.pagination?.envelopeFields]);
    }
    return names;
  }

  /** Every reference resolves to a model, and every model other than `roots` is referenced. */
  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = referencedEverywhere(ir);
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
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

  /** One union in four contexts: a component field, the items of a component array, an inline request-body field and an inline response field. */
  const inFourContexts = (field: SchemaObject) => ({
    openapi: '3.1.0',
    info: { title: 'variant names', version: '1' },
    paths: {
      '/drawings': {
        post: {
          operationId: 'createDrawing',
          requestBody: { content: { 'application/json': { schema: obj({ shape: field }) } } },
          responses: { '204': { description: 'ok' } },
        },
        get: {
          operationId: 'listDrawings',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: obj({ id: { type: 'string' }, shape: field }) } },
            },
          },
        },
      },
    },
    components: { schemas: { Drawing: obj({ shape: field, markers: { type: 'array', items: field } }) } },
  });

  type Case = {
    label: string;
    field: SchemaObject;
    /** The field's TypeRef, given the union's base name. */
    type: (base: string) => unknown;
    /** The variant models and everything nested under them (name → fields), given the base name. */
    models: (base: string) => Record<string, Record<string, unknown>>;
  };
  const titled = (b: string) => ({
    [`Circle${b}`]: { radius: num, center: model(`Circle${b}Center`) },
    [`Circle${b}Center`]: point,
    [`Square${b}`]: { side: num, center: model(`Square${b}Center`) },
    [`Square${b}Center`]: point,
  });
  const radiusAndSide = (b: string) => ({ [b]: { radius: num }, [`${b}WithSide`]: { side: num } });
  const cases: Case[] = [
    {
      label: 'every variant titled: variant 0 takes its title too, and nested objects follow the variant',
      field: { oneOf: [circle, square] },
      type: (b) => union([model(`Circle${b}`), model(`Square${b}`)]),
      models: titled,
    },
    {
      label: 'no title: the distinguishing property',
      field: { oneOf: [byRadius, bySide] },
      type: (b) => union([model(b), model(`${b}WithSide`)]),
      models: radiusAndSide,
    },
    {
      label: 'anyOf too',
      field: { anyOf: [byRadius, bySide] },
      type: (b) => union([model(b), model(`${b}WithSide`)], 'anyOf'),
      models: radiusAndSide,
    },
    {
      label: 'a title on a later variant only; variant 0 stays bare',
      field: { oneOf: [byRadius, { ...bySide, title: 'Square' }] },
      type: (b) => union([model(b), model(`Square${b}`)]),
      models: (b) => ({ [b]: { radius: num }, [`Square${b}`]: { side: num } }),
    },
    {
      label: "a title equal to an earlier variant's: the second falls through to its distinguishing property",
      field: { oneOf: [byRadius, { ...bySide, title: 'Square' }, { ...byPoints, title: 'Square' }] },
      type: (b) => union([model(b), model(`Square${b}`), model(`${b}WithPoints`)]),
      models: (b) => ({ [b]: { radius: num }, [`Square${b}`]: { side: num }, [`${b}WithPoints`]: { points: int } }),
    },
    {
      label: 'identical property sets: the counter remains',
      field: { oneOf: [byRadius, obj({ radius: { type: 'string' } })] },
      type: (b) => union([model(b), model(`${b}2`)]),
      models: (b) => ({ [b]: { radius: num }, [`${b}2`]: { radius: str } }),
    },
    {
      label: "a property set that adds nothing to another variant's: the counter remains",
      field: { oneOf: [obj({ radius: n, side: n }), bySide] },
      type: (b) => union([model(b), model(`${b}2`)]),
      models: (b) => ({ [b]: { radius: num, side: num }, [`${b}2`]: { side: num } }),
    },
    {
      label: "the first distinguishing property in the variant's own order, skipping shared ones",
      field: { oneOf: [obj({ shared: n, radius: n }), obj({ shared: n, side: n, extra: n })] },
      type: (b) => union([model(b), model(`${b}WithSide`)]),
      models: (b) => ({
        [b]: { shared: num, radius: num },
        [`${b}WithSide`]: { shared: num, side: num, extra: num },
      }),
    },
    {
      label: 'a nullable titled variant keeps its wrapper',
      field: { oneOf: [circle, { ...square, type: ['object', 'null'] }] },
      type: (b) => union([model(`Circle${b}`), nullable(model(`Square${b}`))]),
      models: titled,
    },
    {
      label: 'a nullable untitled variant keeps its wrapper',
      field: { oneOf: [byRadius, { ...bySide, type: ['object', 'null'] }] },
      type: (b) => union([model(b), nullable(model(`${b}WithSide`))]),
      models: radiusAndSide,
    },
    {
      label: 'a multi-type variant keeps its other type',
      field: { oneOf: [byRadius, { ...bySide, type: ['object', 'string'] }] },
      type: (b) => union([model(b), { kind: 'union', variants: [model(`${b}WithSide`), str] }]),
      models: radiusAndSide,
    },
  ];

  it.each(cases)(
    '$label — on a component field, array items, a request body and an inline response',
    async ({ field, type, models }) => {
      const ir = await parseWithoutWarnings(inFourContexts(field));
      const types = fieldTypesByModel(ir.models);
      expect(types['Drawing']!['shape']).toEqual(type('DrawingShape'));
      expect(types['Drawing']!['markers']).toEqual({ kind: 'array', items: type('DrawingMarker') });
      expect(types['CreateDrawingRequest']!['shape']).toEqual(type('CreateDrawingRequestShape'));
      expect(types['ListDrawingsResponse']!['shape']).toEqual(type('ListDrawingsResponseShape'));
      const expected = {
        ...models('DrawingShape'),
        ...models('DrawingMarker'),
        ...models('CreateDrawingRequestShape'),
        ...models('ListDrawingsResponseShape'),
      };
      for (const [name, fields] of Object.entries(expected)) expect(types[name], name).toEqual(fields);
      expect(ir.models.map((m) => m.name).sort()).toEqual(
        ['Drawing', 'CreateDrawingRequest', 'ListDrawingsResponse', ...Object.keys(expected)].sort(),
      );
      expectConsistent(ir, ['Drawing']);
    },
  );

  it('a title that PascalCases to the base, or to a prefix of it, is not doubled and falls through', () => {
    for (const title of ['Drawing shape', 'drawing_shape', 'Drawing']) {
      const field: SchemaObject = { oneOf: [byRadius, { ...bySide, title }] };
      expect(schemaToTypeRef(field, 'shape', 'Drawing')).toEqual(
        union([model('DrawingShape'), model('DrawingShapeWithSide')]),
      );
      const results: Model[] = [];
      extractInlineModelsFromProperties({ type: 'object', properties: { shape: field } }, results, 'Drawing');
      expect(results.map((m) => m.name)).toEqual(['DrawingShape', 'DrawingShapeWithSide']);
    }
    // Variant 0 of an all-titled union is not doubled either.
    const allTitled: SchemaObject = {
      oneOf: [
        { ...byRadius, title: 'Drawing shape' },
        { ...bySide, title: 'Square' },
      ],
    };
    expect(schemaToTypeRef(allTitled, 'shape', 'Drawing')).toEqual(
      union([model('DrawingShape'), model('SquareDrawingShape')]),
    );
  });

  it('reordering the variants changes nothing but which one is bare', async () => {
    // Titled: the same names in either order.
    const forward = await parseWithoutWarnings(inFourContexts({ oneOf: [circle, square] }));
    const backward = await parseWithoutWarnings(inFourContexts({ oneOf: [square, circle] }));
    expect(backward.models.map((m) => m.name).sort()).toEqual(forward.models.map((m) => m.name).sort());
    expect(fieldTypesByModel(backward.models)['Drawing']!['shape']).toEqual(
      union([model('SquareDrawingShape'), model('CircleDrawingShape')]),
    );
    // Untitled: the first is bare, the other is still named from its own property, never by a counter.
    const radiusFirst = await parseWithoutWarnings(inFourContexts({ oneOf: [byRadius, bySide] }));
    const sideFirst = await parseWithoutWarnings(inFourContexts({ oneOf: [bySide, byRadius] }));
    expect(fieldTypesByModel(radiusFirst.models)['Drawing']!['shape']).toEqual(
      union([model('DrawingShape'), model('DrawingShapeWithSide')]),
    );
    expect(fieldTypesByModel(sideFirst.models)['Drawing']!['shape']).toEqual(
      union([model('DrawingShape'), model('DrawingShapeWithRadius')]),
    );
    expect(fieldTypesByModel(sideFirst.models)['DrawingShape']).toEqual({ side: num });
    expect(fieldTypesByModel(sideFirst.models)['DrawingShapeWithRadius']).toEqual({ radius: num });
    expectConsistent(sideFirst, ['Drawing']);
  });

  it('a const discriminator still wins over the distinguishing property, and a lone inline variant keeps the bare name', () => {
    const labeled: SchemaObject = {
      oneOf: [
        obj({ kind: { type: 'string', const: 'circle' }, radius: n }),
        obj({ kind: { type: 'string', const: 'square' }, side: n }),
      ],
    };
    expect(schemaToTypeRef(labeled, 'shape', 'Drawing')).toMatchObject({
      variants: [model('DrawingShape'), model('SquareDrawingShape')],
    });
    const results: Model[] = [];
    extractInlineModelsFromProperties({ type: 'object', properties: { shape: labeled } }, results, 'Drawing');
    expect(results.map((m) => m.name)).toEqual(['DrawingShape', 'SquareDrawingShape']);
    // A single inline variant (titled or not) has nothing to be told apart from.
    const lone: SchemaObject = { oneOf: [circle, { $ref: '#/components/schemas/Other' }] };
    expect(schemaToTypeRef(lone, 'shape', 'Drawing')).toEqual(union([model('DrawingShape'), model('Other')]));
  });

  it('a union sibling claims every name its variants mint, so array items step aside only when one matches', async () => {
    const visible = obj({ visible: { type: 'boolean' } });
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info: { title: 'siblings', version: '1' },
      paths: {},
      components: {
        schemas: {
          Drawing: obj({
            layers: { type: 'array', items: visible },
            // Mints DrawingLayer and DrawingLayerWithOpacity: `layers` steps aside.
            layer: { oneOf: [visible, obj({ opacity: n })] },
            tiles: { type: 'array', items: visible },
            // Mints SolidDrawingTile and FadeDrawingTile only: `tiles` keeps DrawingTile.
            tile: {
              oneOf: [
                obj({ visible: { type: 'boolean' } }, { title: 'Solid' }),
                obj({ opacity: n }, { title: 'Fade' }),
              ],
            },
          }),
        },
      },
    });
    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      layers: { kind: 'array', items: model('DrawingLayersItem') },
      layer: union([model('DrawingLayer'), model('DrawingLayerWithOpacity')]),
      tiles: { kind: 'array', items: model('DrawingTile') },
      tile: union([model('SolidDrawingTile'), model('FadeDrawingTile')]),
    });
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'Drawing',
      'DrawingLayer',
      'DrawingLayerWithOpacity',
      'DrawingLayersItem',
      'DrawingTile',
      'FadeDrawingTile',
      'SolidDrawingTile',
    ]);
    expectConsistent(ir, ['Drawing']);
  });

  it('a request body that is itself a oneOf names its const-less variants the same way', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info: { title: 'bodies', version: '1' },
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      obj({ a: { type: 'string' } }),
                      obj({ b: { type: 'string' } }),
                      obj({ c: n }, { title: 'Third' }),
                      obj({ kind: { type: 'string', const: 'keyed' }, d: n }),
                      obj({ a: { type: 'string' } }, { description: 'the first shape again' }),
                    ],
                  },
                },
              },
            },
            responses: { '204': { description: 'ok' } },
          },
        },
      },
    });
    const op = ir.services.flatMap((s) => s.operations)[0]!;
    expect(op.requestBody).toEqual({
      kind: 'union',
      variants: [
        model('CreateThingRequest'),
        model('CreateThingRequestWithB'),
        model('ThirdCreateThingRequest'),
        model('KeyedCreateThingRequest'),
        model('CreateThingRequest4'),
      ],
    });
    const types = fieldTypesByModel(ir.models);
    expect(types['CreateThingRequest']).toEqual({ a: str });
    expect(types['CreateThingRequestWithB']).toEqual({ b: str });
    expect(types['ThirdCreateThingRequest']).toEqual({ c: num });
    expect(types['KeyedCreateThingRequest']).toEqual({ kind: { kind: 'literal', value: 'keyed' }, d: num });
    expect(types['CreateThingRequest4']).toEqual({ a: str });
    expectConsistent(ir, []);
  });

  it('a response that is itself a oneOf materializes every const-less variant under the name the union references', async () => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info: { title: 'responses', version: '1' },
      paths: {
        '/thing': {
          get: {
            operationId: 'getThing',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': { schema: { oneOf: [byRadius, bySide, { ...byPoints, title: 'Scored' }] } },
                },
              },
              '400': {
                description: 'bad',
                content: {
                  'application/json': {
                    schema: {
                      anyOf: [
                        obj({ message: { type: 'string' } }),
                        obj({ message: { type: 'string' }, error: { type: 'string' } }),
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const op = ir.services.flatMap((s) => s.operations)[0]!;
    expect(op.response).toEqual(
      union([model('GetThingResponse'), model('GetThingResponseWithSide'), model('ScoredGetThingResponse')]),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['GetThingResponse']).toEqual({ radius: num });
    expect(types['GetThingResponseWithSide']).toEqual({ side: num });
    expect(types['ScoredGetThingResponse']).toEqual({ points: int });
    expectConsistent(ir, []);
    // Error unions are only typed, never extracted, but their variant names follow the same rule.
    expect(op.errors).toEqual([
      { statusCode: 400, type: union([model('Error400'), model('Error400WithError')], 'anyOf') },
    ]);
  });
});

describe("variant names step around the names the parent's other properties mint", () => {
  const num = { kind: 'primitive', type: 'number' };
  const str = { kind: 'primitive', type: 'string' };
  const model = (name: string) => ({ kind: 'model', name });
  const union = (variants: unknown[]) => ({ kind: 'union', compositionKind: 'oneOf', variants });
  const n: SchemaObject = { type: 'number' };
  const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
    type: 'object',
    properties,
    ...extra,
  });
  const byRadius = obj({ radius: n });
  const bySide = obj({ side: n });
  const labeled = obj({ label: { type: 'string' } });

  /** Every model name referenced from any model field or any operation's body or response. */
  function referencedEverywhere(ir: Awaited<ReturnType<typeof parseSpec>>): Set<string> {
    const names = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record['kind'] === 'model' && typeof record['name'] === 'string') names.add(record['name']);
        Object.values(record).forEach(visit);
      }
    };
    for (const m of ir.models) visit(m.fields);
    for (const op of ir.services.flatMap((s) => s.operations)) {
      visit([op.requestBody, op.response, op.pagination?.envelopeFields]);
    }
    return names;
  }

  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = referencedEverywhere(ir);
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
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

  /** The same properties on a component, an inline request body and an inline response. */
  const inThreeContexts = (properties: Record<string, SchemaObject>) => ({
    openapi: '3.1.0',
    info: { title: 'reserved names', version: '1' },
    paths: {
      '/drawings': {
        post: {
          operationId: 'createDrawing',
          requestBody: { content: { 'application/json': { schema: obj(properties) } } },
          responses: { '204': { description: 'ok' } },
        },
        get: {
          operationId: 'listDrawings',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: obj({ id: { type: 'string' }, ...properties }) } },
            },
          },
        },
      },
    },
    components: { schemas: { Drawing: obj(properties) } },
  });
  const contexts: Array<[parent: string, base: string]> = [
    ['Drawing', 'DrawingShape'],
    ['CreateDrawingRequest', 'CreateDrawingRequestShape'],
    ['ListDrawingsResponse', 'ListDrawingsResponseShape'],
  ];

  it('the reported case: a sibling `shape_with_side` object keeps `<Base>WithSide`, the variant takes the counter, in either order', async () => {
    const shape: SchemaObject = { oneOf: [byRadius, bySide] };
    for (const properties of [
      { shape_with_side: labeled, shape },
      { shape, shape_with_side: labeled },
    ]) {
      const ir = await parseWithoutWarnings(inThreeContexts(properties));
      const types = fieldTypesByModel(ir.models);
      for (const [parent, base] of contexts) {
        expect(types[parent]!['shape_with_side']).toEqual(model(`${base}WithSide`));
        expect(types[parent]!['shape']).toEqual(union([model(base), model(`${base}2`)]));
        expect(types[`${base}WithSide`]).toEqual({ label: str });
        expect(types[base]).toEqual({ radius: num });
        expect(types[`${base}2`]).toEqual({ side: num });
      }
      expectConsistent(ir, ['Drawing']);
    }
  });

  it('a title that collides with a sibling model falls through to the distinguishing property', async () => {
    // The title "Drawing circle" prefixes the base to `DrawingCircleDrawingShape`,
    // which is exactly what a sibling `circle_drawing_shape` object mints.
    const ir = await parseWithoutWarnings(
      inThreeContexts({
        circle_drawing_shape: labeled,
        shape: { oneOf: [byRadius, { ...bySide, title: 'Drawing circle' }] },
      }),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']!['circle_drawing_shape']).toEqual(model('DrawingCircleDrawingShape'));
    expect(types['Drawing']!['shape']).toEqual(union([model('DrawingShape'), model('DrawingShapeWithSide')]));
    expect(types['DrawingCircleDrawingShape']).toEqual({ label: str });
    expect(types['DrawingShapeWithSide']).toEqual({ side: num });
    expectConsistent(ir, ['Drawing']);
  });

  it('a counter that collides with a sibling model keeps counting', async () => {
    const ir = await parseWithoutWarnings(
      inThreeContexts({
        shape2: labeled,
        shape: { oneOf: [byRadius, obj({ radius: { type: 'string' } })] },
      }),
    );
    const types = fieldTypesByModel(ir.models);
    for (const [parent, base] of contexts) {
      expect(types[parent]!['shape2']).toEqual(model(`${base}2`));
      expect(types[parent]!['shape']).toEqual(union([model(base), model(`${base}3`)]));
      expect(types[`${base}2`]).toEqual({ label: str });
      expect(types[`${base}3`]).toEqual({ radius: str });
    }
    expectConsistent(ir, ['Drawing']);
  });

  it('the reference and the extractor agree when handed the same sibling set', () => {
    const properties: Record<string, SchemaObject> = {
      shape_with_side: labeled,
      shape: { oneOf: [byRadius, bySide] },
    };
    const siblings = new Map(Object.entries(properties));
    expect(schemaToTypeRef(properties['shape']!, 'shape', 'Drawing', siblings)).toEqual(
      union([model('DrawingShape'), model('DrawingShape2')]),
    );
    const results: Model[] = [];
    extractInlineModelsFromProperties({ type: 'object', properties }, results, 'Drawing');
    expect(results.map((m) => m.name)).toEqual(['DrawingShapeWithSide', 'DrawingShape', 'DrawingShape2']);
  });
});

describe('a response that is itself a oneOf materializes every variant the union references', () => {
  const num = { kind: 'primitive', type: 'number' };
  const str = { kind: 'primitive', type: 'string' };
  const model = (name: string) => ({ kind: 'model', name });
  const nullable = (inner: unknown) => ({ kind: 'nullable', inner });
  const n: SchemaObject = { type: 'number' };
  const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
    type: 'object',
    properties,
    ...extra,
  });
  const byRadius = obj({ radius: n });
  const nullableBySide = obj({ side: n }, { type: ['object', 'null'] });

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

  const operation = (operationId: string, schema: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'nullable response variants', version: '1' },
    paths: {
      '/things': {
        get: {
          operationId,
          responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
        },
      },
    },
  });

  it('a direct response with a nullable second variant', async () => {
    const ir = await parseWithoutWarnings(operation('getThing', { oneOf: [byRadius, nullableBySide] }));
    const op = ir.services.flatMap((s) => s.operations)[0]!;
    expect(op.response).toEqual({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [model('GetThingResponse'), nullable(model('GetThingResponseWithSide'))],
    });
    const types = fieldTypesByModel(ir.models);
    expect(types['GetThingResponse']).toEqual({ radius: num });
    expect(types['GetThingResponseWithSide']).toEqual({ side: num });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['GetThingResponse', 'GetThingResponseWithSide']);
  });

  it('a list item whose union has a nullable second variant', async () => {
    const ir = await parseWithoutWarnings(
      operation('listThings', {
        type: 'object',
        properties: {
          object: { type: 'string', const: 'list' },
          data: { type: 'array', items: obj({ id: { type: 'string' }, shape: { oneOf: [byRadius, nullableBySide] } }) },
          list_metadata: obj({ before: { type: 'string' }, after: { type: 'string' } }),
        },
      }),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['ListThingsItem']).toEqual({
      id: str,
      shape: {
        kind: 'union',
        compositionKind: 'oneOf',
        variants: [model('ListThingsItemShape'), nullable(model('ListThingsItemShapeWithSide'))],
      },
    });
    expect(types['ListThingsItemShape']).toEqual({ radius: num });
    expect(types['ListThingsItemShapeWithSide']).toEqual({ side: num });
  });

  it('const-named variants carry the names the union references, not bare const names', async () => {
    const ir = await parseWithoutWarnings(
      operation('getThing', {
        oneOf: [
          obj({ kind: { type: 'string', const: 'circle' }, radius: n }),
          obj({ kind: { type: 'string', const: 'square' }, side: n }, { type: ['object', 'null'] }),
        ],
      }),
    );
    const op = ir.services.flatMap((s) => s.operations)[0]!;
    expect(op.response).toEqual({
      kind: 'union',
      compositionKind: 'oneOf',
      variants: [model('GetThingResponse'), nullable(model('SquareGetThingResponse'))],
      discriminator: { property: 'kind', mapping: { circle: 'GetThingResponse', square: 'SquareGetThingResponse' } },
    });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['GetThingResponse', 'SquareGetThingResponse']);
    expect(fieldTypesByModel(ir.models)['SquareGetThingResponse']).toEqual({
      kind: { kind: 'literal', value: 'square' },
      side: num,
    });
  });
});

describe('title-mapped unions: the extracted models follow the discriminator mapping', () => {
  const num = { kind: 'primitive', type: 'number' };
  const str = { kind: 'primitive', type: 'string' };
  const model = (name: string) => ({ kind: 'model', name });
  const n: SchemaObject = { type: 'number' };
  const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
    type: 'object',
    properties,
    ...extra,
  });
  // Every variant carries a title AND pins `kind`: the pre-existing
  // title-mapped path names the discriminator mapping from the titles.
  const circle = obj({ kind: { type: 'string', const: 'circle' }, radius: n }, { title: 'Circle' });
  const square = obj({ kind: { type: 'string', const: 'square' }, side: n }, { title: 'Square' });
  const titled: SchemaObject = { oneOf: [circle, square] };
  const mapped = {
    kind: 'union',
    compositionKind: 'oneOf',
    variants: [model('Circle'), model('Square')],
    discriminator: { property: 'kind', mapping: { circle: 'Circle', square: 'Square' } },
  };
  const circleFields = { kind: { kind: 'literal', value: 'circle' }, radius: num };
  const squareFields = { kind: { kind: 'literal', value: 'square' }, side: num };

  /** Every model ref and every discriminator mapping value, anywhere in a value. */
  function refsIn(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => refsIn(v, out));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record['kind'] === 'model' && typeof record['name'] === 'string') out.add(record['name']);
      const discriminator = record['discriminator'] as { mapping?: Record<string, string> } | undefined;
      if (record['kind'] === 'union' && discriminator?.mapping)
        Object.values(discriminator.mapping).forEach((v) => out.add(v));
      Object.values(record).forEach((v) => refsIn(v, out));
    }
    return out;
  }

  /** Every reference and mapping value resolves to a model; every model other than `roots` is referenced. */
  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = new Set<string>();
    for (const m of ir.models) refsIn(m.fields, referenced);
    for (const op of ir.services.flatMap((s) => s.operations)) {
      refsIn([op.requestBody, op.response, op.pagination?.envelopeFields], referenced);
    }
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
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

  const info = { title: 'title-mapped', version: '1' };
  const withComponents = (schemas: Record<string, SchemaObject>) => ({
    openapi: '3.1.0',
    info,
    paths: {},
    components: { schemas },
  });
  const withGet = (operationId: string, schema: SchemaObject) => ({
    openapi: '3.1.0',
    info,
    paths: {
      '/things': {
        get: { operationId, responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } } },
      },
    },
  });

  it('as a direct response: the union, the mapping and the models all say Circle and Square', async () => {
    const ir = await parseWithoutWarnings(withGet('getThing', titled));
    const op = ir.services.flatMap((s) => s.operations)[0]!;
    expect(op.response).toEqual(mapped);
    const types = fieldTypesByModel(ir.models);
    expect(types['Circle']).toEqual(circleFields);
    expect(types['Square']).toEqual(squareFields);
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Circle', 'Square']);
    expectConsistent(ir, []);
  });

  it('on a list item field', async () => {
    const ir = await parseWithoutWarnings(
      withGet(
        'listThings',
        obj({
          object: { type: 'string', const: 'list' },
          data: { type: 'array', items: obj({ id: { type: 'string' }, shape: titled }) },
          list_metadata: obj({ before: { type: 'string' }, after: { type: 'string' } }),
        }),
      ),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['ListThingsItem']).toEqual({ id: str, shape: mapped });
    expect(types['Circle']).toEqual(circleFields);
    expect(types['Square']).toEqual(squareFields);
    expectConsistent(ir, []);
  });

  it.each([
    {
      label: 'a component field',
      spec: withComponents({ Drawing: obj({ shape: titled }) }),
      field: (types: Record<string, Record<string, unknown>>) => types['Drawing']!['shape'],
      roots: ['Drawing'],
    },
    {
      label: 'a request-body field',
      spec: {
        openapi: '3.1.0',
        info,
        paths: {
          '/things': {
            post: {
              operationId: 'createThing',
              requestBody: { content: { 'application/json': { schema: obj({ shape: titled }) } } },
              responses: { '204': { description: 'ok' } },
            },
          },
        },
      },
      field: (types: Record<string, Record<string, unknown>>) => types['CreateThingRequest']!['shape'],
      roots: [],
    },
    {
      label: 'the items of an array',
      spec: withComponents({ Drawing: obj({ markers: { type: 'array', items: titled } }) }),
      field: (types: Record<string, Record<string, unknown>>) =>
        (types['Drawing']!['markers'] as { items: unknown }).items,
      roots: ['Drawing'],
    },
  ])('as $label', async ({ spec, field, roots }) => {
    const ir = await parseWithoutWarnings(spec);
    const types = fieldTypesByModel(ir.models);
    expect(field(types)).toEqual(mapped);
    expect(types['Circle']).toEqual(circleFields);
    expect(types['Square']).toEqual(squareFields);
    expectConsistent(ir, roots);
  });

  it('two title-mapped unions beside each other share Circle and Square: a title names one shape', async () => {
    const ir = await parseWithoutWarnings(withComponents({ Drawing: obj({ shape: titled, marker: titled }) }));
    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({ shape: mapped, marker: mapped });
    expect(types['Circle']).toEqual(circleFields);
    expect(types['Square']).toEqual(squareFields);
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Circle', 'Drawing', 'Square']);
    expectConsistent(ir, ['Drawing']);
  });

  it('a title a sibling model already mints falls back to the title-prefixed base, and the mapping follows', async () => {
    // The title "Thing circle" resolves to `ThingCircle`, exactly what the sibling `circle` object mints.
    const ir = await parseWithoutWarnings(
      withComponents({
        Thing: obj({
          circle: obj({ label: { type: 'string' } }),
          shape: { oneOf: [{ ...circle, title: 'Thing circle' }, square] },
        }),
      }),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['Thing']).toEqual({
      circle: model('ThingCircle'),
      shape: {
        kind: 'union',
        compositionKind: 'oneOf',
        variants: [model('ThingCircleThingShape'), model('Square')],
        discriminator: { property: 'kind', mapping: { circle: 'ThingCircleThingShape', square: 'Square' } },
      },
    });
    expect(types['ThingCircle']).toEqual({ label: str });
    expect(types['ThingCircleThingShape']).toEqual(circleFields);
    expect(types['Square']).toEqual(squareFields);
    expectConsistent(ir, ['Thing']);
  });
});

describe('sibling reservation reaches every context, including array items and map values', () => {
  const num = { kind: 'primitive', type: 'number' };
  const str = { kind: 'primitive', type: 'string' };
  const model = (name: string) => ({ kind: 'model', name });
  const union = (variants: unknown[]) => ({ kind: 'union', compositionKind: 'oneOf', variants });
  const n: SchemaObject = { type: 'number' };
  const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
    type: 'object',
    properties,
    ...extra,
  });
  const plain: SchemaObject = { oneOf: [obj({ radius: n }), obj({ side: n })] };
  const labeled = obj({ label: { type: 'string' } });

  function referencedEverywhere(ir: Awaited<ReturnType<typeof parseSpec>>): Set<string> {
    const names = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record['kind'] === 'model' && typeof record['name'] === 'string') names.add(record['name']);
        Object.values(record).forEach(visit);
      }
    };
    for (const m of ir.models) visit(m.fields);
    for (const op of ir.services.flatMap((s) => s.operations)) {
      visit([op.requestBody, op.response, op.pagination?.envelopeFields]);
    }
    return names;
  }

  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = referencedEverywhere(ir);
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
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

  const info = { title: 'reserved everywhere', version: '1' };
  const withComponents = (schemas: Record<string, SchemaObject>) => ({
    openapi: '3.1.0',
    info,
    paths: {},
    components: { schemas },
  });

  /** `shape_with_side` beside the `shape` union, the sibling first and the sibling last. */
  const orders: Array<[string, Record<string, SchemaObject>]> = [
    ['sibling first', { shape_with_side: labeled, shape: plain }],
    ['sibling last', { shape: plain, shape_with_side: labeled }],
  ];

  it.each(orders)('in a nested object, %s', async (_order, properties) => {
    const ir = await parseWithoutWarnings(withComponents({ Drawing: obj({ inner: obj(properties) }) }));
    const types = fieldTypesByModel(ir.models);
    expect(types['DrawingInner']).toMatchObject({
      shape_with_side: model('DrawingInnerShapeWithSide'),
      shape: union([model('DrawingInnerShape'), model('DrawingInnerShape2')]),
    });
    expect(types['DrawingInnerShapeWithSide']).toEqual({ label: str });
    expect(types['DrawingInnerShape2']).toEqual({ side: num });
    expectConsistent(ir, ['Drawing']);
  });

  it.each(orders)('in an array item object, %s', async (_order, properties) => {
    const ir = await parseWithoutWarnings(
      withComponents({ Drawing: obj({ items: { type: 'array', items: obj(properties) } }) }),
    );
    const types = fieldTypesByModel(ir.models);
    expect(types['DrawingItem']).toMatchObject({
      shape_with_side: model('DrawingItemShapeWithSide'),
      shape: union([model('DrawingItemShape'), model('DrawingItemShape2')]),
    });
    expect(types['DrawingItemShapeWithSide']).toEqual({ label: str });
    expect(types['DrawingItemShape2']).toEqual({ side: num });
    expectConsistent(ir, ['Drawing']);
  });

  it.each(orders)('on a list-item envelope, %s', async (_order, properties) => {
    const ir = await parseWithoutWarnings({
      openapi: '3.1.0',
      info,
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: obj({
                      object: { type: 'string', const: 'list' },
                      data: { type: 'array', items: obj({ id: { type: 'string' }, ...properties }) },
                      list_metadata: obj({ before: { type: 'string' }, after: { type: 'string' } }),
                    }),
                  },
                },
              },
            },
          },
        },
      },
    });
    const types = fieldTypesByModel(ir.models);
    expect(types['ListThingsItem']).toMatchObject({
      shape_with_side: model('ListThingsItemShapeWithSide'),
      shape: union([model('ListThingsItemShape'), model('ListThingsItemShape2')]),
    });
    expect(types['ListThingsItemShapeWithSide']).toEqual({ label: str });
    expect(types['ListThingsItemShape2']).toEqual({ side: num });
    expectConsistent(ir, []);
  });

  it('a union among array items, map values or nested array items steps around a sibling model too', async () => {
    const ir = await parseWithoutWarnings(
      withComponents({
        Drawing: obj({
          marker_with_side: labeled,
          markers: { type: 'array', items: plain },
          layers: { type: 'object', additionalProperties: plain },
          layer_with_side: labeled,
          grid_with_side: labeled,
          grids: { type: 'array', items: { type: 'array', items: plain } },
        }),
      }),
    );
    const types = fieldTypesByModel(ir.models);
    // The sibling claims the singular name's `WithSide` candidate, so the
    // items/values step aside to `<Field>Item` / `<Field>Value` and their
    // variants are named from there; the sibling models keep their names.
    expect(types['Drawing']).toEqual({
      marker_with_side: model('DrawingMarkerWithSide'),
      markers: { kind: 'array', items: union([model('DrawingMarkersItem'), model('DrawingMarkersItemWithSide')]) },
      layers: { kind: 'map', valueType: union([model('DrawingLayersValue'), model('DrawingLayersValueWithSide')]) },
      layer_with_side: model('DrawingLayerWithSide'),
      grid_with_side: model('DrawingGridWithSide'),
      grids: {
        kind: 'array',
        items: { kind: 'array', items: union([model('DrawingGridsItem'), model('DrawingGridsItemWithSide')]) },
      },
    });
    for (const sibling of ['DrawingMarkerWithSide', 'DrawingLayerWithSide', 'DrawingGridWithSide']) {
      expect(types[sibling]).toEqual({ label: str });
    }
    for (const second of ['DrawingMarkersItemWithSide', 'DrawingLayersValueWithSide', 'DrawingGridsItemWithSide']) {
      expect(types[second]).toEqual({ side: num });
    }
    expectConsistent(ir, ['Drawing']);
  });

  it('a reserved set handed down to array items is honored by the reference and the extractor alike', () => {
    // With no sibling set in play nothing steps aside, so only the handed-down
    // reservation keeps the `{ side }` variant off `DrawingMarkerWithSide`.
    const markers: SchemaObject = { type: 'array', items: plain };
    const reserved = new Set(['DrawingMarkerWithSide']);
    expect(schemaToTypeRef(markers, 'markers', 'Drawing', undefined, reserved)).toEqual({
      kind: 'array',
      items: union([model('DrawingMarker'), model('DrawingMarker2')]),
    });
    const results: Model[] = [];
    extractInlineModelsFromProperties({ properties: { markers } }, results, 'Drawing', undefined, undefined, reserved);
    expect(results.map((m) => m.name)).toEqual(['DrawingMarker', 'DrawingMarker2']);
    expect(fieldTypesByModel(results)['DrawingMarker2']).toEqual({ side: num });
  });
});

describe('matching titles across sibling unions terminate and share one model (the title hang)', () => {
  const num = { kind: 'primitive', type: 'number' };
  const model = (name: string) => ({ kind: 'model', name });
  const n: SchemaObject = { type: 'number' };
  const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
    type: 'object',
    properties,
    ...extra,
  });
  const circle = obj({ kind: { type: 'string', const: 'circle' }, radius: n }, { title: 'Circle' });
  const square = obj({ kind: { type: 'string', const: 'square' }, side: n }, { title: 'Square' });
  const titled: SchemaObject = { oneOf: [circle, square] };
  const plain: SchemaObject = { oneOf: [obj({ radius: n }), obj({ side: n })] };
  const arr = (items: SchemaObject): SchemaObject => ({ type: 'array', items });
  const map = (values: SchemaObject): SchemaObject => ({ type: 'object', additionalProperties: values });
  const mapped = {
    kind: 'union',
    compositionKind: 'oneOf',
    variants: [model('Circle'), model('Square')],
    discriminator: { property: 'kind', mapping: { circle: 'Circle', square: 'Square' } },
  };
  const circleFields = { kind: { kind: 'literal', value: 'circle' }, radius: num };
  const squareFields = { kind: { kind: 'literal', value: 'square' }, side: num };

  /** Every model ref and every discriminator mapping value, anywhere in a value. */
  function refsIn(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => refsIn(v, out));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record['kind'] === 'model' && typeof record['name'] === 'string') out.add(record['name']);
      const discriminator = record['discriminator'] as { mapping?: Record<string, string> } | undefined;
      if (record['kind'] === 'union' && discriminator?.mapping)
        Object.values(discriminator.mapping).forEach((v) => out.add(v));
      Object.values(record).forEach((v) => refsIn(v, out));
    }
    return out;
  }

  /** Every reference and mapping value resolves to a model; every model other than `roots` is referenced. */
  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = new Set<string>();
    for (const m of ir.models) refsIn(m.fields, referenced);
    for (const op of ir.services.flatMap((s) => s.operations)) {
      refsIn([op.requestBody, op.response, op.pagination?.envelopeFields], referenced);
    }
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
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

  const withDrawing = (properties: Record<string, SchemaObject>) => ({
    openapi: '3.1.0',
    info: { title: 'title hang', version: '1' },
    paths: {},
    components: { schemas: { Drawing: obj(properties) } },
  });

  // Each case parses (no hang), names deterministically, and the two unions
  // share the title-named models: a title names one shape wherever it appears.
  it.each<{ label: string; properties: Record<string, SchemaObject>; drawing: Record<string, unknown> }>([
    {
      label: 'the reported case: two sibling arrays of titled items',
      properties: { shapes: arr(titled), markers: arr(titled) },
      drawing: { shapes: { kind: 'array', items: mapped }, markers: { kind: 'array', items: mapped } },
    },
    {
      label: 'two sibling maps of titled values',
      properties: { layers: map(titled), tiles: map(titled) },
      drawing: { layers: { kind: 'map', valueType: mapped }, tiles: { kind: 'map', valueType: mapped } },
    },
    {
      label: 'two sibling unions at field level',
      properties: { shape: titled, marker: titled },
      drawing: { shape: mapped, marker: mapped },
    },
    {
      label: 'a field, an array and a map, all with the same titled items',
      properties: { shape: titled, shapes: arr(titled), layers: map(titled) },
      drawing: { shape: mapped, shapes: { kind: 'array', items: mapped }, layers: { kind: 'map', valueType: mapped } },
    },
  ])('$label', async ({ properties, drawing }) => {
    const ir = await parseWithoutWarnings(withDrawing(properties));
    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual(drawing);
    expect(types['Circle']).toEqual(circleFields);
    expect(types['Square']).toEqual(squareFields);
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Circle', 'Drawing', 'Square']);
    expectConsistent(ir, ['Drawing']);
  });

  it('context-free names never drive a step-aside, so the search is not even entered for them', () => {
    expect(
      elementContextDecision(
        'shapes',
        'item',
        new Map([
          ['shapes', arr(titled)],
          ['markers', arr(titled)],
        ]),
        'Drawing',
        titled,
      ),
    ).toEqual({ context: 'shapes', reason: 'nothing-minted' });
    expect(
      elementContextDecision(
        'layers',
        'value',
        new Map([
          ['layers', map(titled)],
          ['tiles', map(titled)],
        ]),
        'Drawing',
        titled,
      ),
    ).toEqual({ context: 'layers', reason: 'nothing-minted' });
  });

  it('the no-progress rule, not the attempt cap, stops a search whose names never change', () => {
    const tried: string[] = [];
    const constant = (candidate: string): string[] => {
      tried.push(candidate);
      return ['Circle', 'Square'];
    };
    expect(
      firstFreeElementContext('shapes', 'item', new Set(['Circle', 'Square']), constant, ['Circle', 'Square']),
    ).toEqual({ context: 'shapes_item', reason: 'no-progress' });
    expect(tried).toEqual(['shapes_item']);
    expect(tried.length).toBeLessThan(MAX_ELEMENT_CONTEXT_ATTEMPTS);

    // The cap is only the last resort: names that keep changing but stay claimed.
    const everClaimed = (candidate: string): string[] => ['Claimed', candidate];
    expect(
      firstFreeElementContext('shapes', 'item', new Set(['Claimed']), everClaimed, ['Claimed', 'shapes'], 5),
    ).toEqual({
      context: 'shapes_array_item4',
      reason: 'cap',
    });
    // And a candidate that frees itself wins before either rule: the first
    // candidate changes the names (so there is progress) but is still claimed,
    // the second is free.
    const freesAtSecond = (candidate: string): string[] => (candidate === 'shapes_item' ? ['Claimed'] : [candidate]);
    expect(firstFreeElementContext('shapes', 'item', new Set(['Claimed']), freesAtSecond, ['DrawingShape'])).toEqual({
      context: 'shapes_array_item',
      reason: 'free',
    });
  });

  it('a plain union among items still steps around a context-free title equal to its singular name, and terminates', async () => {
    // `markers` is title-mapped with a variant titled "Drawing shape" — the
    // context-free name `DrawingShape` — which is exactly what the plain
    // items of `shapes` would be named: they step aside (`free`), while the
    // title itself falls back because `shapes` mints `DrawingShape` in isolation.
    const titledDrawingShape: SchemaObject = { oneOf: [{ ...circle, title: 'Drawing shape' }, square] };
    const properties = { shapes: arr(plain), markers: arr(titledDrawingShape) };
    expect(elementContextDecision('shapes', 'item', new Map(Object.entries(properties)), 'Drawing', plain)).toEqual({
      context: 'shapes_item',
      reason: 'free',
    });

    const ir = await parseWithoutWarnings(withDrawing(properties));
    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      shapes: {
        kind: 'array',
        items: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('DrawingShapesItem'), model('DrawingShapesItemWithSide')],
        },
      },
      markers: {
        kind: 'array',
        items: {
          kind: 'union',
          compositionKind: 'oneOf',
          variants: [model('DrawingShapeDrawingMarker'), model('Square')],
          discriminator: { property: 'kind', mapping: { circle: 'DrawingShapeDrawingMarker', square: 'Square' } },
        },
      },
    });
    expect(types['DrawingShapeDrawingMarker']).toEqual(circleFields);
    expect(types['DrawingShapesItemWithSide']).toEqual({ side: num });
    expectConsistent(ir, ['Drawing']);
  });
});

describe('a title-named model is shared only between variants of the identical shape', () => {
  const num = { kind: 'primitive', type: 'number' };
  const model = (name: string) => ({ kind: 'model', name });
  const n: SchemaObject = { type: 'number' };
  const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
    type: 'object',
    properties,
    ...extra,
  });
  const circle = (fields: Record<string, SchemaObject>): SchemaObject =>
    obj({ kind: { type: 'string', const: 'circle' }, ...fields }, { title: 'Circle' });
  const square = (fields: Record<string, SchemaObject>): SchemaObject =>
    obj({ kind: { type: 'string', const: 'square' }, ...fields }, { title: 'Square' });
  const byRadius: SchemaObject = { oneOf: [circle({ radius: n }), square({ side: n })] };
  const byDiameter: SchemaObject = { oneOf: [circle({ diameter: n }), square({ side: n })] };
  const byArea: SchemaObject = { oneOf: [circle({ radius: n }), square({ area: n })] };
  const arr = (items: SchemaObject): SchemaObject => ({ type: 'array', items });
  const map = (values: SchemaObject): SchemaObject => ({ type: 'object', additionalProperties: values });
  const unionOf = (first: string, second: string) => ({
    kind: 'union',
    compositionKind: 'oneOf',
    variants: [model(first), model(second)],
    discriminator: { property: 'kind', mapping: { circle: first, square: second } },
  });
  const kind = (value: string) => ({ kind: { kind: 'literal', value } });

  /** Every model ref and every discriminator mapping value, anywhere in a value. */
  function refsIn(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => refsIn(v, out));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record['kind'] === 'model' && typeof record['name'] === 'string') out.add(record['name']);
      const discriminator = record['discriminator'] as { mapping?: Record<string, string> } | undefined;
      if (record['kind'] === 'union' && discriminator?.mapping)
        Object.values(discriminator.mapping).forEach((v) => out.add(v));
      Object.values(record).forEach((v) => refsIn(v, out));
    }
    return out;
  }

  function expectConsistent(ir: Awaited<ReturnType<typeof parseSpec>>, roots: string[]): void {
    const referenced = new Set<string>();
    for (const m of ir.models) refsIn(m.fields, referenced);
    for (const op of ir.services.flatMap((s) => s.operations)) {
      refsIn([op.requestBody, op.response, op.pagination?.envelopeFields], referenced);
    }
    const known = new Set(ir.models.map((m) => m.name));
    expect([...referenced].filter((name) => !known.has(name))).toEqual([]);
    expect([...known].filter((name) => !roots.includes(name) && !referenced.has(name))).toEqual([]);
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

  const withDrawing = (properties: Record<string, SchemaObject>) => ({
    openapi: '3.1.0',
    info: { title: 'shared titles', version: '1' },
    paths: {},
    components: { schemas: { Drawing: obj(properties) } },
  });

  it('the reported case: Circle differs (radius vs diameter), so both unions fall back to a context-qualified Circle and share Square', async () => {
    const ir = await parseWithoutWarnings(withDrawing({ shape: byRadius, marker: byDiameter }));
    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      shape: unionOf('CircleDrawingShape', 'Square'),
      marker: unionOf('CircleDrawingMarker', 'Square'),
    });
    expect(types['CircleDrawingShape']).toEqual({ ...kind('circle'), radius: num });
    expect(types['CircleDrawingMarker']).toEqual({ ...kind('circle'), diameter: num });
    expect(types['Square']).toEqual({ ...kind('square'), side: num });
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'CircleDrawingMarker',
      'CircleDrawingShape',
      'Drawing',
      'Square',
    ]);
    expectConsistent(ir, ['Drawing']);
  });

  it('identical shapes still share one model under the bare title', async () => {
    const ir = await parseWithoutWarnings(withDrawing({ shape: byRadius, marker: byRadius }));
    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({ shape: unionOf('Circle', 'Square'), marker: unionOf('Circle', 'Square') });
    expect(types['Circle']).toEqual({ ...kind('circle'), radius: num });
    expect(ir.models.map((m) => m.name).sort()).toEqual(['Circle', 'Drawing', 'Square']);
    expectConsistent(ir, ['Drawing']);
  });

  it('when only Square differs, Circle is shared and Square splits per union', async () => {
    const ir = await parseWithoutWarnings(withDrawing({ shape: byRadius, marker: byArea }));
    const types = fieldTypesByModel(ir.models);
    expect(types['Drawing']).toEqual({
      shape: unionOf('Circle', 'SquareDrawingShape'),
      marker: unionOf('Circle', 'SquareDrawingMarker'),
    });
    expect(types['Circle']).toEqual({ ...kind('circle'), radius: num });
    expect(types['SquareDrawingShape']).toEqual({ ...kind('square'), side: num });
    expect(types['SquareDrawingMarker']).toEqual({ ...kind('square'), area: num });
    expect(ir.models.map((m) => m.name).sort()).toEqual([
      'Circle',
      'Drawing',
      'SquareDrawingMarker',
      'SquareDrawingShape',
    ]);
    expectConsistent(ir, ['Drawing']);
  });

  it.each<{
    label: string;
    properties: Record<string, SchemaObject>;
    drawing: Record<string, unknown>;
    models: string[];
  }>([
    {
      label: 'array items',
      properties: { shapes: arr(byRadius), markers: arr(byDiameter) },
      drawing: {
        shapes: { kind: 'array', items: unionOf('CircleDrawingShape', 'Square') },
        markers: { kind: 'array', items: unionOf('CircleDrawingMarker', 'Square') },
      },
      models: ['CircleDrawingMarker', 'CircleDrawingShape', 'Drawing', 'Square'],
    },
    {
      label: 'map values',
      properties: { layers: map(byRadius), tiles: map(byDiameter) },
      drawing: {
        layers: { kind: 'map', valueType: unionOf('CircleDrawingLayer', 'Square') },
        tiles: { kind: 'map', valueType: unionOf('CircleDrawingTile', 'Square') },
      },
      models: ['CircleDrawingLayer', 'CircleDrawingTile', 'Drawing', 'Square'],
    },
    {
      label: 'array items where only Square differs',
      properties: { shapes: arr(byRadius), markers: arr(byArea) },
      drawing: {
        shapes: { kind: 'array', items: unionOf('Circle', 'SquareDrawingShape') },
        markers: { kind: 'array', items: unionOf('Circle', 'SquareDrawingMarker') },
      },
      models: ['Circle', 'Drawing', 'SquareDrawingMarker', 'SquareDrawingShape'],
    },
  ])('the same under $label', async ({ properties, drawing, models }) => {
    const ir = await parseWithoutWarnings(withDrawing(properties));
    expect(fieldTypesByModel(ir.models)['Drawing']).toEqual(drawing);
    expect(ir.models.map((m) => m.name).sort()).toEqual(models);
    expectConsistent(ir, ['Drawing']);
  });

  it('the fallback names are context-dependent, so the items search still terminates without being entered', () => {
    expect(
      elementContextDecision(
        'shapes',
        'item',
        new Map([
          ['shapes', arr(byRadius)],
          ['markers', arr(byDiameter)],
        ]),
        'Drawing',
        byRadius,
      ),
    ).toEqual({ context: 'shapes', reason: 'nothing-minted' });
    expect(
      elementContextDecision(
        'layers',
        'value',
        new Map([
          ['layers', map(byRadius)],
          ['tiles', map(byDiameter)],
        ]),
        'Drawing',
        byRadius,
      ),
    ).toEqual({ context: 'layers', reason: 'nothing-minted' });
  });

  it('a kept title is reported context-free and a fallen-back one context-dependent', () => {
    expect([...nameInlineVariantEntries(byRadius, 'DrawingShape', new Set(['Circle'])).values()]).toEqual([
      { name: 'CircleDrawingShape', contextFree: false },
      { name: 'Square', contextFree: true },
    ]);
    // In isolation, a title two variants of one union share falls back for the second.
    const twice: SchemaObject = { oneOf: [circle({ radius: n }), circle({ diameter: n })] };
    expect(
      mintedInlineNameEntries('shape', twice, 'Drawing').map(({ name, contextFree }) => ({ name, contextFree })),
    ).toEqual([
      { name: 'Circle', contextFree: true },
      { name: 'CircleDrawingShape', contextFree: false },
    ]);
  });
});
