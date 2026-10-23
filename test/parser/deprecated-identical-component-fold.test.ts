import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import {
  fieldAdmits,
  fieldFlagAgrees,
  flagAdmits,
  modelAdmits,
  modelFingerprint,
  modelShares,
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

  it('`modelShares` reads the flag by `flagAdmits` for a received shape and a sent one alike', () => {
    for (const sent of [false, true]) {
      expect(modelShares(live, deprecated, sent), `sent: ${sent}`).toBe(true);
      expect(modelShares(deprecated, live, sent), `sent: ${sent}`).toBe(false);
      expect(modelShares(deprecated, deprecated, sent), `sent: ${sent}`).toBe(true);
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
