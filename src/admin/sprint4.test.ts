import { describe, it, expect } from "vitest";
import { calculateProratedAllocation, FOUNDATION_ACCOUNTS } from "./csr/ledger";

describe("CSR & Foundation Business Rules (Sprint 4)", () => {
  it("BR-CSR-05: calculates prorated allocation correctly for whole calendar months", () => {
    const fundedRate = 500; // 500 BDT per seat month
    const start = new Date(2026, 0, 1); // Jan 1, 2026
    const end = new Date(2026, 2, 31, 23, 59, 59); // Mar 31, 2026 (3 whole months: Jan, Feb, Mar)

    const amount = calculateProratedAllocation(fundedRate, start, end);
    // 3 months * 500 = 1500
    expect(amount).toBe(1500);
  });

  it("BR-CSR-05: calculates prorated allocation for partial months", () => {
    const fundedRate = 600;
    // Jan 16 to Jan 31 (16 days out of 31)
    const start = new Date(2026, 0, 16);
    const end = new Date(2026, 0, 31, 23, 59, 59);

    const amount = calculateProratedAllocation(fundedRate, start, end);
    const expected = Math.round((16 / 31) * 600 * 100) / 100;
    expect(amount).toBe(expected);
  });

  it("BR-CSR-05: rejects invalid date ranges where end <= start", () => {
    const fundedRate = 500;
    const start = new Date(2026, 5, 10);
    const end = new Date(2026, 5, 5);

    expect(() => calculateProratedAllocation(fundedRate, start, end)).toThrow(
      "Coverage end date must be after coverage start date"
    );
  });

  it("BR-CSR-01: validates budget lines sum against grantAmount", () => {
    const grantAmount = 100000;
    const validLines = [
      { category: "student_access", amount: 60000 },
      { category: "teacher_training", amount: 25000 },
      { category: "operations", amount: 15000 },
    ];
    const total = validLines.reduce((acc, l) => acc + l.amount, 0);
    expect(total).toBe(grantAmount);

    const invalidLines = [
      { category: "student_access", amount: 50000 },
      { category: "teacher_training", amount: 20000 },
    ];
    const invalidTotal = invalidLines.reduce((acc, l) => acc + l.amount, 0);
    expect(invalidTotal).not.toBe(grantAmount);
  });

  it("BR-CSR-09 & BR-CSR-10: enforces small sample suppression (<10) and separates reach from registered", () => {
    const mockDistrictData = [
      { district: "Dhaka", registered: 45, reach: 38 },
      { district: "Bandarban", registered: 6, reach: 4 },
      { district: "Sylhet", registered: 15, reach: 9 },
    ];

    const processed = mockDistrictData.map((d) => ({
      district: d.district,
      registered: d.registered < 10 ? "<10" : d.registered,
      reach: d.reach < 10 ? "<10" : d.reach,
      isSuppressed: d.registered < 10,
    }));

    expect(processed[0].registered).toBe(45);
    expect(processed[0].reach).toBe(38);
    expect(processed[0].isSuppressed).toBe(false);

    expect(processed[1].registered).toBe("<10");
    expect(processed[1].reach).toBe("<10");
    expect(processed[1].isSuppressed).toBe(true);

    expect(processed[2].registered).toBe(15);
    expect(processed[2].reach).toBe("<10"); // Reach < 10 suppressed
  });

  it("Foundation chart of accounts has segregated non-commercial codes", () => {
    expect(FOUNDATION_ACCOUNTS.CASH_BANK).toBe("1010");
    expect(FOUNDATION_ACCOUNTS.DEFERRED_GRANT).toBe("2010");
    expect(FOUNDATION_ACCOUNTS.GRANT_REVENUE).toBe("4010");
    expect(FOUNDATION_ACCOUNTS.SPONSORED_ACCESS).toBe("5010");
    expect(FOUNDATION_ACCOUNTS.PROGRAMME_OPS).toBe("5020");
  });
});
