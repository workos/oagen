import type { Model, Field } from "../../ir/types.js";
import type { EmitterContext, GeneratedFile } from "../../engine/types.js";
import { mapTypeRef } from "./type-map.js";
import { rubyClassName, rubyFileName } from "./naming.js";
import { yardType } from "./yard.js";

export function generateModels(
  models: Model[],
  ctx: EmitterContext,
): GeneratedFile[] {
  return models.map((model) => ({
    path: `lib/${ctx.namespace}/models/${rubyFileName(model.name)}.rb`,
    content: generateModel(model, ctx),
  }));
}

function generateModel(model: Model, ctx: EmitterContext): string {
  const className = rubyClassName(model.name);
  const lines: string[] = [];

  lines.push(`module ${ctx.namespacePascal}`);
  lines.push("  module Models");

  if (model.description) {
    lines.push(`    # ${model.description}`);
  }

  lines.push(
    `    class ${className} < ${ctx.namespacePascal}::Internal::Type::BaseModel`,
  );

  for (const field of model.fields) {
    lines.push(...generateField(field, ctx).map((l) => `      ${l}`));
  }

  lines.push("    end");
  lines.push("  end");
  lines.push("end");
  lines.push("");

  return lines.join("\n");
}

function generateField(field: Field, ctx: EmitterContext): string[] {
  const lines: string[] = [];
  const keyword = field.required ? "required" : "optional";
  const rubyType = mapTypeRef(field.type, ctx.namespacePascal);
  const yardReturnType = yardType(field.type, ctx.namespacePascal);

  lines.push(`# @!attribute ${field.name}`);
  if (field.description) {
    lines.push(`#   ${field.description}`);
  }
  lines.push(`#   @return [${yardReturnType}]`);
  lines.push(`${keyword} :${field.name}, ${rubyType}`);
  lines.push("");

  return lines;
}
