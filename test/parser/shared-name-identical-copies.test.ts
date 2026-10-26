import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collectModelRefs, collectResponseHeaders } from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #314: identical inline copies that must leave a shared name — a
 * deprecated nested object beside a live component, a live one beside a
 * deprecated component, a deprecated copy beside live inline copies it does
 * not twin, a copy named like an enum — share one model under the first
 * site's qualified name, as identical copies leaving a component's name for
 * a shape it does not admit already did. Each site is repointed to it, the
 * note says how many sites share it, and a copy of another shape still
 * takes a name of its own.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-shared-name-copies-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** A minimal OpenAPI 3.1 document around `schemas` and `paths`. */
const specDoc = (schemas: Record<string, unknown>, paths: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'copies', version: '1' },
  paths,
  components: { schemas },
});

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
  ...extra,
});
/** An inline object pinned to the `Widget` name by its `object` const. */
const widget = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  obj({ object: { type: 'string', const: 'widget' }, ...properties }, extra);

/** A GET whose 200 body is `schema`. */
const getOp = (operationId: string, schema: unknown) => ({
  get: {
    operationId,
    responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
  },
});

/** The issue's projection of a model: `Name (deprecated) {field: type, …}`, with `!` on a required field. */
const describeModels = (spec: ApiSpec): string[] =>
  spec.models.map(
    ({ deprecated, fields, name }) =>
      `${name}${deprecated ? ' (deprecated)' : ''} {${fields
        .map(
          ({ name: f, required, type }) =>
            `${f}${required ? '!' : ''}: ${'name' in type ? type.name : 'type' in type ? String(type.type) : type.kind}`,
        )
        .join(', ')}}`,
  );

/** The merge passes' rename note. */
const renamed = (from: string, to: string, why: string): string =>
  `[oagen] Renamed inline model "${from}" → "${to}": ${why}`;

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

const fieldType = (spec: ApiSpec, model: string, field: string): TypeRef | undefined =>
  spec.models.find((m) => m.name === model)?.fields.find((f) => f.name === field)?.type;

/** Every type reference an operation holds, labelled by where it sits, with whether that site is itself deprecated. */
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

/** Every reference from a live operation, or a live field of a live model, that resolves to a deprecated model. */
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

/**
 * The invariants every case holds: every reference resolves, nothing minted
 * is orphaned, no model is named like an enum, every model name is unique,
 * and the only references that reach a deprecated model are the ones the
 * document wrote `deprecated: true` on itself.
 */
function expectSound(spec: ApiSpec, componentNames: string[], declaredDeprecated: string[] = []): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec, componentNames)).toEqual([]);
  const enumNames = new Set(spec.enums.map((e) => e.name));
  expect(spec.models.map((m) => m.name).filter((name) => enumNames.has(name))).toEqual([]);
  expect(new Set(spec.models.map((m) => m.name)).size).toBe(spec.models.length);
  expect(deprecatedReferences(spec)).toEqual([...declaredDeprecated].sort());
}

async function parse(label: string, doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const spec = await parseSpec(await writeSpec(`${label}.json`, doc));
    return { spec, warnings: warn.mock.calls.map(([m]) => String(m)) };
  } finally {
    warn.mockRestore();
  }
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
    const { spec, warnings } = await parse(`${label}-${order}`, specDoc(schemas, Object.fromEntries(ordered)));
    results.push({ order, spec, warnings });
  }
  return results;
}

describe('the issue, verbatim (issue #314)', () => {
  // `Pet.owner.address` and the deprecated `PetOwner` component's `address`
  // are the same deprecated object, so both mint a deprecated
  // `PetOwnerAddress`; `GET /pets/{id}` returns `Pet`.
  const address = { type: 'object', deprecated: true, properties: { city: str } };
  const schemas = (live: Record<string, unknown> | undefined) => ({
    Pet: obj({ owner: obj({ address }) }),
    PetOwner: obj({ address }, { deprecated: true }),
    ...(live ? { PetOwnerAddress: live } : {}),
  });
  const paths = { '/pets/{id}': getOp('getPet', { $ref: '#/components/schemas/Pet' }) };

  it('`live.json`: both `address` fields resolve to one model', async () => {
    // Identical to the live component but for the flag, the copies fold onto
    // it (issue #312), so the one model they share is `PetOwnerAddress`
    // itself; the live `Pet.owner` still leaves the deprecated `PetOwner`.
    const { spec, warnings } = await parse('live', specDoc(schemas(obj({ city: str })), paths));
    expect(describeModels(spec)).toEqual([
      'Pet {owner: PetOwner2}',
      'PetOwner (deprecated) {address: PetOwnerAddress}',
      'PetOwnerAddress {city: string}',
      'PetOwner2 {address: PetOwnerAddress}',
    ]);
    expect(fieldType(spec, 'PetOwner', 'address')).toEqual(fieldType(spec, 'PetOwner2', 'address'));
    expect(warnings.filter((w) => w.startsWith('[oagen] Renamed'))).toEqual([
      renamed('PetOwner', 'PetOwner2', 'it is live while "PetOwner" is deprecated'),
    ]);
    expectSound(spec, ['Pet', 'PetOwner', 'PetOwnerAddress']);
  });

  it('`nolive.json`: without the component the copies share the bare deprecated name, as before', async () => {
    const { spec, warnings } = await parse('nolive', specDoc(schemas(undefined), paths));
    expect(describeModels(spec)).toEqual([
      'Pet {owner: PetOwner2}',
      'PetOwner (deprecated) {address: PetOwnerAddress}',
      'PetOwnerAddress (deprecated) {city: string}',
      'PetOwner2 {address: PetOwnerAddress}',
    ]);
    expect(warnings).toEqual([renamed('PetOwner', 'PetOwner2', 'it is live while "PetOwner" is deprecated')]);
    expectSound(spec, ['Pet', 'PetOwner']);
  });

  it('beside a live `PetOwnerAddress` of another shape, both share one deprecated `PetOwnerAddress2` (the issue’s expected)', async () => {
    // The component does not admit the copies (it declares `country`), so
    // they must leave its name — and leave it together: one qualified
    // model, both `address` fields repointed, one note, no `PetOwnerAddress3`.
    const { spec, warnings } = await parse(
      'live-other-shape',
      specDoc(schemas(obj({ city: str, country: str })), paths),
    );
    expect(describeModels(spec)).toEqual([
      'Pet {owner: PetOwner2}',
      'PetOwner (deprecated) {address: PetOwnerAddress2}',
      'PetOwnerAddress {city: string, country: string}',
      'PetOwner2 {address: PetOwnerAddress2}',
      'PetOwnerAddress2 (deprecated) {city: string}',
    ]);
    expect(warnings).toEqual([
      `${renamed('PetOwnerAddress', 'PetOwnerAddress2', 'it is deprecated while "PetOwnerAddress" is live')} (shared by 2 sites)`,
      renamed('PetOwner', 'PetOwner2', 'it is live while "PetOwner" is deprecated'),
    ]);
    // `PetOwner2.address` is the document's own deprecated field, so its
    // reaching a deprecated model is declared, not folded in.
    expectSound(spec, ['Pet', 'PetOwner', 'PetOwnerAddress']);
  });
});

describe('identical copies leaving a shared name share one model, in either path order', () => {
  it('three deprecated nested objects under three operations, beside a live component of another shape', async () => {
    const owner = { type: 'object', deprecated: true, properties: { city: str } };
    for (const { order, spec, warnings } of await parseBothOrders(
      'three',
      { WidgetOwner: obj({ city: str, country: str }) },
      [
        ['/a-widgets/{id}', getOp('getAWidget', widget({ owner }))],
        ['/b-widgets/{id}', getOp('getBWidget', widget({ owner }))],
        ['/c-widgets/{id}', getOp('getCWidget', widget({ owner }))],
      ],
    )) {
      const first = order === 'as-written' ? 'GetAWidget' : 'GetCWidget';
      expect(describeModels(spec).sort(), order).toEqual(
        [
          'WidgetOwner {city: string, country: string}',
          `Widget {object: literal, owner: ${first}WidgetOwner}`,
          `${first}WidgetOwner (deprecated) {city: string}`,
        ].sort(),
      );
      // The three parents, all referencing the one renamed child, are
      // identical and fold to one live `Widget`.
      for (const op of ['getAWidget', 'getBWidget', 'getCWidget']) {
        expect(opsOf(spec)[op]?.response, `${order} ${op}`).toEqual({ kind: 'model', name: 'Widget' });
      }
      expect(warnings, order).toEqual([
        `${renamed('WidgetOwner', `${first}WidgetOwner`, 'it is deprecated while "WidgetOwner" is live')} (shared by 3 sites)`,
      ]);
      expectSound(spec, ['WidgetOwner']);
    }
  });

  it('two identical deprecated responses share one name while a third of another shape takes its own', async () => {
    const schemas = { Widget: widget({ a: str, b: str, c: str }) };
    for (const { order, spec, warnings } of await parseBothOrders('two-plus-one', schemas, [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', widget({ a: str }, { deprecated: true }))],
      ['/old-widgets/{id}', getOp('getOldWidget', widget({ a: str }, { deprecated: true }))],
      ['/ancient-widgets/{id}', getOp('getAncientWidget', widget({ a: str, b: str }, { deprecated: true }))],
    ])) {
      const first = order === 'as-written' ? 'GetLegacyWidget' : 'GetOldWidget';
      const ops = opsOf(spec);
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(ops.getOldWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(ops.getAncientWidget?.response, order).toEqual({ kind: 'model', name: 'GetAncientWidgetWidget' });
      expect(describeModels(spec).sort(), order).toEqual(
        [
          'Widget {object: literal, a: string, b: string, c: string}',
          `${first}Widget (deprecated) {object: literal, a: string}`,
          'GetAncientWidgetWidget (deprecated) {object: literal, a: string, b: string}',
        ].sort(),
      );
      const shared = `${renamed('Widget', `${first}Widget`, 'it is deprecated while "Widget" is live')} (shared by 2 sites)`;
      const own = renamed('Widget', 'GetAncientWidgetWidget', 'it is deprecated while "Widget" is live');
      // Clusters are noted in document order of their first copy.
      expect(warnings, order).toEqual(order === 'as-written' ? [shared, own] : [own, shared]);
      expectSound(
        spec,
        ['Widget'],
        [
          `getLegacyWidget.response → ${first}Widget`,
          `getOldWidget.response → ${first}Widget`,
          'getAncientWidget.response → GetAncientWidgetWidget',
        ],
      );
    }
  });

  it('two identical live responses beside a deprecated component', async () => {
    const schemas = { Widget: widget({ a: str }, { deprecated: true }) };
    for (const { order, spec, warnings } of await parseBothOrders('live-copies', schemas, [
      ['/a-widgets/{id}', getOp('getAWidget', widget({ a: str }))],
      ['/b-widgets/{id}', getOp('getBWidget', widget({ a: str }))],
    ])) {
      const first = order === 'as-written' ? 'GetAWidget' : 'GetBWidget';
      expect(opsOf(spec).getAWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(opsOf(spec).getBWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(describeModels(spec).sort(), order).toEqual(
        ['Widget (deprecated) {object: literal, a: string}', `${first}Widget {object: literal, a: string}`].sort(),
      );
      expect(warnings, order).toEqual([
        `${renamed('Widget', `${first}Widget`, 'it is live while "Widget" is deprecated')} (shared by 2 sites)`,
      ]);
      expectSound(spec, ['Widget']);
    }
  });

  it('two identical deprecated responses beside a live inline copy they do not twin (no component)', async () => {
    for (const { order, spec, warnings } of await parseBothOrders('no-owner', {}, [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', widget({ a: str }, { deprecated: true }))],
      ['/old-widgets/{id}', getOp('getOldWidget', widget({ a: str }, { deprecated: true }))],
      ['/widgets/{id}', getOp('getWidget', widget({ a: str }, { required: ['a'] }))],
    ])) {
      const first = order === 'as-written' ? 'GetLegacyWidget' : 'GetOldWidget';
      const ops = opsOf(spec);
      expect(ops.getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(ops.getOldWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(describeModels(spec).sort(), order).toEqual(
        ['Widget {object: literal, a!: string}', `${first}Widget (deprecated) {object: literal, a: string}`].sort(),
      );
      expect(warnings, order).toEqual([
        `${renamed('Widget', `${first}Widget`, 'it is deprecated while "Widget" is live')} (shared by 2 sites)`,
      ]);
      expectSound(spec, [], [`getLegacyWidget.response → ${first}Widget`, `getOldWidget.response → ${first}Widget`]);
    }
  });

  it('two identical responses named like a component enum', async () => {
    const schemas = { Widget: { type: 'string', enum: ['round', 'square'] } };
    for (const { order, spec, warnings } of await parseBothOrders('enum-owned', schemas, [
      ['/a-widgets/{id}', getOp('getAWidget', widget({ a: str }))],
      ['/b-widgets/{id}', getOp('getBWidget', widget({ a: str }))],
    ])) {
      const first = order === 'as-written' ? 'GetAWidget' : 'GetBWidget';
      expect(opsOf(spec).getAWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(opsOf(spec).getBWidget?.response, order).toEqual({ kind: 'model', name: `${first}Widget` });
      expect(describeModels(spec), order).toEqual([`${first}Widget {object: literal, a: string}`]);
      expect(
        spec.enums.map((e) => e.name),
        order,
      ).toEqual(['Widget']);
      expect(warnings, order).toEqual([
        `${renamed('Widget', `${first}Widget`, 'enum "Widget" owns the name')} (shared by 2 sites)`,
      ]);
      expectSound(spec, []);
    }
  });
});
