/**
 * Rust surface builder — transforms parsed Rust symbols into an ApiSurface.
 *
 * Mapping:
 *   pub struct + impl methods → ApiClass
 *   pub struct (no methods)   → ApiInterface (data-only)
 *   pub enum                  → ApiEnum (serde renames as member values)
 *   pub type X = Y            → ApiTypeAlias
 *   pub trait                 → ApiClass (trait methods as API surface)
 */

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
import type { RustStruct, RustEnum, RustFunc, RustTrait, RustTypeAlias as RustTypeAliasType } from './rust-parser.js';
import { sortRecord } from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rustTypeToString(t: string): string {
  return t;
}

/** Strip Result<T, E> to just T. */
function unwrapResultType(returnType: string): string {
  const match = returnType.match(/^Result\s*<\s*(.+)\s*,\s*.+\s*>$/);
  if (match) return match[1].trim();
  return returnType;
}

// ---------------------------------------------------------------------------
// Surface builder
// ---------------------------------------------------------------------------

export function buildSurface(
  allStructs: RustStruct[],
  allEnums: RustEnum[],
  allFuncs: RustFunc[],
  allTraits: RustTrait[],
  allTypeAliases: RustTypeAliasType[],
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

  // Group impl methods by receiver type
  const methodsByReceiver = new Map<string, RustFunc[]>();
  for (const fn of allFuncs) {
    if (!fn.receiverType) continue;
    if (!methodsByReceiver.has(fn.receiverType)) methodsByReceiver.set(fn.receiverType, []);
    methodsByReceiver.get(fn.receiverType)!.push(fn);
  }

  // Process structs
  for (const s of allStructs) {
    const methods = methodsByReceiver.get(s.name);

    if (methods && methods.length > 0) {
      // Struct with impl methods → ApiClass
      const apiMethods: Record<string, ApiMethod[]> = {};
      const properties: Record<string, ApiProperty> = {};

      for (const field of s.fields) {
        const fieldName = field.serdeRename || field.name;
        properties[fieldName] = {
          name: fieldName,
          type: rustTypeToString(field.type),
          readonly: false,
        };
      }

      for (const fn of methods) {
        const params: ApiParam[] = fn.params.map((p) => ({
          name: p.name,
          type: rustTypeToString(p.type),
          optional: p.type.startsWith('Option<'),
        }));
        const returnType = unwrapResultType(fn.returnType);
        if (!apiMethods[fn.name]) apiMethods[fn.name] = [];
        apiMethods[fn.name].push({
          name: fn.name,
          params,
          returnType: rustTypeToString(returnType),
          async: fn.isAsync,
        });
      }

      classes[s.name] = {
        name: s.name,
        sourceFile: s.sourceFile,
        methods: sortRecord(apiMethods),
        properties: sortRecord(properties),
        constructorParams: [],
      };
    } else {
      // Struct without methods → ApiInterface
      const fields: Record<string, ApiField> = {};
      for (const field of s.fields) {
        const fieldName = field.serdeRename || field.name;
        fields[fieldName] = {
          name: fieldName,
          type: rustTypeToString(field.type),
          optional: field.optional,
        };
      }
      interfaces[s.name] = {
        name: s.name,
        sourceFile: s.sourceFile,
        fields: sortRecord(fields),
        extends: [],
      };
    }
  }

  // Process enums
  for (const e of allEnums) {
    const members: Record<string, string | number> = {};
    for (const v of e.variants) {
      members[v.name] = v.serdeRename || v.name;
    }
    enums[e.name] = { name: e.name, sourceFile: e.sourceFile, members: sortRecord(members) };
  }

  // Process type aliases
  for (const ta of allTypeAliases) {
    typeAliases[ta.name] = { name: ta.name, sourceFile: ta.sourceFile, value: rustTypeToString(ta.underlyingType) };
  }

  // Process traits → ApiClass (trait methods define the API contract)
  for (const trait of allTraits) {
    const apiMethods: Record<string, ApiMethod[]> = {};

    for (const fn of trait.methods) {
      const params: ApiParam[] = fn.params.map((p) => ({
        name: p.name,
        type: rustTypeToString(p.type),
        optional: p.type.startsWith('Option<'),
      }));
      const returnType = unwrapResultType(fn.returnType);
      if (!apiMethods[fn.name]) apiMethods[fn.name] = [];
      apiMethods[fn.name].push({
        name: fn.name,
        params,
        returnType: rustTypeToString(returnType),
        async: fn.isAsync,
      });
    }

    classes[trait.name] = {
      name: trait.name,
      sourceFile: trait.sourceFile,
      methods: sortRecord(apiMethods),
      properties: {},
      constructorParams: [],
    };
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

  for (const [file, names] of exportsByFile) exports[file] = [...names].sort();

  return {
    classes: sortRecord(classes),
    interfaces: sortRecord(interfaces),
    typeAliases: sortRecord(typeAliases),
    enums: sortRecord(enums),
    exports: sortRecord(exports),
  };
}
