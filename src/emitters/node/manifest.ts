import type { ApiSpec } from '../../ir/types.js';
import type { EmitterContext, GeneratedFile } from '../../engine/types.js';
import { toCamelCase } from '../../utils/naming.js';
import { nodeMethodName } from './naming.js';

interface ManifestEntry {
  operationId: string;
  sdkResourceProperty: string;
  sdkMethodName: string;
  httpMethod: string;
  path: string;
  pathParams: string[];
  bodyFields: string[];
  queryFields: string[];
}

/** Map IR service names to WorkOS SDK property names (mirrors sdk-node.ts SERVICE_MAP) */
const SERVICE_PROPERTY_MAP: Record<string, string> = {
  Organizations: 'organizations',
  OrganizationDomains: 'organizationDomains',
  Users: 'userManagement',
  Connections: 'sso',
  Directories: 'directorySync',
  DirectoryGroups: 'directorySync',
  DirectoryUsers: 'directorySync',
  Events: 'events',
  AuditLogs: 'auditLogs',
  AuditLogExports: 'auditLogs',
  FeatureFlags: 'featureFlags',
  Webhooks: 'webhooks',
  Vault: 'vault',
  ApiKeys: 'apiKeys',
  Portal: 'portal',
  Roles: 'userManagement',
  Permissions: 'userManagement',
  Invitations: 'userManagement',
  Sessions: 'userManagement',
  Memberships: 'userManagement',
  OrganizationMemberships: 'userManagement',
  SSO: 'sso',
  FGA: 'fga',
};

export function generateManifest(spec: ApiSpec, _ctx: EmitterContext): GeneratedFile[] {
  const entries: ManifestEntry[] = [];

  for (const service of spec.services) {
    const sdkProp = SERVICE_PROPERTY_MAP[service.name];
    if (!sdkProp) continue;

    for (const op of service.operations) {
      const bodyFields: string[] = [];
      if (op.requestBody && op.requestBody.kind === 'model') {
        const bodyName = op.requestBody.name;
        const model = spec.models.find((m) => m.name === bodyName);
        if (model) {
          for (const field of model.fields) {
            if (field.required) {
              bodyFields.push(toCamelCase(field.name));
            }
          }
        }
      }

      entries.push({
        operationId: `${service.name}.${op.name}`,
        sdkResourceProperty: sdkProp,
        sdkMethodName: nodeMethodName(op.name),
        httpMethod: op.httpMethod.toUpperCase(),
        path: op.path,
        pathParams: op.pathParams.map((p) => p.name),
        bodyFields,
        queryFields: op.queryParams.filter((q) => q.required).map((q) => toCamelCase(q.name)),
      });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    entries,
  };

  return [
    {
      path: 'smoke-manifest.json',
      content: JSON.stringify(manifest, null, 2),
      skipIfExists: false,
    },
  ];
}
