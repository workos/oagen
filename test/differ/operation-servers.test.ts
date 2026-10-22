import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { diffOperations, type DocumentServers } from '../../src/differ/operations.js';
import { diffServices } from '../../src/differ/services.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { Change } from '../../src/differ/types.js';
import type { ApiSpec, Operation, ServerEntry } from '../../src/ir/types.js';

/**
 * Covers `serversChanged` on `operation-modified` (issue #251): where an
 * operation is actually served from — `op.servers ?? document servers` on each
 * side — compared by the document-level rule (templates plus variables,
 * descriptions and order ignored, a moved first entry counts), every change
 * breaking because the operation's requests go elsewhere.
 */
const listPets: Operation = {
  name: 'listPets',
  httpMethod: 'get',
  path: '/pets',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'array', items: { kind: 'model', name: 'Pet' } },
  errors: [],
  injectIdempotencyKey: false,
};

const api: ServerEntry[] = [{ url: 'https://api.example.com', description: 'API' }];
const pets: ServerEntry[] = [{ url: 'https://pets.example.com', description: 'Pets' }];
const other: ServerEntry[] = [{ url: 'https://other.example.com' }];
const regional: ServerEntry[] = [
  { url: 'https://{region}.pets.example.com', variables: { region: { default: 'eu', enum: ['eu', 'us'] } } },
];

/** `listPets` carrying `servers`, or inheriting (no key) when none is given. */
function withServers(servers?: ServerEntry[]): Operation {
  return servers ? { ...listPets, servers } : listPets;
}

function documents(oldServers: ServerEntry[] | undefined, newServers: ServerEntry[] | undefined): DocumentServers {
  return { old: oldServers, new: newServers };
}

/** The one `operation-modified` change for `listPets`, or `undefined` when nothing changed. */
function change(changes: Change[]) {
  expect(changes.length).toBeLessThanOrEqual(1);
  return changes[0];
}

describe('diffOperations – servers (issue #251)', () => {
  describe('without the documents (a direct caller)', () => {
    it('reports an operation gaining its own servers as breaking', () => {
      const changes = diffOperations('Pets', [withServers()], [withServers(pets)]);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        kind: 'operation-modified',
        operationName: 'listPets',
        serversChanged: true,
        classification: 'breaking',
      });
    });

    it('reports an operation losing its own servers as breaking', () => {
      expect(change(diffOperations('Pets', [withServers(pets)], [withServers()]))).toMatchObject({
        serversChanged: true,
        classification: 'breaking',
      });
    });

    it('reports a changed list as breaking', () => {
      expect(change(diffOperations('Pets', [withServers(pets)], [withServers(regional)]))).toMatchObject({
        serversChanged: true,
        classification: 'breaking',
      });
    });

    it('reports nothing when both sides inherit', () => {
      expect(diffOperations('Pets', [withServers()], [withServers()])).toHaveLength(0);
      // An explicit undefined is the same as an absent key.
      expect(diffOperations('Pets', [{ ...listPets, servers: undefined }], [withServers()])).toHaveLength(0);
    });

    it('reports nothing when both sides carry the same list', () => {
      // Equal by structure, not by identity: each parse builds its own objects.
      const again: ServerEntry[] = [
        { url: 'https://{region}.pets.example.com', variables: { region: { default: 'eu', enum: ['eu', 'us'] } } },
      ];
      expect(diffOperations('Pets', [withServers(regional)], [withServers(again)])).toHaveLength(0);
    });
  });

  describe('against the documents (as diffSpecs calls it)', () => {
    it('ignores a document that moved to where the operation already pointed', () => {
      // Before: the document is api, listPets declares pets (so `servers` is
      // set). After: the document is pets, listPets still declares pets (so
      // the parser leaves `servers` off). Served from pets both times.
      const changes = diffOperations('Pets', [withServers(pets)], [withServers()], documents(api, pets));
      expect(changes).toHaveLength(0);
    });

    it('ignores an override that equals what the operation was already served from', () => {
      // The document moves away, and the operation pins the old host.
      expect(diffOperations('Pets', [withServers()], [withServers(pets)], documents(pets, api))).toHaveLength(0);
      // The document stays, and the operation restates it (a description
      // makes the parser set the field).
      const restated: ServerEntry[] = [{ url: 'https://api.example.com', description: 'Same host' }];
      expect(diffOperations('Pets', [withServers()], [withServers(restated)], documents(api, api))).toHaveLength(0);
    });

    it('reports an override lost while the document now points elsewhere', () => {
      expect(change(diffOperations('Pets', [withServers(pets)], [withServers()], documents(api, other)))).toMatchObject(
        { serversChanged: true, classification: 'breaking' },
      );
    });

    it('reports an override that changed while the document did not', () => {
      expect(
        change(diffOperations('Pets', [withServers(pets)], [withServers(regional)], documents(api, api))),
      ).toMatchObject({ serversChanged: true, classification: 'breaking' });
    });

    it('leaves a moved document to the document-level diff when the operation inherits on both sides', () => {
      expect(diffOperations('Pets', [withServers()], [withServers()], documents(api, other))).toHaveLength(0);
    });

    it('treats a document without servers as none', () => {
      expect(diffOperations('Pets', [withServers(pets)], [withServers()], documents(undefined, pets))).toHaveLength(0);
      expect(
        change(diffOperations('Pets', [withServers(pets)], [withServers()], documents(undefined, undefined))),
      ).toMatchObject({ serversChanged: true });
    });
  });

  describe('what counts as a change', () => {
    const a: ServerEntry = { url: 'https://a.example.com' };
    const b: ServerEntry = { url: 'https://b.example.com' };
    const c: ServerEntry = { url: 'https://c.example.com' };

    it('ignores a changed server description', () => {
      const described = withServers([{ url: 'https://pets.example.com', description: 'Pet store' }]);
      expect(diffOperations('Pets', [withServers(pets)], [described])).toHaveLength(0);
      // Absent and present descriptions alike.
      expect(
        diffOperations('Pets', [withServers(pets)], [withServers([{ url: 'https://pets.example.com' }])]),
      ).toHaveLength(0);
    });

    it('ignores a changed variable description and a reordered enum', () => {
      const described = withServers([
        {
          url: 'https://{region}.pets.example.com',
          variables: { region: { default: 'eu', enum: ['eu', 'us'], description: 'Where the pets live.' } },
        },
      ]);
      expect(diffOperations('Pets', [withServers(regional)], [described])).toHaveLength(0);

      const reorderedEnum = withServers([
        { url: 'https://{region}.pets.example.com', variables: { region: { default: 'eu', enum: ['us', 'eu'] } } },
      ]);
      expect(diffOperations('Pets', [withServers(regional)], [reorderedEnum])).toHaveLength(0);
    });

    it('ignores a repeated enum value appearing or disappearing: the values are a set (Greptile)', () => {
      const repeated = withServers([
        {
          url: 'https://{region}.pets.example.com',
          variables: { region: { default: 'eu', enum: ['eu', 'eu', 'us'] } },
        },
      ]);
      expect(diffOperations('Pets', [repeated], [withServers(regional)])).toHaveLength(0);
      expect(diffOperations('Pets', [withServers(regional)], [repeated])).toHaveLength(0);
    });

    it('ignores a reordered list that keeps the same first entry', () => {
      expect(diffOperations('Pets', [withServers([a, b, c])], [withServers([a, c, b])])).toHaveLength(0);
    });

    it('reports a reorder that moves the first entry', () => {
      expect(change(diffOperations('Pets', [withServers([a, b])], [withServers([b, a])]))).toMatchObject({
        serversChanged: true,
        classification: 'breaking',
      });
    });

    it('ignores a reorder whose first entries resolve to the same URL', () => {
      const templated: ServerEntry = { url: 'https://{host}.example.com', variables: { host: { default: 'a' } } };
      expect(diffOperations('Pets', [withServers([templated, a])], [withServers([a, templated])])).toHaveLength(0);
    });

    it('reports a changed variable default, a new enum value, a new variable and a changed template', () => {
      const otherDefault = withServers([
        { url: 'https://{region}.pets.example.com', variables: { region: { default: 'us', enum: ['eu', 'us'] } } },
      ]);
      expect(change(diffOperations('Pets', [withServers(regional)], [otherDefault]))).toMatchObject({
        serversChanged: true,
      });

      // Additive at the document level (`variable-enum-value-added`), but one
      // boolean cannot say so.
      const widerEnum = withServers([
        {
          url: 'https://{region}.pets.example.com',
          variables: { region: { default: 'eu', enum: ['eu', 'us', 'ap'] } },
        },
      ]);
      expect(change(diffOperations('Pets', [withServers(regional)], [widerEnum]))).toMatchObject({
        serversChanged: true,
      });

      const extraVariable = withServers([
        {
          url: 'https://{region}.pets.example.com',
          variables: { region: { default: 'eu', enum: ['eu', 'us'] }, tenant: { default: 'acme' } },
        },
      ]);
      expect(change(diffOperations('Pets', [withServers(regional)], [extraVariable]))).toMatchObject({
        serversChanged: true,
      });

      const liftedEnum = withServers([
        { url: 'https://{region}.pets.example.com', variables: { region: { default: 'eu' } } },
      ]);
      expect(change(diffOperations('Pets', [withServers(regional)], [liftedEnum]))).toMatchObject({
        serversChanged: true,
      });

      const retemplated = withServers([
        { url: 'https://{region}.pets.example.net', variables: { region: { default: 'eu', enum: ['eu', 'us'] } } },
      ]);
      expect(change(diffOperations('Pets', [withServers(regional)], [retemplated]))).toMatchObject({
        serversChanged: true,
      });
    });

    it('reports an entry added or removed after the first, as a multiset', () => {
      expect(change(diffOperations('Pets', [withServers([a])], [withServers([a, b])]))).toMatchObject({
        serversChanged: true,
      });
      expect(change(diffOperations('Pets', [withServers([a, b])], [withServers([a])]))).toMatchObject({
        serversChanged: true,
      });
      // A duplicate is one more entry, not the same list.
      expect(change(diffOperations('Pets', [withServers([a, b])], [withServers([a, b, b])]))).toMatchObject({
        serversChanged: true,
      });
    });

    it('ignores a scheme or host that only changed case, a default port and a `/` after a bare authority (issue #293)', () => {
      const notes: ServerEntry[] = [{ url: 'https://notes.example.com' }];
      for (const url of [
        'https://NOTES.example.com',
        'HTTPS://notes.example.com',
        'https://notes.example.com:443',
        'https://notes.example.com/',
      ]) {
        expect(
          diffOperations('Pets', [withServers(notes)], [withServers([{ url }])], documents(api, api)),
          url,
        ).toEqual([]);
      }
      // An override that restates the new document's server in another case
      // is where the operation was already served from.
      expect(
        diffOperations(
          'Pets',
          [withServers()],
          [withServers([{ url: 'https://API.example.com' }])],
          documents(api, api),
        ),
      ).toEqual([]);
      // A lost override while the document moved to the same host in another
      // spelling: the operation is served from the same place as before.
      expect(
        diffOperations(
          'Pets',
          [withServers(notes)],
          [withServers()],
          documents(api, [{ url: 'https://NOTES.example.com:443/' }]),
        ),
      ).toEqual([]);
    });

    it('still reports a path that changed case and a port that is not the default (issue #293)', () => {
      const v1: ServerEntry[] = [{ url: 'https://notes.example.com/v1' }];
      expect(
        change(diffOperations('Pets', [withServers(v1)], [withServers([{ url: 'https://notes.example.com/V1' }])])),
      ).toMatchObject({ serversChanged: true, classification: 'breaking' });
      expect(
        change(
          diffOperations('Pets', [withServers(v1)], [withServers([{ url: 'https://notes.example.com:8443/v1' }])]),
        ),
      ).toMatchObject({ serversChanged: true, classification: 'breaking' });
    });

    it('compares a variable named like an Object.prototype member by its own key', () => {
      // Own data properties, as the parser builds them (never set through `obj[name] = …`).
      const withProto = (defaultValue: string): ServerEntry[] => [
        {
          url: 'https://{__proto__}.example.com/{constructor}',
          variables: Object.fromEntries([
            ['__proto__', { default: defaultValue }],
            ['constructor', { default: 'ctor' }],
          ]),
        },
      ];
      expect(diffOperations('Pets', [withServers(withProto('eu'))], [withServers(withProto('eu'))])).toHaveLength(0);
      expect(
        change(diffOperations('Pets', [withServers(withProto('eu'))], [withServers(withProto('us'))])),
      ).toMatchObject({ serversChanged: true });
    });
  });

  it('keeps the flag false on an unrelated change', () => {
    const retyped: Operation = { ...withServers(pets), response: { kind: 'model', name: 'PetPage' } };
    const changes = diffOperations('Pets', [withServers(pets)], [retyped]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ responseChanged: true, serversChanged: false });
  });

  it('is breaking even when every other change is additive', () => {
    const relaxed: Operation = {
      ...listPets,
      queryParams: [{ name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false }],
    };
    expect(diffOperations('Pets', [listPets], [relaxed])[0]).toMatchObject({ classification: 'additive' });
    expect(diffOperations('Pets', [listPets], [{ ...relaxed, servers: pets }])[0]).toMatchObject({
      serversChanged: true,
      classification: 'breaking',
    });
  });

  describe('through diffServices and diffSpecs', () => {
    function spec(servers: ServerEntry[] | undefined, op: Operation): ApiSpec {
      return {
        name: 'Pets',
        version: '1',
        baseUrl: servers?.[0]?.url ?? '',
        servers,
        services: [{ name: 'Pets', operations: [op] }],
        models: [],
        enums: [],
        sdk: defaultSdkBehavior(),
      };
    }
    const operationChanges = (changes: Change[]) => changes.filter((c) => c.kind === 'operation-modified');

    it('threads the documents through diffServices', () => {
      const oldServices = [{ name: 'Pets', operations: [withServers(pets)] }];
      const newServices = [{ name: 'Pets', operations: [withServers()] }];
      // Without the documents the lost override is a change; with them it is
      // the document catching up with the operation.
      expect(operationChanges(diffServices(oldServices, newServices))).toHaveLength(1);
      expect(operationChanges(diffServices(oldServices, newServices, documents(api, pets)))).toHaveLength(0);
    });

    it('reports no operation change for a document that moved to where the operation pointed', () => {
      const report = diffSpecs(spec(api, withServers(pets)), spec(pets, withServers()));
      expect(operationChanges(report.changes)).toHaveLength(0);
    });

    it('reports the operation when its override is lost and the document points elsewhere', () => {
      const report = diffSpecs(spec(api, withServers(pets)), spec(other, withServers()));
      expect(operationChanges(report.changes)).toHaveLength(1);
      expect(operationChanges(report.changes)[0]).toMatchObject({ serversChanged: true, classification: 'breaking' });
      expect(report.summary.breaking).toBeGreaterThanOrEqual(1);
    });

    it("reports nothing for an operation server whose host only changed case (issue #293's comment, end to end)", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-op-servers-'));
      try {
        const document = (notesUrl: string) => `
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
paths:
  /notes:
    get:
      operationId: listNotes
      servers:
        - url: ${notesUrl}
      responses: { '204': { description: ok } }
`;
        const oldFile = path.join(tmpDir, 'old.yml');
        const newFile = path.join(tmpDir, 'new.yml');
        await fs.writeFile(oldFile, document('https://notes.example.com'), 'utf-8');
        await fs.writeFile(newFile, document('https://NOTES.example.com'), 'utf-8');
        const [oldSpec, newSpec] = await Promise.all([parseSpec(oldFile), parseSpec(newFile)]);
        // The IR keeps each spelling as written; only the comparison folds it.
        expect(newSpec.services[0].operations[0].servers).toEqual([
          { url: 'https://NOTES.example.com', description: undefined },
        ]);
        expect(diffSpecs(oldSpec, newSpec).changes).toEqual([]);
        expect(diffSpecs(newSpec, oldSpec).changes).toEqual([]);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * OpenAPI's default server at operation level (issue #291, the comment): an
 * operation that writes `/` out and one that inherits a document without
 * servers are served from the same place, so neither is a change to the other.
 */
describe("diffOperations – servers: OpenAPI's default (issue #291)", () => {
  const fixtures = resolve(import.meta.dirname, '../fixtures');
  const root: ServerEntry[] = [{ url: '/' }];
  const described: ServerEntry[] = [{ url: '/', description: 'Same origin' }];

  it('reports nothing when an operation gains or loses `/` written out under documents without servers', () => {
    expect(diffOperations('Pets', [withServers()], [withServers(root)], documents(undefined, undefined))).toHaveLength(
      0,
    );
    expect(diffOperations('Pets', [withServers(root)], [withServers()], documents(undefined, undefined))).toHaveLength(
      0,
    );
  });

  it('reports nothing without the documents either: no servers is the default', () => {
    expect(diffOperations('Pets', [withServers()], [withServers(root)])).toHaveLength(0);
    expect(diffOperations('Pets', [withServers(root)], [withServers()])).toHaveLength(0);
  });

  it('reports nothing when the document writes `/` out on one side and declares nothing on the other', () => {
    expect(diffOperations('Pets', [withServers(root)], [withServers()], documents(undefined, root))).toHaveLength(0);
    expect(diffOperations('Pets', [withServers()], [withServers(root)], documents(root, undefined))).toHaveLength(0);
  });

  it('ignores a description on the `/` entry, as on any server', () => {
    expect(
      diffOperations('Pets', [withServers()], [withServers(described)], documents(undefined, undefined)),
    ).toHaveLength(0);
    expect(
      diffOperations('Pets', [withServers(described)], [withServers(root)], documents(undefined, undefined)),
    ).toHaveLength(0);
  });

  it('reports an operation that moves from `/` written out to a named host, and back', () => {
    expect(
      change(diffOperations('Pets', [withServers(root)], [withServers(pets)], documents(undefined, undefined))),
    ).toMatchObject({ kind: 'operation-modified', serversChanged: true, classification: 'breaking' });
    expect(
      change(diffOperations('Pets', [withServers(pets)], [withServers(root)], documents(undefined, undefined))),
    ).toMatchObject({ kind: 'operation-modified', serversChanged: true, classification: 'breaking' });
  });

  it('reports an operation that gains `/` under a document that names a host', () => {
    expect(change(diffOperations('Pets', [withServers()], [withServers(root)], documents(api, api)))).toMatchObject({
      kind: 'operation-modified',
      serversChanged: true,
      classification: 'breaking',
    });
  });

  it('reports an operation that keeps `/` while its document moves from nothing to a named host', () => {
    // Served from `/` on both sides; the document-level diff reports the document.
    expect(diffOperations('Pets', [withServers(root)], [withServers(root)], documents(undefined, api))).toHaveLength(0);
    // Inherits on both sides: the document-level diff's to report, as before.
    expect(diffOperations('Pets', [withServers()], [withServers()], documents(undefined, api))).toHaveLength(0);
  });

  describe("the comment's documents", () => {
    it('reports no change when an operation writes `/` out under a document without servers', async () => {
      const [none, slash] = await Promise.all([
        parseSpec(resolve(fixtures, 'servers-default-operation-none.json')),
        parseSpec(resolve(fixtures, 'servers-default-operation-root.json')),
      ]);
      expect(slash.servers).toBeUndefined();
      expect(slash.services[0].operations[0].servers).toBeUndefined();

      expect(diffSpecs(none, slash).changes).toEqual([]);
      expect(diffSpecs(slash, none).changes).toEqual([]);
    });
  });
});
