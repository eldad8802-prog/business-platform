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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal, self-contained result page. No tokens or secrets are ever placed in
 * the markup — only the connected/error status and a short safe reason code.
 */
function renderResultPage(outcome: {
  status: "connected" | "error";
  reason: string | null;
}): string {
  const connected = outcome.status === "connected";
  const title = connected
    ? "התחברות לרשות המסים הושלמה"
    : "ההתחברות לרשות המסים נכשלה";
  const detail = connected
    ? "החיבור אומת ונשמר. אפשר לחזור ל-Dubiz."
    : "לא הצלחנו להשלים את ההתחברות. נסו שוב מתוך Dubiz.";
  const reasonLine =
    !connected && outcome.reason
      ? `<p class="reason">קוד: ${escapeHtml(outcome.reason)}</p>`
      : "";

  return `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f7f8fa; color: #16181d; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
      .card { background: #fff; border: 1px solid #e6e8ee; border-radius: 14px; padding: 32px; max-width: 420px; text-align: center; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { font-size: 14px; color: #5a6072; margin: 4px 0; }
      .reason { font-family: ui-monospace, monospace; font-size: 12px; color: #98306a; }
      a { display: inline-block; margin-top: 20px; color: #0f6fff; text-decoration: none; font-weight: 600; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
      ${reasonLine}
      <a href="/">חזרה ל-Dubiz</a>
    </main>
  </body>
</html>`;
}

function buildResponse(outcome: AuthorityCallbackRouteOutcome): NextResponse {
  const res = new NextResponse(renderResultPage(outcome), {
    status: outcome.ok ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });

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

    return buildResponse(outcome);
  } catch (error) {
    // Log only the error name — never the message/stack (may contain config
    // values). The callback service already sanitizes its own failures.
    console.error(
      "AUTHORITY_OAUTH_CALLBACK_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    const res = new NextResponse(
      renderResultPage({ status: "error", reason: "SERVER_ERROR" }),
      {
        status: 500,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
    return res;
  }
}
