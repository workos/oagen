import { mapTypeRef } from '@workos/oagen';
import type {
  TypeRef,
  PrimitiveType,
  ArrayType,
  ModelRef,
  EnumRef,
  UnionType,
  NullableType,
  LiteralType,
  MapType,
} from '@workos/oagen';
import { tsTypeName } from './naming.js';

/** Map an IR TypeRef to a TypeScript type string. */
export function toTsType(ref: TypeRef): string {
  return mapTypeRef<string>(ref, {
    primitive: (r: PrimitiveType) => {
      switch (r.type) {
        case 'string':
          return 'string';
        case 'integer':
        case 'number':
          return 'number';
        case 'boolean':
          return 'boolean';
        case 'unknown':
          return 'unknown';
      }
    },
    array: (_r: ArrayType, items: string) => `${items}[]`,
    model: (r: ModelRef) => tsTypeName(r.name),
    enum: (r: EnumRef) => tsTypeName(r.name),
    union: (_r: UnionType, variants: string[]) => variants.join(' | '),
    nullable: (_r: NullableType, inner: string) => `${inner} | null`,
    literal: (r: LiteralType) => JSON.stringify(r.value),
    map: (_r: MapType, value: string) => `Record<string, ${value}>`,
  });
}
