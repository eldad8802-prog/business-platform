/**
 * P3-C · The composer's ONLY model boundary — the one file in lib/services/landing that knows OpenAI.
 * Mirrors the M8 Brain provider (lib/knowledge/brain/provider.ts): same response contract, strict
 * json_schema output, fixed seed, bounded tokens, hard timeout, at most ONE transport retry on a
 * transient failure, no silent fallback to another model.
 *
 * OFF unless LANDING_COMPOSER_ENABLED === "true" (and OPENAI_API_KEY is present): merging P3-C changes
 * no Production behaviour and spends nothing until the owner turns it on. Server-only.
 */

import OpenAI from "openai";
import { openAiKeyPresent } from "@/lib/knowledge/brain/provider";
import type { ComposerModel } from "./landing-composer";

export const COMPOSER_LIMITS = { maxOutputTokens: 2_500, timeoutMs: 45_000, retries: 1 } as const;

export function composerEnabled(): boolean {
  return process.env.LANDING_COMPOSER_ENABLED === "true" && openAiKeyPresent();
}

export function composerModelName(): string {
  const m = process.env.LANDING_COMPOSER_MODEL?.trim();
  return m && m.length > 3 ? m : "gpt-4.1-mini";
}

/** Provider strict mode rejects some validation keywords; the runtime parser enforces them instead. */
export function providerSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(providerSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) if (k !== "maxLength" && k !== "maxItems") out[k] = providerSchema(v);
    return out;
  }
  return schema;
}

function classify(e: unknown): "TIMEOUT" | "RATE_LIMIT" | "PROVIDER_ERROR" {
  const status = (e as { status?: number })?.status;
  const name = e instanceof Error ? e.name : "";
  if (status === 429) return "RATE_LIMIT";
  if (/timeout|abort/i.test(name)) return "TIMEOUT";
  return "PROVIDER_ERROR";
}

export function openAiComposerProvider(): ComposerModel {
  const model = composerModelName();
  return {
    name: "openai",
    model,
    async complete(system, user, schema) {
      const started = Date.now();
      if (process.env.LANDING_COMPOSER_ENABLED !== "true") return { ok: false, reason: "DISABLED", latencyMs: 0 };
      if (!openAiKeyPresent()) return { ok: false, reason: "NO_KEY", latencyMs: 0 };
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: COMPOSER_LIMITS.timeoutMs, maxRetries: 0 });
      const jsonSchema = { name: schema.name, strict: true, schema: providerSchema(schema.schema) as Record<string, unknown> };
      for (let attempt = 0; attempt <= COMPOSER_LIMITS.retries; attempt += 1) {
        try {
          const r = await client.chat.completions.create({
            model,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            temperature: 0.3,
            seed: 7,
            max_tokens: COMPOSER_LIMITS.maxOutputTokens,
            response_format: { type: "json_schema", json_schema: jsonSchema },
          });
          const msg = r.choices[0]?.message;
          if (msg?.refusal) return { ok: false, reason: "REFUSAL", latencyMs: Date.now() - started };
          const text = msg?.content ?? "";
          if (!text.trim()) return { ok: false, reason: "EMPTY", latencyMs: Date.now() - started };
          return { ok: true, text, inputTokens: r.usage?.prompt_tokens ?? null, outputTokens: r.usage?.completion_tokens ?? null, latencyMs: Date.now() - started };
        } catch (e) {
          const reason = classify(e);
          if (attempt < COMPOSER_LIMITS.retries && (reason === "RATE_LIMIT" || reason === "TIMEOUT")) continue;
          return { ok: false, reason, latencyMs: Date.now() - started };
        }
      }
      return { ok: false, reason: "PROVIDER_ERROR", latencyMs: Date.now() - started };
    },
  };
}
