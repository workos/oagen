import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { typesAsUnknown } from '../../src/parser/schemas.js';
import type { ApiSpec, Field, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #616: a type list naming several types beside an `allOf` of a
 * `$ref` to an object component was typed as that model once per type
 * (`Owner | Owner`). `buildTypeRef` read each type of the list from a copy
 * that kept every other keyword, so the `string` copy was typed by the
 * `allOf` as the `object` copy was. Each per-type copy now keeps the
 * keywords that apply to an instance of its type, a copy the composition
 * admits no instance of is left out, two copies typed alike are one
 * variant, and a lone variant is the type itself (`typeListCopy`,
 * `dedupeTypeRefs`).
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const typedOwner = { type: 'object', properties: { name: string } };
const untypedOwner = { properties: { name: string } };
/** `Note.author` as the issue writes it: the type list beside an `allOf` of the `$ref`, `members` beside it. */
const authorOf = (type: string[], ...members: unknown[]) => ({ type, allOf: [ref('Owner'), ...members] });
const owner: TypeRef = { kind: 'model', name: 'Owner' };
const primitive = (type: 'string' | 'integer' | 'unknown'): TypeRef => ({ kind: 'primitive', type });
const union = (...variants: TypeRef[]): TypeRef => ({ kind: 'union', variants });
const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });

const getNote = {
  get: {
    operationId: 'getNote',
    responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Note') } } } },
  },
};

/** The issue's document: `GET /notes` (`getNote`) returning `$ref: Note`, `Note.author` as given, `Owner` as given. */
function document(
  openapi: string,
  author: unknown,
  schemas: Record<string, unknown> = { Owner: typedOwner },
  paths: Record<string, unknown> = { '/notes': getNote },
) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths,
    components: { schemas: { Note: { type: 'object', properties: { author } }, ...schemas } },
  };
}

/** A type rendered as the issue's script renders it, nested unions in parentheses. */
function show(type: TypeRef): string {
  switch (type.kind) {
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `array<${show(type.items)}>`;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'literal':
      return JSON.stringify(type.value);
    case 'primitive':
      return type.type;
    default:
      return type.name;
  }
}

describe('#616', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-type-list-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.json');
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  const modelNames = (spec: ApiSpec) => spec.models.map(({ name }) => name);
  const fieldOf = (spec: ApiSpec, model: string, field: string): Field =>
    spec.models.find(({ name }) => name === model)!.fields.find(({ name }) => name === field)!;
  const author = (spec: ApiSpec): Field => fieldOf(spec, 'Note', 'author');
  const operation = (spec: ApiSpec, name: string) =>
    spec.services.flatMap((service) => service.operations).find((op) => op.name === name)!;

  it('types the issue’s three documents as `Owner`, `Owner | string` and `NoteAuthor | string` (the repro)', async () => {
    // `typed.json`: a string does not satisfy the member's `type: 'object'`.
    const typed = await parseJson(document('3.1.0', authorOf(['object', 'string'])));
    expect(author(typed).type).toEqual(owner);
    expect(modelNames(typed)).toEqual(['Note', 'Owner']);

    // `untyped.json`: `Owner`'s `properties` say nothing of a string.
    const untyped = await parseJson(document('3.1.0', authorOf(['object', 'string']), { Owner: untypedOwner }));
    expect(author(untyped).type).toEqual(union(owner, primitive('string')));
    expect(modelNames(untyped)).toEqual(['Note', 'Owner']);

    // `inline.json`: unchanged — the object written inline.
    const inline = await parseJson(document('3.1.0', { type: ['object', 'string'], properties: { name: string } }, {}));
    expect(author(inline).type).toEqual(union({ kind: 'model', name: 'NoteAuthor' }, primitive('string')));
    expect(modelNames(inline)).toEqual(['Note', 'NoteAuthor']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a `description` member beside the `$ref` the same way, and keeps it on the field', async () => {
    const note = { description: 'Who wrote it.' };
    const typed = await parseJson(document('3.1.0', authorOf(['object', 'string'], note)));
    expect(author(typed).type).toEqual(owner);
    expect(author(typed).description).toBe('Who wrote it.');

    const untyped = await parseJson(document('3.1.0', authorOf(['object', 'string'], note), { Owner: untypedOwner }));
    expect(author(untyped).type).toEqual(union(owner, primitive('string')));
    expect(author(untyped).description).toBe('Who wrote it.');
  });

  it.each([
    [['object', 'string'], 'Owner', '(Owner | string)'],
    [['string', 'object'], 'Owner', '(string | Owner)'],
  ])(
    'reads the list %j in either order: %s beside a typed `Owner`, %s beside an untyped one',
    async (type, typed, untyped) => {
      // The variants come in the list's order, as a `oneOf`'s come in the
      // document's; which copies survive does not depend on it.
      expect(show(author(await parseJson(document('3.1.0', authorOf(type)))).type)).toBe(typed);
      expect(show(author(await parseJson(document('3.1.0', authorOf(type), { Owner: untypedOwner }))).type)).toBe(
        untyped,
      );
    },
  );

  it('keeps the nullable spellings beside the `allOf`: `[object, null]`, `[object, string, null]` and OAS 3.0 `nullable: true`', async () => {
    const objectOrNull = await parseJson(document('3.1.0', authorOf(['object', 'null'])));
    expect(author(objectOrNull).type).toEqual(nullable(owner));

    const typed = await parseJson(document('3.1.0', authorOf(['object', 'string', 'null'])));
    expect(author(typed).type).toEqual(nullable(owner));

    const untyped = await parseJson(document('3.1.0', authorOf(['object', 'string', 'null']), { Owner: untypedOwner }));
    expect(author(untyped).type).toEqual(nullable(union(owner, primitive('string'))));

    const flagged = await parseJson(document('3.0.3', { type: 'object', nullable: true, allOf: [ref('Owner')] }));
    expect(author(flagged).type).toEqual(nullable(owner));
  });

  it('reads a three-entry list the same way: the one admitted type, or every type the `$ref` says nothing of', async () => {
    const typed = await parseJson(document('3.1.0', authorOf(['object', 'string', 'integer'])));
    expect(author(typed).type).toEqual(owner);

    const untyped = await parseJson(
      document('3.1.0', authorOf(['object', 'string', 'integer']), { Owner: untypedOwner }),
    );
    expect(author(untyped).type).toEqual(union(owner, primitive('string'), primitive('integer')));
  });

  it('keeps each copy’s own keywords: `[array, string]` with `items`, `properties` beside the `allOf` merged into the object copy alone', async () => {
    const list = await parseJson(document('3.1.0', { type: ['array', 'string'], items: { type: 'integer' } }, {}));
    expect(author(list).type).toEqual(union({ kind: 'array', items: primitive('integer') }, primitive('string')));

    // `properties` beside the `allOf` fold into it (its first member), so the
    // `object` copy is the merged model and the `string` copy a bare string.
    const extra = { properties: { extra: string } };
    const typed = await parseJson(document('3.1.0', { ...authorOf(['object', 'string']), ...extra }));
    expect(author(typed).type).toEqual({ kind: 'model', name: 'NoteAuthor' });
    expect(fieldOf(typed, 'NoteAuthor', 'extra').type).toEqual(primitive('string'));
    expect(fieldOf(typed, 'NoteAuthor', 'name').type).toEqual(primitive('string'));

    const untyped = await parseJson(
      document('3.1.0', { ...authorOf(['object', 'string']), ...extra }, { Owner: untypedOwner }),
    );
    expect(author(untyped).type).toEqual(union({ kind: 'model', name: 'NoteAuthor' }, primitive('string')));
  });

  it('types two primitives sharing an `enum` as that one enum, and sharing a `const` as that one literal', async () => {
    const shared = await parseJson(document('3.1.0', { type: ['string', 'integer'], enum: ['a', 1, 'b', 2] }, {}));
    expect(author(shared).type).toEqual({ kind: 'enum', name: 'NoteAuthor', values: ['a', 1, 'b', 2] });
    expect(shared.enums.map(({ name, values }) => [name, values.map(({ value }) => value)])).toEqual([
      ['NoteAuthor', ['a', 1, 'b', 2]],
    ]);

    const pinned = await parseJson(document('3.1.0', { type: ['string', 'integer'], const: 'a' }, {}));
    expect(author(pinned).type).toEqual({ kind: 'literal', value: 'a' });
  });

  it('reads a list the `allOf` admits no entry of as written, the model once', async () => {
    // `['string', 'integer']` beside an object: the document contradicts
    // itself; every copy keeps the `allOf`, which types each alike.
    const spec = await parseJson(document('3.1.0', authorOf(['string', 'integer'])));
    expect(author(spec).type).toEqual(owner);
  });

  it('types the same schema alike at a response body, a request body, a parameter, array items, map values and a union variant', async () => {
    const schema = authorOf(['object', 'string']);
    const paths = {
      '/notes': {
        get: {
          operationId: 'getNote',
          parameters: [{ name: 'author', in: 'query', schema }],
          responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
        },
        post: {
          operationId: 'createNote',
          requestBody: { content: { 'application/json': { schema } } },
          responses: { '201': { description: 'Created', content: { 'application/json': { schema: ref('Note') } } } },
        },
      },
    };
    const note = {
      Note: {
        type: 'object',
        properties: {
          authors: { type: 'array', items: schema },
          by_name: { type: 'object', additionalProperties: schema },
          either: { oneOf: [schema, { type: 'integer' }] },
        },
      },
    };
    for (const [label, Owner, expected] of [
      ['typed', typedOwner, owner],
      ['untyped', untypedOwner, union(owner, primitive('string'))],
    ] as const) {
      const spec = await parseJson({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths,
        components: { schemas: { ...note, Owner } },
      });
      expect(operation(spec, 'getNote').response, label).toEqual(expected);
      expect(
        operation(spec, 'getNote').queryParams.map(({ type }) => type),
        label,
      ).toEqual([expected]);
      expect(operation(spec, 'createNote').requestBody, label).toEqual(expected);
      expect(fieldOf(spec, 'Note', 'authors').type, label).toEqual({ kind: 'array', items: expected });
      expect(fieldOf(spec, 'Note', 'by_name').type, label).toEqual({ kind: 'map', valueType: expected });
      expect(fieldOf(spec, 'Note', 'either').type, label).toEqual({
        kind: 'union',
        variants: [expected, primitive('integer')],
        compositionKind: 'oneOf',
      });
      expect(modelNames(spec), label).toEqual(['Note', 'Owner']);
    }
  });

  it('keeps a composition whole on a copy, never trimmed to the members that apply (Greptile, round 1)', async () => {
    // The array copy keeps the whole `allOf` — the merge the extractor
    // builds, `NoteAuthor { name }` — not the `items` member alone, which
    // would reference items no extractor builds a model for.
    const items = { type: 'object', properties: { id: string } };
    const merged = await parseJson(
      document('3.1.0', { type: ['array', 'string'], allOf: [{ properties: { name: string } }, { items }] }, {}),
    );
    expect(author(merged).type).toEqual(union({ kind: 'model', name: 'NoteAuthor' }, primitive('string')));
    expect(fieldOf(merged, 'NoteAuthor', 'name').type).toEqual(primitive('string'));
    expect(modelNames(merged)).toEqual(['Note', 'NoteAuthor']);

    // A copy declaring `items` of its own keeps the `allOf` beside them, as
    // the schema as a whole reads it: the reference, every one resolving.
    const beside = await parseJson(
      document('3.1.0', { ...authorOf(['array', 'string']), items }, { Owner: untypedOwner }),
    );
    expect(author(beside).type).toEqual(union(owner, primitive('string')));
    expect(modelNames(beside)).toEqual(['Note', 'Owner']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers `typesAsUnknown` for a list as the type it builds: bare `unknown` exactly when every copy is', async () => {
    expect(typesAsUnknown({ type: ['weird', 'weirder'] })).toBe(true);
    expect(typesAsUnknown({ type: ['weird', 'string'] })).toBe(false);
    expect(typesAsUnknown({ type: ['string', 'integer'] })).toBe(false);
    expect(typesAsUnknown({ type: ['weird', 'weirder', 'null'] })).toBe(false);

    const spec = await parseJson(document('3.1.0', { type: ['weird', 'weirder'] }, {}));
    expect(author(spec).type).toEqual(primitive('unknown'));
  });
});
