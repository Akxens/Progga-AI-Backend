import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { forbidden, unauthorized } from "../../lib/errors";
import { adminForbidden, mfaRequired, workspaceInvalid } from "./errors";
import type { AdminContext } from "./context";
import type { ScopeType } from "./enums";

export const ADMIN_MFA_COOKIE = "progga_admin_mfa";

export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  // 1. Must be authenticated
  if (!req.user) {
    return next(unauthorized());
  }

  const userId = req.user.id;

  // 2. Fetch staff profile (must exist)
  const staffProfile = await prisma.staffProfile.findUnique({
    where: { userId },
  });

  if (!staffProfile) {
    return next(adminForbidden("admin_forbidden", "Staff profile not found"));
  }

  // 4. Resolve active workspace assignment
  const workspaceHeader = req.headers["x-workspace"];
  const assignmentId = typeof workspaceHeader === "string" && workspaceHeader.trim()
    ? workspaceHeader.trim()
    : staffProfile.lastAssignmentId;

  if (!assignmentId) {
    // If no assignment passed, check if staff has any active assignment
    const anyAssignment = await prisma.roleAssignment.findFirst({
      where: { userId, status: "active" },
      include: { role: true },
    });
    if (!anyAssignment || anyAssignment.role.status !== "active") {
      return next(workspaceInvalid("No active workspace assignment found"));
    }
    return attachContextAndNext(req, staffProfile, anyAssignment, next);
  }

  const assignment = await prisma.roleAssignment.findUnique({
    where: { id: assignmentId },
    include: { role: true },
  });

  if (
    !assignment ||
    assignment.userId !== userId ||
    assignment.status !== "active" ||
    assignment.role.status !== "active"
  ) {
    return next(workspaceInvalid());
  }

  const now = new Date();
  if (assignment.validFrom > now || (assignment.validTo && assignment.validTo < now)) {
    return next(workspaceInvalid("Workspace assignment has expired"));
  }

  return attachContextAndNext(req, staffProfile, assignment, next);
}

function attachContextAndNext(
  req: Request,
  staffProfile: any,
  roleAssignment: any,
  next: NextFunction,
) {
  const permissions = new Set<string>(roleAssignment.role.permissions || []);
  const scopeType = roleAssignment.scopeType as ScopeType;
  const scopeId = roleAssignment.scopeId || null;

  const ctx: AdminContext = {
    user: req.user!,
    staffProfile,
    roleAssignment,
    permissions,
    scope: {
      type: scopeType,
      id: scopeId,
    },
    legalEntityId: scopeType === "LEGAL_ENTITY" ? scopeId : null,
    schoolId: scopeType === "SCHOOL" ? scopeId : null,
    hasPermission: (code: string) => permissions.has(code),
    assert: (code: string) => {
      if (!permissions.has(code)) {
        throw adminForbidden("permission_denied", `Required permission: ${code}`, { required: [code] });
      }
    },
  };

  req.admin = ctx;
  next();
}
