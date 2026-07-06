import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { exchangeCodeForTokens } from "@/lib/services/integrations/gmail/oauth-token.service";
import { fetchGoogleUserInfo } from "@/lib/services/integrations/gmail/google-profile.service";
import { encryptToken } from "@/lib/services/integrations/gmail/token-crypto.placeholder";

export const runtime = "nodejs";

const COOKIE_STATE = "gmail_oauth_state";
const COOKIE_VERIFIER = "gmail_oauth_code_verifier";
const COOKIE_BUSINESS_ID = "gmail_oauth_business_id";

// Where the user lands after Google redirects back here. This is a top-level
// browser navigation (not a fetch), so we must send the user back into the app
// UI — never render raw JSON, which reads as "connection failed" even on success.
const EMAIL_SCREEN_PATH = "/documents/email";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Base for the user-facing redirect. Prefer the configured OAuth redirect base
// (the canonical app origin) and fall back to the request origin so we can still
// bounce the user back into the app even if the env var is momentarily missing.
function appBase(req: NextRequest): string {
  return process.env.GOOGLE_OAUTH_REDIRECT_BASE_URL || req.nextUrl.origin;
}

function clearOauthCookies(res: NextResponse) {
  res.cookies.set(COOKIE_STATE, "", { path: "/", maxAge: 0 });
  res.cookies.set(COOKIE_VERIFIER, "", { path: "/", maxAge: 0 });
  res.cookies.set(COOKIE_BUSINESS_ID, "", { path: "/", maxAge: 0 });
}

// Safe, whitelisted error codes only — never leak provider/internal error text
// into the URL. The email screen can map these to a friendly Hebrew message.
type CallbackErrorCode =
  | "google_access_denied"
  | "gmail_state_invalid"
  | "gmail_token_exchange_failed"
  | "gmail_callback_failed"
  | "max_accounts";

function redirectToEmail(
  req: NextRequest,
  query: string
): NextResponse {
  const res = NextResponse.redirect(
    new URL(`${EMAIL_SCREEN_PATH}?${query}`, appBase(req))
  );
  clearOauthCookies(res);
  return res;
}

function redirectSuccess(req: NextRequest): NextResponse {
  return redirectToEmail(req, "connected=1");
}

function redirectError(req: NextRequest, code: CallbackErrorCode): NextResponse {
  return redirectToEmail(req, `error=${code}`);
}

export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const errorParam = req.nextUrl.searchParams.get("error");

    if (errorParam) {
      // Google returned an error on the consent screen (most commonly the user
      // declining). Only distinguish access_denied; everything else is generic.
      return redirectError(
        req,
        errorParam === "access_denied"
          ? "google_access_denied"
          : "gmail_callback_failed"
      );
    }

    if (!code || !state) {
      return redirectError(req, "gmail_callback_failed");
    }

    const cookieState = req.cookies.get(COOKIE_STATE)?.value || "";
    const codeVerifier = req.cookies.get(COOKIE_VERIFIER)?.value || "";
    const businessIdRaw = req.cookies.get(COOKIE_BUSINESS_ID)?.value || "";
    const businessId = Number(businessIdRaw);

    if (!cookieState || cookieState !== state) {
      return redirectError(req, "gmail_state_invalid");
    }

    if (!codeVerifier) {
      return redirectError(req, "gmail_state_invalid");
    }

    if (!Number.isFinite(businessId) || businessId <= 0) {
      return redirectError(req, "gmail_state_invalid");
    }

    const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
    const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
    const redirectBase = requireEnv("GOOGLE_OAUTH_REDIRECT_BASE_URL");

    const redirectUri = new URL(
      "/api/integrations/gmail/callback",
      redirectBase
    ).toString();

    let tokens;
    let userInfo;
    try {
      tokens = await exchangeCodeForTokens({
        clientId,
        clientSecret,
        redirectUri,
        code,
        codeVerifier,
      });
      userInfo = await fetchGoogleUserInfo(tokens.access_token);
    } catch (exchangeError) {
      console.error("GMAIL_CALLBACK_TOKEN_EXCHANGE_ERROR:", exchangeError);
      return redirectError(req, "gmail_token_exchange_failed");
    }

    const accessEnc = encryptToken(tokens.access_token);
    const refreshEnc = encryptToken(tokens.refresh_token);
    if (!accessEnc) {
      return redirectError(req, "gmail_token_exchange_failed");
    }

    const now = Date.now();
    const expiresAt = new Date(now + Math.max(0, tokens.expires_in) * 1000);

    const scopes = String(tokens.scope || "").trim();
    const scopesToStore = scopes || "openid email profile https://www.googleapis.com/auth/gmail.readonly";

    // Enforce a maximum of two *connected* Gmail accounts per business.
    // Reconnecting an already-connected account is always allowed (it updates
    // in place); a brand-new account is blocked once two are already connected.
    const existingConnections = await prisma.emailConnection.findMany({
      where: { businessId, provider: "gmail" },
      select: { emailAddress: true, status: true },
    });
    const isAlreadyConnected = existingConnections.some(
      (c) => c.emailAddress === userInfo.email && c.status === "connected"
    );
    const connectedCount = existingConnections.filter(
      (c) => c.status === "connected"
    ).length;
    if (!isAlreadyConnected && connectedCount >= 2) {
      return redirectError(req, "max_accounts");
    }

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

    return redirectSuccess(req);
  } catch (error) {
    console.error("GMAIL_CALLBACK_ERROR:", error);
    return redirectError(req, "gmail_callback_failed");
  }
}
