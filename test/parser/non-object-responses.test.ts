import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { isResponseEntry, isResponsesObject, resolveResponseRef } from '../../src/parser/response-refs.js';
import { followReference } from '../../src/parser/reference-objects.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, Operation } from '../../src/ir/types.js';

/**
 * Issue #617: a `responses` entry that is not an object — `200: "oops"`,
 * `null`, `7`, `true`, `[]` — failed the whole parse with a `TypeError`
 * naming neither the operation nor the status code (`Cannot use 'in'
 * operator to search for '$ref' in oops`). It is now warned about once,
 * naming the site, and skipped, and the operation is read from its other
 * entries; a webhook's and a callback's responses are read the same way,
 * and a `responses` that is not an object at all is read as absent. A
 * `$ref` whose chain ends on a `components/responses` entry that is not an
 * object is the same malformed entry behind a pointer, and is skipped the
 * same way, the warning naming the component (review finding 1).
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
/** A `$ref` to the component the review's finding names. */
const gone = { $ref: '#/components/responses/Gone' };
/** `components/responses` holding `Gone` as the given value. */
const goneAs = (value: unknown) => ({ components: { responses: { Gone: value } } });

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

/** The exit code `oagen diff` ends with for the two documents. */
async function diffExitCode(oldDoc: unknown, newDoc: unknown): Promise<number> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const err: any = await diffCommand({ old: write(oldDoc), new: write(newDoc) }).catch((e) => e);
  expect(err).toBeDefined();
  return err.exitCode;
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
function webhookDoc(responses: unknown, openapi: string, extra: Record<string, unknown> = {}) {
  return {
    openapi,
    info,
    paths: {},
    webhooks: { petAdopted: { post: { requestBody: payload, responses } } },
    ...extra,
  };
}

/** `createPet`, declaring a `petAdopted` callback with the given `responses`. */
function callbackDoc(responses: unknown, openapi: string, extra: Record<string, unknown> = {}) {
  const callback = { '{$request.body#/callbackUrl}': { post: { requestBody: payload, responses } } };
  return {
    openapi,
    info,
    paths: {
      '/pets': { post: { operationId: 'createPet', responses: { '200': ok }, callbacks: { petAdopted: callback } } },
    },
    ...extra,
  };
}

const skipped = (site: string, rendered: string) =>
  `[oagen] Warning: ${site} is not a Response Object (${rendered}); skipping it.`;
const noResponses = (label: string, rendered: string) =>
  `[oagen] Warning: responses of ${label} is not a Responses Object (${rendered}); reading no response from it.`;
/** The warning for a `$ref` to `Gone` holding a non-object, at `site`. */
const goneSkipped = (site: string, rendered: string) => skipped(`components/responses/Gone (the ${site})`, rendered);

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
        const components = { responses: { Bad: 'oops', Worse: null, Gone: [] } };
        const { spec, warnings } = await parse(petsDoc({ '204': ok }, openapi, { components }));

        expect(warnings).toEqual([]);
        expect(onlyOperation(spec).responseStatusCode).toBe(204);
      });

      it('still reads a $ref the section holds nothing under (one into another section) as a ref nothing answers', async () => {
        // A pointer to a `components/responses` name that does not exist never
        // reaches the parser: the bundler rejects it first.
        const responses = { '200': { $ref: '#/components/schemas/Gone' }, '204': ok };
        const components = { schemas: { Gone: { type: 'object' } }, responses: { Gone: [] } };
        const { spec, warnings } = await parse(petsDoc(responses, openapi, { components }));

        expect(warnings).toEqual([
          '[oagen] Warning: Unresolved response $ref "#/components/schemas/Gone" in 200 response of listPets: no matching entry under components/responses — reading the response as written, without a body or headers',
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

      describe('a $ref to a components/responses entry that is not an object (review finding 1)', () => {
        it.each(NON_OBJECTS)(
          'skips a 200 that points at %s, warning once naming the component, and reads listPets from its 204 as for the inline entry',
          async (_kind, value, rendered) => {
            const { spec, warnings } = await parse(petsDoc({ '200': gone, '204': ok }, openapi, goneAs(value)));

            expect(warnings).toEqual([goneSkipped('200 response of listPets', rendered)]);
            const op = onlyOperation(spec);
            expect(op.responseStatusCode).toBe(204);
            expect(op.response).toEqual(unknownType);
            expect(op.responseDescription).toBe('No pets.');
            expect(op.successResponses).toBeUndefined();
            expect(op.errors).toEqual([]);
            expect(spec.models).toEqual([]);
            // One IR for the inline and the `$ref` spelling of the same malformed entry.
            const inline = await parse(petsDoc({ '200': value, '204': ok }, openapi));
            expect(spec).toEqual(inline.spec);
          },
        );

        it('reads the same operation whichever order the entries are declared in', async () => {
          const first = await parse(petsDoc({ '200': gone, '204': ok }, openapi, goneAs([])));
          const second = await parse(petsDoc({ '204': ok, '200': gone }, openapi, goneAs([])));

          expect(second.spec).toEqual(first.spec);
          expect(second.warnings).toEqual(first.warnings);
        });

        it('names the last hop of a chain, by its decoded name', async () => {
          const components = {
            responses: { Alias: { $ref: '#/components/responses/Also~1Gone' }, 'Also/Gone': 'oops' },
          };
          const responses = { '200': { $ref: '#/components/responses/Alias' }, '204': ok };
          const { spec, warnings } = await parse(petsDoc(responses, openapi, { components }));

          expect(warnings).toEqual([
            skipped('components/responses/Also/Gone (the 200 response of listPets)', '"oops"'),
          ]);
          const op = onlyOperation(spec);
          expect(op.responseStatusCode).toBe(204);
          expect(op.successResponses).toBeUndefined();
        });

        it.each([
          ['a 3xx', '302'],
          ['an error code', '404'],
          ['default', 'default'],
          ['a range', '2XX'],
        ])('skips %s entry that points at it, with one warning naming the key', async (_kind, key) => {
          const { spec, warnings } = await parse(petsDoc({ [key]: gone, '204': ok }, openapi, goneAs([])));

          expect(warnings).toEqual([goneSkipped(`${key} response of listPets`, '[]')]);
          const op = onlyOperation(spec);
          expect(op.responseStatusCode).toBe(204);
          expect(op.successResponses).toBeUndefined();
          expect(op.errors).toEqual([]);
          expect(op.defaultResponse).toBeUndefined();
          expect(op.rangeResponses).toBeUndefined();
        });

        it('warns once for an operation named from its path, too: the name rehearsals skip the entry silently', async () => {
          const doc = {
            openapi,
            info,
            paths: { '/pets': { get: { responses: { '200': gone, '204': ok } } } },
            ...goneAs(7),
          };
          const { spec, warnings } = await parse(doc);

          expect(warnings).toEqual([goneSkipped('200 response of GET /pets', '7')]);
          expect(onlyOperation(spec).responseStatusCode).toBe(204);
        });

        it.each(NON_OBJECTS)(
          'skips a webhook response that points at %s, with one warning naming the component and the webhook',
          async (_kind, value, rendered) => {
            const responses = { '200': gone, '204': { description: 'Acknowledged' } };
            const { spec, warnings } = await parse(webhookDoc(responses, openapi, goneAs(value)));

            expect(warnings).toEqual([goneSkipped('200 response of webhooks.petAdopted.post', rendered)]);
            expect(spec.webhooks![0].responses).toEqual([{ statusCode: 204, description: 'Acknowledged' }]);
          },
        );

        it('skips a callback response that points at it, with one warning naming the component and the callback site', async () => {
          const responses = { '200': gone, '204': { description: 'Acknowledged' } };
          const { spec, warnings } = await parse(callbackDoc(responses, openapi, goneAs(null)));

          expect(warnings).toEqual([
            goneSkipped('200 response of createPet.callbacks.petAdopted.{$request.body#/callbackUrl}.post', 'null'),
          ]);
          const op = onlyOperation(spec);
          expect(op.callbacks![0].responses).toEqual([{ statusCode: 204, description: 'Acknowledged' }]);
        });

        it('oagen diff between the inline and the $ref spelling of the same malformed entry exits 0', async () => {
          const inline = petsDoc({ '200': [], '204': ok }, openapi);
          const viaRef = petsDoc({ '200': gone, '204': ok }, openapi, goneAs([]));

          expect(await diffExitCode(inline, viaRef)).toBe(0);
          expect(await diffExitCode(viaRef, inline)).toBe(0);
        });
      });
    });
  }

  it('oagen diff on the issue document exits 0 with no changes, where it printed the TypeError and exited 1', async () => {
    const doc = petsDoc({ '200': 'oops', '204': ok }, '3.1.0');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await diffExitCode(doc, doc)).toBe(0);
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

  describe('followReference', () => {
    const components = (entries: Record<string, unknown>) => entries as Record<string, Record<string, unknown>>;

    it.each(NON_OBJECTS)(
      'ends unresolved on a component that is %s, handing the entry back as found',
      (_kind, value) => {
        const followed = followReference(gone, 'responses', components({ Gone: value }), 'override');

        expect(followed).toEqual({
          outcome: 'unresolved',
          ref: gone.$ref,
          value: gone,
          found: { name: 'Gone', value },
        });
      },
    );

    it('hands back the last hop of a chain, by its decoded name', () => {
      const chain = components({ Alias: { $ref: '#/components/responses/a~1b~0c' }, 'a/b~c': [] });
      const followed = followReference({ $ref: '#/components/responses/Alias' }, 'responses', chain, 'override');

      expect(followed).toMatchObject({
        outcome: 'unresolved',
        ref: '#/components/responses/a~1b~0c',
        found: { name: 'a/b~c', value: [] },
      });
    });

    it('hands nothing back for a name the section holds nothing under', () => {
      const followed = followReference(gone, 'responses', components({ Other: ok }), 'override');

      expect(followed).toEqual({ outcome: 'unresolved', ref: gone.$ref, value: gone });
      expect(followed).not.toHaveProperty('found');
    });
  });

  describe('resolveResponseRef', () => {
    it('returns undefined for a chain that ends on a component that is not an object, warning once naming the component and the site', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const components = { Gone: [] } as unknown as Record<string, Record<string, unknown>>;

      expect(resolveResponseRef(gone, components, '200 response of listPets')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(goneSkipped('200 response of listPets', '[]'));
      // Silently for a reader that only pre-computes names.
      expect(resolveResponseRef(gone, components, '200 response of listPets', 'override', 'silent')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
