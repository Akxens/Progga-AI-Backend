import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, forbidden } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { emitAudit } from "../core/audit";
import { revokedSettingKey } from "../../middleware/auth";

export const systemUsersRouter = Router();

// GET /api/admin/system/users
systemUsersRouter.get("/", requirePermission("admin.users.view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    const where: Record<string, unknown> = {
      staffProfile: { isNot: null },
    };

    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
      ];
    }

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          staffProfile: true,
          roleAssignments: {
            where: { status: "active" },
            include: { role: true },
          },
        },
      }),
    ]);

    const mapped = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      accountStatus: u.accountStatus,
      createdAt: u.createdAt,
      staffProfile: u.staffProfile,
      activeAssignments: u.roleAssignments.map((ra) => ({
        id: ra.id,
        roleKey: ra.role.key,
        roleName: ra.role.name,
        scopeType: ra.scopeType,
        scopeId: ra.scopeId,
      })),
    }));

    return sendList(res, mapped, total, { page, pageSize });
  } catch (err) {
    return next(err);
  }
});

const InviteStaffSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email(),
  phone: z.string().trim().optional(),
  title: z.string().trim().default("Staff"),
  department: z.string().trim().default("Operations"),
  assignments: z
    .array(
      z.object({
        roleId: z.string().min(1),
        scopeType: z.enum(["GLOBAL", "LEGAL_ENTITY", "SCHOOL", "PROGRAMME", "PARTNER"]),
        scopeId: z.string().nullable().optional(),
        validTo: z.string().datetime().optional(),
      }),
    )
    .min(1, "At least one role assignment is required"),
});

// POST /api/admin/system/users
systemUsersRouter.post("/", requirePermission("admin.users.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parse = InviteStaffSchema.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Invalid staff invite parameters", parse.error.flatten().fieldErrors));
    }
    const data = parse.data;

    // Check if user already exists
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ email: data.email }, ...(data.phone ? [{ phone: data.phone }] : [])],
      },
    });

    if (existing) {
      return next(badRequest("A user with this email or phone already exists"));
    }

    // Generate random 12-char temporary password
    const tempPassword = `P@${crypto.randomBytes(6).toString("hex")}`;
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const linkCode = crypto.randomBytes(3).toString("hex").toUpperCase();

    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone || null,
          passwordHash,
          linkCode,
          role: "ADMIN",
          accountStatus: "active",
        },
      });

      await tx.staffProfile.create({
        data: {
          userId: newUser.id,
          title: data.title,
          department: data.department,
          mustChangePassword: true,
          invitedById: ctx.user.id,
          invitedAt: new Date(),
        },
      });

      for (const a of data.assignments) {
        await tx.roleAssignment.create({
          data: {
            userId: newUser.id,
            roleId: a.roleId,
            scopeType: a.scopeType,
            scopeId: a.scopeId || null,
            validTo: a.validTo ? new Date(a.validTo) : null,
            grantedById: ctx.user.id,
            reason: "Initial staff onboarding",
          },
        });
      }

      return newUser;
    });

    await emitAudit(req, {
      action: "staff.invite",
      entityType: "User",
      entityId: user.id,
      reason: `Invited ${data.name} (${data.email}) as ${data.title}`,
      after: { email: data.email, title: data.title, assignmentsCount: data.assignments.length },
    });

    return sendOne(
      res,
      {
        id: user.id,
        name: user.name,
        email: user.email,
        temporaryPassword: tempPassword,
      },
      { statusCode: 201 },
    );
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/system/users/:id
systemUsersRouter.get("/:id", requirePermission("admin.users.view"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        staffProfile: true,
        roleAssignments: {
          include: { role: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!user || !user.staffProfile) {
      return next(notFound("Staff user not found"));
    }

    return sendOne(res, {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      accountStatus: user.accountStatus,
      createdAt: user.createdAt,
      staffProfile: user.staffProfile,
      assignments: user.roleAssignments.map((ra) => ({
        id: ra.id,
        roleId: ra.roleId,
        roleKey: ra.role.key,
        roleName: ra.role.name,
        scopeType: ra.scopeType,
        scopeId: ra.scopeId,
        status: ra.status,
        validFrom: ra.validFrom,
        validTo: ra.validTo,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/admin/system/users/:id
systemUsersRouter.patch("/:id", requirePermission("admin.users.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { title, department } = req.body as { title?: string; department?: string };

    const staff = await prisma.staffProfile.findUnique({
      where: { userId: id },
    });
    if (!staff) return next(notFound("Staff user not found"));

    const updated = await prisma.staffProfile.update({
      where: { userId: id },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(department !== undefined ? { department } : {}),
      },
    });

    await emitAudit(req, {
      action: "staff.update",
      entityType: "StaffProfile",
      entityId: id,
      before: { title: staff.title, department: staff.department },
      after: { title: updated.title, department: updated.department },
    });

    return sendOne(res, updated);
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/system/users/:id/reset-mfa
systemUsersRouter.post("/:id/reset-mfa", requirePermission("admin.users.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const targetUserId = req.params.id as string;

    // BR-RBAC: Cannot reset own MFA via admin endpoint
    if (targetUserId === ctx.user.id) {
      return next(forbidden("Cannot reset MFA for your own account"));
    }

    const { reason } = req.body as { reason?: string };
    if (!reason || reason.trim().length < 5) {
      return next(badRequest("A reason of at least 5 characters is required"));
    }

    const staff = await prisma.staffProfile.findUnique({
      where: { userId: targetUserId },
    });
    if (!staff) return next(notFound("Staff user not found"));

    await prisma.staffProfile.update({
      where: { userId: targetUserId },
      data: {
        mfaSecretEnc: null,
        mfaEnrolledAt: null,
        recoveryCodeHashes: [],
      },
    });

    await emitAudit(req, {
      action: "staff.mfa_reset",
      entityType: "StaffProfile",
      entityId: targetUserId,
      reason: reason.trim(),
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/system/users/:id/suspend
systemUsersRouter.post("/:id/suspend", requirePermission("admin.users.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const targetUserId = req.params.id as string;

    if (targetUserId === ctx.user.id) {
      return next(forbidden("Cannot suspend your own account"));
    }

    const { reason } = req.body as { reason?: string };
    if (!reason || reason.trim().length < 5) {
      return next(badRequest("A reason of at least 5 characters is required"));
    }

    // Check if target is a SUPER_ADMIN and if it's the last active SUPER_ADMIN
    const targetSuperAdmin = await prisma.roleAssignment.findFirst({
      where: {
        userId: targetUserId,
        status: "active",
        role: { key: "SUPER_ADMIN" },
      },
    });

    if (targetSuperAdmin) {
      const activeSuperAdminCount = await prisma.roleAssignment.count({
        where: {
          status: "active",
          role: { key: "SUPER_ADMIN" },
          user: { accountStatus: "active" },
        },
      });

      if (activeSuperAdminCount <= 1) {
        return next(forbidden("Cannot suspend the only active Super Admin"));
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: targetUserId },
        data: {
          accountStatus: "suspended",
          statusReason: reason.trim(),
          statusChangedAt: new Date(),
        },
      });

      // Revoke sessions
      const now = Date.now();
      await tx.appSetting.upsert({
        where: { key: revokedSettingKey(targetUserId) },
        create: { key: revokedSettingKey(targetUserId), value: String(now) },
        update: { value: String(now) },
      });
    });

    await emitAudit(req, {
      action: "staff.suspend",
      entityType: "User",
      entityId: targetUserId,
      reason: reason.trim(),
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});
