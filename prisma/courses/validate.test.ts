import { describe, expect, it } from "vitest";
import { validateCourseCatalog } from "./validate";

describe("seeded NCTB courses", () => {
  it("contains valid metadata, options, and checkpoint answerIndex bounds", () => {
    expect(validateCourseCatalog()).toEqual([]);
  });
});
