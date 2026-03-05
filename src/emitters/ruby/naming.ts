import { toSnakeCase, toPascalCase } from "../../utils/naming.js";

export function rubyClassName(name: string): string {
  return toPascalCase(name);
}

export function rubyFileName(name: string): string {
  return toSnakeCase(name);
}

export function rubyMethodName(name: string): string {
  return toSnakeCase(name);
}

export function rubyModulePath(
  namespace: string,
  category: string,
  name: string,
): string {
  return `lib/${toSnakeCase(namespace)}/${category}/${rubyFileName(name)}.rb`;
}
