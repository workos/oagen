import { describe, it, expect } from 'vitest';
import { diffSpecs } from '../../src/differ/diff.js';
import { documentTypes, sameShape } from '../../src/differ/shapes.js';
import type { ApiSpec, Enum, Operation } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

/**
 * Issue #351: `Enum.description` is documentation, not shape. A change to it
 * is not reported — no change carries a flag for it — the same as a changed
 * model, field, operation or request body description, so it is never
 * breaking; and two enums that differ only in it are one shape to the body
 * comparison that reads an enum ref through to its values.
 */

const petStatus: Enum = {
  name: 'PetStatus',
  description: 'Whether the pet can be bought.',
  values: [
    { name: 'AVAILABLE', value: 'available' },
    { name: 'SOLD', value: 'sold' },
  ],
};

const getPetStatus: Operation = {
  name: 'getPetStatus',
  httpMethod: 'get',
  path: '/pets/{id}/status',
  pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
  queryParams: [{ name: 'status', type: { kind: 'enum', name: 'PetStatus' }, required: false }],
  headerParams: [],
  response: { kind: 'enum', name: 'PetStatus' },
  errors: [],
  injectIdempotencyKey: false,
};

function spec(enums: Enum[]): ApiSpec {
  return {
    name: 'Pets',
    version: '1',
    baseUrl: '',
    services: [{ name: 'Pets', operations: [getPetStatus] }],
    models: [],
    enums,
    sdk: defaultSdkBehavior(),
  };
}

const quiet = { added: 0, removed: 0, modified: 0, breaking: 0, additive: 0, behaviorChanges: 0 };

describe('diff — enum descriptions (issue #351)', () => {
  it('reports nothing for an enum whose only change is its description', () => {
    const report = diffSpecs(spec([petStatus]), spec([{ ...petStatus, description: 'Whether it can be bought.' }]));
    expect(report.changes).toEqual([]);
    expect(report.behaviorChanges).toEqual([]);
    expect(report.summary).toEqual(quiet);
  });

  it('reports nothing for a description appearing or disappearing', () => {
    const { description: _text, ...bare } = petStatus;
    expect(diffSpecs(spec([bare]), spec([petStatus])).changes).toEqual([]);
    expect(diffSpecs(spec([petStatus]), spec([bare])).changes).toEqual([]);
  });

  it('still reports a value change beside a description change, with the text playing no part', () => {
    const narrowed: Enum = {
      ...petStatus,
      description: 'Whether it can be bought.',
      values: [{ name: 'AVAILABLE', value: 'available' }],
    };
    const report = diffSpecs(spec([petStatus]), spec([narrowed]));
    expect(report.changes).toEqual([
      {
        kind: 'enum-modified',
        name: 'PetStatus',
        valueChanges: [{ kind: 'value-removed', valueName: 'SOLD', classification: 'breaking' }],
        deprecatedChanged: false,
        classification: 'breaking',
      },
    ]);
    expect(JSON.stringify(report.changes)).not.toContain('bought');
  });

  it('two enums that differ only in description are one shape to the body comparison', () => {
    const shapes = {
      old: documentTypes(spec([petStatus])),
      new: documentTypes(spec([{ ...petStatus, name: 'Status', description: 'Whether it can be bought.' }])),
    };
    expect(sameShape({ kind: 'enum', name: 'PetStatus' }, { kind: 'enum', name: 'Status' }, shapes)).toBe(true);
  });
});
