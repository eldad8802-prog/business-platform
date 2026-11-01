/**
 * "Continue with Google" — the PILOT (google-oauth.ts "who") on real rows: the REAL callback decision and the REAL
 * completing routes against the .agl lab with all three oauth migrations applied, as the real planes
 * (te_auth_login, app_runtime_prod). Google is a stand-in at the code-exchange seam; mail is never sent (the
 * outbox row is what is measured).
 *
 *   P1 An unlisted new person: the callback answers "unavailable" — no ticket row, no User, no Business.
 *   P2 An unlisted existing account: no LINK ticket, no identity, no session.
 *   P3 An unlisted account ALREADY linked (linked while open): no session, no login stamp.
 *   P4 A listed linked account: a session, as before.
 *   P5 A listed new person: ticket → completion → one account; the address is Google's, so the account is
 *      verified at once and NO verification email is recorded — only the WELCOME.
 *   P6 Tickets issued BEFORE the list changed (unlisted address): the signup completion, the password proof, the
 *      email-link request and the email-link completion all refuse — nothing spent, created, linked or recorded.
 *   P7 A pilot with no list, an empty list or a malformed list lets nobody in — the owner's address included.
 *   P8 Open mode (explicit) behaves exactly as before for any address.
 *   P9 No address of a refused person in anything logged.
 *
 * env: OWNER_URL, DATABASE_URL, AUTH_DATABASE_URL (connection_limit ≥ 12), AUTH_PLANE_ENABLED=true,
 * AUTH_TOKEN_SECRET, RATE_LIMIT_BACKEND=memory. Synthetic only. ZERO network.
 */
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

import { deriveLinkSecret } from "@/lib/auth/email-link";
import type { GoogleIdentity, GoogleIdTokenResult } from "@/lib/auth/google-id-token";
import { completeGoogleLink, findLinkAccount, requestLinkEmail } from "@/lib/auth/google-link";
import { GOOGLE_LINK_COOKIE, GOOGLE_START_COOKIE, GOOGLE_TICKET_COOKIE, newStartState, readGoogleLoginConfig, sealStartState, type GoogleLoginConfig } from "@/lib/auth/google-oauth";
import { resolveGoogleCallback } from "@/lib/auth/google-sign-in";
import { readLinkTicket, readSignupTicket } from "@/lib/auth/oauth-ticket";
import { createAccountFromGoogle } from "@/lib/auth/signup";
import { readSignupAllowlist } from "@/lib/auth/signup-allowlist";
import { isPublicSignupEnabled } from "@/lib/auth/signup-gate";
import { consumeRateLimit, reserveAttempt } from "@/lib/security/rate-limit";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";
import { handleGoogleCallback } from "@/app/api/auth/google/callback/route";
import { handleGoogleComplete } from "@/app/api/auth/google/complete/route";
import { handleLinkPassword } from "@/app/api/auth/google/link/password/route";
import { handleLinkEmailRequest } from "@/app/api/auth/google/link/email/route";
import { handleLinkEmailComplete } from "@/app/api/auth/google/link/email/complete/route";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

const logged: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(" "));
    real(...args);
  };
}
const refusedAddresses: string[] = [];

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const count = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as Rows)[0].c);

const BASE = {
  AUTH_GOOGLE_LOGIN_ENABLED: "true",
  AUTH_PLANE_ENABLED: "true",
  GOOGLE_LOGIN_CLIENT_ID: "lab-client.apps.googleusercontent.com",
  GOOGLE_LOGIN_CLIENT_SECRET: "lab-secret",
  GOOGLE_LOGIN_REDIRECT_BASE_URL: "https://app.dubiz.test",
};
const OPEN = readGoogleLoginConfig({ ...BASE, AUTH_GOOGLE_LOGIN_MODE: "open" }) as GoogleLoginConfig;
const pilotOf = (list: string | undefined, mode?: string) =>
  readGoogleLoginConfig({ ...BASE, ...(list === undefined ? {} : { AUTH_GOOGLE_LOGIN_PILOT_EMAILS: list }), ...(mode ? { AUTH_GOOGLE_LOGIN_MODE: mode } : {}) }) as GoogleLoginConfig;
let current: GoogleLoginConfig = OPEN;
const CFG = () => current;
const PASSWORD = "Correct-Horse-Battery-9";

let seq = 0;
let ipSeq = 10;
const ip = () => `203.0.113.${(ipSeq = (ipSeq % 250) + 1)}`;
const stamp = () => `${Date.now()}-${++seq}`;

type Account = { userId: number; businessId: number; email: string; subject: string };
async function account(tag: string): Promise<Account> {
  const s = stamp();
  const email = `agl-pilot-${tag}-${s}@lab.invalid`;
  const b = await owner.business.create({ data: { name: `agl-pilot-${tag}-${s}` }, select: { id: true } });
  const u = await owner.user.create({ data: { email, password: await bcrypt.hash(PASSWORD, 4), name: `דנה ${tag}`, businessId: b.id }, select: { id: true } });
  return { userId: u.id, businessId: b.id, email, subject: `pilot-${tag}-${s}` };
}
const identityOf = (a: { email: string; subject: string }): GoogleIdentity => ({ subject: a.subject, email: a.email, name: "דנה" });
const newPerson = (tag: string) => { const s = stamp(); return { email: `agl-pilot-new-${tag}-${s}@lab.invalid`, subject: `pilot-new-${tag}-${s}` }; };

async function callback(identity: GoogleIdentity, from: "login" | "register" = "login") {
  const start = newStartState(from);
  const verified: GoogleIdTokenResult = { ok: true, identity };
  const res = await handleGoogleCallback(new Request(`https://app.dubiz.test/api/auth/google/callback?code=c&state=${start.state}`, {
    headers: { cookie: `${GOOGLE_START_COOKIE}=${encodeURIComponent(sealStartState(start))}`, "x-forwarded-for": ip(), "user-agent": "agl-pilot" },
  }), { config: CFG, exchange: async () => "stand-in-id-token", resolve: (input) => resolveGoogleCallback(input, { verify: async () => verified }), rateLimit: consumeRateLimit, recordUsage: recordProductUsageEvent });
  const cookies = res.headers.getSetCookie();
  const pick = (name: string) => {
    const c = cookies.find((x) => x.startsWith(`${name}=`));
    return (c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : "") || null;
  };
  return { location: res.headers.get("location") ?? "", ticket: pick(GOOGLE_TICKET_COOKIE), link: pick(GOOGLE_LINK_COOKIE), refresh: pick("dubiz_rt") };
}

const post = (p: string, cookieName: string, cookie: string | null, body: unknown = {}) => new Request(`https://app.dubiz.test${p}`, {
  method: "POST",
  headers: { origin: "https://app.dubiz.test", host: "app.dubiz.test", "sec-fetch-site": "same-origin", "x-forwarded-for": ip(), "user-agent": "agl-pilot",
    "content-type": "application/json", ...(cookie ? { cookie: `${cookieName}=${cookie}` } : {}) },
  body: JSON.stringify(body),
});
async function read(res: Response) {
  const set = res.headers.getSetCookie();
  const refresh = set.find((c) => c.startsWith("dubiz_rt="));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, refresh: refresh ? decodeURIComponent(refresh.split(";")[0].slice(9)) || null : null };
}
const complete = async (ticket: string | null) => read(await handleGoogleComplete(post("/api/auth/google/complete", GOOGLE_TICKET_COOKIE, ticket, { name: "דנה", businessName: "עסק פיילוט", acceptTerms: true }),
  { config: CFG, isSignupEnabled: isPublicSignupEnabled, signupAllowlist: readSignupAllowlist, readTicket: readSignupTicket, rateLimit: consumeRateLimit,
    createAccount: createAccountFromGoogle, recordUsage: recordProductUsageEvent, scheduleWelcome: () => {} }));
const linkPassword = async (cookie: string | null) => read(await handleLinkPassword(post("/api/auth/google/link/password", GOOGLE_LINK_COOKIE, cookie, { password: PASSWORD }),
  { config: CFG, readTicket: readLinkTicket, findAccount: findLinkAccount, rateLimit: consumeRateLimit, reserve: reserveAttempt, compare: (p, h) => bcrypt.compare(p, h), complete: completeGoogleLink, deliver: () => {} }));
const requestEmail = async (cookie: string | null) => read(await handleLinkEmailRequest(post("/api/auth/google/link/email", GOOGLE_LINK_COOKIE, cookie),
  { config: CFG, readTicket: readLinkTicket, rateLimit: consumeRateLimit, request: requestLinkEmail, deliver: () => {} }));
const completeEmail = async (cookie: string | null, token: string) => read(await handleLinkEmailComplete(post("/api/auth/google/link/email/complete", GOOGLE_LINK_COOKIE, cookie, { token }),
  { config: CFG, readTicket: readLinkTicket, rateLimit: consumeRateLimit, complete: completeGoogleLink, deliver: () => {} }));

const ticketsFor = (subject: string) => count(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1`, subject);
const openTicketsFor = (subject: string) => count(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1 AND "endedAt" IS NULL`, subject);
const usersWith = (email: string) => count(`SELECT count(*)::int AS c FROM "User" WHERE lower(email) = lower($1)`, email);
const identities = (userId: number) => count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "userId" = $1`, userId);
const sessions = (userId: number) => count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, userId);
const outbox = (userId: number, kind: string) => count(`SELECT count(*)::int AS c FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = $2`, userId, kind);
const linkTokens = (userId: number) => count(`SELECT count(*)::int AS c FROM "AuthEmailToken" WHERE "userId" = $1 AND purpose = 'LINK_GOOGLE'`, userId);
const lastLogin = async (userId: number) => JSON.stringify(((await owner.$queryRawUnsafe(`SELECT "lastLoginAt", "loginCount" FROM "User" WHERE id = $1`, userId)) as Rows)[0]);

async function main() {
  // Public signup open, as in Production: the pilot is the only gate measured here.
  process.env.PUBLIC_SIGNUP_ENABLED = "true";
  console.log("— P1 an unlisted new person —");
  const listedOwner = await account("owner");
  current = pilotOf(listedOwner.email);
  const stranger = newPerson("stranger");
  refusedAddresses.push(stranger.email);
  const c1 = await callback(identityOf(stranger), "register");
  ok("P1 the callback answers 'unavailable' on the register page", c1.location.endsWith("/register?google=unavailable"), c1.location);
  ok("P1 …no ticket row, no cookie of any kind", (await ticketsFor(stranger.subject)) === 0 && !c1.ticket && !c1.link && !c1.refresh);
  ok("P1 …no User and no Business for the address", (await usersWith(stranger.email)) === 0
    && (await count(`SELECT count(*)::int AS c FROM "Business" WHERE name = 'עסק פיילוט' AND id IN (SELECT "businessId" FROM "User" WHERE lower(email) = lower($1))`, stranger.email)) === 0);

  console.log("— P2 an unlisted existing account —");
  const unlisted = await account("unlisted");
  refusedAddresses.push(unlisted.email);
  const c2 = await callback(identityOf(unlisted));
  ok("P2 'unavailable'; no LINK ticket, no identity, no session", c2.location.endsWith("/login?google=unavailable") && (await ticketsFor(unlisted.subject)) === 0
    && (await identities(unlisted.userId)) === 0 && (await sessions(unlisted.userId)) === 0 && !c2.link && !c2.refresh);

  console.log("— P3 / P4 an account already linked —");
  current = OPEN;
  const linkedLater = await account("linked");
  const l0 = await callback(identityOf(linkedLater));
  const l1 = await linkPassword(l0.link);
  ok("P3 setup: linked while open (one identity)", l1.status === 200 && (await identities(linkedLater.userId)) === 1);
  current = pilotOf(listedOwner.email);
  refusedAddresses.push(linkedLater.email);
  const sessionsBefore = await sessions(linkedLater.userId);
  const stampBefore = await lastLogin(linkedLater.userId);
  const c3 = await callback(identityOf(linkedLater));
  ok("P3 a linked but unlisted account: 'unavailable', no session row, no login stamp", c3.location.endsWith("/login?google=unavailable") && !c3.refresh
    && (await sessions(linkedLater.userId)) === sessionsBefore && (await lastLogin(linkedLater.userId)) === stampBefore);
  current = pilotOf(`${listedOwner.email},${linkedLater.email}`);
  const c4 = await callback(identityOf(linkedLater));
  ok("P4 the same account once listed: a session, as before", c4.location.endsWith("/auth/google/done") && !!c4.refresh && (await sessions(linkedLater.userId)) === sessionsBefore + 1);

  console.log("— P5 a listed new person —");
  const fresh = newPerson("fresh");
  current = pilotOf(`${listedOwner.email},${fresh.email}`);
  const c5 = await callback(identityOf(fresh), "register");
  ok("P5 a SIGNUP ticket and nothing else yet", c5.location.endsWith("/register/google") && !!c5.ticket && (await usersWith(fresh.email)) === 0);
  const d5 = await complete(c5.ticket);
  const created = ((await owner.$queryRawUnsafe(`SELECT id, "emailVerifiedAt" FROM "User" WHERE email = $1`, fresh.email)) as { id: number; emailVerifiedAt: Date | null }[])[0];
  ok("P5 the completion creates one account with a session", d5.status === 200 && !!d5.refresh && (await usersWith(fresh.email)) === 1 && !!created);
  ok("P5 …verified at once (the address is Google's): emailVerifiedAt set", !!created?.emailVerifiedAt);
  ok("P5 …NO verification email or token; exactly one WELCOME", created && (await outbox(created.id, "EMAIL_VERIFY")) === 0
    && (await count(`SELECT count(*)::int AS c FROM "AuthEmailToken" WHERE "userId" = $1 AND purpose = 'EMAIL_VERIFY'`, created.id)) === 0
    && (await outbox(created.id, "WELCOME")) === 1);

  console.log("— P6 tickets issued before the list changed —");
  current = OPEN;
  const lateNew = newPerson("late");
  const lateAcct = await account("late-link");
  const lateEmailAcct = await account("late-email");
  const t6 = await callback(identityOf(lateNew), "register");
  const k6 = await callback(identityOf(lateAcct));
  const e6 = await callback(identityOf(lateEmailAcct));
  const asked = await requestEmail(e6.link);
  const rows = (await owner.$queryRawUnsafe(`SELECT payload FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = 'LINK_GOOGLE' ORDER BY id DESC`, lateEmailAcct.userId)) as { payload: { tokenId: string } }[];
  const emailed = rows[0] ? `${rows[0].payload.tokenId}.${deriveLinkSecret(rows[0].payload.tokenId, "LINK_GOOGLE")}` : "";
  ok("P6 setup (open): a SIGNUP ticket, two LINK tickets and one emailed link exist", !!t6.ticket && !!k6.link && !!e6.link && asked.status === 200 && !!emailed);
  current = pilotOf(listedOwner.email);
  refusedAddresses.push(lateNew.email, lateAcct.email, lateEmailAcct.email);

  const r6a = await complete(t6.ticket);
  ok("P6 signup completion → 403 GOOGLE_NOT_AVAILABLE; no account; the ticket NOT spent", r6a.status === 403 && r6a.body.code === "GOOGLE_NOT_AVAILABLE" && !r6a.refresh
    && (await usersWith(lateNew.email)) === 0 && (await openTicketsFor(lateNew.subject)) === 1);
  const r6b = await linkPassword(k6.link);
  ok("P6 password proof → 403; no identity, no session; the ticket NOT spent", r6b.status === 403 && !r6b.refresh && (await identities(lateAcct.userId)) === 0
    && (await sessions(lateAcct.userId)) === 0 && (await openTicketsFor(lateAcct.subject)) === 1);
  const tokensBefore = await linkTokens(lateEmailAcct.userId);
  const mailsBefore = await outbox(lateEmailAcct.userId, "LINK_GOOGLE");
  const r6c = await requestEmail(e6.link);
  ok("P6 email-link request → 403; no new token, no new email", r6c.status === 403 && (await linkTokens(lateEmailAcct.userId)) === tokensBefore && (await outbox(lateEmailAcct.userId, "LINK_GOOGLE")) === mailsBefore);
  const r6d = await completeEmail(e6.link, emailed);
  ok("P6 email-link completion → 403; nothing spent, no identity, no session, no GOOGLE_LINKED", r6d.status === 403 && !r6d.refresh && (await identities(lateEmailAcct.userId)) === 0
    && (await sessions(lateEmailAcct.userId)) === 0 && (await openTicketsFor(lateEmailAcct.subject)) === 1 && (await outbox(lateEmailAcct.userId, "GOOGLE_LINKED")) === 0
    && (await count(`SELECT count(*)::int AS c FROM "AuthEmailToken" WHERE "userId" = $1 AND purpose = 'LINK_GOOGLE' AND "consumedAt" IS NOT NULL`, lateEmailAcct.userId)) === 0);

  console.log("— P7 a pilot without a usable list —");
  for (const [label, cfg] of [["no list", pilotOf(undefined)], ["an empty list", pilotOf("")], ["a malformed list", pilotOf(`${listedOwner.email}, nope`)], ["mode=Open (wrong case)", pilotOf(undefined, "Open")]] as const) {
    current = cfg;
    const s = newPerson("nolist");
    refusedAddresses.push(s.email);
    const a = await callback(identityOf(s), "register");
    const b = await callback(identityOf(listedOwner));
    ok(`P7 ${label}: nobody in — a new person and the owner's address both 'unavailable', no ticket`,
      a.location.endsWith("?google=unavailable") && b.location.endsWith("?google=unavailable") && (await ticketsFor(s.subject)) === 0 && (await ticketsFor(listedOwner.subject)) === 0);
  }

  console.log("— P8 open mode —");
  current = OPEN;
  const anyone = newPerson("anyone");
  const c8 = await callback(identityOf(anyone), "register");
  const d8 = await complete(c8.ticket);
  ok("P8 open: any address signs up as before", c8.location.endsWith("/register/google") && d8.status === 200 && (await usersWith(anyone.email)) === 1);

  console.log("— P9 logs —");
  const leaked = refusedAddresses.filter((a) => logged.some((line) => line.includes(a)));
  ok(`P9 none of the ${refusedAddresses.length} refused addresses appears in the ${logged.length} logged lines`, refusedAddresses.length >= 8 && leaked.length === 0, leaked.join(","));

  console.log(`\n[oauth-identity-app-battery-pilot] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); });
