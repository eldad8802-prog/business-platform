import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import {
  clearStartCookie,
  exchangeCodeForIdToken,
  GOOGLE_START_COOKIE,
  openStartState,
  readCookie,
  readGoogleLoginConfig,
  sameState,
  setTicketCookie,
  type TokenExchange,
} from "@/lib/auth/google-oauth";
import { resolveGoogleCallback, type CallbackOutcome } from "@/lib/auth/google-sign-in";
import { setRefreshCookie } from "@/lib/auth/refresh-cookie";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";

export const dynamic = "force-dynamic";

/**
 * "Continue with Google" — step 2: Google sends the browser back here.
 *
 * The start cookie is checked (signature, expiry, state — constant time) and cleared whatever happens; the
 * code is exchanged server to server; the ID token is verified in full (lib/auth/google-id-token.ts). Then
 * lib/auth/google-sign-in.ts decides, and this route only turns the decision into a redirect:
 *   linked account → refresh cookie → /auth/google/done (the page fetches its access token from /refresh)
 *   new person     → ticket cookie  → /register/google (NO account, NO session until completion)
 *   anything else  → /login or /register with a reason, nothing written.
 * The URL never carries a token. OFF → 404.
 */
export type CallbackRouteDeps = {
  config: typeof readGoogleLoginConfig;
  exchange: TokenExchange;
  resolve: typeof resolveGoogleCallback;
  rateLimit: typeof consumeRateLimit;
  recordUsage: typeof recordProductUsageEvent;
};
const defaultDeps: CallbackRouteDeps = {
  config: readGoogleLoginConfig,
  exchange: exchangeCodeForIdToken,
  resolve: resolveGoogleCallback,
  rateLimit: consumeRateLimit,
  recordUsage: recordProductUsageEvent,
};

function back(base: string, page: "/login" | "/register", reason: string): NextResponse {
  const res = NextResponse.redirect(new URL(`${page}?google=${reason}`, base), 303);
  res.headers.set("cache-control", "no-store");
  clearStartCookie(res);
  return res;
}

export async function handleGoogleCallback(req: Request, deps: CallbackRouteDeps = defaultDeps): Promise<NextResponse> {
  const config = deps.config();
  if (!config) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const base = config.redirectBase;

  const rl = await deps.rateLimit({ key: `auth:google:callback:${getClientIp(req)}`, limit: 30, windowMs: 10 * 60_000 });
  if (!rl.allowed) return back(base, "/login", "busy");

  const params = new URL(req.url).searchParams;
  const started = openStartState(readCookie(req, GOOGLE_START_COOKIE));
  const page = started?.from === "register" ? "/register" : "/login";

  // The person cancelled (or Google refused): back where they came from, nothing written.
  if (params.get("error")) return back(base, page, params.get("error") === "access_denied" ? "cancelled" : "error");
  if (!started || !sameState(params.get("state"), started.state)) return back(base, "/login", "expired");

  let outcome: CallbackOutcome;
  try {
    const idToken = await deps.exchange({ config, code: params.get("code") ?? "", verifier: started.verifier });
    if (!idToken) return back(base, page, "error");
    outcome = await deps.resolve({ idToken, nonce: started.nonce, config, now: new Date(), userAgent: req.headers.get("user-agent") });
  } catch (error) {
    console.error("GOOGLE_CALLBACK_ERROR:", safeErrorSummary(error));
    return back(base, page, "error");
  }

  switch (outcome.kind) {
    case "session": {
      await deps.recordUsage({
        businessId: outcome.businessId,
        userId: outcome.userId,
        sessionId: randomUUID(),
        featureKey: PRODUCT_USAGE_FEATURES.AUTH_LOGIN,
        action: PRODUCT_USAGE_ACTIONS.COMPLETED,
        outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
        metadata: { method: "google" },
      });
      const res = NextResponse.redirect(new URL("/auth/google/done", base), 303);
      res.headers.set("cache-control", "no-store");
      clearStartCookie(res);
      setRefreshCookie(res, outcome.credential, { now: new Date(), absoluteExpiresAt: outcome.absoluteExpiresAt });
      return res;
    }
    case "ticket": {
      const res = NextResponse.redirect(new URL("/register/google", base), 303);
      res.headers.set("cache-control", "no-store");
      clearStartCookie(res);
      setTicketCookie(res, outcome.secret);
      return res;
    }
    case "existing_account":
      return back(base, "/login", "existing");
    case "refused":
      return back(base, "/login", outcome.reason === "PLATFORM_ADMIN" ? "admin" : "unavailable");
    case "signup_closed":
      await deps.recordUsage({
        businessId: null,
        userId: null,
        featureKey: PRODUCT_USAGE_FEATURES.AUTH_REGISTER,
        action: PRODUCT_USAGE_ACTIONS.FAILED,
        outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
        metadata: { reason: "signup_closed", method: "google" },
      });
      return back(base, "/register", "closed");
    case "ticket_unavailable":
      return back(base, page, "busy");
    case "invalid_token":
      console.warn("[google] id token refused", { reason: outcome.reason });
      return back(base, page, "error");
  }
}

export async function GET(req: Request) {
  return handleGoogleCallback(req);
}
