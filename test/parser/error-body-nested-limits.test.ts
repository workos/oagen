import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Constraints, Field, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #611: `componentAccepts` compared a field's limits at the top of its
 * type only, so a component schema holding a shared error body's name took
 * an inline body it was stricter than below that level — a `maxLength` or a
 * `pattern` on an array's items, on a nested array's items, on a map's
 * values or on a `oneOf` variant — and the operation's error type picked up
 * a limit its own document never declared, while a `minItems` on the array
 * itself kept the body apart. A component is now no stricter than the body
 * at every level of a field's type (`typeNoStricter`), as
 * docs/architecture/ir-types.md states; and two inline bodies that differ
 * only in such a limit share one model carrying, at each level, the limits
 * they agree on (`agreedLimits`), never a union of the two.
 */

type Doc = Record<string, unknown>;
const VERSIONS = ['3.0.3', '3.1.0'] as const;
type Version = (typeof VERSIONS)[number];

const str = { type: 'string' };
const int = { type: 'integer' };
const short = { type: 'string', maxLength: 2 };
const list = (items: Doc, own: Doc = {}): Doc => ({ type: 'array', items, ...own });
const map = (values: Doc): Doc => ({ type: 'object', additionalProperties: values });
const oneOf = (...variants: Doc[]): Doc => ({ oneOf: variants });
/** `schema` admitting `null`, spelled as the version spells it. */
const nullable = (version: Version, schema: Doc): Doc =>
  version === '3.0.3' ? { ...schema, nullable: true } : { ...schema, type: [schema.type, 'null'] };

const string: TypeRef = { kind: 'primitive', type: 'string' };
const shortString: TypeRef = { kind: 'primitive', type: 'string', constraints: { maxLength: 2 } };
const integer: TypeRef = { kind: 'primitive', type: 'integer' };
const listOf = (items: TypeRef, constraints?: Constraints): TypeRef => ({
  kind: 'array',
  items,
  ...(constraints && { constraints }),
});
const mapOf = (valueType: TypeRef): TypeRef => ({ kind: 'map', valueType });
const unionOf = (...variants: TypeRef[]): TypeRef => ({ kind: 'union', variants, compositionKind: 'oneOf' });
const nullOr = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });

/** The issue's error body: `{ message: string, tags }`, both required. */
const body = (tags: Doc): Doc => ({
  type: 'object',
  required: ['message', 'tags'],
  properties: { message: str, tags },
});

/** The issue's `GET /pets/{petId}` (`getPet`), its 404 the inline body with `tags`. */
function getOp(name: string, tags: Doc): Doc {
  return {
    [`/${name}/{id}`]: {
      get: {
        operationId: `get${name[0].toUpperCase()}${name.slice(1)}`,
        parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
          '404': { description: 'nf', content: { 'application/json': { schema: body(tags) } } },
        },
      },
    },
  };
}

function doc(version: Version, paths: Doc, schemas: Doc = {}): Doc {
  return {
    openapi: version,
    info: { title: 'error body nested limits', version: '1' },
    paths,
    components: { schemas: { Pet: { type: 'object', properties: { id: str } }, ...schemas } },
  };
}

/** The issue's document: `getPet` beside the component `name` holding `{ message, tags: componentTags }`. */
function repro(version: Version, name: string, componentTags: Doc, bodyTags: Doc): Doc {
  return doc(version, getOp('pet', bodyTags), { [name]: body(componentTags) });
}

async function parse(spec: Doc): Promise<{ ir: ApiSpec; warnings: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-error-body-nested-limits-'));
  const file = path.join(dir, 'spec.json');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await fs.writeFile(file, JSON.stringify(spec), 'utf-8');
    const ir = await parseSpec(file);
    return { ir, warnings: warn.mock.calls.map((call) => String(call[0])) };
  } finally {
    warn.mockRestore();
    await fs.rm(dir, { recursive: true });
  }
}

const modelNames = (ir: ApiSpec): string[] => ir.models.map((m) => m.name).sort();
function model(ir: ApiSpec, name: string): Model {
  const found = ir.models.find((m) => m.name === name);
  expect(found, `model ${name}`).toBeDefined();
  return found!;
}
/** The name of the model `op`'s first error references. */
function errorOf(ir: ApiSpec, op: string): string {
  const type = ir.services.flatMap((s) => s.operations).find((o) => o.name === op)?.errors[0]?.type;
  expect(type?.kind, `${op}'s error type`).toBe('model');
  return (type as { name: string }).name;
}
/** The `tags` field of model `name`. */
const tagsField = (ir: ApiSpec, name: string): Field => model(ir, name).fields.find((f) => f.name === 'tags')!;
/** The type of `tags` on model `name`, as the issue's script prints it. */
const tagsOf = (ir: ApiSpec, name: string): TypeRef => tagsField(ir, name).type;

/** The issue's warning: the body `shape` left as `GetPetError404`, since the component `name` cannot stand for it. */
const kept = (shape: string, name: string): string =>
  `[oagen] Warning: The shared error body ${shape} would be named "${name}", which component schema "${name}" already holds — keeping model "GetPetError404" as it is; give the two the same shape, or rename one`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#611', () => {
  describe.each(VERSIONS)('under OAS %s', (version) => {
    it("keeps the body apart from a component that limits its array's items or its map's values, as from one that limits the array", async () => {
      // `repro.json`: `maxLength: 2` on the component's items.
      const items = await parse(repro(version, 'ErrorBodyWithTagsList', list(short), list(str)));
      expect(errorOf(items.ir, 'getPet')).toBe('GetPetError404');
      expect(tagsOf(items.ir, 'GetPetError404')).toEqual(listOf(string));
      expect(tagsOf(items.ir, 'ErrorBodyWithTagsList')).toEqual(listOf(shortString));
      expect(modelNames(items.ir)).toEqual(['ErrorBodyWithTagsList', 'GetPetError404', 'Pet']);
      expect(items.warnings).toEqual([kept('{ message: string, tags: string[] }', 'ErrorBodyWithTagsList')]);
      // `min-items.json`: `minItems: 1` on the component's array, as before.
      const minItems = await parse(repro(version, 'ErrorBodyWithTagsList', list(str, { minItems: 1 }), list(str)));
      expect(errorOf(minItems.ir, 'getPet')).toBe('GetPetError404');
      expect(tagsOf(minItems.ir, 'GetPetError404')).toEqual(listOf(string));
      expect(modelNames(minItems.ir)).toEqual(['ErrorBodyWithTagsList', 'GetPetError404', 'Pet']);
      expect(minItems.warnings).toEqual([kept('{ message: string, tags: string[] }', 'ErrorBodyWithTagsList')]);
      // `values.json`: `maxLength: 2` on the component's map values.
      const values = await parse(repro(version, 'ErrorBodyWithTags', map(short), map(str)));
      expect(errorOf(values.ir, 'getPet')).toBe('GetPetError404');
      expect(tagsOf(values.ir, 'GetPetError404')).toEqual(mapOf(string));
      expect(tagsOf(values.ir, 'ErrorBodyWithTags')).toEqual(mapOf(shortString));
      expect(modelNames(values.ir)).toEqual(['ErrorBodyWithTags', 'GetPetError404', 'Pet']);
      expect(values.warnings).toEqual([kept('{ message: string, tags: map<string> }', 'ErrorBodyWithTags')]);
    });

    it("keeps the body apart from a component that limits its items by a pattern, a nested array's items, a oneOf variant or a type under null", async () => {
      const pattern = await parse(
        repro(version, 'ErrorBodyWithTagsList', list({ type: 'string', pattern: '^t' }), list(str)),
      );
      expect(errorOf(pattern.ir, 'getPet')).toBe('GetPetError404');
      expect(tagsOf(pattern.ir, 'GetPetError404')).toEqual(listOf(string));
      expect(pattern.warnings).toEqual([kept('{ message: string, tags: string[] }', 'ErrorBodyWithTagsList')]);
      const nested = await parse(repro(version, 'ErrorBodyWithTagsList', list(list(short)), list(list(str))));
      expect(errorOf(nested.ir, 'getPet')).toBe('GetPetError404');
      expect(tagsOf(nested.ir, 'GetPetError404')).toEqual(listOf(listOf(string)));
      expect(tagsOf(nested.ir, 'ErrorBodyWithTagsList')).toEqual(listOf(listOf(shortString)));
      expect(nested.warnings).toEqual([kept('{ message: string, tags: string[][] }', 'ErrorBodyWithTagsList')]);
      // A limit on a `oneOf` variant, whichever order either side lists the variants in.
      for (const component of [oneOf(short, int), oneOf(int, short)]) {
        for (const [inline, shape, expected] of [
          [oneOf(str, int), 'string | integer', unionOf(string, integer)],
          [oneOf(int, str), 'integer | string', unionOf(integer, string)],
        ] as const) {
          const variant = await parse(repro(version, 'ErrorBodyWithTagsOrTagsInteger', component, inline));
          expect(errorOf(variant.ir, 'getPet')).toBe('GetPetError404');
          expect(tagsOf(variant.ir, 'GetPetError404')).toEqual(expected);
          expect(variant.warnings).toEqual([
            kept(`{ message: string, tags: ${shape} }`, 'ErrorBodyWithTagsOrTagsInteger'),
          ]);
        }
      }
      // A limit under a nullable wrapper: on items that admit `null`, and on an array that does.
      const nullItems = await parse(
        repro(version, 'ErrorBodyWithTagsNullableList', list(nullable(version, short)), list(nullable(version, str))),
      );
      expect(errorOf(nullItems.ir, 'getPet')).toBe('GetPetError404');
      expect(tagsOf(nullItems.ir, 'GetPetError404')).toEqual(listOf(nullOr(string)));
      expect(tagsOf(nullItems.ir, 'ErrorBodyWithTagsNullableList')).toEqual(listOf(nullOr(shortString)));
      expect(nullItems.warnings).toEqual([
        kept('{ message: string, tags: (string | null)[] }', 'ErrorBodyWithTagsNullableList'),
      ]);
      const nullList = await parse(
        repro(version, 'ErrorBodyWithNullableTagsList', nullable(version, list(short)), nullable(version, list(str))),
      );
      expect(errorOf(nullList.ir, 'getPet')).toBe('GetPetError404');
      expect(tagsOf(nullList.ir, 'GetPetError404')).toEqual(nullOr(listOf(string)));
      expect(nullList.warnings).toEqual([
        kept('{ message: string, tags: string[] | null }', 'ErrorBodyWithNullableTagsList'),
      ]);
    });

    it('folds the body onto a component that writes no limit, or the same limit at the same level, as it does', async () => {
      // A component without the limit admits at least what the body does, and is kept exactly as it is.
      const looser = await parse(repro(version, 'ErrorBodyWithTagsList', list(str), list(short)));
      expect(looser.warnings).toEqual([]);
      expect(modelNames(looser.ir)).toEqual(['ErrorBodyWithTagsList', 'Pet']);
      expect(errorOf(looser.ir, 'getPet')).toBe('ErrorBodyWithTagsList');
      expect(tagsOf(looser.ir, 'ErrorBodyWithTagsList')).toEqual(listOf(string));
      // A component that writes the same limit, at the same level, narrows nothing.
      const same = await parse(repro(version, 'ErrorBodyWithTagsList', list(short), list(short)));
      expect(same.warnings).toEqual([]);
      expect(modelNames(same.ir)).toEqual(['ErrorBodyWithTagsList', 'Pet']);
      expect(errorOf(same.ir, 'getPet')).toBe('ErrorBodyWithTagsList');
      expect(tagsOf(same.ir, 'ErrorBodyWithTagsList')).toEqual(listOf(shortString));
      const sameNested = await parse(repro(version, 'ErrorBodyWithTagsList', list(list(short)), list(list(short))));
      expect(sameNested.warnings).toEqual([]);
      expect(errorOf(sameNested.ir, 'getPet')).toBe('ErrorBodyWithTagsList');
      const sameValues = await parse(repro(version, 'ErrorBodyWithTags', map(short), map(short)));
      expect(sameValues.warnings).toEqual([]);
      expect(errorOf(sameValues.ir, 'getPet')).toBe('ErrorBodyWithTags');
      expect(tagsOf(sameValues.ir, 'ErrorBodyWithTags')).toEqual(mapOf(shortString));
      for (const component of [oneOf(short, int), oneOf(int, short)]) {
        for (const inline of [oneOf(short, int), oneOf(int, short)]) {
          const sameVariant = await parse(repro(version, 'ErrorBodyWithTagsOrTagsInteger', component, inline));
          expect(sameVariant.warnings).toEqual([]);
          expect(errorOf(sameVariant.ir, 'getPet')).toBe('ErrorBodyWithTagsOrTagsInteger');
        }
        for (const inline of [oneOf(str, int), oneOf(int, str)]) {
          const looserVariant = await parse(repro(version, 'ErrorBodyWithTagsOrTagsInteger', inline, component));
          expect(looserVariant.warnings).toEqual([]);
          expect(errorOf(looserVariant.ir, 'getPet')).toBe('ErrorBodyWithTagsOrTagsInteger');
        }
      }
    });

    it('shares one model between inline bodies that differ only in a nested limit, keeping the limits they agree on at each level', async () => {
      // Two bodies that differ in the items' limit are one shape: one model, the limit dropped, never a union.
      const differing = await parse(doc(version, { ...getOp('pets', list(short)), ...getOp('notes', list(str)) }));
      expect(differing.warnings).toEqual([]);
      expect(modelNames(differing.ir)).toEqual(['ErrorBodyWithTagsList', 'Pet']);
      expect(errorOf(differing.ir, 'getPets')).toBe('ErrorBodyWithTagsList');
      expect(errorOf(differing.ir, 'getNotes')).toBe('ErrorBodyWithTagsList');
      expect(tagsOf(differing.ir, 'ErrorBodyWithTagsList')).toEqual(listOf(string));
      const agreeing = await parse(doc(version, { ...getOp('pets', list(short)), ...getOp('notes', list(short)) }));
      expect(agreeing.warnings).toEqual([]);
      expect(tagsOf(agreeing.ir, 'ErrorBodyWithTagsList')).toEqual(listOf(shortString));
      // Each level on its own: the array's limit differs while the items' agree, and the other way around.
      const arrayDiffers = await parse(
        doc(version, { ...getOp('pets', list(short, { minItems: 1 })), ...getOp('notes', list(short)) }),
      );
      expect(arrayDiffers.warnings).toEqual([]);
      expect(tagsField(arrayDiffers.ir, 'ErrorBodyWithTagsList').constraints).toBeUndefined();
      expect(tagsOf(arrayDiffers.ir, 'ErrorBodyWithTagsList')).toEqual(listOf(shortString));
      const itemsDiffer = await parse(
        doc(version, { ...getOp('pets', list(short, { minItems: 1 })), ...getOp('notes', list(str, { minItems: 1 })) }),
      );
      expect(itemsDiffer.warnings).toEqual([]);
      expect(tagsField(itemsDiffer.ir, 'ErrorBodyWithTagsList').constraints).toEqual({ minItems: 1 });
      expect(tagsOf(itemsDiffer.ir, 'ErrorBodyWithTagsList')).toEqual(listOf(string, { minItems: 1 }));
      // A nested array's items, a map's values and a `oneOf` variant the same way.
      const nested = await parse(
        doc(version, { ...getOp('pets', list(list(short))), ...getOp('notes', list(list(str))) }),
      );
      expect(nested.warnings).toEqual([]);
      expect(tagsOf(nested.ir, 'ErrorBodyWithTagsList')).toEqual(listOf(listOf(string)));
      const values = await parse(doc(version, { ...getOp('pets', map(short)), ...getOp('notes', map(str)) }));
      expect(values.warnings).toEqual([]);
      expect(modelNames(values.ir)).toEqual(['ErrorBodyWithTags', 'Pet']);
      expect(tagsOf(values.ir, 'ErrorBodyWithTags')).toEqual(mapOf(string));
      const variants = await parse(
        doc(version, { ...getOp('pets', oneOf(short, int)), ...getOp('notes', oneOf(str, int)) }),
      );
      expect(variants.warnings).toEqual([]);
      expect(modelNames(variants.ir)).toEqual(['ErrorBodyWithTagsOrTagsInteger', 'Pet']);
      expect(tagsOf(variants.ir, 'ErrorBodyWithTagsOrTagsInteger')).toEqual(unionOf(string, integer));
    });

    it("pairs a union's variants by shape whichever order the bodies list them in, and keeps one of two left alike", async () => {
      // Greptile on #639 (P2): the variants listed in different orders, a limit on one side, share one `oneOf`
      // with the limit dropped — in the first member's order (`GetNotesError404`, by name), never a union of two unions.
      const reordered = await parse(
        doc(version, { ...getOp('pets', oneOf(short, int)), ...getOp('notes', oneOf(int, str)) }),
      );
      expect(reordered.warnings).toEqual([]);
      expect(modelNames(reordered.ir)).toEqual(['ErrorBodyWithTagsOrTagsInteger', 'Pet']);
      expect(errorOf(reordered.ir, 'getPets')).toBe('ErrorBodyWithTagsOrTagsInteger');
      expect(errorOf(reordered.ir, 'getNotes')).toBe('ErrorBodyWithTagsOrTagsInteger');
      expect(tagsOf(reordered.ir, 'ErrorBodyWithTagsOrTagsInteger')).toEqual(unionOf(integer, string));
      const swapped = await parse(
        doc(version, { ...getOp('pets', oneOf(int, str)), ...getOp('notes', oneOf(short, int)) }),
      );
      expect(swapped.warnings).toEqual([]);
      expect(tagsOf(swapped.ir, 'ErrorBodyWithTagsOrTagsInteger')).toEqual(unionOf(string, integer));
      const plain = await parse(
        doc(version, { ...getOp('pets', oneOf(str, int)), ...getOp('notes', oneOf(int, str)) }),
      );
      expect(plain.warnings).toEqual([]);
      expect(modelNames(plain.ir)).toEqual(['ErrorBodyWithTagsOrTagsInteger', 'Pet']);
      expect(tagsOf(plain.ir, 'ErrorBodyWithTagsOrTagsInteger')).toEqual(unionOf(integer, string));
      // Greptile on #639 (P1): two string variants told apart by their limits alone, which the bodies set
      // differently, are one plain string — never `oneOf: [string, string]`, which admits nothing — at any depth.
      const min3 = { type: 'string', minLength: 3 };
      const max3 = { type: 'string', maxLength: 3 };
      const min4 = { type: 'string', minLength: 4 };
      const alike = await parse(
        doc(version, { ...getOp('pets', oneOf(short, min3)), ...getOp('notes', oneOf(max3, min4)) }),
      );
      expect(alike.warnings).toEqual([]);
      expect(modelNames(alike.ir)).toEqual(['ErrorBodyWithTags', 'Pet']);
      expect(errorOf(alike.ir, 'getPets')).toBe('ErrorBodyWithTags');
      expect(tagsOf(alike.ir, 'ErrorBodyWithTags')).toEqual(string);
      const alikeNested = await parse(
        doc(version, { ...getOp('pets', list(oneOf(short, min3))), ...getOp('notes', list(oneOf(max3, min4))) }),
      );
      expect(alikeNested.warnings).toEqual([]);
      expect(tagsOf(alikeNested.ir, 'ErrorBodyWithTags')).toEqual(listOf(string));
      // The same two variants listed in either order pair with each other and keep their limits.
      const sameReordered = await parse(
        doc(version, { ...getOp('pets', oneOf(short, min3)), ...getOp('notes', oneOf(min3, short)) }),
      );
      expect(sameReordered.warnings).toEqual([]);
      expect(tagsOf(sameReordered.ir, 'ErrorBodyWithTags')).toEqual(
        unionOf({ kind: 'primitive', type: 'string', constraints: { minLength: 3 } }, shortString),
      );
    });

    it("gives a lone surviving variant the limits the union itself agreed on, at the field's top level and below", async () => {
      // Greptile on #639 (round 2): `minLength: 1` beside the `oneOf` is agreed, the variants' limits are not; the
      // string the union leaves is under `minLength: 1` — on an array's items, and as the field's own type, where the
      // field's limits and its type's still agree.
      const min3 = { type: 'string', minLength: 3 };
      const max3 = { type: 'string', maxLength: 3 };
      const min4 = { type: 'string', minLength: 4 };
      const limited = (...variants: Doc[]): Doc => ({ ...oneOf(...variants), minLength: 1 });
      const items = await parse(
        doc(version, { ...getOp('pets', list(limited(short, min3))), ...getOp('notes', list(limited(max3, min4))) }),
      );
      expect(items.warnings).toEqual([]);
      expect(modelNames(items.ir)).toEqual(['ErrorBodyWithTags', 'Pet']);
      expect(tagsOf(items.ir, 'ErrorBodyWithTags')).toEqual(
        listOf({ kind: 'primitive', type: 'string', constraints: { minLength: 1 } }),
      );
      const top = await parse(
        doc(version, { ...getOp('pets', limited(short, min3)), ...getOp('notes', limited(max3, min4)) }),
      );
      expect(top.warnings).toEqual([]);
      expect(tagsField(top.ir, 'ErrorBodyWithTags').constraints).toEqual({ minLength: 1 });
      expect(tagsOf(top.ir, 'ErrorBodyWithTags')).toEqual({
        kind: 'primitive',
        type: 'string',
        constraints: { minLength: 1 },
      });
      // The union's own limit the bodies set differently is dropped with the variants'.
      const differing = await parse(
        doc(version, {
          ...getOp('pets', list(limited(short, min3))),
          ...getOp('notes', list({ ...oneOf(max3, min4), minLength: 2 })),
        }),
      );
      expect(differing.warnings).toEqual([]);
      expect(tagsOf(differing.ir, 'ErrorBodyWithTags')).toEqual(listOf(string));
      // A survivor with a limit of its own conjoins the union's, the stricter bound winning.
      const survivor = await parse(
        doc(version, {
          ...getOp('pets', list({ ...oneOf(min3, int), minLength: 1 })),
          ...getOp('notes', list({ ...oneOf(min3, int), minLength: 1 })),
        }),
      );
      expect(survivor.warnings).toEqual([]);
      expect(tagsOf(survivor.ir, 'ErrorBodyWithTagsOrTagsInteger')).toEqual(
        listOf({
          kind: 'union',
          variants: [{ kind: 'primitive', type: 'string', constraints: { minLength: 3 } }, integer],
          compositionKind: 'oneOf',
          constraints: { minLength: 1 },
        }),
      );
    });

    it("gives a lone surviving variant that is itself a union the outer union's agreed limits", async () => {
      // Greptile on #639 (round 3): the outer `oneOf` collapses onto its one surviving variant, an `anyOf` or a
      // type list, which is a union too and takes the outer's agreed `minLength: 1` all the same.
      const anyOf = (...variants: Doc[]): Doc => ({ anyOf: variants });
      const min3 = { type: 'string', minLength: 3 };
      const max3 = { type: 'string', maxLength: 3 };
      const min4 = { type: 'string', minLength: 4 };
      const outer = (a: Doc, b: Doc): Doc => ({ ...oneOf(a, b), minLength: 1 });
      const survivor: TypeRef = {
        kind: 'union',
        variants: [string, integer],
        compositionKind: 'anyOf',
        constraints: { minLength: 1 },
      };
      const nested = await parse(
        doc(version, {
          ...getOp('pets', outer(anyOf(short, int), anyOf(min3, int))),
          ...getOp('notes', outer(anyOf(max3, int), anyOf(min4, int))),
        }),
      );
      expect(nested.warnings).toEqual([]);
      expect(modelNames(nested.ir)).toEqual(['ErrorBodyWithTagsOrTagsInteger', 'Pet']);
      expect(tagsOf(nested.ir, 'ErrorBodyWithTagsOrTagsInteger')).toEqual(survivor);
      expect(tagsField(nested.ir, 'ErrorBodyWithTagsOrTagsInteger').constraints).toEqual({ minLength: 1 });
      const items = await parse(
        doc(version, {
          ...getOp('pets', list(outer(anyOf(short, int), anyOf(min3, int)))),
          ...getOp('notes', list(outer(anyOf(max3, int), anyOf(min4, int)))),
        }),
      );
      expect(items.warnings).toEqual([]);
      expect(tagsOf(items.ir, 'ErrorBodyWithTagsOrTagsInteger')).toEqual(listOf(survivor));
      if (version === '3.1.0') {
        const typeList = (own: Doc): Doc => ({ type: ['string', 'integer'], ...own });
        const lists = await parse(
          doc(version, {
            ...getOp('pets', outer(typeList({ maxLength: 2 }), typeList({ minLength: 3 }))),
            ...getOp('notes', outer(typeList({ maxLength: 3 }), typeList({ minLength: 4 }))),
          }),
        );
        expect(lists.warnings).toEqual([]);
        expect(tagsOf(lists.ir, 'ErrorBodyWithTagsOrTagsInteger')).toEqual({
          kind: 'union',
          variants: [string, integer],
          constraints: { minLength: 1 },
        });
      }
    });
  });
});
