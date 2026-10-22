import { describe, it, expect, vi } from 'vitest';
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

  it('names an action with no literal parent by the bare verb, and camel-cases a multi-word action', () => {
    const result = names({
      '/{id}/adopt': { post: item('id') },
      '/users/{id}/reset_password': { post: item('id') },
      '/users/{id}/Deactivate': { post: item('id') },
    });
    expect(result).toEqual([
      'deactivateUser               POST   /users/{id}/Deactivate',
      'resetPasswordUser            POST   /users/{id}/reset_password',
      'adopt                        POST   /{id}/adopt',
    ]);
  });

  it('skips API root and version markers when picking the parent of an action', () => {
    // No shared root here (`/api/v1` beside `/v2` and `/store`), so the
    // marker check alone keeps `V1` out of the names.
    const result = names({
      '/api/v1/{companyId}/sendDocument': { post: item('companyId') },
      '/api/v1/{teamId}/subscription': { post: item('teamId') },
      '/api/v1/pets/{petId}/adopt': { post: item('petId') },
      '/v2/pets/{petId}/adopt': { post: item('petId') },
      '/store/pets/{petId}/adopt': { post: item('petId') },
    });
    expect(result).toEqual([
      'adoptPet                     POST   /api/v1/pets/{petId}/adopt',
      'sendDocument                 POST   /api/v1/{companyId}/sendDocument',
      'subscription                 POST   /api/v1/{teamId}/subscription',
      'adoptPet                     POST   /store/pets/{petId}/adopt',
      'adoptPet                     POST   /v2/pets/{petId}/adopt',
    ]);
    // A tagged operation has no API root and relies on the marker check too.
    expect(names({ '/api/v1/{orgId}/sendInvite': { post: { ...item('orgId'), tags: ['invites'] } } })).toEqual([
      'sendInvite                   POST   /api/v1/{orgId}/sendInvite',
    ]);
    // A document root that carries a non-marker word (#224) is skipped whole.
    expect(
      names({
        '/wiki/rest/api/content': { get: ok },
        '/wiki/rest/api/{id}/publish': { post: item('id') },
      }),
    ).toEqual([
      'list                         GET    /wiki/rest/api/content',
      'publish                      POST   /wiki/rest/api/{id}/publish',
    ]);
  });

  it('does not repeat the parent when the action already ends with it', () => {
    const result = names({
      '/companies/verification/{id}/restart-id-verification': { post: item('id') },
      '/companies/verification/{id}/submit-playground-verification': { post: item('id') },
      '/companies/verification/{id}/restart': { post: item('id') },
    });
    expect(result).toEqual([
      'restartVerification          POST   /companies/verification/{id}/restart',
      'restartIdVerification        POST   /companies/verification/{id}/restart-id-verification',
      'submitPlaygroundVerification POST   /companies/verification/{id}/submit-playground-verification',
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
    // Nothing in `/store/pets/{id}` tells it from `/store/featured/{id}`, so
    // the fallback keeps the plural it had before singularisation.
    expect(fallback.name).toBe('getPets');
    expect(new Set(ops.map((op) => op.name)).size).toBe(ops.length);
  });

  it('still tells two colliding operationIds apart when a fallback joins their group', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { services } = extractOperations({
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'get_pet' } },
        '/store/rescues/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/pets/{id}': { get: item('id') },
      } as Parameters<typeof extractOperations>[0]);
      const ops = services.flatMap((s) => s.operations);

      expect(new Set(ops.map((op) => op.name)).size).toBe(3);
      expect(ops.find((op) => op.path === '/store/pets/{id}')!.name).not.toBe('getPet');
      // The reused operationId is numbered with a warning (#227); the fallback
      // takes its plural rather than a third number.
      expect(Object.fromEntries(ops.map((op) => [op.path, op.name]))).toEqual({
        '/store/featured/{id}': 'getPet',
        '/store/rescues/{id}': 'getPet2',
        '/store/pets/{id}': 'getPets',
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps every name unique with two operationIds and two fallbacks in one group', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { services } = extractOperations({
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'get_pet' } },
        '/store/rescues/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/pets/{id}': { get: item('id') },
        '/store/shelter/pets/{id}': { get: item('id') },
      } as Parameters<typeof extractOperations>[0]);
      const ops = services.flatMap((s) => s.operations);

      expect(new Set(ops.map((op) => op.name)).size).toBe(4);
      for (const op of ops.filter((o) => o.path.endsWith('pets/{id}'))) expect(op.name).not.toBe('getPet');
      // The deeper path context separates `/store/shelter/pets/{id}` on its
      // own; only the fallback with nothing to add takes the plural.
      expect(Object.fromEntries(ops.map((op) => [op.path, op.name]))).toEqual({
        '/store/featured/{id}': 'getPet',
        '/store/rescues/{id}': 'getPet2',
        '/store/pets/{id}': 'getPets',
        '/store/shelter/pets/{id}': 'getPetShelter',
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('numbers the second of two colliding operationIds with a warning, as #227 does', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { services } = extractOperations({
        '/store/pets/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
      } as Parameters<typeof extractOperations>[0]);
      const opNames = services.flatMap((s) => s.operations).map((op) => op.name);
      expect(new Set(opNames).size).toBe(2);
      // The lexically first path keeps the name, whatever the document order.
      expect(opNames.sort()).toEqual(['getPet', 'getPet2']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/both take the name "getPet" from their operationId/);
    } finally {
      warn.mockRestore();
    }
  });

  it('prefers the plural a fallback had before singularisation over a numeric suffix, whatever the order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const explicitFirst = {
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/pets/{id}': { get: item('id') },
      };
      const fallbackFirst = {
        '/store/pets/{id}': { get: item('id') },
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
      };
      const expected = [
        'getPet                       GET    /store/featured/{id}',
        'getPets                      GET    /store/pets/{id}',
      ];
      expect(names(explicitFirst)).toEqual(expected);
      expect(names(fallbackFirst)).toEqual(expected);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('shares the plural between PUT and PATCH on one path', () => {
    expect(
      names({
        '/store/featured/{id}': { put: { ...item('id'), operationId: 'updatePet' } },
        '/store/pets/{id}': { put: item('id'), patch: item('id') },
      }),
    ).toEqual([
      'updatePet                    PUT    /store/featured/{id}',
      'updatePets                   PATCH  /store/pets/{id}',
      'updatePets                   PUT    /store/pets/{id}',
    ]);
  });

  it('keeps the singular for two fallbacks whose resources differ: their paths tell them apart', () => {
    expect(
      names({
        '/store/pets/{id}': { get: item('id') },
        '/store/cats/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getCat                       GET    /store/cats/{id}',
      'getPet                       GET    /store/pets/{id}',
    ]);
  });

  it('falls back to a numeric suffix when the plural is taken as well', () => {
    expect(
      names({
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/all/{id}': { get: { ...item('id'), operationId: 'getPets' } },
        '/store/pets/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getPets                      GET    /store/all/{id}',
      'getPet                       GET    /store/featured/{id}',
      'getPet2                      GET    /store/pets/{id}',
    ]);
  });

  it('numbers an action next to an operationId of the same name: a verb has no plural', () => {
    expect(
      names({
        '/store/featured/{id}': { post: { ...item('id'), operationId: 'adoptPet' } },
        '/store/pets/{id}/adopt': { post: item('id') },
      }),
    ).toEqual([
      'adoptPet                     POST   /store/featured/{id}',
      'adoptPet2                    POST   /store/pets/{id}/adopt',
    ]);
  });

  it('qualifies two colliding actions by what sets their paths apart, never by repeating the verb', () => {
    // The deeper path context of the parent, not of the action segment.
    expect(
      names({
        '/shop/pets/{id}/adopt': { post: item('id') },
        '/shop/rescue/pets/{id}/adopt': { post: item('id') },
      }),
    ).toEqual([
      'adoptPet                     POST   /shop/pets/{id}/adopt',
      'adoptPetRescue               POST   /shop/rescue/pets/{id}/adopt',
    ]);
    // Under an API root (#224) the parameters tell the paths apart (#227);
    // one every path carries, `petId`, adds nothing (#258).
    expect(
      names({
        '/api/v1/pets/{petId}/adopt': { post: item('petId') },
        '/api/v1/{orgId}/pets/{petId}/adopt': { post: item('petId') },
      }),
    ).toEqual([
      'adoptPet                     POST   /api/v1/pets/{petId}/adopt',
      'adoptPetByOrgId              POST   /api/v1/{orgId}/pets/{petId}/adopt',
    ]);
  });

  it('meets a tenant-scoped item in one service under an API root, with no repeated word and no version', () => {
    const { services } = extractOperations({
      '/api/v1/pets/{petId}': { get: item('petId') },
      '/api/v1/{orgId}/pets/{petId}': { get: item('petId') },
    } as Parameters<typeof extractOperations>[0]);
    // `petId` is on both paths, so only `orgId` qualifies (#258).
    expect(services.flatMap((s) => s.operations.map((op) => `${s.name}.${op.name} ${op.path}`)).sort()).toEqual([
      'Pets.get /api/v1/pets/{petId}',
      'Pets.getByOrgId /api/v1/{orgId}/pets/{petId}',
    ]);
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

/**
 * Issue #268: two path-named operations whose paths differ only by a plural
 * got a number instead of the plural, a plural segment between the service
 * and the resource stayed plural when it qualified a name, and `aliases` and
 * `analyses` stemmed to `aliase` and `analyse`.
 */
describe('plural path names (issue #268)', () => {
  const json = {
    responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } },
  };
  /** The issue's operations: tagged `Store`, `200` with a JSON string. */
  const tagged = (...params: string[]) => ({
    ...json,
    tags: ['Store'],
    parameters: params.map((name) => ({ name, in: 'path' as const, required: true, schema: { type: 'string' } })),
  });
  /** The issue's own print-out: one entry per service, `name: METHOD /path` per operation. */
  const services = (paths: Record<string, Partial<Record<Method, unknown>>>) =>
    extractOperations(paths as Parameters<typeof extractOperations>[0]).services.map(({ name, operations }) => ({
      name,
      operations: operations.map((op) => `${op.name}: ${op.httpMethod.toUpperCase()} ${op.path}`),
    }));

  it('names the issue repro: the plural kept, a singular parent in the deeper context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const repro = {
        '/store/pets/{id}': { get: tagged('id') },
        '/store/pet/{id}': { get: tagged('id') },
        '/store/cats/{id}/toys/{toyId}': { get: tagged('id', 'toyId'), delete: tagged('id', 'toyId') },
        '/store/dogs/{id}/toys/{toyId}': { get: tagged('id', 'toyId'), delete: tagged('id', 'toyId') },
      };
      expect(services(repro)).toEqual([
        {
          name: 'Store',
          operations: [
            'getPets: GET /store/pets/{id}',
            'getPet: GET /store/pet/{id}',
            'getToyCat: GET /store/cats/{id}/toys/{toyId}',
            'deleteToyCat: DELETE /store/cats/{id}/toys/{toyId}',
            'getToyDog: GET /store/dogs/{id}/toys/{toyId}',
            'deleteToyDog: DELETE /store/dogs/{id}/toys/{toyId}',
          ],
        },
      ]);
      // The same names whatever the document order.
      const reversed = Object.fromEntries(Object.entries(repro).reverse());
      expect(names(reversed)).toEqual(names(repro));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the plural of statuses beside status and of aliases beside alias, and stems analyses', () => {
    expect(
      names({
        '/org/statuses/{id}': { get: item('id') },
        '/org/status/{id}': { get: item('id') },
        '/org/aliases/{id}': { get: item('id') },
        '/org/alias/{id}': { get: item('id') },
        '/org/analyses/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getAlias                     GET    /org/alias/{id}',
      'getAliases                   GET    /org/aliases/{id}',
      'getAnalysis                  GET    /org/analyses/{id}',
      'getStatus                    GET    /org/status/{id}',
      'getStatuses                  GET    /org/statuses/{id}',
    ]);
  });

  it('shares the plural between PUT and PATCH beside the singular path', () => {
    expect(
      names({
        '/store/pets/{id}': { put: item('id'), patch: item('id') },
        '/store/pet/{id}': { put: item('id') },
      }),
    ).toEqual([
      'updatePet                    PUT    /store/pet/{id}',
      'updatePets                   PATCH  /store/pets/{id}',
      'updatePets                   PUT    /store/pets/{id}',
    ]);
  });

  it('numbers members that would all take the same plural: it would say nothing about which is which', () => {
    // `/store/Pets/{id}` and `/store/pets/{id}` flatten to the same words and
    // the same plural; the lexically first path keeps the plain name, as in
    // every numeric pass.
    expect(
      names({
        '/store/pets/{id}': { get: item('id') },
        '/store/Pets/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getPet                       GET    /store/Pets/{id}',
      'getPet2                      GET    /store/pets/{id}',
    ]);
  });

  it('gives the plural to the plural path when an operationId joins the pair, and numbers the singular path', () => {
    expect(
      names({
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/pets/{id}': { get: item('id') },
        '/store/pet/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getPet                       GET    /store/featured/{id}',
      'getPet2                      GET    /store/pet/{id}',
      'getPets                      GET    /store/pets/{id}',
    ]);
  });

  it('falls back to a numeric suffix for the pair when the plural is taken', () => {
    expect(
      names({
        '/store/all/{id}': { get: { ...item('id'), operationId: 'getPets' } },
        '/store/pets/{id}': { get: item('id') },
        '/store/pet/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getPets                      GET    /store/all/{id}',
      'getPet                       GET    /store/pet/{id}',
      'getPet2                      GET    /store/pets/{id}',
    ]);
  });

  it('singularises a deeper segment only when a parameter follows it, and keeps the rest as written', () => {
    // `cats` in `/store/cats/toys/{toyId}` addresses no one cat, so it stays
    // plural, exactly as a collection resource does; `legacy` is not plural.
    expect(
      names({
        '/store/cats/toys/{toyId}': { get: item('toyId') },
        '/store/dogs/toys/{toyId}': { get: item('toyId') },
        '/users/{id}/legacy/factors': { get: item('id') },
        '/users/{id}/factors': { get: item('id') },
      }),
    ).toEqual([
      'getToyCats                   GET    /store/cats/toys/{toyId}',
      'getToyDogs                   GET    /store/dogs/toys/{toyId}',
      'listFactors                  GET    /users/{id}/factors',
      'listFactorsLegacy            GET    /users/{id}/legacy/factors',
    ]);
  });

  it('does not repeat the resource in the other number, and still appends every parameter in path order', () => {
    // The deeper context of `/orgs/notes/{id}/notes` is `Note`, the noun the
    // name already ends with, so it is absorbed and the parameter decides.
    expect(
      names({
        '/orgs/notes': { get: ok },
        '/orgs/notes/{id}/notes': { get: item('id') },
      }),
    ).toEqual([
      'listNotes                    GET    /orgs/notes',
      'listNotesById                GET    /orgs/notes/{id}/notes',
    ]);
    // The same for a noun whose singular ends in `s`: `aliases` and `alias`
    // are one noun, and `alias` is not shortened a second time to `alia`.
    expect(
      names({
        '/org/aliases': { get: ok },
        '/org/aliases/{id}/aliases': { get: item('id') },
      }),
    ).toEqual([
      'listAliases                  GET    /org/aliases',
      'listAliasesById              GET    /org/aliases/{id}/aliases',
    ]);
    // With no deeper context to tell them apart, one `By<Param>` per
    // parameter of its own, in path order.
    expect(
      names({
        '/orgs/members': { get: ok },
        '/orgs/{orgId}/{teamId}/members': { get: item('orgId') },
      }),
    ).toEqual([
      'listMembers                  GET    /orgs/members',
      'listMembersByOrgIdByTeamId   GET    /orgs/{orgId}/{teamId}/members',
    ]);
  });

  it('keeps a deeper segment as written when the plural is what tells two paths apart (review)', () => {
    // One segment deeper than the issue's repro: the singular `Pet` would
    // give both paths `getToyPet`, so the plural path keeps its spelling.
    expect(
      names({
        '/store/pets/{id}/toys/{toyId}': { get: item('id'), delete: item('id') },
        '/store/pet/{id}/toys/{toyId}': { get: item('id'), delete: item('id') },
        '/org/statuses/{id}/notes/{noteId}': { get: item('id') },
        '/org/status/{id}/notes/{noteId}': { get: item('id') },
        '/org/aliases/{id}/notes/{noteId}': { get: item('id') },
        '/org/alias/{id}/notes/{noteId}': { get: item('id') },
      }),
    ).toEqual([
      'getNoteAlias                 GET    /org/alias/{id}/notes/{noteId}',
      'getNoteAliases               GET    /org/aliases/{id}/notes/{noteId}',
      'getNoteStatus                GET    /org/status/{id}/notes/{noteId}',
      'getNoteStatuses              GET    /org/statuses/{id}/notes/{noteId}',
      'deleteToyPet                 DELETE /store/pet/{id}/toys/{toyId}',
      'getToyPet                    GET    /store/pet/{id}/toys/{toyId}',
      'deleteToyPets                DELETE /store/pets/{id}/toys/{toyId}',
      'getToyPets                   GET    /store/pets/{id}/toys/{toyId}',
    ]);
    // Three paths: the two plural spellings share the written form and are
    // numbered, while the singular path keeps the singular name.
    expect(
      names({
        '/store/Pets/{id}/toys/{toyId}': { get: item('id') },
        '/store/pets/{id}/toys/{toyId}': { get: item('id') },
        '/store/pet/{id}/toys/{toyId}': { get: item('id') },
      }),
    ).toEqual([
      'getToyPets                   GET    /store/Pets/{id}/toys/{toyId}',
      'getToyPet                    GET    /store/pet/{id}/toys/{toyId}',
      'getToyPets2                  GET    /store/pets/{id}/toys/{toyId}',
    ]);
  });

  it('keeps a deeper segment as written when the singular would take an operationId (review)', () => {
    expect(
      names({
        '/store/featured/{toyId}': { get: { ...item('toyId'), operationId: 'getToyCat' } },
        '/store/cats/{id}/toys/{toyId}': { get: item('id') },
        '/store/dogs/{id}/toys/{toyId}': { get: item('id') },
      }),
    ).toEqual([
      'getToyCats                   GET    /store/cats/{id}/toys/{toyId}',
      'getToyDog                    GET    /store/dogs/{id}/toys/{toyId}',
      'getToyCat                    GET    /store/featured/{toyId}',
    ]);
    // An item segment beside the same segment as a collection: the singular
    // and the plural tell them apart, with no parameter needed.
    expect(
      names({
        '/store/cats/{id}/toys/{toyId}': { get: item('id') },
        '/store/cats/toys/{toyId}': { get: item('toyId') },
      }),
    ).toEqual([
      'getToyCats                   GET    /store/cats/toys/{toyId}',
      'getToyCat                    GET    /store/cats/{id}/toys/{toyId}',
    ]);
  });

  it('stays singular when two paths agree in both spellings, and goes on to the parameters', () => {
    expect(
      names({
        '/orgs/teams/{id}/members': { get: item('id') },
        '/orgs/{orgId}/teams/{id}/members': { get: item('orgId') },
      }),
    ).toEqual([
      'listMembersTeam              GET    /orgs/teams/{id}/members',
      'listMembersTeamByOrgId       GET    /orgs/{orgId}/teams/{id}/members',
    ]);
  });

  it('shares a plural between members some other member does not take, and numbers them (review)', () => {
    expect(
      names({
        '/store/Pets/{id}': { get: item('id') },
        '/store/pets/{id}': { get: item('id') },
        '/store/pet/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getPets                      GET    /store/Pets/{id}',
      'getPet                       GET    /store/pet/{id}',
      'getPets2                     GET    /store/pets/{id}',
    ]);
    expect(
      names({
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/Pets/{id}': { get: item('id') },
        '/store/pets/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getPets                      GET    /store/Pets/{id}',
      'getPet                       GET    /store/featured/{id}',
      'getPets2                     GET    /store/pets/{id}',
    ]);
  });

  it("applies the stemmer's documented limits to a deeper segment as well (review)", () => {
    // `sms` is an acronym the stemmer reads as a plural; the limit is
    // documented on singularizePathSegment and reaches the deeper context.
    expect(
      names({
        '/messages/sms/{smsId}/attachments': { get: item('smsId') },
        '/messages/{id}/attachments': { get: item('id') },
      }),
    ).toEqual([
      'listAttachmentsSm            GET    /messages/sms/{smsId}/attachments',
      'listAttachments              GET    /messages/{id}/attachments',
    ]);
  });

  it('singularises the service noun restored to an item operation', () => {
    // `/api/notes/{noteId}` would read `Note` were `notes` not the service
    // segment, so that is the noun restored beside `operationId: get`; the
    // collection `/api/notes` beside `operationId: list` keeps `Notes`.
    expect(
      names({
        '/api/notes/{noteId}': { get: item('noteId') },
        '/api/{teamId}/notes/{noteId}': { get: { ...item('teamId'), operationId: 'get' } },
        '/api/notes': { get: json },
        '/api/{teamId}/notes': { get: { ...item('teamId'), operationId: 'list' } },
      }),
    ).toEqual([
      'listNotes                    GET    /api/notes',
      'getNote                      GET    /api/notes/{noteId}',
      'list                         GET    /api/{teamId}/notes',
      'get                          GET    /api/{teamId}/notes/{noteId}',
    ]);
  });
});

/**
 * Custom-method paths (issue #269): an action written after a colon on the
 * segment it acts on, `/pets/{petId}:adopt`, is named exactly like the same
 * action written with a slash. Every reading of the path splits the segment
 * the same way, so the verb never lands inside a `By<Param>` qualifier.
 */
describe('custom-method paths (issue #269)', () => {
  const json = {
    responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } },
  };
  const jsonItem = (name: string) => ({ ...json, ...idParam(name) });

  it('names the issue repro: a custom method on an item is the verb plus its singular parent', () => {
    const result = names({
      '/v1/pets/{petId}:adopt': { post: jsonItem('petId') },
      '/v1/pets/{petId}:archive': { post: jsonItem('petId') },
      '/v1/pets/{petId}/feed': { post: jsonItem('petId') },
    });
    expect(result).toMatchInlineSnapshot(`
      [
        "feedPet                      POST   /v1/pets/{petId}/feed",
        "adoptPet                     POST   /v1/pets/{petId}:adopt",
        "archivePet                   POST   /v1/pets/{petId}:archive",
      ]
    `);
  });

  it('names a tagged custom method on an item the same way, keeping the service segment as the parent', () => {
    expect(names({ '/pets/{petId}:adopt': { post: { ...jsonItem('petId'), tags: ['pets'] } } })).toEqual([
      'adoptPet                     POST   /pets/{petId}:adopt',
    ]);
  });

  it('names the service from the collection a custom method is written on, and reads it like the slash form', () => {
    const paths = { '/v1/pets:batchGet': { post: json }, '/v1/pets': { get: json } };
    const { services } = extractOperations(paths as Parameters<typeof extractOperations>[0]);
    expect(services.map((s) => s.name)).toEqual(['Pets']);
    expect(names(paths)).toEqual([
      'list                         GET    /v1/pets',
      'createBatchGet               POST   /v1/pets:batchGet',
    ]);
  });

  it('qualifies by the parameter alone, never by the verb written after it', () => {
    expect(names({ '/pets/{petId}:history': { get: jsonItem('petId') }, '/pets/history': { get: json } })).toEqual([
      'listHistory                  GET    /pets/history',
      'listHistoryByPetId           GET    /pets/{petId}:history',
    ]);
  });

  it('reads a custom method and its slash form as the same words', () => {
    expect(
      names({ '/pets/{petId}:adopt': { post: jsonItem('petId') }, '/pets/{petId}/adopt': { post: jsonItem('petId') } }),
    ).toEqual([
      'adoptPet                     POST   /pets/{petId}/adopt',
      'adoptPet2                    POST   /pets/{petId}:adopt',
    ]);
  });

  /** One entry per service, `name: METHOD /path` per operation, as the issue prints it. */
  const services = (paths: Record<string, Partial<Record<Method, unknown>>>) =>
    extractOperations(paths as Parameters<typeof extractOperations>[0]).services.map(({ name, operations }) => ({
      name,
      operations: operations.map((op) => `${op.name}: ${op.httpMethod.toUpperCase()} ${op.path}`),
    }));

  it('keeps a tagged service whole when some of its paths carry a custom method', () => {
    const vet = (...params: string[]) => ({
      ...json,
      tags: ['vets'],
      parameters: params.map((name) => ({ name, in: 'path' as const, required: true, schema: { type: 'string' } })),
    });
    expect(
      services({
        '/vets:bulkCertify': { post: vet() },
        '/vets/{id}': { get: vet('id') },
        '/vets/{id}:certify': { post: vet('id') },
      }),
    ).toEqual([
      {
        name: 'Vets',
        operations: [
          'createBulkCertify: POST /vets:bulkCertify',
          'get: GET /vets/{id}',
          'certifyVet: POST /vets/{id}:certify',
        ],
      },
    ]);
  });

  it('never names a service from the verb of a custom method', () => {
    // `/v1/{name}:cancel` stays in `V1` beside `/v1/{name}`: the verb is not
    // a resource. The slash-written `/v1/{name}/cancel` names `Cancel`, as it
    // always did.
    expect(
      services({
        '/v1/operations': { get: json },
        '/v1/{name}': { get: jsonItem('name') },
        '/v1/{name}:cancel': { post: jsonItem('name') },
        '/v1/{name}:wait': { post: jsonItem('name') },
      }),
    ).toEqual([
      { name: 'Operations', operations: ['list: GET /v1/operations'] },
      {
        name: 'V1',
        operations: ['get: GET /v1/{name}', 'cancel: POST /v1/{name}:cancel', 'wait: POST /v1/{name}:wait'],
      },
    ]);
    expect(
      services({ '/v1/{name}': { get: jsonItem('name') }, '/v1/{name}/cancel': { post: jsonItem('name') } }),
    ).toEqual([
      { name: 'V1', operations: ['get: GET /v1/{name}'] },
      { name: 'Cancel', operations: ['cancel: POST /v1/{name}/cancel'] },
    ]);
  });

  it('reads a custom method on the API root as part of the root, and names no service from its verb', () => {
    // `/api/v1:reset` contributes `api/v1` to the document root exactly as
    // `/api/v1/notes` does, so `Notes` is not pushed into `V1`.
    expect(services({ '/api/v1:reset': { post: json }, '/api/v1/notes': { get: json } })).toEqual([
      { name: 'Api', operations: ['createReset: POST /api/v1:reset'] },
      { name: 'Notes', operations: ['list: GET /api/v1/notes'] },
    ]);
  });
});
