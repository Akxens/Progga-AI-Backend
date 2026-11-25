import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { nextCode } from "../core/codes";
import { emitAudit } from "../core/audit";

export const financePlansRouter = Router();

// GET /api/admin/plans and /api/admin/finance/plans
financePlansRouter.get(
  "/plans",
  requirePermission("finance.plans.view"),
  async (req, res, next) => {
    try {
      const { status, search } = req.query as Record<string, string>;
      const where: any = {};
      if (status && status !== "all") where.status = status;
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { code: { contains: search, mode: "insensitive" } },
        ];
      }

      const plans = await prisma.plan.findMany({
        where,
        include: {
          versions: {
            orderBy: { versionNumber: "desc" },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // Augment each plan with subscription count
      const planIds = plans.map((p) => p.id);
      const versionIds = plans.flatMap((p) => p.versions.map((v) => v.id));

      const subCounts = await prisma.subscription.groupBy({
        by: ["planVersionId"],
        where: {
          planVersionId: { in: versionIds },
          status: "active",
        },
        _count: { id: true },
      });

      const countMap = new Map<string, number>();
      for (const row of subCounts) {
        countMap.set(row.planVersionId, row._count.id);
      }

      const items = plans.map((p) => {
        const activeVersion = p.versions.find((v) => v.status === "active") || p.versions[0];
        const totalActiveSubs = p.versions.reduce(
          (sum: number, v: any) => sum + (countMap.get(v.id) || 0),
          0
        );
        return {
          id: p.id,
          code: p.code,
          name: p.name,
          description: p.description,
          accessType: p.accessType,
          status: p.status,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          versionsCount: p.versions.length,
          activeVersion: activeVersion
            ? {
                id: activeVersion.id,
                versionNumber: activeVersion.versionNumber,
                priceAmount: Number(activeVersion.priceAmount),
                currency: activeVersion.currency,
                billingInterval: activeVersion.billingInterval,
                trialDays: activeVersion.trialDays,
                quotas: activeVersion.quotas,
                status: activeVersion.status,
              }
            : null,
          totalActiveSubs,
        };
      });

      return sendList(res, items, items.length);
    } catch (err) {
      return next(err);
    }
  }
);

const CreatePlanSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().default(""),
  accessType: z.enum(["FREE", "PREMIUM_PAID", "PREMIUM_SPONSORED"]).default("PREMIUM_PAID"),
  priceAmount: z.coerce.number().min(0).default(0),
  currency: z.string().default("BDT"),
  billingInterval: z.enum(["month", "year", "one_time"]).default("month"),
  trialDays: z.coerce.number().int().min(0).default(0),
  quotas: z
    .record(z.string(), z.any())
    .default({ dailyTutorLimit: 100, voiceMinutesPerDay: 30, battleEnabled: true }),
  status: z.enum(["active", "draft", "archived"]).default("active"),
});

// POST /api/admin/plans
financePlansRouter.post(
  "/plans",
  requirePermission("finance.plans.edit"),
  async (req, res, next) => {
    try {
      const parsed = CreatePlanSchema.parse(req.body);
      const code = await nextCode("PLN");

      const plan = await prisma.$transaction(async (tx) => {
        const createdPlan = await tx.plan.create({
          data: {
            code,
            name: parsed.name,
            description: parsed.description,
            accessType: parsed.accessType,
            status: parsed.status,
            versions: {
              create: {
                versionNumber: 1,
                priceAmount: parsed.priceAmount,
                currency: parsed.currency,
                billingInterval: parsed.billingInterval,
                trialDays: parsed.trialDays,
                quotas: parsed.quotas as any,
                status: parsed.status === "active" ? "active" : "draft",
              },
            },
          },
          include: {
            versions: true,
          },
        });
        return createdPlan;
      });

      await emitAudit(req, {
        action: "create",
        entityType: "Plan",
        entityId: plan.id,
        after: plan,
      });

      return sendOne(res, plan, 201);
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/admin/plans/:id
financePlansRouter.get(
  "/plans/:id",
  requirePermission("finance.plans.view"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const plan = await prisma.plan.findUnique({
        where: { id },
        include: {
          versions: {
            orderBy: { versionNumber: "desc" },
            include: {
              _count: {
                select: { subscriptions: true },
              },
            },
          },
        },
      });

      if (!plan) return next(notFound("Plan not found"));

      return sendOne(res, {
        ...plan,
        versions: plan.versions.map((v) => ({
          ...v,
          priceAmount: Number(v.priceAmount),
          subscriptionsCount: v._count.subscriptions,
        })),
      });
    } catch (err) {
      return next(err);
    }
  }
);

const UpdatePlanSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().optional(),
  status: z.enum(["active", "draft", "archived"]).optional(),
});

// PATCH /api/admin/plans/:id
financePlansRouter.patch(
  "/plans/:id",
  requirePermission("finance.plans.edit"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const parsed = UpdatePlanSchema.parse(req.body);
      const existing = await prisma.plan.findUnique({ where: { id } });
      if (!existing) return next(notFound("Plan not found"));

      const updated = await prisma.plan.update({
        where: { id },
        data: parsed,
        include: { versions: true },
      });

      await emitAudit(req, {
        action: "update",
        entityType: "Plan",
        entityId: updated.id,
        before: existing,
        after: updated,
      });

      return sendOne(res, updated);
    } catch (err) {
      return next(err);
    }
  }
);

const CreateVersionSchema = z.object({
  priceAmount: z.coerce.number().min(0),
  currency: z.string().default("BDT"),
  billingInterval: z.enum(["month", "year", "one_time"]).default("month"),
  trialDays: z.coerce.number().int().min(0).default(0),
  quotas: z
    .record(z.string(), z.any())
    .default({ dailyTutorLimit: 100, voiceMinutesPerDay: 30, battleEnabled: true }),
  status: z.enum(["active", "draft", "archived"]).default("draft"),
});

// POST /api/admin/plans/:id/versions
financePlansRouter.post(
  "/plans/:id/versions",
  requirePermission("finance.plans.edit"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const parsed = CreateVersionSchema.parse(req.body);
      const plan = await prisma.plan.findUnique({
        where: { id },
        include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
      });
      if (!plan) return next(notFound("Plan not found"));

      const nextVersionNumber = (plan.versions[0]?.versionNumber || 0) + 1;

      const createdVersion = await prisma.planVersion.create({
        data: {
          planId: plan.id,
          versionNumber: nextVersionNumber,
          priceAmount: parsed.priceAmount,
          currency: parsed.currency,
          billingInterval: parsed.billingInterval,
          trialDays: parsed.trialDays,
          quotas: parsed.quotas as any,
          status: parsed.status,
        },
      });

      await emitAudit(req, {
        action: "create_version",
        entityType: "PlanVersion",
        entityId: createdVersion.id,
        after: createdVersion,
      });

      return sendOne(res, { ...createdVersion, priceAmount: Number(createdVersion.priceAmount) }, 201);
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/admin/plans/:id/retire
financePlansRouter.post(
  "/plans/:id/retire",
  requirePermission("finance.plans.approve"),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const plan = await prisma.plan.findUnique({ where: { id } });
      if (!plan) return next(notFound("Plan not found"));

      const updated = await prisma.plan.update({
        where: { id },
        data: { status: "archived" },
      });

      await emitAudit(req, {
        action: "retire",
        entityType: "Plan",
        entityId: updated.id,
        before: plan,
        after: updated,
      });

      return sendOne(res, updated);
    } catch (err) {
      return next(err);
    }
  }
);
