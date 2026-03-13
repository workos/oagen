import { describe, it, expect } from 'vitest';
import { normalizePath } from '../../scripts/smoke/diff.js';

describe('normalizePath', () => {
  it('normalizes WorkOS ULIDs', () => {
    expect(normalizePath('/organizations/org_01HZDS4ZR2X1A2B3C4D5E6F7G8')).toMatchInlineSnapshot(
      `"/organizations/<ID>"`,
    );
  });

  it('normalizes UUIDs', () => {
    expect(normalizePath('/users/550e8400-e29b-41d4-a716-446655440000')).toMatchInlineSnapshot(`"/users/<ID>"`);
  });

  it('normalizes uppercase UUIDs', () => {
    expect(normalizePath('/users/550E8400-E29B-41D4-A716-446655440000')).toMatchInlineSnapshot(`"/users/<ID>"`);
  });

  it('normalizes numeric IDs (4+ digits)', () => {
    expect(normalizePath('/users/12345')).toMatchInlineSnapshot(`"/users/<ID>"`);
  });

  it('does not normalize short numbers', () => {
    expect(normalizePath('/v1/users')).toMatchInlineSnapshot(`"/v1/users"`);
  });

  it('normalizes multiple IDs in one path', () => {
    expect(
      normalizePath('/organizations/org_01HZDS4ZR2X1A2B3C4D5E6F7G8/connections/conn_01HZDS4ZR2X1A2B3C4D5E6F7G8'),
    ).toMatchInlineSnapshot(`"/organizations/<ID>/connections/<ID>"`);
  });

  it('handles paths with no IDs', () => {
    expect(normalizePath('/organizations')).toMatchInlineSnapshot(`"/organizations"`);
  });
});
