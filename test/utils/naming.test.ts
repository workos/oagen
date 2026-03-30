import { describe, it, expect } from 'vitest';
import {
  toPascalCase,
  toCamelCase,
  toSnakeCase,
  toKebabCase,
  toUpperSnakeCase,
  stripBackendSuffixes,
  stripListItemMarkers,
  singularize,
  cleanSchemaName,
  ACRONYM_SET,
} from '../../src/utils/naming.js';

describe('toPascalCase', () => {
  it('converts snake_case', () => {
    expect(toPascalCase('user_profile')).toBe('UserProfile');
  });
  it('converts camelCase', () => {
    expect(toPascalCase('userProfile')).toBe('UserProfile');
  });
  it('handles consecutive capitals', () => {
    expect(toPascalCase('HTTPClient')).toBe('HttpClient');
  });
  it('handles numbers', () => {
    expect(toPascalCase('oauth2_token')).toBe('OAuth2Token');
    expect(toPascalCase('OAuth2Token')).toBe('OAuth2Token');
  });
  it('handles kebab-case', () => {
    expect(toPascalCase('user-profile')).toBe('UserProfile');
  });
  it('handles single char', () => {
    expect(toPascalCase('a')).toBe('A');
  });
  it('handles empty string', () => {
    expect(toPascalCase('')).toBe('');
  });
  it('handles already PascalCase', () => {
    expect(toPascalCase('UserProfile')).toBe('UserProfile');
  });
  it('handles APIKey', () => {
    expect(toPascalCase('APIKey')).toBe('ApiKey');
  });
  it('preserves acronyms like SSO and FGA', () => {
    expect(toPascalCase('SSO')).toBe('SSO');
    expect(toPascalCase('sso_connection')).toBe('SSOConnection');
    expect(toPascalCase('FGA')).toBe('FGA');
    expect(toPascalCase('mfa_factor')).toBe('MfaFactor');
  });
  it('preserves M2M as a compound acronym', () => {
    expect(toPascalCase('CreateM2MApplication')).toBe('CreateM2MApplication');
    expect(toPascalCase('create_m2m_application')).toBe('CreateM2MApplication');
  });
});

describe('toCamelCase', () => {
  it('converts snake_case', () => {
    expect(toCamelCase('user_profile')).toBe('userProfile');
  });
  it('converts PascalCase', () => {
    expect(toCamelCase('UserProfile')).toBe('userProfile');
  });
  it('handles consecutive capitals', () => {
    expect(toCamelCase('HTTPClient')).toBe('httpClient');
  });
  it('preserves acronyms in camelCase (non-leading)', () => {
    expect(toCamelCase('sso_connection')).toBe('ssoConnection');
    expect(toCamelCase('api_key')).toBe('apiKey');
    expect(toCamelCase('validate_api_key')).toBe('validateApiKey');
  });
  it('handles already camelCase', () => {
    expect(toCamelCase('userProfile')).toBe('userProfile');
  });
});

describe('toSnakeCase', () => {
  it('converts PascalCase', () => {
    expect(toSnakeCase('UserProfile')).toBe('user_profile');
  });
  it('converts camelCase', () => {
    expect(toSnakeCase('userProfile')).toBe('user_profile');
  });
  it('handles consecutive capitals', () => {
    expect(toSnakeCase('HTTPClient')).toBe('http_client');
  });
  it('handles numbers', () => {
    expect(toSnakeCase('OAuth2Token')).toBe('oauth_2_token');
  });
  it('handles already snake_case', () => {
    expect(toSnakeCase('already_snake_case')).toBe('already_snake_case');
  });
  it('handles user_id', () => {
    expect(toSnakeCase('user_id')).toBe('user_id');
  });
});

describe('toKebabCase', () => {
  it('converts PascalCase', () => {
    expect(toKebabCase('UserProfile')).toBe('user-profile');
  });
  it('converts snake_case', () => {
    expect(toKebabCase('user_profile')).toBe('user-profile');
  });
  it('keeps OAuth as a single token', () => {
    expect(toKebabCase('CreateOAuthApplication')).toBe('create-oauth-application');
  });
  it('keeps M2M as a single token', () => {
    expect(toKebabCase('CreateM2MApplication')).toBe('create-m2m-application');
  });
});

describe('stripBackendSuffixes', () => {
  it('preserves Dto suffix', () => {
    expect(stripBackendSuffixes('CreateOrganizationDto')).toBe('CreateOrganizationDto');
  });
  it('preserves DTO suffix', () => {
    expect(stripBackendSuffixes('ValidateApiKeyDTO')).toBe('ValidateApiKeyDTO');
  });
  it('strips Controller suffix', () => {
    expect(stripBackendSuffixes('OrganizationsController')).toBe('Organizations');
  });
  it('does not strip from the middle of a name', () => {
    expect(stripBackendSuffixes('DtoValidator')).toBe('DtoValidator');
  });
  it('does not strip if the name IS the suffix', () => {
    expect(stripBackendSuffixes('Dto')).toBe('Dto');
    expect(stripBackendSuffixes('DTO')).toBe('DTO');
    expect(stripBackendSuffixes('Controller')).toBe('Controller');
  });
  it('returns clean names unchanged', () => {
    expect(stripBackendSuffixes('Organization')).toBe('Organization');
    expect(stripBackendSuffixes('User')).toBe('User');
  });
});

describe('stripListItemMarkers', () => {
  it('removes ListItem from name', () => {
    expect(stripListItemMarkers('DirectoriesListItemState')).toBe('DirectoriesState');
  });
  it('removes ByExternalId from name', () => {
    expect(stripListItemMarkers('UserByExternalId')).toBe('User');
  });
  it('removes ByResourceId from name', () => {
    expect(stripListItemMarkers('ConnectionByResourceId')).toBe('Connection');
  });
  it('removes ForResource from name', () => {
    expect(stripListItemMarkers('PermissionForResource')).toBe('Permission');
  });
  it('leaves clean names unchanged', () => {
    expect(stripListItemMarkers('Organization')).toBe('Organization');
  });
});

describe('singularize', () => {
  it('converts ies to y', () => {
    expect(singularize('Directories')).toBe('Directory');
    expect(singularize('Policies')).toBe('Policy');
  });
  it('strips trailing s for words >4 chars', () => {
    expect(singularize('Organizations')).toBe('Organization');
    expect(singularize('Users')).toBe('User');
  });
  it('does not singularize safe-listed words', () => {
    expect(singularize('Status')).toBe('Status');
    expect(singularize('Address')).toBe('Address');
    expect(singularize('Access')).toBe('Access');
    expect(singularize('Process')).toBe('Process');
    expect(singularize('Progress')).toBe('Progress');
    expect(singularize('Success')).toBe('Success');
  });
  it('does not strip s from short words', () => {
    expect(singularize('Bus')).toBe('Bus');
    expect(singularize('Gas')).toBe('Gas');
  });
  it('does not strip ss endings', () => {
    expect(singularize('Class')).toBe('Class');
  });
});

describe('cleanSchemaName', () => {
  it('applies all transforms: prefix + suffix + markers + singularize', () => {
    expect(cleanSchemaName('DirectoriesControllerListItemState')).toBe('DirectoryState');
  });
  it('preserves Dto and singularizes', () => {
    expect(cleanSchemaName('OrganizationsDto')).toBe('OrganizationDto');
  });
  it('is idempotent', () => {
    const first = cleanSchemaName('DirectoriesControllerListItemState');
    expect(cleanSchemaName(first)).toBe(first);
  });
  it('preserves safe-listed words with Dto', () => {
    expect(cleanSchemaName('StatusDto')).toBe('StatusDto');
  });
  it('handles already clean names', () => {
    expect(cleanSchemaName('Organization')).toBe('Organization');
    expect(cleanSchemaName('User')).toBe('User');
  });
  it('strips Userland prefix', () => {
    expect(cleanSchemaName('UserlandConnection')).toBe('Connection');
  });
});

describe('toUpperSnakeCase', () => {
  it('converts lowercase', () => {
    expect(toUpperSnakeCase('active')).toBe('ACTIVE');
  });
  it('converts camelCase', () => {
    expect(toUpperSnakeCase('inProgress')).toBe('IN_PROGRESS');
  });
  it('converts PascalCase', () => {
    expect(toUpperSnakeCase('UserProfile')).toBe('USER_PROFILE');
  });
});

describe('acronym customization', () => {
  it('toPascalCase expands user_id with custom ID acronym', () => {
    expect(toPascalCase('user_id', new Set(['ID']))).toBe('UserID');
  });

  it('toCamelCase expands user_id with custom ID acronym', () => {
    expect(toCamelCase('user_id', new Set(['ID']))).toBe('userID');
  });

  it('toPascalCase expands http_url with multiple custom acronyms', () => {
    expect(toPascalCase('http_url', new Set(['HTTP', 'URL']))).toBe('HTTPURL');
  });

  it('toPascalCase default behavior unchanged when no acronyms param', () => {
    expect(toPascalCase('user_id')).toBe('UserId');
  });

  it('ACRONYM_SET is exported and contains expected values', () => {
    expect(ACRONYM_SET).toBeInstanceOf(Set);
    expect(ACRONYM_SET.has('SSO')).toBe(true);
    expect(ACRONYM_SET.has('FGA')).toBe(true);
    expect(ACRONYM_SET.has('SAML')).toBe(true);
  });
});
