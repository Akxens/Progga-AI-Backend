import { prisma } from "../../lib/prisma";
import { badRequest } from "../../lib/errors";

export interface LedgerPostingItem {
  accountCode: string;
  direction: "debit" | "credit";
  amount: number | string;
  description?: string;
}

export interface PostJournalParams {
  legalEntityId?: string;
  entryType: "SUBSCRIPTION_PAYMENT" | "REFUND" | "CSR_GRANT" | "ADJUSTMENT";
  description: string;
  postedById?: string;
  entries: LedgerPostingItem[];
}

/**
 * Double-entry balanced journal poster.
 * Enforces sum(debits) === sum(credits).
 */
export async function postJournal(
  tx: any,
  params: PostJournalParams
): Promise<any> {
  if (!params.entries || params.entries.length < 2) {
    throw badRequest("A journal entry requires at least two balanced posting lines");
  }

  let totalDebits = 0;
  let totalCredits = 0;

  for (const item of params.entries) {
    const amt = Number(item.amount);
    if (isNaN(amt) || amt <= 0) {
      throw badRequest(`Invalid ledger amount: ${item.amount}`);
    }
    if (item.direction === "debit") {
      totalDebits += amt;
    } else if (item.direction === "credit") {
      totalCredits += amt;
    } else {
      throw badRequest(`Invalid posting direction: ${item.direction}`);
    }
  }

  // Floating point safety margin check
  if (Math.abs(totalDebits - totalCredits) > 0.001) {
    throw badRequest(
      `Unbalanced journal entry: Debits (৳${totalDebits.toFixed(2)}) != Credits (৳${totalCredits.toFixed(2)})`
    );
  }

  const code = `JRN-${Date.now().toString().slice(-6)}`;

  const journal = await tx.ledgerJournal.create({
    data: {
      code,
      legalEntityId: params.legalEntityId || null,
      entryType: params.entryType,
      description: params.description,
      postedById: params.postedById || null,
      entries: {
        create: params.entries.map((e) => ({
          accountCode: e.accountCode,
          direction: e.direction,
          amount: Number(e.amount),
          description: e.description || "",
        })),
      },
    },
    include: {
      entries: true,
    },
  });

  return journal;
}
