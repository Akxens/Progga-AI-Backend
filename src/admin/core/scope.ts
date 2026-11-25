import type { Prisma } from "@prisma/client";
import type { AdminContext } from "./context";
import { outOfScope } from "./errors";

export function buildStudentScopeFilter(ctx: AdminContext): Prisma.UserWhereInput {
  const { type, id } = ctx.scope;

  if (type === "GLOBAL" || type === "LEGAL_ENTITY") {
    return { role: "STUDENT" };
  }

  if (type === "SCHOOL") {
    if (!id) throw outOfScope("School ID missing in scope");
    return {
      role: "STUDENT",
      studentProfile: {
        schoolId: id,
      },
    };
  }

  if (type === "PROGRAMME") {
    if (!id) throw outOfScope("Programme ID missing in scope");
    return {
      role: "STUDENT",
      studentProfile: {
        school: {
          id: { in: [] },
        },
      },
    };
  }

  // PARTNER scope has no direct student access
  throw outOfScope("Partner scope cannot query student profiles directly");
}

export function buildTeacherScopeFilter(ctx: AdminContext): Prisma.UserWhereInput {
  const { type, id } = ctx.scope;

  if (type === "GLOBAL" || type === "LEGAL_ENTITY") {
    return { role: "TEACHER" };
  }

  if (type === "SCHOOL") {
    if (!id) throw outOfScope("School ID missing in scope");
    return {
      role: "TEACHER",
      memberships: {
        some: {
          schoolId: id,
          memberType: "TEACHER",
          status: "active",
        },
      },
    };
  }

  throw outOfScope("Current workspace scope cannot query teachers");
}

export function buildSchoolScopeFilter(ctx: AdminContext): Prisma.SchoolWhereInput {
  const { type, id } = ctx.scope;

  if (type === "GLOBAL" || type === "LEGAL_ENTITY") {
    return {};
  }

  if (type === "SCHOOL") {
    if (!id) throw outOfScope("School ID missing in scope");
    return { id };
  }

  if (type === "PROGRAMME") {
    if (!id) throw outOfScope("Programme ID missing in scope");
    return {
      id: { in: [] },
    };
  }

  return {};
}

export function buildFinanceScopeFilter(ctx: AdminContext): { legalEntityId?: string } {
  const { type, id } = ctx.scope;

  if (type === "GLOBAL") {
    return {};
  }

  if (type === "LEGAL_ENTITY") {
    if (!id) throw outOfScope("Legal Entity ID missing in scope");
    return { legalEntityId: id };
  }

  throw outOfScope("Financial records require GLOBAL or LEGAL_ENTITY workspace scope");
}
