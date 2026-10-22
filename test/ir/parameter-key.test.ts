import { describe, expect, it } from 'vitest';
import { foldHeaderName, foldParameterName, parameterKey } from '../../src/ir/parameter-key.js';

/**
 * Covers `parameterKey` in isolation: the one rule that says whether two
 * parameters are the same parameter (#295). Header names are
 * case-insensitive (RFC 9110 §5.1); path, query and cookie names are not.
 * The parser's merge of path-item and operation parameters on it is covered
 * in test/parser/header-param-case.test.ts, the differ's pairing on it in
 * test/differ/header-param-case.test.ts.
 */
describe('foldHeaderName', () => {
  it('lower-cases a header name, so every spelling of one header folds to one string', () => {
    expect(foldHeaderName('X-Pet-Token')).toBe('x-pet-token');
    expect(foldHeaderName('x-pet-token')).toBe('x-pet-token');
    expect(foldHeaderName('X-PET-TOKEN')).toBe('x-pet-token');
    expect(foldHeaderName('Idempotency-Key')).toBe('idempotency-key');
  });

  it('leaves a name that is already lower case alone', () => {
    expect(foldHeaderName('etag')).toBe('etag');
  });
});

describe('foldParameterName', () => {
  it('folds a header name', () => {
    expect(foldParameterName('header', 'X-Pet-Token')).toBe('x-pet-token');
  });

  it('keeps a path, query or cookie name as written', () => {
    expect(foldParameterName('path', 'petId')).toBe('petId');
    expect(foldParameterName('query', 'Limit')).toBe('Limit');
    expect(foldParameterName('cookie', 'Session')).toBe('Session');
  });
});

describe('parameterKey', () => {
  it('is the location and the name, so a path `id` and a query `id` are two parameters', () => {
    expect(parameterKey('path', 'id')).toBe('path:id');
    expect(parameterKey('query', 'id')).toBe('query:id');
    expect(parameterKey('path', 'id')).not.toBe(parameterKey('query', 'id'));
  });

  it('gives every spelling of one header the same key', () => {
    expect(parameterKey('header', 'X-Pet-Token')).toBe('header:x-pet-token');
    expect(parameterKey('header', 'x-pet-token')).toBe('header:x-pet-token');
    expect(parameterKey('header', 'X-PET-TOKEN')).toBe('header:x-pet-token');
  });

  it('keeps a header apart from a query or cookie parameter spelled the same', () => {
    expect(parameterKey('header', 'x-pet-token')).not.toBe(parameterKey('query', 'x-pet-token'));
    expect(parameterKey('header', 'session')).not.toBe(parameterKey('cookie', 'session'));
  });

  it('tells two path, query or cookie names that differ in case alone apart', () => {
    expect(parameterKey('path', 'petId')).not.toBe(parameterKey('path', 'petid'));
    expect(parameterKey('query', 'Limit')).not.toBe(parameterKey('query', 'limit'));
    expect(parameterKey('cookie', 'Session')).not.toBe(parameterKey('cookie', 'session'));
  });
});
