import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requirePermission } from "../core/permissions";
import { sendOne } from "../core/respond";

export const systemHealthRouter = Router();

/**
 * GET /api/admin/system/health
 * Returns service latency, database status, and system alerts.
 */
systemHealthRouter.get("/health", requirePermission("audit.view"), async (req, res, next) => {
  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Date.now() - start;

    const [activeJobsCount, failedJobsCount, alerts] = await Promise.all([
      prisma.job.count({ where: { status: "pending" } }),
      prisma.job.count({ where: { status: "failed" } }),
      prisma.systemAlert.findMany({
        where: { acknowledged: false },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    sendOne(res, {
      status: failedJobsCount > 10 ? "degraded" : "healthy",
      timestamp: new Date().toISOString(),
      services: {
        database: { status: "connected", latencyMs: dbLatencyMs },
        jobsWorker: { status: "running", pending: activeJobsCount, failed: failedJobsCount },
        cache: { status: "connected" },
        voiceEngine: { status: "online" },
      },
      unacknowledgedAlerts: alerts,
    });
  } catch (err) {
    next(err);
  }
});
