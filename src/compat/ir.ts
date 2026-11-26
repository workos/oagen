/**
 * Rich compatibility IR for cross-language compatibility verification.
 *
 * These types represent the public API surface of an SDK in a language-aware,
 * machine-readable format. They extend the basic ApiSurface with richer
 * parameter semantics, sensitivity flags, and provenance metadata.
 */

import type { CompatPolicyHints } from './policy.js';

/** Language identifier for emitter targets. */
export type LanguageId = 'node' | 'php' | 'python' | 'ruby' | 'go' | 'kotlin' | 'dotnet' | 'elixir' | 'rust' | 'ios';

/** A full compatibility snapshot of an SDK's public API surface. */
export interface CompatSnapshot {
  schemaVersion: string;
  source: {
    specSha?: string;
    extractedAt: string;
    /** Language the snapshot was extracted for. Older snapshots omit this;
     *  the differ falls back to no type-form normalization when absent. */
    language?: LanguageId;
  };
  policies: CompatPolicyHints;
  symbols: CompatSymbol[];
}

/** Kind of public API symbol. */
export type CompatSymbolKind =
  | 'service_accessor'
  | 'callable'
  | 'constructor'
  | 'field'
  | 'property'
  | 'enum'
  | 'enum_member'
  | 'alias';

/** Visibility level of a symbol. */
export type CompatVisibility = 'public' | 'protected' | 'internal';

/** Stability classification of a symbol. */
export type CompatStability = 'stable' | 'unstable' | 'deprecated';

/** How the symbol was generated. */
export type CompatSourceKind =
  | 'generated_service_wrapper'
  | 'generated_model_constructor'
  | 'generated_resource_constructor'
  | 'generated_enum'
  | 'compat_alias';

/** A single public API symbol with its full metadata. */
export interface CompatSymbol {
  id: string;
  kind: CompatSymbolKind;
  fqName: string;
  ownerFqName?: string;
  displayName: string;
  visibility: CompatVisibility;
  stability: CompatStability;
  sourceKind: CompatSourceKind;
  operationId?: string;
  schemaName?: string;
  route?: {
    method: string;
    path: string;
  };
  parameters?: CompatParameter[];
  returns?: CompatTypeRef;
  /** Type reference for field/property symbols. */
  typeRef?: CompatTypeRef;
  /** Value for enum member symbols. */
  value?: string | number;
  /** Whether a callable is a static/type-level method. Absent when the
   *  extractor does not capture staticness; the classifier only compares
   *  it when both snapshots define it, so older snapshots never diff. */
  isStatic?: boolean;
  /** On a `field`: whether a caller that builds the owning type may leave the
   *  field out (`false` for a required field). Absent on every other kind,
   *  when the extractor cannot tell (see `ApiInterface.fieldOptionalityUnknown`)
   *  and in snapshots written before the key existed; the differ reads it
   *  only where it is defined, so older snapshots never diff on it. */
  optional?: boolean;
  /** On a `field`: the member's type as the extractor's checker resolves it,
   *  where that is another text than `typeRef.name`, which stays as every
   *  baseline holds it (`ApiField.resolvedType`). The classifier compares two
   *  fields by it when both snapshots record the field's optionality, that
   *  is, when both were written since it existed; an older snapshot is
   *  compared by `typeRef.name`, as before. */
  resolvedType?: string;
  /** On a type symbol whose members the snapshot records (an interface, a
   *  model class, a type alias of an object type): the supertypes its
   *  declaration names, as written. `[]` when it names none. Absent on a type
   *  alias recorded by name only, on a class, on an enum, and in snapshots
   *  written before the key existed. */
  extends?: string[];
  /** On a type alias: the type text it stands for, as the extractor recorded
   *  it (`ApiTypeAlias.value`). Read to follow a parameter's type to the
   *  types it is built from; a change of it is not reported. Absent in
   *  snapshots written before the key existed. */
  aliasOf?: string;
  /** Relative path to the source file where this symbol is defined. */
  sourceFile?: string;
}

/** How a parameter is passed at the call site. */
export type CompatPassingStyle =
  | 'positional'
  | 'keyword'
  | 'named'
  | 'keyword_or_positional'
  | 'options_object'
  | 'builder';

/** A parameter on a callable or constructor symbol. */
export interface CompatParameter {
  publicName: string;
  wireName?: string;
  position: number;
  required: boolean;
  nullable: boolean;
  hasDefault: boolean;
  passing: CompatPassingStyle;
  type: CompatTypeRef;
  sensitivity: ParameterSensitivity;
}

/** Which aspects of this parameter are part of the public API contract. */
export interface ParameterSensitivity {
  order: boolean;
  publicName: boolean;
  requiredness: boolean;
  type: boolean;
}

/** A type reference — either a named type or an inline description. */
export interface CompatTypeRef {
  name: string;
  nullable?: boolean;
  array?: boolean;
  generic?: string[];
}

// ---------------------------------------------------------------------------
// Bridge: ApiSurface → CompatSnapshot
// ---------------------------------------------------------------------------

import type { ApiSurface, ApiField, ApiParam } from './types.js';
import { getDefaultPolicy } from './policy.js';
import { COMPAT_SCHEMA_VERSION } from './schema.js';

/**
 * Convert a legacy ApiSurface to a CompatSnapshot.
 *
 * This bridge allows existing extractors (which produce ApiSurface) to feed
 * into the new classified diff engine without requiring immediate migration.
 *
 * It keeps what the surface states about each type: a field's optionality
 * (`optional`), an interface's or a model class's supertypes (`extends`), a
 * type alias's value (`aliasOf`) and, where the extractor resolved them, the
 * alias's members as `field` symbols under it, as an interface's are.
 */
export function apiSurfaceToSnapshot(surface: ApiSurface): CompatSnapshot {
  const language = (surface.language || 'node') as LanguageId;
  const symbols: CompatSymbol[] = [];

  // Convert classes → service_accessor symbols + callable/constructor children
  for (const [className, cls] of Object.entries(surface.classes)) {
    symbols.push({
      id: `class:${className}`,
      kind: 'service_accessor',
      fqName: className,
      displayName: className,
      visibility: 'public',
      stability: cls.deprecationMessage ? 'deprecated' : 'stable',
      sourceKind: 'generated_service_wrapper',
      ...(cls.sourceFile ? { sourceFile: cls.sourceFile } : {}),
    });

    // Constructor
    if (cls.constructorParams.length > 0) {
      symbols.push({
        id: `ctor:${className}`,
        kind: 'constructor',
        fqName: `${className}.constructor`,
        ownerFqName: className,
        displayName: `new ${className}`,
        visibility: 'public',
        stability: 'stable',
        sourceKind: 'generated_resource_constructor',
        parameters: cls.constructorParams.map((p, i) => apiParamToCompatParam(p, i, language)),
        ...(cls.sourceFile ? { sourceFile: cls.sourceFile } : {}),
      });
    }

    // Methods
    for (const [methodName, overloads] of Object.entries(cls.methods)) {
      for (let oi = 0; oi < overloads.length; oi++) {
        const method = overloads[oi];
        const suffix = overloads.length > 1 ? `#${oi}` : '';
        symbols.push({
          id: `method:${className}.${methodName}${suffix}`,
          kind: 'callable',
          fqName: `${className}.${methodName}`,
          ownerFqName: className,
          displayName: `${className}.${methodName}`,
          visibility: 'public',
          stability: 'stable',
          sourceKind: 'generated_service_wrapper',
          parameters: method.params.map((p, i) => apiParamToCompatParam(p, i, language)),
          returns: { name: method.returnType },
          ...(method.isStatic !== undefined ? { isStatic: method.isStatic } : {}),
          ...(cls.sourceFile ? { sourceFile: cls.sourceFile } : {}),
        });
      }
    }

    // Properties
    for (const [propName, prop] of Object.entries(cls.properties)) {
      symbols.push({
        id: `prop:${className}.${propName}`,
        kind: 'property',
        fqName: `${className}.${propName}`,
        ownerFqName: className,
        displayName: `${className}.${propName}`,
        visibility: 'public',
        stability: 'stable',
        sourceKind: 'generated_service_wrapper',
        typeRef: { name: prop.type },
        ...(cls.sourceFile ? { sourceFile: cls.sourceFile } : {}),
      });
    }
  }

  // Convert interfaces → field symbols
  for (const [ifaceName, iface] of Object.entries(surface.interfaces)) {
    symbols.push({
      id: `iface:${ifaceName}`,
      kind: 'alias',
      fqName: ifaceName,
      displayName: ifaceName,
      visibility: 'public',
      stability: 'stable',
      sourceKind: 'generated_resource_constructor',
      ...supertypesEntry(iface.extends),
      ...(iface.sourceFile ? { sourceFile: iface.sourceFile } : {}),
    });

    for (const [fieldName, field] of Object.entries(iface.fields)) {
      symbols.push(fieldSymbol(ifaceName, fieldName, field, iface.sourceFile, iface.fieldOptionalityUnknown !== true));
    }

    // Constructor if interface has one
    if (iface.hasCustomConstructor) {
      symbols.push({
        id: `ctor:${ifaceName}`,
        kind: 'constructor',
        fqName: `${ifaceName}.constructor`,
        ownerFqName: ifaceName,
        displayName: `new ${ifaceName}`,
        visibility: 'public',
        stability: 'stable',
        sourceKind: 'generated_resource_constructor',
        ...(iface.sourceFile ? { sourceFile: iface.sourceFile } : {}),
      });
    }
  }

  // Convert type aliases. An alias of an object type carries its members as
  // field symbols, as an interface does; any other alias is recorded by name,
  // with the text it stands for.
  for (const [aliasName, alias] of Object.entries(surface.typeAliases)) {
    const members = aliasMembers(alias.fields);
    symbols.push({
      id: `alias:${aliasName}`,
      kind: 'alias',
      fqName: aliasName,
      displayName: aliasName,
      visibility: 'public',
      stability: 'stable',
      sourceKind: 'generated_resource_constructor',
      ...(members ? supertypesEntry(alias.extends) : {}),
      ...(typeof alias.value === 'string' ? { aliasOf: alias.value } : {}),
      ...(alias.sourceFile ? { sourceFile: alias.sourceFile } : {}),
    });

    for (const [fieldName, field] of Object.entries(members ?? {})) {
      symbols.push(fieldSymbol(aliasName, fieldName, field, alias.sourceFile, true));
    }
  }

  // Convert enums
  for (const [enumName, enumDef] of Object.entries(surface.enums)) {
    symbols.push({
      id: `enum:${enumName}`,
      kind: 'enum',
      fqName: enumName,
      displayName: enumName,
      visibility: 'public',
      stability: 'stable',
      sourceKind: 'generated_enum',
      ...(enumDef.sourceFile ? { sourceFile: enumDef.sourceFile } : {}),
    });

    for (const [memberName, memberValue] of Object.entries(enumDef.members)) {
      symbols.push({
        id: `enum_member:${enumName}.${memberName}`,
        kind: 'enum_member',
        fqName: `${enumName}.${memberName}`,
        ownerFqName: enumName,
        displayName: `${enumName}.${memberName}`,
        visibility: 'public',
        stability: 'stable',
        sourceKind: 'generated_enum',
        value: memberValue,
        ...(enumDef.sourceFile ? { sourceFile: enumDef.sourceFile } : {}),
      });
    }
  }

  return {
    schemaVersion: COMPAT_SCHEMA_VERSION,
    source: { extractedAt: surface.extractedAt, language },
    policies: getDefaultPolicy(language),
    symbols,
  };
}

/**
 * A member of an interface, a model class or an object-type alias. `optional`
 * is written as the surface states it, and left out where the surface states
 * a placeholder (`optionalityKnown` false) or nothing a snapshot can carry.
 */
function fieldSymbol(
  ownerName: string,
  fieldName: string,
  field: ApiField,
  sourceFile: string | undefined,
  optionalityKnown: boolean,
): CompatSymbol {
  return {
    id: `field:${ownerName}.${fieldName}`,
    kind: 'field',
    fqName: `${ownerName}.${fieldName}`,
    ownerFqName: ownerName,
    displayName: `${ownerName}.${fieldName}`,
    visibility: 'public',
    stability: 'stable',
    sourceKind: 'generated_resource_constructor',
    typeRef: { name: field.type },
    ...(optionalityKnown && typeof field.optional === 'boolean' ? { optional: field.optional } : {}),
    ...(typeof field.resolvedType === 'string' ? { resolvedType: field.resolvedType } : {}),
    ...(sourceFile ? { sourceFile } : {}),
  };
}

/** The `extends` key of a type whose members are recorded: the supertypes the
 *  surface names, `[]` when it names none (a surface from a hand-built or
 *  older file may lack the list). */
function supertypesEntry(supertypes: unknown): { extends: string[] } {
  return {
    extends: Array.isArray(supertypes) ? supertypes.filter((name): name is string => typeof name === 'string') : [],
  };
}

/** The members a surface records for a type alias; undefined when it records
 *  none (every extractor but one that resolves an alias's shape, every
 *  surface file written before aliases carried members) or something that is
 *  not a typed field per member, which is read as no record at all. */
function aliasMembers(fields: unknown): Record<string, ApiField> | undefined {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return undefined;
  const isField = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
  return Object.values(fields).every(isField) ? (fields as Record<string, ApiField>) : undefined;
}

/** Convert a legacy ApiParam to a CompatParameter. */
function apiParamToCompatParam(param: ApiParam, position: number, language: LanguageId): CompatParameter {
  const policy = getDefaultPolicy(language);
  const passing = param.passingStyle ?? inferPassingStyle(language);
  return {
    publicName: param.name,
    position,
    required: !param.optional,
    nullable: false,
    hasDefault: param.optional,
    passing,
    type: { name: param.type },
    sensitivity: {
      // Method-call order matters only when callers pass positionally. keyword
      // (Ruby/Python/Elixir) and options_object (Node) hide position entirely;
      // named (PHP/Kotlin/C#) is handled as soft-risk in classify.
      order: passing === 'positional',
      publicName: policy.methodParameterNamesArePublicApi,
      requiredness: true,
      type: true,
    },
  };
}

/** Infer the default parameter passing style for a language. */
function inferPassingStyle(language: LanguageId): CompatPassingStyle {
  switch (language) {
    case 'python':
    case 'ruby':
    case 'elixir':
      return 'keyword';
    case 'php':
    case 'kotlin':
    case 'dotnet':
      return 'named';
    case 'node':
      return 'options_object';
    // Swift argument labels are mandatory at the call site and fixed in
    // declaration order, so parameters behave like labeled positional args.
    case 'ios':
    default:
      return 'positional';
  }
}
