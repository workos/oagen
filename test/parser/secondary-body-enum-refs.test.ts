import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSpec } from '../../src/parser/parse.js';
import { collectModelRefs } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';
import { expectNameInvariants } from './name-invariants.test.js';

/**
 * Round 3 on #278: reserving enum names in the deferred registry must not
 * make a valid document fail to parse. A secondary body whose `shape.oneOf`
 * has titled `Circle`/`Square` object variants, beside a property that
 * references the component ENUM `Circle`, mints a model named `Circle`
 * nested below the top level; the rename that settles it under the body's
 * root must treat the enum reference as what it is — an `EnumRef` no rename
 * touches — not as a component model reference that forbids the rename. The
 * same document on a webhook payload, which never uses the registry, takes
 * the same stepped name through the webhook mint.
 */

async function parseDocument(document: Record<string, unknown>): Promise<ApiSpec> {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-278-enum-refs-'));
  try {
    const file = join(dir, 'spec.json');
    writeFileSync(file, JSON.stringify(document));
    return await parseSpec(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function document(
  paths: Record<string, unknown>,
  schemas: Record<string, unknown> = {},
  webhooks?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Test', version: '1' },
    paths,
    ...(webhooks ? { webhooks } : {}),
    components: { schemas },
  };
}

const str = { type: 'string' };
const num = { type: 'number' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties });
const NAME = obj({ name: str });
const ok = { '204': { description: 'ok' } };
/** A title-mapped variant: a title and the `kind` const every variant pins. */
const titled = (title: string, kind: string, properties: Record<string, unknown>) => ({
  title,
  type: 'object',
  properties: { kind: { const: kind }, ...properties },
});
/** The round-3 body: titled `Circle`/`Square` variants under `shape`, and `outline` typed by the component enum `Circle`. */
const BODY = obj({
  shape: { oneOf: [titled('Circle', 'circle', { radius: num }), titled('Square', 'square', { side: num })] },
  outline: { $ref: '#/components/schemas/Circle' },
});
const CIRCLE_ENUM = { type: 'string', enum: ['solid', 'dashed'] };

const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));

const modelOf = (spec: ApiSpec, name: string): Model => {
  const model = spec.models.find((m) => m.name === name);
  expect(model, name).toBeDefined();
  return model!;
};

/**
 * The body model under `root` has `outline` typed by the enum `Circle`,
 * `Circle` is an enum and never a model, and the `Circle` variant of `shape`
 * is a model with the circle's fields under a stepped name — `<root>Circle`.
 */
function expectEnumKeptAndVariantStepped(spec: ApiSpec, root: string): void {
  const body = modelOf(spec, root);
  const outline = body.fields.find((f) => f.name === 'outline');
  expect(outline?.type).toEqual({ kind: 'enum', name: 'Circle' });
  expect(spec.enums.find((e) => e.name === 'Circle')?.values.map((v) => v.value)).toEqual(['solid', 'dashed']);
  expect(spec.models.map((m) => m.name)).not.toContain('Circle');
  const shape = body.fields.find((f) => f.name === 'shape')?.type as TypeRef;
  const variants = collectModelRefs(shape);
  expect(variants).toContain(`${root}Circle`);
  expect(variants).toContain('Square');
  expect(modelOf(spec, `${root}Circle`).fields.map((f) => f.name)).toEqual(['kind', 'radius']);
  expect(modelOf(spec, 'Square').fields.map((f) => f.name)).toEqual(['kind', 'side']);
  expectNameInvariants(spec);
}

describe('a titled variant named like a component enum the same body references (issue #278, round 3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses on a secondary request body, keeps the enum reference and steps the variant', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(
      document(
        {
          '/widgets/{widgetId}': {
            put: {
              operationId: 'replaceWidget',
              parameters: [{ name: 'widgetId', in: 'path', required: true, schema: str }],
              requestBody: { content: { 'application/json': { schema: NAME }, 'application/xml': { schema: BODY } } },
              responses: ok,
            },
          },
        },
        { Circle: CIRCLE_ENUM },
      ),
    );
    const op = opsOf(spec).replaceWidget;
    expect(op.requestBodyContents?.[1].type).toEqual({ kind: 'model', name: 'ReplaceWidgetApplicationXmlRequest' });
    expectEnumKeptAndVariantStepped(spec, 'ReplaceWidgetApplicationXmlRequest');
    expect(warn).not.toHaveBeenCalled();
  });

  it('parses on a secondary response body (a media type typed from its schema), keeps the enum reference and steps the variant', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = await parseDocument(
      document(
        {
          '/widgets/{widgetId}': {
            get: {
              operationId: 'getWidget',
              parameters: [{ name: 'widgetId', in: 'path', required: true, schema: str }],
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { schema: NAME }, 'application/x-ndjson': { schema: BODY } },
                },
              },
            },
          },
        },
        { Circle: CIRCLE_ENUM },
      ),
    );
    const op = opsOf(spec).getWidget;
    const [root] = collectModelRefs(op.responseContents![1].type);
    expect(root).toBe('GetWidgetApplicationXNdjsonResponse');
    expectEnumKeptAndVariantStepped(spec, root);
    expect(warn).not.toHaveBeenCalled();
  });

  it('parses on a webhook payload, secondary and primary, keeps the enum reference and steps the variant', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secondary = await parseDocument(
      document(
        {},
        { Circle: CIRCLE_ENUM },
        {
          petAdopted: {
            post: {
              requestBody: { content: { 'application/json': { schema: NAME }, 'application/xml': { schema: BODY } } },
              responses: {},
            },
          },
        },
      ),
    );
    const [webhook] = secondary.webhooks ?? [];
    // The stem stays plain: the variant no longer collides with the enum, so nothing hashes it.
    expect(webhook.requestBody).toEqual({ kind: 'model', name: 'PetAdoptedPayload' });
    expect(webhook.requestBodyContents?.[1].type).toEqual({ kind: 'model', name: 'PetAdoptedApplicationXmlPayload' });
    expectEnumKeptAndVariantStepped(secondary, 'PetAdoptedApplicationXmlPayload');

    const primary = await parseDocument(
      document(
        {},
        { Circle: CIRCLE_ENUM },
        {
          petAdopted: { post: { requestBody: { content: { 'application/json': { schema: BODY } } }, responses: {} } },
        },
      ),
    );
    expect(primary.webhooks?.[0].requestBody).toEqual({ kind: 'model', name: 'PetAdoptedPayload' });
    expectEnumKeptAndVariantStepped(primary, 'PetAdoptedPayload');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still fails loudly when the same body inlines a different `Circle` and references component MODEL `Circle`', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      parseDocument(
        document(
          {
            '/widgets/{widgetId}': {
              put: {
                operationId: 'replaceWidget',
                parameters: [{ name: 'widgetId', in: 'path', required: true, schema: str }],
                requestBody: {
                  content: { 'application/json': { schema: NAME }, 'application/xml': { schema: BODY } },
                },
                responses: ok,
              },
            },
          },
          { Circle: obj({ diameter: num }) },
        ),
      ),
    ).rejects.toThrow(
      'Inline schema "Circle" under ReplaceWidgetApplicationXmlRequest has another shape than component "Circle", which the same schema also references',
    );
  });
});
