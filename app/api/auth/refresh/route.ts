/**
 * PERSISTENT LOGIN — the refresh endpoint.
 *
 * POST /api/auth/refresh
 *
 * The HTTP adapter, and only that: read the cookie, run the browser CSRF checks,
 * call the engine, translate the verdict into a status and a Set-Cookie. All the
 * session reasoning lives in `lib/auth/refresh-session.ts`, which knows nothing
 * about requests.
 *
 * POST only, on purpose. A GET would be reachable from a link, a prefetch and a
 * browser's address bar, and this endpoint rotates a credential.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authDb } from "@/lib/prisma-auth";
import { signAuthToken } from "@/lib/auth";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import {
  checkBrowserCsrf,
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from "@/lib/auth/refresh-cookie";
import { refreshSession, type RefreshOutcome } from "@/lib/auth/refresh-session";
import { platformClass, type PlatformClass } from "@/lib/auth/device-label";

export type RefreshDeps = {
  now?: () => Date;
  run?: typeof refreshSession;
};

/**
 * One shape for every refusal. The client learns that it must sign in again and
 * nothing else — which session, which secret and why are all server-side facts,
 * and an endpoint that distinguishes "unknown secret" from "revoked session" in
 * its body is an oracle for whoever is probing it.
 */
function refuse(status: number, clearCookie: boolean): NextResponse {
  const res = NextResponse.json(
    { error: "Unauthorized" },
    { status, headers: { "cache-control": "no-store" } }
  );
  if (clearCookie) clearRefreshCookie(res);
  return res;
}

/**
 * Security telemetry goes to the structured server log for this phase. It never
 * carries the secret, its hash, the cookie, the access token or the connection
 * string — a log line is not a place to put a credential, even a rotated one.
 */
function logSecurityEvent(event: string, fields: Record<string, string | number>): void {
  console.warn(
    JSON.stringify({ event, at: new Date().toISOString(), ...fields })
  );
}

export type RefreshTelemetry = {
  event: "refresh_outcome";
  outcome: RefreshOutcome["kind"] | "csrf_refused" | "rate_limited" | "error";
  reason?: string;
  platform: PlatformClass;
  /** A session SELECTOR prefix: enough to follow one device's chain, useless as a credential. */
  sid?: string;
};

/**
 * One line per refresh, whatever it decided.
 *
 * Without it a refused refresh was invisible: the client saw 401, the person
 * saw a sign-in screen, and nothing on the server said whether the session had
 * been revoked, had expired, had lost a response, or had never sent its cookie
 * at all — the last of which is the question the Android shell still has to
 * answer. The REASON stays here, server-side; the response body is unchanged
 * and still says only "Unauthorized".
 *
 * Closed vocabulary only: the outcome and reason come from the engine's own
 * union, the platform from a five-value classifier, the sid is truncated. No
 * User-Agent string, no IP, no cookie, no token.
 */
export function refreshTelemetry(
  req: Request,
  outcome: RefreshTelemetry["outcome"],
  extra: { reason?: string; sessionId?: string } = {}
): RefreshTelemetry {
  return {
    event: "refresh_outcome",
    outcome,
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    platform: platformClass(req.headers.get("user-agent")),
    ...(extra.sessionId !== undefined ? { sid: extra.sessionId.slice(0, 8) } : {}),
  };
}

function logRefresh(line: RefreshTelemetry): void {
  console.log(JSON.stringify(line));
}

export async function handleRefresh(
  req: Request,
  deps: RefreshDeps = {}
): Promise<NextResponse> {
  const now = deps.now?.() ?? new Date();
  const run = deps.run ?? refreshSession;

  try {
    const csrf = checkBrowserCsrf(req);
    if (!csrf.ok) {
      logSecurityEvent("refresh_csrf_refused", { reason: csrf.reason });
      logRefresh(refreshTelemetry(req, "csrf_refused", { reason: csrf.reason }));
      // The cookie is untouched: a cross-site caller must not be able to log
      // anyone out by being refused.
      return refuse(403, false);
    }

    const ip = getClientIp(req);
    const rl = await consumeRateLimit({ key: `auth:refresh:${ip}`, limit: 30, windowMs: 60_000 });
    if (!rl.allowed) {
      logRefresh(refreshTelemetry(req, "rate_limited"));
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "cache-control": "no-store" } }
      );
    }

    const credential = readRefreshCookie(req);
    const outcome: RefreshOutcome = await run(authDb(), { credential, now });
    logRefresh(
      refreshTelemetry(req, outcome.kind, {
        reason: "reason" in outcome ? outcome.reason : undefined,
        sessionId: "sessionId" in outcome ? outcome.sessionId : undefined,
      })
    );

    switch (outcome.kind) {
      case "rotated": {
        const res = NextResponse.json(
          {
            success: true,
            // Every token this endpoint mints names its session. There is no
            // path here that produces a sid-less token: the only outcome that
            // reaches this branch is one where a session was just rotated.
            token: signAuthToken(outcome.userId, outcome.tokenVersion, outcome.sessionId),
          },
          { headers: { "cache-control": "no-store" } }
        );
        setRefreshCookie(res, outcome.credential, {
          now,
          absoluteExpiresAt: outcome.absoluteExpiresAt,
        });
        return res;
      }

      case "unauthorized":
        // Includes an unknown secret. NOT revoked and NOT cleared: the selector
        // authenticates nothing, so an unrecognised secret proves nothing about
        // the session, and clearing here would turn a future history eviction
        // into a silent logout.
        return refuse(401, false);

      case "replay_unproven":
        // A known rotated secret past its grace, with no evidence anyone else
        // used the session. An ordinary lost response looks exactly like this.
        return refuse(401, false);

      case "replay_revoked":
        logSecurityEvent("refresh_chain_divergence", {
          outcome: "suspected_refresh_reuse",
          sessionId: outcome.sessionId,
          userId: outcome.userId,
        });
        return refuse(401, true);

      case "invalid":
        // Conclusively dead — revoked, expired, or killed by a global logout.
        return refuse(401, true);
    }
  } catch (error) {
    // A driver failure must not touch the cookie. The caller keeps the
    // credential it has and its current access token, and can try again; the
    // alternative is turning a transient database blip into a mass logout.
    console.error(
      "REFRESH_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    logRefresh(refreshTelemetry(req, "error"));
    return NextResponse.json(
      { error: "Server error" },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}

export async function POST(req: Request) {
  return handleRefresh(req);
}
