/**
 * Exact-moment scheduling of a reminder (owner-approved plan, section 2). SERVER-ONLY.
 *
 * After a write that sets or moves a reminder, one QStash message is published for the reminder's moment
 * (`notBefore`), addressed to the dispatcher. The message carries no data the dispatcher trusts: the dispatcher
 * re-reads what is due and claims it, so a stale message (the task was completed, cancelled or snoozed meanwhile)
 * does nothing, and a duplicate message is absorbed by the claim and by QStash deduplication.
 *
 * Needs QSTASH_TOKEN (publish). Without it nothing is published and the safety-net schedule (every few minutes)
 * and the in-app poll still deliver every reminder. Never throws into the caller's request.
 */
import { Client } from "@upstash/qstash";

import { REMINDER_DISPATCH_URL } from "./reminder-dispatch-auth";

type Env = Record<string, string | undefined>;

/**
 * A pasted env value as QStash expects it: the console's `.env` snippet is `QSTASH_TOKEN="…"`, so a copied line may
 * carry the name, the quotes or a trailing newline. Those are removed; the value itself is never changed.
 */
export function cleanEnvValue(raw: string | undefined, name: string): string | undefined {
  let v = raw?.trim();
  if (!v) return undefined;
  if (v.startsWith(`${name}=`)) v = v.slice(name.length + 1).trim();
  if (v.length >= 2 && (v[0] === `"` || v[0] === `'`) && v[v.length - 1] === v[0]) v = v.slice(1, -1).trim();
  return v || undefined;
}

/**
 * What a failed publish may log: the token's SHAPE only (length, whether it looks like a QStash token) and the
 * service's own answer with anything token-like masked. Never the token or a prefix of it.
 */
export function publishFailureFacts(raw: string | undefined, token: string, baseUrl: string, error: unknown): Record<string, unknown> {
  let decodesToUserId = false;
  try {
    decodesToUserId = "UserID" in JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    /* not a QStash token shape */
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    baseUrl,
    tokenLength: token.length,
    rawWasCleaned: raw?.trim() !== token,
    decodesToUserId,
    looksLikeSigningKey: token.startsWith("sig_"),
    answer: message.replace(/[A-Za-z0-9+/=_-]{24,}/g, "[masked]").slice(0, 300),
  };
}

export async function scheduleReminderMessage(taskId: number, remindAt: Date | null, env: Env = process.env): Promise<"published" | "skipped" | "failed"> {
  const token = cleanEnvValue(env.QSTASH_TOKEN, "QSTASH_TOKEN");
  if (!token || !remindAt || remindAt.getTime() <= Date.now()) return "skipped";
  const baseUrl = cleanEnvValue(env.QSTASH_URL, "QSTASH_URL") ?? "https://qstash.upstash.io";
  try {
    const client = new Client({ token, baseUrl });
    await client.publishJSON({
      url: REMINDER_DISPATCH_URL,
      body: { reason: "task_reminder" },
      notBefore: Math.floor(remindAt.getTime() / 1000),
      deduplicationId: `task-${taskId}-${remindAt.getTime()}`,
      retries: 3,
    });
    return "published";
  } catch (e) {
    console.error("[tasks] reminder publish failed", JSON.stringify(publishFailureFacts(env.QSTASH_TOKEN, token, baseUrl, e)));
    return "failed";
  }
}
