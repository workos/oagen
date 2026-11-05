import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { collectModelRefs, collectOperationTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

// The parser materializes every inline 4xx/5xx body as `<Op>Error<code>`
// (#243, #356); a document that writes its errors inline, one schema per
// error code, declares hundreds of such models that differ only in a `const`
// or in prose. By default the models only error sites reach now fold onto
// shared models named by shape — `ErrorBody`, `ErrorBodyWithCode`, a
// pinned value's `RateLimitExceededErrorBody` — with the pinned codes
// gathered into one `ErrorBodyCode` enum (src/parser/collapse-error-bodies.ts).
// A name is never numbered: a shape whose name something else holds is left
// as the parser materialized it, with a warning.

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

async function parseWithoutWarnings(spec: Doc, options?: Parameters<typeof parseSpec>[1]): Promise<ApiSpec> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parse(spec, options);
    expect(warn.mock.calls).toEqual([]);
    return ir;
  } finally {
    warn.mockRestore();
  }
}

/** Parse, expecting exactly one `console.warn` per pattern, in order. */
async function parseWithWarnings(
  spec: Doc,
  patterns: readonly RegExp[],
  options?: Parameters<typeof parseSpec>[1],
): Promise<ApiSpec> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const ir = await parse(spec, options);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toHaveLength(patterns.length);
    patterns.forEach((pattern, i) => expect(messages[i]).toMatch(pattern));
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
  it('is named from the value and its further fields, and keeps the literal', async () => {
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
    // `retry_after` is an integer, which its token says (#515).
    expect(modelNames(ir)).toEqual(['Note', 'RateLimitExceededErrorBodyWithRetryAfterInteger']);
    expect(fieldSummary(ir, 'RateLimitExceededErrorBodyWithRetryAfterInteger')).toEqual([
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
  it('fold with their parents and are named from the parent, their own fields and the field', async () => {
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
    expect(modelNames(ir)).toEqual(['ErrorBodyWithCodeFieldError', 'ErrorBodyWithCodeFieldErrors', 'Note']);
    expect(fieldSummary(ir, 'ErrorBodyWithCodeFieldErrors')).toEqual([
      'message: string',
      'errors: ErrorBodyWithCodeFieldError[]',
    ]);
    expect(fieldSummary(ir, 'ErrorBodyWithCodeFieldError')).toEqual(['code: string', 'field: string']);
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
  it('is a component schema of that name and shape, which the bodies fold onto', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        {
          ...getOp('pets', { '404': { description: 'nf', content: json(messageBody()) } }),
          ...getOp('notes', { '404': { description: 'nf', content: json(messageBody()) } }),
        },
        { ErrorBody: obj({ message: str }) },
      ),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'Note']);
    expect(fieldSummary(ir, 'ErrorBody')).toEqual(['message: string']);
    expect(errorType(ir, 'getPets', 404)).toEqual({ kind: 'model', name: 'ErrorBody' });
    expectSound(ir, ['Note', 'ErrorBody']);
  });

  it('folds onto a component schema only when its string fields admit every pinned value', async () => {
    const bodies = {
      ...getOp('pets', { '409': { description: 'dup', content: json(codedBody('b')) } }),
      ...getOp('notes', { '409': { description: 'dup', content: json(codedBody('c')) } }),
    };
    // An open `code` admits `b` and `c`: the bodies reference the component.
    const open = await parseWithoutWarnings(doc(bodies, { ErrorBodyWithCode: obj({ code: str, message: str }) }));
    expect(modelNames(open)).toEqual(['ErrorBodyWithCode', 'Note']);
    expect(open.enums).toEqual([]);
    expect(errorType(open, 'getPets', 409)).toEqual({ kind: 'model', name: 'ErrorBodyWithCode' });
    // A `code` pinned to `a` would narrow them: the bodies stay as they are.
    const pinned = await parseWithWarnings(
      doc(bodies, { ErrorBodyWithCode: obj({ code: { type: 'string', const: 'a' }, message: str }) }),
      [
        /would be named "ErrorBodyWithCode", which component schema "ErrorBodyWithCode" already holds — keeping models "GetNotesError409", "GetPetsError409" as they are/,
      ],
    );
    expect(modelNames(pinned)).toEqual(['ErrorBodyWithCode', 'GetNotesError409', 'GetPetsError409', 'Note']);
    expect(fieldSummary(pinned, 'GetPetsError409')).toEqual(['code: "b"', 'message: string']);
    expectSound(pinned, ['Note', 'ErrorBodyWithCode']);
  });

  it("orders a union's tokens, so the name does not depend on which operation wrote the union first", async () => {
    const forward = obj({ message: { oneOf: [str, { type: 'array', items: str }] } });
    const backward = obj({ message: { oneOf: [{ type: 'array', items: str }, str] } });
    for (const [first, second] of [
      [forward, backward],
      [backward, forward],
    ]) {
      const ir = await parseWithoutWarnings(
        doc({
          ...getOp('notes', { '400': { description: 'bad', content: json(first) } }),
          ...getOp('pets', { '400': { description: 'bad', content: json(second) } }),
        }),
      );
      expect(modelNames(ir)).toEqual(['ErrorBodyWithMessageOrMessageList', 'Note']);
    }
  });

  it('is never numbered: a component schema of another shape holding it leaves the bodies as they are, with a warning', async () => {
    const ir = await parseWithWarnings(
      doc(
        {
          ...getOp('pets', { '404': { description: 'nf', content: json(messageBody()) } }),
          ...getOp('notes', { '404': { description: 'nf', content: json(messageBody()) } }),
        },
        { ErrorBody: obj({ unrelated: str }) },
      ),
      [
        /would be named "ErrorBody", which component schema "ErrorBody" already holds — keeping models "GetNotesError404", "GetPetsError404" as they are/,
      ],
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'GetNotesError404', 'GetPetsError404', 'Note']);
    expect(fieldSummary(ir, 'ErrorBody')).toEqual(['unrelated: string']);
    expect(errorType(ir, 'getPets', 404)).toEqual({ kind: 'model', name: 'GetPetsError404' });
    expectSound(ir, ['Note', 'ErrorBody']);
  });

  it('qualifies a field by its type, so shapes with the same field names read apart', async () => {
    const fieldErrors = obj({ message: str, errors: { type: 'array', items: obj({ code: str, field: str }) } });
    const constraintErrors = obj({
      message: str,
      errors: { type: 'array', items: obj({ property: str, constraints: { type: 'object' } }) },
    });
    const messageList = obj({ error: str, message: { type: 'array', items: str } });
    const messageOrList = obj({ message: { oneOf: [str, { type: 'array', items: str }] } });
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', { '422': { description: 'invalid', content: json(fieldErrors) } }),
        ...getOp('notes', { '422': { description: 'invalid', content: json(constraintErrors) } }),
        ...getOp('tags', { '400': { description: 'bad', content: json(messageList) } }),
        ...getOp('users', { '400': { description: 'bad', content: json(messageOrList) } }),
      }),
    );
    expect(modelNames(ir)).toEqual([
      'ErrorBodyWithCodeFieldError',
      'ErrorBodyWithCodeFieldErrors',
      'ErrorBodyWithConstraintsPropertyError',
      'ErrorBodyWithConstraintsPropertyErrors',
      'ErrorBodyWithErrorMessageList',
      'ErrorBodyWithMessageOrMessageList',
      'Note',
    ]);
    expectSound(ir);
  });

  it('names the OAuth error format, and a pinned body beside further fields from both', async () => {
    const oauth = obj({ error: { type: 'string', const: 'invalid_grant' }, error_description: str });
    const selection = obj({
      code: { type: 'string', const: 'organization_selection_required' },
      message: str,
      organizations: { type: 'array', items: obj({ id: str, name: str }) },
    });
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('tokens', {
          '400': { description: 'bad', content: json(oauth) },
          '401': { description: 'bad', content: json(obj({ error: str, error_description: str, error_uri: str })) },
        }),
        ...getOp('devices', { '400': { description: 'bad', content: json(oauth) } }),
        ...getOp('sessions', {
          '403': {
            description: 'forbidden',
            content: json({ oneOf: [codedBody('organization_selection_required'), selection, messageBody()] }),
          },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual([
      'ErrorBody',
      'InvalidGrantOAuthErrorBody',
      'Note',
      'OAuthErrorBodyWithErrorUri',
      'OrganizationSelectionRequiredErrorBody',
      'OrganizationSelectionRequiredErrorBodyWithOrganization',
      'OrganizationSelectionRequiredErrorBodyWithOrganizations',
    ]);
    expect(fieldSummary(ir, 'InvalidGrantOAuthErrorBody')).toEqual([
      'error: "invalid_grant"',
      'error_description: string',
    ]);
    expect(fieldSummary(ir, 'OrganizationSelectionRequiredErrorBodyWithOrganizations')).toEqual([
      'code: "organization_selection_required"',
      'message: string',
      'organizations: OrganizationSelectionRequiredErrorBodyWithOrganization[]',
    ]);
    expectSound(ir);
  });

  it('is never numbered for a shape that differs only in which fields are required: each is named from the fields it requires', async () => {
    // Before #515 the two shapes asked for one name, `TakenErrorBody`, and
    // the later one stayed as it was. A name now reads the required fields
    // only: `{ code?: 'taken', message }` requires `message` alone, so it is
    // `ErrorBody`, with `code?` carried as the optional literal it is.
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', { '409': { description: 'dup', content: json(codedBody('taken')) } }),
        ...getOp('notes', {
          '409': { description: 'dup', content: json({ ...codedBody('taken'), required: ['message'] }) },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'Note', 'TakenErrorBody']);
    expect(fieldSummary(ir, 'TakenErrorBody')).toEqual(['code: "taken"', 'message: string']);
    expect(fieldSummary(ir, 'ErrorBody')).toEqual(['code?: "taken"', 'message: string']);
    expectSound(ir);
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

describe('what the review asked to pin (workos/oagen#497)', () => {
  it('never stands a shared model beside an enum of its name: the bodies stay as they are, with a warning', async () => {
    // A component `Error` with a `body` enum lifts `ErrorBody` as an enum
    // before the pass runs; the `{ message }` bodies are left alone.
    const ir = await parseWithWarnings(
      doc(
        {
          ...getOp('pets', {
            '200': { description: 'ok', content: json({ $ref: '#/components/schemas/Error' }) },
            '404': { description: 'nf', content: json(messageBody()) },
          }),
          ...getOp('notes', { '404': { description: 'nf', content: json(messageBody()) } }),
        },
        { Error: obj({ body: { type: 'string', enum: ['json', 'text'] } }) },
      ),
      [/would be named "ErrorBody", which enum "ErrorBody" already holds/],
    );
    expect(ir.enums.map((e) => e.name)).toEqual(['ErrorBody']);
    expect(modelNames(ir)).toEqual(['Error', 'GetNotesError404', 'GetPetsError404', 'Note']);
    expect(errorType(ir, 'getPets', 404)).toEqual({ kind: 'model', name: 'GetPetsError404' });
    expectSound(ir, ['Note', 'Error']);
  });

  it('keeps string values inside arrays in the key, so bodies listing different codes stay two models', async () => {
    const codes = (code: string): Doc =>
      obj({ codes: { type: 'array', items: { type: 'string', const: code } }, message: str });
    // Nothing in the shape names the two apart, so the second stays as it is.
    const ir = await parseWithWarnings(
      doc({
        ...getOp('pets', { '400': { description: 'bad', content: json(codes('a')) } }),
        ...getOp('notes', { '400': { description: 'bad', content: json(codes('b')) } }),
      }),
      [
        /would be named "ErrorBodyWithCodesList", which the shared error body "ErrorBodyWithCodesList" .* already holds — keeping model "GetNotesError400" as it is/,
      ],
    );
    expect(modelNames(ir)).toEqual(['ErrorBodyWithCodesList', 'GetNotesError400', 'Note']);
    // Groups are ordered by shape (the key), not by operation: `"a"` sorts before `"b"`.
    expect(fieldSummary(ir, 'ErrorBodyWithCodesList')).toEqual(['codes: "a"[]', 'message: string']);
    expect(fieldSummary(ir, 'GetNotesError400')).toEqual(['codes: "b"[]', 'message: string']);
    expectSound(ir);
  });

  it('keeps a discriminator mapping in the key, so bodies that map values to different models stay apart', async () => {
    const mapped = (mapping: Record<string, string>): Doc =>
      obj({
        message: str,
        detail: {
          oneOf: [{ $ref: '#/components/schemas/Note' }, { $ref: '#/components/schemas/Tag' }],
          discriminator: { propertyName: 'kind', mapping },
        },
      });
    const ir = await parseWithWarnings(
      doc(
        {
          ...getOp('pets', {
            '400': {
              description: 'bad',
              content: json(mapped({ note: '#/components/schemas/Note', tag: '#/components/schemas/Tag' })),
            },
          }),
          ...getOp('notes', {
            '400': {
              description: 'bad',
              content: json(mapped({ note: '#/components/schemas/Tag', tag: '#/components/schemas/Note' })),
            },
          }),
        },
        { Tag: obj({ label: str }) },
      ),
      [
        /would be named "ErrorBodyWithDetail", which the shared error body "ErrorBodyWithDetail" .* already holds — keeping model "GetNotesError400" as it is/,
      ],
    );
    expect(modelNames(ir)).toEqual(['ErrorBodyWithDetail', 'GetNotesError400', 'Note', 'Tag']);
    expectSound(ir, ['Note', 'Tag']);
  });

  it('carries a field hint applied to a folded body, and applies one keyed by the shared name', async () => {
    const spec = doc({
      ...getOp('pets', { '404': { description: 'nf', content: json(messageBody()) } }),
      ...getOp('notes', { '404': { description: 'nf', content: json(messageBody()) } }),
    });
    // A hint applied before the fold is part of the shape, which the name
    // reads (#515): `message` as `detail` is `ErrorBodyWithMessageAsDetail`.
    const carried = await parseWithoutWarnings(spec, {
      fieldHints: { GetPetsError404: { message: 'detail' }, GetNotesError404: { message: 'detail' } },
    });
    expect(modelNames(carried)).toEqual(['ErrorBodyWithMessageAsDetail', 'Note']);
    expect(carried.models.find((m) => m.name === 'ErrorBodyWithMessageAsDetail')?.fields[0].domainName).toBe('detail');

    const keyedByShared = await parseWithoutWarnings(spec, { fieldHints: { ErrorBody: { message: 'detail' } } });
    expect(modelNames(keyedByShared)).toEqual(['ErrorBody', 'Note']);
    expect(keyedByShared.models.find((m) => m.name === 'ErrorBody')?.fields[0].domainName).toBe('detail');

    // A hint on one body only keeps that body apart under a name of its own:
    // the unhinted shape keeps `ErrorBody`, and nothing is left as it was.
    const split = await parseWithoutWarnings(spec, { fieldHints: { GetPetsError404: { message: 'detail' } } });
    expect(modelNames(split)).toEqual(['ErrorBody', 'ErrorBodyWithMessageAsDetail', 'Note']);
    expect(errorType(split, 'getPets', 404)).toEqual({ kind: 'model', name: 'ErrorBodyWithMessageAsDetail' });
    expect(errorType(split, 'getNotes', 404)).toEqual({ kind: 'model', name: 'ErrorBody' });
  });
});

describe('what the human review asked to pin (workos/oagen#497, review 5704133720)', () => {
  it('names shapes from their structure, so each keeps its name whichever operation declares it, and renaming an operation moves no name', async () => {
    const union = obj({ message: { oneOf: [str, { type: 'array', items: str }] } });
    const build = (plainOp: string, unionOp: string): Doc =>
      doc({
        ...getOp(plainOp, { '400': { description: 'bad', content: json(messageBody()) } }),
        ...getOp(unionOp, { '400': { description: 'bad', content: json(union) } }),
      });
    // The union body's operation sorts before the plain one...
    const a = await parseWithoutWarnings(build('pets', 'notes'));
    expect(fieldSummary(a, 'ErrorBody')).toEqual(['message: string']);
    expect(fieldSummary(a, 'ErrorBodyWithMessageOrMessageList')).toEqual(['message: string | string[]']);
    // ...and after it: the same names.
    const b = await parseWithoutWarnings(build('notes', 'pets'));
    expect(fieldSummary(b, 'ErrorBody')).toEqual(['message: string']);
    expect(fieldSummary(b, 'ErrorBodyWithMessageOrMessageList')).toEqual(['message: string | string[]']);
    // A value-named pair reads the further field in its name, in either order.
    const notFound = (extra: Record<string, unknown>): Doc =>
      obj({ code: { type: 'string', const: 'not_found' }, message: str, ...extra });
    for (const [small, large] of [
      ['pets', 'notes'],
      ['notes', 'pets'],
    ]) {
      const ir = await parseWithoutWarnings(
        doc({
          ...getOp(small, { '404': { description: 'nf', content: json(notFound({})) } }),
          ...getOp(large, { '404': { description: 'nf', content: json(notFound({ id: str })) } }),
        }),
      );
      expect(fieldSummary(ir, 'NotFoundErrorBody')).toEqual(['code: "not_found"', 'message: string']);
      expect(fieldSummary(ir, 'NotFoundErrorBodyWithId')).toEqual([
        'code: "not_found"',
        'message: string',
        'id: string',
      ]);
    }
  });

  it('shares a component enum of the same name and members, and leaves the fields strings when the members differ', async () => {
    const ir = await parseWithoutWarnings(
      doc(
        {
          ...getOp('pets', {
            '200': {
              description: 'ok',
              content: json(obj({ code: { $ref: '#/components/schemas/ErrorBodyCode' } })),
            },
            '409': { description: 'dup', content: json(codedBody('pet_taken')) },
          }),
          ...getOp('notes', { '409': { description: 'dup', content: json(codedBody('note_locked')) } }),
        },
        { ErrorBodyCode: { type: 'string', enum: ['note_locked', 'pet_taken'] } },
      ),
    );
    expect(ir.enums.map((e) => e.name)).toEqual(['ErrorBodyCode']);
    expect(fieldSummary(ir, 'ErrorBodyWithCode')).toEqual(['code: ErrorBodyCode', 'message: string']);
    // Other members leave the fields plain strings, with a warning.
    const other = await parseWithWarnings(
      doc(
        {
          ...getOp('pets', {
            '200': {
              description: 'ok',
              content: json(obj({ code: { $ref: '#/components/schemas/ErrorBodyCode' } })),
            },
            '409': { description: 'dup', content: json(codedBody('pet_taken')) },
          }),
          ...getOp('notes', { '409': { description: 'dup', content: json(codedBody('note_locked')) } }),
        },
        { ErrorBodyCode: { type: 'string', enum: ['something_else'] } },
      ),
      [
        /would be the shared enum "ErrorBodyCode", which enum "ErrorBodyCode" already holds — keeping those fields plain strings/,
      ],
    );
    expect(other.enums.map((e) => e.name).sort()).toEqual(['ErrorBodyCode']);
    expect(fieldSummary(other, 'ErrorBodyWithCode')).toEqual(['code: string', 'message: string']);
  });

  it('falls back to the field-based name when the pinned value would start with a digit', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '409': { description: 'dup', content: json(codedBody('4001')) },
        }),
        ...getOp('notes', {
          '409': { description: 'dup', content: json(codedBody('4001')) },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBodyWithCode', 'Note']);
    expect(fieldSummary(ir, 'ErrorBodyWithCode')).toEqual(['code: "4001"', 'message: string']);
  });
});

// A shared body's key and name read its required fields only — a body that
// requires none, every field under `Optional` — so an optional field added
// to a body (#506) or to a nested item (#516) moves no model, and two
// shapes never ask for one name (#515): what tells them apart is in the
// name, and the warning for what no name can spell prints it.

/** `oagen diff` from `before` to `after`, one line per change, and the exit code the CLI would give. */
async function diffDocs(before: Doc, after: Doc): Promise<{ changes: string[]; exit: number }> {
  const changes = diffSpecs(await parseWithoutWarnings(before), await parseWithoutWarnings(after)).changes.map(
    (change) => {
      const { classification, kind, name, operationName } = change as typeof change & {
        name?: string;
        operationName?: string;
      };
      return `${classification} ${kind} ${name ?? operationName}`;
    },
  );
  const exit = changes.some((change) => change.startsWith('breaking')) ? 2 : changes.length > 0 ? 1 : 0;
  return { changes, exit };
}

const nullableStr = (version: '3.0.3' | '3.1.0'): Doc =>
  version === '3.0.3' ? { type: 'string', nullable: true } : { type: ['string', 'null'] };

describe('#506', () => {
  const before = doc(getOp('pets', { '404': { description: 'No such pet', content: json(messageBody()) } }));
  const after = doc(
    getOp('pets', {
      '404': { description: 'No such pet', content: json(obj({ message: str, hint: str }, ['message'])) },
    }),
  );

  it.each(['3.0.3', '3.1.0'] as const)(
    'keeps `ErrorBody` when an optional property is added, which `oagen diff` reads as additive, under OAS %s',
    async (version) => {
      const old = await parseWithoutWarnings({ ...before, openapi: version });
      const updated = await parseWithoutWarnings({ ...after, openapi: version });
      expect(modelNames(old)).toEqual(['ErrorBody', 'Note']);
      expect(modelNames(updated)).toEqual(['ErrorBody', 'Note']);
      expect(fieldSummary(updated, 'ErrorBody')).toEqual(['message: string', 'hint?: string']);
      expect(errorType(updated, 'getPets', 404)).toEqual({ kind: 'model', name: 'ErrorBody' });
      const { changes, exit } = await diffDocs({ ...before, openapi: version }, { ...after, openapi: version });
      expect(changes).toEqual(['additive model-modified ErrorBody']);
      expect(exit).toBe(1);
      expectSound(updated);
    },
  );

  it('folds a body with and a body without the optional property onto one model that carries it, optional', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', { '404': { description: 'nf', content: json(messageBody()) } }),
        ...getOp('notes', {
          '404': { description: 'nf', content: json(obj({ message: str, hint: str }, ['message'])) },
        }),
        ...getOp('tags', {
          '404': { description: 'nf', content: json(obj({ message: str, reason: str }, ['message'])) },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'Note']);
    // The first member's fields, then what each later member adds.
    expect(fieldSummary(ir, 'ErrorBody')).toEqual(['message: string', 'hint?: string', 'reason?: string']);
    for (const name of ['getPets', 'getNotes', 'getTags']) {
      expect(errorType(ir, name, 404)).toEqual({ kind: 'model', name: 'ErrorBody' });
    }
    expectSound(ir);
  });

  it('types an optional property the bodies type differently as the union of the types, sorted, with `null` hoisted', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '404': { description: 'nf', content: json(obj({ message: str, hint: str }, ['message'])) },
        }),
        ...getOp('notes', {
          '404': { description: 'nf', content: json(obj({ message: str, hint: { type: 'integer' } }, ['message'])) },
        }),
        ...getOp('tags', {
          '404': {
            description: 'nf',
            content: json(obj({ message: str, hint: { type: ['integer', 'null'] } }, ['message'])),
          },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'Note']);
    expect(fieldSummary(ir, 'ErrorBody')).toEqual(['message: string', 'hint?: integer | string | null']);
    expectSound(ir);
  });

  it('keeps an optional property pinned to one value as that literal when the other bodies lack it', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '404': {
            description: 'nf',
            content: json(obj({ message: str, code: { type: 'string', const: 'not_found' } }, ['message'])),
          },
        }),
        ...getOp('notes', { '404': { description: 'nf', content: json(messageBody()) } }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'Note']);
    expect(fieldSummary(ir, 'ErrorBody')).toEqual(['message: string', 'code?: "not_found"']);
  });

  it("keeps a field's flag, default and limits, and a model's, only when every body wrote the same ones", async () => {
    const limited = { ...str, maxLength: 10, deprecated: true, default: 'none' };
    const differing = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '404': { description: 'nf', content: json({ ...obj({ message: limited }), minProperties: 1 }) },
        }),
        ...getOp('notes', { '404': { description: 'nf', content: json(messageBody()) } }),
      }),
    );
    expect(modelNames(differing)).toEqual(['ErrorBody', 'Note']);
    const shared = differing.models.find((m) => m.name === 'ErrorBody')!;
    expect(shared.fields[0]).toEqual({ name: 'message', type: { kind: 'primitive', type: 'string' }, required: true });
    expect(shared.constraints).toBeUndefined();
    const agreeing = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '404': { description: 'nf', content: json({ ...obj({ message: limited }), minProperties: 1 }) },
        }),
        ...getOp('notes', {
          '404': { description: 'nf', content: json({ ...obj({ message: limited }), minProperties: 1 }) },
        }),
      }),
    );
    const kept = agreeing.models.find((m) => m.name === 'ErrorBody')!;
    expect(kept.fields[0]).toEqual({
      name: 'message',
      type: { kind: 'primitive', type: 'string', constraints: { maxLength: 10 } },
      required: true,
      deprecated: true,
      default: 'none',
      constraints: { maxLength: 10 },
    });
    expect(kept.constraints).toEqual({ minProperties: 1 });
  });

  it('folds onto a component of the name only when it declares every optional property the bodies have', async () => {
    const bodies = {
      ...getOp('pets', { '404': { description: 'nf', content: json(messageBody()) } }),
      ...getOp('notes', { '404': { description: 'nf', content: json(obj({ message: str, hint: str }, ['message'])) } }),
    };
    const declared = await parseWithoutWarnings(
      doc(bodies, { ErrorBody: obj({ message: str, hint: str }, ['message']) }),
    );
    expect(modelNames(declared)).toEqual(['ErrorBody', 'Note']);
    expect(errorType(declared, 'getNotes', 404)).toEqual({ kind: 'model', name: 'ErrorBody' });
    expectSound(declared, ['Note', 'ErrorBody']);
    // A component without `hint` would lose it: the bodies stay as they are.
    const lacking = await parseWithWarnings(doc(bodies, { ErrorBody: obj({ message: str }) }), [
      /The shared error body \{ message: string, hint\?: string \} would be named "ErrorBody", which component schema "ErrorBody" already holds — keeping models "GetNotesError404", "GetPetsError404" as they are/,
    ]);
    expect(modelNames(lacking)).toEqual(['ErrorBody', 'GetNotesError404', 'GetPetsError404', 'Note']);
    expectSound(lacking, ['Note', 'ErrorBody']);
  });
});

describe('#515', () => {
  const required = messageBody();
  const optional = obj({ message: str }, []);
  const stringCode = obj({ code: str, message: str });
  const integerCode = obj({ code: { type: 'integer' }, message: str });

  it.each(['3.0.3', '3.1.0'] as const)(
    'names a shape from its required fields, so adding an operation with a shape that differs only in requiredness, nullability or a type renames nothing, under OAS %s',
    async (version) => {
      const nullable = obj({ message: nullableStr(version) });
      for (const [existing, added, kept, taken] of [
        [optional, required, 'OptionalErrorBody', 'ErrorBody'],
        [nullable, required, 'ErrorBodyWithNullableMessage', 'ErrorBody'],
        [stringCode, integerCode, 'ErrorBodyWithCode', 'ErrorBodyWithCodeInteger'],
      ] as const) {
        const before = {
          ...doc({
            ...getOp('pets', { '404': { description: 'nf', content: json(existing) } }),
            ...getOp('users', { '404': { description: 'nf', content: json(existing) } }),
          }),
          openapi: version,
        };
        const after = {
          ...doc({
            ...getOp('pets', { '404': { description: 'nf', content: json(existing) } }),
            ...getOp('users', { '404': { description: 'nf', content: json(existing) } }),
            ...getOp('notes', { '404': { description: 'nf', content: json(added) } }),
          }),
          openapi: version,
        };
        const old = await parseWithoutWarnings(before);
        expect(modelNames(old)).toEqual([kept, 'Note'].sort());
        const updated = await parseWithoutWarnings(after);
        expect(modelNames(updated)).toEqual([kept, 'Note', taken].sort());
        expect(errorType(updated, 'getPets', 404)).toEqual({ kind: 'model', name: kept });
        expect(errorType(updated, 'getUsers', 404)).toEqual({ kind: 'model', name: kept });
        expect(errorType(updated, 'getNotes', 404)).toEqual({ kind: 'model', name: taken });
        const { changes, exit } = await diffDocs(before, after);
        expect(changes).toEqual([`additive model-added ${taken}`, 'additive service-added Notes']);
        expect(exit).toBe(1);
        expectSound(updated);
      }
    },
  );

  it("names a hinted body apart under a name of its own, `ErrorBodyWithMessageAsDetail`, whichever body the hint is on (the issue's comment)", async () => {
    const spec = doc({
      ...getOp('pets', { '404': { description: 'nf', content: json(required) } }),
      ...getOp('notes', { '404': { description: 'nf', content: json(required) } }),
    });
    for (const [hinted, plain] of [
      ['getPets', 'getNotes'],
      ['getNotes', 'getPets'],
    ] as const) {
      const hint = hinted === 'getPets' ? 'GetPetsError404' : 'GetNotesError404';
      const ir = await parseWithoutWarnings(spec, { fieldHints: { [hint]: { message: 'detail' } } });
      expect(modelNames(ir)).toEqual(['ErrorBody', 'ErrorBodyWithMessageAsDetail', 'Note']);
      expect(errorType(ir, hinted, 404)).toEqual({ kind: 'model', name: 'ErrorBodyWithMessageAsDetail' });
      expect(errorType(ir, plain, 404)).toEqual({ kind: 'model', name: 'ErrorBody' });
      expect(ir.models.find((m) => m.name === 'ErrorBodyWithMessageAsDetail')?.fields[0].domainName).toBe('detail');
      expect(ir.models.find((m) => m.name === 'ErrorBody')?.fields[0].domainName).toBeUndefined();
      expectSound(ir);
    }
  });

  it('names a body with no required `message` apart, ending in `WithoutMessage`, in the field-named and the value-named family', async () => {
    const fieldNamed = await parseWithoutWarnings(
      doc({
        ...getOp('pets', { '404': { description: 'nf', content: json(obj({ code: str })) } }),
        ...getOp('notes', { '404': { description: 'nf', content: json(stringCode) } }),
        ...getOp('toys', { '404': { description: 'nf', content: json(obj({ code: str, message: str }, ['code'])) } }),
      }),
    );
    expect(modelNames(fieldNamed)).toEqual(['ErrorBodyWithCode', 'ErrorBodyWithCodeWithoutMessage', 'Note']);
    // `{ code, message? }` requires `code` alone: one shape with `{ code }`.
    expect(errorType(fieldNamed, 'getToys', 404)).toEqual({ kind: 'model', name: 'ErrorBodyWithCodeWithoutMessage' });
    expect(fieldSummary(fieldNamed, 'ErrorBodyWithCodeWithoutMessage')).toEqual(['code: string', 'message?: string']);
    expectSound(fieldNamed);
    const valueNamed = await parseWithoutWarnings(
      doc({
        ...getOp('tags', {
          '404': { description: 'nf', content: json(obj({ code: { type: 'string', const: 'gone' } })) },
        }),
        ...getOp('users', { '404': { description: 'nf', content: json(codedBody('gone')) } }),
      }),
    );
    expect(modelNames(valueNamed)).toEqual(['GoneErrorBody', 'GoneErrorBodyWithoutMessage', 'Note']);
    expect(fieldSummary(valueNamed, 'GoneErrorBodyWithoutMessage')).toEqual(['code: "gone"']);
    expectSound(valueNamed);
  });

  it('spells `message` in the OAuth family, whose implied field is `error_description`', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', { '400': { description: 'bad', content: json(obj({ error: str, error_description: str })) } }),
        ...getOp('notes', {
          '400': { description: 'bad', content: json(obj({ error: str, error_description: str, message: str })) },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual(['Note', 'OAuthErrorBody', 'OAuthErrorBodyWithMessage']);
  });

  it('names a body that requires no field from every field it has, under `Optional`, so adding a field to it renames it', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', { '404': { description: 'nf', content: json(optional) } }),
        ...getOp('notes', { '404': { description: 'nf', content: json(obj({ code: str, message: str }, [])) } }),
        ...getOp('tags', { '404': { description: 'nf', content: json(obj({ code: str }, [])) } }),
        ...getOp('users', { '404': { description: 'nf', content: json(obj({}, [])) } }),
      }),
    );
    expect(modelNames(ir)).toEqual([
      'ErrorBodyEmpty',
      'Note',
      'OptionalErrorBody',
      'OptionalErrorBodyWithCode',
      'OptionalErrorBodyWithCodeWithoutMessage',
    ]);
    expect(fieldSummary(ir, 'OptionalErrorBodyWithCode')).toEqual(['code?: string', 'message?: string']);
    const { changes } = await diffDocs(
      doc(getOp('pets', { '404': { description: 'nf', content: json(optional) } })),
      doc(getOp('pets', { '404': { description: 'nf', content: json(obj({ message: str, hint: str }, [])) } })),
    );
    expect(changes).toEqual([
      'additive model-added OptionalErrorBodyWithHint',
      'breaking model-removed OptionalErrorBody',
      'breaking operation-modified getPets',
    ]);
    expectSound(ir);
  });

  it('qualifies a field by its scalar type, format, nullability and array items, so shapes with the same field names read apart', async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '400': {
            description: 'bad',
            content: json(
              obj({
                message: str,
                at: { type: 'string', format: 'date-time' },
                codes: { type: 'array', items: { type: 'integer' } },
                count: { type: 'integer', format: 'int64' },
                ok: { type: 'boolean' },
                status: { const: 404 },
                tags: { type: 'array', items: { type: ['string', 'null'] } },
              }),
            ),
          },
        }),
        ...getOp('notes', {
          '400': { description: 'bad', content: json(obj({ message: str, codes: { type: 'array', items: str } })) },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual([
      'ErrorBodyWithAtDateTimeCodesIntegerListCountInt64OkBooleanStatusNumberTagsNullableList',
      'ErrorBodyWithCodesList',
      'Note',
    ]);
  });

  it('prints requiredness, nullability, domain names and types in the warning for what no name can spell', async () => {
    // Two bodies that reference different components under one field name
    // are two shapes with one name: the one whose shape sorts first keeps
    // it, and the warning says what differs.
    const ir = await parseWithWarnings(
      doc(
        {
          ...getOp('pets', {
            '404': {
              description: 'nf',
              content: json(
                obj({ message: str, detail: { $ref: '#/components/schemas/Note' }, hint: str }, ['message', 'detail']),
              ),
            },
          }),
          ...getOp('notes', {
            '404': {
              description: 'nf',
              content: json(
                obj({ message: str, detail: { $ref: '#/components/schemas/Tag' }, extra: nullableStr('3.1.0') }, [
                  'message',
                  'detail',
                ]),
              ),
            },
          }),
        },
        { Tag: obj({ label: str }) },
      ),
      [
        /The shared error body \{ message: string, detail: Tag, extra\? as more: string \| null \} would be named "ErrorBodyWithDetail", which the shared error body "ErrorBodyWithDetail" \{ message: string, detail: Note, hint\?: string \} already holds — keeping model "GetNotesError404" as it is/,
      ],
      { fieldHints: { GetNotesError404: { extra: 'more' } } },
    );
    expect(modelNames(ir)).toEqual(['ErrorBodyWithDetail', 'GetNotesError404', 'Note', 'Tag']);
    expectSound(ir, ['Note', 'Tag']);
  });
});

describe('#516', () => {
  const items = (properties: Record<string, unknown>, required?: string[]): Doc =>
    obj({ message: str, errors: { type: 'array', items: obj(properties, required) } });
  const before = doc(
    getOp('pets', { '422': { description: 'invalid', content: json(items({ code: str, field: str })) } }),
  );
  const after = doc(
    getOp('pets', {
      '422': { description: 'invalid', content: json(items({ code: str, field: str, hint: str }, ['code', 'field'])) },
    }),
  );

  it.each(['3.0.3', '3.1.0'] as const)(
    'keeps the item and its parent their names when an optional property is added to the item, which `oagen diff` reads as additive, under OAS %s',
    async (version) => {
      const old = await parseWithoutWarnings({ ...before, openapi: version });
      const updated = await parseWithoutWarnings({ ...after, openapi: version });
      const names = ['ErrorBodyWithCodeFieldError', 'ErrorBodyWithCodeFieldErrors', 'Note'];
      expect(modelNames(old)).toEqual(names);
      expect(modelNames(updated)).toEqual(names);
      expect(fieldSummary(updated, 'ErrorBodyWithCodeFieldError')).toEqual([
        'code: string',
        'field: string',
        'hint?: string',
      ]);
      const { changes, exit } = await diffDocs({ ...before, openapi: version }, { ...after, openapi: version });
      expect(changes).toEqual(['additive model-modified ErrorBodyWithCodeFieldError']);
      expect(exit).toBe(1);
      expectSound(updated);
    },
  );

  it("reads the item's required fields into the parent's name as full tokens, recursively", async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '422': {
            description: 'invalid',
            content: json(
              items({
                code: str,
                tags: { type: 'array', items: { type: 'integer' } },
                detail: obj({ reason: str, more: str }, ['reason']),
              }),
            ),
          },
        }),
      }),
    );
    expect(modelNames(ir)).toEqual([
      'ErrorBodyWithCodeReasonDetailTagsIntegerListError',
      'ErrorBodyWithCodeReasonDetailTagsIntegerListErrorDetail',
      'ErrorBodyWithCodeReasonDetailTagsIntegerListErrors',
      'Note',
    ]);
    expectSound(ir);
  });

  it("names an item under an optional field from the parent, the field and the item's own fields, so two items under one field never ask for one name", async () => {
    const ir = await parseWithoutWarnings(
      doc({
        ...getOp('pets', {
          '404': { description: 'nf', content: json(obj({ message: str, detail: obj({ reason: str }) }, ['message'])) },
        }),
        ...getOp('notes', {
          '404': { description: 'nf', content: json(obj({ message: str, detail: obj({ cause: str }) }, ['message'])) },
        }),
        ...getOp('tags', { '404': { description: 'nf', content: json(messageBody()) } }),
      }),
    );
    expect(modelNames(ir)).toEqual(['ErrorBody', 'ErrorBodyDetailWithCause', 'ErrorBodyDetailWithReason', 'Note']);
    expect(fieldSummary(ir, 'ErrorBody')).toEqual([
      'message: string',
      'detail?: ErrorBodyDetailWithCause | ErrorBodyDetailWithReason',
    ]);
    for (const name of ['getPets', 'getNotes', 'getTags']) {
      expect(errorType(ir, name, 404)).toEqual({ kind: 'model', name: 'ErrorBody' });
    }
    expectSound(ir);
  });

  it('names an item that requires no field from every field it has, as its parent reads it, so adding one renames both', async () => {
    const ir = await parseWithoutWarnings(
      doc(getOp('pets', { '422': { description: 'invalid', content: json(items({ code: str, field: str }, [])) } })),
    );
    expect(modelNames(ir)).toEqual(['ErrorBodyWithCodeFieldError', 'ErrorBodyWithCodeFieldErrors', 'Note']);
    expect(fieldSummary(ir, 'ErrorBodyWithCodeFieldError')).toEqual(['code?: string', 'field?: string']);
    const { changes } = await diffDocs(
      doc(getOp('pets', { '422': { description: 'invalid', content: json(items({ code: str, field: str }, [])) } })),
      doc(
        getOp('pets', {
          '422': { description: 'invalid', content: json(items({ code: str, field: str, hint: str }, [])) },
        }),
      ),
    );
    expect(changes).toEqual([
      'additive model-added ErrorBodyWithCodeFieldHintError',
      'additive model-added ErrorBodyWithCodeFieldHintErrors',
      'breaking model-removed ErrorBodyWithCodeFieldError',
      'breaking model-removed ErrorBodyWithCodeFieldErrors',
      'breaking operation-modified getPets',
    ]);
  });
});
