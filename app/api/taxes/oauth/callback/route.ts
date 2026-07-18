/**
 * Israel Tax Authority (ITA) OAuth callback (E2 foundation).
 *
 * Production path:  https://promaxgroup.co.il/api/taxes/oauth/callback
 * Local path:       http://localhost:3000/api/taxes/oauth/callback
 *
 * This is the redirect_uri registered with the ITA OAuth client. It must match
 * `BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL` + BILLING_AUTHORITY_OAUTH_CALLBACK_PATH
 * exactly, byte-for-byte, or token exchange fails.
 *
 * The handler only orchestrates: it delegates state validation + token exchange
 * to the callback service and never logs or echoes tokens, secrets, the OAuth
 * `code`, or the `state`.
 */

import { NextRequest, NextResponse } from "next/server";
import { AUTHORITY_OAUTH_COOKIE_NAMES } from "@/lib/services/billing/authority/billing-authority-oauth-start.service";
import {
  resolveAuthorityOAuthCallback,
  type AuthorityCallbackRouteOutcome,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback-route.service";

export const runtime = "nodejs";

const REDIRECT_BASE_VAR = "BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL";

/** Where the user lands back in the app after the OAuth round-trip. */
const RESULT_PATH = "/settings/connections";

/**
 * Builds the post-OAuth redirect back into the Settings › Connections screen.
 * Only a safe result flag and a short sanitized reason code are placed in the
 * URL — never tokens, the authorization `code`, the `state`, or raw provider
 * error details. OAuth cookies are wiped on every path.
 */
function buildRedirectUrl(
  origin: string,
  outcome: { status: "connected" | "error"; reason: string | null }
): URL {
  const target = new URL(RESULT_PATH, origin);
  if (outcome.status === "connected") {
    target.searchParams.set("authority", "connected");
  } else {
    target.searchParams.set("authority", "error");
    if (outcome.reason) {
      target.searchParams.set("reason", outcome.reason);
    }
  }
  return target;
}

function buildResponse(
  outcome: AuthorityCallbackRouteOutcome,
  origin: string
): NextResponse {
  const res = NextResponse.redirect(buildRedirectUrl(origin, outcome), {
    status: 303,
  });
  res.headers.set("cache-control", "no-store");

  // Wipe OAuth cookies on every path.
  for (const cookie of outcome.clearedCookies) {
    res.cookies.set(cookie.name, "", {
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
      path: cookie.path,
      maxAge: cookie.maxAge,
    });
  }

  return res;
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const secureCookies =
      process.env.NODE_ENV === "production" ||
      req.nextUrl.protocol === "https:";

    // Use the configured, fixed redirect base so the redirect_uri exactly
    // matches the value sent at authorize time and registered with ITA.
    const redirectBaseUrl =
      process.env[REDIRECT_BASE_VAR]?.trim() || req.nextUrl.origin;

    const outcome = await resolveAuthorityOAuthCallback({
      query: {
        code: sp.get("code"),
        state: sp.get("state"),
        error: sp.get("error"),
        errorDescription: sp.get("error_description"),
      },
      cookies: {
        state: req.cookies.get(AUTHORITY_OAUTH_COOKIE_NAMES.STATE)?.value ?? null,
        businessId:
          req.cookies.get(AUTHORITY_OAUTH_COOKIE_NAMES.BUSINESS_ID)?.value ??
          null,
        environment:
          req.cookies.get(AUTHORITY_OAUTH_COOKIE_NAMES.ENVIRONMENT)?.value ??
          null,
        actorUserId:
          req.cookies.get(AUTHORITY_OAUTH_COOKIE_NAMES.ACTOR_USER_ID)?.value ??
          null,
      },
      redirectBaseUrl,
      secureCookies,
    });

    return buildResponse(outcome, req.nextUrl.origin);
  } catch (error) {
    // Log only the error name — never the message/stack (may contain config
    // values). The callback service already sanitizes its own failures.
    console.error(
      "AUTHORITY_OAUTH_CALLBACK_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    // Redirect back into the app with a safe, generic error code — never HTML
    // that strands the user outside Dubiz, and never any sensitive detail.
    const res = NextResponse.redirect(
      buildRedirectUrl(req.nextUrl.origin, {
        status: "error",
        reason: "SERVER_ERROR",
      }),
      { status: 303 }
    );
    res.headers.set("cache-control", "no-store");
    return res;
  }
}
