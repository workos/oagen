import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { iosExtractor } from '../../../src/compat/extractors/ios.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-ios');

describe('iosExtractor', () => {
  it('extracts resource structs with methods as classes', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    expect(surface.classes.Organizations).toBeDefined();
    expect(surface.classes.Organizations.name).toBe('Organizations');
    expect(Object.keys(surface.classes.Organizations.methods).sort()).toEqual([
      'createOrganization',
      'deleteOrganization',
      'getOrganization',
      'listOrganizations',
    ]);
  });

  it('extracts method params with labels and types', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    const getOrg = surface.classes.Organizations.methods.getOrganization[0];
    expect(getOrg.params).toHaveLength(2);
    expect(getOrg.params[0]).toMatchObject({
      name: 'id',
      type: 'String',
      optional: false,
    });
    expect(getOrg.params[1]).toMatchObject({
      name: 'requestOptions',
      type: 'RequestOptions?',
      optional: true,
    });
  });

  it('marks params as labeled positional (Swift argument labels)', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    const getOrg = surface.classes.Organizations.methods.getOrganization[0];
    expect(getOrg.params[0].passingStyle).toBe('positional');
  });

  it('extracts method return types', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    const getOrg = surface.classes.Organizations.methods.getOrganization[0];
    expect(getOrg.returnType).toBe('Organization');
    const listOrgs = surface.classes.Organizations.methods.listOrganizations[0];
    expect(listOrgs.returnType).toBe('Page<Organization>');
  });

  it('extracts void methods (no return arrow)', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    const deleteOrg = surface.classes.Organizations.methods.deleteOrganization[0];
    expect(deleteOrg.returnType).toBe('Void');
  });

  it('marks async methods', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    const getOrg = surface.classes.Organizations.methods.getOrganization[0];
    expect(getOrg.async).toBe(true);
  });

  it('does not extract private methods', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    expect(surface.classes.Organizations.methods.internalHelper).toBeUndefined();
  });

  it('survives interpolations containing nested string literals', async () => {
    // templatePath's body interpolates `escapeSegment("{")` — if the scanner
    // mis-terminated the outer string at the nested quote, the stray `{`
    // would corrupt brace matching and swallow every later declaration.
    const surface = await iosExtractor.extract(fixturePath);
    expect(surface.classes.Organizations.methods.templatePath).toBeUndefined();
    expect(Object.keys(surface.classes.Organizations.methods)).toContain('getOrganization');
    expect(Object.keys(surface.classes.Organizations.methods)).toContain('deleteOrganization');
  });

  it('extracts dictionary param types intact', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    const createOrg = surface.classes.Organizations.methods.createOrganization[0];
    const metadata = createOrg.params.find((p) => p.name === 'metadata');
    expect(metadata).toMatchObject({ type: '[String: AnyCodable]?', optional: true });
  });

  it('extracts model structs as interfaces with Swift property names', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    const org = surface.interfaces.Organization;
    expect(org).toBeDefined();
    expect(org.fields.id).toMatchObject({ type: 'String', optional: false });
    expect(org.fields.allowProfilesOutsideOrganization).toMatchObject({ type: 'Bool?', optional: true });
    expect(org.fields.domains).toMatchObject({ type: '[OrganizationDomain]?', optional: true });
  });

  it('does not turn internal stored properties into public surface', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    // `let transport: Transport` has no access modifier → internal → excluded
    expect(surface.classes.Organizations.properties.transport).toBeUndefined();
  });

  it('extracts enums with raw values from rawValue switches', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    expect(surface.enums.OrganizationState).toBeDefined();
    expect(surface.enums.OrganizationState.members).toEqual({
      active: 'active',
      inactive: 'inactive',
      pendingReview: 'pending_review',
    });
  });

  it('excludes the unknown(String) escape-hatch enum case', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    expect(surface.enums.OrganizationState.members.unknown).toBeUndefined();
  });

  it('does not extract private nested CodingKeys enums', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    expect(surface.enums.CodingKeys).toBeUndefined();
  });

  it('extracts type aliases', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    expect(surface.typeAliases.OrganizationPage).toMatchObject({
      name: 'OrganizationPage',
      value: 'Page<Organization>',
    });
  });

  it('extracts client resource accessors from extensions', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    const client = surface.classes.WorkOSClient;
    expect(client).toBeDefined();
    expect(client.properties.organizations).toMatchObject({ type: 'Organizations', readonly: false });
    expect(client.properties.sso).toMatchObject({ type: 'Sso', readonly: false });
  });

  it('attributes extension-only types to the extension source file', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    expect(surface.classes.WorkOSClient.sourceFile).toBe('Sources/WorkOS/WorkOSClient+Resources.swift');
  });

  it('skips @oagen-ignore-file hand-maintained files entirely', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    // WorkOSClient.swift declares `configuration` and `handWrittenHelper` —
    // neither may leak into the surface.
    expect(surface.classes.WorkOSClient.properties.configuration).toBeUndefined();
    expect(surface.classes.WorkOSClient.methods.handWrittenHelper).toBeUndefined();
  });

  it('records exports per source file', async () => {
    const surface = await iosExtractor.extract(fixturePath);
    expect(surface.exports['Sources/WorkOS/Resources/Organizations.swift']).toEqual(['Organizations']);
    expect(surface.exports['Sources/WorkOS/Models/Organization.swift']).toEqual(['Organization', 'OrganizationPage']);
  });

  it('produces a compat snapshot with positional labeled parameters', async () => {
    const snapshot = await iosExtractor.extractSnapshot(fixturePath);
    const callable = snapshot.symbols.find((s) => s.fqName === 'Organizations.getOrganization');
    expect(callable).toBeDefined();
    expect(callable?.parameters?.[0]).toMatchObject({
      publicName: 'id',
      passing: 'positional',
      required: true,
    });
  });

  describe('language hints', () => {
    it('strips optional suffix', () => {
      expect(iosExtractor.hints.stripNullable('Organization?')).toBe('Organization');
      expect(iosExtractor.hints.stripNullable('Organization')).toBeNull();
    });

    it('unwraps Page, arrays, and optionals in return types', () => {
      expect(iosExtractor.hints.extractReturnTypeName('Page<Organization>')).toBe('Organization');
      expect(iosExtractor.hints.extractReturnTypeName('[Organization]')).toBe('Organization');
      expect(iosExtractor.hints.extractReturnTypeName('Organization?')).toBe('Organization');
      expect(iosExtractor.hints.extractReturnTypeName('String')).toBeNull();
      expect(iosExtractor.hints.extractReturnTypeName('Void')).toBeNull();
    });

    it('unwraps dictionary value types in params', () => {
      expect(iosExtractor.hints.extractParamTypeName('[String: AnyCodable]?')).toBe('AnyCodable');
      expect(iosExtractor.hints.extractParamTypeName('String')).toBeNull();
    });

    it('treats AnyCodable as an extraction artifact', () => {
      expect(iosExtractor.hints.isExtractionArtifact('AnyCodable')).toBe(true);
      expect(iosExtractor.hints.isExtractionArtifact('Organization')).toBe(false);
    });
  });
});
