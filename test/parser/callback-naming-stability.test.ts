import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * Issue #382: one edit to a document must never rename the public types of
 * a callback or webhook the edit did not touch. Each row pairs a document
 * this work pinned with one edit — a direct reference to a shared component
 * added, a nested reference, a nested key-named callback, a callback with a
 * colliding operationId, two paths reordered, two webhook keys reordered —
 * parses both and asserts that `oagen diff` removes no model and modifies no
 * node the edit left alone, and that every model name of the base is still
 * there. The one documented exception, listed per row as `renamed`: an edit
 * adding a group whose plain stem collides with an existing plain stem
 * hashes both, as the `webhooks` map does, and the callback whose payload
 * moved is reported modified.
 */

type Document = Record<string, unknown>;
type Change = ReturnType<typeof diffSpecs>['changes'][number];

const ok = { '200': { description: 'OK' } };
const petIdSchema = { type: 'object', properties: { petId: { type: 'string' } } };
const flag = (name: string) => ({ type: 'object', properties: { [name]: { type: 'boolean' } } });

/** A Callback Object: one runtime-expression path item whose POST carries `schema`, with `extra` on the operation. */
function posting(schema: unknown = petIdSchema, extra: Record<string, unknown> = {}) {
  return {
    '{$request.body#/callbackUrl}': {
      post: { ...extra, requestBody: { content: { 'application/json': { schema } } }, responses: ok },
    },
  };
}

/** An operation acknowledging with a bare 200, declaring `callbacks` when given. */
function op(operationId: string, callbacks?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { operationId, ...extra, responses: ok, ...(callbacks ? { callbacks } : {}) };
}

function document(openapi: string, paths: Record<string, unknown>, rest: Record<string, unknown> = {}): Document {
  return { openapi, info: { title: 'repro', version: '1' }, paths, ...rest };
}

/** The operation at `paths[route].post` of a document, to edit in place. */
function postOf(doc: Document, route: string): Record<string, unknown> {
  return (doc.paths as Record<string, { post: Record<string, unknown> }>)[route]!.post;
}

/** The callback operation `key` of `operation`, under the one expression `posting` writes, to edit in place. */
function callbackOpOf(operation: Record<string, unknown>, key: string): Record<string, unknown> {
  const callbacks = operation.callbacks as Record<string, Record<string, { post: Record<string, unknown> }>>;
  return callbacks[key]!['{$request.body#/callbackUrl}']!.post;
}

const reference = (name: string) => ({ $ref: `#/components/callbacks/${name}` });
/** A title-mapped union: every variant titled and pinning `kind`, the first titled `title` with `own` fields. */
const titledUnion = (title: string, own: Record<string, unknown>, other: string) => {
  const titled = (name: string, value: string, fields: Record<string, unknown>) => ({
    title: name,
    type: 'object',
    properties: { kind: { type: 'string', const: value }, ...fields },
  });
  return { oneOf: [titled(title, 'first', own), titled(other, 'second', { text: { type: 'string' } })] };
};
/** `titledUnion` with the first variant titled `Shape`. */
const shaped = (own: Record<string, unknown>, other: string) => titledUnion('Shape', own, other);
const adopted = { Adopted: posting(flag('adopted'), { operationId: 'notifyAdoption' }) };
const read = { Read: posting(flag('read')) };

interface Row {
  name: string;
  base: (openapi: string) => Document;
  /** Edits a deep copy of the base in place. */
  edit: (doc: Document) => void;
  /** The base's model names the edit is documented to rename: an added plain stem colliding with an existing one hashes both. */
  renamed?: string[];
  /** The `*-modified` changes the edit is documented to cause, as `kind name`. */
  touched?: string[];
  /** The edit reorders only: the diff is empty. */
  reorder?: boolean;
  /** The warnings the two parses print — a cycle guard's — none by default; a "more than one definition" is never one. */
  warnings?: number;
}

const rows: Row[] = [
  {
    name: 'a nested key-named callback added',
    base: (openapi) => document(openapi, { '/pets': { post: op('createPet', { petAdopted: posting() }) } }),
    edit: (doc) => {
      callbackOpOf(postOf(doc, '/pets'), 'petAdopted').callbacks = { confirmed: posting(flag('ok')) };
    },
  },
  {
    name: "a nested key-named callback added that asks for the parent's parameter model name",
    base: (openapi) =>
      document(openapi, {
        '/pets': {
          post: op('createPet', {
            petAdopted: posting(petIdSchema, {
              parameters: [
                {
                  name: 'confirmedPayload',
                  in: 'query',
                  schema: { type: 'object', properties: { at: { type: 'string' } } },
                },
              ],
            }),
          }),
        },
      }),
    edit: (doc) => {
      callbackOpOf(postOf(doc, '/pets'), 'petAdopted').callbacks = { confirmed: posting(flag('ok')) };
    },
  },
  {
    name: 'a direct reference to a shared component added beside a nested one',
    base: (openapi) =>
      document(
        openapi,
        {
          '/events': { post: op('registerEvent') },
          '/pets': {
            post: op('createPet', {
              events: posting(petIdSchema, { operationId: 'register_event', callbacks: { read: reference('Read') } }),
            }),
          },
        },
        { components: { callbacks: read } },
      ),
    edit: (doc) => {
      postOf(doc, '/events').callbacks = { read: reference('Read') };
    },
  },
  {
    name: 'a nested reference to a shared component added beside a direct one',
    base: (openapi) =>
      document(
        openapi,
        {
          '/events': { post: op('registerEvent', { read: reference('Read') }) },
          '/pets': { post: op('createPet', { events: posting(petIdSchema, { operationId: 'register_event' }) }) },
        },
        { components: { callbacks: read } },
      ),
    edit: (doc) => {
      callbackOpOf(postOf(doc, '/pets'), 'events').callbacks = { read: reference('Read') };
    },
  },
  {
    name: 'a direct reference added to a nested group whose stem a direct callback shares',
    base: (openapi) =>
      document(
        openapi,
        {
          '/pets': { post: op('createPet', { petAdopted: posting(petIdSchema, { operationId: 'notify_adoption' }) }) },
          '/registrations': {
            post: op('registerPet', {
              registered: posting(petIdSchema, { callbacks: { adopted: reference('Adopted') } }),
            }),
          },
        },
        { components: { callbacks: adopted } },
      ),
    edit: (doc) => {
      (postOf(doc, '/registrations').callbacks as Record<string, unknown>).adopted = reference('Adopted');
    },
  },
  {
    name: 'a nested reference added inside a direct callback whose stem the referenced one shares',
    base: (openapi) =>
      document(
        openapi,
        {
          '/pets': { post: op('createPet', { petAdopted: posting(petIdSchema, { operationId: 'notify_adoption' }) }) },
          '/adoptions': { post: op('adoptPet', { adopted: reference('Adopted') }) },
        },
        { components: { callbacks: adopted } },
      ),
    edit: (doc) => {
      callbackOpOf(postOf(doc, '/pets'), 'petAdopted').callbacks = { adopted: reference('Adopted') };
    },
  },
  {
    name: 'a nested key-named callback added to a shared callback operation two operations reference',
    base: (openapi) =>
      document(
        openapi,
        {
          '/notes': { post: op('createNote', { noteAdded: reference('NoteAdded') }) },
          '/comments': { post: op('createComment', { noteAdded: reference('NoteAdded') }) },
        },
        { components: { callbacks: { NoteAdded: posting(flag('added'), { operationId: 'onNoteAdded' }) } } },
      ),
    edit: (doc) => {
      const callbacks = (doc.components as { callbacks: Record<string, unknown> }).callbacks;
      callbackOpOf({ callbacks }, 'NoteAdded').callbacks = { noteRead: posting(flag('read')) };
    },
  },
  {
    name: 'a direct callback added under a fresh stem',
    base: (openapi) => document(openapi, { '/pets': { post: op('createPet', { petAdopted: posting() }) } }),
    edit: (doc) => {
      (postOf(doc, '/pets').callbacks as Record<string, unknown>).petReturned = posting(flag('returned'));
    },
  },
  {
    name: 'a callback added whose operationId cleans to an existing stem (the documented exception)',
    base: (openapi) =>
      document(openapi, {
        '/pets': { post: op('createPet', { petAdopted: posting(petIdSchema, { operationId: 'notify_adoption' }) }) },
      }),
    edit: (doc) => {
      (doc.paths as Record<string, unknown>)['/adoptions'] = {
        post: op('adoptPet', { adopted: posting(flag('adopted'), { operationId: 'notifyAdoption' }) }),
      };
    },
    renamed: ['NotifyAdoptionPayload'],
    touched: ['callback-modified petAdopted'],
  },
  {
    name: 'two shared callbacks made to nest each other',
    base: (openapi) =>
      document(
        openapi,
        {
          '/pets': {
            post: op('createPet', { petEvent: reference('PetEvent'), returnedPetEvent: reference('ReturnedPetEvent') }),
          },
        },
        {
          components: {
            callbacks: {
              PetEvent: posting(
                {
                  oneOf: [
                    { type: 'object', properties: { kind: { const: 'adopted' }, pet_id: { type: 'string' } } },
                    { type: 'object', properties: { kind: { const: 'returned' }, pet_id: { type: 'string' } } },
                  ],
                  discriminator: { propertyName: 'kind' },
                },
                { operationId: 'petEvent' },
              ),
              ReturnedPetEvent: posting(
                { type: 'object', properties: { reason: { type: 'string' } } },
                { operationId: 'returnedPetEvent' },
              ),
            },
          },
        },
      ),
    edit: (doc) => {
      const callbacks = (doc.components as { callbacks: Record<string, unknown> }).callbacks;
      callbackOpOf({ callbacks }, 'PetEvent').callbacks = { returnedPetEvent: reference('ReturnedPetEvent') };
      callbackOpOf({ callbacks }, 'ReturnedPetEvent').callbacks = { petEvent: reference('PetEvent') };
    },
    // The cycle guard stops each nested walk one level down, with a warning each.
    warnings: 2,
  },
  {
    name: 'two callbacks with identical title-mapped variants reordered',
    base: (openapi) =>
      document(openapi, {
        '/pets': {
          post: op('createPet', {
            petAdopted: posting(shaped({ sides: { type: 'integer' } }, 'Note')),
            petReturned: posting(shaped({ sides: { type: 'integer' } }, 'Memo')),
          }),
        },
      }),
    edit: (doc) => {
      const callbacks = postOf(doc, '/pets').callbacks as Record<string, unknown>;
      postOf(doc, '/pets').callbacks = { petReturned: callbacks.petReturned, petAdopted: callbacks.petAdopted };
    },
    reorder: true,
  },
  {
    name: 'two callbacks with differing title-mapped variants reordered',
    base: (openapi) =>
      document(openapi, {
        '/pets': {
          post: op('createPet', {
            petAdopted: posting(shaped({ sides: { type: 'integer' } }, 'Note')),
            petReturned: posting(shaped({ radius: { type: 'number' } }, 'Memo')),
          }),
        },
      }),
    edit: (doc) => {
      const callbacks = postOf(doc, '/pets').callbacks as Record<string, unknown>;
      postOf(doc, '/pets').callbacks = { petReturned: callbacks.petReturned, petAdopted: callbacks.petAdopted };
    },
    reorder: true,
  },
  {
    name: 'four callbacks reordered, two pairs of differing variants, one pair titled with the name the other pair takes',
    base: (openapi) =>
      document(openapi, {
        '/pets': {
          post: op('createPet', {
            a: posting(titledUnion('Shape', { sides: { type: 'integer' } }, 'Note')),
            b: posting(titledUnion('Shape', { radius: { type: 'number' } }, 'Memo')),
            c: posting(titledUnion('CreatePetAShape', { width: { type: 'number' } }, 'Tag')),
            d: posting(titledUnion('CreatePetAShape', { height: { type: 'number' } }, 'Label')),
          }),
        },
      }),
    edit: (doc) => {
      const { a, b, c, d } = postOf(doc, '/pets').callbacks as Record<string, unknown>;
      postOf(doc, '/pets').callbacks = { c, d, a, b };
    },
    reorder: true,
  },
  {
    name: 'a callback nested under the last of four whose variant titles collide across pairs',
    base: (openapi) =>
      document(openapi, {
        '/pets': {
          post: op('createPet', {
            c: posting(titledUnion('CreatePetAShape', { width: { type: 'number' } }, 'Tag')),
            d: posting(titledUnion('CreatePetAShape', { height: { type: 'number' } }, 'Label')),
            a: posting(titledUnion('Shape', { sides: { type: 'integer' } }, 'Note')),
            b: posting(titledUnion('Shape', { radius: { type: 'number' } }, 'Memo')),
          }),
        },
      }),
    edit: (doc) => {
      callbackOpOf(postOf(doc, '/pets'), 'd').callbacks = { e: posting(flag('seen')) };
    },
  },
  {
    name: 'two paths reordered',
    base: (openapi) =>
      document(
        openapi,
        {
          '/pets': { post: op('createPet', { petAdopted: posting(petIdSchema, { operationId: 'notify_adoption' }) }) },
          '/events': {
            post: op('registerEvent', { read: reference('Read'), adopted: reference('Adopted') }),
          },
        },
        { components: { callbacks: { ...read, ...adopted } } },
      ),
    edit: (doc) => {
      const paths = doc.paths as Record<string, unknown>;
      doc.paths = { '/events': paths['/events'], '/pets': paths['/pets'] };
    },
    reorder: true,
  },
  {
    name: 'two webhook keys reordered',
    base: (openapi) =>
      document(
        openapi,
        {},
        {
          webhooks: {
            petReturned: { post: { responses: ok, callbacks: { acknowledged: posting(flag('seen')) } } },
            petAdopted: {
              post: {
                responses: ok,
                callbacks: { acknowledged: posting(flag('seen'), { operationId: 'notify_adoption' }) },
              },
            },
          },
        },
      ),
    edit: (doc) => {
      const webhooks = doc.webhooks as Record<string, unknown>;
      doc.webhooks = { petAdopted: webhooks.petAdopted, petReturned: webhooks.petReturned };
    },
    reorder: true,
  },
];

/** `kind name` of a change, the name being the callback's, operation's, webhook's or model's. */
function label(change: Change): string {
  const name =
    'operationName' in change && change.kind.startsWith('operation')
      ? change.operationName
      : 'webhookName' in change && change.kind.startsWith('webhook')
        ? change.webhookName
        : 'name' in change
          ? change.name
          : '';
  return `${change.kind} ${name}`;
}

describe('#382 naming stability under one edit', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-callback-stability-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function parse(doc: Document, file: string): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, file);
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  describe.each(['3.0.3', '3.1.0'])('OpenAPI %s', (openapi) => {
    it.each(rows)('$name renames nothing the edit left alone', async (row) => {
      const before = row.base(openapi);
      const after = structuredClone(before);
      row.edit(after);
      const base = await parse(before, 'base.json');
      const edited = await parse(after, 'edited.json');
      expect(warn.mock.calls).toHaveLength(row.warnings ?? 0);
      for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('more than one definition');

      const { changes } = diffSpecs(base, edited);
      if (row.reorder) {
        expect(changes).toEqual([]);
        return;
      }
      const removed = changes.filter((change) => change.kind === 'model-removed').map(label);
      expect(removed.sort()).toEqual((row.renamed ?? []).map((name) => `model-removed ${name}`).sort());
      const modified = changes.filter((change) => change.kind.endsWith('-modified')).map(label);
      expect(modified.sort()).toEqual([...(row.touched ?? [])].sort());

      const after_ = new Set(edited.models.map((m) => m.name));
      for (const { name } of base.models) {
        if (!(row.renamed ?? []).includes(name)) expect(after_.has(name), name).toBe(true);
      }
    });
  });
});
