/**
 * OAuth identity foundation — what migration 20261030090000_oauth_identity_foundation does, measured with
 * the real role topology on a Production-shaped database:
 *   owner   (lab_owner: the migration role, owner of the tables and the functions),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane),
 *   auth    (te_auth_login: NOSUPERUSER NOBYPASSRLS, member of app_auth — the signup / login plane).
 *
 * A "Google signup" below is the transaction the application will run, entirely as the auth plane:
 *   spend the ticket → Business → User (no password) → attach the identity → AuthSession.
 *
 *   1. Catalog and privileges: FORCE RLS on both tables; the auth plane holds NOTHING on either table or
 *      the sequence and EXECUTE on the six functions; the tenant plane holds nothing on tickets, only
 *      (id, businessId) + removal on identities, and EXECUTE on none; PUBLIC holds nothing.
 *   2. Issue: input is validated; a SIGNUP needs a provider-verified address; a newer ticket closes the
 *      older; parallel issues leave exactly one open; at most 10 per subject and hour; nothing for a
 *      subject already linked.
 *   3. Read: what the completion form may show, only for an open ticket of the right purpose.
 *   4. A Google signup: one User (no password, verified address), one Business, one identity, one
 *      session; the ticket is spent and names the user.
 *   5. Replay (T14): the spent ticket — as SIGNUP or as LINK — creates no account, links no identity and
 *      opens no session.
 *   6. Concurrency (T33): ten parallel signups with ONE ticket → exactly one account, one identity, one
 *      session; nine refusals.
 *   7. Refusals (T35–T36): expired, superseded, unknown, tampered, subject linked meanwhile; the table
 *      never holds the secret.
 *   8. Rollback (T37): a signup failing after the spend leaves nothing and the ticket open; one later
 *      signup succeeds.
 *   9. Attach guards: only the transaction that spent the ticket, only the account it just created (same
 *      address, no password, no identity, business alive), never a LINK ticket, never a forged marker.
 *  10. Resolve: a linked subject's user and business; its last use; nothing for an unknown subject.
 *  11. Tenant plane (erasure) on identities; purge; constraints; cascade.
 *
 * env: OWNER_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network. Raw SQL only: this PR ships no
 * schema.prisma change (migration-first), so the generated client knows nothing of the new tables.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string, n: number) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=${n}&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });
// Ten real connections, so the ten signups of section 6 run at the same time, each in its own session.
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
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied|42501/i;
const CHECK = /check constraint|23514/i;
const UNIQUE = /unique constraint|23505|duplicate key/i;
const INVALID_ARG = /22023|malformed|unknown purpose|unknown provider/i;
const ATTACH_REFUSED = /not spent in this transaction|not the account this signup created/i;
const count = async (sql: string, ...args: unknown[]) =>
  Number(((await owner.$queryRawUnsafe(sql, ...args)) as Rows)[0].c);

const TICKETS = `"OAuthSignupTicket"`;
const IDS = `"UserIdentity"`;
const BCRYPT = "$2b$10$" + "A".repeat(53);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");
let seq = 0;
const subject = () => `lab-sub-${Date.now()}-${++seq}`;
const address = (tag: string) => `agl-${tag}-${Date.now()}-${++seq}@lab.invalid`;

type Ticket = { secret: string; id: string | null; r: unknown };
async function issue(purpose: string, sub: string, email: string, verified = true, name: string | null = "דנה כהן"): Promise<Ticket> {
  const secret = newSecret();
  const r = await q(auth, null, `SELECT * FROM public.auth_oauth_ticket_issue($1, 'google', $2, $3, $4, $5, $6)`,
    purpose, sub, email, name, verified, sha(secret));
  const id = rows(r)[0]?.ticket_id;
  return { secret, id: typeof id === "string" ? id : null, r };
}
const read = async (secret: string, purpose = "SIGNUP") =>
  rows(await q(auth, null, `SELECT * FROM public.auth_oauth_ticket_read($1, $2)`, secret, purpose));
const ticketRow = async (id: string) =>
  ((await owner.$queryRawUnsafe(`SELECT * FROM ${TICKETS} WHERE id = $1::uuid`, id)) as Rows)[0];

type SignupOpts = { pause?: number; failAfterSpend?: boolean; purpose?: string; client?: PrismaClient };
type SignupResult = { ticketId: string; userId: number; businessId: number; identityId: number; verifiedAt: unknown };
/** The application's Google-signup transaction, as the auth plane. Throws (→ message) when refused. */
function googleSignup(secret: string, businessName: string, opts: SignupOpts = {}): Promise<SignupResult | string> {
  return inTx(opts.client ?? auth, null, async (tx) => {
    const t = (await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, $2)`, secret, opts.purpose ?? "SIGNUP")) as Rows;
    if (t.length !== 1) throw new Error("TICKET_REFUSED");
    if (opts.pause) await tx.$queryRawUnsafe(`SELECT pg_sleep(${opts.pause})`);
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
    return { ticketId: String(t[0].ticket_id), userId, businessId, identityId: Number(a[0].identity_id), verifiedAt: a[0].email_verified_at };
  });
}
type Footprint = { users: number; businesses: number; identities: number; sessions: number };
async function footprint(email: string, businessName: string, sub: string): Promise<Footprint> {
  return {
    users: await count(`SELECT count(*)::int AS c FROM "User" WHERE email = $1`, email),
    businesses: await count(`SELECT count(*)::int AS c FROM "Business" WHERE name = $1`, businessName),
    identities: await count(`SELECT count(*)::int AS c FROM ${IDS} WHERE "providerSubject" = $1`, sub),
    sessions: await count(`SELECT count(*)::int AS c FROM "AuthSession" s JOIN "User" u ON u.id = s."userId" WHERE u.email = $1`, email),
  };
}
const same = (a: Footprint, b: Footprint) => JSON.stringify(a) === JSON.stringify(b);

async function passwordAccount(tag: string) {
  const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `agl-${tag}`)) as Rows;
  const businessId = Number(b[0].id);
  const email = address(tag);
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,$3,$4, now()) RETURNING id`,
    email, BCRYPT, `owner ${tag}`, businessId,
  )) as Rows;
  return { businessId, userId: Number(u[0].id), email };
}

const FUNCS = [
  "auth_oauth_ticket_issue(text, text, text, text, text, boolean, text)",
  "auth_oauth_ticket_read(text, text)",
  "auth_oauth_ticket_consume(text, text)",
  "auth_oauth_identity_attach(uuid, integer)",
  "auth_oauth_identity_resolve(text, text)",
  "auth_oauth_ticket_purge()",
];

async function main() {
  console.log("\n— 1. catalog and privileges —");
  const cat = (await owner.$queryRawUnsafe(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*) FROM aclexplode(c.relacl) a WHERE a.grantee = 0)::int AS public_grants
       FROM pg_class c WHERE c.relname IN ('UserIdentity','OAuthSignupTicket') AND c.relkind = 'r' ORDER BY c.relname`,
  )) as Rows;
  ok("both tables exist with RLS ENABLED + FORCED", cat.length === 2 && cat.every((c) => c.relrowsecurity === true && c.relforcerowsecurity === true));
  ok("PUBLIC holds no privilege on either table", cat.every((c) => Number(c.public_grants) === 0));
  const privs = ((await owner.$queryRawUnsafe(`
    SELECT r.role, t.tbl, p.priv, has_table_privilege(r.role, t.tbl, p.priv) AS has
      FROM (VALUES ('app_auth'), ('app_runtime')) r(role)
     CROSS JOIN (VALUES ('"UserIdentity"'), ('"OAuthSignupTicket"')) t(tbl)
     CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)`)) as Rows);
  const has = (role: string, tbl: string, priv: string) => privs.find((p) => p.role === role && p.tbl === tbl && p.priv === priv)?.has === true;
  ok("app_auth holds NO table privilege on UserIdentity", ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].every((p) => !has("app_auth", '"UserIdentity"', p)));
  ok("app_auth holds NO table privilege on OAuthSignupTicket", ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].every((p) => !has("app_auth", '"OAuthSignupTicket"', p)));
  ok("app_runtime holds NO table privilege on OAuthSignupTicket", ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].every((p) => !has("app_runtime", '"OAuthSignupTicket"', p)));
  ok("app_runtime on UserIdentity: removal only at table level", has("app_runtime", '"UserIdentity"', "DELETE")
    && ["SELECT", "INSERT", "UPDATE", "TRUNCATE", "REFERENCES", "TRIGGER"].every((p) => !has("app_runtime", '"UserIdentity"', p)));
  const cols = ((await owner.$queryRawUnsafe(`
    SELECT a.attname AS col, has_column_privilege('app_runtime', '"UserIdentity"', a.attname, 'SELECT') AS rt,
           has_column_privilege('app_auth', '"UserIdentity"', a.attname, 'SELECT') AS au
      FROM pg_attribute a WHERE a.attrelid = '"UserIdentity"'::regclass AND a.attnum > 0 AND NOT a.attisdropped`)) as Rows);
  ok("app_runtime reads exactly (id, businessId) of UserIdentity", cols.filter((c) => c.rt === true).map((c) => c.col).sort().join(",") === "businessId,id",
    cols.filter((c) => c.rt === true).map((c) => c.col).join(","));
  ok("app_auth reads no column of UserIdentity", cols.every((c) => c.au !== true));
  const seqPriv = ((await owner.$queryRawUnsafe(`
    SELECT has_sequence_privilege('app_auth', '"UserIdentity_id_seq"', 'USAGE') OR has_sequence_privilege('app_auth', '"UserIdentity_id_seq"', 'SELECT')
        OR has_sequence_privilege('app_runtime', '"UserIdentity_id_seq"', 'USAGE') OR has_sequence_privilege('app_runtime', '"UserIdentity_id_seq"', 'SELECT') AS any`)) as Rows)[0];
  ok("neither plane holds a privilege on the identity sequence", seqPriv.any === false);
  const exec = ((await owner.$queryRawUnsafe(`
    SELECT f.sig, has_function_privilege('app_auth', 'public.' || f.sig, 'EXECUTE') AS au,
           has_function_privilege('app_runtime', 'public.' || f.sig, 'EXECUTE') AS rt,
           p.prosecdef AS definer, EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS pinned,
           (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee = 0)::int AS pub
      FROM unnest($1::text[]) f(sig) JOIN pg_proc p ON p.oid = ('public.' || f.sig)::regprocedure`, FUNCS)) as Rows);
  ok("app_auth may EXECUTE all six functions", exec.length === 6 && exec.every((e) => e.au === true));
  ok("app_runtime may EXECUTE none of them", exec.every((e) => e.rt === false));
  ok("PUBLIC may EXECUTE none of them", exec.every((e) => Number(e.pub) === 0));
  ok("all six are SECURITY DEFINER with a pinned search_path", exec.every((e) => e.definer === true && e.pinned === true));
  for (const [label, sql] of [
    ["SELECT tickets", `SELECT * FROM ${TICKETS}`],
    ["SELECT identities", `SELECT * FROM ${IDS}`],
    ["INSERT a ticket", `INSERT INTO ${TICKETS} ("id","purpose","provider","providerSubject","email","emailVerified","secretHash","issuedAt","expiresAt") VALUES ('${randomUUID()}','SIGNUP','google','x','a@b.c',true,'${sha("x")}',now(),now() + interval '10 minutes')`],
    ["UPDATE tickets", `UPDATE ${TICKETS} SET "endedAt" = NULL, "endedReason" = NULL`],
    ["INSERT an identity", `INSERT INTO ${IDS} ("userId","businessId","provider","providerSubject","emailAtLink","linkedAt") VALUES (1,1,'google','x','a@b.c',now())`],
    ["DELETE identities", `DELETE FROM ${IDS}`],
    ["TRUNCATE tickets", `TRUNCATE ${TICKETS}`],
  ] as const) {
    const r = label.startsWith("SELECT") ? await q(auth, null, sql) : await x(auth, null, sql);
    ok(`app_auth cannot ${label} directly (42501)`, refused(r, DENIED), String(r));
  }
  const rtTicket = await q(runtime, 1, `SELECT * FROM ${TICKETS}`);
  ok("app_runtime cannot read tickets (42501)", refused(rtTicket, DENIED), String(rtTicket));
  const rtExec = await q(runtime, null, `SELECT * FROM public.auth_oauth_ticket_consume('x', 'SIGNUP')`);
  ok("app_runtime cannot EXECUTE the functions (42501)", refused(rtExec, DENIED), String(rtExec));
  const pwChange = await x(auth, null, `UPDATE "User" SET "password" = $1 WHERE id = 1`, BCRYPT);
  ok("app_auth still cannot change User.password directly", refused(pwChange, DENIED), String(pwChange));
  const evChange = await x(auth, null, `UPDATE "User" SET "emailVerifiedAt" = now() WHERE id = 1`);
  ok("app_auth still cannot stamp User.emailVerifiedAt directly", refused(evChange, DENIED), String(evChange));
  const nullable = ((await owner.$queryRawUnsafe(`SELECT attnotnull FROM pg_attribute WHERE attrelid = '"User"'::regclass AND attname = 'password'`)) as Rows)[0];
  ok("User.password is nullable", nullable.attnotnull === false);

  console.log("\n— 2. issue —");
  const s0 = subject();
  const e0 = address("issue");
  ok("unknown purpose is refused", refused((await issue("LOGIN", s0, e0)).r, INVALID_ARG));
  const badProvider = await q(auth, null, `SELECT * FROM public.auth_oauth_ticket_issue('SIGNUP', 'facebook', $1, $2, NULL, true, $3)`, s0, e0, sha("p"));
  ok("unknown provider is refused", refused(badProvider, INVALID_ARG), String(badProvider));
  ok("an address that is not folded is refused", refused((await issue("SIGNUP", s0, "Dana@Lab.Invalid")).r, INVALID_ARG));
  const badHash = await q(auth, null, `SELECT * FROM public.auth_oauth_ticket_issue('SIGNUP', 'google', $1, $2, NULL, true, 'ABC')`, s0, e0);
  ok("a malformed hash is refused", refused(badHash, INVALID_ARG), String(badHash));
  const unverified = await issue("SIGNUP", s0, e0, false);
  ok("a SIGNUP for an address the provider did not verify issues nothing", unverified.id === null && typeof unverified.r !== "string", String(unverified.r));
  const t1 = await issue("SIGNUP", s0, e0);
  const t2 = await issue("SIGNUP", s0, e0);
  ok("a SIGNUP for a verified address is issued (id + 30-minute expiry)", t1.id !== null && t2.id !== null);
  const r1 = await ticketRow(t1.id!);
  ok("a newer ticket closes the older one (SUPERSEDED)", r1.endedReason === "SUPERSEDED" && r1.endedAt !== null);
  ok("the table holds sha256(secret), never the secret", r1.secretHash === sha(t1.secret)
    && (await count(`SELECT count(*)::int AS c FROM ${TICKETS} t WHERE t::text LIKE '%' || $1 || '%'`, t1.secret)) === 0);
  const sPar = subject();
  const ePar = address("par");
  await Promise.all(Array.from({ length: 5 }, () => inTx(authPool, null, (tx) =>
    tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_issue('SIGNUP', 'google', $1, $2, NULL, true, $3)`, sPar, ePar, sha(newSecret())))));
  ok("five parallel issues for one subject leave exactly one open ticket",
    (await count(`SELECT count(*)::int AS c FROM ${TICKETS} WHERE "providerSubject" = $1 AND "endedAt" IS NULL`, sPar)) === 1);
  const sCeil = subject();
  const eCeil = address("ceil");
  let issued = 0;
  for (let i = 0; i < 11; i++) if ((await issue("SIGNUP", sCeil, eCeil)).id) issued++;
  ok("at most 10 tickets per subject and hour", issued === 10, String(issued));

  console.log("\n— 3. read —");
  const shown = await read(t2.secret);
  ok("the completion form reads the open ticket's address, name and expiry", shown.length === 1 && shown[0].email === e0 && shown[0].name === "דנה כהן");
  ok("the wrong purpose reads nothing", (await read(t2.secret, "LINK")).length === 0);
  ok("a superseded ticket reads nothing", (await read(t1.secret)).length === 0);
  ok("an unknown secret reads nothing", (await read(newSecret())).length === 0);

  console.log("\n— 4. a Google signup —");
  const sW = subject();
  const eW = address("win");
  const nameW = `agl-win-${Date.now()}`;
  const tW = await issue("SIGNUP", sW, eW);
  const before = await footprint(eW, nameW, sW);
  const W = await googleSignup(tW.secret, nameW);
  ok("the signup commits as the auth plane", typeof W !== "string", String(W));
  const won = typeof W === "string" ? null : W;
  const after = await footprint(eW, nameW, sW);
  ok("exactly one User, one Business, one identity, one session", same(before, { users: 0, businesses: 0, identities: 0, sessions: 0 })
    && same(after, { users: 1, businesses: 1, identities: 1, sessions: 1 }), JSON.stringify(after));
  const wu = won ? ((await owner.$queryRawUnsafe(`SELECT "password", "emailVerifiedAt" FROM "User" WHERE id = $1`, won.userId)) as Rows)[0] : null;
  ok("the user has no password and a verified address", wu?.password === null && wu?.emailVerifiedAt !== null);
  const wt = await ticketRow(tW.id!);
  ok("the ticket is spent (CONSUMED) and names the user", wt.endedReason === "CONSUMED" && Number(wt.consumedByUserId) === won?.userId);
  const wi = won ? ((await owner.$queryRawUnsafe(`SELECT * FROM ${IDS} WHERE id = $1`, won.identityId)) as Rows)[0] : null;
  ok("the identity links subject → user → business with the ticket's address",
    wi?.providerSubject === sW && Number(wi?.userId) === won?.userId && Number(wi?.businessId) === won?.businessId && wi?.emailAtLink === eW);

  console.log("\n— 5. replay (T14 / T34) —");
  const replay = await googleSignup(tW.secret, `${nameW}-replay`);
  ok("the spent ticket is refused as SIGNUP", replay === "TICKET_REFUSED", String(replay));
  const replayLink = await googleSignup(tW.secret, `${nameW}-replay`, { purpose: "LINK" });
  ok("the spent ticket is refused as LINK", replayLink === "TICKET_REFUSED", String(replayLink));
  ok("…no account, no business, no identity, no session was added", same(await footprint(eW, nameW, sW), after)
    && (await count(`SELECT count(*)::int AS c FROM "Business" WHERE name = $1`, `${nameW}-replay`)) === 0);
  ok("a subject already linked is issued no new SIGNUP ticket", (await issue("SIGNUP", sW, eW)).id === null);

  console.log("\n— 6. concurrency (T33): ten signups, one ticket —");
  const sC = subject();
  const eC = address("race");
  const nameC = `agl-race-${Date.now()}`;
  const tC = await issue("SIGNUP", sC, eC);
  const raced = await Promise.all(Array.from({ length: 10 }, () => googleSignup(tC.secret, nameC, { pause: 0.4, client: authPool })));
  const wins = raced.filter((r) => typeof r !== "string") as SignupResult[];
  const refusals = raced.filter((r) => r === "TICKET_REFUSED");
  ok("exactly one of ten parallel signups succeeds", wins.length === 1, raced.map((r) => (typeof r === "string" ? r : "OK")).join(" | "));
  ok("the other nine are refused at the ticket", refusals.length === 9);
  ok("exactly one User, one Business, one identity, one session exist for that ticket",
    same(await footprint(eC, nameC, sC), { users: 1, businesses: 1, identities: 1, sessions: 1 }), JSON.stringify(await footprint(eC, nameC, sC)));

  console.log("\n— 7. refusals (T35 / T36) —");
  const sE = subject();
  const eE = address("exp");
  const tE = await issue("SIGNUP", sE, eE);
  await owner.$executeRawUnsafe(`UPDATE ${TICKETS} SET "issuedAt" = "issuedAt" - interval '40 minutes', "expiresAt" = "expiresAt" - interval '40 minutes' WHERE id = $1::uuid`, tE.id);
  ok("an expired ticket is refused", (await googleSignup(tE.secret, `agl-exp-${seq}`)) === "TICKET_REFUSED");
  ok("…and reads nothing", (await read(tE.secret)).length === 0);
  ok("a superseded ticket is refused", (await googleSignup(t1.secret, `agl-sup-${seq}`)) === "TICKET_REFUSED");
  ok("an unknown secret is refused", (await googleSignup(newSecret(), `agl-unk-${seq}`)) === "TICKET_REFUSED");
  const tT = await issue("SIGNUP", subject(), address("tamper"));
  const tampered = tT.secret.slice(0, -1) + (tT.secret.endsWith("A") ? "B" : "A");
  ok("a tampered secret is refused", (await googleSignup(tampered, `agl-tam-${seq}`)) === "TICKET_REFUSED");
  ok("…and the genuine ticket stays open", (await read(tT.secret)).length === 1);
  const sL = subject();
  const eL = address("linked");
  const tL = await issue("SIGNUP", sL, eL);
  const other = await passwordAccount("linked-meanwhile");
  await owner.$executeRawUnsafe(`INSERT INTO ${IDS} ("userId","businessId","provider","providerSubject","emailAtLink","linkedAt") VALUES ($1,$2,'google',$3,$4,now())`,
    other.userId, other.businessId, sL, other.email);
  ok("an open ticket whose subject was linked meanwhile is refused", (await googleSignup(tL.secret, `agl-lnk-${seq}`)) === "TICKET_REFUSED");

  console.log("\n— 8. rollback (T37) —");
  const sR = subject();
  const eR = address("rb");
  const nameR = `agl-rb-${Date.now()}`;
  const tR = await issue("SIGNUP", sR, eR);
  const failed = await googleSignup(tR.secret, nameR, { failAfterSpend: true });
  ok("a signup failing after the spend fails", failed === "FORCED_FAILURE", String(failed));
  ok("…leaves no account, business, identity or session", same(await footprint(eR, nameR, sR), { users: 0, businesses: 0, identities: 0, sessions: 0 }));
  const rr = await ticketRow(tR.id!);
  ok("…and the ticket open again", rr.endedAt === null && rr.endedReason === null && (await read(tR.secret)).length === 1);
  const again = await googleSignup(tR.secret, nameR);
  ok("one later signup with it succeeds", typeof again !== "string", String(again));
  ok("…once", (await googleSignup(tR.secret, nameR)) === "TICKET_REFUSED"
    && same(await footprint(eR, nameR, sR), { users: 1, businesses: 1, identities: 1, sessions: 1 }));

  console.log("\n— 9. attach guards —");
  const attachOnly = async (setup: (tx: Tx) => Promise<{ ticketId: string; userId: number }>) =>
    inTx(auth, null, async (tx) => {
      const { ticketId, userId } = await setup(tx);
      return tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_identity_attach($1::uuid, $2::int)`, ticketId, userId);
    });
  const pa = await passwordAccount("guard");
  const tG1 = await issue("SIGNUP", subject(), pa.email);
  const g1 = await attachOnly(async () => ({ ticketId: tG1.id!, userId: pa.userId }));
  ok("attach without spending the ticket in the transaction is refused", refused(g1, ATTACH_REFUSED), String(g1));
  const tG2 = await issue("SIGNUP", subject(), address("g2"));
  await inTx(auth, null, (tx) => tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, 'SIGNUP')`, tG2.secret));
  const g2 = await attachOnly(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.oauth_ticket_spent', $1, true)`, tG2.id);
    return { ticketId: tG2.id!, userId: pa.userId };
  });
  ok("a ticket spent by an EARLIER transaction cannot be attached, even with a forged marker", refused(g2, ATTACH_REFUSED), String(g2));
  const tG3 = await issue("SIGNUP", subject(), pa.email);
  const g3 = await attachOnly(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, 'SIGNUP')`, tG3.secret);
    return { ticketId: tG3.id!, userId: pa.userId };
  });
  ok("attach to an existing account with a password is refused (no linking by address)", refused(g3, ATTACH_REFUSED), String(g3));
  const tG4 = await issue("SIGNUP", subject(), address("g4"));
  const g4 = await attachOnly(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, 'SIGNUP')`, tG4.secret);
    const b = (await tx.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ('agl-g4', now()) RETURNING id`)) as Rows;
    const u = (await tx.$queryRawUnsafe(`INSERT INTO "User" ("email","name","businessId","updatedAt") VALUES ($1,'x',$2, now()) RETURNING id`,
      address("g4-other"), Number(b[0].id))) as Rows;
    return { ticketId: tG4.id!, userId: Number(u[0].id) };
  });
  ok("attach to an account with another address is refused", refused(g4, ATTACH_REFUSED), String(g4));
  const doomed = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt","deletionRequestedAt") VALUES ('agl-doomed', now(), now()) RETURNING id`)) as Rows;
  const eD = address("doomed");
  const tG5 = await issue("SIGNUP", subject(), eD);
  const g5 = await attachOnly(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, 'SIGNUP')`, tG5.secret);
    const u = (await tx.$queryRawUnsafe(`INSERT INTO "User" ("email","name","businessId","updatedAt") VALUES ($1,'x',$2, now()) RETURNING id`,
      eD, Number(doomed[0].id))) as Rows;
    return { ticketId: tG5.id!, userId: Number(u[0].id) };
  });
  ok("attach for a business in deletion is refused", refused(g5, ATTACH_REFUSED), String(g5));
  const tG6 = await issue("LINK", subject(), pa.email);
  const g6 = await attachOnly(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT * FROM public.auth_oauth_ticket_consume($1, 'LINK')`, tG6.secret);
    return { ticketId: tG6.id!, userId: pa.userId };
  });
  ok("a LINK ticket cannot be attached (milestone 3 brings its own proof)", refused(g6, ATTACH_REFUSED), String(g6));
  ok("none of the refused attaches left an identity",
    (await count(`SELECT count(*)::int AS c FROM ${IDS} WHERE "userId" = $1`, pa.userId)) === 0);

  console.log("\n— 10. resolve —");
  const res = rows(await q(auth, null, `SELECT * FROM public.auth_oauth_identity_resolve('google', $1)`, sW));
  ok("a linked subject resolves to its user and business", res.length === 1 && Number(res[0].user_id) === won?.userId && Number(res[0].business_id) === won?.businessId);
  const lu = ((await owner.$queryRawUnsafe(`SELECT "lastUsedAt" FROM ${IDS} WHERE "providerSubject" = $1`, sW)) as Rows)[0];
  ok("…and records its last use", lu.lastUsedAt !== null);
  ok("an unknown subject resolves to nothing", rows(await q(auth, null, `SELECT * FROM public.auth_oauth_identity_resolve('google', 'nobody')`)).length === 0);

  console.log("\n— 11. tenant plane, purge, constraints, cascade —");
  if (won) {
    const own = await q(runtime, won.businessId, `SELECT id, "businessId" FROM ${IDS}`);
    ok("in its tenant, app_runtime sees exactly that tenant's identity ids", rows(own).length === 1 && Number(rows(own)[0].businessId) === won.businessId, String(own));
    const subjectRead = await q(runtime, won.businessId, `SELECT "providerSubject" FROM ${IDS}`);
    ok("app_runtime never reads the subject", refused(subjectRead, DENIED), String(subjectRead));
    ok("without a tenant context app_runtime sees nothing", rows(await q(runtime, null, `SELECT id FROM ${IDS}`)).length === 0);
    ok("another tenant cannot remove it", (await x(runtime, other.businessId, `DELETE FROM ${IDS} WHERE id = $1`, won.identityId)) === 0);
  }
  const before11 = await count(`SELECT count(*)::int AS c FROM ${TICKETS} WHERE "expiresAt" <= timezone('UTC', now())`);
  const open11 = await count(`SELECT count(*)::int AS c FROM ${TICKETS} WHERE "expiresAt" > timezone('UTC', now())`);
  const purged = rows(await q(auth, null, `SELECT public.auth_oauth_ticket_purge() AS n`))[0]?.n;
  ok("purge removes exactly the expired tickets", Number(purged) === before11 && before11 >= 1
    && (await count(`SELECT count(*)::int AS c FROM ${TICKETS}`)) === open11, `${purged} vs ${before11}`);
  const bad = (cols: string, vals: string) => x(owner, null, `INSERT INTO ${TICKETS} (${cols}) VALUES (${vals})`);
  const BASE = `"id","purpose","provider","providerSubject","email","emailVerified","secretHash","issuedAt","expiresAt"`;
  ok("lifetime is at most 30 minutes", refused(await bad(BASE, `'${randomUUID()}','SIGNUP','google','s','a@b.c',true,'${sha("c1")}',now(),now() + interval '31 minutes'`), CHECK));
  ok("purpose vocabulary is enforced", refused(await bad(BASE, `'${randomUUID()}','LOGIN','google','s','a@b.c',true,'${sha("c2")}',now(),now() + interval '5 minutes'`), CHECK));
  ok("an end needs a known reason", refused(await bad(`${BASE},"endedAt","endedReason"`,
    `'${randomUUID()}','SIGNUP','google','s','a@b.c',true,'${sha("c3")}',now(),now() + interval '5 minutes',now(),'USED'`), CHECK));
  ok("only a CONSUMED ticket names a user", refused(await bad(`${BASE},"endedAt","endedReason","consumedByUserId"`,
    `'${randomUUID()}','SIGNUP','google','s','a@b.c',true,'${sha("c4")}',now(),now() + interval '5 minutes',now(),'SUPERSEDED',${pa.userId}`), CHECK));
  ok("one subject links one user", refused(await x(owner, null,
    `INSERT INTO ${IDS} ("userId","businessId","provider","providerSubject","emailAtLink","linkedAt") VALUES ($1,$2,'google',$3,'a@b.c',now())`,
    pa.userId, pa.businessId, sW), UNIQUE));
  if (won) {
    ok("one user links one Google identity", refused(await x(owner, null,
      `INSERT INTO ${IDS} ("userId","businessId","provider","providerSubject","emailAtLink","linkedAt") VALUES ($1,$2,'google','another','a@b.c',now())`,
      won.userId, won.businessId), UNIQUE));
    ok("in its own tenant, app_runtime removes it (erasure)", (await x(runtime, won.businessId, `DELETE FROM ${IDS} WHERE id = $1`, won.identityId)) === 1);
  }
  if (typeof again !== "string") {
    await owner.$executeRawUnsafe(`DELETE FROM "AuthSession" WHERE "userId" = $1`, again.userId);
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, again.userId);
    ok("deleting a user removes its identity (cascade)", (await count(`SELECT count(*)::int AS c FROM ${IDS} WHERE "userId" = $1`, again.userId)) === 0);
    const kept = await ticketRow(tR.id!);
    ok("…and its spent ticket no longer names it", kept.consumedByUserId === null && kept.endedReason === "CONSUMED");
  }

  console.log(`\n[oauth-identity-battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect(), authPool.$disconnect()]); });
