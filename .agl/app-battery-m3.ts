/**
 * "Continue with Google", milestone 3 — linking Google to an EXISTING account, through the REAL routes and the
 * REAL link transaction, against the .agl lab with all three oauth migrations applied, as the real planes
 * (te_auth_login, app_runtime_prod). Google is a stand-in at the code-exchange seam; the mail provider is never
 * reached (delivery is OFF in the lab — the outbox row is what is measured).
 *
 *   A  The callback: an existing unlinked account → a LINK ticket and nothing else (no link, no session);
 *      an administrator, a business in deletion, an account linked to another Google identity → no ticket;
 *      a new person still goes to the signup completion.
 *   B  Proof by password: login's own ledger — failures on the link screen and on the login screen count
 *      together and lock together; the right password links ONE identity, ONE session, ONE GOOGLE_LINKED
 *      notice and no WELCOME; replay refused; the next Google sign-in reaches the same account; password
 *      login still works.
 *   C  Proof by email: the request answers the same every time and records at most 3 per ticket; the link is
 *      bound to this browser's ticket (another browser / a scanner: OTHER_BROWSER, nothing changes); only the
 *      latest works; the explicit completion links once.
 *   D  An expired emailed link; E a cancelled ticket; F swaps (another account's link, another account's id).
 *   G  Ten concurrent completions (password and email) on one ticket: exactly one link.
 *   H  A failure after every write: nothing left; the ticket open; a later link works.
 *   I  A deletion requested after the ticket was issued: no link, no session, no email.
 *   J  Settings: status; disconnect re-authenticates and needs a password; the GOOGLE_UNLINKED notice.
 *   K  No ticket or link secret in anything logged.
 *   L  Letter case: an older account holding the address with capital letters, and two accounts that differ only
 *      in case (index dropped for that one case) → stop, no ticket, no second account; "_" matches only itself;
 *      a mixed-case account appearing mid-signup → the completion is refused by the case-folded index.
 *
 * env: OWNER_URL, DATABASE_URL, AUTH_DATABASE_URL (connection_limit ≥ 12), AUTH_PLANE_ENABLED=true,
 * AUTH_TOKEN_SECRET, RATE_LIMIT_BACKEND=memory. Synthetic only. ZERO network.
 */
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

import { getAuthContext, signAuthToken } from "@/lib/auth";
import { deriveLinkSecret } from "@/lib/auth/email-link";
import type { GoogleIdentity, GoogleIdTokenResult } from "@/lib/auth/google-id-token";
import { completeGoogleLink, findLinkAccount, readAccountCredentials, readGoogleLinkStatus, requestLinkEmail, checkLinkEmail, unlinkGoogle } from "@/lib/auth/google-link";
import { GOOGLE_LINK_COOKIE, GOOGLE_START_COOKIE, GOOGLE_TICKET_COOKIE, newStartState, readGoogleLoginConfig, sealStartState, type GoogleLoginConfig } from "@/lib/auth/google-oauth";
import { resolveGoogleCallback } from "@/lib/auth/google-sign-in";
import { cancelLinkTicket, readLinkTicket } from "@/lib/auth/oauth-ticket";
import { refreshSession } from "@/lib/auth/refresh-session";
import { authDb } from "@/lib/prisma-auth";
import { consumeRateLimit, reserveAttempt } from "@/lib/security/rate-limit";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";
import { handleGoogleCallback, type CallbackRouteDeps } from "@/app/api/auth/google/callback/route";
import { handleGoogleComplete, type CompleteDeps } from "@/app/api/auth/google/complete/route";
import { createAccountFromGoogle } from "@/lib/auth/signup";
import { readSignupAllowlist } from "@/lib/auth/signup-allowlist";
import { isPublicSignupEnabled } from "@/lib/auth/signup-gate";
import { readSignupTicket } from "@/lib/auth/oauth-ticket";
import { handleLinkCancel, handleLinkTicketRead } from "@/app/api/auth/google/link/route";
import { handleLinkPassword, type LinkPasswordDeps } from "@/app/api/auth/google/link/password/route";
import { handleLinkEmailRequest } from "@/app/api/auth/google/link/email/route";
import { handleLinkEmailCheck } from "@/app/api/auth/google/link/email/check/route";
import { handleLinkEmailComplete } from "@/app/api/auth/google/link/email/complete/route";
import { handleGoogleStatus, handleGoogleUnlink, type GoogleSecurityDeps } from "@/app/api/security/google/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

const logged: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(" "));
    real(...args);
  };
}
const secrets: string[] = [];

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const count = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as Rows)[0].c);

const config = readGoogleLoginConfig({
  AUTH_GOOGLE_LOGIN_ENABLED: "true",
  GOOGLE_LOGIN_CLIENT_ID: "lab-client.apps.googleusercontent.com",
  GOOGLE_LOGIN_CLIENT_SECRET: "lab-secret",
  GOOGLE_LOGIN_REDIRECT_BASE_URL: "https://app.dubiz.test",
}) as GoogleLoginConfig;
const ON = () => config;
const PASSWORD = "Correct-Horse-Battery-9";

let seq = 0;
let ipSeq = 10;
const ip = () => `203.0.113.${(ipSeq = (ipSeq % 250) + 1)}`;

type Account = { userId: number; businessId: number; email: string; subject: string };
async function account(tag: string, opts: { admin?: boolean; deleting?: boolean } = {}): Promise<Account> {
  seq += 1;
  const email = `agl-m3-${tag}-${Date.now()}-${seq}@lab.invalid`;
  const b = await owner.business.create({ data: { name: `agl-m3-${tag}-${seq}`, ...(opts.deleting ? { deletionRequestedAt: new Date() } : {}) }, select: { id: true } });
  const u = await owner.user.create({
    data: { email, password: await bcrypt.hash(PASSWORD, 10), name: `דנה ${tag}`, businessId: b.id, ...(opts.admin ? { role: "PLATFORM_ADMIN" as const } : {}) },
    select: { id: true },
  });
  return { userId: u.id, businessId: b.id, email, subject: `m3-${tag}-${Date.now()}-${seq}` };
}
const identityOf = (a: Account): GoogleIdentity => ({ subject: a.subject, email: a.email, name: "דנה" });

function callbackDeps(identity: GoogleIdentity): CallbackRouteDeps {
  const verified: GoogleIdTokenResult = { ok: true, identity };
  return { config: ON, exchange: async () => "stand-in-id-token", resolve: (input) => resolveGoogleCallback(input, { verify: async () => verified }), rateLimit: consumeRateLimit, recordUsage: recordProductUsageEvent };
}
async function callback(identity: GoogleIdentity) {
  const start = newStartState("login");
  const res = await handleGoogleCallback(new Request(`https://app.dubiz.test/api/auth/google/callback?code=c&state=${start.state}`, {
    headers: { cookie: `${GOOGLE_START_COOKIE}=${encodeURIComponent(sealStartState(start))}`, "x-forwarded-for": ip(), "user-agent": "agl-m3" },
  }), callbackDeps(identity));
  const cookies = res.headers.getSetCookie();
  const pick = (name: string) => {
    const c = cookies.find((x) => x.startsWith(`${name}=`));
    const v = c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : "";
    return v || null;
  };
  const link = pick(GOOGLE_LINK_COOKIE);
  if (link) secrets.push(link);
  return { location: res.headers.get("location") ?? "", link, ticket: pick(GOOGLE_TICKET_COOKIE), refresh: pick("dubiz_rt") };
}

const headers = (cookie: string | null, extra: Record<string, string> = {}) => ({
  origin: "https://app.dubiz.test", host: "app.dubiz.test", "sec-fetch-site": "same-origin", "x-forwarded-for": ip(), "user-agent": "agl-m3",
  "content-type": "application/json", ...(cookie ? { cookie: `${GOOGLE_LINK_COOKIE}=${cookie}` } : {}), ...extra,
});
const post = (p: string, cookie: string | null, body?: unknown) => new Request(`https://app.dubiz.test${p}`, { method: "POST", headers: headers(cookie), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function read(res: Response) {
  const set = res.headers.getSetCookie();
  const refresh = set.find((c) => c.startsWith("dubiz_rt="));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, refresh: refresh ? decodeURIComponent(refresh.split(";")[0].slice(9)) || null : null,
    linkCleared: set.some((c) => c.startsWith(`${GOOGLE_LINK_COOKIE}=`) && /Max-Age=0/.test(c)) };
}
const pwDeps: LinkPasswordDeps = { config: ON, readTicket: readLinkTicket, findAccount: findLinkAccount, rateLimit: consumeRateLimit, reserve: reserveAttempt,
  compare: (p, h) => bcrypt.compare(p, h), complete: completeGoogleLink, deliver: () => {} };
const linkPassword = async (cookie: string | null, password: string, extra: Record<string, unknown> = {}) =>
  read(await handleLinkPassword(post("/api/auth/google/link/password", cookie, { password, ...extra }), pwDeps));
const requestEmail = async (cookie: string | null) =>
  read(await handleLinkEmailRequest(post("/api/auth/google/link/email", cookie), { config: ON, readTicket: readLinkTicket, rateLimit: consumeRateLimit, request: requestLinkEmail, deliver: () => {} }));
const checkEmail = async (cookie: string | null, token: string) =>
  String((await read(await handleLinkEmailCheck(post("/api/auth/google/link/email/check", cookie, { token }), { config: ON, check: checkLinkEmail, rateLimit: consumeRateLimit }))).body.status);
const completeEmail = async (cookie: string | null, token: string) =>
  read(await handleLinkEmailComplete(post("/api/auth/google/link/email/complete", cookie, { token }), { config: ON, rateLimit: consumeRateLimit, complete: completeGoogleLink, deliver: () => {} }));
const login = async (email: string, password: string) =>
  read(await loginPOST(new Request("https://app.dubiz.test/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip(), "user-agent": "agl-m3" }, body: JSON.stringify({ email, password }) })));

/** The emailed links recorded for an account, newest first: `<tokenId>.<secret>` as the email renders it. */
async function emailedLinks(a: Account): Promise<string[]> {
  const rows = (await owner.$queryRawUnsafe(`SELECT payload FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = 'LINK_GOOGLE' ORDER BY id DESC`, a.userId)) as { payload: { tokenId: string } }[];
  return rows.map((r) => {
    const t = `${r.payload.tokenId}.${deriveLinkSecret(r.payload.tokenId, "LINK_GOOGLE")}`;
    secrets.push(t);
    return t;
  });
}
const notices = (a: Account, kind = "GOOGLE_LINKED") => count(`SELECT count(*)::int AS c FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = $2`, a.userId, kind);
const identities = (a: Account) => count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "userId" = $1`, a.userId);
const sessions = (a: Account) => count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, a.userId);
const welcomes = (a: Account) => count(`SELECT count(*)::int AS c FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = 'WELCOME'`, a.userId);
const openLinkTickets = (a: Account) => count(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1 AND purpose = 'LINK' AND "endedAt" IS NULL`, a.subject);

async function bearerFor(refresh: string): Promise<string | null> {
  const rt = await refreshSession(authDb(), { credential: refresh, now: new Date() });
  return rt.kind === "rotated" ? signAuthToken(rt.userId, rt.tokenVersion, rt.sessionId) : null;
}
const m2CompleteDeps: CompleteDeps = { config: ON, isSignupEnabled: isPublicSignupEnabled, signupAllowlist: readSignupAllowlist, readTicket: readSignupTicket,
  rateLimit: consumeRateLimit, createAccount: createAccountFromGoogle, recordUsage: recordProductUsageEvent, scheduleWelcome: () => {} };
const secDeps: GoogleSecurityDeps = { config: ON, context: getAuthContext, status: readGoogleLinkStatus, credentials: readAccountCredentials, rateLimit: consumeRateLimit,
  reserve: reserveAttempt, compare: (p, h) => bcrypt.compare(p, h), unlink: unlinkGoogle, deliver: () => {} };
const secReq = (token: string, method: "GET" | "POST", body?: unknown) => new Request("https://app.dubiz.test/api/security/google", {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-forwarded-for": ip() }, ...(body ? { body: JSON.stringify(body) } : {}) });

async function main() {
  process.env.PUBLIC_SIGNUP_ENABLED = "true";
  delete process.env.SIGNUP_ALLOWED_EMAILS;

  console.log("\n— A. the callback —");
  const pA = await account("callback");
  const cA = await callback(identityOf(pA));
  ok("A1 an existing unlinked account → /link/google with a LINK ticket cookie, no session cookie", cA.location.endsWith("/link/google") && !!cA.link && cA.refresh === null && cA.ticket === null);
  ok("A1 …no identity, no session; one open LINK ticket", (await identities(pA)) === 0 && (await sessions(pA)) === 0 && (await openLinkTickets(pA)) === 1);
  ok("A1 …the ticket is neither a bearer token nor a refresh credential", (await getAuthContext(new Request("https://x/api/home", { headers: { authorization: `Bearer ${cA.link}` } }))) === null
    && (await refreshSession(authDb(), { credential: cA.link!, now: new Date() })).kind === "unauthorized");
  const view = await read(await handleLinkTicketRead(new Request("https://app.dubiz.test/api/auth/google/link", { headers: headers(cA.link) }), { config: ON, read: readLinkTicket }));
  ok("A1 the link screen shows the address and nothing to send back as authority", view.status === 200 && view.body.email === pA.email && !("userId" in view.body) && !("businessId" in view.body));
  const adm = await account("admin", { admin: true });
  const cAdm = await callback(identityOf(adm));
  ok("A2 a platform administrator → /login?google=admin, no ticket", cAdm.location.endsWith("/login?google=admin") && !cAdm.link && (await openLinkTickets(adm)) === 0);
  const del = await account("deleting", { deleting: true });
  const cDel = await callback(identityOf(del));
  ok("A3 a business in deletion → /login?google=unavailable, no ticket", cDel.location.endsWith("/login?google=unavailable") && !cDel.link && (await openLinkTickets(del)) === 0);
  const other = await account("other-google");
  await owner.$executeRawUnsafe(`INSERT INTO "UserIdentity" ("userId","businessId","provider","providerSubject","emailAtLink","linkedAt") VALUES ($1,$2,'google',$3,$4,now())`,
    other.userId, other.businessId, `m3-elsewhere-${Date.now()}`, other.email);
  const cOther = await callback(identityOf(other));
  ok("A4 an account already linked to ANOTHER Google identity → /login?google=existing, no ticket", cOther.location.endsWith("/login?google=existing") && !cOther.link);
  const newcomer = { subject: `m3-new-${Date.now()}`, email: `agl-m3-new-${Date.now()}@lab.invalid`, name: "חדש" };
  const cNew = await callback(newcomer);
  ok("A5 a new person still goes to the signup completion (milestone 2 unchanged)", cNew.location.endsWith("/register/google") && !!cNew.ticket && !cNew.link);

  console.log("\n— B. proof by password —");
  const pB = await account("pw-ledger");
  const cB = await callback(identityOf(pB));
  ok("B1 a wrong password → 401, nothing linked", (await linkPassword(cB.link, "wrong-1")).status === 401 && (await identities(pB)) === 0);
  ok("B1 a second wrong password → 401", (await linkPassword(cB.link, "wrong-2")).status === 401);
  const third = await login(pB.email, "wrong-3");
  ok("B2 …a wrong password on the LOGIN screen counts on the same ledger (third failure → the warning)", third.status === 401 && third.body.attemptsLeft === 1, JSON.stringify(third.body));
  const fourth = await linkPassword(cB.link, "wrong-4");
  ok("B2 …the fourth, back on the link screen, locks the address (429)", fourth.status === 429 && fourth.body.code === "LOGIN_LOCKED");
  ok("B2 …and the lock holds for login with the RIGHT password too (no way around it)", (await login(pB.email, PASSWORD)).status === 429 && (await linkPassword(cB.link, PASSWORD)).status === 429);
  ok("B2 …nothing linked, no session, the ticket still open", (await identities(pB)) === 0 && (await sessions(pB)) === 0 && (await openLinkTickets(pB)) === 1);

  const p2 = await account("pw-good");
  const c2 = await callback(identityOf(p2));
  const good = await linkPassword(c2.link, PASSWORD, { userId: pA.userId, businessId: pA.businessId, email: pA.email });
  ok("B3 the right password → 200, a refresh cookie, the LINK cookie cleared", good.status === 200 && !!good.refresh && good.linkCleared);
  ok("B3 …ONE identity (this account, this Google subject), ONE session, ONE GOOGLE_LINKED notice, NO WELCOME", (await identities(p2)) === 1 && (await sessions(p2)) === 1
    && (await notices(p2)) === 1 && (await welcomes(p2)) === 0
    && (await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "userId" = $1 AND "providerSubject" = $2`, p2.userId, p2.subject)) === 1);
  ok("B3 …the body's userId / businessId / email were ignored: the other account is untouched", (await identities(pA)) === 0 && (await sessions(pA)) === 0);
  const bearer2 = good.refresh ? await bearerFor(good.refresh) : null;
  const ctx2 = bearer2 ? await getAuthContext(new Request("https://x/api/home", { headers: { authorization: `Bearer ${bearer2}` } })) : null;
  ok("B3 …the session authenticates as that account and its business only", ctx2?.user.id === p2.userId && ctx2?.user.businessId === p2.businessId);
  const replay = await linkPassword(c2.link, PASSWORD);
  ok("B4 replay of the spent ticket → 409 TICKET_EXPIRED, nothing added (one notice)", replay.status === 409 && replay.body.code === "TICKET_EXPIRED" && (await identities(p2)) === 1 && (await notices(p2)) === 1);
  const again = await callback(identityOf(p2));
  ok("B5 the next Google sign-in → a session for the SAME account (no ticket, no second account)", again.location.endsWith("/auth/google/done") && !!again.refresh && !again.link
    && (await count(`SELECT count(*)::int AS c FROM "User" WHERE email = $1`, p2.email)) === 1);
  ok("B6 password login still works for the linked account", (await login(p2.email, PASSWORD)).status === 200);

  console.log("\n— C. proof by email —");
  const e1 = await account("email");
  const cE = await callback(identityOf(e1));
  const r1 = await requestEmail(cE.link);
  ok("C1 the request → 200 'sent'; one LINK_GOOGLE email recorded for the account's address", r1.status === 200 && r1.body.status === "sent"
    && (await count(`SELECT count(*)::int AS c FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = 'LINK_GOOGLE' AND "toEmail" = $2`, e1.userId, e1.email)) === 1);
  const payload = ((await owner.$queryRawUnsafe(`SELECT payload FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = 'LINK_GOOGLE'`, e1.userId)) as { payload: Record<string, unknown> }[])[0].payload;
  ok("C1 …the outbox holds the token id and the first name — never the secret", JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(["firstName", "tokenId"]));
  const more = await Promise.all([requestEmail(cE.link), requestEmail(cE.link), requestEmail(cE.link)]);
  ok("C2 more requests: the same answer every time; at most 3 emails per ticket", more.every((r) => r.status === 200 && r.body.status === "sent")
    && (await count(`SELECT count(*)::int AS c FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = 'LINK_GOOGLE'`, e1.userId)) === 3);
  const links = await emailedLinks(e1);
  const latest = links[0];
  const before = JSON.stringify(await owner.$queryRawUnsafe(`SELECT id, "consumedAt", "invalidatedAt" FROM "AuthEmailToken" WHERE "userId" = $1 ORDER BY id`, e1.userId));
  ok("C3 opened in ANOTHER browser (or by a mail scanner) → OTHER_BROWSER", (await checkEmail(null, latest)) === "OTHER_BROWSER");
  ok("C3 in this browser → VALID; an earlier one → SUPERSEDED", (await checkEmail(cE.link, latest)) === "VALID" && (await checkEmail(cE.link, links[1])) === "SUPERSEDED");
  ok("C3 …checking changed nothing", JSON.stringify(await owner.$queryRawUnsafe(`SELECT id, "consumedAt", "invalidatedAt" FROM "AuthEmailToken" WHERE "userId" = $1 ORDER BY id`, e1.userId)) === before
    && (await identities(e1)) === 0);
  const scanner = await completeEmail(null, latest);
  ok("C4 completing without the ticket (another browser) → 409 TICKET_EXPIRED, nothing linked", scanner.status === 409 && scanner.body.code === "TICKET_EXPIRED" && (await identities(e1)) === 0);
  const old = await completeEmail(cE.link, links[1]);
  ok("C4 completing with the superseded link → 409 LINK_INVALID, the ticket still open", old.status === 409 && old.body.code === "LINK_INVALID" && (await openLinkTickets(e1)) === 1);
  const doneE = await completeEmail(cE.link, latest);
  ok("C5 the explicit completion → 200, a refresh cookie; ONE identity, ONE session, ONE notice, no WELCOME", doneE.status === 200 && !!doneE.refresh
    && (await identities(e1)) === 1 && (await sessions(e1)) === 1 && (await notices(e1)) === 1 && (await welcomes(e1)) === 0);
  ok("C5 …a second completion → 409, nothing added", (await completeEmail(cE.link, latest)).status === 409 && (await identities(e1)) === 1 && (await notices(e1)) === 1);
  ok("C5 …the link now reports USED", (await checkEmail(cE.link, latest)) === "USED");

  console.log("\n— D. an expired emailed link —");
  const e2 = await account("expired");
  const cD = await callback(identityOf(e2));
  await requestEmail(cD.link);
  const [linkD] = await emailedLinks(e2);
  await owner.$executeRawUnsafe(`UPDATE "AuthEmailToken" SET "createdAt" = timezone('UTC', now()) - interval '40 minutes', "expiresAt" = timezone('UTC', now()) - interval '10 minutes' WHERE "userId" = $1`, e2.userId);
  ok("D1 EXPIRED, and the completion is refused; the ticket stays open", (await checkEmail(cD.link, linkD)) === "EXPIRED" && (await completeEmail(cD.link, linkD)).status === 409
    && (await identities(e2)) === 0 && (await openLinkTickets(e2)) === 1);

  console.log("\n— E. a cancelled ticket —");
  const e3 = await account("cancelled");
  const cX = await callback(identityOf(e3));
  await requestEmail(cX.link);
  const [linkX] = await emailedLinks(e3);
  const cancelled = await read(await handleLinkCancel(new Request("https://app.dubiz.test/api/auth/google/link", { method: "DELETE", headers: headers(cX.link) }), { config: ON, cancel: cancelLinkTicket, rateLimit: consumeRateLimit }));
  ok("E1 cancel → 200 cancelled, the ticket ended on the server", cancelled.status === 200 && cancelled.body.status === "cancelled" && (await openLinkTickets(e3)) === 0);
  ok("E1 …a copy of its cookie: the emailed link reports TICKET_ENDED; email and password completions refused", (await checkEmail(cX.link, linkX)) === "TICKET_ENDED"
    && (await completeEmail(cX.link, linkX)).status === 409 && (await linkPassword(cX.link, PASSWORD)).status === 409 && (await identities(e3)) === 0 && (await sessions(e3)) === 0);

  console.log("\n— F. swaps —");
  const s1 = await account("swap-one"); const s2 = await account("swap-two");
  const cs1 = await callback(identityOf(s1)); const cs2 = await callback(identityOf(s2));
  await requestEmail(cs1.link);
  const [link1] = await emailedLinks(s1);
  const swap = await completeEmail(cs2.link, link1);
  ok("F1 account ONE's emailed link in the browser holding account TWO's ticket → 409 LINK_INVALID, neither linked", swap.status === 409 && swap.body.code === "LINK_INVALID"
    && (await identities(s1)) === 0 && (await identities(s2)) === 0);
  const swap2 = await linkPassword(cs2.link, PASSWORD, { userId: s1.userId });
  ok("F2 account TWO's ticket + a body naming account ONE → only account TWO is linked", swap2.status === 200 && (await identities(s2)) === 1 && (await identities(s1)) === 0);

  console.log("\n— G. ten concurrent completions, one ticket —");
  const g = await account("race");
  const cG = await callback(identityOf(g));
  await requestEmail(cG.link);
  const [linkG] = await emailedLinks(g);
  const raced = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? linkPassword(cG.link, PASSWORD) : completeEmail(cG.link, linkG))));
  ok("G1 exactly one 200", raced.filter((r) => r.status === 200).length === 1, raced.map((r) => r.status).join(","));
  ok("G1 …one identity, one session, one notice", (await identities(g)) === 1 && (await sessions(g)) === 1 && (await notices(g)) === 1);

  console.log("\n— H. a failure after every write —");
  const h = await account("rollback");
  const cH = await callback(identityOf(h));
  const fault = await completeGoogleLink({ ticketSecret: cH.link, proof: { kind: "PASSWORD", userId: h.userId }, now: new Date(), userAgent: "agl-m3",
    beforeCommit: async () => { throw new Error("LAB_FAULT_AFTER_EVERY_WRITE"); } }).then(() => "committed", (e: Error) => e.message);
  ok("H1 the link fails after the identity, the session and the notice were written", fault === "LAB_FAULT_AFTER_EVERY_WRITE");
  ok("H1 …nothing left: no identity, no session, no notice; the ticket open", (await identities(h)) === 0 && (await sessions(h)) === 0 && (await notices(h)) === 0 && (await openLinkTickets(h)) === 1);
  ok("H1 …a later link succeeds, once", (await linkPassword(cH.link, PASSWORD)).status === 200 && (await identities(h)) === 1 && (await notices(h)) === 1);

  console.log("\n— I. a deletion requested after the ticket was issued —");
  const d = await account("delete-later");
  const cI = await callback(identityOf(d));
  await owner.business.update({ where: { id: d.businessId }, data: { deletionRequestedAt: new Date() } });
  const refusedPw = await linkPassword(cI.link, PASSWORD);
  ok("I1 the right password → 409 LINK_REFUSED, no session cookie, nothing linked", refusedPw.status === 409 && refusedPw.body.code === "LINK_REFUSED" && !refusedPw.refresh
    && (await identities(d)) === 0 && (await sessions(d)) === 0);
  const cI2 = await callback({ ...identityOf(d), subject: `${d.subject}-b` });
  ok("I1 …and a new Google round trip gets no ticket at all (unavailable)", cI2.location.endsWith("/login?google=unavailable") && !cI2.link);

  console.log("\n— J. settings: status and disconnect —");
  const tokenP2 = await bearerFor((await login(p2.email, PASSWORD)).refresh ?? "");
  const st = await read(await handleGoogleStatus(secReq(tokenP2!, "GET"), secDeps));
  ok("J1 status: connected, the Google address, a password", st.status === 200 && st.body.linked === true && st.body.emailAtLink === p2.email && st.body.hasPassword === true);
  ok("J2 disconnect with a wrong password → 401, still connected", (await read(await handleGoogleUnlink(secReq(tokenP2!, "POST", { password: "nope" }), secDeps))).status === 401 && (await identities(p2)) === 1);
  const un = await read(await handleGoogleUnlink(secReq(tokenP2!, "POST", { password: PASSWORD, userId: e1.userId }), secDeps));
  ok("J3 disconnect re-authenticated → 200; the identity gone; ONE GOOGLE_UNLINKED notice; the body's userId ignored", un.status === 200 && (await identities(p2)) === 0
    && (await notices(p2, "GOOGLE_UNLINKED")) === 1 && (await identities(e1)) === 1);
  ok("J3 …disconnecting again → 409 NOT_LINKED, no second notice", (await read(await handleGoogleUnlink(secReq(tokenP2!, "POST", { password: PASSWORD }), secDeps))).status === 409
    && (await notices(p2, "GOOGLE_UNLINKED")) === 1);
  // An account opened with Google: linked, no password — it may not disconnect.
  const gm = await account("google-made");
  await owner.user.update({ where: { id: gm.userId }, data: { password: null } });
  await owner.$executeRawUnsafe(`INSERT INTO "UserIdentity" ("userId","businessId","provider","providerSubject","emailAtLink","linkedAt") VALUES ($1,$2,'google',$3,$4,now())`, gm.userId, gm.businessId, gm.subject, gm.email);
  const gmSession = await callback(identityOf(gm));
  const tokenGm = gmSession.refresh ? await bearerFor(gmSession.refresh) : null;
  const gmStatus = await read(await handleGoogleStatus(secReq(tokenGm!, "GET"), secDeps));
  const gmUnlink = await read(await handleGoogleUnlink(secReq(tokenGm!, "POST", { password: "anything" }), secDeps));
  ok("J4 an account without a password: status says so; disconnect → 409 PASSWORD_REQUIRED, still connected", gmStatus.body.hasPassword === false
    && gmUnlink.status === 409 && gmUnlink.body.code === "PASSWORD_REQUIRED" && (await identities(gm)) === 1);

  console.log("\n— L. letter case —");
  const anyTicket = (sub: string) => count(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1`, sub);
  const holders = (folded: string) => count(`SELECT count(*)::int AS c FROM "User" WHERE lower(email) = $1`, folded);
  // An older account whose address was stored with capital letters (before signup folded addresses).
  const legacy = await account("legacy-case");
  const mixed = legacy.email.replace("agl-m3-legacy-case", "Agl-M3-Legacy-Case");
  await owner.user.update({ where: { id: legacy.userId }, data: { email: mixed } });
  const cL = await callback({ subject: legacy.subject, email: legacy.email, name: "דנה" });
  ok("L1 an older account holding the address with capital letters → /login?google=existing (sign in with the password)", cL.location.endsWith("/login?google=existing") && !cL.link && !cL.ticket);
  ok("L1 …no ticket of any kind, no link, no second account", (await anyTicket(legacy.subject)) === 0 && (await identities(legacy)) === 0 && (await holders(legacy.email)) === 1);
  // Two accounts that differ only in letter case — impossible while User_email_casefold_key holds (Production):
  // the index is dropped here for this one case, then restored.
  await owner.$executeRawUnsafe(`DROP INDEX "User_email_casefold_key"`);
  const twinA = await account("twin-case");
  const twinB = await account("twin-case-b");
  await owner.user.update({ where: { id: twinB.userId }, data: { email: twinA.email.replace("agl-m3-twin-case", "AGL-M3-TWIN-CASE") } });
  const cT = await callback({ subject: twinA.subject, email: twinA.email, name: "דנה" });
  ok("L2 two accounts that differ only in case (ambiguous) → stop: /login?google=existing, no ticket, nothing linked", cT.location.endsWith("/login?google=existing") && !cT.link && !cT.ticket
    && (await anyTicket(twinA.subject)) === 0 && (await identities(twinA)) === 0 && (await identities(twinB)) === 0);
  await owner.user.delete({ where: { id: twinB.userId } });
  await owner.$executeRawUnsafe(`CREATE UNIQUE INDEX "User_email_casefold_key" ON "User" (lower("email"))`);
  ok("L2 …the case-folded unique index is restored", (await count(`SELECT count(*)::int AS c FROM pg_indexes WHERE indexname = 'User_email_casefold_key'`)) === 1);
  // "_" in an address matches only itself: the comparison is lower(email) = …, never a LIKE pattern.
  const underscore = await account("under_score");
  const lookalike = { subject: `m3-lookalike-${Date.now()}`, email: underscore.email.replace("under_score", "underxscore"), name: "חדש" };
  const cU = await callback(lookalike);
  ok("L3 an address that differs from an account only where the account has '_' → a NEW person (signup), not that account", cU.location.endsWith("/register/google") && !!cU.ticket && !cU.link
    && (await identities(underscore)) === 0);
  // A signup ticket issued while the address was free; meanwhile a mixed-case account takes it.
  const lateEmail = `agl-m3-late-${Date.now()}@lab.invalid`;
  const cLate = await callback({ subject: `m3-late-${Date.now()}`, email: lateEmail, name: "מאוחר" });
  const lateBiz = await owner.business.create({ data: { name: `agl-m3-late-${Date.now()}` }, select: { id: true } });
  await owner.user.create({ data: { email: lateEmail.replace("agl-m3-late", "AGL-M3-LATE"), password: await bcrypt.hash(PASSWORD, 4), name: "מאוחר", businessId: lateBiz.id } });
  const lateDone = await read(await handleGoogleComplete(new Request("https://app.dubiz.test/api/auth/google/complete", {
    method: "POST", headers: { origin: "https://app.dubiz.test", host: "app.dubiz.test", "sec-fetch-site": "same-origin", "x-forwarded-for": ip(), "content-type": "application/json",
      cookie: `${GOOGLE_TICKET_COOKIE}=${cLate.ticket}` }, body: JSON.stringify({ name: "מאוחר", businessName: "עסק מאוחר", acceptTerms: true }) }), m2CompleteDeps));
  ok("L4 completing that signup → 409 EMAIL_ALREADY_REGISTERED (the case-folded index), no second account", lateDone.status === 409 && lateDone.body.code === "EMAIL_ALREADY_REGISTERED"
    && (await holders(lateEmail)) === 1);

  console.log("\n— K. logs —");
  const leaked = secrets.filter((s) => logged.some((line) => line.includes(s) || line.includes(s.split(".")[1] ?? "\u0000")));
  ok(`K1 none of the ${secrets.length} ticket / link secrets appears in the ${logged.length} logged lines`, secrets.length >= 10 && leaked.length === 0);

  console.log(`\n[oauth-identity-app-battery-m3] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); });
