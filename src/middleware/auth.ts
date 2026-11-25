import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { forbidden, HttpError, unauthorized } from "../lib/errors";
import { prisma } from "../lib/prisma";

export const AUTH_COOKIE = "progga_token";
/** Holds the parent's session while a kid's profile is open on the same device, so the parent can switch back. */
export const GUARDIAN_COOKIE = "progga_guardian";
export const revokedSettingKey = (userId: string) => `auth.revoked:${userId}`;

export function setSessionCookie(res: Response, name: string, token: string) {
  res.cookie(name, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

function tokenTimestamp(payload: jwt.JwtPayload): number | undefined {
  if (typeof payload.ts === "number") return payload.ts;
  if (typeof payload.iat === "number") return payload.iat * 1000;
  return undefined;
}

/** Verifies a token without touching the request (e.g. the parked guardian session). */
export function verifyToken(token: string | undefined): AuthUser | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    return {
      id: String(payload.sub),
      role: payload.role as Role,
      ts: tokenTimestamp(payload),
      delegatedBy: payload.delegatedBy ? String(payload.delegatedBy) : undefined,
    };
  } catch {
    return null;
  }
}

export type Role = "STUDENT" | "PARENT" | "TEACHER" | "ADMIN";

export interface AuthUser {
  id: string;
  role: Role;
  ts?: number;
  delegatedBy?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, role: user.role, ts: user.ts ?? Date.now(), delegatedBy: user.delegatedBy }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

function readToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return req.cookies?.[AUTH_COOKIE];
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    const delegatedBy = payload.delegatedBy ? String(payload.delegatedBy) : undefined;
    if (delegatedBy) {
      const link = await prisma.guardianLink.findUnique({
        where: { guardianId_studentId: { guardianId: delegatedBy, studentId: String(payload.sub) } },
      });
      if (!link || link.status !== "active") return next(unauthorized("Guardian delegation revoked"));
    }
    req.user = { id: String(payload.sub), role: payload.role as Role, ts: tokenTimestamp(payload), delegatedBy };
    next();
  } catch (err: any) {
    if (err?.status) return next(err);
    next(unauthorized("Your session expired. Please log in again."));
  }
}

/** Rejects tokens issued before the user's most recent password change, verifies account status, and tracks lastSeenAt. */
export async function requireFreshSession(req: Request, _res: Response, next: NextFunction) {
  const u = req.user;
  if (!u) return next(unauthorized());
  try {
    const [row, user] = await Promise.all([
      prisma.appSetting.findUnique({ where: { key: revokedSettingKey(u.id) } }),
      prisma.user.findUnique({ where: { id: u.id }, select: { accountStatus: true, lastSeenAt: true } }),
    ]);
    if (!user) {
      return next(unauthorized());
    }
    if (user.accountStatus === "suspended") {
      return next(new HttpError(403, "Your account has been suspended. Please contact support.", "account_suspended"));
    }
    if (user.accountStatus === "closed") {
      return next(new HttpError(403, "Your account is closed.", "account_closed"));
    }
    if (row && (u.ts ?? 0) < Number(row.value)) {
      return next(unauthorized("Your session expired. Please log in again."));
    }

    // TASK-013: update lastSeenAt if older than 5 min (fire-and-forget)
    if (!user.lastSeenAt || Date.now() - user.lastSeenAt.getTime() > 5 * 60_000) {
      prisma.user.updateMany({
        where: { id: u.id },
        data: { lastSeenAt: new Date() },
      }).catch(() => {});
    }

    next();
  } catch (err) {
    next(err);
  }
}

/** Validates Origin/Referer against allowed CORS origins on cookie-authenticated mutations. */
export function requireOrigin(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins.map((o) => o.replace(/\/+$/, "")));
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (req.headers.authorization?.startsWith("Bearer ")) return next();
    if (!req.cookies?.[AUTH_COOKIE] && !req.cookies?.[GUARDIAN_COOKIE]) return next();

    const origin = req.get("origin");
    if (origin) return allowed.has(origin.replace(/\/+$/, "")) ? next() : next(forbidden("Untrusted origin"));
    const referer = req.get("referer");
    if (referer) {
      try {
        return allowed.has(new URL(referer).origin) ? next() : next(forbidden("Untrusted origin"));
      } catch {
        return next(forbidden("Untrusted origin"));
      }
    }
    if (req.get("sec-fetch-site") === "cross-site") return next(forbidden("Untrusted origin"));
    next();
  };
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

/** Narrowing helper for handlers mounted behind requireAuth */
export function authed(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
