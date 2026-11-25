import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { writeAudit } from "../core/audit";
import { sendOne, sendList } from "../core/respond";
import { calculateProratedAllocation, FOUNDATION_ACCOUNTS } from "./ledger";
import { postJournal } from "../core/ledger";

export const csrBeneficiariesRouter = Router();

const addBeneficiarySchema = z.object({
  programmeId: z.string(),
  studentId: z.string(),
});

const createAllocationSchema = z.object({
  programmeId: z.string(),
  beneficiaryId: z.string(),
  coverageFrom: z.string().or(z.date()),
  coverageTo: z.string().or(z.date()),
});

/**
 * GET /api/admin/csr/beneficiaries
 * List enrolled programme beneficiaries with student details and eligibility.
 */
csrBeneficiariesRouter.get("/", requirePermission("csr.programmes.view"), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const search = (req.query.search as string)?.trim() || "";
    const programmeId = req.query.programmeId as string;
    const eligibilityState = req.query.eligibilityState as string;

    const where: any = {};
    if (programmeId) where.programmeId = programmeId;
    if (eligibilityState) where.eligibilityState = eligibilityState;
    if (search) {
      where.OR = [
        { student: { name: { contains: search, mode: "insensitive" } } },
        { student: { email: { contains: search, mode: "insensitive" } } },
        { student: { phone: { contains: search, mode: "insensitive" } } },
        { student: { studentProfile: { code: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const [total, beneficiaries] = await Promise.all([
      prisma.beneficiary.count({ where }),
      prisma.beneficiary.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          programme: {
            select: { id: true, code: true, name: true },
          },
          student: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              grade: true,
              studentProfile: {
                select: {
                  code: true,
                  school: { select: { id: true, name: true, district: true } },
                },
              },
            },
          },
          sponsorships: {
            where: { status: "active" },
            orderBy: { coverageTo: "desc" },
            take: 1,
          },
        },
      }),
    ]);

    const rows = beneficiaries.map((b) => {
      const activeSponsorship = b.sponsorships?.[0];
      return {
        id: b.id,
        programmeId: b.programmeId,
        programmeName: b.programme.name,
        programmeCode: b.programme.code,
        studentId: b.studentId,
        studentName: b.student.name,
        studentCode: b.student.studentProfile?.code || b.student.email || b.student.phone || "—",
        grade: b.student.grade,
        schoolName: b.student.studentProfile?.school?.name || "Independent",
        district: b.student.studentProfile?.school?.district || "—",
        eligibilityState: b.eligibilityState,
        ineligibleReason: b.ineligibleReason,
        verifiedAt: b.verifiedAt,
        status: b.status,
        activeSponsorship: activeSponsorship
          ? {
              id: activeSponsorship.id,
              code: activeSponsorship.code,
              coverageFrom: activeSponsorship.coverageFrom,
              coverageTo: activeSponsorship.coverageTo,
              allocatedAmount: Number(activeSponsorship.allocatedAmount),
              status: activeSponsorship.status,
            }
          : null,
        createdAt: b.createdAt,
      };
    });

    sendList(res, rows, { page, pageSize, total });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/csr/beneficiaries
 * Add a student as a programme beneficiary and verify eligibility (BR-CSR-02).
 */
csrBeneficiariesRouter.post("/", requirePermission("csr.programmes.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parsed = addBeneficiarySchema.parse(req.body);

    const programme = await prisma.programme.findUnique({
      where: { id: parsed.programmeId },
      include: { partner: true },
    });
    if (!programme) throw notFound("Programme not found");

    const student = await prisma.user.findUnique({
      where: { id: parsed.studentId },
      include: {
        studentProfile: {
          include: { school: true },
        },
      },
    });
    if (!student || student.role !== "STUDENT") {
      throw badRequest("User must be a valid student");
    }

    // BR-CSR-02: Eligibility check
    let eligibilityState = "eligible";
    let ineligibleReason: string | null = null;

    if (student.accountStatus === "suspended" || student.accountStatus === "closed") {
      eligibilityState = "ineligible";
      ineligibleReason = "account_inactive";
    } else if (
      programme.eligibleGrades.length > 0 &&
      (!student.grade || !programme.eligibleGrades.includes(student.grade))
    ) {
      eligibilityState = "ineligible";
      ineligibleReason = "grade_ineligible";
    } else if (
      programme.eligibleSchoolIds.length > 0 &&
      (!student.studentProfile?.schoolId ||
        !programme.eligibleSchoolIds.includes(student.studentProfile.schoolId))
    ) {
      eligibilityState = "ineligible";
      ineligibleReason = "school_ineligible";
    } else if (
      programme.districts.length > 0 &&
      (!student.studentProfile?.school?.district ||
        !programme.districts.includes(student.studentProfile.school.district))
    ) {
      eligibilityState = "ineligible";
      ineligibleReason = "district_ineligible";
    }

    const beneficiary = await prisma.$transaction(async (tx) => {
      const b = await tx.beneficiary.create({
        data: {
          programmeId: parsed.programmeId,
          studentId: parsed.studentId,
          eligibilityState,
          ineligibleReason,
          verifiedAt: eligibilityState === "eligible" ? new Date() : null,
          verifiedById: eligibilityState === "eligible" ? ctx.user.id : null,
          status: "active",
        },
        include: {
          student: true,
          programme: true,
        },
      });

      await writeAudit(tx, ctx, {
        action: "create",
        entityType: "Beneficiary",
        entityId: b.id,
        after: b,
      });

      return b;
    });

    sendOne(res, beneficiary, 201);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/csr/beneficiaries/:id/verify
 * Mark beneficiary verified by an administrator.
 */
csrBeneficiariesRouter.post("/:id/verify", requirePermission("csr.programmes.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;

    const beneficiary = await prisma.$transaction(async (tx) => {
      const b = await tx.beneficiary.findUnique({ where: { id } });
      if (!b) throw notFound("Beneficiary not found");

      const updated = await tx.beneficiary.update({
        where: { id },
        data: {
          eligibilityState: "eligible",
          ineligibleReason: null,
          verifiedAt: new Date(),
          verifiedById: ctx.user.id,
        },
      });

      await writeAudit(tx, ctx, {
        action: "update",
        entityType: "Beneficiary",
        entityId: id,
        after: { verified: true },
      });

      return updated;
    });

    sendOne(res, beneficiary);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/csr/allocations
 * List active & historical sponsorship coverage allocations.
 */
csrBeneficiariesRouter.get("/allocations", requirePermission("csr.programmes.view"), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const programmeId = req.query.programmeId as string;
    const status = req.query.status as string;

    const where: any = {};
    if (programmeId) where.programmeId = programmeId;
    if (status) where.status = status;

    const [total, allocations] = await Promise.all([
      prisma.sponsorship.count({ where }),
      prisma.sponsorship.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          beneficiary: {
            include: {
              student: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  studentProfile: { select: { code: true } },
                },
              },
              programme: {
                select: { id: true, code: true, name: true },
              },
            },
          },
        },
      }),
    ]);

    const rows = allocations.map((s) => ({
      id: s.id,
      code: s.code,
      studentId: s.studentId,
      studentName: s.beneficiary.student.name,
      studentCode: s.beneficiary.student.studentProfile?.code || s.beneficiary.student.email,
      programmeId: s.programmeId,
      programmeName: s.beneficiary.programme.name,
      programmeCode: s.beneficiary.programme.code,
      coverageFrom: s.coverageFrom,
      coverageTo: s.coverageTo,
      fundedRate: Number(s.fundedRate),
      allocatedAmount: Number(s.allocatedAmount),
      status: s.status,
      revokedAt: s.revokedAt,
      revokedReason: s.revokedReason,
      createdAt: s.createdAt,
    }));

    sendList(res, rows, { page, pageSize, total });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/csr/allocations
 * Allocate sponsorship coverage to a verified student.
 * Validates BR-CSR-03 (capacity), BR-CSR-04 (no overlap), BR-CSR-05 (proration & grant budget cap).
 * Updates student's Entitlement to PREMIUM_SPONSORED.
 */
csrBeneficiariesRouter.post("/allocations", requirePermission("csr.programmes.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parsed = createAllocationSchema.parse(req.body);

    const fromDate = new Date(parsed.coverageFrom);
    const toDate = new Date(parsed.coverageTo);

    const allocation = await prisma.$transaction(async (tx) => {
      const beneficiary = await tx.beneficiary.findUnique({
        where: { id: parsed.beneficiaryId },
        include: { programme: true },
      });

      if (!beneficiary) throw notFound("Beneficiary record not found");
      if (beneficiary.eligibilityState !== "eligible") {
        throw badRequest("Student must be verified as eligible before sponsorship allocation");
      }

      const programme = beneficiary.programme;

      // BR-CSR-03: Capacity check
      const activeCount = await tx.sponsorship.count({
        where: {
          programmeId: programme.id,
          status: "active",
          coverageTo: { gte: fromDate },
          coverageFrom: { lte: toDate },
        },
      });

      if (activeCount >= programme.seatCapacity) {
        throw badRequest(`BR-CSR-03: Programme seat capacity (${programme.seatCapacity}) reached for this period`);
      }

      // BR-CSR-04: No duplicate-funded overlap for the same student (across any programme)
      const overlap = await tx.sponsorship.findFirst({
        where: {
          studentId: beneficiary.studentId,
          status: "active",
          coverageTo: { gte: fromDate },
          coverageFrom: { lte: toDate },
        },
      });

      if (overlap) {
        throw badRequest(
          `BR-CSR-04: Student already has an active sponsorship (${overlap.code}) overlapping requested dates`
        );
      }

      // BR-CSR-05: Proration & Budget check
      const allocatedAmount = calculateProratedAllocation(
        Number(programme.fundedRatePerSeatMonth),
        fromDate,
        toDate
      );

      // Check remaining programme grant amount
      const existingAllocated = await tx.sponsorship.findMany({
        where: { programmeId: programme.id, status: "active" },
        select: { allocatedAmount: true },
      });
      const currentSum = existingAllocated.reduce((sum, a) => sum + Number(a.allocatedAmount), 0);

      if (currentSum + allocatedAmount > Number(programme.grantAmount)) {
        throw badRequest(
          `BR-CSR-05: Allocation (৳${allocatedAmount.toFixed(2)}) exceeds remaining authorized programme grant budget`
        );
      }

      const count = await tx.sponsorship.count();
      const code = `SPN-${(count + 1).toString().padStart(6, "0")}`;
      const idempotencyKey = `spn:${beneficiary.id}:${fromDate.toISOString().slice(0, 10)}:${toDate.toISOString().slice(0, 10)}`;

      // 1. Create Sponsorship
      const spn = await tx.sponsorship.create({
        data: {
          code,
          beneficiaryId: beneficiary.id,
          programmeId: programme.id,
          studentId: beneficiary.studentId,
          coverageFrom: fromDate,
          coverageTo: toDate,
          fundedRate: programme.fundedRatePerSeatMonth,
          allocatedAmount,
          status: "active",
          idempotencyKey,
          createdById: ctx.user.id,
        },
      });

      // 2. Activate or extend student Entitlement to PREMIUM_SPONSORED
      await tx.entitlement.upsert({
        where: { studentId: beneficiary.studentId },
        create: {
          studentId: beneficiary.studentId,
          tier: "PREMIUM_SPONSORED",
          dailyTutorLimit: 100,
          voiceMinutesMonthly: 30,
          activeUntil: toDate,
          source: "csr_grant",
        },
        update: {
          tier: "PREMIUM_SPONSORED",
          dailyTutorLimit: 100,
          voiceMinutesMonthly: 30,
          activeUntil: toDate,
          source: "csr_grant",
        },
      });

      // 3. Post double-entry journal to Foundation ledger: Debit 5010 (Sponsored Access Expense), Credit 4010 (Grant Revenue)
      await postJournal(tx, {
        legalEntityId: "foundation",
        entryType: "CSR_GRANT",
        description: `Sponsored student access allocation (${spn.code}) for student ${beneficiary.studentId}`,
        postedById: ctx.user.id,
        entries: [
          {
            accountCode: FOUNDATION_ACCOUNTS.SPONSORED_ACCESS,
            direction: "debit",
            amount: allocatedAmount,
            description: `Sponsored access for ${spn.code}`,
          },
          {
            accountCode: FOUNDATION_ACCOUNTS.GRANT_REVENUE,
            direction: "credit",
            amount: allocatedAmount,
            description: `Recognized grant revenue for ${programme.code}`,
          },
        ],
      });

      await writeAudit(tx, ctx, {
        action: "create",
        entityType: "Sponsorship",
        entityId: spn.id,
        after: spn,
      });

      return spn;
    });

    sendOne(res, allocation, 201);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/csr/allocations/:id/revoke
 * Revoke sponsorship coverage (BR-CSR-07).
 */
csrBeneficiariesRouter.post("/allocations/:id/revoke", requirePermission("csr.programmes.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const reason = (req.body.reason as string)?.trim() || "Administrative revocation";

    const allocation = await prisma.$transaction(async (tx) => {
      const spn = await tx.sponsorship.findUnique({ where: { id } });
      if (!spn) throw notFound("Sponsorship allocation not found");

      const updated = await tx.sponsorship.update({
        where: { id },
        data: {
          status: "revoked",
          revokedAt: new Date(),
          revokedReason: reason,
        },
      });

      // Revert entitlement if no other active sponsorships
      const remainingActive = await tx.sponsorship.findFirst({
        where: {
          studentId: spn.studentId,
          status: "active",
        },
      });

      if (!remainingActive) {
        await tx.entitlement.updateMany({
          where: { studentId: spn.studentId, source: "csr_grant" },
          data: {
            tier: "FREE",
            dailyTutorLimit: 10,
            voiceMinutesMonthly: 0,
            source: "free_tier",
          },
        });
      }

      await writeAudit(tx, ctx, {
        action: "update",
        entityType: "Sponsorship",
        entityId: id,
        after: { revoked: true, reason },
      });

      return updated;
    });

    sendOne(res, allocation);
  } catch (err) {
    next(err);
  }
});
