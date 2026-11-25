import { beforeEach, describe, expect, it, vi } from "vitest";

const setting = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async () => (setting.value === null ? null : { key: "ai.config", value: setting.value })),
      upsert: vi.fn(async () => ({})),
    },
  },
}));

import { aiConfigVersion, ensureAiConfig } from "./config";

describe("ai config sync and JSON safety", () => {
  beforeEach(() => {
    setting.value = null;
  });

  it("ignores corrupt JSON without throwing and refreshes valid DB updates when forced", async () => {
    const startVersion = aiConfigVersion();
    setting.value = "{bad-json";
    const afterBad = await ensureAiConfig(true);
    expect(afterBad.provider).toBeTruthy();
    expect(aiConfigVersion()).toBe(startVersion);

    setting.value = JSON.stringify({ provider: "mock", model: "offline" });
    const updated = await ensureAiConfig(true);
    expect(updated).toEqual({ provider: "mock", model: "offline" });
  });
});
