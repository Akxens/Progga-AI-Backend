import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { emitAudit } from "../core/audit";

export const academicsReviewRouter = Router();

// GET /api/admin/academics/review
academicsReviewRouter.get(
  "/review",
  requirePermission("courses.review"),
  async (req, res, next) => {
    try {
      const { status = "pending" } = req.query as { status?: string };

      const items = await prisma.contentReview.findMany({
        where: status === "all" ? {} : { status },
        orderBy: { createdAt: "desc" },
      });

      return sendList(res, items, items.length);
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/admin/content-review alias
academicsReviewRouter.get(
  "/content-review",
  requirePermission("courses.review"),
  async (req, res, next) => {
    try {
      const { status = "pending" } = req.query as { status?: string };

      const items = await prisma.contentReview.findMany({
        where: status === "all" ? {} : { status },
        orderBy: { createdAt: "desc" },
      });

      return sendList(res, items, items.length);
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/admin/academics/review
academicsReviewRouter.post(
  "/review",
  requirePermission("courses.edit"),
  async (req, res, next) => {
    try {
      const ctx = getCtx(req);
      const { targetType, targetId, diffSummary } = req.body as {
        targetType: "COURSE" | "LESSON";
        targetId: string;
        diffSummary?: any;
      };

      if (!targetType || !targetId) {
        return next(badRequest("targetType and targetId are required"));
      }

      const review = await prisma.contentReview.create({
        data: {
          targetType,
          targetId,
          submittedById: ctx.user.id,
          diffSummary: diffSummary || {},
          status: "pending",
        },
      });

      // Update target status to in_review
      if (targetType === "COURSE") {
        await prisma.course.update({
          where: { id: targetId },
          data: { status: "in_review" },
        });
      } else if (targetType === "LESSON") {
        await prisma.lesson.update({
          where: { id: targetId },
          data: { status: "in_review" },
        });
      }

      await emitAudit(req, {
        action: "content_review.submit",
        entityType: "ContentReview",
        entityId: review.id,
        after: { targetType, targetId, status: "pending" },
      });

      return sendOne(res, review, { statusCode: 201 });
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/admin/academics/review/:id/approve
academicsReviewRouter.post(
  "/review/:id/approve",
  requirePermission("courses.review"),
  async (req, res, next) => {
    try {
      const ctx = getCtx(req);
      const id = req.params.id as string;
      const review = await prisma.contentReview.findUnique({ where: { id } });
      if (!review) return next(notFound("Content review request not found"));

      const { reviewNotes } = req.body as { reviewNotes?: string };

      const updated = await prisma.$transaction(async (tx) => {
        const r = await tx.contentReview.update({
          where: { id },
          data: {
            status: "approved",
            reviewerId: ctx.user.id,
            reviewNotes: reviewNotes?.trim() || "Approved for publication",
            reviewedAt: new Date(),
          },
        });

        if (r.targetType === "COURSE") {
          await tx.course.update({
            where: { id: r.targetId },
            data: { status: "published", version: { increment: 1 } },
          });
        } else if (r.targetType === "LESSON") {
          await tx.lesson.update({
            where: { id: r.targetId },
            data: { status: "published" },
          });
        }

        return r;
      });

      await emitAudit(req, {
        action: "content_review.approve",
        entityType: "ContentReview",
        entityId: id,
        after: { status: "approved" },
      });

      return sendOne(res, updated);
    } catch (err) {
      return next(err);
    }
  }
);

// POST /api/admin/academics/review/:id/reject
academicsReviewRouter.post(
  "/review/:id/reject",
  requirePermission("courses.review"),
  async (req, res, next) => {
    try {
      const ctx = getCtx(req);
      const id = req.params.id as string;
      const { reviewNotes } = req.body as { reviewNotes?: string };
      if (!reviewNotes) return next(badRequest("Rejection feedback notes are required"));

      const review = await prisma.contentReview.findUnique({ where: { id } });
      if (!review) return next(notFound("Content review request not found"));

      const updated = await prisma.$transaction(async (tx) => {
        const r = await tx.contentReview.update({
          where: { id },
          data: {
            status: "rejected",
            reviewerId: ctx.user.id,
            reviewNotes: reviewNotes.trim(),
            reviewedAt: new Date(),
          },
        });

        if (r.targetType === "COURSE") {
          await tx.course.update({
            where: { id: r.targetId },
            data: { status: "draft" },
          });
        } else if (r.targetType === "LESSON") {
          await tx.lesson.update({
            where: { id: r.targetId },
            data: { status: "draft" },
          });
        }

        return r;
      });

      await emitAudit(req, {
        action: "content_review.reject",
        entityType: "ContentReview",
        entityId: id,
        after: { status: "rejected", reviewNotes },
      });

      return sendOne(res, updated);
    } catch (err) {
      return next(err);
    }
  }
);
