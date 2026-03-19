import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { dotnetExtractor } from '../../../src/compat/extractors/dotnet.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-dotnet');

describe('dotnetExtractor', () => {
  it('extracts classes with methods (service classes)', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(surface.classes.OrganizationService).toBeDefined();
    expect(surface.classes.OrganizationService.name).toBe('OrganizationService');
    expect(Object.keys(surface.classes.OrganizationService.methods).sort()).toEqual([
      'CreateOrganizationAsync',
      'DeleteOrganizationAsync',
      'GetOrganizationAsync',
      'ListOrganizationsAsync',
    ]);
  });

  it('extracts method params', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    const getOrg = surface.classes.OrganizationService.methods.GetOrganizationAsync[0];
    expect(getOrg.params).toHaveLength(1);
    expect(getOrg.params[0]).toMatchObject({
      name: 'id',
      type: 'string',
      optional: false,
    });
  });

  it('extracts async method return types', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    const getOrg = surface.classes.OrganizationService.methods.GetOrganizationAsync[0];
    expect(getOrg.returnType).toBe('Task<Organization>');
    expect(getOrg.async).toBe(true);
  });

  it('extracts void-like async methods', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    const deleteOrg = surface.classes.OrganizationService.methods.DeleteOrganizationAsync[0];
    expect(deleteOrg.returnType).toBe('Task');
    expect(deleteOrg.async).toBe(true);
  });

  it('does not extract private methods', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    const svc = surface.classes.OrganizationService;
    expect(svc.methods.InternalHelper).toBeUndefined();
  });

  it('extracts optional method params', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    const listOrgs = surface.classes.OrganizationService.methods.ListOrganizationsAsync[0];
    expect(listOrgs.params[0]).toMatchObject({
      name: 'options',
      optional: true,
    });
  });

  it('extracts constructor params', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    const svc = surface.classes.OrganizationService;
    expect(svc.constructorParams).toHaveLength(1);
    expect(svc.constructorParams[0]).toMatchObject({
      name: 'client',
      type: 'WorkOSClient',
    });
  });

  it('extracts interfaces from data classes', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization).toBeDefined();
    expect(surface.interfaces.Organization.name).toBe('Organization');
  });

  it('uses JsonProperty names for interface fields', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.id).toBeDefined();
    expect(org.fields.name).toBeDefined();
    expect(org.fields.allow_profiles_outside_organization).toBeDefined();
  });

  it('extracts enums with EnumMember values', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(surface.enums.OrganizationStatus).toBeDefined();
    expect(surface.enums.OrganizationStatus.members).toEqual({
      Active: 'active',
      Inactive: 'inactive',
    });
  });

  it('extracts Order enum', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(surface.enums.Order).toBeDefined();
    expect(surface.enums.Order.members).toEqual({
      Asc: 'asc',
      Desc: 'desc',
    });
  });

  it('extracts ConnectionType enum from SSO namespace', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(surface.enums.ConnectionType).toBeDefined();
    expect(surface.enums.ConnectionType.members).toEqual({
      GenericOIDC: 'GenericOIDC',
      GenericSAML: 'GenericSAML',
    });
  });

  it('extracts SsoService class with methods', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    const ssoSvc = surface.classes.SsoService;
    expect(ssoSvc).toBeDefined();
    expect(Object.keys(ssoSvc.methods).sort()).toEqual(['GetConnectionAsync', 'GetProfileAsync']);
  });

  it('extracts Connection data class as interface', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(surface.interfaces.Connection).toBeDefined();
    expect(surface.interfaces.Connection.fields.connection_type).toBeDefined();
  });

  it('extracts multiple data classes as interfaces', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(surface.interfaces.Profile).toBeDefined();
    expect(surface.interfaces.ListMetadata).toBeDefined();
    expect(surface.interfaces.ListOrganizationsResponse).toBeDefined();
  });

  it('sets sourceFile on extracted items', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(surface.classes.OrganizationService.sourceFile).toContain('OrganizationService.cs');
    expect(surface.classes.SsoService.sourceFile).toContain('SsoService.cs');
    expect(surface.interfaces.Organization.sourceFile).toContain('Organization.cs');
    expect(surface.enums.OrganizationStatus.sourceFile).toContain('Organization.cs');
  });

  it('builds export map grouped by source file', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(Object.keys(surface.exports).length).toBeGreaterThan(0);
  });

  it('produces deterministic output', async () => {
    const surface1 = await dotnetExtractor.extract(fixturePath);
    const surface2 = await dotnetExtractor.extract(fixturePath);
    const normalize = (s: typeof surface1) => ({ ...s, extractedAt: '' });
    expect(normalize(surface1)).toEqual(normalize(surface2));
  });

  it('sets metadata correctly', async () => {
    const surface = await dotnetExtractor.extract(fixturePath);
    expect(surface.language).toBe('dotnet');
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });

  it('throws for non-DotNet projects', async () => {
    await expect(dotnetExtractor.extract('/tmp/nonexistent-dotnet-project')).rejects.toThrow('No .cs files found');
  });
});
