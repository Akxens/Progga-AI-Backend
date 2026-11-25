import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import type { AdminContext } from "./context";
import { prisma } from "../../lib/prisma";

export interface AuditLogData {
  action: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
  before?: any;
  after?: any;
  req?: Request;
}

export async function writeAudit(
  tx: Prisma.TransactionClient,
  ctx: AdminContext | null,
  data: AuditLogData,
): Promise<void> {
  const req = data.req;
  const ip = req ? (req.headers["x-forwarded-for"]?.toString() || req.ip || null) : null;
  const userAgent = req ? req.headers["user-agent"] || null : null;
  const correlationId = req?.correlationId || null;

  await tx.auditLog.create({
    data: {
      actorUserId: ctx?.user?.id || null,
      assignmentId: ctx?.roleAssignment?.id || null,
      roleKey: ctx?.roleAssignment?.role?.key || null,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId,
      reason: data.reason || null,
      before: data.before !== undefined ? data.before : undefined,
      after: data.after !== undefined ? data.after : undefined,
      ip,
      userAgent,
      correlationId,
    },
  });
}

export async function emitAudit(
  req: Request,
  data: Omit<AuditLogData, "req">,
): Promise<void> {
  const ctx = req.admin || null;
  await writeAudit(prisma as any, ctx, { ...data, req });
}
