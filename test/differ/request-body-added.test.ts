import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffOperations } from '../../src/differ/operations.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { Operation } from '../../src/ir/types.js';

const createPet: Operation = {
  name: 'createPet',
  httpMethod: 'post',
  path: '/pets',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'model', name: 'Pet' },
  errors: [],
  injectIdempotencyKey: false,
};

const body: Operation['requestBody'] = { kind: 'model', name: 'CreatePetRequest' };
const optionalBody: Operation = { ...createPet, requestBody: body, requestBodyRequired: false };
const requiredBody: Operation = { ...createPet, requestBody: body, requestBodyRequired: true };

/** The one `operation-modified` change a diff of two versions of `createPet` yields. */
function modified(oldOp: Operation, newOp: Operation) {
  const changes = diffOperations('Pets', [oldOp], [newOp]);
  expect(changes).toHaveLength(1);
  const [change] = changes;
  if (change.kind !== 'operation-modified') throw new Error(`expected operation-modified, got ${change.kind}`);
  return change;
}

describe('diffOperations – request body added (issue #249)', () => {
  it('reports an optional body added as additive, like an optional param-added', () => {
    expect(modified(createPet, optionalBody)).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: false,
      classification: 'additive',
    });
  });

  it('reports a required body added as breaking', () => {
    expect(modified(createPet, requiredBody)).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: false,
      classification: 'breaking',
    });
  });

  it('reports a body removed as breaking, whether it was optional or required', () => {
    expect(modified(optionalBody, createPet)).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: false,
      classification: 'breaking',
    });
    expect(modified(requiredBody, createPet)).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: false,
      classification: 'breaking',
    });
  });

  it('reports a changed body type as breaking, even when the body is optional on both sides', () => {
    const retyped: Operation = { ...optionalBody, requestBody: { kind: 'model', name: 'UpdatePetRequest' } };
    expect(modified(optionalBody, retyped)).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: false,
      classification: 'breaking',
    });
  });

  it('treats an absent flag on the new body as optional, as OpenAPI does', () => {
    // The parser always sets the flag beside a body; a hand-built operation may not.
    const unflagged: Operation = { ...createPet, requestBody: body };
    expect(Object.keys(unflagged)).not.toContain('requestBodyRequired');
    expect(modified(createPet, unflagged)).toMatchObject({
      requestBodyChanged: true,
      requestBodyRequiredChanged: false,
      classification: 'additive',
    });
  });

  it('stays breaking when an optional body is added alongside a required parameter', () => {
    const withRequiredParam: Operation = {
      ...optionalBody,
      queryParams: [{ name: 'organization_id', type: { kind: 'primitive', type: 'string' }, required: true }],
    };
    const change = modified(createPet, withRequiredParam);
    expect(change).toMatchObject({ requestBodyChanged: true, classification: 'breaking' });
    expect(change.paramChanges).toEqual([
      { kind: 'param-added', paramName: 'organization_id', classification: 'breaking', paramLocation: 'query' },
    ]);
  });

  it('stays breaking when an optional body is added alongside a changed response', () => {
    const withNewResponse: Operation = { ...optionalBody, response: { kind: 'model', name: 'PetSummary' } };
    expect(modified(createPet, withNewResponse)).toMatchObject({
      requestBodyChanged: true,
      responseChanged: true,
      classification: 'breaking',
    });
  });

  it('stays additive when an optional body is added alongside other additive changes', () => {
    const withOptionalParam: Operation = {
      ...optionalBody,
      queryParams: [{ name: 'dry_run', type: { kind: 'primitive', type: 'boolean' }, required: false }],
    };
    const change = modified(createPet, withOptionalParam);
    expect(change).toMatchObject({ requestBodyChanged: true, classification: 'additive' });
    expect(change.paramChanges).toEqual([
      { kind: 'param-added', paramName: 'dry_run', classification: 'additive', paramLocation: 'query' },
    ]);
  });

  it('leaves the required-flag flips as they were', () => {
    expect(modified(optionalBody, requiredBody)).toMatchObject({
      requestBodyChanged: false,
      requestBodyRequiredChanged: true,
      classification: 'breaking',
    });
    expect(modified(requiredBody, optionalBody)).toMatchObject({
      requestBodyChanged: false,
      requestBodyRequiredChanged: true,
      classification: 'additive',
    });
  });
});

describe('diffSpecs – request body added (issue #249 repro)', () => {
  const before = {
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1.0.0' },
    paths: {
      '/pets': {
        post: { operationId: 'createPet', responses: { '201': { description: 'Created' } } },
      },
    },
  };
  const content = {
    'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } },
  };

  /** The issue's `after.json`: `before` with the given Request Body Object on `POST /pets`. */
  function withBody(requestBody: unknown) {
    return { ...before, paths: { '/pets': { post: { ...before.paths['/pets'].post, requestBody } } } };
  }

  async function diffDocuments(oldDoc: unknown, newDoc: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'oagen-request-body-added-'));
    try {
      writeFileSync(join(dir, 'before.json'), JSON.stringify(oldDoc));
      writeFileSync(join(dir, 'after.json'), JSON.stringify(newDoc));
      return diffSpecs(await parseSpec(join(dir, 'before.json')), await parseSpec(join(dir, 'after.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The projection the issue prints. */
  function projected(changes: ReturnType<typeof diffSpecs>['changes']) {
    return changes.map((c) => ({
      classification: c.classification,
      kind: c.kind,
      requestBodyChanged: c.kind === 'operation-modified' ? c.requestBodyChanged : undefined,
    }));
  }

  it("classifies the issue's optional body as additive", async () => {
    const { changes, summary } = await diffDocuments(before, withBody({ required: false, content }));
    expect(projected(changes)).toEqual([
      { classification: 'additive', kind: 'model-added', requestBodyChanged: undefined },
      { classification: 'additive', kind: 'operation-modified', requestBodyChanged: true },
    ]);
    expect(summary).toMatchObject({ breaking: 0, additive: 2, modified: 1 });
  });

  it('classifies the same body with the flag omitted as additive (the OpenAPI default)', async () => {
    const { changes, summary } = await diffDocuments(before, withBody({ content }));
    expect(projected(changes)).toEqual([
      { classification: 'additive', kind: 'model-added', requestBodyChanged: undefined },
      { classification: 'additive', kind: 'operation-modified', requestBodyChanged: true },
    ]);
    expect(summary.breaking).toBe(0);
  });

  it('classifies the same body added as required as breaking', async () => {
    const { changes, summary } = await diffDocuments(before, withBody({ required: true, content }));
    expect(projected(changes)).toEqual([
      { classification: 'additive', kind: 'model-added', requestBodyChanged: undefined },
      { classification: 'breaking', kind: 'operation-modified', requestBodyChanged: true },
    ]);
    expect(summary.breaking).toBe(1);
  });

  it('classifies the optional body removed again as breaking', async () => {
    const { changes, summary } = await diffDocuments(withBody({ required: false, content }), before);
    expect(projected(changes)).toEqual([
      { classification: 'breaking', kind: 'model-removed', requestBodyChanged: undefined },
      { classification: 'breaking', kind: 'operation-modified', requestBodyChanged: true },
    ]);
    expect(summary.breaking).toBe(2);
  });
});
