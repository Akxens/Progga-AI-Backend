import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { writeAudit } from "../core/audit";
import { sendOne, sendList } from "../core/respond";

export const systemConsentRouter = Router();

const createPolicySchema = z.object({
  title: z.string().min(2),
  version: z.string().min(1),
  bodyMarkdown: z.string().min(10),
  consentType: z.enum(["data_processing", "ai_tutoring", "progress_reports", "marketing_to_guardian"]).default("data_processing"),
});

/**
 * GET /api/admin/system/consent
 * List consent policies and audit records.
 */
systemConsentRouter.get("/consent", requirePermission("consent.view"), async (req, res, next) => {
  try {
    const policies = await prisma.consentPolicy.findMany({
      orderBy: { createdAt: "desc" },
    });

    sendOne(res, policies);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/system/consent
 * Create or draft a new consent policy version.
 */
systemConsentRouter.post("/consent", requirePermission("consent.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parsed = createPolicySchema.parse(req.body);

    const policy = await prisma.$transaction(async (tx) => {
      const p = await tx.consentPolicy.create({
        data: {
          title: parsed.title,
          version: parsed.version,
          bodyMarkdown: parsed.bodyMarkdown,
          consentType: parsed.consentType,
          effectiveFrom: new Date(),
          status: "draft",
          createdById: ctx.user.id,
        },
      });

      await writeAudit(tx, ctx, {
        action: "create",
        entityType: "ConsentPolicy",
        entityId: p.id,
        after: p,
      });

      return p;
    });

    sendOne(res, policy, 201);
  } catch (err) {
    next(err);
  }
});
