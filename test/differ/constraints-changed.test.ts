/**
 * Issue #599: `oagen diff` compared a field's or parameter's type,
 * requiredness, access flags, deprecation and extensions, but never its
 * `constraints` — `typeRefsEqual` compares a primitive by `type` and
 * `format` only — so a `pattern` narrowed, a `maxLength` lowered or a
 * `minimum` raised on the same node was no change at all: `diffSpecs`
 * returned `[]` and the command exited 0, though a value a caller sends
 * today can be rejected by the new document.
 *
 * The limits are now compared on every node that carries them (the type's
 * at every level included) through `constraintsShift`, and reported as a
 * `field-constraints-changed`, `param-constraints-changed`,
 * `header-constraints-changed` or `variant-constraints-changed` entry, or
 * as `constraintsChanged` on a `model-modified` change: breaking when a
 * keyword was tightened on a request-facing site, additive when loosened or
 * on a site the SDK only reads.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffFields, diffModels } from '../../src/differ/models.js';
import { diffOperations } from '../../src/differ/operations.js';
import { diffWebhooks } from '../../src/differ/webhooks.js';
import { constraintsShift, keywordTightened, pairVariants } from '../../src/differ/constraints.js';
import {
  classifyConstraintsChange,
  classifyFieldChange,
  classifyParamChange,
  classifyResponseHeaderChange,
  constraintsDetails,
} from '../../src/differ/classify.js';
import type { Change, FieldChange, ParamChange } from '../../src/differ/types.js';
import { diffCommand } from '../../src/cli/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Constraints, Model, Operation, TypeRef, Webhook } from '../../src/ir/types.js';

const OPENAPI_VERSIONS = ['3.1.0', '3.0.3'] as const;

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Writes an OpenAPI document to a fresh temp dir and returns its path. */
async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-599-'));
  dirs.push(dir);
  const file = path.join(dir, `${name}.json`);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** Parses a document written to a temp file. */
async function parse(name: string, doc: unknown): Promise<ApiSpec> {
  return parseSpec(await writeSpec(name, doc));
}

/** The exit code `oagen diff` ends with for the two documents. */
async function exitCodeOf(oldDoc: unknown, newDoc: unknown): Promise<number> {
  const [oldPath, newPath] = [await writeSpec('old', oldDoc), await writeSpec('new', newDoc)];
  const error = (await diffCommand({ old: oldPath, new: newPath }).catch((e: unknown) => e)) as { exitCode: number };
  return error.exitCode;
}

const jsonBody = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const petRef = { $ref: '#/components/schemas/Pet' };

interface IssueLimits {
  pattern?: string;
  maxLength?: number;
  minimum?: number;
}

/**
 * The issue's document: `GET /pets/{petId}` (`getPet`) with a path parameter
 * `petId` of `{ type: string, pattern }` and a query parameter `limit` of
 * `{ type: integer, minimum }`, returning `Pet`, and `POST /pets`
 * (`createPet`) taking `Pet`, whose `name` is `{ type: string, maxLength }`
 * and `id` `{ type: string, pattern }`. A limit left out is not declared.
 */
function issueDoc(openapi: string, limits: IssueLimits, over: { pet?: Record<string, unknown> } = {}) {
  const pattern = limits.pattern !== undefined ? { pattern: limits.pattern } : {};
  const maxLength = limits.maxLength !== undefined ? { maxLength: limits.maxLength } : {};
  const minimum = limits.minimum !== undefined ? { minimum: limits.minimum } : {};
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string', ...pattern } },
            { name: 'limit', in: 'query', schema: { type: 'integer', ...minimum } },
          ],
          responses: { '200': { description: 'ok', ...jsonBody(petRef) } },
        },
      },
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: jsonBody(petRef),
          responses: { '201': { description: 'ok', ...jsonBody(petRef) } },
        },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', ...maxLength },
            id: { type: 'string', ...pattern },
          },
          ...over.pet,
        },
      },
    },
  };
}

const ISSUE_OLD: IssueLimits = { pattern: '^pet_[0-9A-Z]{26}$', maxLength: 100, minimum: 1 };
const ISSUE_NEW: IssueLimits = { pattern: '^pet_[0-9A-Z]{12}$', maxLength: 10, minimum: 5 };

/** The issue's `show`: the three sites' `constraints`. */
const show = ({ models, services }: ApiSpec) => {
  const getPet = services[0].operations.find((o) => o.name === 'getPet')!;
  return {
    'Pet.name': models.find((m) => m.name === 'Pet')!.fields.find((f) => f.name === 'name')!.constraints,
    petId: getPet.pathParams[0].constraints,
    limit: getPet.queryParams[0].constraints,
  };
};

const fieldChangesOf = (changes: Change[], name: string): FieldChange[] | undefined => {
  const change = changes.find((c) => c.kind === 'model-modified' && c.name === name);
  return change?.kind === 'model-modified' ? change.fieldChanges : undefined;
};

const paramChangesOf = (changes: Change[], operationName: string): ParamChange[] | undefined => {
  const change = changes.find((c) => c.kind === 'operation-modified' && c.operationName === operationName);
  return change?.kind === 'operation-modified' ? change.paramChanges : undefined;
};

/**
 * A document with `Pet` taken by `POST /pets` and returned by `GET
 * /pets/{petId}` (so `Pet` is both-facing), `Owner` returned by `GET
 * /owners/{ownerId}` alone (response-only), each built from the given
 * schemas, plus whatever `extra` adds to `paths` and `components`.
 */
function petsDoc(
  openapi: string,
  schemas: Record<string, unknown>,
  extra: { paths?: Record<string, unknown>; getPet?: Record<string, unknown>; webhooks?: Record<string, unknown> } = {},
) {
  return {
    openapi,
    info: { title: 'pets', version: '1' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok', ...jsonBody(petRef) } },
          ...extra.getPet,
        },
      },
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: jsonBody(petRef),
          responses: { '201': { description: 'ok', ...jsonBody(petRef) } },
        },
      },
      ...(schemas.Owner
        ? {
            '/owners/{ownerId}': {
              get: {
                operationId: 'getOwner',
                parameters: [{ name: 'ownerId', in: 'path', required: true, schema: { type: 'string' } }],
                responses: { '200': { description: 'ok', ...jsonBody({ $ref: '#/components/schemas/Owner' }) } },
              },
            },
          }
        : {}),
      ...extra.paths,
    },
    ...(extra.webhooks ? { webhooks: extra.webhooks } : {}),
    components: { schemas },
  };
}

const petWith = (properties: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: { id: { type: 'string' }, ...properties },
  ...over,
});

describe('#599', () => {
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("the issue's repro", () => {
    for (const openapi of OPENAPI_VERSIONS) {
      it(`reports the two fields and the two parameters, breaking, and exits 2 (OpenAPI ${openapi})`, async () => {
        const oldSpec = await parse('old', issueDoc(openapi, ISSUE_OLD));
        const newSpec = await parse('new', issueDoc(openapi, ISSUE_NEW));
        expect(show(oldSpec)).toEqual({
          'Pet.name': { maxLength: 100 },
          petId: { pattern: '^pet_[0-9A-Z]{26}$' },
          limit: { minimum: 1 },
        });
        expect(show(newSpec)).toEqual({
          'Pet.name': { maxLength: 10 },
          petId: { pattern: '^pet_[0-9A-Z]{12}$' },
          limit: { minimum: 5 },
        });

        const report = diffSpecs(oldSpec, newSpec);
        expect(report.changes.map((c) => c.kind)).toEqual(['model-modified', 'operation-modified']);
        expect(report.changes[0]).toEqual({
          kind: 'model-modified',
          name: 'Pet',
          fieldChanges: [
            {
              kind: 'field-constraints-changed',
              fieldName: 'name',
              classification: 'breaking',
              oldConstraints: { maxLength: 100 },
              newConstraints: { maxLength: 10 },
              details: 'maxLength 100 → 10',
            },
            {
              kind: 'field-constraints-changed',
              fieldName: 'id',
              classification: 'breaking',
              oldConstraints: { pattern: '^pet_[0-9A-Z]{26}$' },
              newConstraints: { pattern: '^pet_[0-9A-Z]{12}$' },
              details: "pattern '^pet_[0-9A-Z]{26}$' → '^pet_[0-9A-Z]{12}$'",
            },
          ],
          deprecatedChanged: false,
          classification: 'breaking',
        });
        expect(report.changes[1]).toMatchObject({
          kind: 'operation-modified',
          serviceName: 'Pets',
          operationName: 'getPet',
          paramChanges: [
            {
              kind: 'param-constraints-changed',
              paramName: 'petId',
              paramLocation: 'path',
              classification: 'breaking',
              oldConstraints: { pattern: '^pet_[0-9A-Z]{26}$' },
              newConstraints: { pattern: '^pet_[0-9A-Z]{12}$' },
              details: "pattern '^pet_[0-9A-Z]{26}$' → '^pet_[0-9A-Z]{12}$'",
            },
            {
              kind: 'param-constraints-changed',
              paramName: 'limit',
              paramLocation: 'query',
              classification: 'breaking',
              oldConstraints: { minimum: 1 },
              newConstraints: { minimum: 5 },
              details: 'minimum 1 → 5',
            },
          ],
          classification: 'breaking',
        });
        // Limits are not mirrored into `behaviorChanges`.
        expect(report.behaviorChanges).toEqual([]);
        expect(report.summary).toEqual({
          added: 0,
          removed: 0,
          modified: 2,
          breaking: 2,
          additive: 0,
          behaviorChanges: 0,
        });

        expect(await exitCodeOf(issueDoc(openapi, ISSUE_OLD), issueDoc(openapi, ISSUE_NEW))).toBe(2);
        expect(await exitCodeOf(issueDoc(openapi, ISSUE_OLD), issueDoc(openapi, ISSUE_OLD))).toBe(0);
      });

      it(`reports the reverse edit with the loosened bounds additive and the rewritten patterns breaking still (OpenAPI ${openapi})`, async () => {
        const oldSpec = await parse('old', issueDoc(openapi, ISSUE_NEW));
        const newSpec = await parse('new', issueDoc(openapi, ISSUE_OLD));
        const report = diffSpecs(oldSpec, newSpec);
        expect(fieldChangesOf(report.changes, 'Pet')).toEqual([
          {
            kind: 'field-constraints-changed',
            fieldName: 'name',
            classification: 'additive',
            oldConstraints: { maxLength: 10 },
            newConstraints: { maxLength: 100 },
            details: 'maxLength 10 → 100',
          },
          {
            kind: 'field-constraints-changed',
            fieldName: 'id',
            classification: 'breaking',
            oldConstraints: { pattern: '^pet_[0-9A-Z]{12}$' },
            newConstraints: { pattern: '^pet_[0-9A-Z]{26}$' },
            details: "pattern '^pet_[0-9A-Z]{12}$' → '^pet_[0-9A-Z]{26}$'",
          },
        ]);
        expect(paramChangesOf(report.changes, 'getPet')).toMatchObject([
          { kind: 'param-constraints-changed', paramName: 'petId', classification: 'breaking' },
          {
            kind: 'param-constraints-changed',
            paramName: 'limit',
            classification: 'additive',
            details: 'minimum 5 → 1',
          },
        ]);
        expect(report.summary.breaking).toBe(2);
        expect(await exitCodeOf(issueDoc(openapi, ISSUE_NEW), issueDoc(openapi, ISSUE_OLD))).toBe(2);
      });

      it(`still reports a change whose only content is a loosened limit, additive, exit 1 (OpenAPI ${openapi})`, async () => {
        const before = issueDoc(openapi, ISSUE_OLD);
        // `maxLength` raised, `minimum` lowered, the patterns kept.
        const loosened = issueDoc(openapi, { ...ISSUE_OLD, maxLength: 200, minimum: 0 });
        const report = diffSpecs(await parse('old', before), await parse('new', loosened));
        expect(report.changes).toMatchObject([
          {
            kind: 'model-modified',
            name: 'Pet',
            fieldChanges: [{ kind: 'field-constraints-changed', fieldName: 'name', classification: 'additive' }],
            classification: 'additive',
          },
          {
            kind: 'operation-modified',
            operationName: 'getPet',
            paramChanges: [
              {
                kind: 'param-constraints-changed',
                paramName: 'limit',
                classification: 'additive',
                details: 'minimum 1 → 0',
              },
            ],
            classification: 'additive',
          },
        ]);
        expect(report.summary).toMatchObject({ modified: 2, breaking: 0, additive: 2 });
        expect(await exitCodeOf(before, loosened)).toBe(1);
        expect(await exitCodeOf(loosened, before)).toBe(2);

        // A limit removed is loosened too; one added, tightened.
        const unlimited = issueDoc(openapi, {});
        expect(diffSpecs(await parse('old', before), await parse('new', unlimited)).changes).toMatchObject([
          {
            kind: 'model-modified',
            fieldChanges: [
              {
                kind: 'field-constraints-changed',
                fieldName: 'name',
                classification: 'additive',
                oldConstraints: { maxLength: 100 },
                details: 'maxLength 100 → <unset>',
              },
              {
                kind: 'field-constraints-changed',
                fieldName: 'id',
                classification: 'additive',
                details: "pattern '^pet_[0-9A-Z]{26}$' → <unset>",
              },
            ],
            classification: 'additive',
          },
          {
            kind: 'operation-modified',
            paramChanges: [
              { paramName: 'petId', classification: 'additive', details: "pattern '^pet_[0-9A-Z]{26}$' → <unset>" },
              { paramName: 'limit', classification: 'additive', details: 'minimum 1 → <unset>' },
            ],
            classification: 'additive',
          },
        ]);
        expect(
          fieldChangesOf(diffSpecs(await parse('old', unlimited), await parse('new', before)).changes, 'Pet'),
        ).toEqual([
          {
            kind: 'field-constraints-changed',
            fieldName: 'name',
            classification: 'breaking',
            newConstraints: { maxLength: 100 },
            details: 'maxLength <unset> → 100',
          },
          {
            kind: 'field-constraints-changed',
            fieldName: 'id',
            classification: 'breaking',
            newConstraints: { pattern: '^pet_[0-9A-Z]{26}$' },
            details: "pattern <unset> → '^pet_[0-9A-Z]{26}$'",
          },
        ]);
        expect(await exitCodeOf(before, unlimited)).toBe(1);
        expect(await exitCodeOf(unlimited, before)).toBe(2);
      });
    }
  });

  describe('keywordTightened — the per-keyword direction', () => {
    it('reads a keyword added as tightened and one removed as loosened, whichever it is', () => {
      const samples: Array<[keyof Constraints, unknown]> = [
        ['minimum', 1],
        ['maximum', 1],
        ['exclusiveMinimum', 1],
        ['exclusiveMaximum', 1],
        ['multipleOf', 2],
        ['minLength', 1],
        ['maxLength', 1],
        ['pattern', '^a'],
        ['minItems', 1],
        ['maxItems', 1],
        ['uniqueItems', true],
        ['minContains', 1],
        ['maxContains', 1],
        ['minProperties', 1],
        ['maxProperties', 1],
        ['dependentRequired', { a: ['b'] }],
      ];
      for (const [keyword, value] of samples) {
        expect(keywordTightened(keyword, undefined, value), `${keyword} added`).toBe(true);
        expect(keywordTightened(keyword, value, undefined), `${keyword} removed`).toBe(false);
      }
    });

    it('reads an upper bound lowered and a lower bound raised as tightened, the reverse moves as loosened', () => {
      for (const keyword of [
        'maximum',
        'exclusiveMaximum',
        'maxLength',
        'maxItems',
        'maxContains',
        'maxProperties',
      ] as const) {
        expect(keywordTightened(keyword, 10, 5), `${keyword} lowered`).toBe(true);
        expect(keywordTightened(keyword, 5, 10), `${keyword} raised`).toBe(false);
      }
      for (const keyword of [
        'minimum',
        'exclusiveMinimum',
        'minLength',
        'minItems',
        'minContains',
        'minProperties',
      ] as const) {
        expect(keywordTightened(keyword, 5, 10), `${keyword} raised`).toBe(true);
        expect(keywordTightened(keyword, 10, 5), `${keyword} lowered`).toBe(false);
      }
    });

    it('reads a changed pattern or multipleOf as tightened, and uniqueItems by what it becomes', () => {
      expect(keywordTightened('pattern', '^a', '^b')).toBe(true);
      expect(keywordTightened('multipleOf', 2, 4)).toBe(true);
      expect(keywordTightened('multipleOf', 4, 2)).toBe(true);
      expect(keywordTightened('uniqueItems', false, true)).toBe(true);
      expect(keywordTightened('uniqueItems', true, false)).toBe(false);
    });

    it('reads dependentRequired as tightened when a property requires a name it did not, or is newly listed', () => {
      expect(keywordTightened('dependentRequired', { a: ['b'] }, { a: ['b', 'c'] })).toBe(true);
      expect(keywordTightened('dependentRequired', { a: ['b', 'c'] }, { a: ['b'] })).toBe(false);
      expect(keywordTightened('dependentRequired', { a: ['b'] }, { a: ['b'], d: ['e'] })).toBe(true);
      expect(keywordTightened('dependentRequired', { a: ['b'], d: ['e'] }, { a: ['b'] })).toBe(false);
      // One property narrowed and another widened: something was tightened.
      expect(keywordTightened('dependentRequired', { a: ['b', 'c'] }, { a: ['b'], d: ['e'] })).toBe(true);
    });
  });

  describe('constraintsShift — what one site reports', () => {
    const string = (constraints?: Constraints): TypeRef => ({
      kind: 'primitive',
      type: 'string',
      ...(constraints ? { constraints } : {}),
    });
    const integer = (constraints?: Constraints): TypeRef => ({
      kind: 'primitive',
      type: 'integer',
      ...(constraints ? { constraints } : {}),
    });
    const array = (items: TypeRef, constraints?: Constraints): TypeRef => ({
      kind: 'array',
      items,
      ...(constraints ? { constraints } : {}),
    });
    const map = (valueType: TypeRef, constraints?: Constraints): TypeRef => ({
      kind: 'map',
      valueType,
      ...(constraints ? { constraints } : {}),
    });
    const nullable = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
    const union = (variants: TypeRef[], constraints?: Constraints): TypeRef => ({
      kind: 'union',
      variants,
      ...(constraints ? { constraints } : {}),
    });
    const field = (type: TypeRef, constraints?: Constraints) => ({ type, ...(constraints ? { constraints } : {}) });

    it('returns nothing for two sites with the same limits, keyword order and dependentRequired order aside', () => {
      expect(
        constraintsShift(
          field(string(), { minLength: 1, maxLength: 5 }),
          field(string(), { maxLength: 5, minLength: 1 }),
        ),
      ).toBeUndefined();
      expect(constraintsShift(field(string()), field(string()))).toBeUndefined();
      expect(
        constraintsShift(
          { constraints: { dependentRequired: { a: ['b', 'c'], d: ['e'] } } },
          { constraints: { dependentRequired: { d: ['e'], a: ['c', 'b'] } } },
        ),
      ).toBeUndefined();
    });

    it('names every keyword that moved in one fixed order, old → new, whatever order the sites list them in', () => {
      const shift = constraintsShift(
        field(string(), { maxLength: 5, minLength: 1, pattern: '^a' }),
        field(string(), { pattern: '^b', minLength: 2, maxLength: 4, multipleOf: 2 }),
      );
      expect(shift).toEqual({
        oldConstraints: { maxLength: 5, minLength: 1, pattern: '^a' },
        newConstraints: { pattern: '^b', minLength: 2, maxLength: 4, multipleOf: 2 },
        details: "multipleOf <unset> → 2; minLength 1 → 2; maxLength 5 → 4; pattern '^a' → '^b'",
        tightened: true,
      });
      expect(constraintsShift(field(string(), { maxLength: 5 }), field(string(), { maxLength: 6 }))).toEqual({
        oldConstraints: { maxLength: 5 },
        newConstraints: { maxLength: 6 },
        details: 'maxLength 5 → 6',
        tightened: false,
      });
    });

    it('prints uniqueItems and dependentRequired as the document means them', () => {
      expect(constraintsShift({ constraints: { uniqueItems: true } }, {})).toEqual({
        oldConstraints: { uniqueItems: true },
        details: 'uniqueItems true → <unset>',
        tightened: false,
      });
      expect(
        constraintsShift(
          { constraints: { dependentRequired: { a: ['b'] } } },
          { constraints: { dependentRequired: { d: ['e'], a: ['c', 'b'] } } },
        ),
      ).toEqual({
        oldConstraints: { dependentRequired: { a: ['b'] } },
        newConstraints: { dependentRequired: { d: ['e'], a: ['c', 'b'] } },
        details: 'dependentRequired {"a":["b"]} → {"a":["b","c"],"d":["e"]}',
        tightened: true,
      });
    });

    it("reads the site's own limits, else its type's, so a header or a variant is read from its type", () => {
      // A field whose own copy differs from its type's (a hand-built IR) is read from its own.
      expect(
        constraintsShift(field(string({ maxLength: 9 }), { maxLength: 5 }), field(string(), { maxLength: 3 })),
      ).toEqual({
        oldConstraints: { maxLength: 5 },
        newConstraints: { maxLength: 3 },
        details: 'maxLength 5 → 3',
        tightened: true,
      });
      // A header carries none of its own: its type's are the site's.
      expect(constraintsShift({ type: string({ pattern: '^req_' }) }, { type: string({ pattern: '^rq_' }) })).toEqual({
        oldConstraints: { pattern: '^req_' },
        newConstraints: { pattern: '^rq_' },
        details: "pattern '^req_' → '^rq_'",
        tightened: true,
      });
      // A nullable wrapper carries none: its `inner` does.
      expect(
        constraintsShift({ type: nullable(string({ maxLength: 5 })) }, { type: string({ maxLength: 3 }) }),
      ).toEqual({
        oldConstraints: { maxLength: 5 },
        newConstraints: { maxLength: 3 },
        details: 'maxLength 5 → 3',
        tightened: true,
      });
    });

    it("names a nested level by the path to it, and carries the site's own sides for it", () => {
      expect(
        constraintsShift(
          field(array(string({ pattern: '^tag_' }), { maxItems: 10 }), { maxItems: 10 }),
          field(array(string({ pattern: '^tg_' }), { maxItems: 5 }), { maxItems: 5 }),
        ),
      ).toEqual({
        oldConstraints: { maxItems: 10 },
        newConstraints: { maxItems: 5 },
        details: "maxItems 10 → 5; items.pattern '^tag_' → '^tg_'",
        tightened: true,
      });
      // A nested level alone: the sides are the site's own, here none.
      expect(constraintsShift(field(array(string({ pattern: '^tag_' }))), field(array(string())))).toEqual({
        details: "items.pattern '^tag_' → <unset>",
        tightened: false,
      });
      expect(constraintsShift(field(map(string({ maxLength: 5 }))), field(map(string({ maxLength: 3 }))))).toEqual({
        details: 'valueType.maxLength 5 → 3',
        tightened: true,
      });
      expect(
        constraintsShift(
          field(array(array(string({ maxLength: 10 }), { uniqueItems: true })), { minItems: 1 }),
          field(array(array(string({ maxLength: 5 }))), { minItems: 1 }),
        ),
      ).toEqual({
        oldConstraints: { minItems: 1 },
        newConstraints: { minItems: 1 },
        details: 'items.uniqueItems true → <unset>; items.items.maxLength 10 → 5',
        tightened: true,
      });
      // Through a nullable wrapper on either side.
      expect(
        constraintsShift(field(array(nullable(string({ pattern: '^a' })))), field(array(string({ pattern: '^b' })))),
      ).toEqual({
        details: "items.pattern '^a' → '^b'",
        tightened: true,
      });
      // A union's own keywords, then each variant's.
      expect(
        constraintsShift(
          field(union([string({ pattern: '^pet_' }), integer({ minimum: 0 })], { maxLength: 20 }), { maxLength: 20 }),
          field(union([string({ pattern: '^pt_' }), integer({ minimum: 1 })], { maxLength: 10 }), { maxLength: 10 }),
        ),
      ).toEqual({
        oldConstraints: { maxLength: 20 },
        newConstraints: { maxLength: 10 },
        details: "maxLength 20 → 10; variants[0].pattern '^pet_' → '^pt_'; variants[1].minimum 0 → 1",
        tightened: true,
      });
    });

    it('leaves two levels of different kinds to the type change, comparing only what both carry', () => {
      // An array become a string: the sites' own keywords still compare.
      expect(
        constraintsShift(field(array(string({ pattern: '^a' })), { minItems: 1 }), field(string(), { maxLength: 5 })),
      ).toEqual({
        oldConstraints: { minItems: 1 },
        newConstraints: { maxLength: 5 },
        details: 'maxLength <unset> → 5; minItems 1 → <unset>',
        tightened: true,
      });
      // Items become a model: the items' limits have no counterpart.
      expect(
        constraintsShift(field(array(string({ pattern: '^a' }))), field(array({ kind: 'model', name: 'Tag' }))),
      ).toEqual({
        details: "items.pattern '^a' → <unset>",
        tightened: false,
      });
    });

    it('pairs a union’s variants by type, the same limits preferred, so a reorder reports nothing and a kept variant reports under its new index', () => {
      const a = string({ pattern: '^a' });
      const b = string({ pattern: '^b' });
      const c = string({ pattern: '^c' });
      expect(pairVariants([a, b], [b, a])).toEqual(
        new Map([
          [0, b],
          [1, a],
        ]),
      );
      expect(constraintsShift(field(union([a, b])), field(union([b, a])))).toBeUndefined();
      expect(pairVariants([a, b], [a, c])).toEqual(
        new Map([
          [0, a],
          [1, b],
        ]),
      );
      expect(constraintsShift(field(union([a, b])), field(union([a, c])))).toEqual({
        details: "variants[1].pattern '^b' → '^c'",
        tightened: true,
      });
      // A union that gained a variant still reports its kept variants' limits, under the new index.
      expect(pairVariants([a, integer()], [integer(), { kind: 'primitive', type: 'boolean' }, c])).toEqual(
        new Map([
          [0, integer()],
          [2, a],
        ]),
      );
      expect(
        constraintsShift(
          field(union([a, integer()])),
          field(union([integer(), { kind: 'primitive', type: 'boolean' }, c])),
        ),
      ).toEqual({ details: "variants[2].pattern '^a' → '^c'", tightened: true });
      // A variant swapped for another type pairs with nothing.
      expect(pairVariants([a], [integer()])).toEqual(new Map());
    });
  });

  describe('classification by site', () => {
    it('classifies a field’s limits by direction: tightened breaking unless the model is response-only, loosened additive', () => {
      for (const direction of ['request', 'both', 'unknown'] as const) {
        expect(classifyConstraintsChange(true, direction)).toBe('breaking');
        expect(classifyConstraintsChange(false, direction)).toBe('additive');
        expect(classifyFieldChange('field-constraints-changed', 'name', true, direction)).toEqual({
          kind: 'field-constraints-changed',
          fieldName: 'name',
          classification: 'breaking',
        });
      }
      expect(classifyConstraintsChange(true, 'response')).toBe('additive');
      expect(classifyFieldChange('field-constraints-changed', 'name', true, 'response').classification).toBe(
        'additive',
      );
      expect(classifyFieldChange('field-constraints-changed', 'name', false).classification).toBe('additive');
      expect(constraintsDetails({ details: 'maxLength 100 → 10', tightened: true }, 'response')).toBe(
        'maxLength 100 → 10; tightened on a response-only model',
      );
      expect(constraintsDetails({ details: 'maxLength 100 → 10', tightened: true }, 'both')).toBe('maxLength 100 → 10');
      expect(constraintsDetails({ details: 'maxLength 10 → 100', tightened: false }, 'response')).toBe(
        'maxLength 10 → 100',
      );
    });

    it('classifies an operation parameter from the caller’s side and a response header from the reader’s', () => {
      expect(classifyParamChange('param-constraints-changed', 'limit', true)).toEqual({
        kind: 'param-constraints-changed',
        paramName: 'limit',
        classification: 'breaking',
      });
      expect(classifyParamChange('param-constraints-changed', 'limit', false).classification).toBe('additive');
      expect(classifyResponseHeaderChange('header-constraints-changed', 'X-Request-Id')).toEqual({
        kind: 'header-constraints-changed',
        headerName: 'X-Request-Id',
        classification: 'additive',
      });
    });

    it('softens a tightened limit on a response-only model, naming it in details, through diffModels', () => {
      const owner = (maxLength: number): Model => ({
        name: 'Owner',
        fields: [
          {
            name: 'name',
            type: { kind: 'primitive', type: 'string', constraints: { maxLength } },
            required: true,
            constraints: { maxLength },
          },
        ],
      });
      const directions = new Map([['Owner', 'response' as const]]);
      expect(diffModels([owner(100)], [owner(10)], directions)).toEqual([
        {
          kind: 'model-modified',
          name: 'Owner',
          fieldChanges: [
            {
              kind: 'field-constraints-changed',
              fieldName: 'name',
              classification: 'additive',
              oldConstraints: { maxLength: 100 },
              newConstraints: { maxLength: 10 },
              details: 'maxLength 100 → 10; tightened on a response-only model',
            },
          ],
          deprecatedChanged: false,
          classification: 'additive',
        },
      ]);
      expect(diffModels([owner(100)], [owner(10)])).toMatchObject([
        { classification: 'breaking', fieldChanges: [{ classification: 'breaking', details: 'maxLength 100 → 10' }] },
      ]);
      expect(diffFields(owner(100), owner(10), 'request')).toMatchObject([{ classification: 'breaking' }]);
      expect(diffFields(owner(10), owner(100), 'request')).toMatchObject([
        { classification: 'additive', details: 'maxLength 10 → 100' },
      ]);
    });
  });

  describe('every site, parsed', () => {
    for (const openapi of OPENAPI_VERSIONS) {
      it(`reports a limit on an array's items, a map's values and an inline union's variant by its level (OpenAPI ${openapi})`, async () => {
        const pet = (tagPattern: string, labelMax: number, refPattern: string, maxItems: number) =>
          petWith({
            tags: { type: 'array', maxItems, items: { type: 'string', pattern: tagPattern } },
            labels: { type: 'object', additionalProperties: { type: 'string', maxLength: labelMax } },
            ref: { anyOf: [{ type: 'string', pattern: refPattern }, { type: 'string' }] },
          });
        const oldSpec = await parse('old', petsDoc(openapi, { Pet: pet('^tag_', 5, '^pet_', 10) }));
        const newSpec = await parse('new', petsDoc(openapi, { Pet: pet('^tg_', 3, '^pt_', 5) }));
        expect(fieldChangesOf(diffSpecs(oldSpec, newSpec).changes, 'Pet')).toEqual([
          {
            kind: 'field-constraints-changed',
            fieldName: 'tags',
            classification: 'breaking',
            oldConstraints: { maxItems: 10 },
            newConstraints: { maxItems: 5 },
            details: "maxItems 10 → 5; items.pattern '^tag_' → '^tg_'",
          },
          {
            kind: 'field-constraints-changed',
            fieldName: 'labels',
            classification: 'breaking',
            details: 'valueType.maxLength 5 → 3',
          },
          {
            kind: 'field-constraints-changed',
            fieldName: 'ref',
            classification: 'breaking',
            details: "variants[0].pattern '^pet_' → '^pt_'",
          },
        ]);
        // The reverse: `maxItems` and the values' `maxLength` raised are
        // loosened, while a rewritten pattern is tightened either way, so
        // `tags` (its items' pattern) and `ref` stay breaking.
        expect(fieldChangesOf(diffSpecs(newSpec, oldSpec).changes, 'Pet')).toMatchObject([
          { fieldName: 'tags', classification: 'breaking', details: "maxItems 5 → 10; items.pattern '^tg_' → '^tag_'" },
          { fieldName: 'labels', classification: 'additive', details: 'valueType.maxLength 3 → 5' },
          { fieldName: 'ref', classification: 'breaking', details: "variants[0].pattern '^pt_' → '^pet_'" },
        ]);
      });

      it(`reports a parameter in every location from the caller's side, and the same edit on a webhook's or a callback's parameter additive (OpenAPI ${openapi})`, async () => {
        const params = (limits: { pattern: string; minimum: number; maxLength: number; sig: string }) => [
          { name: 'petId', in: 'path', required: true, schema: { type: 'string', pattern: limits.pattern } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: limits.minimum } },
          { name: 'X-Request-Id', in: 'header', schema: { type: 'string', maxLength: limits.maxLength } },
          { name: 'session', in: 'cookie', schema: { type: 'string', pattern: limits.sig } },
        ];
        const received = (sig: string) => [
          { name: 'X-Signature', in: 'header', schema: { type: 'string', pattern: sig } },
        ];
        const doc = (limits: { pattern: string; minimum: number; maxLength: number; sig: string }) =>
          petsDoc(
            openapi,
            { Pet: petWith({}) },
            {
              getPet: {
                parameters: params(limits),
                callbacks: {
                  adopted: {
                    '{$request.query.callbackUrl}': {
                      post: {
                        parameters: received(limits.sig),
                        requestBody: jsonBody({ type: 'object', properties: { petId: { type: 'string' } } }),
                        responses: { '200': { description: 'ok' } },
                      },
                    },
                  },
                },
              },
              webhooks: {
                petAdopted: {
                  post: {
                    parameters: received(limits.sig),
                    requestBody: jsonBody({ type: 'object', properties: { petId: { type: 'string' } } }),
                    responses: { '200': { description: 'ok' } },
                  },
                },
              },
            },
          );
        const oldSpec = await parse('old', doc({ pattern: '^pet_', minimum: 1, maxLength: 36, sig: '^sig_' }));
        const newSpec = await parse('new', doc({ pattern: '^pt_', minimum: 5, maxLength: 32, sig: '^sg_' }));
        const report = diffSpecs(oldSpec, newSpec);
        expect(paramChangesOf(report.changes, 'getPet')).toEqual([
          {
            kind: 'param-constraints-changed',
            paramName: 'petId',
            classification: 'breaking',
            paramLocation: 'path',
            oldConstraints: { pattern: '^pet_' },
            newConstraints: { pattern: '^pt_' },
            details: "pattern '^pet_' → '^pt_'",
          },
          {
            kind: 'param-constraints-changed',
            paramName: 'limit',
            classification: 'breaking',
            paramLocation: 'query',
            oldConstraints: { minimum: 1 },
            newConstraints: { minimum: 5 },
            details: 'minimum 1 → 5',
          },
          {
            kind: 'param-constraints-changed',
            paramName: 'X-Request-Id',
            classification: 'breaking',
            paramLocation: 'header',
            oldConstraints: { maxLength: 36 },
            newConstraints: { maxLength: 32 },
            details: 'maxLength 36 → 32',
          },
          {
            kind: 'param-constraints-changed',
            paramName: 'session',
            classification: 'breaking',
            paramLocation: 'cookie',
            oldConstraints: { pattern: '^sig_' },
            newConstraints: { pattern: '^sg_' },
            details: "pattern '^sig_' → '^sg_'",
          },
        ]);
        const receivedEntry = {
          kind: 'param-constraints-changed',
          paramName: 'X-Signature',
          classification: 'additive',
          paramLocation: 'header',
          oldConstraints: { pattern: '^sig_' },
          newConstraints: { pattern: '^sg_' },
          details: "pattern '^sig_' → '^sg_'",
        };
        expect(report.changes.filter((c) => c.kind === 'callback-modified')).toMatchObject([
          {
            kind: 'callback-modified',
            name: 'adopted',
            serviceName: 'Pets',
            operationName: 'getPet',
            paramChanges: [receivedEntry],
            classification: 'additive',
          },
        ]);
        expect(report.changes.filter((c) => c.kind === 'webhook-modified')).toMatchObject([
          { kind: 'webhook-modified', name: 'petAdopted', paramChanges: [receivedEntry], classification: 'additive' },
        ]);
        // The loosening direction: additive everywhere but the rewritten patterns on the operation.
        expect(paramChangesOf(diffSpecs(newSpec, oldSpec).changes, 'getPet')?.map((c) => c.classification)).toEqual([
          'breaking',
          'additive',
          'additive',
          'breaking',
        ]);
        expect(report.behaviorChanges).toEqual([]);
      });

      it(`reports a response header's limits additive either way, under its status code (OpenAPI ${openapi})`, async () => {
        const doc = (pattern: string, maxItems: number) =>
          petsDoc(
            openapi,
            { Pet: petWith({}) },
            {
              getPet: {
                responses: {
                  '200': {
                    description: 'ok',
                    headers: {
                      'X-Request-Id': { schema: { type: 'string', pattern } },
                      'X-Tags': { schema: { type: 'array', maxItems, items: { type: 'string', pattern } } },
                    },
                    ...jsonBody(petRef),
                  },
                },
              },
            },
          );
        const oldSpec = await parse('old', doc('^req_', 10));
        const newSpec = await parse('new', doc('^rq_', 5));
        const headerChanges = (changes: Change[]) => {
          const change = changes.find((c) => c.kind === 'operation-modified');
          return change?.kind === 'operation-modified' ? change.responseHeaderChanges : undefined;
        };
        expect(headerChanges(diffSpecs(oldSpec, newSpec).changes)).toEqual([
          {
            kind: 'header-constraints-changed',
            headerName: 'X-Request-Id',
            statusCode: 200,
            classification: 'additive',
            oldConstraints: { pattern: '^req_' },
            newConstraints: { pattern: '^rq_' },
            details: "pattern '^req_' → '^rq_'",
          },
          {
            kind: 'header-constraints-changed',
            headerName: 'X-Tags',
            statusCode: 200,
            classification: 'additive',
            oldConstraints: { maxItems: 10 },
            newConstraints: { maxItems: 5 },
            details: "maxItems 10 → 5; items.pattern '^req_' → '^rq_'",
          },
        ]);
        expect(headerChanges(diffSpecs(newSpec, oldSpec).changes)).toMatchObject([
          { headerName: 'X-Request-Id', classification: 'additive' },
          {
            headerName: 'X-Tags',
            classification: 'additive',
            details: "maxItems 5 → 10; items.pattern '^rq_' → '^req_'",
          },
        ]);
        expect(await exitCodeOf(doc('^req_', 10), doc('^rq_', 5))).toBe(1);
      });

      it(`reports a list envelope companion's limits additive either way, as on a response-only model (OpenAPI ${openapi})`, async () => {
        const doc = (minimum: number) => ({
          openapi,
          info: { title: 'Pets', version: '1' },
          paths: {
            '/pets': {
              get: {
                operationId: 'listPets',
                parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
                responses: {
                  '200': {
                    description: 'OK',
                    ...jsonBody({
                      type: 'object',
                      properties: {
                        data: { type: 'array', items: { type: 'string' } },
                        has_more: { type: 'boolean' },
                        total_count: { type: 'integer', minimum },
                      },
                    }),
                  },
                },
              },
            },
          },
        });
        const oldSpec = await parse('old', doc(0));
        const newSpec = await parse('new', doc(1));
        expect(oldSpec.services[0].operations[0].pagination?.envelopeFields?.map((f) => f.name)).toEqual([
          'has_more',
          'total_count',
        ]);
        const envelope = (changes: Change[]) => {
          const change = changes.find((c) => c.kind === 'operation-modified');
          return change?.kind === 'operation-modified'
            ? { entries: change.envelopeFieldChanges, classification: change.classification }
            : undefined;
        };
        expect(envelope(diffSpecs(oldSpec, newSpec).changes)).toEqual({
          entries: [
            {
              kind: 'field-constraints-changed',
              fieldName: 'total_count',
              classification: 'additive',
              oldConstraints: { minimum: 0 },
              newConstraints: { minimum: 1 },
              details: 'minimum 0 → 1; tightened on a response-only model',
            },
          ],
          classification: 'additive',
        });
        expect(envelope(diffSpecs(newSpec, oldSpec).changes)).toMatchObject({
          entries: [{ classification: 'additive', details: 'minimum 1 → 0' }],
          classification: 'additive',
        });
        expect(await exitCodeOf(doc(0), doc(1))).toBe(1);
      });

      it(`softens a tightened limit on a response-only model and keeps it breaking on a both-facing one (OpenAPI ${openapi})`, async () => {
        const doc = (maxLength: number) =>
          petsDoc(openapi, {
            Pet: petWith({ name: { type: 'string', maxLength } }),
            Owner: { type: 'object', properties: { name: { type: 'string', maxLength } } },
          });
        const report = diffSpecs(await parse('old', doc(100)), await parse('new', doc(10)));
        expect(fieldChangesOf(report.changes, 'Pet')).toEqual([
          {
            kind: 'field-constraints-changed',
            fieldName: 'name',
            classification: 'breaking',
            oldConstraints: { maxLength: 100 },
            newConstraints: { maxLength: 10 },
            details: 'maxLength 100 → 10',
          },
        ]);
        expect(fieldChangesOf(report.changes, 'Owner')).toEqual([
          {
            kind: 'field-constraints-changed',
            fieldName: 'name',
            classification: 'additive',
            oldConstraints: { maxLength: 100 },
            newConstraints: { maxLength: 10 },
            details: 'maxLength 100 → 10; tightened on a response-only model',
          },
        ]);
        const ownerOnly = (maxLength: number) =>
          petsDoc(openapi, {
            Pet: petWith({}),
            Owner: { type: 'object', properties: { name: { type: 'string', maxLength } } },
          });
        expect(await exitCodeOf(ownerOnly(100), ownerOnly(10))).toBe(1);
        expect(await exitCodeOf(ownerOnly(10), ownerOnly(100))).toBe(1);
      });

      it(`reports the model's own keywords as constraintsChanged on the model-modified change (OpenAPI ${openapi})`, async () => {
        const doc = (minProperties: number, dependentRequired?: Record<string, string[]>) =>
          petsDoc(openapi, {
            Pet: petWith(
              { name: { type: 'string' }, owner: { type: 'string' } },
              {
                minProperties,
                ...(dependentRequired ? { dependentRequired } : {}),
              },
            ),
          });
        const report = diffSpecs(
          await parse('old', doc(1, { name: ['id'] })),
          await parse('new', doc(2, { name: ['owner', 'id'] })),
        );
        expect(report.changes).toEqual([
          {
            kind: 'model-modified',
            name: 'Pet',
            fieldChanges: [],
            deprecatedChanged: false,
            constraintsChanged: true,
            oldConstraints: { minProperties: 1, dependentRequired: { name: ['id'] } },
            newConstraints: { minProperties: 2, dependentRequired: { name: ['owner', 'id'] } },
            details: 'minProperties 1 → 2; dependentRequired {"name":["id"]} → {"name":["id","owner"]}',
            classification: 'breaking',
          },
        ]);
        expect(report.summary).toMatchObject({ modified: 1, breaking: 1 });
        // Narrowed: additive. Reordered: no change.
        expect(
          diffSpecs(await parse('old', doc(2, { name: ['owner', 'id'] })), await parse('new', doc(1, { name: ['id'] })))
            .changes,
        ).toMatchObject([{ kind: 'model-modified', constraintsChanged: true, classification: 'additive' }]);
        expect(
          diffSpecs(
            await parse('old', doc(1, { name: ['owner', 'id'] })),
            await parse('new', doc(1, { name: ['id', 'owner'] })),
          ).changes,
        ).toEqual([]);
        expect(await exitCodeOf(doc(1), doc(2))).toBe(2);
        expect(await exitCodeOf(doc(2), doc(1))).toBe(1);
      });

      it(`reports a named union's kept variant whose limits moved as variant-constraints-changed (OpenAPI ${openapi})`, async () => {
        const doc = (pattern: string, minimum: number) =>
          petsDoc(openapi, {
            Pet: petWith({ shape: { $ref: '#/components/schemas/Shape' } }),
            Shape: {
              oneOf: [
                { type: 'string', pattern },
                { type: 'integer', minimum },
              ],
            },
          });
        const oldSpec = await parse('old', doc('^sh_', 0));
        const newSpec = await parse('new', doc('^s_', 1));
        expect(oldSpec.models.find((m) => m.name === 'Shape')?.variants).toEqual([
          { kind: 'primitive', type: 'string', constraints: { pattern: '^sh_' } },
          { kind: 'primitive', type: 'integer', constraints: { minimum: 0 } },
        ]);
        expect(diffSpecs(oldSpec, newSpec).changes).toEqual([
          {
            kind: 'model-modified',
            name: 'Shape',
            fieldChanges: [],
            variantChanges: [
              {
                kind: 'variant-constraints-changed',
                variant: 'string',
                classification: 'breaking',
                oldConstraints: { pattern: '^sh_' },
                newConstraints: { pattern: '^s_' },
                details: "pattern '^sh_' → '^s_'",
              },
              {
                kind: 'variant-constraints-changed',
                variant: 'integer',
                classification: 'breaking',
                oldConstraints: { minimum: 0 },
                newConstraints: { minimum: 1 },
                details: 'minimum 0 → 1',
              },
            ],
            deprecatedChanged: false,
            classification: 'breaking',
          },
        ]);
        expect(diffSpecs(newSpec, oldSpec).changes).toMatchObject([
          {
            variantChanges: [
              { variant: 'string', classification: 'breaking' },
              { variant: 'integer', classification: 'additive', details: 'minimum 1 → 0' },
            ],
          },
        ]);
        // Reordered variants are the same union.
        const reordered = petsDoc(openapi, {
          Pet: petWith({ shape: { $ref: '#/components/schemas/Shape' } }),
          Shape: {
            oneOf: [
              { type: 'integer', minimum: 0 },
              { type: 'string', pattern: '^sh_' },
            ],
          },
        });
        expect(diffSpecs(oldSpec, await parse('reordered', reordered)).changes).toEqual([]);
      });

      it(`reports a limit beside a type or format change, not instead of it (OpenAPI ${openapi})`, async () => {
        const doc = (schemas: Record<string, unknown>) => petsDoc(openapi, { Pet: petWith(schemas) });
        const retyped = diffSpecs(
          await parse('old', doc({ name: { type: 'string', maxLength: 100 } })),
          await parse('new', doc({ name: { type: 'integer', maximum: 10 } })),
        );
        expect(fieldChangesOf(retyped.changes, 'Pet')).toEqual([
          { kind: 'field-type-changed', fieldName: 'name', classification: 'breaking', details: 'type changed' },
          {
            kind: 'field-constraints-changed',
            fieldName: 'name',
            classification: 'breaking',
            oldConstraints: { maxLength: 100 },
            newConstraints: { maximum: 10 },
            details: 'maximum <unset> → 10; maxLength 100 → <unset>',
          },
        ]);
        const reformatted = diffSpecs(
          await parse('old', doc({ name: { type: 'string', pattern: '^a' } })),
          await parse('new', doc({ name: { type: 'string', format: 'email' } })),
        );
        expect(fieldChangesOf(reformatted.changes, 'Pet')).toEqual([
          {
            kind: 'field-format-changed',
            fieldName: 'name',
            classification: 'additive',
            details: 'format <unset> → email',
          },
          {
            kind: 'field-constraints-changed',
            fieldName: 'name',
            classification: 'additive',
            oldConstraints: { pattern: '^a' },
            details: "pattern '^a' → <unset>",
          },
        ]);
      });

      it(`reports a limit read through a \`$ref\` to a primitive component on every site that references it (OpenAPI ${openapi})`, async () => {
        const doc = (pattern: string) =>
          petsDoc(
            openapi,
            { Pet: petWith({ id: { $ref: '#/components/schemas/PetId' } }), PetId: { type: 'string', pattern } },
            {
              getPet: {
                parameters: [
                  { name: 'petId', in: 'path', required: true, schema: { $ref: '#/components/schemas/PetId' } },
                ],
              },
            },
          );
        const report = diffSpecs(await parse('old', doc('^pet_')), await parse('new', doc('^pt_')));
        expect(report.changes.map((c) => c.kind)).toEqual(['model-modified', 'operation-modified']);
        expect(fieldChangesOf(report.changes, 'Pet')).toEqual([
          {
            kind: 'field-constraints-changed',
            fieldName: 'id',
            classification: 'breaking',
            oldConstraints: { pattern: '^pet_' },
            newConstraints: { pattern: '^pt_' },
            details: "pattern '^pet_' → '^pt_'",
          },
        ]);
        expect(paramChangesOf(report.changes, 'getPet')).toMatchObject([
          { kind: 'param-constraints-changed', paramName: 'petId', paramLocation: 'path', classification: 'breaking' },
        ]);
      });

      it(`prints the keywords in one order whatever order the document wrote them, and uniqueItems as added or removed (OpenAPI ${openapi})`, async () => {
        const doc = (tags: Record<string, unknown>) =>
          petsDoc(openapi, { Pet: petWith({ tags: { type: 'array', items: { type: 'string' }, ...tags } }) });
        const entry = async (before: Record<string, unknown>, after: Record<string, unknown>) =>
          fieldChangesOf(diffSpecs(await parse('old', doc(before)), await parse('new', doc(after))).changes, 'Pet');
        expect(await entry({ minItems: 1, maxItems: 10 }, { maxItems: 5, minItems: 2 })).toMatchObject([
          { details: 'minItems 1 → 2; maxItems 10 → 5', classification: 'breaking' },
        ]);
        expect(await entry({ maxItems: 10, minItems: 1 }, { minItems: 2, maxItems: 5 })).toMatchObject([
          { details: 'minItems 1 → 2; maxItems 10 → 5', classification: 'breaking' },
        ]);
        // The same keywords in another order: no change.
        expect(await entry({ minItems: 1, maxItems: 10 }, { maxItems: 10, minItems: 1 })).toBeUndefined();
        expect(await entry({}, { uniqueItems: true })).toMatchObject([
          { details: 'uniqueItems <unset> → true', classification: 'breaking', newConstraints: { uniqueItems: true } },
        ]);
        expect(await entry({ uniqueItems: true }, {})).toMatchObject([
          { details: 'uniqueItems true → <unset>', classification: 'additive' },
        ]);
        // `uniqueItems: false` restates the default, which the parser drops.
        expect(await entry({ uniqueItems: true }, { uniqueItems: false })).toMatchObject([
          { details: 'uniqueItems true → <unset>', classification: 'additive' },
        ]);
      });
    }

    it('reads the 3.0 boolean exclusiveMinimum as the 3.1 bound, so turning it on is a tightened bound', async () => {
      const doc30 = (limit: Record<string, unknown>) =>
        petsDoc(
          '3.0.3',
          { Pet: petWith({}) },
          { getPet: { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', ...limit } }] } },
        );
      const doc31 = (limit: Record<string, unknown>) =>
        petsDoc(
          '3.1.0',
          { Pet: petWith({}) },
          { getPet: { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', ...limit } }] } },
        );
      const expected = [
        {
          kind: 'param-constraints-changed',
          paramName: 'limit',
          classification: 'breaking',
          paramLocation: 'query',
          oldConstraints: { minimum: 0 },
          newConstraints: { exclusiveMinimum: 0 },
          details: 'minimum 0 → <unset>; exclusiveMinimum <unset> → 0',
        },
      ];
      expect(
        paramChangesOf(
          diffSpecs(
            await parse('old', doc30({ minimum: 0 })),
            await parse('new', doc30({ minimum: 0, exclusiveMinimum: true })),
          ).changes,
          'getPet',
        ),
      ).toEqual(expected);
      expect(
        paramChangesOf(
          diffSpecs(await parse('old', doc31({ minimum: 0 })), await parse('new', doc31({ exclusiveMinimum: 0 })))
            .changes,
          'getPet',
        ),
      ).toEqual(expected);
      // `exclusiveMinimum: false` restates the default.
      expect(
        diffSpecs(
          await parse('old', doc30({ minimum: 0 })),
          await parse('new', doc30({ minimum: 0, exclusiveMinimum: false })),
        ).changes,
      ).toEqual([]);
    });
  });

  describe('hand-built IR', () => {
    const string = (constraints?: Constraints): TypeRef => ({
      kind: 'primitive',
      type: 'string',
      ...(constraints ? { constraints } : {}),
    });
    const listPets = (over: Partial<Operation>): Operation => ({
      name: 'listPets',
      httpMethod: 'get',
      path: '/pets',
      pathParams: [],
      queryParams: [],
      headerParams: [],
      response: string(),
      errors: [],
      injectIdempotencyKey: false,
      ...over,
    });

    it('reports an operation parameter whose own constraints alone moved (its type carrying none)', () => {
      const before = listPets({
        queryParams: [{ name: 'q', type: string(), required: false, constraints: { minLength: 1 } }],
      });
      const after = listPets({
        queryParams: [{ name: 'q', type: string(), required: false, constraints: { minLength: 3 } }],
      });
      expect(diffOperations('Pets', [before], [after])).toMatchObject([
        {
          kind: 'operation-modified',
          paramChanges: [
            {
              kind: 'param-constraints-changed',
              paramName: 'q',
              paramLocation: 'query',
              classification: 'breaking',
              oldConstraints: { minLength: 1 },
              newConstraints: { minLength: 3 },
              details: 'minLength 1 → 3',
            },
          ],
          classification: 'breaking',
        },
      ]);
      expect(diffOperations('Pets', [after], [before])).toMatchObject([
        { paramChanges: [{ classification: 'additive', details: 'minLength 3 → 1' }], classification: 'additive' },
      ]);
    });

    it("reports a webhook parameter's limits additive either way, from the receiver's side", () => {
      const petAdopted = (pattern: string): Webhook => ({
        name: 'petAdopted',
        httpMethod: 'post',
        headerParams: [{ name: 'X-Signature', type: string({ pattern }), required: true, constraints: { pattern } }],
        queryParams: [],
        requestBody: string(),
        responses: [{ statusCode: 200 }],
      });
      for (const [before, after] of [
        ['^sig_', '^sg_'],
        ['^sg_', '^sig_'],
      ]) {
        expect(diffWebhooks([petAdopted(before)], [petAdopted(after)])).toEqual([
          {
            kind: 'webhook-modified',
            name: 'petAdopted',
            httpMethod: 'post',
            paramChanges: [
              {
                kind: 'param-constraints-changed',
                paramName: 'X-Signature',
                classification: 'additive',
                paramLocation: 'header',
                oldConstraints: { pattern: before },
                newConstraints: { pattern: after },
                details: `pattern '${before}' → '${after}'`,
              },
            ],
            requestBodyChanged: false,
            responsesChanged: false,
            deprecatedChanged: false,
            securityChanged: false,
            tagsChanged: false,
            classification: 'additive',
          },
        ]);
      }
    });

    it('keeps an inline union that gained a variant additive while reporting its kept variant’s limits beside it', () => {
      const union = (variants: TypeRef[]): TypeRef => ({ kind: 'union', variants, compositionKind: 'oneOf' });
      const pet = (ref: TypeRef): Model => ({ name: 'Pet', fields: [{ name: 'ref', type: ref, required: false }] });
      const integer: TypeRef = { kind: 'primitive', type: 'integer' };
      const boolean: TypeRef = { kind: 'primitive', type: 'boolean' };
      expect(
        diffModels(
          [pet(union([string({ pattern: '^a' }), integer]))],
          [pet(union([string({ pattern: '^b' }), integer, boolean]))],
        ),
      ).toEqual([
        {
          kind: 'model-modified',
          name: 'Pet',
          fieldChanges: [
            {
              kind: 'field-type-changed',
              fieldName: 'ref',
              classification: 'additive',
              details: 'variant boolean added',
            },
            {
              kind: 'field-constraints-changed',
              fieldName: 'ref',
              classification: 'breaking',
              details: "variants[0].pattern '^a' → '^b'",
            },
          ],
          deprecatedChanged: false,
          classification: 'breaking',
        },
      ]);
    });

    it('reports a model whose only change is its own limits, on either direction', () => {
      const pet = (constraints?: Constraints): Model => ({
        name: 'Pet',
        fields: [],
        ...(constraints ? { constraints } : {}),
      });
      expect(
        diffModels([pet({ maxProperties: 10 })], [pet({ maxProperties: 5 })], new Map([['Pet', 'request' as const]])),
      ).toEqual([
        {
          kind: 'model-modified',
          name: 'Pet',
          fieldChanges: [],
          deprecatedChanged: false,
          constraintsChanged: true,
          oldConstraints: { maxProperties: 10 },
          newConstraints: { maxProperties: 5 },
          details: 'maxProperties 10 → 5',
          classification: 'breaking',
        },
      ]);
      expect(
        diffModels([pet({ maxProperties: 10 })], [pet({ maxProperties: 5 })], new Map([['Pet', 'response' as const]])),
      ).toMatchObject([
        {
          constraintsChanged: true,
          details: 'maxProperties 10 → 5; tightened on a response-only model',
          classification: 'additive',
        },
      ]);
      expect(diffModels([pet({ maxProperties: 10 })], [pet()])).toMatchObject([
        {
          constraintsChanged: true,
          oldConstraints: { maxProperties: 10 },
          details: 'maxProperties 10 → <unset>',
          classification: 'additive',
        },
      ]);
      expect(diffModels([pet()], [pet()])).toEqual([]);
    });
  });
});
