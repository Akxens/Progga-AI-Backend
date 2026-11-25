import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { correlationMiddleware } from "./correlation";

describe("correlationMiddleware", () => {
  it("assigns X-Correlation-Id header and req.correlationId if missing", () => {
    const headers: Record<string, string> = {};
    const req = { headers: {} } as Request;
    const res = {
      setHeader: vi.fn((k: string, v: string) => {
        headers[k] = v;
      }),
    } as unknown as Response;
    const next = vi.fn();

    correlationMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.correlationId).toBeDefined();
    expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith("X-Correlation-Id", req.correlationId);
  });

  it("preserves incoming X-Correlation-Id header", () => {
    const customId = "my-custom-tracing-id-12345";
    const req = { headers: { "x-correlation-id": customId } } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn();

    correlationMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.correlationId).toBe(customId);
    expect(res.setHeader).toHaveBeenCalledWith("X-Correlation-Id", customId);
  });
});
