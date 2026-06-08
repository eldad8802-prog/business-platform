import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { buildGmailAuthorizeUrl } from "@/lib/services/integrations/gmail/oauth-url.service";
import { createPkcePair } from "@/lib/services/integrations/gmail/pkce-cookie.service";
import { createOauthState } from "@/lib/services/integrations/gmail/state-cookie.service";

export const runtime = "nodejs";

const COOKIE_STATE = "gmail_oauth_state";
const COOKIE_VERIFIER = "gmail_oauth_code_verifier";
const COOKIE_BUSINESS_ID = "gmail_oauth_business_id";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function cookieOptions(req: NextRequest) {
  const secure =
    process.env.NODE_ENV === "production" ||
    req.nextUrl.protocol === "https:";

  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: 10 * 60, // 10 minutes
  };
}

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return authRequiredResponse(req);
    }

    const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
    const redirectBase = requireEnv("GOOGLE_OAUTH_REDIRECT_BASE_URL");

    const redirectUri = new URL(
      "/api/integrations/gmail/callback",
      redirectBase
    ).toString();

    const state = createOauthState();
    const { codeVerifier, codeChallenge } = createPkcePair();

    const authorizeUrl = buildGmailAuthorizeUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge,
    });

    const res = NextResponse.redirect(authorizeUrl);
    const opts = cookieOptions(req);

    res.cookies.set(COOKIE_STATE, state, opts);
    res.cookies.set(COOKIE_VERIFIER, codeVerifier, opts);
    res.cookies.set(COOKIE_BUSINESS_ID, String(user.businessId), opts);

    return res;
  } catch (error) {
    console.error("GMAIL_CONNECT_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

