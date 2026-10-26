/**
 * OAuth identity link — what migration 20261102090000_oauth_identity_link does, measured with the real role
 * topology on a Production-shaped database (20261017090000, 20261030090000, 20261101090000 and this one
 * applied by `prisma migrate deploy`):
 *   owner   (lab_owner: the migration role, owner of the tables and the functions),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane),
 *   auth    (te_auth_login: NOSUPERUSER NOBYPASSRLS, member of app_auth — the signup / login plane).
 *
 * A "link" below is the transaction the application will run, entirely as the auth plane:
 *   spend the LINK ticket → (EMAIL: spend the emailed link bound to it) → link the identity → AuthSession.
 *
 *   1. Catalog and privileges.
 *   2. Issuing the emailed link: only for an open LINK ticket, to the account the ticket's address names;
 *      never for a SIGNUP / cancelled / expired / unknown ticket, an administrator, a business in deletion,
 *      an account already linked, a subject already linked, an address with no account; 3 per ticket,
 *      5 per account and hour; a new one closes the earlier; it never outlives its ticket.
 *   3. Checking it changes nothing: VALID only with the ticket it is bound to; OTHER_BROWSER without it.
 *   4–5. A link by email and by password: one identity, one session, no second account or business.
 *   6. Replay of the ticket and of the emailed link: refused, nothing added.
 *   7. Swaps: a link of another ticket, another account, a SIGNUP ticket on the link path, a LINK ticket on
 *      the signup path, EMAIL proof without a spent link, PASSWORD proof for an account without one.
 *   8. A forged "spent" marker outside the spending transaction: refused.
 *   9. Ten concurrent links with one ticket (email and password mixed): exactly one identity.
 *  10. A failure after every write: nothing left, the ticket and the emailed link open; a later link works.
 *  11. Administrator and business in deletion: refused even with a proof.
 *  12. Status and unlink: unlink only for an account with a password.
 *  13. Cancel, purge, constraints, the old functions refuse a LINK_GOOGLE token, tenant erasure.
 *
 * env: OWNER_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network. Raw SQL only (migration-first).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string, n: number) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=${n}&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });
const authPool = new PrismaClient({ datasourceUrl: withPool(process.env.AUTH_URL!, 12) });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
const TX_OPTS = { timeout: 60_000, maxWait: 60_000 };

async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }, TX_OPTS).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, sql: string, ...args: unknown[]) => inTx(client, null, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) => inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied|42501/i;
const CHECK = /check constraint|23514/i;
const LINK_REFUSED = /not spent in this transaction|not an account this ticket may link|no proof of ownership/i;
const count = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as Rows)[0].c);

const BCRYPT = "$2b$10$" + "A".repeat(53);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");
let seq = 0;
const subject = () => `link-sub-${Date.now()}-${++seq}`;
const address = (tag: string) => `agl-link-${tag}-${Date.now()}-${++seq}@lab.invalid`;

type Account = { userId: number; businessId: number; email: string };
async function account(tag: string, opts: { password?: boolean; admin?: boolean; deleting?: boolean } = {}): Promise<Account> {
  const b = (await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name","updatedAt","deletionRequestedAt") VALUES ($1, now(), $2) RETURNING id`,
    `agl-link-biz-${tag}-${++seq}`, opts.deleting ? new Date() : null)) as Rows;
  const businessId = Number(b[0].id);
  const email = address(tag);
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt","role") VALUES ($1,$2,'דנה',$3, now(), $4::"UserRole") RETURNING id`,
    email, opts.password === false ? null : BCRYPT, businessId, opts.admin ? "PLATFORM_ADMIN" : "USER")) as Rows;
  return { userId: Number(u[0].id), businessId, email };
}

type Ticket = { secret: string; id: string; sub: string };
async function linkTicket(email: string, sub = subject(), purpose = "LINK"): Promise<Ticket> {
  const secret = newSecret();
  const r = await q(auth, `SELECT * FROM public.auth_oauth_ticket_issue($1, 'google', $2, $3, 'דנה', true, $4)`, purpose, sub, email, sha(secret));
  const id = rows(r)[0]?.ticket_id;
  if (typeof id !== "string") throw new Error(`ticket issue failed: ${String(r)}`);
  return { secret, id, sub };
}
type Mail = { tokenId: string; secret: string; userId: number | null; expiresAt: unknown; r: unknown };
async function mailLink(ticketSecret: string | null, client: PrismaClient = auth): Promise<Mail> {
  const tokenId = randomUUID();
  const secret = newSecret();
  const r = await q(client, `SELECT * FROM public.auth_oauth_link_email_issue($1::text, $2::uuid, $3)`, ticketSecret, tokenId, sha(secret));
  const row = rows(r)[0];
  return { tokenId, secret, userId: row ? Number(row.user_id) : null, expiresAt: row?.expires_at, r };
}
const check = async (m: Mail, ticketSecret: string | null) =>
  String(rows(await q(auth, `SELECT public.auth_oauth_link_email_check($1::uuid, $2::text, $3::text) AS s`, m.tokenId, m.secret, ticketSecret))[0]?.s);
const tokenRow = async (id: string) => ((await owner.$queryRawUnsafe(`SELECT * FROM "AuthEmailToken" WHERE id = $1::uuid`, id)) as Rows)[0];
const ticketRow = async (id: string) => ((await owner.$queryRawUnsafe(`SELECT * FROM "OAuthSignupTicket" WHERE id = $1::uuid`, id)) as Rows)[0];
const snapshot = async () => JSON.stringify([
  await owner.$queryRawUnsafe(`SELECT id, "consumedAt", "invalidatedAt" FROM "AuthEmailToken" ORDER BY id`),
  await owner.$queryRawUnsafe(`SELECT id, "endedAt", "consumedByUserId" FROM "OAuthSignupTicket" ORDER BY id`),
  await owner.$queryRawUnsafe(`SELECT id FROM "UserIdentity" ORDER BY id`),
]);

type LinkOpts = { proof: "EMAIL" | "PASSWORD"; mail?: Mail; userId?: number; pause?: number; failAfter?: boolean; client?: PrismaClient; purpose?: string };
type Linked = { identityId: number; userId: number; ticketId: string };
/** The application's link transaction, as the auth plane. Throws (→ message) when refused. */
function link(ticketSecret: string, opts: LinkOpts): Promise<Linked | string> {
  return inTx(opts.client ?? auth, null, async (tx) => {
    const t = (await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, $2)`, ticketSecret, opts.purpose ?? "LINK")) as Rows;
    if (t.length !== 1) throw new Error("TICKET_REFUSED");
    const ticketId = String(t[0].ticket_id);
    let userId: number;
    if (opts.proof === "EMAIL") {
      const m = opts.mail!;
      const c = (await tx.$queryRawUnsafe(`SELECT public.auth_oauth_link_email_consume($1::uuid, $2::text, $3::uuid) AS u`, m.tokenId, m.secret, ticketId)) as Rows;
      if (c[0]?.u === null || c[0]?.u === undefined) throw new Error("EMAIL_LINK_REFUSED");
      userId = Number(c[0].u);
    } else {
      userId = opts.userId!;
    }
    if (opts.pause) await tx.$queryRawUnsafe(`SELECT 1 AS slept FROM pg_sleep(${opts.pause})`);
    const l = (await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_identity_link($1::uuid, $2::int, $3)`, ticketId, userId, opts.proof)) as Rows;
    await tx.$executeRawUnsafe(
      `INSERT INTO "AuthSession" ("id","userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt")
       VALUES ($1::uuid,$2,$3,0,now(),now(),now() + interval '30 days',now() + interval '90 days')`,
      randomUUID(), userId, sha(randomUUID()),
    );
    if (opts.failAfter) throw new Error("FORCED_FAILURE");
    return { identityId: Number(l[0].identity_id), userId, ticketId };
  });
}
type Footprint = { users: number; businesses: number; identities: number; sessions: number };
async function footprint(a: Account): Promise<Footprint> {
  return {
    users: await count(`SELECT count(*)::int AS c FROM "User" WHERE email = $1`, a.email),
    businesses: await count(`SELECT count(*)::int AS c FROM "User" u WHERE u."businessId" = $1`, a.businessId),
    identities: await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "userId" = $1`, a.userId),
    sessions: await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1`, a.userId),
  };
}
const same = (a: Footprint, b: Footprint) => JSON.stringify(a) === JSON.stringify(b);
const UNLINKED: Footprint = { users: 1, businesses: 1, identities: 0, sessions: 0 };
const LINKED: Footprint = { users: 1, businesses: 1, identities: 1, sessions: 1 };

async function main() {
  console.log("\n— 1. catalog and privileges —");
  const fns = (await owner.$queryRawUnsafe(
    `SELECT p.proname, p.prosecdef, p.proconfig,
            has_function_privilege('app_auth', p.oid, 'EXECUTE') AS a, has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS r,
            (SELECT count(*)::int FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS pub
       FROM pg_proc p WHERE p.proname IN ('auth_oauth_link_email_issue','auth_oauth_link_email_check','auth_oauth_link_email_consume',
                                          'auth_oauth_identity_link','auth_oauth_identity_status','auth_oauth_identity_unlink')`)) as Rows;
  ok("the six functions exist, SECURITY DEFINER, search_path pinned", fns.length === 6
    && fns.every((f) => f.prosecdef === true && (f.proconfig as string[]).includes("search_path=pg_catalog, public")));
  ok("app_auth executes all six; app_runtime none; PUBLIC holds nothing", fns.every((f) => f.a === true && f.r === false && f.pub === 0));
  const pA = await account("priv");
  ok("the tenant plane cannot call them", refused(await q(runtime, `SELECT * FROM public.auth_oauth_identity_status($1)`, pA.userId), DENIED));
  ok("the auth plane still cannot read AuthEmailToken", refused(await q(auth, `SELECT id FROM "AuthEmailToken"`), DENIED));
  ok("the tenant plane cannot read the new column", refused(await inTx(runtime, pA.businessId, (tx) => tx.$queryRawUnsafe(`SELECT "oauthTicketId" FROM "AuthEmailToken"`)), DENIED));

  console.log("\n— 2. issuing the emailed link —");
  const a2 = await account("issue");
  const t2 = await linkTicket(a2.email);
  const m2 = await mailLink(t2.secret);
  ok("an open LINK ticket → a link for the account its address names (resolved in the database)", m2.userId === a2.userId);
  const r2 = await tokenRow(m2.tokenId);
  ok("…purpose LINK_GOOGLE, bound to that ticket, sent to the account's address, hash only", r2.purpose === "LINK_GOOGLE" && r2.oauthTicketId === t2.id
    && r2.email === a2.email && r2.tokenHash === sha(m2.secret));
  ok("…it never outlives its ticket", new Date(String(r2.expiresAt)).getTime() <= new Date(String((await ticketRow(t2.id)).expiresAt)).getTime());
  const sSignup = await linkTicket(address("nobody"), subject(), "SIGNUP");
  ok("a SIGNUP ticket → nothing", (await mailLink(sSignup.secret)).userId === null);
  ok("an unknown ticket / no ticket → nothing", (await mailLink(newSecret())).userId === null && (await mailLink(null)).userId === null);
  const noAccount = await linkTicket(address("ghost"));
  ok("an address with no account → nothing", (await mailLink(noAccount.secret)).userId === null);
  const adm = await account("admin", { admin: true });
  ok("a platform administrator → nothing", (await mailLink((await linkTicket(adm.email)).secret)).userId === null);
  const del = await account("deleting", { deleting: true });
  ok("a business in deletion → nothing", (await mailLink((await linkTicket(del.email)).secret)).userId === null);
  const m2b = await mailLink(t2.secret);
  ok("a second request closes the first (SUPERSEDED)", m2b.userId === a2.userId && (await tokenRow(m2.tokenId)).invalidatedAt !== null);
  const m2c = await mailLink(t2.secret);
  ok("…at most 3 per ticket", m2c.userId === a2.userId && (await mailLink(t2.secret)).userId === null);
  const a2h = await account("hourly");
  let issued = 0;
  for (let i = 0; i < 6; i += 1) {
    const tt = await linkTicket(a2h.email);
    if ((await mailLink(tt.secret)).userId !== null) issued += 1;
  }
  ok("…at most 5 per account and hour, across tickets", issued === 5, String(issued));

  console.log("\n— 3. checking changes nothing —");
  const before3 = await snapshot();
  ok("VALID with the ticket it is bound to", (await check(m2c, t2.secret)) === "VALID");
  ok("OTHER_BROWSER without that ticket (another device, a scanner)", (await check(m2c, null)) === "OTHER_BROWSER" && (await check(m2c, newSecret())) === "OTHER_BROWSER");
  ok("SUPERSEDED for the closed one; INVALID for a wrong secret", (await check(m2, t2.secret)) === "SUPERSEDED"
    && (await check({ ...m2c, secret: newSecret() }, t2.secret)) === "INVALID");
  ok("…and not one row changed", (await snapshot()) === before3);

  console.log("\n— 4. a link by email —");
  const done4 = await link(t2.secret, { proof: "EMAIL", mail: m2c });
  ok("one identity for THIS account and THIS Google subject", typeof done4 !== "string" && done4.userId === a2.userId
    && (await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "userId" = $1 AND "providerSubject" = $2`, a2.userId, t2.sub)) === 1, String(done4));
  ok("…one session, no second account or business", same(await footprint(a2), LINKED));
  const tk4 = await ticketRow(t2.id);
  ok("…the ticket CONSUMED and naming the account; the link consumed", tk4.endedReason === "CONSUMED" && Number(tk4.consumedByUserId) === a2.userId
    && (await tokenRow(m2c.tokenId)).consumedAt !== null);
  ok("…the address now verified", ((await owner.$queryRawUnsafe(`SELECT "emailVerifiedAt" FROM "User" WHERE id = $1`, a2.userId)) as Rows)[0].emailVerifiedAt !== null);
  ok("…USED for the emailed link afterwards", (await check(m2c, t2.secret)) === "USED");

  console.log("\n— 5. a link by password —");
  const a5 = await account("password");
  const t5 = await linkTicket(a5.email);
  const done5 = await link(t5.secret, { proof: "PASSWORD", userId: a5.userId });
  ok("PASSWORD proof (compared by the application) → one identity, one session", typeof done5 !== "string" && same(await footprint(a5), LINKED), String(done5));

  console.log("\n— 6. replay —");
  const before6 = await snapshot();
  ok("the spent ticket → refused", (await link(t5.secret, { proof: "PASSWORD", userId: a5.userId })) === "TICKET_REFUSED");
  ok("the spent emailed link → refused", (await link(t2.secret, { proof: "EMAIL", mail: m2c })) === "TICKET_REFUSED");
  ok("…nothing added", (await snapshot()) === before6 && same(await footprint(a5), LINKED));

  console.log("\n— 7. swaps —");
  const a7 = await account("swapA"); const b7 = await account("swapB");
  const t7a = await linkTicket(a7.email); const t7b = await linkTicket(b7.email);
  const m7a = await mailLink(t7a.secret);
  ok("an emailed link of ticket A with ticket B spent → refused", (await link(t7b.secret, { proof: "EMAIL", mail: m7a })) === "EMAIL_LINK_REFUSED");
  ok("ticket B's link to ANOTHER account (A) by password → refused", refused(await link(t7b.secret, { proof: "PASSWORD", userId: a7.userId }), LINK_REFUSED));
  const t7c = await linkTicket(b7.email);
  const noMail = await inTx(auth, null, async (tx) => {
    const t = (await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, 'LINK')`, t7c.secret)) as Rows;
    return tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_identity_link($1::uuid, $2::int, 'EMAIL')`, t[0].ticket_id, b7.userId);
  });
  ok("EMAIL proof with no emailed link spent in the transaction → refused", refused(noMail, LINK_REFUSED), String(noMail));
  const nopw = await account("nopassword", { password: false });
  ok("PASSWORD proof for an account without a password → refused", refused(await link((await linkTicket(nopw.email)).secret, { proof: "PASSWORD", userId: nopw.userId }), LINK_REFUSED));
  const sig = await linkTicket(a7.email, subject(), "SIGNUP");
  ok("a SIGNUP ticket on the link path → refused", refused(await link(sig.secret, { proof: "PASSWORD", userId: a7.userId, purpose: "SIGNUP" }), LINK_REFUSED));
  const viaAttach = await inTx(auth, null, async (tx) => {
    const t = (await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, 'LINK')`, t7a.secret)) as Rows;
    return tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_identity_attach($1::uuid, $2::int)`, t[0].ticket_id, a7.userId);
  });
  ok("a LINK ticket on the signup path (attach) → refused", refused(viaAttach, /not spent in this transaction|not the account this signup created/i), String(viaAttach));
  ok("…none of it linked anything", same(await footprint(a7), UNLINKED) && same(await footprint(b7), UNLINKED));

  console.log("\n— 8. a forged spent marker —");
  const a8 = await account("forge");
  const t8 = await linkTicket(a8.email);
  const forged = await inTx(auth, null, async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.oauth_ticket_spent', $1, true)`, t8.id);
    return tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_identity_link($1::uuid, $2::int, 'PASSWORD')`, t8.id, a8.userId);
  });
  ok("setting the marker by hand, without spending the ticket → refused", refused(forged, LINK_REFUSED) && same(await footprint(a8), UNLINKED));

  console.log("\n— 9. ten concurrent links, one ticket —");
  const a9 = await account("race");
  const t9 = await linkTicket(a9.email);
  const m9 = await mailLink(t9.secret);
  const raced = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    link(t9.secret, i % 2 ? { proof: "PASSWORD", userId: a9.userId, pause: 0.3, client: authPool } : { proof: "EMAIL", mail: m9, pause: 0.3, client: authPool })));
  ok("exactly one link, nine refusals", raced.filter((r) => typeof r !== "string").length === 1, raced.map((r) => (typeof r === "string" ? r : "OK")).join(","));
  ok("…one identity, one session", same(await footprint(a9), LINKED));

  console.log("\n— 10. a failure after every write —");
  const a10 = await account("rollback");
  const t10 = await linkTicket(a10.email);
  const m10 = await mailLink(t10.secret);
  ok("the link fails after the identity and the session were written", (await link(t10.secret, { proof: "EMAIL", mail: m10, failAfter: true })) === "FORCED_FAILURE");
  ok("…nothing left: no identity, no session; the ticket and the emailed link open", same(await footprint(a10), UNLINKED)
    && (await ticketRow(t10.id)).endedAt === null && (await tokenRow(m10.tokenId)).consumedAt === null && (await check(m10, t10.secret)) === "VALID");
  ok("…a later link succeeds, once", typeof (await link(t10.secret, { proof: "EMAIL", mail: m10 })) !== "string" && same(await footprint(a10), LINKED));

  console.log("\n— 11. administrator and business in deletion —");
  const tAdm = await linkTicket(adm.email);
  ok("an administrator, with a PASSWORD proof → refused", refused(await link(tAdm.secret, { proof: "PASSWORD", userId: adm.userId }), LINK_REFUSED));
  const tDel = await linkTicket(del.email);
  ok("a business in deletion, with a PASSWORD proof → refused", refused(await link(tDel.secret, { proof: "PASSWORD", userId: del.userId }), LINK_REFUSED));
  ok("…no identity and no session for either", (await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "userId" IN ($1, $2)`, adm.userId, del.userId)) === 0
    && (await count(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" IN ($1, $2)`, adm.userId, del.userId)) === 0);
  const tAgain = await linkTicket(a2.email);
  ok("an account already linked to Google: no emailed link, and no second link", (await mailLink(tAgain.secret)).userId === null
    && refused(await link(tAgain.secret, { proof: "PASSWORD", userId: a2.userId }), LINK_REFUSED));
  const other = await account("other");
  const tTaken = await linkTicket(other.email, t5.sub);
  ok("a Google subject already linked to another account: no emailed link, and no link", (await mailLink(tTaken.secret)).userId === null
    && typeof (await link(tTaken.secret, { proof: "PASSWORD", userId: other.userId })) === "string" && same(await footprint(other), UNLINKED));

  console.log("\n— 12. status and unlink —");
  const st = rows(await q(auth, `SELECT * FROM public.auth_oauth_identity_status($1)`, a5.userId))[0];
  ok("status: linked, the address at link, a password", st?.linked === true && st?.email_at_link === a5.email && st?.has_password === true);
  const stNone = rows(await q(auth, `SELECT * FROM public.auth_oauth_identity_status($1)`, other.userId))[0];
  ok("status of an unlinked account: not linked", stNone?.linked === false && stNone?.email_at_link === null);
  const un = rows(await q(auth, `SELECT * FROM public.auth_oauth_identity_unlink($1)`, a5.userId));
  ok("unlink with a password → the identity removed", un.length === 1 && (await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "userId" = $1`, a5.userId)) === 0);
  ok("…a second unlink → nothing", rows(await q(auth, `SELECT * FROM public.auth_oauth_identity_unlink($1)`, a5.userId)).length === 0);
  // An account opened with Google: linked, no password.
  const g = await account("google-made", { password: false });
  await owner.$executeRawUnsafe(`INSERT INTO "UserIdentity" ("userId","businessId","provider","providerSubject","emailAtLink","linkedAt") VALUES ($1,$2,'google',$3,$4,now())`,
    g.userId, g.businessId, subject(), g.email);
  ok("unlink for an account WITHOUT a password → nothing removed (it could not sign in)", rows(await q(auth, `SELECT * FROM public.auth_oauth_identity_unlink($1)`, g.userId)).length === 0
    && (await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "userId" = $1`, g.userId)) === 1);

  console.log("\n— 13. cancel, purge, constraints, old functions, erasure —");
  const a13 = await account("cancel");
  const t13 = await linkTicket(a13.email);
  const m13 = await mailLink(t13.secret);
  ok("the server-side cancel ends a LINK ticket", String(rows(await q(auth, `SELECT public.auth_oauth_ticket_cancel($1, 'LINK') AS o`, t13.secret))[0]?.o) === "CANCELLED");
  ok("…its emailed link then reports TICKET_ENDED, cannot be re-issued, cannot link", (await check(m13, t13.secret)) === "TICKET_ENDED"
    && (await mailLink(t13.secret)).userId === null && (await link(t13.secret, { proof: "EMAIL", mail: m13 })) === "TICKET_REFUSED");
  await owner.$executeRawUnsafe(`UPDATE "OAuthSignupTicket" SET "issuedAt" = timezone('UTC', now()) - interval '40 minutes', "expiresAt" = timezone('UTC', now()) - interval '10 minutes' WHERE id = $1::uuid`, t13.id);
  const purged = Number(rows(await q(auth, `SELECT public.auth_oauth_ticket_purge() AS n`))[0]?.n);
  ok("the purge removes the expired ticket and, with it, its emailed link (cascade)", purged >= 1 && (await tokenRow(m13.tokenId)) === undefined);
  const base = `"id","userId","businessId","purpose","email","tokenHash","createdAt","expiresAt"`;
  ok("a LINK_GOOGLE token without a ticket → refused", refused(await x(owner, null,
    `INSERT INTO "AuthEmailToken" (${base}) VALUES ($1::uuid,$2,$3,'LINK_GOOGLE',$4,$5,now(),now() + interval '5 minutes')`,
    randomUUID(), a13.userId, a13.businessId, a13.email, sha(randomUUID())), CHECK));
  const t13b = await linkTicket(a13.email);
  ok("an EMAIL_VERIFY token bound to a ticket → refused", refused(await x(owner, null,
    `INSERT INTO "AuthEmailToken" (${base},"oauthTicketId") VALUES ($1::uuid,$2,$3,'EMAIL_VERIFY',$4,$5,now(),now() + interval '5 minutes',$6::uuid)`,
    randomUUID(), a13.userId, a13.businessId, a13.email, sha(randomUUID()), t13b.id), CHECK));
  const m13b = await mailLink(t13b.secret);
  ok("the email-token functions refuse a LINK_GOOGLE token", String(rows(await q(auth, `SELECT public.auth_email_token_check($1::uuid, $2, 'PASSWORD_RESET') AS s`, m13b.tokenId, m13b.secret))[0]?.s) === "INVALID"
    && String(rows(await q(auth, `SELECT status FROM public.auth_email_verify_consume($1::uuid, $2)`, m13b.tokenId, m13b.secret))[0]?.status) === "INVALID");
  ok("tenant erasure: another business cannot remove the token", (await x(runtime, other.businessId, `DELETE FROM "AuthEmailToken" WHERE id = $1::uuid`, m13b.tokenId)) === 0);
  ok("tenant erasure: its own business removes it", (await x(runtime, a13.businessId, `DELETE FROM "AuthEmailToken" WHERE id = $1::uuid`, m13b.tokenId)) === 1);

  console.log(`\n[oauth-identity-link-battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect(), authPool.$disconnect()]); });
