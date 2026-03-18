/**
 * Go surface builder — transforms parsed Go symbols into an ApiSurface
 * with proper package-qualified names for collision avoidance.
 */

import { basename, dirname } from 'node:path';
import type {
  ApiClass,
  ApiMethod,
  ApiParam,
  ApiProperty,
  ApiInterface,
  ApiField,
  ApiTypeAlias,
  ApiEnum,
} from '../types.js';
import type { GoStruct, GoTypeDecl, GoFunc, GoConst } from './go-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

function goTypeToString(t: string): string {
  return t.replace(/json\.RawMessage/g, '[]byte').replace(/\bcontext\.Context\b/g, 'context.Context');
}

function buildReturnType(returnTypes: string[]): string {
  const nonError = returnTypes.filter((r) => r !== 'error');
  if (nonError.length === 0) return 'error';
  if (nonError.length === 1) return goTypeToString(nonError[0]);
  return `(${nonError.map(goTypeToString).join(', ')})`;
}

/** Get the package directory name from a source file relative path. */
function getPackageDirName(relPath: string): string {
  const dir = dirname(relPath);
  return basename(dir) || 'root';
}

// ---------------------------------------------------------------------------
// Qualified name resolution
// ---------------------------------------------------------------------------

/**
 * When multiple packages define the same exported symbol, qualify with the
 * package directory name (e.g., "organizations.Client", "sso.Client").
 * Unique symbols keep their bare name.
 */
function buildQualifiedNames(
  items: Array<{ name: string; packageName: string; sourceFile: string }>,
): Map<string, string> {
  const nameToPackages = new Map<string, Set<string>>();
  for (const item of items) {
    if (!nameToPackages.has(item.name)) nameToPackages.set(item.name, new Set());
    nameToPackages.get(item.name)!.add(item.packageName);
  }

  const result = new Map<string, string>();
  for (const item of items) {
    const key = `${item.sourceFile}:${item.name}`;
    const packages = nameToPackages.get(item.name)!;
    result.set(key, packages.size > 1 ? `${getPackageDirName(item.sourceFile)}.${item.name}` : item.name);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Surface builder
// ---------------------------------------------------------------------------

export function buildSurface(
  allStructs: GoStruct[],
  allTypes: GoTypeDecl[],
  allFuncs: GoFunc[],
  allConsts: GoConst[],
): {
  classes: Record<string, ApiClass>;
  interfaces: Record<string, ApiInterface>;
  typeAliases: Record<string, ApiTypeAlias>;
  enums: Record<string, ApiEnum>;
  exports: Record<string, string[]>;
} {
  const classes: Record<string, ApiClass> = {};
  const interfaces: Record<string, ApiInterface> = {};
  const typeAliases: Record<string, ApiTypeAlias> = {};
  const enums: Record<string, ApiEnum> = {};
  const exports: Record<string, string[]> = {};

  // Group consts by (packageName, typeName)
  const constsByPkgAndType = new Map<string, GoConst[]>();
  for (const c of allConsts) {
    const key = `${c.packageName}:${c.typeName}`;
    if (!constsByPkgAndType.has(key)) constsByPkgAndType.set(key, []);
    constsByPkgAndType.get(key)!.push(c);
  }

  // Group methods by (packageName, receiverType)
  const methodsByPkgAndReceiver = new Map<string, GoFunc[]>();
  const packageFuncs: GoFunc[] = [];
  for (const fn of allFuncs) {
    if (fn.receiverType) {
      const key = `${fn.packageName}:${fn.receiverType}`;
      if (!methodsByPkgAndReceiver.has(key)) methodsByPkgAndReceiver.set(key, []);
      methodsByPkgAndReceiver.get(key)!.push(fn);
    } else {
      packageFuncs.push(fn);
    }
  }

  // Build qualified names
  const allSymbols: Array<{ name: string; packageName: string; sourceFile: string }> = [];
  for (const s of allStructs) allSymbols.push({ name: s.name, packageName: s.packageName, sourceFile: s.sourceFile });
  for (const t of allTypes) allSymbols.push({ name: t.name, packageName: t.packageName, sourceFile: t.sourceFile });
  const qualifiedNames = buildQualifiedNames(allSymbols);

  // Process type declarations
  for (const typeDecl of allTypes) {
    const qName = qualifiedNames.get(`${typeDecl.sourceFile}:${typeDecl.name}`) || typeDecl.name;
    const typeConsts = constsByPkgAndType.get(`${typeDecl.packageName}:${typeDecl.name}`);

    if (typeDecl.isAlias) {
      typeAliases[qName] = {
        name: qName,
        sourceFile: typeDecl.sourceFile,
        value: goTypeToString(typeDecl.underlyingType),
      };
    } else if (typeConsts && typeConsts.length > 0) {
      const members: Record<string, string | number> = {};
      for (const c of typeConsts) members[c.name] = c.value;
      enums[qName] = { name: qName, sourceFile: typeDecl.sourceFile, members: sortRecord(members) };
    } else {
      typeAliases[qName] = {
        name: qName,
        sourceFile: typeDecl.sourceFile,
        value: goTypeToString(typeDecl.underlyingType),
      };
    }
  }

  // Process structs
  for (const s of allStructs) {
    const qName = qualifiedNames.get(`${s.sourceFile}:${s.name}`) || s.name;
    const methods = methodsByPkgAndReceiver.get(`${s.packageName}:${s.name}`);

    if (methods && methods.length > 0) {
      const apiMethods: Record<string, ApiMethod[]> = {};
      const properties: Record<string, ApiProperty> = {};

      for (const field of s.fields) {
        properties[field.name] = { name: field.name, type: goTypeToString(field.type), readonly: false };
      }

      for (const fn of methods) {
        const params: ApiParam[] = fn.params
          .filter((p) => p.type !== 'context.Context')
          .map((p) => ({ name: p.name, type: goTypeToString(p.type), optional: false }));
        if (!apiMethods[fn.name]) apiMethods[fn.name] = [];
        apiMethods[fn.name].push({ name: fn.name, params, returnType: buildReturnType(fn.returnTypes), async: false });
      }

      classes[qName] = {
        name: qName,
        sourceFile: s.sourceFile,
        methods: sortRecord(apiMethods),
        properties: sortRecord(properties),
        constructorParams: [],
      };
    } else {
      const fields: Record<string, ApiField> = {};
      for (const field of s.fields) {
        const fieldName = field.jsonTag || field.name;
        fields[fieldName] = { name: fieldName, type: goTypeToString(field.type), optional: field.optional };
      }
      interfaces[qName] = { name: qName, sourceFile: s.sourceFile, fields: sortRecord(fields), extends: [] };
    }
  }

  // Build export map
  const exportsByFile = new Map<string, Set<string>>();
  function addExport(sourceFile: string, name: string) {
    if (!exportsByFile.has(sourceFile)) exportsByFile.set(sourceFile, new Set());
    exportsByFile.get(sourceFile)!.add(name);
  }

  for (const [name, cls] of Object.entries(classes)) if (cls.sourceFile) addExport(cls.sourceFile, name);
  for (const [name, iface] of Object.entries(interfaces)) if (iface.sourceFile) addExport(iface.sourceFile, name);
  for (const [name, ta] of Object.entries(typeAliases)) if (ta.sourceFile) addExport(ta.sourceFile, name);
  for (const [name, en] of Object.entries(enums)) if (en.sourceFile) addExport(en.sourceFile, name);
  for (const c of allConsts) {
    const typeDecl = allTypes.find((t) => t.name === c.typeName && t.packageName === c.packageName);
    if (typeDecl) addExport(typeDecl.sourceFile, c.name);
  }
  for (const fn of packageFuncs) addExport(fn.sourceFile, fn.name);

  for (const [file, names] of exportsByFile) exports[file] = [...names].sort();

  return {
    classes: sortRecord(classes),
    interfaces: sortRecord(interfaces),
    typeAliases: sortRecord(typeAliases),
    enums: sortRecord(enums),
    exports: sortRecord(exports),
  };
}
