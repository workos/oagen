import type { TypeRef } from '../../ir/types.js';

export function mapTypeRefPublic(typeRef: TypeRef): string {
  switch (typeRef.kind) {
    case 'primitive':
      return mapPrimitive(typeRef.type);
    case 'array':
      return `${mapTypeRefPublic(typeRef.items)}[]`;
    case 'model':
      return typeRef.name;
    case 'enum':
      return typeRef.name;
    case 'nullable':
      return `${mapTypeRefPublic(typeRef.inner)} | null`;
    case 'union':
      return typeRef.variants.map((v) => mapTypeRefPublic(v)).join(' | ');
  }
}

export function mapTypeRefResponse(typeRef: TypeRef): string {
  switch (typeRef.kind) {
    case 'primitive':
      return mapPrimitive(typeRef.type);
    case 'array':
      return `${mapTypeRefResponse(typeRef.items)}[]`;
    case 'model':
      return `${typeRef.name}Response`;
    case 'enum':
      return typeRef.name;
    case 'nullable':
      return `${mapTypeRefResponse(typeRef.inner)} | null`;
    case 'union':
      return typeRef.variants.map((v) => mapTypeRefResponse(v)).join(' | ');
  }
}

function mapPrimitive(type: string): string {
  if (type === 'string') return 'string';
  if (type === 'integer') return 'number';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  return 'string';
}
