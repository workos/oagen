import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createPhpExtractor } from '../../../src/compat/extractors/php.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-php');

// The test fixtures simulate a PHP SDK with specific base classes.
// Configure the extractor with the fixture's base classes via hints.
const phpExtractor = createPhpExtractor({
  modelBaseClasses: ['BaseWorkOSResource'],
  exceptionBaseClasses: ['Exception', '\\Exception', 'BaseRequestException'],
});

describe('phpExtractor', () => {
  // -------------------------------------------------------------------------
  // Resource classes → interfaces
  // -------------------------------------------------------------------------

  it('extracts resource classes as interfaces with fields from RESOURCE_ATTRIBUTES', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization).toBeDefined();
    const org = surface.interfaces.Organization;
    expect(org.name).toBe('Organization');
    expect(org.fields.id).toMatchObject({ name: 'id', type: 'mixed', optional: false });
    expect(org.fields.name).toMatchObject({ name: 'name', type: 'mixed', optional: false });
    expect(org.fields.allowProfilesOutsideOrganization).toMatchObject({
      name: 'allowProfilesOutsideOrganization',
      type: 'mixed',
      optional: false,
    });
    expect(org.fields.domains).toMatchObject({ name: 'domains', type: 'mixed', optional: false });
    expect(org.extends).toEqual(['BaseWorkOSResource']);
  });

  it('extracts Connection resource with correct attributes', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.interfaces.Connection).toBeDefined();
    const conn = surface.interfaces.Connection;
    expect(Object.keys(conn.fields).sort()).toEqual(['connectionType', 'id', 'name', 'organizationId', 'state']);
  });

  it('extracts Profile resource with correct attributes', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.interfaces.Profile).toBeDefined();
    const profile = surface.interfaces.Profile;
    expect(Object.keys(profile.fields)).toEqual(
      expect.arrayContaining(['id', 'email', 'firstName', 'lastName', 'connectionId']),
    );
  });

  // -------------------------------------------------------------------------
  // Service classes → classes
  // -------------------------------------------------------------------------

  it('extracts service classes with public methods', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.classes.Organizations).toBeDefined();
    const orgs = surface.classes.Organizations;
    expect(Object.keys(orgs.methods).sort()).toEqual([
      'createOrganization',
      'deleteOrganization',
      'getOrganization',
      'listOrganizations',
    ]);
  });

  it('extracts SSO service class with methods', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.classes.SSO).toBeDefined();
    const sso = surface.classes.SSO;
    expect(Object.keys(sso.methods).sort()).toEqual([
      'getAuthorizationUrl',
      'getConnection',
      'getProfileAndToken',
      'listConnections',
    ]);
  });

  // -------------------------------------------------------------------------
  // Enum-like classes → enums
  // -------------------------------------------------------------------------

  it('extracts enum-like classes as enums', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.enums.ConnectionType).toBeDefined();
    expect(surface.enums.ConnectionType.members).toEqual({
      GenericOIDC: 'GenericOIDC',
      GenericSAML: 'GenericSAML',
      GoogleOAuth: 'GoogleOAuth',
      OktaSAML: 'OktaSAML',
    });
  });

  // -------------------------------------------------------------------------
  // Static utility classes → classes
  // -------------------------------------------------------------------------

  it('extracts static utility classes', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.classes.WorkOS).toBeDefined();
    const workos = surface.classes.WorkOS;
    expect(Object.keys(workos.methods).sort()).toEqual(['getApiKey', 'getClientId', 'setApiKey', 'setClientId']);
  });

  // -------------------------------------------------------------------------
  // Exception classes → classes
  // -------------------------------------------------------------------------

  it('extracts exception classes', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.classes.BaseRequestException).toBeDefined();
    expect(surface.classes.BaseRequestException.methods.__construct).toBeDefined();
    expect(surface.classes.BaseRequestException.methods.getRequestId).toBeDefined();
  });

  it('extracts exception subclasses', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    // AuthenticationException and NotFoundException extend BaseRequestException
    // but have no own public methods/properties, so they should still appear
    // as classes if they are exception classes
    expect(surface.classes.AuthenticationException).toBeDefined();
    expect(surface.classes.NotFoundException).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // PHP interfaces → interfaces
  // -------------------------------------------------------------------------

  it('extracts PHP interfaces as ApiInterface', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.interfaces.RequestClientInterface).toBeDefined();
    const iface = surface.interfaces.RequestClientInterface;
    expect(iface.fields.request).toBeDefined();
    expect(iface.fields.request.type).toBe('array');
  });

  // -------------------------------------------------------------------------
  // PHPDoc param extraction
  // -------------------------------------------------------------------------

  it('extracts param types from PHPDoc annotations', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    const createOrg = surface.classes.Organizations.methods.createOrganization[0];
    expect(createOrg.params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'name', type: 'string' }),
        expect.objectContaining({ name: 'domains', type: 'array' }),
      ]),
    );
  });

  // -------------------------------------------------------------------------
  // PHPDoc return type
  // -------------------------------------------------------------------------

  it('extracts return types from PHPDoc annotations', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    const getOrg = surface.classes.Organizations.methods.getOrganization[0];
    expect(getOrg.returnType).toBe('\\WorkOS\\Resource\\Organization');
    const listOrgs = surface.classes.Organizations.methods.listOrganizations[0];
    expect(listOrgs.returnType).toBe('array');
  });

  // -------------------------------------------------------------------------
  // Private method exclusion
  // -------------------------------------------------------------------------

  it('excludes private methods from extracted classes', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    const orgs = surface.classes.Organizations;
    expect(orgs.methods.internalHelper).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Optional params
  // -------------------------------------------------------------------------

  it('marks params with default values as optional', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    const listOrgs = surface.classes.Organizations.methods.listOrganizations[0];

    const domainsParam = listOrgs.params.find((p) => p.name === 'domains');
    expect(domainsParam).toMatchObject({ optional: true });

    const limitParam = listOrgs.params.find((p) => p.name === 'limit');
    expect(limitParam).toMatchObject({ optional: true });
  });

  it('marks params without default values as required', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    const createOrg = surface.classes.Organizations.methods.createOrganization[0];

    const nameParam = createOrg.params.find((p) => p.name === 'name');
    expect(nameParam).toMatchObject({ optional: false });

    const domainsParam = createOrg.params.find((p) => p.name === 'domains');
    expect(domainsParam).toMatchObject({ optional: false });
  });

  // -------------------------------------------------------------------------
  // sourceFile
  // -------------------------------------------------------------------------

  it('sets sourceFile on extracted classes', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.classes.Organizations.sourceFile).toBe('lib/Organizations.php');
    expect(surface.classes.SSO.sourceFile).toBe('lib/SSO.php');
    expect(surface.classes.WorkOS.sourceFile).toBe('lib/WorkOS.php');
  });

  it('sets sourceFile on extracted interfaces', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.interfaces.Organization.sourceFile).toBe('lib/Resource/Organization.php');
    expect(surface.interfaces.Connection.sourceFile).toBe('lib/Resource/Connection.php');
  });

  it('sets sourceFile on extracted enums', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.enums.ConnectionType.sourceFile).toBe('lib/Resource/ConnectionType.php');
  });

  // -------------------------------------------------------------------------
  // Export map
  // -------------------------------------------------------------------------

  it('builds export map grouped by source file', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(Object.keys(surface.exports).length).toBeGreaterThan(0);

    const orgExports = surface.exports['lib/Organizations.php'];
    expect(orgExports).toBeDefined();
    expect(orgExports).toContain('Organizations');

    const connTypeExports = surface.exports['lib/Resource/ConnectionType.php'];
    expect(connTypeExports).toBeDefined();
    expect(connTypeExports).toContain('ConnectionType');
  });

  // -------------------------------------------------------------------------
  // Deterministic output
  // -------------------------------------------------------------------------

  it('produces deterministic output', async () => {
    const surface1 = await phpExtractor.extract(fixturePath);
    const surface2 = await phpExtractor.extract(fixturePath);
    const normalize = (s: typeof surface1) => ({ ...s, extractedAt: '' });
    expect(normalize(surface1)).toEqual(normalize(surface2));
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('sets metadata correctly', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.language).toBe('php');
    expect(surface.extractedFrom).toBe(fixturePath);
    expect(surface.extractedAt).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('throws for non-PHP projects', async () => {
    await expect(phpExtractor.extract('/tmp/nonexistent-php-project')).rejects.toThrow(
      'No lib/ or src/ directory found',
    );
  });

  // -------------------------------------------------------------------------
  // Type aliases (PHP has none)
  // -------------------------------------------------------------------------

  it('returns empty typeAliases', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    expect(surface.typeAliases).toEqual({});
  });

  // -----------------------------------------------------------------------
  // Passing style detection
  // -----------------------------------------------------------------------

  it('sets passingStyle to named for all PHP params', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    const createOrg = surface.classes.Organizations.methods.createOrganization[0];
    // PHP 8+ supports named arguments on all params
    for (const param of createOrg.params) {
      expect(param.passingStyle).toBe('named');
    }
  });

  // -----------------------------------------------------------------------
  // Parameter order preservation
  // -----------------------------------------------------------------------

  it('preserves parameter order for createOrganization', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    const createOrg = surface.classes.Organizations.methods.createOrganization[0];
    const paramNames = createOrg.params.map((p) => p.name);
    expect(paramNames).toEqual(['name', 'domains', 'allowProfilesOutsideOrganization']);
  });

  it('preserves parameter order for listOrganizations', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    const listOrgs = surface.classes.Organizations.methods.listOrganizations[0];
    const paramNames = listOrgs.params.map((p) => p.name);
    expect(paramNames).toEqual(['domains', 'limit', 'before', 'after']);
  });

  // -----------------------------------------------------------------------
  // Parameter requiredness
  // -----------------------------------------------------------------------

  it('distinguishes required vs optional params on createOrganization', async () => {
    const surface = await phpExtractor.extract(fixturePath);
    const createOrg = surface.classes.Organizations.methods.createOrganization[0];
    expect(createOrg.params[0]).toMatchObject({ name: 'name', optional: false });
    expect(createOrg.params[1]).toMatchObject({ name: 'domains', optional: false });
    expect(createOrg.params[2]).toMatchObject({ name: 'allowProfilesOutsideOrganization', optional: true });
  });
});
