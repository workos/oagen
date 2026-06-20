import { describe, expect, it } from 'vitest';
import { resolveScopedServices } from '../../src/engine/scoped-services.js';
import type { ApiSpec, Service, Operation, HttpMethod } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

function op(httpMethod: HttpMethod, path: string): Operation {
  return {
    name: '',
    httpMethod,
    path,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'unknown' },
    errors: [],
    injectIdempotencyKey: false,
  };
}

function svc(name: string): Service {
  return { name, operations: [op('get', `/${name.toLowerCase()}`)] };
}

function spec(serviceNames: string[]): ApiSpec {
  return {
    name: 'TestApi',
    version: '1.0.0',
    baseUrl: 'https://api.test.com',
    services: serviceNames.map(svc),
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

const MOUNTS = { DirectoryUsers: 'DirectorySync', DirectoryGroups: 'DirectorySync' };

describe('resolveScopedServices', () => {
  it('returns the selection as a set for an unmounted service', () => {
    const out = resolveScopedServices(spec(['Vault', 'Sso']), ['Vault']);
    expect(out).toEqual(new Set(['Vault']));
  });

  it('accepts a post-mount target name that multiple source tags mount into', () => {
    // DirectoryUsers + DirectoryGroups both post-mount to DirectorySync, so
    // DirectorySync is a valid selection even though no service is literally named it.
    const out = resolveScopedServices(spec(['DirectoryUsers', 'DirectoryGroups', 'Vault']), ['DirectorySync'], MOUNTS);
    expect(out).toEqual(new Set(['DirectorySync']));
  });

  it('rejects a source tag name that has been mounted elsewhere (must use post-mount)', () => {
    expect(() =>
      resolveScopedServices(spec(['DirectoryUsers', 'DirectoryGroups']), ['DirectoryUsers'], MOUNTS),
    ).toThrow(/Unknown --services/);
  });

  it('keeps an unmounted service selectable by its own name alongside mount rules', () => {
    const out = resolveScopedServices(spec(['DirectoryUsers', 'Vault']), ['Vault'], MOUNTS);
    expect(out).toEqual(new Set(['Vault']));
  });

  it('throws a ConfigError listing valid post-mount names for an unknown service', () => {
    let caught: Error | undefined;
    try {
      resolveScopedServices(spec(['DirectoryUsers', 'DirectoryGroups', 'Vault']), ['Nope'], MOUNTS);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.name).toBe('ConfigError');
    // Valid list is post-mount names, deduped + sorted: source tags are masked.
    expect(caught!.message).toContain('DirectorySync');
    expect(caught!.message).toContain('Vault');
    expect(caught!.message).not.toContain('DirectoryUsers');
  });

  it('reports every unknown selection, not just the first', () => {
    expect(() => resolveScopedServices(spec(['Vault']), ['Nope', 'AlsoNope'])).toThrow(/AlsoNope, Nope/);
  });

  it('does not mutate the input spec', () => {
    const input = spec(['Vault', 'Sso']);
    resolveScopedServices(input, ['Vault']);
    expect(input.services.map((s) => s.name)).toEqual(['Vault', 'Sso']);
  });
});
