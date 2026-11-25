import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, forbidden } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { nextCode } from "../core/codes";
import { emitAudit } from "../core/audit";

export const schoolsRouter = Router();

// GET /api/admin/schools
schoolsRouter.get("/", requirePermission("schools.view"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    const where: Record<string, unknown> = {};

    // Scope check: If SCHOOL scope, restrict to own school
    if (ctx.scope.type === "SCHOOL" && ctx.scope.id) {
      where.id = ctx.scope.id;
    }

    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
        { eiin: { contains: q, mode: "insensitive" } },
        { district: { contains: q, mode: "insensitive" } },
      ];
    }

    if (req.query.type) where.type = String(req.query.type);
    if (req.query.division) where.division = String(req.query.division);
    if (req.query.district) where.district = String(req.query.district);
    if (req.query.upazila) where.upazila = String(req.query.upazila);
    if (req.query.onboardingStage) where.onboardingStage = String(req.query.onboardingStage);
    if (req.query.status) where.status = String(req.query.status);

    const [total, schools] = await Promise.all([
      prisma.school.count({ where }),
      prisma.school.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: {
              students: true,
              teachers: true,
            },
          },
        },
      }),
    ]);

    const mapped = schools.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      eiin: s.eiin,
      type: s.type,
      level: s.level,
      division: s.division,
      district: s.district,
      upazila: s.upazila,
      onboardingStage: s.onboardingStage,
      status: s.status,
      activeStudents: s._count.students,
      activeTeachers: s._count.teachers,
      createdAt: s.createdAt,
    }));

    return sendList(res, mapped, total, { page, pageSize });
  } catch (err) {
    return next(err);
  }
});

const CreateSchoolSchema = z.object({
  name: z.string().trim().min(3).max(150),
  eiin: z.string().trim().default(""),
  type: z.enum(["government", "non_government"]).default("government"),
  level: z.enum(["primary", "secondary", "higher_secondary", "combined"]).default("secondary"),
  division: z.string().trim().default(""),
  district: z.string().trim().default(""),
  upazila: z.string().trim().default(""),
  contactPhone: z.string().trim().optional(),
  contactEmail: z.string().trim().optional(),
  address: z.string().trim().optional(),
});

// POST /api/admin/schools
schoolsRouter.post("/", requirePermission("schools.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parse = CreateSchoolSchema.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Invalid school parameters", parse.error.flatten().fieldErrors));
    }
    const data = parse.data;

    // Check duplicate by EIIN if provided
    if (data.eiin) {
      const existingEiin = await prisma.school.findFirst({
        where: { eiin: data.eiin },
      });
      if (existingEiin) {
        return next(badRequest(`School with EIIN ${data.eiin} already exists`, { existingId: existingEiin.id }));
      }
    }

    const schoolCode = await nextCode("SCH");
    const nameKey = data.name.toLowerCase().trim();

    const school = await prisma.school.create({
      data: {
        code: schoolCode,
        name: data.name,
        nameKey,
        eiin: data.eiin,
        type: data.type,
        level: data.level,
        division: data.division,
        district: data.district,
        upazila: data.upazila,
        onboardingStage: "lead",
        status: "active",
      },
    });

    await emitAudit(req, {
      action: "school.create",
      entityType: "School",
      entityId: school.id,
      after: { code: school.code, name: school.name, district: school.district },
    });

    return sendOne(res, school, { statusCode: 201 });
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/schools/:id
schoolsRouter.get("/:id", requirePermission("schools.view"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    if (ctx.scope.type === "SCHOOL" && ctx.scope.id && ctx.scope.id !== id) {
      return next(notFound("School not found"));
    }

    const school = await prisma.school.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            students: true,
            teachers: true,
            memberships: { where: { status: "active" } },
          },
        },
      },
    });

    if (!school) return next(notFound("School not found"));

    return sendOne(res, {
      ...school,
      activeStudents: school._count.students,
      activeTeachers: school._count.teachers,
      activeMembersCount: school._count.memberships,
    });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/admin/schools/:id
schoolsRouter.patch("/:id", requirePermission("schools.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const school = await prisma.school.findUnique({ where: { id } });
    if (!school) return next(notFound("School not found"));

    const { name, eiin, type, level, division, district, upazila } = req.body as {
      name?: string;
      eiin?: string;
      type?: string;
      level?: string;
      division?: string;
      district?: string;
      upazila?: string;
    };

    const updated = await prisma.school.update({
      where: { id },
      data: {
        ...(name ? { name, nameKey: name.toLowerCase().trim() } : {}),
        ...(eiin !== undefined ? { eiin } : {}),
        ...(type ? { type } : {}),
        ...(level ? { level } : {}),
        ...(division !== undefined ? { division } : {}),
        ...(district !== undefined ? { district } : {}),
        ...(upazila !== undefined ? { upazila } : {}),
      },
    });

    await emitAudit(req, {
      action: "school.update",
      entityType: "School",
      entityId: school.id,
      before: { name: school.name, district: school.district },
      after: { name: updated.name, district: updated.district },
    });

    return sendOne(res, updated);
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/schools/:id/stage
schoolsRouter.post("/:id/stage", requirePermission("schools.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { stage, reason } = req.body as { stage?: string; reason?: string };

    const validStages = ["lead", "contact_established", "agreement_signed", "onboarded", "activated"];
    if (!stage || !validStages.includes(stage)) {
      return next(badRequest("Invalid stage. Allowed: " + validStages.join(", ")));
    }

    const school = await prisma.school.findUnique({ where: { id } });
    if (!school) return next(notFound("School not found"));

    const updated = await prisma.school.update({
      where: { id },
      data: { onboardingStage: stage },
    });

    await emitAudit(req, {
      action: "school.stage_transition",
      entityType: "School",
      entityId: school.id,
      reason: reason || `Stage moved to ${stage}`,
      before: { stage: school.onboardingStage },
      after: { stage },
    });

    return sendOne(res, updated);
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/schools/:id/archive
schoolsRouter.post("/:id/archive", requirePermission("schools.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { reason } = req.body as { reason?: string };
    if (!reason || reason.trim().length < 5) {
      return next(badRequest("A reason of at least 5 characters is required"));
    }

    const school = await prisma.school.findUnique({ where: { id } });
    if (!school) return next(notFound("School not found"));

    const updated = await prisma.school.update({
      where: { id },
      data: { status: "archived" },
    });

    await emitAudit(req, {
      action: "school.archive",
      entityType: "School",
      entityId: school.id,
      reason: reason.trim(),
    });

    return sendOne(res, updated);
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/schools/:id/members
schoolsRouter.get("/:id/members", requirePermission("schools.view"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const memberType = typeof req.query.memberType === "string" ? req.query.memberType : undefined;

    const where: Record<string, unknown> = {
      schoolId: id,
      status: "active",
    };
    if (memberType) where.memberType = memberType;

    const [total, members] = await Promise.all([
      prisma.schoolMembership.count({ where }),
      prisma.schoolMembership.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: {
            select: { id: true, name: true, role: true, email: true, phone: true, studentProfile: { select: { code: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const mapped = members.map((m) => ({
      id: m.id,
      userId: m.userId,
      userName: m.user.name,
      userRole: m.user.role,
      studentCode: m.user.studentProfile?.code,
      memberType: m.memberType,
      grade: m.grade,
      section: m.section,
      joinedAt: m.createdAt,
    }));

    return sendList(res, mapped, total, { page, pageSize });
  } catch (err) {
    return next(err);
  }
});
