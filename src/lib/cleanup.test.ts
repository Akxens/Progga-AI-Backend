import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredArtifacts } from "./cleanup";

describe("cleanupExpiredArtifacts", () => {
  it("deletes BattleTicket > 24h and SpeechClip > 30d with exact cutoffs", async () => {
    const ticketDelete = vi.fn(async () => ({ count: 4 }));
    const clipDelete = vi.fn(async () => ({ count: 9 }));
    const now = new Date("2026-11-30T12:00:00Z");

    const res = await cleanupExpiredArtifacts(
      { battleTicket: { deleteMany: ticketDelete }, speechClip: { deleteMany: clipDelete } } as never,
      now,
    );

    expect(res).toEqual({ deletedTickets: 4, deletedClips: 9 });
    expect(ticketDelete).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-11-29T12:00:00.000Z") } },
    });
    expect(clipDelete).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-10-31T12:00:00.000Z") } },
    });
  });
});
