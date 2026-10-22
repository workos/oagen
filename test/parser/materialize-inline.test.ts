import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Model, TypeRef } from '../../src/ir/types.js';
import {
  materializeInlineSchema,
  modelFingerprint,
  type InlineModelRegistry,
  type SettledSite,
  type SiblingSites,
} from '../../src/parser/materialize-inline.js';

const num = { kind: 'primitive' as const, type: 'number' as const };
const titled = (title: string, kind: string, properties: Record<string, unknown>) => ({
  type: 'object',
  title,
  properties: { kind: { type: 'string', const: kind }, ...properties },
});
/** A body whose `shape` field is a title-mapped union: a nested titled variant no reservation reaches. */
const body = {
  type: 'object',
  properties: {
    shape: {
      oneOf: [
        titled('Circle', 'circle', { diameter: { type: 'number' } }),
        titled('Square', 'square', { side: { type: 'number' } }),
      ],
    },
  },
};
/** A registry in which a component `Circle` of another shape owns the name. */
function registryWithCircle(): InlineModelRegistry {
  const circle: Model = { name: 'Circle', fields: [{ name: 'radius', type: num, required: false }] };
  return new Map([[circle.name, { fingerprint: modelFingerprint(circle) }]]);
}
const stem = (index: number): string => (index === 0 ? 'Body' : `Body${index + 1}`);
const names = (models: Model[]): string[] => models.map((m) => m.name).sort();
const fieldTypes = (models: Model[], name: string) =>
  Object.fromEntries(models.find((m) => m.name === name)!.fields.map((f) => [f.name, f.type]));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('materializeInlineSchema — settling a clash no stem can move', () => {
  it('renames the nested clashing variant under the root and rewrites the reference', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = registryWithCircle();
    const models: Model[] = [];

    const type = materializeInlineSchema(body, { stem, registry, models });

    expect(type).toEqual({ kind: 'model', name: 'Body' });
    expect(names(models)).toEqual(['Body', 'BodyCircle', 'Square']);
    expect(fieldTypes(models, 'Body').shape).toMatchObject({
      kind: 'union',
      variants: [
        { kind: 'model', name: 'BodyCircle' },
        { kind: 'model', name: 'Square' },
      ],
    });
    expect(fieldTypes(models, 'BodyCircle')).toMatchObject({ diameter: num });
    expect(registry.has('BodyCircle')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('moves the body to the next stem when the stem alone clears a root clash', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const taken: Model = { name: 'Body', fields: [{ name: 'other', type: num, required: false }] };
    const registry: InlineModelRegistry = new Map([[taken.name, { fingerprint: modelFingerprint(taken) }]]);
    const models: Model[] = [];

    const type = materializeInlineSchema(
      { type: 'object', properties: { code: { type: 'string' } } },
      { stem, registry, models },
    );

    expect(type).toEqual({ kind: 'model', name: 'Body2' });
    expect(names(models)).toEqual(['Body2']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('materializeInlineSchema — the stems earlier sites of the same bare name settled on (issue #280)', () => {
  const str = { kind: 'primitive' as const, type: 'string' as const };
  const shape = { type: 'object', properties: { name: { type: 'string' } } };
  const otherShape = { type: 'object', properties: { code: { type: 'string' } } };
  const model = (name: string, field: string, type: TypeRef = str): Model => ({
    name,
    fields: [{ name: field, type, required: false }],
  });
  const entry = (m: Model, operation?: string): [string, { fingerprint: string; operation?: string }] => [
    m.name,
    { fingerprint: modelFingerprint(m), operation },
  ];
  /** The content stem of a status code: the bare name, then the code, then numbered. */
  const byCode =
    (code: number) =>
    (index: number): string =>
      index === 0 ? 'Body' : index === 1 ? `Body${code}` : `Body${index}`;
  /** A registry in which `Body` has another shape and `Body200` is the model of `shape` an earlier site settled on. */
  const registryWithSettled = (): InlineModelRegistry =>
    new Map([entry(model('Body', 'other', num)), entry(model('Body200', 'name'), 'Op')]);
  const settled = (stem: string, renames: Array<readonly [string, string]> = []): SettledSite => ({ stem, renames });

  it('shares the model an earlier site settled on, under that stem, before trying its own', () => {
    const registry = registryWithSettled();
    const models: Model[] = [];
    const siblings: SiblingSites = [settled('Body200')];

    const type = materializeInlineSchema(shape, { stem: byCode(201), siblings, registry, models });

    expect(type).toEqual({ kind: 'model', name: 'Body200' });
    expect(models).toEqual([]);
    expect(registry.has('Body201')).toBe(false);
    expect(siblings).toEqual([settled('Body200')]);
  });

  it("steps past a sibling's stem whose model has another shape to its own candidate, and records that", () => {
    const registry = registryWithSettled();
    const models: Model[] = [];
    const siblings: SiblingSites = [settled('Body200')];

    const type = materializeInlineSchema(otherShape, { stem: byCode(201), siblings, registry, models });

    expect(type).toEqual({ kind: 'model', name: 'Body201' });
    expect(names(models)).toEqual(['Body201']);
    expect(siblings).toEqual([settled('Body200'), settled('Body201')]);
  });

  it('records the bare stem when it is free, and a later site shares under it without trying it twice', () => {
    const registry: InlineModelRegistry = new Map();
    const models: Model[] = [];
    const siblings: SiblingSites = [];

    expect(materializeInlineSchema(shape, { stem: byCode(200), siblings, registry, models })).toEqual({
      kind: 'model',
      name: 'Body',
    });
    expect(siblings).toEqual([settled('Body')]);
    expect(materializeInlineSchema(shape, { stem: byCode(201), siblings, registry, models })).toEqual({
      kind: 'model',
      name: 'Body',
    });
    expect(names(models)).toEqual(['Body']);
    expect(siblings).toEqual([settled('Body')]);
  });

  it('shares the nested models too, since they are named from the shared stem', () => {
    const nested = {
      type: 'object',
      properties: { owner: { type: 'object', properties: { id: { type: 'string' } } } },
    };
    const registry: InlineModelRegistry = new Map([entry(model('Body', 'other', num))]);
    const models: Model[] = [];
    const siblings: SiblingSites = [];

    expect(materializeInlineSchema(nested, { stem: byCode(200), siblings, registry, models })).toEqual({
      kind: 'model',
      name: 'Body200',
    });
    expect(names(models)).toEqual(['Body200', 'Body200Owner']);
    expect(materializeInlineSchema(nested, { stem: byCode(201), siblings, registry, models })).toEqual({
      kind: 'model',
      name: 'Body200',
    });
    expect(names(models)).toEqual(['Body200', 'Body200Owner']);
    expect(siblings).toEqual([settled('Body200')]);
  });

  it('tries every sibling stem in order, so a site shares whichever earlier site has its shape', () => {
    const registry: InlineModelRegistry = new Map([entry(model('Body', 'other', num))]);
    const models: Model[] = [];
    const siblings: SiblingSites = [];
    const site = (code: number, schema: Record<string, unknown>) =>
      materializeInlineSchema(schema, { stem: byCode(code), siblings, registry, models });

    expect(site(200, shape)).toEqual({ kind: 'model', name: 'Body200' });
    expect(site(202, otherShape)).toEqual({ kind: 'model', name: 'Body202' });
    expect(site(203, otherShape)).toEqual({ kind: 'model', name: 'Body202' });
    expect(site(204, shape)).toEqual({ kind: 'model', name: 'Body200' });
    expect(names(models)).toEqual(['Body200', 'Body202']);
    expect(siblings).toEqual([settled('Body200'), settled('Body202')]);
  });

  it('leaves out an own candidate a sibling settled on, so no stem is tried twice in a row', () => {
    // `Body2` is both the sibling's stem and this site's second own candidate.
    const registry: InlineModelRegistry = new Map([
      entry(model('Body', 'other', num)),
      entry(model('Body2', 'code'), 'Op'),
    ]);
    const models: Model[] = [];
    const siblings: SiblingSites = [settled('Body2')];

    const type = materializeInlineSchema(shape, { stem, siblings, registry, models });

    expect(type).toEqual({ kind: 'model', name: 'Body3' });
    expect(names(models)).toEqual(['Body3']);
    expect(siblings).toEqual([settled('Body2'), settled('Body3')]);
  });

  it('records the stem the root moved to when renaming a nested variant changed its shape, with every rename', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A registered `Body` exactly as the extractor builds it, whose `shape`
    // points at `Circle` — the component of another shape: the trial's `Body`
    // matches it until its own `Circle` is renamed under the root.
    const minted: Model[] = [];
    materializeInlineSchema(body, { stem, registry: new Map(), models: minted });
    const registry = registryWithCircle();
    registry.set('Body', { fingerprint: modelFingerprint(minted.find((m) => m.name === 'Body')!) });
    const models: Model[] = [];
    const siblings: SiblingSites = [];

    const type = materializeInlineSchema(body, { stem, siblings, registry, models });

    expect(type).toEqual({ kind: 'model', name: 'Body2' });
    expect(names(models)).toEqual(['Body2', 'Body2Circle', 'Square']);
    expect(siblings).toEqual([
      settled('Body2', [
        ['Circle', 'BodyCircle'],
        ['Body', 'Body2'],
        ['BodyCircle', 'Body2Circle'],
      ]),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records the rename made under the stem the fixed point settled on when the root never moved', () => {
    // The registered `Body` differs from the trial's from the first trial on,
    // so the trials step to `Body2` before the fixed point: the settled trial
    // is the one under `Body2`, and `Circle` is renamed under that root.
    const registry = registryWithCircle();
    registry.set('Body', { fingerprint: modelFingerprint(model('Body', 'other', num)) });
    const models: Model[] = [];
    const siblings: SiblingSites = [];

    const type = materializeInlineSchema(body, { stem, siblings, registry, models });

    expect(type).toEqual({ kind: 'model', name: 'Body2' });
    expect(names(models)).toEqual(['Body2', 'Body2Circle', 'Square']);
    expect(siblings).toEqual([settled('Body2', [['Circle', 'Body2Circle']])]);
  });

  it('records nothing and tries only its own candidates when no sibling record is given', () => {
    const registry = registryWithSettled();
    const models: Model[] = [];

    const type = materializeInlineSchema(shape, { stem: byCode(201), registry, models });

    expect(type).toEqual({ kind: 'model', name: 'Body201' });
    expect(names(models)).toEqual(['Body201']);
  });

  describe('a site whose nested variant was renamed under the root (Greptile)', () => {
    it('is shared by an identical later site, which replays the rename and mints nothing', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const registry = registryWithCircle();
      const models: Model[] = [];
      const siblings: SiblingSites = [];

      expect(materializeInlineSchema(body, { stem: byCode(200), siblings, registry, models })).toEqual({
        kind: 'model',
        name: 'Body',
      });
      expect(names(models)).toEqual(['Body', 'BodyCircle', 'Square']);
      expect(siblings).toEqual([settled('Body', [['Circle', 'BodyCircle']])]);

      const type = materializeInlineSchema(body, { stem: byCode(201), siblings, registry, models });

      expect(type).toEqual({ kind: 'model', name: 'Body' });
      expect(names(models)).toEqual(['Body', 'BodyCircle', 'Square']);
      expect(fieldTypes(models, 'Body').shape).toMatchObject({
        variants: [
          { kind: 'model', name: 'BodyCircle' },
          { kind: 'model', name: 'Square' },
        ],
      });
      expect(siblings).toEqual([settled('Body', [['Circle', 'BodyCircle']])]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('is shared the same way when it settled past the bare stem', () => {
      const registry = registryWithCircle();
      registry.set('Body', { fingerprint: modelFingerprint(model('Body', 'other', num)) });
      const models: Model[] = [];
      const siblings: SiblingSites = [];

      expect(materializeInlineSchema(body, { stem: byCode(200), siblings, registry, models })).toEqual({
        kind: 'model',
        name: 'Body200',
      });
      expect(names(models)).toEqual(['Body200', 'Body200Circle', 'Square']);
      expect(materializeInlineSchema(body, { stem: byCode(201), siblings, registry, models })).toEqual({
        kind: 'model',
        name: 'Body200',
      });
      expect(names(models)).toEqual(['Body200', 'Body200Circle', 'Square']);
      expect(siblings).toEqual([settled('Body200', [['Circle', 'Body200Circle']])]);
    });

    it('is not shared by a later site whose renamed variant has another shape, which settles on its own', () => {
      const registry = registryWithCircle();
      const models: Model[] = [];
      const siblings: SiblingSites = [];
      const other = {
        ...body,
        properties: {
          shape: {
            oneOf: [
              titled('Circle', 'circle', { diameter: { type: 'string' } }),
              titled('Square', 'square', { side: { type: 'number' } }),
            ],
          },
        },
      };

      materializeInlineSchema(body, { stem: byCode(200), siblings, registry, models });
      const type = materializeInlineSchema(other, { stem: byCode(201), siblings, registry, models });

      expect(type).toEqual({ kind: 'model', name: 'Body201' });
      expect(names(models)).toEqual(['Body', 'Body201', 'Body201Circle', 'BodyCircle', 'Square']);
      expect(fieldTypes(models, 'Body201Circle')).toMatchObject({ diameter: { kind: 'primitive', type: 'string' } });
      expect(siblings.map((site) => site.stem)).toEqual(['Body', 'Body201']);
    });

    it('skips a replayed rename that does not apply: no model to move, or the name moved to in use', () => {
      const registry: InlineModelRegistry = new Map();
      const models: Model[] = [];
      // A sibling record claiming renames this schema gives nothing to move,
      // and one whose target the schema's own `body_circle` property mints.
      const siblings: SiblingSites = [
        settled('Body', [
          ['Circle', 'BodyCircle'],
          ['Nothing', 'BodyNothing'],
        ]),
      ];
      const withOwnCircle = {
        type: 'object',
        properties: { body_circle: { type: 'object', properties: { r: { type: 'number' } } }, ...body.properties },
      };

      const type = materializeInlineSchema(withOwnCircle, { stem: byCode(200), siblings, registry, models });

      expect(type).toEqual({ kind: 'model', name: 'Body' });
      expect(names(models)).toEqual(['Body', 'BodyCircle', 'Circle', 'Square']);
      expect(fieldTypes(models, 'BodyCircle')).toMatchObject({ r: num });
      expect(fieldTypes(models, 'Body').shape).toMatchObject({ variants: [{ kind: 'model', name: 'Circle' }, {}] });
    });
  });
});
