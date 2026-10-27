import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffModels } from '../../src/differ/models.js';
import { diffOperations } from '../../src/differ/operations.js';
import type { Change, DiffReport, FieldChange } from '../../src/differ/types.js';
import type { ApiSpec, Model, Operation, TypeRef, UnionType } from '../../src/ir/types.js';
import { parseSpec } from '../../src/parser/parse.js';

const cat: TypeRef = { kind: 'model', name: 'Cat' };
const dog: TypeRef = { kind: 'model', name: 'Dog' };
const bird: TypeRef = { kind: 'model', name: 'Bird' };
const fish: TypeRef = { kind: 'model', name: 'Fish' };
const string: TypeRef = { kind: 'primitive', type: 'string' };
const integer: TypeRef = { kind: 'primitive', type: 'integer' };

/** An inline `oneOf` discriminated on `kind`, as the parser reads one over `$ref` variants with no written mapping. */
const union = (variants: TypeRef[], over: Partial<UnionType> = {}): UnionType => ({
  kind: 'union',
  variants,
  compositionKind: 'oneOf',
  discriminator: { property: 'kind', mapping: {} },
  ...over,
});

/** The same union with a written mapping. */
const mapped = (variants: TypeRef[], mapping: Record<string, string>): UnionType =>
  union(variants, { discriminator: { property: 'kind', mapping } });

/** `Owner`, whose required `pet` field is typed `type`. */
const owner = (type: TypeRef): Model => ({ name: 'Owner', fields: [{ name: 'pet', type, required: true }] });

/** The field changes `diffModels` reports when `Owner.pet` goes from `before` to `after`. */
function petChanges(before: TypeRef, after: TypeRef): FieldChange[] {
  return diffModels([owner(before)], [owner(after)]).flatMap((c) =>
    c.kind === 'model-modified' ? c.fieldChanges : [],
  );
}

const additive = (details: string): FieldChange => ({
  kind: 'field-type-changed',
  fieldName: 'pet',
  classification: 'additive',
  details,
});
const breaking: FieldChange = {
  kind: 'field-type-changed',
  fieldName: 'pet',
  classification: 'breaking',
  details: 'type changed',
};

describe('diffModels — a variant added to an inline union (issue #428)', () => {
  it("reports a field's union that only gained a variant as an additive field-type-changed naming it", () => {
    expect(diffModels([owner(union([cat, dog]))], [owner(union([cat, dog, bird]))])).toEqual([
      {
        kind: 'model-modified',
        name: 'Owner',
        fieldChanges: [additive('variant Bird added')],
        deprecatedChanged: false,
        classification: 'additive',
      },
    ]);
  });

  it('takes a new variant anywhere among the old ones, several at once, and the mapping keys they bring', () => {
    expect(petChanges(union([cat, dog]), union([bird, cat, dog]))).toEqual([additive('variant Bird added')]);
    expect(petChanges(union([cat, dog]), union([cat, bird, dog]))).toEqual([additive('variant Bird added')]);
    expect(petChanges(union([cat, dog]), union([cat, bird, dog, fish]))).toEqual([
      additive('variants Bird, Fish added'),
    ]);
    expect(
      petChanges(
        mapped([cat, dog], { cat: 'Cat', dog: 'Dog' }),
        mapped([cat, dog, bird], { cat: 'Cat', dog: 'Dog', bird: 'Bird' }),
      ),
    ).toEqual([additive('variant Bird added')]);
  });

  it('reads an undiscriminated union, an anyOf and a multi-type union alike', () => {
    const undiscriminated = (variants: TypeRef[]): TypeRef => ({ kind: 'union', variants, compositionKind: 'oneOf' });
    expect(petChanges(undiscriminated([cat, string]), undiscriminated([cat, string, integer]))).toEqual([
      additive('variant integer added'),
    ]);
    const anyOf = (variants: TypeRef[]): TypeRef => ({ kind: 'union', variants, compositionKind: 'anyOf' });
    expect(petChanges(anyOf([cat, dog]), anyOf([cat, dog, bird]))).toEqual([additive('variant Bird added')]);
    // `type: [string, integer]`, which carries no composition keyword.
    const multiType = (variants: TypeRef[]): TypeRef => ({ kind: 'union', variants });
    expect(
      petChanges(multiType([string, integer]), multiType([string, integer, { kind: 'primitive', type: 'boolean' }])),
    ).toEqual([additive('variant boolean added')]);
  });

  it('reads through the same nullable, array or map wrapper on both sides', () => {
    const wrappers: Array<(inner: TypeRef) => TypeRef> = [
      (inner) => ({ kind: 'nullable', inner }),
      (inner) => ({ kind: 'array', items: inner }),
      (inner) => ({ kind: 'map', valueType: inner }),
      (inner) => ({ kind: 'array', items: { kind: 'nullable', inner } }),
    ];
    for (const wrap of wrappers) {
      expect(petChanges(wrap(union([cat, dog])), wrap(union([cat, dog, bird])))).toEqual([
        additive('variant Bird added'),
      ]);
      expect(petChanges(wrap(union([cat, dog, bird])), wrap(union([cat, dog])))).toEqual([breaking]);
    }
  });

  it('keeps every other change to an inline union a breaking type change', () => {
    const cases: Array<[string, TypeRef, TypeRef]> = [
      ['a variant removed', union([cat, dog, bird]), union([cat, dog])],
      ['a variant swapped for another', union([cat, dog]), union([cat, bird])],
      ['the variants reordered', union([cat, dog]), union([dog, cat])],
      ['the variants reordered beside the addition', union([cat, dog]), union([dog, cat, bird])],
      ['an old variant repeated beside the addition', union([cat, dog]), union([cat, bird, cat, dog])],
      [
        'a mapping key retargeted beside the addition',
        mapped([cat, dog], { cat: 'Cat', dog: 'Dog' }),
        mapped([cat, dog, bird], { cat: 'Cat', dog: 'Bird', bird: 'Bird' }),
      ],
      [
        'an alias for a kept variant beside the addition',
        mapped([cat, dog], { cat: 'Cat', dog: 'Dog' }),
        mapped([cat, dog, bird], { cat: 'Cat', dog: 'Dog', bird: 'Bird', kitty: 'Cat' }),
      ],
      [
        'the discriminator added beside the addition',
        union([cat, dog], { discriminator: undefined }),
        union([cat, dog, bird]),
      ],
      [
        'the discriminator removed beside the addition',
        union([cat, dog]),
        union([cat, dog, bird], { discriminator: undefined }),
      ],
      [
        'the discriminator moved beside the addition',
        union([cat, dog]),
        union([cat, dog, bird], { discriminator: { property: 'type', mapping: {} } }),
      ],
      [
        'the composition keyword changed beside the addition',
        union([cat, dog], { compositionKind: 'anyOf' }),
        union([cat, dog, bird]),
      ],
      [
        'an allOf gaining a member, which narrows it',
        union([cat, dog], { compositionKind: 'allOf', discriminator: undefined }),
        union([cat, dog, bird], { compositionKind: 'allOf', discriminator: undefined }),
      ],
      ['a model becoming a union', cat, union([cat, dog])],
      [
        'a nullable wrapper added beside the addition',
        union([cat, dog]),
        { kind: 'nullable', inner: union([cat, dog, bird]) },
      ],
      [
        'array items moved under a map beside the addition',
        { kind: 'array', items: union([cat, dog]) },
        { kind: 'map', valueType: union([cat, dog, bird]) },
      ],
    ];
    for (const [label, before, after] of cases) {
      expect([label, petChanges(before, after)]).toEqual([label, [breaking]]);
    }
  });
});

describe('diffOperations — a variant added to an inline union body (issue #428)', () => {
  const getPet = (response: TypeRef): Operation => ({
    name: 'getPet',
    httpMethod: 'get',
    path: '/pets/{id}',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response,
    responseStatusCode: 200,
    errors: [],
    injectIdempotencyKey: false,
  });
  const createPet = (requestBody: TypeRef): Operation => ({
    ...getPet({ kind: 'primitive', type: 'unknown' }),
    name: 'createPet',
    httpMethod: 'post',
    path: '/pets',
    responseStatusCode: 204,
    requestBody,
    requestBodyRequired: true,
  });
  const flags = (changes: Change[]) =>
    changes.map((c) =>
      c.kind === 'operation-modified'
        ? `${c.operationName} responseChanged=${c.responseChanged} requestBodyChanged=${c.requestBodyChanged}: ${c.classification}`
        : `${c.kind}: ${c.classification}`,
    );

  it('keeps a response that only gained a variant additive, and its reverse breaking', () => {
    const before = getPet(union([cat, dog]));
    const after = getPet(union([cat, dog, bird]));
    expect(flags(diffOperations('Pets', [before], [after]))).toEqual([
      'getPet responseChanged=true requestBodyChanged=false: additive',
    ]);
    expect(flags(diffOperations('Pets', [after], [before]))).toEqual([
      'getPet responseChanged=true requestBodyChanged=false: breaking',
    ]);
  });

  it('keeps a request body that only gained a variant additive, and its reverse breaking', () => {
    const before = createPet(union([cat, dog]));
    const after = createPet(union([cat, bird, dog]));
    expect(flags(diffOperations('Pets', [before], [after]))).toEqual([
      'createPet responseChanged=false requestBodyChanged=true: additive',
    ]);
    expect(flags(diffOperations('Pets', [after], [before]))).toEqual([
      'createPet responseChanged=false requestBodyChanged=true: breaking',
    ]);
  });

  it('keeps every other body change breaking', () => {
    expect(flags(diffOperations('Pets', [getPet(union([cat, dog]))], [getPet(union([dog, cat, bird]))]))).toEqual([
      'getPet responseChanged=true requestBodyChanged=false: breaking',
    ]);
    expect(flags(diffOperations('Pets', [createPet(union([cat, dog]))], [createPet(union([cat, bird]))]))).toEqual([
      'createPet responseChanged=false requestBodyChanged=true: breaking',
    ]);
    // The operation losing its only 2xx is breaking whatever its body was.
    const { responseStatusCode: _code, ...noSuccess } = getPet(union([cat, dog, bird]));
    expect(flags(diffOperations('Pets', [getPet(union([cat, dog]))], [noSuccess]))).toEqual([
      'getPet responseChanged=true requestBodyChanged=false: breaking',
    ]);
  });
});

describe("diffSpecs — the issue's documents, end to end (issue #428)", () => {
  const ref = (name: string) => `#/components/schemas/${name}`;
  const variant = (kind: string) => ({
    type: 'object',
    required: ['kind'],
    properties: { kind: { type: 'string', const: kind } },
  });
  const pets = { Bird: variant('bird'), Cat: variant('cat'), Dog: variant('dog') };
  const petUnion = (names: string[]) => ({
    oneOf: names.map((name) => ({ $ref: ref(name) })),
    discriminator: { propertyName: 'kind' },
  });
  const document = (paths: object, schemas: object) => ({
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1.0.0' },
    paths,
    components: { schemas: { ...pets, ...schemas } },
  });
  const getById = (operationId: string, schema: object) => ({
    get: {
      operationId,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
    },
  });
  /** `pet` is a required field of `Owner`, which `GET /owners/{id}` returns. */
  const fieldDocument = (pet: object) =>
    document(
      { '/owners/{id}': getById('getOwner', { $ref: ref('Owner') }) },
      { Owner: { type: 'object', required: ['pet'], properties: { pet } } },
    );
  /** The union is the `200` body of `GET /pets/{id}`. */
  const bodyDocument = (names: string[]) => document({ '/pets/{id}': getById('getPet', petUnion(names)) }, {});
  /** The union is the required request body of `POST /pets`. */
  const requestDocument = (names: string[]) =>
    document(
      {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: { required: true, content: { 'application/json': { schema: petUnion(names) } } },
            responses: { '204': { description: 'created' } },
          },
        },
      },
      {},
    );

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oagen-428-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  async function parse(name: string, doc: object): Promise<ApiSpec> {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(doc));
    return parseSpec(file);
  }
  const summarize = (report: DiffReport) => ({
    changes: report.changes.map((c) => {
      const name = 'name' in c ? c.name : 'operationName' in c ? c.operationName : c.kind;
      const fields = c.kind === 'model-modified' ? c.fieldChanges.map((f) => ` ${f.fieldName} ${f.details}`) : [];
      const response = c.kind === 'operation-modified' && c.responseChanged ? ' responseChanged' : '';
      const body = c.kind === 'operation-modified' && c.requestBodyChanged ? ' requestBodyChanged' : '';
      return `${name}${fields.join(',')}${response}${body}: ${c.classification}`;
    }),
    breaking: report.summary.breaking,
  });

  it('reports a variant added to a field union as additive, and its removal as breaking', async () => {
    const oldSpec = await parse('field-old', fieldDocument(petUnion(['Cat', 'Dog'])));
    const newSpec = await parse('field-new', fieldDocument(petUnion(['Cat', 'Dog', 'Bird'])));
    expect(summarize(diffSpecs(oldSpec, newSpec))).toEqual({
      changes: ['Owner pet variant Bird added: additive'],
      breaking: 0,
    });
    expect(summarize(diffSpecs(newSpec, oldSpec))).toEqual({
      changes: ['Owner pet type changed: breaking'],
      breaking: 1,
    });
  });

  it('reports a variant added to a response union as additive, and its removal as breaking', async () => {
    const oldSpec = await parse('body-old', bodyDocument(['Cat', 'Dog']));
    const newSpec = await parse('body-new', bodyDocument(['Cat', 'Dog', 'Bird']));
    const report = diffSpecs(oldSpec, newSpec);
    expect(summarize(report)).toEqual({ changes: ['getPet responseChanged: additive'], breaking: 0 });
    expect(report.changes[0]).toMatchObject({ responseContentTypeChanges: [], responseHeaderChanges: [] });
    expect(summarize(diffSpecs(newSpec, oldSpec))).toEqual({
      changes: ['getPet responseChanged: breaking'],
      breaking: 1,
    });
  });

  it('reports a variant added to a request body union as additive, and its removal as breaking', async () => {
    const oldSpec = await parse('request-old', requestDocument(['Cat', 'Dog']));
    const newSpec = await parse('request-new', requestDocument(['Cat', 'Dog', 'Bird']));
    expect(summarize(diffSpecs(oldSpec, newSpec))).toEqual({
      changes: ['createPet requestBodyChanged: additive'],
      breaking: 0,
    });
    expect(summarize(diffSpecs(newSpec, oldSpec))).toEqual({
      changes: ['createPet requestBodyChanged: breaking'],
      breaking: 1,
    });
  });

  it('reports an undiscriminated `Cat | string` gaining `integer` as additive', async () => {
    const oldSpec = await parse(
      'undiscriminated-old',
      fieldDocument({ oneOf: [{ $ref: ref('Cat') }, { type: 'string' }] }),
    );
    const newSpec = await parse(
      'undiscriminated-new',
      fieldDocument({ oneOf: [{ $ref: ref('Cat') }, { type: 'string' }, { type: 'integer' }] }),
    );
    expect(summarize(diffSpecs(oldSpec, newSpec))).toEqual({
      changes: ['Owner pet variant integer added: additive'],
      breaking: 0,
    });
  });
});
