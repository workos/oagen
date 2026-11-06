import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import {
  deprecatedFoldWarning,
  fieldAdmits,
  fieldFlagAgrees,
  flagAdmits,
  looserFields,
  modelAdmits,
  modelFingerprint,
  modelPropertiesAdmit,
  modelPropertiesKey,
  modelShares,
  ownerFlagAdmits,
  shapeFingerprint,
} from '../../src/parser/inline-models.js';
import {
  collectModelRefs,
  collectModelTypeRefs,
  collectOperationTypeRefs,
  collectRequestBodyTypes,
  collectResponseHeaders,
  collectWebhookTypeRefs,
  walkTypeRef,
} from '../../src/ir/types.js';
import type { ApiSpec, Field, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #312: a deprecated inline schema identical to a live component it is
 * named like folds onto the component — as #263 folds it onto a live inline
 * twin — with the flag staying on the site that wrote the schema (the field,
 * parameter, header or envelope field), so adding `deprecated: true` to such
 * a schema is the deprecation flip `oagen diff` reports as additive, not a
 * new qualified model and a breaking type change. The reverse never folds
 * (#260): a live inline copy beside a deprecated component keeps a model of
 * its own.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-312-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
  ...extra,
});
const deprecate = (schema: Record<string, unknown>, deprecated: boolean) =>
  deprecated ? { ...schema, deprecated: true } : schema;

/** A minimal OpenAPI 3.1 document around `schemas` and `paths`. */
const specDoc = (
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  openapi: '3.1.0',
  info: { title: 'identical-component-fold', version: '1' },
  paths,
  components: { schemas },
  ...extra,
});

/** A GET whose 200 body is `schema`. */
const getOp = (operationId: string, schema: unknown, extra: Record<string, unknown> = {}) => ({
  get: {
    operationId,
    ...extra,
    responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
  },
});

/** A POST whose JSON request body is `schema`, with a bodiless 200. */
const postOp = (operationId: string, schema: unknown) => ({
  post: {
    operationId,
    requestBody: { content: { 'application/json': { schema } } },
    responses: { '200': { description: 'OK' } },
  },
});

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

const refName = (ref: TypeRef | undefined): string | undefined => (ref?.kind === 'model' ? ref.name : undefined);

/** The issue's projection of the models: name, flag and `name: type` per field. */
const describeModels = (spec: ApiSpec): string[] =>
  spec.models.map(
    ({ deprecated, fields, name }) =>
      `${name}${deprecated ? ' (deprecated)' : ''} {${fields
        .map(
          ({ name: f, type, deprecated: fd }) =>
            `${f}${fd ? ' (deprecated)' : ''}: ${refName(type) ?? ('type' in type ? type.type : type.kind)}`,
        )
        .join(', ')}}`,
  );

/** Parse `doc`, capturing every warning. */
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
  extra: Record<string, unknown> = {},
): Promise<Array<{ order: string; spec: ApiSpec; warnings: string[] }>> {
  const results = [];
  for (const [order, ordered] of [
    ['as-written', paths],
    ['swapped', [...paths].reverse()],
  ] as const) {
    results.push({
      order,
      ...(await parse(`${label}-${order}`, specDoc(schemas, Object.fromEntries(ordered), extra))),
    });
  }
  return results;
}

/** The issue's projection of `oagen diff`: the breaking count and one line per change and field change. */
function describeDiff(oldSpec: ApiSpec, newSpec: ApiSpec): { breaking: number; changes: string[] } {
  const { changes, summary } = diffSpecs(oldSpec, newSpec);
  return {
    breaking: summary.breaking,
    changes: changes.flatMap((change) => {
      const { classification, kind } = change;
      const rest = change as unknown as Record<string, unknown>;
      const fieldChanges =
        (rest.fieldChanges as Array<{ kind: string; fieldName: string; classification: string }> | undefined) ?? [];
      const flags = Object.keys(rest)
        .filter((k) => k.endsWith('Changed') && rest[k] === true)
        .map((k) => ` ${k}`)
        .join('');
      const label = 'name' in change ? change.name : 'operationName' in change ? change.operationName : undefined;
      return [
        `${kind} ${label}${flags}: ${classification}`,
        ...fieldChanges.map((f) => `${f.kind} ${f.fieldName}: ${f.classification}`),
      ];
    }),
  };
}

/** Every type reference a live site holds, labelled, with whether the site itself is deprecated. */
function siteRefs(spec: ApiSpec): Array<[string, TypeRef, boolean]> {
  const refs: Array<[string, TypeRef, boolean]> = [];
  for (const op of Object.values(opsOf(spec))) {
    refs.push([`${op.name}.response`, op.response, !!op.deprecated]);
    if (op.requestBody) refs.push([`${op.name}.requestBody`, op.requestBody, !!op.deprecated]);
    for (const { source, type } of collectRequestBodyTypes(op))
      refs.push([`${op.name}.${source}`, type, !!op.deprecated]);
    for (const r of op.successResponses ?? []) refs.push([`${op.name}.${r.statusCode}`, r.type, !!op.deprecated]);
    for (const e of op.errors) if (e.type) refs.push([`${op.name}.${e.statusCode}`, e.type, !!op.deprecated]);
    for (const f of op.pagination?.envelopeFields ?? []) {
      refs.push([`${op.name}.${f.name}`, f.type, !!op.deprecated || !!f.deprecated]);
    }
    if (op.pagination) refs.push([`${op.name}.items`, op.pagination.itemType, !!op.deprecated]);
    for (const h of collectResponseHeaders(op))
      refs.push([`${op.name}.${h.name}`, h.type, !!op.deprecated || !!h.deprecated]);
    for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...(op.cookieParams ?? [])]) {
      refs.push([`${op.name}(${p.name})`, p.type, !!op.deprecated || !!p.deprecated]);
    }
  }
  for (const webhook of spec.webhooks ?? []) {
    for (const ref of collectWebhookTypeRefs(webhook))
      refs.push([`webhook ${webhook.name}`, ref, !!webhook.deprecated]);
  }
  for (const model of spec.models) {
    for (const field of model.fields) {
      refs.push([`${model.name}.${field.name}`, field.type, !!model.deprecated || !!field.deprecated]);
    }
    for (const [i, variant] of (model.variants ?? []).entries()) {
      refs.push([`${model.name}#${i}`, variant, !!model.deprecated]);
    }
  }
  return refs;
}

/**
 * The invariants every case below holds: every model and enum reference
 * resolves, no model but a component is orphaned, no model is named like an
 * enum, and no reference from a live site reaches a deprecated model — save
 * those `declaredDeprecated` lists, which the document wrote itself.
 */
function expectSound(spec: ApiSpec, componentNames: string[], declaredDeprecated: string[] = []): void {
  const modelNames = new Set(spec.models.map((m) => m.name));
  const enumNames = new Set(spec.enums.map((e) => e.name));
  const deprecated = new Set(spec.models.filter((m) => m.deprecated).map((m) => m.name));
  const unresolved: string[] = [];
  const referenced = new Set<string>();
  const reaching: string[] = [];
  const allRefs: TypeRef[] = [
    ...Object.values(opsOf(spec)).flatMap(collectOperationTypeRefs),
    ...(spec.webhooks ?? []).flatMap(collectWebhookTypeRefs),
    ...spec.models.flatMap(collectModelTypeRefs),
  ];
  for (const ref of allRefs) {
    for (const name of collectModelRefs(ref)) {
      referenced.add(name);
      if (!modelNames.has(name)) unresolved.push(`model ${name}`);
    }
    walkTypeRef(ref, {
      enum: (r) => {
        if (!enumNames.has(r.name)) unresolved.push(`enum ${r.name}`);
      },
    });
  }
  for (const [site, ref, siteDeprecated] of siteRefs(spec)) {
    if (siteDeprecated) continue;
    for (const name of collectModelRefs(ref)) if (deprecated.has(name)) reaching.push(`${site} → ${name}`);
  }
  expect(unresolved).toEqual([]);
  expect(
    spec.models.map((m) => m.name).filter((name) => !componentNames.includes(name) && !referenced.has(name)),
  ).toEqual([]);
  expect(spec.models.map((m) => m.name).filter((name) => enumNames.has(name))).toEqual([]);
  expect(reaching.sort()).toEqual([...declaredDeprecated].sort());
}

const folded = (name: string): string =>
  `[oagen] Warning: Inline model "${name}" is declared both deprecated and live with the same shape — keeping the live definition under the shared name`;

describe('the issue’s repros: each pair before and after `deprecated: true` on the inline object (issue #312)', () => {
  const title = obj({ title: str });
  const widget = obj({ object: { type: 'string', const: 'widget' }, name: str });
  const owner = obj({ name: str });

  it('body: a deprecated `createNote` body identical to the live `CreateNoteRequest` folds onto it, and the diff is empty', async () => {
    const paths = (deprecated: boolean): Array<[string, unknown]> => [
      ['/legacy-notes', postOp('createNote', deprecate(title, deprecated))],
      [
        '/notes',
        {
          put: {
            operationId: 'putNote',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateNoteRequest' } } },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      ],
    ];
    const [before] = await parseBothOrders('body-old', { CreateNoteRequest: title }, paths(false));
    expect(before!.warnings).toEqual([]);
    for (const { order, spec, warnings } of await parseBothOrders(
      'body-new',
      { CreateNoteRequest: title },
      paths(true),
    )) {
      const ops = opsOf(spec);
      expect(describeModels(spec), order).toEqual(['CreateNoteRequest {title: string}']);
      expect(ops.createNote?.requestBody, order).toEqual({ kind: 'model', name: 'CreateNoteRequest' });
      expect(ops.putNote?.requestBody, order).toEqual({ kind: 'model', name: 'CreateNoteRequest' });
      expect(warnings, order).toEqual([folded('CreateNoteRequest')]);
      expectSound(spec, ['CreateNoteRequest']);
      expect(describeDiff(before!.spec, spec), order).toEqual({ breaking: 0, changes: [] });
    }
  });

  it('field: a deprecated `Pet.owner` identical to the live `PetOwner` folds onto it, and the diff is the field’s flip alone', async () => {
    const doc = (deprecated: boolean) =>
      specDoc(
        { Pet: obj({ owner: deprecate(owner, deprecated) }), PetOwner: owner },
        { '/pets/{id}': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
      );
    const before = await parse('field-old', doc(false));
    const after = await parse('field-new', doc(true));
    expect(before.warnings).toEqual([]);
    expect(describeModels(before.spec)).toEqual(['Pet {owner: PetOwner}', 'PetOwner {name: string}']);
    expect(describeModels(after.spec)).toEqual(['Pet {owner (deprecated): PetOwner}', 'PetOwner {name: string}']);
    expect(after.warnings).toEqual([folded('PetOwner')]);
    expectSound(after.spec, ['Pet', 'PetOwner']);
    expect(describeDiff(before.spec, after.spec)).toEqual({
      breaking: 0,
      changes: ['model-modified Pet: additive', 'field-deprecated-changed owner: additive'],
    });
  });

  it('response: a deprecated `getLegacyWidget` response identical to the live `Widget` folds onto it, and the diff is empty', async () => {
    const paths = (deprecated: boolean): Array<[string, unknown]> => [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', deprecate(widget, deprecated))],
      ['/widgets/{id}', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
    ];
    const [before] = await parseBothOrders('response-old', { Widget: widget }, paths(false));
    expect(before!.warnings).toEqual([]);
    for (const { order, spec, warnings } of await parseBothOrders('response-new', { Widget: widget }, paths(true))) {
      const ops = opsOf(spec);
      expect(describeModels(spec), order).toEqual(['Widget {object: literal, name: string}']);
      expect(ops.getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(ops.getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(warnings, order).toEqual([folded('Widget')]);
      expectSound(spec, ['Widget']);
      expect(describeDiff(before!.spec, spec), order).toEqual({ breaking: 0, changes: [] });
    }
  });

  it('the issue’s other reading: two inline copies identical but for the flag still fold onto the live one (#263)', async () => {
    const paths = (deprecated: boolean): Array<[string, unknown]> => [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', deprecate(widget, deprecated))],
      ['/widgets/{id}', getOp('getWidget', widget)],
    ];
    const [before] = await parseBothOrders('twins-old', {}, paths(false));
    for (const { order, spec, warnings } of await parseBothOrders('twins-new', {}, paths(true))) {
      expect(describeModels(spec), order).toEqual(['Widget {object: literal, name: string}']);
      expect(opsOf(spec).getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(warnings, order).toEqual([folded('Widget')]);
      expectSound(spec, []);
      expect(describeDiff(before!.spec, spec), order).toEqual({ breaking: 0, changes: [] });
    }
  });
});

describe('every site a deprecated inline schema identical to a live component can sit at (issue #312)', () => {
  /** The models the diff adds or removes, and the breaking count: a fold changes neither. */
  const modelChanges = (oldSpec: ApiSpec, newSpec: ApiSpec) => {
    const { breaking, changes } = describeDiff(oldSpec, newSpec);
    return { breaking, models: changes.filter((c) => c.startsWith('model-added') || c.startsWith('model-removed')) };
  };

  // A header or parameter model is named from the service word (`Account` +
  // `X-Meta` → `AccountXMeta`); a component key's leading word is
  // singularized, so only a singular service word can share a name with one.
  it('a response header’s object (the shape registry), the header keeping its own flag', async () => {
    const meta = obj({ etag: str });
    const doc = (deprecated: boolean) =>
      specDoc(
        { AccountXMeta: meta },
        {
          '/account': {
            get: {
              operationId: 'getAccount',
              tags: ['Account'],
              responses: {
                '200': {
                  description: 'ok',
                  headers: {
                    'X-Meta': { ...(deprecated ? { deprecated: true } : {}), schema: deprecate(meta, deprecated) },
                  },
                  content: { 'application/json': { schema: str } },
                },
              },
            },
          },
        },
      );
    const before = await parse('header-old', doc(false));
    const after = await parse('header-new', doc(true));
    const header = collectResponseHeaders(opsOf(after.spec).getAccount!)[0];
    expect(header?.type).toEqual({ kind: 'model', name: 'AccountXMeta' });
    expect(header?.deprecated).toBe(true);
    expect(describeModels(after.spec)).toEqual(['AccountXMeta {etag: string}']);
    expect(after.warnings).toEqual([folded('AccountXMeta')]);
    expectSound(after.spec, ['AccountXMeta']);
    expect(modelChanges(before.spec, after.spec)).toEqual({ breaking: 0, models: [] });
  });

  it('a parameter’s object (the shape registry, a shape the SDK sends), the parameter keeping its own flag', async () => {
    const filter = obj({ q: str });
    const withParam = (schema: unknown) => ({
      '/account': getOp('getAccount', str, {
        tags: ['Account'],
        parameters: [{ name: 'filter', in: 'query', style: 'deepObject', schema }],
      }),
    });
    const doc = (deprecated: boolean) => specDoc({ AccountFilter: filter }, withParam(deprecate(filter, deprecated)));
    const before = await parse('param-old', doc(false));
    const after = await parse('param-new', doc(true));
    const param = opsOf(after.spec).getAccount?.queryParams[0];
    expect(param?.type).toEqual({ kind: 'model', name: 'AccountFilter' });
    expect(param?.deprecated).toBe(true);
    expect(describeModels(after.spec)).toEqual(['AccountFilter {q: string}']);
    expect(after.warnings).toEqual([folded('AccountFilter')]);
    expectSound(after.spec, ['AccountFilter']);
    expect(modelChanges(before.spec, after.spec)).toEqual({ breaking: 0, models: [] });

    // A shape the SDK sends still shares a component on an identical shape
    // only: a looser component (optional `q`) takes no parameter requiring
    // it, deprecated or not.
    const strict = await parse(
      'param-strict',
      specDoc({ AccountFilter: filter }, withParam({ ...filter, required: ['q'], deprecated: true })),
    );
    const strictParam = opsOf(strict.spec).getAccount?.queryParams[0];
    expect(refName(strictParam?.type)).toBeDefined();
    expect(refName(strictParam?.type)).not.toBe('AccountFilter');
    expect(strict.spec.models.find((m) => m.name === refName(strictParam?.type))?.deprecated).toBe(true);
    // The parameter wrote the flag itself, so its reference is the document's own.
    expectSound(strict.spec, ['AccountFilter']);
  });

  it('an error body and a secondary request body (the shape registry), which carry no flag of their own', async () => {
    const message = obj({ message: str });
    const rows = obj({ rows: str });
    const doc = (deprecated: boolean) =>
      specDoc(
        { ListUsersError404: message, CreateNoteTextCsvRequest: rows },
        {
          '/users': {
            get: {
              operationId: 'listUsers',
              responses: {
                '200': { description: 'ok', content: { 'application/json': { schema: str } } },
                '404': {
                  description: 'nope',
                  content: { 'application/json': { schema: deprecate(message, deprecated) } },
                },
              },
            },
          },
          '/notes': {
            post: {
              operationId: 'createNote',
              requestBody: {
                content: {
                  'application/json': { schema: obj({ title: str }) },
                  'text/csv': { schema: deprecate(rows, deprecated) },
                },
              },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      );
    const before = await parse('registry-old', doc(false));
    const after = await parse('registry-new', doc(true));
    const ops = opsOf(after.spec);
    expect(ops.listUsers?.errors.map((e) => [e.statusCode, e.type])).toEqual([
      [404, { kind: 'model', name: 'ListUsersError404' }],
    ]);
    expect(collectRequestBodyTypes(ops.createNote!).map((b) => b.type)).toEqual([
      { kind: 'model', name: 'CreateNoteTextCsvRequest' },
    ]);
    expect(describeModels(after.spec)).toEqual([
      'ListUsersError404 {message: string}',
      'CreateNoteTextCsvRequest {rows: string}',
      'CreateNoteRequest {title: string}',
    ]);
    expect(after.warnings).toEqual([folded('ListUsersError404'), folded('CreateNoteTextCsvRequest')]);
    expectSound(after.spec, ['ListUsersError404', 'CreateNoteTextCsvRequest']);
    expect(modelChanges(before.spec, after.spec)).toEqual({ breaking: 0, models: [] });
  });

  it('the items of an array response (the shape registry)', async () => {
    const item = obj({ id: str });
    const doc = (deprecated: boolean) =>
      specDoc(
        { ListUsersItem: item },
        { '/users': getOp('listUsers', { type: 'array', items: deprecate(item, deprecated) }) },
      );
    const before = await parse('items-old', doc(false));
    const after = await parse('items-new', doc(true));
    expect(opsOf(after.spec).listUsers?.response).toEqual({
      kind: 'array',
      items: { kind: 'model', name: 'ListUsersItem' },
    });
    expect(describeModels(after.spec)).toEqual(['ListUsersItem {id: string}']);
    expect(after.warnings).toEqual([folded('ListUsersItem')]);
    expectSound(after.spec, ['ListUsersItem']);
    expect(modelChanges(before.spec, after.spec)).toEqual({ breaking: 0, models: [] });
  });

  it('a webhook payload’s titled variant (the merge passes)', async () => {
    // A webhook's own payload model and its nested objects are named under
    // the webhook's stem, so the webhook site that can share a component's
    // name is a `oneOf` variant named by its title: `Pet`, beside a live
    // `Pet` component of the same shape.
    const pet = obj({ object: { type: 'string', const: 'pet' }, name: str });
    const toy = obj({ object: { type: 'string', const: 'toy' }, name: str });
    const doc = (deprecated: boolean) =>
      specDoc(
        { Pet: pet },
        {},
        {
          webhooks: {
            petAdopted: {
              post: {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: {
                        oneOf: [
                          { title: 'Pet', ...deprecate(pet, deprecated) },
                          { title: 'Toy', ...toy },
                        ],
                      },
                    },
                  },
                },
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        },
      );
    const before = await parse('webhook-old', doc(false));
    const after = await parse('webhook-new', doc(true));
    const payload = after.spec.webhooks?.[0]?.requestBody;
    expect(payload?.kind).toBe('union');
    expect(payload?.kind === 'union' ? payload.variants.map(refName) : []).toEqual(['Pet', 'Toy']);
    expect(after.spec.models.map((m) => [m.name, m.deprecated]).sort()).toEqual([
      ['Pet', undefined],
      ['Toy', undefined],
    ]);
    expect(after.warnings).toEqual([folded('Pet')]);
    expectSound(after.spec, ['Pet']);
    expect(modelChanges(before.spec, after.spec)).toEqual({ breaking: 0, models: [] });
  });

  it('a component field’s array items and `oneOf` variant (the field pass)', async () => {
    const ownerShape = obj({ name: str });
    const circle = obj({ kind: { type: 'string', const: 'circle' }, r: str });
    const square = obj({ kind: { type: 'string', const: 'square' }, s: str });
    const doc = (deprecated: boolean) =>
      specDoc(
        {
          Pet: obj({ owners: { type: 'array', items: deprecate(ownerShape, deprecated) } }),
          PetOwner: ownerShape,
          Drawing: obj({
            shape: {
              oneOf: [
                { title: 'Circle', ...deprecate(circle, deprecated) },
                { title: 'Square', ...square },
              ],
            },
          }),
          Circle: circle,
        },
        {
          '/pets/{id}': getOp('getPet', { $ref: '#/components/schemas/Pet' }),
          '/drawings/{id}': getOp('getDrawing', { $ref: '#/components/schemas/Drawing' }),
        },
      );
    const before = await parse('field-sites-old', doc(false));
    const after = await parse('field-sites-new', doc(true));
    const byName = Object.fromEntries(after.spec.models.map((m) => [m.name, m]));
    expect(byName.Pet?.fields[0]?.type).toEqual({ kind: 'array', items: { kind: 'model', name: 'PetOwner' } });
    const shape = byName.Drawing?.fields[0]?.type;
    expect(shape?.kind).toBe('union');
    expect(shape?.kind === 'union' ? shape.variants.map(refName) : []).toEqual(['Circle', 'Square']);
    expect(Object.keys(byName).sort()).toEqual(['Circle', 'Drawing', 'Pet', 'PetOwner', 'Square']);
    expect(after.warnings).toEqual([folded('PetOwner'), folded('Circle')]);
    expectSound(after.spec, ['Pet', 'PetOwner', 'Drawing', 'Circle']);
    expect(modelChanges(before.spec, after.spec)).toEqual({ breaking: 0, models: [] });
  });

  it('a list envelope’s companion (the envelope pass), the envelope field keeping its own flag', async () => {
    const listMetadata = obj({ before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } });
    const doc = (deprecated: boolean) =>
      specDoc(
        { User: obj({ id: str }), ListMetadata: listMetadata },
        {
          '/legacy-users': {
            get: {
              operationId: 'listLegacyUsers',
              parameters: [{ name: 'after', in: 'query', schema: str }],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        allOf: [
                          obj({
                            object: { type: 'string', const: 'list' },
                            list_metadata: deprecate(listMetadata, deprecated),
                          }),
                          obj({ data: { type: 'array', items: { $ref: '#/components/schemas/User' } } }),
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      );
    const before = await parse('companion-old', doc(false));
    const after = await parse('companion-new', doc(true));
    const meta = opsOf(after.spec).listLegacyUsers?.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata');
    expect(meta?.type).toEqual({ kind: 'model', name: 'ListMetadata' });
    expect(meta?.deprecated).toBe(true);
    expect(after.spec.models.map((m) => m.name).sort()).toEqual(['ListMetadata', 'User']);
    expect(after.warnings).toEqual([folded('ListMetadata')]);
    expectSound(after.spec, ['User', 'ListMetadata']);
    expect(modelChanges(before.spec, after.spec)).toEqual({ breaking: 0, models: [] });
  });

  it('a list envelope’s companion whose own field is deprecated keeps its name beside a live component (Greptile, #364 round 1)', async () => {
    // The component's fields are what every site reads after a fold, and
    // nothing but the field carries a field's notice: a deprecated
    // `list_metadata` whose `before` is deprecated too never shares a live
    // `ListMetadata` whose `before` is live — nor does a live companion
    // beside a component whose `before` is deprecated — while both
    // deprecating `before` share it.
    const listMetadata = (before: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      obj({ before: { type: ['string', 'null'], ...before }, after: { type: ['string', 'null'] } }, extra);
    const doc = (component: Record<string, unknown>, companion: Record<string, unknown>) =>
      specDoc(
        { User: obj({ id: str }), ListMetadata: component },
        {
          '/legacy-users': {
            get: {
              operationId: 'listLegacyUsers',
              parameters: [{ name: 'after', in: 'query', schema: str }],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        allOf: [
                          obj({ object: { type: 'string', const: 'list' }, list_metadata: companion }),
                          obj({ data: { type: 'array', items: { $ref: '#/components/schemas/User' } } }),
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      );
    const metaOf = (spec: ApiSpec) =>
      opsOf(spec).listLegacyUsers?.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata');
    const beforeOf = (spec: ApiSpec, name: string) =>
      spec.models.find((m) => m.name === name)?.fields.find((f) => f.name === 'before');

    for (const [label, root] of [
      ['deprecated companion', { deprecated: true }],
      ['live companion', {}],
    ] as const) {
      const kept = await parse(
        `companion-field-${label.replace(/\W+/g, '-')}`,
        doc(listMetadata({}), listMetadata({ deprecated: true }, root)),
      );
      expect(metaOf(kept.spec)?.type, label).toEqual({ kind: 'model', name: 'ListLegacyUsersListMetadata' });
      expect(metaOf(kept.spec)?.deprecated, label).toBe(root.deprecated);
      expect(beforeOf(kept.spec, 'ListLegacyUsersListMetadata')?.deprecated, label).toBe(true);
      expect(beforeOf(kept.spec, 'ListMetadata')?.deprecated, label).toBeUndefined();
      expect(kept.warnings, label).toEqual([]);
      expectSound(kept.spec, ['User', 'ListMetadata']);
    }
    // The component's `before` deprecated, the companion's live.
    const reverse = await parse('companion-field-reverse', doc(listMetadata({ deprecated: true }), listMetadata({})));
    expect(metaOf(reverse.spec)?.type).toEqual({ kind: 'model', name: 'ListLegacyUsersListMetadata' });
    expect(beforeOf(reverse.spec, 'ListLegacyUsersListMetadata')?.deprecated).toBeUndefined();
    expect(beforeOf(reverse.spec, 'ListMetadata')?.deprecated).toBe(true);
    expect(reverse.warnings).toEqual([]);
    expectSound(reverse.spec, ['User', 'ListMetadata']);
    // Both deprecate `before`: the deprecated companion folds.
    const both = await parse(
      'companion-field-both',
      doc(listMetadata({ deprecated: true }), listMetadata({ deprecated: true }, { deprecated: true })),
    );
    expect(metaOf(both.spec)?.type).toEqual({ kind: 'model', name: 'ListMetadata' });
    expect(metaOf(both.spec)?.deprecated).toBe(true);
    expect(both.spec.models.map((m) => m.name).sort()).toEqual(['ListMetadata', 'User']);
    expect(both.warnings).toEqual([folded('ListMetadata')]);
    expectSound(both.spec, ['User', 'ListMetadata']);
  });

  it('a copy whose own limit differs keeps its name beside a live component, at every site (Greptile, #364 merge round)', async () => {
    // The reviewer's shape: a live component declaring two optional fields
    // and `minProperties: 2`, a deprecated copy declaring the same fields
    // with `minProperties: 1`. The component's definition is what every
    // site reads after a fold, so a copy whose own limit differs keeps its
    // name and its limit — a list envelope's companion, a field object and
    // a request body alike — while the same limit folds.
    const shape = (minProperties: number | undefined, extra: Record<string, unknown> = {}) =>
      obj({ before: str, after: str }, { ...(minProperties === undefined ? {} : { minProperties }), ...extra });
    const limitOf = (spec: ApiSpec, name: string) =>
      spec.models.find((m) => m.name === name)?.constraints?.minProperties;

    // The companion.
    const companionDoc = (component: Record<string, unknown>, companion: Record<string, unknown>) =>
      specDoc(
        { User: obj({ id: str }), ListMetadata: component },
        {
          '/legacy-users': {
            get: {
              operationId: 'listLegacyUsers',
              parameters: [{ name: 'after', in: 'query', schema: str }],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        allOf: [
                          obj({ object: { type: 'string', const: 'list' }, list_metadata: companion }),
                          obj({ data: { type: 'array', items: { $ref: '#/components/schemas/User' } } }),
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      );
    const metaOf = (spec: ApiSpec) =>
      opsOf(spec).listLegacyUsers?.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata');
    for (const [label, component, companion] of [
      ['copy looser', 2, 1],
      ['copy stricter', 1, 2],
      ['component only', 2, undefined],
      ['copy only', undefined, 1],
    ] as const) {
      const kept = await parse(
        `companion-model-limit-${label.replace(/\W+/g, '-')}`,
        companionDoc(shape(component), shape(companion, { deprecated: true })),
      );
      expect(metaOf(kept.spec)?.type, label).toEqual({ kind: 'model', name: 'ListLegacyUsersListMetadata' });
      expect(metaOf(kept.spec)?.deprecated, label).toBe(true);
      expect(limitOf(kept.spec, 'ListLegacyUsersListMetadata'), label).toBe(companion);
      expect(limitOf(kept.spec, 'ListMetadata'), label).toBe(component);
      expect(kept.warnings, label).toEqual([]);
      expectSound(kept.spec, ['User', 'ListMetadata']);
    }
    const companionFolds = await parse(
      'companion-model-limit-same',
      companionDoc(shape(2), shape(2, { deprecated: true })),
    );
    expect(metaOf(companionFolds.spec)?.type).toEqual({ kind: 'model', name: 'ListMetadata' });
    expect(limitOf(companionFolds.spec, 'ListMetadata')).toBe(2);
    expect(companionFolds.spec.models.map((m) => m.name).sort()).toEqual(['ListMetadata', 'User']);
    expect(companionFolds.warnings).toEqual([folded('ListMetadata')]);
    expectSound(companionFolds.spec, ['User', 'ListMetadata']);

    // A field object and a request body, through the merge passes.
    const siteDoc = (component: number | undefined, copy: number | undefined) =>
      specDoc(
        {
          Pet: obj({ owner: shape(copy, { deprecated: true }) }),
          PetOwner: shape(component),
          CreateNoteRequest: shape(component),
        },
        {
          '/pets/{id}': getOp('getPet', { $ref: '#/components/schemas/Pet' }),
          '/notes': postOp('createNote', shape(copy, { deprecated: true })),
        },
      );
    for (const [label, component, copy] of [
      ['copy looser', 2, 1],
      ['copy stricter', 1, 2],
      ['component only', 2, undefined],
      ['copy only', undefined, 1],
    ] as const) {
      const kept = await parse(`site-model-limit-${label.replace(/\W+/g, '-')}`, siteDoc(component, copy));
      const byName = Object.fromEntries(kept.spec.models.map((m) => [m.name, m]));
      expect(byName.Pet?.fields[0]?.type, label).toEqual({ kind: 'model', name: 'PetOwner2' });
      expect(byName.Pet?.fields[0]?.deprecated, label).toBe(true);
      expect(opsOf(kept.spec).createNote?.requestBody, label).toEqual({ kind: 'model', name: 'CreateNoteRequest2' });
      expect([byName.PetOwner2?.deprecated, byName.CreateNoteRequest2?.deprecated], label).toEqual([true, true]);
      expect([limitOf(kept.spec, 'PetOwner'), limitOf(kept.spec, 'PetOwner2')], label).toEqual([component, copy]);
      expect([limitOf(kept.spec, 'CreateNoteRequest'), limitOf(kept.spec, 'CreateNoteRequest2')], label).toEqual([
        component,
        copy,
      ]);
      expect(kept.warnings, label).toEqual([
        '[oagen] Renamed inline model "PetOwner" → "PetOwner2": it is deprecated while "PetOwner" is live',
        '[oagen] Renamed inline model "CreateNoteRequest" → "CreateNoteRequest2": it is deprecated while "CreateNoteRequest" is live',
      ]);
      // The body's own schema wrote the flag, so its reference is the document's own.
      expectSound(kept.spec, ['Pet', 'PetOwner', 'CreateNoteRequest'], ['createNote.requestBody → CreateNoteRequest2']);
    }
    const siteFolds = await parse('site-model-limit-same', siteDoc(2, 2));
    expect(siteFolds.spec.models.find((m) => m.name === 'Pet')?.fields[0]?.type).toEqual({
      kind: 'model',
      name: 'PetOwner',
    });
    expect(opsOf(siteFolds.spec).createNote?.requestBody).toEqual({ kind: 'model', name: 'CreateNoteRequest' });
    expect(siteFolds.spec.models.map((m) => m.name).sort()).toEqual(['CreateNoteRequest', 'Pet', 'PetOwner']);
    expect(siteFolds.warnings).toEqual([folded('PetOwner'), folded('CreateNoteRequest')]);
    expectSound(siteFolds.spec, ['Pet', 'PetOwner', 'CreateNoteRequest']);

    // The predicate itself: a model's own properties beside the flag must be identical, in either direction.
    const model = (extra: Partial<Model> = {}): Model => ({
      name: 'M',
      fields: [{ name: 'a', type: { kind: 'primitive', type: 'string' }, required: false }],
      ...extra,
    });
    const strict = model({ constraints: { minProperties: 2 } });
    const loose = model({ constraints: { minProperties: 1 }, deprecated: true });
    expect(modelPropertiesAdmit(strict, loose)).toBe(false);
    expect(modelPropertiesAdmit(loose, strict)).toBe(false);
    expect(modelPropertiesAdmit(strict, model({ constraints: { minProperties: 2 }, deprecated: true }))).toBe(true);
    expect(modelPropertiesKey(strict)).not.toBe(modelPropertiesKey(loose));
    expect(modelPropertiesKey(strict)).toBe(modelPropertiesKey(model({ constraints: { minProperties: 2 } })));
    for (const sent of [false, true]) {
      expect(modelShares(strict, loose, sent), `sent: ${sent}`).toBe(false);
      expect(
        modelShares(strict, model({ constraints: { minProperties: 2 }, deprecated: true }), sent),
        `sent: ${sent}`,
      ).toBe(true);
    }
  });

  it('a list envelope’s companion whose field limit differs keeps its name beside a live component (Greptile, #364 round 2)', async () => {
    // The reviewer's case: a live `ListMetadata` whose `before` allows 8
    // characters, a deprecated `list_metadata` whose `before` allows 64. The
    // component's fields are what every site reads after a fold, so the
    // companion keeps its name and its own limit; with the same limit it
    // folds, the envelope field keeping the flag.
    const listMetadata = (maxLength: number, extra: Record<string, unknown> = {}) =>
      obj({ before: { type: ['string', 'null'], maxLength }, after: { type: ['string', 'null'] } }, extra);
    const doc = (component: Record<string, unknown>, companion: Record<string, unknown>) =>
      specDoc(
        { User: obj({ id: str }), ListMetadata: component },
        {
          '/legacy-users': {
            get: {
              operationId: 'listLegacyUsers',
              parameters: [{ name: 'after', in: 'query', schema: str }],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        allOf: [
                          obj({ object: { type: 'string', const: 'list' }, list_metadata: companion }),
                          obj({ data: { type: 'array', items: { $ref: '#/components/schemas/User' } } }),
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      );
    const metaOf = (spec: ApiSpec) =>
      opsOf(spec).listLegacyUsers?.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata');
    const limitOf = (spec: ApiSpec, name: string) =>
      spec.models.find((m) => m.name === name)?.fields.find((f) => f.name === 'before')?.constraints?.maxLength;

    const kept = await parse('companion-limit-kept', doc(listMetadata(8), listMetadata(64, { deprecated: true })));
    expect(metaOf(kept.spec)?.type).toEqual({ kind: 'model', name: 'ListLegacyUsersListMetadata' });
    expect(metaOf(kept.spec)?.deprecated).toBe(true);
    expect(limitOf(kept.spec, 'ListLegacyUsersListMetadata')).toBe(64);
    expect(limitOf(kept.spec, 'ListMetadata')).toBe(8);
    expect(kept.warnings).toEqual([]);
    expectSound(kept.spec, ['User', 'ListMetadata']);

    const folds = await parse('companion-limit-folds', doc(listMetadata(8), listMetadata(8, { deprecated: true })));
    expect(metaOf(folds.spec)?.type).toEqual({ kind: 'model', name: 'ListMetadata' });
    expect(metaOf(folds.spec)?.deprecated).toBe(true);
    expect(limitOf(folds.spec, 'ListMetadata')).toBe(8);
    expect(folds.spec.models.map((m) => m.name).sort()).toEqual(['ListMetadata', 'User']);
    expect(folds.warnings).toEqual([folded('ListMetadata')]);
    expectSound(folds.spec, ['User', 'ListMetadata']);
  });

  it('a field’s own flag must agree in either direction at every site `modelAdmits` decides (`fieldFlagAgrees`)', async () => {
    const string = { kind: 'primitive', type: 'string' } as const;
    const field = (deprecated: boolean): Field => ({
      name: 'a',
      type: string,
      required: false,
      ...(deprecated ? { deprecated: true } : {}),
    });
    expect(fieldFlagAgrees(field(false), field(false))).toBe(true);
    expect(fieldFlagAgrees(field(true), field(true))).toBe(true);
    expect(fieldFlagAgrees(field(false), field(true))).toBe(false);
    expect(fieldFlagAgrees(field(true), field(false))).toBe(false);
    expect(fieldAdmits(field(false), field(true))).toBe(false);
    expect(fieldAdmits(field(true), field(false))).toBe(false);
    expect(fieldAdmits(field(true), field(true))).toBe(true);
    const model = (deprecated: boolean, extra: Partial<Model> = {}): Model => ({
      name: 'M',
      fields: [field(deprecated)],
      ...extra,
    });
    // A live owner whose field is live never admits a candidate whose field is deprecated, whatever the roots.
    expect(modelAdmits(model(false), model(true))).toBe(false);
    expect(modelAdmits(model(false), model(true, { deprecated: true }))).toBe(false);
    expect(modelAdmits(model(true), model(false))).toBe(false);
    expect(modelAdmits(model(true), model(true, { deprecated: true }))).toBe(true);
    for (const sent of [false, true]) {
      expect(modelShares(model(false), model(true, { deprecated: true }), sent), `sent: ${sent}`).toBe(false);
      expect(modelShares(model(true), model(true, { deprecated: true }), sent), `sent: ${sent}`).toBe(true);
    }

    // Through the parser: a deprecated `Pet.owner` whose `name` is deprecated
    // too keeps `PetOwner2` beside a live `PetOwner` whose `name` is live;
    // with `PetOwner.name` deprecated as well it folds.
    const owner = (nameDeprecated: boolean, extra: Record<string, unknown> = {}) =>
      obj({ name: { type: 'string', ...(nameDeprecated ? { deprecated: true } : {}) } }, extra);
    const kept = await parse(
      'field-flag-kept',
      specDoc(
        { Pet: obj({ owner: owner(true, { deprecated: true }) }), PetOwner: owner(false) },
        { '/pets/{id}': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
      ),
    );
    expect(describeModels(kept.spec)).toEqual([
      'Pet {owner (deprecated): PetOwner2}',
      'PetOwner {name: string}',
      'PetOwner2 (deprecated) {name (deprecated): string}',
    ]);
    expect(kept.warnings).toEqual([
      '[oagen] Renamed inline model "PetOwner" → "PetOwner2": it is deprecated while "PetOwner" is live',
    ]);
    expectSound(kept.spec, ['Pet', 'PetOwner']);
    const folds = await parse(
      'field-flag-folds',
      specDoc(
        { Pet: obj({ owner: owner(true, { deprecated: true }) }), PetOwner: owner(true) },
        { '/pets/{id}': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
      ),
    );
    expect(describeModels(folds.spec)).toEqual([
      'Pet {owner (deprecated): PetOwner}',
      'PetOwner {name (deprecated): string}',
    ]);
    expect(folds.warnings).toEqual([folded('PetOwner')]);
    expectSound(folds.spec, ['Pet', 'PetOwner']);
  });

  it('a nested object under an inline response, decided before its parent: the parent keeps the field’s flag', async () => {
    // The nested `owner` folds onto the live `WidgetOwner`; the response
    // model then differs from the component `Widget` in the field's own
    // flag, which is part of a field's shape, so it keeps a qualified model
    // whose `owner` is deprecated and resolves to the component. Nothing is
    // orphaned (cf. #313).
    const ownerShape = obj({ name: str });
    const schemas = {
      Widget: obj({ object: { type: 'string', const: 'widget' }, owner: { $ref: '#/components/schemas/WidgetOwner' } }),
      WidgetOwner: ownerShape,
    };
    const legacy = obj({ object: { type: 'string', const: 'widget' }, owner: { ...ownerShape, deprecated: true } });
    for (const { order, spec, warnings } of await parseBothOrders('nested', schemas, [
      ['/legacy-widgets/{id}', getOp('getLegacyWidget', legacy)],
      ['/widgets/{id}', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
    ])) {
      const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
      expect(Object.keys(byName).sort(), order).toEqual(['GetLegacyWidgetWidget', 'Widget', 'WidgetOwner']);
      expect(opsOf(spec).getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
      const ownerField = byName.GetLegacyWidgetWidget?.fields.find((f) => f.name === 'owner');
      expect(ownerField?.type, order).toEqual({ kind: 'model', name: 'WidgetOwner' });
      expect(ownerField?.deprecated, order).toBe(true);
      expect(byName.GetLegacyWidgetWidget?.deprecated, order).toBeUndefined();
      expect(byName.WidgetOwner?.deprecated, order).toBeUndefined();
      expect(warnings, order).toEqual([
        folded('WidgetOwner'),
        '[oagen] Renamed inline model "Widget" → "GetLegacyWidgetWidget": its shape differs from component schema "Widget"',
      ]);
      expectSound(spec, ['Widget', 'WidgetOwner']);
    }
  });
});

describe('the `<Name>Json` fold reads a collapsing child’s flag the same way', () => {
  const string = { kind: 'primitive', type: 'string' } as const;
  const models = (childDeprecated: boolean, holderDeprecated: boolean): Model[] => [
    { name: 'Pet', fields: [{ name: 'a', type: string, required: false }] },
    {
      name: 'PetJson',
      fields: [
        { name: 'a', type: string, required: false },
        { name: 'thing', type: { kind: 'model', name: 'PetJsonThing' }, required: false },
      ],
    },
    {
      name: 'PetJsonThing',
      fields: [{ name: 'x', type: string, required: false }],
      ...(childDeprecated ? { deprecated: true } : {}),
    },
    {
      name: 'PetThing',
      fields: [{ name: 'x', type: string, required: false }],
      ...(holderDeprecated ? { deprecated: true } : {}),
    },
  ];
  const names = (folded: Model[]) => folded.map((m) => `${m.name}${m.deprecated ? ' (deprecated)' : ''}`).sort();

  it('collapses a deprecated `PetJsonThing` onto a live `PetThing` with its parent, and refuses the reverse', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const folded = collapseJsonSuffixModels(models(true, false), []);
      expect(names(folded)).toEqual(['Pet', 'PetThing']);
      expect(folded.find((m) => m.name === 'Pet')?.fields.map((f) => [f.name, refName(f.type)])).toEqual([
        ['a', undefined],
        ['thing', 'PetThing'],
      ]);

      warn.mockClear();
      const refused = collapseJsonSuffixModels(models(false, true), []);
      expect(names(refused)).toEqual(['Pet', 'PetJson', 'PetJsonThing', 'PetThing (deprecated)']);
      expect(warn.mock.calls.map(([m]) => String(m))).toEqual([
        '[oagen] Warning: Json-suffix model "PetJson" does not preserve the shape of "Pet": "PetJsonThing" would fold onto "PetThing", which has a different shape — keeping both',
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the reverse direction is unchanged (issue #260): a live copy never folds onto a deprecated component', () => {
  const string = { kind: 'primitive', type: 'string' } as const;
  const model = (extra: Partial<Model> = {}): Model => ({
    name: 'M',
    fields: [{ name: 'a', type: string, required: false }],
    ...extra,
  });
  const live = model();
  const deprecated = model({ deprecated: true });

  it('`flagAdmits`: a live owner admits either flag, a deprecated owner only a deprecated candidate', () => {
    expect(flagAdmits(live, live)).toBe(true);
    expect(flagAdmits(live, deprecated)).toBe(true);
    expect(flagAdmits(deprecated, deprecated)).toBe(true);
    expect(flagAdmits(deprecated, live)).toBe(false);
  });

  it('`modelShares` reads the flag by `ownerFlagAdmits` for a received shape and a sent one alike', () => {
    for (const sent of [false, true]) {
      expect(modelShares(live, deprecated, sent), `sent: ${sent}`).toBe(true);
      expect(modelShares(deprecated, live, sent), `sent: ${sent}`).toBe(false);
      // Issue #441: a deprecated component shares its name with no copy,
      // deprecated or not; a model a component's field minted still shares
      // it with a deprecated one.
      expect(modelShares(deprecated, deprecated, sent), `sent: ${sent}`).toBe(false);
      expect(modelShares(deprecated, deprecated, sent, true), `sent: ${sent}, field-minted`).toBe(true);
      expect(modelShares(deprecated, live, sent, true), `sent: ${sent}, field-minted`).toBe(false);
    }
    // A sent shape is shared on an identical shape only; a received one when admitted.
    const required = model({ deprecated: true, fields: [{ name: 'a', type: string, required: true }] });
    expect(modelShares(live, required, false)).toBe(true);
    expect(modelShares(live, required, true)).toBe(false);
    expect(modelAdmits(live, required)).toBe(true);
  });

  it('`shapeFingerprint` is `modelFingerprint` without the flag', () => {
    expect(modelFingerprint(live)).not.toBe(modelFingerprint(deprecated));
    expect(shapeFingerprint(live)).toBe(shapeFingerprint(deprecated));
    expect(shapeFingerprint(live)).toBe(modelFingerprint(live));
  });

  it('a live `Pet.owner`, body and response beside a deprecated component each keep a model of their own', async () => {
    const owner = obj({ name: str });
    const title = obj({ title: str });
    const widget = obj({ object: { type: 'string', const: 'widget' }, k: str });
    const { spec, warnings } = await parse(
      'reverse',
      specDoc(
        {
          Pet: obj({ owner }),
          PetOwner: { ...owner, deprecated: true },
          CreateNoteRequest: { ...title, deprecated: true },
          Widget: { ...widget, deprecated: true },
        },
        {
          '/pets/{id}': getOp('getPet', { $ref: '#/components/schemas/Pet' }),
          '/notes': postOp('createNote', title),
          '/legacy-widgets/{id}': getOp('getLegacyWidget', widget),
          '/widgets/{id}': getOp('getWidget', { $ref: '#/components/schemas/Widget' }),
        },
      ),
    );
    const ops = opsOf(spec);
    expect(spec.models.find((m) => m.name === 'Pet')?.fields[0]?.type).toEqual({ kind: 'model', name: 'PetOwner2' });
    expect(ops.createNote?.requestBody).toEqual({ kind: 'model', name: 'CreateNoteRequest2' });
    expect(ops.getLegacyWidget?.response).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
    expect(
      spec.models
        .filter((m) => m.deprecated)
        .map((m) => m.name)
        .sort(),
    ).toEqual(['CreateNoteRequest', 'PetOwner', 'Widget']);
    expect(warnings).toEqual([
      '[oagen] Renamed inline model "PetOwner" → "PetOwner2": it is live while "PetOwner" is deprecated',
      '[oagen] Renamed inline model "CreateNoteRequest" → "CreateNoteRequest2": it is live while "CreateNoteRequest" is deprecated',
      '[oagen] Renamed inline model "Widget" → "GetLegacyWidgetWidget": it is live while "Widget" is deprecated',
    ]);
    expectSound(spec, ['Pet', 'PetOwner', 'CreateNoteRequest', 'Widget'], ['getWidget.response → Widget']);
  });
});

describe('a deprecated copy beside a looser live component (issue #400’s comment)', () => {
  const owner = obj({ name: str }, { required: ['name'], deprecated: true });
  const looser = obj({ name: str });
  const petRef = { $ref: '#/components/schemas/Pet' };
  const looserFold = (name: string, how: string): string =>
    `[oagen] Warning: Inline model "${name}" is declared both deprecated and live, with a looser live definition that ${how} — keeping the live definition under the shared name`;
  const requiredOf = (spec: ApiSpec, model: string): string[] =>
    spec.models
      .find((m) => m.name === model)!
      .fields.filter((f) => f.required)
      .map((f) => f.name);

  it('`sent-deprecated.json`: `Pet`, only sent, keeps its deprecated owner’s own model, as before #364', async () => {
    const { spec, warnings } = await parse(
      'sent-deprecated',
      specDoc({ Pet: obj({ owner }), PetOwner: looser }, { '/pets': postOp('createPet', petRef) }),
    );
    expect(describeModels(spec)).toEqual([
      'Pet {owner (deprecated): PetOwner2}',
      'PetOwner {name: string}',
      'PetOwner2 (deprecated) {name: string}',
    ]);
    expect(requiredOf(spec, 'PetOwner2')).toEqual(['name']);
    expect(warnings).toEqual([
      '[oagen] Renamed inline model "PetOwner" → "PetOwner2": it is deprecated while "PetOwner" is live',
    ]);
    expectSound(spec, ['Pet', 'PetOwner']);
  });

  it('`returned-deprecated.json`: `Pet`, returned, keeps the fold, the warning naming what `PetOwner` does not require', async () => {
    const { spec, warnings } = await parse(
      'returned-deprecated',
      specDoc({ Pet: obj({ owner }), PetOwner: looser }, { '/pets': getOp('getPet', petRef) }),
    );
    expect(describeModels(spec)).toEqual(['Pet {owner (deprecated): PetOwner}', 'PetOwner {name: string}']);
    expect(warnings).toEqual([looserFold('PetOwner', 'does not require "name"')]);
    expectSound(spec, ['Pet', 'PetOwner']);
  });

  it('the shape registry: a deprecated header schema beside a looser `PetsXOwner`, a field’s null named too', async () => {
    const header = obj({ name: str, id: str }, { required: ['name'], deprecated: true });
    const doc = specDoc(
      { PetsXOwner: obj({ name: str, id: { type: ['string', 'null'] } }) },
      {
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: {
              '200': {
                description: 'ok',
                headers: { 'X-Owner': { schema: header } },
                content: { 'application/json': { schema: str } },
              },
            },
          },
        },
      },
    );
    const { spec, warnings } = await parse('header-looser', doc);
    expect(collectResponseHeaders(opsOf(spec).listPets!).map((h) => [h.name, h.type, h.deprecated])).toEqual([
      ['X-Owner', { kind: 'model', name: 'PetsXOwner' }, true],
    ]);
    expect(warnings).toEqual([looserFold('PetsXOwner', 'does not require "name" and allows null in "id"')]);
    expectSound(spec, ['PetsXOwner']);
  });

  it('the list-envelope pass: a deprecated companion beside a looser `ListMetadata`, a nested model’s looseness named by its field', async () => {
    const doc = (cursor: Record<string, unknown>) =>
      specDoc(
        {
          ListMetadata: obj({ after: str, cursor: { $ref: '#/components/schemas/Cursor' } }),
          Cursor: obj({ id: str }),
        },
        {
          '/pets': getOp(
            'listPets',
            obj({
              data: { type: 'array', items: str },
              list_metadata: obj({ after: str, cursor }, { required: ['after'], deprecated: true }),
            }),
            { parameters: [{ name: 'after', in: 'query', schema: str }] },
          ),
        },
      );
    for (const [cursor, how] of [
      [obj({ id: str }, { required: ['id'] }), 'does not require "after" and loosens "cursor"'],
      [obj({ id: str }), 'does not require "after"'],
      // The component itself, as the live definition references it: nothing looser there.
      [{ $ref: '#/components/schemas/Cursor' }, 'does not require "after"'],
    ] as const) {
      const { spec, warnings } = await parse(`envelope-looser-${JSON.stringify(cursor).length}`, doc(cursor));
      const envelope = opsOf(spec).listPets?.pagination?.envelopeFields ?? [];
      expect(envelope.map((f) => [f.name, f.type, f.deprecated])).toEqual([
        ['list_metadata', { kind: 'model', name: 'ListMetadata' }, true],
      ]);
      expect(describeModels(spec)).toEqual(['ListMetadata {after: string, cursor: Cursor}', 'Cursor {id: string}']);
      expect(warnings).toEqual([looserFold('ListMetadata', how)]);
      expectSound(spec, ['ListMetadata', 'Cursor']);
    }
  });

  it('a copy identical but for the flag still folds with “the same shape”, whether the component is sent or returned', async () => {
    const same = obj({ name: str }, { deprecated: true });
    const returned = await parse(
      'returned-same',
      specDoc({ Pet: obj({ owner: same }), PetOwner: looser }, { '/pets': getOp('getPet', petRef) }),
    );
    expect(returned.warnings).toEqual([folded('PetOwner')]);
    // Sent, an identical copy still folds: only a looser component is refused.
    const sent = await parse(
      'sent-same',
      specDoc({ Pet: obj({ owner: same }), PetOwner: looser }, { '/pets': postOp('createPet', petRef) }),
    );
    expect(describeModels(sent.spec)).toEqual(['Pet {owner (deprecated): PetOwner}', 'PetOwner {name: string}']);
    expect(sent.warnings).toEqual([folded('PetOwner')]);
  });

  it('`looserFields` names, in the copy’s field order, the fields the owner leaves optional, then those it makes nullable', () => {
    const string = { kind: 'primitive', type: 'string' } as const;
    const field = (name: string, required: boolean, nullable = false): Field => ({
      name,
      type: nullable ? { kind: 'nullable', inner: string } : string,
      required,
    });
    const owner: Model = { name: 'M', fields: [field('b', false, true), field('a', false), field('c', true, true)] };
    const copy: Model = {
      name: 'M',
      deprecated: true,
      fields: [field('a', true), field('b', true), field('c', true)],
    };
    expect(modelAdmits(owner, copy)).toBe(true);
    expect(looserFields(owner, copy)).toEqual(['does not require "a", "b"', 'allows null in "b", "c"']);
    expect(looserFields(owner, { ...owner, deprecated: true })).toEqual([]);
    expect(deprecatedFoldWarning('M', [])).toBe(folded('M'));
    expect(deprecatedFoldWarning('M', looserFields(owner, copy))).toBe(
      looserFold('M', 'does not require "a", "b" and allows null in "b", "c"'),
    );
  });
});

describe('#441: a deprecated component admits no inline copy, so deprecating the copy is a flag flip', () => {
  const widget = obj({ object: { type: 'string', const: 'widget' }, name: str });
  const title = obj({ title: str });
  const owner = obj({ name: str });
  const refused = (name: string, to: string): string =>
    `[oagen] Renamed inline model "${name}" → "${to}": "${name}" is deprecated and admits no copy`;
  const liveWhile = (name: string, to: string): string =>
    `[oagen] Renamed inline model "${name}" → "${to}": it is live while "${name}" is deprecated`;
  /** The diff's `deprecated-changed` entries, one `node name: direction` each, with every other behavior change by kind. */
  const flips = (oldSpec: ApiSpec, newSpec: ApiSpec): string[] =>
    diffSpecs(oldSpec, newSpec).behaviorChanges.map((b) => {
      if (b.kind !== 'deprecated-changed') return b.kind;
      const node = b as unknown as Record<string, unknown>;
      const name = node.modelName ?? node.operationName ?? node.enumName ?? node.name;
      const nested = node.fieldName ?? node.paramName ?? node.headerName ?? node.valueName;
      return `${b.node} ${name}${nested ? `.${nested}` : ''}: ${b.oldDeprecated ? 'deprecated → live' : 'live → deprecated'}`;
    });
  /** The models the diff adds or removes, and the breaking count, in both directions: a flag flip changes neither. */
  const movedModels = (a: ApiSpec, b: ApiSpec) =>
    [describeDiff(a, b), describeDiff(b, a)].map(({ breaking, changes }) => ({
      breaking,
      models: changes.filter((c) => c.startsWith('model-added') || c.startsWith('model-removed')),
    }));

  describe.each(['3.0.3', '3.1.0'])('the issue’s repro and the body and field sites, on OpenAPI %s', (openapi) => {
    const extra = { openapi };
    const flip = `model-modified GetLegacyWidgetWidget deprecatedChanged: additive`;

    it('response: the copy keeps `GetLegacyWidgetWidget` under either flag, and the diff is the model’s flip alone, in either order and direction', async () => {
      const schemas = { Widget: { ...widget, deprecated: true } };
      const paths = (deprecated: boolean): Array<[string, unknown]> => [
        ['/widget', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
        ['/legacy-widget', getOp('getLegacyWidget', deprecate(widget, deprecated))],
      ];
      const before = await parseBothOrders(`441-response-old-${openapi}`, schemas, paths(false), extra);
      const after = await parseBothOrders(`441-response-new-${openapi}`, schemas, paths(true), extra);
      for (const [i, { order, spec, warnings }] of after.entries()) {
        const { spec: old, warnings: oldWarnings } = before[i]!;
        expect(describeModels(old), order).toEqual([
          'Widget (deprecated) {object: literal, name: string}',
          'GetLegacyWidgetWidget {object: literal, name: string}',
        ]);
        expect(oldWarnings, order).toEqual([liveWhile('Widget', 'GetLegacyWidgetWidget')]);
        expect(describeModels(spec), order).toEqual([
          'Widget (deprecated) {object: literal, name: string}',
          'GetLegacyWidgetWidget (deprecated) {object: literal, name: string}',
        ]);
        expect(warnings, order).toEqual([refused('Widget', 'GetLegacyWidgetWidget')]);
        for (const s of [old, spec]) {
          expect(opsOf(s).getWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
          expect(opsOf(s).getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
        }
        // `getWidget` `$ref`s the deprecated component, and the legacy
        // response wrote `deprecated: true` itself: both are the document's own.
        expectSound(old, ['Widget'], ['getWidget.response → Widget']);
        expectSound(
          spec,
          ['Widget'],
          ['getWidget.response → Widget', 'getLegacyWidget.response → GetLegacyWidgetWidget'],
        );
        expect(describeDiff(old, spec), order).toEqual({ breaking: 0, changes: [flip] });
        expect(describeDiff(spec, old), order).toEqual({ breaking: 0, changes: [flip] });
        expect(diffSpecs(old, spec).behaviorChanges, order).toEqual([
          {
            kind: 'deprecated-changed',
            node: 'model',
            modelName: 'GetLegacyWidgetWidget',
            oldDeprecated: false,
            newDeprecated: true,
            classification: 'additive',
          },
        ]);
        expect(flips(spec, old), order).toEqual(['model GetLegacyWidgetWidget: deprecated → live']);
      }
    });

    it('body: the `createNote` body keeps `CreateNoteRequest2` under either flag beside the deprecated `CreateNoteRequest`', async () => {
      const schemas = { CreateNoteRequest: { ...title, deprecated: true } };
      const putNote = {
        put: {
          operationId: 'putNote',
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateNoteRequest' } } },
          },
          responses: { '200': { description: 'OK' } },
        },
      };
      const paths = (deprecated: boolean): Array<[string, unknown]> => [
        ['/legacy-notes', postOp('createNote', deprecate(title, deprecated))],
        ['/notes', putNote],
      ];
      const before = await parseBothOrders(`441-body-old-${openapi}`, schemas, paths(false), extra);
      const after = await parseBothOrders(`441-body-new-${openapi}`, schemas, paths(true), extra);
      for (const [i, { order, spec, warnings }] of after.entries()) {
        const { spec: old, warnings: oldWarnings } = before[i]!;
        expect(describeModels(old), order).toEqual([
          'CreateNoteRequest (deprecated) {title: string}',
          'CreateNoteRequest2 {title: string}',
        ]);
        expect(oldWarnings, order).toEqual([liveWhile('CreateNoteRequest', 'CreateNoteRequest2')]);
        expect(describeModels(spec), order).toEqual([
          'CreateNoteRequest (deprecated) {title: string}',
          'CreateNoteRequest2 (deprecated) {title: string}',
        ]);
        expect(warnings, order).toEqual([refused('CreateNoteRequest', 'CreateNoteRequest2')]);
        for (const s of [old, spec]) {
          expect(opsOf(s).createNote?.requestBody, order).toEqual({ kind: 'model', name: 'CreateNoteRequest2' });
          expect(opsOf(s).putNote?.requestBody, order).toEqual({ kind: 'model', name: 'CreateNoteRequest' });
        }
        expectSound(old, ['CreateNoteRequest'], ['putNote.requestBody → CreateNoteRequest']);
        expectSound(
          spec,
          ['CreateNoteRequest'],
          ['putNote.requestBody → CreateNoteRequest', 'createNote.requestBody → CreateNoteRequest2'],
        );
        const change = 'model-modified CreateNoteRequest2 deprecatedChanged: additive';
        expect(describeDiff(old, spec), order).toEqual({ breaking: 0, changes: [change] });
        expect(describeDiff(spec, old), order).toEqual({ breaking: 0, changes: [change] });
        expect(flips(old, spec), order).toEqual(['model CreateNoteRequest2: live → deprecated']);
      }
    });

    it('field: `Pet.owner` keeps `PetOwner2` under either flag beside the deprecated `PetOwner`, the field keeping its own flag', async () => {
      const doc = (deprecated: boolean) =>
        specDoc(
          { Pet: obj({ owner: deprecate(owner, deprecated) }), PetOwner: { ...owner, deprecated: true } },
          { '/pets/{id}': getOp('getPet', { $ref: '#/components/schemas/Pet' }) },
          extra,
        );
      const before = await parse(`441-field-old-${openapi}`, doc(false));
      const after = await parse(`441-field-new-${openapi}`, doc(true));
      expect(describeModels(before.spec)).toEqual([
        'Pet {owner: PetOwner2}',
        'PetOwner (deprecated) {name: string}',
        'PetOwner2 {name: string}',
      ]);
      expect(before.warnings).toEqual([liveWhile('PetOwner', 'PetOwner2')]);
      expect(describeModels(after.spec)).toEqual([
        'Pet {owner (deprecated): PetOwner2}',
        'PetOwner (deprecated) {name: string}',
        'PetOwner2 (deprecated) {name: string}',
      ]);
      expect(after.warnings).toEqual([refused('PetOwner', 'PetOwner2')]);
      expectSound(before.spec, ['Pet', 'PetOwner']);
      expectSound(after.spec, ['Pet', 'PetOwner']);
      const changes = [
        'model-modified Pet: additive',
        'field-deprecated-changed owner: additive',
        'model-modified PetOwner2 deprecatedChanged: additive',
      ];
      expect(describeDiff(before.spec, after.spec)).toEqual({ breaking: 0, changes });
      expect(describeDiff(after.spec, before.spec)).toEqual({ breaking: 0, changes });
      expect(flips(before.spec, after.spec)).toEqual([
        'field Pet.owner: live → deprecated',
        'model PetOwner2: live → deprecated',
      ]);
    });
  });

  it('a copy deprecated from the start is a second deprecated model beside the component, and two such copies share it', async () => {
    const schemas = { Widget: { ...widget, deprecated: true } };
    for (const { order, spec, warnings } of await parseBothOrders('441-both', schemas, [
      ['/widget', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
      ['/legacy-widget', getOp('getLegacyWidget', { ...widget, deprecated: true })],
    ])) {
      expect(describeModels(spec), order).toEqual([
        'Widget (deprecated) {object: literal, name: string}',
        'GetLegacyWidgetWidget (deprecated) {object: literal, name: string}',
      ]);
      expect(warnings, order).toEqual([refused('Widget', 'GetLegacyWidgetWidget')]);
      expectSound(
        spec,
        ['Widget'],
        ['getWidget.response → Widget', 'getLegacyWidget.response → GetLegacyWidgetWidget'],
      );
    }
    // Two operations each carrying a deprecated identical copy share one
    // model under the first site's qualified name, as identical copies do
    // whatever moves them off a component's name.
    for (const { order, spec, warnings } of await parseBothOrders('441-two', schemas, [
      ['/legacy-widget', getOp('getLegacyWidget', { ...widget, deprecated: true })],
      ['/old-widget', getOp('getOldWidget', { ...widget, deprecated: true })],
      ['/widget', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
    ])) {
      const first = order === 'as-written' ? 'GetLegacyWidgetWidget' : 'GetOldWidgetWidget';
      expect(describeModels(spec), order).toEqual([
        'Widget (deprecated) {object: literal, name: string}',
        `${first} (deprecated) {object: literal, name: string}`,
      ]);
      expect(opsOf(spec).getLegacyWidget?.response, order).toEqual({ kind: 'model', name: first });
      expect(opsOf(spec).getOldWidget?.response, order).toEqual({ kind: 'model', name: first });
      expect(warnings, order).toEqual([`${refused('Widget', first)} (shared by 2 sites)`]);
      expectSound(
        spec,
        ['Widget'],
        ['getWidget.response → Widget', `getLegacyWidget.response → ${first}`, `getOldWidget.response → ${first}`],
      );
    }
  });

  it('a live component still takes a deprecated copy, with the fold warning (issue #312, unchanged)', async () => {
    for (const { order, spec, warnings } of await parseBothOrders('441-live-component', { Widget: widget }, [
      ['/widget', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
      ['/legacy-widget', getOp('getLegacyWidget', { ...widget, deprecated: true })],
    ])) {
      expect(describeModels(spec), order).toEqual(['Widget {object: literal, name: string}']);
      expect(opsOf(spec).getLegacyWidget?.response, order).toEqual({ kind: 'model', name: 'Widget' });
      expect(warnings, order).toEqual([folded('Widget')]);
      expectSound(spec, ['Widget']);
    }
  });

  describe('every other site an inline copy of a deprecated component can sit at: the copy’s name is the same under either flag', () => {
    /** The one model the diff modifies for its flag, and nothing else: the copy's qualified model, the same on both sides. */
    const onlyFlip = (before: ApiSpec, after: ApiSpec, name: string, ...also: string[]): void => {
      expect(movedModels(before, after)).toEqual([
        { breaking: 0, models: [] },
        { breaking: 0, models: [] },
      ]);
      const flip = `model-modified ${name} deprecatedChanged: additive`;
      expect(describeDiff(before, after).changes).toEqual(expect.arrayContaining([flip, ...also]));
      expect(describeDiff(after, before).changes).toEqual(expect.arrayContaining([flip, ...also]));
      expect(before.models.find((m) => m.name === name)?.deprecated).toBeUndefined();
      expect(after.models.find((m) => m.name === name)?.deprecated).toBe(true);
    };

    it('a response header’s object and a parameter’s object (the shape registry), each keeping its own flag', async () => {
      const meta = obj({ etag: str });
      const filter = obj({ q: str });
      const doc = (deprecated: boolean) =>
        specDoc(
          { AccountXMeta: { ...meta, deprecated: true }, AccountFilter: { ...filter, deprecated: true } },
          {
            '/account': {
              get: {
                operationId: 'getAccount',
                tags: ['Account'],
                parameters: [
                  { name: 'filter', in: 'query', style: 'deepObject', schema: deprecate(filter, deprecated) },
                ],
                responses: {
                  '200': {
                    description: 'ok',
                    headers: { 'X-Meta': { schema: deprecate(meta, deprecated) } },
                    content: { 'application/json': { schema: str } },
                  },
                },
              },
            },
          },
        );
      const { spec: before, warnings: beforeWarnings } = await parse('441-registry-old', doc(false));
      const { spec: after, warnings: afterWarnings } = await parse('441-registry-new', doc(true));
      const headerOf = (spec: ApiSpec) => collectResponseHeaders(opsOf(spec).getAccount!)[0];
      const paramOf = (spec: ApiSpec) => opsOf(spec).getAccount?.queryParams[0];
      const headerModel = 'AccountGetAccountXMeta';
      const paramModel = 'AccountGetAccountFilter';
      for (const spec of [before, after]) {
        expect(refName(headerOf(spec)?.type)).toBe(headerModel);
        expect(refName(paramOf(spec)?.type)).toBe(paramModel);
      }
      expect(headerOf(after)?.deprecated).toBe(true);
      expect(paramOf(after)?.deprecated).toBe(true);
      expect(beforeWarnings).toEqual([]);
      expect(afterWarnings).toEqual([]);
      expectSound(before, ['AccountXMeta', 'AccountFilter']);
      // The header and the parameter carry the flag themselves, so neither
      // is a live site reaching a deprecated model.
      expectSound(after, ['AccountXMeta', 'AccountFilter']);
      onlyFlip(before, after, headerModel, `model-modified ${paramModel} deprecatedChanged: additive`);
    });

    it('an error body, a secondary request body and the items of an array response (the shape registry)', async () => {
      const message = obj({ message: str });
      const rows = obj({ rows: str });
      const item = obj({ id: str });
      const doc = (deprecated: boolean) =>
        specDoc(
          {
            ListUsersError404: { ...message, deprecated: true },
            CreateNoteTextCsvRequest: { ...rows, deprecated: true },
            ListUsersItem: { ...item, deprecated: true },
          },
          {
            '/users': {
              get: {
                operationId: 'listUsers',
                responses: {
                  '200': {
                    description: 'ok',
                    content: { 'application/json': { schema: { type: 'array', items: deprecate(item, deprecated) } } },
                  },
                  '404': {
                    description: 'nope',
                    content: { 'application/json': { schema: deprecate(message, deprecated) } },
                  },
                },
              },
            },
            '/notes': {
              post: {
                operationId: 'createNote',
                requestBody: {
                  content: {
                    'application/json': { schema: obj({ title: str }) },
                    'text/csv': { schema: deprecate(rows, deprecated) },
                  },
                },
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        );
      const { spec: before, warnings: beforeWarnings } = await parse('441-bodies-old', doc(false));
      const { spec: after, warnings: afterWarnings } = await parse('441-bodies-new', doc(true));
      const named = (spec: ApiSpec) => {
        const ops = opsOf(spec);
        const items = ops.listUsers?.response;
        return {
          error: refName(ops.listUsers?.errors[0]?.type),
          csv: refName(collectRequestBodyTypes(ops.createNote!)[0]?.type),
          items: items?.kind === 'array' ? refName(items.items) : undefined,
        };
      };
      const names = named(after);
      expect(named(before)).toEqual(names);
      expect(names.error).toBeDefined();
      expect(names.error).not.toBe('ListUsersError404');
      expect(names.csv).not.toBe('CreateNoteTextCsvRequest');
      expect(names.items).not.toBe('ListUsersItem');
      expect(beforeWarnings).toEqual([]);
      expect(afterWarnings).toEqual([]);
      const components = ['ListUsersError404', 'CreateNoteTextCsvRequest', 'ListUsersItem'];
      expectSound(before, components);
      expectSound(after, components, [
        `listUsers.404 → ${names.error}`,
        `createNote.requestBodyContents.text/csv → ${names.csv}`,
        `listUsers.response → ${names.items}`,
      ]);
      onlyFlip(
        before,
        after,
        names.error!,
        `model-modified ${names.csv} deprecatedChanged: additive`,
        `model-modified ${names.items} deprecatedChanged: additive`,
      );
    });

    it('a webhook payload’s titled variant (the merge passes)', async () => {
      const pet = obj({ object: { type: 'string', const: 'pet' }, name: str });
      const toy = obj({ object: { type: 'string', const: 'toy' }, name: str });
      const doc = (deprecated: boolean) =>
        specDoc(
          { Pet: { ...pet, deprecated: true } },
          {},
          {
            webhooks: {
              petAdopted: {
                post: {
                  requestBody: {
                    content: {
                      'application/json': {
                        schema: {
                          oneOf: [
                            { title: 'Pet', ...deprecate(pet, deprecated) },
                            { title: 'Toy', ...toy },
                          ],
                        },
                      },
                    },
                  },
                  responses: { '200': { description: 'ok' } },
                },
              },
            },
          },
        );
      const { spec: before, warnings: beforeWarnings } = await parse('441-webhook-old', doc(false));
      const { spec: after, warnings: afterWarnings } = await parse('441-webhook-new', doc(true));
      const variants = (spec: ApiSpec) => {
        const payload = spec.webhooks?.[0]?.requestBody;
        return payload?.kind === 'union' ? payload.variants.map(refName) : [];
      };
      const [variant] = variants(after);
      expect(variant).toBeDefined();
      expect(variant).not.toBe('Pet');
      expect(variants(before)).toEqual([variant, 'Toy']);
      expect(variants(after)).toEqual([variant, 'Toy']);
      expect(beforeWarnings).toEqual([liveWhile('Pet', variant!)]);
      expect(afterWarnings).toEqual([refused('Pet', variant!)]);
      expectSound(before, ['Pet']);
      expectSound(after, ['Pet'], [`webhook petAdopted → ${variant}`]);
      onlyFlip(before, after, variant!);
    });

    it('a component field’s array items and `oneOf` variant (the field pass)', async () => {
      const ownerShape = obj({ name: str });
      const circle = obj({ kind: { type: 'string', const: 'circle' }, r: str });
      const square = obj({ kind: { type: 'string', const: 'square' }, s: str });
      const doc = (deprecated: boolean) =>
        specDoc(
          {
            Pet: obj({ owners: { type: 'array', items: deprecate(ownerShape, deprecated) } }),
            PetOwner: { ...ownerShape, deprecated: true },
            Drawing: obj({
              shape: {
                oneOf: [
                  { title: 'Circle', ...deprecate(circle, deprecated) },
                  { title: 'Square', ...square },
                ],
              },
            }),
            Circle: { ...circle, deprecated: true },
          },
          {
            '/pets/{id}': getOp('getPet', { $ref: '#/components/schemas/Pet' }),
            '/drawings/{id}': getOp('getDrawing', { $ref: '#/components/schemas/Drawing' }),
          },
        );
      const { spec: before, warnings: beforeWarnings } = await parse('441-field-sites-old', doc(false));
      const { spec: after, warnings: afterWarnings } = await parse('441-field-sites-new', doc(true));
      const named = (spec: ApiSpec) => {
        const byName = Object.fromEntries(spec.models.map((m) => [m.name, m]));
        const owners = byName.Pet?.fields[0]?.type;
        const shape = byName.Drawing?.fields[0]?.type;
        return {
          items: owners?.kind === 'array' ? refName(owners.items) : undefined,
          variants: shape?.kind === 'union' ? shape.variants.map(refName) : [],
        };
      };
      const names = named(after);
      expect(named(before)).toEqual(names);
      expect(names.items).toBe('PetOwner2');
      expect(names.variants).toEqual(['DrawingCircle', 'Square']);
      expect(beforeWarnings).toEqual([liveWhile('PetOwner', 'PetOwner2'), liveWhile('Circle', 'DrawingCircle')]);
      expect(afterWarnings).toEqual([refused('PetOwner', 'PetOwner2'), refused('Circle', 'DrawingCircle')]);
      expectSound(before, ['Pet', 'PetOwner', 'Drawing', 'Circle']);
      expectSound(
        after,
        ['Pet', 'PetOwner', 'Drawing', 'Circle'],
        ['Pet.owners → PetOwner2', 'Drawing.shape → DrawingCircle'],
      );
      onlyFlip(before, after, 'PetOwner2', 'model-modified DrawingCircle deprecatedChanged: additive');
    });

    it('a list envelope’s companion (the envelope pass), the envelope field keeping its own flag', async () => {
      const listMetadata = obj({ before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } });
      const doc = (deprecated: boolean) =>
        specDoc(
          { User: obj({ id: str }), ListMetadata: { ...listMetadata, deprecated: true } },
          {
            '/legacy-users': {
              get: {
                operationId: 'listLegacyUsers',
                parameters: [{ name: 'after', in: 'query', schema: str }],
                responses: {
                  '200': {
                    description: 'ok',
                    content: {
                      'application/json': {
                        schema: {
                          allOf: [
                            obj({
                              object: { type: 'string', const: 'list' },
                              list_metadata: deprecate(listMetadata, deprecated),
                            }),
                            obj({ data: { type: 'array', items: { $ref: '#/components/schemas/User' } } }),
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        );
      const { spec: before, warnings: beforeWarnings } = await parse('441-companion-old', doc(false));
      const { spec: after, warnings: afterWarnings } = await parse('441-companion-new', doc(true));
      const metaOf = (spec: ApiSpec) =>
        opsOf(spec).listLegacyUsers?.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata');
      expect(metaOf(before)?.type).toEqual({ kind: 'model', name: 'ListLegacyUsersListMetadata' });
      expect(metaOf(after)?.type).toEqual({ kind: 'model', name: 'ListLegacyUsersListMetadata' });
      expect(metaOf(before)?.deprecated).toBeUndefined();
      expect(metaOf(after)?.deprecated).toBe(true);
      expect(beforeWarnings).toEqual([]);
      expect(afterWarnings).toEqual([]);
      expectSound(before, ['User', 'ListMetadata']);
      expectSound(after, ['User', 'ListMetadata']);
      onlyFlip(before, after, 'ListLegacyUsersListMetadata');
      expect(flips(before, after)).toEqual([
        'model ListLegacyUsersListMetadata: live → deprecated',
        'envelope-field listLegacyUsers.list_metadata: live → deprecated',
      ]);
    });
  });

  describe('a nested object inside the copy and the component, decided bottom-up', () => {
    const meta = obj({ k: str });
    const nested = (metaSchema: unknown, flag: boolean) =>
      obj(
        { object: { type: 'string', const: 'widget' }, name: str, meta: metaSchema },
        flag ? { deprecated: true } : {},
      );

    it('a nested deprecated component admits no copy either: the nested copy keeps its qualified name, and its flip is additive', async () => {
      const doc = (metaDeprecated: boolean) =>
        specDoc(
          {
            Widget: { ...nested({ $ref: '#/components/schemas/WidgetMeta' }, true) },
            WidgetMeta: { ...meta, deprecated: true },
          },
          {
            '/widget': getOp('getWidget', { $ref: '#/components/schemas/Widget' }),
            '/legacy-widget': getOp('getLegacyWidget', nested(deprecate(meta, metaDeprecated), false)),
          },
        );
      const before = await parse('441-nested-component-old', doc(false));
      const after = await parse('441-nested-component-new', doc(true));
      expect(describeModels(before.spec)).toEqual([
        'Widget (deprecated) {object: literal, name: string, meta: WidgetMeta}',
        'WidgetMeta (deprecated) {k: string}',
        'GetLegacyWidgetWidget {object: literal, name: string, meta: GetLegacyWidgetWidgetMeta}',
        'GetLegacyWidgetWidgetMeta {k: string}',
      ]);
      // The nested schema's flag deprecates the nested model and the field
      // that wrote it alike, as it does on a component's own field.
      expect(describeModels(after.spec)).toEqual([
        'Widget (deprecated) {object: literal, name: string, meta: WidgetMeta}',
        'WidgetMeta (deprecated) {k: string}',
        'GetLegacyWidgetWidget {object: literal, name: string, meta (deprecated): GetLegacyWidgetWidgetMeta}',
        'GetLegacyWidgetWidgetMeta (deprecated) {k: string}',
      ]);
      // The nested copy is decided first; the parent, live beside the
      // deprecated `Widget`, leaves the name by its flag either way.
      expect(before.warnings).toEqual([
        liveWhile('WidgetMeta', 'GetLegacyWidgetWidgetMeta'),
        liveWhile('Widget', 'GetLegacyWidgetWidget'),
      ]);
      expect(after.warnings).toEqual([
        refused('WidgetMeta', 'GetLegacyWidgetWidgetMeta'),
        liveWhile('Widget', 'GetLegacyWidgetWidget'),
      ]);
      expectSound(before.spec, ['Widget', 'WidgetMeta'], ['getWidget.response → Widget']);
      expectSound(after.spec, ['Widget', 'WidgetMeta'], ['getWidget.response → Widget']);
      const changes = [
        'model-modified GetLegacyWidgetWidget: additive',
        'field-deprecated-changed meta: additive',
        'model-modified GetLegacyWidgetWidgetMeta deprecatedChanged: additive',
      ];
      expect(describeDiff(before.spec, after.spec)).toEqual({ breaking: 0, changes });
      expect(describeDiff(after.spec, before.spec)).toEqual({ breaking: 0, changes });
    });

    it('a model the component’s field minted keeps today’s rule: a deprecated nested copy folds onto it, a live one is qualified', async () => {
      // `Widget.meta` is an inline object, so `WidgetMeta` is a model the
      // component's field minted, not a component schema: it still admits a
      // deprecated copy (the object the schema pass lifts from a field is
      // what the field extractor's own copy folds onto) and takes no live
      // one. The parent copy of the deprecated `Widget` is qualified either
      // way; what the nested flip changes is the nested model, as before
      // this issue.
      const doc = (metaDeprecated: boolean) =>
        specDoc(
          { Widget: nested({ ...meta, deprecated: true }, true) },
          {
            '/widget': getOp('getWidget', { $ref: '#/components/schemas/Widget' }),
            '/legacy-widget': getOp('getLegacyWidget', nested(deprecate(meta, metaDeprecated), false)),
          },
        );
      const live = await parse('441-nested-field-live', doc(false));
      const deprecated = await parse('441-nested-field-deprecated', doc(true));
      expect(describeModels(deprecated.spec)).toEqual([
        'Widget (deprecated) {object: literal, name: string, meta (deprecated): WidgetMeta}',
        'WidgetMeta (deprecated) {k: string}',
        'GetLegacyWidgetWidget {object: literal, name: string, meta (deprecated): WidgetMeta}',
      ]);
      expect(deprecated.warnings).toEqual([liveWhile('Widget', 'GetLegacyWidgetWidget')]);
      expectSound(deprecated.spec, ['Widget'], ['getWidget.response → Widget']);
      expect(describeModels(live.spec)).toEqual([
        'Widget (deprecated) {object: literal, name: string, meta (deprecated): WidgetMeta}',
        'WidgetMeta (deprecated) {k: string}',
        'GetLegacyWidgetWidget {object: literal, name: string, meta: GetLegacyWidgetWidgetMeta}',
        'GetLegacyWidgetWidgetMeta {k: string}',
      ]);
      expect(live.warnings).toEqual([
        liveWhile('WidgetMeta', 'GetLegacyWidgetWidgetMeta'),
        liveWhile('Widget', 'GetLegacyWidgetWidget'),
      ]);
      expectSound(live.spec, ['Widget'], ['getWidget.response → Widget']);
    });
  });

  describe('copies sharing a qualified name beside a deprecated component keep sharing it when one is deprecated (#625 review)', () => {
    const sharedBy = (warning: string, sites: number): string => `${warning} (shared by ${sites} sites)`;
    /** Every pair of the documents, diffed in both directions: the changes each way. */
    const pairs = (specs: Record<string, ApiSpec>): Record<string, ReturnType<typeof describeDiff>> => {
      const out: Record<string, ReturnType<typeof describeDiff>> = {};
      const labels = Object.keys(specs);
      for (const a of labels)
        for (const b of labels) if (a !== b) out[`${a}→${b}`] = describeDiff(specs[a]!, specs[b]!);
      return out;
    };
    const unchanged = { breaking: 0, changes: [] };

    describe.each(['3.0.3', '3.1.0'])(
      'two identical responses beside a deprecated `Widget`, on OpenAPI %s',
      (openapi) => {
        const schemas = { Widget: { ...widget, deprecated: true } };
        const paths = (legacy: boolean, old: boolean): Array<[string, unknown]> => [
          ['/legacy-widget', getOp('getLegacyWidget', deprecate(widget, legacy))],
          ['/old-widget', getOp('getOldWidget', deprecate(widget, old))],
          ['/widget', getOp('getWidget', { $ref: '#/components/schemas/Widget' })],
        ];

        it('one `GetLegacyWidgetWidget` under every flag combination, live unless both copies are deprecated, named by the first site in either order', async () => {
          const combos: Array<[string, boolean, boolean]> = [
            ['live', false, false],
            ['old', false, true],
            ['legacy', true, false],
            ['both', true, true],
          ];
          const byOrder: Record<string, Record<string, ApiSpec>> = {};
          for (const [label, legacy, old] of combos) {
            for (const { order, spec, warnings } of await parseBothOrders(
              `441-shared-${label}-${openapi}`,
              schemas,
              paths(legacy, old),
              { openapi },
            )) {
              const where = `${label}, ${order}`;
              const first = order === 'as-written' ? 'GetLegacyWidgetWidget' : 'GetOldWidgetWidget';
              const deprecated = legacy && old;
              expect(describeModels(spec), where).toEqual([
                'Widget (deprecated) {object: literal, name: string}',
                `${first}${deprecated ? ' (deprecated)' : ''} {object: literal, name: string}`,
              ]);
              expect(opsOf(spec).getLegacyWidget?.response, where).toEqual({ kind: 'model', name: first });
              expect(opsOf(spec).getOldWidget?.response, where).toEqual({ kind: 'model', name: first });
              // A mixed pair keeps the live definition: the deprecated copy
              // folds onto it with the warning a deprecated copy folding
              // onto its live twin gets, and the note names the live flag.
              expect(warnings, where).toEqual(
                deprecated
                  ? [sharedBy(refused('Widget', first), 2)]
                  : [...(legacy || old ? [folded('Widget')] : []), sharedBy(liveWhile('Widget', first), 2)],
              );
              expectSound(
                spec,
                ['Widget'],
                deprecated
                  ? [
                      'getWidget.response → Widget',
                      `getLegacyWidget.response → ${first}`,
                      `getOldWidget.response → ${first}`,
                    ]
                  : ['getWidget.response → Widget'],
              );
              (byOrder[order] ??= {})[label] = spec;
            }
          }
          // Flipping one copy's flag changes nothing a caller compiles
          // against — the response has no node of its own to carry the flag,
          // as between two inline twins — and flipping both is the model's
          // flip alone, additive in either direction.
          for (const [order, specs] of Object.entries(byOrder)) {
            const first = order === 'as-written' ? 'GetLegacyWidgetWidget' : 'GetOldWidgetWidget';
            const flip = { breaking: 0, changes: [`model-modified ${first} deprecatedChanged: additive`] };
            expect(pairs(specs), order).toEqual({
              'live→old': unchanged,
              'live→legacy': unchanged,
              'live→both': flip,
              'old→live': unchanged,
              'old→legacy': unchanged,
              'old→both': flip,
              'legacy→live': unchanged,
              'legacy→old': unchanged,
              'legacy→both': flip,
              'both→live': flip,
              'both→old': flip,
              'both→legacy': flip,
            });
          }
        });
      },
    );

    it('three identical responses, the middle one deprecated, share one live model, and deprecating it changes nothing', async () => {
      const schemas = { Widget: { ...widget, deprecated: true } };
      const paths = (middle: boolean) => ({
        '/widget': getOp('getWidget', { $ref: '#/components/schemas/Widget' }),
        '/a-widget': getOp('getAWidget', widget),
        '/b-widget': getOp('getBWidget', deprecate(widget, middle)),
        '/c-widget': getOp('getCWidget', widget),
      });
      const live = await parse('441-three-live', specDoc(schemas, paths(false)));
      const mixed = await parse('441-three-mixed', specDoc(schemas, paths(true)));
      for (const { spec } of [live, mixed]) {
        expect(describeModels(spec)).toEqual([
          'Widget (deprecated) {object: literal, name: string}',
          'GetAWidgetWidget {object: literal, name: string}',
        ]);
        for (const op of ['getAWidget', 'getBWidget', 'getCWidget']) {
          expect(opsOf(spec)[op]?.response, op).toEqual({ kind: 'model', name: 'GetAWidgetWidget' });
        }
        expectSound(spec, ['Widget'], ['getWidget.response → Widget']);
      }
      expect(live.warnings).toEqual([sharedBy(liveWhile('Widget', 'GetAWidgetWidget'), 3)]);
      expect(mixed.warnings).toEqual([folded('Widget'), sharedBy(liveWhile('Widget', 'GetAWidgetWidget'), 3)]);
      expect(describeDiff(live.spec, mixed.spec)).toEqual(unchanged);
      expect(describeDiff(mixed.spec, live.spec)).toEqual(unchanged);
    });

    it('body site: a body is named from its operation, so two bodies never share a model, and each flips on its own', async () => {
      const putNote = {
        put: {
          operationId: 'putNote',
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateNoteRequest' } } },
          },
          responses: { '200': { description: 'OK' } },
        },
      };
      const doc = (note: boolean, old: boolean) =>
        specDoc(
          { CreateNoteRequest: { ...title, deprecated: true } },
          {
            '/legacy-notes': postOp('createNote', deprecate(title, note)),
            '/old-notes': postOp('createOldNote', deprecate(title, old)),
            '/notes': putNote,
          },
        );
      const live = await parse('441-bodies-live', doc(false, false));
      const old = await parse('441-bodies-old', doc(false, true));
      const both = await parse('441-bodies-both', doc(true, true));
      for (const { spec } of [live, old, both]) {
        expect(opsOf(spec).createNote?.requestBody).toEqual({ kind: 'model', name: 'CreateNoteRequest2' });
        expect(opsOf(spec).createOldNote?.requestBody).toEqual({ kind: 'model', name: 'CreateOldNoteRequest' });
        expect(opsOf(spec).putNote?.requestBody).toEqual({ kind: 'model', name: 'CreateNoteRequest' });
      }
      expect(describeModels(old.spec)).toEqual([
        'CreateNoteRequest (deprecated) {title: string}',
        'CreateNoteRequest2 {title: string}',
        'CreateOldNoteRequest (deprecated) {title: string}',
      ]);
      expect(describeDiff(live.spec, old.spec)).toEqual({
        breaking: 0,
        changes: ['model-modified CreateOldNoteRequest deprecatedChanged: additive'],
      });
      expect(describeDiff(old.spec, both.spec)).toEqual({
        breaking: 0,
        changes: ['model-modified CreateNoteRequest2 deprecatedChanged: additive'],
      });
      expect(describeDiff(both.spec, live.spec)).toEqual({
        breaking: 0,
        changes: [
          'model-modified CreateNoteRequest2 deprecatedChanged: additive',
          'model-modified CreateOldNoteRequest deprecatedChanged: additive',
        ],
      });
    });

    it('field site, across passes: `Pet.owner` and a `getOwner` response of the same `object: pet_owner` shape share one `PetOwner2`, live unless both are deprecated', async () => {
      // The field's copy leaves the deprecated `PetOwner` when the fields
      // are settled, before any operation is read; the response's copy
      // joins the model it minted (`naming.mintedFor`), by shape, flag
      // apart: a live response makes the model live, the field keeping its
      // own flag, and a deprecated response folds onto the live model.
      const petOwner = obj({ object: { type: 'string', const: 'pet_owner' }, name: str });
      const schemas = (field: boolean) => ({
        Pet: obj({ owner: deprecate(petOwner, field) }),
        PetOwner: { ...petOwner, deprecated: true },
      });
      const paths = (response: boolean): Array<[string, unknown]> => [
        ['/pets', getOp('getPet', { $ref: '#/components/schemas/Pet' })],
        ['/owners', getOp('getOwner', deprecate(petOwner, response))],
      ];
      const combos: Array<[string, boolean, boolean]> = [
        ['live', false, false],
        ['response', false, true],
        ['field', true, false],
        ['both', true, true],
      ];
      const byOrder: Record<string, Record<string, ApiSpec>> = {};
      for (const [label, field, response] of combos) {
        for (const { order, spec, warnings } of await parseBothOrders(
          `441-field-shared-${label}`,
          schemas(field),
          paths(response),
        )) {
          const where = `${label}, ${order}`;
          const deprecated = field && response;
          expect(describeModels(spec), where).toEqual([
            `Pet {owner${field ? ' (deprecated)' : ''}: PetOwner2}`,
            'PetOwner (deprecated) {object: literal, name: string}',
            `PetOwner2${deprecated ? ' (deprecated)' : ''} {object: literal, name: string}`,
          ]);
          expect(opsOf(spec).getOwner?.response, where).toEqual({ kind: 'model', name: 'PetOwner2' });
          const fieldNote = field ? refused('PetOwner', 'PetOwner2') : liveWhile('PetOwner', 'PetOwner2');
          const responseNote = sharedBy(
            deprecated || response ? refused('PetOwner', 'PetOwner2') : liveWhile('PetOwner', 'PetOwner2'),
            2,
          );
          expect(warnings, where).toEqual([
            fieldNote,
            ...(field !== response ? [folded('PetOwner')] : []),
            responseNote,
          ]);
          expectSound(spec, ['Pet', 'PetOwner'], deprecated ? ['getOwner.response → PetOwner2'] : []);
          (byOrder[order] ??= {})[label] = spec;
        }
      }
      const fieldFlip = ['model-modified Pet: additive', 'field-deprecated-changed owner: additive'];
      const modelFlip = 'model-modified PetOwner2 deprecatedChanged: additive';
      for (const [order, specs] of Object.entries(byOrder)) {
        expect(pairs(specs), order).toEqual({
          'live→response': unchanged,
          'live→field': { breaking: 0, changes: fieldFlip },
          'live→both': { breaking: 0, changes: [...fieldFlip, modelFlip] },
          'response→live': unchanged,
          'response→field': { breaking: 0, changes: fieldFlip },
          'response→both': { breaking: 0, changes: [...fieldFlip, modelFlip] },
          'field→live': { breaking: 0, changes: fieldFlip },
          'field→response': { breaking: 0, changes: fieldFlip },
          'field→both': { breaking: 0, changes: [modelFlip] },
          'both→live': { breaking: 0, changes: [...fieldFlip, modelFlip] },
          'both→response': { breaking: 0, changes: [...fieldFlip, modelFlip] },
          'both→field': { breaking: 0, changes: [modelFlip] },
        });
      }
    });
  });

  describe('the component’s own flip beside its copies retypes them: a copy’s name follows the component’s flag, never its own (#625 review, finding 1)', () => {
    const pet = obj({ object: { type: 'string', const: 'pet' }, name: str });
    const petModel = (name: string, deprecated = false): string =>
      `${name}${deprecated ? ' (deprecated)' : ''} {object: literal, name: string}`;

    describe.each(['3.0.3', '3.1.0'])('on OpenAPI %s', (openapi) => {
      const extra = { openapi };

      it('`Pet` and `getLegacyPet`’s identical copy deprecated together, or `Pet` alone while the copy stays deprecated: the copy moves to `GetLegacyPetPet`, exit 2 either way', async () => {
        const doc = (component: boolean, copy: boolean) =>
          specDoc(
            { Pet: deprecate(pet, component) },
            {
              '/pets': getOp('getPet', { $ref: '#/components/schemas/Pet' }),
              '/legacy-pets': getOp('getLegacyPet', deprecate(pet, copy)),
            },
            extra,
          );
        const liveLive = await parse(`441-together-ll-${openapi}`, doc(false, false));
        const liveDep = await parse(`441-together-ld-${openapi}`, doc(false, true));
        const depDep = await parse(`441-together-dd-${openapi}`, doc(true, true));
        const depLive = await parse(`441-together-dl-${openapi}`, doc(true, false));
        // A live `Pet` takes its copy under its own name, whatever the
        // copy's flag; a deprecated `Pet` takes none.
        for (const { spec, warnings } of [liveLive, liveDep]) {
          expect(describeModels(spec)).toEqual([petModel('Pet')]);
          expect(opsOf(spec).getLegacyPet?.response).toEqual({ kind: 'model', name: 'Pet' });
          expect(warnings).toEqual(spec === liveDep.spec ? [folded('Pet')] : []);
          expectSound(spec, ['Pet']);
        }
        expect(describeModels(depDep.spec)).toEqual([petModel('Pet', true), petModel('GetLegacyPetPet', true)]);
        expect(depDep.warnings).toEqual([refused('Pet', 'GetLegacyPetPet')]);
        expectSound(depDep.spec, ['Pet'], ['getPet.response → Pet', 'getLegacyPet.response → GetLegacyPetPet']);
        expect(describeModels(depLive.spec)).toEqual([petModel('Pet', true), petModel('GetLegacyPetPet')]);
        expect(depLive.warnings).toEqual([liveWhile('Pet', 'GetLegacyPetPet')]);
        expectSound(depLive.spec, ['Pet'], ['getPet.response → Pet']);
        for (const [label, after] of [
          ['both deprecated together', depDep],
          ['`Pet` alone, the copy already deprecated', depDep],
          ['`Pet` alone, the copy live', depLive],
        ] as const) {
          const before = label.includes('already') ? liveDep : liveLive;
          expect(describeDiff(before.spec, after.spec), label).toEqual({
            breaking: 1,
            changes: [
              'model-added GetLegacyPetPet: additive',
              'model-modified Pet deprecatedChanged: additive',
              'operation-modified getLegacyPet responseChanged: breaking',
            ],
          });
          expect(describeDiff(after.spec, before.spec), `${label}, back`).toEqual({
            breaking: 2,
            changes: [
              'model-removed GetLegacyPetPet: breaking',
              'model-modified Pet deprecatedChanged: additive',
              'operation-modified getLegacyPet responseChanged: breaking',
            ],
          });
        }
      });

      it('two copies move off `Pet` together, to one `GetLegacyPetPet`', async () => {
        const doc = (all: boolean) =>
          specDoc(
            { Pet: deprecate(pet, all) },
            {
              '/pets': getOp('getPet', { $ref: '#/components/schemas/Pet' }),
              '/legacy-pets': getOp('getLegacyPet', deprecate(pet, all)),
              '/old-pets': getOp('getOldPet', deprecate(pet, all)),
            },
            extra,
          );
        const live = await parse(`441-together-two-live-${openapi}`, doc(false));
        const dep = await parse(`441-together-two-dep-${openapi}`, doc(true));
        expect(describeModels(live.spec)).toEqual([petModel('Pet')]);
        expect(describeModels(dep.spec)).toEqual([petModel('Pet', true), petModel('GetLegacyPetPet', true)]);
        for (const op of ['getLegacyPet', 'getOldPet']) {
          expect(opsOf(live.spec)[op]?.response, op).toEqual({ kind: 'model', name: 'Pet' });
          expect(opsOf(dep.spec)[op]?.response, op).toEqual({ kind: 'model', name: 'GetLegacyPetPet' });
        }
        expect(dep.warnings).toEqual([`${refused('Pet', 'GetLegacyPetPet')} (shared by 2 sites)`]);
        expectSound(
          dep.spec,
          ['Pet'],
          ['getPet.response → Pet', 'getLegacyPet.response → GetLegacyPetPet', 'getOldPet.response → GetLegacyPetPet'],
        );
        expect(describeDiff(live.spec, dep.spec)).toEqual({
          breaking: 2,
          changes: [
            'model-added GetLegacyPetPet: additive',
            'model-modified Pet deprecatedChanged: additive',
            'operation-modified getLegacyPet responseChanged: breaking',
            'operation-modified getOldPet responseChanged: breaking',
          ],
        });
        expect(describeDiff(dep.spec, live.spec)).toEqual({
          breaking: 3,
          changes: [
            'model-removed GetLegacyPetPet: breaking',
            'model-modified Pet deprecatedChanged: additive',
            'operation-modified getLegacyPet responseChanged: breaking',
            'operation-modified getOldPet responseChanged: breaking',
          ],
        });
      });

      it('a `Note.pet` field deprecated together with its `NotePet` component moves to `NotePet2`, a breaking field retype', async () => {
        const doc = (all: boolean) =>
          specDoc(
            { Note: obj({ pet: deprecate(pet, all) }), NotePet: deprecate(pet, all) },
            { '/notes': getOp('getNote', { $ref: '#/components/schemas/Note' }) },
            extra,
          );
        const live = await parse(`441-together-field-live-${openapi}`, doc(false));
        const dep = await parse(`441-together-field-dep-${openapi}`, doc(true));
        expect(describeModels(live.spec)).toEqual(['Note {pet: NotePet}', petModel('NotePet')]);
        expect(describeModels(dep.spec)).toEqual([
          'Note {pet (deprecated): NotePet2}',
          petModel('NotePet', true),
          petModel('NotePet2', true),
        ]);
        expect(dep.warnings).toEqual([refused('NotePet', 'NotePet2')]);
        expectSound(live.spec, ['Note', 'NotePet']);
        expectSound(dep.spec, ['Note', 'NotePet']);
        expect(describeDiff(live.spec, dep.spec)).toEqual({
          breaking: 1,
          changes: [
            'model-added NotePet2: additive',
            'model-modified Note: breaking',
            'field-type-changed pet: breaking',
            'field-deprecated-changed pet: additive',
            'model-modified NotePet deprecatedChanged: additive',
          ],
        });
        expect(describeDiff(dep.spec, live.spec)).toEqual({
          breaking: 2,
          changes: [
            'model-removed NotePet2: breaking',
            'model-modified Note: breaking',
            'field-type-changed pet: breaking',
            'field-deprecated-changed pet: additive',
            'model-modified NotePet deprecatedChanged: additive',
          ],
        });
      });
    });
  });

  describe('the predicates', () => {
    const string = { kind: 'primitive', type: 'string' } as const;
    const model = (extra: Partial<Model> = {}): Model => ({
      name: 'M',
      fields: [{ name: 'a', type: string, required: false }],
      ...extra,
    });
    const live = model();
    const deprecated = model({ deprecated: true });

    it('`ownerFlagAdmits`: a component admits either flag while live and none while deprecated; a field model reads `flagAdmits`', () => {
      expect(ownerFlagAdmits(live, live)).toBe(true);
      expect(ownerFlagAdmits(live, deprecated)).toBe(true);
      expect(ownerFlagAdmits(deprecated, deprecated)).toBe(false);
      expect(ownerFlagAdmits(deprecated, live)).toBe(false);
      for (const [owner, candidate] of [
        [live, live],
        [live, deprecated],
        [deprecated, deprecated],
        [deprecated, live],
      ] as const) {
        expect(ownerFlagAdmits(owner, candidate, true)).toBe(flagAdmits(owner, candidate));
      }
    });

    it('`flagAdmits` is unchanged: the `<Name>Json` fold still collapses a deprecated child onto a deprecated holder', () => {
      expect(flagAdmits(deprecated, deprecated)).toBe(true);
      const thing = (name: string): Model => ({
        name,
        deprecated: true,
        fields: [{ name: 'x', type: string, required: false }],
      });
      const models: Model[] = [
        { name: 'Pet', fields: [{ name: 'a', type: string, required: false }] },
        {
          name: 'PetJson',
          fields: [
            { name: 'a', type: string, required: false },
            { name: 'thing', type: { kind: 'model', name: 'PetJsonThing' }, required: false },
          ],
        },
        thing('PetJsonThing'),
        thing('PetThing'),
      ];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const folded = collapseJsonSuffixModels(models, []);
        expect(folded.map((m) => `${m.name}${m.deprecated ? ' (deprecated)' : ''}`).sort()).toEqual([
          'Pet',
          'PetThing (deprecated)',
        ]);
        expect(folded.find((m) => m.name === 'Pet')?.fields.map((f) => [f.name, refName(f.type)])).toEqual([
          ['a', undefined],
          ['thing', 'PetThing'],
        ]);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
