import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

export type CodePrefix =
  | "STU"
  | "TCH"
  | "SCH"
  | "TRP"
  | "CRT"
  | "ACT"
  | "IMP"
  | "CUR"
  | "CRS"
  | "QST"
  | "EXM"
  | "LVC"
  | "SES"
  | "SAF"
  | "PLN"
  | "SUB"
  | "ORD"
  | "TXN"
  | "RFD"
  | "REC"
  | "JRN"
  | "EXP"
  | "PRT"
  | "PRG"
  | "GRC"
  | "SPN"
  | "IER"
  | "RWD"
  | "RWO"
  | "TKT"
  | "APR"
  | "RPT"
  | "INC";

export async function nextCode(
  txOrPrefix: Prisma.TransactionClient | CodePrefix,
  maybePrefix?: CodePrefix,
): Promise<string> {
  let client: Prisma.TransactionClient;
  let prefix: CodePrefix;

  if (typeof txOrPrefix === "string") {
    client = prisma as any;
    prefix = txOrPrefix;
  } else {
    client = txOrPrefix;
    prefix = maybePrefix!;
  }

  const seq = `code_seq_${prefix.toLowerCase()}`;
  try {
    const rows = await client.$queryRawUnsafe<{ n: bigint }[]>(`SELECT nextval('${seq}') AS n`);
    const n = rows[0]?.n ? Number(rows[0].n) : 1;
    return `${prefix}-${String(n).padStart(6, "0")}`;
  } catch {
    // Fallback if sequence not present in dev
    const random = Math.floor(100000 + Math.random() * 900000);
    return `${prefix}-${random}`;
  }
}
