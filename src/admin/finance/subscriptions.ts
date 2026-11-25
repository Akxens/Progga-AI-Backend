import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { nextCode } from "../core/codes";
import { emitAudit } from "../core/audit";
import { recomputeEntitlement } from "../../modules/billing/entitlements";

export const financeSubscriptionsRouter = Router();

// GET /api/admin/subscriptions
financeSubscriptionsRouter.get(
  "/subscriptions",
  requirePermission("finance.subscriptions.view"),
  async (req, res, next) => {
    try {
      const {
        status,
        search,
        source,
        planId,
        page = "1",
        pageSize = "25",
      } = req.query as Record<string, string>;

      const where: any = {};
      if (status && status !== "all") where.status = status;
      if (source && source !== "all") where.source = source;
      if (planId) where.planVersion = { planId };
      if (search) {
        where.OR = [
          { code: { contains: search, mode: "insensitive" } },
          { user: { name: { contains: search, mode: "insensitive" } } },
          { user: { email: { contains: search, mode: "insensitive" } } },
          { user: { studentProfile: { studentCode: { contains: search, mode: "insensitive" } } } },
        ];
      }

      const p = Math.max(1, Number(page));
      const ps = Math.max(1, Math.min(100, Number(pageSize)));

      const [total, subscriptions] = await Promise.all([
        prisma.subscription.count({ where }),
        prisma.subscription.findMany({
          where,
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                grade: true,
                studentProfile: { select: { code: true } },
              },
            },
            planVersion: {
              include: {
                plan: { select: { id: true, code: true, name: true, accessType: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip: (p - 1) * ps,
          take: ps,
        }),
      ]);

      const items = subscriptions.map((s: any) => ({
        id: s.id,
        code: s.code,
        studentId: s.studentId,
        studentName: s.user.name,
        studentEmail: s.user.email,
        studentCode: s.user.studentProfile?.code || "",
        grade: s.user.grade || null,
        planId: s.planVersion.plan.id,
        planCode: s.planVersion.plan.code,
        planName: s.planVersion.plan.name,
        planVersionNumber: s.planVersion.versionNumber,
        priceAmount: Number(s.planVersion.priceAmount),
        currency: s.planVersion.currency,
        billingInterval: s.planVersion.billingInterval,
        status: s.status,
        source: s.source,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        autoRenew: s.autoRenew,
        createdAt: s.createdAt,
      }));

      return sendList(res, items, total);
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/admin/subscriptions/:id
financeSubscriptionsRouter.get(
  "/subscriptions/:id",
  requirePermission("finance.subscriptions.view"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const sub = await prisma.subscription.findUnique({
        where: { id },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              studentProfile: true,
            },
          },
          planVersion: {
            include: {
              plan: true,
            },
          },
          payments: {
            orderBy: { initiatedAt: "desc" },
          },
        },
      });

      if (!sub) return next(notFound("Subscription not found"));

      const s = sub as any;
      return sendOne(res, {
        ...s,
        planVersion: {
          ...s.planVersion,
          priceAmount: Number(s.planVersion.priceAmount),
        },
        payments: s.payments.map((p: any) => ({
          ...p,
          amount: Number(p.amount),
        })),
      });
    } catch (err) {
      return next(err);
    }
  }
);

const CancelSubscriptionSchema = z.object({
  mode: z.enum(["immediate", "period_end"]).default("period_end"),
  reason: z.string().trim().optional(),
});

// POST /api/admin/subscriptions/:id/cancel
financeSubscriptionsRouter.post(
  "/subscriptions/:id/cancel",
  requirePermission("finance.subscriptions.manage"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const parsed = CancelSubscriptionSchema.parse(req.body);
      const sub = await prisma.subscription.findUnique({
        where: { id },
      });
      if (!sub) return next(notFound("Subscription not found"));

      const isImmediate = parsed.mode === "immediate";
      const updated = await prisma.subscription.update({
        where: { id },
        data: {
          status: isImmediate ? "cancelled" : sub.status,
          currentPeriodEnd: isImmediate ? new Date() : sub.currentPeriodEnd,
          cancelAtPeriodEnd: !isImmediate,
          autoRenew: false,
        },
      });

      await recomputeEntitlement(sub.studentId);

      await emitAudit(req, {
        action: "cancel_subscription",
        entityType: "Subscription",
        entityId: sub.id,
        reason: parsed.reason,
        before: sub,
        after: updated,
      });

      return sendOne(res, updated);
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/admin/subscriptions/:id/renew
financeSubscriptionsRouter.post(
  "/subscriptions/:id/renew",
  requirePermission("finance.subscriptions.manage"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const sub = await prisma.subscription.findUnique({
        where: { id },
        include: { planVersion: true },
      });
      if (!sub) return next(notFound("Subscription not found"));

      const s = sub as any;
      const baseDate = s.currentPeriodEnd > new Date() ? s.currentPeriodEnd : new Date();
      const nextPeriodEnd = new Date(baseDate);
      if (s.planVersion.billingInterval === "year") {
        nextPeriodEnd.setFullYear(nextPeriodEnd.getFullYear() + 1);
      } else {
        nextPeriodEnd.setDate(nextPeriodEnd.getDate() + 30);
      }

      const updated = await prisma.subscription.update({
        where: { id },
        data: {
          status: "active",
          currentPeriodEnd: nextPeriodEnd,
          cancelAtPeriodEnd: false,
        },
      });

      await recomputeEntitlement(sub.studentId);

      await emitAudit(req, {
        action: "renew_subscription",
        entityType: "Subscription",
        entityId: sub.id,
        before: sub,
        after: updated,
      });

      return sendOne(res, updated);
    } catch (err) {
      return next(err);
    }
  }
);

const GrantEntitlementSchema = z.object({
  studentId: z.string().min(1),
  planVersionId: z.string().optional(),
  accessType: z.enum(["PREMIUM_PAID", "PREMIUM_SPONSORED"]).default("PREMIUM_SPONSORED"),
  source: z.enum(["csr_grant", "school_sponsored", "manual_admin"]).default("manual_admin"),
  days: z.coerce.number().int().min(1).max(365).default(30),
  reason: z.string().trim().min(3),
});

// POST /api/admin/entitlements/grants
financeSubscriptionsRouter.post(
  "/entitlements/grants",
  requirePermission("finance.entitlements.grant"),
  async (req, res, next) => {
    try {
      const parsed = GrantEntitlementSchema.parse(req.body);

      // Verify student exists
      const student = await prisma.user.findUnique({
        where: { id: parsed.studentId },
      });
      if (!student) return next(notFound("Student not found"));

      let planVersionId = parsed.planVersionId;
      if (!planVersionId) {
        // Find or create default sponsored plan version
        let defaultPlan = await prisma.plan.findFirst({
          where: { accessType: parsed.accessType, status: "active" },
          include: { versions: { where: { status: "active" }, take: 1 } },
        });

        if (!defaultPlan || defaultPlan.versions.length === 0) {
          const code = await nextCode("PLN");
          defaultPlan = await prisma.plan.create({
            data: {
              code,
              name: parsed.accessType === "PREMIUM_SPONSORED" ? "Sponsored Pro Grant" : "Admin Pro Grant",
              accessType: parsed.accessType,
              status: "active",
              versions: {
                create: {
                  versionNumber: 1,
                  priceAmount: 0,
                  currency: "BDT",
                  billingInterval: "month",
                  quotas: {
                    dailyTutorLimit: 100,
                    voiceMinutesPerDay: 30,
                    battleEnabled: true,
                  },
                  status: "active",
                },
              },
            },
            include: { versions: true },
          });
        }
        planVersionId = defaultPlan.versions[0].id;
      }

      const code = await nextCode("SUB");
      const now = new Date();
      const currentPeriodEnd = new Date(now.getTime() + parsed.days * 24 * 60 * 60 * 1000);

      const subscription = await prisma.subscription.create({
        data: {
          code,
          studentId: parsed.studentId,
          planVersionId: planVersionId!,
          status: "active",
          currentPeriodStart: now,
          currentPeriodEnd,
          source: parsed.source,
          autoRenew: false,
          metadata: { reason: parsed.reason },
        },
        include: {
          planVersion: { include: { plan: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      });

      const entitlement = await recomputeEntitlement(parsed.studentId);

      await emitAudit(req, {
        action: "grant_entitlement",
        entityType: "Subscription",
        entityId: subscription.id,
        reason: parsed.reason,
        after: { subscription, entitlement },
      });

      return sendOne(res, { subscription, entitlement }, 201);
    } catch (err) {
      return next(err);
    }
  }
);
