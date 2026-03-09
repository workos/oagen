import { toPascalCase, toCamelCase, toKebabCase, toSnakeCase } from '../../utils/naming.js';

export function nodeClassName(name: string): string {
  return toPascalCase(name);
}

export function nodeFileName(name: string): string {
  return toKebabCase(name);
}

export function nodeMethodName(name: string): string {
  return toCamelCase(name);
}

export function nodeFieldName(name: string): string {
  return toCamelCase(name);
}

export function nodeInterfacePath(service: string, entity: string): string {
  return `src/${toKebabCase(service)}/interfaces/${toKebabCase(entity)}.interface.ts`;
}

export function nodeSerializerPath(service: string, entity: string): string {
  return `src/${toKebabCase(service)}/serializers/${toKebabCase(entity)}.serializer.ts`;
}

export function nodeResourcePath(service: string): string {
  const name = toKebabCase(service);
  return `src/${name}/${name}.ts`;
}

export function nodeTestPath(service: string): string {
  const name = toKebabCase(service);
  return `src/${name}/${name}.spec.ts`;
}

export function nodeFixturePath(service: string, operation: string): string {
  return `src/${toKebabCase(service)}/fixtures/${toSnakeCase(operation)}.json`;
}

/**
 * Merge an action string with a service name by collapsing any trailing overlap.
 * The action's trailing PascalCase words that match the start of the service name
 * are collapsed to avoid duplication.
 *
 * Examples:
 *   mergeActionService("ValidateApiKey", "ApiKeys") → "ValidateApiKeys"
 *   mergeActionService("CreateApiKey", "ApiKeys") → "CreateApiKeys"
 *   mergeActionService("Check", "Authorization") → "CheckAuthorization" (no overlap)
 */
export function mergeActionService(action: string, service: string): string {
  for (let i = 0; i < action.length; i++) {
    if (!/[A-Z]/.test(action[i])) continue;
    const suffix = action.slice(i);
    if (service.startsWith(suffix)) {
      return action.slice(0, i) + service;
    }
  }
  return action + service;
}
