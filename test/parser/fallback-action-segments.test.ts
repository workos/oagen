import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractOperations } from '../../src/parser/operations.js';
import { parseSpec } from '../../src/parser/parse.js';
import { collectModelRefs } from '../../src/ir/types.js';

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

  it('reads a literal with no parameter before it whose last word is a CRUD verb as the action, for any method', () => {
    expect(
      names({
        '/pets/bulk-delete': { post: ok },
        '/store/pets/bulk-update': { post: ok },
        '/store/pets/{id}/photos/bulk-delete': { post: item('id') },
        '/store/pets/delete-candidates': { get: ok },
        '/store/events/check-ins': { get: ok },
        '/store/settings/display-options': { get: ok },
        '/store/pets/search': { post: ok },
      }),
    ).toEqual([
      'Pets.bulkDelete                POST   /pets/bulk-delete',
      'Store.listCheckIns             GET    /store/events/check-ins',
      'Store.bulkUpdatePets           POST   /store/pets/bulk-update',
      'Store.listDeleteCandidates     GET    /store/pets/delete-candidates',
      'Store.createSearch             POST   /store/pets/search',
      'Store.bulkDeletePhotos         POST   /store/pets/{id}/photos/bulk-delete',
      'Store.listDisplayOptions       GET    /store/settings/display-options',
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
      'Shop.bulkDeletePets            POST   /shop/pets/bulk-delete',
      'Shop.getPetStatus              GET    /shop/pets/{id}/status',
      'Shop.bulkDeletePetsRescue      POST   /shop/rescue/pets/bulk-delete',
      'Shop.getPetStatusRescue        GET    /shop/rescue/pets/{id}/status',
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
    expect(names({ '/pets/bulk-delete': { get: ok, post: ok, put: ok } })).toEqual([
      'Pets.listBulkDelete            GET    /pets/bulk-delete',
      'Pets.bulkDelete                POST   /pets/bulk-delete',
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
