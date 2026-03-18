import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pythonExtractor } from '../../../src/compat/extractors/python.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-python');

describe('pythonExtractor', () => {
  // -----------------------------------------------------------------------
  // Pydantic models → interfaces
  // -----------------------------------------------------------------------

  it('extracts Pydantic model classes as interfaces', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization).toBeDefined();
    expect(surface.interfaces.Organization.name).toBe('Organization');
  });

  it('extracts Pydantic model fields with types', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.allow_profiles_outside_organization).toMatchObject({
      name: 'allow_profiles_outside_organization',
      type: 'bool',
      optional: false,
    });
    expect(org.fields.domains).toMatchObject({
      name: 'domains',
      type: 'Sequence[str]',
      optional: false,
    });
  });

  it('marks fields with defaults as optional', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.fields.stripe_customer_id).toMatchObject({
      name: 'stripe_customer_id',
      type: 'Optional[str]',
      optional: true,
    });
  });

  it('extracts OrganizationCommon fields', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    const orgCommon = surface.interfaces.OrganizationCommon;
    expect(orgCommon).toBeDefined();
    expect(orgCommon.fields.id).toMatchObject({ name: 'id', type: 'str', optional: false });
    expect(orgCommon.fields.name).toMatchObject({ name: 'name', type: 'str', optional: false });
    expect(orgCommon.fields.created_at).toMatchObject({ name: 'created_at', type: 'str', optional: false });
  });

  it('sets extends on model classes that inherit from other models', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org.extends).toEqual(['OrganizationCommon']);
  });

  // -----------------------------------------------------------------------
  // TypedDict → interfaces
  // -----------------------------------------------------------------------

  it('extracts TypedDict classes as interfaces', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.interfaces.OrganizationListFilters).toBeDefined();
    const filters = surface.interfaces.OrganizationListFilters;
    expect(filters.fields.limit).toBeDefined();
    expect(filters.fields.before).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Protocol classes → classes
  // -----------------------------------------------------------------------

  it('extracts Protocol classes as ApiClass (service)', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.classes.OrganizationsModule).toBeDefined();
    expect(surface.classes.OrganizationsModule.name).toBe('OrganizationsModule');
  });

  it('extracts Protocol methods', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    const orgModule = surface.classes.OrganizationsModule;
    expect(Object.keys(orgModule.methods).sort()).toEqual([
      'create_organization',
      'delete_organization',
      'get_organization',
      'list_organizations',
    ]);
  });

  it('extracts SSOModule as ApiClass', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.classes.SSOModule).toBeDefined();
    const sso = surface.classes.SSOModule;
    expect(Object.keys(sso.methods).sort()).toEqual(['get_connection', 'get_profile', 'list_connections']);
  });

  // -----------------------------------------------------------------------
  // Method params
  // -----------------------------------------------------------------------

  it('extracts method params with types (skipping self)', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    const getOrg = surface.classes.OrganizationsModule.methods.get_organization[0];
    expect(getOrg.params).toHaveLength(1);
    expect(getOrg.params[0]).toMatchObject({
      name: 'organization_id',
      type: 'str',
      optional: false,
    });
  });

  it('marks params with defaults as optional', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    const listOrgs = surface.classes.OrganizationsModule.methods.list_organizations[0];
    const domainsParam = listOrgs.params.find((p) => p.name === 'domains');
    expect(domainsParam).toMatchObject({ optional: true });
    const limitParam = listOrgs.params.find((p) => p.name === 'limit');
    expect(limitParam).toMatchObject({ optional: true });
  });

  // -----------------------------------------------------------------------
  // Return types
  // -----------------------------------------------------------------------

  it('extracts method return types', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    const getOrg = surface.classes.OrganizationsModule.methods.get_organization[0];
    expect(getOrg.returnType).toBe('Organization');
    const deleteOrg = surface.classes.OrganizationsModule.methods.delete_organization[0];
    expect(deleteOrg.returnType).toBe('None');
  });

  // -----------------------------------------------------------------------
  // Private method exclusion
  // -----------------------------------------------------------------------

  it('excludes private methods (starting with _)', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    const orgModule = surface.classes.OrganizationsModule;
    expect(orgModule.methods._internal_helper).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Literal type aliases → enums
  // -----------------------------------------------------------------------

  it('extracts Literal type aliases as enums', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.enums.ConnectionType).toBeDefined();
    expect(surface.enums.ConnectionType.members).toEqual({
      GenericOIDC: 'GenericOIDC',
      GenericSAML: 'GenericSAML',
      GoogleOAuth: 'GoogleOAuth',
      OktaSAML: 'OktaSAML',
    });
  });

  it('extracts PaginationOrder as enum', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.enums.PaginationOrder).toBeDefined();
    expect(surface.enums.PaginationOrder.members).toEqual({
      asc: 'asc',
      desc: 'desc',
    });
  });

  // -----------------------------------------------------------------------
  // WorkOSListResource aliases → typeAliases
  // -----------------------------------------------------------------------

  it('extracts WorkOSListResource as type alias', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.typeAliases.OrganizationsListResource).toBeDefined();
    expect(surface.typeAliases.OrganizationsListResource).toMatchObject({
      name: 'OrganizationsListResource',
      value: 'WorkOSListResource[Organization, OrganizationListFilters, ListMetadata]',
    });
  });

  // -----------------------------------------------------------------------
  // Exception classes → classes
  // -----------------------------------------------------------------------

  it('extracts exception classes as ApiClass', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.classes.BaseRequestException).toBeDefined();
    expect(surface.classes.AuthorizationException).toBeDefined();
    expect(surface.classes.AuthenticationException).toBeDefined();
    expect(surface.classes.NotFoundException).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // sourceFile
  // -----------------------------------------------------------------------

  it('sets sourceFile on interfaces', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization.sourceFile).toBe('src/workos/types/organizations/organization.py');
    expect(surface.interfaces.OrganizationCommon.sourceFile).toBe(
      'src/workos/types/organizations/organization_common.py',
    );
  });

  it('sets sourceFile on classes', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.classes.OrganizationsModule.sourceFile).toBe('src/workos/organizations.py');
    expect(surface.classes.SSOModule.sourceFile).toBe('src/workos/sso.py');
  });

  it('sets sourceFile on enums', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.enums.ConnectionType.sourceFile).toBe('src/workos/types/sso/connection_type.py');
    expect(surface.enums.PaginationOrder.sourceFile).toBe('src/workos/utils/pagination_order.py');
  });

  it('sets sourceFile on type aliases', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.typeAliases.OrganizationsListResource.sourceFile).toBe('src/workos/organizations.py');
  });

  // -----------------------------------------------------------------------
  // Export map
  // -----------------------------------------------------------------------

  it('builds export map grouped by source file', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(Object.keys(surface.exports).length).toBeGreaterThan(0);
    const orgExports = surface.exports['src/workos/organizations.py'];
    expect(orgExports).toBeDefined();
    expect(orgExports).toEqual(expect.arrayContaining(['OrganizationsModule', 'OrganizationsListResource']));
  });

  // -----------------------------------------------------------------------
  // Deterministic output
  // -----------------------------------------------------------------------

  it('produces deterministic output', async () => {
    const surface1 = await pythonExtractor.extract(fixturePath);
    const surface2 = await pythonExtractor.extract(fixturePath);
    const normalize = (s: typeof surface1) => ({ ...s, extractedAt: '' });
    expect(normalize(surface1)).toEqual(normalize(surface2));
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  it('sets metadata correctly', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.language).toBe('python');
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it('throws for non-Python projects', async () => {
    await expect(pythonExtractor.extract('/tmp/nonexistent-python-project')).rejects.toThrow('No Python package found');
  });

  // -----------------------------------------------------------------------
  // Connection model
  // -----------------------------------------------------------------------

  it('extracts Connection as interface with fields', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.interfaces.Connection).toBeDefined();
    expect(surface.interfaces.Connection.fields.id).toMatchObject({
      name: 'id',
      type: 'str',
      optional: false,
    });
    expect(surface.interfaces.Connection.fields.connection_type).toMatchObject({
      name: 'connection_type',
      type: 'str',
    });
    expect(surface.interfaces.Connection.fields.organization_id).toMatchObject({
      optional: true,
    });
  });

  // -----------------------------------------------------------------------
  // Profile model
  // -----------------------------------------------------------------------

  it('extracts Profile as interface with optional fields', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.interfaces.Profile).toBeDefined();
    expect(surface.interfaces.Profile.fields.email).toMatchObject({
      name: 'email',
      type: 'str',
      optional: false,
    });
    expect(surface.interfaces.Profile.fields.first_name).toMatchObject({
      optional: true,
    });
  });

  // -----------------------------------------------------------------------
  // ListMetadata
  // -----------------------------------------------------------------------

  it('extracts ListMetadata as interface', async () => {
    const surface = await pythonExtractor.extract(fixturePath);
    expect(surface.interfaces.ListMetadata).toBeDefined();
    expect(surface.interfaces.ListMetadata.fields.before).toBeDefined();
    expect(surface.interfaces.ListMetadata.fields.after).toBeDefined();
  });
});
