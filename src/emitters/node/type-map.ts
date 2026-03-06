import type { TypeRef } from '../../ir/types.js';

export function mapTypeRefPublic(typeRef: TypeRef, _namespacePascal: string): string {
  switch (typeRef.kind) {
    case 'primitive':
      return mapPrimitive(typeRef.type);
    case 'array':
      return `${mapTypeRefPublic(typeRef.items, _namespacePascal)}[]`;
    case 'model':
      return typeRef.name;
    case 'enum':
      return typeRef.name;
    case 'nullable':
      return `${mapTypeRefPublic(typeRef.inner, _namespacePascal)} | null`;
    case 'union':
      return typeRef.variants.map((v) => mapTypeRefPublic(v, _namespacePascal)).join(' | ');
  }
}

export function mapTypeRefResponse(typeRef: TypeRef, _namespacePascal: string): string {
  switch (typeRef.kind) {
    case 'primitive':
      return mapPrimitive(typeRef.type);
    case 'array':
      return `${mapTypeRefResponse(typeRef.items, _namespacePascal)}[]`;
    case 'model':
      return `${typeRef.name}Response`;
    case 'enum':
      return typeRef.name;
    case 'nullable':
      return `${mapTypeRefResponse(typeRef.inner, _namespacePascal)} | null`;
    case 'union':
      return typeRef.variants.map((v) => mapTypeRefResponse(v, _namespacePascal)).join(' | ');
  }
}

function mapPrimitive(type: string): string {
  if (type === 'string') return 'string';
  if (type === 'integer') return 'number';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  return 'string';
}
