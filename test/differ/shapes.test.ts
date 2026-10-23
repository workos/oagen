import { describe, it, expect } from 'vitest';
import { documentTypes, sameShape, type DocumentShapes } from '../../src/differ/shapes.js';
import type { Enum, Model, TypeRef } from '../../src/ir/types.js';

const string: TypeRef = { kind: 'primitive', type: 'string' };
const integer: TypeRef = { kind: 'primitive', type: 'integer' };
const model = (name: string): TypeRef => ({ kind: 'model', name });
const enumRef = (name: string): TypeRef => ({ kind: 'enum', name });

const shapesOf = (
  old: { models?: Model[]; enums?: Enum[] },
  next: { models?: Model[]; enums?: Enum[] },
): DocumentShapes => ({
  old: documentTypes({ models: old.models ?? [], enums: old.enums ?? [] }),
  new: documentTypes({ models: next.models ?? [], enums: next.enums ?? [] }),
});

/** `{ title: string, meta: <Meta> }` under `name`, pointing at `metaName` for `meta`. */
const page = (name: string, metaName: string, extra: Partial<Model> = {}): Model => ({
  name,
  fields: [
    { name: 'title', type: string, required: true, description: 'The title' },
    { name: 'meta', type: model(metaName), required: false },
  ],
  ...extra,
});
const meta = (name: string, levelEnum: string): Model => ({
  name,
  fields: [{ name: 'level', type: enumRef(levelEnum), required: true }],
});
const level = (
  name: string,
  values: Array<[string, string]> = [
    ['Low', 'low'],
    ['High', 'high'],
  ],
): Enum => ({
  name,
  values: values.map(([valueName, value]) => ({ name: valueName, value })),
});

describe('sameShape', () => {
  it('reads two differently named models through to their fields, nested models and enums included', () => {
    const shapes = shapesOf(
      { models: [page('OldPage', 'OldMeta'), meta('OldMeta', 'OldLevel')], enums: [level('OldLevel')] },
      { models: [page('NewPage', 'NewMeta'), meta('NewMeta', 'NewLevel')], enums: [level('NewLevel')] },
    );
    expect(sameShape(model('OldPage'), model('NewPage'), shapes)).toBe(true);
    expect(
      sameShape({ kind: 'array', items: model('OldPage') }, { kind: 'array', items: model('NewPage') }, shapes),
    ).toBe(true);
  });

  it('tells a changed field, requiredness, limit, deprecation or enum member apart from a rename', () => {
    const old = { models: [page('OldPage', 'OldMeta'), meta('OldMeta', 'OldLevel')], enums: [level('OldLevel')] };
    const differing: Array<[string, { models: Model[]; enums: Enum[] }]> = [
      [
        'a field added',
        {
          models: [
            {
              ...page('NewPage', 'NewMeta'),
              fields: [...page('NewPage', 'NewMeta').fields, { name: 'summary', type: string, required: false }],
            },
            meta('NewMeta', 'NewLevel'),
          ],
          enums: [level('NewLevel')],
        },
      ],
      [
        'a field made required',
        {
          models: [
            {
              ...page('NewPage', 'NewMeta'),
              fields: page('NewPage', 'NewMeta').fields.map((f) => ({ ...f, required: true })),
            },
            meta('NewMeta', 'NewLevel'),
          ],
          enums: [level('NewLevel')],
        },
      ],
      [
        'a field retyped',
        {
          models: [
            {
              ...page('NewPage', 'NewMeta'),
              fields: [
                { name: 'title', type: integer, required: true },
                { name: 'meta', type: model('NewMeta'), required: false },
              ],
            },
            meta('NewMeta', 'NewLevel'),
          ],
          enums: [level('NewLevel')],
        },
      ],
      [
        'a limit on the model',
        {
          models: [page('NewPage', 'NewMeta', { constraints: { minProperties: 1 } }), meta('NewMeta', 'NewLevel')],
          enums: [level('NewLevel')],
        },
      ],
      [
        'the model deprecated',
        {
          models: [page('NewPage', 'NewMeta', { deprecated: true }), meta('NewMeta', 'NewLevel')],
          enums: [level('NewLevel')],
        },
      ],
      [
        'a nested enum member',
        {
          models: [page('NewPage', 'NewMeta'), meta('NewMeta', 'NewLevel')],
          enums: [level('NewLevel', [['Low', 'low']])],
        },
      ],
    ];
    for (const [what, next] of differing) {
      expect(sameShape(model('OldPage'), model('NewPage'), shapesOf(old, next)), what).toBe(false);
    }
  });

  it('ignores documentation: descriptions, links and examples do not make a shape', () => {
    const documented: Model = {
      ...page('NewPage', 'NewMeta'),
      description: 'A page',
      fields: page('NewPage', 'NewMeta').fields.map((f) => ({ ...f, description: 'changed', example: 'x' })),
    };
    const documentedLevel: Enum = {
      ...level('NewLevel'),
      description: 'Levels',
      values: level('NewLevel').values.map((v) => ({ ...v, description: 'd' })),
    };
    const shapes = shapesOf(
      { models: [page('OldPage', 'OldMeta'), meta('OldMeta', 'OldLevel')], enums: [level('OldLevel')] },
      { models: [documented, meta('NewMeta', 'NewLevel')], enums: [documentedLevel] },
    );
    expect(sameShape(model('OldPage'), model('NewPage'), shapes)).toBe(true);
  });

  it('compares by name alone without the documents, or for a name a document lacks', () => {
    expect(sameShape(model('OldPage'), model('NewPage'))).toBe(false);
    expect(sameShape(model('Page'), model('Page'))).toBe(true);
    const shapes = shapesOf({ models: [page('OldPage', 'OldMeta')] }, { models: [] });
    expect(sameShape(model('OldPage'), model('NewPage'), shapes)).toBe(false);
  });

  it('terminates on self-referential models and takes a pair met again as equal', () => {
    const node = (name: string): Model => ({
      name,
      fields: [
        { name: 'value', type: string, required: true },
        { name: 'children', type: { kind: 'array', items: model(name) }, required: false },
      ],
    });
    const shapes = shapesOf({ models: [node('OldNode')] }, { models: [node('NewNode')] });
    expect(sameShape(model('OldNode'), model('NewNode'), shapes)).toBe(true);
  });

  it('compares unions variant by variant and discriminators by property and mapped shapes', () => {
    const circle = (name: string): Model => ({ name, fields: [{ name: 'radius', type: integer, required: true }] });
    const square = (name: string): Model => ({ name, fields: [{ name: 'side', type: integer, required: true }] });
    const shape = (name: string, circleName: string, squareName: string): Model => ({
      name,
      fields: [],
      variants: [model(circleName), model(squareName)],
      compositionKind: 'oneOf',
      discriminator: { property: 'kind', mapping: { circle: circleName, square: squareName } },
    });
    const shapes = shapesOf(
      { models: [shape('OldShape', 'OldCircle', 'OldSquare'), circle('OldCircle'), square('OldSquare')] },
      { models: [shape('NewShape', 'NewCircle', 'NewSquare'), circle('NewCircle'), square('NewSquare')] },
    );
    expect(sameShape(model('OldShape'), model('NewShape'), shapes)).toBe(true);
    const inlineUnion = (c: string, s: string): TypeRef => ({ kind: 'union', variants: [model(c), model(s)] });
    expect(sameShape(inlineUnion('OldCircle', 'OldSquare'), inlineUnion('NewCircle', 'NewSquare'), shapes)).toBe(true);
    expect(sameShape(inlineUnion('OldCircle', 'OldSquare'), inlineUnion('NewSquare', 'NewCircle'), shapes)).toBe(false);
  });
});
