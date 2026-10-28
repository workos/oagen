import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractOperations } from '../../src/parser/operations.js';
import { parseSpec } from '../../src/parser/parse.js';
import { collectModelRefs } from '../../src/ir/types.js';
import { diffSpecs } from '../../src/differ/diff.js';

/**
 * Fallback names on an action or singleton segment (issue #271). A literal
 * after a path parameter that does not look plural is a singleton of that
 * item, read with the item verb for every method — `GET /pets/{id}/status`
 * is `getPetStatus`, not `listStatus` — and a literal that already says the
 * verb is the action for every method, not only a POST:
 * `DELETE /pets/bulk-delete` is `bulkDelete`, not `deleteBulkDelete`.
 */

const ok = { responses: { '204': { description: 'ok' } } };
const idParam = (name: string) => ({
  parameters: [{ name, in: 'path' as const, required: true, schema: { type: 'string' } }],
});
const item = (name: string) => ({ ...ok, ...idParam(name) });

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
type Paths = Record<string, Partial<Record<Method, unknown>>>;

type Services = ReturnType<typeof extractOperations>['services'];

/**
 * The invariant every case below holds: within a service, two operations
 * share a name only when they sit on one path and are its PUT and PATCH,
 * the one deliberate sharing (both take the verb `update`). The differ keys
 * a service's operations by name, so any other sharing would hide one.
 */
function expectUniqueNames(services: Services): void {
  for (const service of services) {
    const byName = new Map<string, Services[number]['operations']>();
    for (const op of service.operations) byName.set(op.name, [...(byName.get(op.name) ?? []), op]);
    for (const [name, ops] of byName) {
      if (ops.length < 2) continue;
      const shape = { paths: [...new Set(ops.map((op) => op.path))], methods: ops.map((op) => op.httpMethod).sort() };
      expect({ service: service.name, name, ...shape }).toEqual({
        service: service.name,
        name,
        paths: [ops[0].path],
        methods: ['patch', 'put'],
      });
    }
  }
}

/** `Service.name METHOD path` for every operation, sorted by path (code units) then method. */
function names(paths: Paths) {
  const { services } = extractOperations(paths as Parameters<typeof extractOperations>[0]);
  expectUniqueNames(services);
  const key = (op: { path: string; httpMethod: string }) => `${op.path}\0${op.httpMethod}`;
  return services
    .flatMap((s) => s.operations.map((op) => ({ op, service: s.name })))
    .sort((a, b) => (key(a.op) < key(b.op) ? -1 : key(a.op) > key(b.op) ? 1 : 0))
    .map(({ op, service }) => {
      const qualified = `${service}.${op.name}`.padEnd(30);
      return `${qualified} ${op.httpMethod.toUpperCase().padEnd(6)} ${op.path}`;
    });
}

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-action-segments-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

describe('fallback names on an action or singleton segment (issue #271)', () => {
  it('names the issue repro through parseSpec', async () => {
    // Every operation is tagged `Pets` and returns 200 with a JSON string.
    const jsonString = {
      '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } },
    };
    const op = (withId: boolean) => ({ tags: ['Pets'], responses: jsonString, ...(withId ? idParam('id') : {}) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spec = await parseSpec(
        await writeSpec('repro.json', {
          openapi: '3.1.0',
          info: { title: 'repro', version: '1' },
          paths: {
            '/pets/{id}/status': { get: op(true) },
            '/pets/{id}/adopt': { get: op(true), post: op(true) },
            '/pets/bulk-delete': { delete: op(false) },
          },
        }),
      );
      expect(
        spec.services.map(({ name, operations }) => ({
          name,
          operations: operations.map((o) => `${o.name}: ${o.httpMethod.toUpperCase()} ${o.path}`),
        })),
      ).toEqual([
        {
          name: 'Pets',
          operations: [
            'getPetStatus: GET /pets/{id}/status',
            'getPetAdopt: GET /pets/{id}/adopt',
            'adoptPet: POST /pets/{id}/adopt',
            'bulkDelete: DELETE /pets/bulk-delete',
          ],
        },
      ]);
      // Every reference resolves, and a string body mints nothing.
      const modelNames = new Set(spec.models.map((m) => m.name));
      for (const o of spec.services.flatMap((s) => s.operations)) {
        for (const name of collectModelRefs(o.response)) expect(modelNames).toContain(name);
      }
      expect(spec.models).toEqual([]);
      expect(spec.enums).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reads a singleton of one item with the item verb, the singular parent and the segment, for every method', () => {
    expect(
      names({
        '/pets/{id}/status': {
          get: item('id'),
          put: item('id'),
          patch: item('id'),
          delete: item('id'),
          head: item('id'),
          post: item('id'),
        },
      }),
    ).toEqual([
      'Pets.deletePetStatus           DELETE /pets/{id}/status',
      'Pets.getPetStatus              GET    /pets/{id}/status',
      'Pets.checkPetStatus            HEAD   /pets/{id}/status',
      'Pets.updatePetStatus           PATCH  /pets/{id}/status',
      'Pets.createPetStatus           POST   /pets/{id}/status',
      'Pets.updatePetStatus           PUT    /pets/{id}/status',
    ]);
  });

  it('keeps the parent so one singleton on two resources in one service does not collide', () => {
    expect(
      names({
        '/admin/pets/{id}/status': { get: item('id') },
        '/admin/users/{id}/status': { get: item('id') },
        '/admin/pets/{id}/avatar': { delete: item('id') },
        '/admin/users/{id}/avatar': { delete: item('id') },
      }),
    ).toEqual([
      'Admin.deletePetAvatar          DELETE /admin/pets/{id}/avatar',
      'Admin.getPetStatus             GET    /admin/pets/{id}/status',
      'Admin.deleteUserAvatar         DELETE /admin/users/{id}/avatar',
      'Admin.getUserStatus            GET    /admin/users/{id}/status',
    ]);
  });

  it('keeps a plural literal after a parameter a nested collection', () => {
    expect(
      names({
        '/pets/{id}/photos': { get: item('id'), delete: item('id'), post: item('id') },
        '/orgs/{id}/api_keys': { get: item('id') },
      }),
    ).toEqual([
      'Orgs.listApiKeys               GET    /orgs/{id}/api_keys',
      'Pets.deletePhotos              DELETE /pets/{id}/photos',
      'Pets.listPhotos                GET    /pets/{id}/photos',
      'Pets.createPhotos              POST   /pets/{id}/photos',
    ]);
  });

  it('still reads a POST on a singleton that does not end in s as an action, and a GET on it as a singleton', () => {
    expect(
      names({
        '/pets/{id}/avatar': { get: item('id'), post: item('id') },
        '/pets/{id}/adopt': { get: item('id'), delete: item('id'), post: item('id') },
      }),
    ).toEqual([
      'Pets.deletePetAdopt            DELETE /pets/{id}/adopt',
      'Pets.getPetAdopt               GET    /pets/{id}/adopt',
      'Pets.adoptPet                  POST   /pets/{id}/adopt',
      'Pets.getPetAvatar              GET    /pets/{id}/avatar',
      'Pets.avatarPet                 POST   /pets/{id}/avatar',
    ]);
  });

  it("reads a segment that carries the method's own verb as the action, for every method", () => {
    expect(
      names({
        '/pets/bulk-delete': { delete: ok },
        '/store/pets/bulk-delete': { delete: ok },
        '/store/pets/list-all': { get: ok },
        '/store/pets/bulk-update': { put: ok },
        '/users/{id}/update-password': { put: item('id') },
        '/pets/{id}/delete': { delete: item('id') },
        '/pets/{id}/get-status': { get: item('id') },
      }),
    ).toEqual([
      'Pets.bulkDelete                DELETE /pets/bulk-delete',
      'Pets.deletePet                 DELETE /pets/{id}/delete',
      'Pets.getStatusPet              GET    /pets/{id}/get-status',
      'Store.bulkDeletePets           DELETE /store/pets/bulk-delete',
      'Store.bulkUpdatePets           PUT    /store/pets/bulk-update',
      'Store.listAllPets              GET    /store/pets/list-all',
      'Users.updatePasswordUser       PUT    /users/{id}/update-password',
    ]);
  });

  it("reads a literal after a parameter that carries another method's verb as a singleton", () => {
    expect(
      names({
        '/users/{id}/last-update': { get: item('id') },
        '/pets/{id}/health-check': { get: item('id') },
        '/pets/{id}/updates': { get: item('id') },
      }),
    ).toEqual([
      'Pets.getPetHealthCheck         GET    /pets/{id}/health-check',
      'Pets.listUpdates               GET    /pets/{id}/updates',
      'Users.getUserLastUpdate        GET    /users/{id}/last-update',
    ]);
  });

  it('reads a literal with no parameter before it whose last word is a CRUD verb as the action for a POST only', () => {
    expect(
      names({
        '/pets/bulk-delete': { post: ok, put: ok },
        '/pets/update': { get: ok },
        '/pets/last-update': { get: ok },
        '/store/pets/bulk-update': { post: ok },
        '/store/pets/{id}/photos/bulk-delete': { post: item('id') },
        '/store/pets/delete-candidates': { get: ok, post: ok },
        '/store/events/check-ins': { get: ok },
        '/store/settings/display-options': { get: ok },
        '/store/pets/search': { post: ok },
      }),
    ).toEqual([
      // `bulk-delete` and `bulk-update` carry DELETE's and PUT's verbs, whose
      // actions they are whether or not those methods are declared (#379).
      'Pets.createBulkDelete          POST   /pets/bulk-delete',
      'Pets.updateBulkDelete          PUT    /pets/bulk-delete',
      'Pets.listLastUpdate            GET    /pets/last-update',
      'Pets.listUpdate                GET    /pets/update',
      'Store.listCheckIns             GET    /store/events/check-ins',
      'Store.createBulkUpdate         POST   /store/pets/bulk-update',
      'Store.listDeleteCandidates     GET    /store/pets/delete-candidates',
      'Store.createDeleteCandidates   POST   /store/pets/delete-candidates',
      'Store.createSearch             POST   /store/pets/search',
      'Store.createBulkDelete         POST   /store/pets/{id}/photos/bulk-delete',
      'Store.listDisplayOptions       GET    /store/settings/display-options',
    ]);
    // A CRUD verb last that no other method carries: `list` and `check` count
    // for GET and HEAD only as the first word, and `create` is POST's own.
    expect(
      names({
        '/pets/health-check': { post: ok },
        '/pets/allow-list': { post: ok },
        '/pets/bulk-create': { post: ok },
      }),
    ).toEqual([
      'Pets.allowList                 POST   /pets/allow-list',
      'Pets.bulkCreate                POST   /pets/bulk-create',
      'Pets.healthCheck               POST   /pets/health-check',
    ]);
  });

  it('reads list and check as the verb only at the start of a segment; every other verb anywhere', () => {
    expect(
      names({
        '/pets/{id}/wish-list': { get: item('id') },
        '/pets/allow-list': { get: ok },
        '/pets/list-all': { get: ok },
        '/pets/{id}/health-check': { head: item('id') },
        '/pets/check-health': { head: ok },
        '/pets:batchGet': { get: ok },
        '/pets/force-update': { put: ok },
      }),
    ).toEqual([
      'Pets.listAllowList             GET    /pets/allow-list',
      // `HEAD /pets/health` and `GET /pets/all` would be `checkHealth` and
      // `listAll`, so the actions take back their collection (#379).
      'Pets.checkHealthPets           HEAD   /pets/check-health',
      'Pets.forceUpdate               PUT    /pets/force-update',
      'Pets.listAllPets               GET    /pets/list-all',
      'Pets.checkPetHealthCheck       HEAD   /pets/{id}/health-check',
      'Pets.getPetWishList            GET    /pets/{id}/wish-list',
      'Pets.batchGet                  GET    /pets:batchGet',
    ]);
  });

  it('reads an irregular plural singularizePathSegment does not recognise as a singleton', () => {
    expect(
      names({
        '/pets/{id}/children': { get: item('id') },
        '/pets/{id}/people': { get: item('id') },
      }),
    ).toEqual([
      'Pets.getPetChildren            GET    /pets/{id}/children',
      'Pets.getPetPeople              GET    /pets/{id}/people',
    ]);
  });

  it('leaves the plain CRUD name with the CRUD operation and qualifies the action beside it', () => {
    expect(
      names({
        '/pets': { post: ok },
        '/pets/all': { get: ok },
        '/pets/create': { post: ok },
        '/pets/delete': { post: ok },
        '/pets/list-all': { get: ok },
        '/pets/update': { post: ok },
        '/pets/{id}': { put: item('id'), delete: item('id') },
      }),
    ).toEqual([
      'Pets.create                    POST   /pets',
      'Pets.listAll                   GET    /pets/all',
      'Pets.createPets                POST   /pets/create',
      // `delete` and `update` carry DELETE's and PUT's verbs: a POST on them
      // is no action (#379).
      'Pets.createDelete              POST   /pets/delete',
      'Pets.listAllPets               GET    /pets/list-all',
      'Pets.createUpdate              POST   /pets/update',
      'Pets.delete                    DELETE /pets/{id}',
      'Pets.update                    PUT    /pets/{id}',
    ]);
    // The methods whose verbs they are read them as the actions.
    expect(
      names({
        '/pets/delete': { delete: ok },
        '/pets/update': { put: ok },
        '/pets/{id}': { put: item('id'), delete: item('id') },
      }),
    ).toEqual([
      'Pets.deletePets                DELETE /pets/delete',
      'Pets.updatePets                PUT    /pets/update',
      'Pets.delete                    DELETE /pets/{id}',
      'Pets.update                    PUT    /pets/{id}',
    ]);
    // With no dropped collection to take back — the name already ends with
    // it, or the collection is not the service segment — the name without
    // the action rule.
    expect(
      names({
        '/store/pets': { put: ok },
        '/store/pets/update': { post: ok },
        '/store/pets/{id}': { post: item('id') },
        '/store/pets/{id}/create': { post: item('id') },
      }),
    ).toEqual([
      'Store.updatePets               PUT    /store/pets',
      'Store.createUpdate             POST   /store/pets/update',
      'Store.createPet                POST   /store/pets/{id}',
      'Store.createPetCreate          POST   /store/pets/{id}/create',
    ]);
  });

  it('names actions on two collections in one service after their collections', () => {
    expect(
      names({
        '/admin/pets/bulk-delete': { delete: ok },
        '/admin/users/bulk-delete': { delete: ok },
      }),
    ).toEqual([
      'Admin.bulkDeletePets           DELETE /admin/pets/bulk-delete',
      'Admin.bulkDeleteUsers          DELETE /admin/users/bulk-delete',
    ]);
  });

  it('qualifies colliding singletons and actions by what sets their paths apart, never by repeating the parent', () => {
    // The deeper path context around the parent, not the parent again.
    expect(
      names({
        '/shop/pets/{id}/status': { get: item('id') },
        '/shop/rescue/pets/{id}/status': { get: item('id') },
        '/shop/pets/bulk-delete': { post: ok },
        '/shop/rescue/pets/bulk-delete': { post: ok },
      }),
    ).toEqual([
      // `bulk-delete` is DELETE's action, so these POSTs are collections (#379).
      'Shop.createBulkDeletePets      POST   /shop/pets/bulk-delete',
      'Shop.getPetStatus              GET    /shop/pets/{id}/status',
      'Shop.createBulkDeleteRescuePets POST   /shop/rescue/pets/bulk-delete',
      'Shop.getPetStatusRescue        GET    /shop/rescue/pets/{id}/status',
    ]);
    expect(
      names({
        '/shop/pets/bulk-delete': { delete: ok },
        '/shop/rescue/pets/bulk-delete': { delete: ok },
      }),
    ).toEqual([
      'Shop.bulkDeletePets            DELETE /shop/pets/bulk-delete',
      'Shop.bulkDeletePetsRescue      DELETE /shop/rescue/pets/bulk-delete',
    ]);
    // Under an API root the parameters tell the paths apart; one every path
    // carries, `petId`, adds nothing.
    expect(
      names({
        '/api/v1/pets/{petId}/status': { get: item('petId') },
        '/api/v1/{orgId}/pets/{petId}/status': { get: item('petId') },
      }),
    ).toEqual([
      'Pets.getPetStatus              GET    /api/v1/pets/{petId}/status',
      'Pets.getPetStatusByOrgId       GET    /api/v1/{orgId}/pets/{petId}/status',
    ]);
  });

  it('does not repeat the parent when the segment already starts with it', () => {
    expect(
      names({
        '/companies/verification/{id}/verification-status': { get: item('id') },
      }),
    ).toEqual(['Companies.getVerificationStatus GET    /companies/verification/{id}/verification-status']);
  });

  it('names a singleton with no literal parent by the verb and the segment', () => {
    expect(
      names({
        '/{id}/status': { get: item('id') },
        '/api/v1/{companyId}/status': { get: item('companyId') },
      }),
    ).toEqual([
      // Under the `/api/v1` root the service is named from the first literal
      // after it, the segment itself; the name still carries it.
      'Status.getStatus               GET    /api/v1/{companyId}/status',
      'Default.getStatus              GET    /{id}/status',
    ]);
  });

  it('numbers a singleton or action next to an operationId of the same name: neither has a plural', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        names({
          '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPetStatus' } },
          '/store/pets/{id}/status': { get: item('id') },
          '/store/all': { delete: { ...ok, operationId: 'bulkDelete' } },
          '/store/bulk-delete': { delete: ok },
        }),
      ).toEqual([
        'Store.bulkDelete               DELETE /store/all',
        'Store.bulkDelete2              DELETE /store/bulk-delete',
        'Store.getPetStatus             GET    /store/featured/{id}',
        'Store.getPetStatus2            GET    /store/pets/{id}/status',
      ]);
      // A path-derived name is refined silently.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the parent as written when its plural is what tells two singletons apart (issue #381)', async () => {
    // The issue repro: every operation tagged `Shop`, returning 200 with a
    // JSON string. A singleton's qualifiers read its path without the parent
    // (`/shop/status` for both), so the plural is all that tells
    // `/shop/pets/{id}/status` from `/shop/pet/{id}/status`, as it tells the
    // two items apart.
    const jsonString = {
      '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } },
    };
    const op = (...ids: string[]) => ({
      tags: ['Shop'],
      responses: jsonString,
      parameters: ids.map((name) => ({ name, in: 'path' as const, required: true, schema: { type: 'string' } })),
    });
    const repro = {
      '/shop/pets/{id}/status': { get: op('id') },
      '/shop/pet/{id}/status': { get: op('id') },
      '/shop/pets/{id}/toys/{toyId}': { get: op('id', 'toyId') },
      '/shop/pet/{id}/toys/{toyId}': { get: op('id', 'toyId') },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spec = await parseSpec(
        await writeSpec('repro.json', { openapi: '3.1.0', info: { title: 'repro', version: '1' }, paths: repro }),
      );
      expect(
        spec.services.flatMap(({ operations }) =>
          operations.map((o) => `${o.name}: ${o.httpMethod.toUpperCase()} ${o.path}`),
        ),
      ).toEqual([
        'getPetsStatus: GET /shop/pets/{id}/status',
        'getPetStatus: GET /shop/pet/{id}/status',
        'getToyPets: GET /shop/pets/{id}/toys/{toyId}',
        'getToyPet: GET /shop/pet/{id}/toys/{toyId}',
      ]);
      // The same names whatever the document order.
      const reversed = Object.fromEntries(Object.entries(repro).reverse());
      expect(names(reversed)).toEqual(names(repro));
      // A path-derived name is refined silently.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    // The parent is the literal nearest the parameter, wherever it sits, and
    // a segment that repeats the parent's noun is not added again
    // (appendQualifier): `/org/statuses/{id}/status` is `getStatuses`.
    expect(
      names({
        '/shop/owners/{ownerId}/pets/{id}/status': { get: item('id') },
        '/shop/owners/{ownerId}/pet/{id}/status': { get: item('id') },
        '/org/statuses/{id}/status': { get: item('id') },
        '/org/status/{id}/status': { get: item('id') },
      }),
    ).toEqual([
      'Org.getStatus                  GET    /org/status/{id}/status',
      'Org.getStatuses                GET    /org/statuses/{id}/status',
      'Shop.getPetStatus              GET    /shop/owners/{ownerId}/pet/{id}/status',
      'Shop.getPetsStatus             GET    /shop/owners/{ownerId}/pets/{id}/status',
    ]);
    // PUT and PATCH on one path share the parent as written.
    expect(
      names({
        '/shop/pets/{id}/status': { put: item('id'), patch: item('id') },
        '/shop/pet/{id}/status': { put: item('id') },
      }),
    ).toEqual([
      'Shop.updatePetStatus           PUT    /shop/pet/{id}/status',
      'Shop.updatePetsStatus          PATCH  /shop/pets/{id}/status',
      'Shop.updatePetsStatus          PUT    /shop/pets/{id}/status',
    ]);
    // Singletons that write the parent alike take it together and are
    // numbered on it, as items that share a plural are; two that would only
    // take one spelling are numbered on the plain name, since it would say
    // nothing about which is which.
    expect(
      names({
        '/shop/Pets/{id}/status': { get: item('id') },
        '/shop/pets/{id}/status': { get: item('id') },
        '/shop/pet/{id}/status': { get: item('id') },
      }),
    ).toEqual([
      'Shop.getPetsStatus             GET    /shop/Pets/{id}/status',
      'Shop.getPetStatus              GET    /shop/pet/{id}/status',
      'Shop.getPetsStatus2            GET    /shop/pets/{id}/status',
    ]);
    expect(
      names({
        '/shop/Pets/{id}/status': { get: item('id') },
        '/shop/pets/{id}/status': { get: item('id') },
      }),
    ).toEqual([
      'Shop.getPetStatus              GET    /shop/Pets/{id}/status',
      'Shop.getPetStatus2             GET    /shop/pets/{id}/status',
    ]);
  });

  it('gives a singleton its parent as written only beside another singleton, and only when that name is free (issue #381)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // An operationId joining the pair keeps the plain name; the plural path
      // still takes its plural and the singular path is numbered, as for
      // `getPets` and `getPet2` beside `operationId: getPet`.
      expect(
        names({
          '/shop/featured/{id}': { get: { ...item('id'), operationId: 'getPetStatus' } },
          '/shop/pets/{id}/status': { get: item('id') },
          '/shop/pet/{id}/status': { get: item('id') },
        }),
      ).toEqual([
        'Shop.getPetStatus              GET    /shop/featured/{id}',
        'Shop.getPetStatus2             GET    /shop/pet/{id}/status',
        'Shop.getPetsStatus             GET    /shop/pets/{id}/status',
      ]);
      // The parent as written is taken: the number goes on the plain name.
      expect(
        names({
          '/shop/all/{id}': { get: { ...item('id'), operationId: 'getPetsStatus' } },
          '/shop/pets/{id}/status': { get: item('id') },
          '/shop/pet/{id}/status': { get: item('id') },
        }),
      ).toEqual([
        'Shop.getPetsStatus             GET    /shop/all/{id}',
        'Shop.getPetStatus              GET    /shop/pet/{id}/status',
        'Shop.getPetStatus2             GET    /shop/pets/{id}/status',
      ]);
      // Taken by a path-named operation too, even one `Archive` would tell
      // apart: no qualifier runs after this pass, so joining it would only
      // number the name it had (`getPetsStatus2`).
      expect(
        names({
          '/shop/archive/pets-status/{id}/status': { get: item('id') },
          '/shop/pets/{id}/status': { get: item('id') },
          '/shop/pet/{id}/status': { get: item('id') },
        }),
      ).toEqual([
        'Shop.getPetsStatus             GET    /shop/archive/pets-status/{id}/status',
        'Shop.getPetStatus              GET    /shop/pet/{id}/status',
        'Shop.getPetStatus2             GET    /shop/pets/{id}/status',
      ]);
      // Beside an operation of another shape the plural is not what tells the
      // paths apart, so the singleton has none to keep and is numbered, as it
      // is beside an operationId alone.
      expect(
        names({
          '/shop/pet-status/{id}': { get: item('id') },
          '/shop/pets/{id}/status': { get: item('id') },
        }),
      ).toEqual([
        'Shop.getPetStatus              GET    /shop/pet-status/{id}',
        'Shop.getPetStatus2             GET    /shop/pets/{id}/status',
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reads a custom method after a colon as the segment it is written on followed by the verb', () => {
    expect(
      names({
        '/v1/pets/{petId}:status': { get: item('petId') },
        '/v1/pets/{petId}:adopt': { get: item('petId'), post: item('petId') },
        '/v1/pets:bulkDelete': { delete: ok },
      }),
    ).toEqual([
      'Pets.getPetAdopt               GET    /v1/pets/{petId}:adopt',
      'Pets.adoptPet                  POST   /v1/pets/{petId}:adopt',
      'Pets.getPetStatus              GET    /v1/pets/{petId}:status',
      'Pets.bulkDelete                DELETE /v1/pets:bulkDelete',
    ]);
  });

  it('qualifies colliding custom-method singletons by the parameter alone, never by the verb written after it', () => {
    expect(
      names({
        '/v1/pets/{petId}:history': { get: item('petId') },
        '/v1/{orgId}/pets/{petId}:history': { get: item('petId') },
      }),
    ).toEqual([
      'Pets.getPetHistory             GET    /v1/pets/{petId}:history',
      'Pets.getPetHistoryByOrgId      GET    /v1/{orgId}/pets/{petId}:history',
    ]);
  });

  it('is not consulted for an operation with an operationId', () => {
    expect(
      names({
        '/pets/{id}/status': { get: { ...item('id'), operationId: 'fetchStatus' } },
        '/pets/bulk-delete': { delete: { ...ok, operationId: 'purge' } },
      }),
    ).toEqual([
      'Pets.purge                     DELETE /pets/bulk-delete',
      'Pets.fetchStatus               GET    /pets/{id}/status',
    ]);
  });
});

describe('one name on one path: two methods never share it unless they are PUT and PATCH', () => {
  it('keeps the action with the method whose verb the segment carries; the other method takes its CRUD name', () => {
    expect(names({ '/pets/bulk-delete': { post: ok, delete: ok } })).toEqual([
      'Pets.bulkDelete                DELETE /pets/bulk-delete',
      'Pets.createBulkDelete          POST   /pets/bulk-delete',
    ]);
    expect(names({ '/users/{id}/update-password': { post: item('id'), put: item('id') } })).toEqual([
      'Users.createUserUpdatePassword POST   /users/{id}/update-password',
      'Users.updatePasswordUser       PUT    /users/{id}/update-password',
    ]);
  });

  it('keeps the action with POST when no method carries the verb, and shares it between PUT and PATCH', () => {
    expect(names({ '/pets/health-check': { get: ok, post: ok, put: ok } })).toEqual([
      'Pets.listHealthCheck           GET    /pets/health-check',
      'Pets.healthCheck               POST   /pets/health-check',
      'Pets.updateHealthCheck         PUT    /pets/health-check',
    ]);
    // `bulk-delete` carries DELETE's verb: the action is the DELETE's, declared
    // or not, and a POST on it is no action (#379).
    expect(names({ '/pets/bulk-delete': { get: ok, post: ok, put: ok } })).toEqual([
      'Pets.listBulkDelete            GET    /pets/bulk-delete',
      'Pets.createBulkDelete          POST   /pets/bulk-delete',
      'Pets.updateBulkDelete          PUT    /pets/bulk-delete',
    ]);
    expect(names({ '/pets/bulk-update': { post: ok, put: ok, patch: ok } })).toEqual([
      'Pets.bulkUpdate                PATCH  /pets/bulk-update',
      'Pets.createBulkUpdate          POST   /pets/bulk-update',
      'Pets.bulkUpdate                PUT    /pets/bulk-update',
    ]);
  });

  it('reads a custom method the same way', () => {
    expect(names({ '/v1/pets:bulkDelete': { post: ok, delete: ok } })).toEqual([
      'Pets.bulkDelete                DELETE /v1/pets:bulkDelete',
      'Pets.createBulkDelete          POST   /v1/pets:bulkDelete',
    ]);
  });

  it('keeps every method on a singleton or an item action distinct', () => {
    expect(
      names({
        '/pets/{id}/adopt': { get: item('id'), post: item('id'), put: item('id'), delete: item('id') },
        '/pets/{id}/status': {
          get: item('id'),
          post: item('id'),
          put: item('id'),
          patch: item('id'),
          delete: item('id'),
          head: item('id'),
        },
      }),
    ).toEqual([
      'Pets.deletePetAdopt            DELETE /pets/{id}/adopt',
      'Pets.getPetAdopt               GET    /pets/{id}/adopt',
      'Pets.adoptPet                  POST   /pets/{id}/adopt',
      'Pets.updatePetAdopt            PUT    /pets/{id}/adopt',
      'Pets.deletePetStatus           DELETE /pets/{id}/status',
      'Pets.getPetStatus              GET    /pets/{id}/status',
      'Pets.checkPetStatus            HEAD   /pets/{id}/status',
      'Pets.updatePetStatus           PATCH  /pets/{id}/status',
      'Pets.createPetStatus           POST   /pets/{id}/status',
      'Pets.updatePetStatus           PUT    /pets/{id}/status',
    ]);
  });

  it('steps aside for an operationId on the same path, whatever its verb, numbering when the CRUD name is held too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(names({ '/pets/bulk-delete': { post: ok, delete: { ...ok, operationId: 'bulkDelete' } } })).toEqual([
        'Pets.bulkDelete                DELETE /pets/bulk-delete',
        'Pets.createBulkDelete          POST   /pets/bulk-delete',
      ]);
      expect(names({ '/pets/bulk-delete': { post: ok, put: { ...ok, operationId: 'bulkDelete' } } })).toEqual([
        'Pets.createBulkDelete          POST   /pets/bulk-delete',
        'Pets.bulkDelete                PUT    /pets/bulk-delete',
      ]);
      expect(
        names({ '/pets/bulk-delete': { get: { ...ok, operationId: 'createBulkDelete' }, post: ok, delete: ok } }),
      ).toEqual([
        'Pets.bulkDelete                DELETE /pets/bulk-delete',
        'Pets.createBulkDelete          GET    /pets/bulk-delete',
        'Pets.createBulkDelete2         POST   /pets/bulk-delete',
      ]);
      // A path-named PATCH beside `operationId: updatePet` on the PUT has no
      // action to drop, so it is numbered, silently.
      expect(
        names({ '/store/pets/{id}': { put: { ...item('id'), operationId: 'updatePet' }, patch: item('id') } }),
      ).toEqual([
        'Store.updatePet2               PATCH  /store/pets/{id}',
        'Store.updatePet                PUT    /store/pets/{id}',
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('numbers an operationId the document reuses on one path, with the warning the numeric pass gives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        names({
          '/store/pets/{id}': {
            put: { ...item('id'), operationId: 'updatePet' },
            patch: { ...item('id'), operationId: 'updatePet' },
          },
        }),
      ).toEqual([
        'Store.updatePet2               PATCH  /store/pets/{id}',
        'Store.updatePet                PUT    /store/pets/{id}',
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/both take the name "updatePet" from their operationId/);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps path-named PUT and PATCH sharing a name on one path, and the plural they share', () => {
    expect(names({ '/store/pets/{id}': { put: item('id'), patch: item('id') } })).toEqual([
      'Store.updatePet                PATCH  /store/pets/{id}',
      'Store.updatePet                PUT    /store/pets/{id}',
    ]);
    expect(
      names({
        '/store/featured/{id}': { put: { ...item('id'), operationId: 'updatePet' } },
        '/store/pets/{id}': { put: item('id'), patch: item('id') },
      }),
    ).toEqual([
      'Store.updatePet                PUT    /store/featured/{id}',
      'Store.updatePets               PATCH  /store/pets/{id}',
      'Store.updatePets               PUT    /store/pets/{id}',
    ]);
  });

  it('never lands a renamed action on a name another operation on its path holds', () => {
    // The action takes `createPets` back from `POST /pets`, but the GET on
    // its path carries that operationId: the next free name is the one it
    // has without the action rule.
    expect(
      names({
        '/pets': { post: ok },
        '/pets/create': { post: ok, get: { ...ok, operationId: 'createPets' } },
      }),
    ).toEqual([
      'Pets.create                    POST   /pets',
      'Pets.createPets                GET    /pets/create',
      'Pets.createCreate              POST   /pets/create',
    ]);
    // The mirror: the GET is path-named and no action, the POST carries the operationId.
    expect(
      names({
        '/pets': { post: ok },
        '/pets/create': { get: ok, post: { ...ok, operationId: 'createPets' } },
      }),
    ).toEqual([
      'Pets.create                    POST   /pets',
      'Pets.listCreate                GET    /pets/create',
      'Pets.createPets                POST   /pets/create',
    ]);
  });

  it('skips a name a later pass would land on an operationId of the same path, and numbers the plain name', () => {
    // The service noun restored to `GET /api/notes` beside `operationId: list`
    // would be the POST's operationId on its own path, so it is not taken
    // (#288): the GET keeps `list` and, with no qualifier left, is `list2`,
    // never `listNotes2`, which reads as a variant of the POST.
    expect(
      names({
        '/api/notes': { get: ok, post: { ...ok, operationId: 'listNotes' } },
        '/api/{teamId}/notes': { get: { ...item('teamId'), operationId: 'list' } },
      }),
    ).toEqual([
      'Notes.list2                    GET    /api/notes',
      'Notes.listNotes                POST   /api/notes',
      'Notes.list                     GET    /api/{teamId}/notes',
    ]);
  });

  it('holds across every method on every action and singleton shape', () => {
    const every = { get: ok, post: ok, put: ok, patch: ok, delete: ok, head: ok };
    const everyItem = Object.fromEntries(Object.keys(every).map((m) => [m, item('id')]));
    const { services } = extractOperations({
      '/pets/bulk-delete': every,
      '/pets/list-all': every,
      '/pets/search': every,
      '/pets/{id}/adopt': everyItem,
      '/pets/{id}/status': everyItem,
      '/pets/{id}/update-password': everyItem,
      '/pets/{id}/photos': everyItem,
      '/v1/pets:batchGet': every,
      '/v1/pets/{id}:status': everyItem,
    } as Parameters<typeof extractOperations>[0]);
    expectUniqueNames(services);
    expect(services.flatMap((s) => s.operations).length).toBe(54);
  });
});

describe('an operation added beside an action takes no name an operation already has (issue #379)', () => {
  // Every operation tagged `Pets`, returning 204, with no operationId.
  const op = { tags: ['Pets'], responses: { '204': { description: 'ok' } } };
  const itemOp = { ...op, ...idParam('id') };

  /** `paths` with the operations of `more` declared too: a path both carry has the methods of both. */
  const withAdded = (paths: Paths, more: Paths): Paths => {
    const merged: Paths = { ...paths };
    for (const [p, methods] of Object.entries(more)) merged[p] = { ...merged[p], ...methods };
    return merged;
  };

  /** What `oagen diff` reports between two documents of `before` and `after`, one line per change. */
  async function diff(before: Paths, after: Paths) {
    const doc = (paths: Paths) => ({ openapi: '3.1.0', info: { title: 'repro', version: '1' }, paths });
    const { changes, summary } = diffSpecs(
      await parseSpec(await writeSpec('old.json', doc(before))),
      await parseSpec(await writeSpec('new.json', doc(after))),
    );
    return {
      breaking: summary.breaking,
      changes: changes.map((c) => `${c.kind} ${'operationName' in c ? c.operationName : ''}: ${c.classification}`),
    };
  }

  /**
   * Each case declares `before`, then adds `more`, in both orders: whichever
   * operation the document had, the other one comes in as one additive
   * `operation-added`, under the name it has in the merged document, and the
   * one already there keeps its own.
   */
  async function expectAdditive(before: Paths, more: Paths, named: { before: string; more: string }) {
    const after = withAdded(before, more);
    expect(await diff(before, after)).toEqual({ breaking: 0, changes: [`operation-added ${named.more}: additive`] });
    expect(await diff(more, after)).toEqual({ breaking: 0, changes: [`operation-added ${named.before}: additive`] });
  }

  it('reports each pair of the issue as one additive operation-added', async () => {
    // `POST /pets/bulk-delete` carries DELETE's verb, so the action is the
    // DELETE's whether or not it is declared.
    await expectAdditive(
      { '/pets/bulk-delete': { post: op } },
      { '/pets/bulk-delete': { delete: op } },
      { before: 'createBulkDelete', more: 'bulkDelete' },
    );
    // `POST /pets` is `create`, so the action on `/pets/create` never is.
    await expectAdditive(
      { '/pets/create': { post: op } },
      { '/pets': { post: op } },
      { before: 'createPets', more: 'create' },
    );
    // `update` is PUT's verb: a POST on it is no action.
    await expectAdditive(
      { '/pets/update': { post: op } },
      { '/pets/{id}': { put: itemOp } },
      { before: 'createUpdate', more: 'update' },
    );
  });

  it('names an action alike whether or not the operation that could share its name is declared', async () => {
    // A POST after a parameter on a segment that carries PUT's verb.
    await expectAdditive(
      { '/pets/{id}/update-password': { post: itemOp } },
      { '/pets/{id}/update-password': { put: itemOp } },
      { before: 'createPetUpdatePassword', more: 'updatePasswordPet' },
    );
    // An action whose name the operation of its method on the path without
    // the verb has: `GET /pets/all` is `listAll`, `PUT /pets` is `update`,
    // `POST /store/pets/{id}` is `createPet`.
    await expectAdditive(
      { '/pets/list-all': { get: op } },
      { '/pets/all': { get: op } },
      { before: 'listAllPets', more: 'listAll' },
    );
    await expectAdditive(
      { '/pets/update': { put: op } },
      { '/pets/{id}': { put: itemOp } },
      { before: 'updatePets', more: 'update' },
    );
    await expectAdditive(
      { '/store/pets/{id}/create': { post: itemOp } },
      { '/store/pets/{id}': { post: itemOp } },
      { before: 'createPetCreate', more: 'createPet' },
    );
    await expectAdditive(
      { '/store/pets/update': { post: op } },
      { '/store/pets': { put: op } },
      { before: 'createUpdate', more: 'updatePets' },
    );
    // `get` reads one item: `GET /pets/{id}` is `get`.
    await expectAdditive(
      { '/pets/get': { get: op } },
      { '/pets/{id}': { get: itemOp } },
      { before: 'getPets', more: 'get' },
    );
    // Both names it would take back are operationIds': the action is
    // numbered on its name without the action rule, the CRUD operation
    // declared or not.
    const held: Paths = {
      '/pets/create': { post: op },
      '/pets/a': { get: { ...op, operationId: 'createPets' } },
      '/pets/b': { get: { ...op, operationId: 'createCreate' } },
    };
    expect(await diff(held, withAdded(held, { '/pets': { post: op } }))).toEqual({
      breaking: 0,
      changes: ['operation-added create: additive'],
    });
    expect(names(held)).toContain('Pets.createCreate2             POST   /pets/create');
    // On a bare parameter both names it could take back are its own, and
    // `PUT /{id}` lands in its service: it is numbered alone too.
    await expectAdditive(
      { '/{id}/update': { put: itemOp } },
      { '/{id}': { put: itemOp } },
      { before: 'update2', more: 'update' },
    );
    // Untagged, a literal that names its service shares no service with the
    // path without it (`V1` for `/v1/{id}`), so it keeps its name.
    expect(names({ '/{id}/update': { put: item('id') } })).toEqual([
      'Default.update2                PUT    /{id}/update',
    ]);
    expect(names({ '/v1/{id}/update': { put: item('id') }, '/v1/{id}': { put: item('id') } })).toEqual([
      'V1.update                      PUT    /v1/{id}',
      'Update.update                  PUT    /v1/{id}/update',
    ]);
    expect(names({ '/create': { post: ok } })).toEqual(['Create.create                  POST   /create']);
  });

  it('gives PUT and PATCH on one path the one name their action yields to', () => {
    expect(names({ '/pets/update': { put: ok, patch: ok } })).toEqual([
      'Pets.updatePets                PATCH  /pets/update',
      'Pets.updatePets                PUT    /pets/update',
    ]);
    expect(
      names({
        '/pets/update': { put: ok, patch: ok },
        '/pets/{id}': { put: item('id') },
        '/store/pets/{id}/update': { put: item('id'), patch: item('id') },
      }),
    ).toEqual([
      'Pets.updatePets                PATCH  /pets/update',
      'Pets.updatePets                PUT    /pets/update',
      'Pets.update                    PUT    /pets/{id}',
      'Store.updatePetUpdate          PATCH  /store/pets/{id}/update',
      'Store.updatePetUpdate          PUT    /store/pets/{id}/update',
    ]);
  });
});
