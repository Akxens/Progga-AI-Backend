import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public details?: unknown,
  ) {
    super(message);
  }
}

const IdParam = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid identifier");
export const parseId = (raw: unknown): string => IdParam.parse(raw);

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Please log in first") => new HttpError(401, msg, "unauthorized");
export const forbidden = (msg = "You can't do that") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "Not found") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
export const tooMany = (msg: string) => new HttpError(429, msg, "limit_reached");
