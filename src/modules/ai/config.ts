import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

// Which AI engine Progga uses right now. Defaults come from .env; an admin can
// switch provider/model at runtime from AI settings, which is saved in the DB.

export const PROVIDER_IDS = ["openai", "deepseek", "anthropic", "ollama", "mock"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Progga's own names for the engines, shown to students and admins instead of vendor names. */
export const ENGINE_BRANDS: Partial<Record<ProviderId, string>> = {
  openai: "Progga Nova",
  deepseek: "Progga Orbit V1",
  ollama: "Progga Spark beta",
};

export interface ProviderInfo {
  id: ProviderId;
  /** Progga's name for this engine (falls back to the vendor label) */
  brand: string;
  label: string;
  configured: boolean;
  vision: boolean;
  defaultModel: string;
}

export function providers(): ProviderInfo[] {
  const list: Omit<ProviderInfo, "brand">[] = [
    { id: "openai", label: "OpenAI", configured: !!env.OPENAI_API_KEY, vision: true, defaultModel: env.OPENAI_MODEL },
    { id: "deepseek", label: "DeepSeek", configured: !!env.DEEPSEEK_API_KEY, vision: false, defaultModel: env.DEEPSEEK_MODEL },
    { id: "anthropic", label: "Anthropic Claude", configured: !!env.ANTHROPIC_API_KEY, vision: true, defaultModel: env.ANTHROPIC_MODEL },
    { id: "ollama", label: "Local (Ollama)", configured: !!env.OLLAMA_BASE_URL, vision: true, defaultModel: env.OLLAMA_MODEL },
    { id: "mock", label: "Offline practice (mock)", configured: true, vision: true, defaultModel: "offline" },
  ];
  return list.map((p) => ({ ...p, brand: ENGINE_BRANDS[p.id] ?? p.label }));
}

export const providerInfo = (id: ProviderId) => providers().find((p) => p.id === id)!;

export const AiConfigSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  /** The one model used for everything: planning lessons, answering facts and checking replies. */
  model: z.string().trim().min(1).max(100),
});
export type AiConfig = z.infer<typeof AiConfigSchema>;

const SETTING_KEY = "ai.config";
/** Serverless instances each keep a copy, so re-read periodically to pick up admin changes. */
const TTL_MS = 15_000;

function envDefault(): AiConfig {
  const p = providerInfo(env.llmProvider);
  return { provider: p.id, model: p.defaultModel };
}

let current: AiConfig = envDefault();
let version = 0;
let loadedAt = 0;
let inflight: Promise<AiConfig> | null = null;

export const getAiConfig = () => current;
/** Bumps whenever the config changes, so engines can be rebuilt lazily. */
export const aiConfigVersion = () => version;

async function fetchAiConfig(): Promise<AiConfig> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    if (row) {
      let raw: unknown;
      try {
        raw = JSON.parse(row.value);
      } catch {
        logger.warn("Saved AI settings contain invalid JSON; using fallback defaults");
        loadedAt = Date.now();
        return current;
      }
      const parsed = AiConfigSchema.safeParse(raw);
      if (parsed.success && providerInfo(parsed.data.provider).configured) {
        if (parsed.data.provider !== current.provider || parsed.data.model !== current.model) {
          current = parsed.data;
          version++;
        }
      } else {
        logger.warn("Saved AI settings are invalid or missing an API key; using .env defaults");
      }
    }
    loadedAt = Date.now();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Couldn't load AI settings");
  }
  return current;
}

/** Returns the active AI config, refreshing from DB at most once every 15s (or when forced). */
export async function ensureAiConfig(force = false): Promise<AiConfig> {
  if (!force && loadedAt > 0 && Date.now() - loadedAt < TTL_MS) return current;
  if (!inflight) {
    inflight = fetchAiConfig().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Loads the admin-chosen engine from the DB (falls back to .env if unset or no longer usable). */
export async function loadAiConfig() {
  await ensureAiConfig(true);
}

export async function saveAiConfig(cfg: AiConfig) {
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: JSON.stringify(cfg) },
    update: { value: JSON.stringify(cfg) },
  });
  if (cfg.provider !== current.provider || cfg.model !== current.model) version++;
  current = cfg;
  loadedAt = Date.now();
}
