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

export const teachersRouter = Router();

// GET /api/admin/teachers
teachersRouter.get("/", requirePermission("teachers.view"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    const where: Record<string, unknown> = {
      role: "TEACHER",
      teacherProfile: { isNot: null },
    };

    if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
      where.teacherProfile = {
        is: { primarySchoolId: ctx.scope.id },
      };
    } else if (typeof req.query.schoolId === "string") {
      where.teacherProfile = {
        is: { primarySchoolId: req.query.schoolId },
      };
    }

    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { teacherProfile: { is: { code: { contains: q, mode: "insensitive" } } } },
      ];
    }

    if (req.query.status) {
      where.teacherProfile = {
        ...(where.teacherProfile as object),
        is: {
          ...((where.teacherProfile as any)?.is || {}),
          status: String(req.query.status),
        },
      };
    }

    if (req.query.verificationStatus) {
      where.teacherProfile = {
        ...(where.teacherProfile as object),
        is: {
          ...((where.teacherProfile as any)?.is || {}),
          verificationStatus: String(req.query.verificationStatus),
        },
      };
    }

    if (req.query.district) {
      where.teacherProfile = {
        ...(where.teacherProfile as object),
        is: {
          ...((where.teacherProfile as any)?.is || {}),
          district: String(req.query.district),
        },
      };
    }

    const [total, teachers] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          teacherProfile: {
            include: {
              primarySchool: { select: { id: true, name: true, code: true } },
            },
          },
        },
      }),
    ]);

    const mapped = teachers.map((t) => ({
      id: t.id,
      code: t.teacherProfile?.code || t.id,
      name: t.name,
      email: t.email,
      phone: t.phone,
      school: t.teacherProfile?.primarySchool
        ? {
            id: t.teacherProfile.primarySchool.id,
            name: t.teacherProfile.primarySchool.name,
            code: t.teacherProfile.primarySchool.code,
          }
        : null,
      subjectIds: t.teacherProfile?.subjectIds || [],
      grades: t.teacherProfile?.grades || [],
      district: t.teacherProfile?.district,
      upazila: t.teacherProfile?.upazila,
      status: t.teacherProfile?.status || "active",
      verificationStatus: t.teacherProfile?.verificationStatus || "unverified",
      createdAt: t.createdAt,
      lastActiveAt: t.teacherProfile?.lastActiveAt,
    }));

    return sendList(res, mapped, total, { page, pageSize });
  } catch (err) {
    return next(err);
  }
});

const CreateTeacherSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().optional(),
  schoolId: z.string().optional(),
  subjectIds: z.array(z.string()).default([]),
  grades: z.array(z.number().int()).default([]),
  district: z.string().trim().optional(),
  upazila: z.string().trim().optional(),
});

// POST /api/admin/teachers
teachersRouter.post("/", requirePermission("teachers.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parse = CreateTeacherSchema.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Invalid teacher parameters", parse.error.flatten().fieldErrors));
    }
    const data = parse.data;

    let targetSchoolId = data.schoolId;
    if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
      targetSchoolId = ctx.scope.id;
    }

    const teacherCode = await nextCode("TCH");
    const tempPassword = `P@${crypto.randomBytes(6).toString("hex")}`;
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const linkCode = crypto.randomBytes(3).toString("hex").toUpperCase();

    const teacher = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: data.name,
          email: data.email || null,
          phone: data.phone || null,
          passwordHash,
          linkCode,
          role: "TEACHER",
          accountStatus: "active",
        },
      });

      const profile = await tx.teacherProfile.create({
        data: {
          userId: user.id,
          code: teacherCode,
          status: "active",
          verificationStatus: "unverified",
          primarySchoolId: targetSchoolId || null,
          subjectIds: data.subjectIds,
          grades: data.grades,
          district: data.district || null,
          upazila: data.upazila || null,
        },
      });

      if (targetSchoolId) {
        await tx.schoolMembership.create({
          data: {
            schoolId: targetSchoolId,
            userId: user.id,
            memberType: "TEACHER",
            startDate: new Date(),
            status: "active",
          },
        });
      }

      return { user, profile };
    });

    await emitAudit(req, {
      action: "teacher.create",
      entityType: "User",
      entityId: teacher.user.id,
      after: { code: teacherCode, name: data.name, schoolId: targetSchoolId },
    });

    return sendOne(
      res,
      {
        id: teacher.user.id,
        code: teacher.profile.code,
        name: teacher.user.name,
        verificationStatus: teacher.profile.verificationStatus,
      },
      { statusCode: 201 },
    );
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/teachers/:id
teachersRouter.get("/:id", requirePermission("teachers.view"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        teacherProfile: {
          include: {
            primarySchool: true,
            assignments: true,
          },
        },
        memberships: {
          where: { status: "active" },
          include: { school: true },
        },
      },
    });

    if (!user || user.role !== "TEACHER" || !user.teacherProfile) {
      return next(notFound("Teacher not found"));
    }

    if (ctx.scope.type === "SCHOOL" && ctx.scope.id && user.teacherProfile.primarySchoolId !== ctx.scope.id) {
      return next(notFound("Teacher not found"));
    }

    return sendOne(res, {
      id: user.id,
      code: user.teacherProfile.code,
      name: user.name,
      email: user.email,
      phone: user.phone,
      accountStatus: user.accountStatus,
      profile: user.teacherProfile,
      primarySchool: user.teacherProfile.primarySchool,
      activeMemberships: user.memberships,
      assignments: user.teacherProfile.assignments,
    });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/admin/teachers/:id
teachersRouter.patch("/:id", requirePermission("teachers.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({
      where: { id },
      include: { teacherProfile: true },
    });
    if (!user || !user.teacherProfile) return next(notFound("Teacher not found"));

    if (ctx.scope.type === "SCHOOL" && ctx.scope.id && user.teacherProfile.primarySchoolId !== ctx.scope.id) {
      return next(notFound("Teacher not found"));
    }

    const { name, email, phone, schoolId, subjectIds, grades, district, upazila } = req.body as {
      name?: string;
      email?: string;
      phone?: string;
      schoolId?: string;
      subjectIds?: string[];
      grades?: number[];
      district?: string;
      upazila?: string;
    };

    await prisma.$transaction(async (tx) => {
      if (name || email !== undefined || phone !== undefined) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            ...(name ? { name } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(phone !== undefined ? { phone } : {}),
          },
        });
      }

      await tx.teacherProfile.update({
        where: { userId: user.id },
        data: {
          ...(schoolId !== undefined ? { primarySchoolId: schoolId } : {}),
          ...(subjectIds ? { subjectIds } : {}),
          ...(grades ? { grades } : {}),
          ...(district !== undefined ? { district } : {}),
          ...(upazila !== undefined ? { upazila } : {}),
        },
      });
    });

    await emitAudit(req, {
      action: "teacher.update",
      entityType: "User",
      entityId: user.id,
      after: { name, schoolId, district },
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/teachers/:id/verify
teachersRouter.post("/:id/verify", requirePermission("teachers.verify"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { decision, reason } = req.body as { decision?: "verified" | "rejected"; reason?: string };

    if (!decision || !["verified", "rejected"].includes(decision)) {
      return next(badRequest("decision must be verified or rejected"));
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: { teacherProfile: true },
    });
    if (!user || !user.teacherProfile) return next(notFound("Teacher not found"));

    const updated = await prisma.teacherProfile.update({
      where: { userId: user.id },
      data: {
        verificationStatus: decision,
        verifiedAt: new Date(),
        verifiedById: ctx.user.id,
      },
    });

    await emitAudit(req, {
      action: `teacher.verify_${decision}`,
      entityType: "TeacherProfile",
      entityId: user.id,
      reason: reason || `Teacher credentials marked ${decision}`,
    });

    return sendOne(res, updated);
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/teachers/:id/suspend
teachersRouter.post("/:id/suspend", requirePermission("teachers.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { reason } = req.body as { reason?: string };
    if (!reason || reason.trim().length < 5) {
      return next(badRequest("A reason of at least 5 characters is required"));
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: { teacherProfile: true },
    });
    if (!user || !user.teacherProfile) return next(notFound("Teacher not found"));

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

      await tx.teacherProfile.update({
        where: { userId: user.id },
        data: { status: "suspended" },
      });

      // Revoke sessions
      await tx.appSetting.upsert({
        where: { key: revokedSettingKey(user.id) },
        create: { key: revokedSettingKey(user.id), value: String(now) },
        update: { value: String(now) },
      });
    });

    await emitAudit(req, {
      action: "teacher.suspend",
      entityType: "User",
      entityId: user.id,
      reason: reason.trim(),
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/teachers/:id/reactivate
teachersRouter.post("/:id/reactivate", requirePermission("teachers.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { reason } = req.body as { reason?: string };

    const user = await prisma.user.findUnique({
      where: { id },
      include: { teacherProfile: true },
    });
    if (!user || !user.teacherProfile) return next(notFound("Teacher not found"));

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          accountStatus: "active",
          statusReason: reason ? reason.trim() : null,
          statusChangedAt: new Date(),
        },
      });

      await tx.teacherProfile.update({
        where: { userId: user.id },
        data: { status: "active" },
      });
    });

    await emitAudit(req, {
      action: "teacher.reactivate",
      entityType: "User",
      entityId: user.id,
      reason: reason || "Admin reactivation",
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});
