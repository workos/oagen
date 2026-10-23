/**
 * The differ compares response headers (issue #296).
 *
 * The IR carries the headers each response declares — `Operation.responseHeaders`
 * for the primary success response, `headers` on each other `SuccessResponse`,
 * on each `ErrorResponse`, on the `DefaultResponse` and on each `RangeResponse`
 * — so an emitter can expose them as typed accessors on a response wrapper.
 * `diffOperations` built `hasChanges` from a fixed list of aspects that had no
 * response headers, so a header removed, retyped or no longer required came out
 * as no change at all. Every response kind is now walked through the differ's
 * one entry walk (`contentEntries`, the media-type diff's), headers pair by
 * case-folded name (RFC 9110 §5.1), and each change is classified from the
 * reader's side, as a webhook's parameters are.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffOperations } from '../../src/differ/operations.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { classifyResponseHeaderChange, parameterNameShift } from '../../src/differ/classify.js';
import { parseSpec } from '../../src/parser/parse.js';
import { foldHeaderName } from '../../src/ir/parameter-key.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import { collectResponseHeaders } from '../../src/ir/types.js';
import type { ApiSpec, Operation, ResponseHeader, TypeRef } from '../../src/ir/types.js';

const string: TypeRef = { kind: 'primitive', type: 'string' };
const integer: TypeRef = { kind: 'primitive', type: 'integer' };
const pet: TypeRef = { kind: 'model', name: 'Pet' };
const problem: TypeRef = { kind: 'model', name: 'Problem' };

const header = (name: string, over: Partial<ResponseHeader> = {}): ResponseHeader => ({
  name,
  type: string,
  required: false,
  ...over,
});

/** `GET /pets` (`listPets`) with a lone `200` declaring `headers`, as the parser builds it. */
const listPets = (headers: ResponseHeader[] | undefined, over: Partial<Operation> = {}): Operation => ({
  name: 'listPets',
  httpMethod: 'get',
  path: '/pets',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'array', items: pet },
  ...(headers ? { responseHeaders: headers } : {}),
  errors: [],
  injectIdempotencyKey: false,
  ...over,
});

const specOf = (op: Operation): ApiSpec => ({
  name: 'Pets',
  version: '1',
  baseUrl: 'https://api.example.com',
  models: [],
  enums: [],
  services: [{ name: 'Pets', operations: [op] }],
  sdk: defaultSdkBehavior(),
});

/** The one `operation-modified` change a diff of two versions of one operation yields. */
function modified(oldOp: Operation, newOp: Operation) {
  const changes = diffOperations('Pets', [oldOp], [newOp]);
  expect(changes).toHaveLength(1);
  const [change] = changes;
  if (change.kind !== 'operation-modified') throw new Error(`expected operation-modified, got ${change.kind}`);
  return change;
}

const headerChangesOf = (oldOp: Operation, newOp: Operation) => modified(oldOp, newOp).responseHeaderChanges;

describe('issue #296 repro: headers on a lone 200 dropped, retyped and deprecated, and added', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function writeSpec(name: string, doc: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-response-headers-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(doc));
    return file;
  }

  /** `GET /pets` whose `200` declares `headers`, as the issue writes it. */
  const document = (headers: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          responses: {
            '200': {
              description: 'The pets',
              headers,
              content: {
                'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Pet: { type: 'object', properties: { id: { type: 'string' } } } } },
  });

  const before = document({
    'X-Next-Cursor': { schema: { type: 'string' } },
    'X-Rate-Limit': { schema: { type: 'integer' } },
  });
  const after = document({
    'X-Rate-Limit': { deprecated: true, schema: { type: 'string' } },
    'X-Request-Id': { schema: { type: 'string' } },
  });

  it('reports the operation modified, breaking, with one entry per header change', async () => {
    const diff = diffSpecs(
      await parseSpec(await writeSpec('before.json', before)),
      await parseSpec(await writeSpec('after.json', after)),
    );
    // Used to be `[]`.
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'operation-modified',
      operationName: 'listPets',
      responseChanged: false,
      responseHeadersChanged: true,
      classification: 'breaking',
    });
    if (diff.changes[0].kind !== 'operation-modified') return;
    // A lone 2xx carries no status code in the IR, so none is reported.
    expect(diff.changes[0].responseHeaderChanges).toEqual([
      { kind: 'header-added', headerName: 'X-Request-Id', classification: 'additive' },
      { kind: 'header-removed', headerName: 'X-Next-Cursor', classification: 'breaking' },
      { kind: 'header-type-changed', headerName: 'X-Rate-Limit', classification: 'breaking' },
      {
        kind: 'header-deprecated-changed',
        headerName: 'X-Rate-Limit',
        classification: 'additive',
        oldDeprecated: false,
        newDeprecated: true,
        details: 'live → deprecated',
      },
    ]);
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'deprecated-changed',
        node: 'response-header',
        serviceName: diff.changes[0].serviceName,
        operationName: 'listPets',
        headerName: 'X-Rate-Limit',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 1 });
  });

  it('reports nothing for a spec diffed against itself', async () => {
    const a = await parseSpec(await writeSpec('same-a.json', before));
    const b = await parseSpec(await writeSpec('same-b.json', before));
    expect(diffSpecs(a, b).changes).toEqual([]);
  });
});

describe('diffOperations — response headers, one entry at a time', () => {
  it('reports nothing when the headers are unchanged, or when neither side declares any', () => {
    const headers = [header('X-Next-Cursor'), header('X-Rate-Limit', { type: integer, required: true })];
    expect(diffOperations('Pets', [listPets(headers)], [listPets([...headers])])).toEqual([]);
    expect(diffOperations('Pets', [listPets(undefined)], [listPets(undefined)])).toEqual([]);
    expect(diffOperations('Pets', [listPets([])], [listPets(undefined)])).toEqual([]);
  });

  it('reports a header added as additive, required or not: the server simply starts sending it', () => {
    const change = modified(
      listPets([header('X-Total')]),
      listPets([header('X-Total'), header('Location', { required: true })]),
    );
    expect(change.responseHeaderChanges).toEqual([
      { kind: 'header-added', headerName: 'Location', classification: 'additive' },
    ]);
    expect(change).toMatchObject({ responseHeadersChanged: true, classification: 'additive' });
    // The first header the operation declares is additive too.
    expect(headerChangesOf(listPets(undefined), listPets([header('X-Total', { required: true })]))).toEqual([
      { kind: 'header-added', headerName: 'X-Total', classification: 'additive' },
    ]);
  });

  it('reports a header removed as breaking: an accessor the SDK exposed is gone', () => {
    const change = modified(listPets([header('X-Total'), header('Location')]), listPets([header('X-Total')]));
    expect(change.responseHeaderChanges).toEqual([
      { kind: 'header-removed', headerName: 'Location', classification: 'breaking' },
    ]);
    expect(change.classification).toBe('breaking');
    // The last header going is a change to the operation, not a vanished list.
    expect(modified(listPets([header('X-Total')]), listPets(undefined))).toMatchObject({
      responseHeaderChanges: [{ kind: 'header-removed', headerName: 'X-Total', classification: 'breaking' }],
      classification: 'breaking',
    });
  });

  it('reports a retyped header as breaking, whether primitive or model typed', () => {
    expect(
      headerChangesOf(listPets([header('X-Rate-Limit', { type: integer })]), listPets([header('X-Rate-Limit')])),
    ).toEqual([{ kind: 'header-type-changed', headerName: 'X-Rate-Limit', classification: 'breaking' }]);
    expect(
      headerChangesOf(listPets([header('X-Meta', { type: pet })]), listPets([header('X-Meta', { type: problem })])),
    ).toEqual([{ kind: 'header-type-changed', headerName: 'X-Meta', classification: 'breaking' }]);
  });

  it('reports a format-only change as additive with the two formats, as elsewhere', () => {
    const uri: TypeRef = { kind: 'primitive', type: 'string', format: 'uri' };
    const change = modified(listPets([header('Location')]), listPets([header('Location', { type: uri })]));
    expect(change.responseHeaderChanges).toEqual([
      {
        kind: 'header-format-changed',
        headerName: 'Location',
        classification: 'additive',
        details: 'format <unset> → uri',
      },
    ]);
    expect(change.classification).toBe('additive');
  });

  it('reports optional → required as additive (now always sent) and required → optional as breaking', () => {
    const optional = listPets([header('X-Total')]);
    const required = listPets([header('X-Total', { required: true })]);
    expect(modified(optional, required)).toMatchObject({
      responseHeaderChanges: [
        {
          kind: 'header-required-changed',
          headerName: 'X-Total',
          classification: 'additive',
          details: 'optional → required',
        },
      ],
      classification: 'additive',
    });
    expect(modified(required, optional)).toMatchObject({
      responseHeaderChanges: [
        {
          kind: 'header-required-changed',
          headerName: 'X-Total',
          classification: 'breaking',
          details: 'required → optional',
        },
      ],
      classification: 'breaking',
    });
  });

  it('reports a deprecation flip as additive, either way, with both sides and the direction', () => {
    const live = listPets([header('X-Total')]);
    const deprecated = listPets([header('X-Total', { deprecated: true })]);
    expect(modified(live, deprecated)).toMatchObject({
      responseHeaderChanges: [
        {
          kind: 'header-deprecated-changed',
          headerName: 'X-Total',
          classification: 'additive',
          oldDeprecated: false,
          newDeprecated: true,
          details: 'live → deprecated',
        },
      ],
      classification: 'additive',
    });
    expect(headerChangesOf(deprecated, live)).toEqual([
      {
        kind: 'header-deprecated-changed',
        headerName: 'X-Total',
        classification: 'additive',
        oldDeprecated: true,
        newDeprecated: false,
        details: 'deprecated → live',
      },
    ]);
  });

  it('treats a deprecated flag of false as not deprecated, as on every other node', () => {
    const off = listPets([header('X-Total', { deprecated: false })]);
    expect(diffOperations('Pets', [listPets([header('X-Total')])], [off])).toEqual([]);
    expect(diffOperations('Pets', [off], [listPets([header('X-Total')])])).toEqual([]);
    expect(headerChangesOf(off, listPets([header('X-Total', { deprecated: true })]))).toMatchObject([
      { kind: 'header-deprecated-changed', oldDeprecated: false, newDeprecated: true },
    ]);
  });

  it('reports every change to one header, in order: name, type, requiredness, deprecation', () => {
    const before = listPets([header('X-Rate-Limit', { type: integer, required: true })]);
    const after = listPets([header('x-rate-limit', { required: false, deprecated: true })]);
    expect(headerChangesOf(before, after).map((c) => c.kind)).toEqual([
      'header-name-changed',
      'header-type-changed',
      'header-required-changed',
      'header-deprecated-changed',
    ]);
  });

  it('keeps the change breaking when a breaking header change rides along with additive ones', () => {
    const before = listPets([header('X-Total'), header('X-Next-Cursor')]);
    const after = listPets([header('X-Total', { deprecated: true }), header('X-Request-Id')]);
    expect(modified(before, after)).toMatchObject({
      responseHeaderChanges: [
        { kind: 'header-added', headerName: 'X-Request-Id', classification: 'additive' },
        { kind: 'header-removed', headerName: 'X-Next-Cursor', classification: 'breaking' },
        { kind: 'header-deprecated-changed', headerName: 'X-Total', classification: 'additive' },
      ],
      classification: 'breaking',
    });
  });
});

describe('diffOperations — header names are case-insensitive (RFC 9110 §5.1)', () => {
  it('folds a header name the way HTTP compares it', () => {
    expect(foldHeaderName('X-Rate-Limit')).toBe('x-rate-limit');
    expect(foldHeaderName('x-rate-limit')).toBe('x-rate-limit');
  });

  it('pairs a header that only changed case and reports the respelling, additive, with both spellings', () => {
    const change = modified(listPets([header('X-Rate-Limit')]), listPets([header('x-rate-limit')]));
    // Used to be a breaking `header-removed` beside a `header-added`.
    expect(change.responseHeaderChanges).toEqual([
      {
        kind: 'header-name-changed',
        headerName: 'x-rate-limit',
        classification: 'additive',
        oldName: 'X-Rate-Limit',
        newName: 'x-rate-limit',
        details: 'name X-Rate-Limit → x-rate-limit',
      },
    ]);
    expect(change.classification).toBe('additive');
  });

  it('keeps a deprecation flip made with a case-only rename, under the new spelling', () => {
    expect(
      headerChangesOf(listPets([header('X-Rate-Limit')]), listPets([header('x-rate-limit', { deprecated: true })])),
    ).toMatchObject([
      { kind: 'header-name-changed', headerName: 'x-rate-limit' },
      { kind: 'header-deprecated-changed', headerName: 'x-rate-limit', newDeprecated: true },
    ]);
  });

  it('keeps two names of one folding declared side by side apart: exact spellings claim first', () => {
    const both = listPets([header('X-Foo'), header('x-foo', { type: integer })]);
    // Reordering them is no change: each claims the one spelled the same way.
    expect(diffOperations('Pets', [both], [listPets([header('x-foo', { type: integer }), header('X-Foo')])])).toEqual(
      [],
    );
    // The `x-foo` that stays pairs with its own spelling, so only `X-Foo` is gone.
    expect(headerChangesOf(both, listPets([header('x-foo', { type: integer })]))).toEqual([
      { kind: 'header-removed', headerName: 'X-Foo', classification: 'breaking' },
    ]);
    // A spelling nothing claims exactly pairs with the next unpaired name of its folding.
    expect(headerChangesOf(both, listPets([header('x-foo', { type: integer }), header('X-FOO')]))).toEqual([
      {
        kind: 'header-name-changed',
        headerName: 'X-FOO',
        classification: 'additive',
        oldName: 'X-Foo',
        newName: 'X-FOO',
        details: 'name X-Foo → X-FOO',
      },
    ]);
  });

  it('reads a respelling off the two written names alone', () => {
    expect(parameterNameShift({ name: 'X-Foo' }, { name: 'X-Foo' })).toBeUndefined();
    expect(parameterNameShift({ name: 'X-Foo' }, { name: 'x-foo' })).toEqual({
      oldName: 'X-Foo',
      newName: 'x-foo',
      details: 'name X-Foo → x-foo',
    });
  });
});

describe('diffOperations — every response kind, through one walk', () => {
  const ok = [header('X-Total', { type: integer }), header('X-Next-Cursor')];
  /** Headers on the primary `200`, an alternate `201`, a `404`, the `default` and the `4XX` range. */
  const everyKind = listPets(ok, {
    response: pet,
    successResponses: [
      { statusCode: 200, type: pet, headers: ok },
      { statusCode: 201, type: pet, headers: [header('Location', { required: true })] },
    ],
    errors: [{ statusCode: 404, type: problem, headers: [header('X-Reason')] }],
    defaultResponse: { type: problem, headers: [header('X-Request-Id')] },
    rangeResponses: [{ range: '4XX', type: problem, headers: [header('Retry-After', { type: integer })] }],
  });
  /** The same operation with every header gone. */
  const bare = listPets(undefined, {
    response: pet,
    successResponses: [
      { statusCode: 200, type: pet },
      { statusCode: 201, type: pet },
    ],
    errors: [{ statusCode: 404, type: problem }],
    defaultResponse: { type: problem },
    rangeResponses: [{ range: '4XX', type: problem }],
  });

  it('reports a header on each kind of entry with where it lives: a status code or the fallback key', () => {
    const changes = headerChangesOf(everyKind, bare);
    expect(changes).toEqual([
      { kind: 'header-removed', headerName: 'X-Total', statusCode: 200, classification: 'breaking' },
      { kind: 'header-removed', headerName: 'X-Next-Cursor', statusCode: 200, classification: 'breaking' },
      { kind: 'header-removed', headerName: 'Location', statusCode: 201, classification: 'breaking' },
      { kind: 'header-removed', headerName: 'X-Reason', statusCode: 404, classification: 'breaking' },
      { kind: 'header-removed', headerName: 'X-Request-Id', fallback: 'default', classification: 'breaking' },
      { kind: 'header-removed', headerName: 'Retry-After', fallback: '4XX', classification: 'breaking' },
    ]);
    // The differ's walk of an operation's headers agrees with the IR's own, list for list.
    expect(changes.map((c) => c.headerName)).toEqual(collectResponseHeaders(everyKind).map((h) => h.name));
  });

  it('reports the headers added to each kind of entry as additive', () => {
    const change = modified(bare, everyKind);
    expect(change.responseHeaderChanges.map((c) => [c.kind, c.headerName, c.statusCode ?? c.fallback])).toEqual([
      ['header-added', 'X-Total', 200],
      ['header-added', 'X-Next-Cursor', 200],
      ['header-added', 'Location', 201],
      ['header-added', 'X-Reason', 404],
      ['header-added', 'X-Request-Id', 'default'],
      ['header-added', 'Retry-After', '4XX'],
    ]);
    expect(change.classification).toBe('additive');
  });

  it('reads the primary entry from `successResponses` when a hand-built IR sets only its headers there', () => {
    const entryOnly = listPets(undefined, {
      response: pet,
      successResponses: [
        { statusCode: 200, type: pet, headers: [header('X-Total')] },
        { statusCode: 201, type: pet },
      ],
    });
    const stripped = listPets(undefined, {
      response: pet,
      successResponses: [
        { statusCode: 200, type: pet },
        { statusCode: 201, type: pet },
      ],
    });
    expect(headerChangesOf(entryOnly, stripped)).toEqual([
      { kind: 'header-removed', headerName: 'X-Total', statusCode: 200, classification: 'breaking' },
    ]);
  });

  it('pairs a lone 2xx with the entry that survives beside a new one, and reports no headers for the new 2xx', () => {
    const lone = listPets([header('X-Total')], { response: pet });
    const two = listPets([header('X-Total')], {
      response: pet,
      successResponses: [
        { statusCode: 200, type: pet, headers: [header('X-Total')] },
        { statusCode: 201, type: pet, headers: [header('Location', { required: true })] },
      ],
    });
    // A 2xx the new spec adds is no header change (its media types are none either).
    expect(diffOperations('Pets', [lone], [two])).toEqual([]);
    // A 2xx the old spec declared and the new does not has no other diff to
    // report it, so its headers are reported removed, as its media types are.
    expect(modified(two, lone)).toMatchObject({
      responseHeaderChanges: [
        { kind: 'header-removed', headerName: 'Location', statusCode: 201, classification: 'breaking' },
      ],
      classification: 'breaking',
    });
  });

  it('leaves an error or fallback entry only one spec declares to the errors and fallback diffs', () => {
    const withError = listPets(undefined, {
      errors: [{ statusCode: 404, type: problem, headers: [header('X-Reason')] }],
    });
    const noError = listPets(undefined);
    expect(modified(withError, noError)).toMatchObject({
      errorsChanged: true,
      responseHeadersChanged: false,
      responseHeaderChanges: [],
      classification: 'breaking',
    });
    expect(modified(noError, withError)).toMatchObject({
      errorsChanged: true,
      responseHeaderChanges: [],
      classification: 'additive',
    });
    const withDefault = listPets(undefined, { defaultResponse: { type: problem, headers: [header('X-Request-Id')] } });
    expect(modified(withDefault, noError)).toMatchObject({
      fallbackResponsesChanged: true,
      responseHeaderChanges: [],
      classification: 'breaking',
    });
    expect(modified(noError, withDefault)).toMatchObject({
      fallbackResponsesChanged: true,
      responseHeaderChanges: [],
      classification: 'additive',
    });
  });

  it('compares a header on an error, the default and a range entry like one on the primary', () => {
    const before = listPets(undefined, {
      errors: [{ statusCode: 429, type: problem, headers: [header('Retry-After', { type: integer, required: true })] }],
      defaultResponse: { type: problem, headers: [header('X-Request-Id')] },
      rangeResponses: [{ range: '5XX', type: problem, headers: [header('X-Incident')] }],
    });
    const after = listPets(undefined, {
      errors: [{ statusCode: 429, type: problem, headers: [header('retry-after', { type: integer })] }],
      defaultResponse: { type: problem, headers: [header('X-Request-Id', { deprecated: true })] },
      rangeResponses: [{ range: '5XX', type: problem, headers: [header('X-Incident', { type: integer })] }],
    });
    expect(headerChangesOf(before, after)).toEqual([
      {
        kind: 'header-name-changed',
        headerName: 'retry-after',
        statusCode: 429,
        classification: 'additive',
        oldName: 'Retry-After',
        newName: 'retry-after',
        details: 'name Retry-After → retry-after',
      },
      {
        kind: 'header-required-changed',
        headerName: 'retry-after',
        statusCode: 429,
        classification: 'breaking',
        details: 'required → optional',
      },
      {
        kind: 'header-deprecated-changed',
        headerName: 'X-Request-Id',
        fallback: 'default',
        classification: 'additive',
        oldDeprecated: false,
        newDeprecated: true,
        details: 'live → deprecated',
      },
      { kind: 'header-type-changed', headerName: 'X-Incident', fallback: '5XX', classification: 'breaking' },
    ]);
  });
});

describe('diffSpecs — response header flips in behaviorChanges and the summary', () => {
  it('mirrors a flip on an error entry and on the default response with where each lives', () => {
    const before = listPets([header('X-Total')], {
      errors: [{ statusCode: 404, type: problem, headers: [header('X-Reason')] }],
      defaultResponse: { type: problem, headers: [header('X-Request-Id')] },
    });
    const after = listPets([header('X-Total', { deprecated: true })], {
      errors: [{ statusCode: 404, type: problem, headers: [header('X-Reason', { deprecated: true })] }],
      defaultResponse: { type: problem, headers: [header('X-Request-Id', { deprecated: true })] },
    });
    const diff = diffSpecs(specOf(before), specOf(after));
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'deprecated-changed',
        node: 'response-header',
        serviceName: 'Pets',
        operationName: 'listPets',
        headerName: 'X-Total',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
      {
        kind: 'deprecated-changed',
        node: 'response-header',
        serviceName: 'Pets',
        operationName: 'listPets',
        headerName: 'X-Reason',
        statusCode: 404,
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
      {
        kind: 'deprecated-changed',
        node: 'response-header',
        serviceName: 'Pets',
        operationName: 'listPets',
        headerName: 'X-Request-Id',
        fallback: 'default',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
    ]);
    // Three flips on one operation are one additive modified change.
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 3 });
  });

  it('mirrors only the flag: a header added, removed, retyped or respelled is not a behavior change', () => {
    const before = listPets([header('X-Total'), header('X-Next-Cursor'), header('X-Rate-Limit', { type: integer })]);
    const after = listPets([header('x-total'), header('X-Request-Id'), header('X-Rate-Limit')]);
    const diff = diffSpecs(specOf(before), specOf(after));
    expect(diff.changes).toHaveLength(1);
    expect(diff.behaviorChanges).toEqual([]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 0 });
  });
});

describe('classifyResponseHeaderChange — read from the reader side', () => {
  it.each([
    ['header-added', undefined, 'additive'],
    ['header-removed', undefined, 'breaking'],
    ['header-type-changed', undefined, 'breaking'],
    ['header-format-changed', undefined, 'additive'],
    ['header-required-changed', true, 'additive'],
    ['header-required-changed', false, 'breaking'],
    ['header-name-changed', undefined, 'additive'],
    ['header-deprecated-changed', undefined, 'additive'],
  ] as const)('%s (required: %s) is %s', (kind, isRequired, classification) => {
    expect(classifyResponseHeaderChange(kind, 'X-Total', isRequired)).toMatchObject({
      kind,
      headerName: 'X-Total',
      classification,
    });
  });

  it('says which way requiredness went', () => {
    expect(classifyResponseHeaderChange('header-required-changed', 'X-Total', true).details).toBe(
      'optional → required',
    );
    expect(classifyResponseHeaderChange('header-required-changed', 'X-Total', false).details).toBe(
      'required → optional',
    );
  });
});
