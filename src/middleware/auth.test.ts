import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  revokedAt: null as string | null,
  activeLink: true,
  linkStatus: "active" as string,
  accountStatus: "active" as string,
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async () => (store.revokedAt ? { key: "auth.revoked:u1", value: store.revokedAt } : null)),
    },
    guardianLink: {
      findUnique: vi.fn(async () => (store.activeLink ? { guardianId: "g1", studentId: "s1", status: store.linkStatus } : null)),
    },
    user: {
      findUnique: vi.fn(async () => ({
        id: "u1",
        accountStatus: store.accountStatus,
        lastSeenAt: new Date(Date.now() - 1000),
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  },
}));

import { isAllowedOrigin, requireAuth, requireFreshSession, requireOrigin, signToken, verifyToken } from "./auth";

function mockReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  user?: { id: string; role: "STUDENT"; ts?: number };
}): Request {
  const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: opts.method ?? "POST",
    headers,
    cookies: opts.cookies ?? {},
    user: opts.user,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

describe("auth origin & session revocation", () => {
  it("blocks cross-origin cookie mutations and allows trusted origins or GETs", () => {
    const mw = requireOrigin(["http://localhost:3000"]);
    const nextOk = vi.fn();
    mw(mockReq({ method: "POST", headers: { origin: "http://localhost:3000" }, cookies: { progga_token: "abc" } }), {} as Response, nextOk as NextFunction);
    expect(nextOk).toHaveBeenCalledWith();

    const nextBad = vi.fn();
    mw(mockReq({ method: "POST", headers: { origin: "https://evil.example" }, cookies: { progga_token: "abc" } }), {} as Response, nextBad as NextFunction);
    expect(nextBad.mock.calls[0][0]).toMatchObject({ status: 403 });

    const nextGet = vi.fn();
    mw(mockReq({ method: "GET", headers: { origin: "https://evil.example" }, cookies: { progga_token: "abc" } }), {} as Response, nextGet as NextFunction);
    expect(nextGet).toHaveBeenCalledWith();
  });

  it("verifies isAllowedOrigin matches configured origins and trusted domains", () => {
    expect(isAllowedOrigin("http://localhost:3000", ["http://localhost:3000"])).toBe(true);
    expect(isAllowedOrigin("https://sandbox.proggaai.com")).toBe(true);
    expect(isAllowedOrigin("https://proggaai.com")).toBe(true);
    expect(isAllowedOrigin("https://admin.proggaai.com")).toBe(true);
    expect(isAllowedOrigin("https://proggaapi.akxens.com")).toBe(true);
    expect(isAllowedOrigin("http://localhost:4000")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isAllowedOrigin("https://evil.com")).toBe(false);
    expect(isAllowedOrigin("https://notproggaai.com")).toBe(false);
  });

  it("rejects tokens issued before password revocation timestamp and accepts current tokens", async () => {
    store.accountStatus = "active";
    const oldToken = signToken({ id: "u1", role: "STUDENT", ts: 1000 });
    const oldUser = verifyToken(oldToken)!;
    store.revokedAt = "2000";

    const nextOld = vi.fn();
    await requireFreshSession(mockReq({ user: oldUser as { id: string; role: "STUDENT"; ts?: number } }), {} as Response, nextOld as NextFunction);
    expect(nextOld.mock.calls[0][0]).toMatchObject({ status: 401 });

    const freshToken = signToken({ id: "u1", role: "STUDENT", ts: 2000 });
    const freshUser = verifyToken(freshToken)!;
    const nextFresh = vi.fn();
    await requireFreshSession(mockReq({ user: freshUser as { id: string; role: "STUDENT"; ts?: number } }), {} as Response, nextFresh as NextFunction);
    expect(nextFresh).toHaveBeenCalledWith();
  });

  it("rejects suspended or closed accounts with 403 (BR-STU-02)", async () => {
    store.revokedAt = null;
    const token = signToken({ id: "u1", role: "STUDENT" });
    const user = verifyToken(token)!;

    store.accountStatus = "suspended";
    const nextSuspended = vi.fn();
    await requireFreshSession(mockReq({ user: user as any }), {} as Response, nextSuspended as NextFunction);
    expect(nextSuspended.mock.calls[0][0]).toMatchObject({ status: 403, code: "account_suspended" });

    store.accountStatus = "closed";
    const nextClosed = vi.fn();
    await requireFreshSession(mockReq({ user: user as any }), {} as Response, nextClosed as NextFunction);
    expect(nextClosed.mock.calls[0][0]).toMatchObject({ status: 403, code: "account_closed" });
  });

  it("revokes delegated student session when guardian link is unlinked or revoked (BUG-037, BR-GRD-03)", async () => {
    store.accountStatus = "active";
    const token = signToken({ id: "s1", role: "STUDENT", delegatedBy: "g1" });
    const verified = verifyToken(token);
    expect(verified?.delegatedBy).toBe("g1");

    // When link is active
    store.activeLink = true;
    store.linkStatus = "active";
    const nextActive = vi.fn();
    await requireAuth(mockReq({ cookies: { progga_token: token } }), {} as Response, nextActive as NextFunction);
    expect(nextActive).toHaveBeenCalledWith();

    // When link is soft-revoked
    store.activeLink = true;
    store.linkStatus = "revoked";
    const nextRevoked = vi.fn();
    await requireAuth(mockReq({ cookies: { progga_token: token } }), {} as Response, nextRevoked as NextFunction);
    expect(nextRevoked.mock.calls[0][0]).toMatchObject({ status: 401, message: "Guardian delegation revoked" });

    // When link is completely deleted / missing
    store.activeLink = false;
    const nextMissing = vi.fn();
    await requireAuth(mockReq({ cookies: { progga_token: token } }), {} as Response, nextMissing as NextFunction);
    expect(nextMissing.mock.calls[0][0]).toMatchObject({ status: 401, message: "Guardian delegation revoked" });
  });
});
