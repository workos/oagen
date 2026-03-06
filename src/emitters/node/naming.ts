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
