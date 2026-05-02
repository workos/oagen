import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '../../src/compat/differ.js';
import { getDefaultPolicy } from '../../src/compat/policy.js';
import type { CompatSnapshot, CompatSymbol } from '../../src/compat/ir.js';

function makeSnapshot(symbols: CompatSymbol[]): CompatSnapshot {
  return {
    schemaVersion: '1',
    source: { extractedAt: '2026-05-02T00:00:00.000Z' },
    policies: getDefaultPolicy('go'),
    symbols,
  };
}

function sym(overrides: Partial<CompatSymbol> & { fqName: string; kind: CompatSymbol['kind'] }): CompatSymbol {
  return {
    id: overrides.id ?? `test:${overrides.fqName}`,
    displayName: overrides.displayName ?? overrides.fqName,
    visibility: 'public',
    stability: 'stable',
    sourceKind: 'generated_resource_constructor',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Type-rename detection
// ---------------------------------------------------------------------------

describe('detectTypeRenames — model type rename detection', () => {
  /**
   * Mirror the workos/openapi-spec#17 ApiKey → OrganizationApiKey case:
   * the old type vanishes and a structurally-equivalent (or superset)
   * new type takes its place. The wire shape returned by the underlying
   * endpoint is identical, so consumer code accessing `.id`, `.value`, etc.
   * keeps working — only explicit type annotations need to migrate.
   */
  it('downgrades a type removal to soft-risk when a structurally-equivalent new type exists', () => {
    const baseline = makeSnapshot([
      sym({ fqName: 'ApiKeyWithValue', kind: 'alias' }),
      sym({
        fqName: 'ApiKeyWithValue.id',
        kind: 'field',
        ownerFqName: 'ApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'ApiKeyWithValue.value',
        kind: 'field',
        ownerFqName: 'ApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'ApiKeyWithValue.created_at',
        kind: 'field',
        ownerFqName: 'ApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'OrganizationApiKeyWithValue', kind: 'alias' }),
      sym({
        fqName: 'OrganizationApiKeyWithValue.id',
        kind: 'field',
        ownerFqName: 'OrganizationApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'OrganizationApiKeyWithValue.value',
        kind: 'field',
        ownerFqName: 'OrganizationApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'OrganizationApiKeyWithValue.created_at',
        kind: 'field',
        ownerFqName: 'OrganizationApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const removal = result.changes.find((c) => c.category === 'symbol_removed' && c.old.symbol === 'ApiKeyWithValue');
    expect(removal, 'parent type removal change should exist').toBeDefined();
    expect(removal!.severity).toBe('soft-risk');
    expect(removal!.remediation).toMatch(/renamed to "OrganizationApiKeyWithValue"/);
    expect(removal!.remediation).toMatch(/superset/);
  });

  it('cascades the downgrade to owned-field removals so they are also soft-risk', () => {
    const baseline = makeSnapshot([
      sym({ fqName: 'ApiKeyWithValue', kind: 'alias' }),
      sym({
        fqName: 'ApiKeyWithValue.value',
        kind: 'field',
        ownerFqName: 'ApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'OrganizationApiKeyWithValue', kind: 'alias' }),
      sym({
        fqName: 'OrganizationApiKeyWithValue.value',
        kind: 'field',
        ownerFqName: 'OrganizationApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const fieldRemoval = result.changes.find(
      (c) => c.category === 'symbol_removed' && c.old.symbol === 'ApiKeyWithValue.value',
    );
    expect(fieldRemoval, 'owned field removal should exist').toBeDefined();
    expect(fieldRemoval!.severity).toBe('soft-risk');
    expect(fieldRemoval!.remediation).toMatch(/Owned by renamed symbol/);
  });

  it('downgrades return_type_changed when old → new pair matches a recorded rename', () => {
    const baseline = makeSnapshot([
      sym({ fqName: 'ApiKeyWithValue', kind: 'alias' }),
      sym({
        fqName: 'ApiKeyWithValue.value',
        kind: 'field',
        ownerFqName: 'ApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'ApiKeyService.create',
        kind: 'callable',
        ownerFqName: 'ApiKeyService',
        parameters: [],
        returns: { name: 'ApiKeyWithValue' },
      }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'OrganizationApiKeyWithValue', kind: 'alias' }),
      sym({
        fqName: 'OrganizationApiKeyWithValue.value',
        kind: 'field',
        ownerFqName: 'OrganizationApiKeyWithValue',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'ApiKeyService.create',
        kind: 'callable',
        ownerFqName: 'ApiKeyService',
        parameters: [],
        returns: { name: 'OrganizationApiKeyWithValue' },
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const returnChange = result.changes.find((c) => c.category === 'return_type_changed');
    expect(returnChange, 'return_type_changed should be classified').toBeDefined();
    expect(returnChange!.severity).toBe('soft-risk');
    expect(returnChange!.remediation).toMatch(/recorded rename/);
  });

  it('also downgrades return_type_changed for `*Iterator[Foo]` style return wrappers', () => {
    // bareTypeName strips a single-type-arg generic, so `*Iterator[ApiKey]`
    // → `ApiKey` and `*Iterator[OrganizationApiKey]` → `OrganizationApiKey`,
    // letting the cascade pair them with the rename map.
    const baseline = makeSnapshot([
      sym({ fqName: 'ApiKey', kind: 'alias' }),
      sym({
        fqName: 'ApiKey.id',
        kind: 'field',
        ownerFqName: 'ApiKey',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'ApiKeyService.list_organization',
        kind: 'callable',
        ownerFqName: 'ApiKeyService',
        parameters: [],
        returns: { name: 'Iterator<ApiKey>' },
      }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'OrganizationApiKey', kind: 'alias' }),
      sym({
        fqName: 'OrganizationApiKey.id',
        kind: 'field',
        ownerFqName: 'OrganizationApiKey',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'ApiKeyService.list_organization',
        kind: 'callable',
        ownerFqName: 'ApiKeyService',
        parameters: [],
        returns: { name: 'Iterator<OrganizationApiKey>' },
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const returnChange = result.changes.find((c) => c.category === 'return_type_changed');
    expect(returnChange, 'iterator return change should be classified').toBeDefined();
    expect(returnChange!.severity).toBe('soft-risk');
  });

  it('does NOT downgrade when the candidate type drops a baseline field (real reshape)', () => {
    // OldType has {a, b}; NewType has only {a}. Removing b is a genuine
    // reshape, not a rename. Severity stays at breaking.
    const baseline = makeSnapshot([
      sym({ fqName: 'OldType', kind: 'alias' }),
      sym({
        fqName: 'OldType.a',
        kind: 'field',
        ownerFqName: 'OldType',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'OldType.b',
        kind: 'field',
        ownerFqName: 'OldType',
        typeRef: { name: 'string' },
      }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'NewType', kind: 'alias' }),
      sym({
        fqName: 'NewType.a',
        kind: 'field',
        ownerFqName: 'NewType',
        typeRef: { name: 'string' },
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const removal = result.changes.find((c) => c.category === 'symbol_removed' && c.old.symbol === 'OldType');
    expect(removal!.severity).toBe('breaking');
    expect(removal!.remediation).toBeUndefined();
  });

  it('does NOT downgrade when the candidate type already existed in the baseline (it is a swap, not a rename)', () => {
    // Both `Foo` and `Bar` existed in the baseline; only `Foo` is removed.
    // This is a deliberate swap to a pre-existing type, not the emitter
    // losing track of a name. Severity should stay breaking.
    const baseline = makeSnapshot([
      sym({ fqName: 'Foo', kind: 'alias' }),
      sym({ fqName: 'Foo.x', kind: 'field', ownerFqName: 'Foo', typeRef: { name: 'string' } }),
      sym({ fqName: 'Bar', kind: 'alias' }),
      sym({ fqName: 'Bar.x', kind: 'field', ownerFqName: 'Bar', typeRef: { name: 'string' } }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'Bar', kind: 'alias' }),
      sym({ fqName: 'Bar.x', kind: 'field', ownerFqName: 'Bar', typeRef: { name: 'string' } }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const removal = result.changes.find((c) => c.category === 'symbol_removed' && c.old.symbol === 'Foo');
    expect(removal!.severity).toBe('breaking');
  });

  it('also downgrades Go-shape return types like `*Iterator[Foo]` (pointer prefix + bracket generic)', () => {
    // Mirrors workos/openapi-spec#17's APIKeyService.ListOrganizationAPIKeys
    // signature: bareTypeName must strip the leading `*` and the `[...]`
    // bracket generic so the cascade resolves `*Iterator[APIKey]` to bare
    // `APIKey` and matches the recorded type rename.
    const baseline = makeSnapshot([
      sym({ fqName: 'APIKey', kind: 'alias' }),
      sym({ fqName: 'APIKey.id', kind: 'field', ownerFqName: 'APIKey', typeRef: { name: 'string' } }),
      sym({
        fqName: 'APIKeyService.ListOrganizationAPIKeys',
        kind: 'callable',
        ownerFqName: 'APIKeyService',
        parameters: [],
        returns: { name: '*Iterator[APIKey]' },
      }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'OrganizationAPIKey', kind: 'alias' }),
      sym({
        fqName: 'OrganizationAPIKey.id',
        kind: 'field',
        ownerFqName: 'OrganizationAPIKey',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'APIKeyService.ListOrganizationAPIKeys',
        kind: 'callable',
        ownerFqName: 'APIKeyService',
        parameters: [],
        returns: { name: '*Iterator[OrganizationAPIKey]' },
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const returnChange = result.changes.find((c) => c.category === 'return_type_changed');
    expect(returnChange, 'pointer iterator return change should be classified').toBeDefined();
    expect(returnChange!.severity).toBe('soft-risk');
  });

  it('downgrades return_type_changed via structural equivalence even when no parent rename was recorded', () => {
    // Mirrors the canonical fork antipattern: the old type *still exists*
    // in the candidate (so no `symbol_removed` for it), but a method's
    // return type was redirected to a newly-added superset type. The
    // value-level shape is preserved (every field on the old type still
    // exists on the new one), so this is non-breaking even though there's
    // no name-level rename to record.
    const baseline = makeSnapshot([
      sym({ fqName: 'APIKey', kind: 'alias' }),
      sym({ fqName: 'APIKey.id', kind: 'field', ownerFqName: 'APIKey', typeRef: { name: 'string' } }),
      sym({
        fqName: 'APIKey.name',
        kind: 'field',
        ownerFqName: 'APIKey',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'APIKeyService.list',
        kind: 'callable',
        ownerFqName: 'APIKeyService',
        parameters: [],
        returns: { name: 'APIKey' },
      }),
    ]);
    const candidate = makeSnapshot([
      // Old type still present (alias-style)
      sym({ fqName: 'APIKey', kind: 'alias' }),
      sym({ fqName: 'APIKey.id', kind: 'field', ownerFqName: 'APIKey', typeRef: { name: 'string' } }),
      sym({
        fqName: 'APIKey.name',
        kind: 'field',
        ownerFqName: 'APIKey',
        typeRef: { name: 'string' },
      }),
      // New superset type
      sym({ fqName: 'OrganizationAPIKey', kind: 'alias' }),
      sym({
        fqName: 'OrganizationAPIKey.id',
        kind: 'field',
        ownerFqName: 'OrganizationAPIKey',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'OrganizationAPIKey.name',
        kind: 'field',
        ownerFqName: 'OrganizationAPIKey',
        typeRef: { name: 'string' },
      }),
      // Method now returns the new type
      sym({
        fqName: 'APIKeyService.list',
        kind: 'callable',
        ownerFqName: 'APIKeyService',
        parameters: [],
        returns: { name: 'OrganizationAPIKey' },
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const returnChange = result.changes.find((c) => c.category === 'return_type_changed');
    expect(returnChange).toBeDefined();
    expect(returnChange!.severity).toBe('soft-risk');
    // Either the fork-detector remediation or the structural-equivalence
    // fallback should explain the situation; both are accepted.
    expect(returnChange!.remediation).toBeDefined();
  });

  it('detects enum canonical-flips even when the old enum survives as a candidate alias', () => {
    // Go/Ruby/Python/PHP/Kotlin emit `type Old = New` aliases for the
    // dedup-flipped canonical, so the parent fqName persists in candidate
    // and never fires `symbol_removed`. Only the *members* are gone from
    // the old owner. Detection still has to fire so the member cascade
    // can downgrade the enum_member removals.
    const baseline = makeSnapshot([
      sym({ fqName: 'ApplicationsOrder', kind: 'enum' }),
      sym({ fqName: 'ApplicationsOrder.Asc', kind: 'enum_member', ownerFqName: 'ApplicationsOrder', value: 'asc' }),
      sym({ fqName: 'ApplicationsOrder.Desc', kind: 'enum_member', ownerFqName: 'ApplicationsOrder', value: 'desc' }),
      sym({
        fqName: 'ApplicationsOrder.Normal',
        kind: 'enum_member',
        ownerFqName: 'ApplicationsOrder',
        value: 'normal',
      }),
    ]);
    const candidate = makeSnapshot([
      // ApplicationsOrder survives as an alias — same fqName, kind changed
      // to alias, no member children.
      sym({ fqName: 'ApplicationsOrder', kind: 'alias' }),
      // New canonical with the flipped name
      sym({ fqName: 'APIKeysOrder', kind: 'enum' }),
      sym({ fqName: 'APIKeysOrder.Asc', kind: 'enum_member', ownerFqName: 'APIKeysOrder', value: 'asc' }),
      sym({ fqName: 'APIKeysOrder.Desc', kind: 'enum_member', ownerFqName: 'APIKeysOrder', value: 'desc' }),
      sym({ fqName: 'APIKeysOrder.Normal', kind: 'enum_member', ownerFqName: 'APIKeysOrder', value: 'normal' }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const memberRemoval = result.changes.find(
      (c) => c.category === 'symbol_removed' && c.old.symbol === 'ApplicationsOrder.Asc',
    );
    expect(memberRemoval).toBeDefined();
    expect(memberRemoval!.severity).toBe('soft-risk');
    expect(memberRemoval!.remediation).toMatch(/Owned by renamed symbol "ApplicationsOrder"/);
  });

  it('infers transitive renames for child alias types referenced by a renamed parent', () => {
    // Real-world: APIKeyWithValue's Owner field points at APIKeyWithValueOwner.
    // After renaming the parent, the Owner type also got renamed to
    // OrganizationAPIKeyOwner, but it has no extractable field children
    // (Go discriminated-union owner alias). The structural matcher can't
    // pair them directly; the transitive pass should derive the rename
    // from the parent's same-named field's typeRef swap.
    const baseline = makeSnapshot([
      sym({ fqName: 'APIKeyWithValue', kind: 'alias' }),
      sym({ fqName: 'APIKeyWithValue.id', kind: 'field', ownerFqName: 'APIKeyWithValue', typeRef: { name: 'string' } }),
      sym({
        fqName: 'APIKeyWithValue.owner',
        kind: 'field',
        ownerFqName: 'APIKeyWithValue',
        typeRef: { name: 'APIKeyWithValueOwner' },
      }),
      // Owner alias type — no field children
      sym({ fqName: 'APIKeyWithValueOwner', kind: 'alias' }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'OrganizationAPIKeyWithValue', kind: 'alias' }),
      sym({
        fqName: 'OrganizationAPIKeyWithValue.id',
        kind: 'field',
        ownerFqName: 'OrganizationAPIKeyWithValue',
        typeRef: { name: 'string' },
      }),
      sym({
        fqName: 'OrganizationAPIKeyWithValue.owner',
        kind: 'field',
        ownerFqName: 'OrganizationAPIKeyWithValue',
        typeRef: { name: 'OrganizationAPIKeyOwner' },
      }),
      sym({ fqName: 'OrganizationAPIKeyOwner', kind: 'alias' }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const ownerRemoval = result.changes.find(
      (c) => c.category === 'symbol_removed' && c.old.symbol === 'APIKeyWithValueOwner',
    );
    expect(ownerRemoval, 'owner type removal should exist').toBeDefined();
    expect(ownerRemoval!.severity).toBe('soft-risk');
    expect(ownerRemoval!.remediation).toMatch(/inferred transitively/);
    expect(ownerRemoval!.remediation).toMatch(/OrganizationAPIKeyOwner/);
  });

  it('pairs deterministically with the alphabetically-first matching candidate when several are valid', () => {
    // OldType is structurally compatible with both NewTypeA and NewTypeB.
    // The pairing must be stable across runs — choose alphabetically first.
    const baseline = makeSnapshot([
      sym({ fqName: 'OldType', kind: 'alias' }),
      sym({ fqName: 'OldType.f', kind: 'field', ownerFqName: 'OldType', typeRef: { name: 'string' } }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'NewTypeB', kind: 'alias' }),
      sym({ fqName: 'NewTypeB.f', kind: 'field', ownerFqName: 'NewTypeB', typeRef: { name: 'string' } }),
      sym({ fqName: 'NewTypeA', kind: 'alias' }),
      sym({ fqName: 'NewTypeA.f', kind: 'field', ownerFqName: 'NewTypeA', typeRef: { name: 'string' } }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const removal = result.changes.find((c) => c.old.symbol === 'OldType');
    expect(removal!.severity).toBe('soft-risk');
    expect(removal!.remediation).toMatch(/renamed to "NewTypeA"/);
  });
});

// ---------------------------------------------------------------------------
// Enum canonical-flip detection
// ---------------------------------------------------------------------------

describe('detectEnumRenames — enum canonical-flip detection', () => {
  /**
   * Mirror the workos/openapi-spec#17 VaultByokKey case: a baseline enum
   * disappears (in dotnet, which can't emit type aliases) when a new enum
   * with identical wire values joins the spec and the dedup heuristic
   * picks the new shorter name as canonical. The wire values are
   * unchanged, so consumer code constructing or matching on these values
   * keeps working — only typed-class references need migration.
   */
  it('downgrades an enum removal to soft-risk when an identically-valued new enum exists', () => {
    const baseline = makeSnapshot([
      sym({ fqName: 'VaultByokKeyVerificationCompletedDataKeyProvider', kind: 'enum' }),
      sym({
        fqName: 'VaultByokKeyVerificationCompletedDataKeyProvider.AwsKms',
        kind: 'enum_member',
        ownerFqName: 'VaultByokKeyVerificationCompletedDataKeyProvider',
        value: 'AWS_KMS',
      }),
      sym({
        fqName: 'VaultByokKeyVerificationCompletedDataKeyProvider.GcpKms',
        kind: 'enum_member',
        ownerFqName: 'VaultByokKeyVerificationCompletedDataKeyProvider',
        value: 'GCP_KMS',
      }),
      sym({
        fqName: 'VaultByokKeyVerificationCompletedDataKeyProvider.AzureKeyVault',
        kind: 'enum_member',
        ownerFqName: 'VaultByokKeyVerificationCompletedDataKeyProvider',
        value: 'AZURE_KEY_VAULT',
      }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'VaultByokKeyDeletedDataKeyProvider', kind: 'enum' }),
      sym({
        fqName: 'VaultByokKeyDeletedDataKeyProvider.AwsKms',
        kind: 'enum_member',
        ownerFqName: 'VaultByokKeyDeletedDataKeyProvider',
        value: 'AWS_KMS',
      }),
      sym({
        fqName: 'VaultByokKeyDeletedDataKeyProvider.GcpKms',
        kind: 'enum_member',
        ownerFqName: 'VaultByokKeyDeletedDataKeyProvider',
        value: 'GCP_KMS',
      }),
      sym({
        fqName: 'VaultByokKeyDeletedDataKeyProvider.AzureKeyVault',
        kind: 'enum_member',
        ownerFqName: 'VaultByokKeyDeletedDataKeyProvider',
        value: 'AZURE_KEY_VAULT',
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const removal = result.changes.find(
      (c) => c.category === 'symbol_removed' && c.old.symbol === 'VaultByokKeyVerificationCompletedDataKeyProvider',
    );
    expect(removal, 'enum removal change should exist').toBeDefined();
    expect(removal!.severity).toBe('soft-risk');
    expect(removal!.remediation).toMatch(/identical wire values/);
  });

  it('cascades the downgrade to enum_member removals owned by a renamed enum', () => {
    const baseline = makeSnapshot([
      sym({ fqName: 'ApplicationsOrder', kind: 'enum' }),
      sym({
        fqName: 'ApplicationsOrder.Asc',
        kind: 'enum_member',
        ownerFqName: 'ApplicationsOrder',
        value: 'asc',
      }),
      sym({
        fqName: 'ApplicationsOrder.Desc',
        kind: 'enum_member',
        ownerFqName: 'ApplicationsOrder',
        value: 'desc',
      }),
      sym({
        fqName: 'ApplicationsOrder.Normal',
        kind: 'enum_member',
        ownerFqName: 'ApplicationsOrder',
        value: 'normal',
      }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'ApiKeysOrder', kind: 'enum' }),
      sym({
        fqName: 'ApiKeysOrder.Asc',
        kind: 'enum_member',
        ownerFqName: 'ApiKeysOrder',
        value: 'asc',
      }),
      sym({
        fqName: 'ApiKeysOrder.Desc',
        kind: 'enum_member',
        ownerFqName: 'ApiKeysOrder',
        value: 'desc',
      }),
      sym({
        fqName: 'ApiKeysOrder.Normal',
        kind: 'enum_member',
        ownerFqName: 'ApiKeysOrder',
        value: 'normal',
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const memberRemoval = result.changes.find(
      (c) => c.category === 'symbol_removed' && c.old.symbol === 'ApplicationsOrder.Asc',
    );
    expect(memberRemoval, 'enum_member removal should exist').toBeDefined();
    expect(memberRemoval!.severity).toBe('soft-risk');
    expect(memberRemoval!.remediation).toMatch(/Owned by renamed symbol "ApplicationsOrder"/);
  });

  it('does NOT downgrade when the candidate enum has different wire values', () => {
    // Same value-set size but different value — narrowing or shifting an
    // enum is a real wire-format break, not a rename.
    const baseline = makeSnapshot([
      sym({ fqName: 'OldEnum', kind: 'enum' }),
      sym({
        fqName: 'OldEnum.A',
        kind: 'enum_member',
        ownerFqName: 'OldEnum',
        value: 'a',
      }),
      sym({
        fqName: 'OldEnum.B',
        kind: 'enum_member',
        ownerFqName: 'OldEnum',
        value: 'b',
      }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'NewEnum', kind: 'enum' }),
      sym({
        fqName: 'NewEnum.A',
        kind: 'enum_member',
        ownerFqName: 'NewEnum',
        value: 'a',
      }),
      sym({
        fqName: 'NewEnum.C',
        kind: 'enum_member',
        ownerFqName: 'NewEnum',
        value: 'c',
      }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const removal = result.changes.find((c) => c.category === 'symbol_removed' && c.old.symbol === 'OldEnum');
    expect(removal!.severity).toBe('breaking');
    expect(removal!.remediation).toBeUndefined();
  });

  it('does NOT downgrade when the candidate enum is a strict superset (extra value is a real addition consumers may need to handle)', () => {
    // Strict-superset enum is not a rename — consumers may need to add
    // handling for the new wire value. If language emitters emit `Unknown`
    // sentinels this is forward-compatible at the deserialization layer,
    // but the differ shouldn't decide that on the consumer's behalf.
    const baseline = makeSnapshot([
      sym({ fqName: 'OldEnum', kind: 'enum' }),
      sym({ fqName: 'OldEnum.A', kind: 'enum_member', ownerFqName: 'OldEnum', value: 'a' }),
    ]);
    const candidate = makeSnapshot([
      sym({ fqName: 'NewEnum', kind: 'enum' }),
      sym({ fqName: 'NewEnum.A', kind: 'enum_member', ownerFqName: 'NewEnum', value: 'a' }),
      sym({ fqName: 'NewEnum.B', kind: 'enum_member', ownerFqName: 'NewEnum', value: 'b' }),
    ]);

    const result = diffSnapshots(baseline, candidate);
    const removal = result.changes.find((c) => c.category === 'symbol_removed' && c.old.symbol === 'OldEnum');
    expect(removal!.severity).toBe('breaking');
  });
});
