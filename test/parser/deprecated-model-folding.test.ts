import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import { collectModelRefs, collectResponseHeaders } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #260: a live operation or field must never end up referring to a
 * model marked `deprecated` because two inline models, or an inline model
 * and a component, shared a name — whatever order the document declares
 * them in. The deprecated copy takes a qualified name instead; only copies
 * identical in everything but the flag still fold, onto the live one.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-deprecated-folding-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** A minimal OpenAPI 3.1 document around `schemas` and `paths`. */
const specDoc = (schemas: Record<string, unknown>, paths: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'folding', version: '1' },
  paths,
  components: { schemas },
});

/** A GET whose 200 body is `schema`. */
const getOp = (operationId: string, schema: unknown, extra: Record<string, unknown> = {}) => ({
  get: {
    operationId,
    ...extra,
    responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
  },
});

/** A POST whose request body is `schema` and whose 200 body is `response`. */
const postOp = (operationId: string, schema: unknown, response: unknown = { type: 'string' }) => ({
  post: {
    operationId,
    requestBody: { content: { 'application/json': { schema } } },
    responses: { '200': { description: 'OK', content: { 'application/json': { schema: response } } } },
  },
});

/** The issue's projection of a model: flag, `name: type` per field, and the required names. */
const describeModels = (spec: ApiSpec) =>
  spec.models.map(({ deprecated, fields, name }) => ({
    deprecated,
    fields: fields.map(
      ({ name: f, type }) => `${f}: ${'name' in type ? type.name : 'type' in type ? type.type : type.kind}`,
    ),
    name,
    required: fields.filter(({ required }) => required).map(({ name: f }) => f),
  }));

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

/** Every type reference an operation holds, labelled by where it sits. */
function operationRefs(op: Operation): Array<[string, TypeRef, boolean]> {
  const refs: Array<[string, TypeRef, boolean]> = [[`${op.name}.response`, op.response, false]];
  if (op.requestBody) refs.push([`${op.name}.requestBody`, op.requestBody, false]);
  for (const r of op.successResponses ?? []) refs.push([`${op.name}.${r.statusCode}`, r.type, false]);
  for (const e of op.errors) if (e.type) refs.push([`${op.name}.${e.statusCode}`, e.type, false]);
  for (const f of op.pagination?.envelopeFields ?? []) refs.push([`${op.name}.${f.name}`, f.type, !!f.deprecated]);
  if (op.pagination) refs.push([`${op.name}.items`, op.pagination.itemType, false]);
  for (const h of collectResponseHeaders(op)) refs.push([`${op.name}.${h.name}`, h.type, !!h.deprecated]);
  for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
    refs.push([`${op.name}(${p.name})`, p.type, !!p.deprecated]);
  }
  if (op.defaultResponse?.type) refs.push([`${op.name}.default`, op.defaultResponse.type, false]);
  for (const r of op.rangeResponses ?? []) if (r.type) refs.push([`${op.name}.${r.range}`, r.type, false]);
  return refs;
}

/** Every model name a model references: its fields, its named-union variants and its discriminator mapping's targets. */
function modelRefs(model: Model): Array<[string, string]> {
  const names: Array<[string, string]> = [];
  for (const field of model.fields) for (const name of collectModelRefs(field.type)) names.push([field.name, name]);
  for (const [i, variant] of (model.variants ?? []).entries()) {
    for (const name of collectModelRefs(variant)) names.push([`variant${i}`, name]);
  }
  for (const target of Object.values(model.discriminator?.mapping ?? {})) names.push(['discriminator', target]);
  return names;
}

/**
 * Every reference from a live operation, or from a live field of a live
 * model, that resolves to a deprecated model — as `"owner → Model"`. A
 * reference whose own schema was written deprecated (a deprecated operation,
 * field, parameter or header) is not counted: the document said so itself.
 */
function deprecatedReferences(spec: ApiSpec): string[] {
  const deprecated = new Set(spec.models.filter((m) => m.deprecated).map((m) => m.name));
  const found: string[] = [];
  for (const op of Object.values(opsOf(spec))) {
    if (op.deprecated) continue;
    for (const [owner, ref, ownerDeprecated] of operationRefs(op)) {
      if (ownerDeprecated) continue;
      for (const name of collectModelRefs(ref)) if (deprecated.has(name)) found.push(`${owner} → ${name}`);
    }
  }
  for (const model of spec.models) {
    if (model.deprecated) continue;
    for (const field of model.fields) {
      if (field.deprecated) continue;
      for (const name of collectModelRefs(field.type)) {
        if (deprecated.has(name)) found.push(`${model.name}.${field.name} → ${name}`);
      }
    }
  }
  return found.sort();
}

/** Every model reference — from operations, model fields, named-union variants and discriminator mappings alike — that names no model. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const found: string[] = [];
  for (const op of Object.values(opsOf(spec))) {
    for (const [owner, ref] of operationRefs(op)) {
      for (const name of collectModelRefs(ref)) if (!names.has(name)) found.push(`${owner} → ${name}`);
    }
  }
  for (const model of spec.models) {
    for (const [where, name] of modelRefs(model)) if (!names.has(name)) found.push(`${model.name}.${where} → ${name}`);
  }
  return found.sort();
}

/** Every model that is neither a component nor referenced by any operation, model field, named-union variant or discriminator mapping. */
function orphanedModels(spec: ApiSpec, componentNames: string[]): string[] {
  const referenced = new Set<string>();
  for (const op of Object.values(opsOf(spec))) {
    for (const [, ref] of operationRefs(op)) for (const name of collectModelRefs(ref)) referenced.add(name);
  }
  for (const model of spec.models) for (const [, name] of modelRefs(model)) referenced.add(name);
  return spec.models
    .map((m) => m.name)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

/**
 * The invariants every case below holds, the ones the `…Json` fold's tests
 * hold it to (`json-suffix-fold.test.ts`) read off a parsed document: every
 * reference resolves, every model that is not a component is referenced,
 * no two models share a name, no model is named like an enum, and no
 * undeclared reference reaches a deprecated model.
 */
function expectSound(spec: ApiSpec, componentNames: string[], declaredDeprecated: string[] = []): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec, componentNames)).toEqual([]);
  const names = spec.models.map((m) => m.name);
  expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  const enumNames = new Set(spec.enums.map((e) => e.name));
  expect(spec.models.map((m) => m.name).filter((name) => enumNames.has(name))).toEqual([]);
  expect(deprecatedReferences(spec)).toEqual([...declaredDeprecated].sort());
}

/** Parse `paths` in both orders and return both results with their warnings. */
async function parseBothOrders(
  label: string,
  schemas: Record<string, unknown>,
  paths: Array<[string, unknown]>,
): Promise<Array<{ order: string; spec: ApiSpec; warnings: string[] }>> {
  const results = [];
  for (const [order, ordered] of [
    ['as-written', paths],
    ['swapped', [...paths].reverse()],
  ] as const) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spec = await parseSpec(
        await writeSpec(`${label}-${order}.json`, specDoc(schemas, Object.fromEntries(ordered))),
      );
      results.push({ order, spec, warnings: warn.mock.calls.map(([m]) => String(m)) });
    } finally {
      warn.mockRestore();
    }
  }
  return results;
}

describe('two inline responses of one name (issue #260, case 1)', () => {
  // The issue's repro, verbatim: a deprecated inline object and a live one
  // that also requires `a`, both named `Widget` from their `object` const.
  const legacy = getOp('getLegacyWidget', {
    type: 'object',
    deprecated: true,
    properties: { object: { type: 'string', const: 'widget' }, a: { type: 'string' } },
  });
  const live = getOp('getWidget', {
    type: 'object',
    required: ['a'],
    properties: { object: { type: 'string', const: 'widget' }, a: { type: 'string' } },
  });

  it('gives the deprecated copy an operation-qualified name and the live copy the shared one, in either path order', async () => {
    const results = await parseBothOrders('widgets', {}, [
      ['/legacy-widgets/{id}', legacy],
      ['/widgets/{id}', live],
    ]);
    for (const { order, spec, warnings } of results) {
      const ops = opsOf(spec);
      expect(
        describeModels(spec).sort((a, b) => a.name.localeCompare(b.name)),
        order,
      ).toEqual([
        { deprecated: true, fields: ['object: literal', 'a: string'], name: 'GetLegacyWidgetWidget', required: [] },
        { deprecated: undefined, fields: ['object: literal', 'a: string'], name: 'Widget', required: ['a'] },
      ]);
      expect(ops.getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
      // The operation itself is live; its own response schema is what it
      // declared deprecated, so that one reference is the document's own.
      expectSound(spec, [], ['getLegacyWidget.response → GetLegacyWidgetWidget']);
      expect(warnings, order).toEqual([
        '[oagen] Renamed inline model "Widget" → "GetLegacyWidgetWidget": it is deprecated while "Widget" is live',
      ]);
    }
    // Both orders yield the same models and references (the list's own order
    // follows the paths', as it always has).
    const byName = (spec: ApiSpec) => describeModels(spec).sort((a, b) => a.name.localeCompare(b.name));
    expect(byName(results[0]!.spec)).toEqual(byName(results[1]!.spec));
  });

  it('still folds copies identical in everything but the flag onto the live one, and says so, in either path order', async () => {
    const legacySame = getOp('getLegacyWidget', {
      type: 'object',
      deprecated: true,
      required: ['a'],
      properties: { object: { type: 'string', const: 'widget' }, a: { type: 'string' } },
    });
    const results = await parseBothOrders('same-widgets', {}, [
      ['/legacy-widgets/{id}', legacySame],
      ['/widgets/{id}', live],
    ]);
    for (const { order, spec, warnings } of results) {
      const ops = opsOf(spec);
      expect(describeModels(spec), order).toEqual([
        { deprecated: undefined, fields: ['object: literal', 'a: string'], name: 'Widget', required: ['a'] },
      ]);
      expect(ops.getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expectSound(spec, []);
      expect(warnings, order).toEqual([
        '[oagen] Warning: Inline model "Widget" is declared both deprecated and live with the same shape — keeping the live definition under the shared name',
      ]);
    }
  });

  it('gives a live copy the shared name even when the deprecated copy is the larger one', async () => {
    const largerLegacy = getOp('getLegacyWidget', {
      type: 'object',
      deprecated: true,
      properties: { object: { type: 'string', const: 'widget' }, a: { type: 'string' }, b: { type: 'string' } },
    });
    for (const { order, spec } of await parseBothOrders('larger-legacy', {}, [
      ['/legacy-widgets/{id}', largerLegacy],
      ['/widgets/{id}', live],
    ])) {
      const ops = opsOf(spec);
      expect(ops.getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
      expect(
        spec.models.find((m) => m.name === 'Widget')?.fields.map((f) => f.name),
        order,
      ).toEqual(['object', 'a']);
      expectSound(spec, [], ['getLegacyWidget.response → GetLegacyWidgetWidget']);
    }
  });

  it('renames a nested model under the renamed response only when it must, and repoints the renamed response to it', async () => {
    const withOwner = (deprecatedOwner: boolean, extra: Record<string, unknown>) => ({
      type: 'object',
      ...extra,
      properties: {
        object: { type: 'string', const: 'widget' },
        owner: {
          type: 'object',
          ...(deprecatedOwner ? { deprecated: true } : {}),
          properties: { name: { type: 'string' }, ...(deprecatedOwner ? { legacy_id: { type: 'string' } } : {}) },
        },
      },
    });
    // A nested object both copies share by shape stays one live model.
    for (const { order, spec } of await parseBothOrders('nested-shared', {}, [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', withOwner(false, { deprecated: true, required: ['owner'] }))],
      ['/widgets/{id}', getOp('getWidget', withOwner(false, {}))],
    ])) {
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      expect(Object.keys(byName).sort(), order).toEqual(['GetLegacyWidgetWidget', 'Widget', 'WidgetOwner']);
      expect(byName.GetLegacyWidgetWidget?.fields.find((f) => f.name === 'owner')?.type, order).toEqual({
        kind: 'model',
        name: 'WidgetOwner',
      });
      expect(byName.Widget?.fields.find((f) => f.name === 'owner')?.type, order).toEqual({
        kind: 'model',
        name: 'WidgetOwner',
      });
      expectSound(spec, [], ['getLegacyWidget.response → GetLegacyWidgetWidget']);
    }
    // A nested object only the deprecated copy deprecates, with a different
    // shape, is qualified by the same operation and referenced from the
    // renamed response alone.
    for (const { order, spec } of await parseBothOrders('nested-deprecated', {}, [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', withOwner(true, { deprecated: true, required: ['owner'] }))],
      ['/widgets/{id}', getOp('getWidget', withOwner(false, {}))],
    ])) {
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      expect(Object.keys(byName).sort(), order).toEqual([
        'GetLegacyWidgetWidget',
        'GetLegacyWidgetWidgetOwner',
        'Widget',
        'WidgetOwner',
      ]);
      expect(byName.GetLegacyWidgetWidget?.fields.find((f) => f.name === 'owner')?.type, order).toEqual({
        kind: 'model',
        name: 'GetLegacyWidgetWidgetOwner',
      });
      expect(byName.GetLegacyWidgetWidgetOwner?.deprecated, order).toBe(true);
      expect(byName.Widget?.fields.find((f) => f.name === 'owner')?.type, order).toEqual({
        kind: 'model',
        name: 'WidgetOwner',
      });
      expect(byName.WidgetOwner?.deprecated, order).toBeUndefined();
      // The nested object's own field was written deprecated, so its reference is the document's own too.
      expectSound(spec, [], ['getLegacyWidget.response → GetLegacyWidgetWidget']);
    }
  });

  it('takes a numeric suffix when the operation-qualified name is already a component’s', async () => {
    const taken = { type: 'object', properties: { unrelated: { type: 'string' } } };
    for (const { order, spec } of await parseBothOrders('taken', { GetLegacyWidgetWidget: taken }, [
      ['/legacy-widgets/{id}', legacy],
      ['/widgets/{id}', live],
    ])) {
      const ops = opsOf(spec);
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget2' });
      expect(
        spec.models.find((m) => m.name === 'GetLegacyWidgetWidget')?.fields.map((f) => f.name),
        order,
      ).toEqual(['unrelated']);
      expectSound(spec, ['GetLegacyWidgetWidget'], ['getLegacyWidget.response → GetLegacyWidgetWidget2']);
    }
  });
});

describe('an inline model named like a differently flagged component (issue #260, case 2)', () => {
  it('gives `Pet.owner` a model of its own instead of the deprecated `PetOwner` component (the issue’s repro)', async () => {
    const schemas = {
      Pet: { type: 'object', properties: { owner: { type: 'object', properties: { name: { type: 'string' } } } } },
      PetOwner: { type: 'object', deprecated: true, properties: { name: { type: 'string' } } },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spec = await parseSpec(await writeSpec('pet.json', specDoc(schemas)));
      expect(describeModels(spec)).toEqual([
        { deprecated: undefined, fields: ['owner: PetOwner2'], name: 'Pet', required: [] },
        { deprecated: true, fields: ['name: string'], name: 'PetOwner', required: [] },
        { deprecated: undefined, fields: ['name: string'], name: 'PetOwner2', required: [] },
      ]);
      expectSound(spec, ['Pet', 'PetOwner']);
      expect(warn.mock.calls.map(([m]) => String(m))).toEqual([
        '[oagen] Renamed inline model "PetOwner" → "PetOwner2": it is live while "PetOwner" is deprecated',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('folds a deprecated field object identical to a live component onto it: the field keeps the flag (issue #312)', async () => {
    const schemas = {
      Pet: {
        type: 'object',
        properties: { owner: { type: 'object', deprecated: true, properties: { name: { type: 'string' } } } },
      },
      PetOwner: { type: 'object', properties: { name: { type: 'string' } } },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spec = await parseSpec(await writeSpec('pet-reverse.json', specDoc(schemas)));
      // The component's flag is its own (live); the deprecation is the
      // field's, not a second `PetOwner2` of the same shape.
      expect(describeModels(spec)).toEqual([
        { deprecated: undefined, fields: ['owner: PetOwner'], name: 'Pet', required: [] },
        { deprecated: undefined, fields: ['name: string'], name: 'PetOwner', required: [] },
      ]);
      expect(spec.models.find((m) => m.name === 'Pet')?.fields[0]?.deprecated).toBe(true);
      expectSound(spec, ['Pet', 'PetOwner']);
      expect(warn.mock.calls.map(([m]) => String(m))).toEqual([
        '[oagen] Warning: Inline model "PetOwner" is declared both deprecated and live with the same shape — keeping the live definition under the shared name',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('gives an inline request body a model of its own instead of the deprecated `CreateNoteRequest` component', async () => {
    const body = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };
    const schemas = {
      CreateNoteRequest: {
        type: 'object',
        deprecated: true,
        required: ['title'],
        properties: { title: { type: 'string' } },
      },
    };
    const spec = await parseSpec(
      await writeSpec('note.json', specDoc(schemas, { '/notes': postOp('createNote', body) })),
    );
    const ops = opsOf(spec);
    expect(ops.createNote?.requestBody).toEqual({ kind: 'model', name: 'CreateNoteRequest2' });
    expect(describeModels(spec)).toEqual([
      { deprecated: true, fields: ['title: string'], name: 'CreateNoteRequest', required: ['title'] },
      { deprecated: undefined, fields: ['title: string'], name: 'CreateNoteRequest2', required: ['title'] },
    ]);
    expectSound(spec, ['CreateNoteRequest']);

    // And the other way round: a deprecated body identical to the live
    // component folds onto it (issue #312) — the body is what the SDK sends,
    // so an identical shape is required, and the flag is not part of it.
    const reversed = await parseSpec(
      await writeSpec(
        'note-reverse.json',
        specDoc(
          { CreateNoteRequest: { ...schemas.CreateNoteRequest, deprecated: undefined } },
          { '/notes': postOp('createNote', { ...body, deprecated: true }) },
        ),
      ),
    );
    expect(opsOf(reversed).createNote?.requestBody).toEqual({ kind: 'model', name: 'CreateNoteRequest' });
    expect(describeModels(reversed)).toEqual([
      { deprecated: undefined, fields: ['title: string'], name: 'CreateNoteRequest', required: ['title'] },
    ]);
    expectSound(reversed, ['CreateNoteRequest']);
  });

  it('gives an inline response named like a differently flagged component a qualified name, whatever its shape', async () => {
    type Widget = { type: string; deprecated?: boolean; properties: Record<string, unknown> };
    const widget = (extra: Partial<Widget>): Widget => ({
      type: 'object',
      properties: { object: { type: 'string', const: 'widget' }, k: { type: 'string' } },
      ...extra,
    });
    // A deprecated response of the component's own shape beside a live
    // component folds onto it instead (issue #312; see the next test).
    const cases: Array<[string, Widget, Widget]> = [
      ['same shape, component deprecated', widget({ deprecated: true }), widget({})],
      [
        'larger response, component deprecated',
        widget({ deprecated: true }),
        widget({ properties: { ...widget({}).properties, extra: { type: 'string' } } }),
      ],
    ];
    for (const [label, component, response] of cases) {
      for (const { order, spec, warnings } of await parseBothOrders(label.replace(/\W+/g, '-'), { Widget: component }, [
        ['/widgets/{id}', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
        ['/legacy-widgets/{id}', getOp('getLegacyWidget', response)],
      ])) {
        const where = `${label}, ${order}`;
        const ops = opsOf(spec);
        expect(ops.getWidget?.response, where).toEqual({ kind: 'model', name: 'Widget' });
        expect(ops.getLegacyWidget?.response, where).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
        const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
        expect(byName.Widget?.deprecated, where).toBe(component.deprecated);
        expect(
          byName.Widget?.fields.map((f) => f.name),
          where,
        ).toEqual(['object', 'k']);
        expect(byName.GetLegacyWidgetWidget?.deprecated, where).toBe(response.deprecated);
        expect(
          byName.GetLegacyWidgetWidget?.fields.map((f) => f.name),
          where,
        ).toEqual(Object.keys(response.properties));
        // `getWidget` `$ref`s the component as written, so when the component
        // is deprecated that reference is the document's own; likewise the
        // legacy operation's own deprecated response.
        expectSound(
          spec,
          ['Widget'],
          [
            ...(component.deprecated ? ['getWidget.response → Widget'] : []),
            ...(response.deprecated ? ['getLegacyWidget.response → GetLegacyWidgetWidget'] : []),
          ],
        );
        expect(
          warnings.filter((w) => w.includes('component')),
          where,
        ).toEqual([]);
      }
    }
  });

  it('folds a deprecated response identical to a live component onto it, and says so, in either path order (issue #312)', async () => {
    const widget = (extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: { object: { type: 'string', const: 'widget' }, k: { type: 'string' } },
      ...extra,
    });
    for (const { order, spec, warnings } of await parseBothOrders(
      'same-shape-response-deprecated',
      { Widget: widget() },
      [
        ['/widgets/{id}', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
        ['/legacy-widgets/{id}', getOp('getLegacyWidget', widget({ deprecated: true }))],
      ],
    )) {
      const ops = opsOf(spec);
      expect(ops.getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(describeModels(spec), order).toEqual([
        { deprecated: undefined, fields: ['object: literal', 'k: string'], name: 'Widget', required: [] },
      ]);
      expectSound(spec, ['Widget']);
      expect(warnings, order).toEqual([
        '[oagen] Warning: Inline model "Widget" is declared both deprecated and live with the same shape — keeping the live definition under the shared name',
      ]);
    }
  });

  it('leaves a `$ref` to the component elsewhere in the same operation alone', async () => {
    const schemas = {
      Widget: { type: 'object', properties: { object: { type: 'string', const: 'widget' }, k: { type: 'string' } } },
    };
    const response = {
      type: 'object',
      deprecated: true,
      properties: { object: { type: 'string', const: 'widget' }, k: { type: 'string' }, extra: { type: 'string' } },
    };
    const spec = await parseSpec(
      await writeSpec(
        'ref-beside.json',
        specDoc(schemas, { '/widgets': postOp('updateWidget', { $ref: '#/components/schemas/Widget' }, response) }),
      ),
    );
    const ops = opsOf(spec);
    expect(ops.updateWidget?.requestBody).toEqual({ kind: 'model', name: 'Widget' });
    expect(ops.updateWidget?.response).toEqual({ kind: 'model', name: 'UpdateWidgetWidget' });
    expectSound(spec, ['Widget'], ['updateWidget.response → UpdateWidgetWidget']);
  });

  it('covers array items and `oneOf` variants of a component field', async () => {
    const schemas = {
      Pet: {
        type: 'object',
        properties: {
          toys: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
          home: {
            oneOf: [
              { type: 'object', properties: { street: { type: 'string' } } },
              { type: 'object', properties: { city: { type: 'string' } } },
            ],
          },
        },
      },
      // The items of `Pet.toys` are named `PetToys`, the first `home` variant `PetHome`.
      PetToys: { type: 'object', deprecated: true, properties: { name: { type: 'string' } } },
      PetHome: { type: 'object', deprecated: true, properties: { street: { type: 'string' } } },
    };
    const spec = await parseSpec(await writeSpec('pet-items.json', specDoc(schemas)));
    const pet = spec.models.find((m) => m.name === 'Pet')!;
    expect(pet.fields.find((f) => f.name === 'toys')?.type).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'PetToys2' },
    });
    const homeRefs = collectModelRefs(pet.fields.find((f) => f.name === 'home')!.type);
    expect(homeRefs).toContain('PetHome2');
    expect(homeRefs).not.toContain('PetHome');
    for (const name of ['PetToys', 'PetHome'])
      expect(spec.models.find((m) => m.name === name)?.deprecated, name).toBe(true);
    for (const name of ['PetToys2', 'PetHome2'])
      expect(spec.models.find((m) => m.name === name)?.deprecated, name).toBeUndefined();
    expectSound(spec, ['Pet', 'PetToys', 'PetHome']);
  });

  it('settles a component field’s model against a deprecated inline response of the same name', async () => {
    // No component `PetOwner`: `Pet.owner` (live) and `getOwner`'s response,
    // pinned to `object: pet_owner` and deprecated, compete for the name. The
    // live field keeps it; the response is qualified by its operation.
    const schemas = {
      Pet: { type: 'object', properties: { owner: { type: 'object', properties: { name: { type: 'string' } } } } },
    };
    const response = {
      type: 'object',
      deprecated: true,
      properties: {
        object: { type: 'string', const: 'pet_owner' },
        name: { type: 'string' },
        age: { type: 'integer' },
      },
    };
    const spec = await parseSpec(
      await writeSpec('pet-owner-op.json', specDoc(schemas, { '/owner': getOp('getOwner', response) })),
    );
    expect(opsOf(spec).getOwner?.response).toEqual({ kind: 'model', name: 'GetOwnerPetOwner' });
    expect(spec.models.find((m) => m.name === 'Pet')?.fields[0]?.type).toEqual({ kind: 'model', name: 'PetOwner' });
    expect(spec.models.find((m) => m.name === 'PetOwner')?.deprecated).toBeUndefined();
    expect(spec.models.find((m) => m.name === 'GetOwnerPetOwner')?.deprecated).toBe(true);
    expectSound(spec, ['Pet'], ['getOwner.response → GetOwnerPetOwner']);
  });
});

describe('only the literal `true` deprecates (issue #260, `deprecatedEntry`)', () => {
  it('reads `deprecated: "yes"` as not deprecated on every node that carries the flag', async () => {
    const schemas = {
      Widget: {
        type: 'object',
        deprecated: 'yes',
        properties: {
          kind: { type: 'string', deprecated: 'yes', enum: ['a', 'b'] },
          name: { type: 'string', deprecated: 'yes' },
        },
      },
      Color: { type: 'string', deprecated: 'yes', enum: ['red', 'blue'] },
    };
    const paths = {
      '/widgets/{id}': {
        get: {
          operationId: 'getWidget',
          deprecated: 'yes',
          parameters: [{ name: 'id', in: 'path', required: true, deprecated: 'yes', schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'OK',
              headers: { 'X-Meta': { deprecated: 'yes', schema: { type: 'string' } } },
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    deprecated: 'yes',
                    properties: { object: { type: 'string', const: 'thing' } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const spec = await parseSpec(await writeSpec('yes.json', specDoc(schemas, paths)));
    for (const model of spec.models) expect(model, model.name).not.toHaveProperty('deprecated');
    for (const e of spec.enums) expect(e, e.name).not.toHaveProperty('deprecated');
    for (const field of spec.models.flatMap((m) => m.fields)) expect(field.deprecated, field.name).toBeUndefined();
    const op = opsOf(spec).getWidget!;
    expect(op.deprecated).toBeUndefined();
    expect(op.pathParams[0]?.deprecated).toBeUndefined();
    expect(op.responseHeaders?.[0]?.deprecated).toBeUndefined();
  });
});

describe('`<Name>Json` folding (issue #260)', () => {
  it('never folds a live `<Name>Json` onto a deprecated `<Name>`, and still folds a deprecated one onto a live base', () => {
    const field = (name: string) => ({ name, type: { kind: 'primitive', type: 'string' } as const, required: false });
    const models: Model[] = [
      { name: 'Widget', fields: [field('a')] },
      { name: 'WidgetJson', deprecated: true, fields: [field('a'), field('b')] },
      { name: 'Gadget', deprecated: true, fields: [field('a')] },
      { name: 'GadgetJson', fields: [field('a'), field('b')] },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const merged = collapseJsonSuffixModels(models, []);
      expect(merged.map((m) => [m.name, m.deprecated, m.fields.map((f) => f.name)])).toEqual([
        ['Widget', undefined, ['a', 'b']],
        ['Gadget', true, ['a']],
        ['GadgetJson', undefined, ['a', 'b']],
      ]);
      expect(warn.mock.calls.map(([m]) => String(m))).toEqual([
        '[oagen] Not merging "GadgetJson" into "Gadget": "Gadget" is deprecated and "GadgetJson" is live',
        '[oagen] Merged "WidgetJson" into "Widget" (2 fields, superset)',
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a reference a deferred body shares with a renamed copy follows it (Greptile, after the merge with main)', () => {
  // `getLegacyWidget` mints the deprecated `Widget`; `getWidget` the live one
  // (which also requires `a`); `getThing`'s `default` body has a titled
  // `Widget` variant of the deprecated shape, named after every primary
  // model. Today the registry reserves a taken title, so the variant takes
  // `WidgetGetThingDefaultResponse` rather than sharing the deprecated copy;
  // should it ever share it, the deferred site is bundled with the copy's and
  // the rename repoints the `default` response too. Either way it must never
  // be left on `Widget`, the live copy's name.
  const legacy = getOp('getLegacyWidget', {
    type: 'object',
    deprecated: true,
    properties: { object: { type: 'string', const: 'widget' }, a: { type: 'string' } },
  });
  const live = getOp('getWidget', {
    type: 'object',
    required: ['a'],
    properties: { object: { type: 'string', const: 'widget' }, a: { type: 'string' } },
  });
  const thing = {
    get: {
      operationId: 'getThing',
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } },
        default: {
          description: 'Anything else',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    title: 'Widget',
                    type: 'object',
                    deprecated: true,
                    properties: { object: { type: 'string', const: 'widget' }, a: { type: 'string' } },
                  },
                  { title: 'Note', type: 'object', properties: { n: { type: 'string' } } },
                ],
              },
            },
          },
        },
      },
    },
  };

  it('repoints the default response to the renamed deprecated copy, in either order of the copies', async () => {
    const results = await parseBothOrders('deferred-shared', {}, [
      ['/legacy-widgets/{id}', legacy],
      ['/things/{id}', thing],
      ['/widgets/{id}', live],
    ]);
    for (const { order, spec } of results) {
      const ops = opsOf(spec);
      expect(unresolvedReferences(spec), order).toEqual([]);
      expect(ops.getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      const liveModel = spec.models.find((m) => m.name === 'Widget');
      expect(liveModel?.deprecated, order).toBeUndefined();
      expect(
        liveModel?.fields.filter((f) => f.required).map((f) => f.name),
        order,
      ).toEqual(['a']);
      const fallback = ops.getThing?.defaultResponse?.type;
      expect(fallback?.kind, order).toBe('union');
      const variant = fallback?.kind === 'union' ? fallback.variants[0] : undefined;
      expect(variant?.kind, order).toBe('model');
      const name = variant?.kind === 'model' ? variant.name : '';
      // Never the live copy: whichever name the deprecated shape ended up
      // under, the `default` response points at a model of that shape.
      expect(name, order).not.toBe('Widget');
      const shared = spec.models.find((m) => m.name === name);
      expect(shared?.deprecated, order).toBe(true);
      expect(
        shared?.fields.map((f) => f.name),
        order,
      ).toEqual(['object', 'a']);
      expect(
        shared?.fields.filter((f) => f.required),
        order,
      ).toEqual([]);
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
    }
  });
});

describe('a rename repoints references by identity, never by name (review round 1)', () => {
  const str = { type: 'string' };
  const refName = (ref: TypeRef | undefined): string => {
    const names = ref ? collectModelRefs(ref) : [];
    expect(names).toHaveLength(1);
    return names[0]!;
  };

  it('leaves an explicit `$ref` to the component in one response alone while renaming the inline copy in another', async () => {
    const widget = { type: 'object', properties: { object: { type: 'string', const: 'widget' }, k: str } };
    const larger = { ...widget, properties: { ...widget.properties, extra: str } };
    for (const [label, componentFlag, inlineFlag] of [
      ['component live, inline deprecated', false, true],
      ['component deprecated, inline live', true, false],
    ] as const) {
      for (const order of ['200 first', '201 first'] as const) {
        const ok = {
          description: 'OK',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
        };
        const created = {
          description: 'Created',
          content: { 'application/json': { schema: { ...larger, ...(inlineFlag ? { deprecated: true } : {}) } } },
        };
        const responses = order === '200 first' ? { '200': ok, '201': created } : { '201': created, '200': ok };
        const schemas = { Widget: { ...widget, ...(componentFlag ? { deprecated: true } : {}) } };
        const paths = { '/widgets': { post: { operationId: 'createWidget', responses } } };
        const where = `${label}, ${order}`;
        const spec = await parseSpec(
          await writeSpec(`two-codes-${order.replace(' ', '-')}.json`, specDoc(schemas, paths)),
        );
        const op = opsOf(spec).createWidget!;
        const byCode = Object.fromEntries((op.successResponses ?? []).map((r) => [r.statusCode, r.type]));
        // The 200 keeps the component as written; the 201's inline copy is
        // renamed, and the component's fields are untouched.
        expect(byCode[200], where).toEqual({ kind: 'model', name: 'Widget' });
        expect(byCode[201], where).toEqual({ kind: 'model', name: 'CreateWidgetWidget' });
        expect(op.response, where).toEqual({ kind: 'model', name: 'Widget' });
        const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
        expect(
          byName.Widget?.fields.map((f) => f.name),
          where,
        ).toEqual(['object', 'k']);
        expect(byName.Widget?.deprecated, where).toBe(componentFlag ? true : undefined);
        expect(
          byName.CreateWidgetWidget?.fields.map((f) => f.name),
          where,
        ).toEqual(['object', 'k', 'extra']);
        expect(byName.CreateWidgetWidget?.deprecated, where).toBe(inlineFlag ? true : undefined);
        expectSound(
          spec,
          ['Widget'],
          componentFlag
            ? ['createWidget.response → Widget', 'createWidget.200 → Widget']
            : ['createWidget.201 → CreateWidgetWidget'],
        );
      }
    }
  });

  it('names a deprecated child before its parent, so identical-looking parents stop folding and nothing is orphaned', async () => {
    const widget = (items: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      type: 'object',
      ...extra,
      properties: { object: { type: 'string', const: 'widget' }, owners: { type: 'array', items } },
    });
    const legacy = getOp(
      'getLegacyWidget',
      widget({ type: 'object', deprecated: true, properties: { name: str, legacy_id: str } }, { deprecated: true }),
    );
    const live = getOp('getWidget', widget({ type: 'object', properties: { name: str } }));
    for (const { order, spec } of await parseBothOrders('nested-child', {}, [
      ['/legacy-widgets/{id}', legacy],
      ['/widgets/{id}', live],
    ])) {
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      const ops = opsOf(spec);
      expect(ops.getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
      const liveItem = refName(byName.Widget?.fields.find((f) => f.name === 'owners')?.type);
      const legacyItem = refName(byName.GetLegacyWidgetWidget?.fields.find((f) => f.name === 'owners')?.type);
      expect(legacyItem, order).toBe(`GetLegacyWidget${liveItem}`);
      expect(byName[liveItem]?.deprecated, order).toBeUndefined();
      expect(
        byName[liveItem]?.fields.map((f) => f.name),
        order,
      ).toEqual(['name']);
      expect(byName[legacyItem]?.deprecated, order).toBe(true);
      expect(
        byName[legacyItem]?.fields.map((f) => f.name),
        order,
      ).toEqual(['name', 'legacy_id']);
      expect(Object.keys(byName).sort(), order).toEqual(
        ['GetLegacyWidgetWidget', legacyItem, 'Widget', liveItem].sort(),
      );
      expectSound(spec, [], ['getLegacyWidget.response → GetLegacyWidgetWidget']);
    }
  });

  it('carries a rename to the copies of a field an `allOf` merge inherited, and not to an explicit `$ref`', async () => {
    const schemas = {
      Base: { type: 'object', properties: { meta: { type: 'object', properties: { k: str } } } },
      BaseMeta: { type: 'object', deprecated: true, properties: { k: str } },
      Holder: {
        type: 'object',
        properties: {
          ext: {
            allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { extra: str } }],
          },
        },
      },
      Other: { type: 'object', properties: { legacy: { $ref: '#/components/schemas/BaseMeta' } } },
    };
    for (const order of ['as-written', 'reversed'] as const) {
      const entries = Object.entries(schemas);
      const ordered = Object.fromEntries(order === 'as-written' ? entries : [...entries].reverse());
      const spec = await parseSpec(await writeSpec(`inherited-${order}.json`, specDoc(ordered)));
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      const fieldRef = (model: string, field: string) => byName[model]?.fields.find((f) => f.name === field)?.type;
      expect(fieldRef('Base', 'meta'), order).toEqual({ kind: 'model', name: 'BaseMeta2' });
      expect(fieldRef('HolderExt', 'meta'), order).toEqual({ kind: 'model', name: 'BaseMeta2' });
      expect(fieldRef('Other', 'legacy'), order).toEqual({ kind: 'model', name: 'BaseMeta' });
      expect(byName.BaseMeta?.deprecated, order).toBe(true);
      expect(byName.BaseMeta2?.deprecated, order).toBeUndefined();
      expectSound(spec, Object.keys(schemas), ['Other.legacy → BaseMeta']);
    }
  });

  it('never mints a model name an inline enum will take', async () => {
    const legacy = getOp('getLegacyWidget', {
      type: 'object',
      deprecated: true,
      properties: { object: { type: 'string', const: 'widget' }, a: str },
    });
    const live = getOp('getWidget', {
      type: 'object',
      required: ['a'],
      properties: { object: { type: 'string', const: 'widget' }, a: str },
    });
    // A service tagged `GetLegacyWidget` with a `widget` query enum lifts the
    // enum `GetLegacyWidgetWidget` — the very name the deprecated response
    // would otherwise take.
    const search = {
      get: {
        operationId: 'searchWidgets',
        tags: ['GetLegacyWidget'],
        parameters: [{ name: 'widget', in: 'query', schema: { type: 'string', enum: ['round', 'square'] } }],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } } },
      },
    };
    for (const { order, spec } of await parseBothOrders('enum-name', {}, [
      ['/legacy-widgets/{id}', legacy],
      ['/widgets/{id}', live],
      ['/search', search],
    ])) {
      expect(
        spec.enums.map((e) => e.name),
        order,
      ).toEqual(['GetLegacyWidgetWidget']);
      expect(opsOf(spec).getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget2' });
      expect(opsOf(spec).getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expectSound(spec, [], ['getLegacyWidget.response → GetLegacyWidgetWidget2']);
    }
  });

  it('never lets an enum the collectors rename take a model name the merge minted', async () => {
    const legacy = getOp('getLegacyWidget', {
      type: 'object',
      deprecated: true,
      properties: { object: { type: 'string', const: 'widget' }, a: str },
    });
    const live = getOp('getWidget', {
      type: 'object',
      required: ['a'],
      properties: { object: { type: 'string', const: 'widget' }, a: str },
    });
    // The same `widget` query enum, now beside a component enum that owns
    // `GetLegacyWidgetWidget` with other members: the deprecated response is
    // qualified past the component enum to `GetLegacyWidgetWidget2`, and the
    // collectors — which rename the query enum off the component's values
    // after every model is named — must step past that model too.
    const search = {
      get: {
        operationId: 'searchWidgets',
        tags: ['GetLegacyWidget'],
        parameters: [{ name: 'widget', in: 'query', schema: { type: 'string', enum: ['round', 'square'] } }],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } } },
      },
    };
    const schemas = { GetLegacyWidgetWidget: { type: 'string', enum: ['big', 'small'] } };
    for (const { order, spec } of await parseBothOrders('enum-name-taken', schemas, [
      ['/legacy-widgets/{id}', legacy],
      ['/widgets/{id}', live],
      ['/search', search],
    ])) {
      expect(
        spec.enums.map((e) => [e.name, e.values.map((v) => v.value)]),
        order,
      ).toEqual([
        ['GetLegacyWidgetWidget', ['big', 'small']],
        ['GetLegacyWidgetWidget3', ['round', 'square']],
      ]);
      expect(
        opsOf(spec).searchWidgets?.queryParams.map((p) => p.type),
        order,
      ).toEqual([{ kind: 'enum', name: 'GetLegacyWidgetWidget3', values: ['round', 'square'] }]);
      expect(opsOf(spec).getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget2' });
      expect(opsOf(spec).getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expectSound(spec, [], ['getLegacyWidget.response → GetLegacyWidgetWidget2']);
    }
  });

  it('qualifies two deprecated copies under different operations each by its own', async () => {
    const widget = (extra: Record<string, unknown>, props: Record<string, unknown> = {}) => ({
      type: 'object',
      ...extra,
      properties: { object: { type: 'string', const: 'widget' }, a: str, ...props },
    });
    for (const { order, spec } of await parseBothOrders('two-deprecated', {}, [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', widget({ deprecated: true }))],
      ['/old-widgets/{id}', getOp('getOldWidget', widget({ deprecated: true }, { b: str }))],
      ['/widgets/{id}', getOp('getWidget', widget({ required: ['a'] }))],
    ])) {
      const ops = opsOf(spec);
      expect(ops.getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
      expect(ops.getOldWidget?.response, order).toEqual({ kind: 'model', name: 'GetOldWidgetWidget' });
      expect(spec.models.map((m) => [m.name, m.deprecated]).sort(), order).toEqual([
        ['GetLegacyWidgetWidget', true],
        ['GetOldWidgetWidget', true],
        ['Widget', undefined],
      ]);
      expectSound(
        spec,
        [],
        ['getLegacyWidget.response → GetLegacyWidgetWidget', 'getOldWidget.response → GetOldWidgetWidget'],
      );
    }
  });

  it('settles a deprecated list-envelope companion against a live component field’s model: folded when identical, renamed otherwise', async () => {
    const listMetadata = (extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: { before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } },
      ...extra,
    });
    const envelope = (meta: Record<string, unknown>) => ({
      allOf: [
        {
          type: 'object',
          properties: { object: { type: 'string', const: 'list' }, list_metadata: meta },
        },
        { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/User' } } } },
      ],
    });
    const listOp = (meta: Record<string, unknown>) => ({
      get: {
        operationId: 'listLegacyUsers',
        parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: envelope(meta) } } } },
      },
    });
    // The only list operation deprecates its companion, so the companion
    // takes the bare name `ListMetadata` — which `List.metadata` also mints,
    // live. Identical but for the flag, the companion folds onto that model
    // (issue #312): the envelope field keeps the flag.
    const schemas = {
      User: { type: 'object', properties: { id: str } },
      List: { type: 'object', properties: { metadata: listMetadata() } },
    };
    for (const { order, spec } of await parseBothOrders('companion', schemas, [
      ['/legacy-users', listOp(listMetadata({ deprecated: true }))],
      ['/users/{id}', getOp('getUser', { $ref: '#/components/schemas/User' })],
    ])) {
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      const op = opsOf(spec).listLegacyUsers!;
      const metaField = op.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata');
      expect(metaField?.type, order).toEqual({ kind: 'model', name: 'ListMetadata' });
      expect(metaField?.deprecated, order).toBe(true);
      expect(byName.List?.fields[0]?.type, order).toEqual({ kind: 'model', name: 'ListMetadata' });
      expect(byName.ListMetadata?.deprecated, order).toBeUndefined();
      expect(Object.keys(byName).sort(), order).toEqual(['List', 'ListMetadata', 'User']);
      expectSound(spec, Object.keys(schemas));
    }
    // A companion of another shape (one more field) is renamed, and the
    // rename repoints the envelope field.
    for (const { order, spec } of await parseBothOrders('companion-differs', schemas, [
      [
        '/legacy-users',
        listOp(listMetadata({ deprecated: true, properties: { ...listMetadata().properties, page: str } })),
      ],
      ['/users/{id}', getOp('getUser', { $ref: '#/components/schemas/User' })],
    ])) {
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      const op = opsOf(spec).listLegacyUsers!;
      const metaField = op.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata');
      expect(metaField?.type, order).toEqual({ kind: 'model', name: 'ListLegacyUsersListMetadata' });
      expect(metaField?.deprecated, order).toBe(true);
      expect(byName.List?.fields[0]?.type, order).toEqual({ kind: 'model', name: 'ListMetadata' });
      expect(byName.ListMetadata?.deprecated, order).toBeUndefined();
      expect(byName.ListLegacyUsersListMetadata?.deprecated, order).toBe(true);
      expect(
        byName.ListLegacyUsersListMetadata?.fields.map((f) => f.name),
        order,
      ).toEqual(['before', 'after', 'page']);
      expectSound(spec, Object.keys(schemas));
    }
  });
});

describe('review round 2', () => {
  const str = { type: 'string' };

  it('repoints every operation sharing a deprecated companion when the companion is renamed, in either order', async () => {
    const listMetadata = (extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: { before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } },
      ...extra,
    });
    const envelope = {
      allOf: [
        {
          type: 'object',
          properties: { object: { type: 'string', const: 'list' }, list_metadata: listMetadata({ deprecated: true }) },
        },
        { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/User' } } } },
      ],
    };
    const listOp = (operationId: string) => ({
      get: {
        operationId,
        parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: envelope } } } },
      },
    });
    // Two list operations share one deprecated companion, so the envelope
    // pass folds one copy onto the other and the bare `ListMetadata` is
    // deprecated. A third operation's live inline response, pinned to
    // `object: list_metadata`, mints the same name with other fields — a
    // clash the envelope pass cannot see (a component of that name, or a
    // component field's model, it already steps around). The companion is
    // renamed, and both list operations must follow it.
    const schemas = { User: { type: 'object', properties: { id: str } } };
    const liveMetadata = getOp('getListMetadata', {
      type: 'object',
      properties: { object: { type: 'string', const: 'list_metadata' }, page: { type: 'integer' } },
    });
    for (const { order, spec } of await parseBothOrders('shared-companion', schemas, [
      ['/legacy-users', listOp('listLegacyUsers')],
      ['/old-users', listOp('listOldUsers')],
      ['/list-metadata', liveMetadata],
    ])) {
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      const ops = opsOf(spec);
      const metaRef = (name: string) =>
        ops[name]?.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata')?.type;
      const legacy = metaRef('listLegacyUsers');
      const old = metaRef('listOldUsers');
      expect(legacy, order).toEqual(old);
      expect(legacy?.kind, order).toBe('model');
      const shared = byName[(legacy as { name: string }).name]!;
      // The qualifier follows the envelope pass's owner (first declared), so
      // the name itself follows document order; what it is not is
      // `ListMetadata`, and what it references is the deprecated shape.
      expect(shared.name, order).not.toBe('ListMetadata');
      expect(shared.deprecated, order).toBe(true);
      expect(
        shared.fields.map((f) => f.name),
        order,
      ).toEqual(['before', 'after']);
      expect(ops.getListMetadata?.response, order).toEqual({ kind: 'model', name: 'ListMetadata' });
      expect(byName.ListMetadata?.deprecated, order).toBeUndefined();
      expect(
        byName.ListMetadata?.fields.map((f) => f.name),
        order,
      ).toEqual(['object', 'page']);
      expectSound(spec, Object.keys(schemas));
    }
  });

  it('keeps a `$ref` to the component inside the inline copy, whether the copy is renamed or folded (MichaelDeBoey)', async () => {
    const widget = (extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: { object: { type: 'string', const: 'widget' }, parent: { $ref: '#/components/schemas/Widget' } },
      ...extra,
    });
    // A live inline copy beside a deprecated component is renamed; the
    // `$ref` inside it stays the component.
    for (const { order, spec } of await parseBothOrders('self-ref-true', { Widget: widget({ deprecated: true }) }, [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', widget())],
      ['/widgets/{id}', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
    ])) {
      const where = `component deprecated, inline live, ${order}`;
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      expect(opsOf(spec).getLegacyWidget?.response, where).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
      // The `$ref` stays the component; only the inline model was renamed.
      expect(byName.GetLegacyWidgetWidget?.fields.find((f) => f.name === 'parent')?.type, where).toEqual({
        kind: 'model',
        name: 'Widget',
      });
      expect(byName.Widget?.fields.find((f) => f.name === 'parent')?.type, where).toEqual({
        kind: 'model',
        name: 'Widget',
      });
      expect(byName.GetLegacyWidgetWidget?.deprecated, where).toBeUndefined();
      expect(byName.Widget?.deprecated, where).toBe(true);
      expectSound(spec, ['Widget'], ['getWidget.response → Widget', 'GetLegacyWidgetWidget.parent → Widget']);
    }
    // A deprecated inline copy identical to the live component — the `$ref`
    // to the component included — folds onto it (issue #312).
    for (const { order, spec, warnings } of await parseBothOrders('self-ref-false', { Widget: widget() }, [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', widget({ deprecated: true }))],
      ['/widgets/{id}', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
    ])) {
      const where = `component live, inline deprecated, ${order}`;
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      expect(opsOf(spec).getLegacyWidget?.response, where).toEqual({ kind: 'model', name: 'Widget' });
      expect(Object.keys(byName), where).toEqual(['Widget']);
      expect(byName.Widget?.fields.find((f) => f.name === 'parent')?.type, where).toEqual({
        kind: 'model',
        name: 'Widget',
      });
      expect(byName.Widget?.deprecated, where).toBeUndefined();
      expectSound(spec, ['Widget']);
      expect(warnings, where).toEqual([
        '[oagen] Warning: Inline model "Widget" is declared both deprecated and live with the same shape — keeping the live definition under the shared name',
      ]);
    }
  });

  it('renames only the inline variant of a `oneOf` beside a `$ref` to the deprecated component (MichaelDeBoey)', async () => {
    const schemas = {
      Pet: {
        type: 'object',
        properties: {
          owner: { oneOf: [{ $ref: '#/components/schemas/PetOwner' }, { type: 'object', properties: { name: str } }] },
        },
      },
      PetOwner: { type: 'object', deprecated: true, properties: { name: str } },
    };
    for (const order of ['as-written', 'reversed'] as const) {
      const entries = Object.entries(schemas);
      const ordered = Object.fromEntries(order === 'as-written' ? entries : [...entries].reverse());
      const spec = await parseSpec(await writeSpec(`oneof-ref-${order}.json`, specDoc(ordered)));
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      expect(byName.Pet?.fields[0]?.type, order).toEqual({
        kind: 'union',
        variants: [
          { kind: 'model', name: 'PetOwner' },
          { kind: 'model', name: 'PetOwner2' },
        ],
        compositionKind: 'oneOf',
      });
      expect(byName.PetOwner?.deprecated, order).toBe(true);
      expect(byName.PetOwner2?.deprecated, order).toBeUndefined();
      // The `$ref` variant is the document's own reference to the deprecated component.
      expectSound(spec, Object.keys(schemas), ['Pet.owner → PetOwner']);
    }
  });

  it('qualifies a deprecated copy whenever the live copies disagree among themselves, in either order (MichaelDeBoey)', async () => {
    const widget = (extra: Record<string, unknown>) => ({
      type: 'object',
      properties: { object: { type: 'string', const: 'widget' }, a: str, b: str },
      ...extra,
    });
    const x = getOp('getX', widget({ required: ['a'] }));
    const y = getOp('getY', widget({ required: ['b'] }));
    const z = getOp('getZ', widget({ required: ['b'], deprecated: true }));
    for (const [order, paths] of [
      ['x-first', { '/x': x, '/y': y, '/z': z }],
      ['y-first', { '/y': y, '/x': x, '/z': z }],
      ['z-first', { '/z': z, '/y': y, '/x': x }],
    ] as const) {
      const spec = await parseSpec(await writeSpec(`tie-${order}.json`, specDoc({}, paths)));
      const ops = opsOf(spec);
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      // `getZ` matches `getY` but not `getX` modulo the flag, so it never
      // folds — whichever live copy the shared name ends up carrying.
      expect(ops.getZ?.response, order).toEqual({ kind: 'model', name: 'GetZWidget' });
      expect(ops.getX?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getY?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(byName.GetZWidget?.deprecated, order).toBe(true);
      expect(
        byName.GetZWidget?.fields.filter((f) => f.required).map((f) => f.name),
        order,
      ).toEqual(['b']);
      // The live tie still follows document order, as on main: the first
      // declared live copy's requiredness is the shared one.
      const required = byName.Widget?.fields.filter((f) => f.required).map((f) => f.name);
      expect(required, order).toEqual(order === 'x-first' ? ['a'] : ['b']);
      expectSound(spec, [], ['getZ.response → GetZWidget']);
    }
  });
});

describe('a renamed nested model goes with the parent that references it (issue #313)', () => {
  const str = { type: 'string' };
  const obj = (props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: 'object',
    ...extra,
    properties: props,
  });
  const refTo = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const widget = (owner: unknown, extra: Record<string, unknown> = {}) =>
    obj({ object: { type: 'string', const: 'widget' }, owner, ...extra });
  const petWidget = (owner: unknown) => obj({ object: { type: 'string', const: 'pet_widget' }, owner });
  const fieldRef = (spec: ApiSpec, model: string, field: string): TypeRef | undefined =>
    spec.models.find((m) => m.name === model)?.fields.find((f) => f.name === field)?.type;
  const fieldDeprecated = (spec: ApiSpec, model: string, field: string): boolean | undefined =>
    spec.models.find((m) => m.name === model)?.fields.find((f) => f.name === field)?.deprecated;

  async function parseWithWarnings(name: string, doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spec = await parseSpec(await writeSpec(name, doc));
      return { spec, warnings: warn.mock.calls.map(([m]) => String(m)) };
    } finally {
      warn.mockRestore();
    }
  }

  it('folds the deprecated `Pet.owner.address` onto the live component and keeps `Pet.owner` with it (the issue’s `field.json`)', async () => {
    const schemas = {
      Pet: obj({ owner: obj({ address: obj({ city: str }, { deprecated: true }) }) }),
      PetOwner: obj({ address: refTo('PetOwnerAddress') }),
      PetOwnerAddress: obj({ city: str }),
    };
    const { spec, warnings } = await parseWithWarnings(
      'issue-field.json',
      specDoc(schemas, { '/pets/{id}': getOp('getPet', refTo('Pet')) }),
    );
    // No `PetOwnerAddress2` and no note for it: the nested copy is identical
    // to the live component but for the flag and folds onto it. `Pet.owner`
    // keeps a model of its own only because the document deprecates its
    // `address` field while `PetOwner.address` is live — a field flag the
    // component does not admit — and that model references the component.
    expect(describeModels(spec)).toEqual([
      { deprecated: undefined, fields: ['owner: PetOwner2'], name: 'Pet', required: [] },
      { deprecated: undefined, fields: ['address: PetOwnerAddress'], name: 'PetOwner', required: [] },
      { deprecated: undefined, fields: ['city: string'], name: 'PetOwnerAddress', required: [] },
      { deprecated: undefined, fields: ['address: PetOwnerAddress'], name: 'PetOwner2', required: [] },
    ]);
    expect(fieldDeprecated(spec, 'PetOwner2', 'address')).toBe(true);
    expect(opsOf(spec).getPet?.response).toEqual({ kind: 'model', name: 'Pet' });
    expectSound(spec, Object.keys(schemas));
    expect(warnings).toEqual([
      '[oagen] Warning: Inline model "PetOwnerAddress" is declared both deprecated and live with the same shape — keeping the live definition under the shared name',
      '[oagen] Renamed inline model "PetOwner" → "PetOwner2": its shape differs from component schema "PetOwner"',
    ]);
  });

  it('folds the deprecated `owner` of an inline response onto the live component and keeps the response with it (the issue’s `response.json`)', async () => {
    const schemas = { Widget: widget(refTo('WidgetOwner')), WidgetOwner: obj({ city: str }) };
    const { spec, warnings } = await parseWithWarnings(
      'issue-response.json',
      specDoc(schemas, {
        '/legacy-widgets/{id}': getOp('getLegacyWidget', widget(obj({ city: str }, { deprecated: true }))),
      }),
    );
    expect(describeModels(spec)).toEqual([
      { deprecated: undefined, fields: ['object: literal', 'owner: WidgetOwner'], name: 'Widget', required: [] },
      { deprecated: undefined, fields: ['city: string'], name: 'WidgetOwner', required: [] },
      {
        deprecated: undefined,
        fields: ['object: literal', 'owner: WidgetOwner'],
        name: 'GetLegacyWidgetWidget',
        required: [],
      },
    ]);
    expect(fieldDeprecated(spec, 'GetLegacyWidgetWidget', 'owner')).toBe(true);
    expect(opsOf(spec).getLegacyWidget?.response).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
    expectSound(spec, Object.keys(schemas));
    expect(warnings).toEqual([
      '[oagen] Warning: Inline model "WidgetOwner" is declared both deprecated and live with the same shape — keeping the live definition under the shared name',
      '[oagen] Renamed inline model "Widget" → "GetLegacyWidgetWidget": its shape differs from component schema "Widget"',
    ]);
  });

  it('qualifies a live twin whose child was renamed instead of folding it by name, in either order', async () => {
    // `getA` and `getB` both mint `Widget`; only `getB`'s `owner` is
    // deprecated, with a field of its own, so it becomes `GetBWidgetOwner`
    // and `getB`'s `Widget` references it. Folded by name onto `getA`'s
    // `Widget` ("keeping the first definition"), the child would be
    // referenced by nothing; `getB`'s `Widget` leaves the name by its site.
    const live = widget(obj({ city: str }));
    const legacy = widget(obj({ city: str, zip: str }, { deprecated: true }));
    for (const { order, spec, warnings } of await parseBothOrders('renamed-child-twins', {}, [
      ['/a/{id}', getOp('getA', live)],
      ['/b/{id}', getOp('getB', legacy)],
    ])) {
      const ops = opsOf(spec);
      expect(ops.getA?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getB?.response, order).toEqual({ kind: 'model', name: 'GetBWidget' });
      expect(
        describeModels(spec).sort((a, b) => a.name.localeCompare(b.name)),
        order,
      ).toEqual([
        {
          deprecated: undefined,
          fields: ['object: literal', 'owner: GetBWidgetOwner'],
          name: 'GetBWidget',
          required: [],
        },
        { deprecated: true, fields: ['city: string', 'zip: string'], name: 'GetBWidgetOwner', required: [] },
        { deprecated: undefined, fields: ['object: literal', 'owner: WidgetOwner'], name: 'Widget', required: [] },
        { deprecated: undefined, fields: ['city: string'], name: 'WidgetOwner', required: [] },
      ]);
      expect(fieldDeprecated(spec, 'GetBWidget', 'owner'), order).toBe(true);
      expectSound(spec, []);
      expect(warnings, order).toEqual([
        '[oagen] Renamed inline model "WidgetOwner" → "GetBWidgetOwner": it is deprecated while "WidgetOwner" is live',
        '[oagen] Renamed inline model "Widget" → "GetBWidget": it references a renamed model and "Widget" keeps another definition',
      ]);
    }
  });

  it('never lets the twin with the renamed deprecated child win the shared name by field count', async () => {
    // `getB`'s `Widget` has one field more; kept under the shared name
    // ("keeping the one with more fields"), it would hand `getA` the
    // deprecated `GetBWidgetOwner` and orphan `getA`'s `WidgetOwner`.
    const live = widget(obj({ city: str }));
    const legacy = widget(obj({ city: str, zip: str }, { deprecated: true }), { extra: str });
    const { spec } = await parseWithWarnings(
      'larger-twin.json',
      specDoc({}, { '/a/{id}': getOp('getA', live), '/b/{id}': getOp('getB', legacy) }),
    );
    const ops = opsOf(spec);
    expect(ops.getA?.response).toEqual({ kind: 'model', name: 'Widget' });
    expect(ops.getB?.response).toEqual({ kind: 'model', name: 'GetBWidget' });
    expect(fieldRef(spec, 'Widget', 'owner')).toEqual({ kind: 'model', name: 'WidgetOwner' });
    expect(fieldRef(spec, 'GetBWidget', 'owner')).toEqual({ kind: 'model', name: 'GetBWidgetOwner' });
    expect(spec.models.find((m) => m.name === 'GetBWidget')?.fields.map((f) => f.name)).toEqual([
      'object',
      'owner',
      'extra',
    ]);
    expectSound(spec, []);
  });

  it('keeps a renamed leader under its name when a later pass reads it again (identical twins beside a component of another shape)', async () => {
    // Both responses leave the component's names together, `getB` repointed
    // onto `getA`'s `GetAWidget`; the field merge reads `GetAWidget`, which
    // references the renamed `GetAWidgetOwner`, and must not move it to
    // `GetAWidget2` behind `getB`'s back.
    const schemas = { Widget: widget(refTo('WidgetOwner'), { extra: str }), WidgetOwner: obj({ city: str }) };
    const shape = widget(obj({ city: str, zip: str }));
    const { spec, warnings } = await parseWithWarnings(
      'leader.json',
      specDoc(schemas, { '/a/{id}': getOp('getA', shape), '/b/{id}': getOp('getB', shape) }),
    );
    const ops = opsOf(spec);
    expect(ops.getA?.response).toEqual({ kind: 'model', name: 'GetAWidget' });
    expect(ops.getB?.response).toEqual({ kind: 'model', name: 'GetAWidget' });
    expect(spec.models.map((m) => m.name)).toEqual(['Widget', 'WidgetOwner', 'GetAWidget', 'GetAWidgetOwner']);
    expectSound(spec, Object.keys(schemas));
    expect(warnings).toEqual([
      '[oagen] Renamed inline model "WidgetOwner" → "GetAWidgetOwner": its shape differs from component schema "WidgetOwner" (shared by 2 sites)',
      '[oagen] Renamed inline model "Widget" → "GetAWidget": its shape differs from component schema "Widget" (shared by 2 sites)',
    ]);
  });

  it('qualifies every twin that follows a rename, each by its site, beside the one that keeps the name', async () => {
    const live = widget(obj({ city: str }));
    const legacy = widget(obj({ city: str, zip: str }, { deprecated: true }));
    const { spec } = await parseWithWarnings(
      'three-twins.json',
      specDoc(
        {},
        { '/a/{id}': getOp('getA', live), '/b/{id}': getOp('getB', legacy), '/c/{id}': getOp('getC', legacy) },
      ),
    );
    const ops = opsOf(spec);
    expect(ops.getA?.response).toEqual({ kind: 'model', name: 'Widget' });
    expect(fieldRef(spec, 'Widget', 'owner')).toEqual({ kind: 'model', name: 'WidgetOwner' });
    expect(ops.getB?.response).toEqual({ kind: 'model', name: 'GetBWidget' });
    // `getC`'s copies are identical to `getB`'s; whether they share
    // `getB`'s models or take names of their own (issue #314), `getC` never
    // resolves to `Widget`, and its `owner` is a deprecated `{ city, zip }`.
    const c = ops.getC?.response;
    expect(c?.kind).toBe('model');
    const cName = c?.kind === 'model' ? c.name : '';
    expect(cName).not.toBe('Widget');
    const cOwner = fieldRef(spec, cName, 'owner');
    const cOwnerName = cOwner?.kind === 'model' ? cOwner.name : '';
    expect(spec.models.find((m) => m.name === cOwnerName)?.deprecated).toBe(true);
    expect(spec.models.find((m) => m.name === cOwnerName)?.fields.map((f) => f.name)).toEqual(['city', 'zip']);
    expectSound(spec, []);
  });

  it('repoints the model the schema pass lifted from a component field when the field’s child is renamed (lifted twin beside an operation)', async () => {
    // `Pet.widget` is read twice: the schema pass lifts `PetWidget` into the
    // models, the field extractor reads `PetWidget` and `PetWidgetOwner`
    // (deprecated). `getPetWidget` mints a live `PetWidgetOwner` with a field
    // more, so the field's child becomes `PetWidgetOwner2` — and the lifted
    // `PetWidget`, which `Pet.widget` resolves to, must follow it rather than
    // keep naming the operation's live `PetWidgetOwner`.
    const schemas = { Pet: obj({ widget: petWidget(obj({ city: str }, { deprecated: true })) }) };
    const { spec, warnings } = await parseWithWarnings(
      'lifted-twin.json',
      specDoc(schemas, {
        '/pets/{id}': getOp('getPet', refTo('Pet')),
        '/pet-widgets/{id}': getOp('getPetWidget', petWidget(obj({ city: str, zip: str }))),
      }),
    );
    expect(fieldRef(spec, 'Pet', 'widget')).toEqual({ kind: 'model', name: 'PetWidget' });
    expect(fieldRef(spec, 'PetWidget', 'owner')).toEqual({ kind: 'model', name: 'PetWidgetOwner2' });
    expect(fieldDeprecated(spec, 'PetWidget', 'owner')).toBe(true);
    expect(opsOf(spec).getPetWidget?.response).toEqual({ kind: 'model', name: 'GetPetWidgetPetWidget' });
    expect(fieldRef(spec, 'GetPetWidgetPetWidget', 'owner')).toEqual({ kind: 'model', name: 'PetWidgetOwner' });
    expect(
      describeModels(spec)
        .filter((m) => m.name.startsWith('PetWidgetOwner'))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { deprecated: undefined, fields: ['city: string', 'zip: string'], name: 'PetWidgetOwner', required: [] },
      { deprecated: true, fields: ['city: string'], name: 'PetWidgetOwner2', required: [] },
    ]);
    expectSound(spec, Object.keys(schemas));
    expect(warnings).toEqual([
      '[oagen] Renamed inline model "PetWidget" → "GetPetWidgetPetWidget": its shape differs from component schema "PetWidget"',
      '[oagen] Renamed inline model "PetWidgetOwner" → "PetWidgetOwner2": it is deprecated while "PetWidgetOwner" is live',
    ]);
  });

  it('lets the field’s copy fold onto its lifted twin after a child was renamed at the settle (component or enum of the child’s name)', async () => {
    // Without the twin in the field's site, `Pet.widget`'s copy no longer
    // matched the lifted `PetWidget` once its child became `PetWidgetOwner2`,
    // took the name `PetWidget2`, and left the lifted `PetWidget` referenced
    // by nothing — beside a component enum, still referencing the enum's name.
    const deprecatedOwner = obj({ city: str }, { deprecated: true });
    for (const [label, component, owner] of [
      ['component of another shape', obj({ street: str }), deprecatedOwner],
      ['component enum', { type: 'string', enum: ['a', 'b'] }, obj({ city: str })],
    ] as const) {
      const schemas = { Pet: obj({ widget: petWidget(owner) }), PetWidgetOwner: component };
      const { spec } = await parseWithWarnings(
        `lifted-${label.replace(/\W+/g, '-')}.json`,
        specDoc(schemas, { '/pets/{id}': getOp('getPet', refTo('Pet')) }),
      );
      expect(fieldRef(spec, 'Pet', 'widget'), label).toEqual({ kind: 'model', name: 'PetWidget' });
      expect(fieldRef(spec, 'PetWidget', 'owner'), label).toEqual({ kind: 'model', name: 'PetWidgetOwner2' });
      expect(spec.models.map((m) => m.name).sort(), label).toEqual(
        [
          ...Object.keys(schemas).filter((name) => label !== 'component enum' || name !== 'PetWidgetOwner'),
          'PetWidget',
          'PetWidgetOwner2',
        ].sort(),
      );
      expectSound(spec, Object.keys(schemas));
    }
  });

  it('carries a rename made at the field settle into the later merge, so the parent is qualified rather than dropped for a same-named response', async () => {
    // `Pet.widget.owner` (`PetWidgetOwner`) has an `address` renamed when
    // the fields are settled, against a component `PetWidgetOwnerAddress` of
    // another shape; `getOwner`'s response, pinned by `object:
    // pet_widget_owner`, takes `PetWidgetOwner` too. Dropped for it
    // ("Two inline models are named …"), the field's model would retype
    // `Pet.widget.owner` and orphan the renamed address.
    for (const [label, address] of [
      ['deprecated address', obj({ city: str }, { deprecated: true })],
      ['live address', obj({ city: str })],
    ] as const) {
      const schemas = {
        Pet: obj({ widget: petWidget(obj({ object: { type: 'string', const: 'pet_widget_owner' }, address })) }),
        PetWidgetOwnerAddress: obj({ street: str }),
      };
      const { spec, warnings } = await parseWithWarnings(
        `cross-pass-${label.replace(/\W+/g, '-')}.json`,
        specDoc(schemas, {
          '/pets/{id}': getOp('getPet', refTo('Pet')),
          '/owners/{id}': getOp('getOwner', obj({ object: { type: 'string', const: 'pet_widget_owner' } })),
        }),
      );
      expect(fieldRef(spec, 'PetWidget', 'owner'), label).toEqual({ kind: 'model', name: 'PetWidgetOwner2' });
      expect(fieldRef(spec, 'PetWidgetOwner2', 'address'), label).toEqual({
        kind: 'model',
        name: 'PetWidgetOwnerAddress2',
      });
      expect(spec.models.find((m) => m.name === 'PetWidgetOwnerAddress2')?.deprecated, label).toBe(
        label === 'deprecated address' ? true : undefined,
      );
      expect(opsOf(spec).getOwner?.response, label).toEqual({ kind: 'model', name: 'PetWidgetOwner' });
      expect(
        spec.models.find((m) => m.name === 'PetWidgetOwner')?.fields.map((f) => f.name),
        label,
      ).toEqual(['object']);
      expectSound(spec, Object.keys(schemas));
      expect(warnings, label).toEqual([
        label === 'deprecated address'
          ? '[oagen] Renamed inline model "PetWidgetOwnerAddress" → "PetWidgetOwnerAddress2": it is deprecated while "PetWidgetOwnerAddress" is live'
          : '[oagen] Renamed inline model "PetWidgetOwnerAddress" → "PetWidgetOwnerAddress2": its shape differs from component schema "PetWidgetOwnerAddress"',
        '[oagen] Renamed inline model "PetWidgetOwner" → "PetWidgetOwner2": it references a renamed model and "PetWidgetOwner" keeps another definition',
      ]);
    }
  });
});
