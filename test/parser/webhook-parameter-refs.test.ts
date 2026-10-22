import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { extractWebhooks } from '../../src/parser/webhooks.js';
import { collectModelRefs } from '../../src/ir/types.js';
import type { ApiSpec, Model, Parameter, UnionType } from '../../src/ir/types.js';
import { expectNameInvariants } from './name-invariants.test.js';

/**
 * Round 4 on #278: a webhook parameter is typed by `extractParams` from its
 * schema alone, then minted by `mintParameter`; the minted reference is the
 * one whose models exist, so it must always replace the extracted type —
 * not only when the parameter's property moved. A query parameter `filter`
 * with titled `Circle`/`Square` variants beside the component enum `Circle`
 * has its `Circle` variant renamed past the enum (`PetAdoptedFilterCircle`)
 * under the parameter's own name; the parameter, its variants and its
 * discriminator mapping must point at that model, never at the enum's name.
 */

async function parseDocument(document: Record<string, unknown>): Promise<ApiSpec> {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-278-param-refs-'));
  try {
    const file = join(dir, 'spec.json');
    writeFileSync(file, JSON.stringify(document));
    return await parseSpec(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const num = { type: 'number' };
const str = { type: 'string' };
/** A title-mapped variant: a title and the `kind` const every variant pins. */
const titled = (title: string, kind: string, properties: Record<string, unknown>) => ({
  title,
  type: 'object',
  properties: { kind: { const: kind }, ...properties },
});
/** The round-4 parameter schema: titled `Circle`/`Square` variants. */
const SHAPES = { oneOf: [titled('Circle', 'circle', { radius: num }), titled('Square', 'square', { side: num })] };
const CIRCLE_ENUM = { type: 'string', enum: ['solid', 'dashed'] };
const NAME = { type: 'object', properties: { name: str } };

/** A `petAdopted` webhook with the given parameters and a JSON payload. */
function petAdopted(parameters: unknown[]): Record<string, unknown> {
  return {
    petAdopted: {
      post: { parameters, requestBody: { content: { 'application/json': { schema: NAME } } }, responses: {} },
    },
  };
}

const document = (webhooks: Record<string, unknown>): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: { title: 'Test', version: '1' },
  paths: {},
  webhooks,
  components: { schemas: { Circle: CIRCLE_ENUM } },
});

/** Every variant and mapping target of the parameter's union names a model that exists, `<circle>` for the circle and `Square` for the square; none names `Circle`. */
function expectShapesParameter(param: Parameter | undefined, circle: string, models: Model[]): void {
  expect(param).toBeDefined();
  const union = param!.type as UnionType;
  expect(union.kind).toBe('union');
  expect(collectModelRefs(union).sort()).toEqual([circle, 'Square'].sort());
  expect(union.discriminator).toEqual({ property: 'kind', mapping: { circle, square: 'Square' } });
  expect(models.find((m) => m.name === circle)?.fields.map((f) => f.name)).toEqual(['kind', 'radius']);
  expect(models.find((m) => m.name === 'Square')?.fields.map((f) => f.name)).toEqual(['kind', 'side']);
  expect(models.map((m) => m.name)).not.toContain('Circle');
}

describe('a webhook parameter always references what its mint produced (issue #278, round 4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a query parameter with titled variants beside component enum Circle references the renamed variant', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(document(petAdopted([{ name: 'filter', in: 'query', schema: SHAPES }])));
    const [webhook] = spec.webhooks ?? [];
    expectShapesParameter(webhook.queryParams[0], 'PetAdoptedFilterCircle', spec.models);
    expect(spec.enums.find((e) => e.name === 'Circle')?.values.map((v) => v.value)).toEqual(['solid', 'dashed']);
    expect(webhook.requestBody).toEqual({ kind: 'model', name: 'PetAdoptedPayload' });
    expectNameInvariants(spec);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a header parameter and a cookie parameter do the same, under their own names', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(
      document(
        petAdopted([
          { name: 'X-Shape', in: 'header', schema: SHAPES },
          { name: 'session', in: 'cookie', schema: SHAPES },
        ]),
      ),
    );
    const [webhook] = spec.webhooks ?? [];
    expectShapesParameter(webhook.headerParams[0], 'PetAdoptedXShapeCircle', spec.models);
    expectShapesParameter(webhook.cookieParams?.[0], 'PetAdoptedSessionCircle', spec.models);
    // `Square`, context-free, is minted once for both and shared.
    expect(spec.models.filter((m) => m.name === 'Square')).toHaveLength(1);
    expectNameInvariants(spec);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps each parameter under its own name when a context-free variant clashes between them', () => {
    // The header's `Square` is already minted by the query parameter and
    // embeds no property, so no candidate property clears it: the earliest
    // trial is kept and the clash is left to the merge — the renamed circle
    // stays under the parameter's own name, never a numbered one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { webhooks, inlineModels } = extractWebhooks(
      petAdopted([
        { name: 'filter', in: 'query', schema: SHAPES },
        { name: 'X-Shape', in: 'header', schema: SHAPES },
      ]),
      { schemas: { Circle: CIRCLE_ENUM } },
      ['Circle'],
      ['Circle'],
    );
    const [webhook] = webhooks;
    expect(collectModelRefs(webhook.queryParams[0].type)).toEqual(['PetAdoptedFilterCircle', 'Square']);
    expect(collectModelRefs(webhook.headerParams[0].type)).toEqual(['PetAdoptedXShapeCircle', 'Square']);
    expect(inlineModels.map((m) => m.name)).toEqual([
      'PetAdoptedPayload',
      'PetAdoptedFilterCircle',
      'Square',
      'PetAdoptedXShapeCircle',
      'Square',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a path parameter has nowhere to go on a webhook and mints nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(
      document(petAdopted([{ name: 'shapeId', in: 'path', required: true, schema: SHAPES }])),
    );
    const [webhook] = spec.webhooks ?? [];
    expect(webhook.queryParams).toEqual([]);
    expect(webhook.headerParams).toEqual([]);
    expect(spec.models.map((m) => m.name)).toEqual(['PetAdoptedPayload']);
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      '[oagen] Warning: Parameter "shapeId" (in: path) on webhooks.petAdopted.post ignored: a webhook has no path to place it in.',
    ]);
    expectNameInvariants(spec);
  });

  it('still moves a parameter off a name the payload minted, reference following', () => {
    // The pre-existing rule: a query parameter named `payload` would mint the
    // body's `<Stem>Payload`, so it is minted under `query_payload` instead,
    // and the parameter references that model.
    const { webhooks, inlineModels } = extractWebhooks(
      petAdopted([{ name: 'payload', in: 'query', schema: { type: 'object', properties: { note: str } } }]),
    );
    const [webhook] = webhooks;
    expect(webhook.queryParams[0].type).toEqual({ kind: 'model', name: 'PetAdoptedQueryPayload' });
    expect(inlineModels.map((m) => [m.name, m.fields.map((f) => f.name)])).toEqual([
      ['PetAdoptedPayload', ['name']],
      ['PetAdoptedQueryPayload', ['note']],
    ]);
  });

  it('a secondary payload whose context-free variant clashes with the primary keeps its own name too', () => {
    // Both payloads mint `Square`, which embeds no property, so no candidate
    // `<Fragment>Payload[N]` clears it: the earliest trial is kept and the
    // renamed circle stays under the secondary's own name, never a numbered one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = { type: 'object', properties: { shape: SHAPES } };
    const { webhooks, inlineModels } = extractWebhooks(
      {
        petAdopted: {
          post: {
            requestBody: { content: { 'application/json': { schema: body }, 'application/xml': { schema: body } } },
            responses: {},
          },
        },
      },
      { schemas: { Circle: CIRCLE_ENUM } },
      ['Circle'],
      ['Circle'],
    );
    const [webhook] = webhooks;
    expect(webhook.requestBodyContents?.map((c) => collectModelRefs(c.type)[0])).toEqual([
      'PetAdoptedPayload',
      'PetAdoptedApplicationXmlPayload',
    ]);
    const names = inlineModels.map((m) => m.name);
    expect(names).toContain('PetAdoptedPayloadCircle');
    expect(names).toContain('PetAdoptedApplicationXmlPayloadCircle');
    expect(names.filter((n) => /Payload\d+Circle$/.test(n))).toEqual([]);
    expect(names).not.toContain('Circle');
    expect(warn).not.toHaveBeenCalled();
  });
});
