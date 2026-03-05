import { describe, it, expect } from "vitest";
import { generateTests } from "../../../src/emitters/ruby/tests.js";
import type { EmitterContext } from "../../../src/engine/types.js";
import type { ApiSpec } from "../../../src/ir/types.js";

const spec: ApiSpec = {
  name: "WorkOS",
  version: "1.0.0",
  baseUrl: "https://api.workos.com",
  services: [
    {
      name: "Organizations",
      operations: [
        {
          name: "list",
          httpMethod: "get",
          path: "/organizations",
          pathParams: [],
          queryParams: [
            { name: "cursor", type: { kind: "primitive", type: "string" }, required: false },
          ],
          headerParams: [],
          response: { kind: "model", name: "Organization" },
          errors: [],
          paginated: true,
          idempotent: false,
        },
        {
          name: "retrieve",
          httpMethod: "get",
          path: "/organizations/{id}",
          pathParams: [
            { name: "id", type: { kind: "primitive", type: "string" }, required: true },
          ],
          queryParams: [],
          headerParams: [],
          response: { kind: "model", name: "Organization" },
          errors: [],
          paginated: false,
          idempotent: false,
        },
        {
          name: "create",
          httpMethod: "post",
          path: "/organizations",
          pathParams: [],
          queryParams: [],
          headerParams: [],
          requestBody: { kind: "model", name: "CreateOrganization" },
          response: { kind: "model", name: "Organization" },
          errors: [],
          paginated: false,
          idempotent: true,
        },
      ],
    },
  ],
  models: [
    {
      name: "Organization",
      fields: [
        { name: "id", type: { kind: "primitive", type: "string" }, required: true },
        { name: "name", type: { kind: "primitive", type: "string" }, required: true },
      ],
    },
  ],
  enums: [],
};

const ctx: EmitterContext = {
  namespace: "work_os",
  namespacePascal: "WorkOS",
  spec,
};

describe("generateTests", () => {
  it("generates test files nested in modules", () => {
    const files = generateTests(spec, ctx);

    const testFile = files.find((f) => f.path === "test/work_os/resources/organizations_test.rb");
    expect(testFile).toBeDefined();
    expect(testFile!.content).toContain("module WorkOS");
    expect(testFile!.content).toContain("module Resources");
    expect(testFile!.content).toContain("class OrganizationsTest < Minitest::Test");
  });

  it("generates CRUD tests with WebMock stubs", () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === "test/work_os/resources/organizations_test.rb")!;

    expect(testFile.content).toContain("def test_list");
    expect(testFile.content).toContain("def test_retrieve");
    expect(testFile.content).toContain("def test_create");
    expect(testFile.content).toContain(
      'stub_request(:get, "https://api.example.com/organizations")',
    );
    expect(testFile.content).toContain(
      'stub_request(:get, "https://api.example.com/organizations/test_id")',
    );
    expect(testFile.content).toContain(
      'stub_request(:post, "https://api.example.com/organizations")',
    );
  });

  it("uses assert_pattern for paginated responses", () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === "test/work_os/resources/organizations_test.rb")!;
    expect(testFile.content).toContain("assert_pattern { response => WorkOS::Internal::CursorPage }");
  });

  it("uses assert_pattern for model responses", () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === "test/work_os/resources/organizations_test.rb")!;
    expect(testFile.content).toContain("assert_pattern { response => WorkOS::Models::Organization }");
  });

  it("generates error tests", () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === "test/work_os/resources/organizations_test.rb")!;
    expect(testFile.content).toContain("# === Error Tests ===");
    expect(testFile.content).toContain("def test_not_found");
    expect(testFile.content).toContain("assert_raises(WorkOS::NotFoundError)");
    expect(testFile.content).toContain("def test_authentication_error");
    expect(testFile.content).toContain("assert_raises(WorkOS::AuthenticationError)");
  });

  it("generates retry tests for list operations", () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === "test/work_os/resources/organizations_test.rb")!;
    expect(testFile.content).toContain("# === Retry Tests ===");
    expect(testFile.content).toContain("def test_retry_on_rate_limit");
    expect(testFile.content).toContain("status: 429");
    expect(testFile.content).toContain('"Retry-After" => "1"');
    expect(testFile.content).toContain("max_retries: 2");
  });

  it("generates idempotency tests for create operations", () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === "test/work_os/resources/organizations_test.rb")!;
    expect(testFile.content).toContain("# === Idempotency Tests ===");
    expect(testFile.content).toContain("def test_idempotency_key_sent");
    expect(testFile.content).toContain('"Idempotency-Key" => "my_key"');
    expect(testFile.content).toContain("def test_idempotency_key_auto_generated");
    expect(testFile.content).toContain("refute_nil captured_key");
  });

  it("uses load_fixture helper with resource/operation pattern", () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === "test/work_os/resources/organizations_test.rb")!;
    expect(testFile.content).toContain('load_fixture("organizations/list.json")');
    expect(testFile.content).toContain('load_fixture("organizations/retrieve.json")');
    expect(testFile.content).toContain('load_fixture("organizations/create.json")');
  });

  it("generates fixture JSON files", () => {
    const files = generateTests(spec, ctx);
    const fixture = files.find((f) => f.path.includes("fixtures/") && f.path.endsWith(".json"));
    expect(fixture).toBeDefined();
    const parsed = JSON.parse(fixture!.content);
    expect(parsed).toHaveProperty("id");
    expect(parsed).toHaveProperty("name");
  });

  it("includes test_helper require", () => {
    const files = generateTests(spec, ctx);
    const testFile = files.find((f) => f.path === "test/work_os/resources/organizations_test.rb")!;
    expect(testFile.content).toContain('require_relative "../../test_helper"');
  });
});
