import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

export type JobHandler = (payload: any) => Promise<void>;

export const jobRegistry: Record<string, JobHandler> = {};

export function registerJob(type: string, handler: JobHandler) {
  jobRegistry[type] = handler;
}

// ── Outbox Dispatch Handler (TASK-009) ────────────────────────
registerJob("outbox-dispatch", async (_payload: any) => {
  const pendingRows = await prisma.outbox.findMany({
    where: {
      status: "pending",
      nextAttemptAt: { lte: new Date() },
    },
    take: 50,
    orderBy: { createdAt: "asc" },
  });

  for (const row of pendingRows) {
    try {
      // Route topic
      switch (row.topic) {
        case "notification.send":
          // Stub: logged until TASK-092
          logger.info({ payload: row.payload }, "Outbox routing notification.send");
          break;
        case "entitlement.recompute":
          // Stub: logged until TASK-082
          logger.info({ payload: row.payload }, "Outbox routing entitlement.recompute");
          break;
        case "metrics.invalidate":
          // Stub: logged until TASK-160
          logger.info({ payload: row.payload }, "Outbox routing metrics.invalidate");
          break;
        default:
          logger.info({ topic: row.topic, payload: row.payload }, "Outbox generic topic processed");
      }

      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: "done" },
      });
    } catch (err: any) {
      const attempts = row.attempts + 1;
      const dead = attempts >= 5;
      await prisma.outbox.update({
        where: { id: row.id },
        data: {
          attempts,
          status: dead ? "dead" : "pending",
          lastError: err.message,
          nextAttemptAt: new Date(Date.now() + Math.pow(2, attempts) * 60_000),
        },
      });
      logger.error({ err, topic: row.topic, outboxId: row.id }, "Outbox row processing failed");
    }
  }
});

// ── Finalize Stale Sessions Job (WF-STU-03) ───────────────────
registerJob("finalize-sessions", async (_payload: any) => {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60_000);
  const staleSessions = await prisma.learningSession.findMany({
    where: {
      isFinalized: false,
      lastHeartbeatAt: { lt: thirtyMinutesAgo },
    },
    take: 100,
  });

  for (const session of staleSessions) {
    await prisma.learningSession.update({
      where: { id: session.id },
      data: {
        isFinalized: true,
        endedAt: session.lastHeartbeatAt,
      },
    });
  }

  if (staleSessions.length > 0) {
    logger.info({ count: staleSessions.length }, "Finalized timed-out learning sessions");
  }
});

// Stubs for remaining jobs scheduled in system (log info/warn and resolve cleanly)
const defaultJobTypes = [
  "aggregate-metrics",
  "reconcile-payments",
  "report-generate",
  "expire-entitlements",
  "recognize-revenue",
  "safety-sla-check",
  "cleanup",
  "import-validate",
  "import-process",
  "send-scheduled-reports",
  "expire-orders",
];

for (const type of defaultJobTypes) {
  registerJob(type, async (payload: any) => {
    logger.info({ type, payload }, `Running stub job handler for ${type}`);
  });
}
