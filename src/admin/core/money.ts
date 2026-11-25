import { Decimal } from "@prisma/client/runtime/library";

export function toMoneyString(val: Decimal | number | string | null | undefined): string {
  if (val === null || val === undefined) return "0.00";
  const num = typeof val === "object" && "toFixed" in val ? val.toNumber() : Number(val);
  return isNaN(num) ? "0.00" : num.toFixed(2);
}

export function formatBdt(val: Decimal | number | string | null | undefined): string {
  if (val === null || val === undefined) return "৳ 0.00";
  const num = typeof val === "object" && "toFixed" in val ? val.toNumber() : Number(val);
  if (isNaN(num)) return "৳ 0.00";
  const parts = num.toFixed(2).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `৳ ${parts.join(".")}`;
}

export function toMoneyDecimal(val: Decimal | number | string | null | undefined): Decimal {
  if (val instanceof Decimal) return val;
  if (val === null || val === undefined) return new Decimal(0);
  return new Decimal(val);
}
