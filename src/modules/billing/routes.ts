import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, unauthorized } from "../../lib/errors";
import { authed, requireAuth } from "../../middleware/auth";
import { initiateShurjopayPayment, verifyShurjopayWebhookSignature } from "./shurjopay";
import { recomputeEntitlement } from "./entitlements";
import { postJournal } from "../../admin/core/ledger";
import { nextCode } from "../../admin/core/codes";

export const billingRouter = Router();

// GET /api/billing/plans
billingRouter.get("/plans", async (req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({
      where: { status: "active" },
      include: {
        versions: {
          where: { status: "active" },
          orderBy: { versionNumber: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const formatted = plans.map((p) => {
      const v = p.versions[0];
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
        accessType: p.accessType,
        planVersionId: v?.id || null,
        priceAmount: v ? Number(v.priceAmount) : 0,
        currency: v?.currency || "BDT",
        billingInterval: v?.billingInterval || "month",
        trialDays: v?.trialDays || 0,
        quotas: v?.quotas || {},
      };
    });

    return res.json({ plans: formatted });
  } catch (err) {
    return next(err);
  }
});

// GET /api/billing/access/:studentId
billingRouter.get("/access/:studentId", requireAuth, async (req, res, next) => {
  try {
    const current = authed(req);
    const targetStudentId = req.params.studentId as string;

    // Must be own student account or authorized admin
    if (current.id !== targetStudentId && (current as any).role !== "ADMIN" && (current as any).role !== "SUPER_ADMIN") {
      return next(unauthorized("Not authorized to view access for this student"));
    }

    const entitlement = await recomputeEntitlement(targetStudentId);
    return res.json(entitlement);
  } catch (err) {
    return next(err);
  }
});

const CheckoutSchema = z.object({
  studentId: z.string().min(1),
  planVersionId: z.string().min(1),
  returnUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

// POST /api/billing/checkout
billingRouter.post("/checkout", requireAuth, async (req, res, next) => {
  try {
    const user = authed(req);
    const parsed = CheckoutSchema.parse(req.body);

    const planVersion = await prisma.planVersion.findUnique({
      where: { id: parsed.planVersionId },
      include: { plan: true },
    });
    if (!planVersion) return next(notFound("Plan version not found"));

    const student = await prisma.user.findUnique({
      where: { id: parsed.studentId },
    });
    if (!student) return next(notFound("Student not found"));

    const txnCode = await nextCode("TXN");
    const amount = Number(planVersion.priceAmount);

    const initResult = await initiateShurjopayPayment({
      orderId: txnCode,
      amount,
      customerName: student.name || "Progga Student",
      customerEmail: student.email || undefined,
      customerPhone: student.phone || undefined,
      returnUrl: parsed.returnUrl || `${process.env.APP_URL || "http://localhost:3000"}/billing/return?order=${txnCode}`,
      cancelUrl: parsed.cancelUrl || `${process.env.APP_URL || "http://localhost:3000"}/billing/cancelled`,
      clientIp: req.ip,
    });

    // Create pending payment transaction
    await prisma.paymentTransaction.create({
      data: {
        code: txnCode,
        studentId: student.id,
        amount,
        currency: planVersion.currency,
        provider: "shurjopay",
        providerTxnId: initResult.spOrderId,
        status: "pending",
        metadata: {
          planVersionId: planVersion.id,
          planName: planVersion.plan.name,
          checkoutUrl: initResult.checkoutUrl,
        },
      },
    });

    return res.json({
      orderCode: txnCode,
      checkoutUrl: initResult.checkoutUrl,
      spOrderId: initResult.spOrderId,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/webhooks/payments/:provider
billingRouter.post("/webhooks/payments/:provider", async (req, res, next) => {
  try {
    const provider = req.params.provider;
    const payload = req.body;
    const signature = req.headers["x-shurjopay-signature"] as string | undefined;

    // Record webhook event
    await prisma.paymentWebhookEvent.create({
      data: {
        provider,
        eventType: "payment_notification",
        payload: payload || {},
        signature: signature || null,
        processed: false,
      },
    });

    const orderId = payload.order_id || payload.customer_order_id;
    if (!orderId) {
      return res.status(200).json({ received: true, note: "No order id found in payload" });
    }

    const txn = await prisma.paymentTransaction.findUnique({
      where: { code: orderId },
      include: { user: true },
    });

    if (!txn || txn.status === "succeeded") {
      return res.status(200).json({ received: true, status: txn?.status || "not_found" });
    }

    const spStatus = (payload.sp_message || payload.status || "").toLowerCase();
    const isSuccess = spStatus.includes("success") || payload.status === "200" || payload.status === 200;

    if (isSuccess) {
      const now = new Date();
      const planVersionId = (txn.metadata as any)?.planVersionId;
      const planVersion = planVersionId
        ? await prisma.planVersion.findUnique({ where: { id: planVersionId } })
        : null;

      await prisma.$transaction(async (tx) => {
        // 1. Mark transaction succeeded
        await tx.paymentTransaction.update({
          where: { id: txn.id },
          data: {
            status: "succeeded",
            completedAt: now,
            providerTxnId: payload.sp_order_id || txn.providerTxnId,
            method: payload.method || payload.card_type || "shurjopay",
          },
        });

        // 2. Create or extend Subscription
        if (planVersion) {
          const subCode = await nextCode(tx, "SUB");
          const periodEnd = new Date(now);
          if (planVersion.billingInterval === "year") {
            periodEnd.setFullYear(periodEnd.getFullYear() + 1);
          } else {
            periodEnd.setDate(periodEnd.getDate() + 30);
          }

          const sub = await tx.subscription.create({
            data: {
              code: subCode,
              studentId: txn.studentId,
              planVersionId: planVersion.id,
              status: "active",
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
              source: "b2c_online",
              autoRenew: true,
            },
          });

          await tx.paymentTransaction.update({
            where: { id: txn.id },
            data: { subscriptionId: sub.id },
          });
        }

        // 3. Create Invoice
        const invNumber = `INV-${now.getFullYear()}-${txn.code.replace(/[^0-9]/g, "").slice(-6) || Date.now().toString().slice(-6)}`;
        await tx.invoice.create({
          data: {
            invoiceNumber: invNumber,
            studentId: txn.studentId,
            paymentTransactionId: txn.id,
            amount: txn.amount,
            currency: txn.currency,
            status: "paid",
          },
        });

        // 4. Double-Entry Balanced Ledger Entry
        await postJournal(tx, {
          entryType: "SUBSCRIPTION_PAYMENT",
          description: `Online subscription payment for ${txn.code}`,
          entries: [
            {
              accountCode: "1000",
              direction: "debit",
              amount: Number(txn.amount),
              description: `Gateway Cash Settlement ${txn.code}`,
            },
            {
              accountCode: "4000",
              direction: "credit",
              amount: Number(txn.amount),
              description: `B2C Subscription Revenue ${txn.code}`,
            },
          ],
        });
      });

      // 5. Recompute student entitlement
      await recomputeEntitlement(txn.studentId);
    }

    return res.status(200).json({ received: true, processed: isSuccess });
  } catch (err) {
    return next(err);
  }
});

// GET /api/billing/return/:orderCode
billingRouter.get("/return/:orderCode", async (req, res, next) => {
  try {
    const txn = await prisma.paymentTransaction.findUnique({
      where: { code: req.params.orderCode as string },
      include: {
        subscription: {
          include: { planVersion: { include: { plan: true } } },
        },
      },
    });

    if (!txn) return next(notFound("Order not found"));

    return res.json({
      orderCode: txn.code,
      status: txn.status,
      amount: Number(txn.amount),
      currency: txn.currency,
      completedAt: txn.completedAt,
      subscription: txn.subscription
        ? {
            code: txn.subscription.code,
            planName: txn.subscription.planVersion.plan.name,
            currentPeriodEnd: txn.subscription.currentPeriodEnd,
          }
        : null,
    });
  } catch (err) {
    return next(err);
  }
});
