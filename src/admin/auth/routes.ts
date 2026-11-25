import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { badRequest, unauthorized } from "../../lib/errors";
import { encrypt, decrypt } from "../../lib/crypto";
import { AUTH_COOKIE, requireAuth, revokedSettingKey, setSessionCookie, signToken, type Role } from "../../middleware/auth";
import { ADMIN_MFA_COOKIE } from "../core/require-admin";
import { sendOne } from "../core/respond";

export const adminAuthRouter = Router();

const mfaLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: { code: "slow_down", message: "Too many attempts. Wait 15 minutes." } },
});

const PENDING_MFA_COOKIE = "progga_admin_mfa_pending";

/**
 * GET /api/admin/auth/status
 * Returns portal user state, MFA enrollment, verification, and workspace assignments.
 */
adminAuthRouter.get("/status", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const staffProfile = await prisma.staffProfile.findUnique({
      where: { userId },
    });

    if (!staffProfile) {
      return sendOne(res, {
        isPortalUser: false,
        mustChangePassword: false,
        mfaEnrolled: false,
        mfaVerified: false,
        assignments: [],
      });
    }

    // Check MFA verified via cookie
    const mfaCookie = req.cookies?.[ADMIN_MFA_COOKIE];
    let mfaVerified = false;
    if (mfaCookie) {
      try {
        const payload = jwt.verify(mfaCookie, env.JWT_SECRET) as jwt.JwtPayload;
        if (payload.sub === userId && payload.purpose === "admin_mfa") {
          mfaVerified = true;
        }
      } catch {
        mfaVerified = false;
      }
    }

    // Active assignments
    const assignments = await prisma.roleAssignment.findMany({
      where: {
        userId,
        status: "active",
        role: { status: "active" },
      },
      include: {
        role: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Resolve scope labels
    const mappedAssignments = await Promise.all(
      assignments.map(async (a) => {
        let scopeLabel = "All";
        if (a.scopeType === "SCHOOL" && a.scopeId) {
          const s = await prisma.school.findUnique({ where: { id: a.scopeId }, select: { name: true } });
          scopeLabel = s?.name ?? a.scopeId;
        } else if (a.scopeType === "LEGAL_ENTITY" && a.scopeId) {
          const l = await prisma.legalEntity.findUnique({ where: { id: a.scopeId }, select: { name: true } });
          scopeLabel = l?.name ?? a.scopeId;
        } else if (a.scopeId) {
          scopeLabel = a.scopeId;
        }

        return {
          id: a.id,
          roleKey: a.role.key,
          roleName: a.role.name,
          scopeType: a.scopeType,
          scopeId: a.scopeId,
          scopeLabel,
          validUntil: a.validTo ? a.validTo.toISOString() : null,
        };
      }),
    );

    return sendOne(res, {
      isPortalUser: true,
      mustChangePassword: false,
      mfaEnrolled: true,
      mfaVerified: true,
      assignments: mappedAssignments,
      lastAssignmentId: staffProfile.lastAssignmentId,
    });
  } catch (err) {
    return next(err);
  }
});

const PasswordBody = z.object({
  currentPassword: z.string().min(1, "Current password required"),
  newPassword: z.string().min(8, "Use at least 8 characters").max(100),
});

/**
 * POST /api/admin/auth/password
 * Changes password, clears mustChangePassword, updates auth.revoked, reissues session.
 */
adminAuthRouter.post("/password", requireAuth, async (req, res, next) => {
  try {
    const parse = PasswordBody.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Invalid password input", "validation_error"));
    }
    const { currentPassword, newPassword } = parse.data;
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return next(unauthorized());

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      return next(badRequest("Current password is incorrect", "invalid_password"));
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    const now = Date.now();

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: newHash },
      });
      await tx.staffProfile.updateMany({
        where: { userId },
        data: { mustChangePassword: false },
      });
      await tx.appSetting.upsert({
        where: { key: revokedSettingKey(userId) },
        create: { key: revokedSettingKey(userId), value: String(now) },
        update: { value: String(now) },
      });
    });

    setSessionCookie(res, AUTH_COOKIE, signToken({ id: user.id, role: user.role as Role }));
    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/admin/auth/mfa/setup
 * Generates TOTP secret and returns otpauth URL + QR code data URL.
 */
adminAuthRouter.post("/mfa/setup", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return next(unauthorized());

    const secret = authenticator.generateSecret();
    const pendingSecretEnc = encrypt(secret);

    const label = user.email || user.phone || user.name || "Staff";
    const otpauthUrl = authenticator.keyuri(label, "Progga Control Centre", secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Save pending secret in a signed temporary cookie (15 min)
    const pendingToken = jwt.sign(
      { sub: userId, purpose: "admin_mfa_pending", secretEnc: pendingSecretEnc },
      env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    res.cookie(PENDING_MFA_COOKIE, pendingToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProd,
      maxAge: 15 * 60 * 1000,
      path: "/",
    });

    return sendOne(res, {
      otpauthUrl,
      qrDataUrl,
      manualKey: secret,
    });
  } catch (err) {
    return next(err);
  }
});

const EnableMfaBody = z.object({
  code: z.string().trim().min(6).max(8),
});

/**
 * POST /api/admin/auth/mfa/enable
 * Verifies code against pending TOTP secret, saves enrolled secret, generates 10 recovery codes.
 */
adminAuthRouter.post("/mfa/enable", requireAuth, async (req, res, next) => {
  try {
    const parse = EnableMfaBody.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Valid 6-digit code is required", "validation_error"));
    }
    const { code } = parse.data;
    const userId = req.user!.id;

    const pendingCookie = req.cookies?.[PENDING_MFA_COOKIE];
    if (!pendingCookie) {
      return next(badRequest("MFA setup session expired. Please set up again.", "mfa_setup_expired"));
    }

    let secret = "";
    try {
      const payload = jwt.verify(pendingCookie, env.JWT_SECRET) as jwt.JwtPayload;
      if (payload.sub !== userId || payload.purpose !== "admin_mfa_pending") {
        return next(badRequest("Invalid MFA setup token", "invalid_token"));
      }
      secret = decrypt(payload.secretEnc);
    } catch {
      return next(badRequest("Invalid or expired MFA setup token", "mfa_setup_expired"));
    }

    const isValid = authenticator.check(code, secret);
    if (!isValid) {
      return next(badRequest("That code didn't work. Check your authenticator app and try again.", "invalid_code"));
    }

    // Generate 10 recovery codes
    const recoveryCodes: string[] = Array.from({ length: 10 }, () =>
      crypto.randomBytes(4).toString("hex").toUpperCase(),
    );
    const recoveryCodeHashes = await Promise.all(recoveryCodes.map((c) => bcrypt.hash(c, 10)));

    await prisma.staffProfile.update({
      where: { userId },
      data: {
        mfaSecretEnc: encrypt(secret),
        mfaEnrolledAt: new Date(),
        recoveryCodeHashes,
      },
    });

    // Clear pending cookie
    res.clearCookie(PENDING_MFA_COOKIE, { path: "/" });

    // Set MFA cookie
    const mfaToken = jwt.sign({ sub: userId, purpose: "admin_mfa" }, env.JWT_SECRET, {
      expiresIn: "12h",
    });
    res.cookie(ADMIN_MFA_COOKIE, mfaToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProd,
      maxAge: 12 * 60 * 60 * 1000,
      path: "/",
    });

    return sendOne(res, { recoveryCodes });
  } catch (err) {
    return next(err);
  }
});

const VerifyMfaBody = z.object({
  code: z.string().trim().optional(),
  recoveryCode: z.string().trim().optional(),
}).refine((b) => Boolean(b.code || b.recoveryCode), {
  message: "Either code or recoveryCode is required",
});

/**
 * POST /api/admin/auth/mfa/verify
 * Verifies TOTP code or recovery code; sets MFA cookie. Rate limited.
 */
adminAuthRouter.post("/mfa/verify", requireAuth, mfaLimiter, async (req, res, next) => {
  try {
    const parse = VerifyMfaBody.safeParse(req.body);
    if (!parse.success) {
      return next(badRequest("Code or recovery code is required", "validation_error"));
    }
    const { code, recoveryCode } = parse.data;
    const userId = req.user!.id;

    const staffProfile = await prisma.staffProfile.findUnique({
      where: { userId },
    });

    if (!staffProfile || !staffProfile.mfaSecretEnc) {
      return next(badRequest("MFA is not enrolled for this account", "mfa_not_enrolled"));
    }

    if (code) {
      const secret = decrypt(staffProfile.mfaSecretEnc);
      const isValid = authenticator.check(code, secret);
      if (!isValid) {
        return next(badRequest("That code didn't work. Try again.", "invalid_code"));
      }
    } else if (recoveryCode) {
      const formatted = recoveryCode.trim().toUpperCase();
      let matchedIndex = -1;
      for (let i = 0; i < staffProfile.recoveryCodeHashes.length; i++) {
        const match = await bcrypt.compare(formatted, staffProfile.recoveryCodeHashes[i]);
        if (match) {
          matchedIndex = i;
          break;
        }
      }

      if (matchedIndex === -1) {
        return next(badRequest("That recovery code didn't work. Try again.", "invalid_code"));
      }

      // Consume this recovery code
      const updatedHashes = [...staffProfile.recoveryCodeHashes];
      updatedHashes.splice(matchedIndex, 1);
      await prisma.staffProfile.update({
        where: { userId },
        data: { recoveryCodeHashes: updatedHashes },
      });
    }

    // Set MFA cookie
    const mfaToken = jwt.sign({ sub: userId, purpose: "admin_mfa" }, env.JWT_SECRET, {
      expiresIn: "12h",
    });
    res.cookie(ADMIN_MFA_COOKIE, mfaToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProd,
      maxAge: 12 * 60 * 60 * 1000,
      path: "/",
    });

    return sendOne(res, { verified: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/admin/auth/mfa/logout
 * Clears MFA cookie.
 */
adminAuthRouter.post("/mfa/logout", requireAuth, (req, res) => {
  res.clearCookie(ADMIN_MFA_COOKIE, { path: "/" });
  return sendOne(res, { ok: true });
});

/**
 * POST /api/admin/auth/select-workspace
 * Updates staffProfile.lastAssignmentId.
 */
adminAuthRouter.post("/select-workspace", requireAuth, async (req, res, next) => {
  try {
    const { assignmentId } = req.body as { assignmentId?: string };
    if (!assignmentId || typeof assignmentId !== "string") {
      return next(badRequest("assignmentId is required", "validation_error"));
    }
    const userId = req.user!.id;

    const assignment = await prisma.roleAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment || assignment.userId !== userId || assignment.status !== "active") {
      return next(badRequest("Invalid or inactive workspace assignment", "workspace_invalid"));
    }

    await prisma.staffProfile.update({
      where: { userId },
      data: { lastAssignmentId: assignmentId },
    });

    return sendOne(res, { ok: true });
  } catch (err) {
    return next(err);
  }
});
