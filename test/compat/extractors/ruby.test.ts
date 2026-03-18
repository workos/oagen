import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { rubyExtractor } from '../../../src/compat/extractors/ruby.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-ruby');

describe('rubyExtractor', () => {
  it('extracts model classes', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    expect(surface.classes.Organization).toBeDefined();
    expect(surface.classes.Organization.name).toBe('Organization');
  });

  it('extracts attr_accessor properties', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const org = surface.classes.Organization;
    expect(org.properties.id).toMatchObject({ name: 'id', readonly: false });
    expect(org.properties.name).toMatchObject({ name: 'name', readonly: false });
    expect(org.properties.created_at).toMatchObject({ name: 'created_at', readonly: false });
    expect(org.properties.updated_at).toMatchObject({ name: 'updated_at', readonly: false });
  });

  it('extracts attr_reader as readonly properties', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const org = surface.classes.Organization;
    expect(org.properties.domains).toMatchObject({ name: 'domains', readonly: true });
  });

  it('extracts constructor params from initialize', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const org = surface.classes.Organization;
    expect(org.constructorParams).toHaveLength(1);
    expect(org.constructorParams[0]).toMatchObject({ name: 'json', optional: false });
  });

  it('extracts instance methods', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const profile = surface.classes.Profile;
    expect(profile.methods.full_name).toBeDefined();
    expect(profile.methods.full_name[0].params).toHaveLength(0);
  });

  it('extracts to_json as a method', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const org = surface.classes.Organization;
    expect(org.methods.to_json).toBeDefined();
  });

  it('extracts service modules as classes', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    expect(surface.classes.Organizations).toBeDefined();
    expect(surface.classes.SSO).toBeDefined();
  });

  it('extracts service module methods', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const orgs = surface.classes.Organizations;
    expect(orgs.methods.list_organizations).toBeDefined();
    expect(orgs.methods.get_organization).toBeDefined();
    expect(orgs.methods.create_organization).toBeDefined();
    expect(orgs.methods.delete_organization).toBeDefined();
  });

  it('excludes private methods from service modules', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const orgs = surface.classes.Organizations;
    expect(orgs.methods.check_and_raise_organization_error).toBeUndefined();
  });

  it('extracts keyword arguments with defaults as optional params', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const createOrg = surface.classes.Organizations.methods.create_organization[0];
    // name: is required (no default), domain_data: nil and idempotency_key: nil are optional
    const nameParam = createOrg.params.find((p) => p.name === 'name');
    const domainDataParam = createOrg.params.find((p) => p.name === 'domain_data');
    const idempotencyKeyParam = createOrg.params.find((p) => p.name === 'idempotency_key');
    expect(nameParam).toMatchObject({ name: 'name', optional: false });
    expect(domainDataParam).toMatchObject({ name: 'domain_data', optional: true });
    expect(idempotencyKeyParam).toMatchObject({ name: 'idempotency_key', optional: true });
  });

  it('extracts positional arguments with defaults as optional', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const listOrgs = surface.classes.Organizations.methods.list_organizations[0];
    expect(listOrgs.params).toHaveLength(1);
    expect(listOrgs.params[0]).toMatchObject({ name: 'options', optional: true });
  });

  it('extracts enum-like modules', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    expect(surface.enums.Provider).toBeDefined();
    expect(surface.enums.Provider.members).toEqual({
      Apple: 'AppleOAuth',
      GitHub: 'GitHubOAuth',
      Google: 'GoogleOAuth',
      Microsoft: 'MicrosoftOAuth',
    });
  });

  it('extracts error classes', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    expect(surface.classes.WorkOSError).toBeDefined();
    expect(surface.classes.APIError).toBeDefined();
    expect(surface.classes.AuthenticationError).toBeDefined();
  });

  it('extracts struct-like classes', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    expect(surface.classes.ListStruct).toBeDefined();
    expect(surface.classes.ListStruct.properties.data).toBeDefined();
    expect(surface.classes.ListStruct.properties.list_metadata).toBeDefined();
  });

  it('extracts SSO module methods', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const sso = surface.classes.SSO;
    expect(sso.methods.authorization_url).toBeDefined();
    expect(sso.methods.get_profile).toBeDefined();
    expect(sso.methods.list_connections).toBeDefined();
    expect(sso.methods.get_connection).toBeDefined();
    expect(sso.methods.delete_connection).toBeDefined();
  });

  it('excludes private methods from SSO module', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const sso = surface.classes.SSO;
    expect(sso.methods.validate_authorization_url_arguments).toBeUndefined();
  });

  it('sets sourceFile on extracted classes', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    expect(surface.classes.Organization.sourceFile).toBe('lib/workos/organization.rb');
    expect(surface.classes.Organizations.sourceFile).toBe('lib/workos/organizations.rb');
  });

  it('sets sourceFile on extracted enums', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    expect(surface.enums.Provider.sourceFile).toBe('lib/workos/types/provider.rb');
  });

  it('extracts autoload declarations as exports', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const mainExports = surface.exports['lib/workos.rb'];
    expect(mainExports).toBeDefined();
    expect(mainExports).toEqual(
      expect.arrayContaining(['Organization', 'Organizations', 'SSO', 'Connection', 'Profile', 'User']),
    );
  });

  it('has empty interfaces and typeAliases for Ruby', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    expect(surface.interfaces).toEqual({});
    expect(surface.typeAliases).toEqual({});
  });

  it('produces deterministic output', async () => {
    const surface1 = await rubyExtractor.extract(fixturePath);
    const surface2 = await rubyExtractor.extract(fixturePath);
    const normalize = (s: typeof surface1) => ({ ...s, extractedAt: '' });
    expect(normalize(surface1)).toEqual(normalize(surface2));
  });

  it('sets metadata correctly', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    expect(surface.language).toBe('ruby');
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });

  it('extracts multiple classes from the same file', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    // errors.rb has WorkOSError, APIError, AuthenticationError
    expect(surface.classes.WorkOSError).toBeDefined();
    expect(surface.classes.APIError).toBeDefined();
    expect(surface.classes.AuthenticationError).toBeDefined();
  });

  it('extracts all properties from User model', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const user = surface.classes.User;
    expect(user.properties.id).toBeDefined();
    expect(user.properties.email).toBeDefined();
    expect(user.properties.first_name).toBeDefined();
    expect(user.properties.last_name).toBeDefined();
    expect(user.properties.email_verified).toBeDefined();
  });

  it('extracts Connection properties including readonly', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const conn = surface.classes.Connection;
    expect(conn.properties.id).toMatchObject({ readonly: false });
    expect(conn.properties.organization_id).toMatchObject({ readonly: true });
  });

  it('extracts constants from service modules as readonly properties', async () => {
    const surface = await rubyExtractor.extract(fixturePath);
    const sso = surface.classes.SSO;
    expect(sso.properties.PROVIDERS).toMatchObject({ name: 'PROVIDERS', readonly: true });
  });
});
