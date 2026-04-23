import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { rustExtractor } from '../../../src/compat/extractors/rust.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-rust');

describe('rustExtractor', () => {
  it('extracts classes from structs with impl methods', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.classes.WorkOs).toBeDefined();
    expect(surface.classes.WorkOs.name).toBe('WorkOs');
  });

  it('extracts class methods from impl blocks', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const client = surface.classes.WorkOs;
    expect(Object.keys(client.methods).sort()).toEqual([
      'create_organization',
      'delete_organization',
      'get_connection',
      'get_organization',
      'get_profile',
      'list_organizations',
      'new',
    ]);
  });

  it('excludes private methods', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const client = surface.classes.WorkOs;
    expect(client.methods.internal_request).toBeUndefined();
  });

  it('extracts method params (skipping &self)', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const getOrg = surface.classes.WorkOs.methods.get_organization[0];
    expect(getOrg.params).toHaveLength(1);
    expect(getOrg.params[0]).toMatchObject({
      name: 'id',
      type: '&str',
      optional: false,
    });
  });

  it('marks async methods', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const getOrg = surface.classes.WorkOs.methods.get_organization[0];
    expect(getOrg.async).toBe(true);
    const newFn = surface.classes.WorkOs.methods.new[0];
    expect(newFn.async).toBe(false);
  });

  it('unwraps Result return types', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const getOrg = surface.classes.WorkOs.methods.get_organization[0];
    expect(getOrg.returnType).toBe('Organization');
    const deleteOrg = surface.classes.WorkOs.methods.delete_organization[0];
    expect(deleteOrg.returnType).toBe('()');
  });

  it('extracts class properties from pub struct fields', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const client = surface.classes.WorkOs;
    expect(client.properties.api_key).toMatchObject({ name: 'api_key', type: 'String', readonly: false });
    expect(client.properties.base_url).toMatchObject({ name: 'base_url', type: 'String' });
    // Private field should not appear
    expect(client.properties.client).toBeUndefined();
  });

  it('extracts interfaces from structs without impl methods', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization).toBeDefined();
    expect(surface.interfaces.Organization.name).toBe('Organization');
  });

  it('uses serde rename for interface field names', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.allow_profiles_outside_organization).toBeDefined();
    expect(org.fields.allow_profiles_outside_organization.type).toBe('bool');
  });

  it('extracts optional fields from Option<T> types', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.domains).toMatchObject({ optional: true });
    expect(org.fields.id).toMatchObject({ optional: false });
    expect(org.fields.name).toMatchObject({ optional: false });
  });

  it('excludes private struct fields from interfaces', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.internal_state).toBeUndefined();
  });

  it('extracts enums with serde renames as member values', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.enums.Status).toBeDefined();
    expect(surface.enums.Status.members).toEqual({
      Active: 'active',
      Inactive: 'inactive',
    });
  });

  it('extracts enums without serde renames using variant name as value', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.enums.Order).toBeDefined();
    expect(surface.enums.Order.members).toEqual({
      Asc: 'asc',
      Desc: 'desc',
    });
  });

  it('extracts ConnectionType enum from a different file', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.enums.ConnectionType).toBeDefined();
    expect(surface.enums.ConnectionType.members).toEqual({
      GenericSaml: 'GenericSAML',
      GenericOidc: 'GenericOIDC',
    });
  });

  it('excludes private enums', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.enums.InternalState).toBeUndefined();
  });

  it('extracts type aliases', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.typeAliases.OrgId).toBeDefined();
    expect(surface.typeAliases.OrgId).toMatchObject({
      name: 'OrgId',
      value: 'String',
    });
  });

  it('extracts traits as classes', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.classes.SsoProvider).toBeDefined();
    const sso = surface.classes.SsoProvider;
    expect(Object.keys(sso.methods).sort()).toEqual(['get_authorization_url', 'get_profile_and_token']);
  });

  it('extracts trait method params and return types', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const getAuthUrl = surface.classes.SsoProvider.methods.get_authorization_url[0];
    expect(getAuthUrl.params).toHaveLength(1);
    expect(getAuthUrl.params[0]).toMatchObject({ name: 'opts', type: 'AuthUrlOpts' });
    expect(getAuthUrl.returnType).toBe('String');
    expect(getAuthUrl.async).toBe(true);
  });

  it('sets sourceFile on extracted items', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.classes.WorkOs.sourceFile).toBe('src/client.rs');
    expect(surface.interfaces.Organization.sourceFile).toBe('src/models.rs');
    expect(surface.enums.Status.sourceFile).toBe('src/enums.rs');
    expect(surface.typeAliases.OrgId.sourceFile).toBe('src/models.rs');
  });

  it('builds export map grouped by source file', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(Object.keys(surface.exports).length).toBeGreaterThan(0);
    const modelExports = surface.exports['src/models.rs'];
    expect(modelExports).toBeDefined();
    expect(modelExports).toEqual(expect.arrayContaining(['Organization', 'Connection', 'Profile', 'OrgId']));
    const enumExports = surface.exports['src/enums.rs'];
    expect(enumExports).toBeDefined();
    expect(enumExports).toEqual(expect.arrayContaining(['Status', 'ConnectionType', 'Order']));
  });

  it('produces deterministic output', async () => {
    const surface1 = await rustExtractor.extract(fixturePath);
    const surface2 = await rustExtractor.extract(fixturePath);
    const normalize = (s: typeof surface1) => ({ ...s, extractedAt: '' });
    expect(normalize(surface1)).toEqual(normalize(surface2));
  });

  it('sets metadata correctly', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.language).toBe('rust');
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });

  it('throws for non-Rust projects', async () => {
    await expect(rustExtractor.extract('/tmp/nonexistent-rust-project')).rejects.toThrow('No .rs files found');
  });

  it('extracts multiple data structs as interfaces', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    expect(surface.interfaces.Connection).toBeDefined();
    expect(surface.interfaces.Profile).toBeDefined();
    expect(surface.interfaces.ListMetadata).toBeDefined();
  });

  it('uses serde rename on Connection fields', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const conn = surface.interfaces.Connection;
    expect(conn.fields.connection_type).toBeDefined();
    expect(conn.fields.connection_type.type).toBe('String');
  });

  it('marks Option params as optional in method signatures', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const createOrg = surface.classes.WorkOs.methods.create_organization[0];
    const domainsParam = createOrg.params.find((p) => p.name === 'domains');
    expect(domainsParam).toMatchObject({ optional: true });
    const nameParam = createOrg.params.find((p) => p.name === 'name');
    expect(nameParam).toMatchObject({ optional: false });
  });

  // -----------------------------------------------------------------------
  // Passing style detection
  // -----------------------------------------------------------------------

  it('sets passingStyle to positional for all Rust params', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const createOrg = surface.classes.WorkOs.methods.create_organization[0];
    for (const param of createOrg.params) {
      expect(param.passingStyle).toBe('positional');
    }
  });

  // -----------------------------------------------------------------------
  // Parameter order preservation
  // -----------------------------------------------------------------------

  it('preserves parameter order for create_organization', async () => {
    const surface = await rustExtractor.extract(fixturePath);
    const createOrg = surface.classes.WorkOs.methods.create_organization[0];
    const paramNames = createOrg.params.map((p) => p.name);
    expect(paramNames).toEqual(['name', 'domains']);
  });
});
