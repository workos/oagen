import { describe, it, expect } from "vitest";
import { generateErrors } from "../../../src/emitters/ruby/errors.js";
import type { EmitterContext } from "../../../src/engine/types.js";
import type { ApiSpec } from "../../../src/ir/types.js";

const emptySpec: ApiSpec = {
  name: "Test",
  version: "1.0.0",
  baseUrl: "",
  services: [],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: "work_os",
  namespacePascal: "WorkOS",
  spec: emptySpec,
};

describe("generateErrors", () => {
  it("generates the error class hierarchy", () => {
    const files = generateErrors(ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("lib/work_os/errors.rb");

    const content = files[0].content;
    expect(content).toContain("class APIError < StandardError");
    expect(content).toContain("class AuthenticationError < APIError; end");
    expect(content).toContain("class NotFoundError < APIError; end");
    expect(content).toContain("class UnprocessableEntityError < APIError; end");
    expect(content).toContain("class RateLimitExceededError < APIError; end");
    expect(content).toContain("class ServerError < APIError; end");
    expect(content).toContain("class NetworkError < APIError; end");
    expect(content).toContain("class ConfigurationError < StandardError; end");
  });

  it("uses correct namespace", () => {
    const files = generateErrors({
      ...ctx,
      namespace: "stripe",
      namespacePascal: "Stripe",
    });

    expect(files[0].content).toContain("module Stripe");
    expect(files[0].path).toBe("lib/stripe/errors.rb");
  });
});
