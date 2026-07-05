import OpenAI from "openai";
import type { BotLlmPrompt } from "./types";

function getModel(): string {
  const m = process.env.BOT_LLM_MODEL?.trim();
  return m && m.length > 3 ? m : "gpt-4.1-mini";
}

/**
 * Real OpenAI completion for a bot reply DRAFT. Returns plain reply text, or
 * null on empty/failure (the orchestrator then yields no draft). Mirrors the
 * existing content-llm client pattern. Never throws to the caller.
 */
export async function completeBotLlmDraftOpenAI(
  prompt: BotLlmPrompt
): Promise<string | null> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const response = await client.chat.completions.create({
      model: getModel(),
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.6,
      max_tokens: 400,
    });
    const text = response.choices[0]?.message?.content ?? "";
    return text.trim() ? text : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bot-llm-draft] OPENAI_ERROR detail=${msg}`);
    return null;
  }
}
