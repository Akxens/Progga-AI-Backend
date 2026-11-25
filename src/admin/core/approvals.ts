import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import type { AdminContext } from "./context";
import { adminForbidden, invalidTransition, selfApprovalForbidden, versionConflict } from "./errors";
import { nextCode } from "./codes";
import { writeAudit } from "./audit";

export type ApprovalHandler = {
  onApprove: (tx: Prisma.TransactionClient, approval: any) => Promise<void>;
  onReject?: (tx: Prisma.TransactionClient, approval: any) => Promise<void>;
};

export const approvalHandlers: Record<string, ApprovalHandler> = {};

export function registerApprovalHandler(type: string, handler: ApprovalHandler) {
  approvalHandlers[type] = handler;
}

export async function createApproval(
  tx: Prisma.TransactionClient,
  ctx: AdminContext,
  data: {
    type: string;
    entityType: string;
    entityId: string;
    legalEntityId?: string | null;
    summary: string;
    payload?: any;
    requiredPermission: string;
  },
) {
  const code = await nextCode(tx, "APR");

  const approval = await tx.approval.create({
    data: {
      code,
      type: data.type,
      entityType: data.entityType,
      entityId: data.entityId,
      legalEntityId: data.legalEntityId || ctx.legalEntityId || null,
      summary: data.summary,
      payload: data.payload || {},
      requiredPermission: data.requiredPermission,
      status: "pending",
      requestedById: ctx.user.id,
    },
  });

  await writeAudit(tx, ctx, {
    action: "approval.created",
    entityType: "Approval",
    entityId: approval.id,
    after: { code, type: data.type, entityType: data.entityType, entityId: data.entityId },
  });

  return approval;
}

export async function decideApproval(
  ctx: AdminContext,
  approvalId: string,
  decision: "approved" | "rejected",
  reason: string,
  expectedVersion?: number,
) {
  return prisma.$transaction(async (tx) => {
    const approval = await tx.approval.findUnique({
      where: { id: approvalId },
    });

    if (!approval) {
      throw new Error("Approval not found");
    }

    if (approval.status !== "pending") {
      throw invalidTransition("Only pending approvals can be decided");
    }

    // Maker-checker rule (BR-APR-03): requestedBy !== decidedBy
    if (approval.requestedById === ctx.user.id) {
      throw selfApprovalForbidden();
    }

    // Check permission
    if (typeof ctx.hasPermission === "function" && !ctx.hasPermission(approval.requiredPermission)) {
      throw adminForbidden("permission_denied", `Missing required permission: ${approval.requiredPermission}`);
    }

    // Optimistic lock
    if (expectedVersion !== undefined && approval.version !== expectedVersion) {
      throw versionConflict();
    }

    const updated = await tx.approval.update({
      where: { id: approvalId },
      data: {
        status: decision,
        decidedById: ctx.user.id,
        decidedAt: new Date(),
        decisionReason: reason,
        version: { increment: 1 },
      },
    });

    // Execute registered domain handler
    const handler = approvalHandlers[approval.type];
    if (handler) {
      if (decision === "approved") {
        await handler.onApprove(tx, updated);
      } else if (handler.onReject) {
        await handler.onReject(tx, updated);
      }
    }

    await writeAudit(tx, ctx, {
      action: `approval.${decision}`,
      entityType: "Approval",
      entityId: updated.id,
      reason,
      before: { status: "pending" },
      after: { status: decision, decidedById: ctx.user.id },
    });

    return updated;
  });
}

export async function cancelApproval(
  ctx: AdminContext,
  approvalId: string,
  reason = "Cancelled by requester",
) {
  return prisma.$transaction(async (tx) => {
    const approval = await tx.approval.findUnique({
      where: { id: approvalId },
    });

    if (!approval) {
      throw new Error("Approval not found");
    }

    if (approval.status !== "pending") {
      throw invalidTransition("Only pending approvals can be cancelled");
    }

    // Only maker or super admin can cancel
    const isMaker = approval.requestedById === ctx.user.id;
    const isSuperAdmin = ctx.roleAssignment.role.key === "SUPER_ADMIN";
    if (!isMaker && !isSuperAdmin) {
      throw adminForbidden("permission_denied", "Only the requester or a super admin can cancel an approval");
    }

    const updated = await tx.approval.update({
      where: { id: approvalId },
      data: {
        status: "cancelled",
        decidedById: ctx.user.id,
        decidedAt: new Date(),
        decisionReason: reason,
        version: { increment: 1 },
      },
    });

    await writeAudit(tx, ctx, {
      action: "approval.cancelled",
      entityType: "Approval",
      entityId: updated.id,
      reason,
      before: { status: "pending" },
      after: { status: "cancelled", decidedById: ctx.user.id },
    });

    return updated;
  });
}
