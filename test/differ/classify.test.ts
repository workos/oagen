import { describe, it, expect } from 'vitest';
import { classifyFieldChange, classifyParamChange, requestBodyRequiredCompared } from '../../src/differ/classify.js';
import type { TypeRef } from '../../src/ir/types.js';

describe('classifyFieldChange', () => {
  it('field-added optional is additive', () => {
    expect(classifyFieldChange('field-added', 'avatar', false)).toMatchObject({
      classification: 'additive',
    });
  });

  it('field-added required is breaking', () => {
    expect(classifyFieldChange('field-added', 'role', true)).toMatchObject({
      classification: 'breaking',
    });
  });

  it('field-added required on a response-only model is additive', () => {
    const result = classifyFieldChange('field-added', 'config', true, 'response');
    expect(result.classification).toBe('additive');
    expect(result.details).toBe('required on a response-only model');
  });

  it('field-added required stays breaking on request-facing and both-facing models', () => {
    expect(classifyFieldChange('field-added', 'config', true, 'request').classification).toBe('breaking');
    expect(classifyFieldChange('field-added', 'config', true, 'both').classification).toBe('breaking');
    expect(classifyFieldChange('field-added', 'config', true, 'unknown').classification).toBe('breaking');
  });

  it('field-added optional is additive regardless of direction', () => {
    for (const direction of ['request', 'response', 'both', 'unknown'] as const) {
      expect(classifyFieldChange('field-added', 'config', false, direction).classification).toBe('additive');
    }
  });

  it('field-removed is always breaking', () => {
    expect(classifyFieldChange('field-removed', 'email')).toMatchObject({
      classification: 'breaking',
    });
  });

  it('field-type-changed is always breaking', () => {
    expect(classifyFieldChange('field-type-changed', 'name')).toMatchObject({
      classification: 'breaking',
    });
  });

  it('field-access-changed is always breaking', () => {
    expect(classifyFieldChange('field-access-changed', 'email')).toMatchObject({
      classification: 'breaking',
    });
  });

  it('field-required-changed optional→required is breaking', () => {
    const result = classifyFieldChange('field-required-changed', 'age', true);
    expect(result.classification).toBe('breaking');
    expect(result.details).toBe('optional → required');
  });

  it('field-required-changed required→optional is additive', () => {
    const result = classifyFieldChange('field-required-changed', 'age', false);
    expect(result.classification).toBe('additive');
    expect(result.details).toBe('required → optional');
  });
});

describe('classifyParamChange', () => {
  it('param-added optional is additive', () => {
    expect(classifyParamChange('param-added', 'filter', false)).toMatchObject({
      classification: 'additive',
    });
  });

  it('param-added required is breaking', () => {
    expect(classifyParamChange('param-added', 'org_id', true)).toMatchObject({
      classification: 'breaking',
    });
  });

  it('param-removed is always breaking', () => {
    expect(classifyParamChange('param-removed', 'limit')).toMatchObject({
      classification: 'breaking',
    });
  });

  it('param-type-changed is always breaking', () => {
    expect(classifyParamChange('param-type-changed', 'limit')).toMatchObject({
      classification: 'breaking',
    });
  });

  it('param-required-changed to required is breaking', () => {
    expect(classifyParamChange('param-required-changed', 'filter', true)).toMatchObject({
      classification: 'breaking',
    });
  });

  it('param-required-changed to optional is additive', () => {
    expect(classifyParamChange('param-required-changed', 'filter', false)).toMatchObject({
      classification: 'additive',
    });
  });
});

describe('requestBodyRequiredCompared (#528)', () => {
  const pet: TypeRef = { kind: 'model', name: 'Pet' };
  /** A body read as `requestBody`, as the parser builds one under `application/json`. */
  const read = { requestBody: pet, requestBodyContentTypes: ['application/json'] };
  /** A body carried in `requestBodyContents` alone, as the parser builds one under `application/xml`. */
  const carried = { requestBodyContentTypes: ['application/xml'] };
  /** A hand-built IR body with no media-type list. */
  const bare = { requestBody: pet };
  const none = {};

  it('compares the flag while both sides carry a body, read as requestBody or carried in its contents alone', () => {
    expect(requestBodyRequiredCompared(read, read)).toBe(true);
    expect(requestBodyRequiredCompared(carried, carried)).toBe(true);
    expect(requestBodyRequiredCompared(bare, bare)).toBe(true);
    // Whichever way each side is read.
    expect(requestBodyRequiredCompared(carried, read)).toBe(true);
    expect(requestBodyRequiredCompared(read, carried)).toBe(true);
    expect(requestBodyRequiredCompared(bare, carried)).toBe(true);
  });

  it('does not while either side carries none: the flag goes with the body', () => {
    expect(requestBodyRequiredCompared(none, read)).toBe(false);
    expect(requestBodyRequiredCompared(read, none)).toBe(false);
    expect(requestBodyRequiredCompared(none, carried)).toBe(false);
    expect(requestBodyRequiredCompared(carried, none)).toBe(false);
    expect(requestBodyRequiredCompared(none, none)).toBe(false);
  });
});
