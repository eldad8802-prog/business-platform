/**
 * Platform-Admin: FCM credential check (owner decision 2026-11-17, notifications track #1146).
 *
 * Path: POST /api/platform-admin/notifications/fcm-auth-check
 *
 * Proves the server can authenticate to Google with FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY: ONE fresh
 * service-account token exchange (checkFcmAuth) — no push is sent, the shared token cache is untouched, the access
 * token is discarded. Returns only { result } (configured | authentication_failed | not_configured | unavailable).
 * A `configured` result does NOT prove the send permission (cloudmessaging.messages.create); the pilot's first real
 * send does.
 *
 * Guard: the canonical platform-admin guard (Bearer + PLATFORM_ADMIN role + PLATFORM_ADMIN_EMAILS allowlist + MFA
 * elevation when enforced), then a fail-closed rate limit (3 per admin per 10 min, 20 per day overall). Every run is
 * audited with the result class only. Never called by the app, a cron or a deploy — only by hand.
 * Nothing secret is returned or logged: no key, assertion, access token, Google response body or error message.
 */

import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse, type PlatformAdminUser } from "@/lib/auth/platform-admin";
import { checkFcmAuth, type FcmAuthCheckResult } from "@/lib/notifications/push/fcm-client";
import { getClientIp } from "@/lib/security/rate-limit";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import type { RateLimitDecision } from "@/lib/security/rate-limiter/types";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export type FcmAuthCheckDeps = {
  authorize?: (req: Request) => Promise<PlatformAdminUser | NextResponse>;
  rateLimit?: (actorId: number, req: Request) => Promise<RateLimitDecision>;
  check?: () => Promise<FcmAuthCheckResult>;
  audit?: (actorId: number, result: FcmAuthCheckResult, req: Request) => Promise<void>;
};

/** Testable handler: guard → rate limit → one check → audit → { result }. */
export async function handleFcmAuthCheck(req: NextRequest, deps: FcmAuthCheckDeps = {}): Promise<NextResponse> {
  const authorize = deps.authorize ?? requirePlatformAdminOrResponse;
  const rateLimit =
    deps.rateLimit ?? ((actorId: number, r: Request) => checkRateLimit({ bucket: "FCM_AUTH_CHECK", user: actorId, ip: getClientIp(r) }));
  const check = deps.check ?? (() => checkFcmAuth());
  const audit =
    deps.audit ??
    ((actorId: number, result: FcmAuthCheckResult, r: Request) =>
      logPlatformAuditEvent({
        actorUserId: actorId,
        action: PLATFORM_AUDIT_ACTIONS.FCM_AUTH_CHECKED,
        targetType: "SYSTEM",
        metadata: { result },
        req: r,
      }));

  try {
    const auth = await authorize(req);
    if (auth instanceof NextResponse) return auth; // 401 / 403 from the canonical guard — nothing else runs.

    const decision = await rateLimit(auth.id, req);
    if (!decision.allowed) return buildRateLimitResponse(decision);

    const result = await check();
    await audit(auth.id, result, req);
    return NextResponse.json({ result }, { status: 200, headers: NO_STORE });
  } catch (error) {
    // The error NAME only — a message could carry configuration.
    console.error("FCM_AUTH_CHECK_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: NextRequest) {
  return handleFcmAuthCheck(req);
}
