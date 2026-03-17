import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { generate } from '../../src/engine/orchestrator.js';
import { generateIncremental } from '../../src/engine/incremental.js';
import { diffSurfaces, specDerivedNames, filterSurface } from '../../src/compat/differ.js';
import { nodeHints } from '../../src/compat/language-hints.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';
import type { Emitter } from '../../src/engine/types.js';
import type { ApiSurface, ApiClass, ApiInterface, ApiField, ApiMethod, ApiTypeAlias } from '../../src/compat/types.js';

const FIXTURES = resolve(import.meta.dirname, '../fixtures');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Walk every TypeRef in a spec, calling `fn` on each one */
function walkTypeRefs(spec: ApiSpec, fn: (ref: TypeRef) => void): void {
  function visit(ref: TypeRef) {
    fn(ref);
    switch (ref.kind) {
      case 'array':
        visit(ref.items);
        break;
      case 'nullable':
        visit(ref.inner);
        break;
      case 'union':
        ref.variants.forEach((v) => visit(v));
        break;
      case 'map':
        visit(ref.valueType);
        break;
    }
  }
  for (const m of spec.models) for (const f of m.fields) visit(f.type);
  for (const s of spec.services) {
    for (const op of s.operations) {
      visit(op.response);
      if (op.requestBody) visit(op.requestBody);
      for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) visit(p.type);
    }
  }
}

/** Collect the set of all TypeRef.kind values present in a spec */
function collectTypeRefKinds(spec: ApiSpec): Set<string> {
  const kinds = new Set<string>();
  walkTypeRefs(spec, (ref) => kinds.add(ref.kind));
  return kinds;
}

/** Collect all primitive type names present (string, integer, etc.) */
function collectPrimitiveTypes(spec: ApiSpec): Set<string> {
  const types = new Set<string>();
  walkTypeRefs(spec, (ref) => {
    if (ref.kind === 'primitive') types.add(ref.type);
  });
  return types;
}

/** Collect all primitive format strings present (uuid, date-time, etc.) */
function collectFormats(spec: ApiSpec): Set<string> {
  const formats = new Set<string>();
  walkTypeRefs(spec, (ref) => {
    if (ref.kind === 'primitive' && ref.format) formats.add(ref.format);
  });
  return formats;
}

/** Convert a TypeRef to a simple type string (simulates extractor output) */
function typeRefToString(ref: TypeRef): string {
  switch (ref.kind) {
    case 'primitive':
      return ref.type;
    case 'array':
      return `${typeRefToString(ref.items)}[]`;
    case 'model':
      return ref.name;
    case 'enum':
      return ref.name;
    case 'nullable':
      return `${typeRefToString(ref.inner)} | null`;
    case 'union':
      return ref.variants.map((v) => typeRefToString(v)).join(' | ');
    case 'literal':
      return `"${ref.value}"`;
    case 'map':
      return `Record<string, ${typeRefToString(ref.valueType)}>`;
  }
}

/** Build an ApiSurface from IR (simulates what an extractor would produce) */
function irToSurface(spec: ApiSpec): ApiSurface {
  const classes: Record<string, ApiClass> = {};
  const interfaces: Record<string, ApiInterface> = {};
  const typeAliases: Record<string, ApiTypeAlias> = {};

  for (const service of spec.services) {
    const methods: Record<string, ApiMethod[]> = {};
    for (const op of service.operations) {
      methods[op.name] = [
        {
          name: op.name,
          params: [
            ...op.pathParams.map((p) => ({ name: p.name, type: typeRefToString(p.type), optional: !p.required })),
            ...op.queryParams.map((p) => ({ name: p.name, type: typeRefToString(p.type), optional: !p.required })),
          ],
          returnType: typeRefToString(op.response),
          async: true,
        },
      ];
    }
    classes[service.name] = {
      name: service.name,
      methods,
      properties: {},
      constructorParams: [],
    };
  }

  for (const model of spec.models) {
    const fields: Record<string, ApiField> = {};
    for (const field of model.fields) {
      fields[field.name] = {
        name: field.name,
        type: typeRefToString(field.type),
        optional: !field.required,
      };
    }
    interfaces[model.name] = {
      name: model.name,
      fields,
      extends: [],
    };
  }

  for (const e of spec.enums) {
    typeAliases[e.name] = {
      name: e.name,
      value: e.values.map((v) => `"${v.value}"`).join(' | '),
    };
  }

  return {
    language: 'mock',
    extractedFrom: '/mock-sdk',
    extractedAt: '2024-01-01T00:00:00Z',
    classes,
    interfaces,
    typeAliases,
    enums: {},
    exports: {},
  };
}

/** IR-aware mock emitter — file paths and content reflect actual IR structures */
function mockEmitter(): Emitter {
  return {
    language: 'mock',
    generateModels: (models) =>
      models.map((m) => ({
        path: `models/${m.name.toLowerCase()}.ts`,
        content: `export interface ${m.name} { ${m.fields.map((f) => f.name).join('; ')} }`,
      })),
    generateEnums: (enums) =>
      enums.map((e) => ({
        path: `enums/${e.name.toLowerCase()}.ts`,
        content: `export type ${e.name} = ${e.values.map((v) => `'${v.value}'`).join(' | ')};`,
      })),
    generateResources: (services) =>
      services.map((s) => ({
        path: `resources/${s.name.toLowerCase()}.ts`,
        content: `export class ${s.name} { ${s.operations.map((o) => o.name).join('; ')} }`,
      })),
    generateClient: () => [{ path: 'client.ts', content: 'export class Client {}' }],
    generateErrors: () => [{ path: 'errors.ts', content: 'export class ApiError {}' }],
    generateConfig: () => [{ path: 'config.ts', content: 'export const config = {};' }],
    generateTypeSignatures: (spec) => [
      ...spec.models.map((m) => ({ path: `types/${m.name.toLowerCase()}.d.ts`, content: '' })),
      ...spec.services.map((s) => ({ path: `types/${s.name.toLowerCase()}.d.ts`, content: '' })),
    ],
    generateTests: (spec) =>
      spec.services.map((s) => ({
        path: `test/${s.name.toLowerCase()}.test.ts`,
        content: '',
      })),
    fileHeader: () => '// Auto-generated by oagen',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('end-to-end pipeline', () => {
  let conformance: ApiSpec;

  beforeAll(async () => {
    conformance = await parseSpec(resolve(FIXTURES, 'conformance.yml'));
  });

  // ── Stage 1: Kitchen Sink Parse Coverage ──────────────────────────────────

  describe('Stage 1: kitchen sink parse coverage', () => {
    it('produces all 8 TypeRef variants from the conformance spec', () => {
      const kinds = collectTypeRefKinds(conformance);
      expect(kinds).toContain('primitive');
      expect(kinds).toContain('array');
      expect(kinds).toContain('model');
      expect(kinds).toContain('enum');
      expect(kinds).toContain('union');
      expect(kinds).toContain('nullable');
      expect(kinds).toContain('literal');
      expect(kinds).toContain('map');
      expect(kinds.size).toBe(8);
    });

    it('covers all primitive subtypes', () => {
      const types = collectPrimitiveTypes(conformance);
      expect(types).toContain('string');
      expect(types).toContain('integer');
      expect(types).toContain('number');
      expect(types).toContain('boolean');
    });

    it('covers key formats (uuid, date-time)', () => {
      const formats = collectFormats(conformance);
      expect(formats).toContain('uuid');
      expect(formats).toContain('date-time');
    });

    it('parses allOf composition (inline sub-schemas)', () => {
      const composed = conformance.models.find((m) => m.name === 'ComposedModel');
      expect(composed).toBeDefined();
      const fieldNames = composed!.fields.map((f) => f.name);
      expect(fieldNames).toContain('id');
      expect(fieldNames).toContain('name');
      expect(fieldNames).toContain('label');
    });

    it('parses allOf with $ref sub-schemas', () => {
      const extended = conformance.models.find((m) => m.name === 'ExtendedWidget');
      expect(extended).toBeDefined();
      // Should inherit fields from BaseWidget via $ref
      expect(extended!.fields.some((f) => f.name === 'id')).toBe(true);
      // Plus its own fields
      expect(extended!.fields.some((f) => f.name === 'extension_field')).toBe(true);
    });

    it('parses deeply nested allOf (allOf referencing another allOf)', () => {
      const deep = conformance.models.find((m) => m.name === 'DeeplyNested');
      expect(deep).toBeDefined();
      // base_id from NestedBase (which is itself allOf)
      expect(deep!.fields.some((f) => f.name === 'base_id')).toBe(true);
      // deep_field from DeeplyNested's own inline schema
      expect(deep!.fields.some((f) => f.name === 'deep_field')).toBe(true);
    });

    it('parses oneOf discriminated unions', () => {
      // EventContainer.event should be a union type
      const container = conformance.models.find((m) => m.name === 'EventContainer');
      expect(container).toBeDefined();
      const eventField = container!.fields.find((f) => f.name === 'event');
      expect(eventField).toBeDefined();
      expect(eventField!.type.kind).toBe('union');
      if (eventField!.type.kind === 'union') {
        expect(eventField!.type.discriminator).toBeDefined();
        expect(eventField!.type.discriminator!.property).toBe('event_type');
        expect(eventField!.type.variants.length).toBe(2);
      }
    });

    it('extracts standalone enums', () => {
      const widgetKind = conformance.enums.find((e) => e.name === 'WidgetKind');
      expect(widgetKind).toBeDefined();
      expect(widgetKind!.values.map((v) => v.value)).toEqual(['standard', 'premium', 'enterprise']);
    });

    it('extracts inline enums from model fields', () => {
      const gadget = conformance.models.find((m) => m.name === 'Gadget');
      expect(gadget).toBeDefined();
      const typeField = gadget!.fields.find((f) => f.name === 'type');
      expect(typeField).toBeDefined();
      expect(typeField!.type.kind).toBe('enum');
    });

    it('handles nullable fields — OAS 3.1 type array syntax', () => {
      const widget = conformance.models.find((m) => m.name === 'Widget');
      const parentId = widget!.fields.find((f) => f.name === 'parent_id');
      expect(parentId).toBeDefined();
      expect(parentId!.type.kind).toBe('nullable');
    });

    it('handles nullable fields — OAS 3.0 nullable flag', () => {
      const gadget = conformance.models.find((m) => m.name === 'Gadget');
      const value = gadget!.fields.find((f) => f.name === 'value');
      expect(value).toBeDefined();
      expect(value!.type.kind).toBe('nullable');
    });

    it('parses map types (additionalProperties)', () => {
      const widget = conformance.models.find((m) => m.name === 'Widget');
      const metadata = widget!.fields.find((f) => f.name === 'metadata');
      expect(metadata).toBeDefined();
      expect(metadata!.type.kind).toBe('map');
    });

    it('parses nested arrays (array of arrays)', () => {
      const matrix = conformance.models.find((m) => m.name === 'MatrixModel');
      const matrixField = matrix!.fields.find((f) => f.name === 'matrix');
      expect(matrixField).toBeDefined();
      expect(matrixField!.type.kind).toBe('array');
      if (matrixField!.type.kind === 'array') {
        expect(matrixField!.type.items.kind).toBe('array');
      }
    });

    it('parses literal (const) fields', () => {
      const literal = conformance.models.find((m) => m.name === 'LiteralModel');
      const objectField = literal!.fields.find((f) => f.name === 'object');
      expect(objectField).toBeDefined();
      expect(objectField!.type.kind).toBe('literal');
      if (objectField!.type.kind === 'literal') {
        expect(objectField!.type.value).toBe('literal_model');
      }
    });

    it('detects paginated list endpoints', () => {
      const listOp = conformance.services.flatMap((s) => s.operations).find((o) => o.name === 'listWidgets');
      expect(listOp).toBeDefined();
      expect(listOp!.pagination).toBeDefined();
    });

    it('extracts full CRUD operation set', () => {
      const opNames = conformance.services.flatMap((s) => s.operations).map((o) => o.name);
      expect(opNames).toContain('listWidgets');
      expect(opNames).toContain('createWidget');
      expect(opNames).toContain('getWidget');
      expect(opNames).toContain('updateWidget');
      expect(opNames).toContain('deleteWidget');
    });

    it('extracts error responses', () => {
      const createOp = conformance.services.flatMap((s) => s.operations).find((o) => o.name === 'createWidget');
      expect(createOp).toBeDefined();
      expect(createOp!.errors.length).toBeGreaterThan(0);
      expect(createOp!.errors.some((e) => e.statusCode === 400)).toBe(true);
    });

    it('extracts path, query, and header params', () => {
      const getOp = conformance.services.flatMap((s) => s.operations).find((o) => o.name === 'getWidget');
      expect(getOp).toBeDefined();
      expect(getOp!.pathParams.length).toBeGreaterThan(0);
      expect(getOp!.headerParams.length).toBeGreaterThan(0);

      const listOp = conformance.services.flatMap((s) => s.operations).find((o) => o.name === 'listWidgets');
      expect(listOp).toBeDefined();
      expect(listOp!.queryParams.length).toBeGreaterThan(0);
    });
  });

  // ── Stage 2: Spec Stability ────────────────────────────────────────────────

  describe('Stage 2: spec stability', () => {
    it('diffing identical specs produces zero changes', () => {
      const diff = diffSpecs(conformance, conformance);
      expect(diff.changes).toHaveLength(0);
      expect(diff.summary.breaking).toBe(0);
      expect(diff.summary.additive).toBe(0);
    });

    it('parsing the same spec twice produces identical IRs', async () => {
      const second = await parseSpec(resolve(FIXTURES, 'conformance.yml'));
      const diff = diffSpecs(conformance, second);
      expect(diff.changes).toHaveLength(0);
    });

    it('full generation is deterministic (same spec → same files)', async () => {
      const emitter = mockEmitter();
      const run1 = await generate(conformance, emitter, {
        namespace: 'Test',
        dryRun: true,
        outputDir: '/tmp/determinism-test',
      });
      const run2 = await generate(conformance, emitter, {
        namespace: 'Test',
        dryRun: true,
        outputDir: '/tmp/determinism-test',
      });

      expect(run1.map((f) => f.path)).toEqual(run2.map((f) => f.path));
      expect(run1.map((f) => f.content)).toEqual(run2.map((f) => f.content));
    });
  });

  // ── Stage 3: Full Update Pipeline ──────────────────────────────────────────

  describe('Stage 3: spec update → diff → generate → verify', () => {
    let v1: ApiSpec;
    let v2: ApiSpec;

    beforeAll(() => {
      v1 = conformance;
      v2 = structuredClone(conformance);
      v2.version = '2.0.0';

      const widget = v2.models.find((m) => m.name === 'Widget')!;

      // Breaking: Widget.count integer → string
      const countField = widget.fields.find((f) => f.name === 'count')!;
      countField.type = { kind: 'primitive', type: 'string' };

      // Breaking: remove Widget.score
      widget.fields = widget.fields.filter((f) => f.name !== 'score');

      // Breaking: remove 'standard' from WidgetKind
      const widgetKind = v2.enums.find((e) => e.name === 'WidgetKind')!;
      widgetKind.values = widgetKind.values.filter((v) => v.value !== 'standard');

      // Additive: add optional Widget.priority
      widget.fields.push({
        name: 'priority',
        type: { kind: 'primitive', type: 'integer' },
        required: false,
      });

      // Additive: add 'premium_plus' to WidgetKind
      widgetKind.values.push({ name: 'PremiumPlus', value: 'premium_plus' });

      // Additive: new WidgetStats model
      v2.models.push({
        name: 'WidgetStats',
        fields: [
          { name: 'widget_id', type: { kind: 'primitive', type: 'string', format: 'uuid' }, required: true },
          { name: 'view_count', type: { kind: 'primitive', type: 'integer' }, required: true },
          { name: 'last_viewed_at', type: { kind: 'primitive', type: 'string', format: 'date-time' }, required: false },
        ],
      });

      // Additive: new operation on Widgets service
      const widgetsService = v2.services.find((s) => s.operations.some((o) => o.name === 'listWidgets'))!;
      widgetsService.operations.push({
        name: 'getWidgetStats',
        httpMethod: 'get',
        path: '/widgets/{widget_id}/stats',
        pathParams: [
          { name: 'widget_id', type: { kind: 'primitive', type: 'string', format: 'uuid' }, required: true },
        ],
        queryParams: [],
        headerParams: [],
        response: { kind: 'model', name: 'WidgetStats' },
        errors: [],
        idempotent: false,
      });
    });

    // ── Diff ──

    it('detects both additive and breaking changes', () => {
      const diff = diffSpecs(v1, v2);
      expect(diff.changes.length).toBeGreaterThan(0);
      expect(diff.summary.additive).toBeGreaterThan(0);
      expect(diff.summary.breaking).toBeGreaterThan(0);
    });

    it('classifies field type change as breaking', () => {
      const diff = diffSpecs(v1, v2);
      const widgetMod = diff.changes.find((c) => c.kind === 'model-modified' && c.name === 'Widget');
      expect(widgetMod).toBeDefined();
      if (widgetMod?.kind === 'model-modified') {
        const countChange = widgetMod.fieldChanges.find((fc) => fc.fieldName === 'count');
        expect(countChange).toBeDefined();
        expect(countChange!.kind).toBe('field-type-changed');
        expect(countChange!.classification).toBe('breaking');
      }
    });

    it('classifies field removal as breaking', () => {
      const diff = diffSpecs(v1, v2);
      const widgetMod = diff.changes.find((c) => c.kind === 'model-modified' && c.name === 'Widget');
      if (widgetMod?.kind === 'model-modified') {
        const scoreRemoved = widgetMod.fieldChanges.find((fc) => fc.fieldName === 'score');
        expect(scoreRemoved).toBeDefined();
        expect(scoreRemoved!.kind).toBe('field-removed');
        expect(scoreRemoved!.classification).toBe('breaking');
      }
    });

    it('classifies optional field addition as additive', () => {
      const diff = diffSpecs(v1, v2);
      const widgetMod = diff.changes.find((c) => c.kind === 'model-modified' && c.name === 'Widget');
      if (widgetMod?.kind === 'model-modified') {
        const priorityAdded = widgetMod.fieldChanges.find((fc) => fc.fieldName === 'priority');
        expect(priorityAdded).toBeDefined();
        expect(priorityAdded!.kind).toBe('field-added');
        expect(priorityAdded!.classification).toBe('additive');
      }
    });

    it('classifies enum value removal as breaking', () => {
      const diff = diffSpecs(v1, v2);
      const enumMod = diff.changes.find((c) => c.kind === 'enum-modified' && c.name === 'WidgetKind');
      expect(enumMod).toBeDefined();
      if (enumMod?.kind === 'enum-modified') {
        const removed = enumMod.valueChanges.find((vc) => vc.kind === 'value-removed');
        expect(removed).toBeDefined();
        expect(removed!.classification).toBe('breaking');
      }
    });

    it('classifies enum value addition as additive', () => {
      const diff = diffSpecs(v1, v2);
      const enumMod = diff.changes.find((c) => c.kind === 'enum-modified' && c.name === 'WidgetKind');
      if (enumMod?.kind === 'enum-modified') {
        const added = enumMod.valueChanges.find((vc) => vc.kind === 'value-added');
        expect(added).toBeDefined();
        expect(added!.classification).toBe('additive');
      }
    });

    it('detects new model addition', () => {
      const diff = diffSpecs(v1, v2);
      const modelAdded = diff.changes.find((c) => c.kind === 'model-added' && c.name === 'WidgetStats');
      expect(modelAdded).toBeDefined();
      expect(modelAdded!.classification).toBe('additive');
    });

    it('detects new operation addition', () => {
      const diff = diffSpecs(v1, v2);
      const opAdded = diff.changes.find((c) => c.kind === 'operation-added' && c.operationName === 'getWidgetStats');
      expect(opAdded).toBeDefined();
      expect(opAdded!.classification).toBe('additive');
    });

    // ── Incremental Generation ──

    it('incremental generation only regenerates affected files', async () => {
      const result = await generateIncremental(v1, v2, mockEmitter(), {
        namespace: 'Test',
        outputDir: '/tmp/pipeline-test',
        dryRun: true,
      });

      const paths = result.generated.map((f) => f.path);

      // Widget model was modified → regenerate
      expect(paths).toContain('models/widget.ts');
      expect(paths).toContain('types/widget.d.ts');

      // WidgetKind enum was modified → regenerate
      expect(paths).toContain('enums/widgetkind.ts');

      // New model added → regenerate
      expect(paths).toContain('models/widgetstats.ts');
      expect(paths).toContain('types/widgetstats.d.ts');

      // Service referencing Widget should be regenerated (cascade)
      const hasServiceFile = paths.some((p) => p.startsWith('resources/'));
      expect(hasServiceFile).toBe(true);
    });

    it('unaffected models are NOT regenerated', async () => {
      const result = await generateIncremental(v1, v2, mockEmitter(), {
        namespace: 'Test',
        outputDir: '/tmp/pipeline-test',
        dryRun: true,
      });

      const paths = result.generated.map((f) => f.path);

      // BaseWidget was not changed
      expect(paths).not.toContain('models/basewidget.ts');
      // ComposedModel was not changed
      expect(paths).not.toContain('models/composedmodel.ts');
    });

    it('diff report is included in incremental result', async () => {
      const result = await generateIncremental(v1, v2, mockEmitter(), {
        namespace: 'Test',
        outputDir: '/tmp/pipeline-test',
        dryRun: true,
      });

      expect(result.diff.oldVersion).toBe('1.0.0');
      expect(result.diff.newVersion).toBe('2.0.0');
      expect(result.diff.changes.length).toBeGreaterThan(0);
    });

    // ── Compat Verification ──

    it('compat verification catches breaking changes', () => {
      const baseline = irToSurface(v1);
      const candidate = irToSurface(v2);
      const result = diffSurfaces(baseline, candidate, nodeHints);

      expect(result.violations.length).toBeGreaterThan(0);

      // Widget.score removed → breaking
      const scoreViolation = result.violations.find((v) => v.symbolPath === 'Widget.score');
      expect(scoreViolation).toBeDefined();
      expect(scoreViolation!.severity).toBe('breaking');

      // Widget.count type changed → breaking
      const countViolation = result.violations.find((v) => v.symbolPath === 'Widget.count');
      expect(countViolation).toBeDefined();
      expect(countViolation!.severity).toBe('breaking');

      // Preservation score < 100
      expect(result.preservationScore).toBeLessThan(100);
    });

    it('compat verification reports additive changes as additions', () => {
      const baseline = irToSurface(v1);
      const candidate = irToSurface(v2);
      const result = diffSurfaces(baseline, candidate, nodeHints);

      // New WidgetStats interface → addition
      const statsAddition = result.additions.find((a) => a.symbolPath === 'WidgetStats');
      expect(statsAddition).toBeDefined();

      // New getWidgetStats method → addition
      const opsAddition = result.additions.find((a) => a.symbolPath.includes('getWidgetStats'));
      expect(opsAddition).toBeDefined();
    });

    it('compat verification passes for additive-only changes', () => {
      const v2Additive = structuredClone(v1);
      v2Additive.version = '2.0.0';

      // Only additive: new optional field
      const widget = v2Additive.models.find((m) => m.name === 'Widget')!;
      widget.fields.push({
        name: 'priority',
        type: { kind: 'primitive', type: 'integer' },
        required: false,
      });

      // Only additive: new model
      v2Additive.models.push({
        name: 'WidgetStats',
        fields: [{ name: 'widget_id', type: { kind: 'primitive', type: 'string' }, required: true }],
      });

      const baseline = irToSurface(v1);
      const candidate = irToSurface(v2Additive);
      const result = diffSurfaces(baseline, candidate, nodeHints);

      const breakingViolations = result.violations.filter((v) => v.severity === 'breaking');
      expect(breakingViolations).toHaveLength(0);
      expect(result.preservationScore).toBe(100);
      expect(result.additions.length).toBeGreaterThan(0);
    });

    it('specDerivedNames includes all spec-generated symbols', () => {
      const names = specDerivedNames(v1, nodeHints);

      // Models + Response/Serialized variants
      expect(names.has('Widget')).toBe(true);
      expect(names.has('WidgetResponse')).toBe(true);
      expect(names.has('SerializedWidget')).toBe(true);

      // Enums
      expect(names.has('WidgetKind')).toBe(true);

      // Services
      for (const service of v1.services) {
        expect(names.has(service.name)).toBe(true);
      }
    });

    it('filterSurface excludes hand-written symbols', () => {
      const surface = irToSurface(v1);
      // Simulate a hand-written class that's not in the spec
      surface.classes['CustomHelper'] = {
        name: 'CustomHelper',
        methods: {},
        properties: {},
        constructorParams: [],
      };

      const names = specDerivedNames(v1, nodeHints);
      const filtered = filterSurface(surface, names);

      expect(filtered.classes['CustomHelper']).toBeUndefined();
      for (const service of v1.services) {
        expect(filtered.classes[service.name]).toBeDefined();
      }
    });
  });

  // ── Stage 4: YAML Fixture Full Pipeline ────────────────────────────────────

  describe('Stage 4: YAML fixtures through full pipeline', () => {
    it('v1 → v2-mixed: parse, diff, generate, verify', async () => {
      const v1 = await parseSpec(resolve(FIXTURES, 'v1.yml'));
      const v2 = await parseSpec(resolve(FIXTURES, 'v2-mixed.yml'));

      // Diff
      const diff = diffSpecs(v1, v2);
      expect(diff.changes.length).toBeGreaterThan(0);
      expect(diff.summary.breaking).toBeGreaterThan(0);
      expect(diff.summary.additive).toBeGreaterThan(0);

      // Generate
      const result = await generateIncremental(v1, v2, mockEmitter(), {
        namespace: 'Test',
        outputDir: '/tmp/pipeline-yaml-test',
        dryRun: true,
      });
      expect(result.generated.length).toBeGreaterThan(0);
      expect(result.diff.changes.length).toBeGreaterThan(0);

      // Verify
      const baseline = irToSurface(v1);
      const candidate = irToSurface(v2);
      const compat = diffSurfaces(baseline, candidate, nodeHints);

      // User.name changed from string to integer → breaking
      const nameViolation = compat.violations.find((v) => v.symbolPath === 'User.name');
      expect(nameViolation).toBeDefined();
      expect(nameViolation!.severity).toBe('breaking');

      // New Team model + listTeams operation → additions
      expect(compat.additions.length).toBeGreaterThan(0);
    });

    it('v1 → v1: no changes produces no generation and clean compat', async () => {
      const v1 = await parseSpec(resolve(FIXTURES, 'v1.yml'));

      const diff = diffSpecs(v1, v1);
      expect(diff.changes).toHaveLength(0);

      const result = await generateIncremental(v1, v1, mockEmitter(), {
        namespace: 'Test',
        outputDir: '/tmp/pipeline-noop-test',
        dryRun: true,
      });
      expect(result.generated).toHaveLength(0);
      expect(result.deleted).toHaveLength(0);

      const surface = irToSurface(v1);
      const compat = diffSurfaces(surface, surface, nodeHints);
      expect(compat.preservationScore).toBe(100);
      expect(compat.violations).toHaveLength(0);
    });
  });
});
