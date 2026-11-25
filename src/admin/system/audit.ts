import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requirePermission } from "../core/permissions";
import { sendOne } from "../core/respond";

export const systemAuditRouter = Router();

// GET /api/admin/system/audit
systemAuditRouter.get("/", requirePermission("audit.view"), async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const actorUserId = typeof req.query.actorUserId === "string" ? req.query.actorUserId : undefined;
    const action = typeof req.query.action === "string" ? req.query.action : undefined;
    const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;
    const entityId = typeof req.query.entityId === "string" ? req.query.entityId : undefined;
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;

    const where: Record<string, unknown> = {};

    if (actorUserId) where.actorUserId = actorUserId;
    if (action) where.action = { contains: action, mode: "insensitive" };
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;

    if (from || to) {
      where.createdAt = {
        ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
        ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
      };
    }

    const items = await prisma.auditLog.findMany({
      where,
      take: limit + 1,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      orderBy: { createdAt: "desc" },
    });

    let nextCursor: string | null = null;
    if (items.length > limit) {
      const nextItem = items.pop();
      nextCursor = nextItem ? nextItem.id : null;
    }

    return sendOne(res, items, { next_cursor: nextCursor });
  } catch (err) {
    return next(err);
  }
});
