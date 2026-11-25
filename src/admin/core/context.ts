import type { Request } from "express";
import type { Role, RoleAssignment, StaffProfile } from "@prisma/client";
import type { AuthUser } from "../../middleware/auth";
import type { ScopeType } from "./enums";
import { HttpError } from "../../lib/errors";

export interface AdminContext {
  user: AuthUser;
  staffProfile: StaffProfile;
  roleAssignment: RoleAssignment & { role: Role };
  permissions: Set<string>;
  scope: {
    type: ScopeType;
    id: string | null;
  };
  legalEntityId: string | null;
  schoolId: string | null;
  hasPermission: (code: string) => boolean;
  assert: (code: string) => void;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminContext;
    }
  }
}

export function getCtx(req: Request): AdminContext {
  if (!req.admin) {
    throw new HttpError(401, "Admin context not established", "unauthorized");
  }
  return req.admin;
}
