import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { nodeExtractor } from '../../../src/compat/extractors/node.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk');

describe('nodeExtractor', () => {
  it('extracts classes with methods and properties', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.classes.SampleClient).toBeDefined();

    const client = surface.classes.SampleClient;
    expect(client.name).toBe('SampleClient');
    expect(Object.keys(client.methods)).toEqual([
      'deleteOrganization',
      'getOrganization',
      'listOrganizations',
      'updateOrganization',
    ]);
  });

  it('extracts method params and return types', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const getOrg = surface.classes.SampleClient.methods.getOrganization[0];
    expect(getOrg.params).toHaveLength(1);
    expect(getOrg.params[0]).toMatchObject({ name: 'id', type: 'string', optional: false });
    expect(getOrg.returnType).toBe('Promise<Organization>');
    expect(getOrg.async).toBe(true);
  });

  it('extracts optional params', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const listOrgs = surface.classes.SampleClient.methods.listOrganizations[0];
    expect(listOrgs.params).toHaveLength(1);
    expect(listOrgs.params[0]).toMatchObject({ name: 'limit', optional: true });
  });

  it('normalizes destructured parameter names', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const updateOrg = surface.classes.SampleClient.methods.updateOrganization[0];
    expect(updateOrg.params).toHaveLength(1);
    expect(updateOrg.params[0]).toMatchObject({
      name: 'options',
      type: '{ id: string; name?: string | undefined; }',
      optional: false,
    });
  });

  it('extracts readonly properties', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const client = surface.classes.SampleClient;
    expect(client.properties.baseUrl).toMatchObject({
      name: 'baseUrl',
      type: 'string',
      readonly: true,
    });
  });

  it('extracts constructor params', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const client = surface.classes.SampleClient;
    expect(client.constructorParams).toHaveLength(1);
    expect(client.constructorParams[0]).toMatchObject({ name: 'options', type: 'ClientOptions' });
  });

  it('extracts interfaces with fields', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.interfaces.ClientOptions).toBeDefined();
    expect(surface.interfaces.Organization).toBeDefined();

    const options = surface.interfaces.ClientOptions;
    expect(options.fields.apiKey).toMatchObject({ type: 'string', optional: false });
    expect(options.fields.baseUrl).toMatchObject({ type: 'string', optional: true });
  });

  it('extracts generic interfaces', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.interfaces.ListResponse).toBeDefined();
    const lr = surface.interfaces.ListResponse;
    expect(lr.fields.data).toBeDefined();
    expect(lr.fields.hasMore).toMatchObject({ type: 'boolean', optional: false });
  });

  it('extracts enums', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.enums.Status).toBeDefined();
    expect(surface.enums.Status.members).toEqual({ Active: 'active', Inactive: 'inactive' });
  });

  it('extracts type aliases', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.typeAliases.StatusType).toBeDefined();
    expect(surface.typeAliases.StatusType).toMatchObject({
      name: 'StatusType',
      value: '"active" | "inactive"',
    });
  });

  it('stringifies generic types correctly', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    const listOrgs = surface.classes.SampleClient.methods.listOrganizations[0];
    expect(listOrgs.returnType).toBe('Promise<ListResponse<Organization>>');
  });

  it('extracts inherited methods from subclasses', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.classes.ExtendedClient).toBeDefined();
    const extended = surface.classes.ExtendedClient;
    // Own method
    expect(extended.methods.createOrganization).toBeDefined();
    // Inherited methods from SampleClient
    expect(extended.methods.getOrganization).toBeDefined();
    expect(extended.methods.listOrganizations).toBeDefined();
    expect(extended.methods.deleteOrganization).toBeDefined();
  });

  it('sets sourceFile on extracted classes', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.classes.SampleClient.sourceFile).toBe('src/client.ts');
    expect(surface.classes.ExtendedClient.sourceFile).toBe('src/client.ts');
  });

  it('sets sourceFile on extracted interfaces', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization.sourceFile).toBe('src/models.ts');
    expect(surface.interfaces.ClientOptions.sourceFile).toBe('src/models.ts');
    expect(surface.interfaces.ListResponse.sourceFile).toBe('src/models.ts');
  });

  it('sets sourceFile on extracted enums', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.enums.Status.sourceFile).toBe('src/models.ts');
  });

  it('sets sourceFile on extracted type aliases', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.typeAliases.StatusType.sourceFile).toBe('src/models.ts');
  });

  it('extracts barrel exports', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.exports['src/index.ts']).toBeDefined();
    expect(surface.exports['src/index.ts']).toEqual(
      expect.arrayContaining(['SampleClient', 'ClientOptions', 'Organization', 'ListResponse', 'Status']),
    );
  });

  it('walks barrel chain to produce exports for all files', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(Object.keys(surface.exports).sort()).toEqual(['src/client.ts', 'src/index.ts', 'src/models.ts']);
  });

  it('lists correct exports for each file in barrel chain', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.exports['src/client.ts']).toEqual(expect.arrayContaining(['SampleClient', 'ExtendedClient']));
    expect(surface.exports['src/models.ts']).toEqual(
      expect.arrayContaining(['ClientOptions', 'ListResponse', 'Organization', 'Status', 'StatusType']),
    );
  });

  it('produces deterministic output', async () => {
    const surface1 = await nodeExtractor.extract(fixturePath);
    const surface2 = await nodeExtractor.extract(fixturePath);
    // Ignore extractedAt since timestamps differ
    const normalize = (s: typeof surface1) => ({ ...s, extractedAt: '' });
    expect(normalize(surface1)).toEqual(normalize(surface2));
  });

  it('sets metadata correctly', async () => {
    const surface = await nodeExtractor.extract(fixturePath);
    expect(surface.language).toBe('node');
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });
});
