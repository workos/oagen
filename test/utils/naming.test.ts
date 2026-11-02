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
  singularizePathSegment,
  cleanSchemaName,
  numberedName,
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

describe('singularizePathSegment', () => {
  it('drops a trailing s, including on short words', () => {
    expect(singularizePathSegment('pets')).toBe('pet');
    expect(singularizePathSegment('users')).toBe('user');
    expect(singularizePathSegment('keys')).toBe('key');
    expect(singularizePathSegment('ids')).toBe('id');
    expect(singularizePathSegment('organizations')).toBe('organization');
  });

  it('turns -ies into -y, but keeps the ie of a short word', () => {
    expect(singularizePathSegment('directories')).toBe('directory');
    expect(singularizePathSegment('policies')).toBe('policy');
    expect(singularizePathSegment('pies')).toBe('pie');
  });

  it('drops the es added to a sibilant stem', () => {
    expect(singularizePathSegment('addresses')).toBe('address');
    expect(singularizePathSegment('processes')).toBe('process');
    expect(singularizePathSegment('statuses')).toBe('status');
    expect(singularizePathSegment('buses')).toBe('bus');
    expect(singularizePathSegment('boxes')).toBe('box');
    expect(singularizePathSegment('indexes')).toBe('index');
    expect(singularizePathSegment('batches')).toBe('batch');
    expect(singularizePathSegment('branches')).toBe('branch');
    expect(singularizePathSegment('hashes')).toBe('hash');
  });

  it('drops the es of an -ias noun and turns -yses into -ysis (issue #268)', () => {
    expect(singularizePathSegment('aliases')).toBe('alias');
    expect(singularizePathSegment('biases')).toBe('bias');
    expect(singularizePathSegment('email_aliases')).toBe('email_alias');
    expect(singularizePathSegment('analyses')).toBe('analysis');
    expect(singularizePathSegment('paralyses')).toBe('paralysis');
    expect(singularizePathSegment('risk_analyses')).toBe('risk_analysis');
    // -iases only slices, so the segment's own case is kept.
    expect(singularizePathSegment('Aliases')).toBe('Alias');
    expect(singularizePathSegment('ALIASES')).toBe('ALIAS');
    // -yses → -ysis writes two letters; they take the case of the es they replace.
    expect(singularizePathSegment('Analyses')).toBe('Analysis');
    expect(singularizePathSegment('ANALYSES')).toBe('ANALYSIS');
    // The singulars those rules produce are left alone, like `-is`, `-us`
    // and `-ss` words, so stemming is idempotent.
    expect(singularizePathSegment('alias')).toBe('alias');
    expect(singularizePathSegment('bias')).toBe('bias');
    expect(singularizePathSegment('Alias')).toBe('Alias');
    expect(singularizePathSegment('analysis')).toBe('analysis');
  });

  it('documents the plurals and singulars ending in s it deliberately does not handle', () => {
    // `-ases` other than `-iases` reads as an `-ase` noun (`cases`, `releases`).
    expect(singularizePathSegment('canvases')).toBe('canvase');
    // `-es` of an `-is` noun other than `-ysis` reads as an `-e` noun
    // (`premises`, `cheeses`).
    expect(singularizePathSegment('crises')).toBe('crise');
    expect(singularizePathSegment('theses')).toBe('these');
    // A singular ending in `-as` other than `-ias`, or in `-ns`, looks like
    // the plural of an `-a` or `-n` noun (`areas`, `tokens`), so its `s` is
    // dropped, as before.
    expect(singularizePathSegment('canvas')).toBe('canva');
    expect(singularizePathSegment('lens')).toBe('len');
    // The plural of an `-ia` noun is kept, the price of keeping `alias`.
    expect(singularizePathSegment('utopias')).toBe('utopias');
  });

  it('is idempotent on every input above: a singular it produces comes back unchanged', () => {
    const inputs = [
      // the plurals each rule handles
      'pets',
      'users',
      'keys',
      'ids',
      'organizations',
      'directories',
      'policies',
      'pies',
      'addresses',
      'processes',
      'statuses',
      'buses',
      'boxes',
      'indexes',
      'batches',
      'branches',
      'hashes',
      'responses',
      'licenses',
      'releases',
      'cases',
      'warehouses',
      'uses',
      'archives',
      'aliases',
      'biases',
      'email_aliases',
      'analyses',
      'paralyses',
      'risk_analyses',
      'api_keys',
      'auth-factors',
      'email_addresses',
      'authFactors',
      'Directories',
      'DIRECTORIES',
      'PIES',
      'ADDRESSES',
      'Addresses',
      'STATUSES',
      'Statuses',
      'BOXES',
      'Boxes',
      'BATCHES',
      'Batches',
      'HASHES',
      'Hashes',
      'RESPONSES',
      'Responses',
      'PETS',
      'Pets',
      'API_KEYS',
      'Aliases',
      'ALIASES',
      'Analyses',
      'ANALYSES',
      // what it leaves alone
      'pet',
      'adopt',
      'status',
      'address',
      'access',
      'analysis',
      'radius',
      'alias',
      'bias',
      'Alias',
      'is',
      's',
      '',
      'series',
      'time_series',
      'species',
      'news',
      'STATUS',
      'SERIES',
      // the documented limits
      'people',
      'children',
      'data',
      'menus',
      'apis',
      'canvases',
      'crises',
      'theses',
      'canvas',
      'lens',
      'utopias',
      'cookies',
      'heroes',
      'caches',
      'excuses',
      'sms',
    ];
    for (const input of inputs) {
      const once = singularizePathSegment(input);
      expect(singularizePathSegment(once), `${input} → ${once}`).toBe(once);
    }
  });

  it('drops only the s when the stem itself ends in e', () => {
    expect(singularizePathSegment('responses')).toBe('response');
    expect(singularizePathSegment('licenses')).toBe('license');
    expect(singularizePathSegment('releases')).toBe('release');
    expect(singularizePathSegment('cases')).toBe('case');
    expect(singularizePathSegment('warehouses')).toBe('warehouse');
    expect(singularizePathSegment('uses')).toBe('use');
    expect(singularizePathSegment('archives')).toBe('archive');
  });

  it('leaves alone anything that does not look plural', () => {
    expect(singularizePathSegment('pet')).toBe('pet');
    expect(singularizePathSegment('adopt')).toBe('adopt');
    expect(singularizePathSegment('status')).toBe('status');
    expect(singularizePathSegment('address')).toBe('address');
    expect(singularizePathSegment('access')).toBe('access');
    expect(singularizePathSegment('analysis')).toBe('analysis');
    expect(singularizePathSegment('radius')).toBe('radius');
    expect(singularizePathSegment('is')).toBe('is');
    expect(singularizePathSegment('s')).toBe('s');
    expect(singularizePathSegment('')).toBe('');
  });

  it('keeps invariant plurals', () => {
    expect(singularizePathSegment('series')).toBe('series');
    expect(singularizePathSegment('time_series')).toBe('time_series');
    expect(singularizePathSegment('species')).toBe('species');
    expect(singularizePathSegment('news')).toBe('news');
  });

  it('acts on the trailing word of a compound segment and preserves case', () => {
    expect(singularizePathSegment('api_keys')).toBe('api_key');
    expect(singularizePathSegment('auth-factors')).toBe('auth-factor');
    expect(singularizePathSegment('email_addresses')).toBe('email_address');
    expect(singularizePathSegment('authFactors')).toBe('authFactor');
    expect(singularizePathSegment('Directories')).toBe('Directory');
    expect(singularizePathSegment('STATUSES')).toBe('STATUS');
  });

  it('matches the case of the segment under every rule', () => {
    // -ies → -y is the only rule that writes a letter; the y takes the case of
    // the ies it replaces so an all-caps word stays one word for splitWords.
    expect(singularizePathSegment('DIRECTORIES')).toBe('DIRECTORY');
    expect(singularizePathSegment('directories')).toBe('directory');
    expect(singularizePathSegment('Directories')).toBe('Directory');
    expect(singularizePathSegment('PIES')).toBe('PIE');
    // Every other rule only slices, so the segment's own case is kept.
    expect(singularizePathSegment('ADDRESSES')).toBe('ADDRESS');
    expect(singularizePathSegment('Addresses')).toBe('Address');
    expect(singularizePathSegment('STATUSES')).toBe('STATUS');
    expect(singularizePathSegment('Statuses')).toBe('Status');
    expect(singularizePathSegment('BOXES')).toBe('BOX');
    expect(singularizePathSegment('Boxes')).toBe('Box');
    expect(singularizePathSegment('BATCHES')).toBe('BATCH');
    expect(singularizePathSegment('Batches')).toBe('Batch');
    expect(singularizePathSegment('HASHES')).toBe('HASH');
    expect(singularizePathSegment('Hashes')).toBe('Hash');
    expect(singularizePathSegment('RESPONSES')).toBe('RESPONSE');
    expect(singularizePathSegment('Responses')).toBe('Response');
    expect(singularizePathSegment('PETS')).toBe('PET');
    expect(singularizePathSegment('Pets')).toBe('Pet');
    expect(singularizePathSegment('STATUS')).toBe('STATUS');
    expect(singularizePathSegment('SERIES')).toBe('SERIES');
    expect(singularizePathSegment('API_KEYS')).toBe('API_KEY');
  });

  it('documents the irregular plurals it deliberately does not handle', () => {
    expect(singularizePathSegment('people')).toBe('people');
    expect(singularizePathSegment('children')).toBe('children');
    expect(singularizePathSegment('data')).toBe('data');
    expect(singularizePathSegment('menus')).toBe('menus');
    expect(singularizePathSegment('apis')).toBe('apis');
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

// workos/oagen#403: one spelling for every numbered operation, model and
// enum name, and for the hash a path-derived or webhook stem takes.
describe('numberedName', () => {
  it('appends the bare number to a name that ends in a letter', () => {
    expect(numberedName('list', 2)).toBe('list2');
    expect(numberedName('GetPetKindResponse', 3)).toBe('GetPetKindResponse3');
  });

  it('sets the number off with `No` from a name that ends in a digit', () => {
    expect(numberedName('listV1', 2)).toBe('listV1No2');
    expect(numberedName('PetSizeV2', 2)).toBe('PetSizeV2No2');
    expect(numberedName('GetPetError404', 2)).toBe('GetPetError404No2');
  });

  it('sets a hash off the same way only when it starts with a digit', () => {
    expect(numberedName('PetsTop10', '567B59')).toBe('PetsTop10No567B59');
    expect(numberedName('PetsTop10', 'Ba41B5')).toBe('PetsTop10Ba41B5');
    expect(numberedName('FooBar', '546F12')).toBe('FooBar546F12');
    expect(numberedName('', '567B59')).toBe('567B59');
  });

  it('keeps the boundary through re-casing, where an underscore would not', () => {
    for (const name of [numberedName('PetSizeV2', 2), numberedName('PetsTop10', '567B59')]) {
      expect(toPascalCase(name)).toBe(name);
    }
    expect(toCamelCase(numberedName('listTop10', 2))).toBe('listTop10No2');
    expect(toPascalCase('PetSizeV2_2')).toBe('PetSizeV22');
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
