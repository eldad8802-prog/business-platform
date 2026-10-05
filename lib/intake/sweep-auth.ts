/**
 * Who may run the intake sweep (POST /api/intake/sweep).
 *
 *   QStash (primary, ~10 min)   a request carrying `Upstash-Signature` is accepted ONLY when the
 *                               official SDK Receiver verifies it with QSTASH_CURRENT_SIGNING_KEY or
 *                               QSTASH_NEXT_SIGNING_KEY: issuer Upstash, not expired / not before,
 *                               subject = the EXACT Production sweep URL, body hash = this raw body.
 *                               No Dubiz secret is given to Upstash; the signing keys can only make
 *                               a request this route accepts — and this route only sweeps.
 *   CRON_SECRET (backstops)     no signature header → the existing bearer check (GitHub scheduled
 *                               workflow, daily Vercel cron), unchanged.
 *
 * No fallback: a request that carries a signature is judged by the signature alone — an invalid one
 * is refused even if it also carries a valid bearer. Dev-server keys are never accepted (devMode off)
 * and keys are never inferred from region headers: both keys must be configured, or QStash is refused.
 * Nothing about a signature or a key is ever logged.
 */
import { Receiver } from "@upstash/qstash";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/** The only destination a QStash signature is accepted for. */
export const SWEEP_URL = "https://promaxgroup.co.il/api/intake/sweep";

/** Seconds of clock skew tolerated on exp / nbf (Upstash ↔ Vercel). */
export const CLOCK_TOLERANCE_SECONDS = 5;

export type SweepAuth =
  | { ok: true; via: "qstash" | "cron" }
  | { ok: false; status: 401 | 503; error: "unauthorized" | "invalid_signature" | "sweep_not_configured" | "qstash_not_configured" };

type Env = Record<string, string | undefined>;

export async function authorizeSweep(
  input: { authorization: string | null; signature: string | null; body: string },
  env: Env = process.env
): Promise<SweepAuth> {
  const signature = (input.signature ?? "").trim();
  if (signature) {
    const currentSigningKey = env.QSTASH_CURRENT_SIGNING_KEY?.trim();
    const nextSigningKey = env.QSTASH_NEXT_SIGNING_KEY?.trim();
    if (!currentSigningKey || !nextSigningKey) return { ok: false, status: 503, error: "qstash_not_configured" };
    try {
      await new Receiver({ currentSigningKey, nextSigningKey, devMode: false }).verify({
        signature,
        body: input.body,
        url: SWEEP_URL,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      return { ok: true, via: "qstash" };
    } catch {
      return { ok: false, status: 401, error: "invalid_signature" };
    }
  }
  const decision = decideCronAuth(input.authorization, env);
  if (decision === "AUTHORIZED") return { ok: true, via: "cron" };
  if (decision === "NOT_CONFIGURED") return { ok: false, status: 503, error: "sweep_not_configured" };
  return { ok: false, status: 401, error: "unauthorized" };
}
