import { describe, it, expect } from 'vitest';
import { extractOperations } from '../../src/parser/operations.js';

/**
 * Fallback operation names — the `<verb><Resource>` an operation gets when it
 * has no `operationId` (issue #210): the resource of an item operation is
 * singular, and a POST to a literal after an item parameter is an action.
 */

const ok = { responses: { '204': { description: 'ok' } } };
const idParam = (name: string) => ({
  parameters: [{ name, in: 'path' as const, required: true, schema: { type: 'string' } }],
});
const item = (name: string) => ({ ...ok, ...idParam(name) });

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';

/** `name METHOD path` for every operation, sorted by path (code units) then method. */
function names(paths: Record<string, Partial<Record<Method, unknown>>>) {
  const { services } = extractOperations(paths as Parameters<typeof extractOperations>[0]);
  const key = (op: { path: string; httpMethod: string }) => `${op.path}\0${op.httpMethod}`;
  return services
    .flatMap((s) => s.operations)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .map((op) => `${op.name.padEnd(28)} ${op.httpMethod.toUpperCase().padEnd(6)} ${op.path}`);
}

describe('fallback operation names (issue #210)', () => {
  it('names the issue repro: singular item, action verb with its parent', () => {
    const result = names({
      '/store/pets': { get: ok },
      '/store/pets/{petId}': { get: item('petId') },
      '/store/pets/{petId}/adopt': { post: item('petId') },
    });
    expect(result).toMatchInlineSnapshot(`
      [
        "listPets                     GET    /store/pets",
        "getPet                       GET    /store/pets/{petId}",
        "adoptPet                     POST   /store/pets/{petId}/adopt",
      ]
    `);
  });

  it('singularises the resource of an item operation for every HTTP method', () => {
    const result = names({
      '/store/pets/{petId}': {
        get: item('petId'),
        put: item('petId'),
        patch: item('petId'),
        delete: item('petId'),
        head: item('petId'),
        post: item('petId'),
      },
    });
    expect(result).toEqual([
      'deletePet                    DELETE /store/pets/{petId}',
      'getPet                       GET    /store/pets/{petId}',
      'checkPet                     HEAD   /store/pets/{petId}',
      'updatePet                    PATCH  /store/pets/{petId}',
      'createPet                    POST   /store/pets/{petId}',
      'updatePet                    PUT    /store/pets/{petId}',
    ]);
  });

  it('keeps a collection plural, and a POST to it or below it a create', () => {
    const result = names({
      '/store/pets': { get: ok, post: ok },
      // A literal under a collection with no parameter before it cannot be told
      // from a nested collection such as /accounts/users/auth_factors.
      '/store/pets/search': { post: ok },
      '/store/pets/{petId}/photos': { get: item('petId'), post: item('petId') },
    });
    expect(result).toEqual([
      'listPets                     GET    /store/pets',
      'createPets                   POST   /store/pets',
      'createSearch                 POST   /store/pets/search',
      'listPhotos                   GET    /store/pets/{petId}/photos',
      'createPhotos                 POST   /store/pets/{petId}/photos',
    ]);
  });

  it('handles nested items and a POST action under a nested item', () => {
    const result = names({
      '/owners/{ownerId}/pets': { get: item('ownerId'), post: item('ownerId') },
      '/owners/{ownerId}/pets/{petId}': { get: item('ownerId'), delete: item('ownerId') },
      '/owners/{ownerId}/pets/{petId}/vaccinate': { post: item('ownerId') },
    });
    expect(result).toEqual([
      'listPets                     GET    /owners/{ownerId}/pets',
      'createPets                   POST   /owners/{ownerId}/pets',
      'deletePet                    DELETE /owners/{ownerId}/pets/{petId}',
      'getPet                       GET    /owners/{ownerId}/pets/{petId}',
      'vaccinatePet                 POST   /owners/{ownerId}/pets/{petId}/vaccinate',
    ]);
  });

  it('drops the service segment from a CRUD name but keeps it as the parent of an action', () => {
    const result = names({
      '/pets': { post: ok },
      '/pets/{petId}': { get: item('petId') },
      '/pets/{petId}/adopt': { post: item('petId') },
    });
    expect(result).toEqual([
      'create                       POST   /pets',
      'get                          GET    /pets/{petId}',
      'adoptPet                     POST   /pets/{petId}/adopt',
    ]);
  });

  it('does not collide two same-named actions on different resources in one service', () => {
    const tagged = (name: string) => ({ ...item(name), tags: ['admin'] });
    const result = names({
      '/pets/{petId}/archive': { post: tagged('petId') },
      '/users/{userId}/archive': { post: tagged('userId') },
    });
    expect(result).toEqual([
      'archivePet                   POST   /pets/{petId}/archive',
      'archiveUser                  POST   /users/{userId}/archive',
    ]);
  });

  it('singularises compound and sibilant resources', () => {
    const result = names({
      '/accounts/api_keys/{id}': { get: item('id') },
      '/accounts/auth-factors/{id}': { get: item('id') },
      '/accounts/directories/{id}': { get: item('id') },
      '/accounts/email_addresses/{id}': { get: item('id') },
      '/accounts/batches/{id}': { get: item('id') },
      '/accounts/boxes/{id}': { get: item('id') },
      '/accounts/statuses/{id}': { get: item('id') },
      '/accounts/responses/{id}': { get: item('id') },
    });
    expect(result).toEqual([
      'getApiKey                    GET    /accounts/api_keys/{id}',
      'getAuthFactor                GET    /accounts/auth-factors/{id}',
      'getBatch                     GET    /accounts/batches/{id}',
      'getBox                       GET    /accounts/boxes/{id}',
      'getDirectory                 GET    /accounts/directories/{id}',
      'getEmailAddress              GET    /accounts/email_addresses/{id}',
      'getResponse                  GET    /accounts/responses/{id}',
      'getStatus                    GET    /accounts/statuses/{id}',
    ]);
  });

  it('leaves a resource that is already singular, or does not look plural, alone', () => {
    const result = names({
      '/admin/status/{id}': { get: item('id') },
      '/admin/address/{id}': { get: item('id') },
      '/admin/analysis/{id}': { get: item('id') },
      '/admin/profile/{id}': { get: item('id') },
      '/status/{id}': { get: item('id') },
    });
    expect(result).toEqual([
      'getAddress                   GET    /admin/address/{id}',
      'getAnalysis                  GET    /admin/analysis/{id}',
      'getProfile                   GET    /admin/profile/{id}',
      'getStatus                    GET    /admin/status/{id}',
      'get                          GET    /status/{id}',
    ]);
  });

  it('documents the irregular plurals it deliberately does not handle', () => {
    const result = names({
      '/admin/people/{id}': { get: item('id') },
      '/admin/children/{id}': { get: item('id') },
      '/admin/data/{id}': { get: item('id') },
    });
    expect(result).toEqual([
      'getChildren                  GET    /admin/children/{id}',
      'getData                      GET    /admin/data/{id}',
      'getPeople                    GET    /admin/people/{id}',
    ]);
  });

  it('keeps a POST a create when the literal after the parameter ends in s', () => {
    const result = names({
      '/orgs/{id}/api_keys': { post: item('id') },
      '/orders/{id}/status': { post: item('id') },
      '/items/{id}/process': { post: item('id') },
    });
    expect(result).toEqual([
      'createProcess                POST   /items/{id}/process',
      'createStatus                 POST   /orders/{id}/status',
      'createApiKeys                POST   /orgs/{id}/api_keys',
    ]);
  });

  it('keeps a POST a create when no literal precedes the parameter, and camel-cases a multi-word action', () => {
    const result = names({
      '/{id}/adopt': { post: item('id') },
      '/users/{id}/reset_password': { post: item('id') },
      '/users/{id}/Deactivate': { post: item('id') },
    });
    expect(result).toEqual([
      'deactivateUser               POST   /users/{id}/Deactivate',
      'resetPasswordUser            POST   /users/{id}/reset_password',
      'createAdopt                  POST   /{id}/adopt',
    ]);
  });

  it('keeps an operationId unchanged when a singular fallback name collides with it', () => {
    const { services } = extractOperations({
      '/store/pets/{id}': { get: item('id') },
      '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
    } as Parameters<typeof extractOperations>[0]);
    const ops = services.flatMap((s) => s.operations);
    const explicit = ops.find((op) => op.path === '/store/featured/{id}')!;
    const fallback = ops.find((op) => op.path === '/store/pets/{id}')!;

    expect(explicit.name).toBe('getPet');
    expect(fallback.name).not.toBe('getPet');
    expect(new Set(ops.map((op) => op.name)).size).toBe(ops.length);
  });

  it('still qualifies every operation when two operationIds collide with each other', () => {
    const { services } = extractOperations({
      '/store/pets/{id}': { get: { ...item('id'), operationId: 'getPet' } },
      '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
    } as Parameters<typeof extractOperations>[0]);
    const opNames = services.flatMap((s) => s.operations).map((op) => op.name);
    expect(new Set(opNames).size).toBe(2);
  });

  it('keeps an all-caps resource one word when singularised', () => {
    const result = names({
      '/store/DIRECTORIES/{id}': { get: item('id') },
      '/store/ADDRESSES/{id}': { get: item('id') },
      '/store/PETS/{id}': { get: item('id') },
      '/store/Policies/{id}': { get: item('id') },
    });
    expect(result).toEqual([
      'getAddress                   GET    /store/ADDRESSES/{id}',
      'getDirectory                 GET    /store/DIRECTORIES/{id}',
      'getPet                       GET    /store/PETS/{id}',
      'getPolicy                    GET    /store/Policies/{id}',
    ]);
  });

  it('is not consulted for an operation with an operationId', () => {
    const paths = {
      '/store/pets/{petId}': { get: { ...item('petId'), operationId: 'fetchPets' } },
      '/store/pets/{petId}/adopt': { post: { ...item('petId'), operationId: 'createAdoption' } },
    };
    expect(names(paths)).toEqual([
      'fetchPets                    GET    /store/pets/{petId}',
      'createAdoption               POST   /store/pets/{petId}/adopt',
    ]);

    const { services } = extractOperations(paths, (id) => `${id}_v2`);
    const transformed = services.flatMap((s) => s.operations).map((o) => o.name);
    expect(transformed.sort()).toEqual(['createAdoption_v2', 'fetchPets_v2']);
  });
});
