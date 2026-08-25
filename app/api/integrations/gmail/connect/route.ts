import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { buildGmailAuthorizeUrl } from "@/lib/services/integrations/gmail/oauth-url.service";
import { createPkcePair } from "@/lib/services/integrations/gmail/pkce-cookie.service";
import { createSignedGmailState } from "@/lib/services/integrations/gmail/signed-state.service";

export const runtime = "nodejs";

const COOKIE_STATE = "gmail_oauth_state";
const COOKIE_VERIFIER = "gmail_oauth_code_verifier";

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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
    const redirectBase = requireEnv("GOOGLE_OAUTH_REDIRECT_BASE_URL");

    const redirectUri = new URL(
      "/api/integrations/gmail/callback",
      redirectBase
    ).toString();

    // D2/P7-W4A: the state is a tamper-evident envelope that BINDS the
    // server-derived tenant identity (businessId + userId) to this OAuth
    // round-trip. The callback derives the tenant from the verified state —
    // a standalone businessId cookie is no longer an authority.
    const state = createSignedGmailState({
      businessId: user.businessId,
      userId: user.id,
    });
    const { codeVerifier, codeChallenge } = createPkcePair();

    const authorizeUrl = buildGmailAuthorizeUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge,
    });

    // Return the authorize URL in the body (not an HTTP redirect): the client
    // calls this with a Bearer token via fetch and cannot read the Location
    // header of a redirect (a `redirect:"manual"` fetch yields an opaque
    // response with no headers). The PKCE/state cookies below are still set on
    // this 200 response and stored by the same-origin fetch.
    const res = NextResponse.json({ url: authorizeUrl });
    const opts = cookieOptions(req);

    // Double-submit binding: the same signed state also travels as an
    // httpOnly cookie, so the callback only accepts the state from the
    // browser session that initiated the flow (and it is single-use — the
    // cookie is cleared on every callback outcome).
    res.cookies.set(COOKIE_STATE, state, opts);
    res.cookies.set(COOKIE_VERIFIER, codeVerifier, opts);

    return res;
  } catch (error) {
    console.error("GMAIL_CONNECT_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

