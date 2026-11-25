import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, forbidden } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { nextCode } from "../core/codes";
import { emitAudit } from "../core/audit";
import { revokedSettingKey } from "../../middleware/auth";

export const studentsRouter = Router();

// GET /api/admin/students
studentsRouter.get("/", requirePermission("students.view"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    // Scope check: if user is scoped to a SCHOOL, they can ONLY see students in their school
    let scopedSchoolId: string | undefined = undefined;
    if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
      if (req.query.schoolId && req.query.schoolId !== ctx.scope.id) {
        return next(forbidden("Cannot query students outside your assigned school"));
      }
      scopedSchoolId = ctx.scope.id;
    } else if (typeof req.query.schoolId === "string") {
      scopedSchoolId = req.query.schoolId;
    }

    const where: Record<string, unknown> = {
      role: "STUDENT",
      studentProfile: { isNot: null },
    };

    if (scopedSchoolId) {
      where.studentProfile = {
        is: { schoolId: scopedSchoolId },
      };
    }

    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { studentProfile: { is: { code: { contains: q, mode: "insensitive" } } } },
      ];
    }

    if (req.query.grade) {
      where.grade = Number(req.query.grade);
    }

    if (req.query.accessType) {
      where.studentProfile = {
        ...(where.studentProfile as object),
        is: {
          ...((where.studentProfile as any)?.is || {}),
          effectiveAccess: String(req.query.accessType),
        },
      };
    }

    if (req.query.guardianStatus) {
      where.studentProfile = {
        ...(where.studentProfile as object),
        is: {
          ...((where.studentProfile as any)?.is || {}),
          guardianStatus: String(req.query.guardianStatus),
        },
      };
    }

    if (req.query.accountStatus) {
      where.accountStatus = String(req.query.accountStatus);
    }

    if (req.query.district) {
      where.studentProfile = {
        ...(where.studentProfile as object),
        is: {
          ...((where.studentProfile as any)?.is || {}),
          district: String(req.query.district),
        },
      };
    }

    // Sort order
    const sortParam = typeof req.query.sort === "string" ? req.query.sort : "-createdAt";
    let orderBy: Record<string, "asc" | "desc"> = { createdAt: "desc" };
    if (sortParam === "name") orderBy = { name: "asc" };
    else if (sortParam === "-name") orderBy = { name: "desc" };
    else if (sortParam === "grade") orderBy = { grade: "asc" };
    else if (sortParam === "-grade") orderBy = { grade: "desc" };
    else if (sortParam === "createdAt") orderBy = { createdAt: "asc" };
    else if (sortParam === "-createdAt") orderBy = { createdAt: "desc" };

    const [total, students] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy,
        include: {
          studentProfile: {
            include: {
              school: { select: { id: true, name: true, code: true } },
            },
          },
        },
      }),
    ]);

    const mapped = students.map((s) => ({
      id: s.id,
      code: s.studentProfile?.code || s.id,
      name: s.name,
      grade: s.grade,
      school: s.studentProfile?.school
        ? { id: s.studentProfile.school.id, name: s.studentProfile.school.name, code: s.studentProfile.school.code }
        : null,
      district: s.studentProfile?.district || null,
      accessType: s.studentProfile?.effectiveAccess || "FREE",
      guardianStatus: s.studentProfile?.guardianStatus || "none",
      joinedAt: s.createdAt,
      lastActiveAt: s.studentProfile?.lastActiveAt || null,
      accountStatus: s.accountStatus,
    }));

    return sendList(res, mapped, total, { page, pageSize });
  } catch (err) {
    return next(err);
  }
});

const CreateStudentSchema = z.object({
  name: z.string().trim().min(2).max(100),
  grade: z.coerce.number().int().min(3).max(12),
  birthdate: z.string().optional(),
  language: z.enum(["en", "bn"]).default("en"),
  schoolId: z.string().optional(),
  section: z.string().trim().optional(),
  division: z.string().trim().optional(),
  district: z.string().trim().optional(),
  upazila: z.string().trim().optional(),
  acquisitionSource: z.string().trim().default("school"),
  guardianInvite: z
    .object({
      contact: z.string().trim().min(3),
      relation: z.string().trim().default("parent"),
    })
    .optional(),
});

// POST /api/admin/students
studentsRouter.post("/", requirePermission("students.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parse = CreateStudentSchema.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Invalid student parameters", parse.error.flatten().fieldErrors));
    }
    const data = parse.data;

    let targetSchoolId = data.schoolId;
    if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
      targetSchoolId = ctx.scope.id;
    }

    const studentCode = await nextCode("STU");
    const tempPassword = `P@${crypto.randomBytes(6).toString("hex")}`;
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const linkCode = crypto.randomBytes(3).toString("hex").toUpperCase();

    const student = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: data.name,
          grade: data.grade,
          passwordHash,
          linkCode,
          role: "STUDENT",
          accountStatus: "active",
        },
      });

      const profile = await tx.studentProfile.create({
        data: {
          userId: user.id,
          code: studentCode,
          schoolId: targetSchoolId || null,
          section: data.section || null,
          division: data.division || null,
          district: data.district || null,
          upazila: data.upazila || null,
          acquisitionSource: data.acquisitionSource,
          effectiveAccess: "FREE",
          guardianStatus: data.guardianInvite ? "invited" : "none",
        },
      });

      if (targetSchoolId) {
        await tx.schoolMembership.create({
          data: {
            schoolId: targetSchoolId,
            userId: user.id,
            memberType: "STUDENT",
            status: "active",
            grade: data.grade,
            section: data.section || "",
            startDate: new Date(),
          },
        });
      }

      if (data.guardianInvite) {
        const rawToken = crypto.randomBytes(20).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        await tx.guardianInvite.create({
          data: {
            studentId: user.id,
            contact: data.guardianInvite.contact,
            relation: data.guardianInvite.relation,
            tokenHash,
            status: "sent",
            expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            sentById: ctx.user.id,
          },
        });
      }

      return { user, profile };
    });

    await emitAudit(req, {
      action: "student.create",
      entityType: "User",
      entityId: student.user.id,
      after: { code: studentCode, name: data.name, grade: data.grade, schoolId: targetSchoolId },
    });

    return sendOne(
      res,
      {
        id: student.user.id,
        code: student.profile.code,
        name: student.user.name,
        grade: student.user.grade,
        accountStatus: student.user.accountStatus,
      },
      { statusCode: 201 },
    );
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/students/:id
studentsRouter.get("/:id", requirePermission("students.view"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        studentProfile: {
          include: {
            school: true,
          },
        },
        memberships: {
          where: { status: "active" },
          include: { school: true },
        },
        guardedBy: {
          where: { status: "active" },
          include: { guardian: { select: { id: true, name: true, phone: true, email: true } } },
        },
      },
    });

    if (!user || user.role !== "STUDENT" || !user.studentProfile) {
      return next(notFound("Student not found"));
    }

    // Scope check: If SCHOOL scope and not in school -> 404 to avoid leaking existence
    if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
      if (user.studentProfile.schoolId !== ctx.scope.id) {
        return next(notFound("Student not found"));
      }
    }

    return sendOne(res, {
      id: user.id,
      code: user.studentProfile.code,
      name: user.name,
      grade: user.grade,
      email: user.email,
      phone: user.phone,
      accountStatus: user.accountStatus,
      statusReason: user.statusReason,
      createdAt: user.createdAt,
      profile: user.studentProfile,
      school: user.studentProfile.school,
      activeMemberships: user.memberships,
      guardians: user.guardedBy.map((g) => ({
        id: g.id,
        guardianId: g.guardianId,
        guardianName: g.guardian.name,
        guardianPhone: g.guardian.phone,
        relation: g.relation,
        isVerified: g.isVerified,
        createdAt: g.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/admin/students/:id
studentsRouter.patch("/:id", requirePermission("students.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({
      where: { id },
      include: { studentProfile: true },
    });
    if (!user || !user.studentProfile) return next(notFound("Student not found"));

    if (ctx.scope.type === "SCHOOL" && ctx.scope.id && user.studentProfile.schoolId !== ctx.scope.id) {
      return next(notFound("Student not found"));
    }

    const { name, grade, section, division, district, upazila } = req.body as {
      name?: string;
      grade?: number;
      section?: string;
      division?: string;
      district?: string;
      upazila?: string;
    };

    await prisma.$transaction(async (tx) => {
      if (name || grade !== undefined) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            ...(name ? { name } : {}),
            ...(grade !== undefined ? { grade } : {}),
          },
        });
      }

      await tx.studentProfile.update({
        where: { userId: user.id },
        data: {
          ...(section !== undefined ? { section } : {}),
          ...(division !== undefined ? { division } : {}),
          ...(district !== undefined ? { district } : {}),
          ...(upazila !== undefined ? { upazila } : {}),
        },
      });
    });

    await emitAudit(req, {
      action: "student.update",
      entityType: "User",
      entityId: user.id,
      after: { name, grade, section, district },
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/students/:id/suspend
studentsRouter.post("/:id/suspend", requirePermission("students.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { reason } = req.body as { reason?: string };
    if (!reason || reason.trim().length < 5) {
      return next(badRequest("A reason of at least 5 characters is required"));
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: { studentProfile: true },
    });
    if (!user || !user.studentProfile) return next(notFound("Student not found"));

    if (ctx.scope.type === "SCHOOL" && ctx.scope.id && user.studentProfile.schoolId !== ctx.scope.id) {
      return next(notFound("Student not found"));
    }

    const now = Date.now();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          accountStatus: "suspended",
          statusReason: reason.trim(),
          statusChangedAt: new Date(),
        },
      });

      // Revoke sessions
      await tx.appSetting.upsert({
        where: { key: revokedSettingKey(user.id) },
        create: { key: revokedSettingKey(user.id), value: String(now) },
        update: { value: String(now) },
      });
    });

    await emitAudit(req, {
      action: "student.suspend",
      entityType: "User",
      entityId: user.id,
      reason: reason.trim(),
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/students/:id/reactivate
studentsRouter.post("/:id/reactivate", requirePermission("students.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { reason } = req.body as { reason?: string };

    const user = await prisma.user.findUnique({
      where: { id },
      include: { studentProfile: true },
    });
    if (!user || !user.studentProfile) return next(notFound("Student not found"));

    if (ctx.scope.type === "SCHOOL" && ctx.scope.id && user.studentProfile.schoolId !== ctx.scope.id) {
      return next(notFound("Student not found"));
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        accountStatus: "active",
        statusReason: reason ? reason.trim() : null,
        statusChangedAt: new Date(),
      },
    });

    await emitAudit(req, {
      action: "student.reactivate",
      entityType: "User",
      entityId: user.id,
      reason: reason || "Admin reactivation",
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/students/:id/transfer
studentsRouter.post("/:id/transfer", requirePermission("schools.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { toSchoolId, grade, section, reason } = req.body as {
      toSchoolId: string;
      grade?: number;
      section?: string;
      reason?: string;
    };

    if (!toSchoolId) return next(badRequest("toSchoolId is required"));

    const [user, targetSchool] = await Promise.all([
      prisma.user.findUnique({ where: { id }, include: { studentProfile: true } }),
      prisma.school.findUnique({ where: { id: toSchoolId } }),
    ]);

    if (!user || !user.studentProfile) return next(notFound("Student not found"));
    if (!targetSchool || targetSchool.status !== "active") return next(badRequest("Target school not found or inactive"));

    const fromSchoolId = user.studentProfile.schoolId;

    await prisma.$transaction(async (tx) => {
      // Close existing active school memberships
      await tx.schoolMembership.updateMany({
        where: { userId: user.id, status: "active" },
        data: { status: "transferred" },
      });

      // Create new active membership
      await tx.schoolMembership.create({
        data: {
          schoolId: toSchoolId,
          userId: user.id,
          memberType: "STUDENT",
          status: "active",
          grade: grade ?? user.grade ?? 6,
          section: section ?? user.studentProfile?.section ?? "",
          startDate: new Date(),
        },
      });

      // Update student profile current school
      await tx.studentProfile.update({
        where: { userId: user.id },
        data: {
          schoolId: toSchoolId,
          ...(section !== undefined ? { section } : {}),
        },
      });

      if (grade !== undefined) {
        await tx.user.update({
          where: { id: user.id },
          data: { grade },
        });
      }
    });

    await emitAudit(req, {
      action: "student.transfer",
      entityType: "User",
      entityId: user.id,
      reason: reason || `Transferred from school ${fromSchoolId || "none"} to ${targetSchool.name}`,
      before: { schoolId: fromSchoolId },
      after: { schoolId: toSchoolId },
    });

    return sendOne(res, { ok: true, schoolId: toSchoolId, schoolName: targetSchool.name });
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/students/:id/sessions
studentsRouter.get("/:id/sessions", requirePermission("students.view_sessions"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const sessions = await prisma.learningSession.findMany({
      where: { userId: id },
      take: 50,
      orderBy: { startedAt: "desc" },
    });
    return sendList(res, sessions, sessions.length);
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/students/:id/guardians
studentsRouter.get("/:id/guardians", requirePermission("students.view_guardian"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const [links, invites] = await Promise.all([
      prisma.guardianLink.findMany({
        where: { studentId: id },
        include: { guardian: { select: { id: true, name: true, phone: true, email: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.guardianInvite.findMany({
        where: { studentId: id },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return sendOne(res, { links, invites });
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/students/:id/history
studentsRouter.get("/:id/history", requirePermission("students.view"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const history = await prisma.auditLog.findMany({
      where: { entityType: "User", entityId: id },
      take: 50,
      orderBy: { createdAt: "desc" },
    });
    return sendList(res, history, history.length);
  } catch (err) {
    return next(err);
  }
});
