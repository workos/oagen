import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collectModelRefs, collectOperationTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Operation, ResponseContent, TypeRef } from '../../src/ir/types.js';
// These tests pin the per-operation error body naming (`<Op>Error<code>`) that
// the collapse pass folds onto shared models by default
// (src/parser/collapse-error-bodies.ts); they parse with
// `collapseErrorBodies: false` to keep exercising it.

// workos/oagen#304: an inline error body is `<Op>Error<code>` (#243), but the
// same error's body under another media type was `<Op><MediaType>Error`,
// with the status code appended only once that name was taken, and a `4XX`
// or `5XX` body was `<Op>ClientErrorResponse`, like a `default` body. Every
// inline error body now carries the status code — or the range key — in
// its name and steps by `Body` as the JSON body does:
// `GetNoteError404ApplicationYaml`, `GetNoteError4Xx`, `GetNoteError4XxApplicationYaml`.

type Doc = Record<string, unknown>;

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>): Doc => ({ type: 'object', properties });
const json = (schema: Doc) => ({ 'application/json': { schema } });
const yaml = (schema: Doc) => ({ 'application/yaml': { schema } });
const text = { 'text/plain': { schema: str } };
const ok = { description: 'ok', content: json({ $ref: '#/components/schemas/Note' }) };
const noteComponent = { Note: obj({ title: str }) };

function doc(paths: Doc, schemas: Doc = {}, responses?: Doc): Doc {
  return {
    openapi: '3.1.0',
    info: { title: 'error body naming', version: '1' },
    paths,
    components: { schemas: { ...noteComponent, ...schemas }, ...(responses && { responses }) },
  };
}

/** `GET /notes/{id}` (`getNote`) returning `Note`, with the given other responses. */
function getNote(responses: Doc, operation: Doc = { operationId: 'getNote' }): Doc {
  return {
    '/notes/{id}': {
      get: {
        ...operation,
        parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
        responses: { '200': ok, ...responses },
      },
    },
  };
}

async function parse(spec: Doc): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-error-body-naming-'));
  const file = path.join(dir, 'spec.json');
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    return await parseSpec(file, { collapseErrorBodies: false });
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

async function parseWithoutWarnings(spec: Doc): Promise<ApiSpec> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parse(spec);
    expect(warn.mock.calls).toEqual([]);
    return ir;
  } finally {
    warn.mockRestore();
  }
}

function operations(spec: ApiSpec): Map<string, Operation> {
  return new Map(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
}

function only(spec: ApiSpec): Operation {
  const ops = [...operations(spec).values()];
  expect(ops).toHaveLength(1);
  return ops[0];
}

const typeName = (type: TypeRef | undefined): string | undefined =>
  type?.kind === 'model' || type?.kind === 'enum' ? type.name : type?.kind === 'primitive' ? type.type : type?.kind;

const contentsOf = (entry: { contents?: ResponseContent[] }): string[] =>
  (entry.contents ?? []).map(({ contentType, type }) => `${contentType}: ${typeName(type)}`);

const modelNames = (spec: ApiSpec): string[] => spec.models.map((m) => m.name).sort();

const fieldsOf = (spec: ApiSpec, name: string): string[] | undefined =>
  spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);

const enumValues = (spec: ApiSpec, name: string): string[] | undefined =>
  spec.enums.find((e) => e.name === name)?.values.map((v) => String(v.value));

/** The issue's projection: every error's media types, and every range body, by name. */
function errorNames(op: Operation): { errors: Record<string, string[]>; ranges: string[] } {
  return {
    errors: Object.fromEntries(op.errors.map(({ statusCode, contents }) => [statusCode, contentsOf({ contents })])),
    ranges: (op.rangeResponses ?? []).map(({ range, type }) => `${range}: ${typeName(type)}`),
  };
}

/** Every model reference, from operations and model fields alike, that names no model. */
function unresolvedReferences(spec: ApiSpec): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const found: string[] = [];
  for (const op of operations(spec).values()) {
    for (const ref of collectOperationTypeRefs(op)) {
      for (const name of collectModelRefs(ref)) if (!names.has(name)) found.push(`${op.name} → ${name}`);
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
function orphanedModels(spec: ApiSpec, componentNames: readonly string[]): string[] {
  const referenced = new Set<string>();
  for (const op of operations(spec).values()) {
    for (const ref of collectOperationTypeRefs(op)) for (const name of collectModelRefs(ref)) referenced.add(name);
  }
  for (const model of spec.models) {
    for (const field of model.fields) for (const name of collectModelRefs(field.type)) referenced.add(name);
  }
  return spec.models
    .map((m) => m.name)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name))
    .sort();
}

/** Nothing dangles, nothing is orphaned, and no model is named like an enum. */
function expectSound(spec: ApiSpec, componentNames: readonly string[] = ['Note']): void {
  expect(unresolvedReferences(spec)).toEqual([]);
  expect(orphanedModels(spec, componentNames)).toEqual([]);
  const enumNames = new Set(spec.enums.map((e) => e.name));
  expect(spec.models.map((m) => m.name).filter((name) => enumNames.has(name))).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the issue's repro: a 400 and a 404 under JSON and YAML, and an inline 4XX", () => {
  const paths = getNote({
    '400': { description: 'bad', content: { ...json(obj({ a: str })), ...yaml(obj({ b: str })) } },
    '404': { description: 'gone', content: { ...json(obj({ c: str })), ...yaml(obj({ d: str })) } },
    '4XX': { description: 'rejected', content: json(obj({ e: str })) },
  });

  it('names every error body `<Op>Error<code>`, the media type after the code, and the range body by its key', async () => {
    const spec = await parseWithoutWarnings(doc(paths));

    // Before: `GetNoteApplicationYamlError` for the 400's YAML body (its code
    // dropped), `GetNoteApplicationYamlError404` for the 404's (its code
    // appended only because the bare name was taken), and
    // `GetNoteClientErrorResponse` for the range.
    expect(errorNames(only(spec))).toEqual({
      errors: {
        '400': ['application/json: GetNoteError400', 'application/yaml: GetNoteError400ApplicationYaml'],
        '404': ['application/json: GetNoteError404', 'application/yaml: GetNoteError404ApplicationYaml'],
      },
      ranges: ['4XX: GetNoteError4Xx'],
    });
    expect(modelNames(spec)).toEqual([
      'GetNoteError400',
      'GetNoteError400ApplicationYaml',
      'GetNoteError404',
      'GetNoteError404ApplicationYaml',
      'GetNoteError4Xx',
      'Note',
    ]);
    expect(fieldsOf(spec, 'GetNoteError400ApplicationYaml')).toEqual(['b']);
    expect(fieldsOf(spec, 'GetNoteError404ApplicationYaml')).toEqual(['d']);
    expect(fieldsOf(spec, 'GetNoteError4Xx')).toEqual(['e']);
    expectSound(spec);
  });

  it('shares the JSON entry with `type` and types the YAML entry on its own, on each error', async () => {
    const op = only(await parseWithoutWarnings(doc(paths)));

    for (const error of op.errors) {
      expect(error.contents?.[0].type, String(error.statusCode)).toBe(error.type);
      expect(error.contents?.[1].type, String(error.statusCode)).not.toBe(error.type);
    }
    const [range] = op.rangeResponses!;
    expect(range.contents?.[0].type).toBe(range.type);
  });
});

describe('an error body under a secondary media type', () => {
  it('carries the status code even when the media type is declared on one error only', async () => {
    const spec = await parseWithoutWarnings(
      doc(getNote({ '404': { description: 'gone', content: { ...json(obj({ a: str })), ...yaml(obj({ b: str })) } } })),
    );

    // Before: `GetNoteApplicationYamlError`, the code added only on a clash.
    expect(contentsOf(only(spec).errors[0])).toEqual([
      'application/json: GetNoteError404',
      'application/yaml: GetNoteError404ApplicationYaml',
    ]);
    expect(modelNames(spec)).toEqual(['GetNoteError404', 'GetNoteError404ApplicationYaml', 'Note']);
    expectSound(spec);
  });

  it('is named from the error whether or not the error has a JSON body', async () => {
    const spec = await parseWithoutWarnings(
      doc(getNote({ '404': { description: 'gone', content: { ...yaml(obj({ b: str })), ...text } } })),
    );
    const [error] = only(spec).errors;

    // No JSON media type: `type` is unset and every entry is typed on its own.
    expect(error.type).toBeUndefined();
    expect(contentsOf(error)).toEqual(['application/yaml: GetNoteError404ApplicationYaml', 'text/plain: string']);
    expectSound(spec);
  });

  it('gets a model per status code for one media type, as the JSON bodies do, even when the shapes are identical', async () => {
    const same = obj({ reason: str });
    const spec = await parseWithoutWarnings(
      doc(
        getNote({
          '400': { description: 'bad', content: { ...json(same), ...yaml(same) } },
          '404': { description: 'gone', content: { ...json(same), ...yaml(same) } },
        }),
      ),
    );

    expect(errorNames(only(spec)).errors).toEqual({
      '400': ['application/json: GetNoteError400', 'application/yaml: GetNoteError400ApplicationYaml'],
      '404': ['application/json: GetNoteError404', 'application/yaml: GetNoteError404ApplicationYaml'],
    });
    expect(modelNames(spec)).toEqual([
      'GetNoteError400',
      'GetNoteError400ApplicationYaml',
      'GetNoteError404',
      'GetNoteError404ApplicationYaml',
      'Note',
    ]);
    expectSound(spec);
  });

  it('keeps its vendor suffix and nested objects, and the primary +json body its `<Op>Error<code>`', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        getNote({
          '500': {
            description: 'down',
            content: {
              'application/problem+json': { schema: obj({ title: str }) },
              'application/vnd.note+json; version=2': { schema: obj({ detail: obj({ field: str }) }) },
            },
          },
        }),
      ),
    );
    const [error] = only(spec).errors;

    expect(typeName(error.type)).toBe('GetNoteError500');
    // The media type's fragment is its essence's (`mediaTypeNameFragment`):
    // the parameters are left out when no other key of that essence sits
    // beside it.
    expect(contentsOf(error)).toEqual([
      'application/problem+json: GetNoteError500',
      'application/vnd.note+json; version=2: GetNoteError500ApplicationVndNoteJson',
    ]);
    expect(fieldsOf(spec, 'GetNoteError500ApplicationVndNoteJsonDetail')).toEqual(['field']);
    expectSound(spec);
  });

  it('is named per operation, so two operations with the same inline YAML body get two models', async () => {
    const yamlError = { description: 'gone', content: { ...json(obj({ a: str })), ...yaml(obj({ b: str })) } };
    const spec = await parseWithoutWarnings(
      doc({
        ...getNote({ '404': yamlError }),
        '/pets/{id}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
            responses: { '200': ok, '404': yamlError },
          },
        },
      }),
    );
    const ops = operations(spec);

    expect(contentsOf(ops.get('getNote')!.errors[0])).toEqual([
      'application/json: GetNoteError404',
      'application/yaml: GetNoteError404ApplicationYaml',
    ]);
    expect(contentsOf(ops.get('getPet')!.errors[0])).toEqual([
      'application/json: GetPetError404',
      'application/yaml: GetPetError404ApplicationYaml',
    ]);
    expectSound(spec);
  });

  it('is named from the path when the operation has no operationId, as the JSON body is', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        getNote(
          {
            '404': { description: 'gone', content: { ...json(obj({ a: str })), ...yaml(obj({ b: str })) } },
            '4XX': { description: 'rejected', content: { ...json(obj({ c: str })), ...yaml(obj({ d: str })) } },
          },
          {},
        ),
      ),
    );
    const op = only(spec);

    expect(contentsOf(op.errors[0])).toEqual([
      'application/json: NotesByIdGetError404',
      'application/yaml: NotesByIdGetError404ApplicationYaml',
    ]);
    expect(contentsOf(op.rangeResponses![0])).toEqual([
      'application/json: NotesByIdGetError4Xx',
      'application/yaml: NotesByIdGetError4XxApplicationYaml',
    ]);
    expectSound(spec);
  });
});

describe('a 4XX or 5XX range body is an error body', () => {
  it('is named `<Op>Error` + the range key, PascalCased as every identifier is, for 4XX and for 5XX', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        getNote({
          '4XX': { description: 'rejected', content: json(obj({ code: str })) },
          '5XX': { description: 'down', content: json(obj({ detail: obj({ field: str }) })) },
        }),
      ),
    );

    // Before: `GetNoteClientErrorResponse` and `GetNoteServerErrorResponse`,
    // the fallback-body scheme. `4XX` itself does not survive PascalCasing.
    expect(errorNames(only(spec)).ranges).toEqual(['4XX: GetNoteError4Xx', '5XX: GetNoteError5Xx']);
    expect(modelNames(spec)).toEqual(['GetNoteError4Xx', 'GetNoteError5Xx', 'GetNoteError5XxDetail', 'Note']);
    expectSound(spec);
  });

  it('names its secondary bodies `<Op>Error<range><MediaType>`, as an explicit status code does', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        getNote({
          '4XX': {
            description: 'rejected',
            content: { ...json(obj({ code: str })), ...yaml(obj({ reason: str })), ...text },
          },
        }),
      ),
    );
    const [range] = only(spec).rangeResponses!;

    // Before: `GetNoteClientErrorApplicationYamlResponse`.
    expect(contentsOf(range)).toEqual([
      'application/json: GetNoteError4Xx',
      'application/yaml: GetNoteError4XxApplicationYaml',
      'text/plain: string',
    ]);
    expect(range.contents?.[0].type).toBe(range.type);
    expect(fieldsOf(spec, 'GetNoteError4XxApplicationYaml')).toEqual(['reason']);
    expectSound(spec);
  });

  it('leaves `default` and the 1XX, 2XX and 3XX ranges on the label scheme, bodies and secondary bodies alike', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        getNote({
          default: { description: 'd', content: { ...json(obj({ a: str })), ...yaml(obj({ b: str })) } },
          '1XX': { description: 'i', content: json(obj({ c: str })) },
          '2XX': { description: 's', content: { ...json(obj({ d: str })), ...yaml(obj({ e: str })) } },
          '3XX': { description: 'r', content: json(obj({ f: str })) },
        }),
      ),
    );
    const op = only(spec);

    expect(typeName(op.defaultResponse?.type)).toBe('GetNoteDefaultResponse');
    expect(contentsOf(op.defaultResponse!)).toEqual([
      'application/json: GetNoteDefaultResponse',
      'application/yaml: GetNoteDefaultApplicationYamlResponse',
    ]);
    expect(errorNames(op).ranges).toEqual([
      '1XX: GetNoteInformationalResponse',
      '2XX: GetNoteSuccessResponse',
      '3XX: GetNoteRedirectResponse',
    ]);
    expect(contentsOf(op.rangeResponses![1])).toEqual([
      'application/json: GetNoteSuccessResponse',
      'application/yaml: GetNoteSuccessApplicationYamlResponse',
    ]);
    expectSound(spec);
  });

  it('keeps the range label as the qualifier of its headers, which are not bodies', async () => {
    const meta = (properties: Record<string, unknown>) => ({ 'X-Meta': { schema: obj(properties) } });
    const spec = await parseWithoutWarnings(
      doc(
        getNote({
          '200': { ...ok, headers: meta({ a: str }) },
          '4XX': { description: 'rejected', headers: meta({ b: str }), content: json(obj({ code: str })) },
        }),
      ),
    );
    const op = only(spec);

    expect(typeName(op.responseHeaders?.[0].type)).toBe('NotesXMeta');
    expect(typeName(op.rangeResponses?.[0].headers?.[0].type)).toBe('NotesXMetaClientError');
    expect(typeName(op.rangeResponses?.[0].type)).toBe('GetNoteError4Xx');
    expectSound(spec);
  });

  it('keeps a component response its component name at a 4XX, as at a 404 and at `default`', async () => {
    const problem = {
      description: 'a problem',
      content: { ...json(obj({ title: str })), ...yaml(obj({ summary: str })) },
    };
    const spec = await parseWithoutWarnings(
      doc(
        {
          ...getNote({ '4XX': { $ref: '#/components/responses/Problem' } }),
          '/pets/{id}': {
            get: {
              operationId: 'getPet',
              parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
              responses: {
                '200': ok,
                '404': { $ref: '#/components/responses/Problem' },
                default: { $ref: '#/components/responses/Problem' },
              },
            },
          },
        },
        {},
        { Problem: problem },
      ),
    );
    const ops = operations(spec);

    expect(contentsOf(ops.get('getNote')!.rangeResponses![0])).toEqual([
      'application/json: ProblemResponse',
      'application/yaml: ProblemApplicationYamlResponse',
    ]);
    expect(contentsOf(ops.get('getPet')!.errors[0])).toEqual([
      'application/json: ProblemResponse',
      'application/yaml: ProblemApplicationYamlResponse',
    ]);
    expect(contentsOf(ops.get('getPet')!.defaultResponse!)).toEqual([
      'application/json: ProblemResponse',
      'application/yaml: ProblemApplicationYamlResponse',
    ]);
    expect(modelNames(spec)).toEqual(['Note', 'ProblemApplicationYamlResponse', 'ProblemResponse']);
    expectSound(spec);
  });
});

describe('a taken name steps by `Body`, as `<Op>Error<code>` does', () => {
  it('moves a range body past a component schema of its name with another shape', async () => {
    const spec = await parseWithoutWarnings(
      doc(getNote({ '4XX': { description: 'rejected', content: json(obj({ code: str })) } }), {
        GetNoteError4Xx: obj({ message: str }),
      }),
    );

    // Before: the range body stepped by number (`…Response2`), as a `default` body does.
    expect(typeName(only(spec).rangeResponses![0].type)).toBe('GetNoteError4XxBody');
    expect(fieldsOf(spec, 'GetNoteError4Xx')).toEqual(['message']);
    expect(fieldsOf(spec, 'GetNoteError4XxBody')).toEqual(['code']);
    expectSound(spec, ['Note', 'GetNoteError4Xx']);
  });

  it('moves a secondary error body past a component schema of its name with another shape', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        getNote({ '404': { description: 'gone', content: { ...json(obj({ a: str })), ...yaml(obj({ b: str })) } } }),
        { GetNoteError404ApplicationYaml: obj({ message: str }) },
      ),
    );

    // Before: `<Op><MediaType>Error` stepped to its status code, then by number.
    expect(contentsOf(only(spec).errors[0])).toEqual([
      'application/json: GetNoteError404',
      'application/yaml: GetNoteError404ApplicationYamlBody',
    ]);
    expect(fieldsOf(spec, 'GetNoteError404ApplicationYaml')).toEqual(['message']);
    expect(fieldsOf(spec, 'GetNoteError404ApplicationYamlBody')).toEqual(['b']);
    expectSound(spec, ['Note', 'GetNoteError404ApplicationYaml']);
  });

  it('shares a component schema of its name that admits its shape, minting nothing', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        getNote({
          '404': { description: 'gone', content: { ...json(obj({ a: str })), ...yaml(obj({ b: str })) } },
          '4XX': { description: 'rejected', content: json(obj({ code: str })) },
        }),
        { GetNoteError404ApplicationYaml: obj({ b: str }), GetNoteError4Xx: obj({ code: str }) },
      ),
    );
    const op = only(spec);

    expect(contentsOf(op.errors[0])).toEqual([
      'application/json: GetNoteError404',
      'application/yaml: GetNoteError404ApplicationYaml',
    ]);
    expect(typeName(op.rangeResponses![0].type)).toBe('GetNoteError4Xx');
    expect(modelNames(spec)).toEqual(['GetNoteError404', 'GetNoteError404ApplicationYaml', 'GetNoteError4Xx', 'Note']);
    expectSound(spec, ['Note', 'GetNoteError404ApplicationYaml', 'GetNoteError4Xx']);
  });
});

describe('an enum body shared through components/responses steps by number at every site, never by `Body`', () => {
  const enumOf = (values: string[]): Doc => ({ type: 'string', enum: values });
  const problemRef = { $ref: '#/components/responses/Problem' };
  const noteOp = (operationId: string, responses: Doc): Doc => ({
    get: { operationId, responses: { '200': ok, ...responses } },
  });
  /** `Problem`, whose JSON body is an inline enum. */
  const problemEnum = { description: 'p', content: json(enumOf(['wait', 'later'])) };
  /** `Problem`, whose JSON body is an object and whose YAML body is an inline enum. */
  const problemYamlEnum = {
    description: 'p',
    content: { ...json(obj({ title: str })), ...yaml(enumOf(['wait', 'later'])) },
  };
  const enumsOf = (spec: ApiSpec): string[] =>
    spec.enums.map((e) => `${e.name} [${e.values.map((v) => v.value).join(',')}]`).sort();

  it.each([
    ['a 4XX and a default', { '4XX': problemRef }, { default: problemRef }],
    ['a 404 and a default', { '404': problemRef }, { default: problemRef }],
    ['a 404 and a 4XX', { '404': problemRef }, { '4XX': problemRef }],
    ['a 5XX and a 200', { '5XX': problemRef }, { '200': problemRef }],
  ])('settles on one enum from %s, past a component enum of its name', async (_label, first: Doc, second: Doc) => {
    const spec = await parseWithoutWarnings(
      doc(
        { '/a': noteOp('opA', first), '/b': noteOp('opB', second) },
        { ProblemResponse: enumOf(['old', 'new']) },
        { Problem: problemEnum },
      ),
    );
    const ops = operations(spec);

    // Before: the error site stepped by `Body` (`ProblemResponseBody`) and
    // the fallback site by number (`ProblemResponse2`): two enums for one
    // component body.
    expect(enumsOf(spec)).toEqual(['ProblemResponse [old,new]', 'ProblemResponse2 [wait,later]']);
    for (const op of ops.values()) {
      const bodies = [
        ...op.errors.map((e) => e.type),
        op.defaultResponse?.type,
        ...(op.rangeResponses ?? []).map((r) => r.type),
        ...(op.successResponses?.map((s) => s.type) ?? []),
        op.response,
      ].filter((t) => t?.kind === 'enum');
      expect(bodies.length, op.name).toBeGreaterThan(0);
      for (const body of bodies)
        expect(body, op.name).toEqual({ kind: 'enum', name: 'ProblemResponse2', values: ['wait', 'later'] });
    }
    expectSound(spec);
  });

  it('steps by number, never by `Body`, when the component is reached through a chain of refs at a 4XX and at a 404', async () => {
    // A chain is named after the component the operation wrote (`Alias` →
    // `AliasResponse`, see `sharedResponseModelName`), so the two sites of
    // the chain share one enum, and neither steps by `Body` past the
    // component enum of that name.
    const aliasRef = { $ref: '#/components/responses/Alias' };
    const spec = await parseWithoutWarnings(
      doc(
        { '/a': noteOp('opA', { '4XX': aliasRef }), '/b': noteOp('opB', { '404': aliasRef, default: problemRef }) },
        { AliasResponse: enumOf(['old', 'new']) },
        { Alias: problemRef, Problem: problemEnum },
      ),
    );
    const ops = operations(spec);

    expect(enumsOf(spec)).toEqual([
      'AliasResponse [old,new]',
      'AliasResponse2 [wait,later]',
      'ProblemResponse [wait,later]',
    ]);
    expect(typeName(ops.get('opA')!.rangeResponses![0].type)).toBe('AliasResponse2');
    expect(typeName(ops.get('opB')!.errors[0].type)).toBe('AliasResponse2');
    expect(typeName(ops.get('opB')!.defaultResponse!.type)).toBe('ProblemResponse');
    expectSound(spec);
  });

  it.each([
    ['a 404 and a 200', { '404': problemRef }, { '200': problemRef }],
    ['a 4XX and a default', { '4XX': problemRef }, { default: problemRef }],
    ['a 5XX and a 404', { '5XX': problemRef }, { '404': problemRef }],
  ])(
    'shares one model and one enum for the secondary media type of a component returned at %s',
    async (_label, first: Doc, second: Doc) => {
      const spec = await parseWithoutWarnings(
        doc(
          { '/a': noteOp('opA', first), '/b': noteOp('opB', second) },
          { ProblemApplicationYamlResponse: enumOf(['old', 'new']) },
          { Problem: problemYamlEnum },
        ),
      );

      // Before: `ProblemApplicationYamlResponseBody` at the error site beside
      // `ProblemApplicationYamlResponse2` at the other.
      expect(modelNames(spec)).toEqual(['Note', 'ProblemResponse']);
      expect(enumsOf(spec)).toEqual([
        'ProblemApplicationYamlResponse [old,new]',
        'ProblemApplicationYamlResponse2 [wait,later]',
      ]);
      for (const op of operations(spec).values()) {
        // The one entry of each operation that returns `Problem`: the `200`
        // of the other paths is `Note`, under `application/json` alone.
        const entries = [
          ...op.errors,
          ...(op.defaultResponse ? [op.defaultResponse] : []),
          ...(op.rangeResponses ?? []),
          ...(op.successResponses ?? [{ contents: op.responseContents }]),
        ].filter((entry) => entry.contents?.some((content) => content.contentType === 'application/yaml'));
        expect(entries.length, op.name).toBe(1);
        expect(contentsOf(entries[0]), op.name).toEqual([
          'application/json: ProblemResponse',
          'application/yaml: ProblemApplicationYamlResponse2',
        ]);
      }
      expectSound(spec);
    },
  );

  it('still steps an operation-owned enum body by `Body` beside a shared one', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        {
          '/a': noteOp('opA', { '4XX': problemRef, '5XX': { description: 'down', content: json(enumOf(['x', 'y'])) } }),
          '/b': noteOp('opB', { default: problemRef }),
        },
        { ProblemResponse: enumOf(['old', 'new']), OpAError5Xx: enumOf(['old', 'new']) },
        { Problem: problemEnum },
      ),
    );
    const opA = operations(spec).get('opA')!;

    expect(enumsOf(spec)).toEqual([
      'OpAError5Xx [old,new]',
      'OpAError5XxBody [x,y]',
      'ProblemResponse [old,new]',
      'ProblemResponse2 [wait,later]',
    ]);
    expect(opA.rangeResponses!.map((r) => `${r.range}: ${typeName(r.type)}`)).toEqual([
      '4XX: ProblemResponse2',
      '5XX: OpAError5XxBody',
    ]);
    expectSound(spec);
  });
});

describe('an error body that is itself an inline enum', () => {
  const enumOf = (values: string[]): Doc => ({ type: 'string', enum: values });

  it('is promoted to spec.enums under the same names, for a range and for a secondary media type', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        getNote({
          '404': { description: 'gone', content: { ...json(obj({ a: str })), ...yaml(enumOf(['gone', 'missing'])) } },
          '5XX': { description: 'down', content: json(enumOf(['wait', 'later'])) },
        }),
      ),
    );
    const op = only(spec);

    expect(op.errors[0].contents?.[1].type).toEqual({
      kind: 'enum',
      name: 'GetNoteError404ApplicationYaml',
      values: ['gone', 'missing'],
    });
    expect(op.rangeResponses![0].type).toEqual({ kind: 'enum', name: 'GetNoteError5Xx', values: ['wait', 'later'] });
    expect(enumValues(spec, 'GetNoteError404ApplicationYaml')).toEqual(['gone', 'missing']);
    expect(enumValues(spec, 'GetNoteError5Xx')).toEqual(['wait', 'later']);
    expectSound(spec);
  });

  it('steps to `…Body` past a component enum of its name with other members, as a 404 enum body does', async () => {
    const spec = await parseWithoutWarnings(
      doc(
        getNote({
          '404': { description: 'gone', content: { ...json(obj({ a: str })), ...yaml(enumOf(['gone', 'missing'])) } },
          '5XX': { description: 'down', content: json(enumOf(['wait', 'later'])) },
        }),
        { GetNoteError404ApplicationYaml: enumOf(['old', 'new']), GetNoteError5Xx: enumOf(['old', 'new']) },
      ),
    );
    const op = only(spec);

    // Before: a range body's enum stepped by number (`…2`).
    expect(op.errors[0].contents?.[1].type).toEqual({
      kind: 'enum',
      name: 'GetNoteError404ApplicationYamlBody',
      values: ['gone', 'missing'],
    });
    expect(op.rangeResponses![0].type).toEqual({
      kind: 'enum',
      name: 'GetNoteError5XxBody',
      values: ['wait', 'later'],
    });
    expect(enumValues(spec, 'GetNoteError404ApplicationYaml')).toEqual(['old', 'new']);
    expect(enumValues(spec, 'GetNoteError404ApplicationYamlBody')).toEqual(['gone', 'missing']);
    expect(enumValues(spec, 'GetNoteError5Xx')).toEqual(['old', 'new']);
    expect(enumValues(spec, 'GetNoteError5XxBody')).toEqual(['wait', 'later']);
    expectSound(spec);
  });
});

describe('past two taken names an error-site enum numbers under `Body`, as the object bodies do', () => {
  const enumOf = (values: string[]): Doc => ({ type: 'string', enum: values });
  /** Component enums owning both `<name>` and `<name>Body`, with other members than the inline body. */
  const twoTakenEnums = (name: string): Doc => ({
    [name]: enumOf(['old', 'new']),
    [`${name}Body`]: enumOf(['older', 'newer']),
  });
  /** Component schemas owning both `<name>` and `<name>Body`, with other shapes than the inline body. */
  const twoTakenModels = (name: string): Doc => ({
    [name]: obj({ message: str }),
    [`${name}Body`]: obj({ other: str }),
  });

  const sites: Array<[label: string, name: string, pick: (op: Operation) => TypeRef | undefined]> = [
    ['a 404', 'GetNoteError404', (op) => op.errors[0].type],
    ['a 5XX range', 'GetNoteError5Xx', (op) => op.rangeResponses![0].type],
    ['a secondary media type of a 404', 'GetNoteError404ApplicationYaml', (op) => op.errors[0].contents![1].type],
  ];
  /** The site's responses, its body `schema` under JSON (or under YAML beside a JSON object, for the secondary site). */
  const responsesOf = (label: string, schema: Doc): Doc =>
    label === 'a 5XX range'
      ? { '5XX': { description: 'down', content: json(schema) } }
      : label === 'a 404'
        ? { '404': { description: 'gone', content: json(schema) } }
        : { '404': { description: 'gone', content: { ...json(obj({ a: str })), ...yaml(schema) } } };

  it.each(sites)('an enum body at %s is `<name>Body2`, not `<name>2`', async (label, name, pick) => {
    const spec = await parseWithoutWarnings(
      doc(getNote(responsesOf(label, enumOf(['gone', 'missing']))), twoTakenEnums(name)),
    );

    // Before: `Body` was tried once and the numbers went on the bare name
    // (`GetNoteError5Xx2`), while an object body in the same spot took
    // `GetNoteError5XxBody2`.
    expect(pick(only(spec))).toEqual({ kind: 'enum', name: `${name}Body2`, values: ['gone', 'missing'] });
    expect(enumValues(spec, name)).toEqual(['old', 'new']);
    expect(enumValues(spec, `${name}Body`)).toEqual(['older', 'newer']);
    expect(enumValues(spec, `${name}Body2`)).toEqual(['gone', 'missing']);
    expect(spec.enums.map((e) => e.name)).not.toContain(`${name}2`);
    expectSound(spec);
  });

  it.each(sites)('an object body at %s takes the same `<name>Body2`', async (label, name, pick) => {
    const spec = await parseWithoutWarnings(doc(getNote(responsesOf(label, obj({ code: str }))), twoTakenModels(name)));

    expect(typeName(pick(only(spec)))).toBe(`${name}Body2`);
    expect(fieldsOf(spec, `${name}Body2`)).toEqual(['code']);
    expect(modelNames(spec)).not.toContain(`${name}2`);
    expectSound(spec, ['Note', name, `${name}Body`]);
  });

  it.each(sites)(
    'an enum body at %s shares a `<name>Body2` that already holds its members',
    async (label, name, pick) => {
      const spec = await parseWithoutWarnings(
        doc(getNote(responsesOf(label, enumOf(['gone', 'missing']))), {
          ...twoTakenEnums(name),
          [`${name}Body2`]: enumOf(['gone', 'missing']),
        }),
      );

      // A numbered step under `Body` with the same members is shared, never
      // followed by a `…Body3`.
      expect(pick(only(spec))).toEqual({ kind: 'enum', name: `${name}Body2`, values: ['gone', 'missing'] });
      expect(spec.enums.filter((e) => e.name.startsWith(name)).map((e) => e.name)).toEqual([
        name,
        `${name}Body`,
        `${name}Body2`,
      ]);
      expectSound(spec);
    },
  );
});
