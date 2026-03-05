import type { TypeRef } from '../../ir/types.js';

export function mapTypeRef(typeRef: TypeRef, namespacePascal: string): string {
  switch (typeRef.kind) {
    case 'primitive':
      return mapPrimitive(typeRef.type, typeRef.format, namespacePascal);

    case 'array':
      return `${namespacePascal}::Internal::Type::ArrayOf[${mapTypeRef(typeRef.items, namespacePascal)}]`;

    case 'model':
      return `-> { ${namespacePascal}::Models::${typeRef.name} }`;

    case 'enum':
      return `enum: -> { ${namespacePascal}::Models::${typeRef.name} }`;

    case 'nullable':
      return `${mapTypeRef(typeRef.inner, namespacePascal)}, nil?: true`;

    case 'union':
      const variants = typeRef.variants.map((v) => mapTypeRef(v, namespacePascal)).join(', ');
      return `${namespacePascal}::Internal::Type::Union[${variants}]`;
  }
}

function mapPrimitive(type: string, format: string | undefined, namespacePascal: string): string {
  if (type === 'string') {
    if (format === 'date') return 'Date';
    if (format === 'date-time') return 'Time';
    return 'String';
  }
  if (type === 'integer') return 'Integer';
  if (type === 'number') return 'Float';
  if (type === 'boolean') return `${namespacePascal}::Internal::Type::Boolean`;
  return 'String';
}

export function mapTypeRefForRbs(typeRef: TypeRef, namespacePascal: string): string {
  switch (typeRef.kind) {
    case 'primitive':
      return mapPrimitiveRbs(typeRef.type, typeRef.format);
    case 'array':
      return `Array[${mapTypeRefForRbs(typeRef.items, namespacePascal)}]`;
    case 'model':
      return `${namespacePascal}::Models::${typeRef.name}`;
    case 'enum':
      return `${namespacePascal}::Models::${typeRef.name}`;
    case 'nullable':
      return `${mapTypeRefForRbs(typeRef.inner, namespacePascal)}?`;
    case 'union':
      return typeRef.variants.map((v) => mapTypeRefForRbs(v, namespacePascal)).join(' | ');
  }
}

function mapPrimitiveRbs(type: string, format?: string): string {
  if (type === 'string') {
    if (format === 'date') return 'Date';
    if (format === 'date-time') return 'Time';
    return 'String';
  }
  if (type === 'integer') return 'Integer';
  if (type === 'number') return 'Float';
  if (type === 'boolean') return 'bool';
  return 'String';
}

export function mapTypeRefForSorbet(typeRef: TypeRef, namespacePascal: string): string {
  switch (typeRef.kind) {
    case 'primitive':
      return mapPrimitiveSorbet(typeRef.type, typeRef.format);
    case 'array':
      return `T::Array[${mapTypeRefForSorbet(typeRef.items, namespacePascal)}]`;
    case 'model':
      return `${namespacePascal}::Models::${typeRef.name}`;
    case 'enum':
      return `${namespacePascal}::Models::${typeRef.name}`;
    case 'nullable':
      return `T.nilable(${mapTypeRefForSorbet(typeRef.inner, namespacePascal)})`;
    case 'union':
      const variants = typeRef.variants.map((v) => mapTypeRefForSorbet(v, namespacePascal)).join(', ');
      return `T.any(${variants})`;
  }
}

function mapPrimitiveSorbet(type: string, format?: string): string {
  if (type === 'string') {
    if (format === 'date') return 'Date';
    if (format === 'date-time') return 'Time';
    return 'String';
  }
  if (type === 'integer') return 'Integer';
  if (type === 'number') return 'Float';
  if (type === 'boolean') return 'T::Boolean';
  return 'String';
}
