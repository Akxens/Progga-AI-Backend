import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { authed, requireAuth, requireFreshSession } from "../../middleware/auth";
import { getOrCreateSession, ingestEvents } from "./service";

export const eventsRouter = Router();

const eventsLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip ?? "0.0.0.0"),
});

eventsRouter.use(eventsLimiter);
eventsRouter.use(requireAuth, requireFreshSession);

const SessionBody = z.object({
  deviceCategory: z.string().trim().optional(),
  platform: z.string().trim().optional(),
  appVersion: z.string().trim().optional(),
  module: z.string().trim().optional(),
  lessonId: z.string().trim().optional(),
});

const IngestEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string().trim().min(1),
  occurredAt: z.string().datetime(),
  sessionId: z.string().trim().optional().nullable(),
  schoolId: z.string().trim().optional().nullable(),
  programmeId: z.string().trim().optional().nullable(),
  properties: z.record(z.string(), z.any()).optional(),
});

const IngestBatchBody = z.object({
  events: z.array(IngestEventSchema).min(1).max(50),
});

// POST /api/events/session
eventsRouter.post("/session", async (req, res) => {
  const me = authed(req);
  const body = SessionBody.parse(req.body);

  const session = await getOrCreateSession(me.id, body);
  res.json({ data: session });
});

// POST /api/events
eventsRouter.post("/", async (req, res) => {
  const me = authed(req);
  const body = IngestBatchBody.parse(req.body);

  const result = await ingestEvents(me.id, body.events);
  res.status(202).json(result);
});
