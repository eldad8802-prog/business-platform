/**
 * LLM Draft feature flags — DEFAULT OFF. Three modes:
 *
 *   off     — master flag off (or no key). No prompt, no model call, no record.
 *   shadow  — master ON + `BOT_LLM_DRAFTS_SHADOW === "true"`. The generator runs
 *             and metrics are recorded, but NO visible LLM_DRAFT is saved and
 *             nothing is shown to the owner (measurement only).
 *   visible — master ON + shadow OFF. A visible LLM_DRAFT (GENERATED) is saved
 *             for the owner to review. Still draft-only — never auto-sent.
 *
 * Master flag: `BOT_LLM_DRAFTS_ENABLED === "true"` AND a present OPENAI_API_KEY.
 */
export type BotLlmDraftMode = "off" | "shadow" | "visible";

export type BotLlmDraftDiagnostics = {
  flagRaw: string | undefined;
  shadowRaw: string | undefined;
  openAiKeyPresent: boolean;
  mode: BotLlmDraftMode;
  reasonIfDisabled: string;
};

export function getBotLlmDraftDiagnostics(): BotLlmDraftDiagnostics {
  const raw = process.env.BOT_LLM_DRAFTS_ENABLED;
  const shadowRaw = process.env.BOT_LLM_DRAFTS_SHADOW;
  const key = process.env.OPENAI_API_KEY;
  const keyOk = typeof key === "string" && key.length > 10;
  const flagOk = raw === "true";
  const shadowOn = shadowRaw === "true";
  const parts: string[] = [];
  if (!flagOk) {
    parts.push(
      `BOT_LLM_DRAFTS_ENABLED is not "true" (got: ${raw === undefined ? "undefined" : JSON.stringify(raw)})`
    );
  }
  if (!keyOk) {
    parts.push("OPENAI_API_KEY missing or too short");
  }
  const mode: BotLlmDraftMode = !(flagOk && keyOk)
    ? "off"
    : shadowOn
      ? "shadow"
      : "visible";
  return {
    flagRaw: raw,
    shadowRaw,
    openAiKeyPresent: keyOk,
    mode,
    reasonIfDisabled: parts.length ? parts.join(" | ") : "ok",
  };
}

export function resolveBotLlmDraftMode(): BotLlmDraftMode {
  return getBotLlmDraftDiagnostics().mode;
}

/** True when the generator should run at all (shadow OR visible). */
export function isBotLlmDraftsEnabled(): boolean {
  return resolveBotLlmDraftMode() !== "off";
}

/**
 * Full-text logging switch — DEFAULT OFF. When off, shadow/visible metrics are
 * METADATA ONLY (lengths, types, reason codes) — no message/draft content ever
 * reaches the logs (PII-safe). Only when `BOT_LLM_DRAFTS_LOG_TEXT === "true"`
 * are the LLM draft + prior-draft texts recorded, for qualitative comparison.
 */
export function isBotLlmDraftsLogTextEnabled(): boolean {
  return process.env.BOT_LLM_DRAFTS_LOG_TEXT === "true";
}

/**
 * Sample rate for running the (cost-bearing) LLM in shadow/visible — DEFAULT 0.
 * `BOT_LLM_DRAFTS_SAMPLE_RATE` in [0,1]. Unset / non-numeric / <=0 → 0 (never
 * run). >=1 → always run. Anything between → that fraction of messages.
 */
export function getBotLlmDraftSampleRate(): number {
  const raw = process.env.BOT_LLM_DRAFTS_SAMPLE_RATE;
  if (raw == null || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1 ? 1 : n;
}

/**
 * Daily cap on actual LLM calls — DEFAULT 0 (fail-closed). `BOT_LLM_DRAFTS_DAILY_CAP`
 * must be an explicit positive integer to allow ANY model calls. Unset /
 * non-numeric / <=0 → 0 → nothing runs. This is the safest default: shadow only
 * incurs cost when BOTH a sample rate AND a daily cap are set on purpose, so a
 * traffic spike or a forgotten flag can never surprise us with cost.
 */
export function getBotLlmDraftDailyCap(): number {
  const raw = process.env.BOT_LLM_DRAFTS_DAILY_CAP;
  if (raw == null || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** Deterministic [0,1) bucket from an integer key (Knuth multiplicative hash). */
function sampleBucket(key: number): number {
  const h = Math.abs(Math.imul(key | 0, 2654435761)) % 100000;
  return h / 100000;
}

/**
 * Deterministic sampling decision — same (key, rate) always yields the same
 * result (keyed on messageId), so behaviour is testable and stable, not random.
 */
export function isBotLlmDraftSampledIn(key: number, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return sampleBucket(key) < rate;
}
