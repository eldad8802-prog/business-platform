/**
 * "Continue with Google" — configuration and the OAuth mechanics between Dubiz and Google.
 *
 * WHAT THIS MODULE DECIDES: whether the feature is on, what Google is asked for, and the browser-bound state
 * that ties a callback to the sign-in that started it. It decides nothing about accounts (google-sign-in.ts)
 * and touches no database.
 *
 *   flag        AUTH_GOOGLE_LOGIN_ENABLED=true AND a complete client config (id, secret, redirect base).
 *               Anything less is OFF: the button is not rendered and every Google route answers 404.
 *   who         while ON, AUTH_GOOGLE_LOGIN_MODE decides who may use it:
 *                 "open"  — everyone. Opening to all users is this explicit value and nothing else.
 *                 anything else, unset included — PILOT: only the exact addresses in
 *                 AUTH_GOOGLE_LOGIN_PILOT_EMAILS (parsed like SIGNUP_ALLOWED_EMAILS, fail closed). A missing,
 *                 empty or malformed list lets NOBODY in; deleting the list never opens the service.
 *               The pilot is enforced on the server, on the address Google verified: in the callback before
 *               any ticket, link or session, and again by every route that completes a signup or a link.
 *               `?google=pilot` only shows the button (googleButtonVisible) — it grants nothing.
 *   scopes      exactly `openid email profile`. No offline access, no refresh token, no Gmail / Drive /
 *               Calendar — sign-in needs an identity and nothing else.
 *   start state one httpOnly, SameSite=Lax cookie holding {state, nonce, PKCE verifier, exp}, HMAC-signed
 *               with a key derived from AUTH_TOKEN_SECRET under its own label. Lax (not Strict) because the
 *               callback is a top-level navigation from accounts.google.com; scoped to the callback path;
 *               10 minutes; cleared by the callback whatever the outcome.
 *   signup      the single-use ticket's secret (oauth-ticket.ts) in its own httpOnly cookie, scoped to
 *               /api/auth/google, 30 minutes — the only thing a visitor holds before signup is complete.
 *
 * TEST ENDPOINTS: the CI labs drive the real routes against a local Google stand-in. Its URLs are honoured
 * ONLY when GOOGLE_LOGIN_TEST_ENDPOINTS=1 and the deployment is not a Vercel one (VERCEL_ENV unset) — a
 * Production or Preview deployment always talks to Google itself, whatever else is configured.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";

import { parseSignupAllowlist, type SignupAllowlist } from "@/lib/auth/signup-allowlist";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_LOGIN_SCOPES = "openid email profile";

export const GOOGLE_START_COOKIE = "dz_google_oauth";
export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";
export const GOOGLE_TICKET_COOKIE = "dz_google_signup";
export const GOOGLE_TICKET_COOKIE_PATH = "/api/auth/google";
/** The LINK ticket (an existing account's owner proving ownership) — its own cookie, beside the signup one. */
export const GOOGLE_LINK_COOKIE = "dz_google_link";
export const START_TTL_SECONDS = 10 * 60;
export const TICKET_COOKIE_MAX_AGE_SECONDS = 30 * 60;

const KEY_LABEL = "dubiz:google-login-start:v1";
const STATE_VERSION = 1;

export type GoogleLoginConfig = {
  clientId: string;
  clientSecret: string;
  /** https://host — no trailing slash. The redirect URI is this + GOOGLE_CALLBACK_PATH. */
  redirectBase: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** null = Google's own JWKS (lib/auth/google-id-token.ts). */
  jwksUrl: string | null;
  /** Who may use it — see "who" above. */
  access: GoogleLoginAccess;
};

export type GoogleLoginAccess = { mode: "open" } | { mode: "pilot"; allowed: SignupAllowlist };

/** The page parameter that shows the button during the pilot: `/login?google=pilot`. Grants nothing by itself. */
export const GOOGLE_PILOT_PARAM = "pilot";

type Env = Record<string, string | undefined>;

function testEndpointsAllowed(env: Env): boolean {
  return env.GOOGLE_LOGIN_TEST_ENDPOINTS === "1" && !env.VERCEL_ENV;
}

/** The configuration, or null when the feature is OFF (flag off or anything missing). */
export function readGoogleLoginConfig(env: Env = process.env): GoogleLoginConfig | null {
  if (env.AUTH_GOOGLE_LOGIN_ENABLED !== "true") return null;
  const clientId = env.GOOGLE_LOGIN_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_LOGIN_CLIENT_SECRET?.trim();
  const base = env.GOOGLE_LOGIN_REDIRECT_BASE_URL?.trim().replace(/\/+$/, "");
  if (!clientId || !clientSecret || !base) return null;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  const test = testEndpointsAllowed(env);
  return {
    clientId,
    clientSecret,
    redirectBase: `${parsed.protocol}//${parsed.host}`,
    authorizeUrl: (test && env.GOOGLE_LOGIN_TEST_AUTHORIZE_URL) || GOOGLE_AUTHORIZE_URL,
    tokenUrl: (test && env.GOOGLE_LOGIN_TEST_TOKEN_URL) || GOOGLE_TOKEN_URL,
    jwksUrl: (test && env.GOOGLE_LOGIN_TEST_JWKS_URL) || null,
    access: env.AUTH_GOOGLE_LOGIN_MODE?.trim() === "open" ? { mode: "open" } : { mode: "pilot", allowed: parseSignupAllowlist(env.AUTH_GOOGLE_LOGIN_PILOT_EMAILS) },
  };
}

export function isGoogleLoginEnabled(env: Env = process.env): boolean {
  return readGoogleLoginConfig(env) !== null;
}

/** May this Google-verified address sign in, sign up or link? Always false for a pilot without a valid list. */
export function googleLoginAllows(config: GoogleLoginConfig, email: string): boolean {
  return config.access.mode === "open" || config.access.allowed.has(email);
}

/** Is the button shown? Open: whenever the feature is on. Pilot: only on a page opened with `?google=pilot`. */
export function googleButtonVisible(config: GoogleLoginConfig | null, param: string | string[] | undefined): boolean {
  if (!config) return false;
  return config.access.mode === "open" || param === GOOGLE_PILOT_PARAM;
}

/** What a route answers when the pilot does not include the ticket's address (403, the cookie forgotten). */
export const GOOGLE_NOT_IN_PILOT = { code: "GOOGLE_NOT_AVAILABLE", error: "ההתחברות עם Google עדיין לא זמינה לחשבון הזה." } as const;

export function redirectUri(config: GoogleLoginConfig): string {
  return `${config.redirectBase}${GOOGLE_CALLBACK_PATH}`;
}

// ── the start state ────────────────────────────────────────────────────────────────────────────────

export type StartState = { state: string; nonce: string; verifier: string; exp: number; from: "login" | "register" };

function key(): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) throw new Error("AUTH_TOKEN_SECRET is not configured");
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

const b64 = (b: Buffer) => b.toString("base64url");

export function newStartState(from: "login" | "register", nowMs = Date.now()): StartState {
  return {
    state: b64(randomBytes(32)),
    nonce: b64(randomBytes(32)),
    verifier: b64(randomBytes(48)),
    exp: Math.floor(nowMs / 1000) + START_TTL_SECONDS,
    from,
  };
}

export function sealStartState(s: StartState): string {
  const body = b64(Buffer.from(JSON.stringify({ v: STATE_VERSION, ...s }), "utf8"));
  return `${body}.${b64(createHmac("sha256", key()).update(body).digest())}`;
}

/** The start state, or null when it is missing, forged, altered, malformed or expired. */
export function openStartState(sealed: string | null, nowMs = Date.now()): StartState | null {
  if (!sealed || sealed.length > 2048) return null;
  const dot = sealed.indexOf(".");
  if (dot <= 0 || dot !== sealed.lastIndexOf(".")) return null;
  const body = sealed.slice(0, dot);
  const given = Buffer.from(sealed.slice(dot + 1), "base64url");
  const want = createHmac("sha256", key()).update(body).digest();
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (p.v !== STATE_VERSION) return null;
  if (typeof p.state !== "string" || typeof p.nonce !== "string" || typeof p.verifier !== "string") return null;
  if (typeof p.exp !== "number" || p.exp <= Math.floor(nowMs / 1000)) return null;
  if (p.from !== "login" && p.from !== "register") return null;
  return { state: p.state, nonce: p.nonce, verifier: p.verifier, exp: p.exp, from: p.from };
}

/** Constant-time comparison of the state Google echoed with the one this browser holds. */
export function sameState(echoed: string | null, held: string): boolean {
  if (!echoed) return false;
  const a = createHash("sha256").update(echoed, "utf8").digest();
  const b = createHash("sha256").update(held, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function authorizeUrl(config: GoogleLoginConfig, s: StartState): string {
  const challenge = b64(createHash("sha256").update(s.verifier, "ascii").digest());
  const u = new URL(config.authorizeUrl);
  u.searchParams.set("client_id", config.clientId);
  u.searchParams.set("redirect_uri", redirectUri(config));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_LOGIN_SCOPES);
  u.searchParams.set("state", s.state);
  u.searchParams.set("nonce", s.nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  // Always let the person pick (or confirm) the account — never sign in silently as whoever is in the browser.
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

// ── the code exchange ──────────────────────────────────────────────────────────────────────────────

export type TokenExchange = (input: { config: GoogleLoginConfig; code: string; verifier: string }) => Promise<string | null>;

/** Exchange the authorization code for the ID token (server to server, with the client secret). */
export const exchangeCodeForIdToken: TokenExchange = async ({ config, code, verifier }) => {
  if (!code || code.length > 2048) return null;
  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri(config),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  // The access token in the same answer is never read, kept or logged.
  return typeof body?.id_token === "string" ? body.id_token : null;
};

// ── cookies ────────────────────────────────────────────────────────────────────────────────────────

const secure = () => process.env.NODE_ENV === "production";

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

export function setStartCookie(res: NextResponse, sealed: string): void {
  res.cookies.set({ name: GOOGLE_START_COOKIE, value: sealed, httpOnly: true, secure: secure(), sameSite: "lax", path: GOOGLE_CALLBACK_PATH, maxAge: START_TTL_SECONDS });
}
export function clearStartCookie(res: NextResponse): void {
  res.cookies.set({ name: GOOGLE_START_COOKIE, value: "", httpOnly: true, secure: secure(), sameSite: "lax", path: GOOGLE_CALLBACK_PATH, maxAge: 0 });
}
export function setTicketCookie(res: NextResponse, secret: string): void {
  res.cookies.set({ name: GOOGLE_TICKET_COOKIE, value: secret, httpOnly: true, secure: secure(), sameSite: "lax", path: GOOGLE_TICKET_COOKIE_PATH, maxAge: TICKET_COOKIE_MAX_AGE_SECONDS });
}
export function clearTicketCookie(res: NextResponse): void {
  res.cookies.set({ name: GOOGLE_TICKET_COOKIE, value: "", httpOnly: true, secure: secure(), sameSite: "lax", path: GOOGLE_TICKET_COOKIE_PATH, maxAge: 0 });
}
export function setLinkCookie(res: NextResponse, secret: string): void {
  res.cookies.set({ name: GOOGLE_LINK_COOKIE, value: secret, httpOnly: true, secure: secure(), sameSite: "lax", path: GOOGLE_TICKET_COOKIE_PATH, maxAge: TICKET_COOKIE_MAX_AGE_SECONDS });
}
export function clearLinkCookie(res: NextResponse): void {
  res.cookies.set({ name: GOOGLE_LINK_COOKIE, value: "", httpOnly: true, secure: secure(), sameSite: "lax", path: GOOGLE_TICKET_COOKIE_PATH, maxAge: 0 });
}
