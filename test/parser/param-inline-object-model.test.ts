import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import {
  collectModelTypeRefs,
  collectOperationTypeRefs,
  collectWebhookTypeRefs,
  walkTypeRef,
} from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef, Webhook } from '../../src/ir/types.js';
import type { SchemaObject } from '../../src/parser/schemas.js';

/**
 * workos/oagen#298: an inline object on an operation's parameter — a
 * `style: deepObject` query filter, or the same schema on a path, header or
 * cookie parameter — was typed as a model nothing created (`[oagen]
 * Warning: Unresolved model reference "NotesFilter"`), while the same
 * parameter on a webhook got its model. A parameter whose inline schema
 * mints a model is now deferred like a response header
 * (`deferParameterModels`) and materialized under a name nothing else owns.
 *
 * "Nothing else" includes every enum name: the component enums, the inline
 * enums every typed site carries, and those a deferred site types. A
 * parameter model named like one of them stepped past nothing before, so
 * the IR declared a model and an enum under one name and an emitter wrote
 * both to one file. The deferred registry now reserves every enum name
 * (`reserveEnumNamesInPlay`, `reserveEnumNames`), and an enum lifted after a
 * model of its name steps to a distinct name (`collectDistinctEnums`), so
 * the first site to carry a name keeps it.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-param-inline-object-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** Parse `doc`, collecting every warning instead of printing it. */
async function parse(label: string, doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const spec = await parseSpec(await writeSpec(`${label}.json`, doc));
    return { spec, warnings: warn.mock.calls.map(([m]) => String(m)) };
  } finally {
    warn.mockRestore();
  }
}

const str: SchemaObject = { type: 'string' };
const int: SchemaObject = { type: 'integer' };
const en = (values: string[]): SchemaObject => ({ type: 'string', enum: values });
const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
  type: 'object',
  properties,
  ...extra,
});
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const ok = { '200': { description: 'ok' } };
const param = (name: string, location: string, schema: SchemaObject, extra: Record<string, unknown> = {}) => ({
  name,
  in: location,
  schema,
  ...(location === 'path' ? { required: true } : {}),
  ...extra,
});
const specDoc = (
  paths: Record<string, unknown>,
  schemas: Record<string, unknown> = {},
  webhooks: Record<string, unknown> = {},
) => ({
  openapi: '3.1.0',
  info: { title: 'param inline object', version: '1' },
  paths,
  ...(Object.keys(webhooks).length > 0 ? { webhooks } : {}),
  components: { schemas },
});

// The issue's parameter, verbatim: a `deepObject` query filter.
const filter = param('filter', 'query', obj({ tag: str }), { style: 'deepObject' });
/** `GET /notes` (`listNotes`, tag `notes`) with the given parameters. */
const listNotes = (parameters: unknown[]) => ({
  '/notes': { get: { operationId: 'listNotes', tags: ['notes'], parameters, responses: ok } },
});
/** The `noteAdded` webhook with the given parameters. */
const noteAdded = (parameters: unknown[]) => ({
  noteAdded: { post: { operationId: 'noteAdded', parameters, responses: ok } },
});

/** `Model[]`, `T | null`, `(A | B)`, `map<T>`. */
function show(type: TypeRef): string {
  switch (type.kind) {
    case 'array':
      return `${show(type.items)}[]`;
    case 'nullable':
      return `${show(type.inner)} | null`;
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'model':
    case 'enum':
      return type.name;
    case 'primitive':
      return type.type;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'literal':
      return JSON.stringify(type.value);
  }
}

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
const hookOf = (spec: ApiSpec, name: string): Webhook => {
  const hook = spec.webhooks?.find((w) => w.name === name);
  if (!hook) throw new Error(`webhook ${name} not found`);
  return hook;
};

/** Every parameter of an operation or webhook as `location:name` → rendered type. */
function paramTypes(site: Operation | Webhook): Record<string, string> {
  const lists: Array<[string, Array<{ name: string; type: TypeRef }>]> = [
    ['path', 'pathParams' in site ? site.pathParams : []],
    ['query', site.queryParams],
    ['header', site.headerParams],
    ['cookie', site.cookieParams ?? []],
  ];
  return Object.fromEntries(
    lists.flatMap(([location, list]) => list.map((p) => [`${location}:${p.name}`, show(p.type)])),
  );
}

const fieldsOf = (spec: ApiSpec, name: string): Record<string, string> => {
  const model = spec.models.find((m) => m.name === name);
  if (!model) throw new Error(`model ${name} not found in ${spec.models.map((m) => m.name).join(', ')}`);
  return Object.fromEntries(model.fields.map((f) => [f.name, show(f.type)]));
};
const enumValues = (spec: ApiSpec, name: string): unknown[] | undefined =>
  spec.enums.find((e) => e.name === name)?.values.map((v) => v.value);
const modelNames = (spec: ApiSpec): string[] => spec.models.map((m) => m.name).sort();
const enumNames = (spec: ApiSpec): string[] => spec.enums.map((e) => e.name).sort();

/**
 * The IR is sound: no name is both a model's and an enum's, every model and
 * enum reference resolves, and every model or enum that is not a component
 * is reachable from an operation, a webhook or a model — nothing minted is
 * left orphaned.
 */
function expectSound(spec: ApiSpec, components: readonly string[] = []): void {
  const models = new Set(spec.models.map((m) => m.name));
  const enums = new Set(spec.enums.map((e) => e.name));
  expect([...models].filter((name) => enums.has(name))).toEqual([]);
  const dangling: string[] = [];
  const reached = new Set<string>();
  const visit = (label: string, type: TypeRef): void => {
    walkTypeRef(type, {
      model: (ref) => {
        if (!models.has(ref.name)) dangling.push(`${label} -> model ${ref.name}`);
        reached.add(ref.name);
      },
      enum: (ref) => {
        if (!enums.has(ref.name)) dangling.push(`${label} -> enum ${ref.name}`);
        reached.add(ref.name);
      },
    });
  };
  for (const op of spec.services.flatMap((s) => s.operations)) {
    for (const ref of collectOperationTypeRefs(op)) visit(op.name, ref);
  }
  for (const hook of spec.webhooks ?? []) for (const ref of collectWebhookTypeRefs(hook)) visit(hook.name, ref);
  for (const model of spec.models) for (const ref of collectModelTypeRefs(model)) visit(model.name, ref);
  expect(dangling).toEqual([]);
  const orphans = [...models, ...enums].filter((name) => !reached.has(name) && !components.includes(name));
  expect(orphans).toEqual([]);
}

describe('the issue, verbatim', () => {
  it('creates the model an inline object parameter references, on an operation as on a webhook', async () => {
    const { spec, warnings } = await parse('repro', specDoc(listNotes([filter]), {}, noteAdded([filter])));
    expect(warnings).toEqual([]);
    expect(modelNames(spec)).toEqual(['NoteAddedFilter', 'NotesFilter']);
    expect(paramTypes(opsOf(spec).listNotes)).toEqual({ 'query:filter': 'NotesFilter' });
    expect(paramTypes(hookOf(spec, 'noteAdded'))).toEqual({ 'query:filter': 'NoteAddedFilter' });
    expect(fieldsOf(spec, 'NotesFilter')).toEqual({ tag: 'string' });
    expect(fieldsOf(spec, 'NoteAddedFilter')).toEqual({ tag: 'string' });
    expectSound(spec);
  });

  it('does the same for an inline object on a path, header or cookie parameter', async () => {
    const selector = obj({ id: str, rev: int });
    const trace = obj({ span: str });
    const session = obj({ token: str });
    const { spec, warnings } = await parse(
      'locations',
      specDoc(
        {
          '/notes/{selector}': {
            get: {
              operationId: 'getNote',
              tags: ['notes'],
              parameters: [
                param('selector', 'path', selector, { style: 'matrix' }),
                param('X-Trace', 'header', trace),
                param('session', 'cookie', session),
              ],
              responses: ok,
            },
          },
        },
        {},
        noteAdded([param('X-Trace', 'header', trace), param('session', 'cookie', session)]),
      ),
    );
    expect(warnings).toEqual([]);
    expect(paramTypes(opsOf(spec).getNote)).toEqual({
      'path:selector': 'NotesSelector',
      'header:X-Trace': 'NotesXTrace',
      'cookie:session': 'NotesSession',
    });
    expect(paramTypes(hookOf(spec, 'noteAdded'))).toEqual({
      'header:X-Trace': 'NoteAddedXTrace',
      'cookie:session': 'NoteAddedSession',
    });
    expect(fieldsOf(spec, 'NotesSelector')).toEqual({ id: 'string', rev: 'integer' });
    expect(fieldsOf(spec, 'NotesXTrace')).toEqual({ span: 'string' });
    expect(fieldsOf(spec, 'NotesSession')).toEqual({ token: 'string' });
    expect(fieldsOf(spec, 'NoteAddedXTrace')).toEqual({ span: 'string' });
    expect(fieldsOf(spec, 'NoteAddedSession')).toEqual({ token: 'string' });
    expectSound(spec);
  });
});

describe('what the parameter references at any depth, on an operation as on a webhook', () => {
  const params = [
    param(
      'filter',
      'query',
      obj({ tag: str, status: en(['draft', 'published']), sort: { $ref: '#/components/schemas/SortOrder' } }),
      { style: 'deepObject' },
    ),
    param('owner', 'query', obj({ address: obj({ city: str }) })),
    param('authors', 'query', { type: 'array', items: obj({ name: str }) }),
    param('labels', 'query', { type: 'object', additionalProperties: obj({ color: str }) }),
    param('shape', 'query', { oneOf: [obj({ radius: int }), obj({ side: int })] }),
    param('cursor', 'query', { type: ['object', 'null'], properties: { after: str } }),
  ];

  it('nested objects, inline and component enums, arrays, maps, unions and nullable wrappers', async () => {
    const { spec, warnings } = await parse(
      'depth',
      specDoc(listNotes(params), { SortOrder: en(['asc', 'desc']) }, noteAdded(params)),
    );
    expect(warnings).toEqual([]);
    const expectedTypes = (stem: string) => ({
      'query:filter': `${stem}Filter`,
      'query:owner': `${stem}Owner`,
      'query:authors': `${stem}Author[]`,
      'query:labels': `map<${stem}Label>`,
      'query:shape': `(${stem}Shape | ${stem}ShapeWithSide)`,
      'query:cursor': `${stem}Cursor | null`,
    });
    expect(paramTypes(opsOf(spec).listNotes)).toEqual(expectedTypes('Notes'));
    expect(paramTypes(hookOf(spec, 'noteAdded'))).toEqual(expectedTypes('NoteAdded'));
    for (const stem of ['Notes', 'NoteAdded']) {
      expect(fieldsOf(spec, `${stem}Filter`)).toEqual({
        tag: 'string',
        status: `${stem}FilterStatus`,
        sort: 'SortOrder',
      });
      expect(fieldsOf(spec, `${stem}Owner`)).toEqual({ address: `${stem}OwnerAddress` });
      expect(fieldsOf(spec, `${stem}OwnerAddress`)).toEqual({ city: 'string' });
      expect(fieldsOf(spec, `${stem}Author`)).toEqual({ name: 'string' });
      expect(fieldsOf(spec, `${stem}Label`)).toEqual({ color: 'string' });
      expect(fieldsOf(spec, `${stem}Shape`)).toEqual({ radius: 'integer' });
      expect(fieldsOf(spec, `${stem}ShapeWithSide`)).toEqual({ side: 'integer' });
      expect(fieldsOf(spec, `${stem}Cursor`)).toEqual({ after: 'string' });
      expect(enumValues(spec, `${stem}FilterStatus`)).toEqual(['draft', 'published']);
    }
    expect(enumNames(spec)).toEqual(['NoteAddedFilterStatus', 'NotesFilterStatus', 'SortOrder']);
    expectSound(spec);
  });
});

describe('a name an enum owns is not a parameter model’s', () => {
  /** `GET /pets` (`listPets`), `GET /pets/search` (`searchPets`) and `GET /pets/tags` (`listPetTags`), all tagged `pets`. */
  const pets = (listPets: unknown[], searchPets: unknown[] = [], listPetTags: unknown[] = []) => ({
    '/pets': { get: { operationId: 'listPets', tags: ['pets'], parameters: listPets, responses: ok } },
    '/pets/search': { get: { operationId: 'searchPets', tags: ['pets'], parameters: searchPets, responses: ok } },
    '/pets/tags': { get: { operationId: 'listPetTags', tags: ['pets'], parameters: listPetTags, responses: ok } },
  });

  it('a component enum: the model is qualified by the operation, its nested enum with it', async () => {
    const { spec, warnings } = await parse(
      'component-enum',
      specDoc(pets([param('filter', 'query', obj({ tag: str, status: en(['draft', 'published']) }))]), {
        PetsFilter: en(['a', 'b']),
      }),
    );
    expect(warnings).toEqual([]);
    expect(paramTypes(opsOf(spec).listPets)).toEqual({ 'query:filter': 'PetsListPetsFilter' });
    expect(fieldsOf(spec, 'PetsListPetsFilter')).toEqual({ tag: 'string', status: 'PetsListPetsFilterStatus' });
    expect(enumValues(spec, 'PetsFilter')).toEqual(['a', 'b']);
    expect(enumValues(spec, 'PetsListPetsFilterStatus')).toEqual(['draft', 'published']);
    expect(modelNames(spec)).toEqual(['PetsListPetsFilter']);
    expectSound(spec, ['PetsFilter']);
  });

  it("another operation's parameter enum, declared before or after: the model is qualified by the operation", async () => {
    const { spec, warnings } = await parse(
      'other-operation-enum',
      specDoc(
        pets(
          [param('status', 'query', en(['on', 'off']))],
          [param('status', 'query', obj({ code: str })), param('kind', 'query', obj({ label: str }))],
          [param('kind', 'query', en(['one', 'two']))],
        ),
      ),
    );
    expect(warnings).toEqual([]);
    const ops = opsOf(spec);
    expect(paramTypes(ops.listPets)).toEqual({ 'query:status': 'PetsStatus' });
    expect(paramTypes(ops.searchPets)).toEqual({
      'query:status': 'PetsSearchPetsStatus',
      'query:kind': 'PetsSearchPetsKind',
    });
    expect(paramTypes(ops.listPetTags)).toEqual({ 'query:kind': 'PetsKind' });
    expect(enumValues(spec, 'PetsStatus')).toEqual(['on', 'off']);
    expect(enumValues(spec, 'PetsKind')).toEqual(['one', 'two']);
    expect(fieldsOf(spec, 'PetsSearchPetsStatus')).toEqual({ code: 'string' });
    expect(fieldsOf(spec, 'PetsSearchPetsKind')).toEqual({ label: 'string' });
    expect(modelNames(spec)).toEqual(['PetsSearchPetsKind', 'PetsSearchPetsStatus']);
    expect(enumNames(spec)).toEqual(['PetsKind', 'PetsStatus']);
    expectSound(spec);
  });

  it("the same operation's parameter enum in another location: the model is qualified by its location", async () => {
    const { spec, warnings } = await parse(
      'same-operation-enum',
      specDoc(pets([param('status', 'query', en(['on', 'off'])), param('status', 'header', obj({ code: str }))])),
    );
    expect(warnings).toEqual([]);
    expect(paramTypes(opsOf(spec).listPets)).toEqual({
      'query:status': 'PetsStatus',
      'header:status': 'PetsHeaderStatus',
    });
    expect(enumValues(spec, 'PetsStatus')).toEqual(['on', 'off']);
    expect(fieldsOf(spec, 'PetsHeaderStatus')).toEqual({ code: 'string' });
    expectSound(spec);
  });

  it('an enum a deferred site typed earlier — a response header, an error body — and the reverse', async () => {
    const Pet = { $ref: '#/components/schemas/Pet' };
    const { spec, warnings } = await parse(
      'deferred-enum',
      specDoc(
        {
          // The `X-Mode` header enum is typed in the deferred pass, before the
          // `X-Mode` parameter object of the next operation.
          '/pets': {
            get: {
              operationId: 'listPets',
              tags: ['pets'],
              responses: {
                '200': { description: 'ok', ...json(Pet), headers: { 'X-Mode': { schema: en(['fast', 'slow']) } } },
              },
            },
          },
          // `get-pet` and `getPet` share the stem `GetPet`: the enum body of
          // the first owns `GetPetError404`, the object body of the second
          // steps to `GetPetError404Body` as a second model would.
          '/pet/{petId}': {
            get: {
              operationId: 'get-pet',
              tags: ['pets'],
              parameters: [param('petId', 'path', str), param('X-Mode', 'header', obj({ lane: str }))],
              responses: {
                '200': { description: 'ok', ...json(Pet) },
                '404': { description: 'nf', ...json(en(['gone', 'missing'])) },
              },
            },
          },
          '/pets/{petId}': {
            get: {
              operationId: 'getPet',
              tags: ['pets'],
              parameters: [param('petId', 'path', str)],
              responses: {
                '200': { description: 'ok', ...json(Pet) },
                '404': { description: 'nf', ...json(obj({ reason: str })) },
              },
            },
          },
        },
        { Pet: obj({ name: str }) },
      ),
    );
    expect(warnings).toEqual([]);
    const byPath = Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.path, op]));
    expect(show(byPath['/pets'].responseHeaders![0].type)).toBe('PetsXMode');
    expect(paramTypes(byPath['/pet/{petId}'])).toEqual({ 'path:petId': 'string', 'header:X-Mode': 'PetsGetPetXMode' });
    expect(show(byPath['/pet/{petId}'].errors[0].type!)).toBe('GetPetError404');
    expect(show(byPath['/pets/{petId}'].errors[0].type!)).toBe('GetPetError404Body');
    expect(enumValues(spec, 'PetsXMode')).toEqual(['fast', 'slow']);
    expect(enumValues(spec, 'GetPetError404')).toEqual(['gone', 'missing']);
    expect(fieldsOf(spec, 'PetsGetPetXMode')).toEqual({ lane: 'string' });
    expect(fieldsOf(spec, 'GetPetError404Body')).toEqual({ reason: 'string' });
    expectSound(spec, ['Pet']);
  });

  it('and a name a model owns is not an enum’s: the enum steps to a numbered name', async () => {
    const { spec, warnings } = await parse(
      'model-name',
      specDoc(
        pets([
          // The `kind` enum nested in the `owner` parameter's model derives
          // `PetsOwnerKind`, a component model's name.
          param('owner', 'query', obj({ kind: en(['person', 'org']) })),
          // The `mode` parameter enum derives `PetsMode`, a component model's name.
          param('mode', 'query', en(['fast', 'slow'])),
        ]),
        { PetsOwnerKind: obj({ code: str }), PetsMode: obj({ level: int }) },
      ),
    );
    expect(warnings).toEqual([]);
    expect(paramTypes(opsOf(spec).listPets)).toEqual({ 'query:owner': 'PetsOwner', 'query:mode': 'PetsMode2' });
    expect(fieldsOf(spec, 'PetsOwner')).toEqual({ kind: 'PetsOwnerKind2' });
    expect(enumValues(spec, 'PetsOwnerKind2')).toEqual(['person', 'org']);
    expect(enumValues(spec, 'PetsMode2')).toEqual(['fast', 'slow']);
    expect(fieldsOf(spec, 'PetsOwnerKind')).toEqual({ code: 'string' });
    expect(fieldsOf(spec, 'PetsMode')).toEqual({ level: 'integer' });
    expect(modelNames(spec)).toEqual(['PetsMode', 'PetsOwner', 'PetsOwnerKind']);
    expect(enumNames(spec)).toEqual(['PetsMode2', 'PetsOwnerKind2']);
    expectSound(spec, ['PetsMode', 'PetsOwnerKind']);
  });
});

describe('a parameter declared with `content` instead of `schema` (workos/oagen#297)', () => {
  /** The parameter's object under `content.application/json`, the way #297 types it. */
  const viaContent = (name: string, location: string, schema: SchemaObject) => ({
    name,
    in: location,
    ...(location === 'path' ? { required: true } : {}),
    ...json(schema),
  });

  it('mints its model in every location, on an operation as on a webhook, and steps around an enum name too', async () => {
    const trace = obj({ span: str });
    const session = obj({ token: str });
    const { spec, warnings } = await parse(
      'content',
      specDoc(
        {
          '/pets': {
            get: {
              operationId: 'listPets',
              tags: ['pets'],
              parameters: [
                viaContent('filter', 'query', obj({ tag: str, status: en(['draft', 'published']) })),
                viaContent('X-Trace', 'header', trace),
                viaContent('session', 'cookie', session),
              ],
              responses: ok,
            },
          },
          '/pets/{selector}': {
            get: {
              operationId: 'getPet',
              tags: ['pets'],
              parameters: [viaContent('selector', 'path', obj({ id: str, rev: int }))],
              responses: ok,
            },
          },
        },
        // A component enum owns the `filter` parameter's bare name. (`Pets`,
        // not `Notes`: `cleanSchemaName` keeps `PetsFilter` as written.)
        { PetsFilter: en(['a', 'b']) },
        noteAdded([viaContent('filter', 'query', obj({ tag: str })), viaContent('X-Trace', 'header', trace)]),
      ),
    );
    expect(warnings).toEqual([]);
    const ops = opsOf(spec);
    expect(paramTypes(ops.listPets)).toEqual({
      'query:filter': 'PetsListPetsFilter',
      'header:X-Trace': 'PetsXTrace',
      'cookie:session': 'PetsSession',
    });
    expect(paramTypes(ops.getPet)).toEqual({ 'path:selector': 'PetsSelector' });
    expect(paramTypes(hookOf(spec, 'noteAdded'))).toEqual({
      'query:filter': 'NoteAddedFilter',
      'header:X-Trace': 'NoteAddedXTrace',
    });
    expect(fieldsOf(spec, 'PetsListPetsFilter')).toEqual({ tag: 'string', status: 'PetsListPetsFilterStatus' });
    expect(fieldsOf(spec, 'PetsXTrace')).toEqual({ span: 'string' });
    expect(fieldsOf(spec, 'PetsSession')).toEqual({ token: 'string' });
    expect(fieldsOf(spec, 'PetsSelector')).toEqual({ id: 'string', rev: 'integer' });
    expect(fieldsOf(spec, 'NoteAddedFilter')).toEqual({ tag: 'string' });
    expect(fieldsOf(spec, 'NoteAddedXTrace')).toEqual({ span: 'string' });
    expect(enumValues(spec, 'PetsFilter')).toEqual(['a', 'b']);
    expect(enumValues(spec, 'PetsListPetsFilterStatus')).toEqual(['draft', 'published']);
    expectSound(spec, ['PetsFilter']);
  });
});
