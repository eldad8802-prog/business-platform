/**
 * Business runtime-columns forensic — exposure + options battery
 * (lab: .bizcols/lab.sh — Production topology + the real D2 E4 narrowing).
 *
 * Measures, as the NOSUPERUSER / NOBYPASSRLS runtime login app_runtime_prod:
 *   A. EXPOSURE — what the runtime can read / write on ANOTHER business's row,
 *      with no tenant context, with its own tenant context, with the other
 *      tenant's context (does the GUC change anything?), and through the REAL
 *      lifecycle code (lib/tenant/business-lifecycle.ts).
 *   B. OPTIONS — each tried inside a transaction that is ROLLED BACK (the lab
 *      database is unchanged afterwards):
 *        B1 RLS on Business (tenant policy) — what breaks;
 *        B2 narrower column grants (drop createdAt) — what breaks;
 *        B3 a restricted SECURITY DEFINER lifecycle function instead of column
 *           grants on the lifecycle columns.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network.
 */
import { PrismaClient, Prisma } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL!;
const RUNTIME_URL = process.env.RUNTIME_URL!;
process.env.DATABASE_URL = RUNTIME_URL;
process.env.DIRECT_URL = RUNTIME_URL;

let pass = 0;
const failures: string[] = [];
const facts: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
function fact(s: string) { facts.push(s); console.log(`  [FACT] ${s}`); }
async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: string }> {
  try { return { ok: true, v: await fn() }; } catch (e) {
    const err = e as { code?: string; meta?: { code?: string }; message?: string };
    return { ok: false, e: `${err.meta?.code ?? err.code ?? ""} ${(err.message ?? "").split("\n").filter(Boolean).pop() ?? ""}`.trim() };
  }
}
const isDenied = (r: { ok: boolean; e?: string }) => !r.ok && /permission denied|42501/i.test((r as { e: string }).e);

const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });

async function rt<T = unknown>(guc: number | null, sql: string): Promise<T> {
  return runtime.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return tx.$queryRawUnsafe(sql) as Promise<T>;
  });
}

/** Run a block as the OWNER inside a transaction that is always rolled back. */
async function sandbox(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  const ROLLBACK = new Error("__sandbox_rollback__");
  try {
    await owner.$transaction(async (tx) => { await fn(tx); throw ROLLBACK; }, { timeout: 60_000 });
  } catch (e) { if (e !== ROLLBACK) throw e; }
}

async function main() {
  const [who] = (await runtime.$queryRawUnsafe(`SELECT current_user::text u, rolsuper s, rolbypassrls b FROM pg_roles WHERE rolname = current_user`)) as Array<{ u: string; s: boolean; b: boolean }>;
  ok(`runtime is ${who.u}, NOSUPERUSER NOBYPASSRLS`, !who.s && !who.b);

  const tag = `biz-${Date.now()}`;
  const A = await owner.business.create({ data: { name: `${tag}-A` } });
  const B = await owner.business.create({ data: { name: `${tag}-B-secret-name` } });

  // ── A. exposure ──────────────────────────────────────────────────────────────
  console.log("\n-- A. exposure: another business's row --");
  for (const [label, guc] of [["no tenant context", null], ["own tenant context (A)", A.id], ["the other tenant's context (B)", B.id]] as const) {
    const r = await outcome(() => rt<Array<{ id: number; name: string }>>(guc, `SELECT id, name, "createdAt", "deletionRequestedAt", "deletedAt" FROM "Business" WHERE id = ${B.id}`));
    ok(`A1 [${label}] runtime READS B's five columns (no RLS — the GUC changes nothing)`, r.ok && r.v.length === 1 && r.v[0].name === `${tag}-B-secret-name`, r.ok ? "" : r.e);
  }
  const allRows = await rt<Array<{ n: number }>>(A.id, `SELECT count(*)::int n FROM "Business"`);
  ok("A2 runtime (GUC = A) can enumerate EVERY business (count = all rows)", allRows[0].n === (await owner.business.count()), String(allRows[0].n));
  const hidden = await outcome(() => rt(A.id, `SELECT "archivedAt" FROM "Business" WHERE id = ${B.id}`));
  ok("A3 runtime cannot read a column outside the five (archivedAt) — 42501", isDenied(hidden), hidden.ok ? "allowed!" : hidden.e);
  const star = await outcome(() => rt(A.id, `SELECT * FROM "Business" WHERE id = ${B.id}`));
  ok("A4 SELECT * is refused (column privilege, not row filtering)", isDenied(star));

  const wr = await outcome(() => rt<unknown>(A.id, `UPDATE "Business" SET "deletionRequestedAt" = now(), "updatedAt" = now() WHERE id = ${B.id} RETURNING id`));
  const bAfter = await owner.business.findUnique({ where: { id: B.id }, select: { deletionRequestedAt: true } });
  if (wr.ok && bAfter?.deletionRequestedAt) {
    fact(`A5 runtime with GUC = A SUCCESSFULLY set deletionRequestedAt on business B (cross-tenant write — column UPD + no RLS)`);
    ok("A5 cross-tenant lifecycle write is POSSIBLE at the database layer (finding, not a pass/fail of the lab)", true);
    await owner.business.update({ where: { id: B.id }, data: { deletionRequestedAt: null } });
  } else {
    ok("A5 cross-tenant lifecycle write refused", true, wr.ok ? "" : wr.e);
  }
  const wrName = await outcome(() => rt(A.id, `UPDATE "Business" SET name = 'pwned' WHERE id = ${B.id}`));
  ok("A6 runtime cannot rename another (or any) business — name is not writable", isDenied(wrName));

  const { readBusinessLifecycle } = await import("../lib/tenant/business-lifecycle");
  const life = await outcome(() => readBusinessLifecycle(B.id));
  ok("A7 the REAL lifecycle reader (runtime client, no context) reads B's lifecycle — it is designed to run before a tenant exists",
    life.ok && life.v !== null, life.ok ? JSON.stringify(life.v) : life.e);

  // ── B. options (each rolled back) ────────────────────────────────────────────
  console.log("\n-- B1. option: RLS on Business (tenant policy) --");
  await sandbox(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "Business" ENABLE ROW LEVEL SECURITY`);
    await tx.$executeRawUnsafe(`ALTER TABLE "Business" FORCE ROW LEVEL SECURITY`);
    await tx.$executeRawUnsafe(`CREATE POLICY lab_biz_tenant ON "Business" FOR ALL USING (id = NULLIF(current_setting('app.current_business_id', true), '')::int) WITH CHECK (id = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
    // evaluate as the runtime INSIDE this owner transaction: SET LOCAL ROLE.
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_runtime`);
    const own = (await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', '${A.id}', true); `).then(() => tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "Business"`))) as Array<{ n: number }>;
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '', true)`);
    const none = (await tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "Business" WHERE id = ${A.id}`)) as Array<{ n: number }>;
    ok("B1a with tenant RLS: GUC = A sees exactly its own business", own[0].n === 1, String(own[0].n));
    ok("B1b with tenant RLS: NO tenant context sees nothing — so login/session/signup lifecycle reads (which run before a GUC) would see no business", none[0].n === 0, String(none[0].n));
    fact("B1 RLS(id = GUC) closes cross-tenant reads/writes, but breaks every pre-context read: readBusinessLifecycle/assertBusinessAcceptsWrites (runTenantJob, webhooks, settlement cron, intake sweeper), session/login (legacy auth mode), public coupon pages (other businesses' names), platform-admin lists on the runtime client");
  });

  console.log("\n-- B2. option: narrower column grants --");
  await sandbox(async (tx) => {
    await tx.$executeRawUnsafe(`REVOKE SELECT ("createdAt") ON "Business" FROM app_runtime`);
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_runtime`);
    const r = await tx.$queryRawUnsafe(`SELECT id, name FROM "Business" WHERE id = ${B.id}`).then(() => "ok", (e: Error) => e.message);
    const c = await tx.$queryRawUnsafe(`SELECT id FROM "Business" ORDER BY "createdAt" LIMIT 1`).then(() => "ok", (e: Error) => e.message);
    ok("B2a without createdAt, id/name reads still work", r === "ok", r);
    ok("B2b …but ORDER BY / SELECT createdAt (platform-admin lists on the runtime client) fails — those reads must move to the admin path first", /permission denied/i.test(c), c);
  });

  console.log("\n-- B3. option: a restricted SECURITY DEFINER lifecycle function --");
  await sandbox(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE FUNCTION public.lab_business_lifecycle(p_id int)
      RETURNS TABLE ("deletionRequestedAt" timestamp(3), "deletedAt" timestamp(3))
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
      AS $f$ SELECT b."deletionRequestedAt", b."deletedAt" FROM public."Business" b WHERE b.id = p_id $f$`);
    await tx.$executeRawUnsafe(`REVOKE ALL ON FUNCTION public.lab_business_lifecycle(int) FROM PUBLIC`);
    await tx.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION public.lab_business_lifecycle(int) TO app_runtime`);
    await tx.$executeRawUnsafe(`REVOKE SELECT ("deletionRequestedAt", "deletedAt") ON "Business" FROM app_runtime`);
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_runtime`);
    const viaFn = (await tx.$queryRawUnsafe(`SELECT * FROM public.lab_business_lifecycle(${B.id})`)) as unknown[];
    const direct = await tx.$queryRawUnsafe(`SELECT "deletedAt" FROM "Business" WHERE id = ${B.id}`).then(() => "ok", (e: Error) => e.message);
    ok("B3a the function answers the lifecycle question for one id (a point lookup, no enumeration)", viaFn.length === 1);
    ok("B3b the runtime can no longer read the lifecycle columns directly", /permission denied/i.test(direct), direct);
    fact("B3 a SECURITY DEFINER point-lookup removes direct column reads of the lifecycle fields but still answers for ANY id passed (cross-tenant by design, same trust as today); it does not address name/createdAt or the UPD grants");
  });

  console.log("\n-- B4. option: RLS that keeps every read but pins WRITES to the tenant --");
  await sandbox(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "Business" ENABLE ROW LEVEL SECURITY`);
    await tx.$executeRawUnsafe(`ALTER TABLE "Business" FORCE ROW LEVEL SECURITY`);
    await tx.$executeRawUnsafe(`CREATE POLICY lab_biz_read ON "Business" FOR SELECT USING (true)`);
    await tx.$executeRawUnsafe(`CREATE POLICY lab_biz_write ON "Business" FOR UPDATE USING (id = NULLIF(current_setting('app.current_business_id', true), '')::int) WITH CHECK (id = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
    await tx.$executeRawUnsafe(`CREATE POLICY lab_biz_signup ON "Business" FOR INSERT TO app_auth WITH CHECK (true)`);
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_runtime`);
    const reads = (await tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "Business"`)) as Array<{ n: number }>;
    ok("B4a pre-context reads unchanged: no GUC still reads every business's five columns (login/lifecycle/coupons keep working)", reads[0].n >= 2, String(reads[0].n));
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${A.id}', true)`);
    const cross = (await tx.$queryRawUnsafe(`WITH u AS (UPDATE "Business" SET "deletionRequestedAt" = now(), "updatedAt" = now() WHERE id = ${B.id} RETURNING 1) SELECT count(*)::int n FROM u`)) as Array<{ n: number }>;
    const own = (await tx.$queryRawUnsafe(`WITH u AS (UPDATE "Business" SET "deletionRequestedAt" = now(), "updatedAt" = now() WHERE id = ${A.id} RETURNING 1) SELECT count(*)::int n FROM u`)) as Array<{ n: number }>;
    ok("B4b GUC = A: the cross-tenant lifecycle write on B now touches 0 rows", cross[0].n === 0, String(cross[0].n));
    ok("B4c GUC = A: the own-tenant lifecycle write still works", own[0].n === 1, String(own[0].n));
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '', true)`);
    const noCtx = (await tx.$queryRawUnsafe(`WITH u AS (UPDATE "Business" SET "deletedAt" = now(), "updatedAt" = now() WHERE id = ${A.id} RETURNING 1) SELECT count(*)::int n FROM u`)) as Array<{ n: number }>;
    ok("B4d with NO tenant context a lifecycle write touches 0 rows — account deletion's two Business writes (today deliberately outside the tenant context) would have to set the GUC for their own business first", noCtx[0].n === 0, String(noCtx[0].n));
    fact("B4 closes the cross-tenant WRITE (the real risk) while keeping every read path working; it requires account-deletion's quarantine/finalize Business writes to run with app.current_business_id = their own business (a code change) and an INSERT policy for signup (app_auth)");
  });

  // the sandbox really rolled back
  const rlsNow = (await owner.$queryRawUnsafe(`SELECT relrowsecurity r FROM pg_class WHERE relname = 'Business'`)) as Array<{ r: boolean }>;
  const fnNow = (await owner.$queryRawUnsafe(`SELECT count(*)::int n FROM pg_proc WHERE proname = 'lab_business_lifecycle'`)) as Array<{ n: number }>;
  ok("every option was rolled back (no RLS, no function, grants as the migration left them)", !rlsNow[0].r && fnNow[0].n === 0 &&
    (await rt<Array<{ n: number }>>(null, `SELECT count(*)::int n FROM "Business" WHERE "createdAt" IS NOT NULL`))[0].n >= 2);

  console.log(`\n[bizcols] PASS=${pass} FAIL=${failures.length}`);
  console.log("FACTS:\n - " + facts.join("\n - "));
  if (failures.length) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
  await Promise.all([owner.$disconnect(), runtime.$disconnect()]);
}

main().catch((e) => { console.error("battery crashed:", e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e); process.exit(1); });
