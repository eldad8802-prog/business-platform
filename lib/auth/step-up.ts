/**
 * STEP-UP — fresh proof of the password before a destructive action (M-9).
 *
 * A bearer token alone proves only that someone holds a token. Deleting the
 * account or signing every other device out are acts a stolen token must not be
 * able to perform, so they additionally require a step-up token, obtained from
 * POST /api/auth/step-up by re-entering the password.
 *
 * The step-up token is:
 *   - short-lived: 5 minutes;
 *   - bound to sub + sid + tokenVersion: useless from another device, and dead
 *     the moment the user's generation moves (logout, password change/reset);
 *   - bound to ONE action: a token minted for "sessions.revoke_others" cannot
 *     delete the account;
 *   - single-use: its nonce is consumed on the shared limiter backend (Redis in
 *     production) the first time it is accepted, fail-CLOSED if the backend is
 *     unreachable. No schema.
 *
 * Tokens that name no session (pre-rollout, sid-less) cannot obtain one.
 */

import { consumeOnce } from "@/lib/security/rate-limiter";
import { openEnvelope, randomNonce, sealEnvelope } from "./signed-envelope";

const LABEL = "dubiz-step-up-v1";
const VERSION = 1;
export const STEP_UP_TTL_SECONDS = 5 * 60;
export const STEP_UP_HEADER = "x-step-up";

export const STEP_UP_ACTIONS = ["account.delete", "sessions.revoke_others"] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export function isStepUpAction(value: unknown): value is StepUpAction {
  return typeof value === "string" && (STEP_UP_ACTIONS as readonly string[]).includes(value);
}

export type StepUpBinding = { userId: number; sessionId: string; tokenVersion: number };

export function issueStepUpToken(binding: StepUpBinding, action: StepUpAction, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  return sealEnvelope(LABEL, {
    v: VERSION,
    act: action,
    sub: binding.userId,
    sid: binding.sessionId,
    tv: binding.tokenVersion,
    n: randomNonce(),
    iat,
    exp: iat + STEP_UP_TTL_SECONDS,
  });
}

export type StepUpVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing"
        | "invalid"
        | "expired"
        | "wrong_action"
        | "binding_mismatch"
        | "reused"
        | "unavailable";
    };

/**
 * Verify and CONSUME. Call only once the rest of the request is known to be
 * acceptable up to this point — a consumed token is gone.
 */
export async function verifyAndConsumeStepUp(
  raw: string | null,
  binding: { userId: number; sessionId: string | null; tokenVersion: number },
  action: StepUpAction,
  nowMs = Date.now()
): Promise<StepUpVerdict> {
  if (!raw) return { ok: false, reason: "missing" };
  const p = openEnvelope(LABEL, raw);
  if (!p || p.v !== VERSION || typeof p.n !== "string" || !Number.isInteger(p.exp)) {
    return { ok: false, reason: "invalid" };
  }
  if (Math.floor(nowMs / 1000) >= (p.exp as number)) return { ok: false, reason: "expired" };
  if (p.act !== action) return { ok: false, reason: "wrong_action" };
  if (
    binding.sessionId === null ||
    p.sub !== binding.userId ||
    p.sid !== binding.sessionId ||
    p.tv !== binding.tokenVersion
  ) {
    return { ok: false, reason: "binding_mismatch" };
  }
  const once = await consumeOnce("step-up", p.n as string, STEP_UP_TTL_SECONDS + 60);
  if (once === "reused") return { ok: false, reason: "reused" };
  if (once === "unavailable") return { ok: false, reason: "unavailable" };
  return { ok: true };
}

export function readStepUpHeader(req: Request): string | null {
  return req.headers.get(STEP_UP_HEADER);
}

/** The body a destructive route returns when step-up is missing or unusable. */
export function stepUpRequiredBody(verdict: Exclude<StepUpVerdict, { ok: true }>) {
  return {
    error: "Re-enter your password to continue",
    code: verdict.reason === "unavailable" ? "STEP_UP_UNAVAILABLE" : "STEP_UP_REQUIRED",
  };
}
