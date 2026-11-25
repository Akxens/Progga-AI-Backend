import { aiConfigReady, app } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { tutorLLM } from "./modules/tutor/llm";
import { tickJobs } from "./jobs/runner";

// Local/long-running server. On Vercel, src/app.ts is the entry instead.
async function main() {
  await aiConfigReady;

  let jobInterval: NodeJS.Timeout | undefined;
  if (env.RUN_JOBS_IN_PROCESS) {
    logger.info("Starting in-process background job runner (60s interval)");
    jobInterval = setInterval(() => {
      tickJobs().catch((err) => logger.error({ err }, "In-process job tick failed"));
    }, 60_000);
  }

  const server = app.listen(env.PORT, () => {
    logger.info(`🍌 Progga API listening on http://localhost:${env.PORT} (tutor brain: ${tutorLLM.name} · ${tutorLLM.model})`);
    if (tutorLLM.name === "mock") {
      logger.warn("Using the offline MOCK tutor. Add OPENAI_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY or OLLAMA_BASE_URL to backend/.env for a real AI.");
    }
  });

  async function shutdown(signal: string) {
    logger.info(`${signal} received, shutting down`);
    if (jobInterval) clearInterval(jobInterval);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
