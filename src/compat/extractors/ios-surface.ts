/**
 * Swift surface builder — transforms parsed Swift symbols into an ApiSurface.
 *
 * Classification rules:
 *  - A struct with no public methods is a data model → ApiInterface, with its
 *    stored properties as fields (Swift property names are the public API;
 *    wire names live in the private CodingKeys enum).
 *  - Anything with public methods is a service → ApiClass.
 *  - Extension-contributed members merge into their extended type; when the
 *    extended type's own declaration is hand-maintained (skipped by the
 *    parser), the extension entry stands alone with the extension's source
 *    file. This is how `WorkOSClient+Resources.swift` accessors survive
 *    manifest filtering while the hand-written client core does not.
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
import type { SwiftTypeDecl, SwiftEnum, SwiftTypeAlias } from './ios-parser.js';
import { sortRecord, ExportCollector } from './shared.js';

interface MergedType {
  name: string;
  /** Kind of the type's own declaration; null when only extensions were seen. */
  declKind: 'struct' | 'class' | 'actor' | null;
  properties: SwiftTypeDecl['properties'];
  methods: SwiftTypeDecl['methods'];
  initOverloads: SwiftTypeDecl['initOverloads'];
  sourceFile: string;
}

function mergeTypes(allTypes: SwiftTypeDecl[]): MergedType[] {
  const byName = new Map<string, MergedType>();
  for (const decl of allTypes) {
    let entry = byName.get(decl.name);
    if (!entry) {
      entry = {
        name: decl.name,
        declKind: null,
        properties: [],
        methods: [],
        initOverloads: [],
        sourceFile: decl.sourceFile,
      };
      byName.set(decl.name, entry);
    }
    if (decl.kind !== 'extension' && entry.declKind === null) {
      entry.declKind = decl.kind;
      entry.sourceFile = decl.sourceFile;
    }
    entry.properties.push(...decl.properties);
    entry.methods.push(...decl.methods);
    entry.initOverloads.push(...decl.initOverloads);
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// Surface builder
// ---------------------------------------------------------------------------

export function buildSurface(
  allTypes: SwiftTypeDecl[],
  allEnums: SwiftEnum[],
  allTypeAliases: SwiftTypeAlias[],
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

  const collector = new ExportCollector();

  for (const type of mergeTypes(allTypes)) {
    // Data model: a struct (or struct-less property bag from extensions of a
    // struct) with no callable surface → interface with fields.
    if (type.declKind === 'struct' && type.methods.length === 0) {
      if (type.properties.length === 0) continue;
      const fields: Record<string, ApiField> = {};
      for (const prop of type.properties) {
        fields[prop.name] = {
          name: prop.name,
          type: prop.type,
          optional: prop.optional,
        };
      }
      interfaces[type.name] = {
        name: type.name,
        sourceFile: type.sourceFile,
        fields: sortRecord(fields),
        extends: [],
      };
      collector.add(type.sourceFile, type.name);
      continue;
    }

    // Service / client surface → class with methods and properties.
    if (type.methods.length === 0 && type.properties.length === 0) continue;

    const methods: Record<string, ApiMethod[]> = {};
    for (const method of type.methods) {
      // Swift argument labels are required at the call site AND fixed in
      // declaration order, so parameters model as labeled positional args.
      const params: ApiParam[] = method.params.map((p) => ({
        name: p.name,
        type: p.type,
        optional: p.optional,
        passingStyle: 'positional' as const,
      }));

      if (!methods[method.name]) methods[method.name] = [];
      methods[method.name].push({
        name: method.name,
        params,
        returnType: method.returnType,
        async: method.async,
        isStatic: method.isStatic,
      });
    }

    const properties: Record<string, ApiProperty> = {};
    for (const prop of type.properties) {
      properties[prop.name] = {
        name: prop.name,
        type: prop.type,
        readonly: prop.readonly,
      };
    }

    const constructorParams: ApiParam[] = (type.initOverloads[0] ?? []).map((p) => ({
      name: p.name,
      type: p.type,
      optional: p.optional,
      passingStyle: 'positional' as const,
    }));

    classes[type.name] = {
      name: type.name,
      sourceFile: type.sourceFile,
      methods: sortRecord(methods),
      properties: sortRecord(properties),
      constructorParams,
    };
    collector.add(type.sourceFile, type.name);
  }

  for (const en of allEnums) {
    enums[en.name] = {
      name: en.name,
      sourceFile: en.sourceFile,
      members: sortRecord(en.members),
    };
    collector.add(en.sourceFile, en.name);
  }

  for (const ta of allTypeAliases) {
    typeAliases[ta.name] = {
      name: ta.name,
      sourceFile: ta.sourceFile,
      value: ta.value,
    };
    collector.add(ta.sourceFile, ta.name);
  }

  return {
    classes: sortRecord(classes),
    interfaces: sortRecord(interfaces),
    typeAliases: sortRecord(typeAliases),
    enums: sortRecord(enums),
    exports: sortRecord(collector.toRecord()),
  };
}
