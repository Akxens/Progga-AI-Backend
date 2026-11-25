import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { emitAudit } from "../core/audit";

export const guardiansRouter = Router();

// GET /api/admin/guardians
guardiansRouter.get("/", requirePermission("guardians.view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    const where: Record<string, unknown> = {
      role: "PARENT",
    };

    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { guardianStudents: { some: { student: { name: { contains: q, mode: "insensitive" } } } } },
      ];
    }

    const [total, parents] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          guardianOf: {
            where: { status: "active" },
            include: {
              student: {
                select: { id: true, name: true, grade: true, studentProfile: { select: { code: true } } },
              },
            },
          },
        },
      }),
    ]);

    const mapped = parents.map((p) => ({
      id: p.id,
      name: p.name,
      phone: p.phone,
      email: p.email,
      accountStatus: p.accountStatus,
      createdAt: p.createdAt,
      activeStudentsCount: p.guardianOf.length,
      students: p.guardianOf.map((gs) => ({
        id: gs.student.id,
        code: gs.student.studentProfile?.code || gs.student.id,
        name: gs.student.name,
        grade: gs.student.grade,
        relation: gs.relation,
        isVerified: gs.isVerified,
      })),
    }));

    return sendList(res, mapped, total, { page, pageSize });
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/guardians/:id
guardiansRouter.get("/:id", requirePermission("guardians.view"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const parent = await prisma.user.findUnique({
      where: { id },
      include: {
        guardianOf: {
          include: {
            student: {
              include: { studentProfile: { include: { school: true } } },
            },
            consents: true,
          },
        },
      },
    });

    if (!parent || parent.role !== "PARENT") {
      return next(notFound("Guardian not found"));
    }

    return sendOne(res, {
      id: parent.id,
      name: parent.name,
      phone: parent.phone,
      email: parent.email,
      accountStatus: parent.accountStatus,
      createdAt: parent.createdAt,
      links: parent.guardianOf.map((gs) => ({
        id: gs.id,
        studentId: gs.studentId,
        studentName: gs.student.name,
        studentCode: gs.student.studentProfile?.code,
        schoolName: gs.student.studentProfile?.school?.name,
        relation: gs.relation,
        status: gs.status,
        isVerified: gs.isVerified,
        canManageBilling: gs.canManageBilling,
        createdAt: gs.createdAt,
        consents: gs.consents,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

const InviteGuardianSchema = z.object({
  studentId: z.string().min(1),
  contact: z.string().trim().min(3),
  relation: z.string().trim().default("parent"),
});

// POST /api/admin/guardians/invites
guardiansRouter.post("/invites", requirePermission("guardians.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parse = InviteGuardianSchema.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Invalid invite parameters", parse.error.flatten().fieldErrors));
    }
    const data = parse.data;

    const student = await prisma.user.findUnique({
      where: { id: data.studentId },
      include: { studentProfile: true },
    });
    if (!student || !student.studentProfile) return next(notFound("Student not found"));

    const rawToken = crypto.randomBytes(20).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const invite = await prisma.$transaction(async (tx) => {
      const inv = await tx.guardianInvite.create({
        data: {
          studentId: data.studentId,
          contact: data.contact,
          relation: data.relation,
          tokenHash,
          status: "sent",
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          sentById: ctx.user.id,
        },
      });

      if (student.studentProfile?.guardianStatus === "none") {
        await tx.studentProfile.update({
          where: { userId: student.id },
          data: { guardianStatus: "invited" },
        });
      }

      return inv;
    });

    await emitAudit(req, {
      action: "guardian.invite",
      entityType: "GuardianInvite",
      entityId: invite.id,
      after: { studentId: data.studentId, contact: data.contact, relation: data.relation },
    });

    return sendOne(res, invite, { statusCode: 201 });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/guardians/links/:id/verify
guardiansRouter.post("/links/:id/verify", requirePermission("guardians.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const linkId = req.params.id as string;
    const { note } = req.body as { method?: string; note?: string };

    const link = await prisma.guardianLink.findUnique({
      where: { id: linkId },
    });
    if (!link) return next(notFound("Guardian link not found"));

    await prisma.$transaction(async (tx) => {
      await tx.guardianLink.update({
        where: { id: linkId },
        data: {
          isVerified: true,
          verifiedAt: new Date(),
        },
      });

      await tx.studentProfile.update({
        where: { userId: link.studentId },
        data: { guardianStatus: "verified" },
      });
    });

    await emitAudit(req, {
      action: "guardian_link.verify",
      entityType: "GuardianLink",
      entityId: linkId,
      reason: note || "Admin verified guardian linkage",
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/guardians/links/:id/revoke
guardiansRouter.post("/links/:id/revoke", requirePermission("guardians.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const linkId = req.params.id as string;
    const { reason } = req.body as { reason?: string };

    if (!reason || reason.trim().length < 5) {
      return next(badRequest("A reason of at least 5 characters is required"));
    }

    const link = await prisma.guardianLink.findUnique({
      where: { id: linkId },
    });
    if (!link) return next(notFound("Guardian link not found"));

    await prisma.$transaction(async (tx) => {
      // Soft-revoke the link
      await tx.guardianLink.update({
        where: { id: linkId },
        data: {
          status: "revoked",
          revokedAt: new Date(),
          revokedById: ctx.user.id,
          revokedReason: reason.trim(),
        },
      });

      // Revoke any consents recorded under this link
      await tx.consent.updateMany({
        where: { guardianLinkId: linkId, status: "granted" },
        data: {
          status: "revoked",
          revokedAt: new Date(),
          revokedReason: `Revoked with guardian link: ${reason.trim()}`,
        },
      });

      // Check if other active links remain for the student
      const remaining = await tx.guardianLink.count({
        where: { studentId: link.studentId, status: "active" },
      });

      if (remaining === 0) {
        await tx.studentProfile.update({
          where: { userId: link.studentId },
          data: { guardianStatus: "none" },
        });
      }
    });

    await emitAudit(req, {
      action: "guardian_link.revoke",
      entityType: "GuardianLink",
      entityId: linkId,
      reason: reason.trim(),
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});

const RecordConsentSchema = z.object({
  studentId: z.string().min(1),
  guardianLinkId: z.string().optional(),
  policyId: z.string().min(1),
  method: z.enum(["in_app", "paper_form", "school_agreement", "sms_otp"]).default("paper_form"),
  evidenceNote: z.string().trim().default(""),
});

// POST /api/admin/consents
guardiansRouter.post("/consents", requirePermission("consent.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parse = RecordConsentSchema.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Invalid consent parameters", parse.error.flatten().fieldErrors));
    }
    const data = parse.data;

    const policy = await prisma.consentPolicy.findUnique({ where: { id: data.policyId } });
    if (!policy) return next(badRequest("Consent policy not found"));

    const consent = await prisma.consent.create({
      data: {
        studentId: data.studentId,
        guardianLinkId: data.guardianLinkId || null,
        policyId: data.policyId,
        consentType: policy.consentType,
        status: "granted",
        method: data.method,
        evidenceEnc: data.evidenceNote || null,
        recordedById: ctx.user.id,
      },
    });

    await emitAudit(req, {
      action: "consent.record",
      entityType: "Consent",
      entityId: consent.id,
      after: { studentId: data.studentId, policyId: data.policyId, method: data.method },
    });

    return sendOne(res, consent, { statusCode: 201 });
  } catch (err) {
    return next(err);
  }
});
