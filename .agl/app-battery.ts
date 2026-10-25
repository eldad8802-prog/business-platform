/**
 * "Continue with Google", milestone 1 — the REAL application modules against the .agl lab with migration
 * 20261030090000_oauth_identity_foundation applied, as the real planes (te_auth_login for the auth plane,
 * app_runtime_prod for the tenant plane):
 *
 *   1. Before signup is complete there is NO way in (T1–T4): a ticket creates no User / Business / session;
 *      its secret is not a bearer token (getAuthContext → null) and not a refresh credential.
 *   2. The completed signup (lib/auth/oauth-ticket.ts inside one auth-plane transaction, with the generated
 *      Prisma client and the optional password): exactly one User (no password, verified address), one
 *      Business, one identity, one session; a token minted for that session authenticates.
 *   3. Single use through the service (T14, T33): replay throws SignupTicketRefusedError and adds nothing;
 *      ten concurrent completions with one ticket → exactly one account; a failure after the spend leaves
 *      the ticket open for one later completion (T37).
 *   4. Resolve + the Google sign-in policy: a linked subject resolves to its account; a platform admin and a
 *      business in deletion are refused before any session.
 *   5. T32 — the password login route: an account with no password is answered exactly like a wrong
 *      password (401, same body, counted, no session); a password account still signs in; an unknown
 *      address is answered the same way.
 *   6. Purge: expired tickets go, open ones stay.
 *
 * env: OWNER_URL, DATABASE_URL, AUTH_DATABASE_URL, AUTH_PLANE_ENABLED=true, AUTH_TOKEN_SECRET,
 * RATE_LIMIT_BACKEND=memory. Synthetic only. ZERO network.
 */
import bcrypt from "bcrypt";
import { PrismaClient, UserRole } from "@prisma/client";

import { getAuthContext, signAuthToken } from "@/lib/auth";
import { issueRefreshSession, refreshSession } from "@/lib/auth/refresh-session";
import {
  attachGoogleIdentity,
  hashTicketSecret,
  issueSignupTicket,
  purgeExpiredTickets,
  readSignupTicket,
  resolveGoogleIdentity,
  SignupTicketRefusedError,
  spendSignupTicket,
  type SpentTicket,
} from "@/lib/auth/oauth-ticket";
import { googleSignInRefusal } from "@/lib/auth/google-sign-in-policy";
import type { GoogleIdentity } from "@/lib/auth/google-id-token";
import { authDb } from "@/lib/prisma-auth";
import { POST as login } from "@/app/api/auth/login/route";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const count = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as Rows)[0].c);

let n = 0;
const identity = (tag: string): GoogleIdentity => {
  n += 1;
  return { subject: `app-sub-${Date.now()}-${n}`, email: `agl-app-${tag}-${Date.now()}-${n}@lab.invalid`, name: `דנה ${tag}` };
};
type Footprint = { users: number; businesses: number; identities: number; sessions: number };
async function footprint(email: string, businessName: string, subject: string): Promise<Footprint> {
  return {
    users: await count(`SELECT count(*)::int AS c FROM "User" WHERE email = $1`, email),
    businesses: await count(`SELECT count(*)::int AS c FROM "Business" WHERE name = $1`, businessName),
    identities: await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "providerSubject" = $1`, subject),
    sessions: await count(`SELECT count(*)::int AS c FROM "AuthSession" s JOIN "User" u ON u.id = s."userId" WHERE u.email = $1`, email),
  };
}
const same = (a: Footprint, b: Footprint) => JSON.stringify(a) === JSON.stringify(b);
const ZERO: Footprint = { users: 0, businesses: 0, identities: 0, sessions: 0 };
const ONE: Footprint = { users: 1, businesses: 1, identities: 1, sessions: 1 };

type Completed = { userId: number; businessId: number; sessionId: string; tokenVersion: number; spent: SpentTicket };
/**
 * The completion the application's signup will run (milestone 2 wires it to a route): spend the ticket
 * FIRST, then Business → User (no password) → identity → session, all in one auth-plane transaction.
 */
function completeSignup(secret: string, businessName: string, opts: { pause?: number; failAfterSpend?: boolean } = {}) {
  const now = new Date();
  return authDb().$transaction(async (tx) => {
    const spent = await spendSignupTicket(tx, secret);
    // pg_sleep returns void, which the raw-query decoder cannot read: select a value beside it.
    if (opts.pause) await tx.$queryRawUnsafe(`SELECT 1 AS slept FROM pg_sleep(${opts.pause})`);
    // Raw inserts, as the signup plane's lab grants allow (this lab does not hold every column grant the
    // generated client's create would name; the register route test covers that path). No password column.
    const b = (await tx.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, businessName)) as Rows;
    const business = { id: Number(b[0].id) };
    const u = (await tx.$queryRawUnsafe(
      `INSERT INTO "User" ("email","name","businessId","updatedAt") VALUES ($1,$2,$3, now()) RETURNING id`,
      spent.email, spent.name ?? businessName, business.id,
    )) as Rows;
    // A new row starts at generation 0 (the column default); the consent columns are written by the real
    // signup (createAccount, milestone 2) and are outside this lab's grants.
    const user = { id: Number(u[0].id), tokenVersion: 0 };
    if (opts.failAfterSpend) throw new Error("FORCED_FAILURE");
    await attachGoogleIdentity(tx, spent.ticketId, user.id);
    const session = await issueRefreshSession(tx, { userId: user.id, tokenVersion: user.tokenVersion, now, userAgent: "agl-app-battery" });
    return { userId: user.id, businessId: business.id, sessionId: session.sessionId, tokenVersion: user.tokenVersion, spent } satisfies Completed;
  }, { timeout: 60_000, maxWait: 60_000 });
}
const outcome = (p: Promise<Completed>) =>
  p.then((c) => c as Completed | string, (e: unknown) => (e instanceof SignupTicketRefusedError ? "REFUSED" : e instanceof Error ? e.message : String(e)));

const post = (body: unknown, ip: string) =>
  new Request("http://lab/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "agl-app-battery" },
    body: JSON.stringify(body),
  });

async function main() {
  console.log("\n— 1. before the signup is complete there is no way in (T1–T4) —");
  const g1 = identity("pending");
  const biz1 = `agl-app-pending-${Date.now()}`;
  const t1 = await issueSignupTicket(g1);
  ok("T1 a verified Google identity with no account gets a ticket", t1 !== null && t1.secret.length === 43);
  ok("T1 …and NOTHING else: no User, Business, identity or session", same(await footprint(g1.email, biz1, g1.subject), ZERO));
  ok("T1 the database keeps only sha256(secret)",
    (await count(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "secretHash" = $1`, hashTicketSecret(t1!.secret))) === 1
    && (await count(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" t WHERE t::text LIKE '%' || $1 || '%'`, t1!.secret)) === 0);
  const view = await readSignupTicket(t1!.secret);
  ok("the completion form can read the address and name to prefill", view?.email === g1.email && view?.name === g1.name);
  const bearer = await getAuthContext(new Request("http://lab/api/home", { headers: { authorization: `Bearer ${t1!.secret}` } }));
  ok("T3 the ticket secret is not a bearer token (getAuthContext → null)", bearer === null);
  const asRefresh = await refreshSession(authDb(), { credential: t1!.secret, now: new Date() });
  ok("T4 the ticket secret is not a refresh credential", asRefresh.kind === "unauthorized", JSON.stringify(asRefresh));
  ok("a malformed cookie value never reaches the database", (await readSignupTicket("x' OR 1=1 --")) === null);

  console.log("\n— 2. the completed signup —");
  const done = await outcome(completeSignup(t1!.secret, biz1));
  ok("T11 the completion commits on the auth plane", typeof done !== "string", String(done));
  const W = typeof done === "string" ? null : done;
  ok("T11 exactly one User, one Business, one identity, one session", same(await footprint(g1.email, biz1, g1.subject), ONE),
    JSON.stringify(await footprint(g1.email, biz1, g1.subject)));
  const wu = W ? await owner.user.findUnique({ where: { id: W.userId }, select: { password: true, emailVerifiedAt: true } }) : null;
  ok("T11 the user has no password and a verified address", wu?.password === null && wu?.emailVerifiedAt !== null);
  if (W) {
    const token = signAuthToken(W.userId, W.tokenVersion, W.sessionId);
    const ctx = await getAuthContext(new Request("http://lab/api/home", { headers: { authorization: `Bearer ${token}` } }));
    ok("T11 a token for the session the signup opened authenticates as that user and business",
      ctx?.user.id === W.userId && ctx?.user.businessId === W.businessId);
  }
  ok("the spent ticket reads nothing any more", (await readSignupTicket(t1!.secret)) === null);

  console.log("\n— 3. single use through the service (T14 / T33 / T37) —");
  const replay = await outcome(completeSignup(t1!.secret, `${biz1}-replay`));
  ok("T14 replay is refused (SignupTicketRefusedError)", replay === "REFUSED", String(replay));
  ok("T14 …and adds no account, business, identity or session",
    same(await footprint(g1.email, biz1, g1.subject), ONE) && (await count(`SELECT count(*)::int AS c FROM "Business" WHERE name = $1`, `${biz1}-replay`)) === 0);
  ok("a subject already linked is issued no new ticket", (await issueSignupTicket(g1)) === null);

  const g2 = identity("race");
  const biz2 = `agl-app-race-${Date.now()}`;
  const t2 = await issueSignupTicket(g2);
  const raced = await Promise.all(Array.from({ length: 10 }, () => outcome(completeSignup(t2!.secret, biz2, { pause: 0.4 }))));
  const wins = raced.filter((r) => typeof r !== "string");
  ok("T33 ten concurrent completions with one ticket: exactly one succeeds", wins.length === 1,
    raced.map((r) => (typeof r === "string" ? r : "OK")).join(" | "));
  ok("T33 …the other nine are refused at the ticket", raced.filter((r) => r === "REFUSED").length === 9);
  ok("T33 …one User, one Business, one identity, one session", same(await footprint(g2.email, biz2, g2.subject), ONE),
    JSON.stringify(await footprint(g2.email, biz2, g2.subject)));

  const g3 = identity("rollback");
  const biz3 = `agl-app-rb-${Date.now()}`;
  const t3 = await issueSignupTicket(g3);
  const failed = await outcome(completeSignup(t3!.secret, biz3, { failAfterSpend: true }));
  ok("T37 a completion failing after the spend fails", failed === "FORCED_FAILURE", String(failed));
  ok("T37 …leaves nothing and the ticket open", same(await footprint(g3.email, biz3, g3.subject), ZERO) && (await readSignupTicket(t3!.secret)) !== null);
  ok("T37 …one later completion succeeds", typeof (await outcome(completeSignup(t3!.secret, biz3))) !== "string"
    && same(await footprint(g3.email, biz3, g3.subject), ONE));

  console.log("\n— 4. resolve + the Google sign-in policy —");
  const resolved = await resolveGoogleIdentity(g1.subject);
  ok("T15 a linked subject resolves to its account (matched on sub)", resolved?.userId === W?.userId && resolved?.businessId === W?.businessId);
  ok("an unknown subject resolves to nothing", (await resolveGoogleIdentity("nobody-at-all")) === null);
  const candidate = W ? await authDb().user.findUnique({
    where: { id: W.userId },
    select: { role: true, business: { select: { deletionRequestedAt: true, deletedAt: true } } },
  }) : null;
  ok("the linked owner may receive a session", candidate !== null && googleSignInRefusal(candidate) === null);
  ok("T19 a platform admin never signs in with Google (v1)", googleSignInRefusal({ role: UserRole.PLATFORM_ADMIN, business: { deletionRequestedAt: null, deletedAt: null } }) === "PLATFORM_ADMIN");
  ok("T19 a business in deletion gets no session through Google",
    googleSignInRefusal({ role: UserRole.USER, business: { deletionRequestedAt: new Date(), deletedAt: null } }) === "BUSINESS_UNAVAILABLE"
    && googleSignInRefusal({ role: UserRole.USER, business: { deletionRequestedAt: new Date(), deletedAt: new Date() } }) === "BUSINESS_UNAVAILABLE");

  console.log("\n— 5. T32: the password login route —");
  const pwUserBiz = await owner.business.create({ data: { name: `agl-app-pw-${Date.now()}` }, select: { id: true } });
  const pwEmail = `agl-app-pw-${Date.now()}@lab.invalid`;
  await owner.user.create({ data: { email: pwEmail, password: await bcrypt.hash("right-password-1", 10), name: "פ", businessId: pwUserBiz.id } });
  const sessionsBefore = await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, W?.userId ?? -1);
  const noPw = await login(post({ email: g1.email, password: "anything-at-all-1" }, "198.51.100.21"));
  const noPwBody = await noPw.json();
  const wrongPw = await login(post({ email: pwEmail, password: "wrong-password-1" }, "198.51.100.22"));
  const wrongPwBody = await wrongPw.json();
  const unknown = await login(post({ email: `nobody-${Date.now()}@lab.invalid`, password: "anything-at-all-1" }, "198.51.100.23"));
  const unknownBody = await unknown.json();
  ok("T32 an account with no password: 401 INVALID_CREDENTIALS", noPw.status === 401 && noPwBody.code === "INVALID_CREDENTIALS", JSON.stringify(noPwBody));
  ok("T32 …the same answer as a wrong password and an unknown address",
    JSON.stringify(noPwBody) === JSON.stringify(wrongPwBody) && JSON.stringify(noPwBody) === JSON.stringify(unknownBody)
    && wrongPw.status === 401 && unknown.status === 401);
  ok("T32 …and no session was opened for it",
    (await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, W?.userId ?? -1)) === sessionsBefore);
  const right = await login(post({ email: pwEmail, password: "right-password-1" }, "198.51.100.24"));
  const rightBody = await right.json();
  ok("T32 regression: a password account still signs in (200, token, session)", right.status === 200 && typeof rightBody.token === "string" && typeof rightBody.sessionId === "string");

  console.log("\n— 6. purge —");
  const g4 = identity("expired");
  const t4 = await issueSignupTicket(g4);
  await owner.$executeRawUnsafe(`UPDATE "OAuthSignupTicket" SET "issuedAt" = "issuedAt" - interval '40 minutes', "expiresAt" = "expiresAt" - interval '40 minutes' WHERE id = $1::uuid`, t4!.ticketId);
  const g5 = identity("open");
  const t5 = await issueSignupTicket(g5);
  const purged = await purgeExpiredTickets();
  ok("purge removes the expired ticket", purged >= 1 && (await count(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE id = $1::uuid`, t4!.ticketId)) === 0);
  ok("purge keeps the open ticket", (await readSignupTicket(t5!.secret)) !== null);

  console.log(`\n[oauth-identity-app-battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); await authDb().$disconnect(); });
