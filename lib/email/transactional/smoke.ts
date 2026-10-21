/**
 * TEMPORARY — one Resend smoke send from Production, to prove the configured provider credential,
 * sender and domain end to end without creating a user, a business or an outbox row.
 *
 * Owner-approved scope (2026-10-21): ONE message, to ONE fixed recipient, with the sender and
 * reply-to Dubiz actually uses (TRANSACTIONAL_EMAIL_FROM / _REPLY_TO, read like delivery reads them),
 * through the existing Resend adapter. Nothing here takes input from the request: recipient, subject
 * and body are constants. No database, no tenant context, no business data.
 *
 * Bounded to at most one send by independent layers, each sufficient on its own in its own failure
 * mode:
 *   1. lifetime   — after SMOKE_NOT_AFTER this answers "expired" and does nothing (even if the route
 *                   were never removed).
 *   2. latch      — the TRANSACTIONAL_EMAIL_SMOKE rate-limit bucket: ONE admission, globally, per 30
 *                   days (longer than the lifetime), in the shared Production Redis, fail-CLOSED. It is
 *                   consumed BEFORE the provider call, so a failed attempt is not retried either.
 *   3. provider   — a fixed Idempotency-Key: Resend answers a repeat within 24h with the first result.
 * The route adds CRON_SECRET; the workflow adds owner-only, main-only, typed confirmation, no re-run.
 *
 * Logs and the answer carry the outcome, a machine code and the provider message id only — never
 * the address, the sender or the body. Remove this file, the route, the workflow and the bucket
 * together after the test.
 */

import { checkRateLimit } from "@/lib/security/rate-limiter";

import { readTransactionalEmailConfig, type TransactionalEmailEnv } from "./config";
import type { EmailProvider, OutboundEmail } from "./provider";
import { createResendProvider } from "./resend";

/** The one recipient this route can ever address (owner-designated test inbox). */
export const SMOKE_RECIPIENT = "eldad8804@gmail.com";
export const SMOKE_SUBJECT = "בדיקת מייל — Dubiz";
/** Fixed: a repeat inside Resend's 24h idempotency window returns the first message, never a second. */
export const SMOKE_IDEMPOTENCY_KEY = "smoke:resend:2026-10-21";
/** Past this instant the smoke send is dead code: no latch, no network. */
export const SMOKE_NOT_AFTER = new Date("2026-11-04T00:00:00Z");

export const SMOKE_TEXT = [
  "זוהי הודעת בדיקה אחת מתשתית המיילים של Dubiz.",
  "היא נשלחה כדי לוודא שהשליחה דרך ספק המיילים פועלת. אין צורך להשיב.",
].join("\n\n");

export const SMOKE_HTML =
  '<!doctype html><html lang="he" dir="rtl"><body style="font-family:Arial,sans-serif;direction:rtl;text-align:right">' +
  "<p>זוהי הודעת בדיקה אחת מתשתית המיילים של Dubiz.</p>" +
  "<p>היא נשלחה כדי לוודא שהשליחה דרך ספק המיילים פועלת. אין צורך להשיב.</p>" +
  "</body></html>";

export type SmokeOutcome =
  | "expired"
  | "disabled"
  | "not_configured"
  | "already_used"
  | "latch_unavailable"
  | "sent"
  | "retryable"
  | "permanent";

export type SmokeResult = {
  outcome: SmokeOutcome;
  providerMessageId: string | null;
  code: string | null;
};

export type SmokeDeps = {
  now: () => Date;
  env: TransactionalEmailEnv;
  /** One admission ever (see layer 2). `unavailable` = the backend could not decide: deny. */
  latch: () => Promise<"admitted" | "used" | "unavailable">;
  provider: (apiKey: string) => EmailProvider;
};

async function redisLatch(): Promise<"admitted" | "used" | "unavailable"> {
  try {
    const d = await checkRateLimit({ bucket: "TRANSACTIONAL_EMAIL_SMOKE" });
    if (d.allowed) return "admitted";
    return d.outcome === "backend_unavailable" ? "unavailable" : "used";
  } catch {
    // A configuration error (no Redis configured) is a refusal too: fail closed.
    return "unavailable";
  }
}

function defaultDeps(): SmokeDeps {
  return {
    now: () => new Date(),
    env: process.env,
    latch: redisLatch,
    provider: (apiKey) => createResendProvider({ apiKey }),
  };
}

function result(outcome: SmokeOutcome, code: string | null = null, providerMessageId: string | null = null): SmokeResult {
  console.info("[transactional-email] smoke", { outcome, code, providerMessageId });
  return { outcome, providerMessageId, code };
}

export async function runSmokeSend(deps: SmokeDeps = defaultDeps()): Promise<SmokeResult> {
  if (deps.now().getTime() >= SMOKE_NOT_AFTER.getTime()) return result("expired");

  // The same switch and configuration delivery uses: OFF or misconfigured sends nothing and does
  // not spend the latch.
  const state = readTransactionalEmailConfig(deps.env);
  if (!state.enabled) return result("disabled", state.error);
  if (!state.ok) return result("not_configured", state.missing.join(","));

  const latch = await deps.latch();
  if (latch === "used") return result("already_used");
  if (latch === "unavailable") return result("latch_unavailable");

  const message: OutboundEmail = {
    idempotencyKey: SMOKE_IDEMPOTENCY_KEY,
    from: state.config.from,
    replyTo: state.config.replyTo,
    to: SMOKE_RECIPIENT,
    subject: SMOKE_SUBJECT,
    html: SMOKE_HTML,
    text: SMOKE_TEXT,
  };
  const sent = await deps.provider(state.config.apiKey).send(message);
  if (sent.outcome === "sent") return result("sent", null, sent.providerMessageId);
  return result(sent.outcome, sent.code);
}
