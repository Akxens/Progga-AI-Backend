import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../lib/prisma";
import { registerJob, jobRegistry } from "./registry";
import { tickJobs, enqueueDueSchedules } from "./runner";
import { emitEvent, enqueueOutbox } from "../lib/events";

describe("Job Runner & Outbox Engine (TASK-008 & TASK-009)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("TASK-009: emitEvent inserts event with uuid and source=server", async () => {
    const mockCreate = vi.fn().mockImplementation(async ({ data }) => data);
    const mockTx = { event: { create: mockCreate } } as any;

    const event = await emitEvent(mockTx, {
      eventType: "session_started",
      userId: "u-1",
      properties: { grade: 6 },
    });

    expect(mockCreate).toHaveBeenCalled();
    expect(event.eventType).toBe("session_started");
    expect(event.source).toBe("server");
    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("TASK-009: enqueueOutbox inserts row with pending status", async () => {
    const mockCreate = vi.fn().mockImplementation(async ({ data }) => data);
    const mockTx = { outbox: { create: mockCreate } } as any;

    const outbox = await enqueueOutbox(mockTx, "notification.send", { to: "user-1" });
    expect(mockCreate).toHaveBeenCalled();
    expect(outbox.topic).toBe("notification.send");
    expect(outbox.status).toBe("pending");
    expect(outbox.attempts).toBe(0);
  });

  it("TASK-008: runs successful job and marks succeeded", async () => {
    let jobExecuted = false;
    registerJob("test-success", async () => {
      jobExecuted = true;
    });

    const mockJob = {
      id: "job-1",
      type: "test-success",
      payload: {},
      status: "queued",
      attempts: 0,
      maxAttempts: 5,
    };

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const tx = {
        jobSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        $queryRaw: vi.fn().mockResolvedValue([{ id: "job-1" }]),
        $executeRaw: vi.fn().mockResolvedValue(1),
        job: {
          findMany: vi.fn().mockResolvedValue([mockJob]),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      return cb(tx);
    });

    const updateSpy = vi.spyOn(prisma.job, "update").mockResolvedValue({} as any);

    const summary = await tickJobs(5000);
    expect(summary.processed).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(jobExecuted).toBe(true);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1" },
        data: expect.objectContaining({ status: "succeeded" }),
      }),
    );
  });

  it("TASK-008: retries failing job with backoff when attempts < maxAttempts", async () => {
    registerJob("test-fail", async () => {
      throw new Error("Temporary network glitch");
    });

    const mockJob = {
      id: "job-fail-1",
      type: "test-fail",
      payload: {},
      status: "running",
      attempts: 2, // 2nd attempt out of 5
      maxAttempts: 5,
    };

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const tx = {
        jobSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        $queryRaw: vi.fn().mockResolvedValue([{ id: "job-fail-1" }]),
        $executeRaw: vi.fn().mockResolvedValue(1),
        job: { findMany: vi.fn().mockResolvedValue([mockJob]) },
      };
      return cb(tx);
    });

    const updateSpy = vi.spyOn(prisma.job, "update").mockResolvedValue({} as any);

    const summary = await tickJobs(5000);
    expect(summary.failed).toBe(1);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-fail-1" },
        data: expect.objectContaining({
          status: "queued",
          lastError: "Temporary network glitch",
        }),
      }),
    );
  });

  it("TASK-008: marks dead and generates SystemAlert on 5th failure", async () => {
    registerJob("test-dead", async () => {
      throw new Error("Fatal unrecoverable error");
    });

    const mockJob = {
      id: "job-dead-1",
      type: "test-dead",
      payload: {},
      status: "running",
      attempts: 5, // Reached maxAttempts!
      maxAttempts: 5,
    };

    let alertCreated = false;
    let jobMarkedDead = false;

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const tx = {
        jobSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        $queryRaw: vi.fn().mockResolvedValue([{ id: "job-dead-1" }]),
        $executeRaw: vi.fn().mockResolvedValue(1),
        job: {
          findMany: vi.fn().mockResolvedValue([mockJob]),
          update: vi.fn().mockImplementation(async ({ data }) => {
            if (data.status === "dead") jobMarkedDead = true;
          }),
        },
        systemAlert: {
          create: vi.fn().mockImplementation(async () => {
            alertCreated = true;
          }),
        },
      };
      return cb(tx);
    });

    const summary = await tickJobs(5000);
    expect(summary.failed).toBe(1);
    expect(jobMarkedDead).toBe(true);
    expect(alertCreated).toBe(true);
  });
});
