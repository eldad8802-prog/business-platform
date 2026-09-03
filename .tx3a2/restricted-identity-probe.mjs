/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-3A.2 — what the restricted identity can and
 * cannot do, measured as the identity itself.
 *
 * 3A.1 proved the same contract by *simulating* the Production grant set. This
 * runs as a real LOGIN role, over the network, through the pooler, against
 * Preview's 87 RLS-enabled tables — a strictly larger blast radius than the five
 * tables Production currently forces.
 *
 * The assertions are chosen around the asymmetry that makes RLS dangerous to
 * verify casually: a context-less READ returns zero rows and raises NOTHING,
 * while a context-less WRITE raises. A probe that only checks for thrown errors
 * would score the silent-zero case as a pass, so reads are asserted on row
 * counts and writes on refusal.
 *
 * Everything it creates is namespaced and deleted on the way out. PREVIEW ONLY.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const url = readFileSync(process.env.REHEARSAL_URL_FILE, "utf8").trim();
const db = new PrismaClient({ datasourceUrl: url });
const TAG = `3a2-probe-${process.env.REHEARSAL_STAMP ?? "x"}`;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function raises(fn) {
  try { await fn(); return null; } catch (e) { return String(e?.message ?? e); }
}

/** One transaction, one GUC — exactly how withTenantTransaction does it. */
function withCtx(businessId, fn) {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(businessId));
    return fn(tx);
  });
}
function withoutCtx(fn) {
  return db.$transaction((tx) => fn(tx));
}

async function main() {
  const who = await db.$queryRawUnsafe(
    `SELECT current_user::text u, current_setting('is_superuser') su,
            (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace
               AND relkind='r' AND relrowsecurity) rls`);
  console.log(`  identity: ${who[0].u}  superuser=${who[0].su}  rls_tables=${who[0].rls}`);
  ok("running as the restricted rehearsal role", who[0].u === "app_runtime_prev_rehearsal");
  ok("not a superuser", who[0].su === "off");

  const attrs = await db.$queryRawUnsafe(
    `SELECT rolbypassrls, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user`);
  ok("NOBYPASSRLS", attrs[0].rolbypassrls === false);
  ok("owns zero relations", (await db.$queryRawUnsafe(
    `SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace
       AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)`))[0].n === 0);

  // ---- the two tenants -------------------------------------------------------
  const biz = await db.$queryRawUnsafe(`SELECT id FROM "Business" ORDER BY id LIMIT 1`);
  // Business itself is under RLS, so read it with context off the known row set.
  const A = biz.length ? biz[0].id : null;
  ok("a Business row is visible to the restricted role", A !== null,
    "Business is RLS-protected and returned nothing without context — expected for a tenant table");
  const B = (A ?? 0) + 999000; // a tenant that does not exist: isolation must still hold

  console.log("\n== READS: the silent-zero asymmetry ==");
  const noCtx = await withoutCtx((tx) =>
    tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "Customer"`));
  ok("context-less SELECT on Customer returns ZERO rows and raises nothing",
    noCtx[0].n === 0, `saw ${noCtx[0].n}`);

  console.log("\n== WRITES: refusal is loud ==");
  const wNoCtx = await raises(() => withoutCtx((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "Customer" ("businessId","name","createdAt","updatedAt")
       VALUES ($1,$2,now(),now())`, A, `${TAG}-nocontext`)));
  ok("context-less INSERT on Customer is REFUSED", wNoCtx !== null && /row-level security/i.test(wNoCtx),
    wNoCtx ? wNoCtx.slice(0, 140) : "no error raised — the write went through");

  if (A !== null) {
    const wCtx = await raises(() => withCtx(A, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Customer" ("businessId","name","createdAt","updatedAt")
         VALUES ($1,$2,now(),now())`, A, `${TAG}-a`)));
    ok("INSERT WITH matching context SUCCEEDS", wCtx === null, wCtx ? wCtx.slice(0, 160) : "");

    // nextval() is reached by that INSERT: USAGE without UPDATE must be enough.
    ok("sequence USAGE without UPDATE is sufficient for INSERT", wCtx === null);

    const wCross = await raises(() => withCtx(A, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Customer" ("businessId","name","createdAt","updatedAt")
         VALUES ($1,$2,now(),now())`, B, `${TAG}-forged`)));
    ok("INSERT claiming tenant A while writing tenant B is REFUSED (WITH CHECK)",
      wCross !== null && /row-level security/i.test(wCross),
      wCross ? wCross.slice(0, 140) : "the forged cross-tenant write was ACCEPTED");

    const seenA = await withCtx(A, (tx) =>
      tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "Customer" WHERE name LIKE $1`, `${TAG}%`));
    ok("tenant A reads its own row back under context", seenA[0].n >= 1, `saw ${seenA[0].n}`);

    const seenB = await withCtx(B, (tx) =>
      tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "Customer" WHERE name LIKE $1`, `${TAG}%`));
    ok("tenant B sees ZERO of tenant A's rows", seenB[0].n === 0, `saw ${seenB[0].n}`);
  }

  console.log("\n== the privileges it must NOT have ==");
  const ledger = await raises(() => db.$queryRawUnsafe(`SELECT count(*) FROM "_prisma_migrations"`));
  ok("cannot read the migration ledger", ledger !== null && /permission denied/i.test(ledger),
    ledger ? ledger.slice(0, 120) : "the ledger was readable");

  const alter = await raises(() => db.$executeRawUnsafe(`ALTER TABLE "Customer" ADD COLUMN "x3a2" TEXT`));
  ok("cannot ALTER an application table", alter !== null, "the ALTER succeeded");

  const seq = await db.$queryRawUnsafe(
    `SELECT count(*) FILTER (WHERE has_sequence_privilege(current_user, s.oid,'UPDATE'))::int upd,
            count(*)::int total
       FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S'`);
  ok(`UPDATE on ZERO of ${seq[0].total} sequences (setval stays impossible)`, seq[0].upd === 0);

  const disable = await raises(() => db.$executeRawUnsafe(`ALTER TABLE "Customer" DISABLE ROW LEVEL SECURITY`));
  ok("cannot disable RLS on a table it does not own", disable !== null, "RLS was disabled");

  // ---- cleanup ---------------------------------------------------------------
  if (A !== null) {
    await withCtx(A, (tx) => tx.$executeRawUnsafe(`DELETE FROM "Customer" WHERE name LIKE $1`, `${TAG}%`))
      .catch((e) => console.log(`  [note] cleanup: ${String(e?.message ?? e).slice(0, 120)}`));
  }

  console.log(`\n[probe] PASS=${pass} FAIL=${fail}`);
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", String(e?.message ?? e).slice(0, 400)); process.exit(1); });
