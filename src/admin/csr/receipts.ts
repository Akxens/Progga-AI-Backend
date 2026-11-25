import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { writeAudit } from "../core/audit";
import { sendOne, sendList } from "../core/respond";
import { postFoundationGrantReceipt } from "./ledger";

export const csrReceiptsRouter = Router();

const createReceiptSchema = z.object({
  programmeId: z.string(),
  amount: z.number().positive(),
  receivedOn: z.string().or(z.date()),
  reference: z.string().min(2),
  evidenceFileIds: z.array(z.string()).default([]),
});

/**
 * GET /api/admin/csr/receipts
 * List donor grant receipts.
 */
csrReceiptsRouter.get("/", requirePermission("csr.programmes.view"), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const programmeId = req.query.programmeId as string;

    const where: any = {};
    if (programmeId) where.programmeId = programmeId;

    const [total, receipts] = await Promise.all([
      prisma.grantReceipt.count({ where }),
      prisma.grantReceipt.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { receivedOn: "desc" },
        include: {
          programme: {
            select: {
              id: true,
              code: true,
              name: true,
              partner: { select: { id: true, name: true, code: true } },
            },
          },
        },
      }),
    ]);

    const rows = receipts.map((r) => ({
      id: r.id,
      code: r.code,
      programmeId: r.programmeId,
      programmeName: r.programme.name,
      programmeCode: r.programme.code,
      partnerName: r.programme.partner.name,
      partnerCode: r.programme.partner.code,
      amount: Number(r.amount),
      receivedOn: r.receivedOn,
      reference: r.reference,
      journalId: r.journalId,
      createdAt: r.createdAt,
    }));

    sendList(res, rows, { page, pageSize, total });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/csr/receipts
 * Record a donor grant receipt with bank reference and post double-entry Foundation ledger.
 */
csrReceiptsRouter.post("/", requirePermission("csr.programmes.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parsed = createReceiptSchema.parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      const { receipt, journal } = await postFoundationGrantReceipt(tx, {
        programmeId: parsed.programmeId,
        amount: parsed.amount,
        receivedOn: new Date(parsed.receivedOn),
        reference: parsed.reference,
        evidenceFileIds: parsed.evidenceFileIds,
        recordedById: ctx.user.id,
      });

      await writeAudit(tx, ctx, {
        action: "create",
        entityType: "GrantReceipt",
        entityId: receipt.id,
        after: { receipt, journalId: journal.id },
      });

      return { receipt, journal };
    });

    sendOne(res, result.receipt, 201);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/csr/ledger
 * Audited double-entry general ledger journal lines for Progga Foundation.
 */
csrReceiptsRouter.get("/ledger", requirePermission("csr.ledger.view"), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const entryType = req.query.entryType as string;

    const where: any = { legalEntityId: "foundation" };
    if (entryType) where.entryType = entryType;

    const [total, journals] = await Promise.all([
      prisma.ledgerJournal.count({ where }),
      prisma.ledgerJournal.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { postedAt: "desc" },
        include: {
          entries: {
            orderBy: { accountCode: "asc" },
          },
        },
      }),
    ]);

    const rows = journals.map((j) => {
      let debitTotal = 0;
      let creditTotal = 0;
      for (const e of j.entries) {
        if (e.direction === "debit") debitTotal += Number(e.amount);
        else creditTotal += Number(e.amount);
      }
      return {
        id: j.id,
        code: j.code,
        legalEntityId: j.legalEntityId,
        entryType: j.entryType,
        description: j.description,
        postedAt: j.postedAt,
        entriesCount: j.entries.length,
        totalAmount: debitTotal,
        isBalanced: Math.abs(debitTotal - creditTotal) <= 0.001,
        entries: j.entries.map((e) => ({
          id: e.id,
          accountCode: e.accountCode,
          direction: e.direction,
          amount: Number(e.amount),
          description: e.description,
        })),
      };
    });

    sendList(res, rows, { page, pageSize, total });
  } catch (err) {
    next(err);
  }
});
