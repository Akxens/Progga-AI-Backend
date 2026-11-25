import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requirePermission } from "../core/permissions";
import { sendOne } from "../core/respond";

export const workQueueRouter = Router();

/**
 * GET /api/admin/work-queue
 * Unified administrative work-queue aggregating pending maker-checker approvals,
 * content moderation reviews, flagged safety items, and pending payment verifications.
 */
workQueueRouter.get("/", requirePermission("workqueue.view"), async (req, res, next) => {
  try {
    const [pendingApprovals, pendingReviews, safetyEvents, pendingPayments] = await Promise.all([
      prisma.approval.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.contentReview.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.safetyEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.paymentTransaction.findMany({
        where: { status: "pending" },
        orderBy: { initiatedAt: "desc" },
        take: 20,
        include: {
          user: { select: { id: true, name: true } },
        },
      }),
    ]);

    const items = [
      ...pendingApprovals.map((a) => ({
        id: a.id,
        type: "approval",
        category: a.type,
        title: `Approval Required: ${a.summary}`,
        description: `Target: ${a.entityType} (${a.entityId})`,
        requestedBy: a.requestedById,
        priority: "high",
        createdAt: a.createdAt,
        actionUrl: `/admin/system/approvals`,
      })),
      ...pendingReviews.map((r) => ({
        id: r.id,
        type: "content_review",
        category: r.targetType,
        title: `Content Moderation: ${r.targetType.toUpperCase()}`,
        description: `Version ${r.version} submitted for academic review`,
        requestedBy: r.submittedById,
        priority: "medium",
        createdAt: r.createdAt,
        actionUrl: `/admin/content-review`,
      })),
      ...safetyEvents.map((s) => ({
        id: s.id,
        type: "safety_alert",
        category: s.category,
        title: `Safety Flag: ${s.category.toUpperCase()}`,
        description: `Student: ${s.user?.name || s.userId} - Excerpt: "${s.excerpt.slice(0, 80)}"`,
        requestedBy: "AI Guardian",
        priority: s.category === "wellbeing" ? "urgent" : "medium",
        createdAt: s.createdAt,
        actionUrl: `/admin/safety`,
      })),
      ...pendingPayments.map((p) => ({
        id: p.id,
        type: "payment_verification",
        category: p.provider,
        title: `Unverified Transaction: ${p.code}`,
        description: `Amount: ৳${Number(p.amount).toFixed(2)} (${p.provider.toUpperCase()}) - Student: ${p.user?.name || "Student"}`,
        requestedBy: "Gateway Webhook",
        priority: "medium",
        createdAt: p.initiatedAt,
        actionUrl: `/admin/finance/payments/${p.id}`,
      })),
    ];

    // Sort combined queue by creation date descending
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    sendOne(res, {
      totalPending: items.length,
      counts: {
        approvals: pendingApprovals.length,
        contentReviews: pendingReviews.length,
        safetyAlerts: safetyEvents.length,
        payments: pendingPayments.length,
      },
      items,
    });
  } catch (err) {
    next(err);
  }
});
