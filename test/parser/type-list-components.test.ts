import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { assignModelsToServices, walkTypeRef } from '../../src/ir/types.js';
import type { ApiSpec, Field, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #730: a component whose type list names `array` or `object` beside
 * another type (`Tags: { type: ['array', 'string'], items }`, `Owner: {
 * type: ['object', 'string'], properties }`) was neither an array component
 * nor a primitive one, so it became a model, and every `$ref` to it was that
 * model alone: a fieldless `Tags`, and `Owner` without its `string`. Where
 * the same schemas are written they are `string[] | string` and the model
 * beside a `string`. A `$ref` to the component is now what the schema is in
 * place: a list with no `object` is an array component, typed as the union
 * of its array and its other types with its items named under the component;
 * a list naming `object` is the model it always built, each reference
 * carrying the other types beside it, as it carries a `null`.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const named = { name: string };
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });

/** The issue's document: `GET /notes/{noteId}` (`getNote`) returning `$ref: Note`. */
function document(schemas: Record<string, unknown>, openapi = '3.1.0', paths?: Record<string, unknown>) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: paths ?? {
      '/notes/{noteId}': {
        get: {
          operationId: 'getNote',
          parameters: [{ name: 'noteId', in: 'path', required: true, schema: string }],
          responses: { '200': { description: 'OK', ...json(ref('Note')) } },
        },
      },
    },
    components: { schemas },
  };
}

/** `Note` with `x` written as `schema`. */
const note = (schema: unknown) => ({ type: 'object', properties: { x: schema } });

/** The issue's two documents. */
const TAGS = { type: ['array', 'string'], items: string };
const OWNER = { type: ['object', 'string'], properties: named };
const INLINE = { Note: { type: 'object', properties: { tags: TAGS, owner: OWNER } } };
const COMPONENT = {
  Note: { type: 'object', properties: { tags: ref('Tags'), owner: ref('Owner') } },
  Tags: TAGS,
  Owner: OWNER,
};

/** The issue's script: a type as its variants, its items, its name. */
const typeOf = (type: TypeRef): string =>
  type.kind === 'union'
    ? type.variants.map(typeOf).join(' | ')
    : type.kind === 'array'
      ? `${typeOf(type.items)}[]`
      : 'name' in type
        ? type.name
        : 'type' in type
          ? type.type
          : type.kind;
const script = ({ models }: ApiSpec): string[] =>
  models.map(
    ({ fields, name }) => `${name} { ${fields.map((field) => `${field.name}: ${typeOf(field.type)}`).join(', ')} }`,
  );

/** A type with its limits, nested unions in parentheses. */
function show(type: TypeRef): string {
  const limits = 'constraints' in type && type.constraints ? ` ${JSON.stringify(type.constraints)}` : '';
  switch (type.kind) {
    case 'union':
      return `(${type.variants.map(show).join(' | ')})${limits}`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `${show(type.items)}[]${limits}`;
    case 'map':
      return `map<${show(type.valueType)}>${limits}`;
    case 'literal':
      return `${JSON.stringify(type.value)}${limits}`;
    case 'primitive':
      return `${type.type}${type.format ? `:${type.format}` : ''}${limits}`;
    case 'enum':
      return `enum ${type.name}`;
    default:
      return type.name;
  }
}

/** A model as its name, its fields and what it carries beside them. */
const showModel = (model: Model): string => {
  const fields = model.fields.map((field) => `${field.name}${field.required ? '' : '?'}: ${show(field.type)}`);
  const extras = [
    model.variants ? `variants ${model.compositionKind}[${model.variants.map(show).join(' | ')}]` : '',
    model.bases ? `bases [${model.bases.map(show).join(', ')}]` : '',
    model.constraints ? `limits ${JSON.stringify(model.constraints)}` : '',
    model.description ? `"${model.description}"` : '',
    model.deprecated ? 'deprecated' : '',
  ].filter(Boolean);
  return `${model.name} { ${fields.join(', ')} }${extras.length ? ` ${extras.join(' ')}` : ''}`;
};

describe('#730 a component whose type list names `array` or `object` beside another type', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-type-list-components-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  let specs = 0;
  async function writeJson(doc: unknown): Promise<string> {
    const specFile = path.join(tmpDir, `spec-${specs++}.json`);
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return specFile;
  }
  const parseJson = async (doc: unknown): Promise<ApiSpec> => parseSpec(await writeJson(doc));
  const parse = async (schemas: Record<string, unknown>, openapi = '3.1.0'): Promise<ApiSpec> =>
    parseJson(document(schemas, openapi));

  const modelOf = (spec: ApiSpec, name: string): Model => spec.models.find((model) => model.name === name)!;
  const fieldOf = (spec: ApiSpec, model: string, name: string): Field =>
    modelOf(spec, model).fields.find((field) => field.name === name)!;
  const names = (spec: ApiSpec): string[] => spec.models.map(({ name }) => name).sort();
  const warnings = (): string[] => warn.mock.calls.map((call: unknown[]) => String(call[0]));
  /** `Note.x` written as `$ref: X`, with `X` the given schema: the field's type and the models beside `Note`. */
  const component = async (x: unknown, more: Record<string, unknown> = {}, openapi = '3.1.0'): Promise<string> => {
    const spec = await parse({ Note: note(ref('X')), X: x, ...more }, openapi);
    const others = spec.models.filter(({ name }) => name !== 'Note' && !Object.hasOwn(more, name)).map(showModel);
    return [show(fieldOf(spec, 'Note', 'x').type), ...others].join(' ; ');
  };
  /** `Note.x` written as `schema` in place: the same. */
  const inline = async (schema: unknown, more: Record<string, unknown> = {}): Promise<string> => {
    const spec = await parse({ Note: note(schema), ...more });
    const others = spec.models.filter(({ name }) => name !== 'Note' && !Object.hasOwn(more, name)).map(showModel);
    return [show(fieldOf(spec, 'Note', 'x').type), ...others].join(' ; ');
  };
  /** Each `[label, schema]` as a component, one `label: reading` per line. */
  const table = async (rows: Record<string, unknown>, more: Record<string, unknown> = {}): Promise<string> => {
    const lines: string[] = [];
    for (const [label, schema] of Object.entries(rows)) lines.push(`${label}: ${await component(schema, more)}`);
    return lines.join('\n');
  };
  /** `oagen diff` from one document to another, as its entries. */
  const changes = (from: ApiSpec, to: ApiSpec): string[] =>
    diffSpecs(from, to).changes.map((change) => {
      const name = 'name' in change ? ` ${change.name}` : '';
      const fields =
        'fieldChanges' in change && change.fieldChanges
          ? ` [${change.fieldChanges.map((field) => `${field.kind} ${field.fieldName}`).join(', ')}]`
          : '';
      return `${change.kind}${name}${fields}`;
    });
  const expectNoDiff = (a: ApiSpec, b: ApiSpec, label: string) => {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const diff = diffSpecs(from, to);
      expect(diff.changes, label).toEqual([]);
      expect(diff.summary.breaking, label).toBe(0);
    }
  };
  /** The exit code of `oagen diff --old from --new to`. */
  const exitCode = async (from: unknown, to: unknown): Promise<number> => {
    const [oldFile, newFile] = [await writeJson(from), await writeJson(to)];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const error = (await diffCommand({ old: oldFile, new: newFile }).catch((e: unknown) => e)) as {
        exitCode: number;
      };
      return error.exitCode;
    } finally {
      log.mockRestore();
    }
  };
  /** Every model a document's types reference, by name. */
  const referenced = (spec: ApiSpec): Set<string> => {
    const seen = new Set<string>();
    const visit = (type: TypeRef | undefined): void => {
      if (type) walkTypeRef(type, { model: (model) => void seen.add(model.name) });
    };
    for (const model of spec.models) {
      for (const field of model.fields) visit(field.type);
      for (const variant of model.variants ?? []) visit(variant);
      for (const base of model.bases ?? []) visit(base);
    }
    for (const operation of spec.services.flatMap((service) => service.operations)) {
      visit(operation.response);
      visit(operation.requestBody);
      for (const parameter of [...operation.pathParams, ...operation.queryParams, ...operation.headerParams]) {
        visit(parameter.type);
      }
    }
    return seen;
  };
  /** No reference names a model the document does not hold. */
  const expectNoDanglingReference = (spec: ApiSpec, label = ''): void => {
    const held = new Set(spec.models.map(({ name }) => name));
    expect(
      [...referenced(spec)].filter((name) => !held.has(name)),
      label,
    ).toEqual([]);
    expect(
      warnings().filter((text) => text.includes('Unresolved')),
      label,
    ).toEqual([]);
  };

  describe('the issue', () => {
    it.each(['3.0.3', '3.1.0'])(
      'types a `$ref` to `Tags` and to `Owner` as the schemas are in place (the repro), under OAS %s',
      async (openapi) => {
        const inlineSpec = await parse(INLINE, openapi);
        const componentSpec = await parse(COMPONENT, openapi);
        // The issue's script.
        expect({ 'inline.json': script(inlineSpec), 'component.json': script(componentSpec) }).toMatchInlineSnapshot(`
          {
            "component.json": [
              "Note { tags: string[] | string, owner: Owner | string }",
              "Owner { name: string }",
            ],
            "inline.json": [
              "Note { tags: string[] | string, owner: NoteOwner | string }",
              "NoteOwner { name: string }",
            ],
          }
        `);
        // `Tags` is no model; `Owner` is the model it was, and `Note` names it beside a string.
        expect(names(componentSpec)).toEqual(['Note', 'Owner']);
        expect(fieldOf(componentSpec, 'Note', 'tags')).toEqual(fieldOf(inlineSpec, 'Note', 'tags'));
        expect(fieldOf(componentSpec, 'Note', 'owner').type).toEqual({
          kind: 'union',
          variants: [
            { kind: 'model', name: 'Owner' },
            { kind: 'primitive', type: 'string' },
          ],
        });
        expect(modelOf(componentSpec, 'Owner')).toEqual({ ...modelOf(inlineSpec, 'NoteOwner'), name: 'Owner' });
        expectNoDanglingReference(componentSpec);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('`oagen diff` between the two reports `Tags` nowhere and the object under its component name, in both directions', async () => {
      const [inlineSpec, componentSpec] = [await parse(INLINE), await parse(COMPONENT)];
      expect({
        'inline -> component': changes(inlineSpec, componentSpec),
        'component -> inline': changes(componentSpec, inlineSpec),
      }).toMatchInlineSnapshot(`
        {
          "component -> inline": [
            "model-added NoteOwner",
            "model-removed Owner",
            "model-modified Note [field-type-changed owner]",
          ],
          "inline -> component": [
            "model-added Owner",
            "model-removed NoteOwner",
            "model-modified Note [field-type-changed owner]",
          ],
        }
      `);
      // What is left is the name of the object: `NoteOwner` where it is written in `Note`, `Owner` as a
      // component. Extracting a plain object into a component reports exactly that, with no type list at all.
      const plain = { type: 'object', properties: named };
      const [plainInline, plainComponent] = [
        await parse({ Note: { type: 'object', properties: { tags: TAGS, owner: plain } } }),
        await parse({
          Note: { type: 'object', properties: { tags: ref('Tags'), owner: ref('Owner') } },
          Tags: TAGS,
          Owner: plain,
        }),
      ];
      expect(changes(plainInline, plainComponent)).toEqual(changes(inlineSpec, componentSpec));
      expect(changes(plainComponent, plainInline)).toEqual(changes(componentSpec, inlineSpec));
      expect(await exitCode(document(INLINE), document(COMPONENT))).toBe(2);
      expect(await exitCode(document(COMPONENT), document(INLINE))).toBe(2);
    });

    it('`oagen diff` reports nothing once the object keeps one name: `Tags` extracted, and `Owner` named `NoteOwner`', async () => {
      const tagsOnly = { Note: { type: 'object', properties: { tags: ref('Tags'), owner: OWNER } }, Tags: TAGS };
      expectNoDiff(await parse(INLINE), await parse(tagsOnly), 'tags extracted');
      expect(await exitCode(document(INLINE), document(tagsOnly))).toBe(0);
      expect(await exitCode(document(tagsOnly), document(INLINE))).toBe(0);
      // The object extracted under the name it has in place.
      const sameName = {
        Note: { type: 'object', properties: { tags: ref('Tags'), owner: ref('NoteOwner') } },
        Tags: TAGS,
        NoteOwner: OWNER,
      };
      expectNoDiff(await parse(INLINE), await parse(sameName), 'owner extracted as NoteOwner');
      expect(await exitCode(document(INLINE), document(sameName))).toBe(0);
      expect(await exitCode(document(sameName), document(INLINE))).toBe(0);
    });
  });

  describe('the spellings of one component', () => {
    it('reads `Tags` with its `items` beside the list as it reads them in an `allOf` member, and the `oneOf` as the named union it was', async () => {
      const spellings = {
        'beside the list': TAGS,
        'in an allOf member': { type: ['array', 'string'], allOf: [{ items: string }] },
        'in a lone allOf member with the list': { allOf: [TAGS] },
        oneOf: { oneOf: [{ type: 'array', items: string }, string] },
      };
      expect(await table(spellings)).toMatchInlineSnapshot(`
        "beside the list: (string[] | string)
        in an allOf member: (string[] | string)
        in a lone allOf member with the list: (string[] | string)
        oneOf: X ; X {  } variants oneOf[string[] | string]"
      `);
      const parsed: ApiSpec[] = [];
      for (const schema of Object.values(spellings).slice(0, 3))
        parsed.push(await parse({ Note: note(ref('X')), X: schema }));
      for (const spec of parsed) expectNoDiff(parsed[0]!, spec, 'tags spellings');
    });

    it('reads `Owner` with its `properties` beside the list as it reads them in an `allOf` member, and the `oneOf` as the named union it was', async () => {
      const spellings = {
        'beside the list': OWNER,
        'in an allOf member': { type: ['object', 'string'], allOf: [{ properties: named }] },
        'in a lone allOf member with the list': { allOf: [OWNER] },
        oneOf: { oneOf: [{ type: 'object', properties: named }, string] },
      };
      expect(await table(spellings)).toMatchInlineSnapshot(`
        "beside the list: (X | string) ; X { name?: string }
        in an allOf member: (X | string) ; X { name?: string }
        in a lone allOf member with the list: (X | string) ; X { name?: string }
        oneOf: X ; X { name?: string } variants oneOf[XWithName | string] ; XWithName { name?: string }"
      `);
      const parsed: ApiSpec[] = [];
      for (const schema of Object.values(spellings).slice(0, 3))
        parsed.push(await parse({ Note: note(ref('X')), X: schema }));
      for (const spec of parsed) expectNoDiff(parsed[0]!, spec, 'owner spellings');
    });
  });

  describe('the type lists', () => {
    const items = string;
    const properties = named;
    const lists: Record<string, Record<string, unknown>> = {
      "['array', 'string']": { type: ['array', 'string'], items },
      "['string', 'array']": { type: ['string', 'array'], items },
      "['array', 'string', 'null']": { type: ['array', 'string', 'null'], items },
      "['array', 'integer', 'boolean']": { type: ['array', 'integer', 'boolean'], items },
      "['object', 'string']": { type: ['object', 'string'], properties },
      "['string', 'object']": { type: ['string', 'object'], properties },
      "['object', 'string', 'null']": { type: ['object', 'string', 'null'], properties },
      "['object', 'integer', 'string']": { type: ['object', 'integer', 'string'], properties },
      "['array', 'object']": { type: ['array', 'object'], items, properties },
      "['object', 'array']": { type: ['object', 'array'], items, properties },
      "['array', 'object', 'string']": { type: ['array', 'object', 'string'], items, properties },
      "['array', 'object', 'string', 'null']": { type: ['array', 'object', 'string', 'null'], items, properties },
      // A type named twice is one variant, and a list left with one type is that type.
      "['array', 'array']": { type: ['array', 'array'], items },
      "['array', 'string', 'string']": { type: ['array', 'string', 'string'], items },
      "['object', 'object', 'string']": { type: ['object', 'object', 'string'], properties },
      "['object', 'object']": { type: ['object', 'object'], properties },
    };

    it('reads each as a component the way it reads it in place, the object under the component’s name', async () => {
      const lines: string[] = [];
      for (const [label, schema] of Object.entries(lists)) {
        const [named, placed] = [await component(schema), await inline(schema)];
        // In place the object is `NoteX`; as the component `X` it is `X`.
        expect(named.replaceAll(/\bX\b/g, 'NoteX'), label).toBe(placed);
        lines.push(`${label}: ${named}`);
      }
      expect(lines.join('\n')).toMatchInlineSnapshot(`
        "['array', 'string']: (string[] | string)
        ['string', 'array']: (string | string[])
        ['array', 'string', 'null']: nullable<(string[] | string)>
        ['array', 'integer', 'boolean']: (string[] | integer | boolean)
        ['object', 'string']: (X | string) ; X { name?: string }
        ['string', 'object']: (string | X) ; X { name?: string }
        ['object', 'string', 'null']: nullable<(X | string)> ; X { name?: string }
        ['object', 'integer', 'string']: (X | integer | string) ; X { name?: string }
        ['array', 'object']: (string[] | X) ; X { name?: string }
        ['object', 'array']: (X | string[]) ; X { name?: string }
        ['array', 'object', 'string']: (string[] | X | string) ; X { name?: string }
        ['array', 'object', 'string', 'null']: nullable<(string[] | X | string)> ; X { name?: string }
        ['array', 'array']: string[]
        ['array', 'string', 'string']: (string[] | string)
        ['object', 'object', 'string']: (X | string) ; X { name?: string }
        ['object', 'object']: X ; X { name?: string }"
      `);
      expect(warn).not.toHaveBeenCalled();
    });

    it('leaves the lists that were already read as they were', async () => {
      expect(
        await table({
          "['array', 'null']": { type: ['array', 'null'], items },
          "['object', 'null']": { type: ['object', 'null'], properties },
          "['string', 'integer']": { type: ['string', 'integer'] },
          "['string', 'integer', 'null']": { type: ['string', 'integer', 'null'] },
          "['object']": { type: ['object'], properties },
          "['null']": { type: ['null'] },
          "type: 'array'": { type: 'array', items },
          "type: 'object'": { type: 'object', properties },
          "type: 'array', nullable: true": { type: 'array', items, nullable: true },
          "type: 'object', nullable: true": { type: 'object', properties, nullable: true },
        }),
      ).toMatchInlineSnapshot(`
        "['array', 'null']: nullable<string[]>
        ['object', 'null']: nullable<X> ; X { name?: string }
        ['string', 'integer']: (string | integer)
        ['string', 'integer', 'null']: nullable<(string | integer)>
        ['object']: X ; X { name?: string }
        ['null']: nullable<X> ; X {  }
        type: 'array': string[]
        type: 'object': X ; X { name?: string }
        type: 'array', nullable: true: nullable<string[]>
        type: 'object', nullable: true: nullable<X> ; X { name?: string }"
      `);
    });

    it('reads a list of one entry as before: `[array]` with `items` is typed as it is in place', async () => {
      // Not this issue: a list of one type that is no `null` is unread where it is written too.
      const schema = { type: ['array'], items };
      expect(await component(schema)).toBe(await inline(schema));
      expect(await component(schema)).toMatchInlineSnapshot(`"unknown"`);
    });
  });

  describe('what the object and the array are', () => {
    it('keeps the object the model the component builds, whatever it declares', async () => {
      expect(
        await table(
          {
            'no properties': { type: ['object', 'string'] },
            'a map': { type: ['object', 'string'], additionalProperties: string },
            'properties and a map': { type: ['object', 'string'], properties: named, additionalProperties: string },
            required: { type: ['object', 'string'], properties: named, required: ['name'] },
            'an allOf of a base and properties': {
              type: ['object', 'string'],
              allOf: [ref('Base'), { properties: { extra: string } }],
            },
            'an allOf of a base alone': { type: ['object', 'string'], allOf: [ref('Base')] },
            documented: {
              type: ['object', 'string'],
              properties: named,
              description: 'An owner.',
              deprecated: true,
            },
          },
          { Base: { properties: { id: string } } },
        ),
      ).toMatchInlineSnapshot(`
        "no properties: (X | string) ; X {  }
        a map: (X | string) ; X {  }
        properties and a map: (X | string) ; X { name?: string, additionalProperties?: map<string> }
        required: (X | string) ; X { name: string }
        an allOf of a base and properties: (X | string) ; X { id?: string, extra?: string } bases [Base]
        an allOf of a base alone: (X | string) ; X { id?: string } bases [Base]
        documented: (X | string) ; X { name?: string } "An owner." deprecated"
      `);
    });

    it('is the model alone where the composition admits no other type, as in place', async () => {
      // `Typed` declares `type: 'object'`, which no string satisfies.
      const schema = { type: ['object', 'string'], allOf: [ref('Typed')] };
      const more = { Typed: { type: 'object', properties: { id: string } } };
      expect(await component(schema, more)).toMatchInlineSnapshot(`"X ; X { id?: string } bases [Typed]"`);
      expect(await inline(schema, more)).toMatchInlineSnapshot(`"Typed"`);
    });

    it('names the array’s items under the component, and builds what they reference', async () => {
      const item = { type: 'object', properties: { a: string, nested: { type: 'object', properties: { b: string } } } };
      expect(
        await table({
          'object items': { type: ['array', 'string'], items: item },
          'object items beside an object': { type: ['array', 'object'], items: item, properties: named },
          'object items beside an `item` property': {
            type: ['array', 'object'],
            items: { type: 'object', properties: { a: string } },
            properties: { item: { type: 'object', properties: { b: string } } },
          },
          'enum items': { type: ['array', 'string'], items: { type: 'string', enum: ['a', 'b'] } },
          '$ref items': { type: ['array', 'string'], items: ref('Note') },
          'nested arrays': {
            type: ['array', 'string'],
            items: { type: 'array', items: { type: 'object', properties: { a: string } } },
          },
          'items in an allOf member': {
            type: ['array', 'string'],
            allOf: [{ items: { type: 'object', properties: { a: string } } }],
          },
          'items in an allOf member, beside an object': {
            type: ['array', 'object'],
            properties: named,
            allOf: [{ items: { type: 'object', properties: { a: string } } }],
          },
        }),
      ).toMatchInlineSnapshot(`
        "object items: (XItem[] | string) ; XItem { a?: string, nested?: XItemNested } ; XItemNested { b?: string }
        object items beside an object: (XItem[] | X) ; X { name?: string } ; XItem { a?: string, nested?: XItemNested } ; XItemNested { b?: string }
        object items beside an \`item\` property: (XItemItem[] | X) ; X { item?: XItem } ; XItemItem { a?: string } ; XItem { b?: string }
        enum items: (enum XItem[] | string)
        $ref items: (Note[] | string)
        nested arrays: (XItem[][] | string) ; XItem { a?: string }
        items in an allOf member: (XItem[] | string) ; XItem { a?: string }
        items in an allOf member, beside an object: (XItem[] | X) ; X { name?: string } ; XItem { a?: string }"
      `);
      const spec = await parse({
        Note: note(ref('X')),
        X: { type: ['array', 'object'], items: item, properties: named },
        Y: { type: ['array', 'string'], items: item },
        Holder: { type: 'object', properties: { y: ref('Y') } },
      });
      expect(names(spec)).toEqual(['Holder', 'Note', 'X', 'XItem', 'XItemNested', 'YItem', 'YItemNested']);
      expect(spec.enums).toEqual([]);
      expectNoDanglingReference(spec);
      expect(warn).not.toHaveBeenCalled();
    });

    it('lifts the inline enum the array’s items are, whether or not anything names the component', async () => {
      const spec = await parse({
        Note: note(string),
        Tags: { type: ['array', 'string'], items: { type: 'string', enum: ['a', 'b'] } },
      });
      expect(spec.enums.map(({ name, values }) => `${name}: ${values.map(({ value }) => value).join(', ')}`)).toEqual([
        'TagsItem: a, b',
      ]);
      expect(names(spec)).toEqual(['Note']);
    });

    it('steps the items’ name around another component’s, as an array component’s items do', async () => {
      const spec = await parse({
        Note: note(ref('Tags')),
        Tags: { type: ['array', 'string'], items: { type: 'object', properties: { a: string } } },
        TagsItem: { type: 'object', properties: { other: string } },
      });
      expect(show(fieldOf(spec, 'Note', 'x').type)).toBe('(TagsItemItem[] | string)');
      expect(spec.models.map(showModel).sort()).toEqual([
        'Note { x?: (TagsItemItem[] | string) }',
        'TagsItem { other?: string }',
        'TagsItemItem { a?: string }',
      ]);
      // And the items of a list that names `object` too, which are planned with them.
      const beside = await parse({
        Note: note(ref('Owner')),
        Owner: { type: ['array', 'object'], items: { type: 'object', properties: { a: string } }, properties: named },
        OwnerItem: { type: 'object', properties: { other: string } },
      });
      expect(beside.models.map(showModel).sort()).toEqual([
        'Note { x?: (OwnerItemItem[] | Owner) }',
        'Owner { name?: string }',
        'OwnerItem { other?: string }',
        'OwnerItemItem { a?: string }',
      ]);
      // A component of the items' own shape is shared, as an array component's items share one.
      const shared = await parse({
        Note: note(ref('Owner')),
        Owner: { type: ['array', 'object'], items: { type: 'object', properties: { a: string } }, properties: named },
        OwnerItem: { type: 'object', properties: { a: string } },
      });
      expect(shared.models.map(showModel).sort()).toEqual([
        'Note { x?: (OwnerItem[] | Owner) }',
        'Owner { name?: string }',
        'OwnerItem { a?: string }',
      ]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('limits and documentation', () => {
    it('carries the list’s limits on the union and on the field, as in place', async () => {
      const tags = { type: ['array', 'string'], items: string, minItems: 1, minLength: 2 };
      const owner = { type: ['object', 'string'], properties: named, minLength: 2, format: 'uuid', minProperties: 1 };
      const inlineSpec = await parse({ Note: { type: 'object', properties: { tags, owner } } });
      const componentSpec = await parse({
        Note: { type: 'object', properties: { tags: ref('Tags'), owner: ref('Owner') } },
        Tags: tags,
        Owner: owner,
      });
      const lines = (spec: ApiSpec): string[] =>
        modelOf(spec, 'Note').fields.map(
          (field) => `${field.name}: ${show(field.type)} / ${JSON.stringify(field.constraints)}`,
        );
      expect(lines(componentSpec)).toMatchInlineSnapshot(`
        [
          "tags: (string[] | string) {"minLength":2,"minItems":1} / {"minLength":2,"minItems":1}",
          "owner: (Owner | string:uuid) {"minLength":2,"minProperties":1} / {"minLength":2,"minProperties":1}",
        ]
      `);
      expect(lines(componentSpec).map((line) => line.replace('(Owner ', '(NoteOwner '))).toEqual(lines(inlineSpec));
      // The model keeps the limits a model carries, as the one built in place does.
      expect(modelOf(componentSpec, 'Owner').constraints).toEqual(modelOf(inlineSpec, 'NoteOwner').constraints);
      expect(modelOf(componentSpec, 'Owner').constraints).toEqual({ minLength: 2, minProperties: 1 });
    });

    it('conjoins a limit written beside the `$ref`, or on an alias, with the component’s', async () => {
      const rows: Record<string, unknown> = {};
      for (const [kind, x] of Object.entries({ Tags: TAGS, Owner: OWNER })) {
        const spec = await parse({
          Note: {
            type: 'object',
            properties: {
              site: { ...ref('X'), maxLength: 5 },
              alias: ref('Alias'),
              wrapped: { allOf: [ref('X'), { maxLength: 4 }] },
            },
          },
          Alias: { allOf: [ref('X'), { maxLength: 3 }] },
          X: { ...x, minLength: 2 },
        });
        rows[kind] = modelOf(spec, 'Note').fields.map(
          (field) => `${field.name}: ${show(field.type)} / ${JSON.stringify(field.constraints)}`,
        );
      }
      expect(rows).toMatchInlineSnapshot(`
        {
          "Owner": [
            "site: (X | string) {"minLength":2,"maxLength":5} / {"minLength":2,"maxLength":5}",
            "alias: (Alias | string) {"minLength":2,"maxLength":3} / {"minLength":2,"maxLength":3}",
            "wrapped: (X | string) {"minLength":2,"maxLength":4} / {"minLength":2,"maxLength":4}",
          ],
          "Tags": [
            "site: (string[] | string) {"minLength":2,"maxLength":5} / {"minLength":2,"maxLength":5}",
            "alias: (string[] | string) {"minLength":2,"maxLength":3} / {"minLength":2,"maxLength":3}",
            "wrapped: (string[] | string) {"minLength":2,"maxLength":4} / {"minLength":2,"maxLength":4}",
          ],
        }
      `);
    });

    it('documents the field from the array list, which no model carries, and leaves the object’s documentation on its model', async () => {
      const docs = {
        description: 'Described.',
        deprecated: true,
        externalDocs: { url: 'https://example.com/docs' },
        'x-team': 'core',
        example: 'ada',
        default: 'ada',
      };
      const inlineSpec = await parse({
        Note: { type: 'object', properties: { tags: { ...TAGS, ...docs }, owner: { ...OWNER, ...docs } } },
      });
      const componentSpec = await parse({
        Note: { type: 'object', properties: { tags: ref('Tags'), owner: ref('Owner') } },
        Tags: { ...TAGS, ...docs },
        Owner: { ...OWNER, ...docs },
      });
      // `Tags` is no model: the field reads all of it, as the field written in place does.
      expect(fieldOf(componentSpec, 'Note', 'tags')).toEqual(fieldOf(inlineSpec, 'Note', 'tags'));
      expect(fieldOf(componentSpec, 'Note', 'tags')).toMatchObject({
        description: 'Described.',
        deprecated: true,
        default: 'ada',
        example: 'ada',
        externalDocs: { url: 'https://example.com/docs' },
        extensions: { 'x-team': 'core' },
      });
      // `Owner` is a model: it carries its own, and the field what a field naming any model carries.
      expect(modelOf(componentSpec, 'Owner')).toEqual({ ...modelOf(inlineSpec, 'NoteOwner'), name: 'Owner' });
      expect(modelOf(componentSpec, 'Owner')).toMatchObject({
        description: 'Described.',
        deprecated: true,
        externalDocs: { url: 'https://example.com/docs' },
        extensions: { 'x-team': 'core' },
      });
      const plain = await parse({
        Note: { type: 'object', properties: { owner: ref('Owner') } },
        Owner: { type: 'object', properties: named, ...docs },
      });
      const { type: _type, ...owner } = fieldOf(componentSpec, 'Note', 'owner');
      const { type: _plainType, ...plainOwner } = fieldOf(plain, 'Note', 'owner');
      expect(owner).toEqual(plainOwner);
    });
  });

  describe('every site that names the component', () => {
    const schemas = (x: unknown) => ({
      Holder: {
        type: 'object',
        properties: {
          field: ref('X'),
          items: { type: 'array', items: ref('X') },
          values: { type: 'object', additionalProperties: ref('X') },
          nullable: { oneOf: [ref('X'), { type: 'null' }] },
          variant: { oneOf: [ref('X'), { type: 'integer' }] },
          reference: { allOf: [ref('X')] },
          documented: { allOf: [ref('X'), { description: 'Documented.' }] },
          alias: ref('Alias'),
          aliasOfAlias: ref('AliasOfAlias'),
          nullableAlias: ref('NullableAlias'),
          union: ref('Union'),
          arrays: ref('Arrays'),
        },
      },
      Alias: ref('X'),
      AliasOfAlias: { allOf: [ref('Alias')] },
      NullableAlias: { oneOf: [ref('X'), { type: 'null' }] },
      Union: { oneOf: [ref('X'), ref('Other')] },
      Arrays: { type: 'array', items: ref('X') },
      Other: { type: 'object', properties: { id: string } },
      X: x,
    });
    const paths = {
      '/things/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: ref('X') }],
        put: {
          operationId: 'putThing',
          parameters: [
            { name: 'q', in: 'query', schema: ref('X') },
            { name: 'X-Thing', in: 'header', schema: ref('X') },
            { name: 'c', in: 'cookie', schema: ref('X') },
          ],
          requestBody: json(ref('X')),
          responses: {
            '200': { description: 'OK', headers: { 'X-Rate': { schema: ref('X') } }, ...json(ref('X')) },
            '400': { description: 'Bad', ...json(ref('X')) },
          },
        },
      },
      '/holder': {
        get: { operationId: 'getHolder', responses: { '200': { description: 'OK', ...json(ref('Holder')) } } },
      },
    };
    const sites = (spec: ApiSpec): string[] => {
      const operation: Operation = spec.services
        .flatMap((service) => service.operations)
        .find(({ name }) => name === 'putThing')!;
      return [
        ...modelOf(spec, 'Holder').fields.map((field) => `Holder.${field.name}: ${show(field.type)}`),
        ...spec.models
          .filter(({ name }) => !['Holder', 'Other', 'X'].includes(name))
          .map((model) => `model ${showModel(model)}`),
        ...[
          ...operation.pathParams,
          ...operation.queryParams,
          ...operation.headerParams,
          ...(operation.cookieParams ?? []),
        ].map((parameter) => `parameter ${parameter.name}: ${show(parameter.type)}`),
        `request body: ${show(operation.requestBody!)}`,
        `response: ${show(operation.response)}`,
        ...(operation.responseHeaders ?? []).map((header) => `response header ${header.name}: ${show(header.type)}`),
        ...operation.errors.map((error) => `error ${error.statusCode}: ${error.type ? show(error.type) : ''}`),
      ];
    };

    it('types `Tags` as the union at each', async () => {
      const spec = await parseJson(document(schemas(TAGS), '3.1.0', paths));
      expect(sites(spec)).toMatchInlineSnapshot(`
        [
          "Holder.field: (string[] | string)",
          "Holder.items: (string[] | string)[]",
          "Holder.values: map<(string[] | string)>",
          "Holder.nullable: nullable<(string[] | string)>",
          "Holder.variant: ((string[] | string) | integer)",
          "Holder.reference: (string[] | string)",
          "Holder.documented: (string[] | string)",
          "Holder.alias: (string[] | string)",
          "Holder.aliasOfAlias: (string[] | string)",
          "Holder.nullableAlias: nullable<(string[] | string)>",
          "Holder.union: Union",
          "Holder.arrays: (string[] | string)[]",
          "model Union {  } variants oneOf[(string[] | string) | Other]",
          "parameter id: (string[] | string)",
          "parameter q: (string[] | string)",
          "parameter X-Thing: (string[] | string)",
          "parameter c: (string[] | string)",
          "request body: (string[] | string)",
          "response: (string[] | string)",
          "response header X-Rate: (string[] | string)",
          "error 400: (string[] | string)",
        ]
      `);
      expect(names(spec)).not.toContain('X');
      expectNoDanglingReference(spec);
      expect(warn).not.toHaveBeenCalled();
    });

    it('types `Owner` as the model beside the string at each', async () => {
      const spec = await parseJson(document(schemas(OWNER), '3.1.0', paths));
      expect(sites(spec)).toMatchInlineSnapshot(`
        [
          "Holder.field: (X | string)",
          "Holder.items: (X | string)[]",
          "Holder.values: map<(X | string)>",
          "Holder.nullable: nullable<(X | string)>",
          "Holder.variant: ((X | string) | integer)",
          "Holder.reference: (X | string)",
          "Holder.documented: (X | string)",
          "Holder.alias: (Alias | string)",
          "Holder.aliasOfAlias: (AliasOfAlias | string)",
          "Holder.nullableAlias: nullable<NullableAlias>",
          "Holder.union: Union",
          "Holder.arrays: (X | string)[]",
          "model Alias { name?: string } bases [X]",
          "model AliasOfAlias { name?: string } bases [Alias]",
          "model NullableAlias {  } variants oneOf[(X | string)]",
          "model Union {  } variants oneOf[(X | string) | Other]",
          "parameter id: (X | string)",
          "parameter q: (X | string)",
          "parameter X-Thing: (X | string)",
          "parameter c: (X | string)",
          "request body: (X | string)",
          "response: (X | string)",
          "response header X-Rate: (X | string)",
          "error 400: (X | string)",
        ]
      `);
      expect(showModel(modelOf(spec, 'X'))).toBe('X { name?: string }');
      expectNoDanglingReference(spec);
      expect(warn).not.toHaveBeenCalled();
    });

    it('types a webhook payload and a callback body the same way', async () => {
      for (const [x, expected] of [
        [TAGS, '(string[] | string)'],
        [OWNER, '(X | string)'],
      ] as const) {
        const spec = await parseJson({
          ...document({ X: x }, '3.1.0', {
            '/things': {
              post: {
                operationId: 'createThing',
                requestBody: json(ref('X')),
                responses: { '204': { description: 'none' } },
                callbacks: {
                  done: {
                    '{$request.body#/url}': {
                      post: { requestBody: json(ref('X')), responses: { '200': { description: 'OK' } } },
                    },
                  },
                },
              },
            },
          }),
          webhooks: { thing: { post: { requestBody: json(ref('X')), responses: { '200': { description: 'OK' } } } } },
        });
        const operation = spec.services[0]!.operations[0]!;
        expect(show(spec.webhooks![0]!.requestBody!)).toBe(expected);
        expect(show(operation.callbacks![0]!.requestBody!)).toBe(expected);
        expect(show(operation.requestBody!)).toBe(expected);
      }
    });

    it('keeps `Owner` the base of a component that merges it, and reads the merge as the model it is in place', async () => {
      const cat = { allOf: [ref('X'), { properties: { lives: string } }] };
      const spec = await parse({ Note: note(ref('Cat')), Cat: cat, X: OWNER, Other: note(cat) });
      expect(spec.models.map(showModel)).toMatchInlineSnapshot(`
        [
          "Note { x?: Cat }",
          "Cat { name?: string, lives?: string } bases [X]",
          "X { name?: string }",
          "Other { x?: OtherX }",
          "OtherX { name?: string, lives?: string }",
        ]
      `);
      // `Tags` is no model, so it is no base: the merge reads the object member alone, as over an array component.
      const overTags = await parse({ Note: note(ref('Cat')), Cat: cat, X: TAGS });
      expect(overTags.models.map(showModel)).toEqual(['Note { x?: Cat }', 'Cat { lives?: string }']);
      expect(overTags.models.map(showModel)).toEqual(
        (await parse({ Note: note(ref('Cat')), Cat: cat, X: { type: 'array', items: string } })).models.map(showModel),
      );
    });

    it('maps a discriminator to the model, the variant carrying the other type', async () => {
      const owner = { type: ['object', 'string'], properties: { kind: { const: 'owner' }, name: string } };
      const dog = { type: 'object', properties: { kind: { const: 'dog' } } };
      const mapping = { owner: '#/components/schemas/Owner', dog: '#/components/schemas/Dog' };
      const spec = await parse({
        Note: {
          type: 'object',
          properties: {
            written: ref('Written'),
            derived: ref('Derived'),
            implicit: ref('Implicit'),
            inline: { oneOf: [ref('Owner'), ref('Dog')], discriminator: { propertyName: 'kind' } },
          },
        },
        Written: { oneOf: [ref('Owner'), ref('Dog')], discriminator: { propertyName: 'kind', mapping } },
        Derived: { oneOf: [ref('Owner'), ref('Dog')], discriminator: { propertyName: 'kind' } },
        Implicit: { oneOf: [ref('Owner'), ref('Dog')] },
        Owner: owner,
        Dog: dog,
      });
      const expected = { property: 'kind', mapping: { owner: 'Owner', dog: 'Dog' } };
      for (const union of ['Written', 'Derived', 'Implicit']) {
        expect(modelOf(spec, union).variants!.map(show), union).toEqual(['(Owner | string)', 'Dog']);
        expect(modelOf(spec, union).discriminator, union).toEqual(expected);
      }
      const inlineUnion = fieldOf(spec, 'Note', 'inline').type;
      expect(show(inlineUnion)).toBe('((Owner | string) | Dog)');
      expect(inlineUnion.kind === 'union' && inlineUnion.discriminator).toEqual(expected);
      expectNoDanglingReference(spec);
    });

    it('reads a JSON Pointer into the component through the member that carries the keyword', async () => {
      const spec = await parse({
        Note: {
          type: 'object',
          properties: {
            tagsItems: { $ref: '#/components/schemas/Tags/items' },
            ownerName: { $ref: '#/components/schemas/Owner/properties/name' },
            bothItems: { $ref: '#/components/schemas/Both/items' },
            bothName: { $ref: '#/components/schemas/Both/properties/name' },
          },
        },
        Tags: { type: ['array', 'string'], items: { type: 'object', properties: { a: string } } },
        Owner: OWNER,
        Both: { type: ['array', 'object'], items: { type: 'object', properties: { b: string } }, properties: named },
      });
      expect(modelOf(spec, 'Note').fields.map((field) => `${field.name}: ${show(field.type)}`)).toEqual([
        'tagsItems: TagsItem',
        'ownerName: string',
        'bothItems: BothItem',
        'bothName: string',
      ]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('a list envelope', () => {
    const envelope = (data: unknown) => ({
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'after', in: 'query', schema: string }],
          responses: {
            '200': {
              description: 'OK',
              ...json({ type: 'object', properties: { data, has_more: { type: 'boolean' } } }),
            },
          },
        },
      },
    });
    const pet = { type: 'object', properties: { id: string } };

    it('is unwrapped on an array component, and not on one typed as a union', async () => {
      const read = async (x: unknown): Promise<string> => {
        const spec = await parseJson(document({ X: x, Pet: pet }, '3.1.0', envelope(ref('X'))));
        const operation = spec.services[0]!.operations[0]!;
        return `${show(operation.response)} / item ${show(operation.pagination!.itemType)} / ${operation.pagination!.dataPath}`;
      };
      expect({
        'an array': await read({ type: 'array', items: ref('Pet') }),
        'a list, items beside it': await read({ type: ['array', 'string'], items: ref('Pet') }),
        // Before #730 this one was read as the envelope's array: `Pet[] | string` with `string` for its item.
        'a list, items in an allOf member': await read({ type: ['array', 'string'], allOf: [{ items: ref('Pet') }] }),
        'a list that names array twice': await read({ type: ['array', 'array'], items: ref('Pet') }),
      }).toMatchInlineSnapshot(`
        {
          "a list that names array twice": "Pet[] / item Pet / data",
          "a list, items beside it": "ListPetsResponse / item ListPetsResponse / undefined",
          "a list, items in an allOf member": "ListPetsResponse / item ListPetsResponse / undefined",
          "an array": "Pet[] / item Pet / data",
        }
      `);
    });
  });

  describe('a component that names itself', () => {
    it('types a field of the model as the model beside its other types', async () => {
      const spec = await parse({
        Note: note(ref('Tree')),
        Tree: {
          type: ['object', 'string'],
          properties: { child: ref('Tree'), children: { type: 'array', items: ref('Tree') } },
        },
      });
      expect(spec.models.map(showModel)).toEqual([
        'Note { x?: (Tree | string) }',
        'Tree { child?: (Tree | string), children?: (Tree | string)[] }',
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('types the array list’s own items as unknown, with one warning, as an array component’s', async () => {
      const spec = await parse({
        Note: { type: 'object', properties: { x: ref('Tree'), y: ref('Tree') } },
        Tree: { type: ['array', 'string'], items: ref('Tree') },
      });
      expect(spec.models.map(showModel)).toEqual(['Note { x?: (unknown[] | string), y?: (unknown[] | string) }']);
      expect(warnings()).toEqual([
        '[oagen] Warning: Array component "Tree" refers to itself through its items — the inner reference is typed as unknown',
      ]);
    });

    it('types a model’s own items as the model alone, with one warning', async () => {
      const spec = await parse({
        Note: { type: 'object', properties: { x: ref('Tree'), y: ref('Tree') } },
        Tree: { type: ['array', 'object'], items: ref('Tree'), properties: named },
      });
      expect(spec.models.map(showModel)).toEqual([
        'Note { x?: (Tree[] | Tree), y?: (Tree[] | Tree) }',
        'Tree { name?: string }',
      ]);
      expect(warnings()).toEqual([
        '[oagen] Warning: Component "Tree" refers to itself through the other types of its type list — the inner reference is typed as the model alone',
      ]);
    });

    it('ends a chain that returns to the component through another one', async () => {
      const spec = await parse({
        Note: note(ref('A')),
        A: { type: ['array', 'string'], items: ref('B') },
        B: { type: ['array', 'object'], items: ref('A'), properties: named },
      });
      expect(spec.models.map(showModel)).toMatchInlineSnapshot(`
        [
          "Note { x?: ((unknown[] | B)[] | string) }",
          "B { name?: string }",
        ]
      `);
      // Each reaches itself through the other, and says so once.
      expect(warnings()).toEqual([
        '[oagen] Warning: Array component "A" refers to itself through its items — the inner reference is typed as unknown',
        '[oagen] Warning: Component "B" refers to itself through the other types of its type list — the inner reference is typed as the model alone',
      ]);
      expectNoDanglingReference(spec);
    });
  });

  describe('a component nothing names', () => {
    it('emits the model the object is, and nothing for the array list', async () => {
      const spec = await parse({ Note: note(string), Tags: TAGS, Owner: OWNER });
      expect(spec.models.map(showModel)).toEqual(['Note { x?: string }', 'Owner { name?: string }']);
      expect(spec.enums).toEqual([]);
    });

    it('assigns the model to the service that reaches it, and reports no reference to a model nobody built', async () => {
      const spec = await parse(COMPONENT);
      const assigned = assignModelsToServices(spec.models, spec.services);
      expect(Object.fromEntries(assigned)).toEqual({ Note: 'Notes', Owner: 'Notes' });
      expectNoDanglingReference(spec);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('the document’s order', () => {
    it('reads the components alike whichever is declared first', async () => {
      const schemas = {
        Note: { type: 'object', properties: { tags: ref('TagsAlias'), owner: ref('OwnerAlias'), cat: ref('Cat') } },
        TagsAlias: ref('Tags'),
        OwnerAlias: { allOf: [ref('Owner')] },
        Cat: { allOf: [ref('Owner'), { properties: { lives: string } }] },
        Tags: { type: ['array', 'string'], items: { type: 'object', properties: { a: string } } },
        Owner: OWNER,
      };
      const forward = await parse(schemas);
      const backward = await parse(Object.fromEntries(Object.entries(schemas).reverse()));
      const sorted = (spec: ApiSpec): string[] => spec.models.map(showModel).sort();
      expect(sorted(backward)).toEqual(sorted(forward));
      expect(sorted(forward)).toMatchInlineSnapshot(`
        [
          "Cat { name?: string, lives?: string } bases [Owner]",
          "Note { tags?: (TagsItem[] | string), owner?: (OwnerAlias | string), cat?: Cat }",
          "Owner { name?: string }",
          "OwnerAlias { name?: string } bases [Owner]",
          "TagsItem { a?: string }",
        ]
      `);
      expectNoDiff(forward, backward, 'order');
    });
  });

  describe('two keys that resolve to one name', () => {
    it('types each `$ref` by the key it names', async () => {
      // `cleanSchemaName` singularizes the leading word, so `Notes` resolves to `Note`.
      const holder = { type: 'object', properties: { list: ref('Notes'), one: ref('Note') } };
      const one = { type: 'object', properties: { id: string } };
      const array = await parse({
        Holder: holder,
        Note: one,
        Notes: { type: ['array', 'string'], items: ref('Note') },
      });
      expect(array.models.map(showModel)).toEqual([
        'Holder { list?: (Note[] | string), one?: Note }',
        'Note { id?: string }',
      ]);
      const object = await parse({
        Holder: holder,
        Note: one,
        Notes: { type: ['object', 'string', 'null'], properties: { id: string } },
      });
      expect(object.models.map(showModel)).toEqual([
        'Holder { list?: nullable<(Note | string)>, one?: Note }',
        'Note { id?: string }',
      ]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('OAS 3.0.3', () => {
    it('leaves the spellings a 3.0 document has as they were', async () => {
      const read = async (x: unknown): Promise<string> => component(x, {}, '3.0.3');
      expect({
        'oneOf of an array and a string': await read({ oneOf: [{ type: 'array', items: string }, string] }),
        'anyOf of an array and a string': await read({ anyOf: [{ type: 'array', items: string }, string] }),
        'oneOf of an object and a string': await read({ oneOf: [{ type: 'object', properties: named }, string] }),
        'a nullable array': await read({ type: 'array', items: string, nullable: true }),
        'a nullable object': await read({ type: 'object', properties: named, nullable: true }),
      }).toMatchInlineSnapshot(`
        {
          "a nullable array": "nullable<string[]>",
          "a nullable object": "nullable<X> ; X { name?: string }",
          "anyOf of an array and a string": "X ; X {  } variants anyOf[string[] | string]",
          "oneOf of an array and a string": "X ; X {  } variants oneOf[string[] | string]",
          "oneOf of an object and a string": "X ; X { name?: string } variants oneOf[XWithName | string] ; XWithName { name?: string }",
        }
      `);
    });
  });

  describe('what is left as it was', () => {
    it('keeps the named union a typing `oneOf`/`anyOf` beside the list makes the component', async () => {
      expect(
        await table(
          {
            'a oneOf of two components': { type: ['object', 'string'], oneOf: [ref('A'), ref('B')] },
            'a oneOf of an object and a string': {
              type: ['object', 'string'],
              oneOf: [{ type: 'object', properties: named }, string],
            },
            'an anyOf of an array and a string': {
              type: ['array', 'string'],
              anyOf: [{ type: 'array', items: string }, string],
            },
            'properties beside a oneOf': {
              type: ['object', 'string'],
              properties: named,
              oneOf: [{ properties: { a: string } }, { properties: { b: string } }],
            },
          },
          { A: { properties: { a: string } }, B: { type: 'object', properties: { b: string } } },
        ),
      ).toMatchInlineSnapshot(`
        "a oneOf of two components: X ; X {  } variants oneOf[A | B]
        a oneOf of an object and a string: X ; X { name?: string } variants oneOf[XWithName | string] ; XWithName { name?: string }
        an anyOf of an array and a string: X ; X {  } variants anyOf[string[] | string]
        properties beside a oneOf: X ; X { name?: string, a?: string, b?: string }"
      `);
    });

    it('keeps the union of one a nullable `oneOf` around an object list is, and reads one around an array list as the list', async () => {
      expect(
        await table({
          'around an object list': { oneOf: [OWNER, { type: 'null' }] },
          'around an array list': { oneOf: [TAGS, { type: 'null' }] },
          'around a primitive list': { oneOf: [{ type: ['string', 'integer'] }, { type: 'null' }] },
        }),
      ).toMatchInlineSnapshot(`
        "around an object list: nullable<X> ; X { name?: string } variants oneOf[(XWithName | string)] ; XWithName { name?: string }
        around an array list: nullable<(string[] | string)>
        around a primitive list: nullable<(string | integer)>"
      `);
    });

    it('keeps the fieldless model of a list whose array has no `items`, as `type: array` without them', async () => {
      expect(
        await table({
          "['array', 'string'] without items": { type: ['array', 'string'] },
          "['array', 'object'] without items": { type: ['array', 'object'], properties: named },
          "type: 'array' without items": { type: 'array' },
        }),
      ).toMatchInlineSnapshot(`
        "['array', 'string'] without items: X ; X {  }
        ['array', 'object'] without items: X ; X { name?: string }
        type: 'array' without items: X ; X {  }"
      `);
    });

    it('keeps the literal and the enum a `const` or an `enum` beside the list is', async () => {
      expect(
        await table({
          const: { type: ['object', 'string'], const: 'a' },
          enum: { type: ['array', 'string'], items: string, enum: ['a', 'b'] },
        }),
      ).toMatchInlineSnapshot(`
        "const: "a"
        enum: enum X"
      `);
    });

    it('reads a merge over the component as the model the same merge is in place', async () => {
      const merge = { allOf: [ref('X'), { properties: { extra: string } }] };
      expect(await inline(merge, { X: OWNER })).toMatchInlineSnapshot(
        `"NoteX ; NoteX { name?: string, extra?: string }"`,
      );
      expect(await inline({ allOf: [OWNER, { properties: { extra: string } }] })).toMatchInlineSnapshot(
        `"NoteX ; NoteX { name?: string, extra?: string }"`,
      );
    });
  });

  describe('a document the readers of the list cannot read', () => {
    // Each parsed before #730, when the component was a model built from its
    // `properties` alone. It parses still, read as it was.
    const unread: Record<string, Record<string, unknown>> = {
      'a type no rule knows': { type: ['array', 'text'], items: string },
      'a type that is no name': { type: ['array', 1], items: string },
      'a type that is a list': { type: ['object', ['string']], properties: named },
      'an enum that is no list, under items': { type: ['array', 'string'], items: { type: 'string', enum: true } },
      'a required that is no list, under items': {
        type: ['array', 'string'],
        items: { type: 'object', properties: named, required: 5 },
      },
      'a format that names the component': { type: ['array', 'string'], items: string, format: ref('X') },
      // No reader throws on these: the items are typed as a model the field
      // extractor builds for no schema, in a component or in place, so read
      // as the union the document would name a model it does not hold.
      'items that are a type list of an array of inline objects': {
        type: ['array', 'string'],
        items: { type: ['array', 'integer'], items: { type: 'object', properties: named } },
      },
      'items, beside an object, that are a type list of a map of inline objects': {
        type: ['array', 'object'],
        properties: named,
        items: { type: ['object', 'integer'], additionalProperties: { type: 'object', properties: named } },
      },
      'items whose property is a type list of an array of inline objects': {
        type: ['array', 'string'],
        items: {
          type: 'object',
          properties: { tags: { type: ['array', 'string'], items: { type: 'object', properties: named } } },
        },
      },
    };

    it.each(Object.entries(unread))('leaves %s the model it was', async (_label, x) => {
      const spec = await parse({ Note: note(ref('X')), X: x });
      const type = fieldOf(spec, 'Note', 'x').type;
      expect(type.kind === 'nullable' ? type.inner : type).toEqual({ kind: 'model', name: 'X' });
      expect(names(spec)).toEqual(['Note', 'X']);
      expectNoDanglingReference(spec);
    });

    it('reads the same items whole once nothing under them is left unbuilt', async () => {
      // The nested list with primitive items, and the nested array with object items, are read.
      expect(
        await table({
          'a nested list of primitives': {
            type: ['array', 'string'],
            items: { type: ['array', 'integer'], items: string },
          },
          'a nested array of objects': {
            type: ['array', 'string'],
            items: { type: 'array', items: { type: 'object', properties: named } },
          },
        }),
      ).toMatchInlineSnapshot(`
        "a nested list of primitives: ((string[] | integer)[] | string)
        a nested array of objects: (XItem[][] | string) ; XItem { name?: string }"
      `);
    });

    it.each([
      ['an empty list', { type: [], items: string, properties: named }],
      ['items that are `true`', { type: ['array', 'string'], items: true }],
      ['items that are `false`', { type: ['array', 'string'], items: false }],
      ['nested items that are `true`', { type: ['array', 'string'], items: { type: 'array', items: true } }],
      ['items beside an object that are `true`', { type: ['array', 'object'], items: true, properties: named }],
      ['an allOf member that is `true`', { type: ['object', 'string'], properties: named, allOf: [true] }],
      ['properties that are no object', { type: ['object', 'string'], properties: 5 }],
    ])('parses %s, with no reference to a model nobody built', async (_label, x) => {
      const spec = await parse({ Note: note(ref('X')), X: x, Alias: ref('X') });
      expectNoDanglingReference(spec);
    });
  });
});
