import type { PrismaClient } from "@prisma/client";

const TICKET_TTL_MS = 24 * 60 * 60 * 1000;
const CLIP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Removes abandoned battle matchmaking tickets (> 24h) and old cached TTS audio
 * clips (> 30d; re-synthesized seamlessly on replay).
 */
export async function cleanupExpiredArtifacts(
  db: Pick<PrismaClient, "battleTicket" | "speechClip">,
  now = new Date(),
) {
  const ticketCutoff = new Date(now.getTime() - TICKET_TTL_MS);
  const clipCutoff = new Date(now.getTime() - CLIP_TTL_MS);
  const [tickets, clips] = await Promise.all([
    db.battleTicket.deleteMany({ where: { createdAt: { lt: ticketCutoff } } }),
    db.speechClip.deleteMany({ where: { createdAt: { lt: clipCutoff } } }),
  ]);
  return { deletedTickets: tickets.count, deletedClips: clips.count };
}
