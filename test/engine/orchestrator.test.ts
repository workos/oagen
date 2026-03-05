import { describe, it, expect } from "vitest";
import { generate } from "../../src/engine/orchestrator.js";
import type { Emitter, EmitterContext, GeneratedFile } from "../../src/engine/types.js";
import type { ApiSpec } from "../../src/ir/types.js";

function mockEmitter(): Emitter {
  return {
    language: "mock",
    generateModels: () => [{ path: "models/user.rb", content: "class User; end" }],
    generateEnums: () => [{ path: "models/status.rb", content: "class Status; end" }],
    generateResources: () => [{ path: "resources/users.rb", content: "class Users; end" }],
    generateClient: () => [{ path: "client.rb", content: "class Client; end" }],
    generateErrors: () => [{ path: "errors.rb", content: "class APIError; end" }],
    generateConfig: () => [{ path: "config.rb", content: "module Config; end" }],
    generateTypeSignatures: () => [{ path: "sig/user.rbs", content: "class User; end" }],
    generateTests: () => [{ path: "test/test_users.rb", content: "class TestUsers; end" }],
    fileHeader: () => "# Auto-generated",
  };
}

const minimalSpec: ApiSpec = {
  name: "Test API",
  version: "1.0.0",
  baseUrl: "https://api.test.com",
  services: [],
  models: [],
  enums: [],
};

describe("generate", () => {
  it("calls all emitter methods and collects files", async () => {
    const files = await generate(minimalSpec, mockEmitter(), {
      namespace: "test_api",
      dryRun: true,
      outputDir: "/tmp/test",
    });

    expect(files).toHaveLength(8);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("models/user.rb");
    expect(paths).toContain("models/status.rb");
    expect(paths).toContain("resources/users.rb");
    expect(paths).toContain("client.rb");
    expect(paths).toContain("errors.rb");
    expect(paths).toContain("config.rb");
    expect(paths).toContain("sig/user.rbs");
    expect(paths).toContain("test/test_users.rb");
  });

  it("prepends file header to all files", async () => {
    const files = await generate(minimalSpec, mockEmitter(), {
      namespace: "test",
      dryRun: true,
      outputDir: "/tmp/test",
    });

    for (const f of files) {
      expect(f.content).toMatch(/^# Auto-generated\n\n/);
    }
  });

  it("sets namespace context from options", async () => {
    let capturedCtx: EmitterContext | undefined;
    const emitter = mockEmitter();
    emitter.generateModels = (_models, ctx) => {
      capturedCtx = ctx;
      return [];
    };

    await generate(minimalSpec, emitter, {
      namespace: "WorkOS",
      dryRun: true,
      outputDir: "/tmp/test",
    });

    expect(capturedCtx!.namespace).toBe("work_os");
    expect(capturedCtx!.namespacePascal).toBe("WorkOS");
    expect(capturedCtx!.spec).toBe(minimalSpec);
  });

  it("dry run does not write files", async () => {
    const files = await generate(minimalSpec, mockEmitter(), {
      namespace: "test",
      dryRun: true,
      outputDir: "/tmp/nonexistent-dir-that-should-not-be-created",
    });

    expect(files.length).toBeGreaterThan(0);
  });
});
