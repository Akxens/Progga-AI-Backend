import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { writeAudit } from "../core/audit";
import { sendOne } from "../core/respond";

export const systemConfigRouter = Router();

const allowedKeys = [
  "features.consentEnforcement",
  "features.studentExams",
  "features.rewardsStore",
  "ai.defaultEngine",
  "ai.fallbackEngine",
  "ai.temperature",
  "ai.safetyScreening",
  "voice.defaultEngine",
  "system.maintenanceMode",
] as const;

/**
 * GET /api/admin/system/config
 * Retrieves white-listed system parameters and feature flags.
 */
systemConfigRouter.get("/config", requirePermission("admin.users.view"), async (req, res, next) => {
  try {
    const settings = await prisma.appSetting.findMany({
      where: { key: { in: allowedKeys as any } },
    });

    const config: Record<string, any> = {
      "features.consentEnforcement": true,
      "features.studentExams": false,
      "features.rewardsStore": true,
      "ai.defaultEngine": "gemini-2.5-flash",
      "ai.fallbackEngine": "groq",
      "ai.temperature": 0.7,
      "ai.safetyScreening": true,
      "voice.defaultEngine": "indicf5",
      "system.maintenanceMode": false,
    };

    for (const s of settings) {
      config[s.key] = s.value;
    }

    sendOne(res, config);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/system/config
 * Update whitelist-validated system configuration settings.
 */
systemConfigRouter.put("/config", requirePermission("admin.users.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const updates = req.body;

    if (typeof updates !== "object" || !updates) {
      throw badRequest("Body must be a configuration object");
    }

    const updatedConfig = await prisma.$transaction(async (tx) => {
      for (const [key, val] of Object.entries(updates)) {
        if (!allowedKeys.includes(key as any)) {
          throw badRequest(`Setting '${key}' is not in the allowed configuration whitelist`);
        }

        await tx.appSetting.upsert({
          where: { key },
          create: {
            key,
            value: val as any,
          },
          update: {
            value: val as any,
          },
        });
      }

      await writeAudit(tx, ctx, {
        action: "update",
        entityType: "SystemConfig",
        entityId: "global",
        after: updates,
      });

      return updates;
    });

    sendOne(res, { success: true, updated: updatedConfig });
  } catch (err) {
    next(err);
  }
});
