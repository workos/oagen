import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #627: two distinct `operationId`s that clean to one stem — `createPet`
 * beside `create_pet`, `CreatePet` or `createPetController` (`Controller` is
 * stripped) — named the same inline `…Request` and `…Response` models, so the
 * merge kept the first definition for both with a warning, one operation was
 * typed with fields it does not take, and which one followed the order of
 * the paths. Now the operation whose id is spelled as the stem (`createPet`
 * for `CreatePet`) keeps the stem and the plain names, and every other one
 * is path-named, as a reused id's later operation is (#481): two request
 * models and two response models, each operation typed with its own fields,
 * whatever the order of the paths.
 */

describe('#627', () => {
  const str = { type: 'string' };
  const int = { type: 'integer' };
  type Schema = Record<string, unknown>;
  const body = (properties: Record<string, Schema>): Schema => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
  });
  const json = (schema: Schema) => ({ content: { 'application/json': { schema } } });
  /** An operation with a JSON request body and a `201` JSON response, every property required. */
  const operation = (
    operationId: string,
    request: Record<string, Schema>,
    response: Record<string, Schema>,
    extra: Record<string, unknown> = {},
  ) => ({
    operationId,
    ...extra,
    requestBody: { required: true, ...json(body(request)) },
    responses: { '201': { description: 'Created', ...json(body(response)) } },
  });
  /** `POST /pets`: takes `{ name: string }`, returns `{ id: string }`. */
  const createPet = (operationId = 'createPet', extra: Record<string, unknown> = {}) =>
    operation(operationId, { name: str }, { id: str }, extra);
  /** `POST /pet-drafts`: takes `{ draftId: integer }`, returns `{ draftNumber: integer }`. */
  const createDraft = (operationId: string, extra: Record<string, unknown> = {}) =>
    operation(operationId, { draftId: int }, { draftNumber: int }, extra);
  const document = (openapi: string, paths: Record<string, unknown>) => ({
    openapi,
    info: { title: 'repro', version: '1' },
    paths,
  });
  /** The issue's `repro.json`: `POST /pets` (`createPet`) beside `POST /pet-drafts` (`otherId`), in either path order. */
  const repro = (openapi: string, otherId = 'create_pet', draftsFirst = false) => {
    const pets = { '/pets': { post: createPet() } };
    const drafts = { '/pet-drafts': { post: createDraft(otherId) } };
    return document(openapi, draftsFirst ? { ...drafts, ...pets } : { ...pets, ...drafts });
  };
  const nameOf = (type: TypeRef | undefined) => (type?.kind === 'model' ? type.name : String(type?.kind));
  /** What the issue's script prints: each operation's name, path, request body model and response model. */
  const typed = (spec: ApiSpec) =>
    spec.services
      .flatMap((service) => service.operations)
      .map((op) => `${op.name} (${op.path}): ${nameOf(op.requestBody)} -> ${nameOf(op.response)}`);
  const fieldsOf = (spec: ApiSpec, name: string) => spec.models.find((m) => m.name === name)?.fields.map((f) => f.name);
  const modelNames = (spec: ApiSpec) => spec.models.map((m) => m.name).sort();
  /** Every change a diff reports, its breaking ones marked. */
  const changes = (before: ApiSpec, after: ApiSpec) =>
    diffSpecs(before, after).changes.map(
      (change) =>
        `${change.kind} ${'name' in change ? change.name : ''}${change.classification === 'breaking' ? ' (breaking)' : ''}`,
    );
  const modelChanges = (before: ApiSpec, after: ApiSpec) =>
    changes(before, after).filter((change) => change.startsWith('model-') || change.startsWith('enum-'));

  const petsTyped = 'createPet (/pets): CreatePetRequest -> CreatePetResponse';
  const draftsTyped = (name = 'createPet') => `${name} (/pet-drafts): PetDraftsPostRequest -> PetDraftsPostResponse`;
  const reproModels = ['CreatePetRequest', 'CreatePetResponse', 'PetDraftsPostRequest', 'PetDraftsPostResponse'];

  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oagen-627-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (label: string, doc: Record<string, unknown>) => {
    const file = join(dir, `${label}.json`);
    await writeFile(file, JSON.stringify(doc));
    return file;
  };
  const parse = async (
    label: string,
    doc: Record<string, unknown>,
    operationIdTransform?: (operationId: string) => string,
  ) => parseSpec(await write(label, doc), operationIdTransform ? { operationIdTransform } : undefined);
  /** The exit code of `oagen diff --old <before> --new <after>`. */
  const exitCodeOf = async (before: string, after: string) => {
    const err: unknown = await diffCommand({ old: before, new: after }).catch((e: unknown) => e);
    return (err as { exitCode: number }).exitCode;
  };

  for (const openapi of ['3.1.0', '3.0.3']) {
    describe(`OpenAPI ${openapi}`, () => {
      it('types each operation with its own fields under `create_pet`, `CreatePet` and `createPetController`, whatever the order of the paths', async () => {
        for (const [otherId, name] of [
          ['create_pet', 'createPet'],
          ['CreatePet', 'createPet'],
          ['createPetController', 'createPetController'],
        ] as const) {
          for (const draftsFirst of [false, true]) {
            const label = `${otherId}-${draftsFirst ? 'drafts' : 'pets'}-first`;
            const spec = await parse(label, repro(openapi, otherId, draftsFirst));
            // `createPet` is spelled as the stem `CreatePet` and keeps the
            // plain names; the other operation is path-named, in either order.
            expect(typed(spec), label).toEqual(
              draftsFirst ? [draftsTyped(name), petsTyped] : [petsTyped, draftsTyped(name)],
            );
            expect(modelNames(spec), label).toEqual(reproModels);
            expect(fieldsOf(spec, 'CreatePetRequest'), label).toEqual(['name']);
            expect(fieldsOf(spec, 'CreatePetResponse'), label).toEqual(['id']);
            expect(fieldsOf(spec, 'PetDraftsPostRequest'), label).toEqual(['draftId']);
            expect(fieldsOf(spec, 'PetDraftsPostResponse'), label).toEqual(['draftNumber']);
          }
        }
        // Nothing was merged away, so no "more than one definition" warning.
        expect(warn).not.toHaveBeenCalled();
      });

      it('names bodies of the same shape apart too: the names depend on the ids alone, never on the shapes', async () => {
        // Two models of one shape, rather than one shared model, so that a
        // field added to `create_pet`'s body later changes its own model
        // instead of renaming it.
        const doc = document(openapi, {
          '/pets': { post: createPet() },
          '/pet-drafts': { post: createPet('create_pet') },
        });
        const spec = await parse('same-shape', doc);
        expect(typed(spec)).toEqual([petsTyped, draftsTyped()]);
        expect(modelNames(spec)).toEqual(reproModels);
        expect(fieldsOf(spec, 'PetDraftsPostRequest')).toEqual(['name']);
        expect(fieldsOf(spec, 'PetDraftsPostResponse')).toEqual(['id']);
        expect(warn).not.toHaveBeenCalled();
      });

      it('reports adding `POST /pet-drafts` as additive and leaves `createPet`’s models as they were, in either path order', async () => {
        const oldFile = await write('old', document(openapi, { '/pets': { post: createPet() } }));
        const old = await parseSpec(oldFile);
        expect(typed(old)).toEqual([petsTyped]);
        for (const draftsFirst of [false, true]) {
          const label = draftsFirst ? 'drafts-first' : 'pets-first';
          const newFile = await write(`new-${label}`, repro(openapi, 'create_pet', draftsFirst));
          const next = await parseSpec(newFile);
          expect(changes(old, next), label).toEqual([
            'model-added PetDraftsPostResponse',
            'model-added PetDraftsPostRequest',
            'service-added PetDrafts',
          ]);
          expect(await exitCodeOf(oldFile, newFile), label).toBe(1);
        }
        expect(warn).not.toHaveBeenCalled();
      });

      it('renames the operation only under an `operationIdTransform` (#537): the models stay path-named', async () => {
        const plain = await parse('transform-plain', repro(openapi));
        const transformed = await parse('transform-renamed', repro(openapi), (operationId) =>
          operationId === 'create_pet' ? 'createPetDraft' : operationId,
        );
        expect(typed(transformed)).toEqual([petsTyped, draftsTyped('createPetDraft')]);
        expect(modelNames(transformed)).toEqual(reproModels);
        expect(modelChanges(plain, transformed)).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      });

      it('path-names every contestant when none is spelled as the stem, and every other one when one is', async () => {
        // `create_pet` beside `CreatePet`: neither is `createPet`, so both are
        // path-named, in either order.
        const drafts = { '/pet-drafts': { post: createDraft('create_pet') } };
        const templates = { '/pet-templates': { post: createDraft('CreatePet') } };
        for (const [label, paths] of [
          ['drafts-first', { ...drafts, ...templates }],
          ['templates-first', { ...templates, ...drafts }],
        ] as const) {
          const spec = await parse(`none-${label}`, document(openapi, paths));
          expect(typed(spec).sort(), label).toEqual([
            'createPet (/pet-drafts): PetDraftsPostRequest -> PetDraftsPostResponse',
            'createPet (/pet-templates): PetTemplatesPostRequest -> PetTemplatesPostResponse',
          ]);
          expect(modelNames(spec), label).toEqual([
            'PetDraftsPostRequest',
            'PetDraftsPostResponse',
            'PetTemplatesPostRequest',
            'PetTemplatesPostResponse',
          ]);
        }
        // With `createPet` beside them, it alone keeps the stem.
        const three = await parse(
          'three',
          document(openapi, { ...templates, ...drafts, '/pets': { post: createPet() } }),
        );
        expect(typed(three).sort()).toEqual([
          'createPet (/pet-drafts): PetDraftsPostRequest -> PetDraftsPostResponse',
          'createPet (/pet-templates): PetTemplatesPostRequest -> PetTemplatesPostResponse',
          petsTyped,
        ]);
        expect(fieldsOf(three, 'CreatePetRequest')).toEqual(['name']);
        expect(warn).not.toHaveBeenCalled();
      });

      it('reads the id up to its overload markers: `createPet[1]` is spelled as the stem (#565)', async () => {
        const spec = await parse(
          'markers',
          document(openapi, {
            '/pet-drafts': { post: createDraft('create_pet') },
            '/pets': { post: createPet('createPet[1]') },
          }),
        );
        expect(typed(spec)).toEqual([draftsTyped(), petsTyped]);
        expect(modelNames(spec)).toEqual(reproModels);
        expect(warn).not.toHaveBeenCalled();
      });

      it('lets two paths that `$ref` one Path Item share the path-named models of the first', async () => {
        // `create_pet` is declared once, on a Path Item two paths reach: it
        // loses the stem once, and both paths read one body under the name
        // of the first path in order (`/drafts` before `/pet-drafts`).
        const spec = await parse(
          'shared-path-item',
          document(openapi, {
            '/pets': { post: createPet() },
            '/pet-drafts': { post: createDraft('create_pet') },
            '/drafts': { $ref: '#/paths/~1pet-drafts' },
          }),
        );
        expect(typed(spec)).toEqual([
          petsTyped,
          'createPet (/pet-drafts): DraftsPostRequest -> DraftsPostResponse',
          'createPet (/drafts): DraftsPostRequest -> DraftsPostResponse',
        ]);
        expect(modelNames(spec)).toEqual([
          'CreatePetRequest',
          'CreatePetResponse',
          'DraftsPostRequest',
          'DraftsPostResponse',
        ]);
        expect(fieldsOf(spec, 'DraftsPostRequest')).toEqual(['draftId']);
        expect(warn).not.toHaveBeenCalled();
      });

      it('settles the contest after the reuse pass (#481): a reused `createPet` yields to a lone `create_pet`, which then holds the stem alone', async () => {
        // `createPet` declared on two Operation Objects is reused, and a
        // reused id's claim yields to every id declared once whose stem it
        // is (#481): both `createPet` operations are path-named, and
        // `create_pet` keeps `CreatePet` with no one left to contest it.
        const spec = await parse(
          'reused',
          document(openapi, {
            '/pets': { post: createPet('createPet', { tags: ['Pets'] }) },
            '/archived-pets': { post: createPet('createPet', { tags: ['Archived'] }) },
            '/pet-drafts': { post: createDraft('create_pet', { tags: ['Drafts'] }) },
          }),
        );
        expect(typed(spec)).toEqual([
          'createPet (/pets): PetsPostRequest -> PetsPostResponse',
          'createPet (/archived-pets): ArchivedPetsPostRequest -> ArchivedPetsPostResponse',
          'createPet (/pet-drafts): CreatePetRequest -> CreatePetResponse',
        ]);
        expect(fieldsOf(spec, 'CreatePetRequest')).toEqual(['draftId']);
        expect(fieldsOf(spec, 'PetsPostRequest')).toEqual(['name']);
        expect(fieldsOf(spec, 'ArchivedPetsPostRequest')).toEqual(['name']);
      });

      // Greptile (round 1): a losing operation's path prefix can extend the
      // winner's stem, and then its `…Response` is exactly a name the
      // winner's response nests. `resolvePathModelBaseNames` reserved the
      // stem alone, which never reached such a name — on this branch, or on
      // `main` for an operation without an `operationId` — so the merge kept
      // one shape for both. Now a prefix that extends an operation's stem
      // reserves every name the operations' bodies mint and is hashed.
      describe('a path prefix that extends the stem (Greptile, round 1)', () => {
        /** `createPet`, whose response nests a `drafts_get_response` object and whose request body nests a `foo_post_request` object. */
        const createPetNesting = {
          operationId: 'createPet',
          requestBody: json(body({ name: str, foo_post_request: body({ tag: str }) })),
          responses: {
            '201': { description: 'Created', ...json(body({ status: str, drafts_get_response: body({ id: str }) })) },
          },
        };
        /** `GET /create/pet/response/drafts`, returning `{ draftId: integer }`. */
        const draftsGet = (operationId?: string) => ({
          ...(operationId ? { operationId } : {}),
          responses: { '200': { description: 'ok', ...json(body({ draftId: int })) } },
        });
        /** `POST /create/pet/request/foo`, taking `{ draftId: integer }`. */
        const fooPost = (operationId?: string) => ({
          ...(operationId ? { operationId } : {}),
          requestBody: json(body({ draftId: int })),
          responses: { '204': { description: 'ok' } },
        });
        const hashed = (stem: string, method: string, suffix: string) =>
          new RegExp(`^${stem}[0-9A-Fa-f]{6}${method}${suffix}$`);
        const operationAt = (spec: ApiSpec, path: string) =>
          spec.services.flatMap((s) => s.operations).find((op) => op.path === path)!;

        it('hashes the loser’s prefix instead of naming its response after a model the winner’s response nests, in either order', async () => {
          const pets = { '/pets': { post: createPetNesting } };
          const drafts = { '/create/pet/response/drafts': { get: draftsGet('create_pet') } };
          for (const [label, paths] of [
            ['pets-first', { ...pets, ...drafts }],
            ['drafts-first', { ...drafts, ...pets }],
          ] as const) {
            const spec = await parse(`extends-${label}`, document(openapi, paths));
            // `CreatePetResponseDraftsGet` extends `CreatePet`, so the
            // path-named `create_pet` is hashed and keeps its own fields.
            const response = nameOf(operationAt(spec, '/create/pet/response/drafts').response);
            expect(response, label).toMatch(hashed('CreatePetResponseDrafts', 'Get', 'Response'));
            expect(fieldsOf(spec, response), label).toEqual(['draftId']);
            // `createPet`'s nested model keeps its name and its fields.
            expect(fieldsOf(spec, 'CreatePetResponseDraftsGetResponse'), label).toEqual(['id']);
            expect(fieldsOf(spec, 'CreatePetResponse'), label).toEqual(['status', 'drafts_get_response']);
            expect(spec.models, label).toHaveLength(5);
          }
          expect(warn).not.toHaveBeenCalled();
        });

        it('reserves the names the winner’s request body nests the same way', async () => {
          const spec = await parse(
            'extends-request',
            document(openapi, {
              '/pets': { post: createPetNesting },
              '/create/pet/request/foo': { post: fooPost('create_pet') },
            }),
          );
          const request = nameOf(operationAt(spec, '/create/pet/request/foo').requestBody);
          expect(request).toMatch(hashed('CreatePetRequestFoo', 'Post', 'Request'));
          expect(fieldsOf(spec, request)).toEqual(['draftId']);
          expect(fieldsOf(spec, 'CreatePetRequestFooPostRequest')).toEqual(['tag']);
          expect(warn).not.toHaveBeenCalled();
        });

        it('hashes an operation without an `operationId` whose prefix extends the stem the same way', async () => {
          const spec = await parse(
            'extends-no-id',
            document(openapi, {
              '/pets': { post: createPetNesting },
              '/create/pet/response/drafts': { get: draftsGet() },
            }),
          );
          const response = nameOf(operationAt(spec, '/create/pet/response/drafts').response);
          expect(response).toMatch(hashed('CreatePetResponseDrafts', 'Get', 'Response'));
          expect(fieldsOf(spec, response)).toEqual(['draftId']);
          expect(fieldsOf(spec, 'CreatePetResponseDraftsGetResponse')).toEqual(['id']);
          expect(warn).not.toHaveBeenCalled();
        });

        it('leaves a prefix that does not extend the stem plain', async () => {
          const spec = await parse(
            'extends-not',
            document(openapi, { '/pets': { post: createPetNesting }, '/drafts': { get: draftsGet('create_pet') } }),
          );
          expect(nameOf(operationAt(spec, '/drafts').response)).toBe('DraftsGetResponse');
          expect(warn).not.toHaveBeenCalled();
        });

        // Greptile (round 2): the request body was rehearsed as a response,
        // which names an array body's items `CreatePetRequestItem`, while
        // the request extractor names them `CreatePetRequest` itself — so
        // the `CreatePetRequestFooPostRequest` they nest was never reserved.
        it('reserves what an array request body’s items nest, as the request extractor names them, in either order', async () => {
          /** `createPet` taking an array of objects that nest a `foo_post_request` object. */
          const createPetArray = {
            operationId: 'createPet',
            requestBody: json({ type: 'array', items: body({ foo_post_request: body({ tag: str }) }) }),
            responses: { '204': { description: 'ok' } },
          };
          const pets = { '/pets': { post: createPetArray } };
          const foo = { '/create/pet/request/foo': { post: fooPost('create_pet') } };
          for (const [label, paths] of [
            ['pets-first', { ...pets, ...foo }],
            ['foo-first', { ...foo, ...pets }],
          ] as const) {
            const spec = await parse(`extends-array-${label}`, document(openapi, paths));
            const items = operationAt(spec, '/pets').requestBody;
            expect(items, label).toEqual({ kind: 'array', items: { kind: 'model', name: 'CreatePetRequest' } });
            expect(fieldsOf(spec, 'CreatePetRequest'), label).toEqual(['foo_post_request']);
            expect(fieldsOf(spec, 'CreatePetRequestFooPostRequest'), label).toEqual(['tag']);
            const request = nameOf(operationAt(spec, '/create/pet/request/foo').requestBody);
            expect(request, label).toMatch(hashed('CreatePetRequestFoo', 'Post', 'Request'));
            expect(fieldsOf(spec, request), label).toEqual(['draftId']);
            expect(spec.models, label).toHaveLength(3);
          }
          expect(warn).not.toHaveBeenCalled();
        });
      });

      // Michael (round 1): only the camelCase spelling of the stem could keep
      // it, so a document that writes its ids in snake_case or PascalCase
      // path-named both contestants, and adding the operation with the
      // marker renamed the plain one's models (`ListNotesResponse` →
      // `NotesGetResponse`, `oagen diff` exit `2`). Now the contestant the
      // cleaning moved least keeps the stem, whatever case it is written in:
      // an id a marker or backend word was stripped from never keeps it, one
      // left as written outranks one only singularized, and a tie goes to
      // the camelCase spelling when there is exactly one.
      describe('the contestant the cleaning moved least keeps the stem, in any case (Michael, round 1)', () => {
        /** A `GET` returning an object of `properties`, in the service `tag` names or the path's. */
        const listing = (operationId: string, properties: Record<string, Schema>, tag?: string) => ({
          operationId,
          ...(tag ? { tags: [tag] } : {}),
          responses: { '200': { description: 'ok', ...json(body(properties)) } },
        });
        /** Michael's `old.json`: `GET /notes` (`first`) returning `{ title }`. */
        const notes = (first: string, tag?: string) => ({ '/notes': { get: listing(first, { title: str }, tag) } });
        /** What `new.json` adds: `GET /notes/external` (`second`) returning `{ externalId }`, or `{ title }` too. */
        const external = (second: string, sameShape = false, tag?: string) => ({
          '/notes/external': { get: listing(second, sameShape ? { title: str } : { externalId: str }, tag) },
        });
        const responseAt = (spec: ApiSpec, path: string) =>
          nameOf(spec.services.flatMap((s) => s.operations).find((op) => op.path === path)!.response);

        it('keeps the plain id’s models when a marker id is added, additively, in snake_case, PascalCase, beside `Controller` and singularized', async () => {
          for (const [first, second, response] of [
            ['list_notes', 'list_notes_by_external_id', 'ListNotesResponse'],
            ['ListNotes', 'ListNotesByExternalId', 'ListNotesResponse'],
            ['CreatePet', 'CreatePetController', 'CreatePetResponse'],
            ['Notes_List', 'Notes_ListByExternalId', 'NoteListResponse'],
          ] as const) {
            const oldFile = await write(`${first}-old`, document(openapi, notes(first)));
            const old = await parseSpec(oldFile);
            expect(responseAt(old, '/notes'), first).toBe(response);
            for (const [order, paths] of [
              ['plain-first', { ...notes(first), ...external(second) }],
              ['marker-first', { ...external(second), ...notes(first) }],
            ] as const) {
              const label = `${first}-${order}`;
              const newFile = await write(label, document(openapi, paths));
              const next = await parseSpec(newFile);
              expect(responseAt(next, '/notes'), label).toBe(response);
              expect(responseAt(next, '/notes/external'), label).toBe('NotesExternalGetResponse');
              expect(fieldsOf(next, response), label).toEqual(['title']);
              expect(fieldsOf(next, 'NotesExternalGetResponse'), label).toEqual(['externalId']);
              const diff = diffSpecs(old, next);
              expect(
                diff.changes.map((change) => change.kind),
                label,
              ).toEqual(['model-added', 'operation-added']);
              expect(modelChanges(old, next), label).toEqual(['model-added NotesExternalGetResponse']);
              expect(diff.summary.breaking, label).toBe(0);
              expect(await exitCodeOf(oldFile, newFile), label).toBe(1);
            }
          }
          expect(warn).not.toHaveBeenCalled();
        });

        it('is additive for bodies of one shape too', async () => {
          const oldFile = await write('same-old', document(openapi, notes('list_notes')));
          const newFile = await write(
            'same-new',
            document(openapi, { ...notes('list_notes'), ...external('list_notes_by_external_id', true) }),
          );
          const old = await parseSpec(oldFile);
          const next = await parseSpec(newFile);
          expect(responseAt(next, '/notes')).toBe('ListNotesResponse');
          expect(responseAt(next, '/notes/external')).toBe('NotesExternalGetResponse');
          expect(modelChanges(old, next)).toEqual(['model-added NotesExternalGetResponse']);
          expect(await exitCodeOf(oldFile, newFile)).toBe(1);
          expect(warn).not.toHaveBeenCalled();
        });

        it('ranks an id left as written over one only singularized, breaks a tie by the camelCase spelling, and path-names every id a marker was stripped from', async () => {
          // `Note_List` PascalCases to `NoteList` as written; `Notes_List`
          // was singularized to it, so `Note_List` keeps the stem.
          const exact = await parse(
            'exact',
            document(openapi, { ...notes('Notes_List', 'Notes'), ...external('Note_List', false, 'External') }),
          );
          expect(responseAt(exact, '/notes')).toBe('NotesGetResponse');
          expect(responseAt(exact, '/notes/external')).toBe('NoteListResponse');
          // `notesList` and `Notes_List` were both singularized; the one
          // written in camelCase keeps the stem.
          const camel = await parse(
            'camel',
            document(openapi, { ...notes('Notes_List', 'Notes'), ...external('notesList', false, 'External') }),
          );
          expect(responseAt(camel, '/notes')).toBe('NotesGetResponse');
          expect(responseAt(camel, '/notes/external')).toBe('NoteListResponse');
          // Two ids a marker was stripped from never keep the stem, however
          // they are written: both are path-named.
          const markers = await parse(
            'markers',
            document(openapi, {
              ...notes('listNotesByExternalId', 'Notes'),
              ...external('list_notes_by_external_id', false, 'External'),
            }),
          );
          expect(responseAt(markers, '/notes')).toBe('NotesGetResponse');
          expect(responseAt(markers, '/notes/external')).toBe('NotesExternalGetResponse');
          expect(warn).not.toHaveBeenCalled();
        });
      });
    });
  }
});
