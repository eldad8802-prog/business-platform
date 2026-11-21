/**
 * Step-up re-authentication for sensitive account actions (first user: "מעבר לעוסק מורשה", owner decision 2026-11-20).
 *
 * The owner re-proves who they are right before the action, on the server:
 *   PASSWORD — an account with a password re-enters it (same ledger and lock as login);
 *   GOOGLE   — an account without a password re-authenticates at Google (prompt=login, max_age=0), and the Google
 *              account that comes back must be the one linked to THIS signed-in user.
 * A successful re-authentication mints a PROOF: an HMAC-SHA256 envelope (the platform-admin elevation pattern) bound
 * to the user, the session, the action and the method, valid for 5 minutes. It travels only as an httpOnly cookie
 * scoped to the action's API path — page script never sees it — and the action clears it when it succeeds.
 *
 * Purpose-separated keys (derived from AUTH_TOKEN_SECRET with their own labels): a proof can never validate as a
 * session, an admin elevation or a Google start state, nor the other way round. Fails closed without the secret.
 * Pure crypto: no database, no network.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ReauthMethod = "PASSWORD" | "GOOGLE";
export type SensitiveAction = "BUSINESS_KIND_TRANSITION";

export const REAUTH_PROOF_TTL_SECONDS = 5 * 60;
export const GOOGLE_REAUTH_STATE_TTL_SECONDS = 10 * 60;
/** Google must report an authentication at most this old (plus clock skew) for a re-authentication to count. */
export const GOOGLE_REAUTH_MAX_AUTH_AGE_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 60;

/** Where each action's proof cookie lives (path-scoped: sent only to that action's API). */
export const REAUTH_ACTIONS: Record<SensitiveAction, { cookie: string; path: string; returnPage: string }> = {
  BUSINESS_KIND_TRANSITION: {
    cookie: "dz_reauth_bkt",
    path: "/api/business/legal-identity/kind-transition",
    returnPage: "/business/legal-identity/kind-transition",
  },
};

/** The Google re-authentication start state rides in its own cookie on the shared callback path. */
export const GOOGLE_REAUTH_COOKIE = "dz_google_reauth";

export class SensitiveReauthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SensitiveReauthConfigError";
  }
}

function subkey(label: string): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) throw new SensitiveReauthConfigError("AUTH_TOKEN_SECRET is not configured");
  return createHmac("sha256", secret).update(label).digest();
}
const b64 = (b: Buffer) => b.toString("base64url");

function seal(label: string, payload: object): string {
  const body = b64(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64(createHmac("sha256", subkey(label)).update(body).digest())}`;
}

function open(label: string, raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot !== raw.lastIndexOf(".") || dot === raw.length - 1) return null;
  const body = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1), "base64url");
  const want = createHmac("sha256", subkey(label)).update(body).digest();
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isAction = (v: unknown): v is SensitiveAction => typeof v === "string" && Object.prototype.hasOwnProperty.call(REAUTH_ACTIONS, v);

// ── the proof ──────────────────────────────────────────────────────────────────────────────────────

const PROOF_LABEL = "dubiz-sensitive-reauth-proof-v1";
const PROOF_PURPOSE = "sensitive-reauth-proof";

export type ReauthProofClaims = { userId: number; sessionId: string; action: SensitiveAction; method: ReauthMethod };

export function issueReauthProof(c: ReauthProofClaims, nowMs = Date.now()): string {
  if (!isPosInt(c.userId) || typeof c.sessionId !== "string" || !c.sessionId || !isAction(c.action)) {
    throw new SensitiveReauthConfigError("invalid proof claims");
  }
  const iat = Math.floor(nowMs / 1000);
  return seal(PROOF_LABEL, {
    v: 1, purpose: PROOF_PURPOSE, sub: c.userId, sid: c.sessionId, action: c.action, method: c.method,
    nonce: b64(randomBytes(16)), iat, exp: iat + REAUTH_PROOF_TTL_SECONDS,
  });
}

export type ReauthProofCheck =
  | { ok: true; method: ReauthMethod; reauthAt: Date }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "user_mismatch" | "session_mismatch" | "action_mismatch" };

/** Verify a proof against the CURRENT request's user and session, for one action. Never throws on bad input. */
export function verifyReauthProof(
  raw: string | null | undefined,
  expected: { userId: number; sessionId: string | null; action: SensitiveAction },
  nowMs = Date.now()
): ReauthProofCheck {
  if (!raw) return { ok: false, reason: "missing" };
  const p = open(PROOF_LABEL, raw);
  if (!p || p.v !== 1 || p.purpose !== PROOF_PURPOSE) return { ok: false, reason: "invalid" };
  if (!isPosInt(p.sub) || typeof p.sid !== "string" || !isAction(p.action) || (p.method !== "PASSWORD" && p.method !== "GOOGLE")
      || typeof p.iat !== "number" || typeof p.exp !== "number" || typeof p.nonce !== "string") {
    return { ok: false, reason: "invalid" };
  }
  const now = Math.floor(nowMs / 1000);
  if (p.exp <= now || p.iat > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };
  if (p.sub !== expected.userId) return { ok: false, reason: "user_mismatch" };
  // A token without a session id (legacy) can never satisfy a step-up: the proof must name the live session.
  if (!expected.sessionId || p.sid !== expected.sessionId) return { ok: false, reason: "session_mismatch" };
  if (p.action !== expected.action) return { ok: false, reason: "action_mismatch" };
  return { ok: true, method: p.method, reauthAt: new Date(p.iat * 1000) };
}

/** Which method this account must use: a password if it has one (owner 11-20), Google otherwise. */
export function requiredReauthMethod(account: { hasPassword: boolean }): ReauthMethod {
  return account.hasPassword ? "PASSWORD" : "GOOGLE";
}

// ── the Google re-authentication start state ───────────────────────────────────────────────────────

const GSTATE_LABEL = "dubiz-google-reauth-state-v1";
const GSTATE_PURPOSE = "google-reauth-state";

export type GoogleReauthState = {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
  userId: number;
  sessionId: string;
  action: SensitiveAction;
};

export function newGoogleReauthState(c: { userId: number; sessionId: string; action: SensitiveAction }, nowMs = Date.now()): GoogleReauthState {
  if (!isPosInt(c.userId) || !c.sessionId || !isAction(c.action)) throw new SensitiveReauthConfigError("invalid reauth state");
  return {
    state: b64(randomBytes(32)),
    nonce: b64(randomBytes(32)),
    verifier: b64(randomBytes(48)),
    exp: Math.floor(nowMs / 1000) + GOOGLE_REAUTH_STATE_TTL_SECONDS,
    userId: c.userId,
    sessionId: c.sessionId,
    action: c.action,
  };
}

export function sealGoogleReauthState(s: GoogleReauthState): string {
  return seal(GSTATE_LABEL, { v: 1, purpose: GSTATE_PURPOSE, ...s });
}

export function openGoogleReauthState(raw: string | null | undefined, nowMs = Date.now()): GoogleReauthState | null {
  const p = open(GSTATE_LABEL, raw);
  if (!p || p.v !== 1 || p.purpose !== GSTATE_PURPOSE) return null;
  if (typeof p.state !== "string" || typeof p.nonce !== "string" || typeof p.verifier !== "string") return null;
  if (typeof p.exp !== "number" || p.exp <= Math.floor(nowMs / 1000)) return null;
  if (!isPosInt(p.userId) || typeof p.sessionId !== "string" || !p.sessionId || !isAction(p.action)) return null;
  return { state: p.state, nonce: p.nonce, verifier: p.verifier, exp: p.exp, userId: p.userId, sessionId: p.sessionId, action: p.action };
}

/** Google's auth_time must be present and recent: prompt=login + max_age=0 asked for a fresh authentication. */
export function googleAuthIsFresh(authTime: number | null | undefined, nowMs = Date.now()): boolean {
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return false;
  const now = Math.floor(nowMs / 1000);
  return authTime <= now + CLOCK_SKEW_SECONDS && now - authTime <= GOOGLE_REAUTH_MAX_AUTH_AGE_SECONDS + CLOCK_SKEW_SECONDS;
}
