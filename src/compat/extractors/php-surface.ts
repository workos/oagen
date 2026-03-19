/**
 * PHP surface builder — transforms parsed PHP classes into an ApiSurface.
 *
 * Mapping:
 *   Class extending a resource base      → ApiInterface (fields from RESOURCE_ATTRIBUTES)
 *   Class with only constants             → ApiEnum (const values)
 *   Service class with public methods     → ApiClass
 *   Static utility class                  → ApiClass
 *   PHP interface declaration             → ApiInterface (methods as fields)
 *   Exception class                       → ApiClass
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
import type { PhpClass } from './php-parser.js';
import { sortRecord, ExportCollector } from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default resource base classes (empty — consumer provides via hints.modelBaseClasses). */
const DEFAULT_RESOURCE_BASES: string[] = [];

/** Default exception base classes. */
const DEFAULT_EXCEPTION_BASES = ['Exception', '\\Exception'];

/** Check if a class is a resource class (extends a known resource base and has attributes). */
function isResourceClass(cls: PhpClass, resourceBases: Set<string>): boolean {
  return !!cls.extends && resourceBases.has(cls.extends) && cls.resourceAttributes.length > 0;
}

/** Check if a class is enum-like (only constants, no public methods). */
function isEnumClass(cls: PhpClass): boolean {
  if (cls.isInterface) return false;
  if (cls.constants.length === 0) return false;
  // Must have only constants — no public instance methods (excluding inherited)
  const publicMethods = cls.methods.filter((m) => m.visibility === 'public' && m.name !== '__construct');
  return publicMethods.length === 0 && cls.properties.length === 0 && !cls.extends;
}

/** Check if a class is an exception. */
function isExceptionClass(cls: PhpClass, exceptionBases: Set<string>): boolean {
  if (!cls.extends) return false;
  return exceptionBases.has(cls.extends);
}

// ---------------------------------------------------------------------------
// Surface builder
// ---------------------------------------------------------------------------

export function buildSurface(
  allClasses: PhpClass[],
  hints?: LanguageHints,
): {
  classes: Record<string, ApiClass>;
  interfaces: Record<string, ApiInterface>;
  enums: Record<string, ApiEnum>;
  exports: Record<string, string[]>;
} {
  const resourceBases = new Set(hints?.modelBaseClasses ?? DEFAULT_RESOURCE_BASES);
  const exceptionBases = new Set(hints?.exceptionBaseClasses ?? DEFAULT_EXCEPTION_BASES);

  const classes: Record<string, ApiClass> = {};
  const interfaces: Record<string, ApiInterface> = {};
  const enums: Record<string, ApiEnum> = {};

  const collector = new ExportCollector();

  for (const cls of allClasses) {
    if (cls.isInterface) {
      // PHP interface → ApiInterface
      const fields: Record<string, ApiField> = {};
      for (const method of cls.methods) {
        if (method.visibility !== 'public') continue;
        fields[method.name] = {
          name: method.name,
          type: method.returnType || 'mixed',
          optional: false,
        };
      }
      interfaces[cls.name] = {
        name: cls.name,
        sourceFile: cls.sourceFile,
        fields: sortRecord(fields),
        extends: [],
      };
      collector.add(cls.sourceFile, cls.name);
    } else if (isResourceClass(cls, resourceBases)) {
      // Resource class → ApiInterface with fields from RESOURCE_ATTRIBUTES
      const fields: Record<string, ApiField> = {};
      for (const attr of cls.resourceAttributes) {
        fields[attr] = {
          name: attr,
          type: 'mixed',
          optional: false,
        };
      }
      interfaces[cls.name] = {
        name: cls.name,
        sourceFile: cls.sourceFile,
        fields: sortRecord(fields),
        extends: cls.extends ? [cls.extends] : [],
      };
      collector.add(cls.sourceFile, cls.name);
    } else if (isEnumClass(cls)) {
      // Enum-like class → ApiEnum
      const members: Record<string, string | number> = {};
      for (const constant of cls.constants) {
        members[constant.name] = constant.value;
      }
      enums[cls.name] = {
        name: cls.name,
        sourceFile: cls.sourceFile,
        members: sortRecord(members),
      };
      collector.add(cls.sourceFile, cls.name);
    } else {
      // Service class, static utility class, or exception → ApiClass
      const apiMethods: Record<string, ApiMethod[]> = {};
      const properties: Record<string, ApiProperty> = {};

      // Only include public methods
      for (const method of cls.methods) {
        if (method.visibility !== 'public') continue;

        const params: ApiParam[] = method.params.map((p) => ({
          name: p.name,
          type: p.type,
          optional: p.optional,
        }));

        if (!apiMethods[method.name]) apiMethods[method.name] = [];
        apiMethods[method.name].push({
          name: method.name,
          params,
          returnType: method.returnType || 'mixed',
          async: false, // PHP is synchronous
        });
      }

      // Include public properties
      for (const prop of cls.properties) {
        if (prop.visibility !== 'public') continue;
        properties[prop.name] = {
          name: prop.name,
          type: prop.type,
          readonly: false,
        };
      }

      // Only add if there's something meaningful (methods or properties)
      if (
        Object.keys(apiMethods).length > 0 ||
        Object.keys(properties).length > 0 ||
        isExceptionClass(cls, exceptionBases)
      ) {
        classes[cls.name] = {
          name: cls.name,
          sourceFile: cls.sourceFile,
          methods: sortRecord(apiMethods),
          properties: sortRecord(properties),
          constructorParams: [],
        };
        collector.add(cls.sourceFile, cls.name);
      }
    }
  }

  const exports = collector.toRecord();

  return {
    classes: sortRecord(classes),
    interfaces: sortRecord(interfaces),
    enums: sortRecord(enums),
    exports: sortRecord(exports),
  };
}
