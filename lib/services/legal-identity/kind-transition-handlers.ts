/**
 * "מעבר לעוסק מורשה" — the HTTP handlers (routes under app/api/business/legal-identity/kind-transition/ are thin
 * wrappers). OFF (BUSINESS_KIND_TRANSITION_ENABLED not "true") → 404 everywhere, as if the routes did not exist.
 *
 *   GET    .../kind-transition                   eligibility, the required re-auth method, the acknowledgements,
 *                                                the effects, the identity on file, the history (if any)
 *   POST   .../kind-transition/preview           validates the input; answers the statement digest to confirm
 *   POST   .../kind-transition/reauth/password   password re-entry (login's ledger and lock) → proof cookie
 *   POST   .../kind-transition/reauth/google     Google re-auth start → { url } + the re-auth state cookie
 *   POST   .../kind-transition                   the transition: input + digest + a valid proof for THIS user,
 *                                                THIS session, THIS action, by the method the account requires
 *
 * The user and business are the verified session's; nothing identifying comes from the body. Every refusal writes
 * nothing; the database function re-checks everything in one transaction anyway.
 */
import bcrypt from "bcrypt";
import { NextResponse } from "next/server";

import { authRequiredResponse, getAuthContext } from "@/lib/auth";
import { LOGIN_FAILURE_POLICY, loginAccountRateKey } from "@/lib/auth/account-rate-key";
import { readAccountCredentials } from "@/lib/auth/google-link";
import { readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { clearReauthProofCookie, googleReauthAuthorizeUrl, setGoogleReauthCookie, setReauthProofCookie } from "@/lib/auth/google-reauth";
import {
  issueReauthProof,
  newGoogleReauthState,
  REAUTH_ACTIONS,
  requiredReauthMethod,
  sealGoogleReauthState,
  verifyReauthProof,
} from "@/lib/auth/sensitive-reauth";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import {
  evaluateKindTransitionEligibility,
  KIND_TRANSITION_ACKNOWLEDGEMENTS,
  KIND_TRANSITION_EFFECTS,
  kindTransitionOutcome,
  kindTransitionStatementSha256,
  validateKindTransitionInput,
  type KindTransitionInput,
} from "@/lib/legal-identity/kind-transition";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp, reserveAttempt } from "@/lib/security/rate-limit";
import {
  isBusinessKindTransitionEnabled,
  performKindTransition,
  readKindTransitionSnapshot,
} from "@/lib/services/legal-identity/kind-transition.service";

const ACTION = "BUSINESS_KIND_TRANSITION" as const;
const noStore = { "cache-control": "no-store" };
const TIMING_EQUALISER_HASH = "$2b$10$zN1gFgiX48MtiTQ9xbwAjOBLnk7QFfVFoISIbd2r/jR2k.4gSTfmq";

export type KindTransitionDeps = {
  enabled: () => boolean;
  context: typeof getAuthContext;
  snapshot: typeof readKindTransitionSnapshot;
  credentials: (userId: number) => Promise<{ email: string; password: string | null } | null>;
  perform: typeof performKindTransition;
  rateLimit: typeof consumeRateLimit;
  reserve: typeof reserveAttempt;
  compare: (plain: string, hash: string) => Promise<boolean>;
  googleConfig: typeof readGoogleLoginConfig;
  now: () => Date;
};
export const defaultKindTransitionDeps: KindTransitionDeps = {
  enabled: isBusinessKindTransitionEnabled,
  context: getAuthContext,
  snapshot: readKindTransitionSnapshot,
  credentials: readAccountCredentials,
  perform: performKindTransition,
  rateLimit: consumeRateLimit,
  reserve: reserveAttempt,
  compare: (plain, hash) => bcrypt.compare(plain, hash),
  googleConfig: readGoogleLoginConfig,
  now: () => new Date(),
};

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });
const serverError = (tag: string, error: unknown) => {
  console.error(`${tag}:`, safeErrorSummary(error));
  return json({ code: "SERVER_ERROR", error: "הפעולה לא הושלמה ולא נשמר שום שינוי. אפשר לנסות שוב." }, 500);
};

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function inputOf(b: Record<string, unknown>): KindTransitionInput {
  const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 64) : "");
  return {
    confirmTaxId: s(b.confirmTaxId),
    vatNumber: s(b.vatNumber),
    statusEffectiveDate: s(b.statusEffectiveDate),
    acknowledged: Array.isArray(b.acknowledged) ? b.acknowledged.filter((x): x is string => typeof x === "string").slice(0, 20) : [],
  };
}

function readProofCookie(req: Request): string | null {
  const name = REAUTH_ACTIONS[ACTION].cookie;
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim()) || null;
  }
  return null;
}

// ── GET ────────────────────────────────────────────────────────────────────────────────────────────

export async function handleKindTransitionGet(req: Request, deps: KindTransitionDeps = defaultKindTransitionDeps): Promise<NextResponse> {
  if (!deps.enabled()) return notFound();
  try {
    const ctx = await deps.context(req);
    if (!ctx) return authRequiredResponse(req);
    const [snap, creds] = await Promise.all([deps.snapshot(ctx.user.businessId, ctx.user.id), deps.credentials(ctx.user.id)]);
    if (!creds) return authRequiredResponse(req);
    return json({
      eligibility: evaluateKindTransitionEligibility(snap.state),
      reauthMethod: requiredReauthMethod({ hasPassword: !!creds.password }),
      identity: { legalName: snap.state.billingLegalName, taxId: snap.state.billingTaxId, kind: snap.state.billingBusinessKind },
      acknowledgements: KIND_TRANSITION_ACKNOWLEDGEMENTS,
      effects: KIND_TRANSITION_EFFECTS,
      history: snap.history,
    });
  } catch (error) {
    return serverError("KIND_TRANSITION_GET_ERROR", error);
  }
}

// ── preview ────────────────────────────────────────────────────────────────────────────────────────

/** Shared by preview and confirm: eligibility + validation against what is on file now. */
async function validated(ctx: { user: { id: number; businessId: number } }, body: Record<string, unknown>, deps: KindTransitionDeps) {
  const snap = await deps.snapshot(ctx.user.businessId, ctx.user.id);
  const elig = evaluateKindTransitionEligibility(snap.state);
  if (!elig.eligible) return { ok: false, error: json({ code: elig.block, error: elig.message }, 409) } as const;
  const v = validateKindTransitionInput(snap.state, inputOf(body));
  if (!v.ok) return { ok: false, error: json({ code: "INVALID_INPUT", problems: v.problems }, 400) } as const;
  const statementSha256 = kindTransitionStatementSha256({
    businessId: ctx.user.businessId,
    actorUserId: ctx.user.id,
    legalName: snap.state.billingLegalName ?? "",
    taxId: v.taxId,
    vatNumber: v.vatNumber,
    statusEffectiveDate: v.statusEffectiveDate,
  });
  return { ok: true, v, statementSha256 } as const;
}

export async function handleKindTransitionPreview(req: Request, deps: KindTransitionDeps = defaultKindTransitionDeps): Promise<NextResponse> {
  if (!deps.enabled()) return notFound();
  try {
    const ctx = await deps.context(req);
    if (!ctx) return authRequiredResponse(req);
    const body = await readBody(req);
    // stage "identity" (step 2): check what was typed so far — eligibility, id number, VAT number, date — before the
    // confirmations exist. It answers no digest: a digest is only ever issued for the full statement.
    if (body.stage === "identity") {
      const snap = await deps.snapshot(ctx.user.businessId, ctx.user.id);
      const elig = evaluateKindTransitionEligibility(snap.state);
      if (!elig.eligible) return json({ code: elig.block, error: elig.message }, 409);
      const v = validateKindTransitionInput(snap.state, { ...inputOf(body), acknowledged: KIND_TRANSITION_ACKNOWLEDGEMENTS.map((a) => a.id) });
      if (!v.ok) return json({ code: "INVALID_INPUT", problems: v.problems }, 400);
      return json({ ok: true });
    }
    const r = await validated(ctx, body, deps);
    if (!r.ok) return r.error;
    return json({ statementSha256: r.statementSha256, statusEffectiveDate: r.v.statusEffectiveDate, vatNumber: r.v.vatNumber });
  } catch (error) {
    return serverError("KIND_TRANSITION_PREVIEW_ERROR", error);
  }
}

// ── confirm ────────────────────────────────────────────────────────────────────────────────────────

export async function handleKindTransitionConfirm(req: Request, deps: KindTransitionDeps = defaultKindTransitionDeps): Promise<NextResponse> {
  if (!deps.enabled()) return notFound();
  try {
    const ctx = await deps.context(req);
    if (!ctx) return authRequiredResponse(req);
    const rl = await deps.rateLimit({ key: `bkt:confirm:${ctx.user.id}`, limit: 10, windowMs: 60 * 60_000 });
    if (!rl.allowed) return json({ code: "RATE_LIMITED", error: "יותר מדי ניסיונות. אפשר לנסות שוב מאוחר יותר." }, 429);

    const body = await readBody(req);
    const r = await validated(ctx, body, deps);
    if (!r.ok) return r.error;
    if (typeof body.statementSha256 !== "string" || body.statementSha256 !== r.statementSha256) {
      return json({ code: "STATEMENT_STALE", error: kindTransitionOutcome("STATEMENT_STALE").message }, 409);
    }

    const creds = await deps.credentials(ctx.user.id);
    if (!creds) return authRequiredResponse(req);
    const required = requiredReauthMethod({ hasPassword: !!creds.password });
    const proof = verifyReauthProof(readProofCookie(req), { userId: ctx.user.id, sessionId: ctx.sessionId, action: ACTION }, deps.now().getTime());
    if (!proof.ok || proof.method !== required) {
      return json({ code: "REAUTH_REQUIRED", reauthMethod: required, error: kindTransitionOutcome("REAUTH_REQUIRED").message }, 401);
    }

    const db = await deps.perform(ctx.user.businessId, ctx.user.id, {
      vatNumber: r.v.vatNumber,
      statusEffectiveDate: r.v.statusEffectiveDate,
      reauthMethod: proof.method,
      reauthAt: proof.reauthAt,
      statementSha256: r.statementSha256,
    });
    const o = kindTransitionOutcome(db);
    // An answer the route does not expect (e.g. an unreachable ISSUER_DECLARATION_* refusal): nothing was written; log
    // the status code only (a fixed vocabulary, never a value) so it can be traced.
    if (o.status === 500) console.error("KIND_TRANSITION_UNEXPECTED_DB_STATUS:", /^[A-Z_]{1,64}$/.test(db) ? db : "NON_CODE");
    const res = json({ code: o.code, error: o.status === 200 ? undefined : o.message, message: o.status === 200 ? o.message : undefined }, o.status);
    if (o.status === 200) clearReauthProofCookie(res, ACTION); // one transition per proof
    return res;
  } catch (error) {
    return serverError("KIND_TRANSITION_CONFIRM_ERROR", error);
  }
}

// ── re-authentication ──────────────────────────────────────────────────────────────────────────────

export async function handleKindTransitionReauthPassword(req: Request, deps: KindTransitionDeps = defaultKindTransitionDeps): Promise<NextResponse> {
  if (!deps.enabled()) return notFound();
  try {
    const ctx = await deps.context(req);
    if (!ctx) return authRequiredResponse(req);
    if (!ctx.sessionId) return json({ code: "SIGN_IN_AGAIN", error: "יש להתחבר מחדש ולנסות שוב." }, 401);

    const rl = await deps.rateLimit({ key: `auth:login:${getClientIp(req)}`, limit: 10, windowMs: 60_000 });
    if (!rl.allowed) return json({ code: "RATE_LIMITED", error: "יותר מדי ניסיונות. אפשר לנסות שוב בעוד דקה." }, 429);

    const password = (await readBody(req)).password;
    if (typeof password !== "string" || !password || password.length > 128) {
      return json({ code: "INVALID_BODY", error: "יש להזין את הסיסמה של החשבון." }, 400);
    }
    const creds = await deps.credentials(ctx.user.id);
    if (!creds) return authRequiredResponse(req);
    if (!creds.password) return json({ code: "USE_GOOGLE", error: "לחשבון אין סיסמה. האימות נעשה דרך Google." }, 409);

    const attempt = await deps.reserve({ key: loginAccountRateKey(normalizeEmail(creds.email)), limit: LOGIN_FAILURE_POLICY.limit, windowMs: LOGIN_FAILURE_POLICY.windowMs });
    if (!attempt.allowed) {
      const s = Math.max(1, Math.ceil(attempt.retryAfterMs / 1000));
      return NextResponse.json({ code: "LOGIN_LOCKED", error: "יותר מדי ניסיונות שגויים. אפשר לנסות שוב מאוחר יותר.", retryAfterSeconds: s }, { status: 429, headers: { ...noStore, "Retry-After": String(s) } });
    }
    if (!(await deps.compare(password, creds.password ?? TIMING_EQUALISER_HASH))) {
      if (attempt.count >= LOGIN_FAILURE_POLICY.limit) {
        // As login: the failure that reaches the limit locks AND says so (not "wrong password, try again").
        await attempt.lock(LOGIN_FAILURE_POLICY.lockMs);
        const s = Math.ceil(LOGIN_FAILURE_POLICY.lockMs / 1000);
        return NextResponse.json({ code: "LOGIN_LOCKED", error: "יותר מדי ניסיונות שגויים. אפשר לנסות שוב מאוחר יותר.", retryAfterSeconds: s }, { status: 429, headers: { ...noStore, "Retry-After": String(s) } });
      }
      return json({ code: "INVALID_PASSWORD", error: "הסיסמה שגויה." }, 401);
    }
    await attempt.clear();

    const res = json({ ok: true, method: "PASSWORD" });
    setReauthProofCookie(res, ACTION, issueReauthProof({ userId: ctx.user.id, sessionId: ctx.sessionId, action: ACTION, method: "PASSWORD" }, deps.now().getTime()));
    return res;
  } catch (error) {
    return serverError("KIND_TRANSITION_REAUTH_PASSWORD_ERROR", error);
  }
}

export async function handleKindTransitionReauthGoogle(req: Request, deps: KindTransitionDeps = defaultKindTransitionDeps): Promise<NextResponse> {
  if (!deps.enabled()) return notFound();
  try {
    const ctx = await deps.context(req);
    if (!ctx) return authRequiredResponse(req);
    if (!ctx.sessionId) return json({ code: "SIGN_IN_AGAIN", error: "יש להתחבר מחדש ולנסות שוב." }, 401);
    const config = deps.googleConfig();
    if (!config) return json({ code: "GOOGLE_UNAVAILABLE", error: "האימות דרך Google אינו זמין כרגע." }, 409);
    const creds = await deps.credentials(ctx.user.id);
    if (!creds) return authRequiredResponse(req);
    if (creds.password) return json({ code: "USE_PASSWORD", error: "לחשבון יש סיסמה. האימות נעשה בהזנת הסיסמה." }, 409);

    const rl = await deps.rateLimit({ key: `bkt:reauth:google:${ctx.user.id}`, limit: 10, windowMs: 10 * 60_000 });
    if (!rl.allowed) return json({ code: "RATE_LIMITED", error: "יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות." }, 429);

    const state = newGoogleReauthState({ userId: ctx.user.id, sessionId: ctx.sessionId, action: ACTION }, deps.now().getTime());
    const res = json({ url: googleReauthAuthorizeUrl(config, state) });
    setGoogleReauthCookie(res, sealGoogleReauthState(state));
    return res;
  } catch (error) {
    return serverError("KIND_TRANSITION_REAUTH_GOOGLE_ERROR", error);
  }
}
