import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collectModelRefs, collectOperationTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

// The parser materializes every inline 4xx/5xx body as `<Op>Error<code>`
// (#243, #356); a document that writes its errors inline, one schema per
// error code, declares hundreds of such models that differ only in a `const`
// or in prose. By default the models only error sites reach now fold onto
// shared models named by shape — `ErrorBody`, `ErrorBodyWithCode`, a
// pinned value's `RateLimitExceededErrorBody` — with the pinned codes
// gathered into one `ErrorBodyCode` enum (src/parser/collapse-error-bodies.ts).

type Doc = Record<string, unknown>;
const str = { type: 'string' };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)): Doc => ({
  type: 'object',
  properties,
  required,
});
const json = (schema: Doc) => ({ 'application/json': { schema } });
const messageBody = (description = 'A human-readable description of the error.'): Doc =>
  obj({ message: { ...str, description } });
const codedBody = (code: string): Doc =>
  obj({
    code: { type: 'string', const: code, description: 'The error code identifying the type of error.' },
    message: { ...str, description: 'A human-readable description of the error.' },
  });
const ok = { description: 'ok', content: json({ $ref: '#/components/schemas/Note' }) };
const noteComponent = { Note: obj({ title: str }) };

function doc(paths: Doc, schemas: Doc = {}, responses?: Doc): Doc {
  return {
    openapi: '3.1.0',
    info: { title: 'collapse error bodies', version: '1' },
    paths,
    components: { schemas: { ...noteComponent, ...schemas }, ...(responses && { responses }) },
  };
}

/** `GET /<name>/{id}` (`get<Name>`) returning `Note`, with the given other responses. */
function getOp(name: string, responses: Doc): Doc {
  return {
    [`/${name}/{id}`]: {
      get: {
        operationId: `get${name[0].toUpperCase()}${name.slice(1)}`,
        parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
        responses: { '200': ok, ...responses },
      },
    },
  };
}

async function parse(spec: Doc, options?: Parameters<typeof parseSpec>[1]): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-collapse-error-bodies-'));
  const file = path.join(dir, 'spec.json');
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    return await parseSpec(file, options);
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
function op(spec: ApiSpec, name: string): Operation {
  const found = operations(spec).get(name);
  expect(found, `operation ${name}`).toBeDefined();
  return found!;
}
function errorType(spec: ApiSpec, opName: string, status: number): TypeRef | undefined {
  return op(spec, opName).errors.find((e) => e.statusCode === status)?.type;
}
const modelNames = (spec: ApiSpec): string[] => spec.models.map((m) => m.name).sort();
const fieldSummary = (spec: ApiSpec, name: string): string[] | undefined =>
  spec.models
    .find((m) => m.name === name)
    ?.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${describe_(f.type)}`);
function describe_(type: TypeRef): string {
  switch (type.kind) {
    case 'model':
    case 'enum':
      return type.name;
    case 'literal':
      return JSON.stringify(type.value);
    case 'primitive':
      return type.type;
    case 'array':
      return `${describe_(type.items)}[]`;
    case 'nullable':
      return `${describe_(type.inner)} | null`;
    case 'union':
      return type.variants.map(describe_).join(' | ');
    case 'map':
      return `map<${describe_(type.valueType)}>`;
  }
}
const enumValues = (spec: ApiSpec, name: string): string[] | undefined =>
  spec.enums.find((e) => e.name === name)?.values.map((v) => String(v.value));

/** Nothing dangles, nothing is orphaned, and no model is named like an enum. */
function expectSound(spec: ApiSpec, componentNames: readonly string[] = ['Note']): void {
  const names = new Set(spec.models.map((m) => m.name));
  const referenced = new Set<string>();
  const dangling: string[] = [];
  for (const operation of operations(spec).values()) {
    for (const ref of collectOperationTypeRefs(operation)) {
      for (const name of collectModelRefs(ref)) {
        referenced.add(name);
        if (!names.has(name)) dangling.push(`${operation.name} → ${name}`);
      }
    }
  }
  for (const model of spec.models) {
    for (const field of model.fields) {
      for (const name of collectModelRefs(field.type)) {
        referenced.add(name);
        if (!names.has(name)) dangling.push(`${model.name}.${field.name} → ${name}`);
      }
    }
  }
  expect(dangling).toEqual([]);
  const orphaned = spec.models
    .map((m) => m.name)
    .filter((name) => !componentNames.includes(name) && !referenced.has(name));
  expect(orphaned).toEqual([]);
  const enumNames = new Set(spec.enums.map((e) => e.name));
  expect(spec.models.map((m) => m.name).filter((name) => enumNames.has(name))).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('identical inline error bodies across operations', () => {
  const spec = doc({
    ...getOp('pets', { '404': { description: 'No such pet', content: json(messageBody()) } }),
    ...getOp('notes', { '404': { description: 'No such note', content: json(messageBody()) } }),
    ...getOp('tags', { '403': { description: 'Forbidden', content: json(messageBody()) } }),
  });

  it('fold onto one `ErrorBody` model that every error references, and no `<Op>Error<code>` survives', async () => {
    const ir = await parseWithoutWarnings(spec);
    expect(modelNames(ir)).toEqual(['ErrorBody', 'Note']);
    expect(fieldSummary(ir, 'ErrorBody')).toEqual(['message: string']);
    for (const [name, status] of [
      ['getPets', 404],
      ['getNotes', 404],
      ['getTags', 403],
    ] as const) {
      expect(errorType(ir, name, status)).toEqual({ kind: 'model', name: 'ErrorBody' });
    }
    expectSound(ir);
  });

  it("keep each error's own description on the `errors[]` entry", async () => {
    const ir = await parseWithoutWarnings(spec);
    expect(op(ir, 'getPets').errors[0].description).toBe('No such pet');
    expect(op(ir, 'getNotes').errors[0].description).toBe('No such note');
  });

  it("keep a field's description only when every folded body wrote the same one", async () => {
    const same = await parseWithoutWarnings(spec);
    expect(same.models.find((m) => m.name === 'ErrorBody')?.fields[0].description).toBe(
      'A human-readable description of the error.',
    );
    const differing = await parseWithoutWarnings(
      doc({
        ...getOp('pets', { '404': { description: 'nf', content: json(messageBody('The pet is gone.')) } }),
        ...getOp('notes', { '404': { description: 'nf', content: json(messageBody('The note is gone.')) } }),
      }),
    );
    expect(differing.models.find((m) => m.name === 'ErrorBody')?.fields[0].description).toBeUndefined();
  });

  it('stay one model per operation under `collapseErrorBodies: false`', async () => {
    const ir = await parse(spec, { collapseErrorBodies: false });
    expect(modelNames(ir)).toEqual(['GetNotesError404', 'GetPetsError404', 'GetTagsError403', 'Note']);
  });
});

describe('bodies pinned to different error codes', () => {
  const spec = doc({
    ...getOp('pets', {
      '400': { description: 'bad', content: json(codedBody('pet_name_required')) },
      '409': { description: 'dup', content: json(codedBody('pet_already_exists')) },
    }),
    ...getOp('notes', {
      '400': { description: 'bad', content: json(obj({ code: str, message: str })) },
    }),
  });

  it('fold onto one `ErrorBodyWithCode` whose `code` is a shared enum of every pinned value, lifted into spec.enums', async () => {
    const ir = await parseWithoutWarnings(spec);
    expect(modelNames(ir)).toEqual(['ErrorBodyWithCode', 'Note']);
    expect(fieldSummary(ir, 'ErrorBodyWithCode')).toEqual(['code: ErrorBodyCode', 'message: string']);
    expect(enumValues(ir, 'ErrorBodyCode')).toEqual(['pet_already_exists', 'pet_name_required']);
    expect(errorType(ir, 'getPets', 400)).toEqual({ kind: 'model', name: 'ErrorBodyWithCode' });
    expect(errorType(ir, 'getPets', 409)).toEqual({ kind: 'model', name: 'ErrorBodyWithCode' });
    expect(errorType(ir, 'getNotes', 400)).toEqual({ kind: 'model', name: 'ErrorBodyWithCode' });
    expectSound(ir);
  });

  it('read an inline `enum` of codes as pinned values too', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', { '400': { description: 'bad', content: json(codedBody('pet_name_required')) } }),
        ...getOp('notes', {
          '400': {
            description: 'bad',
            content: json(obj({ code: { type: 'string', enum: ['note_locked', 'note_archived'] }, message: str })),
          },
        }),
      }),
    );
    expect(enumValues(ir, 'ErrorBodyCode')).toEqual(['note_archived', 'note_locked', 'pet_name_required']);
    expect(ir.enums.map((e) => e.name)).toEqual(['ErrorBodyCode']);
  });

  it('turn a `oneOf` of same-shaped variants into one reference, and keep distinct shapes as a union', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        getOp('pets', {
          '422': {
            description: 'invalid',
            content: json({ oneOf: [codedBody('idp_metadata_fetch_failed'), codedBody('invalid_idp_sso_url')] }),
          },
          '400': {
            description: 'bad',
            content: json({ oneOf: [messageBody(), codedBody('pet_name_required')] }),
          },
        }),
      ),
    );
    expect(errorType(ir, 'getPets', 422)).toEqual({ kind: 'model', name: 'ErrorBodyWithCode' });
    expect(errorType(ir, 'getPets', 400)).toEqual({
      kind: 'union',
      variants: [
        { kind: 'model', name: 'ErrorBody' },
        { kind: 'model', name: 'ErrorBodyWithCode' },
      ],
      compositionKind: 'oneOf',
    });
    expect(enumValues(ir, 'ErrorBodyCode')).toEqual([
      'idp_metadata_fetch_failed',
      'invalid_idp_sso_url',
      'pet_name_required',
    ]);
    expectSound(ir);
  });
});

describe('a shape every member pins to one value', () => {
  it('is named from the value and keeps the literal', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '429': {
            description: 'slow down',
            content: json(
              obj({
                code: { type: 'string', const: 'rate_limit_exceeded' },
                message: str,
                retry_after: { type: 'integer' },
              }),
            ),
          },
        }),
        ...getOp('notes', {
          '429': {
            description: 'slow down',
            content: json(
              obj({
                code: { type: 'string', const: 'rate_limit_exceeded' },
                message: str,
                retry_after: { type: 'integer' },
              }),
            ),
          },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual(['Note', 'RateLimitExceededErrorBody']);
    expect(fieldSummary(ir, 'RateLimitExceededErrorBody')).toEqual([
      'code: "rate_limit_exceeded"',
      'message: string',
      'retry_after: integer',
    ]);
    expect(ir.enums).toEqual([]);
    expectSound(ir);
  });

  it('widens a lone pinned value beside free strings to `string` and names the shape from its fields', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '400': { description: 'bad', content: json(obj({ message: { type: 'string', const: 'Must use SSO' } })) },
        }),
        ...getOp('notes', { '400': { description: 'bad', content: json(messageBody()) } }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'Note']);
    expect(fieldSummary(ir, 'ErrorBody')).toEqual(['message: string']);
  });
});

describe('nested error-only models', () => {
  it('fold with their parents and are named from the parent and field', async () => {
    const validation = obj({
      message: str,
      errors: { type: 'array', items: obj({ code: str, field: str }) },
    });
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', { '422': { description: 'invalid', content: json(validation) } }),
        ...getOp('notes', { '422': { description: 'invalid', content: json(validation) } }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBodyWithErrors', 'ErrorBodyWithErrorsError', 'Note']);
    expect(fieldSummary(ir, 'ErrorBodyWithErrors')).toEqual(['message: string', 'errors: ErrorBodyWithErrorsError[]']);
    expect(fieldSummary(ir, 'ErrorBodyWithErrorsError')).toEqual(['code: string', 'field: string']);
    expectSound(ir);
  });
});

describe('what the pass leaves alone', () => {
  it('a `$ref` to a component schema, and a model a success response also reaches', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        {
          ...getOp('pets', {
            '404': { description: 'nf', content: json({ $ref: '#/components/schemas/Problem' }) },
            '409': { description: 'dup', content: json({ $ref: '#/components/schemas/Note' }) },
          }),
          ...getOp('notes', {
            '404': { description: 'nf', content: json({ $ref: '#/components/schemas/Problem' }) },
          }),
        },
        { Problem: obj({ message: str }) },
      ),
    );
    expect(modelNames(ir)).toEqual(['Note', 'Problem']);
    expect(errorType(ir, 'getPets', 404)).toEqual({ kind: 'model', name: 'Problem' });
    expect(errorType(ir, 'getPets', 409)).toEqual({ kind: 'model', name: 'Note' });
    expectSound(ir, ['Note', 'Problem']);
  });

  it('a body shared through `components/responses`, named after the component wherever it is returned', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        {
          ...getOp('pets', { '404': { $ref: '#/components/responses/NotFound' } }),
          ...getOp('notes', {
            '404': { $ref: '#/components/responses/NotFound' },
            '403': { description: 'forbidden', content: json(messageBody()) },
          }),
        },
        {},
        { NotFound: { description: 'not found', content: json(messageBody()) } },
      ),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'NotFoundResponse', 'Note']);
    expect(errorType(ir, 'getPets', 404)).toEqual({ kind: 'model', name: 'NotFoundResponse' });
    expect(errorType(ir, 'getNotes', 404)).toEqual({ kind: 'model', name: 'NotFoundResponse' });
    expect(errorType(ir, 'getNotes', 403)).toEqual({ kind: 'model', name: 'ErrorBody' });
    expectSound(ir);
  });
});

describe('the shared name', () => {
  it('steps by number past a component schema that owns it', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        {
          ...getOp('pets', { '404': { description: 'nf', content: json(messageBody()) } }),
          ...getOp('notes', { '404': { description: 'nf', content: json(messageBody()) } }),
        },
        { ErrorBody: obj({ unrelated: str }) },
      ),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'ErrorBody2', 'Note']);
    expect(fieldSummary(ir, 'ErrorBody')).toEqual(['unrelated: string']);
    expect(errorType(ir, 'getPets', 404)).toEqual({ kind: 'model', name: 'ErrorBody2' });
    expectSound(ir, ['Note', 'ErrorBody']);
  });

  it('ignores `x-` extensions and examples when deciding what folds', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '404': {
            description: 'nf',
            content: json({ ...messageBody(), 'x-inline-with-overrides': true, example: { message: 'gone' } }),
          },
        }),
        ...getOp('notes', { '404': { description: 'nf', content: json(messageBody()) } }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'Note']);
    expect(ir.models.find((m) => m.name === 'ErrorBody')?.extensions).toBeUndefined();
  });
});

describe('every error site', () => {
  it('is rewritten: secondary media types and `4XX`/`5XX` range bodies alike', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '404': {
            description: 'nf',
            content: { ...json(messageBody()), 'application/yaml': { schema: messageBody() } },
          },
          '4XX': { description: 'client error', content: json(codedBody('client_error')) },
          '5XX': { description: 'server error', content: json(codedBody('server_error')) },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'ErrorBodyWithCode', 'Note']);
    const notFound = op(ir, 'getPets').errors.find((e) => e.statusCode === 404)!;
    expect(notFound.type).toEqual({ kind: 'model', name: 'ErrorBody' });
    expect(notFound.contents?.map((c) => `${c.contentType}: ${describe_(c.type)}`)).toEqual([
      'application/json: ErrorBody',
      'application/yaml: ErrorBody',
    ]);
    expect(op(ir, 'getPets').rangeResponses?.map((r) => `${r.range}: ${describe_(r.type!)}`)).toEqual([
      '4XX: ErrorBodyWithCode',
      '5XX: ErrorBodyWithCode',
    ]);
    expect(enumValues(ir, 'ErrorBodyCode')).toEqual(['client_error', 'server_error']);
    expectSound(ir);
  });
});
