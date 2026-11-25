import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  user: {
    id: "u1",
    xp: 0,
    coins: 100,
    avatarSkin: "classic",
    streakDays: 2,
    bestStreak: 2,
    lastActiveDate: "2026-11-24",
  },
  items: new Set<string>(),
  xpEvents: [] as { userId: string; amount: number; reason: string; day: string }[],
}));

vi.mock("../../lib/dates", () => ({
  dayKey: () => "2026-11-25",
  addDays: () => "2026-11-24",
  weekStartKey: () => "2026-11-23",
  dayStartUtc: () => new Date("2026-11-25T00:00:00Z"),
}));

vi.mock("../../lib/prisma", () => {
  // Serializes interactive transactions just like PostgreSQL row locks on User.
  let txQueue = Promise.resolve();
  const makeClient = (draftUser: typeof mockState.user, draftItems: Set<string>, draftEvents: typeof mockState.xpEvents) => ({
    user: {
      findUniqueOrThrow: vi.fn(async () => ({ ...draftUser })),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.id && draftUser.id !== where.id) return { count: 0 };
        if (where.coins && typeof where.coins === "object" && "gte" in where.coins) {
          if (draftUser.coins < (where.coins as { gte: number }).gte) return { count: 0 };
        }
        if ("lastActiveDate" in where && draftUser.lastActiveDate !== where.lastActiveDate) return { count: 0 };

        if (data.coins && typeof data.coins === "object" && "decrement" in data.coins) {
          draftUser.coins -= (data.coins as { decrement: number }).decrement;
        }
        if (typeof data.avatarSkin === "string") draftUser.avatarSkin = data.avatarSkin;
        if (typeof data.streakDays === "number") draftUser.streakDays = data.streakDays;
        if (typeof data.bestStreak === "number") draftUser.bestStreak = data.bestStreak;
        if (typeof data.lastActiveDate === "string") draftUser.lastActiveDate = data.lastActiveDate;
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (data.xp && typeof data.xp === "object" && "increment" in data.xp) {
          draftUser.xp += (data.xp as { increment: number }).increment;
        }
        if (data.coins && typeof data.coins === "object" && "increment" in data.coins) {
          draftUser.coins += (data.coins as { increment: number }).increment;
        }
        return { ...draftUser };
      }),
    },
    userItem: {
      findUnique: vi.fn(async ({ where }: { where: { userId_itemId: { itemId: string } } }) =>
        draftItems.has(where.userId_itemId.itemId) ? { id: where.userId_itemId.itemId } : null,
      ),
      findMany: vi.fn(async () => [...draftItems].map((itemId) => ({ itemId }))),
      create: vi.fn(async ({ data }: { data: { itemId: string } }) => {
        if (draftItems.has(data.itemId)) throw Object.assign(new Error("Unique"), { code: "P2002" });
        draftItems.add(data.itemId);
        return { id: data.itemId, ...data };
      }),
    },
    xpEvent: {
      create: vi.fn(async ({ data }: { data: { userId: string; amount: number; reason: string; day: string } }) => {
        draftEvents.push(data);
        return data;
      }),
      createMany: vi.fn(async ({ data }: { data: { userId: string; amount: number; reason: string; day: string }[] }) => {
        draftEvents.push(...data);
        return { count: data.length };
      }),
      groupBy: vi.fn(async () => []),
    },
    userBadge: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    tutorSession: {
      count: vi.fn(async () => 0),
    },
  });

  return {
    prisma: {
      ...makeClient(mockState.user, mockState.items, mockState.xpEvents),
      user: {
        findUniqueOrThrow: vi.fn(async () => ({ ...mockState.user })),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      userItem: {
        findMany: vi.fn(async () => [...mockState.items].map((itemId) => ({ itemId }))),
      },
      xpEvent: {
        groupBy: vi.fn(async () => []),
      },
      userBadge: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      tutorSession: {
        count: vi.fn(async () => 0),
      },
      $transaction: <T>(fn: (tx: ReturnType<typeof makeClient>) => Promise<T>) => {
        const run = txQueue.then(async () => {
          const draftUser = { ...mockState.user };
          const draftItems = new Set(mockState.items);
          const draftEvents = [...mockState.xpEvents];
          const res = await fn(makeClient(draftUser, draftItems, draftEvents));
          mockState.user = draftUser;
          mockState.items = draftItems;
          mockState.xpEvents = draftEvents;
          return res;
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

import { award, buySkin } from "./service";

describe("gamification concurrency", () => {
  beforeEach(() => {
    mockState.user = {
      id: "u1",
      xp: 0,
      coins: 100,
      avatarSkin: "classic",
      streakDays: 2,
      bestStreak: 2,
      lastActiveDate: "2026-11-24",
    };
    mockState.items = new Set();
    mockState.xpEvents = [];
  });

  it("prevents concurrent skin purchases from driving coins negative", async () => {
    const [a, b] = await Promise.allSettled([buySkin("u1", "mango"), buySkin("u1", "mint")]); // 60 + 80 > 100 coins
    const wins = [a, b].filter((r) => r.status === "fulfilled");
    const losses = [a, b].filter((r) => r.status === "rejected");

    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(mockState.user.coins).toBeGreaterThanOrEqual(0);
    expect(mockState.items.size).toBe(1);
  });

  it("grants daily streak milestone XP once across concurrent award() calls", async () => {
    const [a, b] = await Promise.all([
      award("u1", [{ amount: 10, reason: "tutor_step" }]),
      award("u1", [{ amount: 10, reason: "quiz_finish" }]),
    ]);

    const streakEvents = mockState.xpEvents.filter((e) => e.reason === "streak");
    expect(streakEvents).toHaveLength(1);
    expect(streakEvents[0].amount).toBe(15); // day 3 milestone
    expect(a.xpGained + b.xpGained).toBe(10 + 10 + 15);
    expect(mockState.user.streakDays).toBe(3);
  });
});
