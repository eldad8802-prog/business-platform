import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { exchangeCodeForTokens } from "@/lib/services/integrations/gmail/oauth-token.service";
import { fetchGoogleUserInfo } from "@/lib/services/integrations/gmail/google-profile.service";
import { encryptToken } from "@/lib/services/integrations/gmail/token-crypto.placeholder";

export const runtime = "nodejs";

const COOKIE_STATE = "gmail_oauth_state";
const COOKIE_VERIFIER = "gmail_oauth_code_verifier";
const COOKIE_BUSINESS_ID = "gmail_oauth_business_id";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function clearOauthCookies(res: NextResponse) {
  res.cookies.set(COOKIE_STATE, "", { path: "/", maxAge: 0 });
  res.cookies.set(COOKIE_VERIFIER, "", { path: "/", maxAge: 0 });
  res.cookies.set(COOKIE_BUSINESS_ID, "", { path: "/", maxAge: 0 });
}

export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const errorParam = req.nextUrl.searchParams.get("error");

    if (errorParam) {
      const out = NextResponse.json(
        { error: `OAuth error: ${errorParam}` },
        { status: 400 }
      );
      clearOauthCookies(out);
      return out;
    }

    if (!code || !state) {
      const out = NextResponse.json(
        { error: "Missing code/state" },
        { status: 400 }
      );
      clearOauthCookies(out);
      return out;
    }

    const cookieState = req.cookies.get(COOKIE_STATE)?.value || "";
    const codeVerifier = req.cookies.get(COOKIE_VERIFIER)?.value || "";
    const businessIdRaw = req.cookies.get(COOKIE_BUSINESS_ID)?.value || "";
    const businessId = Number(businessIdRaw);

    if (!cookieState || cookieState !== state) {
      const out = NextResponse.json({ error: "Invalid state" }, { status: 400 });
      clearOauthCookies(out);
      return out;
    }

    if (!codeVerifier) {
      const out = NextResponse.json(
        { error: "Missing PKCE verifier" },
        { status: 400 }
      );
      clearOauthCookies(out);
      return out;
    }

    if (!Number.isFinite(businessId) || businessId <= 0) {
      const out = NextResponse.json(
        { error: "Missing business context" },
        { status: 400 }
      );
      clearOauthCookies(out);
      return out;
    }

    const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
    const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
    const redirectBase = requireEnv("GOOGLE_OAUTH_REDIRECT_BASE_URL");

    const redirectUri = new URL(
      "/api/integrations/gmail/callback",
      redirectBase
    ).toString();

    const tokens = await exchangeCodeForTokens({
      clientId,
      clientSecret,
      redirectUri,
      code,
      codeVerifier,
    });

    const userInfo = await fetchGoogleUserInfo(tokens.access_token);

    const accessEnc = encryptToken(tokens.access_token);
    const refreshEnc = encryptToken(tokens.refresh_token);
    if (!accessEnc) {
      const out = NextResponse.json(
        { error: "Missing access token" },
        { status: 500 }
      );
      clearOauthCookies(out);
      return out;
    }

    const now = Date.now();
    const expiresAt = new Date(now + Math.max(0, tokens.expires_in) * 1000);

    const scopes = String(tokens.scope || "").trim();
    const scopesToStore = scopes || "openid email profile https://www.googleapis.com/auth/gmail.readonly";

    const connection = await prisma.emailConnection.upsert({
      where: {
        businessId_provider_emailAddress: {
          businessId,
          provider: "gmail",
          emailAddress: userInfo.email,
        },
      },
      create: {
        businessId,
        provider: "gmail",
        status: "connected",
        emailAddress: userInfo.email,
        providerAccountId: userInfo.sub,
        scopes: scopesToStore,
      },
      update: {
        status: "connected",
        providerAccountId: userInfo.sub,
        scopes: scopesToStore,
        lastError: null,
      },
    });

    await prisma.oAuthToken.upsert({
      where: { connectionId: connection.id },
      create: {
        connectionId: connection.id,
        accessTokenEncrypted: accessEnc.encrypted,
        refreshTokenEncrypted: refreshEnc?.encrypted ?? null,
        expiresAt,
        tokenType: tokens.token_type ?? null,
        encryptionKeyId: accessEnc.keyId,
      },
      update: {
        accessTokenEncrypted: accessEnc.encrypted,
        refreshTokenEncrypted: refreshEnc?.encrypted ?? null,
        expiresAt,
        tokenType: tokens.token_type ?? null,
        encryptionKeyId: accessEnc.keyId,
      },
    });

    const out = NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        emailAddress: connection.emailAddress,
        providerAccountId: connection.providerAccountId,
        businessId: connection.businessId,
        status: connection.status,
      },
    });
    clearOauthCookies(out);
    return out;
  } catch (error) {
    console.error("GMAIL_CALLBACK_ERROR:", error);
    const out = NextResponse.json({ error: "Server error" }, { status: 500 });
    clearOauthCookies(out);
    return out;
  }
}

