/**
 * Transactional email foundation — what migration 20261015090000_transactional_email_foundation does,
 * measured with the real role topology on a Production-shaped database:
 *   owner   (lab_owner: the migration role),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane),
 *   auth    (te_auth_login: NOSUPERUSER NOBYPASSRLS, member of app_auth — the signup / delivery plane).
 *
 *   1. FORCE RLS is on; PUBLIC holds nothing.
 *   2. Signup plane: a real signup transaction (Business → User → TransactionalEmail) commits as app_auth;
 *      the idempotency key is unique; a userId-less row is allowed (future kinds); the tenant binding
 *      refuses a row whose user belongs to another business; no DELETE, no TRUNCATE; only the delivery
 *      columns can change — recipient, content, kind, key, user and business are immutable.
 *   3. Tenant plane: app_runtime can never read toEmail / payload / any content column, never INSERT or
 *      UPDATE, never TRUNCATE, never use the sequence; it reads only (id, businessId) of its own tenant,
 *      and nothing without a tenant context.
 *   4. Account erasure: inside tenant A's context, app_runtime deletes exactly A's rows — B's are
 *      untouched, a cross-tenant DELETE removes nothing, and no email address or name of A remains.
 *   5. Constraints: payload object, status vocabulary, SENT needs sentAt, kind format; Business deletion
 *      cascades.
 *
 * env: OWNER_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network. Raw SQL only: PR-1 ships no
 * schema.prisma change (migration-first), so the generated client knows nothing of the table.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;

/** One transaction as `client`, optionally inside a tenant context; returns rows or the error text. */
async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const n = (r: unknown) => (typeof r === "string" ? -1 : Array.isArray(r) ? r.length : Number(r));
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied/i;
const RLS = /row-level security/i;
const UNIQUE = /Unique constraint|duplicate key|23505/i;
const CHECK = /check constraint|23514/i;

const T = `"TransactionalEmail"`;
const INS = `INSERT INTO ${T} ("kind","dedupeKey","userId","businessId","toEmail","payload","locale","status","nextAttemptAt","expiresAt","createdAt","updatedAt")
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,'he','PENDING',now(),now() + interval '24 hours',now(),now())`;

async function ownerBusiness(name: string): Promise<{ businessId: number; userId: number; email: string }> {
  const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, name)) as Rows;
  const businessId = Number(b[0].id);
  const email = `te-${businessId}-${Date.now()}@lab.invalid`;
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,'x',$2,$3, now()) RETURNING id`,
    email, `owner ${name}`, businessId,
  )) as Rows;
  return { businessId, userId: Number(u[0].id), email };
}

async function main() {
  console.log("\n— 1. catalog —");
  const cat = (await owner.$queryRawUnsafe(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*) FROM aclexplode(c.relacl) a WHERE a.grantee = 0) AS public_grants
       FROM pg_class c WHERE c.relname = 'TransactionalEmail' AND c.relkind = 'r'`,
  )) as Rows;
  ok("table exists with RLS ENABLED", cat[0]?.relrowsecurity === true);
  ok("FORCE ROW LEVEL SECURITY is on", cat[0]?.relforcerowsecurity === true);
  ok("PUBLIC holds no privilege", Number(cat[0]?.public_grants) === 0);

  const A = await ownerBusiness("te-A");
  const B = await ownerBusiness("te-B");

  console.log("\n— 2. signup plane (app_auth) —");
  // A real signup transaction, entirely as the signup plane: Business → User → owed WELCOME.
  const signup = await inTx(auth, null, async (tx) => {
    const b = (await tx.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ('te-signup', now()) RETURNING id`)) as Rows;
    const businessId = Number(b[0].id);
    const email = `te-signup-${businessId}@lab.invalid`;
    const u = (await tx.$queryRawUnsafe(
      `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,'x','דנה כהן',$2, now()) RETURNING id`,
      email, businessId,
    )) as Rows;
    const userId = Number(u[0].id);
    const e = (await tx.$queryRawUnsafe(`${INS} RETURNING id`, "WELCOME", `welcome:user:${userId}`, userId, businessId, email,
      JSON.stringify({ firstName: "דנה", businessName: "te-signup" }))) as Rows;
    return { businessId, userId, emailId: Number(e[0].id) };
  });
  ok("a signup transaction (Business, User, WELCOME row) commits as app_auth", typeof signup !== "string", String(signup));
  const S = typeof signup === "string" ? null : signup;

  const aWelcome = await x(auth, null, INS, "WELCOME", `welcome:user:${A.userId}`, A.userId, A.businessId, A.email, JSON.stringify({ firstName: "A" }));
  const bWelcome = await x(auth, null, INS, "WELCOME", `welcome:user:${B.userId}`, B.userId, B.businessId, B.email, JSON.stringify({ firstName: "B" }));
  ok("legitimate app_auth INSERT for business A and B", aWelcome === 1 && bWelcome === 1, `${aWelcome} ${bWelcome}`);

  const dup = await x(auth, null, INS, "WELCOME", `welcome:user:${A.userId}`, A.userId, A.businessId, A.email, "{}");
  ok("the idempotency key is unique (a second WELCOME for the same user is refused)", refused(dup, UNIQUE), String(dup));
  const dupNoop = await x(auth, null, `${INS} ON CONFLICT ("dedupeKey") DO NOTHING`, "WELCOME", `welcome:user:${A.userId}`, A.userId, A.businessId, A.email, "{}");
  ok("…and ON CONFLICT DO NOTHING writes nothing (retry / double submit)", dupNoop === 0, String(dupNoop));

  const cross = await x(auth, null, INS, "WELCOME", `welcome:cross:${A.userId}`, A.userId, B.businessId, A.email, "{}");
  ok("app_auth cannot file a user's email under ANOTHER business (tenant binding, RLS)", refused(cross, RLS), String(cross));
  const ghost = await x(auth, null, INS, "WELCOME", "welcome:ghost", 2147480000, A.businessId, A.email, "{}");
  ok("app_auth cannot name a user that does not exist", typeof ghost === "string", String(ghost));
  const noUser = await x(auth, null, INS, "RECEIPT_COPY", `receipt:${A.businessId}:1`, null, A.businessId, "customer@lab.invalid", "{}");
  ok("a userId-less row is allowed (future kinds; no closed kind list)", noUser === 1, String(noUser));

  const authDel = await x(auth, null, `DELETE FROM ${T} WHERE "businessId" = $1`, A.businessId);
  ok("app_auth cannot DELETE", refused(authDel, DENIED), String(authDel));
  const authTrunc = await x(auth, null, `TRUNCATE ${T}`);
  ok("app_auth cannot TRUNCATE", refused(authTrunc, DENIED), String(authTrunc));
  for (const col of ["toEmail", "payload", "kind", "dedupeKey", "userId", "businessId", "locale", "expiresAt", "createdAt"]) {
    const v = col === "payload" ? `'{}'::jsonb` : col === "userId" || col === "businessId" ? `"${col}"` : col.endsWith("At") ? "now()" : `'X'`;
    const r = await x(auth, null, `UPDATE ${T} SET "${col}" = ${v} WHERE "dedupeKey" = $1`, `welcome:user:${A.userId}`);
    ok(`app_auth cannot change ${col} (immutable after insert)`, refused(r, DENIED), String(r));
  }
  const delivered = await x(auth, null,
    `UPDATE ${T} SET "status"='SENT', "attempts"=1, "sentAt"=now(), "provider"='resend', "providerMessageId"='lab-msg-1', "nextAttemptAt"=NULL, "lastErrorCode"=NULL, "updatedAt"=now() WHERE "dedupeKey" = $1`,
    `welcome:user:${B.userId}`);
  ok("app_auth can move the delivery columns (claim / send / record)", delivered === 1, String(delivered));
  const authSees = await q(auth, null, `SELECT "toEmail","payload" FROM ${T} WHERE "businessId" IN ($1,$2)`, A.businessId, B.businessId);
  ok("app_auth reads rows of every business (the cross-tenant delivery worker)", n(authSees) >= 3, String(authSees));

  console.log("\n— 3. tenant plane (app_runtime) —");
  for (const col of ["toEmail", "payload", "kind", "dedupeKey", "userId", "status", "providerMessageId"]) {
    const r = await q(runtime, A.businessId, `SELECT "${col}" FROM ${T}`);
    ok(`app_runtime cannot read ${col}, even in its own tenant`, refused(r, DENIED), String(r));
  }
  const star = await q(runtime, A.businessId, `SELECT * FROM ${T}`);
  ok("app_runtime cannot SELECT *", refused(star, DENIED), String(star));
  const own = await q(runtime, A.businessId, `SELECT "id","businessId" FROM ${T}`);
  ok("app_runtime reads only (id, businessId), and only its own tenant's rows",
    Array.isArray(own) && own.length === 2 && own.every((r) => Number(r.businessId) === A.businessId), JSON.stringify(own));
  const other = await q(runtime, A.businessId, `SELECT "id" FROM ${T} WHERE "businessId" = $1`, B.businessId);
  ok("cross-tenant SELECT returns nothing", n(other) === 0, String(other));
  const noCtx = await q(runtime, null, `SELECT "id" FROM ${T}`);
  ok("no tenant context → nothing visible", n(noCtx) === 0, String(noCtx));
  const rtIns = await x(runtime, A.businessId, INS, "WELCOME", "welcome:rt", A.userId, A.businessId, A.email, "{}");
  ok("app_runtime cannot INSERT", refused(rtIns, DENIED), String(rtIns));
  const rtUpd = await x(runtime, A.businessId, `UPDATE ${T} SET "status"='SENT', "sentAt"=now() WHERE "businessId" = $1`, A.businessId);
  ok("app_runtime cannot UPDATE", refused(rtUpd, DENIED), String(rtUpd));
  const rtTrunc = await x(runtime, A.businessId, `TRUNCATE ${T}`);
  ok("app_runtime cannot TRUNCATE", refused(rtTrunc, DENIED), String(rtTrunc));
  const rtSeq = await q(runtime, A.businessId, `SELECT nextval('"TransactionalEmail_id_seq"')`);
  ok("app_runtime cannot use the id sequence", refused(rtSeq, DENIED), String(rtSeq));

  console.log("\n— 4. account erasure (Stage 2 shape: app_runtime inside the erased tenant) —");
  const crossDel = await x(runtime, A.businessId, `DELETE FROM ${T} WHERE "businessId" = $1`, B.businessId);
  ok("cross-tenant DELETE removes nothing", crossDel === 0, String(crossDel));
  const noCtxDel = await x(runtime, null, `DELETE FROM ${T} WHERE "businessId" = $1`, A.businessId);
  ok("DELETE without a tenant context removes nothing", noCtxDel === 0, String(noCtxDel));
  const erase = await x(runtime, A.businessId, `DELETE FROM ${T} WHERE "businessId" = $1`, A.businessId);
  ok("erasure deletes exactly the erased business's rows", erase === 2, String(erase));
  const left = (await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE "toEmail" = $2 OR "payload" ->> 'firstName' = 'A')::int AS pii
       FROM ${T} WHERE "businessId" = $1`, A.businessId, A.email)) as Rows;
  ok("no row, address or name of the erased business remains", left[0].n === 0 && left[0].pii === 0, JSON.stringify(left));
  const bLeft = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${T} WHERE "businessId" = $1`, B.businessId)) as Rows;
  ok("the other business's rows are untouched", bLeft[0].n === 1, JSON.stringify(bLeft));

  console.log("\n— 5. constraints and cascade —");
  const badPayload = await x(auth, null, INS, "WELCOME", "welcome:bad-payload", null, B.businessId, B.email, "[1,2]");
  ok("payload must be a JSON object", refused(badPayload, CHECK), String(badPayload));
  const badKind = await x(auth, null, INS, "welcome", "welcome:bad-kind", null, B.businessId, B.email, "{}");
  ok("kind format is enforced (not a closed list)", refused(badKind, CHECK), String(badKind));
  const badStatus = await x(auth, null, `UPDATE ${T} SET "status"='DONE' WHERE "businessId" = $1`, B.businessId);
  ok("status vocabulary is closed", refused(badStatus, CHECK), String(badStatus));
  const sentNoTime = await x(auth, null, `UPDATE ${T} SET "sentAt"=NULL WHERE "businessId" = $1 AND "status"='SENT'`, B.businessId);
  ok("SENT needs sentAt", refused(sentNoTime, CHECK), String(sentNoTime));
  const badEmail = await x(auth, null, INS, "WELCOME", "welcome:bad-email", null, B.businessId, "not-an-address", "{}");
  ok("toEmail must look like an address", refused(badEmail, CHECK), String(badEmail));

  if (S) {
    // A userId-less row survives the user's removal and goes with the business itself.
    await x(auth, null, INS, "RECEIPT_COPY", `receipt:${S.businessId}:1`, null, S.businessId, "customer@lab.invalid", "{}");
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE "businessId" = $1`, S.businessId);
    const afterUser = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${T} WHERE "businessId" = $1`, S.businessId)) as Rows;
    ok("deleting a user cascades to that user's rows only", afterUser[0].n === 1, JSON.stringify(afterUser));
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = $1`, S.businessId);
    const gone = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${T} WHERE "businessId" = $1`, S.businessId)) as Rows;
    ok("deleting the business cascades to its rows", gone[0].n === 0, JSON.stringify(gone));
  }

  await Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect()]);
  console.log(`\n[transactional-email battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) {
    console.log("FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("BATTERY ERROR:", e);
  process.exit(1);
});
