/**
 * POST /api/auth/password/reset/request — ask for a reset link.
 *
 * Body: { email: string }
 *
 * ENUMERATION-RESISTANT. Every well-formed request receives the SAME 200 body,
 * whether or not the address has an account, whether or not a provider is
 * configured, and whether or not delivery succeeded. Response time is padded to
 * a fixed floor so the work done for a real account (token + send) is not
 * visible as latency. The throttle is keyed by the normalized address whether
 * or not it exists, so being throttled is not an oracle either.
 *
 * FAIL-CLOSED DELIVERY. With no configured sender nothing is minted at all.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { authThrottleResponse, padResponseTime } from "@/lib/auth/credential-check";
import {
  PASSWORD_RESET_TTL_SECONDS,
  buildResetUrl,
  issuePasswordResetToken,
  resolvePasswordResetSender,
  type PasswordResetSender,
} from "@/lib/auth/password-reset";
import { loadCredentialSubjectByEmail } from "@/lib/auth/session-directory";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getClientIp } from "@/lib/security/rate-limit";

const NO_STORE = { "cache-control": "no-store" };

/** Floor for every non-throttled response, in ms. */
export const RESET_REQUEST_FLOOR_MS = 750;

export const RESET_REQUEST_GENERIC_BODY = {
  success: true,
  message: "אם הכתובת רשומה במערכת, יישלח אליה קישור לאיפוס הסיסמה.",
} as const;

export type ResetRequestDeps = {
  sender: PasswordResetSender;
  floorMs: number;
};

export async function handleResetRequest(
  req: Request,
  deps: ResetRequestDeps = { sender: resolvePasswordResetSender(), floorMs: RESET_REQUEST_FLOOR_MS }
): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
    if (typeof body?.email !== "string" || body.email.trim().length === 0 || body.email.length > 320) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: NO_STORE });
    }
    const typed = body.email.trim();
    const normalized = normalizeEmail(typed);

    const rl = await checkRateLimit({
      bucket: "AUTH_PASSWORD_RESET_REQUEST",
      account: normalized,
      ip: getClientIp(req),
    });
    if (!rl.allowed) return authThrottleResponse(rl);

    if (deps.sender.configured) {
      const subject = await loadCredentialSubjectByEmail(typed, normalized);
      if (subject && !subject.quarantined) {
        const url = buildResetUrl(issuePasswordResetToken(subject));
        if (url) {
          try {
            await deps.sender.send({
              to: subject.email,
              resetUrl: url,
              expiresInMinutes: PASSWORD_RESET_TTL_SECONDS / 60,
            });
          } catch (error) {
            // Never surfaced: a delivery failure that changed the response
            // would be an oracle for "this address has an account".
            console.error(
              "PASSWORD_RESET_DELIVERY_ERROR:",
              error instanceof Error ? error.name : "UnknownError"
            );
          }
        } else {
          console.error("PASSWORD_RESET_CONFIG_ERROR: no application base URL");
        }
      }
    }

    await padResponseTime(startedAt, deps.floorMs);
    return NextResponse.json(RESET_REQUEST_GENERIC_BODY, { headers: NO_STORE });
  } catch (error) {
    console.error("PASSWORD_RESET_REQUEST_ERROR:", error instanceof Error ? error.name : "UnknownError");
    await padResponseTime(startedAt, deps.floorMs);
    // Still generic: an internal failure must not distinguish accounts either.
    return NextResponse.json(RESET_REQUEST_GENERIC_BODY, { headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleResetRequest(req);
}
