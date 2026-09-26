/**
 * M8 · The one provider boundary. The Brain talks to a `BrainProvider`; only this file knows OpenAI.
 *
 * Explicit, observable configuration: provider "openai", model from BRAIN_LLM_MODEL (default
 * gpt-4.1-mini, the model the product already uses for bot drafts), strict JSON-schema output,
 * temperature 0 and a fixed seed (best-effort reproducibility — the provider does not guarantee
 * identical text), bounded output tokens, a hard timeout, and at most ONE retry on a transient
 * failure. No silent fallback to another provider or model.
 *
 * Server-only: this module reads OPENAI_API_KEY and must never be imported by client code — asserted
 * statically by brain.eval.test.ts (no "use client" module may import it).
 */

import OpenAI from "openai";
import { RAW_RESULT_JSON_SCHEMA } from "./brain.contract";

export type ProviderResponse =
  | { ok: true; text: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number }
  | { ok: false; reason: "NO_KEY" | "TIMEOUT" | "RATE_LIMIT" | "PROVIDER_ERROR" | "REFUSAL" | "EMPTY"; latencyMs: number };

export interface BrainProvider {
  readonly name: string;
  readonly model: string;
  complete(system: string, user: string): Promise<ProviderResponse>;
}

export const BRAIN_LIMITS = {
  maxOutputTokens: 1_200,
  timeoutMs: 25_000,
  retries: 1,
} as const;

export function brainModel(): string {
  const m = process.env.BRAIN_LLM_MODEL?.trim();
  return m && m.length > 3 ? m : "gpt-4.1-mini";
}

export function openAiKeyPresent(): boolean {
  const k = process.env.OPENAI_API_KEY;
  return typeof k === "string" && k.length > 10;
}

function classify(e: unknown): "TIMEOUT" | "RATE_LIMIT" | "PROVIDER_ERROR" {
  const status = (e as { status?: number })?.status;
  const name = e instanceof Error ? e.name : "";
  if (status === 429) return "RATE_LIMIT";
  if (/timeout|abort/i.test(name)) return "TIMEOUT";
  return "PROVIDER_ERROR";
}

export function openAiBrainProvider(): BrainProvider {
  const model = brainModel();
  return {
    name: "openai",
    model,
    async complete(system, user) {
      const started = Date.now();
      if (!openAiKeyPresent()) return { ok: false, reason: "NO_KEY", latencyMs: 0 };
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: BRAIN_LIMITS.timeoutMs, maxRetries: 0 });
      for (let attempt = 0; attempt <= BRAIN_LIMITS.retries; attempt += 1) {
        try {
          const r = await client.chat.completions.create({
            model,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            temperature: 0,
            seed: 7,
            max_tokens: BRAIN_LIMITS.maxOutputTokens,
            response_format: { type: "json_schema", json_schema: RAW_RESULT_JSON_SCHEMA as unknown as { name: string; strict: boolean; schema: Record<string, unknown> } },
          });
          const msg = r.choices[0]?.message;
          if (msg?.refusal) return { ok: false, reason: "REFUSAL", latencyMs: Date.now() - started };
          const text = msg?.content ?? "";
          if (!text.trim()) return { ok: false, reason: "EMPTY", latencyMs: Date.now() - started };
          return { ok: true, text, inputTokens: r.usage?.prompt_tokens ?? null, outputTokens: r.usage?.completion_tokens ?? null, latencyMs: Date.now() - started };
        } catch (e) {
          const reason = classify(e);
          // One retry, only for transient conditions. Never a loop.
          if (attempt < BRAIN_LIMITS.retries && (reason === "RATE_LIMIT" || reason === "TIMEOUT")) continue;
          return { ok: false, reason, latencyMs: Date.now() - started };
        }
      }
      return { ok: false, reason: "PROVIDER_ERROR", latencyMs: Date.now() - started };
    },
  };
}
