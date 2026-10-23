import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { collectFallbackResponseTypes, collectModelRefs } from '../../src/ir/types.js';
import type { ApiSpec, HttpMethod, Operation } from '../../src/ir/types.js';
import {
  coversStatus,
  formatExpectedStatuses,
  getExpectedStatusCodes,
  getExpectedStatuses,
  isUnexpectedStatus,
} from '../../scripts/smoke/shared.js';

/**
 * Issue #274: an operation carries its `default` and `1XX`–`5XX` responses
 * (`defaultResponse`, `rangeResponses`), so a status one of them covers is
 * not unexpected. Every declared 2xx/3xx code counts as declared too —
 * `responseStatusCode` for the primary (a lone `302`, a POST's lone `200`)
 * and every `successResponses` entry — and nothing is implied from the HTTP
 * method: an operation that declares no success response has no success
 * code.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-smoke-status-'));
  dirs.push(dir);
  const file = path.join(dir, 'spec.json');
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** A response with a JSON object body of one string property. */
const jsonResponse = (description: string, property: string) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties: { [property]: { type: 'string' } } } } },
});

/** A minimal OpenAPI 3.1 document with one `/pets` operation declaring `responses`. */
const specDoc = (method: HttpMethod, responses: Record<string, unknown>) => ({
  openapi: '3.1.0',
  info: { title: 'pets', version: '1' },
  paths: { '/pets': { [method]: { operationId: 'listPets', responses } } },
  components: { schemas: {} },
});

async function parseOnlyOperation(method: HttpMethod, responses: Record<string, unknown>): Promise<Operation> {
  const spec = await parseSpec(await writeSpec(specDoc(method, responses)));
  return onlyOperation(spec);
}

function onlyOperation(spec: ApiSpec): Operation {
  const ops = spec.services.flatMap((s) => s.operations);
  expect(ops).toHaveLength(1);
  return ops[0];
}

/** Every model reference an operation's responses hold that names no model in `spec`. */
function unresolvedResponseReferences(spec: ApiSpec, op: Operation): string[] {
  const names = new Set(spec.models.map((m) => m.name));
  const refs = [
    op.response,
    ...(op.successResponses ?? []).map((r) => r.type),
    ...op.errors.flatMap((e) => (e.type ? [e.type] : [])),
    ...collectFallbackResponseTypes(op),
  ];
  return refs.flatMap((ref) => collectModelRefs(ref)).filter((name) => !names.has(name));
}

/** An operation holding only what the status helpers read. */
function makeOp(partial: Partial<Operation> & Pick<Operation, 'httpMethod'>): Operation {
  return {
    name: 'listPets',
    path: '/pets',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'string' },
    errors: [],
    injectIdempotencyKey: false,
    ...partial,
  };
}

describe('getExpectedStatuses / isUnexpectedStatus (issue #274)', () => {
  it('covers 409 through the 4XX range and 500 through default, exactly as the issue reports', async () => {
    const spec = await parseSpec(
      await writeSpec(
        specDoc('get', {
          '200': {
            description: 'The pets',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
                  },
                },
              },
            },
          },
          '4XX': jsonResponse('Client error', 'code'),
          default: jsonResponse('Unexpected error', 'message'),
        }),
      ),
    );
    const op = onlyOperation(spec);

    expect({
      defaultResponse: op.defaultResponse !== undefined,
      expected: getExpectedStatusCodes(op),
      rangeResponses: op.rangeResponses?.map(({ range }) => range),
      unexpected409: isUnexpectedStatus(409, op),
      unexpected500: isUnexpectedStatus(500, op),
    }).toEqual({
      defaultResponse: true,
      expected: [200],
      rangeResponses: ['4XX'],
      unexpected409: false,
      unexpected500: false,
    });
    expect(getExpectedStatuses(op)).toEqual({ codes: [200], ranges: ['4XX'], hasDefault: true });
    expect(formatExpectedStatuses(getExpectedStatuses(op))).toBe('200/4XX/default');
    expect(unresolvedResponseReferences(spec, op)).toEqual([]);
  });

  it('a range covers every status in its hundred and nothing outside it', async () => {
    const op = await parseOnlyOperation('get', {
      '200': { description: 'OK' },
      '404': { description: 'Not found' },
      '4XX': jsonResponse('Client error', 'code'),
    });

    expect(getExpectedStatuses(op)).toEqual({ codes: [200, 404], ranges: ['4XX'], hasDefault: false });
    expect([400, 404, 409, 499].map((status) => isUnexpectedStatus(status, op))).toEqual([false, false, false, false]);
    expect([302, 399, 500].map((status) => isUnexpectedStatus(status, op))).toEqual([true, true, true]);
  });

  it('a default response with only a description still covers every status not listed', async () => {
    const op = await parseOnlyOperation('get', {
      '200': { description: 'OK' },
      default: { description: 'Error' },
    });

    expect(op.defaultResponse).toEqual({ description: 'Error' });
    expect(getExpectedStatuses(op)).toEqual({ codes: [200], ranges: [], hasDefault: true });
    expect([201, 302, 418, 503].map((status) => isUnexpectedStatus(status, op))).toEqual([false, false, false, false]);
    expect(formatExpectedStatuses(getExpectedStatuses(op))).toBe('200/default');
  });

  it('reads a lowercase 4xx key as the 4XX range', async () => {
    const op = await parseOnlyOperation('get', {
      '200': { description: 'OK' },
      '4xx': { description: 'Client error' },
    });

    expect(getExpectedStatuses(op).ranges).toEqual(['4XX']);
    expect(isUnexpectedStatus(409, op)).toBe(false);
  });

  it('covers each of the five ranges through its own hundred', async () => {
    const op = await parseOnlyOperation('get', {
      '200': { description: 'OK' },
      '1XX': { description: 'Informational' },
      '2XX': { description: 'Success' },
      '3XX': { description: 'Redirect' },
      '4XX': { description: 'Client error' },
      '5XX': { description: 'Server error' },
    });

    expect(getExpectedStatuses(op)).toEqual({
      codes: [200],
      ranges: ['1XX', '2XX', '3XX', '4XX', '5XX'],
      hasDefault: false,
    });
    expect([101, 204, 301, 404, 503].map((status) => isUnexpectedStatus(status, op))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("counts every successResponses code as declared without implying the method's usual code", async () => {
    const post = await parseOnlyOperation('post', {
      '200': jsonResponse('Updated', 'id'),
      '202': { description: 'Accepted' },
      '404': { description: 'Not found' },
    });

    expect(post.successResponses?.map((r) => r.statusCode)).toEqual([200, 202]);
    expect(getExpectedStatuses(post)).toEqual({ codes: [200, 202, 404], ranges: [], hasDefault: false });
    expect(isUnexpectedStatus(202, post)).toBe(false);
    // 201 is POST's usual success code, but the document declared 200 and 202 instead.
    expect(isUnexpectedStatus(201, post)).toBe(true);

    const get = await parseOnlyOperation('get', {
      '200': { description: 'OK' },
      '204': { description: 'Empty' },
    });
    expect(getExpectedStatuses(get).codes).toEqual([200, 204]);
    expect(isUnexpectedStatus(204, get)).toBe(false);
  });

  it('credits a lone success response with its own code, whatever the HTTP method would suggest', async () => {
    const postCreated = await parseOnlyOperation('post', { '201': jsonResponse('Created', 'id') });
    const postUpdated = await parseOnlyOperation('post', { '200': jsonResponse('Updated', 'id') });
    const del = await parseOnlyOperation('delete', { '204': { description: 'Deleted' } });
    const redirect = await parseOnlyOperation('get', { '302': { description: 'See the photo' } });

    expect([postCreated, postUpdated, del, redirect].map((op) => getExpectedStatusCodes(op))).toEqual([
      [201],
      [200],
      [204],
      [302],
    ]);
    // `POST /notes` declaring only `200`: 200 is declared, 201 (POST's usual code) is not.
    expect(isUnexpectedStatus(200, postUpdated)).toBe(false);
    expect(isUnexpectedStatus(201, postUpdated)).toBe(true);
    expect(formatExpectedStatuses(getExpectedStatuses(postUpdated))).toBe('200');
    // `GET /pets/{id}/photo` declaring only `302`.
    expect(isUnexpectedStatus(302, redirect)).toBe(false);
    expect(isUnexpectedStatus(200, redirect)).toBe(true);
  });

  it('credits no success code when the operation declares no 2xx or 3xx response', async () => {
    // `GET /pets` declaring only `404` never declares a 200, so a 200 is unexpected.
    const errorOnly = await parseOnlyOperation('get', { '404': jsonResponse('Not found', 'code') });
    expect(getExpectedStatuses(errorOnly)).toEqual({ codes: [404], ranges: [], hasDefault: false });
    expect(isUnexpectedStatus(404, errorOnly)).toBe(false);
    expect(isUnexpectedStatus(200, errorOnly)).toBe(true);

    const defaultOnly = await parseOnlyOperation('get', { default: jsonResponse('Anything', 'message') });
    expect(getExpectedStatuses(defaultOnly)).toEqual({ codes: [], ranges: [], hasDefault: true });
    expect([200, 404, 503].map((status) => isUnexpectedStatus(status, defaultOnly))).toEqual([false, false, false]);
    expect(formatExpectedStatuses(getExpectedStatuses(defaultOnly))).toBe('default');

    const rangeOnly = await parseOnlyOperation('get', { '2XX': { description: 'Some success' } });
    expect(getExpectedStatuses(rangeOnly)).toEqual({ codes: [], ranges: ['2XX'], hasDefault: false });
    expect(isUnexpectedStatus(200, rangeOnly)).toBe(false);
    expect(isUnexpectedStatus(404, rangeOnly)).toBe(true);
  });

  it('still reports a status that no explicit code, range or default covers', async () => {
    const op = await parseOnlyOperation('get', {
      '200': { description: 'OK' },
      '404': jsonResponse('Not found', 'code'),
    });

    expect(getExpectedStatuses(op)).toEqual({ codes: [200, 404], ranges: [], hasDefault: false });
    expect(isUnexpectedStatus(404, op)).toBe(false);
    expect(isUnexpectedStatus(409, op)).toBe(true);
    expect(isUnexpectedStatus(500, op)).toBe(true);
  });

  it('never reports status 0, which marks a skipped call or a network error', async () => {
    const op = await parseOnlyOperation('get', { '200': { description: 'OK' } });
    expect(isUnexpectedStatus(0, op)).toBe(false);
  });

  it('lists explicit codes ascending and once, whatever order the IR holds them in', () => {
    const op = makeOp({
      httpMethod: 'post',
      responseStatusCode: 200,
      successResponses: [
        { statusCode: 202, type: { kind: 'primitive', type: 'unknown' } },
        { statusCode: 200, type: { kind: 'primitive', type: 'unknown' } },
      ],
      errors: [{ statusCode: 404 }, { statusCode: 400 }, { statusCode: 404 }],
    });

    expect(getExpectedStatusCodes(op)).toEqual([200, 202, 400, 404]);
  });

  it('lists nothing for an operation without a declared success or error code, whatever its method', () => {
    expect(getExpectedStatusCodes(makeOp({ httpMethod: 'head' }))).toEqual([]);
    expect(getExpectedStatusCodes(makeOp({ httpMethod: 'post' }))).toEqual([]);
  });
});

describe('coversStatus', () => {
  it('resolves an explicit code, then the range containing it, then default', () => {
    const withoutDefault = { codes: [200, 404], ranges: ['5XX' as const], hasDefault: false };
    expect([200, 404, 409, 500, 599].map((status) => coversStatus(withoutDefault, status))).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);

    const withDefault = { ...withoutDefault, hasDefault: true };
    expect([409, 302].map((status) => coversStatus(withDefault, status))).toEqual([true, true]);
  });

  it('does not stretch a range past its hundred', () => {
    const expected = { codes: [], ranges: ['4XX' as const], hasDefault: false };
    expect(coversStatus(expected, 399)).toBe(false);
    expect(coversStatus(expected, 400)).toBe(true);
    expect(coversStatus(expected, 499)).toBe(true);
    expect(coversStatus(expected, 500)).toBe(false);
  });
});

describe('formatExpectedStatuses', () => {
  it('lists the explicit codes, then the ranges in declaration order, then default', () => {
    expect(formatExpectedStatuses({ codes: [200, 404], ranges: ['5XX', '4XX'], hasDefault: true })).toBe(
      '200/404/5XX/4XX/default',
    );
    expect(formatExpectedStatuses({ codes: [201], ranges: [], hasDefault: false })).toBe('201');
  });
});
