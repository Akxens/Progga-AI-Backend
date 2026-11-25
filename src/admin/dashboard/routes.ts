import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requirePermission } from "../core/permissions";
import { sendOne } from "../core/respond";

export const dashboardRouter = Router();

/**
 * GET /api/admin/dashboard
 * High-level executive and operational metrics for the Control Centre dashboard.
 */
dashboardRouter.get("/", requirePermission("dashboard.executive.view"), async (req, res, next) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalStudents,
      activeTodayStudents,
      totalTutorSessions,
      todayTutorSessions,
      activeSubscriptions,
      activeSponsorships,
      schoolsCount,
      teachersCount,
      pendingApprovalsCount,
      pendingReviewsCount,
      recentAudits,
    ] = await Promise.all([
      prisma.user.count({ where: { role: "STUDENT" } }),
      prisma.user.count({
        where: {
          role: "STUDENT",
          lastSeenAt: { gte: todayStart },
        },
      }),
      prisma.tutorSession.count(),
      prisma.tutorSession.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.subscription.findMany({
        where: { status: "active" },
        include: { planVersion: { select: { priceAmount: true } } },
      }),
      prisma.sponsorship.count({ where: { status: "active" } }),
      prisma.school.count(),
      prisma.user.count({ where: { role: "TEACHER" } }),
      prisma.approval.count({ where: { status: "pending" } }),
      prisma.contentReview.count({ where: { status: "pending" } }),
      prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);

    // Calculate MRR
    const mrr = activeSubscriptions.reduce(
      (sum, s) => sum + Number(s.planVersion?.priceAmount || 0),
      0
    );

    sendOne(res, {
      kpis: {
        totalStudents,
        activeTodayStudents,
        totalTutorSessions,
        todayTutorSessions,
        mrr,
        activeSubscriptionsCount: activeSubscriptions.length,
        activeSponsoredSeats: activeSponsorships,
        schoolsCount,
        teachersCount,
        pendingActionsCount: pendingApprovalsCount + pendingReviewsCount,
      },
      recentActivity: recentAudits.map((a) => ({
        id: a.id,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        actorUserId: a.actorUserId || "System",
        timestamp: a.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});
