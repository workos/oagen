import { describe, it, expect } from 'vitest';
import { parseSpec } from '../../src/parser/parse.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiSpec } from '../../src/ir/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');

let ir: ApiSpec;

/** Parse the comprehensive spec once, share across all tests */
beforeAll(async () => {
  ir = await parseSpec(`${FIXTURES}/conformance.yml`);
});

function findModel(name: string) {
  return ir.models.find((m) => m.name === name);
}

function findEnum(name: string) {
  return ir.enums.find((e) => e.name === name);
}

function findService(name: string) {
  return ir.services.find((s) => s.name === name);
}

function findOperation(serviceName: string, opName: string) {
  return findService(serviceName)?.operations.find((o) => o.name === opName);
}

function findField(modelName: string, fieldName: string) {
  return findModel(modelName)?.fields.find((f) => f.name === fieldName);
}

describe('parseSpec – schema types', () => {
  it('string primitive → PrimitiveType', () => {
    const field = findField('Widget', 'name');
    expect(field?.type).toEqual({ kind: 'primitive', type: 'string' });
  });

  it('string with uuid format → PrimitiveType with format', () => {
    const field = findField('Widget', 'id');
    expect(field?.type).toEqual({ kind: 'primitive', type: 'string', format: 'uuid' });
  });

  it('string with date-time format → PrimitiveType with format', () => {
    const field = findField('Widget', 'created_at');
    expect(field?.type).toEqual({ kind: 'primitive', type: 'string', format: 'date-time' });
  });

  it('integer primitive → PrimitiveType', () => {
    const field = findField('Widget', 'count');
    expect(field?.type).toEqual({ kind: 'primitive', type: 'integer' });
  });

  it('number primitive → PrimitiveType', () => {
    const field = findField('Widget', 'score');
    expect(field?.type).toEqual({ kind: 'primitive', type: 'number' });
  });

  it('boolean primitive → PrimitiveType', () => {
    const field = findField('Widget', 'is_active');
    expect(field?.type).toEqual({ kind: 'primitive', type: 'boolean' });
  });

  it('$ref field → ModelRef with correct name', () => {
    const field = findField('Widget', 'kind');
    expect(field?.type).toEqual({ kind: 'model', name: 'WidgetKind' });
  });

  it('array of string primitives → ArrayType', () => {
    const field = findField('Widget', 'tags');
    expect(field?.type).toEqual({
      kind: 'array',
      items: { kind: 'primitive', type: 'string' },
    });
  });

  it('array of formatted strings → ArrayType with format', () => {
    const field = findField('Widget', 'related_ids');
    expect(field?.type).toEqual({
      kind: 'array',
      items: { kind: 'primitive', type: 'string', format: 'uuid' },
    });
  });

  it('additionalProperties with schema → MapType', () => {
    const field = findField('Widget', 'metadata');
    expect(field?.type).toEqual({
      kind: 'map',
      valueType: { kind: 'primitive', type: 'string' },
    });
  });

  it('OAS 3.1 nullable type array → NullableType', () => {
    const field = findField('Widget', 'parent_id');
    expect(field?.type.kind).toBe('nullable');
    if (field?.type.kind === 'nullable') {
      expect(field.type.inner).toEqual({ kind: 'primitive', type: 'string' });
    }
  });

  it('OAS 3.0 nullable flag → NullableType', () => {
    const field = findField('Gadget', 'value');
    expect(field?.type.kind).toBe('nullable');
    if (field?.type.kind === 'nullable') {
      expect(field.type.inner).toEqual({ kind: 'primitive', type: 'number' });
    }
  });

  it('inline object field → ModelRef', () => {
    const field = findField('Widget', 'settings');
    expect(field?.type.kind).toBe('model');
    if (field?.type.kind === 'model') {
      expect(field.type.name).toBe('Settings');
    }
  });

  it('required flag set on required fields', () => {
    const id = findField('Widget', 'id');
    const name = findField('Widget', 'name');
    const desc = findField('Widget', 'description');
    expect(id?.required).toBe(true);
    expect(name?.required).toBe(true);
    expect(desc?.required).toBe(false);
  });

  it('nested array (array of arrays) → nested ArrayType', () => {
    const field = findField('MatrixModel', 'matrix');
    expect(field?.type).toEqual({
      kind: 'array',
      items: { kind: 'array', items: { kind: 'primitive', type: 'number' } },
    });
  });

  it('OAS 3.1 multi-type field [string, integer, number] → UnionType', () => {
    const field = findField('MultiTypeModel', 'flexible');
    expect(field?.type.kind).toBe('union');
    if (field?.type.kind === 'union') {
      expect(field.type.variants).toHaveLength(3);
    }
  });
});

describe('parseSpec – enums and literals', () => {
  it('standalone enum extracted with correct values', () => {
    const e = findEnum('WidgetKind');
    expect(e).toBeDefined();
    expect(e!.values).toHaveLength(3);
    expect(e!.values.map((v) => v.value)).toEqual(['standard', 'premium', 'enterprise']);
  });

  it('standalone enum values have UPPER_SNAKE_CASE names', () => {
    const e = findEnum('WidgetKind');
    expect(e!.values.map((v) => v.name)).toEqual(['STANDARD', 'PREMIUM', 'ENTERPRISE']);
  });

  it('inline field enum extracted as EnumRef', () => {
    const field = findField('Gadget', 'type');
    expect(field?.type.kind).toBe('enum');
    if (field?.type.kind === 'enum') {
      expect(field.type.values).toEqual(['sensor', 'actuator', 'controller']);
    }
  });

  it('const value → LiteralType', () => {
    const field = findField('LiteralModel', 'object');
    expect(field?.type).toEqual({ kind: 'literal', value: 'literal_model' });
  });

  it('single-value enum → LiteralType', () => {
    const field = findField('LiteralModel', 'single_option');
    expect(field?.type).toEqual({ kind: 'literal', value: 'only_value' });
  });

  it('multi-value inline enum → EnumRef', () => {
    const field = findField('LiteralModel', 'multi_option');
    expect(field?.type.kind).toBe('enum');
    if (field?.type.kind === 'enum') {
      expect(field.type.values).toEqual(['opt_a', 'opt_b', 'opt_c']);
    }
  });

  it('nullable enum field → NullableType', () => {
    const field = findField('NullableEnumModel', 'status');
    expect(field).toBeDefined();
    expect(field!.type.kind).toBe('nullable');
  });

  it('array of inline enum items → ArrayType with EnumRef', () => {
    const field = findField('TaggedModel', 'categories');
    expect(field).toBeDefined();
    expect(field!.type.kind).toBe('array');
    if (field!.type.kind === 'array') {
      expect(field!.type.items.kind).toBe('enum');
    }
  });
});

describe('parseSpec – allOf composition', () => {
  it('merges fields from all inline sub-schemas', () => {
    const model = findModel('ComposedModel');
    expect(model).toBeDefined();
    const fieldNames = model!.fields.map((f) => f.name);
    expect(fieldNames).toContain('id');
    expect(fieldNames).toContain('name');
    expect(fieldNames).toContain('label');
  });

  it('preserves required flags from all sub-schemas', () => {
    const model = findModel('ComposedModel');
    const id = model!.fields.find((f) => f.name === 'id');
    const name = model!.fields.find((f) => f.name === 'name');
    const label = model!.fields.find((f) => f.name === 'label');
    expect(id?.required).toBe(true);
    expect(name?.required).toBe(true);
    expect(label?.required).toBe(false);
  });

  it('resolves $ref sub-schema and includes referenced fields', () => {
    // ExtendedWidget = allOf($ref BaseWidget, inline { extension_field, extra_data })
    const model = findModel('ExtendedWidget');
    expect(model).toBeDefined();
    const fieldNames = model!.fields.map((f) => f.name);
    expect(fieldNames).toContain('id');
    expect(fieldNames).toContain('created_at');
    expect(fieldNames).toContain('extension_field');
    expect(fieldNames).toContain('extra_data');
  });

  it('preserves required flags from $ref sub-schema', () => {
    const model = findModel('ExtendedWidget');
    expect(model).toBeDefined();
    const id = model!.fields.find((f) => f.name === 'id');
    const createdAt = model!.fields.find((f) => f.name === 'created_at');
    const extField = model!.fields.find((f) => f.name === 'extension_field');
    const extraData = model!.fields.find((f) => f.name === 'extra_data');
    expect(id?.required).toBe(true);
    expect(createdAt?.required).toBe(true);
    expect(extField?.required).toBe(true);
    expect(extraData?.required).toBe(false);
  });

  it('merges fields from mixed $ref and inline sub-schemas', () => {
    // MixedAllOf = allOf($ref BaseWidget, $ref Gadget, inline { mixed_extra })
    const model = findModel('MixedAllOf');
    expect(model).toBeDefined();
    const fieldNames = model!.fields.map((f) => f.name);
    expect(fieldNames).toContain('id');
    expect(fieldNames).toContain('created_at');
    expect(fieldNames).toContain('type');
    expect(fieldNames).toContain('value');
    expect(fieldNames).toContain('mixed_extra');
  });

  it('preserves required from mixed $ref sources', () => {
    const model = findModel('MixedAllOf');
    expect(model).toBeDefined();
    const id = model!.fields.find((f) => f.name === 'id');
    const mixedExtra = model!.fields.find((f) => f.name === 'mixed_extra');
    expect(id?.required).toBe(true);
    expect(mixedExtra?.required).toBe(true);
  });

  it('recursively resolves $ref to allOf schema (deeply nested)', () => {
    // DeeplyNested = allOf($ref NestedBase, inline { deep_field })
    // NestedBase = allOf(inline { base_id }, inline { base_label })
    const model = findModel('DeeplyNested');
    expect(model).toBeDefined();
    const fieldNames = model!.fields.map((f) => f.name);
    expect(fieldNames).toContain('deep_field');
    expect(fieldNames).toContain('base_id');
    expect(fieldNames).toContain('base_label');
  });

  it('preserves required from deeply nested allOf', () => {
    const model = findModel('DeeplyNested');
    expect(model).toBeDefined();
    const baseId = model!.fields.find((f) => f.name === 'base_id');
    const baseLabel = model!.fields.find((f) => f.name === 'base_label');
    const deepField = model!.fields.find((f) => f.name === 'deep_field');
    expect(baseId?.required).toBe(true);
    expect(baseLabel?.required).toBe(false);
    expect(deepField?.required).toBe(true);
  });

  it('top-level oneOf schema creates a model', () => {
    const model = findModel('Event');
    expect(model).toBeDefined();
  });

  it('top-level anyOf schema creates a model', () => {
    const model = findModel('FlexibleValue');
    expect(model).toBeDefined();
  });

  it('discriminated union in field position → UnionType with discriminator', () => {
    const field = findField('EventContainer', 'event');
    expect(field).toBeDefined();
    expect(field!.type.kind).toBe('union');
    if (field!.type.kind === 'union') {
      expect(field!.type.discriminator).toBeDefined();
      expect(field!.type.discriminator!.property).toBe('event_type');
    }
  });
});

describe('parseSpec – maps', () => {
  it('freeform object (no properties) → model with zero fields', () => {
    const model = findModel('FreeformMap');
    expect(model).toBeDefined();
    expect(model!.fields).toHaveLength(0);
  });

  it('typed additionalProperties top-level → model with zero fields', () => {
    const model = findModel('TypedMap');
    expect(model).toBeDefined();
    expect(model!.fields).toHaveLength(0);
  });

  it('patternProperties top-level → model with zero fields', () => {
    const model = findModel('PatternMap');
    expect(model).toBeDefined();
    expect(model!.fields).toHaveLength(0);
  });

  it('additionalProperties in field → MapType with typed values', () => {
    const field = findField('Widget', 'metadata');
    expect(field?.type).toEqual({
      kind: 'map',
      valueType: { kind: 'primitive', type: 'string' },
    });
  });

  it('$ref value type in additionalProperties → model with zero fields', () => {
    const model = findModel('RefMap');
    expect(model).toBeDefined();
    expect(model!.fields).toHaveLength(0);
  });

  it('empty additionalProperties ({}) → model with zero fields', () => {
    const model = findModel('EmptyAdditionalProps');
    expect(model).toBeDefined();
    expect(model!.fields).toHaveLength(0);
  });
});

describe('parseSpec – operations', () => {
  it('path parameter extracted with correct type', () => {
    const op = findOperation('Widgets', 'getWidget');
    expect(op).toBeDefined();
    const param = op!.pathParams.find((p) => p.name === 'widget_id');
    expect(param).toBeDefined();
    expect(param!.type).toEqual({ kind: 'primitive', type: 'string', format: 'uuid' });
    expect(param!.required).toBe(true);
  });

  it('path-level parameters merged into operations', () => {
    const get = findOperation('Widgets', 'getWidget');
    const put = findOperation('Widgets', 'updateWidget');
    const del = findOperation('Widgets', 'deleteWidget');
    expect(get!.pathParams.some((p) => p.name === 'widget_id')).toBe(true);
    expect(put!.pathParams.some((p) => p.name === 'widget_id')).toBe(true);
    expect(del!.pathParams.some((p) => p.name === 'widget_id')).toBe(true);
  });

  it('required query parameter → required: true', () => {
    const op = findOperation('Widgets', 'listWidgets');
    const param = op!.queryParams.find((p) => p.name === 'status');
    expect(param?.required).toBe(true);
  });

  it('optional query parameter → required: false', () => {
    const op = findOperation('Widgets', 'listWidgets');
    const cursor = op!.queryParams.find((p) => p.name === 'cursor');
    const limit = op!.queryParams.find((p) => p.name === 'limit');
    expect(cursor?.required).toBe(false);
    expect(limit?.required).toBe(false);
  });

  it('header parameter extracted', () => {
    const op = findOperation('Widgets', 'getWidget');
    const header = op!.headerParams.find((p) => p.name === 'X-Request-Id');
    expect(header).toBeDefined();
    expect(header!.type).toEqual({ kind: 'primitive', type: 'string' });
  });

  it('request body from $ref → ModelRef', () => {
    const op = findOperation('Widgets', 'createWidget');
    expect(op!.requestBody).toBeDefined();
    expect(op!.requestBody!.kind).toBe('model');
    if (op!.requestBody!.kind === 'model') {
      expect(op!.requestBody!.name).toBe('CreateWidget');
    }
  });

  it('inline request body produces a ModelRef', () => {
    const op = findOperation('Actions', 'performAction');
    expect(op).toBeDefined();
    expect(op!.requestBody).toBeDefined();
    expect(op!.requestBody!.kind).toBe('model');
  });

  it('operationId mapped to method name', () => {
    const op = findOperation('Widgets', 'listWidgets');
    expect(op).toBeDefined();
    expect(op!.httpMethod).toBe('get');
  });

  it('no operationId → inferred name (list for GET collection)', () => {
    const op = findOperation('Items', 'list');
    expect(op).toBeDefined();
    expect(op!.httpMethod).toBe('get');
  });

  it('no operationId → inferred name (create for POST)', () => {
    const op = findOperation('Items', 'create');
    expect(op).toBeDefined();
    expect(op!.httpMethod).toBe('post');
  });

  it('service name inferred from path prefix', () => {
    expect(findService('Widgets')).toBeDefined();
    expect(findService('Gadgets')).toBeDefined();
    expect(findService('Items')).toBeDefined();
    expect(findService('Resources')).toBeDefined();
  });

  it('error responses collected with status codes', () => {
    const op = findOperation('Widgets', 'createWidget');
    expect(op!.errors.length).toBeGreaterThanOrEqual(1);
    const error400 = op!.errors.find((e) => e.statusCode === 400);
    expect(error400).toBeDefined();
  });

  it('POST sets idempotent flag', () => {
    const op = findOperation('Widgets', 'createWidget');
    expect(op!.idempotent).toBe(true);
  });

  it('GET does not set idempotent flag', () => {
    const op = findOperation('Widgets', 'listWidgets');
    expect(op!.idempotent).toBe(false);
  });

  it('DELETE operation extracted', () => {
    const op = findOperation('Widgets', 'deleteWidget');
    expect(op).toBeDefined();
    expect(op!.httpMethod).toBe('delete');
  });

  it('PUT operation extracted', () => {
    const op = findOperation('Widgets', 'updateWidget');
    expect(op).toBeDefined();
    expect(op!.httpMethod).toBe('put');
  });

  it('query parameter with array type → ArrayType', () => {
    const op = findOperation('Search', 'searchWidgets');
    expect(op).toBeDefined();
    const ids = op!.queryParams.find((p) => p.name === 'ids');
    expect(ids).toBeDefined();
    expect(ids!.type.kind).toBe('array');
    if (ids!.type.kind === 'array') {
      expect(ids!.type.items).toEqual({ kind: 'primitive', type: 'string' });
    }
    expect(ids!.required).toBe(true);
  });

  it('optional array query parameter', () => {
    const op = findOperation('Search', 'searchWidgets');
    const tags = op!.queryParams.find((p) => p.name === 'tags');
    expect(tags).toBeDefined();
    expect(tags!.required).toBe(false);
    expect(tags!.type.kind).toBe('array');
  });
});

describe('parseSpec – response patterns', () => {
  it('direct $ref response → ModelRef', () => {
    const op = findOperation('Widgets', 'getWidget');
    expect(op!.response.kind).toBe('model');
    if (op!.response.kind === 'model') {
      expect(op!.response.name).toBe('Widget');
    }
  });

  it('allOf list envelope → ArrayType', () => {
    const op = findOperation('Widgets', 'listWidgets');
    expect(op!.response.kind).toBe('array');
  });

  it('allOf list envelope → paginated: true', () => {
    const op = findOperation('Widgets', 'listWidgets');
    expect(op!.paginated).toBe(true);
  });

  it('flat list envelope → ArrayType + paginated', () => {
    const op = findOperation('Gadgets', 'listGadgets');
    expect(op!.response.kind).toBe('array');
    expect(op!.paginated).toBe(true);
  });

  it('single-resource wrapper (object const) → ModelRef', () => {
    const op = findOperation('Resources', 'getWrappedResource');
    expect(op!.response.kind).toBe('model');
    if (op!.response.kind === 'model') {
      expect(op!.response.name).toBe('WrappedResource');
    }
  });

  it('inline object response → ModelRef with extracted model', () => {
    const op = findOperation('Status', 'getStatus');
    expect(op!.response.kind).toBe('model');
    if (op!.response.kind === 'model') {
      const model = findModel(op!.response.name);
      expect(model).toBeDefined();
      expect(model!.fields.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('204 no-content response → default TypeRef', () => {
    const op = findOperation('Widgets', 'deleteWidget');
    expect(op!.response.kind).toBe('primitive');
  });

  it('plain array response (non-paginated)', () => {
    const op = findOperation('Configs', 'listConfigs');
    expect(op!.response.kind).toBe('array');
    if (op!.response.kind === 'array') {
      expect(op!.response.items).toEqual({ kind: 'primitive', type: 'string' });
    }
    expect(op!.paginated).toBe(false);
  });
});

describe('parseSpec – pagination', () => {
  it('cursor param + list envelope → paginated: true', () => {
    const op = findOperation('Widgets', 'listWidgets');
    expect(op!.paginated).toBe(true);
  });

  it('after param + flat list envelope → paginated: true', () => {
    const op = findOperation('Gadgets', 'listGadgets');
    expect(op!.paginated).toBe(true);
  });

  it('no cursor params → paginated: false', () => {
    const op = findOperation('Configs', 'listConfigs');
    expect(op!.paginated).toBe(false);
  });
});

describe('parseSpec – integration', () => {
  it('spec metadata parsed correctly', () => {
    expect(ir.name).toBe('Conformance API');
    expect(ir.version).toBe('1.0.0');
    expect(ir.baseUrl).toBe('https://api.conformance.test');
    expect(ir.description).toBe('Comprehensive spec for parser conformance testing');
  });

  it('all expected models present', () => {
    const modelNames = ir.models.map((m) => m.name);
    expect(modelNames).toContain('Widget');
    expect(modelNames).toContain('CreateWidget');
    expect(modelNames).toContain('UpdateWidget');
    expect(modelNames).toContain('Gadget');
    expect(modelNames).toContain('ComposedModel');
    expect(modelNames).toContain('BaseWidget');
    expect(modelNames).toContain('LiteralModel');
    expect(modelNames).toContain('MatrixModel');
    expect(modelNames).toContain('MultiTypeModel');
  });

  it('all expected enums present', () => {
    const enumNames = ir.enums.map((e) => e.name);
    expect(enumNames).toContain('WidgetKind');
  });

  it('all expected services present', () => {
    const serviceNames = ir.services.map((s) => s.name);
    expect(serviceNames).toContain('Widgets');
    expect(serviceNames).toContain('Gadgets');
    expect(serviceNames).toContain('Items');
    expect(serviceNames).toContain('Resources');
    expect(serviceNames).toContain('Configs');
    expect(serviceNames).toContain('Status');
  });

  it('no duplicate model names', () => {
    const names = ir.models.map((m) => m.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('no duplicate enum names', () => {
    const names = ir.enums.map((e) => e.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('inline models from nested objects are extracted', () => {
    const settings = findModel('Settings');
    expect(settings).toBeDefined();
    expect(settings!.fields.map((f) => f.name)).toContain('theme');
    expect(settings!.fields.map((f) => f.name)).toContain('notifications');
  });
});
