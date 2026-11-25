import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound, forbidden } from "../../lib/errors";
import { getCtx } from "../core/context";
import { requirePermission, PERMISSIONS } from "../core/permissions";
import { sendList, sendOne } from "../core/respond";
import { emitAudit } from "../core/audit";

export const systemRolesRouter = Router();

// GET /api/admin/system/permissions
systemRolesRouter.get("/permissions", requirePermission("admin.roles.manage"), (_req, res) => {
  const catalog = Object.entries(PERMISSIONS).map(([code, description]) => ({
    code,
    description,
    group: code.split(".")[0],
  }));
  return sendOne(res, catalog);
});

// GET /api/admin/system/roles
systemRolesRouter.get("/roles", requirePermission("admin.roles.manage"), async (_req, res, next) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      include: {
        _count: {
          select: { assignments: { where: { status: "active" } } },
        },
      },
    });

    const mapped = roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      allowedScopes: r.allowedScopes,
      isSystem: r.isSystem,
      status: r.status,
      activeStaffCount: r._count.assignments,
    }));

    return sendList(res, mapped, mapped.length);
  } catch (err) {
    return next(err);
  }
});

// GET /api/admin/system/roles/:id
systemRolesRouter.get("/roles/:id", requirePermission("admin.roles.manage"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const role = await prisma.role.findUnique({
      where: { id },
      include: {
        assignments: {
          where: { status: "active" },
          include: { user: true },
        },
      },
    });
    if (!role) return next(notFound("Role not found"));

    return sendOne(res, {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      permissions: role.permissions,
      allowedScopes: role.allowedScopes,
      isSystem: role.isSystem,
      status: role.status,
      assignments: role.assignments.map((a) => ({
        id: a.id,
        userId: a.userId,
        userName: a.user.name,
        userEmail: a.user.email,
        scopeType: a.scopeType,
        scopeId: a.scopeId,
        validTo: a.validTo,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

const CreateRoleSchema = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]+$/, "Role key must be uppercase alphanumeric with underscores")
    .min(3)
    .max(50),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().default(""),
  permissions: z.array(z.string()).min(1, "At least one permission is required"),
  allowedScopes: z
    .array(z.enum(["GLOBAL", "LEGAL_ENTITY", "SCHOOL", "PROGRAMME", "PARTNER"]))
    .default(["GLOBAL"]),
});

// POST /api/admin/system/roles
systemRolesRouter.post("/roles", requirePermission("admin.roles.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parse = CreateRoleSchema.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Invalid role configuration", parse.error.flatten().fieldErrors));
    }
    const data = parse.data;

    const existing = await prisma.role.findUnique({ where: { key: data.key } });
    if (existing) {
      return next(badRequest(`Role with key ${data.key} already exists`, "conflict"));
    }

    const role = await prisma.role.create({
      data: {
        key: data.key,
        name: data.name,
        description: data.description,
        permissions: data.permissions,
        allowedScopes: data.allowedScopes,
        isSystem: false,
        status: "active",
      },
    });

    await emitAudit(req, {
      action: "role.create",
      entityType: "Role",
      entityId: role.id,
      after: { key: role.key, name: role.name, permissionsCount: role.permissions.length },
    });

    return sendOne(res, role, { statusCode: 201 });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/admin/system/roles/:id
systemRolesRouter.patch("/roles/:id", requirePermission("admin.roles.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) return next(notFound("Role not found"));

    if (role.isSystem) {
      return next(forbidden("System roles cannot be modified"));
    }

    const { name, description, permissions, allowedScopes } = req.body as {
      name?: string;
      description?: string;
      permissions?: string[];
      allowedScopes?: string[];
    };

    const updated = await prisma.role.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(permissions ? { permissions } : {}),
        ...(allowedScopes ? { allowedScopes } : {}),
      },
    });

    await emitAudit(req, {
      action: "role.update",
      entityType: "Role",
      entityId: role.id,
      before: { name: role.name, permissions: role.permissions },
      after: { name: updated.name, permissions: updated.permissions },
    });

    return sendOne(res, updated);
  } catch (err) {
    return next(err);
  }
});

const RoleAssignmentSchema = z.object({
  userId: z.string().min(1),
  roleId: z.string().min(1),
  scopeType: z.enum(["GLOBAL", "LEGAL_ENTITY", "SCHOOL", "PROGRAMME", "PARTNER"]),
  scopeId: z.string().nullable().optional(),
  validTo: z.string().datetime().optional(),
  reason: z.string().trim().default("Staff operational assignment"),
});

// POST /api/admin/system/role-assignments
systemRolesRouter.post("/role-assignments", requirePermission("admin.roles.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const parse = RoleAssignmentSchema.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Invalid role assignment parameters", parse.error.flatten().fieldErrors));
    }
    const data = parse.data;

    const [user, role] = await Promise.all([
      prisma.user.findUnique({ where: { id: data.userId } }),
      prisma.role.findUnique({ where: { id: data.roleId } }),
    ]);

    if (!user) return next(notFound("User not found"));
    if (!role || role.status !== "active") return next(badRequest("Role is inactive or invalid"));

    // Check scope allowed
    if (!role.allowedScopes.includes(data.scopeType)) {
      return next(badRequest(`Scope ${data.scopeType} is not allowed for role ${role.name}`));
    }

    const scopeIdValue = data.scopeId || null;
    const existingAssignment = await prisma.roleAssignment.findFirst({
      where: {
        userId: data.userId,
        roleId: data.roleId,
        scopeType: data.scopeType,
        scopeId: scopeIdValue,
      },
    });

    let assignment;
    if (existingAssignment) {
      assignment = await prisma.roleAssignment.update({
        where: { id: existingAssignment.id },
        data: {
          status: "active",
          validTo: data.validTo ? new Date(data.validTo) : null,
          grantedById: ctx.user.id,
          reason: data.reason,
        },
      });
    } else {
      assignment = await prisma.roleAssignment.create({
        data: {
          userId: data.userId,
          roleId: data.roleId,
          scopeType: data.scopeType,
          scopeId: scopeIdValue,
          validTo: data.validTo ? new Date(data.validTo) : null,
          grantedById: ctx.user.id,
          reason: data.reason,
          status: "active",
        },
      });
    }

    await emitAudit(req, {
      action: "role_assignment.grant",
      entityType: "RoleAssignment",
      entityId: assignment.id,
      reason: data.reason,
      after: { userId: data.userId, roleKey: role.key, scopeType: data.scopeType, scopeId: data.scopeId },
    });

    return sendOne(res, assignment, { statusCode: 201 });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/system/role-assignments/:id/revoke
systemRolesRouter.post("/role-assignments/:id/revoke", requirePermission("admin.roles.manage"), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = req.params.id as string;
    const { reason } = req.body as { reason?: string };
    if (!reason || reason.trim().length < 5) {
      return next(badRequest("A reason of at least 5 characters is required"));
    }

    const assignment = await prisma.roleAssignment.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!assignment) return next(notFound("Role assignment not found"));

    // Guard: Prevent revoking the only active Super Admin
    if (assignment.role.key === "SUPER_ADMIN" && assignment.status === "active") {
      const activeSuperAdminCount = await prisma.roleAssignment.count({
        where: {
          status: "active",
          role: { key: "SUPER_ADMIN" },
          user: { accountStatus: "active" },
        },
      });

      if (activeSuperAdminCount <= 1) {
        return next(forbidden("Cannot revoke the only active Super Admin assignment"));
      }
    }

    const updated = await prisma.roleAssignment.update({
      where: { id },
      data: {
        status: "revoked",
        revokedAt: new Date(),
        revokedById: ctx.user.id,
        reason: reason.trim(),
      },
    });

    await emitAudit(req, {
      action: "role_assignment.revoke",
      entityType: "RoleAssignment",
      entityId: assignment.id,
      reason: reason.trim(),
      before: { status: "active" },
      after: { status: "revoked" },
    });

    return sendOne(res, updated);
  } catch (err) {
    return next(err);
  }
});
