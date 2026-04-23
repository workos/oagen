import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { kotlinExtractor } from '../../../src/compat/extractors/kotlin.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-kotlin');

describe('kotlinExtractor', () => {
  it('extracts classes with methods (service classes)', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.classes.OrganizationApi).toBeDefined();
    expect(surface.classes.OrganizationApi.name).toBe('OrganizationApi');
    expect(Object.keys(surface.classes.OrganizationApi.methods).sort()).toEqual([
      'createOrganization',
      'deleteOrganization',
      'getOrganization',
      'listOrganizations',
    ]);
  });

  it('extracts method params', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const getOrg = surface.classes.OrganizationApi.methods.getOrganization[0];
    expect(getOrg.params).toHaveLength(1);
    expect(getOrg.params[0]).toMatchObject({
      name: 'options',
      type: 'GetOrganizationOptions',
      optional: false,
    });
  });

  it('extracts method return types', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const getOrg = surface.classes.OrganizationApi.methods.getOrganization[0];
    expect(getOrg.returnType).toBe('Organization');
  });

  it('extracts void-like methods', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const deleteOrg = surface.classes.OrganizationApi.methods.deleteOrganization[0];
    expect(deleteOrg.returnType).toBe('Unit');
  });

  it('does not extract private methods', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const api = surface.classes.OrganizationApi;
    expect(api.methods.internalHelper).toBeUndefined();
  });

  it('extracts optional method params', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const listOrgs = surface.classes.OrganizationApi.methods.listOrganizations[0];
    expect(listOrgs.params[0]).toMatchObject({
      name: 'options',
      type: 'ListOrganizationsOptions?',
      optional: true,
    });
  });

  it('extracts interfaces from data classes', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization).toBeDefined();
    expect(surface.interfaces.Organization.name).toBe('Organization');
  });

  it('uses JsonProperty names for interface fields', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.id).toBeDefined();
    expect(org.fields.name).toBeDefined();
    expect(org.fields.allow_profiles_outside_organization).toBeDefined();
  });

  it('extracts optional fields from nullable types', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.domains).toMatchObject({ optional: true });
    expect(org.fields.id).toMatchObject({ optional: false });
  });

  it('extracts enums from enum classes', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.enums.Status).toBeDefined();
    expect(surface.enums.Status.members).toEqual({
      Active: 'active',
      Inactive: 'inactive',
    });
  });

  it('extracts Order enum', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.enums.Order).toBeDefined();
    expect(surface.enums.Order.members).toEqual({
      Asc: 'asc',
      Desc: 'desc',
    });
  });

  it('extracts ConnectionType enum from SSO package', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.enums.ConnectionType).toBeDefined();
    expect(surface.enums.ConnectionType.members).toEqual({
      GenericOIDC: 'GenericOIDC',
      GenericSAML: 'GenericSAML',
    });
  });

  it('extracts type aliases', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.typeAliases.StatusAlias).toBeDefined();
    expect(surface.typeAliases.StatusAlias).toMatchObject({
      name: 'StatusAlias',
      value: 'Status',
    });
  });

  it('extracts SsoApi class with methods', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const ssoApi = surface.classes.SsoApi;
    expect(ssoApi).toBeDefined();
    expect(Object.keys(ssoApi.methods).sort()).toEqual(['getConnection', 'getProfile']);
  });

  it('extracts Connection data class as interface', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.interfaces.Connection).toBeDefined();
    expect(surface.interfaces.Connection.fields.connection_type).toBeDefined();
  });

  it('extracts multiple data classes as interfaces', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.interfaces.Profile).toBeDefined();
    expect(surface.interfaces.ListMetadata).toBeDefined();
    expect(surface.interfaces.ListOrganizationsResponse).toBeDefined();
  });

  it('sets sourceFile on extracted items', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.classes.OrganizationApi.sourceFile).toContain('OrganizationApi.kt');
    expect(surface.classes.SsoApi.sourceFile).toContain('SsoApi.kt');
    expect(surface.interfaces.Organization.sourceFile).toContain('OrganizationApi.kt');
    expect(surface.enums.Status.sourceFile).toContain('OrganizationApi.kt');
  });

  it('builds export map grouped by source file', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(Object.keys(surface.exports).length).toBeGreaterThan(0);
  });

  it('produces deterministic output', async () => {
    const surface1 = await kotlinExtractor.extract(fixturePath);
    const surface2 = await kotlinExtractor.extract(fixturePath);
    const normalize = (s: typeof surface1) => ({ ...s, extractedAt: '' });
    expect(normalize(surface1)).toEqual(normalize(surface2));
  });

  it('sets metadata correctly', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    expect(surface.language).toBe('kotlin');
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // Passing style detection
  // -----------------------------------------------------------------------

  it('sets passingStyle to named for all Kotlin params', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const orgApi = surface.classes.OrganizationApi;
    const getOrg = orgApi.methods.getOrganization[0];
    for (const param of getOrg.params) {
      expect(param.passingStyle).toBe('named');
    }
  });

  it('sets passingStyle to named for constructor params', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const orgApi = surface.classes.OrganizationApi;
    for (const param of orgApi.constructorParams) {
      expect(param.passingStyle).toBe('named');
    }
  });

  // -----------------------------------------------------------------------
  // Parameter order preservation
  // -----------------------------------------------------------------------

  it('preserves parameter order for methods', async () => {
    const surface = await kotlinExtractor.extract(fixturePath);
    const createOrg = surface.classes.OrganizationApi.methods.createOrganization[0];
    expect(createOrg.params.length).toBeGreaterThan(0);
    // createOrganization(options: CreateOrganizationOptions)
    expect(createOrg.params[0].name).toBe('options');
  });

  it('throws for non-Kotlin projects', async () => {
    await expect(kotlinExtractor.extract('/tmp/nonexistent-kotlin-project')).rejects.toThrow('No .kt files found');
  });
});
