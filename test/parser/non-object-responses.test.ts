import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { isResponseEntry, isResponsesObject } from '../../src/parser/response-refs.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';

/**
 * Issue #617: a `responses` entry that is not an object — `200: "oops"`,
 * `null`, `7`, `true`, `[]` — failed the whole parse with a `TypeError`
 * naming neither the operation nor the status code (`Cannot use 'in'
 * operator to search for '$ref' in oops`). It is now warned about once,
 * naming the site, and skipped, and the operation is read from its other
 * entries; a webhook's and a callback's responses are read the same way,
 * and a `responses` that is not an object at all is read as absent.
 */

const VERSIONS = ['3.0.3', '3.1.0'] as const;
/** Every non-object kind a JSON or YAML document can write, with how the warning renders it. */
const NON_OBJECTS: Array<[kind: string, value: unknown, rendered: string]> = [
  ['a string', 'oops', '"oops"'],
  ['null', null, 'null'],
  ['a number', 7, '7'],
  ['a boolean', true, 'true'],
  ['an array', [], '[]'],
];
const ok = { description: 'No pets.' };
const info = { title: 'repro', version: '1' };
const unknownType = { kind: 'primitive', type: 'unknown' };

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Write `doc` to a temp file. */
function write(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'oagen-617-'));
  dirs.push(dir);
  const file = join(dir, 'spec.json');
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

/** Parse `doc` from a file, as the issue does, collecting every warning the parse prints. */
async function parse(doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const spec = await parseSpec(write(doc));
  const warnings = warn.mock.calls.map((call) => String(call[0]));
  warn.mockRestore();
  return { spec, warnings };
}

/** The issue's document: `GET /pets` (`listPets`) with the given `responses`. */
function petsDoc(responses: unknown, openapi: string, extra: Record<string, unknown> = {}) {
  return { openapi, info, paths: { '/pets': { get: { operationId: 'listPets', responses } } }, ...extra };
}

/** The one operation a document declares. */
function onlyOperation(spec: ApiSpec): Operation {
  const operations = spec.services.flatMap((service) => service.operations);
  expect(operations).toHaveLength(1);
  return operations[0];
}

const payload = {
  content: { 'application/json': { schema: { type: 'object', properties: { petId: { type: 'string' } } } } },
};

/** A `petAdopted` webhook posting a payload, with the given `responses`. */
function webhookDoc(responses: unknown, openapi: string) {
  return { openapi, info, paths: {}, webhooks: { petAdopted: { post: { requestBody: payload, responses } } } };
}

/** `createPet`, declaring a `petAdopted` callback with the given `responses`. */
function callbackDoc(responses: unknown, openapi: string) {
  const callback = { '{$request.body#/callbackUrl}': { post: { requestBody: payload, responses } } };
  return {
    openapi,
    info,
    paths: {
      '/pets': { post: { operationId: 'createPet', responses: { '200': ok }, callbacks: { petAdopted: callback } } },
    },
  };
}

const skipped = (site: string, rendered: string) =>
  `[oagen] Warning: ${site} is not a Response Object (${rendered}); skipping it.`;
const noResponses = (label: string, rendered: string) =>
  `[oagen] Warning: responses of ${label} is not a Responses Object (${rendered}); reading no response from it.`;

describe('#617', () => {
  for (const openapi of VERSIONS) {
    describe(`OpenAPI ${openapi}`, () => {
      it.each(NON_OBJECTS)(
        'warns once about a 200 that is %s, skips it and reads listPets from its 204 (the issue repro)',
        async (_kind, value, rendered) => {
          const { spec, warnings } = await parse(petsDoc({ '200': value, '204': ok }, openapi));

          expect(warnings).toEqual([skipped('200 response of listPets', rendered)]);
          const op = onlyOperation(spec);
          expect(op.responseStatusCode).toBe(204);
          expect(op.response).toEqual(unknownType);
          expect(op.responseDescription).toBe('No pets.');
          expect(op.successResponses).toBeUndefined();
          expect(op.errors).toEqual([]);
          expect(op.defaultResponse).toBeUndefined();
          expect(op.rangeResponses).toBeUndefined();
          expect(spec.models).toEqual([]);
        },
      );

      it('reads the same operation whichever order the entries are declared in', async () => {
        const first = await parse(petsDoc({ '200': 'oops', '204': ok }, openapi));
        const second = await parse(petsDoc({ '204': ok, '200': 'oops' }, openapi));

        expect(second.spec).toEqual(first.spec);
        expect(second.warnings).toEqual(first.warnings);
      });

      it.each([
        ['a 1xx', '101'],
        ['a 3xx', '302'],
        ['an error code', '404'],
        ['default', 'default'],
        ['a range', '2XX'],
      ])('skips %s entry that is not an object, with one warning naming the key', async (_kind, key) => {
        const { spec, warnings } = await parse(petsDoc({ [key]: null, '204': ok }, openapi));

        expect(warnings).toEqual([skipped(`${key} response of listPets`, 'null')]);
        const op = onlyOperation(spec);
        expect(op.responseStatusCode).toBe(204);
        expect(op.successResponses).toBeUndefined();
        expect(op.errors).toEqual([]);
        expect(op.defaultResponse).toBeUndefined();
        expect(op.rangeResponses).toBeUndefined();
      });

      it('checks every key a reader reads, each warned about once, in document order', async () => {
        const responses = { '101': 'a', '200': 'b', '302': 'c', '404': 'd', default: 'e', '2XX': 'f', '204': ok };
        const { spec, warnings } = await parse(petsDoc(responses, openapi));

        expect(warnings).toEqual([
          skipped('101 response of listPets', '"a"'),
          skipped('200 response of listPets', '"b"'),
          skipped('302 response of listPets', '"c"'),
          skipped('404 response of listPets', '"d"'),
          skipped('default response of listPets', '"e"'),
          skipped('2XX response of listPets', '"f"'),
        ]);
        expect(onlyOperation(spec).responseStatusCode).toBe(204);
      });

      it('does not check an x- extension, and reports a key OpenAPI does not define on its own', async () => {
        const { spec, warnings } = await parse(petsDoc({ 'x-notes': 'oops', '600': 'oops', '204': ok }, openapi));

        expect(warnings).toEqual([
          '[oagen] Warning: Ignoring response key "600" on listPets: not a status code (three digits, 100–599), a 1XX–5XX range, or "default"',
        ]);
        expect(onlyOperation(spec).responseStatusCode).toBe(204);
      });

      it('warns once for an operation named from its path, too: the name rehearsals skip the entry silently', async () => {
        const doc = { openapi, info, paths: { '/pets': { get: { responses: { '200': 'oops', '204': ok } } } } };
        const { spec, warnings } = await parse(doc);

        expect(warnings).toEqual([skipped('200 response of GET /pets', '"oops"')]);
        expect(onlyOperation(spec).responseStatusCode).toBe(204);
      });

      it.each(NON_OBJECTS)(
        'reads a responses that is %s as absent, with one warning, never as the map of its indexes',
        async (_kind, value, rendered) => {
          const { spec, warnings } = await parse(petsDoc(value, openapi));

          expect(warnings).toEqual([noResponses('listPets', rendered)]);
          const op = onlyOperation(spec);
          expect(op.response).toEqual(unknownType);
          expect(op.responseStatusCode).toBeUndefined();
          expect(op.successResponses).toBeUndefined();
          expect(op.errors).toEqual([]);
        },
      );

      it('reads a responses written as an array of Response Objects as absent, not as a response at key "0"', async () => {
        const { spec, warnings } = await parse(petsDoc([ok], openapi));

        expect(warnings).toEqual([noResponses('listPets', '[{"description":"No pets."}]')]);
        expect(onlyOperation(spec).responseStatusCode).toBeUndefined();
      });

      it('parses a components/responses entry that is not an object, silently when nothing refers to it', async () => {
        const components = { responses: { Bad: 'oops', Worse: null } };
        const { spec, warnings } = await parse(petsDoc({ '204': ok }, openapi, { components }));

        expect(warnings).toEqual([]);
        expect(onlyOperation(spec).responseStatusCode).toBe(204);
      });

      it('reads a $ref to a components/responses entry that is not an object as a ref nothing answers', async () => {
        const components = { responses: { Bad: 'oops' } };
        const responses = { '200': { $ref: '#/components/responses/Bad' }, '204': ok };
        const { spec, warnings } = await parse(petsDoc(responses, openapi, { components }));

        expect(warnings).toEqual([
          '[oagen] Warning: Unresolved response $ref "#/components/responses/Bad" in 200 response of listPets: no matching entry under components/responses — reading the response as written, without a body or headers',
        ]);
        const op = onlyOperation(spec);
        expect(op.responseStatusCode).toBe(200);
        expect(op.response).toEqual(unknownType);
        expect(op.successResponses?.map((entry) => entry.statusCode)).toEqual([200, 204]);
      });

      it.each(NON_OBJECTS)(
        'skips a webhook response entry that is %s, with one warning naming the webhook',
        async (_kind, value, rendered) => {
          const { spec, warnings } = await parse(
            webhookDoc({ '200': value, '204': { description: 'Acknowledged' } }, openapi),
          );

          expect(warnings).toEqual([skipped('200 response of webhooks.petAdopted.post', rendered)]);
          expect(spec.webhooks).toHaveLength(1);
          expect(spec.webhooks![0].responses).toEqual([{ statusCode: 204, description: 'Acknowledged' }]);
        },
      );

      it('reads a webhook responses that is not an object as none, with one warning', async () => {
        const { spec, warnings } = await parse(webhookDoc('oops', openapi));

        expect(warnings).toEqual([noResponses('webhooks.petAdopted.post', '"oops"')]);
        expect(spec.webhooks![0].responses).toEqual([]);
      });

      it('skips a callback response entry that is not an object, with one warning naming the callback site', async () => {
        const { spec, warnings } = await parse(
          callbackDoc({ '200': null, '204': { description: 'Acknowledged' } }, openapi),
        );

        expect(warnings).toEqual([
          skipped('200 response of createPet.callbacks.petAdopted.{$request.body#/callbackUrl}.post', 'null'),
        ]);
        const op = onlyOperation(spec);
        expect(op.responseStatusCode).toBe(200);
        expect(op.callbacks).toHaveLength(1);
        expect(op.callbacks![0].responses).toEqual([{ statusCode: 204, description: 'Acknowledged' }]);
      });
    });
  }

  it('oagen diff on the issue document exits 0 with no changes, where it printed the TypeError and exited 1', async () => {
    const file = write(petsDoc({ '200': 'oops', '204': ok }, '3.1.0'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err: any = await diffCommand({ old: file, new: file }).catch((e) => e);

    expect(err).toBeDefined();
    expect(err.exitCode).toBe(0);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(skipped('200 response of listPets', '"oops"'));
  });

  describe('isResponseEntry', () => {
    it('accepts a Response Object and a Reference Object without a word', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(isResponseEntry({ description: 'ok' }, '200 response of listPets')).toBe(true);
      expect(isResponseEntry({ $ref: '#/components/responses/Problem' }, '200 response of listPets')).toBe(true);
      expect(isResponseEntry({}, '200 response of listPets')).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(NON_OBJECTS)(
      'rejects %s, warning once with the site when given one and silently otherwise',
      (_kind, value, rendered) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(isResponseEntry(value, '404 response of getPet')).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(skipped('404 response of getPet', rendered));
        expect(isResponseEntry(value)).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('isResponsesObject', () => {
    it('accepts an object without a word and rejects anything else with one warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(isResponsesObject({}, 'listPets')).toBe(true);
      expect(isResponsesObject({ '200': ok }, 'listPets')).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      for (const [, value, rendered] of NON_OBJECTS) {
        expect(isResponsesObject(value, 'listPets')).toBe(false);
        expect(warn).toHaveBeenLastCalledWith(noResponses('listPets', rendered));
      }
      expect(warn).toHaveBeenCalledTimes(NON_OBJECTS.length);
    });
  });
});
