/**
 * Python surface builder — transforms parsed Python symbols into an ApiSurface.
 *
 * Mapping:
 *   class Foo(BaseModel/custom model)  → ApiInterface (fields from annotations)
 *   class Foo(TypedDict)              → ApiInterface (fields)
 *   class Foo(Protocol)               → ApiClass (canonical service)
 *   Sync/Async impl classes           → skip (Protocol takes precedence)
 *   FooType = Literal[...]            → ApiEnum (members = literal strings)
 *   FooResource = ListResource[...]    → ApiTypeAlias
 *   Exception subclass                → ApiClass
 *   Other class with methods          → ApiClass
 */

import type {
  ApiClass,
  ApiMethod,
  ApiParam,
  ApiInterface,
  ApiField,
  ApiTypeAlias,
  ApiEnum,
  LanguageHints,
} from '../types.js';
import type { PythonClass, ParsedPythonFile } from './python-parser.js';
import { sortRecord } from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default model base classes. Overridden by hints.modelBaseClasses when provided. */
const DEFAULT_MODEL_BASES: string[] = [];

/** Known dict-like base classes (→ ApiInterface). */
const DICT_BASES = new Set(['TypedDict']);

/** Known protocol bases (→ ApiClass as service). */
const PROTOCOL_BASES = new Set(['Protocol']);

/** Default exception bases. Overridden by hints.exceptionBaseClasses when provided. */
const DEFAULT_EXCEPTION_BASES = ['Exception', 'BaseException'];

/** Check if a class has any of the given base classes (by simple name). */
function hasBase(cls: PythonClass, bases: Set<string>): boolean {
  return cls.bases.some((b) => bases.has(b));
}

/** Check if a class is a model class (inherits from BaseModel or configured model bases,
 *  transitively from another class that does). */
function isModelClass(cls: PythonClass, allClasses: Map<string, PythonClass>, modelBases: Set<string>): boolean {
  if (hasBase(cls, modelBases)) return true;
  // Check transitively: if parent class is a model
  for (const base of cls.bases) {
    const parentCls = allClasses.get(base);
    if (parentCls && isModelClass(parentCls, allClasses, modelBases)) return true;
  }
  return false;
}

/** Check if a class is an exception class. */
function isExceptionClass(
  cls: PythonClass,
  allClasses: Map<string, PythonClass>,
  exceptionBases: Set<string>,
): boolean {
  if (hasBase(cls, exceptionBases)) return true;
  for (const base of cls.bases) {
    const parentCls = allClasses.get(base);
    if (parentCls && isExceptionClass(parentCls, allClasses, exceptionBases)) return true;
  }
  return false;
}

/** Parse Literal["a", "b", "c"] into member strings. */
function parseLiteralMembers(value: string): Record<string, string> | null {
  const match = value.match(/^Literal\[(.+)\]$/s);
  if (!match) return null;

  const inner = match[1];
  const members: Record<string, string> = {};

  // Split by comma, handling nested brackets
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of inner) {
    if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    // Strip quotes
    const stripped = part.replace(/^["']|["']$/g, '');
    if (stripped) {
      members[stripped] = stripped;
    }
  }

  return Object.keys(members).length > 0 ? members : null;
}

/** Unwrap SyncOrAsync[T] → T. */
function unwrapReturnType(returnType: string): string {
  const syncOrAsyncMatch = returnType.match(/^SyncOrAsync\[(.+)\]$/);
  if (syncOrAsyncMatch) return syncOrAsyncMatch[1];
  const awaitableMatch = returnType.match(/^Awaitable\[(.+)\]$/);
  if (awaitableMatch) return awaitableMatch[1];
  return returnType;
}

// ---------------------------------------------------------------------------
// Surface builder
// ---------------------------------------------------------------------------

export function buildSurface(
  parsedFiles: ParsedPythonFile[],
  hints?: LanguageHints,
): {
  classes: Record<string, ApiClass>;
  interfaces: Record<string, ApiInterface>;
  typeAliases: Record<string, ApiTypeAlias>;
  enums: Record<string, ApiEnum>;
  exports: Record<string, string[]>;
} {
  const MODEL_BASES = new Set(hints?.modelBaseClasses ?? DEFAULT_MODEL_BASES);
  const EXCEPTION_BASES = new Set(hints?.exceptionBaseClasses ?? DEFAULT_EXCEPTION_BASES);

  const classes: Record<string, ApiClass> = {};
  const interfaces: Record<string, ApiInterface> = {};
  const typeAliases: Record<string, ApiTypeAlias> = {};
  const enums: Record<string, ApiEnum> = {};
  const exports: Record<string, string[]> = {};

  // Collect all classes for transitive base lookups
  const allClassesByName = new Map<string, PythonClass>();
  for (const file of parsedFiles) {
    for (const cls of file.classes) {
      allClassesByName.set(cls.name, cls);
    }
  }

  // Track protocol class names to skip sync/async impls
  const protocolNames = new Set<string>();
  for (const file of parsedFiles) {
    for (const cls of file.classes) {
      if (hasBase(cls, PROTOCOL_BASES)) {
        protocolNames.add(cls.name);
      }
    }
  }

  // Build export map from __all__ and file-level symbols
  const exportsByFile = new Map<string, Set<string>>();
  function addExport(sourceFile: string, name: string) {
    if (!exportsByFile.has(sourceFile)) exportsByFile.set(sourceFile, new Set());
    exportsByFile.get(sourceFile)!.add(name);
  }

  for (const file of parsedFiles) {
    // Process type aliases
    for (const alias of file.typeAliases) {
      const literalMembers = parseLiteralMembers(alias.value);
      if (literalMembers) {
        // Literal type alias → ApiEnum
        enums[alias.name] = {
          name: alias.name,
          sourceFile: alias.sourceFile,
          members: sortRecord(literalMembers),
        };
        addExport(alias.sourceFile, alias.name);
      } else {
        // Regular type alias → ApiTypeAlias
        typeAliases[alias.name] = {
          name: alias.name,
          sourceFile: alias.sourceFile,
          value: alias.value,
        };
        addExport(alias.sourceFile, alias.name);
      }
    }

    // Process classes
    for (const cls of file.classes) {
      // 1. Protocol classes → ApiClass (canonical service)
      if (hasBase(cls, PROTOCOL_BASES)) {
        const apiMethods: Record<string, ApiMethod[]> = {};

        for (const method of cls.methods) {
          // Skip __init__ for protocols (they don't have constructors)
          if (method.name === '__init__') continue;

          const params: ApiParam[] = method.params.map((p) => ({
            name: p.name,
            type: p.type,
            optional: p.optional,
          }));

          const returnType = unwrapReturnType(method.returnType);

          if (!apiMethods[method.name]) apiMethods[method.name] = [];
          apiMethods[method.name].push({
            name: method.name,
            params,
            returnType,
            async: method.isAsync,
          });
        }

        classes[cls.name] = {
          name: cls.name,
          sourceFile: cls.sourceFile,
          methods: sortRecord(apiMethods),
          properties: {},
          constructorParams: [],
        };
        addExport(cls.sourceFile, cls.name);
        continue;
      }

      // 2. Model classes (BaseModel or configured model bases) → ApiInterface
      if (isModelClass(cls, allClassesByName, MODEL_BASES)) {
        const fields: Record<string, ApiField> = {};
        for (const field of cls.fields) {
          fields[field.name] = {
            name: field.name,
            type: field.type,
            optional: field.hasDefault,
          };
        }

        // Compute extends list: filter out model bases themselves
        const extendsArr = cls.bases.filter((b) => !MODEL_BASES.has(b) && allClassesByName.has(b));

        interfaces[cls.name] = {
          name: cls.name,
          sourceFile: cls.sourceFile,
          fields: sortRecord(fields),
          extends: extendsArr,
        };
        addExport(cls.sourceFile, cls.name);
        continue;
      }

      // 3. TypedDict classes → ApiInterface
      if (hasBase(cls, DICT_BASES)) {
        const fields: Record<string, ApiField> = {};
        for (const field of cls.fields) {
          fields[field.name] = {
            name: field.name,
            type: field.type,
            optional: field.hasDefault,
          };
        }

        interfaces[cls.name] = {
          name: cls.name,
          sourceFile: cls.sourceFile,
          fields: sortRecord(fields),
          extends: [],
        };
        addExport(cls.sourceFile, cls.name);
        continue;
      }

      // 4. Exception classes → ApiClass
      if (isExceptionClass(cls, allClassesByName, EXCEPTION_BASES)) {
        const apiMethods: Record<string, ApiMethod[]> = {};
        // Extract any non-private, non-init methods
        for (const method of cls.methods) {
          if (method.name === '__init__') continue;
          const params: ApiParam[] = method.params.map((p) => ({
            name: p.name,
            type: p.type,
            optional: p.optional,
          }));
          if (!apiMethods[method.name]) apiMethods[method.name] = [];
          apiMethods[method.name].push({
            name: method.name,
            params,
            returnType: unwrapReturnType(method.returnType),
            async: method.isAsync,
          });
        }

        // Exception fields as properties if they have annotations
        const fields: Record<string, ApiField> = {};
        for (const field of cls.fields) {
          fields[field.name] = {
            name: field.name,
            type: field.type,
            optional: field.hasDefault,
          };
        }

        classes[cls.name] = {
          name: cls.name,
          sourceFile: cls.sourceFile,
          methods: sortRecord(apiMethods),
          properties: {},
          constructorParams: [],
        };
        addExport(cls.sourceFile, cls.name);
        continue;
      }

      // 5. Other class with methods → ApiClass
      if (cls.methods.length > 0) {
        const apiMethods: Record<string, ApiMethod[]> = {};
        const constructorParams: ApiParam[] = [];

        for (const method of cls.methods) {
          if (method.name === '__init__') {
            constructorParams.push(
              ...method.params.map((p) => ({
                name: p.name,
                type: p.type,
                optional: p.optional,
              })),
            );
            continue;
          }

          const params: ApiParam[] = method.params.map((p) => ({
            name: p.name,
            type: p.type,
            optional: p.optional,
          }));
          if (!apiMethods[method.name]) apiMethods[method.name] = [];
          apiMethods[method.name].push({
            name: method.name,
            params,
            returnType: unwrapReturnType(method.returnType),
            async: method.isAsync,
          });
        }

        classes[cls.name] = {
          name: cls.name,
          sourceFile: cls.sourceFile,
          methods: sortRecord(apiMethods),
          properties: {},
          constructorParams,
        };
        addExport(cls.sourceFile, cls.name);
        continue;
      }

      // 6. Class with only fields and no methods → ApiInterface
      if (cls.fields.length > 0) {
        const fields: Record<string, ApiField> = {};
        for (const field of cls.fields) {
          fields[field.name] = {
            name: field.name,
            type: field.type,
            optional: field.hasDefault,
          };
        }
        interfaces[cls.name] = {
          name: cls.name,
          sourceFile: cls.sourceFile,
          fields: sortRecord(fields),
          extends: [],
        };
        addExport(cls.sourceFile, cls.name);
      }
    }

    // Add __all__ exports
    if (file.allExports.length > 0) {
      for (const name of file.allExports) {
        addExport(file.sourceFile, name);
      }
    }
  }

  // Convert export map
  for (const [file, names] of exportsByFile) {
    exports[file] = [...names].sort();
  }

  return {
    classes: sortRecord(classes),
    interfaces: sortRecord(interfaces),
    typeAliases: sortRecord(typeAliases),
    enums: sortRecord(enums),
    exports: sortRecord(exports),
  };
}
