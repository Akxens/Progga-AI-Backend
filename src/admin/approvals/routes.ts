import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { getCtx } from "../core/context";
import { parseListQuery } from "../core/list-query";
import { sendList, sendOne } from "../core/respond";
import { decideApproval, cancelApproval } from "../core/approvals";

export const approvalsRouter = Router();

const DecisionBody = z.object({
  decision: z.enum(["approved", "rejected", "approve", "reject"]),
  reason: z.string().trim().min(1, "Reason is required"),
  expectedVersion: z.number().int().optional(),
  version: z.number().int().optional(),
});

const CancelBody = z.object({
  reason: z.string().trim().optional(),
});

// GET /api/admin/approvals
approvalsRouter.get("/", async (req, res) => {
  const ctx = getCtx(req);
  const q = parseListQuery(req, {
    allowedSortFields: ["createdAt", "updatedAt", "code", "status"],
    defaultSortField: "createdAt",
    defaultSortOrder: "desc",
  });

  const where: any = {};
  if (q.filters.status) where.status = q.filters.status;
  if (q.filters.type) where.type = q.filters.type;
  if (q.filters.entityType) where.entityType = q.filters.entityType;
  if (q.filters.mine === "true") {
    where.requestedById = ctx.user.id;
  }

  if (q.search) {
    where.OR = [
      { code: { contains: q.search, mode: "insensitive" } },
      { summary: { contains: q.search, mode: "insensitive" } },
    ];
  }

  // Legal entity scope isolation
  if (ctx.scope.type === "LEGAL_ENTITY" && ctx.legalEntityId) {
    where.OR = [
      { legalEntityId: ctx.legalEntityId },
      { legalEntityId: null },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.approval.findMany({
      where,
      skip: q.skip,
      take: q.take,
      orderBy: { [q.sortBy]: q.sortOrder },
    }),
    prisma.approval.count({ where }),
  ]);

  sendList(res, items, total, {
    page: q.page,
    pageSize: q.pageSize,
    applied_filters: q.filters,
  });
});

// POST /api/admin/approvals/:id/decisions
approvalsRouter.post("/:id/decisions", async (req, res) => {
  const ctx = getCtx(req);
  const body = DecisionBody.parse(req.body);
  const decisionNormalized = body.decision.startsWith("approve") ? "approved" : "rejected";
  const expectedVer = body.expectedVersion ?? body.version;

  const result = await decideApproval(
    ctx,
    req.params.id as string,
    decisionNormalized,
    body.reason,
    expectedVer,
  );

  sendOne(res, result);
});

// POST /api/admin/approvals/:id/cancel
approvalsRouter.post("/:id/cancel", async (req, res) => {
  const ctx = getCtx(req);
  const body = CancelBody.parse(req.body);

  const result = await cancelApproval(
    ctx,
    req.params.id as string,
    body.reason,
  );

  sendOne(res, result);
});
