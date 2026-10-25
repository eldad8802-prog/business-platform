/**
 * OAuth signup ticket cancel — what migration 20261101090000_oauth_ticket_cancel does, measured with the real
 * role topology on a Production-shaped database (both oauth migrations applied by `prisma migrate deploy`):
 *   owner   (lab_owner: the migration role, owner of the table and the functions),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane),
 *   auth    (te_auth_login: NOSUPERUSER NOBYPASSRLS, member of app_auth — the signup / login plane).
 *
 * A "Google signup" below is the transaction the application runs, as the auth plane:
 *   spend the ticket → Business → User (no password) → attach the identity → AuthSession.
 *
 *   1. Catalog and privileges: SECURITY DEFINER, search_path pinned; the auth plane executes it and still
 *      holds nothing on the table; the tenant plane and PUBLIC cannot execute it.
 *   2. Cancel, then a signup with a COPY of the secret: refused, nothing created; the form reads nothing.
 *   3. A second cancel (and five at once): safe — exactly one CANCELLED, the row unchanged afterwards.
 *   4. A wrong secret, a tampered one, a wrong purpose, a malformed or unknown purpose: NOT_FOUND, no row
 *      changes anywhere.
 *   5. Expired, superseded, completed: reported, nothing changes; the completed account is untouched.
 *   6. Race, cancel first: the cancel holds the row; a concurrent signup waits, then is refused.
 *   7. Race, completion first: the signup holds the row; a concurrent cancel waits, then answers COMPLETED
 *      and changes nothing — the account stays whole.
 *   8. Race, completion rolled back: the waiting cancel then ends the ticket; no account.
 *   9. A new sign-in after a cancel: a fresh ticket opens and completes; the cancelled one stays ended.
 *  10. Purge: a cancelled ticket stays until its expiry, then the sweep removes it; open ones stay.
 *  11. Constraints: CANCELLED is a known end reason; an unknown one is still refused; a CANCELLED ticket
 *      never names a user.
 *
 * env: OWNER_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network. Raw SQL only (migration-first: the
 * generated client knows nothing of the function).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string, n: number) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=${n}&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });
// Separate real connections, so a held transaction and the statement racing it run in different sessions.
const authPool = new PrismaClient({ datasourceUrl: withPool(process.env.AUTH_URL!, 8) });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
const TX_OPTS = { timeout: 60_000, maxWait: 60_000 };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function inTx<T>(client: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(fn, TX_OPTS).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, sql: string, ...args: unknown[]) => inTx(client, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, sql: string, ...args: unknown[]) => inTx(client, (tx) => tx.$executeRawUnsafe(sql, ...args));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied|42501/i;
const CHECK = /check constraint|23514/i;
const count = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as Rows)[0].c);

const TICKETS = `"OAuthSignupTicket"`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");
let seq = 0;
const subject = () => `cancel-sub-${Date.now()}-${++seq}`;
const address = (tag: string) => `agl-cancel-${tag}-${Date.now()}-${++seq}@lab.invalid`;

type Ticket = { secret: string; id: string };
async function issue(sub: string, email: string, purpose = "SIGNUP"): Promise<Ticket> {
  const secret = newSecret();
  const r = await q(auth, `SELECT * FROM public.auth_oauth_ticket_issue($1, 'google', $2, $3, 'דנה כהן', true, $4)`, purpose, sub, email, sha(secret));
  const id = rows(r)[0]?.ticket_id;
  if (typeof id !== "string") throw new Error(`issue failed: ${String(r)}`);
  return { secret, id };
}
const cancel = async (secret: string | null, purpose: string | null = "SIGNUP", client: PrismaClient = auth) => {
  const r = await q(client, `SELECT public.auth_oauth_ticket_cancel($1::text, $2::text) AS o`, secret, purpose);
  return typeof r === "string" ? r : String(rows(r)[0]?.o);
};
const read = async (secret: string) => rows(await q(auth, `SELECT * FROM public.auth_oauth_ticket_read($1, 'SIGNUP')`, secret));
const ticketRow = async (id: string) => ((await owner.$queryRawUnsafe(`SELECT * FROM ${TICKETS} WHERE id = $1::uuid`, id)) as Rows)[0];
const snapshot = async () => JSON.stringify(await owner.$queryRawUnsafe(`SELECT id, "endedAt", "endedReason", "consumedByUserId" FROM ${TICKETS} ORDER BY id`));

type SignupOpts = { pause?: number; failAfterSpend?: boolean; client?: PrismaClient };
type SignupResult = { userId: number; businessId: number; identityId: number };
/** The application's Google-signup transaction, as the auth plane. Throws (→ message) when refused. */
function googleSignup(secret: string, businessName: string, opts: SignupOpts = {}): Promise<SignupResult | string> {
  return inTx(opts.client ?? auth, async (tx) => {
    const t = (await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, 'SIGNUP')`, secret)) as Rows;
    if (t.length !== 1) throw new Error("TICKET_REFUSED");
    // pg_sleep returns void, which the raw-query decoder cannot read: select a value beside it.
    if (opts.pause) await tx.$queryRawUnsafe(`SELECT 1 AS slept FROM pg_sleep(${opts.pause})`);
    const b = (await tx.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, businessName)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await tx.$queryRawUnsafe(
      `INSERT INTO "User" ("email","name","businessId","updatedAt") VALUES ($1,$2,$3, now()) RETURNING id`,
      t[0].email, t[0].name ?? "x", businessId,
    )) as Rows;
    const userId = Number(u[0].id);
    if (opts.failAfterSpend) throw new Error("FORCED_FAILURE");
    const a = (await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_identity_attach($1::uuid, $2::int)`, t[0].ticket_id, userId)) as Rows;
    await tx.$executeRawUnsafe(
      `INSERT INTO "AuthSession" ("id","userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt")
       VALUES ($1::uuid,$2,$3,0,now(),now(),now() + interval '30 days',now() + interval '90 days')`,
      randomUUID(), userId, sha(randomUUID()),
    );
    return { userId, businessId, identityId: Number(a[0].identity_id) };
  });
}
type Footprint = { users: number; businesses: number; identities: number; sessions: number };
async function footprint(email: string, businessName: string, sub: string): Promise<Footprint> {
  return {
    users: await count(`SELECT count(*)::int AS c FROM "User" WHERE email = $1`, email),
    businesses: await count(`SELECT count(*)::int AS c FROM "Business" WHERE name = $1`, businessName),
    identities: await count(`SELECT count(*)::int AS c FROM "UserIdentity" WHERE "providerSubject" = $1`, sub),
    sessions: await count(`SELECT count(*)::int AS c FROM "AuthSession" s JOIN "User" u ON u.id = s."userId" WHERE u.email = $1`, email),
  };
}
const same = (a: Footprint, b: Footprint) => JSON.stringify(a) === JSON.stringify(b);
const NONE: Footprint = { users: 0, businesses: 0, identities: 0, sessions: 0 };
const ONE: Footprint = { users: 1, businesses: 1, identities: 1, sessions: 1 };

async function main() {
  console.log("\n— 1. catalog and privileges —");
  const fn = ((await owner.$queryRawUnsafe(
    `SELECT p.prosecdef, p.proconfig, pg_get_function_identity_arguments(p.oid) AS args, p.prorettype::regtype::text AS ret,
            (SELECT count(*)::int FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_grants,
            has_function_privilege('app_auth', p.oid, 'EXECUTE') AS auth_exec,
            has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS runtime_exec
       FROM pg_proc p WHERE p.proname = 'auth_oauth_ticket_cancel'`)) as Rows);
  ok("exactly one auth_oauth_ticket_cancel(text, text) returning text", fn.length === 1 && fn[0].args === "p_secret text, p_purpose text" && fn[0].ret === "text");
  ok("SECURITY DEFINER with search_path pinned to pg_catalog, public", fn[0]?.prosecdef === true
    && Array.isArray(fn[0]?.proconfig) && (fn[0].proconfig as string[]).includes("search_path=pg_catalog, public"));
  ok("app_auth may execute it; app_runtime may not; PUBLIC holds nothing", fn[0]?.auth_exec === true && fn[0]?.runtime_exec === false && fn[0]?.public_grants === 0);
  const s1 = subject();
  const t1 = await issue(s1, address("priv"));
  ok("the tenant plane cannot call it", refused(await q(runtime, `SELECT public.auth_oauth_ticket_cancel($1, 'SIGNUP') AS o`, t1.secret), DENIED));
  ok("the auth plane still cannot read the table", refused(await q(auth, `SELECT id FROM ${TICKETS}`), DENIED));
  ok("the auth plane still cannot end a ticket directly", refused(await x(auth, `UPDATE ${TICKETS} SET "endedAt" = now(), "endedReason" = 'CANCELLED'`), DENIED));
  ok("the tenant plane still cannot read the table", refused(await q(runtime, `SELECT id FROM ${TICKETS}`), DENIED));
  ok("…and the ticket is still open after all of that", (await ticketRow(t1.id)).endedAt === null);

  console.log("\n— 2. cancel, then a signup with a copy of the secret —");
  const s2 = subject(); const e2 = address("copy"); const b2 = `agl-cancel-biz-${seq}`;
  const t2 = await issue(s2, e2);
  const copy = t2.secret;
  ok("cancel → CANCELLED", (await cancel(t2.secret)) === "CANCELLED");
  const r2 = await ticketRow(t2.id);
  ok("…the row is ended CANCELLED, names no user", r2.endedReason === "CANCELLED" && r2.endedAt !== null && r2.consumedByUserId === null);
  ok("…the completion form reads nothing for it", (await read(copy)).length === 0);
  ok("a signup with the COPY of the secret is refused", (await googleSignup(copy, b2)) === "TICKET_REFUSED");
  ok("…nothing was created", same(await footprint(e2, b2, s2), NONE));
  ok("the table never holds the secret, only its sha256", r2.secretHash === sha(copy)
    && (await count(`SELECT count(*)::int AS c FROM ${TICKETS} t WHERE position($1 in row_to_json(t)::text) > 0`, copy)) === 0);

  console.log("\n— 3. a second cancel; five at once —");
  const endedAt = String((await ticketRow(t2.id)).endedAt);
  ok("a second cancel → ALREADY_CANCELLED", (await cancel(copy)) === "ALREADY_CANCELLED");
  ok("…the row is unchanged (same end instant, same reason)", String((await ticketRow(t2.id)).endedAt) === endedAt && (await ticketRow(t2.id)).endedReason === "CANCELLED");
  const t3 = await issue(subject(), address("five"));
  const five = await Promise.all(Array.from({ length: 5 }, () => cancel(t3.secret, "SIGNUP", authPool)));
  ok("five concurrent cancels: exactly one CANCELLED, four ALREADY_CANCELLED",
    five.filter((o) => o === "CANCELLED").length === 1 && five.filter((o) => o === "ALREADY_CANCELLED").length === 4, five.join(","));

  console.log("\n— 4. wrong secret, wrong purpose, malformed —");
  const s4 = subject();
  const t4 = await issue(s4, address("wrong"));
  const tl = await issue(s4, address("link"), "LINK");
  const before4 = await snapshot();
  const tampered = (t4.secret[0] === "A" ? "B" : "A") + t4.secret.slice(1);
  ok("an unknown secret → NOT_FOUND", (await cancel(newSecret())) === "NOT_FOUND");
  ok("a tampered secret → NOT_FOUND", (await cancel(tampered)) === "NOT_FOUND");
  ok("a SIGNUP ticket cancelled as LINK → NOT_FOUND", (await cancel(t4.secret, "LINK")) === "NOT_FOUND");
  ok("a LINK ticket cancelled as SIGNUP → NOT_FOUND", (await cancel(tl.secret, "SIGNUP")) === "NOT_FOUND");
  ok("an unknown purpose → NOT_FOUND", (await cancel(t4.secret, "LOGIN")) === "NOT_FOUND");
  ok("a NULL secret / NULL purpose / an oversized secret → NOT_FOUND",
    (await cancel(null)) === "NOT_FOUND" && (await cancel(t4.secret, null)) === "NOT_FOUND" && (await cancel("x".repeat(500))) === "NOT_FOUND");
  ok("…and not one row changed anywhere", (await snapshot()) === before4);
  ok("…the SIGNUP ticket still reads, and still completes", (await read(t4.secret)).length === 1);

  console.log("\n— 5. expired, superseded, completed —");
  const t5e = await issue(subject(), address("expired"));
  await owner.$executeRawUnsafe(`UPDATE ${TICKETS} SET "issuedAt" = timezone('UTC', now()) - interval '40 minutes', "expiresAt" = timezone('UTC', now()) - interval '10 minutes' WHERE id = $1::uuid`, t5e.id);
  ok("an expired ticket → EXPIRED", (await cancel(t5e.secret)) === "EXPIRED");
  ok("…unchanged (still not ended; the sweep removes it)", (await ticketRow(t5e.id)).endedAt === null);
  const s5s = subject(); const e5s = address("sup");
  const old = await issue(s5s, e5s);
  const fresh = await issue(s5s, e5s);
  ok("a superseded ticket → SUPERSEDED", (await cancel(old.secret)) === "SUPERSEDED");
  ok("…unchanged, and the newer one is still open", (await ticketRow(old.id)).endedReason === "SUPERSEDED" && (await ticketRow(fresh.id)).endedAt === null);
  const s5c = subject(); const e5c = address("done"); const b5c = `agl-cancel-done-${seq}`;
  const t5c = await issue(s5c, e5c);
  const done = await googleSignup(t5c.secret, b5c);
  ok("a completed signup", typeof done !== "string");
  const beforeDone = await snapshot();
  ok("cancel after completion → COMPLETED", (await cancel(t5c.secret)) === "COMPLETED");
  const r5c = await ticketRow(t5c.id);
  ok("…the ticket is unchanged (CONSUMED, still names its user)", r5c.endedReason === "CONSUMED" && typeof done !== "string" && Number(r5c.consumedByUserId) === done.userId
    && (await snapshot()) === beforeDone);
  ok("…the account is whole: one user, business, identity, session", same(await footprint(e5c, b5c, s5c), ONE));

  console.log("\n— 6. race, cancel first —");
  const s6 = subject(); const e6 = address("race-cancel"); const b6 = `agl-cancel-race1-${seq}`;
  const t6 = await issue(s6, e6);
  const held6 = inTx(authPool, async (tx) => {
    const r = (await tx.$queryRawUnsafe(`SELECT public.auth_oauth_ticket_cancel($1, 'SIGNUP') AS o`, t6.secret)) as Rows;
    await tx.$queryRawUnsafe(`SELECT 1 AS slept FROM pg_sleep(1.2)`);
    return String(r[0].o);
  });
  await delay(300);
  const t0 = Date.now();
  const signup6 = await googleSignup(t6.secret, b6, { client: authPool });
  const waited6 = Date.now() - t0;
  ok("the cancel won → CANCELLED", (await held6) === "CANCELLED");
  ok("the signup waited on the row and was then refused", signup6 === "TICKET_REFUSED" && waited6 >= 500, `${String(signup6)} after ${waited6} ms`);
  ok("…no account, business, identity or session", same(await footprint(e6, b6, s6), NONE));

  console.log("\n— 7. race, completion first —");
  const s7 = subject(); const e7 = address("race-done"); const b7 = `agl-cancel-race2-${seq}`;
  const t7 = await issue(s7, e7);
  const signup7 = googleSignup(t7.secret, b7, { pause: 1.2, client: authPool });
  await delay(300);
  const t7start = Date.now();
  const cancel7 = await cancel(t7.secret, "SIGNUP", authPool);
  const waited7 = Date.now() - t7start;
  const done7 = await signup7;
  ok("the signup won and committed", typeof done7 !== "string");
  ok("the cancel waited on the row and then answered COMPLETED", cancel7 === "COMPLETED" && waited7 >= 500, `${cancel7} after ${waited7} ms`);
  const r7 = await ticketRow(t7.id);
  ok("…the ticket stays CONSUMED and names the new user", r7.endedReason === "CONSUMED" && typeof done7 !== "string" && Number(r7.consumedByUserId) === done7.userId);
  ok("…the account is whole and untouched", same(await footprint(e7, b7, s7), ONE));

  console.log("\n— 8. race, completion rolled back —");
  const s8 = subject(); const e8 = address("race-rb"); const b8 = `agl-cancel-race3-${seq}`;
  const t8 = await issue(s8, e8);
  const signup8 = googleSignup(t8.secret, b8, { pause: 1.2, failAfterSpend: true, client: authPool });
  await delay(300);
  const cancel8 = await cancel(t8.secret, "SIGNUP", authPool);
  ok("the signup failed after the spend (rolled back)", (await signup8) === "FORCED_FAILURE");
  ok("the waiting cancel then ended the ticket → CANCELLED", cancel8 === "CANCELLED" && (await ticketRow(t8.id)).endedReason === "CANCELLED");
  ok("…no account; a later signup with the secret is refused", same(await footprint(e8, b8, s8), NONE) && (await googleSignup(t8.secret, b8)) === "TICKET_REFUSED");

  console.log("\n— 9. a new sign-in after a cancel —");
  const again = await issue(s2, e2);
  ok("the same Google subject gets a fresh, open ticket", (await read(again.secret)).length === 1);
  ok("…the cancelled one stays CANCELLED (supersede touches only open tickets)", (await ticketRow(t2.id)).endedReason === "CANCELLED");
  const done9 = await googleSignup(again.secret, b2);
  ok("…the fresh ticket completes, once", typeof done9 !== "string" && same(await footprint(e2, b2, s2), ONE));

  console.log("\n— 10. purge —");
  ok("a cancelled ticket stays until its expiry", (await count(`SELECT count(*)::int AS c FROM ${TICKETS} WHERE id = $1::uuid`, t3.id)) === 1);
  await owner.$executeRawUnsafe(`UPDATE ${TICKETS} SET "issuedAt" = timezone('UTC', now()) - interval '40 minutes', "expiresAt" = timezone('UTC', now()) - interval '10 minutes' WHERE id = $1::uuid`, t3.id);
  const expired = await count(`SELECT count(*)::int AS c FROM ${TICKETS} WHERE "expiresAt" <= timezone('UTC', now())`);
  const live = await count(`SELECT count(*)::int AS c FROM ${TICKETS} WHERE "expiresAt" > timezone('UTC', now())`);
  const purged = Number(rows(await q(auth, `SELECT public.auth_oauth_ticket_purge() AS n`))[0]?.n);
  ok("purge removes exactly the expired tickets (the cancelled one among them)", purged === expired && expired >= 2
    && (await count(`SELECT count(*)::int AS c FROM ${TICKETS} WHERE id = $1::uuid`, t3.id)) === 0, `${purged} vs ${expired}`);
  ok("…and keeps every live one, cancelled or open", (await count(`SELECT count(*)::int AS c FROM ${TICKETS}`)) === live
    && (await count(`SELECT count(*)::int AS c FROM ${TICKETS} WHERE id = $1::uuid`, t6.id)) === 1);

  console.log("\n— 11. constraints —");
  const BASE = `"id","purpose","provider","providerSubject","email","emailVerified","secretHash","issuedAt","expiresAt","endedAt","endedReason"`;
  const row = (reason: string, extra = "", extraCol = "") => x(owner,
    `INSERT INTO ${TICKETS} (${BASE}${extraCol}) VALUES ('${randomUUID()}','SIGNUP','google','s','a@b.c',true,'${sha(randomUUID())}',now(),now() + interval '5 minutes',now(),'${reason}'${extra})`);
  ok("CANCELLED is a known end reason", (await row("CANCELLED")) === 1);
  ok("an unknown reason is still refused", refused(await row("REVOKED"), CHECK));
  ok("a CANCELLED ticket never names a user", typeof done !== "string" && refused(await row("CANCELLED", `,${done.userId}`, `,"consumedByUserId"`), CHECK));
  ok("an end still needs a reason, and a reason an end", refused(await x(owner,
    `INSERT INTO ${TICKETS} ("id","purpose","provider","providerSubject","email","emailVerified","secretHash","issuedAt","expiresAt","endedReason")
     VALUES ('${randomUUID()}','SIGNUP','google','s','a@b.c',true,'${sha(randomUUID())}',now(),now() + interval '5 minutes','CANCELLED')`), CHECK));

  console.log(`\n[oauth-ticket-cancel-battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect(), authPool.$disconnect()]); });
