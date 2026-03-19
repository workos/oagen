/**
 * Elixir surface builder — transforms parsed Elixir symbols into an ApiSurface.
 *
 * Elixir conventions:
 * - Data types (defstruct) → ApiInterface
 * - Modules with public functions → ApiClass
 * - Enum-like modules (with value functions) → ApiEnum
 */

import type { ApiClass, ApiMethod, ApiParam, ApiInterface, ApiField, ApiEnum } from '../types.js';
import type { ElixirStruct, ElixirFunction, ElixirEnumModule, ElixirTypeSpec } from './elixir-parser.js';
import { sortRecord } from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the short name from a fully qualified Elixir module name. */
function shortName(moduleName: string): string {
  const parts = moduleName.split('.');
  return parts[parts.length - 1];
}

// ---------------------------------------------------------------------------
// Surface builder
// ---------------------------------------------------------------------------

export function buildSurface(
  allStructs: ElixirStruct[],
  allFunctions: ElixirFunction[],
  allEnumModules: ElixirEnumModule[],
  allTypeSpecs: ElixirTypeSpec[],
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

  // Collect struct module names so we can distinguish struct modules from service modules
  const structModuleNames = new Set(allStructs.map((s) => s.moduleName));
  const enumModuleNames = new Set(allEnumModules.map((e) => e.moduleName));

  // Process structs as interfaces
  for (const struct of allStructs) {
    const name = shortName(struct.moduleName);
    const fields: Record<string, ApiField> = {};

    // Build fields from struct keys — types come from @type spec if available
    const typeSpec = allTypeSpecs.find((ts) => ts.moduleName === struct.moduleName && ts.name === 't');

    for (const field of struct.fields) {
      // Try to extract type from the @type spec
      let fieldType = 'any';
      let optional = false;

      if (typeSpec) {
        // Parse the type definition to find this field's type
        const fieldPrefix = field + ':';
        const prefixIdx = typeSpec.definition.indexOf(fieldPrefix);
        const fieldTypeMatch = prefixIdx >= 0
          ? typeSpec.definition.slice(prefixIdx + fieldPrefix.length).match(/^\s*([^,}]+)/)
          : null;
        if (fieldTypeMatch) {
          fieldType = fieldTypeMatch[1].trim();
          // Check if nullable (contains | nil)
          if (fieldType.includes('| nil') || fieldType.includes('nil |')) {
            optional = true;
            fieldType = fieldType
              .replace(/\s*\|\s*nil/g, '')
              .replace(/nil\s*\|\s*/g, '')
              .trim();
          }
        }
      }

      fields[field] = {
        name: field,
        type: fieldType,
        optional,
      };
    }

    interfaces[name] = {
      name,
      sourceFile: struct.sourceFile,
      fields: sortRecord(fields),
      extends: [],
    };
    addExport(struct.sourceFile, name);
  }

  // Process enum modules
  for (const enumModule of allEnumModules) {
    const name = shortName(enumModule.moduleName);
    enums[name] = {
      name,
      sourceFile: enumModule.sourceFile,
      members: sortRecord(enumModule.members),
    };
    addExport(enumModule.sourceFile, name);
  }

  // Group public functions by module
  const funcsByModule = new Map<string, ElixirFunction[]>();
  for (const func of allFunctions) {
    if (func.isPrivate) continue;

    // Skip functions from struct modules (they are data, not services)
    // and enum modules (already handled)
    if (structModuleNames.has(func.moduleName) && !funcsByModule.has(func.moduleName)) {
      // Struct modules might still have functions, but only if they have
      // functions beyond just struct-related ones
    }
    if (enumModuleNames.has(func.moduleName)) continue;

    if (!funcsByModule.has(func.moduleName)) funcsByModule.set(func.moduleName, []);
    funcsByModule.get(func.moduleName)!.push(func);
  }

  // Convert function modules to classes
  for (const [moduleName, funcs] of funcsByModule) {
    // Skip if this is a struct-only module (no meaningful functions)
    if (structModuleNames.has(moduleName)) continue;

    const name = shortName(moduleName);
    const methods: Record<string, ApiMethod[]> = {};

    // Deduplicate by function name (Elixir allows multiple clauses)
    const seenFuncs = new Set<string>();
    for (const func of funcs) {
      if (seenFuncs.has(func.name)) continue;
      seenFuncs.add(func.name);

      const params: ApiParam[] = func.params.map((p) => ({
        name: p,
        type: 'any',
        optional: false,
      }));

      if (!methods[func.name]) methods[func.name] = [];
      methods[func.name].push({
        name: func.name,
        params,
        returnType: 'any',
        async: false,
      });
    }

    if (Object.keys(methods).length > 0) {
      classes[name] = {
        name,
        sourceFile: funcs[0].sourceFile,
        methods: sortRecord(methods),
        properties: {},
        constructorParams: [],
      };
      addExport(funcs[0].sourceFile, name);
    }
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
