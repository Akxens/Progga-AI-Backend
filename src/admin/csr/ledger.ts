import { prisma } from "../../lib/prisma";
import { badRequest } from "../../lib/errors";
import { postJournal } from "../core/ledger";

/**
 * Chart of accounts for Progga Foundation (CSR & Donor Grant entity)
 */
export const FOUNDATION_ACCOUNTS = {
  CASH_BANK: "1010", // Foundation Cash / Bank Account
  DEFERRED_GRANT: "2010", // Deferred Grant Receipts (Liability)
  GRANT_REVENUE: "4010", // Grant Revenue Recognized (Income)
  SPONSORED_ACCESS: "5010", // Sponsored Student Access Expense
  PROGRAMME_OPS: "5020", // Programme Operations Expense
} as const;

/**
 * BR-CSR-05: Calculates prorated allocation amount.
 * Formula: fundedRatePerSeatMonth * months (with partial month proration by days).
 */
export function calculateProratedAllocation(
  fundedRatePerSeatMonth: number,
  coverageFrom: Date,
  coverageTo: Date
): number {
  const from = new Date(coverageFrom);
  const to = new Date(coverageTo);

  if (to <= from) {
    throw badRequest("Coverage end date must be after coverage start date");
  }

  const startYear = from.getFullYear();
  const startMonth = from.getMonth();
  const endYear = to.getFullYear();
  const endMonth = to.getMonth();

  let totalMonths = 0;

  // Iterate month by month
  let current = new Date(startYear, startMonth, 1);
  const endLimit = new Date(endYear, endMonth, 1);

  while (current <= endLimit) {
    const y = current.getFullYear();
    const m = current.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    const monthStart = new Date(y, m, 1);
    const monthEnd = new Date(y, m, daysInMonth, 23, 59, 59);

    const activeFrom = from > monthStart ? from : monthStart;
    const activeTo = to < monthEnd ? to : monthEnd;

    const diffDays = Math.max(
      0,
      Math.floor((activeTo.getTime() - activeFrom.getTime()) / (1000 * 60 * 60 * 24)) + 1
    );

    if (diffDays >= daysInMonth) {
      totalMonths += 1;
    } else {
      totalMonths += diffDays / daysInMonth;
    }

    current = new Date(y, m + 1, 1);
  }

  const rawAmount = totalMonths * fundedRatePerSeatMonth;
  return Math.round(rawAmount * 100) / 100;
}

/**
 * Records a grant receipt for a CSR programme and posts the corresponding Foundation double-entry ledger journal.
 * Debit 1010 (Foundation Cash), Credit 2010 (Deferred Grant Receipts).
 */
export async function postFoundationGrantReceipt(
  tx: any,
  params: {
    programmeId: string;
    amount: number;
    receivedOn: Date;
    reference: string;
    evidenceFileIds?: string[];
    recordedById: string;
  }
) {
  const { programmeId, amount, receivedOn, reference, evidenceFileIds = [], recordedById } = params;

  if (amount <= 0) {
    throw badRequest("Grant receipt amount must be greater than 0");
  }

  const programme = await tx.programme.findUnique({
    where: { id: programmeId },
    select: { id: true, code: true, name: true },
  });

  if (!programme) {
    throw badRequest("Programme not found");
  }

  const idempotencyKey = `grc:${programmeId}:${reference}:${amount}`;

  // 1. Post double-entry balanced journal to Foundation ledger
  const journal = await postJournal(tx, {
    legalEntityId: "foundation",
    entryType: "CSR_GRANT",
    description: `Grant receipt for ${programme.name} (${programme.code}) Ref: ${reference}`,
    postedById: recordedById,
    entries: [
      {
        accountCode: FOUNDATION_ACCOUNTS.CASH_BANK,
        direction: "debit",
        amount,
        description: `Bank deposit ref: ${reference}`,
      },
      {
        accountCode: FOUNDATION_ACCOUNTS.DEFERRED_GRANT,
        direction: "credit",
        amount,
        description: `Deferred donor grant for ${programme.code}`,
      },
    ],
  });

  // 2. Create the GrantReceipt record
  const receiptCode = `GRC-${Date.now().toString().slice(-6)}`;
  const receipt = await tx.grantReceipt.create({
    data: {
      code: receiptCode,
      programmeId,
      amount,
      receivedOn,
      reference,
      evidenceFileIds,
      journalId: journal.id,
      idempotencyKey,
      recordedById,
    },
  });

  return { receipt, journal };
}
