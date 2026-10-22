import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Model } from '../../src/ir/types.js';
import {
  materializeInlineSchema,
  modelFingerprint,
  type InlineModelRegistry,
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
