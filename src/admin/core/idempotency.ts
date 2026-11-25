import type { Request, Response } from "express";
import crypto from "node:crypto";
import { prisma } from "../../lib/prisma";
import type { AdminContext } from "./context";
import { idempotencyMismatch } from "./errors";

function hashRequest(body: any): string {
  const str = JSON.stringify(body || {});
  return crypto.createHash("sha256").update(str).digest("hex");
}

export async function withIdempotency<T>(
  ctx: AdminContext,
  req: Request,
  res: Response,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<void> {
  const key = req.headers["idempotency-key"];
  if (!key || typeof key !== "string" || !key.trim()) {
    // If no key provided, execute directly
    const result = await fn();
    res.status(result.status).json(result.body);
    return;
  }

  const idempotencyKey = key.trim();
  const requestHash = hashRequest(req.body);
  const route = `${req.method} ${req.baseUrl}${req.path}`;

  const existing = await prisma.idempotencyKey.findUnique({
    where: { key: idempotencyKey },
  });

  if (existing) {
    if (existing.userId !== ctx.user.id || existing.route !== route || existing.requestHash !== requestHash) {
      throw idempotencyMismatch();
    }
    res.status(existing.responseStatus).json(existing.responseBody);
    return;
  }

  const result = await fn();

  await prisma.idempotencyKey.create({
    data: {
      key: idempotencyKey,
      userId: ctx.user.id,
      route,
      requestHash,
      responseStatus: result.status,
      responseBody: result.body as any,
    },
  });

  res.status(result.status).json(result.body);
}
