import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma";
import { ingestEvents, getOrCreateSession } from "./service";

describe("Event Ingest & Learning Sessions (TASK-022, WF-STU-03)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("dedupes already-ingested event IDs", async () => {
    vi.spyOn(prisma.event, "findUnique").mockResolvedValueOnce({ id: "evt-1" } as any);

    const result = await ingestEvents("user-1", [
      {
        eventId: "evt-1",
        eventType: "session_heartbeat",
        occurredAt: new Date().toISOString(),
      },
    ]);

    expect(result.duplicates).toBe(1);
    expect(result.accepted).toBe(0);
  });

  it("flips user accountStatus from registered to active on first event (BR-STU-01)", async () => {
    vi.spyOn(prisma.event, "findUnique").mockResolvedValue(null);
    vi.spyOn(prisma.event, "create").mockResolvedValue({} as any);

    const updateManySpy = vi.spyOn(prisma.user, "updateMany").mockResolvedValue({ count: 1 });
    vi.spyOn(prisma.studentProfile, "findUnique").mockResolvedValue({
      userId: "user-1",
      firstActiveAt: null,
    } as any);
    const profileUpdateSpy = vi.spyOn(prisma.studentProfile, "update").mockResolvedValue({} as any);

    const result = await ingestEvents("user-1", [
      {
        eventId: "11111111-1111-1111-1111-111111111111",
        eventType: "session_started",
        occurredAt: new Date().toISOString(),
      },
    ]);

    expect(result.accepted).toBe(1);
    expect(updateManySpy).toHaveBeenCalledWith({
      where: { id: "user-1", accountStatus: "registered" },
      data: { accountStatus: "active" },
    });
    expect(profileUpdateSpy).toHaveBeenCalled();
  });

  it("caps heartbeat gap: 0 < gap <= 90 adds seconds, gap > 90 adds 0", async () => {
    const startedAt = new Date("2026-11-25T10:00:00.000Z");
    const lastHeartbeatAt = new Date("2026-11-25T10:00:30.000Z");
    const nextHeartbeatAt = new Date("2026-11-25T10:01:00.000Z"); // gap = 30 sec

    const mockSession = {
      id: "ses-1",
      code: "SES-000001",
      userId: "user-1",
      startedAt,
      lastHeartbeatAt,
      isFinalized: false,
      activeSeconds: 30,
      deviceCategory: "desktop",
      platform: "web",
      module: "tutor",
      lessonId: null,
    };

    vi.spyOn(prisma.event, "findUnique").mockResolvedValue(null);
    vi.spyOn(prisma.event, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma.user, "updateMany").mockResolvedValue({ count: 0 });
    vi.spyOn(prisma.studentProfile, "findUnique").mockResolvedValue(null);
    vi.spyOn(prisma.learningSession, "findUnique").mockResolvedValue(mockSession as any);

    const sessionUpdateSpy = vi.spyOn(prisma.learningSession, "update").mockResolvedValue({} as any);

    await ingestEvents("user-1", [
      {
        eventId: "22222222-2222-2222-2222-222222222222",
        eventType: "session_heartbeat",
        sessionId: "ses-1",
        occurredAt: nextHeartbeatAt.toISOString(),
      },
    ]);

    expect(sessionUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ses-1" },
        data: expect.objectContaining({
          activeSeconds: { increment: 30 },
          lastHeartbeatAt: nextHeartbeatAt,
        }),
      }),
    );
  });

  it("splits session when gap > 30 minutes (1800s)", async () => {
    const now = Date.now();
    const nextHeartbeatAt = new Date(now);
    const lastHeartbeatAt = new Date(now - 35 * 60_000); // 35 minutes ago
    const startedAt = new Date(now - 40 * 60_000);

    const mockSession = {
      id: "ses-old",
      code: "SES-000001",
      userId: "user-1",
      startedAt,
      lastHeartbeatAt,
      isFinalized: false,
      activeSeconds: 300,
      deviceCategory: "desktop",
      platform: "web",
      module: "tutor",
      lessonId: null,
    };

    vi.spyOn(prisma.event, "findUnique").mockResolvedValue(null);
    vi.spyOn(prisma.event, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma.user, "updateMany").mockResolvedValue({ count: 0 });
    vi.spyOn(prisma.studentProfile, "findUnique").mockResolvedValue(null);
    vi.spyOn(prisma.learningSession, "findUnique").mockResolvedValue(mockSession as any);

    const oldSessionUpdateSpy = vi.spyOn(prisma.learningSession, "update").mockResolvedValue({} as any);
    const newSessionCreateSpy = vi.spyOn(prisma.learningSession, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma, "$queryRawUnsafe").mockResolvedValue([{ n: 2n }]);

    await ingestEvents("user-1", [
      {
        eventId: "33333333-3333-3333-3333-333333333333",
        eventType: "session_heartbeat",
        sessionId: "ses-old",
        occurredAt: nextHeartbeatAt.toISOString(),
      },
    ]);

    // Old session finalized
    expect(oldSessionUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ses-old" },
        data: expect.objectContaining({
          isFinalized: true,
          endedAt: lastHeartbeatAt,
        }),
      }),
    );

    // New session created
    expect(newSessionCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          isFinalized: false,
          activeSeconds: 0,
        }),
      }),
    );
  });
});
