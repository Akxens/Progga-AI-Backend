import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export interface EventEnvelope {
  eventType: string;
  occurredAt?: Date;
  userId?: string | null;
  sessionId?: string | null;
  schoolId?: string | null;
  programmeId?: string | null;
  legalEntityId?: string | null;
  correlationId?: string | null;
  source?: "web" | "android" | "ios" | "server";
  properties?: Record<string, any>;
}

export async function emitEvent(
  txOrPrisma: Prisma.TransactionClient | typeof prisma,
  envelope: EventEnvelope,
) {
  const id = crypto.randomUUID();
  return txOrPrisma.event.create({
    data: {
      id,
      eventType: envelope.eventType,
      occurredAt: envelope.occurredAt || new Date(),
      receivedAt: new Date(),
      userId: envelope.userId || null,
      sessionId: envelope.sessionId || null,
      schoolId: envelope.schoolId || null,
      programmeId: envelope.programmeId || null,
      legalEntityId: envelope.legalEntityId || null,
      schemaVersion: 1,
      correlationId: envelope.correlationId || null,
      source: envelope.source || "server",
      properties: envelope.properties || {},
    },
  });
}

export async function enqueueOutbox(
  txOrPrisma: Prisma.TransactionClient | typeof prisma,
  topic: string,
  payload: any,
) {
  return txOrPrisma.outbox.create({
    data: {
      topic,
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
    },
  });
}
