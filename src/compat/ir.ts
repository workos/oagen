/**
 * Rich compatibility IR for cross-language compatibility verification.
 *
 * These types represent the public API surface of an SDK in a language-aware,
 * machine-readable format. They extend the basic ApiSurface with richer
 * parameter semantics, sensitivity flags, and provenance metadata.
 */

import type { CompatPolicyHints } from './policy.js';

/** Language identifier for emitter targets. */
export type LanguageId = 'node' | 'php' | 'python' | 'ruby' | 'go' | 'kotlin' | 'dotnet' | 'elixir' | 'rust';

/** A full compatibility snapshot of an SDK's public API surface. */
export interface CompatSnapshot {
  schemaVersion: string;
  source: {
    specSha?: string;
    extractedAt: string;
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

import type { ApiSurface, ApiParam } from './types.js';
import { getDefaultPolicy } from './policy.js';
import { COMPAT_SCHEMA_VERSION } from './schema.js';

/**
 * Convert a legacy ApiSurface to a CompatSnapshot.
 *
 * This bridge allows existing extractors (which produce ApiSurface) to feed
 * into the new classified diff engine without requiring immediate migration.
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
    });

    for (const [fieldName, field] of Object.entries(iface.fields)) {
      symbols.push({
        id: `field:${ifaceName}.${fieldName}`,
        kind: 'field',
        fqName: `${ifaceName}.${fieldName}`,
        ownerFqName: ifaceName,
        displayName: `${ifaceName}.${fieldName}`,
        visibility: 'public',
        stability: 'stable',
        sourceKind: 'generated_resource_constructor',
        typeRef: { name: field.type },
      });
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
      });
    }
  }

  // Convert type aliases
  for (const [aliasName] of Object.entries(surface.typeAliases)) {
    symbols.push({
      id: `alias:${aliasName}`,
      kind: 'alias',
      fqName: aliasName,
      displayName: aliasName,
      visibility: 'public',
      stability: 'stable',
      sourceKind: 'generated_resource_constructor',
    });
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
      });
    }
  }

  return {
    schemaVersion: COMPAT_SCHEMA_VERSION,
    source: { extractedAt: surface.extractedAt },
    policies: getDefaultPolicy(language),
    symbols,
  };
}

/** Convert a legacy ApiParam to a CompatParameter. */
function apiParamToCompatParam(param: ApiParam, position: number, language: LanguageId): CompatParameter {
  const policy = getDefaultPolicy(language);
  return {
    publicName: param.name,
    position,
    required: !param.optional,
    nullable: false,
    hasDefault: param.optional,
    passing: param.passingStyle ?? inferPassingStyle(language),
    type: { name: param.type },
    sensitivity: {
      order: policy.constructorOrderMatters,
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
    default:
      return 'positional';
  }
}
