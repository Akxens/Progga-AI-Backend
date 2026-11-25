import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { jobRegistry } from "./registry";

export interface TickSummary {
  processed: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}

export async function enqueueDueSchedules(): Promise<number> {
  const now = new Date();
  const dueSchedules = await prisma.jobSchedule.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
    },
  });

  let enqueued = 0;
  for (const schedule of dueSchedules) {
    await prisma.$transaction(async (tx) => {
      // Check if job of this type is already queued
      const existing = await tx.job.findFirst({
        where: { type: schedule.type, status: "queued" },
      });

      if (!existing) {
        await tx.job.create({
          data: {
            type: schedule.type,
            runAt: now,
            status: "queued",
          },
        });
        enqueued++;
      }

      const nextRunAt = new Date(now.getTime() + schedule.everyMinutes * 60_000);
      await tx.jobSchedule.update({
        where: { id: schedule.id },
        data: { nextRunAt },
      });
    });
  }

  return enqueued;
}

export async function tickJobs(timeoutMs = 50_000): Promise<TickSummary> {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  await enqueueDueSchedules().catch((err) => {
    logger.error({ err }, "Failed to enqueue due schedules");
  });

  // Claim up to 10 due jobs using SKIP LOCKED
  const claimedJobs = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Job"
      WHERE status = 'queued' AND "runAt" <= NOW()
      ORDER BY "runAt" ASC
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    `;

    if (!rows || rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    // Increment attempts and set locked status
    await tx.$executeRaw`
      UPDATE "Job"
      SET status = 'running',
          "lockedAt" = NOW(),
          attempts = attempts + 1
      WHERE id = ANY(${ids}::text[])
    `;

    return tx.job.findMany({
      where: { id: { in: ids } },
    });
  });

  let succeeded = 0;
  let failed = 0;

  for (const job of claimedJobs) {
    if (Date.now() >= deadline) {
      logger.warn({ jobId: job.id }, "Job tick reached timeout budget before completing all jobs");
      break;
    }

    const handler = jobRegistry[job.type];
    if (!handler) {
      logger.error({ type: job.type }, "No handler registered for job type");
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "dead",
          lastError: `Unknown job type: ${job.type}`,
          finishedAt: new Date(),
        },
      });
      failed++;
      continue;
    }

    try {
      await handler(job.payload);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
        },
      });
      succeeded++;
    } catch (err: any) {
      failed++;
      const currentAttempts = job.attempts;
      const isDead = currentAttempts >= job.maxAttempts;

      if (isDead) {
        await prisma.$transaction(async (tx) => {
          await tx.job.update({
            where: { id: job.id },
            data: {
              status: "dead",
              lastError: err?.message || String(err),
              finishedAt: new Date(),
            },
          });

          await tx.systemAlert.create({
            data: {
              severity: "critical",
              source: "job",
              message: `Job ${job.type} (${job.id}) failed after ${job.maxAttempts} attempts: ${err?.message || err}`,
              details: {
                jobId: job.id,
                type: job.type,
                attempts: currentAttempts,
                error: err?.message || String(err),
              },
            },
          });
        });
        logger.error({ err, jobId: job.id, type: job.type }, "Job reached maximum attempts and marked dead");
      } else {
        const backoffMinutes = Math.pow(2, currentAttempts);
        const nextRunAt = new Date(Date.now() + backoffMinutes * 60_000);

        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "queued",
            runAt: nextRunAt,
            lastError: err?.message || String(err),
          },
        });
        logger.warn(
          { jobId: job.id, type: job.type, currentAttempts, nextRunAt },
          "Job failed; scheduled retry with exponential backoff",
        );
      }
    }
  }

  const durationMs = Date.now() - startTime;
  return {
    processed: claimedJobs.length,
    succeeded,
    failed,
    durationMs,
  };
}
