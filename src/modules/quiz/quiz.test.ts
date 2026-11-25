import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  attempt: null as {
    id: string;
    userId: string;
    subjectId: string;
    grade: number;
    questionIds: string[];
    answers: unknown[];
    combo: number;
    bestCombo: number;
    hearts: number;
    score: number;
    correctCount: number;
    finishedAt: Date | null;
    createdAt: Date;
  } | null,
  awardCalls: 0,
}));

vi.mock("../gamification/service", () => ({
  award: vi.fn(async () => {
    state.awardCalls++;
    return { xpGained: 20, coinsGained: 4, totalXp: 100, level: 2, leveledUp: false, streak: 1, newBadges: [] };
  }),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    quizAttempt: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.attempt && state.attempt.id === where.id ? { ...state.attempt, answers: [...state.attempt.answers] } : null,
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (!state.attempt || state.attempt.id !== where.id) throw new Error("Not found");
        return { ...state.attempt, answers: [...state.attempt.answers] };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const a = state.attempt;
        // Simulate atomic PostgreSQL row-locked conditional UPDATE
        if (
          !a ||
          a.id !== where.id ||
          a.finishedAt !== where.finishedAt ||
          a.hearts !== where.hearts ||
          a.correctCount !== where.correctCount ||
          a.combo !== where.combo ||
          a.score !== where.score
        ) {
          return { count: 0 };
        }
        state.attempt = { ...a, ...(data as Partial<typeof a>) };
        return { count: 1 };
      }),
    },
    quizQuestion: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        answerIndex: 1,
        explanation: "Because 2 + 2 = 4",
      })),
    },
  },
}));

import { answerQuizAttempt, scoreAnswer } from "./routes";

describe("quiz scoring and concurrency", () => {
  beforeEach(() => {
    state.awardCalls = 0;
    state.attempt = {
      id: "att-1",
      userId: "user-1",
      subjectId: "math",
      grade: 6,
      questionIds: ["q1", "q2"],
      answers: [{ questionId: "q1", choice: 1, correct: true, ms: 2000, points: 143 }],
      combo: 1,
      bestCombo: 1,
      hearts: 3,
      score: 143,
      correctCount: 1,
      finishedAt: null,
      createdAt: new Date(),
    };
  });

  it("calculates score with speed bonus and capped 2x combo", () => {
    expect(scoreAnswer(false, 100, 5)).toBe(0);
    expect(scoreAnswer(true, 0, 0)).toBe(150);
    expect(scoreAnswer(true, 0, 10)).toBe(300);
    expect(scoreAnswer(true, 15_000, 0)).toBe(100);
  });

  it("allows only one concurrent final-question submit to settle and call award()", async () => {
    const [r1, r2] = await Promise.allSettled([
      answerQuizAttempt("user-1", "att-1", { questionId: "q2", choice: 1, ms: 1000 }),
      answerQuizAttempt("user-1", "att-1", { questionId: "q2", choice: 1, ms: 1000 }),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(state.awardCalls).toBe(1);
    expect(state.attempt?.correctCount).toBe(2);
    expect(state.attempt?.finishedAt).toBeInstanceOf(Date);
  });
});
