import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { elixirExtractor } from '../../../src/compat/extractors/elixir.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-elixir');

describe('elixirExtractor', () => {
  it('extracts classes from modules with public functions', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.classes.Organizations).toBeDefined();
    expect(surface.classes.Organizations.name).toBe('Organizations');
  });

  it('extracts class methods', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    const orgs = surface.classes.Organizations;
    expect(Object.keys(orgs.methods).sort()).toEqual([
      'create_organization',
      'delete_organization',
      'get_organization',
      'list_organizations',
    ]);
  });

  it('extracts method params', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    const getOrg = surface.classes.Organizations.methods.get_organization[0];
    expect(getOrg.params).toHaveLength(2);
    expect(getOrg.params[0]).toMatchObject({ name: 'client' });
    expect(getOrg.params[1]).toMatchObject({ name: 'id' });
  });

  it('does not extract private functions', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    const orgs = surface.classes.Organizations;
    expect(orgs.methods.internal_helper).toBeUndefined();
  });

  it('extracts interfaces from defstruct modules', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization).toBeDefined();
    expect(surface.interfaces.Organization.name).toBe('Organization');
  });

  it('extracts struct fields', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.id).toBeDefined();
    expect(org.fields.name).toBeDefined();
    expect(org.fields.allow_profiles_outside_organization).toBeDefined();
    expect(org.fields.domains).toBeDefined();
  });

  it('extracts optional fields from type specs', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.domains).toMatchObject({ optional: true });
    expect(org.fields.id).toMatchObject({ optional: false });
  });

  it('extracts enums from enum-like modules', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.enums.Status).toBeDefined();
    expect(surface.enums.Status.members).toEqual({
      active: 'active',
      inactive: 'inactive',
    });
  });

  it('extracts Order enum', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.enums.Order).toBeDefined();
    expect(surface.enums.Order.members).toEqual({
      asc: 'asc',
      desc: 'desc',
    });
  });

  it('extracts ConnectionType enum from SSO', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.enums.ConnectionType).toBeDefined();
    expect(surface.enums.ConnectionType.members).toEqual({
      generic_oidc: 'GenericOIDC',
      generic_saml: 'GenericSAML',
    });
  });

  it('extracts SSO module as class', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    const sso = surface.classes.SSO;
    expect(sso).toBeDefined();
    expect(Object.keys(sso.methods).sort()).toEqual(['get_connection', 'get_profile']);
  });

  it('extracts Connection struct as interface', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.interfaces.Connection).toBeDefined();
    expect(surface.interfaces.Connection.fields.connection_type).toBeDefined();
  });

  it('extracts multiple structs as interfaces', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.interfaces.Profile).toBeDefined();
    expect(surface.interfaces.ListMetadata).toBeDefined();
    expect(surface.interfaces.ListOrganizationsResponse).toBeDefined();
  });

  it('sets sourceFile on extracted items', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.classes.Organizations.sourceFile).toContain('organizations.ex');
    expect(surface.interfaces.Organization.sourceFile).toContain('organization.ex');
    expect(surface.enums.Status.sourceFile).toContain('organization.ex');
  });

  it('builds export map grouped by source file', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(Object.keys(surface.exports).length).toBeGreaterThan(0);
  });

  it('produces deterministic output', async () => {
    const surface1 = await elixirExtractor.extract(fixturePath);
    const surface2 = await elixirExtractor.extract(fixturePath);
    const normalize = (s: typeof surface1) => ({ ...s, extractedAt: '' });
    expect(normalize(surface1)).toEqual(normalize(surface2));
  });

  it('sets metadata correctly', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.language).toBe('elixir');
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });

  it('throws for non-Elixir projects', async () => {
    await expect(elixirExtractor.extract('/tmp/nonexistent-elixir-project')).rejects.toThrow('No .ex files found');
  });
});
