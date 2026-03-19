/**
 * DotNet (.NET/C#) surface builder — transforms parsed C# symbols into an ApiSurface.
 */

import type {
  ApiClass,
  ApiMethod,
  ApiParam,
  ApiProperty,
  ApiInterface,
  ApiField,
  ApiEnum,
  LanguageHints,
} from '../types.js';
import type { CSharpClass, CSharpEnum } from './dotnet-parser.js';
import { sortRecord } from './shared.js';

// ---------------------------------------------------------------------------
// Surface builder
// ---------------------------------------------------------------------------

export function buildSurface(
  allClasses: CSharpClass[],
  allEnums: CSharpEnum[],
  _hints: LanguageHints,
): {
  classes: Record<string, ApiClass>;
  interfaces: Record<string, ApiInterface>;
  enums: Record<string, ApiEnum>;
  exports: Record<string, string[]>;
} {
  const classes: Record<string, ApiClass> = {};
  const interfaces: Record<string, ApiInterface> = {};
  const enums: Record<string, ApiEnum> = {};
  const exports: Record<string, string[]> = {};

  const exportsByFile = new Map<string, Set<string>>();
  function addExport(sourceFile: string, name: string) {
    if (!exportsByFile.has(sourceFile)) exportsByFile.set(sourceFile, new Set());
    exportsByFile.get(sourceFile)!.add(name);
  }

  // Process classes
  for (const cls of allClasses) {
    if (cls.isService) {
      // Service class — has methods
      const methods: Record<string, ApiMethod[]> = {};
      const properties: Record<string, ApiProperty> = {};

      for (const method of cls.methods) {
        const params: ApiParam[] = method.params.map((p) => ({
          name: p.name,
          type: p.type,
          optional: p.optional,
        }));

        if (!methods[method.name]) methods[method.name] = [];
        methods[method.name].push({
          name: method.name,
          params,
          returnType: method.returnType,
          async: method.isAsync,
        });
      }

      // Add public properties to service class
      for (const prop of cls.properties) {
        const propName = prop.jsonName || prop.name;
        properties[propName] = {
          name: propName,
          type: prop.type,
          readonly: prop.readonly,
        };
      }

      const constructorParams: ApiParam[] = cls.constructorParams.map((p) => ({
        name: p.name,
        type: p.type,
        optional: false,
      }));

      classes[cls.name] = {
        name: cls.name,
        sourceFile: cls.sourceFile,
        methods: sortRecord(methods),
        properties: sortRecord(properties),
        constructorParams,
      };
    } else {
      // Data class — no methods, treat as interface
      const fields: Record<string, ApiField> = {};
      for (const prop of cls.properties) {
        const fieldName = prop.jsonName || prop.name;
        const isNullable = prop.type.endsWith('?');
        fields[fieldName] = {
          name: fieldName,
          type: prop.type,
          optional: isNullable,
        };
      }

      interfaces[cls.name] = {
        name: cls.name,
        sourceFile: cls.sourceFile,
        fields: sortRecord(fields),
        extends: [],
      };
    }
    addExport(cls.sourceFile, cls.name);
  }

  // Process enums
  for (const en of allEnums) {
    enums[en.name] = {
      name: en.name,
      sourceFile: en.sourceFile,
      members: sortRecord(en.members),
    };
    addExport(en.sourceFile, en.name);
  }

  // Build export map
  for (const [file, names] of exportsByFile) {
    exports[file] = [...names].sort();
  }

  return {
    classes: sortRecord(classes),
    interfaces: sortRecord(interfaces),
    enums: sortRecord(enums),
    exports: sortRecord(exports),
  };
}
