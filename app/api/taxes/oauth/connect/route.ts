/**
 * Israel Tax Authority (ITA) OAuth START / connect (E2 foundation).
 *
 * Path:   GET /api/taxes/oauth/connect
 * Pairs with the callback at /api/taxes/oauth/callback.
 *
 * Begins the ITA OAuth 2.0 Authorization Code flow for the authenticated
 * Dubiz user's business: transitions the connection to AUTHORIZATION_REQUIRED,
 * sets the OAuth cookies (state + business + environment + actor), and
 * redirects the browser to the ITA authorize URL.
 *
 * Sandbox-first: defaults to the SANDBOX environment. No client secret, token,
 * or sensitive config is ever returned or logged. The ITA OAuth flow has no
 * PKCE/nonce, so no verifier cookie is issued (confirmed against the start
 * service: response_type=code, confidential client via Basic auth at token).
 */

import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { resolveAuthorityOAuthStart } from "@/lib/services/billing/authority/billing-authority-oauth-start-route.service";

export const runtime = "nodejs";

const REDIRECT_BASE_VAR = "BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const redirectBaseUrl = process.env[REDIRECT_BASE_VAR]?.trim();
    if (!redirectBaseUrl) {
      // Misconfiguration — never echo env names/values to the client body.
      console.error("AUTHORITY_OAUTH_CONNECT_ERROR: missing redirect base");
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }

    const sp = req.nextUrl.searchParams;
    const secureCookies =
      process.env.NODE_ENV === "production" ||
      req.nextUrl.protocol === "https:";

    const outcome = await resolveAuthorityOAuthStart({
      user: { id: user.id, businessId: user.businessId, role: user.role },
      requestedBusinessId: sp.get("businessId"),
      environment: sp.get("environment"),
      redirectBaseUrl,
      secureCookies,
    });

    if (!outcome.ok) {
      if (outcome.status === "unauthenticated") {
        return authRequiredResponse(req);
      }
      const httpStatus = outcome.status === "forbidden" ? 403 : 400;
      return NextResponse.json(
        { error: outcome.status, reason: outcome.reason },
        { status: httpStatus }
      );
    }

    // Allow SPA callers to fetch the authorize URL as JSON; otherwise redirect.
    const wantsJson =
      req.headers.get("accept")?.includes("application/json") ||
      req.headers.get("x-authority-connect-mode") === "json";

    const res = wantsJson
      ? NextResponse.json({ authorizeUrl: outcome.authorizationUrl })
      : NextResponse.redirect(outcome.authorizationUrl);

    for (const cookie of outcome.cookies) {
      res.cookies.set(cookie.name, cookie.value, {
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
        path: cookie.path,
        maxAge: cookie.maxAge,
      });
    }

    return res;
  } catch (error) {
    // Log only the error name — never the message/stack (may carry config).
    console.error(
      "AUTHORITY_OAUTH_CONNECT_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
