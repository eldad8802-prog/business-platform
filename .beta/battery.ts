/**
 * Beta cohort enrollment — what migration 20261017090000_beta_cohort_enrollment does, measured with the
 * real role topology on a Production-shaped database:
 *   owner   (lab_owner: the migration role),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane),
 *   auth    (beta_auth_login: NOSUPERUSER NOBYPASSRLS, member of app_auth — the signup plane).
 *
 *   1. Nothing backfilled: every business that existed before has no row. FORCE RLS on; PUBLIC nothing.
 *   2. Signup plane: inserts a CLOSED_BETA_SIGNUP row (no RETURNING) — and nothing else: another source is
 *      refused by its policy, a second row for the same business by the key, a missing business by the
 *      foreign key; it can never read, change or remove a row.
 *   3. Tenant plane: reads ITS OWN row only — another tenant's row is invisible, nothing without a tenant
 *      context; it can never add, change or remove a row (a business can neither enroll nor leave).
 *   4. Constraints: cohort format, source vocabulary. Business deletion cascades to its enrollment.
 *
 * env: OWNER_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network. Raw SQL only: PR-1 ships no
 * schema.prisma change (migration-first).
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
const FK = /foreign key|23503/i;

const T = `"BusinessBetaEnrollment"`;
const INS = `INSERT INTO ${T} ("businessId","cohort","source","createdAt") VALUES ($1,$2,$3,now())`;

async function main() {
  const mk = async (name: string) =>
    ((await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, name)) as { id: number }[])[0].id;

  // 1 ─ nothing backfilled, RLS forced, PUBLIC nothing
  const before = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "Business"`)) as { c: number }[];
  const rows0 = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM ${T}`)) as { c: number }[];
  ok(`1a no backfill: ${before[0].c} existing businesses, 0 enrolled`, rows0[0].c === 0);
  const rls = (await owner.$queryRawUnsafe(
    `SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE relname = 'BusinessBetaEnrollment'`)) as { e: boolean; f: boolean }[];
  ok("1b RLS enabled and forced", rls[0]?.e === true && rls[0]?.f === true);
  const pub = (await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relname = 'BusinessBetaEnrollment' AND a.grantee = 0`)) as { c: number }[];
  ok("1c PUBLIC holds nothing", pub[0].c === 0);

  const A = await mk("beta lab A");
  const B = await mk("beta lab B");
  const C = await mk("beta lab C (existing, never enrolled)");

  // 2 ─ signup plane
  ok("2a app_auth inserts a closed-beta row (no RETURNING)", n(await x(auth, null, INS, A, "closed-beta", "CLOSED_BETA_SIGNUP")) === 1);
  const otherSource = await x(auth, null, INS, B, "closed-beta", "ADMIN_GRANT");
  ok("2b app_auth: another source is refused (policy / CHECK)", refused(otherSource, RLS) || refused(otherSource, CHECK), String(otherSource));
  ok("2c app_auth: a second row for the same business is refused", refused(await x(auth, null, INS, A, "closed-beta", "CLOSED_BETA_SIGNUP"), UNIQUE));
  ok("2d app_auth: a missing business is refused", refused(await x(auth, null, INS, 999999, "closed-beta", "CLOSED_BETA_SIGNUP"), FK));
  ok("2e app_auth cannot read", refused(await q(auth, null, `SELECT * FROM ${T}`), DENIED));
  ok("2f app_auth cannot read even with RETURNING", refused(await q(auth, null, `${INS} RETURNING "businessId"`, B, "closed-beta", "CLOSED_BETA_SIGNUP"), DENIED));
  ok("2g app_auth cannot change", refused(await x(auth, null, `UPDATE ${T} SET "cohort" = 'x-y'`), DENIED));
  ok("2h app_auth cannot remove", refused(await x(auth, null, `DELETE FROM ${T}`), DENIED));
  ok("2i app_auth cannot truncate", refused(await x(auth, null, `TRUNCATE ${T}`), DENIED));

  // 3 ─ tenant plane
  const own = await q(runtime, A, `SELECT "businessId", "cohort" FROM ${T}`);
  ok("3a runtime in A's context reads A's row", n(own) === 1 && Number((own as Rows)[0].businessId) === A);
  ok("3b runtime in B's context sees nothing (B not enrolled; A's row invisible)", n(await q(runtime, B, `SELECT * FROM ${T}`)) === 0);
  ok("3c runtime in B's context cannot see A's row even by key", n(await q(runtime, B, `SELECT * FROM ${T} WHERE "businessId" = $1`, A)) === 0);
  ok("3d runtime with no tenant context sees nothing", n(await q(runtime, null, `SELECT * FROM ${T}`)) === 0);
  ok("3e runtime cannot enroll its own business", refused(await x(runtime, B, INS, B, "closed-beta", "CLOSED_BETA_SIGNUP"), DENIED));
  ok("3f runtime cannot change its enrollment", refused(await x(runtime, A, `UPDATE ${T} SET "cohort" = 'x-y'`), DENIED));
  ok("3g runtime cannot leave the beta (no removal)", refused(await x(runtime, A, `DELETE FROM ${T}`), DENIED));
  ok("3h runtime cannot truncate", refused(await x(runtime, A, `TRUNCATE ${T}`), DENIED));
  ok("3i business C (never enrolled) reads no row", n(await q(runtime, C, `SELECT * FROM ${T}`)) === 0);

  // 4 ─ constraints + cascade
  ok("4a cohort format is checked", refused(await x(owner, null, INS, B, "Closed Beta", "CLOSED_BETA_SIGNUP"), CHECK));
  ok("4b source vocabulary is checked", refused(await x(owner, null, INS, B, "closed-beta", "OTHER"), CHECK));
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = $1`, A);
  ok("4c removing the business removes its enrollment (cascade)",
    ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM ${T} WHERE "businessId" = $1`, A)) as { c: number }[])[0].c === 0);
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = ANY($1::int[])`, [B, C]);

  console.log(`\nbeta cohort enrollment battery: ${pass} PASS, ${failures.length} FAIL`);
  await Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect()]);
  if (failures.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
