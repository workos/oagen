import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type {
  ApiSurface,
  Extractor,
  ApiClass,
  ApiMethod,
  ApiParam,
  ApiProperty,
  ApiInterface,
  ApiField,
  ApiTypeAlias,
  ApiEnum,
} from '../types.js';

export const nodeExtractor: Extractor = {
  language: 'node',

  async extract(sdkPath: string): Promise<ApiSurface> {
    const configPath = ts.findConfigFile(sdkPath, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error(`No tsconfig.json found in ${sdkPath}`);

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, sdkPath);
    const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
    const checker = program.getTypeChecker();

    const entryPoint = resolveEntryPoint(sdkPath, program);
    const entrySourceFile = program.getSourceFile(entryPoint);
    if (!entrySourceFile) throw new Error(`Entry point not found: ${entryPoint}`);

    const moduleSymbol = checker.getSymbolAtLocation(entrySourceFile);
    if (!moduleSymbol) throw new Error('No exports found at entry point');

    const exportedSymbols = checker.getExportsOfModule(moduleSymbol);

    const classes: Record<string, ApiClass> = {};
    const interfaces: Record<string, ApiInterface> = {};
    const typeAliases: Record<string, ApiTypeAlias> = {};
    const enums: Record<string, ApiEnum> = {};

    for (const sym of exportedSymbols) {
      const resolved = resolveAlias(sym, checker);
      const declarations = resolved.getDeclarations();
      if (!declarations || declarations.length === 0) continue;
      const decl = declarations[0];

      if (ts.isClassDeclaration(decl)) {
        classes[resolved.name] = extractClass(resolved, checker);
      } else if (ts.isInterfaceDeclaration(decl)) {
        interfaces[resolved.name] = extractInterface(resolved, checker);
      } else if (ts.isTypeAliasDeclaration(decl)) {
        typeAliases[resolved.name] = extractTypeAlias(resolved, checker);
      } else if (ts.isEnumDeclaration(decl)) {
        enums[resolved.name] = extractEnum(resolved, checker);
      }
    }

    const exports = buildExportMap(entrySourceFile, checker, sdkPath);

    return {
      language: 'node',
      extractedFrom: sdkPath,
      extractedAt: new Date().toISOString(),
      classes: sortRecord(classes),
      interfaces: sortRecord(interfaces),
      typeAliases: sortRecord(typeAliases),
      enums: sortRecord(enums),
      exports: sortRecord(exports),
    };
  },
};

function resolveEntryPoint(sdkPath: string, program: ts.Program): string {
  const pkgPath = resolve(sdkPath, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    // Check "exports" field first
    if (pkg.exports) {
      const mainExport =
        typeof pkg.exports === 'string'
          ? pkg.exports
          : (pkg.exports['.']?.import ?? pkg.exports['.']?.default ?? pkg.exports['.']);
      if (typeof mainExport === 'string') {
        const resolved = resolveSourceFile(sdkPath, mainExport, program);
        if (resolved) return resolved;
      }
    }
    // Fallback to "main"
    if (pkg.main) {
      const resolved = resolveSourceFile(sdkPath, pkg.main, program);
      if (resolved) return resolved;
    }
  } catch {
    // No package.json or invalid — fall through to default
  }

  // Default fallback
  const fallback = resolve(sdkPath, 'src/index.ts');
  if (program.getSourceFile(fallback)) return fallback;
  throw new Error(`No entry point found. Tried: package.json exports/main, src/index.ts`);
}

function resolveSourceFile(sdkPath: string, entryPath: string, program: ts.Program): string | undefined {
  // Try the path as-is, then swap .js → .ts, then try index.ts
  const candidates = [
    resolve(sdkPath, entryPath),
    resolve(sdkPath, entryPath.replace(/\.js$/, '.ts')),
    resolve(sdkPath, entryPath.replace(/\.js$/, '/index.ts')),
  ];
  for (const candidate of candidates) {
    if (program.getSourceFile(candidate)) return candidate;
  }
  return undefined;
}

function resolveAlias(sym: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if (sym.flags & ts.SymbolFlags.Alias) {
    return checker.getAliasedSymbol(sym);
  }
  return sym;
}

function extractClass(sym: ts.Symbol, checker: ts.TypeChecker): ApiClass {
  const type = checker.getDeclaredTypeOfSymbol(sym);
  const methods: Record<string, ApiMethod> = {};
  const properties: Record<string, ApiProperty> = {};
  const constructorParams: ApiParam[] = [];

  // Extract constructor params
  const declarations = sym.getDeclarations();
  if (declarations) {
    for (const decl of declarations) {
      if (ts.isClassDeclaration(decl)) {
        for (const member of decl.members) {
          if (ts.isConstructorDeclaration(member)) {
            for (const param of member.parameters) {
              const paramName = param.name.getText();
              const paramType = param.type ? checker.typeToString(checker.getTypeFromTypeNode(param.type)) : 'any';
              constructorParams.push({
                name: paramName,
                type: paramType,
                optional: !!param.questionToken || !!param.initializer,
              });
            }
          }
        }
      }
    }
  }

  // Extract methods and properties from the type
  for (const prop of type.getProperties()) {
    // Skip private/protected members
    const propDeclarations = prop.getDeclarations();
    if (propDeclarations && propDeclarations.length > 0) {
      const decl = propDeclarations[0];
      const modifiers = ts.canHaveModifiers(decl) ? ts.getModifiers(decl) : undefined;
      if (
        modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)
      ) {
        continue;
      }
    }

    const propType = checker.getTypeOfSymbolAtLocation(prop, declarations![0]);
    const callSignatures = propType.getCallSignatures();

    if (callSignatures.length > 0) {
      const sig = callSignatures[0];
      methods[prop.name] = {
        name: prop.name,
        params: sig.getParameters().map((p) => extractParam(p, checker)),
        returnType: checker.typeToString(sig.getReturnType()),
        async: checker.typeToString(sig.getReturnType()).startsWith('Promise<'),
      };
    } else {
      const typeStr = checker.typeToString(propType);
      const isReadonly = propDeclarations?.some((d) => {
        const mods = ts.canHaveModifiers(d) ? ts.getModifiers(d) : undefined;
        return mods?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);
      });
      properties[prop.name] = {
        name: prop.name,
        type: typeStr,
        readonly: !!isReadonly,
      };
    }
  }

  return {
    name: sym.name,
    methods: sortRecord(methods),
    properties: sortRecord(properties),
    constructorParams,
  };
}

function extractParam(sym: ts.Symbol, checker: ts.TypeChecker): ApiParam {
  const decl = sym.getDeclarations()?.[0];
  const isOptional = decl && ts.isParameter(decl) ? !!decl.questionToken || !!decl.initializer : false;
  const type = checker.getTypeOfSymbolAtLocation(sym, decl!);
  return {
    name: sym.name,
    type: checker.typeToString(type),
    optional: isOptional,
  };
}

function extractInterface(sym: ts.Symbol, checker: ts.TypeChecker): ApiInterface {
  const type = checker.getDeclaredTypeOfSymbol(sym);
  const fields: Record<string, ApiField> = {};
  const extendsNames: string[] = [];

  // Get extends clauses
  const declarations = sym.getDeclarations();
  if (declarations) {
    for (const decl of declarations) {
      if (ts.isInterfaceDeclaration(decl) && decl.heritageClauses) {
        for (const clause of decl.heritageClauses) {
          for (const typeExpr of clause.types) {
            extendsNames.push(typeExpr.getText());
          }
        }
      }
    }
  }

  for (const prop of type.getProperties()) {
    const propType = checker.getTypeOfSymbolAtLocation(prop, declarations![0]);
    const propDecl = prop.getDeclarations()?.[0];
    const isOptional = propDecl && ts.isPropertySignature(propDecl) ? !!propDecl.questionToken : false;
    let typeStr = checker.typeToString(propType);
    if (isOptional) {
      typeStr = stripUndefined(typeStr);
    }
    fields[prop.name] = {
      name: prop.name,
      type: typeStr,
      optional: isOptional,
    };
  }

  return {
    name: sym.name,
    fields: sortRecord(fields),
    extends: extendsNames.sort(),
  };
}

function extractTypeAlias(sym: ts.Symbol, checker: ts.TypeChecker): ApiTypeAlias {
  const type = checker.getDeclaredTypeOfSymbol(sym);
  return {
    name: sym.name,
    value: checker.typeToString(type, undefined, ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.NoTruncation),
  };
}

function extractEnum(sym: ts.Symbol, checker: ts.TypeChecker): ApiEnum {
  const members: Record<string, string | number> = {};
  const type = checker.getDeclaredTypeOfSymbol(sym);

  if (type.isUnion()) {
    for (const memberType of type.types) {
      if (memberType.symbol) {
        const constValue = checker.getConstantValue(memberType.symbol.getDeclarations()![0] as ts.EnumMember);
        if (constValue !== undefined) {
          members[memberType.symbol.name] = constValue;
        }
      }
    }
  }

  return {
    name: sym.name,
    members: sortRecord(members),
  };
}

function buildExportMap(sourceFile: ts.SourceFile, checker: ts.TypeChecker, sdkPath: string): Record<string, string[]> {
  const exports: Record<string, string[]> = {};
  const relPath = relative(sdkPath, sourceFile.fileName);

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol) {
    const exportedNames = checker.getExportsOfModule(moduleSymbol).map((s) => s.name);
    if (exportedNames.length > 0) {
      exports[relPath] = exportedNames.sort();
    }
  }

  return exports;
}

function stripUndefined(typeStr: string): string {
  return typeStr.replace(/\s*\|\s*undefined$/, '').replace(/^undefined\s*\|\s*/, '');
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}
