import { prisma } from "../../lib/prisma";

export interface RecomputedEntitlementResult {
  studentId: string;
  effectiveAccess: "FREE" | "PREMIUM_PAID" | "PREMIUM_SPONSORED";
  dailyTutorLimit: number;
  voiceMinutesPerDay: number;
  battleEnabled: boolean;
  validTo: Date | null;
  source: "free" | "paid" | "sponsored";
}

/**
 * Evaluates student entitlement hierarchy (TASK-082, BR-ENT-01..05):
 * 1. CSR / School Sponsored (takes precedence)
 * 2. Active B2C Paid Subscription
 * 3. Free Tier Fallback
 */
export async function recomputeEntitlement(
  studentId: string
): Promise<RecomputedEntitlementResult> {
  const now = new Date();

  // 1. Check for active subscriptions
  const activeSubs = await prisma.subscription.findMany({
    where: {
      studentId,
      status: { in: ["active", "trialing"] },
      currentPeriodEnd: { gte: now },
    },
    include: {
      planVersion: {
        include: { plan: true },
      },
    },
    orderBy: { currentPeriodEnd: "desc" },
  });

  // Check sponsored first
  const sponsoredSub = activeSubs.find(
    (s) => s.source === "csr_grant" || s.source === "school_sponsored"
  );

  let effectiveAccess: "FREE" | "PREMIUM_PAID" | "PREMIUM_SPONSORED" = "FREE";
  let dailyTutorLimit = 25;
  let voiceMinutesPerDay = 0;
  let battleEnabled = true;
  let validTo: Date | null = null;
  let source: "free" | "paid" | "sponsored" = "free";

  if (sponsoredSub) {
    effectiveAccess = "PREMIUM_SPONSORED";
    source = "sponsored";
    validTo = sponsoredSub.currentPeriodEnd;
    const quotas = (sponsoredSub.planVersion?.quotas as any) || {};
    dailyTutorLimit = quotas.dailyTutorLimit ?? 100;
    voiceMinutesPerDay = quotas.voiceMinutesPerDay ?? 30;
    battleEnabled = quotas.battleEnabled !== false;
  } else if (activeSubs.length > 0) {
    const paidSub = activeSubs[0];
    effectiveAccess = "PREMIUM_PAID";
    source = "paid";
    validTo = paidSub.currentPeriodEnd;
    const quotas = (paidSub.planVersion?.quotas as any) || {};
    dailyTutorLimit = quotas.dailyTutorLimit ?? 100;
    voiceMinutesPerDay = quotas.voiceMinutesPerDay ?? 30;
    battleEnabled = quotas.battleEnabled !== false;
  }

  // Upsert Entitlement table
  await prisma.entitlement.upsert({
    where: { studentId },
    create: {
      studentId,
      source,
      effectiveAccess,
      validFrom: now,
      validTo,
      dailyTutorLimit,
      voiceMinutesPerDay,
      battleEnabled,
    },
    update: {
      source,
      effectiveAccess,
      validTo,
      dailyTutorLimit,
      voiceMinutesPerDay,
      battleEnabled,
    },
  });

  // Sync to User table daily limit
  await prisma.user.update({
    where: { id: studentId },
    data: {
      dailyTutorLimit,
    },
  });

  return {
    studentId,
    effectiveAccess,
    dailyTutorLimit,
    voiceMinutesPerDay,
    battleEnabled,
    validTo,
    source,
  };
}
