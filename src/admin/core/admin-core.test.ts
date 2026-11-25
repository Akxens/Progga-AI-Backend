import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { parseListQuery } from "./list-query";
import { maskPhone, maskEmail, maskName } from "./mask";
import { toMoneyString, formatBdt } from "./money";
import { toCsv, escapeCsvCell } from "./csv";
import { requirePermission } from "./permissions";
import { requireAdmin, ADMIN_MFA_COOKIE } from "./require-admin";
import { createApproval, decideApproval, registerApprovalHandler } from "./approvals";
import { withIdempotency } from "./idempotency";
import type { AdminContext } from "./context";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";

describe("Admin Core: parseListQuery", () => {
  const spec = {
    allowedSortFields: ["name", "createdAt", "status"] as const,
    defaultSortField: "createdAt" as const,
    defaultSortOrder: "desc" as const,
  };

  it("applies defaults for empty query", () => {
    const req = { query: {} } as unknown as Request;
    const result = parseListQuery(req, spec);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
    expect(result.sortBy).toBe("createdAt");
    expect(result.sortOrder).toBe("desc");
    expect(result.skip).toBe(0);
    expect(result.take).toBe(25);
  });

  it("validates allowed pageSize (10, 25, 50, 100) and rejects other values", () => {
    const req1 = { query: { page: "2", pageSize: "50" } } as unknown as Request;
    const result1 = parseListQuery(req1, spec);
    expect(result1.page).toBe(2);
    expect(result1.pageSize).toBe(50);
    expect(result1.skip).toBe(50);
    expect(result1.take).toBe(50);

    const invalidReq = { query: { pageSize: "500" } } as unknown as Request;
    expect(() => parseListQuery(invalidReq, spec)).toThrowError(/pageSize must be one of/);
  });

  it("validates sort field against whitelist", () => {
    const req = { query: { sortBy: "invalidField", sortOrder: "asc" } } as unknown as Request;
    const result = parseListQuery(req, spec);
    expect(result.sortBy).toBe("createdAt"); // falls back to default
    expect(result.sortOrder).toBe("asc");
  });

  it("supports sort='-name' shorthand", () => {
    const req = { query: { sort: "-name" } } as unknown as Request;
    const result = parseListQuery(req, spec);
    expect(result.sortBy).toBe("name");
    expect(result.sortOrder).toBe("desc");
  });

  it("parses filters, search and date range", () => {
    const req = {
      query: {
        status: "active",
        search: "rahim",
        from: "2026-01-01",
        to: "2026-01-31",
      },
    } as unknown as Request;
    const result = parseListQuery(req, spec);
    expect(result.filters.status).toBe("active");
    expect(result.search).toBe("rahim");
    expect(result.from).toBe("2026-01-01");
    expect(result.to).toBe("2026-01-31");
  });
});

describe("Admin Core: Masking helpers", () => {
  it("masks phone numbers correctly per 03 A-17", () => {
    expect(maskPhone("+8801712345678")).toBe("+8801*******78");
    expect(maskPhone("01712345678")).toBe("01712****78");
    expect(maskPhone(null)).toBe("");
  });

  it("masks email addresses correctly per 03 A-17", () => {
    expect(maskEmail("student@example.com")).toBe("s***@e***.com");
    expect(maskEmail(null)).toBe("");
  });

  it("masks names correctly per 03 A-17", () => {
    expect(maskName("Rahim Uddin")).toBe("Rahim U.");
    expect(maskName("Rahim")).toBe("Rahim");
    expect(maskName(null)).toBe("");
  });
});

describe("Admin Core: Money formatting", () => {
  it("formats money string and BDT currency", () => {
    expect(toMoneyString(1500)).toBe("1500.00");
    expect(toMoneyString(1500.5)).toBe("1500.50");
    expect(formatBdt(1500)).toContain("1,500.00");
  });
});

describe("Admin Core: CSV serializer", () => {
  it("escapes cells properly and prevents CSV formula injection", () => {
    expect(escapeCsvCell("Hello, World")).toBe('"Hello, World"');
    expect(escapeCsvCell('He said "Hi"')).toBe('"He said ""Hi"""');
    expect(escapeCsvCell("=1+1")).toBe("'=1+1");
    expect(escapeCsvCell("+88017")).toBe("'+88017");
  });

  it("converts objects to CSV string with header", () => {
    const headers = ["id", "name", "score"];
    const rows = [
      ["1", "Alice", 95],
      ["2", "Bob, Jr.", 80],
    ];
    const csv = toCsv(headers, rows);
    expect(csv).toContain("id,name,score");
    expect(csv).toContain("1,Alice,95");
    expect(csv).toContain('2,"Bob, Jr.",80');
  });
});

describe("Admin Core: requirePermission", () => {
  it("passes when context has at least one requested permission", () => {
    const middleware = requirePermission("students.view", "students.manage");
    const req = {
      admin: {
        permissions: new Set(["students.view"]),
        hasPermission: (code: string) => code === "students.view",
      },
    } as unknown as Request;
    let nextCalled = false;
    let errPassed: any;
    const next = (err?: any) => {
      if (err) errPassed = err;
      else nextCalled = true;
    };
    middleware(req, {} as Response, next);
    expect(nextCalled).toBe(true);
    expect(errPassed).toBeUndefined();
  });

  it("calls next with 403 when context lacks requested permissions", () => {
    const middleware = requirePermission("students.manage");
    const req = {
      admin: {
        permissions: new Set(["students.view"]),
        hasPermission: (code: string) => code === "students.view",
      },
    } as unknown as Request;
    let errPassed: any;
    const next = (err?: any) => {
      errPassed = err;
    };
    middleware(req, {} as Response, next);
    expect(errPassed).toBeDefined();
    expect(errPassed.status).toBe(403);
    expect(errPassed.code).toBe("permission_denied");
  });
});

describe("Admin Core: requireAdmin middleware", () => {
  it("returns 401 mfa_required when progga_admin_mfa cookie is missing", async () => {
    const req = {
      user: { id: "user-1", role: "ADMIN" },
      cookies: {},
    } as unknown as Request;
    const res = {} as Response;
    let errPassed: any;
    const next = (err?: any) => {
      errPassed = err;
    };

    await requireAdmin(req, res, next);
    expect(errPassed).toBeDefined();
    expect(errPassed.status).toBe(401);
    expect(errPassed.code).toBe("mfa_required");
  });

  it("returns 403 admin_forbidden when no StaffProfile exists", async () => {
    const token = jwt.sign({ sub: "user-1", purpose: "admin_mfa" }, env.JWT_SECRET);
    const req = {
      user: { id: "user-1", role: "ADMIN" },
      cookies: { [ADMIN_MFA_COOKIE]: token },
      headers: {},
    } as unknown as Request;
    const res = {} as Response;
    let errPassed: any;
    const next = (err?: any) => {
      errPassed = err;
    };

    vi.spyOn(prisma.staffProfile, "findUnique").mockResolvedValueOnce(null);

    await requireAdmin(req, res, next);
    expect(errPassed).toBeDefined();
    expect(errPassed.status).toBe(403);
    expect(errPassed.code).toBe("admin_forbidden");
  });
});

describe("Admin Core: Approvals", () => {
  it("prevents self-approval (BR-APR-03)", async () => {
    const ctx: AdminContext = {
      user: { id: "user-1", role: "ADMIN" } as any,
      staffProfile: { id: "staff-1", title: "Admin", department: "IT", mustChangePassword: false } as any,
      roleAssignment: {
        id: "ra-1",
        role: { key: "SUPER_ADMIN", name: "Super Admin" },
        scopeType: "GLOBAL",
      } as any,
      scope: { type: "GLOBAL", id: null },
      legalEntityId: null,
      schoolId: null,
      permissions: new Set(["finance.plans.approve"]),
      hasPermission: (c) => c === "finance.plans.approve",
    };

    const mockApproval = {
      id: "appr-1",
      code: "APR-000001",
      type: "plan_version",
      targetEntity: "Plan",
      targetId: "plan-1",
      requestedById: "user-1", // Same as ctx.user.id!
      status: "pending",
      requiredPermission: "finance.plans.approve",
      version: 1,
    };

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const mockTx = {
        approval: {
          findUnique: vi.fn().mockResolvedValue(mockApproval),
        },
      };
      return cb(mockTx);
    });

    await expect(
      decideApproval(ctx, "appr-1", "approved", "Approved test"),
    ).rejects.toMatchObject({
      status: 403,
      code: "self_approval",
    });
  });
});
