/**
 * Kotlin surface builder — transforms parsed Kotlin symbols into an ApiSurface.
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
import type { KotlinDataClass, KotlinClass, KotlinEnum, KotlinTypeAlias } from './kotlin-parser.js';
import { sortRecord, ExportCollector } from './shared.js';

// ---------------------------------------------------------------------------
// Surface builder
// ---------------------------------------------------------------------------

export function buildSurface(
  allDataClasses: KotlinDataClass[],
  allClasses: KotlinClass[],
  allEnums: KotlinEnum[],
  allTypeAliases: KotlinTypeAlias[],
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

  // Process data classes as interfaces (they represent data models)
  for (const dc of allDataClasses) {
    const fields: Record<string, ApiField> = {};
    for (const field of dc.fields) {
      const fieldName = field.jsonName || field.name;
      fields[fieldName] = {
        name: fieldName,
        type: field.type,
        optional: field.optional,
      };
    }
    interfaces[dc.name] = {
      name: dc.name,
      sourceFile: dc.sourceFile,
      fields: sortRecord(fields),
      extends: [],
    };
    collector.add(dc.sourceFile, dc.name);
  }

  // Process classes (service classes with methods)
  for (const cls of allClasses) {
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
        async: false,
      });
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
    collector.add(cls.sourceFile, cls.name);
  }

  // Process enums
  for (const en of allEnums) {
    enums[en.name] = {
      name: en.name,
      sourceFile: en.sourceFile,
      members: sortRecord(en.members),
    };
    collector.add(en.sourceFile, en.name);
  }

  // Process type aliases
  for (const ta of allTypeAliases) {
    typeAliases[ta.name] = {
      name: ta.name,
      sourceFile: ta.sourceFile,
      value: ta.value,
    };
    collector.add(ta.sourceFile, ta.name);
  }

  const exports = collector.toRecord();

  return {
    classes: sortRecord(classes),
    interfaces: sortRecord(interfaces),
    typeAliases: sortRecord(typeAliases),
    enums: sortRecord(enums),
    exports: sortRecord(exports),
  };
}
