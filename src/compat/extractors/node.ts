import ts from 'typescript';
import { readFileSync } from 'node:fs';
import path, { resolve, relative } from 'node:path';
import { ExtractorError } from '../../errors.js';
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
import { nodeHints } from '../language-hints.js';
import { sortRecord } from './shared.js';

export const nodeExtractor: Extractor = {
  language: 'node',
  hints: nodeHints,

  async extract(sdkPath: string): Promise<ApiSurface> {
    sdkPath = resolve(sdkPath);
    const configPath = ts.findConfigFile(sdkPath, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath)
      throw new ExtractorError(
        `No tsconfig.json found in ${sdkPath}`,
        `Create a tsconfig.json in "${sdkPath}" or verify the --sdk-path argument points to a TypeScript project root.`,
      );

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, sdkPath);
    const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
    const checker = program.getTypeChecker();

    const entryPoint = resolveEntryPoint(sdkPath, program);
    const entrySourceFile = program.getSourceFile(entryPoint);
    if (!entrySourceFile)
      throw new ExtractorError(
        `Entry point not found: ${entryPoint}`,
        `Ensure the file "${entryPoint}" exists and is included in the tsconfig.json "include" or "files" array.`,
      );

    const moduleSymbol = checker.getSymbolAtLocation(entrySourceFile);
    if (!moduleSymbol)
      throw new ExtractorError(
        'No exports found at entry point',
        `Verify that "${entryPoint}" has at least one \`export\` statement. The extractor needs public exports to build an API surface.`,
      );

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

      const sourceFile = relative(sdkPath, decl.getSourceFile().fileName);

      if (ts.isClassDeclaration(decl)) {
        classes[resolved.name] = { ...extractClass(resolved, checker), sourceFile };
      } else if (ts.isInterfaceDeclaration(decl)) {
        interfaces[resolved.name] = { ...extractInterface(resolved, checker), sourceFile };
      } else if (ts.isTypeAliasDeclaration(decl)) {
        typeAliases[resolved.name] = { ...extractTypeAlias(resolved, checker), sourceFile };
      } else if (ts.isEnumDeclaration(decl)) {
        enums[resolved.name] = { ...extractEnum(resolved, checker), sourceFile };
      }
    }

    // Follow property types on extracted classes to discover resource classes
    // (e.g., WorkOS.apiKeys: ApiKeys → extract ApiKeys)
    followPropertyTypeClasses(exportedSymbols, checker, classes, sdkPath);

    const exports = buildExportMap(entrySourceFile, checker, sdkPath, program);

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

function followPropertyTypeClasses(
  exportedSymbols: ts.Symbol[],
  checker: ts.TypeChecker,
  classes: Record<string, ApiClass>,
  sdkPath: string,
): void {
  // Build initial set of class symbols from exports
  const classSymbols = new Map<string, ts.Symbol>();
  for (const sym of exportedSymbols) {
    const resolved = resolveAlias(sym, checker);
    const decls = resolved.getDeclarations();
    if (decls?.some((d) => ts.isClassDeclaration(d))) {
      classSymbols.set(resolved.name, resolved);
    }
  }

  const toVisit = [...classSymbols.values()];
  const visited = new Set(classSymbols.keys());

  while (toVisit.length > 0) {
    const sym = toVisit.pop()!;
    const type = checker.getDeclaredTypeOfSymbol(sym);
    const decls = sym.getDeclarations();
    if (!decls || decls.length === 0) continue;

    for (const prop of type.getProperties()) {
      const propDecls = prop.getDeclarations();
      if (!propDecls || propDecls.length === 0) continue;
      const propDecl = propDecls[0];

      // Skip private/protected
      const modifiers = ts.canHaveModifiers(propDecl) ? ts.getModifiers(propDecl) : undefined;
      if (
        modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)
      ) {
        continue;
      }

      const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl);
      const propSymbol = propType.getSymbol();
      if (!propSymbol) continue;

      const propName = propSymbol.name;
      if (visited.has(propName)) continue;

      const propSymDecls = propSymbol.getDeclarations();
      if (!propSymDecls?.some((d) => ts.isClassDeclaration(d))) continue;

      // Found a class referenced by property type — extract it
      visited.add(propName);
      const sourceFile = relative(sdkPath, propSymDecls[0].getSourceFile().fileName);
      classes[propName] = { ...extractClass(propSymbol, checker), sourceFile };
      toVisit.push(propSymbol);
    }
  }
}

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
  throw new ExtractorError(
    `No entry point found. Tried: package.json exports/main, src/index.ts`,
    `Add an "exports" or "main" field to package.json in "${sdkPath}", or create a src/index.ts file that re-exports the public API.`,
  );
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
  const methods: Record<string, ApiMethod[]> = {};
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
      if (!methods[prop.name]) methods[prop.name] = [];
      // Extract ALL overloads, not just the first
      for (const sig of callSignatures) {
        methods[prop.name].push({
          name: prop.name,
          params: sig.getParameters().map((p) => extractParam(p, checker)),
          returnType: checker.typeToString(sig.getReturnType()),
          async: checker.typeToString(sig.getReturnType()).startsWith('Promise<'),
        });
      }
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

  // Fallback: walk AST declaration members for fields that type.getProperties() missed.
  // This handles generic interfaces (e.g., List<T>) where the checker may not resolve
  // all properties when the type parameter is unbound.
  if (declarations) {
    for (const decl of declarations) {
      if (ts.isInterfaceDeclaration(decl)) {
        for (const member of decl.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const memberName = member.name.getText();
            if (!fields[memberName]) {
              const memberType = member.type ? checker.typeToString(checker.getTypeFromTypeNode(member.type)) : 'any';
              const isOpt = !!member.questionToken;
              fields[memberName] = {
                name: memberName,
                type: isOpt ? stripUndefined(memberType) : memberType,
                optional: isOpt,
              };
            }
          }
        }
      }
    }
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

function buildExportMap(
  entryFile: ts.SourceFile,
  checker: ts.TypeChecker,
  sdkPath: string,
  program: ts.Program,
): Record<string, string[]> {
  const exports: Record<string, string[]> = {};
  const visited = new Set<string>();

  function walk(sourceFile: ts.SourceFile): void {
    const absPath = sourceFile.fileName;
    if (visited.has(absPath)) return;
    visited.add(absPath);

    const relPath = relative(sdkPath, absPath);
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol) {
      const names = checker.getExportsOfModule(moduleSymbol).map((s) => s.name);
      if (names.length > 0) {
        exports[relPath] = names.sort();
      }
    }

    for (const stmt of sourceFile.statements) {
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const target = stmt.moduleSpecifier.text;
        const resolved = resolveSourceFile(path.dirname(absPath), target, program);
        if (resolved) {
          const targetFile = program.getSourceFile(resolved);
          if (targetFile) {
            walk(targetFile);
          }
        }
      }
    }
  }

  walk(entryFile);
  return exports;
}

function stripUndefined(typeStr: string): string {
  return typeStr.replace(/\s*\|\s*undefined$/, '').replace(/^undefined\s*\|\s*/, '');
}
