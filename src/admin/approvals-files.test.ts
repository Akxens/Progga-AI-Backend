import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../lib/prisma";
import {
  createApproval,
  decideApproval,
  cancelApproval,
  registerApprovalHandler,
} from "./core/approvals";
import { issueDownloadToken, readFileByToken } from "./core/files";
import type { AdminContext } from "./core/context";

describe("Approvals & Files Business Rules", () => {
  const ctx: AdminContext = {
    user: { id: "user-approver", role: "ADMIN" } as any,
    staffProfile: { id: "staff-1", title: "Approver", department: "Finance", mustChangePassword: false } as any,
    roleAssignment: {
      id: "ra-1",
      role: { key: "FINANCE_APPROVER", name: "Finance Approver" },
      scopeType: "GLOBAL",
    } as any,
    scope: { type: "GLOBAL", id: null },
    legalEntityId: null,
    schoolId: null,
    permissions: new Set(["finance.plans.approve"]),
    hasPermission: (c) => c === "finance.plans.approve",
  };

  it("BR-APR-01 & BR-APR-02: executes registered handler on approval decision", async () => {
    let approveCalled = false;
    registerApprovalHandler("plan_version", {
      onApprove: async (_tx, app) => {
        approveCalled = true;
      },
    });

    const mockApproval = {
      id: "appr-1",
      code: "APR-000001",
      type: "plan_version",
      targetEntity: "Plan",
      targetId: "plan-1",
      requestedById: "user-maker", // Different from user-approver
      requiredPermission: "finance.plans.approve",
      status: "pending",
      version: 1,
    };

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const mockTx = {
        approval: {
          findUnique: vi.fn().mockResolvedValue(mockApproval),
          update: vi.fn().mockResolvedValue({ ...mockApproval, status: "approved", version: 2 }),
        },
        auditLog: {
          create: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
      };
      return cb(mockTx);
    });

    const res = await decideApproval(ctx, "appr-1", "approved", "Price looks good");
    expect(res.status).toBe("approved");
    expect(approveCalled).toBe(true);
  });

  it("BR-APR-05: throws version_conflict when record has been updated by someone else", async () => {
    const mockApproval = {
      id: "appr-1",
      code: "APR-000001",
      type: "plan_version",
      targetEntity: "Plan",
      targetId: "plan-1",
      requestedById: "user-maker",
      requiredPermission: "finance.plans.approve",
      status: "pending",
      version: 2, // version in DB is 2
    };

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const mockTx = {
        approval: {
          findUnique: vi.fn().mockResolvedValue(mockApproval),
        },
      };
      return cb(mockTx);
    });

    // Client passes expectedVersion = 1
    await expect(
      decideApproval(ctx, "appr-1", "approved", "Looks good", 1),
    ).rejects.toMatchObject({
      status: 409,
      code: "version_conflict",
    });
  });

  it("BR-APR-06: allows maker or super admin to cancel pending approval", async () => {
    const makerCtx: AdminContext = {
      ...ctx,
      user: { id: "user-maker", role: "ADMIN" } as any,
    };

    const mockApproval = {
      id: "appr-2",
      code: "APR-000002",
      type: "plan_version",
      targetEntity: "Plan",
      targetId: "plan-1",
      requestedById: "user-maker",
      status: "pending",
      version: 1,
    };

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const mockTx = {
        approval: {
          findUnique: vi.fn().mockResolvedValue(mockApproval),
          update: vi.fn().mockResolvedValue({ ...mockApproval, status: "cancelled", version: 2 }),
        },
        auditLog: {
          create: vi.fn().mockResolvedValue({ id: "audit-2" }),
        },
      };
      return cb(mockTx);
    });

    const res = await cancelApproval(makerCtx, "appr-2", "No longer needed");
    expect(res.status).toBe("cancelled");
  });

  it("Files: download token validation and expiration (05 §2)", async () => {
    const fileId = "file-1";
    const issuedToUserId = "user-1";

    vi.spyOn(prisma.downloadToken, "create").mockResolvedValueOnce({
      id: "dt-1",
      fileId,
      issuedToUserId,
    } as any);

    const { token } = await issueDownloadToken(fileId, issuedToUserId, 24);
    expect(token).toBeDefined();

    // Valid download
    vi.spyOn(prisma.downloadToken, "findUnique").mockResolvedValueOnce({
      id: "dt-1",
      fileId,
      issuedToUserId,
      expiresAt: new Date(Date.now() + 3600000),
      file: { id: fileId, fileName: "report.pdf", mime: "application/pdf", data: Buffer.from("pdf-data") },
    } as any);
    vi.spyOn(prisma.downloadToken, "update").mockResolvedValueOnce({} as any);

    const file = await readFileByToken(token, issuedToUserId);
    expect(file.id).toBe(fileId);

    // Expired download token
    vi.spyOn(prisma.downloadToken, "findUnique").mockResolvedValueOnce({
      id: "dt-1",
      fileId,
      issuedToUserId,
      expiresAt: new Date(Date.now() - 3600000), // Expired 1 hour ago
      file: { id: fileId },
    } as any);

    await expect(readFileByToken(token, issuedToUserId)).rejects.toMatchObject({
      status: 410,
      code: "expired",
    });

    // Unauthorized user
    vi.spyOn(prisma.downloadToken, "findUnique").mockResolvedValueOnce({
      id: "dt-1",
      fileId,
      issuedToUserId,
      expiresAt: new Date(Date.now() + 3600000),
      file: { id: fileId },
    } as any);

    await expect(readFileByToken(token, "other-user")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });
});
