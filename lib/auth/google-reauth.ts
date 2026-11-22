/**
 * Google re-authentication for a signed-in user (lib/auth/sensitive-reauth.ts explains the model).
 *
 * Start: a Bearer-authenticated route seals { state, nonce, PKCE verifier, user, session, action } into the httpOnly
 * cookie dz_google_reauth on Google's (already registered) callback path, and sends the browser to Google with
 * prompt=login and max_age=0 — the person must actually authenticate again, not just pick an account.
 *
 * Callback: /api/auth/google/callback hands over to handleGoogleReauthCallback ONLY when that cookie is present,
 * valid and its state equals the state Google echoed; everything else is the ordinary sign-in, unchanged. Here:
 * the code is exchanged (PKCE), the ID token verified in full (issuer, audience, nonce, verified email), Google's
 * auth_time must be fresh, and the Google account must resolve to THE SAME user the cookie names. Then — and only
 * then — a 5-minute proof is set as an httpOnly cookie scoped to the action's API path. No session is created, no
 * account is linked, nothing is written to the database. The URL never carries a token.
 */
import { NextResponse } from "next/server";

import { verifyGoogleIdToken, type GoogleIdTokenResult } from "@/lib/auth/google-id-token";
import {
  authorizeUrl,
  exchangeCodeForIdToken,
  GOOGLE_CALLBACK_PATH,
  type GoogleLoginConfig,
  type TokenExchange,
} from "@/lib/auth/google-oauth";
import { resolveGoogleIdentity } from "@/lib/auth/oauth-ticket";
import {
  GOOGLE_REAUTH_COOKIE,
  GOOGLE_REAUTH_STATE_TTL_SECONDS,
  googleAuthIsFresh,
  issueReauthProof,
  REAUTH_ACTIONS,
  REAUTH_PROOF_TTL_SECONDS,
  type GoogleReauthState,
  type SensitiveAction,
} from "@/lib/auth/sensitive-reauth";
import { safeErrorSummary } from "@/lib/security/log-safe-error";

const secure = () => process.env.NODE_ENV === "production";

/** Google's authorize URL for a re-authentication: the sign-in URL with a forced, fresh login. */
export function googleReauthAuthorizeUrl(config: GoogleLoginConfig, s: GoogleReauthState): string {
  const u = new URL(authorizeUrl(config, { state: s.state, nonce: s.nonce, verifier: s.verifier, exp: s.exp, from: "login" }));
  u.searchParams.set("prompt", "login");
  u.searchParams.set("max_age", "0");
  return u.toString();
}

export function setGoogleReauthCookie(res: NextResponse, sealed: string): void {
  res.cookies.set({ name: GOOGLE_REAUTH_COOKIE, value: sealed, httpOnly: true, secure: secure(), sameSite: "lax", path: GOOGLE_CALLBACK_PATH, maxAge: GOOGLE_REAUTH_STATE_TTL_SECONDS });
}
export function clearGoogleReauthCookie(res: NextResponse): void {
  res.cookies.set({ name: GOOGLE_REAUTH_COOKIE, value: "", httpOnly: true, secure: secure(), sameSite: "lax", path: GOOGLE_CALLBACK_PATH, maxAge: 0 });
}

/** The proof cookie: httpOnly, sent only to the action's API path. */
export function setReauthProofCookie(res: NextResponse, action: SensitiveAction, proof: string): void {
  const a = REAUTH_ACTIONS[action];
  res.cookies.set({ name: a.cookie, value: proof, httpOnly: true, secure: secure(), sameSite: "strict", path: a.path, maxAge: REAUTH_PROOF_TTL_SECONDS });
}
export function clearReauthProofCookie(res: NextResponse, action: SensitiveAction): void {
  const a = REAUTH_ACTIONS[action];
  res.cookies.set({ name: a.cookie, value: "", httpOnly: true, secure: secure(), sameSite: "strict", path: a.path, maxAge: 0 });
}

export type GoogleReauthCallbackDeps = {
  exchange: TokenExchange;
  verify: (idToken: string, expected: { clientId: string; nonce: string; now: Date }) => Promise<GoogleIdTokenResult>;
  resolve: (subject: string) => Promise<{ userId: number; businessId: number } | null>;
  now: () => Date;
};
export const defaultGoogleReauthCallbackDeps: GoogleReauthCallbackDeps = {
  exchange: exchangeCodeForIdToken,
  verify: (idToken, expected) => verifyGoogleIdToken(idToken, expected),
  resolve: (subject) => resolveGoogleIdentity(subject),
  now: () => new Date(),
};

export type GoogleReauthResult = "ok" | "cancelled" | "error" | "stale" | "other_account";

function back(config: GoogleLoginConfig, s: GoogleReauthState, result: GoogleReauthResult, proof?: string): NextResponse {
  const page = REAUTH_ACTIONS[s.action].returnPage;
  const res = NextResponse.redirect(new URL(`${page}?reauth=${result}`, config.redirectBase), 303);
  res.headers.set("cache-control", "no-store");
  clearGoogleReauthCookie(res);
  if (proof) setReauthProofCookie(res, s.action, proof);
  return res;
}

/**
 * The callback's re-authentication branch. `s` is the opened dz_google_reauth state whose `state` already equals
 * the one Google echoed (the caller checked it in constant time).
 */
export async function handleGoogleReauthCallback(
  params: URLSearchParams,
  config: GoogleLoginConfig,
  s: GoogleReauthState,
  deps: GoogleReauthCallbackDeps = defaultGoogleReauthCallbackDeps
): Promise<NextResponse> {
  if (params.get("error")) return back(config, s, params.get("error") === "access_denied" ? "cancelled" : "error");
  try {
    const idToken = await deps.exchange({ config, code: params.get("code") ?? "", verifier: s.verifier });
    if (!idToken) return back(config, s, "error");
    const now = deps.now();
    const verified = await deps.verify(idToken, { clientId: config.clientId, nonce: s.nonce, now });
    if (!verified.ok) return back(config, s, "error");
    if (!googleAuthIsFresh(verified.identity.authTime, now.getTime())) return back(config, s, "stale");
    const owner = await deps.resolve(verified.identity.subject);
    // The Google account must be the one linked to the signed-in user — never "any Google account".
    if (!owner || owner.userId !== s.userId) return back(config, s, "other_account");
    const proof = issueReauthProof({ userId: s.userId, sessionId: s.sessionId, action: s.action, method: "GOOGLE" }, now.getTime());
    return back(config, s, "ok", proof);
  } catch (error) {
    console.error("GOOGLE_REAUTH_CALLBACK_ERROR:", safeErrorSummary(error));
    return back(config, s, "error");
  }
}
