import { describe, it, expect } from 'vitest';

// Since validate.ts runs as a script with main() at module level,
// we test the key logic functions by extracting them inline.
// The pathMatchesTemplate function is the core logic worth unit testing.

/** Check if a concrete path matches a template like /orgs/{id}/members */
function pathMatchesTemplate(concretePath: string, template: string): boolean {
  const concreteSegments = concretePath.split('/').filter(Boolean);
  const templateSegments = template.split('/').filter(Boolean);

  if (concreteSegments.length !== templateSegments.length) return false;

  return templateSegments.every((seg, i) => {
    if (seg.startsWith('{') && seg.endsWith('}')) return true;
    return seg === concreteSegments[i];
  });
}

describe('pathMatchesTemplate', () => {
  it('matches exact paths', () => {
    expect(pathMatchesTemplate('/organizations', '/organizations')).toBe(true);
  });

  it('matches paths with template params', () => {
    expect(pathMatchesTemplate('/organizations/org_123', '/organizations/{id}')).toBe(true);
  });

  it('matches nested template paths', () => {
    expect(
      pathMatchesTemplate('/organizations/org_123/connections/conn_456', '/organizations/{id}/connections/{connId}'),
    ).toBe(true);
  });

  it('rejects paths with different segment counts', () => {
    expect(pathMatchesTemplate('/organizations/org_123/extra', '/organizations/{id}')).toBe(false);
  });

  it('rejects paths with different static segments', () => {
    expect(pathMatchesTemplate('/users/123', '/organizations/{id}')).toBe(false);
  });
});
