import { describe, it, expect } from "vitest";
import { generateModels } from "../../../src/emitters/ruby/models.js";
import type { EmitterContext } from "../../../src/engine/types.js";
import type { Model, ApiSpec } from "../../../src/ir/types.js";

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

describe("generateModels", () => {
  it("generates a model with YARD-documented primitive fields", () => {
    const models: Model[] = [
      {
        name: "User",
        description: "A user record",
        fields: [
          { name: "id", type: { kind: "primitive", type: "string", format: "uuid" }, required: true },
          { name: "name", type: { kind: "primitive", type: "string" }, required: true, description: "The user name" },
          { name: "email", type: { kind: "primitive", type: "string" }, required: true },
          { name: "created_at", type: { kind: "primitive", type: "string", format: "date-time" }, required: false },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("lib/work_os/models/user.rb");
    const content = files[0].content;

    // YARD attribute docs
    expect(content).toContain("# @!attribute id");
    expect(content).toContain("#   @return [String]");
    expect(content).toContain("# @!attribute name");
    expect(content).toContain("#   The user name");
    expect(content).toContain("# @!attribute created_at");
    expect(content).toContain("#   @return [Time]");

    // Model description
    expect(content).toContain("# A user record");

    // Field declarations
    expect(content).toContain("required :id, String");
    expect(content).toContain("required :name, String");
    expect(content).toContain("optional :created_at, Time");
  });

  it("generates a model with nested model refs", () => {
    const models: Model[] = [
      {
        name: "Organization",
        fields: [
          { name: "id", type: { kind: "primitive", type: "string" }, required: true },
          { name: "owner", type: { kind: "model", name: "User" }, required: true },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    expect(files[0].content).toContain("required :owner, -> { WorkOS::Models::User }");
    expect(files[0].content).toContain("#   @return [WorkOS::Models::User]");
  });

  it("generates a model with enum refs", () => {
    const models: Model[] = [
      {
        name: "Organization",
        fields: [
          { name: "status", type: { kind: "enum", name: "OrganizationStatus" }, required: true },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    expect(files[0].content).toContain(
      "required :status, enum: -> { WorkOS::Models::OrganizationStatus }",
    );
    expect(files[0].content).toContain("#   @return [Symbol]");
  });

  it("generates a model with nullable fields", () => {
    const models: Model[] = [
      {
        name: "Organization",
        fields: [
          {
            name: "parent_id",
            type: { kind: "nullable", inner: { kind: "primitive", type: "string" } },
            required: false,
          },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    expect(files[0].content).toContain("optional :parent_id, String, nil?: true");
    expect(files[0].content).toContain("#   @return [String, nil]");
  });

  it("generates a model with array fields", () => {
    const models: Model[] = [
      {
        name: "Team",
        fields: [
          {
            name: "members",
            type: { kind: "array", items: { kind: "model", name: "User" } },
            required: true,
          },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    expect(files[0].content).toContain(
      "required :members, WorkOS::Internal::Type::ArrayOf[-> { WorkOS::Models::User }]",
    );
    expect(files[0].content).toContain("#   @return [Array<WorkOS::Models::User>]");
  });

  it("generates a model with union fields", () => {
    const models: Model[] = [
      {
        name: "Pet",
        fields: [
          {
            name: "data",
            type: {
              kind: "union",
              variants: [
                { kind: "model", name: "Dog" },
                { kind: "model", name: "Cat" },
              ],
            },
            required: true,
          },
        ],
      },
    ];

    const files = generateModels(models, ctx);
    expect(files[0].content).toContain(
      "required :data, WorkOS::Internal::Type::Union[-> { WorkOS::Models::Dog }, -> { WorkOS::Models::Cat }]",
    );
    expect(files[0].content).toContain("#   @return [WorkOS::Models::Dog, WorkOS::Models::Cat]");
  });

  it("generates multiple models as separate files", () => {
    const models: Model[] = [
      { name: "User", fields: [{ name: "id", type: { kind: "primitive", type: "string" }, required: true }] },
      { name: "Organization", fields: [{ name: "id", type: { kind: "primitive", type: "string" }, required: true }] },
    ];

    const files = generateModels(models, ctx);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("lib/work_os/models/user.rb");
    expect(files[1].path).toBe("lib/work_os/models/organization.rb");
  });
});
