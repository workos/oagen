import { describe, it, expect } from 'vitest';
import { toPascalCase, toCamelCase, toSnakeCase, toKebabCase, toUpperSnakeCase } from '../../src/utils/naming.js';

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
    expect(toPascalCase('oauth2_token')).toBe('Oauth2Token');
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
    expect(toSnakeCase('OAuth2Token')).toBe('o_auth_2_token');
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
