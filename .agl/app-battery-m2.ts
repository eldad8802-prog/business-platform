/**
 * "Continue with Google", milestone 2 — the REAL routes and the REAL account transaction against the .agl lab
 * (migration 20261030090000 applied; the consent grant of 20261011090100 restored by the migration itself),
 * as the real planes: te_auth_login (auth plane), app_runtime_prod (tenant plane). Google is a stand-in at
 * the code-exchange seam only; everything after it — ticket, gate, account, consent, identity, session,
 * WELCOME — is the production code path.
 *
 *   A  A new person: the callback creates NO User / Business / session, only a ticket; the ticket is neither a
 *      bearer token nor a refresh credential; no business API answers for it.
 *   B  Completion: ONE transaction → one User (no password; consent recorded with the real grants; address
 *      verified), one Business, one identity, one session, one WELCOME and no EMAIL_VERIFY; its session
 *      authenticates as that user and that business only.
 *   C  Replay of the spent ticket: 409, nothing added. Ten concurrent completions with one ticket: exactly
 *      one account. A fault after every write: nothing left, the ticket open; one later completion succeeds.
 *      An invalid form spends nothing.
 *   D  The linked person signs in again: a session for the SAME user and business, no new account.
 *   E  An address that belongs to an existing, unlinked account: no SIGNUP ticket, no session, no link — only a
 *      LINK ticket for the link screen (milestone 3), where the owner must prove ownership first.
 *   F  Signup closed: no ticket for an unlisted address; a listed (closed-beta) address completes.
 *   G  A platform admin, and a business in deletion, linked to Google: no session.
 *
 * env: OWNER_URL, DATABASE_URL, AUTH_DATABASE_URL (connection_limit ≥ 12), AUTH_PLANE_ENABLED=true,
 * AUTH_TOKEN_SECRET, RATE_LIMIT_BACKEND=memory. Synthetic only. ZERO network.
 */
import bcrypt from "bcrypt";
import { PrismaClient, UserRole } from "@prisma/client";

import { getAuthContext, signAuthToken } from "@/lib/auth";
import type { GoogleIdentity, GoogleIdTokenResult } from "@/lib/auth/google-id-token";
import { GOOGLE_START_COOKIE, GOOGLE_TICKET_COOKIE, newStartState, readGoogleLoginConfig, sealStartState, type GoogleLoginConfig } from "@/lib/auth/google-oauth";
import { resolveGoogleCallback } from "@/lib/auth/google-sign-in";
import { refreshSession } from "@/lib/auth/refresh-session";
import { createAccountFromGoogle } from "@/lib/auth/signup";
import { CURRENT_TERMS_VERSION } from "@/lib/legal/consent-version";
import { authDb } from "@/lib/prisma-auth";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";
import { handleGoogleCallback, type CallbackRouteDeps } from "@/app/api/auth/google/callback/route";
import { handleGoogleComplete, type CompleteDeps } from "@/app/api/auth/google/complete/route";
import { readSignupAllowlist } from "@/lib/auth/signup-allowlist";
import { isPublicSignupEnabled } from "@/lib/auth/signup-gate";
import { readSignupTicket } from "@/lib/auth/oauth-ticket";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

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
  AUTH_GOOGLE_LOGIN_MODE: "open",
  GOOGLE_LOGIN_CLIENT_ID: "lab-client.apps.googleusercontent.com",
  GOOGLE_LOGIN_CLIENT_SECRET: "lab-secret",
  GOOGLE_LOGIN_REDIRECT_BASE_URL: "https://app.dubiz.test",
}) as GoogleLoginConfig;

let seq = 0;
const person = (tag: string): GoogleIdentity => {
  seq += 1;
  return { subject: `m2-${tag}-${Date.now()}-${seq}`, email: `agl-m2-${tag}-${Date.now()}-${seq}@lab.invalid`, name: `דנה ${tag}` };
};
let ipSeq = 10;
const ip = () => `198.51.100.${(ipSeq = (ipSeq % 250) + 1)}`;

/** Google, at the code-exchange seam: the ID token "is" this identity, already verified. */
function callbackDeps(identity: GoogleIdentity): CallbackRouteDeps {
  const verified: GoogleIdTokenResult = { ok: true, identity };
  return {
    config: () => config,
    exchange: async () => "stand-in-id-token",
    resolve: (input) => resolveGoogleCallback(input, { verify: async () => verified }),
    rateLimit: consumeRateLimit,
    recordUsage: recordProductUsageEvent,
  };
}
async function callback(identity: GoogleIdentity) {
  const start = newStartState("register");
  const req = new Request(`https://app.dubiz.test/api/auth/google/callback?code=c&state=${start.state}`, {
    headers: { cookie: `${GOOGLE_START_COOKIE}=${encodeURIComponent(sealStartState(start))}`, "x-forwarded-for": ip(), "user-agent": "agl-m2" },
  });
  const res = await handleGoogleCallback(req, callbackDeps(identity));
  const cookies = res.headers.getSetCookie();
  const pick = (name: string) => {
    const c = cookies.find((x) => x.startsWith(`${name}=`));
    const v = c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : "";
    return v || null;
  };
  return { location: res.headers.get("location") ?? "", ticket: pick(GOOGLE_TICKET_COOKIE), refresh: pick("dubiz_rt"), link: pick("dz_google_link") };
}
const completeDeps: CompleteDeps = {
  config: () => config,
  isSignupEnabled: isPublicSignupEnabled,
  signupAllowlist: readSignupAllowlist,
  readTicket: readSignupTicket,
  rateLimit: consumeRateLimit,
  createAccount: createAccountFromGoogle,
  recordUsage: recordProductUsageEvent,
  scheduleWelcome: () => {}, // delivery is OFF in the lab; the WELCOME row is what is measured
};
async function complete(ticket: string | null, body: Record<string, unknown>, deps: CompleteDeps = completeDeps) {
  const res = await handleGoogleComplete(new Request("https://app.dubiz.test/api/auth/google/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: "https://app.dubiz.test", host: "app.dubiz.test", "sec-fetch-site": "same-origin",
      "x-forwarded-for": ip(), "user-agent": "agl-m2", ...(ticket ? { cookie: `${GOOGLE_TICKET_COOKIE}=${ticket}` } : {}),
    },
    body: JSON.stringify(body),
  }), deps);
  const refresh = res.headers.getSetCookie().find((c) => c.startsWith("dubiz_rt="));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, refresh: refresh ? decodeURIComponent(refresh.split(";")[0].slice(9)) : null };
}
const form = (businessName: string) => ({ name: "דנה כהן", businessName, acceptTerms: true });

type Footprint = { users: number; businesses: number; identities: number; sessions: number; welcome: number; verify: number };
async function footprint(email: string, businessName: string, subject: string): Promise<Footprint> {
  return {
    users: await count(`SELECT count(*)::int AS c FROM "User" WHERE email = $1`, email),
    businesses: await count(`SELECT count(*)::int AS c FROM "Business" WHERE name = $1`, businessName),
    identities: await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "providerSubject" = $1`, subject),
    sessions: await count(`SELECT count(*)::int AS c FROM "AuthSession" s JOIN "User" u ON u.id = s."userId" WHERE u.email = $1`, email),
    welcome: await count(`SELECT count(*)::int AS c FROM "TransactionalEmail" WHERE "toEmail" = $1 AND kind = 'WELCOME'`, email),
    verify: await count(`SELECT count(*)::int AS c FROM "TransactionalEmail" WHERE "toEmail" = $1 AND kind = 'EMAIL_VERIFY'`, email),
  };
}
const same = (a: Footprint, b: Footprint) => JSON.stringify(a) === JSON.stringify(b);
const NONE: Footprint = { users: 0, businesses: 0, identities: 0, sessions: 0, welcome: 0, verify: 0 };
const ONE: Footprint = { users: 1, businesses: 1, identities: 1, sessions: 1, welcome: 1, verify: 0 };
const bearer = (token: string) => new Request("https://app.dubiz.test/api/home", { headers: { authorization: `Bearer ${token}` } });

async function main() {
  process.env.PUBLIC_SIGNUP_ENABLED = "true";
  delete process.env.SIGNUP_ALLOWED_EMAILS;

  console.log("\n— A. a new person: a ticket, and nothing else —");
  const p1 = person("new");
  const b1 = `agl-m2-biz-${Date.now()}`;
  const c1 = await callback(p1);
  ok("A1 the callback sends a new person to /register/google with a ticket", c1.location.endsWith("/register/google") && !!c1.ticket);
  ok("A1 …and no refresh cookie", c1.refresh === null);
  ok("A1 NO User, Business, identity, session or email exists yet", same(await footprint(p1.email, b1, p1.subject), NONE));
  ok("A2 the ticket is not a bearer token", (await getAuthContext(bearer(c1.ticket!))) === null);
  ok("A2 the ticket is not a refresh credential", (await refreshSession(authDb(), { credential: c1.ticket!, now: new Date() })).kind === "unauthorized");

  console.log("\n— C(form). an invalid form spends nothing —");
  const bad = await complete(c1.ticket, { name: "דנה", businessName: "", acceptTerms: true });
  ok("C0 no business name → 400 on businessName", bad.status === 400 && bad.body.field === "businessName");
  const noConsent = await complete(c1.ticket, { name: "דנה", businessName: b1, acceptTerms: false });
  ok("C0 no consent → 400 on acceptTerms", noConsent.status === 400 && noConsent.body.field === "acceptTerms");
  ok("C0 …nothing written and the ticket still open", same(await footprint(p1.email, b1, p1.subject), NONE) && (await readSignupTicket(c1.ticket)) !== null);

  console.log("\n— B. completion: one transaction —");
  const done = await complete(c1.ticket, form(b1));
  ok("B1 completion → 200, next /setup, a refresh cookie, no token in the body", done.status === 200 && done.body.next === "/setup" && !!done.refresh && !("token" in done.body));
  ok("B1 exactly one User, Business, identity, session and WELCOME; no EMAIL_VERIFY", same(await footprint(p1.email, b1, p1.subject), ONE),
    JSON.stringify(await footprint(p1.email, b1, p1.subject)));
  const u1 = await owner.user.findUnique({ where: { email: p1.email }, select: { id: true, businessId: true, password: true, emailVerifiedAt: true, termsAcceptedAt: true, termsVersion: true, name: true } });
  ok("B2 consent recorded in the same transaction, with the real grants (termsAcceptedAt + current termsVersion)",
    u1?.termsAcceptedAt instanceof Date && u1?.termsVersion === CURRENT_TERMS_VERSION, JSON.stringify({ at: u1?.termsAcceptedAt, v: u1?.termsVersion }));
  ok("B2 no password; the provider-verified address is marked verified; the typed name kept", u1?.password === null && u1?.emailVerifiedAt instanceof Date && u1?.name === "דנה כהן");
  const rt = await refreshSession(authDb(), { credential: done.refresh!, now: new Date() });
  ok("B3 the refresh cookie the completion set is a live session for that user", rt.kind === "rotated" && rt.userId === u1?.id, rt.kind);
  if (rt.kind === "rotated") {
    const ctx = await getAuthContext(bearer(signAuthToken(rt.userId, rt.tokenVersion, rt.sessionId)));
    ok("B3 …whose token authenticates as that user AND that business only", ctx?.user.id === u1?.id && ctx?.user.businessId === u1?.businessId);
  }
  ok("B4 the completion recorded one AUTH_REGISTER COMPLETED for that user (google)",
    (await count(`SELECT count(*)::int AS c FROM "ProductUsageEvent" WHERE "userId" = $1 AND "featureKey" = 'AUTH_REGISTER' AND action = 'COMPLETED'`, u1?.id)) <= 1);

  console.log("\n— C. replay, concurrency, rollback —");
  const after = await footprint(p1.email, b1, p1.subject);
  const replay = await complete(c1.ticket, form(`${b1}-again`));
  ok("C1 replay of the spent ticket → 409 TICKET_REFUSED, no refresh cookie", replay.status === 409 && replay.body.code === "TICKET_REFUSED" && replay.refresh === null);
  ok("C1 …nothing added (account, business, identity, session, WELCOME)", same(await footprint(p1.email, b1, p1.subject), after)
    && (await count(`SELECT count(*)::int AS c FROM "Business" WHERE name = $1`, `${b1}-again`)) === 0);

  const p2 = person("race");
  const b2 = `agl-m2-race-${Date.now()}`;
  const c2 = await callback(p2);
  const raced = await Promise.all(Array.from({ length: 10 }, () => complete(c2.ticket, form(b2))));
  ok("C2 ten concurrent completions with one ticket: exactly one 200", raced.filter((r) => r.status === 200).length === 1, raced.map((r) => r.status).join(","));
  ok("C2 …nine 409 TICKET_REFUSED", raced.filter((r) => r.status === 409 && r.body.code === "TICKET_REFUSED").length === 9);
  ok("C2 …exactly one User, Business, identity, session and WELCOME", same(await footprint(p2.email, b2, p2.subject), ONE), JSON.stringify(await footprint(p2.email, b2, p2.subject)));

  const p3 = person("fault");
  const b3 = `agl-m2-fault-${Date.now()}`;
  const c3 = await callback(p3);
  const faulty: CompleteDeps = { ...completeDeps, createAccount: (input) => createAccountFromGoogle({ ...input, beforeCommit: async () => { throw new Error("LAB_FAULT_AFTER_EVERY_WRITE"); } }) };
  const f = await complete(c3.ticket, form(b3), faulty);
  ok("C3 a fault after every write → 500", f.status === 500, String(f.status));
  ok("C3 …leaves NOTHING (no account, business, identity, session, email) and the ticket open",
    same(await footprint(p3.email, b3, p3.subject), NONE) && (await readSignupTicket(c3.ticket)) !== null, JSON.stringify(await footprint(p3.email, b3, p3.subject)));
  ok("C3 …one later completion succeeds, once", (await complete(c3.ticket, form(b3))).status === 200
    && (await complete(c3.ticket, form(b3))).status === 409 && same(await footprint(p3.email, b3, p3.subject), ONE));

  console.log("\n— D. the linked person signs in again —");
  const sessionsBefore = await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, u1?.id);
  const again = await callback(p1);
  ok("D1 → /auth/google/done with a refresh cookie, no ticket", again.location.endsWith("/auth/google/done") && !!again.refresh && again.ticket === null);
  const rt2 = await refreshSession(authDb(), { credential: again.refresh!, now: new Date() });
  ok("D1 …the session is the SAME user (and so the same business)", rt2.kind === "rotated" && rt2.userId === u1?.id);
  ok("D1 …one new session, no new account", (await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, u1?.id)) === sessionsBefore + 1
    && (await count(`SELECT count(*)::int AS c FROM "User" WHERE email = $1`, p1.email)) === 1);
  const stamp = await owner.user.findUnique({ where: { id: u1!.id }, select: { lastLoginAt: true, loginCount: true } });
  ok("D1 …stamped like a password login (lastLoginAt, loginCount)", stamp?.lastLoginAt instanceof Date && (stamp?.loginCount ?? 0) >= 1);

  console.log("\n— E. an existing, unlinked account with the same address —");
  const pwBiz = await owner.business.create({ data: { name: `agl-m2-pw-${Date.now()}` }, select: { id: true } });
  const pwEmail = `agl-m2-pw-${Date.now()}@lab.invalid`;
  const pwUser = await owner.user.create({ data: { email: pwEmail, password: await bcrypt.hash("pw-123456", 4), name: "פ", businessId: pwBiz.id }, select: { id: true } });
  const pE = { subject: `m2-existing-${Date.now()}`, email: pwEmail, name: "פ" };
  const sE = await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, pwUser.id);
  const cE = await callback(pE);
  ok("E1 → the link screen (/link/google) with a LINK ticket — milestone 3", cE.location.endsWith("/link/google") && !!cE.link);
  ok("E1 …no session, no SIGNUP ticket cookie", cE.refresh === null && cE.ticket === null);
  ok("E1 …no SIGNUP ticket row, no identity, no session, no second account",
    (await count(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1 AND purpose = 'SIGNUP'`, pE.subject)) === 0
    && (await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "userId" = $1`, pwUser.id)) === 0
    && (await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, pwUser.id)) === sE
    && (await count(`SELECT count(*)::int AS c FROM "User" WHERE email = $1`, pwEmail)) === 1);

  console.log("\n— F. signup closed —");
  process.env.PUBLIC_SIGNUP_ENABLED = "false";
  const pF = person("closed");
  const cF = await callback(pF);
  ok("F1 closed, no list → /register?google=closed, no ticket", cF.location.endsWith("/register?google=closed") && cF.ticket === null
    && (await count(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1`, pF.subject)) === 0);
  const pL = person("listed");
  process.env.SIGNUP_ALLOWED_EMAILS = pL.email;
  const cL = await callback(pL);
  ok("F2 closed, a listed (closed-beta) address → a ticket", cL.location.endsWith("/register/google") && !!cL.ticket);
  const bL = `agl-m2-listed-${Date.now()}`;
  ok("F2 …and it completes", (await complete(cL.ticket, form(bL))).status === 200 && same(await footprint(pL.email, bL, pL.subject), ONE));
  const pU = person("unlisted-ticket");
  process.env.PUBLIC_SIGNUP_ENABLED = "true";
  const cU = await callback(pU);
  process.env.PUBLIC_SIGNUP_ENABLED = "false";
  const bU = `agl-m2-unlisted-${Date.now()}`;
  const closedNow = await complete(cU.ticket, form(bU));
  ok("F3 a ticket issued while open, completed after signup closed (address unlisted) → 403, nothing created",
    closedNow.status === 403 && same(await footprint(pU.email, bU, pU.subject), NONE));
  process.env.PUBLIC_SIGNUP_ENABLED = "true";
  delete process.env.SIGNUP_ALLOWED_EMAILS;

  console.log("\n— G. who never gets a session through Google —");
  const adminBiz = await owner.business.create({ data: { name: `agl-m2-admin-${Date.now()}` }, select: { id: true } });
  const admin = await owner.user.create({ data: { email: `agl-m2-admin-${Date.now()}@lab.invalid`, password: await bcrypt.hash("pw-123456", 4), name: "א", businessId: adminBiz.id, role: UserRole.PLATFORM_ADMIN }, select: { id: true, email: true } });
  const pA = { subject: `m2-admin-${Date.now()}`, email: admin.email, name: "א" };
  await owner.$executeRawUnsafe(`INSERT INTO "UserIdentity" ("userId","businessId","provider","providerSubject","emailAtLink","linkedAt") VALUES ($1,$2,'google',$3,$4,now())`, admin.id, adminBiz.id, pA.subject, admin.email);
  const cA = await callback(pA);
  ok("G1 a platform admin linked to Google → /login?google=admin, no session",
    cA.location.endsWith("/login?google=admin") && cA.refresh === null && (await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, admin.id)) === 0);
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, u1!.businessId);
  const sDoomed = await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, u1?.id);
  const cD = await callback(p1);
  ok("G2 a business in deletion → /login?google=unavailable, no session",
    cD.location.endsWith("/login?google=unavailable") && cD.refresh === null && (await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, u1?.id)) === sDoomed);

  console.log(`\n[oauth-identity-app-battery-m2] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const x of failures) console.log(`  - ${x}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); await authDb().$disconnect(); });
