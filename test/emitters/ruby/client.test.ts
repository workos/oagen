import { describe, it, expect } from "vitest";
import { generateClient } from "../../../src/emitters/ruby/client.js";
import type { EmitterContext } from "../../../src/engine/types.js";
import type { ApiSpec } from "../../../src/ir/types.js";

const spec: ApiSpec = {
  name: "WorkOS",
  version: "1.0.0",
  baseUrl: "https://api.workos.com",
  services: [
    { name: "Organizations", operations: [] },
    { name: "Users", operations: [] },
  ],
  models: [],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: "work_os",
  namespacePascal: "WorkOS",
  spec,
};

describe("generateClient", () => {
  it("generates client with keyword-style request method", () => {
    const files = generateClient(spec, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("lib/work_os/client.rb");

    const content = files[0].content;
    expect(content).toContain("RETRYABLE_STATUSES = [429, 500, 502, 503, 504]");
    expect(content).toContain("MAX_RETRY_DELAY = 30");
    // Keyword arguments
    expect(content).toContain("def request(method:, path:, query: nil, body: nil, model: nil, page: nil, idempotency_key: nil, options: nil)");
    expect(content).toContain("(2**attempt * 0.5) + jitter");
  });

  it("generates resource accessor methods with YARD docs", () => {
    const files = generateClient(spec, ctx);
    const content = files[0].content;
    expect(content).toContain("# @return [WorkOS::Resources::Organizations]");
    expect(content).toContain("def organizations");
    expect(content).toContain("WorkOS::Resources::Organizations.new(client: self)");
    expect(content).toContain("# @return [WorkOS::Resources::Users]");
    expect(content).toContain("def users");
    expect(content).toContain("WorkOS::Resources::Users.new(client: self)");
  });

  it("includes Retry-After header handling", () => {
    const files = generateClient(spec, ctx);
    const content = files[0].content;
    expect(content).toContain('response["Retry-After"]');
  });

  it("includes idempotency key generation for POST", () => {
    const files = generateClient(spec, ctx);
    const content = files[0].content;
    expect(content).toContain("SecureRandom.uuid if method == :post");
  });

  it("handles model and page deserialization", () => {
    const files = generateClient(spec, ctx);
    const content = files[0].content;
    expect(content).toContain("def handle_response(response, model:, page:)");
    expect(content).toContain("return nil if model == NilClass");
    expect(content).toContain("page.new(model: model, page: parsed)");
    expect(content).toContain("model.new(parsed)");
  });
});
