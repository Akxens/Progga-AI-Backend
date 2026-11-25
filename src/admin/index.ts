import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "./core/require-admin";
import { getCtx } from "./core/context";
import { sendOne } from "./core/respond";

import { adminAuthRouter } from "./auth/routes";
import { approvalsRouter } from "./approvals/routes";
import { filesRouter } from "./files/routes";
import { lookupsRouter } from "./lookups/routes";
import { systemRouter } from "./system";
import { studentsRouter } from "./students/routes";
import { sessionsRouter } from "./sessions/routes";
import { analyticsRouter } from "./analytics/routes";
import { guardiansRouter } from "./guardians/routes";
import { schoolsRouter } from "./schools/routes";
import { teachersRouter } from "./teachers/routes";
import { importsRouter } from "./imports/routes";
import { trainingRouter } from "./training/routes";
import { activationRouter } from "./activation/routes";
import { academicsCurriculumRouter } from "./academics/curriculum";
import { academicsCoursesRouter } from "./academics/courses";
import { academicsReviewRouter } from "./academics/review";
import { financePlansRouter } from "./finance/plans";
import { financeSubscriptionsRouter } from "./finance/subscriptions";
import { financePaymentsRouter } from "./finance/payments";
import { csrPartnersRouter } from "./csr/partners";
import { csrProgrammesRouter } from "./csr/programmes";
import { csrBeneficiariesRouter } from "./csr/beneficiaries";
import { csrReceiptsRouter } from "./csr/receipts";
import { csrOverviewRouter } from "./csr/overview";
import { workQueueRouter } from "./system/work-queue";
import { dashboardRouter } from "./dashboard/routes";

export const adminRouter = Router();

// Rate limiter for admin endpoints: 600 requests per minute
const adminLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
});

adminRouter.use(adminLimiter);

// Auth endpoints require session authentication but run before requireAdmin / MFA verification
adminRouter.use("/auth", adminAuthRouter);

// Protected portal endpoints require both session authentication and Admin / MFA / Workspace context
adminRouter.use(requireAuth);
adminRouter.use(requireAdmin);

adminRouter.use("/approvals", approvalsRouter);
adminRouter.use("/files", filesRouter);
adminRouter.use("/lookups", lookupsRouter);
adminRouter.use("/system", systemRouter);
adminRouter.use("/students", studentsRouter);
adminRouter.use("/sessions", sessionsRouter);
adminRouter.use("/analytics", analyticsRouter);
adminRouter.use("/guardians", guardiansRouter);
adminRouter.use("/schools", schoolsRouter);
adminRouter.use("/teachers", teachersRouter);
adminRouter.use("/imports", importsRouter);
adminRouter.use("/training", trainingRouter);
adminRouter.use("/activation", activationRouter);

// Academics
adminRouter.use("/academics", academicsCurriculumRouter);
adminRouter.use("/academics", academicsCoursesRouter);
adminRouter.use("/academics", academicsReviewRouter);
adminRouter.use(academicsCurriculumRouter);
adminRouter.use(academicsCoursesRouter);
adminRouter.use(academicsReviewRouter);

// Finance
adminRouter.use("/finance", financePlansRouter);
adminRouter.use("/finance", financeSubscriptionsRouter);
adminRouter.use("/finance", financePaymentsRouter);
adminRouter.use(financePlansRouter);
adminRouter.use(financeSubscriptionsRouter);
adminRouter.use(financePaymentsRouter);

// CSR & Progga Foundation
adminRouter.use("/csr/partners", csrPartnersRouter);
adminRouter.use("/csr/programmes", csrProgrammesRouter);
adminRouter.use("/csr/beneficiaries", csrBeneficiariesRouter);
adminRouter.use("/csr/allocations", csrBeneficiariesRouter);
adminRouter.use("/csr/receipts", csrReceiptsRouter);
adminRouter.use("/csr", csrReceiptsRouter); // for /csr/ledger
adminRouter.use("/csr", csrOverviewRouter); // for /csr/overview and /csr/impact

// Work-Queue & Dashboard
adminRouter.use("/work-queue", workQueueRouter);
adminRouter.use("/dashboard", dashboardRouter);

// Core GET /api/admin/me
adminRouter.get("/me", async (req, res, next) => {
  try {
    const ctx = getCtx(req);

    let scopeLabel = "All";
    if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
      const s = await prisma.school.findUnique({ where: { id: ctx.scope.id }, select: { name: true } });
      scopeLabel = s?.name ?? ctx.scope.id;
    } else if (ctx.scope.type === "LEGAL_ENTITY" && ctx.scope.id) {
      const l = await prisma.legalEntity.findUnique({ where: { id: ctx.scope.id }, select: { name: true } });
      scopeLabel = l?.name ?? ctx.scope.id;
    } else if (ctx.scope.id) {
      scopeLabel = ctx.scope.id;
    }

    sendOne(res, {
      user: {
        id: ctx.user.id,
        role: ctx.user.role,
      },
      assignment: {
        id: ctx.roleAssignment.id,
        roleKey: ctx.roleAssignment.role.key,
        roleName: ctx.roleAssignment.role.name,
        scopeType: ctx.scope.type,
        scopeId: ctx.scope.id,
        scopeLabel,
      },
      role: ctx.roleAssignment.role.key,
      permissions: Array.from(ctx.permissions),
      scope: ctx.scope,
      scopeLabel,
      staffProfile: {
        title: ctx.staffProfile.title,
        department: ctx.staffProfile.department,
        mfaEnrolled: Boolean(ctx.staffProfile.mfaSecretEnc),
        mustChangePassword: ctx.staffProfile.mustChangePassword,
      },
      activeWorkspace: {
        assignmentId: ctx.roleAssignment.id,
        roleKey: ctx.roleAssignment.role.key,
        roleName: ctx.roleAssignment.role.name,
        scopeType: ctx.scope.type,
        scopeId: ctx.scope.id,
        permissions: Array.from(ctx.permissions),
      },
    });
  } catch (err) {
    next(err);
  }
});
