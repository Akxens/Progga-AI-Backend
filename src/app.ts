import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { isAllowedOrigin, requireOrigin } from "./middleware/auth";
import { authRouter } from "./modules/auth/routes";
import { photosRouter, usersRouter } from "./modules/users/routes";
import { subjectsRouter } from "./modules/subjects/routes";
import { tutorRouter } from "./modules/tutor/routes";
import { lessonsRouter } from "./modules/lessons/routes";
import { coursesRouter } from "./modules/courses/routes";
import { quizRouter } from "./modules/quiz/routes";
import { gamificationRouter } from "./modules/gamification/routes";
import { guardianRouter } from "./modules/guardian/routes";
import { battleRouter } from "./modules/battle/routes";
import { labRouter } from "./modules/lab/routes";
import { eventsRouter } from "./modules/events/routes";
import { billingRouter } from "./modules/billing/routes";
import { requireFeature } from "./modules/features/config";
import { featuresAdminRouter, featuresRouter } from "./modules/features/routes";
import { tutorLLM } from "./modules/tutor/llm";
import { adminRouter } from "./admin";
import { internalJobsRouter } from "./jobs/routes";
import { aiAdminRouter } from "./modules/ai/routes";
import { ensureAiConfig, loadAiConfig } from "./modules/ai/config";
import { ensureVoiceConfig, loadVoiceConfig } from "./modules/voice/engines";
import { voiceAvailable, voiceKey, voiceLift, voiceLifts } from "./modules/voice/service";
import { voiceAdminRouter } from "./modules/voice/routes";
import { logger, runWithReqId } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { correlationMiddleware } from "./middleware/correlation";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(correlationMiddleware);
  app.use((req, res, next) => {
    const raw = req.get("x-request-id");
    const reqId = raw && /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : req.correlationId || crypto.randomUUID();
    res.setHeader("X-Request-Id", reqId);
    runWithReqId(reqId, next);
  });
  app.use(helmet());
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        if (!requestOrigin) return callback(null, true);
        if (isAllowedOrigin(requestOrigin, env.corsOrigins)) {
          return callback(null, true);
        }
        callback(null, false);
      },
      credentials: true,
      methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Workspace", "Idempotency-Key", "X-Request-Id"],
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use(requireOrigin(env.corsOrigins));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      // live battles poll every second and are limited per student in their own router
      skip: (req) => req.path.startsWith("/battle/"),
    }),
  );

  app.get("/api/health", async (req, res) => {
    await Promise.all([ensureAiConfig(), ensureVoiceConfig()]);
    const deep = req.query.deep === "1" || req.query.deep === "true";
    let db: "ok" | "error" | undefined;
    if (deep) {
      try {
        await prisma.$queryRaw`SELECT 1`;
        db = "ok";
      } catch (err) {
        logger.error({ err: (err as Error).message }, "Deep health DB probe failed");
        db = "error";
      }
    }
    res.status(db === "error" ? 503 : 200).json({
      ok: db !== "error",
      service: "progga-api",
      ...(db && { db }),
      llm: { provider: tutorLLM.name, model: tutorLLM.model, vision: tutorLLM.supportsImages },
      voice: voiceAvailable(),
      voiceLift: voiceLift(),
      voiceLifts: voiceLifts(),
      voiceKey: voiceKey(),
      time: new Date().toISOString(),
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/me", usersRouter);
  app.use("/api/photos", photosRouter);
  app.use("/api/subjects", subjectsRouter);
  app.use("/api/tutor", tutorRouter);
  app.use("/api/lessons", lessonsRouter);
  app.use("/api/courses", coursesRouter);
  app.use("/api/quiz", quizRouter);
  app.use("/api/game", gamificationRouter);
  app.use("/api/guardian", guardianRouter);
  app.use("/api/features", featuresRouter);
  app.use("/api/battle", requireFeature("battle"), battleRouter);
  app.use("/api/lab", requireFeature("lab"), labRouter);
  app.use("/api/events", eventsRouter);
  app.use("/api/billing", billingRouter);
  app.use("/api/webhooks", billingRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/admin/ai", aiAdminRouter);
  app.use("/api/admin/voice", voiceAdminRouter);
  app.use("/api/admin/features", featuresAdminRouter);
  app.use("/api/internal/jobs", internalJobsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();

// Loads the admin-chosen AI engine from the DB. A failure must not take the API
// down: log it and keep the .env defaults.
export const aiConfigReady = Promise.all([
  loadAiConfig().catch((err) => {
    logger.error({ err }, "Could not load AI settings from the database; using .env defaults");
  }),
  loadVoiceConfig().catch((err) => {
    logger.error({ err }, "Could not load voice settings from the database; using .env defaults");
  }),
]);

/**
 * Vercel serverless entry. Vercel's Express preset picks src/app.ts and needs it
 * to import express and default-export a handler; src/index.ts is the local server.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await aiConfigReady;
  app(req, res);
}
