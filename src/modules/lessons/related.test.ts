import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ args: null as Record<string, unknown> | null }));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    lesson: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        calls.args = args;
        return [
          {
            id: "l1",
            subjectId: "math",
            title: "Linear Equations",
            chapter: "Algebra",
            description: "Solving linear equations",
            grade: 7,
            durationSec: 300,
            xpReward: 20,
            provider: "youtube",
            videoUrl: "abc123",
            subject: { id: "math", name: "Math", icon: "📐", color: "#2B7BE8" },
          },
        ];
      }),
    },
  },
}));

import { relatedLessons } from "./related";

describe("relatedLessons SQL projection", () => {
  it("filters by subject or nearby grade and omits heavy body/checkpoints columns", async () => {
    const res = await relatedLessons({ subject: "math", grade: 7, text: "linear equations" });
    expect(res).toHaveLength(1);
    expect(calls.args?.where).toEqual({
      OR: [{ subjectId: "math" }, { grade: { gte: 5, lte: 9 } }],
    });
    const select = calls.args?.select as Record<string, unknown>;
    expect(select.body).toBeUndefined();
    expect(select.checkpoints).toBeUndefined();
  });
});
