import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import { ZodError, z } from "zod";
import { HttpError } from "../lib/errors";
import { logger } from "../lib/logger";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: "not_found",
      message: `No route for ${req.method} ${req.path}`,
      correlationId: req.correlationId,
    },
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const correlationId = req.correlationId;
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, correlationId },
    });
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "That photo is too large — please pick a smaller image."
        : "Could not process that uploaded file — please try another image.";
    return res.status(status).json({
      error: { code: "upload_error", message, correlationId },
    });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "validation_error",
        message: "Some fields need fixing",
        details: z.flattenError(err).fieldErrors,
        correlationId,
      },
    });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      if (req.user && err.meta?.modelName === "User") {
        return res.status(401).json({
          error: { code: "unauthorized", message: "Please log in again", correlationId },
        });
      }
      return res.status(404).json({
        error: { code: "not_found", message: "Record not found", correlationId },
      });
    }
    if (err.code === "P2002") {
      return res.status(409).json({
        error: { code: "conflict", message: "That value is already in use", correlationId },
      });
    }
  }
  logger.error({ err, correlationId }, "Unhandled error");
  res.status(500).json({
    error: {
      code: "server_error",
      message: "Oops! Something went wrong on our side.",
      correlationId,
    },
  });
}
