import { toCamelCase, toPascalCase } from '@workos/oagen';

/** Convert an IR model/enum name to a TypeScript interface name. */
export function tsTypeName(name: string): string {
  return toPascalCase(name);
}

/** Convert an IR field name to a TypeScript property name (camelCase). */
export function tsPropertyName(name: string): string {
  return toCamelCase(name);
}

/** Convert an IR operation name to a TypeScript method name (camelCase). */
export function tsMethodName(name: string): string {
  return toCamelCase(name);
}

/** Convert an IR service name to a TypeScript class name. */
export function tsClassName(name: string): string {
  return toPascalCase(name);
}
