import { describe, it, expect } from "vitest";
import { detectPagination } from "../../src/parser/pagination.js";
import type { TypeRef, Parameter } from "../../src/ir/types.js";

describe("detectPagination", () => {
  const makeParam = (name: string): Parameter => ({
    name,
    type: { kind: "primitive", type: "string" },
    required: false,
  });

  it("returns true when cursor param present", () => {
    const response: TypeRef = { kind: "primitive", type: "string" };
    expect(detectPagination(response, [makeParam("cursor")])).toBe(true);
  });

  it("returns true when after param present", () => {
    const response: TypeRef = { kind: "primitive", type: "string" };
    expect(detectPagination(response, [makeParam("after")])).toBe(true);
  });

  it("returns true when before param present", () => {
    const response: TypeRef = { kind: "primitive", type: "string" };
    expect(detectPagination(response, [makeParam("before")])).toBe(true);
  });

  it("returns true when starting_after param present", () => {
    const response: TypeRef = { kind: "primitive", type: "string" };
    expect(detectPagination(response, [makeParam("starting_after")])).toBe(
      true,
    );
  });

  it("returns false when no cursor param", () => {
    const response: TypeRef = { kind: "primitive", type: "string" };
    expect(detectPagination(response, [makeParam("limit")])).toBe(false);
  });

  it("returns false with empty params", () => {
    const response: TypeRef = { kind: "primitive", type: "string" };
    expect(detectPagination(response, [])).toBe(false);
  });
});
