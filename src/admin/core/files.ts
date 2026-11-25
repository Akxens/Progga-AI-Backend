import crypto from "node:crypto";
import { prisma } from "../../lib/prisma";
import type { AdminContext } from "./context";
import { HttpError } from "../../lib/errors";

export async function putFile(
  ctx: AdminContext,
  data: {
    purpose: string;
    fileName: string;
    mime: string;
    data: Buffer;
    sensitivity?: string;
    expiresAt?: Date | null;
  },
) {
  const sha256 = crypto.createHash("sha256").update(data.data).digest("hex");

  return prisma.storedFile.create({
    data: {
      purpose: data.purpose,
      fileName: data.fileName,
      mime: data.mime,
      sizeBytes: data.data.length,
      sha256,
      storageDriver: "db",
      data: new Uint8Array(data.data),
      sensitivity: data.sensitivity || "internal",
      expiresAt: data.expiresAt || null,
      createdById: ctx.user.id,
    },
  });
}

export async function issueDownloadToken(fileId: string, issuedToUserId: string, ttlHours = 24) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await prisma.downloadToken.create({
    data: {
      fileId,
      tokenHash,
      issuedToUserId,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

export async function readFileByToken(token: string, userId: string) {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const downloadToken = await prisma.downloadToken.findUnique({
    where: { tokenHash },
    include: { file: true },
  });

  if (!downloadToken) {
    throw new HttpError(404, "Invalid download token", "not_found");
  }

  if (downloadToken.expiresAt < new Date()) {
    throw new HttpError(410, "Download link has expired", "expired");
  }

  if (downloadToken.issuedToUserId !== userId) {
    throw new HttpError(403, "Download unauthorized for this user", "forbidden");
  }

  await prisma.downloadToken.update({
    where: { id: downloadToken.id },
    data: { downloads: { increment: 1 } },
  });

  return downloadToken.file;
}
