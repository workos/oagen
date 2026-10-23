import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffOperations } from '../../src/differ/operations.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Model, Operation, RequestBodyContent, TypeRef, Webhook } from '../../src/ir/types.js';

const string: TypeRef = { kind: 'primitive', type: 'string' };
const binary: TypeRef = { kind: 'primitive', type: 'string', format: 'binary' };
const request: TypeRef = { kind: 'model', name: 'CreatePetRequest' };
const upload: TypeRef = { kind: 'model', name: 'CreatePetMultipartFormDataRequest' };
const rows: TypeRef = { kind: 'model', name: 'CsvRows' };

const contents = (entries: Array<[string, TypeRef]>): RequestBodyContent[] =>
  entries.map(([contentType, type]) => ({ contentType, type }));

/**
 * `createPet` with a required body, as the parser builds it: `requestBody`
 * is the JSON entry's very object, every other entry typed on its own.
 */
const createPet = (entries: Array<[string, TypeRef]>, over: Partial<Operation> = {}): Operation => ({
  name: 'createPet',
  httpMethod: 'post',
  path: '/pets',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'model', name: 'Pet' },
  errors: [],
  injectIdempotencyKey: false,
  requestBody: entries[0]?.[1],
  requestBodyRequired: true,
  requestBodyContentTypes: entries.map(([contentType]) => contentType),
  requestBodyContents: contents(entries),
  ...over,
});

/** The one `operation-modified` change, or `undefined` when nothing changed. */
function modified(oldOp: Operation, newOp: Operation) {
  const changes = diffOperations('Pets', [oldOp], [newOp]);
  if (changes.length === 0) return undefined;
  expect(changes).toHaveLength(1);
  const [change] = changes;
  if (change.kind !== 'operation-modified') throw new Error(`expected operation-modified, got ${change.kind}`);
  return change;
}

describe('diffOperations — request body media types (issue #279)', () => {
  it("reports no change when the body's media type only gains a charset or changes case", () => {
    const plain = createPet([['application/json', request]]);
    expect(modified(plain, createPet([['application/json; charset=utf-8', request]]))).toBeUndefined();
    expect(modified(plain, createPet([['APPLICATION/JSON', request]]))).toBeUndefined();
    expect(modified(createPet([['application/json; charset=utf-8', request]]), plain)).toBeUndefined();
  });

  it('reports a form media type callers could send that is gone as removed, breaking', () => {
    const both = createPet([
      ['application/json', request],
      ['multipart/form-data', upload],
    ]);
    const jsonOnly = createPet([['application/json', request]]);
    expect(modified(both, jsonOnly)).toMatchObject({
      requestBodyChanged: false,
      requestBodyContentTypesChanged: true,
      requestBodyContentTypeChange: {
        added: [],
        removed: ['multipart/form-data'],
        retyped: [],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
  });

  it('reports a media type callers can newly send as added, additive', () => {
    const jsonOnly = createPet([['application/json', request]]);
    const withCsv = createPet([
      ['application/json', request],
      ['text/csv', string],
    ]);
    expect(modified(jsonOnly, withCsv)).toMatchObject({
      requestBodyChanged: false,
      requestBodyContentTypesChanged: true,
      requestBodyContentTypeChange: { added: ['text/csv'], removed: [], retyped: [], classification: 'additive' },
      classification: 'additive',
    });
  });

  it('keeps two spellings of one essence apart: a spelling that is gone is removed, one that appears is added', () => {
    const both = createPet([
      ['application/json', request],
      ['application/json; charset=utf-8', request],
    ]);
    const plain = createPet([['application/json', request]]);
    expect(modified(both, plain)).toMatchObject({
      requestBodyContentTypeChange: {
        added: [],
        removed: ['application/json; charset=utf-8'],
        retyped: [],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
    expect(modified(plain, both)).toMatchObject({
      requestBodyContentTypeChange: {
        added: ['application/json; charset=utf-8'],
        removed: [],
        retyped: [],
        classification: 'additive',
      },
      classification: 'additive',
    });
  });

  it('reports a secondary media type whose body changed type as retyped, breaking, under the new spelling', () => {
    const old = createPet([
      ['application/json', request],
      ['text/csv', string],
    ]);
    const next = createPet([
      ['application/json', request],
      ['Text/CSV', rows],
    ]);
    expect(modified(old, next)).toMatchObject({
      requestBodyChanged: false,
      requestBodyContentTypeChange: { added: [], removed: [], retyped: ['Text/CSV'], classification: 'breaking' },
      classification: 'breaking',
    });
  });

  it('leaves the body requestBody is read from to requestBodyChanged when it changes type, respelled or not', () => {
    const thing: TypeRef = { kind: 'model', name: 'Thing' };
    const old = createPet([['application/json', request]]);
    const next = createPet([['application/json; charset=utf-8', thing]]);
    expect(modified(old, next)).toMatchObject({
      requestBodyChanged: true,
      requestBodyContentTypesChanged: false,
      classification: 'breaking',
    });
    expect(modified(old, next)).not.toHaveProperty('requestBodyContentTypeChange');
  });

  it('is not a media-type change when the body appears or disappears: that is requestBodyChanged alone', () => {
    const none = createPet([], {
      requestBody: undefined,
      requestBodyRequired: undefined,
      requestBodyContentTypes: undefined,
      requestBodyContents: undefined,
    });
    const both = createPet([
      ['application/json', request],
      ['multipart/form-data', upload],
    ]);
    expect(modified(none, both)).toMatchObject({ requestBodyChanged: true, requestBodyContentTypesChanged: false });
    expect(modified(both, none)).toMatchObject({ requestBodyChanged: true, requestBodyContentTypesChanged: false });
  });

  it('reports no change for the same media types in another order, and no change at all for a body without lists', () => {
    const old = createPet([
      ['application/json', request],
      ['application/octet-stream', binary],
    ]);
    // The parser picks the JSON body whatever its position, so `requestBody` stays the JSON entry's object.
    const reordered = createPet(
      [
        ['application/octet-stream', binary],
        ['application/json', request],
      ],
      { requestBody: request },
    );
    expect(modified(old, reordered)).toBeUndefined();
    const listless = createPet([['application/json', request]], {
      requestBodyContentTypes: undefined,
      requestBodyContents: undefined,
    });
    expect(modified(listless, listless)).toBeUndefined();
  });
});

describe('diffSpecs — webhook payload media types, from the receiver side (issue #279)', () => {
  const event: TypeRef = { kind: 'model', name: 'AdoptionEvent' };
  const adoptionEvent: Model = {
    name: 'AdoptionEvent',
    fields: [{ name: 'pet_id', type: { kind: 'primitive', type: 'string' }, required: true }],
  };
  const webhook = (entries: Array<[string, TypeRef]>): Webhook => ({
    name: 'petAdopted',
    httpMethod: 'post',
    headerParams: [],
    queryParams: [],
    requestBody: entries[0]?.[1],
    requestBodyContentTypes: entries.map(([contentType]) => contentType),
    requestBodyContents: contents(entries),
    responses: [{ statusCode: 200 }],
  });
  const spec = (hook: Webhook): ApiSpec => ({
    name: 'Test',
    version: '1',
    baseUrl: '',
    services: [],
    webhooks: [hook],
    models: [adoptionEvent],
    enums: [],
    sdk: defaultSdkBehavior(),
  });
  const jsonOnly = webhook([['application/json', event]]);
  const withText = webhook([
    ['application/json', event],
    ['text/plain', string],
  ]);

  it('reports no change when the payload media type only gains a charset', () => {
    expect(diffSpecs(spec(jsonOnly), spec(webhook([['application/json; charset=utf-8', event]]))).changes).toEqual([]);
  });

  it('reports a media type the sender can newly use as breaking — the handler must decode it', () => {
    const { changes } = diffSpecs(spec(jsonOnly), spec(withText));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'webhook-modified',
      requestBodyChanged: true,
      requestBodyContentTypeChange: { added: ['text/plain'], removed: [], retyped: [], classification: 'breaking' },
      details: 'payload media type text/plain added',
      classification: 'breaking',
    });
  });

  it('reports a media type the sender can no longer use as additive', () => {
    const { changes } = diffSpecs(spec(withText), spec(jsonOnly));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'webhook-modified',
      requestBodyChanged: true,
      requestBodyContentTypeChange: { added: [], removed: ['text/plain'], retyped: [], classification: 'additive' },
      details: 'payload media type text/plain removed',
      classification: 'additive',
    });
  });

  it('reports a secondary payload whose type changed as retyped, breaking, beside the other body details', () => {
    const retyped = webhook([
      ['application/json', event],
      ['text/plain', rows],
    ]);
    const { changes } = diffSpecs(spec(withText), spec({ ...retyped, requestBodyRequired: true }));
    expect(changes[0]).toMatchObject({
      kind: 'webhook-modified',
      requestBodyChanged: true,
      requestBodyContentTypeChange: { added: [], removed: [], retyped: ['text/plain'], classification: 'breaking' },
      details: 'body optional → required; payload media type text/plain retyped',
      classification: 'breaking',
    });
  });
});

describe('parseSpec to diffSpecs — the issue #278 body under application/json; charset=utf-8', () => {
  /** `createPet` with a required `{ name: string }` body under the given media types. */
  const document = (content: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1' },
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: { required: true, content },
          responses: { '204': { description: 'created' } },
        },
      },
    },
  });
  const name = { schema: { type: 'object', properties: { name: { type: 'string' } } } };
  const diffDocuments = async (before: Record<string, unknown>, after: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'oagen-279-request-'));
    try {
      const oldPath = join(dir, 'old.json');
      const newPath = join(dir, 'new.json');
      writeFileSync(oldPath, JSON.stringify(before));
      writeFileSync(newPath, JSON.stringify(after));
      return diffSpecs(await parseSpec(oldPath), await parseSpec(newPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reports no change when the body only gains a charset', async () => {
    const { changes } = await diffDocuments(
      document({ 'application/json': name }),
      document({ 'application/json; charset=utf-8': name }),
    );
    expect(changes).toEqual([]);
  });

  it('reports text/csv added beside the JSON body as additive, and the form body removed as breaking', async () => {
    const added = await diffDocuments(
      document({ 'application/json': name }),
      document({ 'application/json': name, 'text/csv': { schema: { type: 'string' } } }),
    );
    expect(added.changes).toHaveLength(1);
    expect(added.changes[0]).toMatchObject({
      kind: 'operation-modified',
      requestBodyChanged: false,
      requestBodyContentTypeChange: { added: ['text/csv'], removed: [], retyped: [], classification: 'additive' },
      classification: 'additive',
    });
    const removed = await diffDocuments(
      document({ 'application/json': name, 'multipart/form-data': name }),
      document({ 'application/json': name }),
    );
    expect(removed.changes.find((c) => c.kind === 'operation-modified')).toMatchObject({
      requestBodyChanged: false,
      requestBodyContentTypeChange: {
        added: [],
        removed: ['multipart/form-data'],
        retyped: [],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
  });

  /** The JSON body beside two CSV keys, `version=<v>` with the given schema and `version=2`. */
  const versioned = (v: number, properties: Record<string, unknown>) =>
    document({
      'application/json': name,
      [`text/csv; version=${v}`]: { schema: { type: 'object', properties } },
      'text/csv; version=2': { schema: { type: 'object', properties: { cell: { type: 'string' } } } },
    });
  const row = { row: { type: 'string' } };

  it('reports the renamed model and the reparameterized key, not a retype, when a parameter edit on a sibling-distinguished key leaves the schema as it was (Greptile round 3)', async () => {
    const { changes } = await diffDocuments(versioned(1, row), versioned(3, row));
    expect(changes.map((c) => c.kind).sort()).toEqual(['model-added', 'model-removed', 'operation-modified']);
    expect(changes).toContainEqual({
      kind: 'model-removed',
      name: 'CreatePetTextCsvVersion1Request',
      classification: 'breaking',
    });
    expect(changes.find((c) => c.kind === 'operation-modified')).toMatchObject({
      requestBodyChanged: false,
      requestBodyContentTypeChange: {
        added: [],
        removed: [],
        retyped: [],
        reparameterized: [{ from: 'text/csv; version=1', to: 'text/csv; version=3' }],
        classification: 'additive',
      },
      classification: 'additive',
    });
  });

  it('reports a changed version parameter on the body callers send as reparameterized, additive (issue author review)', () => {
    const v1 = createPet([['application/vnd.pets+json; version=1', request]]);
    const v2 = createPet([['application/vnd.pets+json; version=2', request]]);
    expect(modified(v1, v2)).toMatchObject({
      requestBodyChanged: false,
      requestBodyContentTypesChanged: true,
      requestBodyContentTypeChange: {
        added: [],
        removed: [],
        retyped: [],
        reparameterized: [{ from: 'application/vnd.pets+json; version=1', to: 'application/vnd.pets+json; version=2' }],
        classification: 'additive',
      },
      classification: 'additive',
    });
  });

  it('still reports a schema change under a parameter-edited sibling-distinguished key as retyped, breaking', async () => {
    const { changes } = await diffDocuments(versioned(1, row), versioned(3, { ...row, cells: { type: 'integer' } }));
    expect(changes.find((c) => c.kind === 'operation-modified')).toMatchObject({
      requestBodyChanged: false,
      requestBodyContentTypeChange: {
        added: [],
        removed: [],
        retyped: ['text/csv; version=3'],
        classification: 'breaking',
      },
      classification: 'breaking',
    });
  });
});

describe('diffSpecs — a webhook payload model that was only renamed is no media-type change', () => {
  const event: TypeRef = { kind: 'model', name: 'AdoptionEvent' };
  const note = (modelName: string): Model => ({
    name: modelName,
    fields: [{ name: 'text', type: string, required: true }],
  });
  const adoptionEvent: Model = {
    name: 'AdoptionEvent',
    fields: [{ name: 'pet_id', type: string, required: true }],
  };
  const hook = (noteModel: string): Webhook => ({
    name: 'petAdopted',
    httpMethod: 'post',
    headerParams: [],
    queryParams: [],
    requestBody: event,
    requestBodyContentTypes: ['application/json', 'text/plain'],
    requestBodyContents: contents([
      ['application/json', event],
      ['text/plain', { kind: 'model', name: noteModel }],
    ]),
    responses: [{ statusCode: 200 }],
  });
  const spec = (noteModel: string, noteShape: Model): ApiSpec => ({
    name: 'Test',
    version: '1',
    baseUrl: '',
    services: [],
    webhooks: [hook(noteModel)],
    models: [adoptionEvent, noteShape],
    enums: [],
    sdk: defaultSdkBehavior(),
  });

  it('reports the rename through the models diff only', () => {
    const { changes } = diffSpecs(spec('OldNote', note('OldNote')), spec('NewNote', note('NewNote')));
    expect(changes.map((c) => c.kind).sort()).toEqual(['model-added', 'model-removed']);
  });

  it('reports a payload whose media type only changed a parameter other than charset as reparameterized, additive', () => {
    const respelled: Webhook = {
      ...hook('OldNote'),
      requestBodyContentTypes: ['application/json; charset=utf-8', 'text/plain; format=flowed'],
      requestBodyContents: contents([
        ['application/json; charset=utf-8', event],
        ['text/plain; format=flowed', { kind: 'model', name: 'OldNote' }],
      ]),
    };
    const { changes } = diffSpecs(spec('OldNote', note('OldNote')), {
      ...spec('OldNote', note('OldNote')),
      webhooks: [respelled],
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'webhook-modified',
      requestBodyChanged: true,
      requestBodyContentTypeChange: {
        added: [],
        removed: [],
        retyped: [],
        reparameterized: [{ from: 'text/plain', to: 'text/plain; format=flowed' }],
        classification: 'additive',
      },
      details: 'payload media type text/plain → text/plain; format=flowed',
      classification: 'additive',
    });
  });

  it('reports a payload whose shape changed as retyped, breaking', () => {
    const changed: Model = { ...note('NewNote'), fields: [{ name: 'text', type: string, required: false }] };
    const { changes } = diffSpecs(spec('OldNote', note('OldNote')), spec('NewNote', changed));
    expect(changes.find((c) => c.kind === 'webhook-modified')).toMatchObject({
      requestBodyChanged: true,
      requestBodyContentTypeChange: { added: [], removed: [], retyped: ['text/plain'], classification: 'breaking' },
      details: 'payload media type text/plain retyped',
      classification: 'breaking',
    });
  });
});
