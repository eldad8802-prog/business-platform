/**
 * Who may run the reminder dispatcher (POST /api/task-reminders/dispatch). Same rules as the intake sweep
 * (lib/intake/sweep-auth.ts), bound to THIS route's URL:
 *
 *   QStash   a request carrying `Upstash-Signature` is accepted ONLY when the official SDK Receiver verifies it
 *            with QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY: issuer Upstash, not expired / not before,
 *            subject = the EXACT Production dispatch URL, body hash = this raw body. Both the per-reminder
 *            messages (published for the reminder's moment) and the safety-net schedule arrive this way.
 *   CRON     no signature header → the CRON_SECRET bearer (a manual or scheduled backstop).
 *
 * A request that carries a signature is judged by the signature alone. The dispatcher only dispatches: the
 * worst a valid caller can do is send a reminder that is due anyway.
 */
import { Receiver } from "@upstash/qstash";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

export const REMINDER_DISPATCH_URL = "https://promaxgroup.co.il/api/task-reminders/dispatch";
export const CLOCK_TOLERANCE_SECONDS = 5;

export type DispatchAuth =
  | { ok: true; via: "qstash" | "cron" }
  | { ok: false; status: 401 | 503; error: "unauthorized" | "invalid_signature" | "dispatch_not_configured" | "qstash_not_configured" };

type Env = Record<string, string | undefined>;

export async function authorizeReminderDispatch(
  input: { authorization: string | null; signature: string | null; body: string },
  env: Env = process.env,
): Promise<DispatchAuth> {
  const signature = (input.signature ?? "").trim();
  if (signature) {
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
  const decision = decideCronAuth(input.authorization, env);
  if (decision === "AUTHORIZED") return { ok: true, via: "cron" };
  if (decision === "NOT_CONFIGURED") return { ok: false, status: 503, error: "dispatch_not_configured" };
  return { ok: false, status: 401, error: "unauthorized" };
}
