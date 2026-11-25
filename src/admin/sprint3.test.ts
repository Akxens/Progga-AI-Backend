import { describe, it, expect, vi } from "vitest";
import { postJournal } from "./core/ledger";
import {
  initiateShurjopayPayment,
  verifyShurjopayPayment,
  verifyShurjopayWebhookSignature,
} from "../modules/billing/shurjopay";

describe("Sprint 3 Core Modules (TASK-080, TASK-082, TASK-083)", () => {
  describe("Double-Entry Ledger Lite Core (TASK-080)", () => {
    it("rejects journal entries with fewer than two lines", async () => {
      const mockTx = {};
      await expect(
        postJournal(mockTx, {
          entryType: "SUBSCRIPTION_PAYMENT",
          description: "Invalid single line",
          entries: [
            { accountCode: "1000", direction: "debit", amount: 100 },
          ],
        })
      ).rejects.toThrow(/at least two balanced posting lines/i);
    });

    it("rejects unbalanced debits and credits", async () => {
      const mockTx = {};
      await expect(
        postJournal(mockTx, {
          entryType: "SUBSCRIPTION_PAYMENT",
          description: "Unbalanced payment",
          entries: [
            { accountCode: "1000", direction: "debit", amount: 500 },
            { accountCode: "4000", direction: "credit", amount: 450 },
          ],
        })
      ).rejects.toThrow(/Unbalanced journal entry/i);
    });

    it("rejects non-positive or invalid amounts", async () => {
      const mockTx = {};
      await expect(
        postJournal(mockTx, {
          entryType: "SUBSCRIPTION_PAYMENT",
          description: "Negative amount",
          entries: [
            { accountCode: "1000", direction: "debit", amount: -100 },
            { accountCode: "4000", direction: "credit", amount: -100 },
          ],
        })
      ).rejects.toThrow(/Invalid ledger amount/i);
    });

    it("creates balanced journal entry when debits equal credits", async () => {
      let createdData: any = null;
      const mockTx = {
        ledgerJournal: {
          create: vi.fn().mockImplementation(async ({ data }: any) => {
            createdData = data;
            return {
              id: "jrn_test_123",
              ...data,
              entries: data.entries.create,
            };
          }),
        },
      };

      const result = await postJournal(mockTx, {
        entryType: "SUBSCRIPTION_PAYMENT",
        description: "Payment for TXN-0001",
        entries: [
          { accountCode: "1000", direction: "debit", amount: 499 },
          { accountCode: "4000", direction: "credit", amount: 499 },
        ],
      });

      expect(result).toBeDefined();
      expect(result.id).toBe("jrn_test_123");
      expect(createdData.entryType).toBe("SUBSCRIPTION_PAYMENT");
      expect(createdData.entries.create).toHaveLength(2);
      expect(createdData.entries.create[0].amount).toBe(499);
      expect(createdData.entries.create[1].amount).toBe(499);
    });
  });

  describe("Shurjopay Gateway Adapter (TASK-080, TASK-083)", () => {
    it("initiates payment returning structured checkout url and order ID", async () => {
      const result = await initiateShurjopayPayment({
        orderId: "TXN-998811",
        amount: 299,
        customerName: "Afsana Khan",
        customerEmail: "afsana@example.com",
        customerPhone: "01711223344",
        returnUrl: "http://localhost:3000/billing/return",
        cancelUrl: "http://localhost:3000/billing/cancelled",
      });

      expect(result).toBeDefined();
      expect(result.checkoutUrl).toContain("TXN-998811");
      expect(result.checkoutUrl).toContain("amount=299");
      expect(result.spOrderId).toContain("TXN-998811");
    });

    it("verifies mock payment returning verified succeeded status", async () => {
      const result = await verifyShurjopayPayment("TXN-998811");
      expect(result.verified).toBe(true);
      expect(result.status).toBe("succeeded");
      expect(result.spCode).toBe("1000");
    });

    it("validates signature verification helper", () => {
      const valid = verifyShurjopayWebhookSignature({ order_id: "TXN-123" });
      expect(valid).toBe(true);
    });
  });
});
