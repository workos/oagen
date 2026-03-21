import { describe, it, expect } from 'vitest';
import { classifyFieldChange, classifyParamChange } from '../../src/differ/classify.js';

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
