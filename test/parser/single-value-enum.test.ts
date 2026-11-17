import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #667: a single-value `enum:` list is the OAS 3.0 spelling of a
 * `const`, and the type builder read one as a literal — but kept the value
 * only when it was a number, and took `String(value)` of anything else. So
 * `{ type: 'boolean', enum: [true] }` was the string literal `'true'` where
 * `{ type: 'boolean', const: true }` is the boolean `true`, an object value
 * was the literal `'[object Object]'` where its `const` is a map, and a list
 * of `null` alone lifted an enum with no members where `const: null` is
 * `nullable<unknown>`. The one value of such a list is now typed as the same
 * `const` is (`constTypeRef`), at every site that types a schema in place.
 */

type Schema = Record<string, unknown>;

const json = (schema: unknown) => ({ 'application/json': { schema } });
const unknown: TypeRef = { kind: 'primitive', type: 'unknown' };
const literal = (value: string | number | boolean): TypeRef => ({ kind: 'literal', value });
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });

/** `GET /notes` (`listNotes`) returning `Note`, with the given component schemas and parameters. */
function documentOf(openapi: string, schemas: Record<string, Schema>, parameters: Schema[] = []) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/notes': {
        get: {
          operationId: 'listNotes',
          parameters,
          responses: { '200': { description: 'OK', content: json({ $ref: '#/components/schemas/Note' }) } },
        },
      },
    },
    components: { schemas },
  };
}

/**
 * The issue's document: `GET /notes` (`listNotes`) with a query parameter
 * `archived`, returning `Note` with a field `archived`, both typed by `schema`.
 */
const issueDocument = (openapi: string, schema: Schema) =>
  documentOf(openapi, { Note: { type: 'object', properties: { archived: schema } } }, [
    { name: 'archived', in: 'query', schema },
  ]);

/** A document whose `Note` has the given properties, beside the `extra` component schemas. */
const noteDocument = (openapi: string, properties: Record<string, Schema>, extra: Record<string, Schema> = {}) =>
  documentOf(openapi, { Note: { type: 'object', properties }, ...extra });

/** The JSON Schema `type` of `value`; none for `null` in an OAS 3.0 document, which has no `null` type. */
function typeNameOf(value: unknown, openapi: string): string | undefined {
  if (value === null) return openapi.startsWith('3.0') ? undefined : 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

type Spelling = 'const' | 'enum';

/** A schema pinned to `value`: `{ const: value }` or `{ enum: [value] }`, with the value's `type` beside it when `typed`. */
function pin(spelling: Spelling, value: unknown, openapi: string, typed: boolean): Schema {
  const type = typed ? typeNameOf(value, openapi) : undefined;
  return { ...(type ? { type } : {}), ...(spelling === 'const' ? { const: value } : { enum: [value] }) };
}

/**
 * `s` at every site that types a schema in place: a field (optional,
 * required, described), an array's items, a map's values, a union's variant
 * (`other` beside it, in both orders), an `allOf` of one, a nullable
 * wrapper, a query, header, path and cookie parameter, a response header, a
 * request body and a response body, an error body's field, a webhook
 * payload's field and a callback body's field.
 */
function everySiteDocument(openapi: string, s: Schema, other: Schema) {
  const holder = { type: 'object', properties: { pinned: s } };
  const nullWrappers = openapi.startsWith('3.0')
    ? // OAS 3.0 has no `null` type: the flag beside the schema, read where a `type` is written.
      { flagged: { ...s, nullable: true } }
    : { wrapped: { oneOf: [s, { type: 'null' }] }, wrappedAny: { anyOf: [{ type: 'null' }, s] } };
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/notes/{p}': {
        get: {
          operationId: 'listNotes',
          parameters: [
            { name: 'q', in: 'query', schema: s },
            { name: 'X-H', in: 'header', schema: s },
            { name: 'p', in: 'path', required: true, schema: s },
            { name: 'c', in: 'cookie', schema: s },
            { name: 'callbackUrl', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'OK',
              headers: { 'X-R': { schema: s } },
              content: json({ $ref: '#/components/schemas/Note' }),
            },
            '404': {
              description: 'Not found',
              content: json({
                type: 'object',
                required: ['code', 'message'],
                properties: { code: s, message: { type: 'string' } },
              }),
            },
          },
          callbacks: {
            onListed: {
              '{$request.query.callbackUrl}': {
                post: { requestBody: { content: json(holder) }, responses: { '200': { description: 'OK' } } },
              },
            },
          },
        },
      },
      '/raw': {
        post: {
          operationId: 'postRaw',
          requestBody: { content: json(s) },
          responses: { '200': { description: 'OK', content: json(s) } },
        },
      },
    },
    webhooks: {
      noteArchived: {
        post: { requestBody: { content: json(holder) }, responses: { '200': { description: 'OK' } } },
      },
    },
    components: {
      schemas: {
        Note: {
          type: 'object',
          required: ['required'],
          properties: {
            plain: s,
            required: s,
            described: { ...s, description: 'Always this value.' },
            items: { type: 'array', items: s },
            values: { type: 'object', additionalProperties: s },
            variant: { oneOf: [s, { type: 'string', format: 'date' }] },
            both: { oneOf: [s, other] },
            reversed: { anyOf: [other, s] },
            member: { allOf: [s] },
            ...nullWrappers,
          },
        },
      },
    },
  };
}

/**
 * The pins read through another object, or beside other keywords: a
 * parameter and a header typed by `content`, a component parameter and
 * header, a `default` body and two error bodies of one shape, a body under
 * three media types, a property two `allOf` members declare, the variants of
 * a discriminated `allOf` + `oneOf` component, of a named union and of an
 * inline one, a type list, a `patternProperties` map, a pin beside each
 * annotation a field reads, and a request body, a webhook payload and a
 * callback body written as a union of pins. `pinOf(value, type)` spells
 * each pin.
 */
function furtherSitesDocument(openapi: string, pinOf: (value: unknown, type?: string | string[]) => Schema) {
  const yes = pinOf(true, 'boolean');
  const no = pinOf(false, 'boolean');
  const object = pinOf({ a: 1 }, 'object');
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const result = (ok: Schema, extra: string) => ({
    type: 'object',
    required: ['ok'],
    properties: { ok, [extra]: { type: 'string' } },
  });
  const accepted = { '200': { description: 'OK' } };
  /** `POST` sending and returning `body`. */
  const echo = (operationId: string, body: Schema) => ({
    post: {
      operationId,
      requestBody: { content: json(body) },
      responses: { '200': { description: 'OK', content: json(body) } },
    },
  });
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    webhooks: {
      flagSet: { post: { requestBody: { content: json(yes) }, responses: accepted } },
      flagChanged: { post: { requestBody: { content: json({ oneOf: [yes, no] }) }, responses: accepted } },
    },
    paths: {
      '/one-of': echo('sendOneOf', { oneOf: [yes, no] }),
      '/any-of': echo('sendAnyOf', { anyOf: [no, yes] }),
      '/one-of-null': echo('sendOneOfNull', { oneOf: [yes, pinOf(null)] }),
      '/one-of-object': echo('sendOneOfObject', { oneOf: [object, { type: 'object', properties: { flag: yes } }] }),
      '/subscriptions': {
        post: {
          operationId: 'subscribe',
          parameters: [{ name: 'url', in: 'query', schema: { type: 'string' } }],
          responses: accepted,
          callbacks: {
            onFlag: {
              '{$request.query.url}': {
                post: { requestBody: { content: json({ oneOf: [yes, no] }) }, responses: accepted },
              },
            },
          },
        },
      },
      '/notes': {
        get: {
          operationId: 'listNotes',
          parameters: [
            { name: 'viaContent', in: 'query', content: json(yes) },
            { name: 'X-Via-Content', in: 'header', content: json(object) },
            { name: 'flags', in: 'query', schema: { type: 'array', items: yes } },
            { $ref: '#/components/parameters/Shared' },
          ],
          responses: {
            '200': {
              description: 'OK',
              headers: { 'X-Content': { content: json(yes) }, 'X-Shared': { $ref: '#/components/headers/Shared' } },
              content: json(ref('Note')),
            },
            default: {
              description: 'Error',
              content: json({ type: 'object', properties: { ok: no, why: pinOf(null) } }),
            },
          },
        },
        post: {
          operationId: 'createNote',
          requestBody: {
            content: {
              'application/json': { schema: { type: 'object', properties: { archived: yes, meta: object } } },
              'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { archived: yes } } },
              'multipart/form-data': { schema: { type: 'object', properties: { archived: no } } },
            },
          },
          responses: {
            '201': { description: 'Created', content: json({ type: 'array', items: yes }) },
            '400': { description: 'Bad request', content: json(result(no, 'reason')) },
            '409': { description: 'Conflict', content: json(result(no, 'reason')) },
          },
        },
      },
    },
    components: {
      parameters: { Shared: { name: 'shared', in: 'query', schema: yes } },
      headers: { Shared: { schema: object } },
      schemas: {
        Note: {
          type: 'object',
          properties: {
            annotated: { allOf: [yes, { description: 'Always true.' }] },
            nested: { allOf: [{ allOf: [yes] }] },
            pattern: { type: 'object', patternProperties: { '^x-': yes } },
            typeList: pinOf(true, ['boolean', 'string']),
            nullableTypeList: pinOf(true, ['boolean', 'string', 'null']),
            objectTypeList: { ...pinOf({ a: 1 }, ['object', 'string']), properties: { a: { type: 'integer' } } },
            typedNull: { oneOf: [{ ...pinOf(null), type: 'string' }, { type: 'integer' }] },
            nullVariant: { oneOf: [{ type: 'integer' }, pinOf(null)] },
            deep: { type: 'object', properties: { list: { type: 'array', items: { oneOf: [yes, object] } } } },
            readOnly: { ...yes, readOnly: true },
            defaulted: { ...yes, default: true, example: true },
            deprecated: { ...object, deprecated: true },
            linked: { ...yes, externalDocs: { url: 'https://example.com/flag' } },
            extended: { ...yes, 'x-internal': true },
            titled: { ...object, title: 'Meta' },
          },
        },
        Base: { type: 'object', properties: { flag: { type: 'boolean' }, meta: { type: 'object' } } },
        Child: { allOf: [ref('Base'), { type: 'object', properties: { flag: pinOf(true), meta: pinOf({ a: 1 }) } }] },
        Dispatcher: {
          type: 'object',
          properties: { name: { type: 'string' } },
          oneOf: [result(yes, 'data'), result(no, 'error')],
        },
        Results: {
          oneOf: [
            { ...result(yes, 'data'), title: 'Success' },
            { ...result(no, 'error'), title: 'Failure' },
          ],
        },
        Holder: {
          type: 'object',
          properties: {
            dispatcher: ref('Dispatcher'),
            results: ref('Results'),
            child: ref('Child'),
            inline: { oneOf: [result(yes, 'data'), result(no, 'error')], discriminator: { propertyName: 'ok' } },
          },
        },
      },
    },
  };
}

describe('#667 a single-value `enum` is read as the same `const` is', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-667-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    log.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeJson(name: string, doc: unknown): Promise<string> {
    const file = path.join(tmpDir, name);
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return file;
  }

  const parseJson = async (doc: unknown, name = 'spec.json'): Promise<ApiSpec> => parseSpec(await writeJson(name, doc));

  /** The exit code of `oagen diff --old before --new after`. */
  const exitCodeOf = async (before: string, after: string) => {
    const err: unknown = await diffCommand({ old: before, new: after }).catch((e: unknown) => e);
    return (err as { exitCode: number }).exitCode;
  };

  /** Every `console.warn` message so far, in order. */
  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));
  const operationOf = (spec: ApiSpec, operationId: string): Operation | undefined =>
    spec.services.flatMap(({ operations }) => operations).find((op) => op.operationId === operationId);
  const fieldTypes = (spec: ApiSpec, modelName: string): Record<string, TypeRef> =>
    Object.fromEntries(spec.models.find(({ name }) => name === modelName)?.fields.map((f) => [f.name, f.type]) ?? []);
  const enumsOf = (spec: ApiSpec) => spec.enums.map(({ name, values }) => [name, values.map(({ value }) => value)]);

  /** The issue's script: the type of `Note.archived` and of the `archived` query parameter. */
  const issueLine = (spec: ApiSpec) => {
    const [{ queryParams }] = spec.services.flatMap(({ operations }) => operations);
    return `${JSON.stringify(spec.models[0]!.fields[0]!.type)} ${JSON.stringify(queryParams[0]!.type)}`;
  };

  describe("the issue's repro", () => {
    const documents = {
      'const.json': issueDocument('3.1.0', { type: 'boolean', const: true }),
      'enum.json': issueDocument('3.1.0', { type: 'boolean', enum: [true] }),
      'enum-3.0.json': issueDocument('3.0.3', { type: 'boolean', enum: [true] }),
    };

    it('types `enum: [true]` as the boolean literal on the field and the parameter, as `const: true` is', async () => {
      const lines: string[] = [];
      for (const [name, doc] of Object.entries(documents))
        lines.push(`${name} ${issueLine(await parseJson(doc, name))}`);
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "const.json {"kind":"literal","value":true} {"kind":"literal","value":true}
        enum.json {"kind":"literal","value":true} {"kind":"literal","value":true}
        enum-3.0.json {"kind":"literal","value":true} {"kind":"literal","value":true}"
      `);
      expect(warnings()).toEqual([]);
    });

    it('`oagen diff` between the spellings reports nothing, in either direction (exit 0)', async () => {
      const files: Record<string, string> = {};
      for (const [name, doc] of Object.entries(documents)) files[name] = await writeJson(name, doc);
      for (const before of Object.keys(files)) {
        for (const after of Object.keys(files)) {
          if (before === after) continue;
          const label = `${before} -> ${after}`;
          const [oldSpec, newSpec] = [await parseSpec(files[before]!), await parseSpec(files[after]!)];
          const { changes, summary } = diffSpecs(oldSpec, newSpec);
          expect(changes, label).toEqual([]);
          expect(summary.breaking, label).toBe(0);
          expect(await exitCodeOf(files[before]!, files[after]!), label).toBe(0);
        }
      }
    });

    it.each(['3.1.0', '3.0.3'])(
      'types a `oneOf` of single-value boolean enums as a union of `true` and `false`, as the `oneOf` of consts is, on OpenAPI %s',
      async (openapi) => {
        const ofEnums = {
          oneOf: [
            { type: 'boolean', enum: [true] },
            { type: 'boolean', enum: [false] },
          ],
        };
        const ofConsts = {
          oneOf: [
            { type: 'boolean', const: true },
            { type: 'boolean', const: false },
          ],
        };
        const expected = { kind: 'union', variants: [literal(true), literal(false)], compositionKind: 'oneOf' };
        const enums = await parseJson(issueDocument(openapi, ofEnums));
        expect(fieldTypes(enums, 'Note')).toEqual({ archived: expected });
        expect(operationOf(enums, 'listNotes')?.queryParams[0]?.type).toEqual(expected);
        expect(enums.enums).toEqual([]);
        expect(enums).toEqual(await parseJson(issueDocument(openapi, ofConsts)));
      },
    );

    it.each(['3.1.0', '3.0.3'])(
      'types an object value as the map its `const` is, not the literal `[object Object]`, on OpenAPI %s',
      async (openapi) => {
        const ofEnum = await parseJson(issueDocument(openapi, { type: 'object', enum: [{ a: 1 }] }));
        const expected = { kind: 'map', valueType: unknown };
        expect(fieldTypes(ofEnum, 'Note')).toEqual({ archived: expected });
        expect(operationOf(ofEnum, 'listNotes')?.queryParams[0]?.type).toEqual(expected);
        expect(ofEnum).toEqual(await parseJson(issueDocument(openapi, { type: 'object', const: { a: 1 } })));
      },
    );
  });

  describe.each(['3.1.0', '3.0.3'])('every value, at every site, on OpenAPI %s', (openapi) => {
    // [label, the value, another value of its kind for the union sites, the type a schema pinned to the value has]
    const values: Array<[string, unknown, unknown, TypeRef]> = [
      ['true', true, false, literal(true)],
      ['false', false, true, literal(false)],
      ['an integer', 1, 2, literal(1)],
      ['zero', 0, 1, literal(0)],
      ['a fraction', 1.5, 2.5, literal(1.5)],
      ['a string', 'a', 'b', literal('a')],
      ['the empty string', '', 'b', literal('')],
      ["the string 'true'", 'true', 'false', literal('true')],
      ['null', null, 'b', nullable(unknown)],
      ['an object', { a: 1 }, { b: 2 }, { kind: 'map', valueType: unknown }],
      ['an empty object', {}, { b: 2 }, { kind: 'map', valueType: unknown }],
      ['an array', [1], [2], { kind: 'array', items: unknown }],
      ['an empty array', [], [2], { kind: 'array', items: unknown }],
    ];

    for (const typed of [true, false]) {
      it.each(values)(
        `%s ${typed ? 'beside its `type`' : 'with no `type`'} is one IR under \`const\` and under a one-value \`enum\``,
        async (_label, value, otherValue, expected) => {
          const document = (spelling: Spelling) =>
            everySiteDocument(openapi, pin(spelling, value, openapi, typed), pin(spelling, otherValue, openapi, typed));
          const ofConst = await parseJson(document('const'), 'const.json');
          const ofEnum = await parseJson(document('enum'), 'enum.json');

          // The value's own type, where the schema stands alone.
          const listNotes = operationOf(ofEnum, 'listNotes');
          const postRaw = operationOf(ofEnum, 'postRaw');
          const note = fieldTypes(ofEnum, 'Note');
          expect({
            plain: note.plain,
            required: note.required,
            described: note.described,
            items: note.items,
            values: note.values,
            member: note.member,
            query: listNotes?.queryParams.find(({ name }) => name === 'q')?.type,
            header: listNotes?.headerParams.find(({ name }) => name === 'X-H')?.type,
            path: listNotes?.pathParams[0]?.type,
            cookie: listNotes?.cookieParams?.[0]?.type,
            responseHeader: listNotes?.responseHeaders?.[0]?.type,
            requestBody: postRaw?.requestBody,
            response: postRaw?.response,
          }).toEqual({
            plain: expected,
            required: expected,
            described: expected,
            items: { kind: 'array', items: expected },
            values: { kind: 'map', valueType: expected },
            member: expected,
            query: expected,
            header: expected,
            path: expected,
            cookie: expected,
            responseHeader: expected,
            requestBody: expected,
            response: expected,
          });

          // Every other site — the unions, the nullable wrappers, the error
          // body, the webhook payload, the callback body — and every model
          // and enum the document mints: the two spellings are one IR.
          expect(ofEnum).toEqual(ofConst);
          expect(diffSpecs(ofConst, ofEnum).changes).toEqual([]);
          expect(diffSpecs(ofEnum, ofConst).changes).toEqual([]);
          expect(await exitCodeOf(path.join(tmpDir, 'const.json'), path.join(tmpDir, 'enum.json'))).toBe(0);
          expect(await exitCodeOf(path.join(tmpDir, 'enum.json'), path.join(tmpDir, 'const.json'))).toBe(0);
        },
      );
    }
  });

  it.each(['3.1.0', '3.0.3'])(
    'is one IR where the pin is read through another object or beside other keywords, on OpenAPI %s',
    async (openapi) => {
      const withType = (type?: string | string[]) => (type === undefined ? {} : { type });
      const ofConst = await parseJson(
        furtherSitesDocument(openapi, (value, type) => ({ ...withType(type), const: value })),
        'const.json',
      );
      const ofEnum = await parseJson(
        furtherSitesDocument(openapi, (value, type) => ({ ...withType(type), enum: [value] })),
        'enum.json',
      );

      const listNotes = operationOf(ofEnum, 'listNotes');
      const createNote = operationOf(ofEnum, 'createNote');
      const object = { kind: 'map', valueType: unknown };
      expect(Object.fromEntries(listNotes?.queryParams.map(({ name, type }) => [name, type]) ?? [])).toEqual({
        viaContent: literal(true),
        flags: { kind: 'array', items: literal(true) },
        shared: literal(true),
      });
      expect(listNotes?.headerParams.map(({ type }) => type)).toEqual([object]);
      expect(listNotes?.responseHeaders?.map(({ type }) => type)).toEqual([literal(true), object]);
      expect(createNote?.response).toEqual({ kind: 'array', items: literal(true) });
      expect(operationOf(ofEnum, 'sendOneOf')?.requestBody).toEqual({
        kind: 'union',
        variants: [literal(true), literal(false)],
      });
      expect(operationOf(ofEnum, 'sendAnyOf')?.response).toEqual({
        kind: 'union',
        variants: [literal(false), literal(true)],
        compositionKind: 'anyOf',
      });
      expect(operationOf(ofEnum, 'sendOneOfNull')?.requestBody).toEqual(nullable(literal(true)));
      expect(operationOf(ofEnum, 'sendOneOfObject')?.requestBody).toEqual({
        kind: 'union',
        variants: [object, { kind: 'model', name: 'SendOneOfObjectRequest' }],
      });
      expect(fieldTypes(ofEnum, 'CreateNoteRequest')).toEqual({ archived: literal(true), meta: object });
      expect(fieldTypes(ofEnum, 'Note')).toMatchObject({
        annotated: literal(true),
        nested: literal(true),
        pattern: { kind: 'map', valueType: literal(true) },
        typeList: literal(true),
        nullableTypeList: nullable(literal(true)),
        objectTypeList: object,
        typedNull: { kind: 'union', variants: [nullable(unknown), { kind: 'primitive', type: 'integer' }] },
        nullVariant: nullable({ kind: 'primitive', type: 'integer' }),
        readOnly: literal(true),
        deprecated: object,
      });
      // The two error bodies share one model, named from the value `ok` pins.
      expect(createNote?.errors.map(({ type }) => type)).toEqual([
        { kind: 'model', name: 'ErrorBodyWithOkFalseWithoutMessage' },
        { kind: 'model', name: 'ErrorBodyWithOkFalseWithoutMessage' },
      ]);
      expect(ofEnum.enums).toEqual([]);

      expect(ofEnum).toEqual(ofConst);
      expect(diffSpecs(ofConst, ofEnum).changes).toEqual([]);
      expect(diffSpecs(ofEnum, ofConst).changes).toEqual([]);
    },
  );

  describe('`null` in the list', () => {
    it('beside the one value marks nullability: `enum: [true, null]` is the nullable boolean literal', async () => {
      const spec = await parseJson(
        noteDocument('3.1.0', {
          typeList: { type: ['boolean', 'null'], enum: [true, null] },
          untyped: { enum: [null, false] },
          object: { enum: [{ a: 1 }, null] },
          // The same three, spelled with consts.
          typeListConst: { oneOf: [{ type: 'boolean', const: true }, { type: 'null' }] },
          untypedConst: { oneOf: [{ type: 'null' }, { const: false }] },
          objectConst: { oneOf: [{ const: { a: 1 } }, { type: 'null' }] },
        }),
      );
      expect(fieldTypes(spec, 'Note')).toEqual({
        typeList: nullable(literal(true)),
        untyped: nullable(literal(false)),
        object: nullable({ kind: 'map', valueType: unknown }),
        typeListConst: nullable(literal(true)),
        untypedConst: nullable(literal(false)),
        objectConst: nullable({ kind: 'map', valueType: unknown }),
      });
      expect(spec.enums).toEqual([]);
    });

    it('reads the OAS 3.0 flag beside a one-value boolean enum as it reads it beside the const', async () => {
      const spec = await parseJson(
        noteDocument('3.0.3', {
          flagged: { type: 'boolean', enum: [true], nullable: true },
          listed: { type: 'boolean', enum: [true, null], nullable: true },
          flaggedConst: { type: 'boolean', const: true, nullable: true },
        }),
      );
      expect(fieldTypes(spec, 'Note')).toEqual({
        flagged: nullable(literal(true)),
        listed: nullable(literal(true)),
        flaggedConst: nullable(literal(true)),
      });
    });

    it.each(['3.1.0', '3.0.3'])(
      'alone is `nullable<unknown>`, as `const: null` is, and lifts no enum without members, on OpenAPI %s',
      async (openapi) => {
        const spec = await parseJson(
          noteDocument(openapi, {
            alone: { enum: [null] },
            twice: { enum: [null, null] },
            besideType: { type: 'string', enum: [null] },
            flagged: { type: 'string', nullable: true, enum: [null] },
            const: { const: null },
            constBesideType: { type: 'string', const: null },
          }),
        );
        expect(fieldTypes(spec, 'Note')).toEqual({
          alone: nullable(unknown),
          twice: nullable(unknown),
          besideType: nullable(unknown),
          flagged: nullable(unknown),
          const: nullable(unknown),
          constBesideType: nullable(unknown),
        });
        expect(spec.enums).toEqual([]);
        expect(warnings()).toEqual([]);
      },
    );
  });

  describe('beside the other keywords of its schema', () => {
    it('carries the limits written beside it, as the const does (#545)', async () => {
      const spec = await parseJson(
        noteDocument('3.1.0', {
          object: { type: 'object', enum: [{ a: 1 }], minProperties: 1 },
          objectConst: { type: 'object', const: { a: 1 }, minProperties: 1 },
          array: { type: 'array', enum: [[1]], minItems: 1 },
          arrayConst: { type: 'array', const: [1], minItems: 1 },
          string: { type: 'string', enum: ['a'], maxLength: 3 },
          stringConst: { type: 'string', const: 'a', maxLength: 3 },
        }),
      );
      const types = fieldTypes(spec, 'Note');
      expect(types.object).toEqual({ kind: 'map', valueType: unknown, constraints: { minProperties: 1 } });
      expect(types.array).toEqual({ kind: 'array', items: unknown, constraints: { minItems: 1 } });
      expect(types.string).toEqual({ kind: 'literal', value: 'a', constraints: { maxLength: 3 } });
      expect(types.objectConst).toEqual(types.object);
      expect(types.arrayConst).toEqual(types.array);
      expect(types.stringConst).toEqual(types.string);
    });

    it('is typed once for a type list naming several types, and builds no model for `properties` beside it', async () => {
      const spec = await parseJson(
        noteDocument('3.1.0', {
          typeList: { type: ['boolean', 'string'], enum: [true] },
          typeListConst: { type: ['boolean', 'string'], const: true },
          withProperties: { type: 'object', properties: { a: { type: 'integer' } }, enum: [{ a: 1 }] },
          withPropertiesConst: { type: 'object', properties: { a: { type: 'integer' } }, const: { a: 1 } },
        }),
      );
      expect(fieldTypes(spec, 'Note')).toEqual({
        typeList: literal(true),
        typeListConst: literal(true),
        withProperties: { kind: 'map', valueType: unknown },
        withPropertiesConst: { kind: 'map', valueType: unknown },
      });
      expect(spec.models.map(({ name }) => name)).toEqual(['Note']);
      expect(spec.enums).toEqual([]);
      expect(warnings()).toEqual([]);
    });
  });

  describe('what stays as it was', () => {
    it.each(['3.1.0', '3.0.3'])(
      'a one-value string or number enum is the literal it was, on OpenAPI %s',
      async (openapi) => {
        const spec = await parseJson(
          noteDocument(openapi, {
            object: { type: 'string', enum: ['note'] },
            version: { type: 'integer', enum: [2] },
            ratio: { type: 'number', enum: [0.5] },
            digits: { type: 'string', enum: ['2'] },
            flag: { type: 'string', enum: ['true'] },
          }),
        );
        expect(fieldTypes(spec, 'Note')).toEqual({
          object: literal('note'),
          version: literal(2),
          ratio: literal(0.5),
          digits: literal('2'),
          flag: literal('true'),
        });
      },
    );

    it.each(['3.1.0', '3.0.3'])(
      'a discriminator pin written as a one-value string `enum` still maps its variant, on OpenAPI %s',
      async (openapi) => {
        const animal = (kind: Schema) => ({
          type: 'object',
          required: ['kind'],
          properties: { kind, name: { type: 'string' } },
        });
        const document = (pinOf: (kind: string) => Schema) =>
          noteDocument(
            openapi,
            { pet: { $ref: '#/components/schemas/Pet' } },
            {
              Pet: {
                oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
                discriminator: { propertyName: 'kind' },
              },
              Cat: animal(pinOf('cat')),
              Dog: animal(pinOf('dog')),
            },
          );
        const ofEnum = await parseJson(document((kind) => ({ type: 'string', enum: [kind] })));
        expect(ofEnum.models.find(({ name }) => name === 'Pet')?.discriminator).toEqual({
          property: 'kind',
          mapping: { cat: 'Cat', dog: 'Dog' },
        });
        expect(fieldTypes(ofEnum, 'Cat').kind).toEqual(literal('cat'));
        expect(ofEnum).toEqual(await parseJson(document((kind) => ({ type: 'string', const: kind }))));
      },
    );

    it.each(['3.1.0', '3.0.3'])(
      'a boolean pin maps no variant in either spelling, and the two are one IR, on OpenAPI %s',
      async (openapi) => {
        const result = (ok: Schema) => ({
          type: 'object',
          required: ['ok'],
          properties: { ok, detail: { type: 'string' } },
        });
        const document = (pinOf: (ok: boolean) => Schema) =>
          noteDocument(
            openapi,
            { result: { $ref: '#/components/schemas/Result' } },
            {
              Result: {
                oneOf: [{ $ref: '#/components/schemas/Success' }, { $ref: '#/components/schemas/Failure' }],
                discriminator: { propertyName: 'ok' },
              },
              Success: result(pinOf(true)),
              Failure: result(pinOf(false)),
            },
          );
        const ofEnum = await parseJson(document((ok) => ({ type: 'boolean', enum: [ok] })));
        expect(ofEnum.models.find(({ name }) => name === 'Result')?.discriminator).toEqual({
          property: 'ok',
          mapping: {},
        });
        expect(fieldTypes(ofEnum, 'Success').ok).toEqual(literal(true));
        expect(fieldTypes(ofEnum, 'Failure').ok).toEqual(literal(false));
        expect(ofEnum).toEqual(await parseJson(document((ok) => ({ type: 'boolean', const: ok }))));
      },
    );

    it('a list of two or more values is an enum, its members in their string form unless numbers', async () => {
      const spec = await parseJson(
        noteDocument('3.1.0', {
          flag: { type: 'boolean', enum: [true, false] },
          mixed: { enum: [1, 'a', true] },
        }),
      );
      expect(fieldTypes(spec, 'Note')).toEqual({
        flag: { kind: 'enum', name: 'NoteFlag', values: ['true', 'false'] },
        mixed: { kind: 'enum', name: 'NoteMixed', values: [1, 'a', 'true'] },
      });
      expect(enumsOf(spec)).toEqual([
        ['NoteFlag', ['true', 'false']],
        ['NoteMixed', [1, 'a', 'true']],
      ]);
    });

    it('a component that declares an `enum:` list is an `Enum` whatever the list holds, one value included', async () => {
      const spec = await parseJson(
        noteDocument(
          '3.1.0',
          { flag: { $ref: '#/components/schemas/Flag' }, kind: { $ref: '#/components/schemas/Kind' } },
          { Flag: { type: 'boolean', enum: [true] }, Kind: { type: 'string', enum: ['note'] } },
        ),
      );
      expect(fieldTypes(spec, 'Note')).toEqual({
        flag: { kind: 'enum', name: 'Flag' },
        kind: { kind: 'enum', name: 'Kind' },
      });
      expect(enumsOf(spec)).toEqual([
        ['Flag', ['true']],
        ['Kind', ['note']],
      ]);
    });
  });
});
