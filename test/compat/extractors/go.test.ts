import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { goExtractor } from '../../../src/compat/extractors/go.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-go');

describe('goExtractor', () => {
  it('qualifies duplicate names with package prefix', async () => {
    const surface = await goExtractor.extract(fixturePath);
    // Both packages define Client, so they should be qualified
    expect(surface.classes['organizations.Client']).toBeDefined();
    expect(surface.classes['sso.Client']).toBeDefined();
    // Bare 'Client' should not exist
    expect(surface.classes.Client).toBeUndefined();
  });

  it('extracts classes with methods (structs with receiver methods)', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const client = surface.classes['organizations.Client'];
    expect(client.name).toBe('organizations.Client');
    expect(Object.keys(client.methods).sort()).toEqual([
      'CreateOrganization',
      'DeleteOrganization',
      'GetOrganization',
      'ListOrganizations',
    ]);
  });

  it('extracts method params (skipping context.Context)', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const getOrg = surface.classes['organizations.Client'].methods.GetOrganization[0];

    expect(getOrg.params).toHaveLength(1);
    expect(getOrg.params[0]).toMatchObject({
      name: 'opts',
      type: 'GetOrganizationOpts',
      optional: false,
    });
  });

  it('extracts method return types (stripping error)', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const getOrg = surface.classes['organizations.Client'].methods.GetOrganization[0];
    expect(getOrg.returnType).toBe('Organization');
    expect(getOrg.async).toBe(false);
  });

  it('extracts void-like methods (error-only return)', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const deleteOrg = surface.classes['organizations.Client'].methods.DeleteOrganization[0];
    expect(deleteOrg.returnType).toBe('error');
  });

  it('extracts class properties from struct fields', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const client = surface.classes['organizations.Client'];
    // Only exported fields
    expect(client.properties.APIKey).toMatchObject({
      name: 'APIKey',
      type: 'string',
      readonly: false,
    });
    expect(client.properties.Endpoint).toBeDefined();
    // httpClient is unexported, should not appear
    expect(client.properties.httpClient).toBeUndefined();
  });

  it('extracts interfaces from structs without methods', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization).toBeDefined();

    const org = surface.interfaces.Organization;
    expect(org.name).toBe('Organization');
    expect(org.fields.id).toMatchObject({
      name: 'id',
      type: 'string',
      optional: false,
    });
    expect(org.fields.name).toMatchObject({
      name: 'name',
      type: 'string',
      optional: false,
    });
  });

  it('uses JSON tags for interface field names', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    // allow_profiles_outside_organization from json tag
    expect(org.fields.allow_profiles_outside_organization).toBeDefined();
    expect(org.fields.allow_profiles_outside_organization.type).toBe('bool');
  });

  it('extracts optional fields from omitempty tags', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const createOpts = surface.interfaces.CreateOrganizationOpts;
    expect(createOpts).toBeDefined();
    // domains has omitempty
    expect(createOpts.fields.domains).toMatchObject({
      optional: true,
    });
    // name does not have omitempty
    expect(createOpts.fields.name).toMatchObject({
      optional: false,
    });
  });

  it('extracts enums from type+const patterns', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.enums.Status).toBeDefined();
    expect(surface.enums.Status.members).toEqual({
      Active: 'active',
      Inactive: 'inactive',
    });
  });

  it('extracts Order enum', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.enums.Order).toBeDefined();
    expect(surface.enums.Order.members).toEqual({
      Asc: 'asc',
      Desc: 'desc',
    });
  });

  it('extracts enums from different packages', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.enums.ConnectionType).toBeDefined();
    expect(surface.enums.ConnectionType.members).toEqual({
      GenericOIDC: 'GenericOIDC',
      GenericSAML: 'GenericSAML',
    });
  });

  it('extracts type aliases', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.typeAliases.StatusAlias).toBeDefined();
    expect(surface.typeAliases.StatusAlias).toMatchObject({
      name: 'StatusAlias',
      value: 'Status',
    });
  });

  it('does not extract unexported methods', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const client = surface.classes['organizations.Client'];
    // unexportedHelper should not appear
    expect(client.methods.unexportedHelper).toBeUndefined();
  });

  it('sets sourceFile on extracted classes', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.classes['organizations.Client'].sourceFile).toBe('pkg/organizations/client.go');
    expect(surface.classes['sso.Client'].sourceFile).toBe('pkg/sso/client.go');
  });

  it('sets sourceFile on extracted interfaces', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization.sourceFile).toBe('pkg/organizations/client.go');
    expect(surface.interfaces.Connection.sourceFile).toBe('pkg/sso/client.go');
  });

  it('sets sourceFile on extracted enums', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.enums.Status.sourceFile).toBe('pkg/organizations/client.go');
    expect(surface.enums.ConnectionType.sourceFile).toBe('pkg/sso/client.go');
  });

  it('builds export map grouped by source file', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(Object.keys(surface.exports).length).toBeGreaterThan(0);
    const orgExports = surface.exports['pkg/organizations/client.go'];
    expect(orgExports).toBeDefined();
    expect(orgExports).toEqual(expect.arrayContaining(['organizations.Client', 'Organization', 'Status']));
    const ssoExports = surface.exports['pkg/sso/client.go'];
    expect(ssoExports).toBeDefined();
    expect(ssoExports).toEqual(expect.arrayContaining(['sso.Client', 'ConnectionType']));
  });

  it('produces deterministic output', async () => {
    const surface1 = await goExtractor.extract(fixturePath);
    const surface2 = await goExtractor.extract(fixturePath);
    const normalize = (s: typeof surface1) => ({ ...s, extractedAt: '' });
    expect(normalize(surface1)).toEqual(normalize(surface2));
  });

  it('sets metadata correctly', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.language).toBe('go');
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });

  it('throws for non-Go projects', async () => {
    await expect(goExtractor.extract('/tmp/nonexistent-go-project')).rejects.toThrow('No .go files found');
  });

  it('extracts ListMetadata from common package', async () => {
    const surface = await goExtractor.extract(fixturePath);
    expect(surface.interfaces.ListMetadata).toBeDefined();
    expect(surface.interfaces.ListMetadata.fields.before).toMatchObject({
      name: 'before',
      type: 'string',
    });
  });

  it('skips package-level convenience functions in exports', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const orgExports = surface.exports['pkg/organizations/client.go'];
    expect(orgExports).toEqual(expect.arrayContaining(['SetAPIKey']));
  });

  it('extracts list response structs as interfaces with correct field types', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const listResp = surface.interfaces.ListOrganizationsResponse;
    expect(listResp).toBeDefined();
    expect(listResp.fields.data).toBeDefined();
    expect(listResp.fields.data.type).toBe('[]Organization');
    expect(listResp.fields.list_metadata).toBeDefined();
  });

  it('extracts sso.Client with its methods', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const ssoClient = surface.classes['sso.Client'];
    expect(ssoClient).toBeDefined();
    expect(ssoClient.methods.GetConnection).toBeDefined();
    expect(ssoClient.methods.GetConnection[0].returnType).toBe('Connection');
    expect(ssoClient.properties.APIKey).toBeDefined();
    expect(ssoClient.properties.ClientID).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Passing style detection
  // -----------------------------------------------------------------------

  it('sets passingStyle to positional for all Go params', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const getOrg = surface.classes['organizations.Client'].methods.GetOrganization[0];
    for (const param of getOrg.params) {
      expect(param.passingStyle).toBe('positional');
    }
  });

  // -----------------------------------------------------------------------
  // Parameter order preservation
  // -----------------------------------------------------------------------

  it('preserves parameter order (context.Context filtered out)', async () => {
    const surface = await goExtractor.extract(fixturePath);
    const getOrg = surface.classes['organizations.Client'].methods.GetOrganization[0];
    // context.Context is filtered; only opts remains
    expect(getOrg.params).toHaveLength(1);
    expect(getOrg.params[0].name).toBe('opts');
  });
});
