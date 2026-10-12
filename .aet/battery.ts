/**
 * Auth email tokens — what migration 20261017090000_auth_email_tokens does, measured with the real role
 * topology on a Production-shaped database:
 *   owner   (lab_owner: the migration role, owner of the table and the functions),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane),
 *   auth    (te_auth_login: NOSUPERUSER NOBYPASSRLS, member of app_auth — the signup / login plane).
 *
 *   1. Catalog: FORCE RLS; PUBLIC holds nothing on the table or the functions.
 *   2. The auth plane reaches the table ONLY through the functions: no SELECT / INSERT / UPDATE / DELETE /
 *      TRUNCATE on it, still no UPDATE on User.password or User.emailVerifiedAt; it can read
 *      emailVerifiedAt and EXECUTE the four functions. The tenant plane cannot EXECUTE them.
 *   3. Issue: returns the user's business and address; a second issue supersedes the first; at most five
 *      per user, purpose and hour; nothing for an unknown user, a business in deletion, or an already
 *      verified address (EMAIL_VERIFY); malformed input is refused.
 *   4. Check: VALID / INVALID (wrong secret, wrong purpose, unknown id) / EXPIRED / USED / SUPERSEDED; and
 *      INVALID once the account's address is no longer the one the link was sent to.
 *   5. Verify: a wrong secret changes nothing; the right one stamps emailVerifiedAt exactly once; replay is
 *      USED; an expired link is EXPIRED and stamps nothing; a reset link cannot verify.
 *   6. Reset: only a bcrypt hash is accepted; a wrong secret changes nothing; the right one sets the hash,
 *      bumps tokenVersion, revokes every open refresh session, closes the user's other reset links and
 *      stamps emailVerifiedAt — and touches no other user; replay is USED; a verify link cannot reset;
 *      a business in deletion cannot reset.
 *   7. Tenant plane (erasure): inside tenant A's context app_runtime sees and deletes only A's token ids,
 *      never the hash / address / timestamps, nothing without a context; B's rows survive.
 *   8. Constraints and cascade: purpose vocabulary, hash shape, lifetime <= 24h; deleting a user removes
 *      its tokens.
 *
 * env: OWNER_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network. Raw SQL only: PR-1 ships no
 * schema.prisma change (migration-first), so the generated client knows nothing of the table or column.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied/i;
const CHECK = /check constraint|23514/i;
const INVALID_ARG = /22023|malformed|unknown purpose|not a bcrypt hash/i;

const T = `"AuthEmailToken"`;
const BCRYPT_A = "$2b$10$" + "A".repeat(53);
const BCRYPT_B = "$2b$10$" + "B".repeat(53);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const secret = () => randomBytes(32).toString("base64url");

type Acct = { businessId: number; userId: number; email: string };
async function account(name: string): Promise<Acct> {
  const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, name)) as Rows;
  const businessId = Number(b[0].id);
  const email = `aet-${businessId}-${Date.now()}@lab.invalid`;
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,$3,$4, now()) RETURNING id`,
    email, BCRYPT_A, `owner ${name}`, businessId,
  )) as Rows;
  return { businessId, userId: Number(u[0].id), email };
}
async function session(userId: number): Promise<void> {
  await owner.$executeRawUnsafe(
    `INSERT INTO "AuthSession" ("id","userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt")
     VALUES ($1::uuid,$2,$3,0,now(),now(),now() + interval '30 days',now() + interval '90 days')`,
    randomUUID(), userId, sha(randomUUID()),
  );
}
/** Issue as the auth plane; returns { id, secret, row } (row empty when nothing was issued). */
async function issue(userId: number, purpose: string) {
  const id = randomUUID();
  const s = secret();
  const r = await q(auth, null, `SELECT * FROM public.auth_email_token_issue($1::int, $2, $3::uuid, $4)`, userId, purpose, id, sha(s));
  return { id, secret: s, r };
}
const check = async (id: string, s: string, purpose: string) =>
  rows(await q(auth, null, `SELECT public.auth_email_token_check($1::uuid, $2, $3) AS s`, id, s, purpose))[0]?.s;
const verify = async (id: string, s: string) =>
  rows(await q(auth, null, `SELECT * FROM public.auth_email_verify_consume($1::uuid, $2)`, id, s))[0];
const reset = (id: string, s: string, hash: string) =>
  q(auth, null, `SELECT * FROM public.auth_password_reset_consume($1::uuid, $2, $3)`, id, s, hash);
const user = async (id: number) =>
  ((await owner.$queryRawUnsafe(`SELECT "password","tokenVersion","emailVerifiedAt" FROM "User" WHERE id = $1`, id)) as Rows)[0];
const openSessions = async (userId: number) =>
  Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1 AND "revokedAt" IS NULL`, userId)) as Rows)[0].c);

async function main() {
  console.log("\n— 1. catalog —");
  const cat = ((await owner.$queryRawUnsafe(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*) FROM aclexplode(c.relacl) a WHERE a.grantee = 0)::int AS public_grants
       FROM pg_class c WHERE c.relname = 'AuthEmailToken' AND c.relkind = 'r'`,
  )) as Rows)[0];
  ok("table exists with RLS ENABLED + FORCED", cat?.relrowsecurity === true && cat?.relforcerowsecurity === true);
  ok("PUBLIC holds no privilege on the table", Number(cat?.public_grants) === 0);
  const pubExec = ((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE p.proname LIKE 'auth\\_%' AND p.proname IN ('auth_email_token_issue','auth_email_token_check','auth_email_verify_consume','auth_password_reset_consume')
        AND a.grantee = 0`,
  )) as Rows)[0];
  ok("PUBLIC holds no EXECUTE on any of the four functions", Number(pubExec.c) === 0);

  const A = await account("aet-A");
  const B = await account("aet-B");
  await session(A.userId); await session(A.userId); await session(B.userId);

  console.log("\n— 2. the auth plane reaches the table only through the functions —");
  for (const [label, sql] of [
    ["SELECT", `SELECT * FROM ${T}`],
    ["INSERT", `INSERT INTO ${T} ("id","userId","businessId","purpose","email","tokenHash","createdAt","expiresAt") VALUES ('${randomUUID()}', ${A.userId}, ${A.businessId}, 'PASSWORD_RESET', '${A.email}', '${sha("x")}', now(), now() + interval '1 hour')`],
    ["UPDATE", `UPDATE ${T} SET "consumedAt" = now()`],
    ["DELETE", `DELETE FROM ${T}`],
    ["TRUNCATE", `TRUNCATE ${T}`],
  ] as const) {
    const r = label === "SELECT" ? await q(auth, null, sql) : await x(auth, null, sql);
    ok(`app_auth cannot ${label} the table`, refused(r, DENIED), String(r));
  }
  const pw = await x(auth, null, `UPDATE "User" SET "password" = $1 WHERE id = $2`, BCRYPT_B, A.userId);
  ok("app_auth still cannot change User.password directly", refused(pw, DENIED), String(pw));
  const ev = await x(auth, null, `UPDATE "User" SET "emailVerifiedAt" = now() WHERE id = $1`, A.userId);
  ok("app_auth cannot stamp User.emailVerifiedAt directly", refused(ev, DENIED), String(ev));
  const evRead = await q(auth, null, `SELECT "emailVerifiedAt" FROM "User" WHERE id = $1`, A.userId);
  ok("app_auth can read User.emailVerifiedAt (NULL: no backfill)", rows(evRead).length === 1 && rows(evRead)[0].emailVerifiedAt === null, String(evRead));
  const rtExec = await q(runtime, A.businessId, `SELECT * FROM public.auth_email_token_issue($1::int, 'PASSWORD_RESET', $2::uuid, $3)`, A.userId, randomUUID(), sha("y"));
  ok("app_runtime cannot EXECUTE the issue function", refused(rtExec, DENIED), String(rtExec));
  const rtReset = await q(runtime, A.businessId, `SELECT * FROM public.auth_password_reset_consume($1::uuid, 'x', $2)`, randomUUID(), BCRYPT_B);
  ok("app_runtime cannot EXECUTE the reset function", refused(rtReset, DENIED), String(rtReset));

  console.log("\n— 3. issue —");
  const v1 = await issue(A.userId, "EMAIL_VERIFY");
  const v1r = rows(v1.r)[0];
  ok("issue returns the token, the user's business and address", v1r?.token_id === v1.id && Number(v1r?.business_id) === A.businessId && v1r?.email === A.email, JSON.stringify(v1.r));
  const life = ((await owner.$queryRawUnsafe(`SELECT extract(epoch FROM "expiresAt" - "createdAt")::int AS s, "userId", "businessId" FROM ${T} WHERE id = $1::uuid`, v1.id)) as Rows)[0];
  ok("EMAIL_VERIFY lives 24h and is filed under the user's own business", Number(life.s) === 86400 && Number(life.businessId) === A.businessId);
  const stored = ((await owner.$queryRawUnsafe(`SELECT "tokenHash" FROM ${T} WHERE id = $1::uuid`, v1.id)) as Rows)[0];
  ok("only sha256(secret) is stored — never the secret", stored.tokenHash === sha(v1.secret) && stored.tokenHash !== v1.secret);
  const v2 = await issue(A.userId, "EMAIL_VERIFY");
  ok("a second issue succeeds", rows(v2.r).length === 1);
  ok("…and supersedes the first", (await check(v1.id, v1.secret, "EMAIL_VERIFY")) === "SUPERSEDED");
  const r1 = await issue(A.userId, "PASSWORD_RESET");
  const rlife = ((await owner.$queryRawUnsafe(`SELECT extract(epoch FROM "expiresAt" - "createdAt")::int AS s FROM ${T} WHERE id = $1::uuid`, r1.id)) as Rows)[0];
  ok("PASSWORD_RESET lives 1h", Number(rlife.s) === 3600);
  ok("a reset issue does not supersede the verify link (purposes are separate)", (await check(v2.id, v2.secret, "EMAIL_VERIFY")) === "VALID");
  const ghost = await issue(2147480000, "PASSWORD_RESET");
  ok("nothing is issued for an unknown user", Array.isArray(ghost.r) && rows(ghost.r).length === 0, String(ghost.r));
  const badPurpose = await q(auth, null, `SELECT * FROM public.auth_email_token_issue($1::int, 'LOGIN', $2::uuid, $3)`, A.userId, randomUUID(), sha("z"));
  ok("an unknown purpose is refused", refused(badPurpose, INVALID_ARG), String(badPurpose));
  const badHash = await q(auth, null, `SELECT * FROM public.auth_email_token_issue($1::int, 'PASSWORD_RESET', $2::uuid, 'not-a-hash')`, A.userId, randomUUID());
  ok("a malformed hash is refused", refused(badHash, INVALID_ARG), String(badHash));

  const C = await account("aet-ceiling");
  const ceiling: number[] = [];
  for (let i = 0; i < 6; i++) ceiling.push(rows((await issue(C.userId, "PASSWORD_RESET")).r).length);
  ok("at most five per user, purpose and hour (the sixth issues nothing)", ceiling.join("") === "111110", ceiling.join(""));
  ok("…the ceiling is per purpose", rows((await issue(C.userId, "EMAIL_VERIFY")).r).length === 1);

  const D = await account("aet-deleting");
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, D.businessId);
  ok("nothing is issued for a business in deletion", rows((await issue(D.userId, "PASSWORD_RESET")).r).length === 0);

  console.log("\n— 4. check —");
  ok("VALID for the live link", (await check(r1.id, r1.secret, "PASSWORD_RESET")) === "VALID");
  ok("INVALID for a wrong secret", (await check(r1.id, secret(), "PASSWORD_RESET")) === "INVALID");
  ok("INVALID for the wrong purpose", (await check(r1.id, r1.secret, "EMAIL_VERIFY")) === "INVALID");
  ok("INVALID for an unknown id", (await check(randomUUID(), r1.secret, "PASSWORD_RESET")) === "INVALID");
  ok("INVALID for an oversized secret", (await check(r1.id, "x".repeat(500), "PASSWORD_RESET")) === "INVALID");
  const E = await account("aet-expired");
  const e1 = await issue(E.userId, "PASSWORD_RESET");
  await owner.$executeRawUnsafe(`UPDATE ${T} SET "createdAt" = "createdAt" - interval '2 hours', "expiresAt" = "expiresAt" - interval '2 hours' WHERE id = $1::uuid`, e1.id);
  ok("EXPIRED once past expiresAt", (await check(e1.id, e1.secret, "PASSWORD_RESET")) === "EXPIRED");
  const M = await account("aet-moved");
  const m1 = await issue(M.userId, "PASSWORD_RESET");
  await owner.$executeRawUnsafe(`UPDATE "User" SET "email" = $1 WHERE id = $2`, `moved-${M.userId}@lab.invalid`, M.userId);
  ok("INVALID once the account's address is no longer the one the link was sent to", (await check(m1.id, m1.secret, "PASSWORD_RESET")) === "INVALID");

  console.log("\n— 5. verify —");
  const wrongV = await verify(v2.id, secret());
  ok("a wrong secret: INVALID, nothing stamped", wrongV?.status === "INVALID" && (await user(A.userId)).emailVerifiedAt === null);
  const crossPurpose = await verify(r1.id, r1.secret);
  ok("a reset link cannot verify", crossPurpose?.status === "INVALID");
  const goodV = await verify(v2.id, v2.secret);
  ok("the right secret: VERIFIED for that user and business", goodV?.status === "VERIFIED" && Number(goodV?.user_id) === A.userId && Number(goodV?.business_id) === A.businessId, JSON.stringify(goodV));
  const stampA = (await user(A.userId)).emailVerifiedAt;
  ok("…emailVerifiedAt is stamped", stampA instanceof Date);
  ok("…and B is untouched", (await user(B.userId)).emailVerifiedAt === null);
  ok("replaying the link: USED", (await verify(v2.id, v2.secret))?.status === "USED");
  ok("nothing new is issued for an already verified address", rows((await issue(A.userId, "EMAIL_VERIFY")).r).length === 0);
  const F = await account("aet-verify-expired");
  const f1 = await issue(F.userId, "EMAIL_VERIFY");
  await owner.$executeRawUnsafe(`UPDATE ${T} SET "createdAt" = "createdAt" - interval '25 hours', "expiresAt" = "expiresAt" - interval '25 hours' WHERE id = $1::uuid`, f1.id);
  ok("an expired verify link: EXPIRED, nothing stamped", (await verify(f1.id, f1.secret))?.status === "EXPIRED" && (await user(F.userId)).emailVerifiedAt === null);

  console.log("\n— 6. reset —");
  const notBcrypt = await reset(r1.id, r1.secret, "plain-password");
  ok("only a bcrypt hash is accepted (the plain password never reaches the database)", refused(notBcrypt, INVALID_ARG), String(notBcrypt));
  const r2 = await issue(A.userId, "PASSWORD_RESET");
  ok("issuing again supersedes the earlier reset link", (await check(r1.id, r1.secret, "PASSWORD_RESET")) === "SUPERSEDED");
  const beforeA = await user(A.userId);
  const beforeB = await user(B.userId);
  const wrongR = rows(await reset(r2.id, secret(), BCRYPT_B))[0];
  ok("a wrong secret: INVALID, password unchanged, sessions intact",
    wrongR?.status === "INVALID" && (await user(A.userId)).password === beforeA.password && (await openSessions(A.userId)) === 2);
  ok("a verify link cannot reset", rows(await reset(v1.id, v1.secret, BCRYPT_B))[0]?.status === "INVALID");
  const goodR = rows(await reset(r2.id, r2.secret, BCRYPT_B))[0];
  const afterA = await user(A.userId);
  ok("the right secret: RESET for that user", goodR?.status === "RESET" && Number(goodR?.user_id) === A.userId, JSON.stringify(goodR));
  ok("…the new hash is set", afterA.password === BCRYPT_B);
  ok("…tokenVersion is bumped (every access token dies)", Number(afterA.tokenVersion) === Number(beforeA.tokenVersion) + 1);
  ok("…every open refresh session is revoked", (await openSessions(A.userId)) === 0);
  const reason = ((await owner.$queryRawUnsafe(`SELECT DISTINCT "revokedReason" AS r FROM "AuthSession" WHERE "userId" = $1`, A.userId)) as Rows).map((r) => r.r);
  ok("…with reason password_reset", reason.length === 1 && reason[0] === "password_reset", JSON.stringify(reason));
  ok("…B's password, tokenVersion and sessions are untouched",
    (await user(B.userId)).password === beforeB.password && Number((await user(B.userId)).tokenVersion) === Number(beforeB.tokenVersion) && (await openSessions(B.userId)) === 1);
  ok("replaying the link: USED, password stays", rows(await reset(r2.id, r2.secret, BCRYPT_A))[0]?.status === "USED" && (await user(A.userId)).password === BCRYPT_B);
  const G = await account("aet-reset-verifies");
  const g1 = await issue(G.userId, "PASSWORD_RESET");
  rows(await reset(g1.id, g1.secret, BCRYPT_B));
  ok("a reset proves control of the address: emailVerifiedAt stamped", (await user(G.userId)).emailVerifiedAt instanceof Date);
  const H = await account("aet-reset-deleting");
  const h1 = await issue(H.userId, "PASSWORD_RESET");
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, H.businessId);
  ok("a business entering deletion cannot reset (INVALID, password unchanged)",
    rows(await reset(h1.id, h1.secret, BCRYPT_B))[0]?.status === "INVALID" && (await user(H.userId)).password === BCRYPT_A);
  ok("an expired reset link: EXPIRED, password unchanged",
    rows(await reset(e1.id, e1.secret, BCRYPT_B))[0]?.status === "EXPIRED" && (await user(E.userId)).password === BCRYPT_A);

  console.log("\n— 7. tenant plane (erasure) —");
  const bTok = await issue(B.userId, "PASSWORD_RESET");
  for (const col of ["tokenHash", "email", "userId", "purpose", "expiresAt", "consumedAt"]) {
    const r = await q(runtime, A.businessId, `SELECT "${col}" FROM ${T}`);
    ok(`app_runtime cannot read ${col}, even in its own tenant`, refused(r, DENIED), String(r));
  }
  const seenA = rows(await q(runtime, A.businessId, `SELECT "id","businessId" FROM ${T}`));
  ok("app_runtime sees only its own tenant's token ids", seenA.length > 0 && seenA.every((r) => Number(r.businessId) === A.businessId));
  ok("…and nothing without a tenant context", rows(await q(runtime, null, `SELECT "id" FROM ${T}`)).length === 0);
  const rtIns = await x(runtime, A.businessId, `INSERT INTO ${T} ("id","userId","businessId","purpose","email","tokenHash","createdAt","expiresAt") VALUES ($1::uuid,$2,$3,'PASSWORD_RESET',$4,$5,now(),now() + interval '1 hour')`, randomUUID(), A.userId, A.businessId, A.email, sha("rt"));
  ok("app_runtime cannot INSERT", refused(rtIns, DENIED), String(rtIns));
  const rtUpd = await x(runtime, A.businessId, `UPDATE ${T} SET "consumedAt" = now()`);
  ok("app_runtime cannot UPDATE", refused(rtUpd, DENIED), String(rtUpd));
  const crossDel = await x(runtime, A.businessId, `DELETE FROM ${T} WHERE "businessId" = $1`, B.businessId);
  ok("a cross-tenant DELETE removes nothing", crossDel === 0, String(crossDel));
  const erased = await x(runtime, A.businessId, `DELETE FROM ${T} WHERE "businessId" = $1`, A.businessId);
  ok("erasure inside tenant A deletes A's tokens", typeof erased === "number" && erased > 0, String(erased));
  const left = ((await owner.$queryRawUnsafe(`SELECT count(*) FILTER (WHERE "businessId" = $1)::int AS a, count(*) FILTER (WHERE "businessId" = $2)::int AS b FROM ${T}`, A.businessId, B.businessId)) as Rows)[0];
  ok("…none of A's remain and B's survive", Number(left.a) === 0 && Number(left.b) >= 1, JSON.stringify(left));
  ok("…B's link still works", (await check(bTok.id, bTok.secret, "PASSWORD_RESET")) === "VALID");

  console.log("\n— 8. constraints and cascade —");
  const base = (purpose: string, hash: string, life: string) =>
    x(owner, null, `INSERT INTO ${T} ("id","userId","businessId","purpose","email","tokenHash","createdAt","expiresAt") VALUES ($1::uuid,$2,$3,$4,$5,$6,now(),now() + interval '${life}')`,
      randomUUID(), B.userId, B.businessId, purpose, B.email, hash);
  ok("purpose vocabulary is enforced", refused(await base("LOGIN", sha("c1"), "1 hour"), CHECK));
  ok("hash shape is enforced", refused(await base("PASSWORD_RESET", "ABC", "1 hour"), CHECK));
  ok("lifetime is at most 24h", refused(await base("EMAIL_VERIFY", sha("c2"), "25 hours"), CHECK));
  await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, C.userId);
  const cLeft = ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM ${T} WHERE "userId" = $1`, C.userId)) as Rows)[0];
  ok("deleting a user removes its tokens (cascade)", Number(cLeft.c) === 0);

  console.log(`\n[auth-email-tokens-battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect()]); });
