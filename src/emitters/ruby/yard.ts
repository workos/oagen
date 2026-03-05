import type { TypeRef } from "../../ir/types.js";

export function yardType(typeRef: TypeRef, namespacePascal: string): string {
  switch (typeRef.kind) {
    case "primitive":
      return yardPrimitive(typeRef.type, typeRef.format);
    case "array":
      return `Array<${yardType(typeRef.items, namespacePascal)}>`;
    case "model":
      return `${namespacePascal}::Models::${typeRef.name}`;
    case "enum":
      return "Symbol";
    case "nullable":
      return `${yardType(typeRef.inner, namespacePascal)}, nil`;
    case "union":
      return typeRef.variants
        .map((v) => yardType(v, namespacePascal))
        .join(", ");
  }
}

function yardPrimitive(type: string, format?: string): string {
  if (type === "string") {
    if (format === "date") return "Date";
    if (format === "date-time") return "Time";
    return "String";
  }
  if (type === "integer") return "Integer";
  if (type === "number") return "Float";
  if (type === "boolean") return "Boolean";
  return "String";
}
