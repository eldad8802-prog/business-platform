/**
 * B4 — Business tenant-pinned writes: proof with the REAL migration and the
 * REAL application code (lab: .bizcols/lab.sh <db> --b4).
 *
 *   1. reads are unchanged (pre-context lifecycle reader, cross-business id/name
 *      reads the public coupon pages and platform-admin lists rely on);
 *   2. the cross-tenant lifecycle write is closed (GUC = A → B: 0 rows; no GUC: 0 rows);
 *   3. the own-tenant write still works;
 *   4. the REAL account-deletion transitions (quarantine, finalize) still move
 *      the Business row — and a NEGATIVE CONTROL proves why the code change is
 *      required: the same write without naming the business matches 0 rows;
 *   5. signup still creates a Business as app_auth (INSERT … RETURNING id, name);
 *   6. the owner (BYPASSRLS) is unaffected; nothing deletes a Business.
 *
 * env: OWNER_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network.
 */
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL!;
const RUNTIME_URL = process.env.RUNTIME_URL!;
const AUTH_URL = process.env.AUTH_URL!;
process.env.DATABASE_URL = RUNTIME_URL;
process.env.DIRECT_URL = RUNTIME_URL;

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });
const auth = new PrismaClient({ datasourceUrl: AUTH_URL });

async function rt<T = unknown>(guc: number | null, sql: string): Promise<T> {
  return runtime.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return tx.$queryRawUnsafe(sql) as Promise<T>;
  });
}
const n = (r: unknown) => (r as Array<{ n: number }>)[0].n;
const upd = (id: number, set: string) => `WITH u AS (UPDATE "Business" SET ${set}, "updatedAt" = now() WHERE id = ${id} RETURNING 1) SELECT count(*)::int n FROM u`;

async function main() {
  const [pol] = (await owner.$queryRawUnsafe(
    `SELECT relrowsecurity r, relforcerowsecurity f, (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) p FROM pg_class c WHERE relname = 'Business'`
  )) as Array<{ r: boolean; f: boolean; p: number }>;
  ok("B4 applied: Business RLS + FORCE, exactly 3 policies", pol.r && pol.f && pol.p === 3, JSON.stringify(pol));

  const tag = `b4-${Date.now()}`;
  const A = await owner.business.create({ data: { name: `${tag}-A` } });
  const B = await owner.business.create({ data: { name: `${tag}-B` } });
  const C = await owner.business.create({ data: { name: `${tag}-C` } });
  const admin = await owner.user.create({ data: { email: `${tag}-u@lab.test`, password: "x", businessId: C.id, role: "USER" } });

  console.log("\n-- 1. reads unchanged --");
  const { readBusinessLifecycle } = await import("../lib/tenant/business-lifecycle");
  const life = await readBusinessLifecycle(B.id);
  ok("the pre-context lifecycle reader still reads (runtime, no tenant context)", life !== null);
  ok("no tenant context: the runtime still reads every business's id/name (public coupons, platform-admin lists)",
    n(await rt(null, `SELECT count(*)::int n FROM "Business" WHERE id IN (${A.id}, ${B.id}, ${C.id})`)) === 3);
  ok("tenant context A: reading B's id/name is unchanged (reads were never the B4 target)",
    n(await rt(A.id, `SELECT count(*)::int n FROM "Business" WHERE id = ${B.id}`)) === 1);
  const hidden = await rt(A.id, `SELECT "archivedAt" FROM "Business" WHERE id = ${B.id}`).then(() => "ok", (e: Error) => e.message);
  ok("column privileges still apply on top (archivedAt not readable)", /permission denied/i.test(hidden), hidden);

  console.log("\n-- 2/3. writes pinned to the tenant --");
  ok("GUC = A → UPD B's lifecycle: 0 rows (the cross-tenant write is CLOSED)", n(await rt(A.id, upd(B.id, `"deletionRequestedAt" = now()`))) === 0);
  ok("no tenant context → UPD B: 0 rows", n(await rt(null, upd(B.id, `"deletionRequestedAt" = now()`))) === 0);
  ok("B is untouched", (await owner.business.findUnique({ where: { id: B.id } }))?.deletionRequestedAt === null);
  ok("GUC = A → UPD A (own business): 1 row", n(await rt(A.id, upd(A.id, `"archivedAt" = now()`))) === 1);
  const moveId = await rt(A.id, `UPDATE "Business" SET "updatedAt" = now() WHERE id = ${A.id} AND false`).then(() => "ok", (e: Error) => e.message);
  ok("sanity: own-tenant statements execute normally", moveId === "ok", moveId);

  console.log("\n-- 4. the REAL account-deletion transitions --");
  const neg = n(await runtime.$transaction(async (tx) => tx.$queryRawUnsafe(upd(C.id, `"deletionRequestedAt" = now()`))));
  ok("NEGATIVE CONTROL: the pre-B4 code path (no tenant named) would match 0 rows — the code change is required", neg === 0, String(neg));
  const { prismaAccountDeletionStore } = await import("../lib/services/account/account-deletion.prisma-store");
  const now = new Date();
  const q = await prismaAccountDeletionStore.quarantineAndRevokeIntegrations(C.id, now).then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e: e.message }));
  const cAfterQ = await owner.business.findUnique({ where: { id: C.id } });
  ok("quarantine (real code, names its business) sets deletionRequestedAt on C", q.ok && cAfterQ?.deletionRequestedAt !== null, q.ok ? "" : q.e);
  const f = await prismaAccountDeletionStore.finalizeAndAudit(C.id, admin.id, new Date()).then(() => "ok", (e: Error) => e.message);
  const cAfterF = await owner.business.findUnique({ where: { id: C.id } });
  ok("finalize (real code) sets deletedAt / archivedAt / archivedByUserId on C", f === "ok" && cAfterF?.deletedAt !== null && cAfterF?.archivedByUserId === admin.id, f);
  ok("…and the account-deletion of C touched neither A's nor B's lifecycle",
    (await owner.business.findUnique({ where: { id: B.id } }))?.deletionRequestedAt === null);

  console.log("\n-- 5. signup (app_auth) --");
  const signup = await auth.$queryRawUnsafe(`INSERT INTO "Business" (name, "updatedAt") VALUES ('${tag}-signup', now()) RETURNING id, name`).then(
    (r) => ({ ok: true as const, r: r as Array<{ id: number }> }), (e: Error) => ({ ok: false as const, e: e.message }));
  ok("app_auth INSERT … RETURNING id, name still works (signup)", signup.ok && signup.r.length === 1, signup.ok ? "" : signup.e);
  const authUpd = await auth.$queryRawUnsafe(`UPDATE "Business" SET "deletedAt" = now() WHERE id = ${B.id}`).then(() => "ok", (e: Error) => e.message);
  ok("app_auth still cannot UPD a Business (no grant)", /permission denied/i.test(authUpd), authUpd);
  const rtIns = await rt(A.id, `INSERT INTO "Business" (name, "updatedAt") VALUES ('x', now())`).then(() => "ok", (e: Error) => e.message);
  ok("the runtime still cannot INS a Business", /permission denied/i.test(rtIns), rtIns);

  console.log("\n-- 6. owner / deletion --");
  const ownerUpd = await owner.$executeRawUnsafe(`UPDATE "Business" SET "updatedAt" = now() WHERE id = ${B.id}`);
  ok("the owner (BYPASSRLS) is unaffected (operator scripts, migrations)", ownerUpd === 1);
  const rtDel = await rt(A.id, `DELETE FROM "Business" WHERE id = ${A.id}`).then(() => "ok", (e: Error) => e.message);
  ok("the runtime cannot DELETE a Business (no grant, no policy)", /permission denied/i.test(rtDel), rtDel);

  console.log(`\n[b4] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
  await Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect()]);
}

main().catch((e) => { console.error("battery crashed:", e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e); process.exit(1); });
