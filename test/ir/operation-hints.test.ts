import { describe, expect, it } from 'vitest';
import { deriveMethodName, resolveOperations } from '../../src/ir/operation-hints.js';
import type { OperationHint } from '../../src/ir/operation-hints.js';
import type { ApiSpec, Service, Operation, HttpMethod } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Operation for testing. */
function op(httpMethod: HttpMethod, path: string, name = ''): Operation {
  return {
    name,
    httpMethod,
    path,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'void' } as any,
    errors: [],
    injectIdempotencyKey: false,
  };
}

/** Build a minimal Service. */
function svc(name: string, ops: Operation[]): Service {
  return { name, operations: ops };
}

/** Build a minimal ApiSpec. */
function spec(services: Service[]): ApiSpec {
  return {
    name: 'TestApi',
    version: '1.0.0',
    baseUrl: 'https://api.test.com',
    services,
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
  };
}

// ---------------------------------------------------------------------------
// deriveMethodName — algorithm unit tests
// ---------------------------------------------------------------------------

describe('deriveMethodName', () => {
  const service = svc('TestService', []);

  describe('CRUD operations', () => {
    it('GET on collection → list_<plural>', () => {
      expect(deriveMethodName(op('get', '/users'), service)).toBe('list_users');
    });

    it('GET with trailing {id} → get_<singular>', () => {
      expect(deriveMethodName(op('get', '/users/{id}'), service)).toBe('get_user');
    });

    it('POST on collection → create_<plural>', () => {
      expect(deriveMethodName(op('post', '/users'), service)).toBe('create_users');
    });

    it('PUT on resource → update_<singular>', () => {
      expect(deriveMethodName(op('put', '/users/{id}'), service)).toBe('update_user');
    });

    it('PATCH on resource → update_<singular>', () => {
      expect(deriveMethodName(op('patch', '/users/{id}'), service)).toBe('update_user');
    });

    it('DELETE on resource → delete_<singular>', () => {
      expect(deriveMethodName(op('delete', '/users/{id}'), service)).toBe('delete_user');
    });
  });

  describe('action verbs', () => {
    it('terminal verify → verify_<resource>', () => {
      expect(deriveMethodName(op('post', '/auth/challenges/{id}/verify'), service)).toBe('verify_challenge');
    });

    it('terminal enroll → enroll_<resource>', () => {
      expect(deriveMethodName(op('post', '/auth/factors/enroll'), service)).toBe('enroll_factor');
    });

    it('terminal confirm → confirm_<resource>', () => {
      expect(deriveMethodName(op('post', '/password_reset/confirm'), service)).toBe('confirm_password_reset');
    });

    it('terminal challenge → challenge_<resource>', () => {
      expect(deriveMethodName(op('post', '/auth/factors/{id}/challenge'), service)).toBe('challenge_factor');
    });

    it('terminal accept → accept_<resource>', () => {
      expect(deriveMethodName(op('post', '/invitations/{id}/accept'), service)).toBe('accept_invitation');
    });

    it('terminal revoke → revoke_<resource>', () => {
      expect(deriveMethodName(op('post', '/invitations/{id}/revoke'), service)).toBe('revoke_invitation');
    });

    it('terminal send → send_<resource>', () => {
      expect(deriveMethodName(op('post', '/users/{id}/email_verification/send'), service)).toBe(
        'send_email_verification',
      );
    });

    it('terminal disable → disable_<resource>', () => {
      expect(deriveMethodName(op('put', '/feature-flags/{slug}/disable'), service)).toBe('disable_feature_flag');
    });

    it('terminal enable → enable_<resource>', () => {
      expect(deriveMethodName(op('put', '/feature-flags/{slug}/enable'), service)).toBe('enable_feature_flag');
    });

    it('terminal complete → complete_<resource>', () => {
      expect(deriveMethodName(op('post', '/authkit/oauth2/complete'), service)).toBe('complete_oauth2');
    });

    it('terminal authorize → authorize_<resource>', () => {
      expect(deriveMethodName(op('post', '/data-integrations/{slug}/authorize'), service)).toBe(
        'authorize_data_integration',
      );
    });

    it('terminal deactivate → deactivate_<resource>', () => {
      expect(deriveMethodName(op('put', '/organization_memberships/{id}/deactivate'), service)).toBe(
        'deactivate_organization_membership',
      );
    });

    it('terminal reactivate → reactivate_<resource>', () => {
      expect(deriveMethodName(op('put', '/organization_memberships/{id}/reactivate'), service)).toBe(
        'reactivate_organization_membership',
      );
    });
  });

  describe('singularization', () => {
    it('keeps plural for collection POST', () => {
      expect(deriveMethodName(op('post', '/organizations'), service)).toBe('create_organizations');
    });

    it('singularizes with trailing param', () => {
      expect(deriveMethodName(op('get', '/directories/{id}'), service)).toBe('get_directory');
    });

    it('preserves -ss words', () => {
      expect(deriveMethodName(op('get', '/access/{id}'), service)).toBe('get_access');
    });
  });

  describe('nested paths', () => {
    it('uses terminal segment for resource noun', () => {
      expect(deriveMethodName(op('get', '/user_management/users'), service)).toBe('list_users');
    });

    it('nested resource with trailing param', () => {
      expect(deriveMethodName(op('get', '/user_management/users/{id}'), service)).toBe('get_user');
    });

    it('deeply nested action verb gets resource context', () => {
      expect(deriveMethodName(op('post', '/user_management/users/{id}/email_change/confirm'), service)).toBe(
        'confirm_email_change',
      );
    });
  });

  describe('edge cases', () => {
    it('root-level path produces fallback name', () => {
      expect(deriveMethodName(op('get', '/'), service)).toBe('list_root');
    });

    it('path with only params produces fallback', () => {
      // Unlikely but exercised for robustness
      expect(deriveMethodName(op('get', '/{id}'), service)).toBe('list_root');
    });

    it('hyphenated segments converted to snake_case', () => {
      expect(deriveMethodName(op('get', '/feature-flags'), service)).toBe('list_feature_flags');
    });

    it('by_token sub-path for GET → get_<resource>_by_token', () => {
      expect(deriveMethodName(op('get', '/user_management/invitations/by_token/{token}'), service)).toBe(
        'get_by_token',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// resolveOperations — integration tests
// ---------------------------------------------------------------------------

describe('resolveOperations', () => {
  it('resolves without hints using algorithm', () => {
    const s = spec([svc('Users', [op('get', '/users'), op('get', '/users/{id}'), op('post', '/users')])]);

    const resolved = resolveOperations(s);
    expect(resolved).toHaveLength(3);
    expect(resolved[0].methodName).toBe('list_users');
    expect(resolved[1].methodName).toBe('get_user');
    expect(resolved[2].methodName).toBe('create_users');
    // No mount override — stays on original service
    expect(resolved[0].mountOn).toBe('Users');
  });

  it('applies name hint override', () => {
    const s = spec([svc('SSO', [op('get', '/sso/authorize')])]);
    const hints: Record<string, OperationHint> = {
      'GET /sso/authorize': { name: 'get_authorization_url' },
    };

    const resolved = resolveOperations(s, hints);
    expect(resolved[0].methodName).toBe('get_authorization_url');
  });

  it('applies mountOn hint override', () => {
    const s = spec([svc('Organizations', [op('get', '/organizations/{id}/audit_logs_retention')])]);
    const hints: Record<string, OperationHint> = {
      'GET /organizations/{id}/audit_logs_retention': { mountOn: 'AuditLogs' },
    };

    const resolved = resolveOperations(s, hints);
    expect(resolved[0].mountOn).toBe('AuditLogs');
  });

  it('applies mount rules at service level', () => {
    const s = spec([svc('Connections', [op('get', '/connections'), op('get', '/connections/{id}')])]);
    const mountRules = { Connections: 'SSO' };

    const resolved = resolveOperations(s, {}, mountRules);
    expect(resolved[0].mountOn).toBe('SSO');
    expect(resolved[1].mountOn).toBe('SSO');
  });

  it('per-operation mountOn hint overrides service-level mount rule', () => {
    const s = spec([svc('Connections', [op('get', '/connections'), op('get', '/connections/{id}')])]);
    const hints: Record<string, OperationHint> = {
      'GET /connections/{id}': { mountOn: 'CustomTarget' },
    };
    const mountRules = { Connections: 'SSO' };

    const resolved = resolveOperations(s, hints, mountRules);
    expect(resolved[0].mountOn).toBe('SSO'); // service-level rule
    expect(resolved[1].mountOn).toBe('CustomTarget'); // per-op override
  });

  it('builds wrappers for split hints', () => {
    const authOp = op('post', '/user_management/authenticate');
    authOp.response = { kind: 'model', name: 'AuthResponse' } as any;
    const s = spec([svc('UserManagementAuthentication', [authOp])]);

    const hints: Record<string, OperationHint> = {
      'POST /user_management/authenticate': {
        split: [
          {
            name: 'authenticate_with_password',
            targetVariant: 'PasswordSessionAuthenticateRequest',
            defaults: { grant_type: 'password' },
            inferFromClient: ['client_id', 'client_secret'],
            exposedParams: ['email', 'password'],
          },
          {
            name: 'authenticate_with_code',
            targetVariant: 'CodeSessionAuthenticateRequest',
            defaults: { grant_type: 'authorization_code' },
            inferFromClient: ['client_id', 'client_secret'],
            exposedParams: ['code'],
          },
        ],
      },
    };

    const resolved = resolveOperations(s, hints);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].wrappers).toHaveLength(2);

    const [pw, code] = resolved[0].wrappers!;
    expect(pw.name).toBe('authenticate_with_password');
    expect(pw.targetVariant).toBe('PasswordSessionAuthenticateRequest');
    expect(pw.defaults).toEqual({ grant_type: 'password' });
    expect(pw.inferFromClient).toEqual(['client_id', 'client_secret']);
    expect(pw.exposedParams).toEqual(['email', 'password']);
    expect(pw.responseModelName).toBe('AuthResponse');

    expect(code.name).toBe('authenticate_with_code');
    expect(code.exposedParams).toEqual(['code']);
  });

  it('ignores hints for nonexistent operations', () => {
    const s = spec([svc('Users', [op('get', '/users')])]);
    const hints: Record<string, OperationHint> = {
      'DELETE /nonexistent': { name: 'should_not_appear' },
    };

    const resolved = resolveOperations(s, hints);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].methodName).toBe('list_users');
  });

  it('unhinted operations always produce a name (never blocks)', () => {
    const s = spec([
      svc('NewService', [op('get', '/new_endpoints'), op('post', '/new_endpoints'), op('get', '/new_endpoints/{id}')]),
    ]);

    const resolved = resolveOperations(s);
    for (const r of resolved) {
      expect(r.methodName).toBeTruthy();
      expect(r.mountOn).toBe('NewService');
    }
  });

  it('wrappers without split produce undefined wrappers', () => {
    const s = spec([svc('SSO', [op('get', '/sso/profile')])]);
    const hints: Record<string, OperationHint> = {
      'GET /sso/profile': { name: 'get_profile' },
    };

    const resolved = resolveOperations(s, hints);
    expect(resolved[0].wrappers).toBeUndefined();
  });

  it('combines name + mountOn hints on the same operation', () => {
    const s = spec([svc('UserManagementSessionTokens', [op('get', '/sso/jwks/{id}')])]);
    const hints: Record<string, OperationHint> = {
      'GET /sso/jwks/{id}': { name: 'get_jwks' },
    };
    const mountRules = { UserManagementSessionTokens: 'UserManagement' };

    const resolved = resolveOperations(s, hints, mountRules);
    expect(resolved[0].methodName).toBe('get_jwks');
    expect(resolved[0].mountOn).toBe('UserManagement');
  });
});
