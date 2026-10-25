/**
 * "Continue with Google" — the server-side cancel through the REAL routes and the REAL account transaction,
 * against the .agl lab with both migrations applied (20261030090000 + 20261101090000), as the real planes:
 * te_auth_login (auth plane), app_runtime_prod (tenant plane). Google is a stand-in at the code-exchange
 * seam only.
 *
 *   A  Cancel, then a COPY of the secret: the form reads nothing and the completion is refused (409); no
 *      account. A second cancel with the copy is safe (200, nothing changes).
 *   B  Already unusable: an expired ticket, a secret nobody holds → 200 "ended"; no row changes.
 *   C  The database refuses the cancel (EXECUTE revoked from the auth plane for the test): 503, the cookie
 *      KEPT, the ticket still open and still completable; once restored, the retry ends it.
 *   D  Race, cancel first: the cancel's transaction holds the row; a completion waits, then is refused.
 *   E  Race, completion first: the completion holds the row; a cancel waits, then answers ALREADY_COMPLETED;
 *      the account is whole and untouched.
 *   F  Race, completion rolled back: the waiting cancel then ends the ticket; no account.
 *   G  A new sign-in after a cancel: a fresh ticket, which completes.
 *   H  Flag OFF: the cancel route answers 404 and touches no row.
 *   I  Purge: the sweep removes a cancelled ticket once it has expired.
 *   J  No ticket secret appears in anything the code logged.
 *
 * env: OWNER_URL, DATABASE_URL, AUTH_DATABASE_URL (connection_limit ≥ 12), AUTH_PLANE_ENABLED=true,
 * AUTH_TOKEN_SECRET, RATE_LIMIT_BACKEND=memory. Synthetic only. ZERO network.
 */
import { PrismaClient } from "@prisma/client";

import type { GoogleIdentity, GoogleIdTokenResult } from "@/lib/auth/google-id-token";
import { GOOGLE_START_COOKIE, GOOGLE_TICKET_COOKIE, newStartState, readGoogleLoginConfig, sealStartState, type GoogleLoginConfig } from "@/lib/auth/google-oauth";
import { resolveGoogleCallback } from "@/lib/auth/google-sign-in";
import { cancelSignupTicket, purgeExpiredTickets, readSignupTicket } from "@/lib/auth/oauth-ticket";
import { createAccountFromGoogle } from "@/lib/auth/signup";
import { readSignupAllowlist } from "@/lib/auth/signup-allowlist";
import { isPublicSignupEnabled } from "@/lib/auth/signup-gate";
import { authDb } from "@/lib/prisma-auth";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";
import { handleGoogleCallback, type CallbackRouteDeps } from "@/app/api/auth/google/callback/route";
import { handleGoogleComplete, type CompleteDeps } from "@/app/api/auth/google/complete/route";
import { handleTicketCancel, handleTicketRead, type CancelRouteDeps } from "@/app/api/auth/google/ticket/route";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

// Everything the code under test logs, to prove (J) that no ticket secret is ever in it.
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
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config = readGoogleLoginConfig({
  AUTH_GOOGLE_LOGIN_ENABLED: "true",
  GOOGLE_LOGIN_CLIENT_ID: "lab-client.apps.googleusercontent.com",
  GOOGLE_LOGIN_CLIENT_SECRET: "lab-secret",
  GOOGLE_LOGIN_REDIRECT_BASE_URL: "https://app.dubiz.test",
}) as GoogleLoginConfig;

let seq = 0;
const person = (tag: string): GoogleIdentity => {
  seq += 1;
  return { subject: `cancel-${tag}-${Date.now()}-${seq}`, email: `agl-cancel-${tag}-${Date.now()}-${seq}@lab.invalid`, name: `דנה ${tag}` };
};
let ipSeq = 10;
const ip = () => `203.0.113.${(ipSeq = (ipSeq % 250) + 1)}`;

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
/** Google → the callback → a ticket cookie (and nothing else) for a new person. */
async function ticketFor(identity: GoogleIdentity): Promise<string> {
  const start = newStartState("register");
  const res = await handleGoogleCallback(new Request(`https://app.dubiz.test/api/auth/google/callback?code=c&state=${start.state}`, {
    headers: { cookie: `${GOOGLE_START_COOKIE}=${encodeURIComponent(sealStartState(start))}`, "x-forwarded-for": ip(), "user-agent": "agl-cancel" },
  }), callbackDeps(identity));
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`${GOOGLE_TICKET_COOKIE}=`));
  const v = c ? decodeURIComponent(c.split(";")[0].slice(GOOGLE_TICKET_COOKIE.length + 1)) : "";
  if (!v) throw new Error("no ticket issued");
  secrets.push(v);
  return v;
}
const completeDeps: CompleteDeps = {
  config: () => config,
  isSignupEnabled: isPublicSignupEnabled,
  signupAllowlist: readSignupAllowlist,
  readTicket: readSignupTicket,
  rateLimit: consumeRateLimit,
  createAccount: createAccountFromGoogle,
  recordUsage: recordProductUsageEvent,
  scheduleWelcome: () => {},
};
const browserHeaders = (ticket: string | null) => ({
  origin: "https://app.dubiz.test", host: "app.dubiz.test", "sec-fetch-site": "same-origin", "x-forwarded-for": ip(), "user-agent": "agl-cancel",
  ...(ticket ? { cookie: `${GOOGLE_TICKET_COOKIE}=${ticket}` } : {}),
});
async function complete(ticket: string, businessName: string, deps: CompleteDeps = completeDeps) {
  const res = await handleGoogleComplete(new Request("https://app.dubiz.test/api/auth/google/complete", {
    method: "POST",
    headers: { "content-type": "application/json", ...browserHeaders(ticket) },
    body: JSON.stringify({ name: "דנה כהן", businessName, acceptTerms: true }),
  }), deps);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const cancelDeps: CancelRouteDeps = { config: () => config, cancel: cancelSignupTicket, rateLimit: consumeRateLimit };
async function cancelRoute(ticket: string | null, deps: CancelRouteDeps = cancelDeps) {
  const res = await handleTicketCancel(new Request("https://app.dubiz.test/api/auth/google/ticket", { method: "DELETE", headers: browserHeaders(ticket) }), deps);
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`${GOOGLE_TICKET_COOKIE}=`)) ?? "";
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, cleared: /Max-Age=0/.test(c), kept: c === "" };
}
const readRoute = async (ticket: string) =>
  (await handleTicketRead(new Request("https://app.dubiz.test/api/auth/google/ticket", { headers: browserHeaders(ticket) }), { config: () => config, read: readSignupTicket })).status;
const ticketState = async (subject: string) =>
  (await owner.$queryRawUnsafe(`SELECT id, "endedAt", "endedReason", "consumedByUserId" FROM "OAuthSignupTicket" WHERE "providerSubject" = $1 ORDER BY "issuedAt"`, subject)) as Rows;

type Footprint = { users: number; businesses: number; identities: number; sessions: number };
async function footprint(p: GoogleIdentity, businessName: string): Promise<Footprint> {
  return {
    users: await count(`SELECT count(*)::int AS c FROM "User" WHERE email = $1`, p.email),
    businesses: await count(`SELECT count(*)::int AS c FROM "Business" WHERE name = $1`, businessName),
    identities: await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "providerSubject" = $1`, p.subject),
    sessions: await count(`SELECT count(*)::int AS c FROM "AuthSession" s JOIN "User" u ON u.id = s."userId" WHERE u.email = $1`, p.email),
  };
}
const same = (a: Footprint, b: Footprint) => JSON.stringify(a) === JSON.stringify(b);
const NONE: Footprint = { users: 0, businesses: 0, identities: 0, sessions: 0 };
const ONE: Footprint = { users: 1, businesses: 1, identities: 1, sessions: 1 };

async function main() {
  process.env.PUBLIC_SIGNUP_ENABLED = "true";
  delete process.env.SIGNUP_ALLOWED_EMAILS;

  console.log("\n— A. cancel, then a copy of the secret —");
  const pA = person("copy"); const bA = `agl-cancel-a-${Date.now()}`;
  const tA = await ticketFor(pA);
  const copy = tA;
  const cA = await cancelRoute(tA);
  ok("A1 the real cancel route → 200 cancelled, the cookie cleared", cA.status === 200 && cA.body.status === "cancelled" && cA.cleared);
  ok("A1 …the row is ended CANCELLED on the server", (await ticketState(pA.subject))[0]?.endedReason === "CANCELLED");
  ok("A2 the copy no longer reads (401)", (await readRoute(copy)) === 401);
  const lateA = await complete(copy, bA);
  ok("A2 the copy cannot complete: 409 TICKET_REFUSED", lateA.status === 409 && lateA.body.code === "TICKET_REFUSED");
  ok("A2 …no account, business, identity or session", same(await footprint(pA, bA), NONE));
  const againA = await cancelRoute(copy);
  ok("A3 a second cancel with the copy → 200 cancelled, nothing changes", againA.status === 200 && againA.body.status === "cancelled"
    && (await ticketState(pA.subject)).length === 1 && (await ticketState(pA.subject))[0].endedReason === "CANCELLED");

  console.log("\n— B. already unusable —");
  const pB = person("expired");
  const tB = await ticketFor(pB);
  await owner.$executeRawUnsafe(`UPDATE "OAuthSignupTicket" SET "issuedAt" = timezone('UTC', now()) - interval '40 minutes', "expiresAt" = timezone('UTC', now()) - interval '10 minutes' WHERE "providerSubject" = $1`, pB.subject);
  const cB = await cancelRoute(tB);
  ok("B1 an expired ticket → 200 ended, the cookie cleared, the row unchanged", cB.status === 200 && cB.body.status === "ended" && cB.cleared
    && (await ticketState(pB.subject))[0].endedAt === null);
  const pB2 = person("bystander");
  const tB2 = await ticketFor(pB2);
  const unheld = "Q".repeat(43);
  const cB2 = await cancelRoute(unheld);
  ok("B2 a secret nobody holds → 200 ended; another person's open ticket is untouched", cB2.status === 200 && cB2.body.status === "ended"
    && (await ticketState(pB2.subject))[0].endedAt === null && (await readRoute(tB2)) === 200);

  console.log("\n— C. the database refuses, then the retry —");
  const pC = person("fail"); const bC = `agl-cancel-c-${Date.now()}`;
  const tC = await ticketFor(pC);
  await owner.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION public.auth_oauth_ticket_cancel(text, text) FROM app_auth`);
  let cC: Awaited<ReturnType<typeof cancelRoute>>;
  try {
    cC = await cancelRoute(tC);
  } finally {
    await owner.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION public.auth_oauth_ticket_cancel(text, text) TO app_auth`);
  }
  ok("C1 the cancel fails in the database → 503 CANCEL_FAILED (never 'cancelled')", cC.status === 503 && cC.body.code === "CANCEL_FAILED" && cC.body.status === undefined);
  ok("C1 …the cookie is KEPT", cC.kept);
  ok("C1 …the ticket is still open on the server and still reads", (await ticketState(pC.subject))[0].endedAt === null && (await readRoute(tC)) === 200);
  const retry = await cancelRoute(tC);
  ok("C2 the retry → 200 cancelled; the row is CANCELLED", retry.status === 200 && retry.body.status === "cancelled" && retry.cleared
    && (await ticketState(pC.subject))[0].endedReason === "CANCELLED");
  ok("C2 …and the secret can no longer complete", (await complete(tC, bC)).status === 409 && same(await footprint(pC, bC), NONE));

  console.log("\n— D. race, cancel first —");
  const pD = person("race-cancel"); const bD = `agl-cancel-d-${Date.now()}`;
  const tD = await ticketFor(pD);
  // The cancel's transaction holds the row for 1.2 s after ending it — a completion arriving meanwhile waits.
  const heldCancel: CancelRouteDeps = { ...cancelDeps, cancel: (s) => authDb().$transaction(async (tx) => {
    const outcome = await cancelSignupTicket(s, tx);
    await tx.$queryRaw`SELECT 1 AS slept FROM pg_sleep(1.2)`;
    return outcome;
  }, { timeout: 30_000, maxWait: 30_000 }) };
  const cancelD = cancelRoute(tD, heldCancel);
  await delay(300);
  const startD = Date.now();
  const doneD = await complete(tD, bD);
  const waitedD = Date.now() - startD;
  const cD = await cancelD;
  ok("D1 the cancel won → 200 cancelled", cD.status === 200 && cD.body.status === "cancelled");
  ok("D1 the completion waited on the row, then 409 TICKET_REFUSED", doneD.status === 409 && doneD.body.code === "TICKET_REFUSED" && waitedD >= 500, `${doneD.status} after ${waitedD} ms`);
  ok("D1 …no account", same(await footprint(pD, bD), NONE));

  console.log("\n— E. race, completion first —");
  const pE = person("race-done"); const bE = `agl-cancel-e-${Date.now()}`;
  const tE = await ticketFor(pE);
  const slowCommit: CompleteDeps = { ...completeDeps, createAccount: (input) => createAccountFromGoogle({ ...input, beforeCommit: () => delay(1200) }) };
  const doneE = complete(tE, bE, slowCommit);
  await delay(300);
  const startE = Date.now();
  const cE = await cancelRoute(tE);
  const waitedE = Date.now() - startE;
  const finishedE = await doneE;
  ok("E1 the completion won → 200", finishedE.status === 200);
  ok("E1 the cancel waited on the row, then 409 ALREADY_COMPLETED (the cookie cleared)",
    cE.status === 409 && cE.body.code === "ALREADY_COMPLETED" && cE.cleared && waitedE >= 500, `${cE.status} after ${waitedE} ms`);
  const userE = await owner.user.findUnique({ where: { email: pE.email }, select: { id: true, businessId: true } });
  const stE = (await ticketState(pE.subject))[0];
  ok("E1 …the account is whole: one user, business, identity, session", same(await footprint(pE, bE), ONE));
  ok("E1 …the ticket stays CONSUMED and names that user", stE.endedReason === "CONSUMED" && Number(stE.consumedByUserId) === userE?.id);
  const cE2 = await cancelRoute(tE);
  ok("E2 a later cancel with the same secret still changes nothing (409)", cE2.status === 409 && same(await footprint(pE, bE), ONE)
    && (await owner.user.findUnique({ where: { email: pE.email }, select: { businessId: true } }))?.businessId === userE?.businessId);

  console.log("\n— F. race, completion rolled back —");
  const pF = person("race-rb"); const bF = `agl-cancel-f-${Date.now()}`;
  const tF = await ticketFor(pF);
  const failingCommit: CompleteDeps = { ...completeDeps, createAccount: (input) => createAccountFromGoogle({ ...input, beforeCommit: async () => { await delay(1200); throw new Error("LAB_FAULT_AFTER_EVERY_WRITE"); } }) };
  const doneF = complete(tF, bF, failingCommit);
  await delay(300);
  const cF = await cancelRoute(tF);
  const finishedF = await doneF;
  ok("F1 the completion failed and rolled back (500)", finishedF.status === 500);
  ok("F1 the waiting cancel then ended the ticket → 200 cancelled", cF.status === 200 && cF.body.status === "cancelled"
    && (await ticketState(pF.subject))[0].endedReason === "CANCELLED");
  ok("F1 …no account; the secret cannot complete afterwards", same(await footprint(pF, bF), NONE) && (await complete(tF, bF)).status === 409);

  console.log("\n— G. a new sign-in after a cancel —");
  const tG = await ticketFor(pA);
  ok("G1 Google again → a fresh ticket the form can read", (await readRoute(tG)) === 200);
  ok("G1 …it completes, once", (await complete(tG, bA)).status === 200 && same(await footprint(pA, bA), ONE));
  const states = await ticketState(pA.subject);
  ok("G1 …the cancelled ticket stays CANCELLED beside the consumed one", states.length === 2 && states[0].endedReason === "CANCELLED" && states[1].endedReason === "CONSUMED");

  console.log("\n— H. flag OFF —");
  const pH = person("off");
  const tH = await ticketFor(pH);
  const off = await cancelRoute(tH, { ...cancelDeps, config: () => null });
  ok("H1 OFF: the cancel route → 404 and the ticket is untouched", off.status === 404 && off.kept && (await ticketState(pH.subject))[0].endedAt === null);

  console.log("\n— I. purge —");
  await owner.$executeRawUnsafe(`UPDATE "OAuthSignupTicket" SET "issuedAt" = timezone('UTC', now()) - interval '40 minutes', "expiresAt" = timezone('UTC', now()) - interval '10 minutes' WHERE "providerSubject" = $1`, pC.subject);
  const purged = await purgeExpiredTickets();
  ok("I1 the sweep removes the cancelled ticket once expired (and only expired ones)", purged >= 2 && (await ticketState(pC.subject)).length === 0
    && (await ticketState(pH.subject)).length === 1 && (await ticketState(pD.subject)).length === 1);

  console.log("\n— J. logs —");
  const leaked = secrets.filter((s) => logged.some((line) => line.includes(s)));
  ok(`J1 none of the ${secrets.length} ticket secrets appears in the ${logged.length} logged lines`, secrets.length >= 8 && leaked.length === 0);

  console.log(`\n[oauth-ticket-cancel-app-battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); });
