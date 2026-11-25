import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { writeAudit } from "../core/audit";
import { sendOne, sendList } from "../core/respond";

export const csrProgrammesRouter = Router();

const budgetLineSchema = z.object({
  category: z.enum([
    "student_access",
    "teacher_training",
    "devices",
    "events",
    "operations",
    "monitoring",
    "other",
  ]),
  description: z.string().default(""),
  amount: z.number().positive(),
});

const createProgrammeSchema = z.object({
  name: z.string().min(2),
  partnerId: z.string(),
  agreementRef: z.string().min(2),
  grantAmount: z.number().positive(),
  currency: z.string().default("BDT"),
  startDate: z.string().or(z.date()),
  endDate: z.string().or(z.date()),
  seatCapacity: z.number().int().positive(),
  fundedRatePerSeatMonth: z.number().positive(),
  divisions: z.array(z.string()).default([]),
  districts: z.array(z.string()).default([]),
  upazilas: z.array(z.string()).default([]),
  eligibleGrades: z.array(z.number().int()).default([]),
  eligibleSchoolIds: z.array(z.string()).default([]),
  eligibilityNotes: z.string().default(""),
  budgetLines: z.array(budgetLineSchema).min(1),
});

/**
 * GET /api/admin/csr/programmes
 * List programmes with partner details and allocation capacity stats.
 */
csrProgrammesRouter.get("/", requirePermission("csr.programmes.view"), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const search = (req.query.search as string)?.trim() || "";
    const status = req.query.status as string;
    const partnerId = req.query.partnerId as string;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { code: { contains: search, mode: "insensitive" } },
        { partner: { name: { contains: search, mode: "insensitive" } } },
      ];
    }
    if (status) where.status = status;
    if (partnerId) where.partnerId = partnerId;

    const [total, programmes] = await Promise.all([
      prisma.programme.count({ where }),
      prisma.programme.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          partner: {
            select: { id: true, code: true, name: true },
          },
          _count: {
            select: {
              beneficiaries: true,
              receipts: true,
            },
          },
          beneficiaries: {
            where: { status: "active" },
            include: {
              sponsorships: {
                where: { status: "active" },
                select: { allocatedAmount: true },
              },
            },
          },
        },
      }),
    ]);

    const rows = programmes.map((prg) => {
      let activeAllocatedSum = 0;
      let activeSeatsCount = 0;

      for (const b of prg.beneficiaries) {
        if (b.sponsorships && b.sponsorships.length > 0) {
          activeSeatsCount += 1;
          for (const s of b.sponsorships) {
            activeAllocatedSum += Number(s.allocatedAmount);
          }
        }
      }

      return {
        id: prg.id,
        code: prg.code,
        name: prg.name,
        partnerId: prg.partnerId,
        partnerName: prg.partner.name,
        partnerCode: prg.partner.code,
        agreementRef: prg.agreementRef,
        grantAmount: Number(prg.grantAmount),
        seatCapacity: prg.seatCapacity,
        activeSeatsCount,
        allocatedAmount: activeAllocatedSum,
        fundedRatePerSeatMonth: Number(prg.fundedRatePerSeatMonth),
        startDate: prg.startDate,
        endDate: prg.endDate,
        status: prg.status,
        beneficiariesCount: prg._count.beneficiaries,
        receiptsCount: prg._count.receipts,
        createdAt: prg.createdAt,
      };
    });

    sendList(res, rows, { page, pageSize, total });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/csr/programmes
 * Create a new CSR Programme.
 * Validates BR-CSR-01 (Budget line sum = grantAmount, agreement validity).
 */
csrProgrammesRouter.post("/", requirePermission("csr.programmes.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parsed = createProgrammeSchema.parse(req.body);

    // 1. Verify active GrantAgreement exists
    const agreement = await prisma.grantAgreement.findFirst({
      where: {
        partnerId: parsed.partnerId,
        agreementRef: parsed.agreementRef,
        status: "active",
      },
    });

    if (!agreement) {
      throw badRequest(`No active Grant Agreement found with reference '${parsed.agreementRef}' for this partner`);
    }

    // 2. Validate BR-CSR-01: Sum of budget lines must equal grantAmount
    const totalBudget = parsed.budgetLines.reduce((acc, bl) => acc + bl.amount, 0);
    if (Math.abs(totalBudget - parsed.grantAmount) > 0.01) {
      throw badRequest(
        `BR-CSR-01: Sum of budget lines (৳${totalBudget.toFixed(2)}) must exactly equal grantAmount (৳${parsed.grantAmount.toFixed(2)})`
      );
    }

    const count = await prisma.programme.count();
    const code = `PRG-${(count + 1).toString().padStart(6, "0")}`;

    const programme = await prisma.$transaction(async (tx) => {
      const prg = await tx.programme.create({
        data: {
          code,
          name: parsed.name,
          partnerId: parsed.partnerId,
          agreementRef: parsed.agreementRef,
          legalEntityId: "foundation",
          grantAmount: parsed.grantAmount,
          currency: parsed.currency,
          startDate: new Date(parsed.startDate),
          endDate: new Date(parsed.endDate),
          divisions: parsed.divisions,
          districts: parsed.districts,
          upazilas: parsed.upazilas,
          eligibleGrades: parsed.eligibleGrades,
          eligibleSchoolIds: parsed.eligibleSchoolIds,
          eligibilityNotes: parsed.eligibilityNotes,
          seatCapacity: parsed.seatCapacity,
          fundedRatePerSeatMonth: parsed.fundedRatePerSeatMonth,
          status: "draft",
          createdById: ctx.user.id,
          budgetLines: {
            create: parsed.budgetLines.map((bl) => ({
              category: bl.category,
              description: bl.description,
              amount: bl.amount,
            })),
          },
        },
        include: {
          budgetLines: true,
        },
      });

      await writeAudit(tx, ctx, {
        action: "create",
        entityType: "Programme",
        entityId: prg.id,
        after: prg,
      });

      return prg;
    });

    sendOne(res, programme, 201);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/csr/programmes/:id
 * Retrieve single programme with full details (budget lines, milestones, targets, receipts, beneficiaries).
 */
csrProgrammesRouter.get("/:id", requirePermission("csr.programmes.view"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const programme = await prisma.programme.findUnique({
      where: { id },
      include: {
        partner: true,
        budgetLines: true,
        milestones: { orderBy: { dueDate: "asc" } },
        targets: { orderBy: { dueDate: "asc" } },
        receipts: { orderBy: { receivedOn: "desc" } },
        _count: {
          select: {
            beneficiaries: true,
          },
        },
      },
    });

    if (!programme) throw notFound("Programme not found");

    // Count active seats and total allocated amount
    const activeSponsorships = await prisma.sponsorship.findMany({
      where: { programmeId: id, status: "active" },
      select: { allocatedAmount: true },
    });

    const activeSeatsCount = activeSponsorships.length;
    const allocatedAmount = activeSponsorships.reduce((sum, s) => sum + Number(s.allocatedAmount), 0);
    const totalReceived = programme.receipts.reduce((sum, r) => sum + Number(r.amount), 0);

    sendOne(res, {
      ...programme,
      activeSeatsCount,
      allocatedAmount,
      totalReceived,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/csr/programmes/:id/activate
 * Activate a CSR programme after verifying BR-CSR-01.
 */
csrProgrammesRouter.post("/:id/activate", requirePermission("csr.programmes.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;

    const programme = await prisma.$transaction(async (tx) => {
      const prg = await tx.programme.findUnique({
        where: { id },
        include: { budgetLines: true },
      });

      if (!prg) throw notFound("Programme not found");

      // Check budget lines sum
      const totalBudget = prg.budgetLines.reduce((acc, bl) => acc + Number(bl.amount), 0);
      if (Math.abs(totalBudget - Number(prg.grantAmount)) > 0.01) {
        throw badRequest("Budget lines must equal grantAmount before activation");
      }

      const updated = await tx.programme.update({
        where: { id },
        data: { status: "active", version: prg.version + 1 },
      });

      await writeAudit(tx, ctx, {
        action: "update",
        entityType: "Programme",
        entityId: id,
        after: { status: "active" },
      });

      return updated;
    });

    sendOne(res, programme);
  } catch (err) {
    next(err);
  }
});
