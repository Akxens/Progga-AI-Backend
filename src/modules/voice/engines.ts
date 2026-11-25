import { z } from "zod";
import { env } from "../../config/env";
import { HttpError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import type { SpeechLang } from "./speech-text";

// Text-to-speech engines for Progga's voice. Defaults come from .env; an admin can
// switch engine and voice at runtime from AI settings, which is saved in the DB.
// Bangla and English replies can each use their own engine and voice.

export const TTS_PROVIDER_IDS = ["elevenlabs", "indicf5", "openai", "gemini", "azure"] as const;
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

export interface VoiceOption {
  id: string;
  label: string;
  note?: string;
}

export interface TtsProviderInfo {
  id: TtsProviderId;
  label: string;
  configured: boolean;
  /** what the key needs to be in backend/.env */
  keyHint: string;
  model: string;
  /** how well it speaks Bangladeshi Bangla, shown to admins */
  bangla: string;
  voices: VoiceOption[];
  defaultVoice: string;
  /**
   * Playback speed-up the app applies with pitch preservation off, making the voice
   * sound younger. Adult voices need it; Gemini is already asked to sound like a kid.
   */
  lift: number;
}

// gpt-4o-mini-tts voices. coral, directed as a 10-year-old, stays the most youthful in both languages.
const OPENAI_VOICES: VoiceOption[] = [
  { id: "coral", label: "Coral", note: "Warm, youthful (default)" },
  { id: "marin", label: "Marin", note: "Natural, newest" },
  { id: "cedar", label: "Cedar", note: "Natural, newest" },
  { id: "nova", label: "Nova", note: "Bright" },
  { id: "shimmer", label: "Shimmer", note: "Soft" },
  { id: "sage", label: "Sage", note: "Calm" },
  { id: "ballad", label: "Ballad", note: "Expressive" },
  { id: "verse", label: "Verse", note: "Expressive" },
  { id: "alloy", label: "Alloy", note: "Neutral" },
  { id: "ash", label: "Ash", note: "Clear" },
  { id: "echo", label: "Echo", note: "Deep" },
  { id: "fable", label: "Fable", note: "Storyteller" },
  { id: "onyx", label: "Onyx", note: "Deep" },
];

// Gemini TTS prebuilt voices with Google's own one-word descriptions; the youthful,
// upbeat ones suit Progga best and are listed first.
const GEMINI_VOICES: VoiceOption[] = [
  ["Leda", "Youthful"], ["Puck", "Upbeat"], ["Laomedeia", "Upbeat"], ["Sadachbia", "Lively"], ["Fenrir", "Excitable"],
  ["Zephyr", "Bright"], ["Autonoe", "Bright"], ["Aoede", "Breezy"], ["Achird", "Friendly"], ["Sulafat", "Warm"],
  ["Vindemiatrix", "Gentle"], ["Achernar", "Soft"], ["Callirrhoe", "Easy-going"], ["Umbriel", "Easy-going"],
  ["Zubenelgenubi", "Casual"], ["Iapetus", "Clear"], ["Erinome", "Clear"], ["Despina", "Smooth"], ["Algieba", "Smooth"],
  ["Schedar", "Even"], ["Pulcherrima", "Forward"], ["Charon", "Informative"], ["Rasalgethi", "Informative"],
  ["Sadaltager", "Knowledgeable"], ["Kore", "Firm"], ["Orus", "Firm"], ["Alnilam", "Firm"], ["Enceladus", "Breathy"],
  ["Gacrux", "Mature"], ["Algenib", "Gravelly"],
].map(([id, note]) => ({ id, label: id, note }));

// Azure neural voices are tied to one language, so each choice pairs a Bangla voice
// with an English one for English replies.
const AZURE_VOICES: Record<string, { label: string; note: string; bn: string; bnLang: string; en: string }> = {
  nabanita: { label: "Nabanita", note: "Female · Bangladesh (bn-BD)", bn: "bn-BD-NabanitaNeural", bnLang: "bn-BD", en: "en-US-AnaNeural" },
  pradeep: { label: "Pradeep", note: "Male · Bangladesh (bn-BD)", bn: "bn-BD-PradeepNeural", bnLang: "bn-BD", en: "en-US-GuyNeural" },
  tanishaa: { label: "Tanishaa", note: "Female · India (bn-IN)", bn: "bn-IN-TanishaaNeural", bnLang: "bn-IN", en: "en-IN-NeerjaNeural" },
  bashkar: { label: "Bashkar", note: "Male · India (bn-IN)", bn: "bn-IN-BashkarNeural", bnLang: "bn-IN", en: "en-IN-PrabhatNeural" },
};

// ElevenLabs default voices that work on every plan (library voices need a paid plan).
// Any other voice id from the account (e.g. a custom or cloned voice) is accepted too.
const ELEVENLABS_VOICES: VoiceOption[] = [
  { id: "cgSgspJ2msm6clMCkdW9", label: "Jessica", note: "Playful, bright (default)" },
  { id: "FGY2WhTYpPnrIDTdsKH5", label: "Laura", note: "Upbeat, quirky" },
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily", note: "Warm, clear" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah", note: "Soft, reassuring" },
  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda", note: "Friendly" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice", note: "Clear, engaging" },
  { id: "IKne3meq5aSn9XLyUdCD", label: "Charlie", note: "Male, energetic" },
  { id: "JBFqnCBsd6RMkjVDRZzb", label: "George", note: "Male, warm" },
];

// Voices on the self-hosted IndicF5 server: each is a reference clip it clones (indicf5/voices).
let indicVoices: VoiceOption[] = [];

/** Asks the IndicF5 server which voices it has; keeps the last list if it is down. */
export async function refreshIndicVoices() {
  if (!env.INDICF5_URL) return;
  try {
    const res = await fetch(`${env.INDICF5_URL}/voices`, { signal: AbortSignal.timeout(3000) });
    const { voices } = (await res.json()) as { voices: string[] };
    indicVoices = voices.map((id) => ({ id, label: id, note: "Cloned from indicf5/voices" }));
  } catch {
    logger.warn({ url: env.INDICF5_URL }, "IndicF5 voice server is not reachable");
  }
}

export function ttsProviders(): TtsProviderInfo[] {
  return [
    {
      id: "elevenlabs",
      label: "ElevenLabs",
      configured: !!env.ELEVENLABS_API_KEY,
      keyHint: "ELEVENLABS_API_KEY",
      model: env.ELEVENLABS_MODEL,
      bangla: "Clear, natural Bangla (eleven_v3)",
      voices: ELEVENLABS_VOICES,
      defaultVoice: ELEVENLABS_VOICES[0].id,
      lift: 1.06,
    },
    {
      id: "indicf5",
      label: "IndicF5 (self-hosted)",
      configured: !!env.INDICF5_URL,
      keyHint: "INDICF5_URL (run indicf5/server.py)",
      model: "ai4bharat/IndicF5",
      bangla: "Bangla from AI4Bharat's Indic model on this machine; English replies use OpenAI",
      voices: indicVoices,
      defaultVoice: indicVoices[0]?.id ?? "progga",
      lift: 1.12,
    },
    {
      id: "gemini",
      label: "Google Gemini TTS",
      configured: !!env.GEMINI_API_KEY,
      keyHint: "GEMINI_API_KEY",
      model: env.GEMINI_TTS_MODEL,
      bangla: "Natural Bangla, follows the kid style directions",
      voices: GEMINI_VOICES,
      defaultVoice: "Leda",
      lift: 1.04,
    },
    {
      id: "azure",
      label: "Azure Speech",
      configured: !!env.AZURE_SPEECH_KEY && !!env.AZURE_SPEECH_REGION,
      keyHint: "AZURE_SPEECH_KEY + AZURE_SPEECH_REGION",
      model: "neural",
      bangla: "Native Bangladeshi voices (bn-BD), clear pronunciation",
      voices: Object.entries(AZURE_VOICES).map(([id, v]) => ({ id, label: v.label, note: v.note })),
      defaultVoice: "nabanita",
      lift: 1.12,
    },
    {
      id: "openai",
      label: "OpenAI GPT",
      configured: !!env.OPENAI_API_KEY,
      keyHint: "OPENAI_API_KEY",
      model: env.OPENAI_TTS_MODEL,
      bangla: "Understandable Bangla with a foreign accent",
      voices: OPENAI_VOICES,
      defaultVoice: env.OPENAI_TTS_VOICE,
      lift: 1.12,
    },
  ];
}

export const ttsProviderInfo = (id: TtsProviderId) => ttsProviders().find((p) => p.id === id)!;

/** One engine + voice. */
export const VoiceChoiceSchema = z.object({
  provider: z.enum(TTS_PROVIDER_IDS),
  voice: z.string().trim().min(1).max(60),
});
export type VoiceChoice = z.infer<typeof VoiceChoiceSchema>;

/** The Bangla (and default) voice, plus an optional different one for English replies. */
export const VoiceConfigSchema = VoiceChoiceSchema.extend({ en: VoiceChoiceSchema.optional() });
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/** Which engine and voice speak a reply in this language. */
export const choiceFor = (cfg: VoiceConfig, lang: SpeechLang): VoiceChoice =>
  lang === "en" && cfg.en ? cfg.en : { provider: cfg.provider, voice: cfg.voice };

/** The voice must be one the engine offers (OpenAI and ElevenLabs accept any id, for newer or custom voices). */
export function voiceExists(cfg: VoiceChoice): boolean {
  // the IndicF5 server may still be starting; it reports unknown voices itself
  if (cfg.provider === "openai" || cfg.provider === "elevenlabs" || (cfg.provider === "indicf5" && !indicVoices.length)) return true;
  return ttsProviderInfo(cfg.provider).voices.some((v) => v.id === cfg.voice);
}

/** Both languages' engines have their keys and the voices exist. */
export const usable = (cfg: VoiceConfig) =>
  [cfg, ...(cfg.en ? [cfg.en] : [])].every((c) => ttsProviderInfo(c.provider).configured && voiceExists(c));

const SETTING_KEY = "voice.config";
const TTL_MS = 15_000;

function envDefault(): VoiceConfig {
  // ElevenLabs when it has a key (the default voice), then OpenAI, then whatever is set up
  const p =
    ttsProviders().find((x) => x.id === "elevenlabs" && x.configured) ??
    ttsProviders().find((x) => x.id === "openai" && x.configured) ??
    ttsProviders().find((x) => x.configured) ??
    ttsProviderInfo("openai");
  return { provider: p.id, voice: p.defaultVoice };
}

let current: VoiceConfig = envDefault();
let loadedAt = 0;
let inflight: Promise<VoiceConfig> | null = null;

export const getVoiceConfig = () => current;

async function fetchVoiceConfig(): Promise<VoiceConfig> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    if (row) {
      let raw: unknown;
      try {
        raw = JSON.parse(row.value);
      } catch {
        logger.warn("Saved voice settings contain invalid JSON; using fallback defaults");
        loadedAt = Date.now();
        return current;
      }
      const parsed = VoiceConfigSchema.safeParse(raw);
      if (parsed.success && usable(parsed.data)) current = parsed.data;
      else logger.warn("Saved voice settings are invalid or missing an API key; using .env defaults");
    }
    loadedAt = Date.now();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Couldn't load voice settings");
  }
  return current;
}

/** Returns the active voice config, refreshing from DB at most once every 15s (or when forced). */
export async function ensureVoiceConfig(force = false): Promise<VoiceConfig> {
  if (!force && loadedAt > 0 && Date.now() - loadedAt < TTL_MS) return current;
  if (!inflight) {
    inflight = fetchVoiceConfig().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Loads the admin-chosen voice from the DB (falls back to .env if unset or no longer usable). */
export async function loadVoiceConfig() {
  await refreshIndicVoices();
  await ensureVoiceConfig(true);
}

export async function saveVoiceConfig(cfg: VoiceConfig) {
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: JSON.stringify(cfg) },
    update: { value: JSON.stringify(cfg) },
  });
  current = cfg;
  loadedAt = Date.now();
}

// ── Speaking ─────────────────────────────────────────────

/** Audio as it arrives from the engine, so the first words can play while the rest downloads. */
export interface SpeechAudio {
  contentType: string;
  chunks: AsyncIterable<Uint8Array>;
  /** fixes up the whole clip before it is saved (e.g. a streamed WAV's placeholder sizes) */
  finalize?: (whole: Buffer) => Buffer;
}

/** How Progga should sound: a kid, so students hear a friend learning alongside them rather than a teacher. */
function kidDirections(lang: SpeechLang): string {
  // Tested on reply-length text: without the "throughout the whole passage" line, voices drift
  // back into an adult register after the first sentence.
  const base =
    "Identity: a 10-year-old child: Progga, the cheerful robot buddy of a school student in Bangladesh. You ARE a kid, not an adult doing a voice. " +
    "Pitch: high and light, like a young child, throughout the WHOLE passage, never dropping into an adult register, even in long sentences. " +
    // the app plays clips slightly faster (and so younger-sounding), so ask for an unhurried pace
    "Tone: bubbly, excited, curious, smiling. Pace: unhurried and clear, noticeably slower than a normal chat, with short pauses between sentences. " +
    "Volume: full and well projected; never whisper or trail off. When reading maths, say each number and operation clearly.";
  return lang === "bn"
    ? `${base} Speak in natural Bangladeshi Bangla with standard Dhaka pronunciation. Read digits as Bangla numbers.`
    : `${base} Speak simple, clear English.`;
}

const unavailable = (label: string) => new HttpError(503, `Progga's voice (${label}) isn't available right now.`, "tts_error");

async function call(label: string, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const combined = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: combined });
  } catch (err) {
    if (signal?.aborted) throw err;
    logger.error({ err: (err as Error).message, engine: label }, "TTS request failed");
    throw new HttpError(503, "Progga's voice is taking a nap. Please try again.", "tts_timeout");
  }
  if (!res.ok || !res.body) {
    logger.error({ status: res.status, engine: label, detail: (await res.text().catch(() => "")).slice(0, 300) }, "TTS API error");
    throw unavailable(label);
  }
  return res;
}

async function* readBody(res: Response, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  const reader = res.body!.getReader();
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => undefined);
  }
}

// Realtime models only speak these voices; anything else falls back to coral.
const REALTIME_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const REALTIME_RATE = 24_000; // 16-bit mono PCM

/** 44-byte WAV header for 16-bit mono PCM, so the browser can play the raw realtime audio. */
function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(REALTIME_RATE, 24);
  h.writeUInt32LE(REALTIME_RATE * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** A streamed WAV doesn't know its length yet: these placeholder sizes mean "until the stream ends". */
const STREAM_BYTES = 0x7fffffff;

/** Writes the real sizes into a finished streamed WAV, so the saved copy is a normal file. */
function fixWavSizes(whole: Buffer): Buffer {
  if (whole.length < 44 || whole.toString("latin1", 0, 4) !== "RIFF") return whole;
  const out = Buffer.from(whole);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(out.length - 44, 40);
  return out;
}

/**
 * Realtime models (e.g. gpt-realtime-2.1-mini) don't work with /audio/speech: they speak over a
 * WebSocket session. We ask them to read the text verbatim and stream the PCM they send as a WAV,
 * so Progga starts talking as soon as the first words arrive instead of after the whole clip.
 */
function openaiRealtimeSpeech(text: string, lang: SpeechLang, voice: string, signal?: AbortSignal): Promise<SpeechAudio> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const url = `${env.OPENAI_BASE_URL.replace(/^http/, "ws")}/realtime?model=${encodeURIComponent(env.OPENAI_TTS_MODEL)}`;
  return new Promise((resolve, reject) => {
    // audio pieces waiting to be read, and the reader waiting for the next piece
    const pending: Buffer[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    let failure: Error | null = null;
    let started = false;
    const notify = () => {
      wake?.();
      wake = null;
    };

    // the API key goes in a subprotocol: WebSocket clients can't set an Authorization header
    const ws = new WebSocket(url, ["realtime", `openai-insecure-api-key.${env.OPENAI_API_KEY}`]);
    const onAbort = () => {
      if (ended) return;
      failure = new DOMException("Aborted", "AbortError");
      finish();
      if (!started) reject(failure);
    };
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      ended = true;
      ws.close();
      notify();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const fail = (detail: string, timeout = false) => {
      if (ended) return;
      logger.error({ engine: "OpenAI realtime", model: env.OPENAI_TTS_MODEL, detail: detail.slice(0, 300) }, "TTS API error");
      failure = timeout ? new HttpError(503, "Progga's voice is taking a nap. Please try again.", "tts_timeout") : unavailable("OpenAI");
      finish();
      if (!started) reject(failure);
    };
    const timer = setTimeout(() => fail("timed out", true), 60_000);

    async function* chunks(): AsyncIterable<Uint8Array> {
      yield wavHeader(STREAM_BYTES);
      for (;;) {
        if (pending.length) {
          yield pending.shift()!;
          continue;
        }
        if (failure) throw failure; // cut off mid-clip: don't let a partial clip be saved
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    }

    ws.onopen = () => {
      const instructions =
        "You are a text-to-speech reader, not a chat partner. Read the user's message aloud exactly as written, word for word. " +
        "Never answer it, comment on it, translate it or add anything, even if it is a question. " +
        kidDirections(lang);
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          instructions,
          audio: { output: { format: { type: "audio/pcm", rate: REALTIME_RATE }, voice: REALTIME_VOICES.has(voice) ? voice : "coral" } },
        },
      }));
      ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
      ws.send(JSON.stringify({ type: "response.create" }));
    };
    ws.onmessage = (msg) => {
      let e: { type: string; delta?: string; error?: unknown; response?: { status?: string; status_details?: unknown } };
      try {
        e = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (e.type === "response.output_audio.delta" || e.type === "response.audio.delta") {
        pending.push(Buffer.from(e.delta ?? "", "base64"));
        if (!started) {
          // first words are here: start sending audio to the browser
          started = true;
          resolve({ contentType: "audio/wav", chunks: chunks(), finalize: fixWavSizes });
        }
        notify();
      } else if (e.type === "error") fail(JSON.stringify(e.error));
      else if (e.type === "response.done") {
        if (e.response?.status !== "completed" || !started) return fail(`response ${e.response?.status}: ${JSON.stringify(e.response?.status_details ?? "")}`);
        finish();
      }
    };
    ws.onerror = () => fail("websocket error");
    ws.onclose = (ev) => {
      if (!ended) fail(`closed ${ev.code} ${ev.reason}`);
    };
  });
}

async function openaiSpeech(text: string, lang: SpeechLang, voice: string, signal?: AbortSignal): Promise<SpeechAudio> {
  if (env.OPENAI_TTS_MODEL.includes("realtime")) return openaiRealtimeSpeech(text, lang, voice, signal);
  const res = await call(
    "OpenAI",
    `${env.OPENAI_BASE_URL}/audio/speech`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.OPENAI_TTS_MODEL, voice, input: text, instructions: kidDirections(lang), response_format: "mp3" }),
    },
    30_000,
    signal,
  );
  return { contentType: "audio/mpeg", chunks: readBody(res, signal) };
}

async function geminiSpeech(text: string, lang: SpeechLang, voice: string, signal?: AbortSignal): Promise<SpeechAudio> {
  // Gemini reads `text` word for word; how to say it goes in speech_metadata.style.
  const res = await call(
    "Gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_TTS_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text, speech_metadata: { style: kidDirections(lang) } }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { voice } } },
      }),
    },
    60_000,
    signal,
  );
  const json = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  } | null;
  const audio = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!audio?.data) {
    logger.error({ detail: JSON.stringify(json).slice(0, 300) }, "Gemini TTS returned no audio");
    throw unavailable("Gemini");
  }
  const bytes = Buffer.from(audio.data, "base64");
  // the default reply is a complete WAV file (24 kHz mono 16-bit)
  return { contentType: "audio/wav", chunks: (async function* () { yield bytes; })() };
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

async function azureSpeech(text: string, lang: SpeechLang, voice: string, signal?: AbortSignal): Promise<SpeechAudio> {
  const v = AZURE_VOICES[voice] ?? AZURE_VOICES.nabanita;
  const [name, xmlLang] = lang === "bn" ? [v.bn, v.bnLang] : [v.en, v.en.slice(0, 5)];
  // a touch higher and slower than normal: friendlier for kids (the app's playback lift adds the rest)
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLang}">` +
    `<voice name="${name}"><prosody pitch="+8%" rate="-8%">${xmlEscape(text)}</prosody></voice></speak>`;
  const res = await call(
    "Azure",
    `https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY!,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
        "User-Agent": "progga-api",
      },
      body: ssml,
    },
    30_000,
    signal,
  );
  return { contentType: "audio/mpeg", chunks: readBody(res, signal) };
}

async function elevenlabsSpeech(text: string, lang: SpeechLang, voice: string, signal?: AbortSignal): Promise<SpeechAudio> {
  // the stream endpoint sends MP3 as it is generated, so the first words play within about a second
  const res = await call(
    "ElevenLabs",
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: env.ELEVENLABS_MODEL,
        language_code: lang,
        // v3 takes 0, 0.5 or 1: 0.5 keeps the voice steady but still lively
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
    60_000,
    signal,
  );
  return { contentType: "audio/mpeg", chunks: readBody(res, signal) };
}

async function indicf5Speech(text: string, voice: string, signal?: AbortSignal): Promise<SpeechAudio> {
  // generous timeout: the GPU is shared with the tutor's model
  const res = await call(
    "IndicF5",
    `${env.INDICF5_URL}/tts`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice }) },
    120_000,
    signal,
  );
  return { contentType: "audio/wav", chunks: readBody(res, signal) };
}

/** Speaks `text` (already turned into plain words) with the engine and voice set for its language. */
export function synthesize(config: VoiceConfig, text: string, lang: SpeechLang, signal?: AbortSignal): Promise<SpeechAudio> {
  const cfg = choiceFor(config, lang);
  if (cfg.provider === "elevenlabs") return elevenlabsSpeech(text, lang, cfg.voice, signal);
  if (cfg.provider === "indicf5") {
    // IndicF5 only knows Indian languages, so English replies go to OpenAI when it has a key
    return lang === "en" && env.OPENAI_API_KEY ? openaiSpeech(text, lang, env.OPENAI_TTS_VOICE, signal) : indicf5Speech(text, cfg.voice, signal);
  }
  if (cfg.provider === "gemini") return geminiSpeech(text, lang, cfg.voice, signal);
  if (cfg.provider === "azure") return azureSpeech(text, lang, cfg.voice, signal);
  return openaiSpeech(text, lang, cfg.voice, signal);
}
