/**
 * Browser half of step-up (M-9): trade the password for a single-use,
 * 5-minute token for ONE action, then send it as `x-step-up` on that action's
 * request. The password is sent once, over the same channel login uses, and is
 * never stored.
 */

import { buildClientAuthHeaders } from "@/lib/client-session";

export type StepUpClientAction = "account.delete" | "sessions.revoke_others";

export type StepUpClientResult =
  | { ok: true; token: string }
  | { ok: false; reason: "wrong_password" | "unauthorized" | "rate_limited" | "refresh_required" | "failed" };

export async function obtainStepUpToken(
  password: string,
  action: StepUpClientAction
): Promise<StepUpClientResult> {
  try {
    const res = await fetch("/api/auth/step-up", {
      method: "POST",
      headers: buildClientAuthHeaders(),
      body: JSON.stringify({ password, action }),
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { stepUpToken?: unknown };
      return typeof body.stepUpToken === "string"
        ? { ok: true, token: body.stepUpToken }
        : { ok: false, reason: "failed" };
    }
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (res.status === 403) return { ok: false, reason: "wrong_password" };
    if (res.status === 409) return { ok: false, reason: "refresh_required" };
    if (res.status === 429 || res.status === 503) return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export const STEP_UP_HEADER = "x-step-up";

export function stepUpErrorMessage(reason: Exclude<StepUpClientResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "wrong_password":
      return "הסיסמה שגויה.";
    case "unauthorized":
      return "החיבור פג. יש להתחבר מחדש ולנסות שוב.";
    case "rate_limited":
      return "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.";
    case "refresh_required":
      return "יש לרענן את הדף ולנסות שוב.";
    default:
      return "הפעולה נכשלה. נסו שוב מאוחר יותר.";
  }
}
