import { describe, it, expect } from 'vitest';
import { diffOperations } from '../../src/differ/operations.js';
import type { Operation, ServerEntry } from '../../src/ir/types.js';

/**
 * Covers `serversChanged` on `operation-modified` (issue #251): the
 * operation's `servers` field compared by `serverListsEqual`, every change
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

const pets: ServerEntry[] = [{ url: 'https://pets.example.com', description: 'Pets' }];
const regional: ServerEntry[] = [
  { url: 'https://{region}.pets.example.com', variables: { region: { default: 'eu', enum: ['eu', 'us'] } } },
];

function withServers(servers: ServerEntry[]): Operation {
  return { ...listPets, servers };
}

describe('diffOperations – servers (issue #251)', () => {
  it('reports an operation gaining its own servers as breaking', () => {
    const changes = diffOperations('Pets', [listPets], [withServers(pets)]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      operationName: 'listPets',
      serversChanged: true,
      classification: 'breaking',
    });
  });

  it('reports an operation losing its own servers (inheriting again) as breaking', () => {
    const changes = diffOperations('Pets', [withServers(pets)], [listPets]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ serversChanged: true, classification: 'breaking' });
  });

  it('reports a changed list as breaking', () => {
    const changes = diffOperations('Pets', [withServers(pets)], [withServers(regional)]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ serversChanged: true, classification: 'breaking' });
  });

  it('reports nothing when both sides inherit', () => {
    expect(diffOperations('Pets', [listPets], [listPets])).toHaveLength(0);
    // An explicit undefined is the same as an absent key.
    expect(diffOperations('Pets', [{ ...listPets, servers: undefined }], [listPets])).toHaveLength(0);
  });

  it('reports nothing when both sides carry the same list', () => {
    // Equal by structure, not by identity: each parse builds its own objects.
    const again: ServerEntry[] = [
      { url: 'https://{region}.pets.example.com', variables: { region: { default: 'eu', enum: ['eu', 'us'] } } },
    ];
    expect(diffOperations('Pets', [withServers(regional)], [withServers(again)])).toHaveLength(0);
    // A description that is absent on one side and undefined on the other is the same thing.
    const plain = withServers([{ url: 'https://pets.example.com' }]);
    const undefinedDescription = withServers([{ url: 'https://pets.example.com', description: undefined }]);
    expect(diffOperations('Pets', [plain], [undefinedDescription])).toHaveLength(0);
  });

  it('counts a changed description, variable or order as a change', () => {
    const described = withServers([{ url: 'https://pets.example.com', description: 'Pet store' }]);
    expect(diffOperations('Pets', [withServers(pets)], [described])[0]).toMatchObject({ serversChanged: true });

    const otherDefault = withServers([
      { url: 'https://{region}.pets.example.com', variables: { region: { default: 'us', enum: ['eu', 'us'] } } },
    ]);
    expect(diffOperations('Pets', [withServers(regional)], [otherDefault])[0]).toMatchObject({ serversChanged: true });

    const otherEnumOrder = withServers([
      { url: 'https://{region}.pets.example.com', variables: { region: { default: 'eu', enum: ['us', 'eu'] } } },
    ]);
    expect(diffOperations('Pets', [withServers(regional)], [otherEnumOrder])[0]).toMatchObject({
      serversChanged: true,
    });

    const reordered = withServers([...regional, ...pets]);
    const original = withServers([...pets, ...regional]);
    expect(diffOperations('Pets', [original], [reordered])[0]).toMatchObject({ serversChanged: true });
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
});
