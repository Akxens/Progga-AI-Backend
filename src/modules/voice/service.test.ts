import { describe, expect, it, vi } from "vitest";

const voiceCfg = vi.hoisted(() => ({
  cfg: {
    provider: "elevenlabs" as const,
    voice: "cgSgspJ2msm6clMCkdW9",
    en: { provider: "openai" as const, voice: "coral" },
  },
}));

vi.mock("./engines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engines")>();
  return {
    ...actual,
    getVoiceConfig: () => voiceCfg.cfg,
  };
});

import { voiceKey, voiceLift, voiceLifts } from "./service";

describe("bilingual voice lifts and cache key", () => {
  it("exposes separate Bangla and English lifts and updates voiceKey on config changes", () => {
    expect(voiceLift()).toBe(1.06);
    expect(voiceLifts()).toEqual({ bn: 1.06, en: 1.12 });
    const keyBefore = voiceKey();

    voiceCfg.cfg = {
      provider: "gemini",
      voice: "Leda",
      en: { provider: "openai", voice: "nova" },
    };
    expect(voiceLifts()).toEqual({ bn: 1.04, en: 1.12 });
    expect(voiceKey()).not.toBe(keyBefore);
  });
});
