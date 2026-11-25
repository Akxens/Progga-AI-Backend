import { prisma } from "../../lib/prisma";
import { badRequest } from "../../lib/errors";
import { nextCode } from "../../admin/core/codes";

export interface IngestEvent {
  eventId: string;
  eventType: string;
  occurredAt: string | Date;
  sessionId?: string | null;
  schoolId?: string | null;
  programmeId?: string | null;
  properties?: Record<string, any>;
}

const ALLOWED_CLIENT_EVENT_TYPES = new Set([
  "session_started",
  "session_heartbeat",
  "session_ended",
  "lesson_started",
]);

export async function getOrCreateSession(
  userId: string,
  data: {
    deviceCategory?: string;
    platform?: string;
    appVersion?: string;
    module?: string;
    lessonId?: string;
  },
) {
  const now = new Date();
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60_000);

  // 1. Look for existing open session with recent heartbeat
  const openSession = await prisma.learningSession.findFirst({
    where: {
      userId,
      isFinalized: false,
      lastHeartbeatAt: { gte: thirtyMinutesAgo },
    },
    orderBy: { lastHeartbeatAt: "desc" },
  });

  if (openSession) {
    return {
      sessionId: openSession.id,
      code: openSession.code,
    };
  }

  // 2. Finalize any stale open sessions for this user (orphan rule)
  await prisma.learningSession.updateMany({
    where: {
      userId,
      isFinalized: false,
    },
    data: {
      isFinalized: true,
    },
  });

  // 3. Create fresh session
  const code = await nextCode(prisma, "SES");
  const newSession = await prisma.learningSession.create({
    data: {
      code,
      userId,
      startedAt: now,
      lastHeartbeatAt: now,
      deviceCategory: data.deviceCategory || "unknown",
      platform: data.platform || "web",
      appVersion: data.appVersion || "1.0.0",
      module: data.module || "browse",
      lessonId: data.lessonId || null,
      isFinalized: false,
      activeSeconds: 0,
    },
  });

  return {
    sessionId: newSession.id,
    code: newSession.code,
  };
}

export async function ingestEvents(userId: string, rawEvents: IngestEvent[]) {
  if (rawEvents.length > 50) {
    throw badRequest("Max 50 events per batch");
  }

  const now = Date.now();
  const maxFuture = now + 5 * 60_000; // 5 min clock skew
  const maxPast = now - 7 * 24 * 60 * 60_000; // 7 days

  let accepted = 0;
  let duplicates = 0;

  for (const raw of rawEvents) {
    if (!raw.eventId || typeof raw.eventId !== "string") {
      throw badRequest("Missing or invalid eventId");
    }

    if (!ALLOWED_CLIENT_EVENT_TYPES.has(raw.eventType)) {
      throw badRequest(`eventType '${raw.eventType}' is not permitted from client`);
    }

    const occurredAt = new Date(raw.occurredAt);
    const occurredTime = occurredAt.getTime();
    if (isNaN(occurredTime)) {
      throw badRequest("Invalid occurredAt date");
    }

    if (occurredTime > maxFuture) {
      throw badRequest("occurredAt is too far in the future (clock skew > 5m)");
    }

    if (occurredTime < maxPast) {
      throw badRequest("occurredAt is older than 7 days");
    }

    // Deduplication check
    const existing = await prisma.event.findUnique({
      where: { id: raw.eventId },
    });
    if (existing) {
      duplicates++;
      continue;
    }

    // Persist event
    await prisma.event.create({
      data: {
        id: raw.eventId,
        eventType: raw.eventType,
        occurredAt,
        receivedAt: new Date(),
        userId,
        sessionId: raw.sessionId || null,
        schoolId: raw.schoolId || null,
        programmeId: raw.programmeId || null,
        source: "web",
        schemaVersion: 1,
        properties: raw.properties || {},
      },
    });
    accepted++;

    // Meaningful activity: flip student registered -> active (WF-STU-03, BR-STU-01)
    await prisma.user.updateMany({
      where: { id: userId, accountStatus: "registered" },
      data: { accountStatus: "active" },
    });

    // Update StudentProfile firstActiveAt / lastActiveAt
    const studentProfile = await prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (studentProfile) {
      await prisma.studentProfile.update({
        where: { userId },
        data: {
          firstActiveAt: studentProfile.firstActiveAt || occurredAt,
        },
      });
    }

    // Process Heartbeat & Session progression
    if (raw.sessionId) {
      const session = await prisma.learningSession.findUnique({
        where: { id: raw.sessionId },
      });

      if (session && !session.isFinalized) {
        if (raw.eventType === "session_heartbeat") {
          const gapSec = Math.floor(
            (occurredAt.getTime() - session.lastHeartbeatAt.getTime()) / 1000,
          );

          if (gapSec > 1800) {
            // Gap > 30 min: end old session and open new one
            await prisma.learningSession.update({
              where: { id: session.id },
              data: {
                isFinalized: true,
                endedAt: session.lastHeartbeatAt,
              },
            });
            const newCode = await nextCode(prisma, "SES");
            await prisma.learningSession.create({
              data: {
                code: newCode,
                userId,
                startedAt: occurredAt,
                lastHeartbeatAt: occurredAt,
                deviceCategory: session.deviceCategory,
                platform: session.platform,
                module: (raw.properties?.module as string) || session.module,
                lessonId: (raw.properties?.lessonId as string) || session.lessonId,
                activeSeconds: 0,
                isFinalized: false,
              },
            });
          } else {
            // Normal heartbeat: if 0 < gap <= 90 sec, add to activeSeconds (capped gap rule)
            const addSec = gapSec > 0 && gapSec <= 90 ? gapSec : 0;
            const nextHeartbeat =
              occurredAt.getTime() > session.lastHeartbeatAt.getTime()
                ? occurredAt
                : session.lastHeartbeatAt;

            await prisma.learningSession.update({
              where: { id: session.id },
              data: {
                activeSeconds: { increment: addSec },
                lastHeartbeatAt: nextHeartbeat,
                module: (raw.properties?.module as string) || session.module,
                lessonId: (raw.properties?.lessonId as string) || session.lessonId,
              },
            });
          }
        } else if (raw.eventType === "session_ended") {
          await prisma.learningSession.update({
            where: { id: session.id },
            data: {
              isFinalized: true,
              endedAt: occurredAt,
            },
          });
        }
      }
    }
  }

  return { accepted, duplicates };
}
