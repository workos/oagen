import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readExternalDocs, externalDocsEntry } from '../../src/parser/external-docs.js';
import { extractOperations } from '../../src/parser/operations.js';
import { extractSchemas, extractInlineModelsFromSchemas, clearSchemaNameTransform } from '../../src/parser/schemas.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { Model } from '../../src/ir/types.js';

const responses = { '204': { description: 'ok' } };
const link = { url: 'https://docs.example.com/pets' };
const describedLink = { url: 'https://docs.example.com/pets/list', description: 'Listing pets' };

async function parseDocument(document: unknown, tag: string) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `oagen-issue-217-${tag}-`));
  const specFile = path.join(tmpDir, 'repro.json');
  try {
    await fs.writeFile(specFile, JSON.stringify(document), 'utf-8');
    return await parseSpec(specFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const byName = (models: Model[], name: string): Model => {
  const model = models.find((m) => m.name === name);
  if (!model) throw new Error(`no model named ${name} among ${models.map((m) => m.name).join(', ')}`);
  return model;
};

describe('readExternalDocs', () => {
  it('keeps the url and a description with content', () => {
    expect(readExternalDocs(describedLink)).toEqual(describedLink);
  });

  it('keeps only the url when the description is missing or blank', () => {
    expect(readExternalDocs(link)).toEqual(link);
    expect(readExternalDocs({ ...link, description: '' })).toEqual(link);
    expect(readExternalDocs({ ...link, description: '   ' })).toEqual(link);
    expect(readExternalDocs({ ...link, description: 42 })).toEqual(link);
  });

  it('keeps a relative url exactly as written', () => {
    // OpenAPI allows a url relative to the document; the parser does not know
    // where the document is served from, so it is neither resolved nor rewritten.
    expect(readExternalDocs({ url: '../guides/pets.md' })).toEqual({ url: '../guides/pets.md' });
    expect(readExternalDocs({ url: ' https://docs.example.com ' })).toEqual({ url: ' https://docs.example.com ' });
  });

  it.each([
    ['a string', 'https://docs.example.com'],
    ['null', null],
    ['an array', [link]],
    ['a missing url', { description: 'No link.' }],
    ['an empty url', { url: '' }],
    ['a blank url', { url: '   ' }],
    ['a non-string url', { url: 42 }],
  ])('drops %s', (_shape, raw) => {
    expect(readExternalDocs(raw)).toBeUndefined();
    expect(externalDocsEntry(raw)).toEqual({});
    expect('externalDocs' in externalDocsEntry(raw)).toBe(false);
  });

  it('spreads into a node literal as a present key only when usable', () => {
    expect(externalDocsEntry(link)).toEqual({ externalDocs: link });
  });
});

describe('extractOperations – Operation.externalDocs (issue #217)', () => {
  it("carries an operation's externalDocs", () => {
    const paths = { '/pets': { get: { operationId: 'listPets', externalDocs: describedLink, responses } } };

    const [service] = extractOperations(paths).services;
    expect(service.operations[0].externalDocs).toEqual(describedLink);
  });

  it('leaves the key absent on an operation without one, or with a malformed one', () => {
    const paths = {
      '/pets': {
        get: { operationId: 'listPets', responses },
        post: { operationId: 'createPet', externalDocs: { description: 'no url' }, responses },
        put: { operationId: 'replacePet', externalDocs: 'https://docs.example.com' as never, responses },
      },
    };

    const [service] = extractOperations(paths).services;
    expect(service.operations).toHaveLength(3);
    for (const op of service.operations) expect('externalDocs' in op).toBe(false);
  });

  it('carries externalDocs on an inline request body model and on its oneOf variants', () => {
    const paths = {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', externalDocs: link, properties: { name: { type: 'string' } } },
              },
            },
          },
          responses,
        },
        put: {
          operationId: 'replacePet',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      title: 'Cat',
                      externalDocs: { url: 'https://docs.example.com/cats' },
                      properties: { meow: { type: 'string' } },
                    },
                    { type: 'object', title: 'Dog', properties: { bark: { type: 'string' } } },
                  ],
                },
              },
            },
          },
          responses,
        },
      },
    };

    const { inlineModels } = extractOperations(paths);
    expect(byName(inlineModels, 'CreatePetRequest').externalDocs).toEqual(link);
    const cat = inlineModels.find((m) => m.fields.some((f) => f.name === 'meow'))!;
    const dog = inlineModels.find((m) => m.fields.some((f) => f.name === 'bark'))!;
    expect(cat.externalDocs).toEqual({ url: 'https://docs.example.com/cats' });
    expect('externalDocs' in dog).toBe(false);
  });

  it('carries externalDocs on an inline response model and the inline objects nested in it', () => {
    const paths = {
      '/pets/{id}': {
        get: {
          operationId: 'getPet',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    externalDocs: link,
                    properties: {
                      id: { type: 'string' },
                      owner: {
                        type: 'object',
                        externalDocs: { url: 'https://docs.example.com/owners' },
                        properties: { name: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const { inlineModels } = extractOperations(paths);
    expect(byName(inlineModels, 'GetPetResponse').externalDocs).toEqual(link);
    expect(byName(inlineModels, 'GetPetResponseOwner').externalDocs).toEqual({
      url: 'https://docs.example.com/owners',
    });
  });
});

describe('extractOperations – Service.externalDocs from document tags (issue #217)', () => {
  type DocTags = Parameters<typeof extractOperations>[6];
  const withTags = (paths: Parameters<typeof extractOperations>[0], tags: DocTags) =>
    extractOperations(paths, undefined, undefined, undefined, undefined, undefined, tags).services;
  const docsOf = (services: ReturnType<typeof withTags>) =>
    Object.fromEntries(services.map((s) => [s.name, { description: s.description, externalDocs: s.externalDocs }]));

  it('gives a service the externalDocs of the tag it was named after, beside its description', () => {
    const paths = { '/pets': { get: { operationId: 'listPets', tags: ['Pets'], responses } } };
    const tags = [{ name: 'Pets', description: 'Pets in the store.', externalDocs: link }];

    expect(withTags(paths, tags)).toEqual([
      expect.objectContaining({ name: 'Pets', description: 'Pets in the store.', externalDocs: link }),
    ]);
  });

  it('keeps the link on a tag that has no description', () => {
    const paths = { '/pets': { get: { operationId: 'listPets', tags: ['pets'], responses } } };

    const [service] = withTags(paths, [{ name: 'pets', externalDocs: link }]);
    expect(service.externalDocs).toEqual(link);
    expect('description' in service).toBe(false);
  });

  it('gives every service split off a tag by path prefix that tag link, with its description', () => {
    const paths = {
      '/organizations': { get: { operationId: 'listOrganizations', tags: ['organizations'], responses } },
      '/organization_domains': {
        get: { operationId: 'listOrganizationDomains', tags: ['organizations'], responses },
      },
    };
    const tags = [{ name: 'organizations', description: 'Manage organizations.', externalDocs: link }];

    expect(docsOf(withTags(paths, tags))).toEqual({
      Organizations: { description: 'Manage organizations.', externalDocs: link },
      OrganizationDomains: { description: 'Manage organizations.', externalDocs: link },
    });
  });

  it('never borrows another tag link for a service whose own tag is declared', () => {
    // Same scenario as the description rule: the split merges the api_keys
    // operation into UserManagement, whose tag is declared without docs.
    const paths = {
      '/user_management/users': { get: { operationId: 'listUsers', tags: ['user-management'], responses } },
      '/user_management/api_keys': { get: { operationId: 'listUserApiKeys', tags: ['api_keys'], responses } },
      '/api_keys/{id}': { delete: { operationId: 'deleteApiKey', tags: ['api_keys'], responses } },
    };
    const tags = [{ name: 'user-management' }, { name: 'api_keys', description: 'API keys.', externalDocs: link }];

    const services = withTags(paths, tags);
    const userManagement = services.find((s) => s.name === 'UserManagement')!;
    expect(userManagement.operations).toHaveLength(2);
    expect('description' in userManagement).toBe(false);
    expect('externalDocs' in userManagement).toBe(false);
    expect(services.find((s) => s.name === 'ApiKeys')).toEqual(
      expect.objectContaining({ description: 'API keys.', externalDocs: link }),
    );
  });

  it('a split-off service inherits each field from the first tag its operations carry that gives it', () => {
    // Both the `domains` and the `organizations` tag have operations under
    // /organization_domains, so the path-prefix split carves one
    // OrganizationDomains service out of both; its first operation carries
    // the undescribed-but-linked `domains` tag. The description comes from
    // the first described tag and the link from the first linked one, so
    // adding a link to a tag never changes which description a service shows.
    const paths = {
      '/organization_domains': {
        get: { operationId: 'listOrganizationDomains', tags: ['domains'], responses },
        post: { operationId: 'createOrganizationDomain', tags: ['organizations'], responses },
      },
      '/domains': { get: { operationId: 'listDomains', tags: ['domains'], responses } },
      '/organizations': { get: { operationId: 'listOrganizations', tags: ['organizations'], responses } },
    };
    const tags = [
      { name: 'domains', externalDocs: { url: 'https://docs.example.com/domains' } },
      { name: 'organizations', description: 'Manage organizations.', externalDocs: link },
    ];

    const services = withTags(paths, tags);
    expect(services.find((s) => s.name === 'OrganizationDomains')!.operations.map((o) => o.name)).toEqual([
      'listOrganizationDomains',
      'createOrganizationDomain',
    ]);
    expect(docsOf(services)).toEqual({
      Organizations: { description: 'Manage organizations.', externalDocs: link },
      Domains: { description: undefined, externalDocs: { url: 'https://docs.example.com/domains' } },
      OrganizationDomains: {
        description: 'Manage organizations.',
        externalDocs: { url: 'https://docs.example.com/domains' },
      },
    });
  });

  it('a declared-but-undocumented tag blocks inheriting a link exactly as it blocks a description', () => {
    const paths = {
      '/organizations': { get: { operationId: 'listOrganizations', tags: ['organizations'], responses } },
      '/organization_memberships': {
        get: { operationId: 'listOrganizationMemberships', tags: ['organizations'], responses },
      },
    };
    const tags = [
      { name: 'organizations', description: 'Manage organizations.', externalDocs: link },
      { name: 'organization-memberships' },
    ];

    const memberships = withTags(paths, tags).find((s) => s.name === 'OrganizationMemberships')!;
    expect('description' in memberships).toBe(false);
    expect('externalDocs' in memberships).toBe(false);
  });

  it('takes each field from the first duplicate tag that gives it', () => {
    const paths = { '/pets': { get: { operationId: 'listPets', tags: ['pets'], responses } } };
    const tags = [
      { name: 'pets', externalDocs: link },
      { name: 'Pets', description: 'Described later.', externalDocs: { url: 'https://docs.example.com/later' } },
    ];

    const [service] = withTags(paths, tags);
    expect(service.description).toBe('Described later.');
    expect(service.externalDocs).toEqual(link);
  });

  it('drops a malformed tag link without affecting the description', () => {
    const paths = { '/pets': { get: { operationId: 'listPets', tags: ['Pets'], responses } } };

    const [noUrl] = withTags(paths, [{ name: 'Pets', description: 'Pets.', externalDocs: { description: 'x' } }]);
    expect(noUrl.description).toBe('Pets.');
    expect('externalDocs' in noUrl).toBe(false);

    const [notAnObject] = withTags(paths, [{ name: 'Pets', externalDocs: 'https://docs.example.com' } as never]);
    expect('externalDocs' in notAnObject).toBe(false);
    expect('description' in notAnObject).toBe(false);
  });
});

describe('extractSchemas – Model and Enum externalDocs (issue #217)', () => {
  afterEach(() => clearSchemaNameTransform());

  it('carries a component model externalDocs and leaves the key absent otherwise', () => {
    const { models } = extractSchemas({
      Pet: { type: 'object', externalDocs: describedLink, properties: { id: { type: 'string' } } },
      Toy: { type: 'object', properties: { id: { type: 'string' } } },
    });

    expect(byName(models, 'Pet').externalDocs).toEqual(describedLink);
    expect('externalDocs' in byName(models, 'Toy')).toBe(false);
  });

  it('carries a component enum externalDocs and leaves the key absent otherwise', () => {
    const { enums } = extractSchemas({
      Status: { type: 'string', enum: ['active', 'inactive'], externalDocs: link },
      Kind: { type: 'string', enum: ['a', 'b'] },
    });

    expect(enums.find((e) => e.name === 'Status')!.externalDocs).toEqual(link);
    expect('externalDocs' in enums.find((e) => e.name === 'Kind')!).toBe(false);
  });

  it('carries an allOf model own externalDocs, not a member component one', () => {
    const { models } = extractSchemas({
      Base: {
        type: 'object',
        externalDocs: { url: 'https://docs.example.com/base' },
        properties: { id: { type: 'string' } },
      },
      Cat: {
        allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { meow: { type: 'string' } } }],
        externalDocs: link,
      },
      Dog: {
        allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { bark: { type: 'string' } } }],
      },
    });

    expect(byName(models, 'Cat').externalDocs).toEqual(link);
    expect('externalDocs' in byName(models, 'Dog')).toBe(false);
  });

  it('carries a variant own externalDocs on discriminated allOf + oneOf variant models', () => {
    const { models } = extractSchemas({
      Event: {
        allOf: [
          { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          {
            oneOf: [
              {
                type: 'object',
                externalDocs: { url: 'https://docs.example.com/events/created' },
                properties: { event: { const: 'pet.created' }, pet: { type: 'string' } },
              },
              { type: 'object', properties: { event: { const: 'pet.deleted' } } },
            ],
          },
        ],
      },
    });

    const created = models.find((m) => m.fields.some((f) => f.name === 'pet'))!;
    const deleted = models.find((m) => m.name !== 'Event' && m !== created)!;
    expect(created.externalDocs).toEqual({ url: 'https://docs.example.com/events/created' });
    expect('externalDocs' in deleted).toBe(false);
  });

  it('carries externalDocs on inline models nested in component fields', () => {
    const schemas = {
      Base: { type: 'object', properties: { id: { type: 'string' } } },
      Pet: {
        type: 'object',
        properties: {
          owner: { type: 'object', externalDocs: { url: '/owners' }, properties: { name: { type: 'string' } } },
          friends: {
            type: 'array',
            items: { type: 'object', externalDocs: { url: '/friends' }, properties: { id: { type: 'string' } } },
          },
          meta: {
            allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { x: { type: 'string' } } }],
            externalDocs: { url: '/meta' },
          },
          plain: { type: 'object', properties: { y: { type: 'string' } } },
        },
      },
    };

    // Both extractors materialize these models; parseSpec keeps the first
    // definition of a name, so each must carry the link.
    const nested = extractSchemas(schemas).models;
    expect(byName(nested, 'PetOwner').externalDocs).toEqual({ url: '/owners' });
    expect(byName(nested, 'PetFriend').externalDocs).toEqual({ url: '/friends' });
    expect('externalDocs' in byName(nested, 'PetPlain')).toBe(false);

    const fromFields = extractInlineModelsFromSchemas(schemas);
    expect(byName(fromFields, 'PetOwner').externalDocs).toEqual({ url: '/owners' });
    expect(byName(fromFields, 'PetFriend').externalDocs).toEqual({ url: '/friends' });
    expect(byName(fromFields, 'PetMeta').externalDocs).toEqual({ url: '/meta' });
    expect('externalDocs' in byName(fromFields, 'PetPlain')).toBe(false);
  });
});

describe('parseSpec – externalDocs reaches the IR (issue #217)', () => {
  it('reproduces the issue: tag and operation links reach the service and operation', async () => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        tags: [{ name: 'Pets', description: 'Pets in the store.', externalDocs: link }],
        paths: {
          '/pets': {
            get: { operationId: 'listPets', tags: ['Pets'], externalDocs: describedLink, responses },
          },
        },
      },
      'repro',
    );

    expect(JSON.stringify(spec).includes('docs.example.com')).toBe(true);
    const [service] = spec.services;
    expect(service).toEqual(
      expect.objectContaining({ name: 'Pets', description: 'Pets in the store.', externalDocs: link }),
    );
    expect(service.operations[0].externalDocs).toEqual(describedLink);
    expect('externalDocs' in spec).toBe(false);
  });

  it('carries the document-level externalDocs and those of component models and enums', async () => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        externalDocs: { url: 'https://docs.example.com', description: 'Full reference' },
        paths: { '/pets': { get: { operationId: 'listPets', responses } } },
        components: {
          schemas: {
            Pet: {
              type: 'object',
              externalDocs: link,
              properties: { status: { $ref: '#/components/schemas/Status' } },
            },
            Status: { type: 'string', enum: ['active'], externalDocs: { url: 'https://docs.example.com/status' } },
          },
        },
      },
      'document',
    );

    expect(spec.externalDocs).toEqual({ url: 'https://docs.example.com', description: 'Full reference' });
    expect(byName(spec.models, 'Pet').externalDocs).toEqual(link);
    expect(spec.enums.find((e) => e.name === 'Status')!.externalDocs).toEqual({
      url: 'https://docs.example.com/status',
    });
  });

  it('keeps every key absent for a document that declares no externalDocs anywhere', async () => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        tags: [{ name: 'Pets', description: 'Pets in the store.' }],
        paths: { '/pets': { get: { operationId: 'listPets', tags: ['Pets'], responses } } },
        components: {
          schemas: {
            Pet: { type: 'object', properties: { id: { type: 'string' } } },
            Status: { type: 'string', enum: ['active'] },
          },
        },
      },
      'none',
    );

    expect(JSON.stringify(spec).includes('externalDocs')).toBe(false);
  });

  // The parser ignored `externalDocs` entirely before it was read, so a
  // malformed value must not turn into a parse failure now; it is dropped
  // the way a malformed document tag is.
  it.each([
    ['a string', 'https://docs.example.com'],
    ['null', null],
    ['an entry without a url', { description: 'No link.' }],
    ['an entry with a numeric url', { url: 42 }],
  ])('keeps parsing a document whose externalDocs values are %s', async (_shape, externalDocs) => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        externalDocs,
        tags: [{ name: 'Pets', description: 'Pets in the store.', externalDocs }],
        paths: { '/pets': { get: { operationId: 'listPets', tags: ['Pets'], externalDocs, responses } } },
        components: {
          schemas: {
            Pet: { type: 'object', externalDocs, properties: { id: { type: 'string' } } },
            Status: { type: 'string', enum: ['active'], externalDocs },
          },
        },
      },
      'malformed',
    );

    expect(spec.services.map((s) => s.name)).toEqual(['Pets']);
    expect(spec.services[0].description).toBe('Pets in the store.');
    expect(JSON.stringify(spec).includes('externalDocs')).toBe(false);
  });

  it('survives the inline-model merge passes', async () => {
    const spec = await parseDocument(
      {
        openapi: '3.1.0',
        info: { title: 'repro', version: '1' },
        paths: {
          '/pets/{id}': {
            get: {
              operationId: 'getPet',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      // Resolves to the component by name; the component's
                      // definition (and link) is the one kept.
                      schema: { $ref: '#/components/schemas/Pet' },
                    },
                  },
                },
              },
            },
          },
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      externalDocs: { url: 'https://docs.example.com/create' },
                      properties: {
                        owner: {
                          type: 'object',
                          externalDocs: { url: 'https://docs.example.com/owner' },
                          properties: { name: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
              },
              responses,
            },
          },
        },
        components: {
          schemas: {
            Pet: { type: 'object', externalDocs: link, properties: { id: { type: 'string' } } },
            // Collapsed into Pet (superset of its fields); Pet keeps its own
            // documentation, link included, as it keeps its description.
            PetJson: {
              type: 'object',
              externalDocs: { url: 'https://docs.example.com/pet-json' },
              properties: { id: { type: 'string' }, name: { type: 'string' } },
            },
          },
        },
      },
      'merge',
    );

    expect(spec.models.map((m) => m.name).sort()).toEqual(['CreatePetRequest', 'CreatePetRequestOwner', 'Pet']);
    expect(byName(spec.models, 'Pet')).toEqual(
      expect.objectContaining({ externalDocs: link, fields: [expect.anything(), expect.anything()] }),
    );
    expect(byName(spec.models, 'CreatePetRequest').externalDocs).toEqual({ url: 'https://docs.example.com/create' });
    expect(byName(spec.models, 'CreatePetRequestOwner').externalDocs).toEqual({
      url: 'https://docs.example.com/owner',
    });
  });
});
