/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-3A.2 — provision + verify the Preview rehearsal role.
 *
 * Creates, on the PREVIEW branch only:
 *
 *   group  app_runtime                  — the privilege plane Production already has
 *   login  app_runtime_prev_rehearsal   — modelled exactly on the future app_runtime_prod
 *
 * and then verifies the resulting contract against the one measured in Production
 * (3A.1): DML on every application table except the migration ledger, USAGE + SELECT
 * on every sequence with UPDATE on none, schema USAGE without CREATE, membership of
 * app_runtime and nothing else, and ownership of nothing.
 *
 * The password is read from the environment, used once, and never logged. Idempotent:
 * safe to re-run.
 *
 * PREVIEW ONLY — the workflow's deny-list guarantees the target is not Production.
 */
import { PrismaClient } from "@prisma/client";

const ROLE = process.env.RUNTIME_ROLE;
const PW = process.env.RTPW;
const URL_ = process.env.DIRECT_URL;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  if (!URL_ || !ROLE || !PW) { console.error("DIRECT_URL, RUNTIME_ROLE and RTPW are required"); process.exit(2); }
  for (const d of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (URL_.includes(d)) { console.error("REFUSING: Production deny-list"); process.exit(2); }
  }
  const db = new PrismaClient({ datasourceUrl: URL_ });

  const who = await db.$queryRawUnsafe(`SELECT current_database() AS d, current_user::text AS u`);
  console.log(`  target: db=${who[0].d} as=${who[0].u}`);
  ok("connected to neondb", who[0].d === "neondb");

  // ---- 1. the app_runtime privilege plane ----------------------------------
  console.log("\n== 1. app_runtime group + exact grant contract ==");
  await db.$executeRawUnsafe(
    `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN
       CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
     END IF; END $do$`);
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO app_runtime`);
  await db.$executeRawUnsafe(
    `DO $do$ DECLARE t record; BEGIN
       FOR t IN SELECT relname FROM pg_class
                 WHERE relnamespace='public'::regnamespace AND relkind='r'
                   AND relname <> '_prisma_migrations'
       LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_runtime', t.relname);
       END LOOP;
     END $do$`);
  // USAGE + SELECT only — Production grants UPDATE on zero sequences.
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime`);

  // ---- 2. the rehearsal login role ------------------------------------------
  console.log("\n== 2. rehearsal login role ==");
  const exists = await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1`, ROLE);
  if (exists[0].n === 0) {
    // Parameterised DDL is not possible; the password is masked in CI and never printed.
    await db.$executeRawUnsafe(
      `CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
    console.log("  role created");
  } else {
    await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} WITH PASSWORD '${PW}'`);
    // NOSUPERUSER / NOBYPASSRLS / NOREPLICATION can only be *changed* by a
    // superuser, and neondb_owner is not one — re-asserting them on an existing
    // role fails with 42501 even though they are already set. Only the
    // attributes an owner may actually alter are re-asserted here; the three
    // security-critical ones are proven by the verification below instead,
    // which is the stronger check anyway: it measures rather than assumes.
    await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOCREATEROLE NOCREATEDB INHERIT`);
    console.log("  role already existed — password rotated, alterable attributes re-asserted");
  }
  await db.$executeRawUnsafe(`GRANT app_runtime TO ${ROLE}`);

  // ---- 3. verify the contract ----------------------------------------------
  console.log("\n== 3. contract verification ==");
  const a = await db.$queryRawUnsafe(
    `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit
       FROM pg_roles WHERE rolname=$1`, ROLE);
  const A = a[0];
  ok("LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, INHERIT",
    A.rolcanlogin && !A.rolsuper && !A.rolbypassrls && !A.rolcreatedb && !A.rolcreaterole &&
    !A.rolreplication && A.rolinherit, JSON.stringify(A));

  const mem = await db.$queryRawUnsafe(
    `SELECT g.rolname AS m FROM pg_auth_members am
       JOIN pg_roles r ON r.oid=am.member JOIN pg_roles g ON g.oid=am.roleid
      WHERE r.rolname=$1 ORDER BY 1`, ROLE);
  const memNames = mem.map((m) => m.m);
  ok("member of app_runtime and NOTHING else", memNames.length === 1 && memNames[0] === "app_runtime",
    JSON.stringify(memNames));
  for (const forbidden of ["app_admin", "app_ctlplane"]) {
    const h = await db.$queryRawUnsafe(`SELECT pg_has_role($1, $2, 'USAGE') AS m`, ROLE, forbidden);
    ok(`NOT a member of ${forbidden}`, h[0].m === false);
  }

  const owns = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=$1)`, ROLE);
  ok("owns ZERO application relations", owns[0].n === 0);

  const g = await db.$queryRawUnsafe(
    `SELECT
       (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r') AS total_tables,
       (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'
          AND relname='_prisma_migrations') AS ledger,
       (SELECT count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'SELECT'))::int
          FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r') AS can_select,
       (SELECT count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'INSERT'))::int
          FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r') AS can_insert,
       (SELECT count(*) FILTER (WHERE has_sequence_privilege($1, s.oid, 'USAGE'))::int
          FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S') AS seq_usage,
       (SELECT count(*) FILTER (WHERE has_sequence_privilege($1, s.oid, 'UPDATE'))::int
          FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S') AS seq_update,
       (SELECT count(*)::int FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S') AS seq_total,
       has_schema_privilege($1,'public','USAGE') AS schema_usage,
       has_schema_privilege($1,'public','CREATE') AS schema_create`, ROLE);
  const G = g[0];
  const expectedTables = G.total_tables - G.ledger;
  ok(`SELECT on every application table (${G.can_select} of ${G.total_tables}, ledger=${G.ledger})`,
    G.can_select === expectedTables, JSON.stringify(G));
  ok(`INSERT on every application table (${G.can_insert})`, G.can_insert === expectedTables);
  ok(`sequences: USAGE on all ${G.seq_total}, UPDATE on ZERO`,
    G.seq_usage === G.seq_total && G.seq_update === 0, JSON.stringify(G));
  ok("schema USAGE yes, CREATE no", G.schema_usage === true && G.schema_create === false);
  if (G.ledger === 1) {
    const l = await db.$queryRawUnsafe(
      `SELECT has_table_privilege($1,'public."_prisma_migrations"','SELECT') AS r`, ROLE);
    ok("cannot read the migration ledger", l[0].r === false);
  }

  console.log(`\n[provision] PASS=${pass} FAIL=${fail}`);
  console.log(`  ROLE READY: ${ROLE} (password not logged)`);
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", String(e?.message ?? e).slice(0, 300)); process.exit(1); });
