import { describe, expect, it } from 'vitest';
import { filterSpecByServices } from '../../src/engine/filter-services.js';
import type { ApiSpec, Service, Operation, Model, HttpMethod, TypeRef } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function op(httpMethod: HttpMethod, path: string, response: TypeRef): Operation {
  return {
    name: '',
    httpMethod,
    path,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response,
    errors: [],
    injectIdempotencyKey: false,
  };
}

function svc(name: string, ops: Operation[]): Service {
  return { name, operations: ops };
}

function model(name: string, fields: Model['fields']): Model {
  return { name, fields };
}

const modelRef = (name: string): TypeRef => ({ kind: 'model', name });

/**
 * Fixture: ServiceA and ServiceB each reference the shared model `Shared`.
 * DirectoryUsers and DirectoryGroups both mount into `DirectorySync`.
 */
function fixture(): ApiSpec {
  return {
    name: 'TestApi',
    version: '1.0.0',
    baseUrl: 'https://api.test.com',
    services: [
      svc('ServiceA', [op('get', '/a', modelRef('AResp'))]),
      svc('ServiceB', [op('get', '/b', modelRef('BResp'))]),
      svc('DirectoryUsers', [op('get', '/directory_users', modelRef('DirectoryUser'))]),
      svc('DirectoryGroups', [op('get', '/directory_groups', modelRef('DirectoryGroup'))]),
    ],
    models: [
      model('AResp', [{ name: 'shared', type: modelRef('Shared'), required: true }]),
      model('BResp', [{ name: 'shared', type: modelRef('Shared'), required: true }]),
      model('Shared', [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }]),
      model('DirectoryUser', [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }]),
      model('DirectoryGroup', [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }]),
    ],
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

const names = (services: Service[]): string[] => services.map((s) => s.name).sort();
const modelNames = (models: Model[]): string[] => models.map((m) => m.name).sort();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('filterSpecByServices', () => {
  it('keeps only the selected single-tag service', () => {
    const out = filterSpecByServices(fixture(), ['ServiceA']);
    expect(names(out.services)).toEqual(['ServiceA']);
  });

  it('retains a model shared with an excluded service', () => {
    const out = filterSpecByServices(fixture(), ['ServiceA']);
    // AResp (direct) + Shared (transitively reachable) kept; B/Directory models dropped.
    expect(modelNames(out.models)).toEqual(['AResp', 'Shared']);
    expect(out.models.some((m) => m.name === 'BResp')).toBe(false);
  });

  it('expands a post-mount service to all its mount-sibling source services', () => {
    // The filter keeps every source service that mounts into the selected target.
    // Merging those siblings into a single post-mount resource FILE (grouped by
    // `ctx.resolvedOperations[].mountOn`) is the out-of-repo emitter's job and is
    // verified by emitter snapshots, not here — this test only asserts the
    // service-level set the emitter receives.
    const mountRules = { DirectoryUsers: 'DirectorySync', DirectoryGroups: 'DirectorySync' };
    const out = filterSpecByServices(fixture(), ['DirectorySync'], mountRules);
    expect(names(out.services)).toEqual(['DirectoryGroups', 'DirectoryUsers']);
    expect(modelNames(out.models)).toEqual(['DirectoryGroup', 'DirectoryUser']);
  });

  it('matches on the post-mount name, not the source tag name', () => {
    const mountRules = { DirectoryUsers: 'DirectorySync', DirectoryGroups: 'DirectorySync' };
    // Selecting a source tag that has been mounted elsewhere must NOT match —
    // the scoping unit is the post-mount service.
    expect(() => filterSpecByServices(fixture(), ['DirectoryUsers'], mountRules)).toThrow(/No services matched/);
  });

  it('keeps an unmounted service selectable by its own name', () => {
    const mountRules = { DirectoryUsers: 'DirectorySync', DirectoryGroups: 'DirectorySync' };
    const out = filterSpecByServices(fixture(), ['ServiceB'], mountRules);
    expect(names(out.services)).toEqual(['ServiceB']);
  });

  it('throws a ConfigError listing valid post-mount names for an unknown service', () => {
    const mountRules = { DirectoryUsers: 'DirectorySync', DirectoryGroups: 'DirectorySync' };
    let caught: Error | undefined;
    try {
      filterSpecByServices(fixture(), ['Nonexistent'], mountRules);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.name).toBe('ConfigError');
    // Valid list is post-mount names, deduped + sorted: source tags are masked.
    expect(caught!.message).toContain('DirectorySync');
    expect(caught!.message).toContain('ServiceA');
    expect(caught!.message).toContain('ServiceB');
    expect(caught!.message).not.toContain('DirectoryUsers');
  });

  it('does not mutate the input spec', () => {
    const input = fixture();
    const before = input.services.length;
    filterSpecByServices(input, ['ServiceA']);
    expect(input.services.length).toBe(before);
  });
});
