import type { FieldChange, ParamChange } from './types.js';

export function classifyFieldChange(kind: FieldChange['kind'], fieldName: string, isRequired?: boolean): FieldChange {
  switch (kind) {
    case 'field-added':
      return {
        kind,
        fieldName,
        classification: isRequired ? 'breaking' : 'additive',
      };
    case 'field-removed':
      return { kind, fieldName, classification: 'breaking' };
    case 'field-type-changed':
      return { kind, fieldName, classification: 'breaking' };
    case 'field-required-changed':
      return {
        kind,
        fieldName,
        classification: isRequired ? 'breaking' : 'additive',
        details: isRequired ? 'optional → required' : 'required → optional',
      };
  }
}

export function classifyParamChange(kind: ParamChange['kind'], paramName: string, isRequired?: boolean): ParamChange {
  switch (kind) {
    case 'param-added':
      return {
        kind,
        paramName,
        classification: isRequired ? 'breaking' : 'additive',
      };
    case 'param-removed':
      return { kind, paramName, classification: 'breaking' };
    case 'param-type-changed':
      return { kind, paramName, classification: 'breaking' };
    case 'param-required-changed':
      return {
        kind,
        paramName,
        classification: isRequired ? 'breaking' : 'additive',
      };
  }
}
