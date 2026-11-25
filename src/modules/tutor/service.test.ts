import { beforeEach, describe, expect, it, vi } from "vitest";
import { newProgress } from "./engine";
import type { Plan } from "./schemas";

const mockStore = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  messages: [] as { id: string; role: string; kind: string; content: string; stepIndex: number | null; meta: unknown; createdAt: Date }[],
  awardCalls: 0,
  startedToday: 0,
  dailyLimit: 25,
}));

vi.mock("../gamification/service", () => ({
  award: vi.fn(async () => {
    mockStore.awardCalls++;
    return { xpGained: 15, coinsGained: 3, totalXp: 15, level: 1, leveledUp: false, streak: 1, newBadges: [] };
  }),
}));

vi.mock("../lessons/related", () => ({
  relatedLessons: vi.fn(async () => []),
}));

vi.mock("../../lib/prisma", () => {
  let txQueue = Promise.resolve();
  return {
    prisma: {
      user: {
        findUniqueOrThrow: vi.fn(async () => ({ id: "student-1", language: "en", grade: 6, dailyTutorLimit: mockStore.dailyLimit })),
      },
      lesson: {
        findUnique: vi.fn(async () => null),
      },
      tutorSession: {
        count: vi.fn(async () => mockStore.startedToday),
        findUnique: vi.fn(async () => (mockStore.session ? { ...mockStore.session } : null)),
      },
      tutorMessage: {
        findMany: vi.fn(async () => [...mockStore.messages]),
        count: vi.fn(async () => 0),
      },
      $transaction: <T>(
        fn: (tx: {
          $queryRaw: () => Promise<unknown[]>;
          tutorSession: {
            count: () => Promise<number>;
            create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
            updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
            findUniqueOrThrow: () => Promise<Record<string, unknown>>;
          };
          tutorMessage: {
            createManyAndReturn: (args: { data: Record<string, unknown>[] }) => Promise<Record<string, unknown>[]>;
          };
        }) => Promise<T>,
      ) => {
        const run = txQueue.then(() => {
          const draftSession = mockStore.session ? { ...mockStore.session } : null;
          const draftMessages = [...mockStore.messages];
          const tx = {
            $queryRaw: async () => [],
            tutorSession: {
              count: async () => mockStore.startedToday,
              create: async ({ data }: { data: Record<string, unknown> }) => {
                mockStore.startedToday++;
                const created = {
                  id: `sess-${mockStore.startedToday}`,
                  createdAt: new Date("2026-11-25T00:00:00Z"),
                  updatedAt: new Date("2026-11-25T00:00:00Z"),
                  xpEarned: 0,
                  currentStep: 0,
                  hintsUsed: 0,
                  wrongAttempts: 0,
                  ...data,
                };
                mockStore.session = created;
                return created;
              },
              updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                if (
                  !draftSession ||
                  draftSession.status !== where.status ||
                  draftSession.currentStep !== where.currentStep ||
                  draftSession.hintsUsed !== where.hintsUsed ||
                  draftSession.wrongAttempts !== where.wrongAttempts ||
                  (draftSession.updatedAt as Date).getTime() !== (where.updatedAt as Date).getTime()
                ) {
                  return { count: 0 };
                }
                Object.assign(draftSession, data);
                if (data.xpEarned && typeof data.xpEarned === "object" && "increment" in data.xpEarned) {
                  draftSession.xpEarned = (mockStore.session!.xpEarned as number) + (data.xpEarned as { increment: number }).increment;
                }
                return { count: 1 };
              },
              findUniqueOrThrow: async () => ({ ...draftSession! }),
            },
            tutorMessage: {
              createManyAndReturn: async ({ data }: { data: Record<string, unknown>[] }) => {
                const inserted = data.map((d) => {
                  const msg = {
                    id: `msg-${draftMessages.length + 1}`,
                    role: d.role as string,
                    kind: d.kind as string,
                    content: d.content as string,
                    stepIndex: (d.stepIndex as number | undefined) ?? null,
                    meta: d.meta ?? null,
                    createdAt: d.createdAt as Date,
                  };
                  draftMessages.push(msg);
                  return msg;
                });
                return inserted;
              },
            },
          };
          return fn(tx).then((res) => {
            if (draftSession) mockStore.session = draftSession;
            mockStore.messages = draftMessages;
            return res;
          });
        });
        txQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    },
  };
});

import { hint, reply, startSession } from "./service";

const plan: Plan = {
  safety: "ok",
  safety_reply: "",
  mode: "problem",
  title: "Linear",
  topic: "Linear equations",
  big_idea: "Isolate x",
  intro: "Let's go!",
  key_idea: "Subtract first.",
  steps: [
    {
      goal: "Subtract 5",
      prompt: "What is 20 - 5?",
      expected: "15",
      options: ["15", "25", "10", "5"],
      hints: ["Subtract 5", "20 - 5", "Almost there"],
      why: "Keeps balance.",
      explain: "Subtract on both sides.",
    },
    {
      goal: "Divide by 3",
      prompt: "If 3x = 15, x = ?",
      expected: "5",
      options: ["5", "12", "45", "3"],
      hints: ["Divide by 3", "15 / 3", "One step"],
      why: "Finds x.",
      explain: "Divide both sides.",
    },
  ],
  final_answer: "x = 5",
  walkthrough: "Subtract then divide.",
  recap: "Done",
  practice_problem: "2x = 8",
  answer: "",
  more_info: [],
  fun_fact: "",
  explore_next: [],
};

describe("tutor service concurrency & edge guards", () => {
  beforeEach(() => {
    mockStore.awardCalls = 0;
    mockStore.startedToday = 0;
    mockStore.dailyLimit = 25;
    mockStore.messages = [];
    mockStore.session = {
      id: "sess-1",
      studentId: "student-1",
      subject: "math",
      grade: 6,
      mode: "problem",
      kind: "question",
      language: "en",
      title: "Linear",
      topic: "Linear equations",
      problemText: "3x + 5 = 20",
      hadImage: false,
      status: "active",
      plan,
      progress: newProgress(plan),
      currentStep: 0,
      hintsUsed: 0,
      wrongAttempts: 0,
      xpEarned: 0,
      lessonId: null,
      createdAt: new Date("2026-11-25T00:00:00Z"),
      updatedAt: new Date("2026-11-25T00:00:00Z"),
    };
  });

  it("rejects overlapping reply calls against the same turn with 409 and awards XP once", async () => {
    const fakeLlm = {
      evaluate: vi.fn(async () => ({
        verdict: "correct" as const,
        feedback: "Spot on!",
        follow_up: "",
        misconception: "",
      })),
    };

    const [a, b] = await Promise.allSettled([
      reply("student-1", "sess-1", "15", undefined, fakeLlm as never),
      reply("student-1", "sess-1", "15", undefined, fakeLlm as never),
    ]);

    const ok = [a, b].filter((r) => r.status === "fulfilled");
    const err = [a, b].filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect((err[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(mockStore.awardCalls).toBe(1);
    expect(mockStore.session?.currentStep).toBe(1);
    expect(mockStore.messages.filter((m) => m.role === "student")).toHaveLength(1);
  });

  it("serializes concurrent hint() calls so hintsUsed advances only once", async () => {
    const [a, b] = await Promise.allSettled([hint("student-1", "sess-1"), hint("student-1", "sess-1")]);
    expect([a, b].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect([a, b].filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(mockStore.session?.hintsUsed).toBe(1);
  });

  it("blocks concurrent startSession calls past dailyTutorLimit and throws 502 on empty problem steps", async () => {
    mockStore.startedToday = 24;
    mockStore.dailyLimit = 25;
    const slowPlanLlm = {
      plan: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return plan;
      }),
    };
    const [s1, s2] = await Promise.allSettled([
      startSession("student-1", { question: "Solve 3x+5=20", subject: "math" }, undefined, slowPlanLlm as never),
      startSession("student-1", { question: "Solve 2x+1=5", subject: "math" }, undefined, slowPlanLlm as never),
    ]);
    expect([s1, s2].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect([s1, s2].filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(mockStore.startedToday).toBe(25);

    mockStore.startedToday = 0;
    const emptyStepLlm = {
      plan: vi.fn(async () => ({ ...plan, safety: "ok" as const, steps: [] })),
    };
    await expect(startSession("student-1", { question: "Solve x", subject: "math" }, undefined, emptyStepLlm as never)).rejects.toMatchObject({
      status: 502,
      code: "llm_parse",
    });
  });
});
