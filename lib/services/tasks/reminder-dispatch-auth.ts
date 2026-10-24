/**
 * Who may run the reminder dispatcher (POST /api/task-reminders/dispatch): QStash, and nobody else.
 *
 * A request is accepted ONLY when it carries `Upstash-Signature` and the official SDK Receiver verifies it with
 * QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY: issuer Upstash, not expired / not before, subject = the
 * EXACT Production dispatch URL, body hash = this raw body. Both the per-reminder messages (published for the
 * reminder's moment) and the safety-net schedule arrive this way. Without a signature the answer is 401; without
 * the keys, 503 (fail closed). Deliberately NO CRON_SECRET path: the scheduler is QStash, and the bearer's callers
 * stay exactly the ones its own scope test pins.
 *
 * The dispatcher only dispatches: the worst a valid caller can do is send a reminder that is due anyway.
 */
import { Receiver } from "@upstash/qstash";

export const REMINDER_DISPATCH_URL = "https://promaxgroup.co.il/api/task-reminders/dispatch";
export const CLOCK_TOLERANCE_SECONDS = 5;

export type DispatchAuth =
  | { ok: true; via: "qstash" }
  | { ok: false; status: 401 | 503; error: "unauthorized" | "invalid_signature" | "qstash_not_configured" };

type Env = Record<string, string | undefined>;

export async function authorizeReminderDispatch(
  input: { signature: string | null; body: string },
  env: Env = process.env,
): Promise<DispatchAuth> {
  const signature = (input.signature ?? "").trim();
  if (!signature) return { ok: false, status: 401, error: "unauthorized" };
  const currentSigningKey = env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!currentSigningKey || !nextSigningKey) return { ok: false, status: 503, error: "qstash_not_configured" };
  try {
    await new Receiver({ currentSigningKey, nextSigningKey, devMode: false }).verify({
      signature,
      body: input.body,
      url: REMINDER_DISPATCH_URL,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    return { ok: true, via: "qstash" };
  } catch {
    return { ok: false, status: 401, error: "invalid_signature" };
  }
}
