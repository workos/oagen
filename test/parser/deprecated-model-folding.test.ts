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
  return refs;
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

/** Every model reference, from operations and model fields alike, that names no model. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const found: string[] = [];
  for (const op of Object.values(opsOf(spec))) {
    for (const [owner, ref] of operationRefs(op)) {
      for (const name of collectModelRefs(ref)) if (!names.has(name)) found.push(`${owner} → ${name}`);
    }
  }
  for (const model of spec.models) {
    for (const field of model.fields) {
      for (const name of collectModelRefs(field.type))
        if (!names.has(name)) found.push(`${model.name}.${field.name} → ${name}`);
    }
  }
  return found.sort();
}

/** Every model that is neither a component nor referenced by any operation or model field. */
function orphanedModels(spec: ApiSpec, componentNames: string[]): string[] {
  const referenced = new Set<string>();
  for (const op of Object.values(opsOf(spec))) {
    for (const [, ref] of operationRefs(op)) for (const name of collectModelRefs(ref)) referenced.add(name);
  }
  for (const model of spec.models) {
    for (const field of model.fields) for (const name of collectModelRefs(field.type)) referenced.add(name);
  }
  return spec.models
    .map((m) => m.name)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

/** The invariants every case below holds: nothing dangles, nothing is orphaned, and no undeclared reference reaches a deprecated model. */
function expectSound(spec: ApiSpec, componentNames: string[], declaredDeprecated: string[] = []): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec, componentNames)).toEqual([]);
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

  it('never folds a deprecated field object onto a live component either: the component’s flag is its own', async () => {
    const schemas = {
      Pet: {
        type: 'object',
        properties: { owner: { type: 'object', deprecated: true, properties: { name: { type: 'string' } } } },
      },
      PetOwner: { type: 'object', properties: { name: { type: 'string' } } },
    };
    const spec = await parseSpec(await writeSpec('pet-reverse.json', specDoc(schemas)));
    expect(describeModels(spec)).toEqual([
      { deprecated: undefined, fields: ['owner: PetOwner2'], name: 'Pet', required: [] },
      { deprecated: undefined, fields: ['name: string'], name: 'PetOwner', required: [] },
      { deprecated: true, fields: ['name: string'], name: 'PetOwner2', required: [] },
    ]);
    expect(spec.models.find((m) => m.name === 'Pet')?.fields[0]?.deprecated).toBe(true);
    expectSound(spec, ['Pet', 'PetOwner']);
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

    // And the other way round: the deprecated body keeps its flag under its
    // own name rather than folding onto the live component.
    const reversed = await parseSpec(
      await writeSpec(
        'note-reverse.json',
        specDoc(
          { CreateNoteRequest: { ...schemas.CreateNoteRequest, deprecated: undefined } },
          { '/notes': postOp('createNote', { ...body, deprecated: true }) },
        ),
      ),
    );
    expect(opsOf(reversed).createNote?.requestBody).toEqual({ kind: 'model', name: 'CreateNoteRequest2' });
    expect(reversed.models.find((m) => m.name === 'CreateNoteRequest2')?.deprecated).toBe(true);
    expect(reversed.models.find((m) => m.name === 'CreateNoteRequest')?.deprecated).toBeUndefined();
    expectSound(reversed, ['CreateNoteRequest'], ['createNote.requestBody → CreateNoteRequest2']);
  });

  it('gives an inline response named like a differently flagged component a qualified name, whatever its shape', async () => {
    type Widget = { type: string; deprecated?: boolean; properties: Record<string, unknown> };
    const widget = (extra: Partial<Widget>): Widget => ({
      type: 'object',
      properties: { object: { type: 'string', const: 'widget' }, k: { type: 'string' } },
      ...extra,
    });
    const cases: Array<[string, Widget, Widget]> = [
      ['same shape, component deprecated', widget({ deprecated: true }), widget({})],
      ['same shape, response deprecated', widget({}), widget({ deprecated: true })],
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
