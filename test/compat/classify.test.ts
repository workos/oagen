import { describe, it, expect } from 'vitest';
import { classifySymbolChanges, classifyAddedSymbol, summarizeChanges } from '../../src/compat/classify.js';
import type { CompatSymbol } from '../../src/compat/ir.js';
import { getDefaultPolicy } from '../../src/compat/policy.js';

function makeSymbol(overrides: Partial<CompatSymbol> & { fqName: string }): CompatSymbol {
  const { fqName, ...rest } = overrides;
  return {
    id: rest.id ?? `test:${fqName}`,
    kind: rest.kind ?? 'callable',
    fqName,
    displayName: rest.displayName ?? fqName,
    visibility: 'public',
    stability: 'stable',
    sourceKind: 'generated_service_wrapper',
    ...rest,
  };
}

describe('classifySymbolChanges', () => {
  describe('symbol removal', () => {
    it('classifies a removed symbol as breaking', () => {
      const baseline = makeSymbol({ fqName: 'UserManagement.createUser' });
      const changes = classifySymbolChanges(baseline, undefined, getDefaultPolicy('php'));
      expect(changes).toHaveLength(1);
      expect(changes[0].category).toBe('symbol_removed');
      expect(changes[0].severity).toBe('breaking');
    });
  });

  describe('staticness changes', () => {
    it('classifies a static ↔ instance flip as breaking when both sides record it', () => {
      const baseline = makeSymbol({ fqName: 'Sso.authorizationUrl', isStatic: true });
      const candidate = makeSymbol({ fqName: 'Sso.authorizationUrl', isStatic: false });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('ios'));
      expect(changes).toHaveLength(1);
      expect(changes[0].category).toBe('staticness_changed');
      expect(changes[0].severity).toBe('breaking');
    });

    it('emits nothing when staticness is unchanged', () => {
      const baseline = makeSymbol({ fqName: 'Sso.authorizationUrl', isStatic: true });
      const candidate = makeSymbol({ fqName: 'Sso.authorizationUrl', isStatic: true });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('ios'));
      expect(changes).toHaveLength(0);
    });

    it('ignores staticness when either snapshot does not record it', () => {
      // Older snapshots and extractors that don't capture staticness leave
      // the field absent — comparing absent vs defined must never diff.
      const withField = makeSymbol({ fqName: 'Sso.authorizationUrl', isStatic: true });
      const withoutField = makeSymbol({ fqName: 'Sso.authorizationUrl' });
      expect(classifySymbolChanges(withoutField, withField, getDefaultPolicy('ios'))).toHaveLength(0);
      expect(classifySymbolChanges(withField, withoutField, getDefaultPolicy('ios'))).toHaveLength(0);
    });
  });

  describe('parameter changes', () => {
    it('classifies parameter removal as breaking', () => {
      const baseline = makeSymbol({
        fqName: 'Authorization.check',
        parameters: [
          {
            publicName: 'resourceId',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Authorization.check',
        parameters: [],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('php'));
      expect(changes.some((c) => c.category === 'parameter_removed')).toBe(true);
    });

    it('classifies parameter rename as breaking in PHP (named args)', () => {
      const baseline = makeSymbol({
        fqName: 'Authorization.check',
        parameters: [
          {
            publicName: 'resourceId',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Authorization.check',
        parameters: [
          {
            publicName: 'resourceTarget',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('php'));
      const rename = changes.find((c) => c.category === 'parameter_renamed');
      expect(rename).toBeDefined();
      expect(rename!.severity).toBe('breaking');
    });

    it('classifies parameter rename as soft-risk in Go (no named args)', () => {
      const baseline = makeSymbol({
        fqName: 'Authorization.Check',
        parameters: [
          {
            publicName: 'resourceId',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Authorization.Check',
        parameters: [
          {
            publicName: 'resourceTarget',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('go'));
      const rename = changes.find((c) => c.category === 'parameter_renamed');
      expect(rename).toBeDefined();
      expect(rename!.severity).toBe('soft-risk');
    });

    it('classifies requiredness increase as breaking', () => {
      const baseline = makeSymbol({
        fqName: 'Auth.verify',
        parameters: [
          {
            publicName: 'code',
            position: 0,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Auth.verify',
        parameters: [
          {
            publicName: 'code',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('php'));
      expect(changes.some((c) => c.category === 'parameter_requiredness_increased')).toBe(true);
    });

    it('classifies position change as breaking in PHP (order-sensitive)', () => {
      const baseline = makeSymbol({
        kind: 'constructor',
        fqName: 'CreateUser.constructor',
        parameters: [
          {
            publicName: 'email',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
          {
            publicName: 'firstName',
            position: 1,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        kind: 'constructor',
        fqName: 'CreateUser.constructor',
        parameters: [
          {
            publicName: 'firstName',
            position: 0,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
          {
            publicName: 'email',
            position: 1,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('php'));
      const posChange = changes.find((c) => c.category === 'constructor_position_changed_order_sensitive');
      expect(posChange).toBeDefined();
      expect(posChange!.severity).toBe('breaking');
    });

    it('classifies constructor reorder as soft-risk in Kotlin (named-friendly)', () => {
      const baseline = makeSymbol({
        kind: 'constructor',
        fqName: 'CreateUser.constructor',
        parameters: [
          {
            publicName: 'email',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'String' },
            sensitivity: { order: false, publicName: true, requiredness: true, type: true },
          },
          {
            publicName: 'firstName',
            position: 1,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'String' },
            sensitivity: { order: false, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        kind: 'constructor',
        fqName: 'CreateUser.constructor',
        parameters: [
          {
            publicName: 'firstName',
            position: 0,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'named',
            type: { name: 'String' },
            sensitivity: { order: false, publicName: true, requiredness: true, type: true },
          },
          {
            publicName: 'email',
            position: 1,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'named',
            type: { name: 'String' },
            sensitivity: { order: false, publicName: true, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('kotlin'));
      const reorder = changes.find((c) => c.category === 'constructor_reordered_named_friendly');
      expect(reorder).toBeDefined();
      expect(reorder!.severity).toBe('soft-risk');
    });

    it('classifies optional terminal parameter addition as additive', () => {
      const baseline = makeSymbol({
        fqName: 'Svc.doIt',
        parameters: [
          {
            publicName: 'x',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      });
      const candidate = makeSymbol({
        fqName: 'Svc.doIt',
        parameters: [
          {
            publicName: 'x',
            position: 0,
            required: true,
            nullable: false,
            hasDefault: false,
            passing: 'positional',
            type: { name: 'string' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
          {
            publicName: 'opts',
            position: 1,
            required: false,
            nullable: false,
            hasDefault: true,
            passing: 'positional',
            type: { name: 'Options' },
            sensitivity: { order: true, publicName: false, requiredness: true, type: true },
          },
        ],
      });
      const changes = classifySymbolChanges(baseline, candidate, getDefaultPolicy('go'));
      const added = changes.find((c) => c.category === 'parameter_added_optional_terminal');
      expect(added).toBeDefined();
      expect(added!.severity).toBe('additive');
    });
  });
});

describe('classifyAddedSymbol', () => {
  it('returns an additive change', () => {
    const sym = makeSymbol({ fqName: 'NewService.newMethod' });
    const change = classifyAddedSymbol(sym);
    expect(change.category).toBe('symbol_added');
    expect(change.severity).toBe('additive');
  });
});

describe('Python type-form normalization', () => {
  // Emitters evolve Python annotation style across releases (PEP 604 `X | None`,
  // PEP 585 lowercase generics, unquoted forward refs). These are cosmetic and
  // must not register as breaking type changes.
  const py = getDefaultPolicy('python');

  it('treats Optional[X] and X | None as equivalent', () => {
    const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Optional[str]' } });
    const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'str | None' } });
    expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
  });

  it('treats quoted and unquoted forward refs as equivalent', () => {
    const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: '"Foo"' } });
    const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Foo' } });
    expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
  });

  it('treats Union[A, B] and A | B as equivalent', () => {
    const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Union[A, B]' } });
    const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'A | B' } });
    expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
  });

  it('treats List[str] and list[str] as equivalent (PEP 585)', () => {
    const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'List[str]' } });
    const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'list[str]' } });
    expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
  });

  it('treats Optional[List[str]] and list[str] | None as equivalent (nested)', () => {
    const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Optional[List[str]]' } });
    const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'list[str] | None' } });
    expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
  });

  it('treats Union[A, B,] (trailing comma) and (A | B) (parenthesized) as equivalent', () => {
    const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Union[\n  A,\n  B,\n]' } });
    const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: '(\n  A\n  | B\n)' } });
    expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
  });

  it('still flags a real optionality change (str -> str | None)', () => {
    const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'str' } });
    const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'str | None' } });
    const changes = classifySymbolChanges(baseline, candidate, py, 'python');
    expect(changes).toHaveLength(1);
    expect(changes[0].category).toBe('field_type_changed');
  });

  it('does not normalize when language is absent (older snapshots)', () => {
    const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Optional[str]' } });
    const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'str | None' } });
    expect(classifySymbolChanges(baseline, candidate, py)).toHaveLength(1);
  });

  it('does not normalize for non-Python languages', () => {
    const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Optional[str]' } });
    const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'str | None' } });
    expect(classifySymbolChanges(baseline, candidate, getDefaultPolicy('ruby'), 'ruby')).toHaveLength(1);
  });

  describe('Literal value preservation', () => {
    it('treats Literal["x"] and Literal["x"] as equivalent', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["event"]' } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["event"]' } });
      expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
    });

    it('treats Literal["a", "b"] and Literal["a","b"] as equivalent (spacing only)', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a", "b"]' } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a","b"]' } });
      expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
    });

    it('preserves inner whitespace so Literal["a b"] and Literal["a  b"] are NOT equal', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a b"]' } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a  b"]' } });
      const changes = classifySymbolChanges(baseline, candidate, py, 'python');
      expect(changes).toHaveLength(1);
      expect(changes[0].category).toBe('field_type_changed');
    });

    it('preserves quotes so Literal["a"] and Literal[a] are NOT equal', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a"]' } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal[a]' } });
      const changes = classifySymbolChanges(baseline, candidate, py, 'python');
      expect(changes).toHaveLength(1);
      expect(changes[0].category).toBe('field_type_changed');
    });

    it('flags a real literal value change ("a" -> "b")', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a"]' } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["b"]' } });
      const changes = classifySymbolChanges(baseline, candidate, py, 'python');
      expect(changes).toHaveLength(1);
      expect(changes[0].category).toBe('field_type_changed');
    });

    it('does not split on a comma inside a string literal', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a,b"]' } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a,b"]' } });
      expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
    });

    it('normalizes Literal inside a union: Union[Literal["x"], "Foo"] ≡ Literal["x"] | Foo', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Union[Literal["x"], "Foo"]' } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["x"] | Foo' } });
      expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
    });

    it('treats single- and double-quoted Literal values as equivalent', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: "Literal['event']" } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["event"]' } });
      expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
    });

    it('treats mixed quote styles across multiple Literal args as equivalent', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: "Literal['a', 'b']" } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a", "b"]' } });
      expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
    });

    it('still flags a real value change across quote styles (\'a\' -> "b")', () => {
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: "Literal['a']" } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["b"]' } });
      const changes = classifySymbolChanges(baseline, candidate, py, 'python');
      expect(changes).toHaveLength(1);
      expect(changes[0].category).toBe('field_type_changed');
    });

    it('treats an embedded double quote across quote styles as equivalent', () => {
      // Literal['say "hi"'] (single-quoted, unescaped inner ") ≡ Literal["say \"hi\""] (double-quoted, escaped)
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal[\'say "hi"\']' } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["say \\\"hi\\\""]' } });
      expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
    });

    it('treats an embedded single quote across quote styles as equivalent', () => {
      // Literal["it's"] (double-quoted, unescaped ') ≡ Literal['it\'s'] (single-quoted, escaped)
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["it\'s"]' } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: "Literal['it\\'s']" } });
      expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
    });

    it('treats a backslash escape across quote styles as equivalent', () => {
      // Literal['a\\b'] ≡ Literal["a\\b"] (both decode to a\b)
      const baseline = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: "Literal['a\\\\b']" } });
      const candidate = makeSymbol({ fqName: 'M.f', kind: 'field', typeRef: { name: 'Literal["a\\\\b"]' } });
      expect(classifySymbolChanges(baseline, candidate, py, 'python')).toHaveLength(0);
    });
  });
});

describe('summarizeChanges', () => {
  it('counts by severity', () => {
    const changes = [
      { severity: 'breaking' as const },
      { severity: 'breaking' as const },
      { severity: 'soft-risk' as const },
      { severity: 'additive' as const },
      { severity: 'additive' as const },
      { severity: 'additive' as const },
    ];
    const summary = summarizeChanges(changes as any);
    expect(summary).toEqual({ breaking: 2, softRisk: 1, additive: 3 });
  });
});
