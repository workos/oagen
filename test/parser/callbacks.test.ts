import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { warnOnIgnoredCallbacks } from '../../src/parser/callbacks.js';
import { collectModelRefs, collectWebhookTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * Issue #272: an operation's `callbacks` were not parsed, and nothing said
 * so. The parser still does not read them — a callback's request body never
 * becomes a model — but every operation that declares any is now told so
 * once, from `paths` and from `webhooks` alike, through the one
 * `warnOnIgnoredCallbacks`.
 */

const petIdSchema = { type: 'object', properties: { petId: { type: 'string' } } };

/** A Callback Object: one runtime-expression path item whose POST carries `schema`. */
function callbackPosting(schema: Record<string, unknown> = petIdSchema) {
  return {
    '{$request.body#/callbackUrl}': {
      post: {
        requestBody: { content: { 'application/json': { schema } } },
        responses: { '200': { description: 'OK' } },
      },
    },
  };
}

/** An operation that acknowledges with a bare 200, declaring the given callbacks. */
function opWith(callbacks: unknown, operationId?: string) {
  return {
    ...(operationId ? { operationId } : {}),
    responses: { '200': { description: 'OK' } },
    callbacks,
  };
}

/** The issue's repro, verbatim. */
const issueRepro = {
  openapi: '3.1.0',
  info: { title: 'repro', version: '1' },
  paths: {
    '/pets': {
      post: {
        operationId: 'createPet',
        responses: { '200': { description: 'OK' } },
        callbacks: { petAdopted: callbackPosting() },
      },
    },
  },
};

describe('operation callbacks (issue #272)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-callbacks-'));
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

  /** Every `console.warn` message so far, in order. */
  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  const operationNames = (spec: ApiSpec) => spec.services.flatMap((service) => service.operations.map((op) => op.name));

  describe('on a `paths` operation', () => {
    it("parses the issue's repro without its callbacks, and says so once", async () => {
      const spec = await parseJson(issueRepro);

      // The output the issue shows, unchanged: nothing is read from the callback.
      expect(spec.models.map(({ name }) => name)).toEqual([]);
      expect('webhooks' in spec).toBe(false);
      // The operation itself is parsed as it was.
      expect(operationNames(spec)).toEqual(['createPet']);

      expect(warnings()).toEqual([
        '[oagen] Warning: `callbacks` on createPet are not read ("petAdopted"); the operation is parsed ' +
          "without them. Declare each callback's request under the top-level `webhooks` map (OpenAPI 3.1) " +
          'to have its payload typed.',
      ]);
    });

    it('names an operation without an operationId by its method and path', async () => {
      const spec = await parseJson({
        ...issueRepro,
        paths: { '/pets': { post: opWith({ petAdopted: callbackPosting() }) } },
      });

      expect(operationNames(spec)).toHaveLength(1);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('`callbacks` on POST /pets are not read ("petAdopted")');
    });

    it('warns once per operation naming every callback, not once per callback or per path expression', async () => {
      const twoExpressions = {
        ...callbackPosting(),
        '{$request.body#/secondUrl}': callbackPosting()['{$request.body#/callbackUrl}'],
      };
      const spec = await parseJson({
        ...issueRepro,
        paths: {
          '/pets': {
            // Methods are read in `HTTP_METHODS` order, so the GET is reported first.
            get: opWith({ petListed: callbackPosting() }, 'listPets'),
            post: opWith({ petAdopted: twoExpressions, petReturned: twoExpressions }, 'createPet'),
          },
          '/owners': { get: { operationId: 'listOwners', responses: { '200': { description: 'OK' } } } },
        },
      });

      expect(spec.models).toEqual([]);
      expect(operationNames(spec).sort()).toEqual(['createPet', 'listOwners', 'listPets']);
      expect(warnings()).toHaveLength(2);
      expect(warnings()[0]).toContain('`callbacks` on listPets are not read ("petListed")');
      expect(warnings()[1]).toContain('`callbacks` on createPet are not read ("petAdopted", "petReturned")');
    });

    it('reports a `$ref` into components/callbacks at the operation that writes it, under its key', async () => {
      const spec = await parseJson({
        ...issueRepro,
        paths: { '/pets': { post: opWith({ adopted: { $ref: '#/components/callbacks/petAdopted' } }, 'createPet') } },
        components: { callbacks: { petAdopted: callbackPosting() } },
      });

      expect(spec.models).toEqual([]);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('`callbacks` on createPet are not read ("adopted")');
    });

    it('is silent for an empty `callbacks` map and for a components/callbacks entry nothing references', async () => {
      const spec = await parseJson({
        ...issueRepro,
        paths: { '/pets': { post: opWith({}, 'createPet') } },
        components: { callbacks: { petAdopted: callbackPosting() } },
      });

      expect(operationNames(spec)).toEqual(['createPet']);
      expect(spec.models).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('on a `webhooks` operation', () => {
    it('warns under the webhook label and still parses the webhook and its payload', async () => {
      const spec = await parseJson({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {},
        webhooks: {
          petAdopted: {
            post: {
              requestBody: { content: { 'application/json': { schema: petIdSchema } } },
              responses: { '200': { description: 'OK' } },
              callbacks: { adoptionConfirmed: callbackPosting() },
            },
          },
        },
      });

      expect(spec.webhooks?.map(({ name, httpMethod }) => `${name}.${httpMethod}`)).toEqual(['petAdopted.post']);
      // The webhook's own payload is read as before; the callback's never is.
      expect(spec.models.map(({ name }) => name)).toEqual(['PetAdoptedPayload']);
      const modelNames = new Set(spec.models.map(({ name }) => name));
      for (const ref of collectWebhookTypeRefs(spec.webhooks![0])) {
        for (const name of collectModelRefs(ref)) expect(modelNames.has(name), name).toBe(true);
      }

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('`callbacks` on webhooks.petAdopted.post are not read ("adoptionConfirmed")');
    });

    it('warns once per (key, method) entry, two keys sharing one components/pathItems entry included', async () => {
      const spec = await parseJson({
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {},
        webhooks: {
          petUpdated: {
            put: { responses: { '200': { description: 'OK' } }, callbacks: { putDone: callbackPosting() } },
            post: { responses: { '200': { description: 'OK' } }, callbacks: { postDone: callbackPosting() } },
          },
          petQuiet: { post: { responses: { '200': { description: 'OK' } } } },
          // Two keys resolving to one operation object are two sites: each loses the callbacks.
          sharedA: { $ref: '#/components/pathItems/shared' },
          sharedB: { $ref: '#/components/pathItems/shared' },
        },
        components: {
          pathItems: {
            shared: { post: { responses: { '200': { description: 'OK' } }, callbacks: { shared: callbackPosting() } } },
          },
        },
      });

      expect(spec.webhooks?.map(({ name, httpMethod }) => `${name}.${httpMethod}`)).toEqual([
        'petUpdated.put',
        'petUpdated.post',
        'petQuiet.post',
        'sharedA.post',
        'sharedB.post',
      ]);
      expect(warnings()).toEqual([
        expect.stringContaining('`callbacks` on webhooks.petUpdated.put are not read ("putDone")'),
        expect.stringContaining('`callbacks` on webhooks.petUpdated.post are not read ("postDone")'),
        expect.stringContaining('`callbacks` on webhooks.sharedA.post are not read ("shared")'),
        expect.stringContaining('`callbacks` on webhooks.sharedB.post are not read ("shared")'),
      ]);
    });
  });

  describe('warnOnIgnoredCallbacks', () => {
    it.each([
      { what: 'undefined', callbacks: undefined },
      { what: 'null', callbacks: null },
      { what: 'a string', callbacks: 'petAdopted' },
      { what: 'an array', callbacks: [{ petAdopted: {} }] },
      { what: 'an empty map', callbacks: {} },
    ])('is silent for $what, which declares no callback', ({ callbacks }) => {
      warnOnIgnoredCallbacks(callbacks, 'createPet');
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns once, under the given label, naming every key in document order', () => {
      warnOnIgnoredCallbacks({ b: {}, a: { $ref: '#/components/callbacks/a' } }, 'webhooks.x.post');

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('[oagen] Warning: `callbacks` on webhooks.x.post are not read ("b", "a")');
    });
  });
});
