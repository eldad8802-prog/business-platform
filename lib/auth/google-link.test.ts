/**
 * "Continue with Google", milestone 3 — linking Google to an existing account: the pure half (no database, no
 * network). Every link route driven with injected stand-ins, the emails, and the static scope.
 *   npx tsx lib/auth/google-link.test.ts
 *
 * The database half — both proofs on real rows, the shared login attempt ledger, the emailed link (scan, other
 * browser, expired, used, superseded), swaps, concurrency, rollback, administrator / deletion, unlink, notice
 * dedupe — is .agl/app-battery-m3.ts; the browser half is .agl/browser-m3.ts; the database functions alone are
 * .agl/link-battery.ts.
 */
process.env.AUTH_TOKEN_SECRET ??= "pure_test_auth_token_secret_0123456789abcdef0123456789";

import fs from "node:fs";
import path from "node:path";

import { LOGIN_FAILURE_POLICY, loginAccountRateKey } from "./account-rate-key";
import { buildEmailLink, deriveLinkSecret, EMAIL_LINK_PATHS } from "./email-link";
import { GoogleLinkRefusedError, type CompletedLink } from "./google-link";
import { GOOGLE_LINK_COOKIE, readGoogleLoginConfig, type GoogleLoginConfig } from "./google-oauth";
import { normalizeEmail } from "./signup-identity";
import { handleLinkCancel, handleLinkTicketRead } from "@/app/api/auth/google/link/route";
import { handleLinkPassword, type LinkPasswordDeps } from "@/app/api/auth/google/link/password/route";
import { handleLinkEmailRequest } from "@/app/api/auth/google/link/email/route";
import { handleLinkEmailCheck } from "@/app/api/auth/google/link/email/check/route";
import { handleLinkEmailComplete } from "@/app/api/auth/google/link/email/complete/route";
import { handleGoogleStatus, handleGoogleUnlink, type GoogleSecurityDeps } from "@/app/api/security/google/route";
import { accountLinkDedupeKey, EMAIL_KINDS, googleNoticeDedupeKey, renderStored } from "@/lib/email/transactional/registry";

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

const config = readGoogleLoginConfig({
  AUTH_GOOGLE_LOGIN_ENABLED: "true",
  AUTH_PLANE_ENABLED: "true",
  AUTH_GOOGLE_LOGIN_MODE: "open",
  GOOGLE_LOGIN_CLIENT_ID: "client-1.apps.googleusercontent.com",
  GOOGLE_LOGIN_CLIENT_SECRET: "lab-secret",
  GOOGLE_LOGIN_REDIRECT_BASE_URL: "https://app.dubiz.test",
}) as GoogleLoginConfig;
const ON = () => config;
const OFF = () => null;
const allow = async () => ({ allowed: true, remaining: 1, resetAt: 0 });
const deny = async () => ({ allowed: false, remaining: 0, resetAt: 0 });
const SECRET = "Ab-_".repeat(10) + "xyz";
const EMAIL = "dana@lab.invalid";
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`)) ?? "";
const cleared = (res: Response) => /Max-Age=0/.test(cookieOf(res, GOOGLE_LINK_COOKIE));
const kept = (res: Response) => cookieOf(res, GOOGLE_LINK_COOKIE) === "";
const req = (p: string, init: { method?: string; body?: unknown; cookie?: boolean; site?: string; origin?: boolean; auth?: string } = {}) =>
  new Request(`https://app.dubiz.test${p}`, {
    method: init.method ?? "POST",
    headers: {
      host: "app.dubiz.test",
      "x-forwarded-for": "198.51.100.9",
      "content-type": "application/json",
      ...(init.origin === false ? {} : { origin: "https://app.dubiz.test" }),
      "sec-fetch-site": init.site ?? "same-origin",
      ...(init.cookie === false ? {} : { cookie: `${GOOGLE_LINK_COOKIE}=${SECRET}` }),
      ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
const linked: CompletedLink = { userId: 7, businessId: 70, identityId: 700, session: { sessionId: "s", credential: "refresh-credential-value", absoluteExpiresAt: new Date(Date.now() + 86_400_000) }, noticeEmailId: 7000 };

async function main() {
  // ── OFF: every route answers 404 and reaches nothing ───────────────────────
  let reached = 0;
  const reach = async () => { reached += 1; return null as never; };
  const offs = await Promise.all([
    handleLinkTicketRead(req("/api/auth/google/link", { method: "GET" }), { config: OFF, read: reach }),
    handleLinkCancel(req("/api/auth/google/link", { method: "DELETE" }), { config: OFF, cancel: reach, rateLimit: reach }),
    handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "x" } }), { config: OFF } as unknown as LinkPasswordDeps),
    handleLinkEmailRequest(req("/api/auth/google/link/email"), { config: OFF, readTicket: reach, rateLimit: reach, request: reach, deliver: reach }),
    handleLinkEmailCheck(req("/api/auth/google/link/email/check", { body: {} }), { config: OFF, check: reach, rateLimit: reach }),
    handleLinkEmailComplete(req("/api/auth/google/link/email/complete", { body: {} }), { config: OFF, readTicket: reach, rateLimit: reach, complete: reach, deliver: reach }),
    handleGoogleStatus(req("/api/security/google", { method: "GET" }), { config: OFF } as unknown as GoogleSecurityDeps),
    handleGoogleUnlink(req("/api/security/google", { body: {} }), { config: OFF } as unknown as GoogleSecurityDeps),
  ]);
  ok("OFF: every link and settings route → 404, and nothing behind them is reached", offs.every((r) => r.status === 404) && reached === 0, offs.map((r) => r.status).join(","));

  // ── the link screen's view and cancel ──────────────────────────────────────
  const view = await handleLinkTicketRead(req("/api/auth/google/link", { method: "GET" }), { config: ON, read: async () => ({ email: EMAIL, name: "דנה", expiresAt: new Date() }) });
  ok("view: the address, the name and the expiry — no account id, no business, nothing to send back as authority", view.status === 200 && Object.keys(await view.json()).sort().join(",") === "email,expiresAt,name");
  const noView = await handleLinkTicketRead(req("/api/auth/google/link", { method: "GET" }), { config: ON, read: async () => null });
  ok("view: no open LINK ticket → 401, the cookie cleared", noView.status === 401 && cleared(noView));
  const cancelOk = await handleLinkCancel(req("/api/auth/google/link", { method: "DELETE" }), { config: ON, cancel: async () => "CANCELLED", rateLimit: allow });
  ok("cancel: ended on the server → 200 cancelled, the cookie cleared", cancelOk.status === 200 && (await cancelOk.json()).status === "cancelled" && cleared(cancelOk));
  const cancelLinked = await handleLinkCancel(req("/api/auth/google/link", { method: "DELETE" }), { config: ON, cancel: async () => "COMPLETED", rateLimit: allow });
  ok("cancel: the link completed first → 409 ALREADY_LINKED", cancelLinked.status === 409 && (await cancelLinked.json()).code === "ALREADY_LINKED");
  const silenced = console.error;
  console.error = () => {};
  const cancelFail = await handleLinkCancel(req("/api/auth/google/link", { method: "DELETE" }), { config: ON, cancel: async () => { throw new Error("db down"); }, rateLimit: allow });
  console.error = silenced;
  ok("cancel: a database failure → 503, the cookie KEPT (never answered as cancelled)", cancelFail.status === 503 && kept(cancelFail));
  ok("cancel: cross-site → 403", (await handleLinkCancel(req("/api/auth/google/link", { method: "DELETE", site: "cross-site" }), { config: ON, cancel: async () => "CANCELLED", rateLimit: allow })).status === 403);

  // ── proof by password: login's own limits, the account from the ticket ─────
  type Call = { key?: string; compared?: string; completed?: unknown; locked?: number; cleared?: boolean; delivered?: number };
  const pw = (o: { account?: { id: number; businessId: number; password: string | null } | null; match?: boolean; count?: number; allowed?: boolean; ticket?: boolean; complete?: () => Promise<CompletedLink>; ipLimit?: typeof allow } = {}) => {
    const call: Call = {};
    const deps: LinkPasswordDeps = {
      config: ON,
      readTicket: async () => (o.ticket === false ? null : { email: EMAIL, name: "דנה", expiresAt: new Date() }),
      findAccount: async () => (o.account === undefined ? { id: 7, businessId: 70, password: "$2b$10$hash" } : o.account),
      rateLimit: o.ipLimit ?? allow,
      reserve: (async (p: { key: string }) => {
        call.key = p.key;
        if (o.allowed === false) return { allowed: false, locked: true, retryAfterMs: 60_000 };
        return { allowed: true, count: o.count ?? 1, clear: async () => { call.cleared = true; }, lock: async (ms: number) => { call.locked = ms; } };
      }) as unknown as LinkPasswordDeps["reserve"],
      compare: async (_p, hash) => { call.compared = hash; return o.match ?? true; },
      complete: (async (input: unknown) => { call.completed = input; return o.complete ? o.complete() : linked; }) as LinkPasswordDeps["complete"],
      deliver: (id) => { call.delivered = id; },
    };
    return { deps, call };
  };
  const p1 = pw();
  const good = await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "right", userId: 999, businessId: 999, email: "other@lab.invalid" } }), p1.deps);
  const goodBody = await good.json();
  ok("password right → 200, the refresh cookie set, the LINK cookie cleared, no token in the body", good.status === 200 && /dubiz_rt=/.test(good.headers.getSetCookie().join(";"))
    && cleared(good) && !JSON.stringify(goodBody).includes("refresh-credential-value") && !("token" in goodBody));
  ok("…the account is the TICKET's (id 7), never the body's userId / businessId / email", (p1.call.completed as { proof: { kind: string; userId: number } }).proof.userId === 7
    && (p1.call.completed as { proof: { kind: string } }).proof.kind === "PASSWORD");
  ok("…the attempt is reserved on login's own ledger for the ticket's address", p1.call.key === loginAccountRateKey(normalizeEmail(EMAIL)));
  ok("…the ledger is cleared on success, and the GOOGLE_LINKED notice handed to delivery", p1.call.cleared === true && p1.call.delivered === 7000);
  const p2 = pw({ match: false, count: 2 });
  const wrong = await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "wrong" } }), p2.deps);
  ok("password wrong → 401 INVALID_PASSWORD, nothing linked, the ledger NOT cleared", wrong.status === 401 && (await wrong.json()).code === "INVALID_PASSWORD" && p2.call.completed === undefined && !p2.call.cleared);
  const p3 = pw({ match: false, count: LOGIN_FAILURE_POLICY.warnAtFailure });
  ok("…the third failure warns (one attempt left)", (await (await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "wrong" } }), p3.deps)).json()).attemptsLeft === 1);
  const p4 = pw({ match: false, count: LOGIN_FAILURE_POLICY.limit });
  const fourth = await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "wrong" } }), p4.deps);
  ok("…the fourth locks the address for login's 15 minutes (429)", fourth.status === 429 && p4.call.locked === LOGIN_FAILURE_POLICY.lockMs);
  const p5 = pw({ allowed: false });
  const locked = await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "right" } }), p5.deps);
  ok("a locked address → 429 before any comparison", locked.status === 429 && p5.call.compared === undefined && p5.call.completed === undefined);
  const p6 = pw({ account: null, match: true });
  const ghost = await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "x" } }), p6.deps);
  ok("no account → the same bcrypt work (the equaliser) and the same 401", ghost.status === 401 && typeof p6.call.compared === "string" && p6.call.compared.startsWith("$2b$10$") && p6.call.completed === undefined);
  const p7 = pw({ account: { id: 7, businessId: 70, password: null }, match: true });
  ok("an account without a password → 401, never linked by password", (await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "x" } }), p7.deps)).status === 401 && p7.call.completed === undefined);
  const p8 = pw({ ticket: false });
  const noTicket = await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "x" } }), p8.deps);
  ok("no open LINK ticket → 409 TICKET_EXPIRED, cookie cleared, no comparison", noTicket.status === 409 && cleared(noTicket) && p8.call.compared === undefined);
  const p9 = pw({ complete: async () => { throw new GoogleLinkRefusedError("ACCOUNT"); } });
  ok("the database refuses the account → 409 LINK_REFUSED, no session cookie",
    await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "x" } }), p9.deps).then(async (r) => r.status === 409 && (await r.json()).code === "LINK_REFUSED" && !/dubiz_rt=/.test(r.headers.getSetCookie().join(";"))));
  ok("password: cross-site / no Origin → 403", (await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "x" }, site: "cross-site" }), pw().deps)).status === 403
    && (await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "x" }, origin: false }), pw().deps)).status === 403);
  ok("password: login's per-IP limit → 429", (await handleLinkPassword(req("/api/auth/google/link/password", { body: { password: "x" } }), pw({ ipLimit: deny }).deps)).status === 429);

  // ── proof by email: request, check (changes nothing), explicit complete ────
  let requested = 0;
  let delivered: number[] = [];
  const emailDeps = (issued: boolean) => ({ config: ON, readTicket: async () => ({ email: EMAIL, name: null, expiresAt: new Date() }), rateLimit: allow,
    request: async () => { requested += 1; return issued ? { emailId: 55, businessId: 70 } : null; }, deliver: (id: number) => { delivered.push(id); } });
  const sentA = await handleLinkEmailRequest(req("/api/auth/google/link/email"), emailDeps(true));
  const sentB = await handleLinkEmailRequest(req("/api/auth/google/link/email"), emailDeps(false));
  ok("email request: issued or not (ceilings, an account that may not be linked) — the SAME answer", sentA.status === 200 && sentB.status === 200
    && JSON.stringify(await sentA.json()) === JSON.stringify(await sentB.json()) && requested === 2);
  ok("…delivery only for an email that was recorded", JSON.stringify(delivered) === "[55]");
  ok("email request: its own per-IP limit → 429", (await handleLinkEmailRequest(req("/api/auth/google/link/email"), { ...emailDeps(true), rateLimit: deny })).status === 429);
  let checked: unknown[] = [];
  const chk = await handleLinkEmailCheck(req("/api/auth/google/link/email/check", { body: { token: "t.v" } }), { config: ON, rateLimit: allow, check: async (t, s) => { checked = [t, s]; return "VALID"; } });
  ok("check: answers the status for the posted token and THIS browser's ticket", (await chk.json()).status === "VALID" && checked[0] === "t.v" && checked[1] === SECRET);
  let completed: { proof?: { kind: string; token: unknown }; ticketSecret?: unknown } = {};
  delivered = [];
  const done = await handleLinkEmailComplete(req("/api/auth/google/link/email/complete", { body: { token: "t.v", userId: 999 } }), { config: ON, readTicket: async () => null, rateLimit: allow,
    complete: (async (i: typeof completed) => { completed = i; return linked; }) as never, deliver: (id) => { delivered.push(id); } });
  ok("complete: the EMAIL proof is the posted token + this browser's ticket; nothing else from the body", done.status === 200 && completed.proof?.kind === "EMAIL"
    && completed.proof.token === "t.v" && completed.ticketSecret === SECRET && !JSON.stringify(completed).includes("999"));
  ok("…the refresh cookie set, the LINK cookie cleared, the notice delivered", /dubiz_rt=/.test(done.headers.getSetCookie().join(";")) && cleared(done) && JSON.stringify(delivered) === "[7000]");
  for (const [reason, code, clears] of [["TICKET", "TICKET_EXPIRED", true], ["EMAIL_LINK", "LINK_INVALID", false], ["ACCOUNT", "LINK_REFUSED", true]] as const) {
    const r = await handleLinkEmailComplete(req("/api/auth/google/link/email/complete", { body: { token: "t.v" } }), { config: ON, readTicket: async () => null, rateLimit: allow,
      complete: async () => { throw new GoogleLinkRefusedError(reason); }, deliver: () => {} });
    ok(`complete: refused (${reason}) → 409 ${code}, no session cookie${clears ? ", the LINK cookie cleared" : ", the LINK cookie kept"}`,
      r.status === 409 && (await r.json()).code === code && !/dubiz_rt=/.test(r.headers.getSetCookie().join(";")) && (clears ? cleared(r) : kept(r)));
  }
  ok("complete / check: cross-site → 403", (await handleLinkEmailComplete(req("/api/auth/google/link/email/complete", { body: {}, site: "cross-site" }), { config: ON, readTicket: async () => null, rateLimit: allow, complete: async () => linked, deliver: () => {} })).status === 403
    && (await handleLinkEmailCheck(req("/api/auth/google/link/email/check", { body: {}, site: "cross-site" }), { config: ON, rateLimit: allow, check: async () => "VALID" })).status === 403);

  // ── settings: status and unlink, for the caller's own account only ────────
  const sec = (o: { context?: boolean; password?: string | null; match?: boolean; allowed?: boolean; unlinked?: boolean } = {}) => {
    const call: { unlinkedFor?: number; compared?: boolean; delivered?: number; key?: string } = {};
    const deps: GoogleSecurityDeps = {
      config: ON,
      context: (async () => (o.context === false ? null : { user: { id: 7, businessId: 70, email: EMAIL }, sessionId: "s" })) as unknown as GoogleSecurityDeps["context"],
      status: async () => ({ linked: true, emailAtLink: EMAIL, linkedAt: new Date(), lastUsedAt: null, hasPassword: o.password !== null }),
      credentials: async () => ({ email: EMAIL, password: o.password === undefined ? "$2b$10$hash" : o.password }),
      rateLimit: allow,
      reserve: (async (p: { key: string }) => { call.key = p.key; return o.allowed === false ? { allowed: false, retryAfterMs: 60_000 } : { allowed: true, count: 1, clear: async () => {}, lock: async () => {} }; }) as unknown as GoogleSecurityDeps["reserve"],
      compare: async () => { call.compared = true; return o.match ?? true; },
      unlink: async (userId) => { call.unlinkedFor = userId; return o.unlinked === false ? null : { identityId: 700, noticeEmailId: 7001 }; },
      deliver: (id) => { call.delivered = id; },
    };
    return { deps, call };
  };
  ok("status: without a session → 401", (await handleGoogleStatus(req("/api/security/google", { method: "GET" }), sec({ context: false }).deps)).status === 401);
  ok("status: the caller's own link", (await (await handleGoogleStatus(req("/api/security/google", { method: "GET" }), sec().deps)).json()).linked === true);
  const s1 = sec();
  const un = await handleGoogleUnlink(req("/api/security/google", { body: { password: "right", userId: 999 } }), s1.deps);
  ok("unlink: re-authenticated → 200, for the SESSION's user (never the body's), the notice delivered", un.status === 200 && s1.call.unlinkedFor === 7 && s1.call.delivered === 7001);
  ok("…on login's own ledger for the account's address", s1.call.key === loginAccountRateKey(normalizeEmail(EMAIL)));
  const s2 = sec({ match: false });
  ok("unlink: a wrong password → 401, nothing removed", (await handleGoogleUnlink(req("/api/security/google", { body: { password: "wrong" } }), s2.deps)).status === 401 && s2.call.unlinkedFor === undefined);
  const s3 = sec({ password: null });
  const noPw = await handleGoogleUnlink(req("/api/security/google", { body: { password: "x" } }), s3.deps);
  ok("unlink: an account without a password → 409 PASSWORD_REQUIRED, nothing compared or removed", noPw.status === 409 && (await noPw.json()).code === "PASSWORD_REQUIRED"
    && !s3.call.compared && s3.call.unlinkedFor === undefined);
  const s4 = sec({ allowed: false });
  ok("unlink: a locked address → 429, nothing compared", (await handleGoogleUnlink(req("/api/security/google", { body: { password: "x" } }), s4.deps)).status === 429 && !s4.call.compared);
  ok("unlink: without a session → 401", (await handleGoogleUnlink(req("/api/security/google", { body: { password: "x" } }), sec({ context: false }).deps)).status === 401);
  ok("unlink: nothing linked → 409 NOT_LINKED", (await handleGoogleUnlink(req("/api/security/google", { body: { password: "x" } }), sec({ unlinked: false }).deps)).status === 409);

  // ── the emails ─────────────────────────────────────────────────────────────
  ok("registry: LINK_GOOGLE, GOOGLE_LINKED and GOOGLE_UNLINKED are kinds; a proof link lives 30 minutes",
    "LINK_GOOGLE" in EMAIL_KINDS && "GOOGLE_LINKED" in EMAIL_KINDS && "GOOGLE_UNLINKED" in EMAIL_KINDS && EMAIL_KINDS.LINK_GOOGLE.ttlMs === 30 * 60_000);
  const tokenId = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const mail = renderStored("LINK_GOOGLE", { tokenId, firstName: "דנה" }, { appBaseUrl: "https://app.dubiz.test" });
  const link = buildEmailLink("https://app.dubiz.test", tokenId, "LINK_GOOGLE");
  ok("LINK_GOOGLE: Hebrew, carries the confirmation link (the secret derived at render, in the fragment)", !!mail && mail.html.includes('dir="rtl"')
    && mail.text.includes(link) && link.startsWith(`https://app.dubiz.test${EMAIL_LINK_PATHS.LINK_GOOGLE}#t=${tokenId}.`) && link.endsWith(deriveLinkSecret(tokenId, "LINK_GOOGLE")));
  ok("…its payload never holds the secret (a payload with one is refused)", renderStored("LINK_GOOGLE", { tokenId, firstName: null, secret: "x" }, { appBaseUrl: "x" }) === null);
  ok("…the LINK_GOOGLE secret is not the reset or verification secret for the same id",
    deriveLinkSecret(tokenId, "LINK_GOOGLE") !== deriveLinkSecret(tokenId, "PASSWORD_RESET") && deriveLinkSecret(tokenId, "LINK_GOOGLE") !== deriveLinkSecret(tokenId, "EMAIL_VERIFY"));
  const notice = renderStored("GOOGLE_LINKED", { firstName: "דנה", googleEmail: "<b>x@y.z</b>" }, { appBaseUrl: "https://app.dubiz.test" });
  ok("GOOGLE_LINKED: Hebrew security notice, the Google address escaped, the way to the security settings", !!notice && notice.subject.includes("Google")
    && notice.html.includes("&lt;b&gt;x@y.z&lt;/b&gt;") && notice.text.includes("https://app.dubiz.test/settings/security"));
  ok("GOOGLE_UNLINKED renders; a notice without a Google address is refused", !!renderStored("GOOGLE_UNLINKED", { firstName: null, googleEmail: "x@y.z" }, { appBaseUrl: "x" })
    && renderStored("GOOGLE_LINKED", { firstName: null }, { appBaseUrl: "x" }) === null);
  ok("dedupe: one notice per identity row and act; one proof email per token",
    googleNoticeDedupeKey("GOOGLE_LINKED", 5) !== googleNoticeDedupeKey("GOOGLE_UNLINKED", 5) && googleNoticeDedupeKey("GOOGLE_LINKED", 5) === googleNoticeDedupeKey("GOOGLE_LINKED", 5)
    && accountLinkDedupeKey("LINK_GOOGLE", tokenId) === `link_google:token:${tokenId}`);

  // ── static scope ───────────────────────────────────────────────────────────
  const ROOT = process.cwd();
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
  const routes = ["link/route.ts", "link/password/route.ts", "link/email/route.ts", "link/email/check/route.ts", "link/email/complete/route.ts"].map((r) => read(`app/api/auth/google/${r}`));
  ok("every link route answers 404 when OFF (the config is read first)", routes.every((s) =>
    /> \{\n  (const config = deps\.config\(\);\n  if \(!config\)|if \(!deps\.config\(\)\)) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/.test(s)));
  ok("no link or settings route reaches the database directly", [...routes, read("app/api/security/google/route.ts")].every((s) => !/prisma-auth|\$queryRaw|authDb\(/.test(s)));
  ok("the check route never completes anything", !/completeGoogleLink|auth_oauth_link_email_consume|auth_oauth_identity_link/.test(read("app/api/auth/google/link/email/check/route.ts")));
  const confirm = read("app/link/google/confirm/google-link-confirm.tsx");
  const effect = confirm.slice(confirm.indexOf("useEffect("), confirm.indexOf("const confirm = async"));
  ok("the emailed link's page: loading it only CHECKS — the complete call is behind the button", effect.includes("/api/auth/google/link/email/check") && !effect.includes("/complete")
    && confirm.includes('onClick={confirm}'));
  ok("…and it removes the token from the address bar", effect.includes("history.replaceState"));
  const linkSrc = read("lib/auth/google-link.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  ok("google-link.ts reaches the tables only through the definer functions (no table name in a query)", !/FROM\s+"?(AuthEmailToken|OAuthSignupTicket|UserIdentity)"?/.test(linkSrc)
    && !/\.(authEmailToken|oAuthSignupTicket|userIdentity)\./.test(linkSrc));
  ok("the link transaction never records a WELCOME", !/enqueueWelcomeEmail|WELCOME/.test(linkSrc));
  const signIn = read("lib/auth/google-sign-in.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  ok("the callback compares addresses WITHOUT letter case through lower(\"email\") — an exact comparison, never a LIKE / ILIKE pattern",
    /WHERE lower\("email"\) = \$\{folded\} LIMIT 2/.test(signIn) && !/ILIKE|LIKE|mode:\s*"insensitive"/i.test(signIn));
  ok("…and an ambiguous or capital-letter holder stops before any ticket", /held\.kind === "ambiguous"\) return \{ kind: "existing_account" \}/.test(signIn)
    && /holder\.email !== identity\.email/.test(signIn) && signIn.indexOf("existing_account") < signIn.indexOf("issueLinkTicket(identity)")
    && signIn.indexOf("existing_account") < signIn.indexOf("issueSignupTicket(identity)"));
  const confirmSrc = read("app/link/google/confirm/google-link-confirm.tsx");
  ok("Hebrew quotations use gershayim (״…״), never ASCII quotes around a Latin word (RTL)", !/\\"המשך עם Google\\"/.test(confirmSrc) && confirmSrc.includes("״המשך עם Google״")
    && !read("components/settings/security/google-connection.tsx").includes("&quot;"));
  const formSrc = read("app/link/google/google-link-form.tsx");
  ok("the email path says up front that the link works only in this browser (and, in the installed app, recommends the password)",
    formSrc.includes('data-testid="google-link-email-note"') && formSrc.includes('data-testid="google-link-pwa-note"') && /display-mode: standalone/.test(formSrc));
  ok("…without carrying anything in a URL: the link page reads only its own fragment, and nothing appends a ticket or token to a link",
    !/[?&](ticket|token|secret)=/.test(formSrc + confirmSrc));
  const store = read("lib/services/account/account-deletion.prisma-store.ts");
  ok("account erasure still removes the business's link tokens and Google identities", /authEmailToken\.deleteMany\(\{ where: \{ businessId \} \}\)/.test(store) && /userIdentity\.deleteMany\(\{ where: \{ businessId \} \}\)/.test(store));
  ok("the password login route is unchanged by milestone 3 (imports no Google module)", !/google/i.test(read("app/api/auth/login/route.ts").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")));

  console.log(`\n[google-link] ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
