/**
 * "Continue with Google", milestone 2 — the pure half (no database, no network): the flag and its config,
 * the signed start state, the authorization request, and the four routes driven with injected stand-ins.
 *   npx tsx lib/auth/google-login.test.ts
 *
 * The database half — the one account transaction, single use under concurrency, replay, rollback, consent
 * recorded with the real grants, the linked / existing / closed outcomes on real rows — is .agl/app-battery-m2.ts;
 * the browser half (desktop / tablet / phone, cancel and return) is .agl/browser-m2.ts. The server-side cancel
 * on real rows (a copy of the secret, both race orders, a database failure and retry) is .agl/app-battery-cancel.ts.
 */
process.env.AUTH_TOKEN_SECRET ??= "pure_test_auth_token_secret_0123456789abcdef0123456789";

import fs from "node:fs";
import path from "node:path";

import {
  authorizeUrl,
  GOOGLE_LOGIN_SCOPES,
  GOOGLE_START_COOKIE,
  GOOGLE_TICKET_COOKIE,
  isGoogleLoginEnabled,
  newStartState,
  openStartState,
  readGoogleLoginConfig,
  sealStartState,
  type GoogleLoginConfig,
} from "./google-oauth";
import { googleNoticeFor, GOOGLE_NOTICES } from "./google-notices";
import { normalizeGoogleSignupInput, SignupValidationError } from "./signup-identity";
import { cancelSignupTicket, SignupTicketRefusedError, type TicketCancelOutcome } from "./oauth-ticket";
import { EmailAlreadyRegisteredError, type CreatedGoogleAccount } from "./signup";
import { handleGoogleStart } from "@/app/api/auth/google/start/route";
import { handleGoogleCallback, type CallbackRouteDeps } from "@/app/api/auth/google/callback/route";
import { handleGoogleComplete, type CompleteDeps } from "@/app/api/auth/google/complete/route";
import { handleTicketCancel, handleTicketRead } from "@/app/api/auth/google/ticket/route";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const ON = {
  AUTH_GOOGLE_LOGIN_ENABLED: "true",
  AUTH_GOOGLE_LOGIN_MODE: "open",
  GOOGLE_LOGIN_CLIENT_ID: "client-1.apps.googleusercontent.com",
  GOOGLE_LOGIN_CLIENT_SECRET: "lab-secret",
  GOOGLE_LOGIN_REDIRECT_BASE_URL: "https://app.dubiz.test",
};
const config = readGoogleLoginConfig(ON) as GoogleLoginConfig;
const OFF = () => null;
const allow = async () => ({ allowed: true, remaining: 1, resetAt: 0 });
const deny = async () => ({ allowed: false, remaining: 0, resetAt: 0 });
const noUsage = async () => undefined;
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`)) ?? "";
const locationOf = (res: Response) => res.headers.get("location") ?? "";

async function main() {
  // ── the flag ──────────────────────────────────────────────────────────────
  ok("OFF by default", !isGoogleLoginEnabled({}));
  ok("OFF when the flag is anything but the string true", !isGoogleLoginEnabled({ ...ON, AUTH_GOOGLE_LOGIN_ENABLED: "1" }));
  for (const k of ["GOOGLE_LOGIN_CLIENT_ID", "GOOGLE_LOGIN_CLIENT_SECRET", "GOOGLE_LOGIN_REDIRECT_BASE_URL"] as const) {
    ok(`OFF when ${k} is missing (no half-configured state)`, !isGoogleLoginEnabled({ ...ON, [k]: "" }));
  }
  ok("OFF for an http redirect base that is not local", !isGoogleLoginEnabled({ ...ON, GOOGLE_LOGIN_REDIRECT_BASE_URL: "http://app.dubiz.test" }));
  ok("OFF for a redirect base with a path", !isGoogleLoginEnabled({ ...ON, GOOGLE_LOGIN_REDIRECT_BASE_URL: "https://app.dubiz.test/x" }));
  ok("ON with the flag and a complete config", isGoogleLoginEnabled(ON) && config.authorizeUrl.startsWith("https://accounts.google.com/"));
  const testEnv = { ...ON, GOOGLE_LOGIN_TEST_ENDPOINTS: "1", GOOGLE_LOGIN_TEST_AUTHORIZE_URL: "http://localhost:9/a", GOOGLE_LOGIN_TEST_TOKEN_URL: "http://localhost:9/t", GOOGLE_LOGIN_TEST_JWKS_URL: "http://localhost:9/j" };
  ok("lab stand-in endpoints are honoured outside Vercel only", readGoogleLoginConfig(testEnv)?.tokenUrl === "http://localhost:9/t");
  const onVercel = readGoogleLoginConfig({ ...testEnv, VERCEL_ENV: "preview" });
  ok("on any Vercel deployment the real Google endpoints are used whatever is configured",
    onVercel?.tokenUrl === "https://oauth2.googleapis.com/token" && onVercel?.jwksUrl === null && onVercel?.authorizeUrl.startsWith("https://accounts.google.com/"));

  // ── the authorization request ─────────────────────────────────────────────
  const st = newStartState("login");
  const url = new URL(authorizeUrl(config, st));
  ok("scope is exactly openid email profile", url.searchParams.get("scope") === "openid email profile" && GOOGLE_LOGIN_SCOPES === "openid email profile");
  ok("no Gmail / Drive / Calendar / offline access is requested",
    !/gmail|drive|calendar/i.test(url.toString()) && !url.searchParams.has("access_type"));
  ok("PKCE S256, state and nonce are sent", url.searchParams.get("code_challenge_method") === "S256"
    && url.searchParams.get("state") === st.state && url.searchParams.get("nonce") === st.nonce && (url.searchParams.get("code_challenge") ?? "").length === 43);
  ok("the person always picks the account (prompt=select_account)", url.searchParams.get("prompt") === "select_account");
  ok("redirect_uri is the configured base + the callback path", url.searchParams.get("redirect_uri") === "https://app.dubiz.test/api/auth/google/callback");

  // ── the start state ───────────────────────────────────────────────────────
  const sealed = sealStartState(st);
  ok("the sealed state opens", openStartState(sealed)?.state === st.state);
  const [body, sig] = sealed.split(".");
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), from: "register" })).toString("base64url");
  ok("an altered state is refused", openStartState(`${altered}.${sig}`) === null);
  ok("a forged signature is refused", openStartState(`${body}.${"A".repeat(43)}`) === null);
  ok("an expired state is refused", openStartState(sealed, (st.exp + 1) * 1000) === null);
  ok("garbage and nothing are refused", openStartState("x.y.z") === null && openStartState(null) === null);

  // ── notices ───────────────────────────────────────────────────────────────
  ok("a known reason is shown", googleNoticeFor("existing") === "existing" && GOOGLE_NOTICES.existing.includes("קיים"));
  ok("an unknown reason is never echoed", googleNoticeFor("<script>") === null && googleNoticeFor("toString") === null);

  // ── completion input ──────────────────────────────────────────────────────
  const valid = normalizeGoogleSignupInput({ name: "  דנה כהן ", businessName: " מאפיית דנה ", acceptTerms: true });
  ok("completion input: the signup rules, trimmed", valid.name === "דנה כהן" && valid.businessName === "מאפיית דנה");
  for (const [label, input, field] of [
    ["no business name", { name: "דנה", businessName: "", acceptTerms: true }, "businessName"],
    ["no name", { name: "", businessName: "עסק", acceptTerms: true }, "name"],
    ["consent not given", { name: "דנה", businessName: "עסק", acceptTerms: false }, "acceptTerms"],
    ['consent as the string "true"', { name: "דנה", businessName: "עסק", acceptTerms: "true" }, "acceptTerms"],
  ] as const) {
    let got = "";
    try { normalizeGoogleSignupInput(input as never); } catch (e) { got = e instanceof SignupValidationError ? e.field : "other"; }
    ok(`completion input refused: ${label}`, got === field, got);
  }

  // ── routes: OFF → 404 everywhere ──────────────────────────────────────────
  const get = (u: string, cookie = "") => new Request(`https://app.dubiz.test${u}`, { headers: cookie ? { cookie } : {} });
  ok("OFF: start → 404", (await handleGoogleStart(get("/api/auth/google/start"), { config: OFF, rateLimit: allow })).status === 404);
  const offCallback = { config: OFF, exchange: async () => "x", resolve: async () => ({ kind: "existing_account" as const }), rateLimit: allow, recordUsage: noUsage };
  ok("OFF: callback → 404", (await handleGoogleCallback(get("/api/auth/google/callback?code=c&state=s"), offCallback)).status === 404);
  let offCancels = 0;
  ok("OFF: ticket read / cancel → 404, and the cancel reaches nothing",
    (await handleTicketRead(get("/api/auth/google/ticket"), { config: OFF, read: async () => null })).status === 404
    && (await handleTicketCancel(get("/api/auth/google/ticket"), { config: OFF, cancel: async () => { offCancels += 1; return "CANCELLED"; }, rateLimit: allow })).status === 404
    && offCancels === 0);

  let created = 0;
  const account: CreatedGoogleAccount = {
    userId: 7, businessId: 9, email: "a@b.co", name: "דנה", businessName: "עסק", tokenVersion: 0,
    session: { sessionId: "s", credential: "sid.secret", absoluteExpiresAt: new Date(Date.now() + 86_400_000) },
    welcomeEmailId: 3, identityId: 1,
  };
  const completeDeps = (over: Partial<CompleteDeps> = {}): CompleteDeps => ({
    config: () => config, isSignupEnabled: () => true,
    signupAllowlist: () => ({ configured: false, size: 0, error: null, has: () => false }) as never,
    readTicket: async () => ({ email: "a@b.co", name: "דנה", expiresAt: new Date() }),
    rateLimit: allow, createAccount: async () => { created++; return account; }, recordUsage: noUsage, scheduleWelcome: () => {},
    ...over,
  });
  const post = (b: unknown, extra: Record<string, string> = {}) => new Request("https://app.dubiz.test/api/auth/google/complete", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.dubiz.test", host: "app.dubiz.test", "sec-fetch-site": "same-origin", cookie: `${GOOGLE_TICKET_COOKIE}=${"T".repeat(43)}`, ...extra },
    body: JSON.stringify(b),
  });
  const form = { name: "דנה כהן", businessName: "מאפיית דנה", acceptTerms: true };
  ok("OFF: complete → 404, nothing created", (await handleGoogleComplete(post(form), completeDeps({ config: OFF }))).status === 404 && created === 0);

  // ── start ─────────────────────────────────────────────────────────────────
  const started = await handleGoogleStart(get("/api/auth/google/start?from=register"), { config: () => config, rateLimit: allow });
  const startCookie = cookieOf(started, GOOGLE_START_COOKIE);
  ok("start → 303 to Google", started.status === 303 && locationOf(started).startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
  ok("start cookie: httpOnly, SameSite=Lax, scoped to the callback", /HttpOnly/i.test(startCookie) && /SameSite=lax/i.test(startCookie) && /Path=\/api\/auth\/google\/callback/.test(startCookie));
  ok("start rate limit → back to login, no Google trip", locationOf(await handleGoogleStart(get("/api/auth/google/start"), { config: () => config, rateLimit: deny })).includes("/login?google=busy"));

  // ── callback ──────────────────────────────────────────────────────────────
  const sealedReg = decodeURIComponent(startCookie.split(";")[0].slice(GOOGLE_START_COOKIE.length + 1));
  const opened = openStartState(sealedReg)!;
  const withStart = (q: string) => get(`/api/auth/google/callback?${q}`, `${GOOGLE_START_COOKIE}=${encodeURIComponent(sealedReg)}`);
  let resolved = 0;
  const cb = (outcome: Awaited<ReturnType<CallbackRouteDeps["resolve"]>>, over: Partial<CallbackRouteDeps> = {}): CallbackRouteDeps => ({
    config: () => config, exchange: async () => "id.token.here", resolve: async () => { resolved++; return outcome; }, rateLimit: allow, recordUsage: noUsage, ...over,
  });
  const cancelled = await handleGoogleCallback(withStart("error=access_denied"), cb({ kind: "existing_account" }));
  ok("cancel at Google → back to where it started, nothing resolved", locationOf(cancelled).endsWith("/register?google=cancelled") && resolved === 0);
  ok("…and the start cookie is cleared", /Max-Age=0/.test(cookieOf(cancelled, GOOGLE_START_COOKIE)));
  ok("no start cookie → expired, nothing resolved",
    locationOf(await handleGoogleCallback(get(`/api/auth/google/callback?code=c&state=${opened.state}`), cb({ kind: "existing_account" }))).endsWith("/login?google=expired") && resolved === 0);
  ok("a state that is not this browser's → expired, nothing resolved",
    locationOf(await handleGoogleCallback(withStart("code=c&state=someone-else"), cb({ kind: "existing_account" }))).endsWith("/login?google=expired") && resolved === 0);
  ok("a failed code exchange → error, nothing resolved",
    locationOf(await handleGoogleCallback(withStart(`code=c&state=${opened.state}`), cb({ kind: "existing_account" }, { exchange: async () => null }))).endsWith("/register?google=error") && resolved === 0);
  const ticketRes = await handleGoogleCallback(withStart(`code=c&state=${opened.state}`), cb({ kind: "ticket", secret: "S".repeat(43) }));
  ok("new person → /register/google with the ticket cookie, and NO session cookie",
    locationOf(ticketRes).endsWith("/register/google") && cookieOf(ticketRes, GOOGLE_TICKET_COOKIE).includes("S".repeat(43)) && cookieOf(ticketRes, "dubiz_rt") === "");
  ok("ticket cookie: httpOnly, SameSite=Lax, scoped to /api/auth/google, 30 minutes",
    /HttpOnly/i.test(cookieOf(ticketRes, GOOGLE_TICKET_COOKIE)) && /Path=\/api\/auth\/google(;|$)/.test(cookieOf(ticketRes, GOOGLE_TICKET_COOKIE)) && /Max-Age=1800/.test(cookieOf(ticketRes, GOOGLE_TICKET_COOKIE)));
  const sessionRes = await handleGoogleCallback(withStart(`code=c&state=${opened.state}`), cb({ kind: "session", userId: 1, businessId: 2, credential: "sid.sec", absoluteExpiresAt: new Date(Date.now() + 86_400_000) }));
  ok("linked account → /auth/google/done with the refresh cookie; the URL carries no token",
    locationOf(sessionRes).endsWith("/auth/google/done") && cookieOf(sessionRes, "dubiz_rt").startsWith("dubiz_rt=sid.sec") && !/token|sid\.sec/.test(locationOf(sessionRes)));
  for (const [kind, want] of [["existing_account", "/login?google=existing"], ["signup_closed", "/register?google=closed"]] as const) {
    const r = await handleGoogleCallback(withStart(`code=c&state=${opened.state}`), cb({ kind } as never));
    ok(`${kind} → ${want}, no session, no ticket`, locationOf(r).endsWith(want) && cookieOf(r, "dubiz_rt") === "" && cookieOf(r, GOOGLE_TICKET_COOKIE) === "");
  }
  const admin = await handleGoogleCallback(withStart(`code=c&state=${opened.state}`), cb({ kind: "refused", reason: "PLATFORM_ADMIN" }));
  ok("platform admin → /login?google=admin, no session", locationOf(admin).endsWith("/login?google=admin") && cookieOf(admin, "dubiz_rt") === "");
  const doomed = await handleGoogleCallback(withStart(`code=c&state=${opened.state}`), cb({ kind: "refused", reason: "BUSINESS_UNAVAILABLE" }));
  ok("business in deletion → /login?google=unavailable, no session", locationOf(doomed).endsWith("/login?google=unavailable") && cookieOf(doomed, "dubiz_rt") === "");
  const bad = await handleGoogleCallback(withStart(`code=c&state=${opened.state}`), cb({ kind: "invalid_token", reason: "AUDIENCE" }));
  ok("a refused ID token → error, nothing else", locationOf(bad).endsWith("/register?google=error") && cookieOf(bad, "dubiz_rt") === "" && cookieOf(bad, GOOGLE_TICKET_COOKIE) === "");

  // ── complete ──────────────────────────────────────────────────────────────
  created = 0;
  const done = await handleGoogleComplete(post(form), completeDeps());
  const doneBody = await done.json();
  ok("complete → 200, the refresh cookie, the ticket cookie cleared, no token in the body",
    done.status === 200 && doneBody.next === "/setup" && cookieOf(done, "dubiz_rt").startsWith("dubiz_rt=sid.secret") && /Max-Age=0/.test(cookieOf(done, GOOGLE_TICKET_COOKIE)) && !("token" in doneBody) && created === 1);
  created = 0;
  ok("cross-site POST → 403, nothing created",
    (await handleGoogleComplete(post(form, { origin: "https://evil.example" }), completeDeps())).status === 403 && created === 0);
  const closed = await handleGoogleComplete(post(form), completeDeps({ isSignupEnabled: () => false }));
  ok("signup closed, no list → 403 SIGNUP_DISABLED, nothing created", closed.status === 403 && (await closed.json()).code === "SIGNUP_DISABLED" && created === 0);
  const listed = (email: string) => ({ configured: true, size: 1, error: null, has: (e: string) => e === email }) as never;
  ok("signup closed, the ticket's address NOT listed → 403, nothing created",
    (await handleGoogleComplete(post(form), completeDeps({ isSignupEnabled: () => false, signupAllowlist: () => listed("x@y.co") }))).status === 403 && created === 0);
  ok("signup closed, the ticket's address listed → the account is created",
    (await handleGoogleComplete(post(form), completeDeps({ isSignupEnabled: () => false, signupAllowlist: () => listed("a@b.co") }))).status === 200 && created === 1);
  created = 0;
  ok("rate limited (the register route's key) → 429, nothing created", (await handleGoogleComplete(post(form), completeDeps({ rateLimit: deny }))).status === 429 && created === 0);
  const noTerms = await handleGoogleComplete(post({ ...form, acceptTerms: false }), completeDeps());
  ok("consent missing → 400 on acceptTerms, nothing created", noTerms.status === 400 && (await noTerms.json()).field === "acceptTerms" && created === 0);
  ok("no business name → 400, nothing created", (await handleGoogleComplete(post({ ...form, businessName: " " }), completeDeps())).status === 400 && created === 0);
  ok("honeypot filled → 400, nothing created", (await handleGoogleComplete(post({ ...form, dz_confirm_field: "x" }), completeDeps())).status === 400 && created === 0);
  const refused = await handleGoogleComplete(post(form), completeDeps({ createAccount: async () => { throw new SignupTicketRefusedError(); } }));
  ok("spent / expired ticket → 409 TICKET_REFUSED, cookie cleared, no session cookie",
    refused.status === 409 && (await refused.json()).code === "TICKET_REFUSED" && /Max-Age=0/.test(cookieOf(refused, GOOGLE_TICKET_COOKIE)) && cookieOf(refused, "dubiz_rt") === "");
  const dup = await handleGoogleComplete(post(form), completeDeps({ createAccount: async () => { throw new EmailAlreadyRegisteredError(); } }));
  ok("address registered meanwhile → 409 EMAIL_ALREADY_REGISTERED, no session cookie",
    dup.status === 409 && (await dup.json()).code === "EMAIL_ALREADY_REGISTERED" && cookieOf(dup, "dubiz_rt") === "");

  // ── ticket read / cancel ──────────────────────────────────────────────────
  const view = await handleTicketRead(get("/api/auth/google/ticket"), { config: () => config, read: async () => ({ email: "a@b.co", name: "דנה", expiresAt: new Date() }) });
  ok("ticket view: address and name only", view.status === 200 && Object.keys(await view.json()).sort().join(",") === "email,expiresAt,name");
  const gone = await handleTicketRead(get("/api/auth/google/ticket"), { config: () => config, read: async () => null });
  ok("no open ticket → 401 and the cookie cleared", gone.status === 401 && /Max-Age=0/.test(cookieOf(gone, GOOGLE_TICKET_COOKIE)));

  // ── ticket cancel: ended on the server first; a failure is never answered as cancelled ──
  const SECRET = "Ab-_".repeat(10) + "xyz"; // 43 base64url characters: the shape of a ticket secret
  const del = (cookie: string | null, site = "same-origin") => new Request("https://app.dubiz.test/api/auth/google/ticket", {
    method: "DELETE",
    headers: { origin: "https://app.dubiz.test", host: "app.dubiz.test", "sec-fetch-site": site, "x-forwarded-for": "198.51.100.7",
      ...(cookie ? { cookie: `${GOOGLE_TICKET_COOKIE}=${cookie}` } : {}) },
  });
  let cancels: unknown[] = [];
  const cancelDeps = (answer: () => Promise<TicketCancelOutcome>, rateLimit: typeof allow = allow) =>
    ({ config: () => config, cancel: async (s: unknown) => { cancels.push(s); return answer(); }, rateLimit });
  const cleared = (res: Response) => /Max-Age=0/.test(cookieOf(res, GOOGLE_TICKET_COOKIE));
  const untouched = (res: Response) => cookieOf(res, GOOGLE_TICKET_COOKIE) === "";
  for (const [answer, status] of [["CANCELLED", "cancelled"], ["ALREADY_CANCELLED", "cancelled"], ["EXPIRED", "ended"], ["SUPERSEDED", "ended"], ["NOT_FOUND", "ended"]] as const) {
    cancels = [];
    const res = await handleTicketCancel(del(SECRET), cancelDeps(async () => answer));
    ok(`cancel: ${answer} → 200 ${status}, the cookie cleared, the held secret sent to the server`,
      res.status === 200 && (await res.json()).status === status && cleared(res) && cancels.length === 1 && cancels[0] === SECRET);
  }
  const completedFirst = await handleTicketCancel(del(SECRET), cancelDeps(async () => "COMPLETED"));
  ok("cancel after the signup completed → 409 ALREADY_COMPLETED, the cookie cleared",
    completedFirst.status === 409 && (await completedFirst.json()).code === "ALREADY_COMPLETED" && cleared(completedFirst));
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  let failedRes: Response;
  try {
    failedRes = await handleTicketCancel(del(SECRET), cancelDeps(async () => { throw Object.assign(new Error(`permission denied (${SECRET})`), { code: "P2010" }); }));
  } finally {
    console.error = realError;
  }
  ok("cancel: the database fails → 503 CANCEL_FAILED, NOT cancelled",
    failedRes.status === 503 && (await failedRes.json()).code === "CANCEL_FAILED");
  ok("…the ticket cookie is KEPT (no Set-Cookie for it), so the cancel can be tried again", untouched(failedRes));
  ok("…the failure is logged without the secret", logged.length === 1 && logged[0].includes("cancel_failed") && !logged.join("").includes(SECRET), logged.join(" | "));
  cancels = [];
  const limited = await handleTicketCancel(del(SECRET), cancelDeps(async () => "CANCELLED", deny));
  ok("cancel: the rate limit → 429, nothing sent to the server, the cookie kept", limited.status === 429 && cancels.length === 0 && untouched(limited));
  const limiterDown = await handleTicketCancel(del(SECRET), cancelDeps(async () => "CANCELLED", async () => { throw new Error("limiter down"); }));
  ok("cancel: the limiter fails → 503, the cookie kept", limiterDown.status === 503 && untouched(limiterDown));

  // A failure never locks the person out of the retry: one browser, one held cookie, in sequence — the limiter
  // down, then the database refusing, then both healthy. The limiter counts what it is asked to count (the
  // route's own key and limit) the way the real one does, and a failed limiter call records nothing.
  const counted = new Map<string, number>();
  let limiterHealthy = false;
  let databaseHealthy = false;
  const countingLimiter = async ({ key, limit }: { key: string; limit: number; windowMs: number }) => {
    if (!limiterHealthy) throw new Error("limiter down");
    const used = (counted.get(key) ?? 0) + 1;
    counted.set(key, used);
    return { allowed: used <= limit, remaining: Math.max(0, limit - used), resetAt: 0 };
  };
  const retryDeps = { config: () => config, rateLimit: countingLimiter,
    cancel: async () => { if (!databaseHealthy) throw new Error("database down"); return "CANCELLED" as const; } };
  const silenced = console.error;
  console.error = () => {};
  const seq: Response[] = [];
  try {
    seq.push(await handleTicketCancel(del(SECRET), retryDeps)); // 1: the limiter is down
    limiterHealthy = true;
    for (let i = 0; i < 18; i += 1) seq.push(await handleTicketCancel(del(SECRET), retryDeps)); // 2–19: the database refuses
    databaseHealthy = true;
    seq.push(await handleTicketCancel(del(SECRET), retryDeps)); // 20: both healthy
  } finally {
    console.error = silenced;
  }
  const last = seq[seq.length - 1];
  ok("retry after a limiter failure, then 18 database failures: every failure → 503 with the cookie kept",
    seq.slice(0, -1).every((r) => r.status === 503 && untouched(r)), seq.map((r) => r.status).join(","));
  ok("…and the retry that follows → 200 cancelled (the limiter failure recorded nothing; the database failures stayed within the limit)",
    last.status === 200 && (await last.json()).status === "cancelled" && cleared(last) && counted.get("auth:google-cancel:198.51.100.7") === 19);
  cancels = [];
  const crossSite = await handleTicketCancel(del(SECRET, "cross-site"), cancelDeps(async () => "CANCELLED"));
  ok("cancel: cross-site → 403, nothing sent to the server, the cookie kept", crossSite.status === 403 && cancels.length === 0 && untouched(crossSite));
  const noOrigin = await handleTicketCancel(new Request("https://app.dubiz.test/api/auth/google/ticket", { method: "DELETE", headers: { cookie: `${GOOGLE_TICKET_COOKIE}=${SECRET}` } }), cancelDeps(async () => "CANCELLED"));
  ok("cancel: no Origin → 403", noOrigin.status === 403 && cancels.length === 0);
  const none = await handleTicketCancel(del(null), cancelDeps(async () => "CANCELLED"));
  ok("cancel without a ticket → 200 ended, nothing sent to the server", none.status === 200 && (await none.json()).status === "ended" && cancels.length === 0);
  const junk = await handleTicketCancel(del("not-a-ticket"), cancelDeps(async () => "CANCELLED"));
  ok("cancel with a value that cannot be a ticket → 200 ended, nothing sent, the cookie cleared", junk.status === 200 && cancels.length === 0 && cleared(junk));
  ok("cancelSignupTicket: a value that cannot be a ticket never reaches the database",
    (await cancelSignupTicket("short", { $queryRaw: (() => { throw new Error("reached the database"); }) as never, $executeRaw: (() => 0) as never })) === "NOT_FOUND");
  ok("cancelSignupTicket: an answer outside the vocabulary is an error, never a success",
    await cancelSignupTicket(SECRET, { $queryRaw: (async () => [{ outcome: "OK" }]) as never, $executeRaw: (() => 0) as never }).then(() => false, () => true));

  // ── static scope ──────────────────────────────────────────────────────────
  const ROOT = process.cwd();
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
  const routes = ["start", "callback", "ticket", "complete"].map((r) => read(`app/api/auth/google/${r}/route.ts`));
  ok("every Google route answers 404 when OFF (the config is read first)", routes.every((s) => /if \(!(deps\.config\(\)|config)\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/.test(s)));
  ok("no Google route mints an access token", routes.every((s) => !/signAuthToken/.test(s)));
  ok("no Google route reaches the database directly", routes.every((s) => !/prisma-auth|\$queryRaw|authDb\(/.test(s)));
  ok("the pages 404 when OFF", /if \(!isGoogleLoginEnabled\(\)\) notFound\(\);/.test(read("app/register/google/page.tsx")) && /if \(!isGoogleLoginEnabled\(\)\) notFound\(\);/.test(read("app/auth/google/done/page.tsx")));
  ok("the button is hidden inside the native shell", /isNative\(\)/.test(read("components/auth/google-sign-in.tsx")));
  ok("the password login route is unchanged by milestone 2 (imports no Google module)", !/from ["']@\/lib\/auth\/(google|oauth-ticket)/.test(read("app/api/auth/login/route.ts")));

  console.log(`\n[google-login] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
