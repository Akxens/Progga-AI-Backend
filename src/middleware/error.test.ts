import { Prisma } from "@prisma/client";
import multer from "multer";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "./error";

function mockRes() {
  const body: { status?: number; json?: unknown } = {};
  const res = {
    status(code: number) {
      body.status = code;
      return this;
    },
    json(payload: unknown) {
      body.json = payload;
      return this;
    },
  } as unknown as Response;
  return { res, body };
}

describe("errorHandler upload errors", () => {
  it("maps Multer LIMIT_FILE_SIZE to 413 and other MulterErrors to 400", () => {
    const { res: r1, body: b1 } = mockRes();
    errorHandler(new multer.MulterError("LIMIT_FILE_SIZE"), {} as Request, r1, vi.fn() as NextFunction);
    expect(b1.status).toBe(413);
    expect(b1.json).toMatchObject({ error: { code: "upload_error" } });

    const { res: r2, body: b2 } = mockRes();
    errorHandler(new multer.MulterError("LIMIT_UNEXPECTED_FILE"), {} as Request, r2, vi.fn() as NextFunction);
    expect(b2.status).toBe(400);
    expect(b2.json).toMatchObject({ error: { code: "upload_error" } });
  });

  it("maps Prisma P2025 to 401/404 and P2002 to 409", () => {
    const p2025User = new Prisma.PrismaClientKnownRequestError("Missing", {
      code: "P2025",
      clientVersion: "6",
      meta: { modelName: "User" },
    });
    const { res: r1, body: b1 } = mockRes();
    errorHandler(p2025User, { user: { id: "u1", role: "STUDENT" } } as unknown as Request, r1, vi.fn() as NextFunction);
    expect(b1.status).toBe(401);

    const p2025Lesson = new Prisma.PrismaClientKnownRequestError("Missing", {
      code: "P2025",
      clientVersion: "6",
      meta: { modelName: "Lesson" },
    });
    const { res: r2, body: b2 } = mockRes();
    errorHandler(p2025Lesson, {} as Request, r2, vi.fn() as NextFunction);
    expect(b2.status).toBe(404);

    const p2002 = new Prisma.PrismaClientKnownRequestError("Dup", { code: "P2002", clientVersion: "6" });
    const { res: r3, body: b3 } = mockRes();
    errorHandler(p2002, {} as Request, r3, vi.fn() as NextFunction);
    expect(b3.status).toBe(409);
  });
});
