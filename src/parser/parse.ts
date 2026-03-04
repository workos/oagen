import type { ApiSpec } from "../ir/types.js";
import { loadAndBundleSpec } from "./refs.js";
import { extractSchemas } from "./schemas.js";
import { extractOperations } from "./operations.js";

export async function parseSpec(specPath: string): Promise<ApiSpec> {
  const { parsed } = await loadAndBundleSpec(specPath);

  const spec = parsed as {
    openapi?: string;
    info?: { title?: string; version?: string; description?: string };
    servers?: Array<{ url?: string }>;
    paths?: Record<string, unknown>;
    components?: { schemas?: Record<string, unknown> };
  };

  // Validate OpenAPI version
  const version = spec.openapi ?? "";
  if (!version.startsWith("3.")) {
    throw new Error(
      `Unsupported OpenAPI version: ${version}. oagen requires OpenAPI 3.x`,
    );
  }

  const { models, enums } = extractSchemas(
    spec.components?.schemas as Record<string, Record<string, unknown>> | undefined,
  );

  const services = extractOperations(
    spec.paths as Record<string, Record<string, unknown>> | undefined,
  );

  return {
    name: spec.info?.title ?? "Unknown API",
    version: spec.info?.version ?? "0.0.0",
    description: spec.info?.description,
    baseUrl: spec.servers?.[0]?.url ?? "",
    services,
    models,
    enums,
  };
}
