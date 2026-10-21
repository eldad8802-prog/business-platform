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

export async function scheduleReminderMessage(taskId: number, remindAt: Date | null, env: Env = process.env): Promise<"published" | "skipped" | "failed"> {
  const token = env.QSTASH_TOKEN?.trim();
  if (!token || !remindAt || remindAt.getTime() <= Date.now()) return "skipped";
  try {
    const client = new Client({ token, ...(env.QSTASH_URL?.trim() ? { baseUrl: env.QSTASH_URL.trim() } : {}) });
    await client.publishJSON({
      url: REMINDER_DISPATCH_URL,
      body: { reason: "task_reminder" },
      notBefore: Math.floor(remindAt.getTime() / 1000),
      deduplicationId: `task-${taskId}-${remindAt.getTime()}`,
      retries: 3,
    });
    return "published";
  } catch {
    return "failed";
  }
}
