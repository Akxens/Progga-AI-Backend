import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requirePermission } from "../core/permissions";
import { sendOne } from "../core/respond";

export const csrOverviewRouter = Router();

/**
 * GET /api/admin/csr/overview
 * Top-level CSR and Progga Foundation KPI summary.
 */
csrOverviewRouter.get("/overview", requirePermission("csr.overview.view"), async (req, res, next) => {
  try {
    const [
      partnersCount,
      programmesCount,
      activeProgrammesCount,
      activeAgreements,
      allReceipts,
      activeSponsorships,
      totalBeneficiariesCount,
      eligibleBeneficiariesCount,
    ] = await Promise.all([
      prisma.partner.count(),
      prisma.programme.count(),
      prisma.programme.count({ where: { status: "active" } }),
      prisma.grantAgreement.findMany({
        where: { status: "active" },
        select: { amountCommitted: true },
      }),
      prisma.grantReceipt.findMany({
        select: { amount: true },
      }),
      prisma.sponsorship.findMany({
        where: { status: "active" },
        select: { allocatedAmount: true },
      }),
      prisma.beneficiary.count(),
      prisma.beneficiary.count({ where: { eligibilityState: "eligible" } }),
    ]);

    const totalCommitted = activeAgreements.reduce((sum, a) => sum + Number(a.amountCommitted), 0);
    const totalReceived = allReceipts.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalAllocated = activeSponsorships.reduce((sum, s) => sum + Number(s.allocatedAmount), 0);
    const activeSponsoredStudents = activeSponsorships.length;

    sendOne(res, {
      partnersCount,
      programmesCount,
      activeProgrammesCount,
      totalCommitted,
      totalReceived,
      totalAllocated,
      unallocatedFunds: Math.max(0, totalReceived - totalAllocated),
      activeSponsoredStudents,
      totalBeneficiariesCount,
      eligibleBeneficiariesCount,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/csr/impact
 * Aggregated CSR impact metrics.
 * Implements BR-CSR-09: Privacy protection & small sample suppression (<10).
 * Implements BR-CSR-10: Separates reach (active learning students) from registered beneficiaries.
 */
csrOverviewRouter.get("/impact", requirePermission("csr.impact.view"), async (req, res, next) => {
  try {
    const [programmes, beneficiaries, activeSponsorships, sessionsCount] = await Promise.all([
      prisma.programme.findMany({
        select: { id: true, code: true, name: true, seatCapacity: true },
      }),
      prisma.beneficiary.findMany({
        include: {
          student: {
            select: {
              id: true,
              grade: true,
              studentProfile: {
                select: {
                  school: { select: { district: true, division: true } },
                },
              },
              _count: {
                select: { tutorSessions: true },
              },
            },
          },
        },
      }),
      prisma.sponsorship.findMany({
        where: { status: "active" },
        select: { id: true, studentId: true, programmeId: true },
      }),
      prisma.tutorSession.count(),
    ]);

    // Group reach by district
    const districtBreakdown: Record<string, { registered: number; reach: number }> = {};
    let totalReach = 0;
    const activeStudentIds = new Set(activeSponsorships.map((s) => s.studentId));

    for (const b of beneficiaries) {
      const district = b.student.studentProfile?.school?.district || "Other / Independent";
      if (!districtBreakdown[district]) {
        districtBreakdown[district] = { registered: 0, reach: 0 };
      }
      districtBreakdown[district].registered += 1;

      // BR-CSR-10: Reach = distinct beneficiaries with >= 1 meaningful tutor session
      if (b.student._count.tutorSessions > 0) {
        districtBreakdown[district].reach += 1;
        totalReach += 1;
      }
    }

    // BR-CSR-09: Apply privacy suppression for districts with < 10 students
    const districts = Object.entries(districtBreakdown).map(([name, counts]) => ({
      name,
      registered: counts.registered < 10 ? "<10" : counts.registered,
      reach: counts.reach < 10 ? "<10" : counts.reach,
      isSuppressed: counts.registered < 10,
    }));

    sendOne(res, {
      totalRegistered: beneficiaries.length,
      totalReach, // Verified active beneficiaries
      activeSponsoredSeats: activeSponsorships.length,
      totalSessionsCompleted: sessionsCount,
      districts,
    });
  } catch (err) {
    next(err);
  }
});
