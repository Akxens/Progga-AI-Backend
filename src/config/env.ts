import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  LLM_PROVIDER: z.enum(["openai", "deepseek", "anthropic", "ollama", "mock", ""]).default(""),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-6-luna"),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  // Read-aloud: Progga speaks its replies. Engines: OpenAI (OPENAI_API_KEY), Google Gemini TTS
  // (GEMINI_API_KEY), Azure Speech (AZURE_SPEECH_KEY + region) or ElevenLabs (ELEVENLABS_API_KEY);
  // admins pick one per language in AI settings.
  VOICE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  OPENAI_TTS_MODEL: z.string().default("gpt-realtime-2.1-mini"),
  // coral, directed as a 10-year-old, stays the most youthful in both English and Bangla
  OPENAI_TTS_VOICE: z.string().default("coral"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_TTS_MODEL: z.string().default("gemini-3.8-flash-tts"),
  AZURE_SPEECH_KEY: z.string().optional(),
  /** e.g. southeastasia, centralindia, eastus */
  AZURE_SPEECH_REGION: z.string().optional(),
  /** Self-hosted IndicF5 voice server (indicf5/server.py), e.g. http://127.0.0.1:8020 */
  INDICF5_URL: z.url().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  // eleven_v3 is the ElevenLabs model that speaks Bangla correctly (the v2 models garble it)
  ELEVENLABS_MODEL: z.string().default("eleven_v3"),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().default("deepseek-flash"),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  // Local models via Ollama (OpenAI-compatible API, no key). Set the URL to enable it.
  OLLAMA_BASE_URL: z.url().optional(),
  OLLAMA_MODEL: z.string().default("gemma4:12b"),
  /** Context window (tokens) for the local model; the tutor prompt needs well over Ollama's 4096 default. */
  OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(16384),
  DEFAULT_DAILY_TUTOR_LIMIT: z.coerce.number().int().positive().default(25),
  // ── Admin & Control Centre ────────────────────────────────
  /** 32-byte base64 encryption key for sensitive data at rest (MFA secrets, consent evidence) */
  DATA_ENCRYPTION_KEY: z
    .string()
    .default(() => Buffer.from("01234567890123456789012345678901").toString("base64")),
  /** Bearer secret used by cron workers calling /api/internal/jobs/tick */
  CRON_SECRET: z.string().default("dev-cron-secret-change-in-production-40-chars-min"),
  /** For local/container deployments: runs the job tick on a setInterval */
  RUN_JOBS_IN_PROCESS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Secret used to sign and verify mock payment provider webhooks in dev/test */
  MOCK_PAYMENT_SECRET: z.string().default("dev-mock-payment-secret"),
  /** Payment provider driver: mock | sslcommerz | bkash */
  PAYMENT_PROVIDER: z.enum(["mock", "sslcommerz", "bkash"]).default("mock"),
  /** Base URL of the admin/student frontend for notification links and downloads */
  ADMIN_APP_URL: z.string().default("http://localhost:3000"),
  /** Number of hours generated report exports remain downloadable before cleanup */
  REPORT_FILE_TTL_HOURS: z.coerce.number().int().positive().default(24),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:\n", z.prettifyError(parsed.error));
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  // Vercel doesn't always set NODE_ENV for functions, so treat any Vercel deployment as production.
  isProd: raw.NODE_ENV === "production" || !!process.env.VERCEL,
  corsOrigins: raw.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
  /** Provider used until an admin picks one in AI settings (stored in the database). */
  llmProvider: (raw.LLM_PROVIDER ||
    (raw.OPENAI_API_KEY ? "openai" : raw.DEEPSEEK_API_KEY ? "deepseek" : raw.ANTHROPIC_API_KEY ? "anthropic" : raw.OLLAMA_BASE_URL ? "ollama" : "mock")) as
    | "openai"
    | "deepseek"
    | "anthropic"
    | "ollama"
    | "mock",
};
