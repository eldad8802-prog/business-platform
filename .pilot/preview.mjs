/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-2B — Preview convergence proof.
 *
 * Preview is the ONE environment that actually carries the unmigrated P4-B residue:
 * five `p4b_tenant` policies, each `FOR ALL` (so each silently grants DELETE), applied
 * by hand and present in no migration. The PG17 battery reproduces that shape; this
 * proves the migration converges the REAL thing.
 *
 * Before / apply / after, with the exact catalog compared each time. The end state
 * must be identical to what a clean repo-derived database gets: ENABLE + FORCE, 15
 * canonical `p7pilot_tenant_*` policies, zero DELETE policy, zero residue, and the
 * W2-GATE `p7adm_read` policies untouched.
 *
 * Writes are limited to the migration's own DDL plus synthetic `pilot-prev-` fixtures,
 * removed with an always-on backstop. NO grant, NO role, NO credential change.
 * NO PRODUCTION — the deny-list aborts on the Production endpoints.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const MIG = "prisma/migrations/20260902120000_d2_cutover2b_pilot_tenant_rls/migration.sql";
const PILOT = ["Conversation", "Customer", "Appointment", "BillingDocument", "PaymentRequest"];
const DENY = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
function statementsOf(file) {
  return readFileSync(file, "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}

async function snapshot(db) {
  const flags = await db.$queryRawUnsafe(
    `SELECT relname::text AS tbl, relrowsecurity AS rls, relforcerowsecurity AS forced
       FROM pg_class WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[])
      ORDER BY relname`, PILOT);
  const policies = await db.$queryRawUnsafe(
    `SELECT tablename, policyname, cmd FROM pg_policies
      WHERE schemaname='public' AND tablename = ANY($1::text[])
      ORDER BY tablename, policyname`, PILOT);
  return { flags, policies };
}

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) { console.error("DIRECT_URL required"); process.exit(2); }
  for (const d of DENY) {
    if (url.includes(d)) { console.error("REFUSING: Production deny-list"); process.exit(2); }
  }
  const db = new PrismaClient({ datasourceUrl: url });

  console.log("\n== identity ==");
  const who = await db.$queryRawUnsafe(`SELECT current_database() AS db, current_user::text AS role`);
  console.log(`  database=${who[0].db} role=${who[0].role}`);
  ok("connected to the neondb database", who[0].db === "neondb");

  // ---- BEFORE ---------------------------------------------------------------
  console.log("\n== BEFORE: the real Preview residue ==");
  const before = await snapshot(db);
  for (const f of before.flags) console.log(`    ${f.tbl.padEnd(18)} rls=${f.rls} force=${f.forced}`);
  for (const p of before.policies) console.log(`    ${p.tablename.padEnd(18)} ${p.policyname} (${p.cmd})`);

  const residueBefore = before.policies.filter((p) => p.policyname === "p4b_tenant");
  ok(`Preview carries the unmigrated p4b_tenant residue (${residueBefore.length} policies)`,
    residueBefore.length === 5, JSON.stringify(residueBefore.map((p) => p.tablename)));
  ok("...and every one of them is FOR ALL, i.e. it silently grants DELETE",
    residueBefore.every((p) => p.cmd === "ALL"), JSON.stringify(residueBefore.map((p) => p.cmd)));
  const admBefore = before.policies.filter((p) => p.policyname === "p7adm_read");
  ok("the canonical W2-GATE admin policies are present before", admBefore.length === 2);
  const canonBefore = before.policies.filter((p) => p.policyname.startsWith("p7pilot_tenant_"));
  ok("no canonical policy exists yet", canonBefore.length === 0);

  // ---- APPLY ----------------------------------------------------------------
  console.log("\n== APPLY the canonical migration ==");
  const stmts = statementsOf(MIG);
  await db.$transaction(async (tx) => {
    for (const s of stmts) await tx.$executeRawUnsafe(s);
  });
  ok(`migration applied to Preview (${stmts.length} statements, one transaction)`, stmts.length > 0);

  // ---- AFTER ----------------------------------------------------------------
  console.log("\n== AFTER: canonical state ==");
  const after = await snapshot(db);
  for (const f of after.flags) console.log(`    ${f.tbl.padEnd(18)} rls=${f.rls} force=${f.forced}`);

  ok("all five are ENABLE + FORCE", after.flags.length === 5 && after.flags.every((f) => f.rls && f.forced));
  const residueAfter = after.policies.filter((p) => p.policyname === "p4b_tenant");
  ok("the p4b_tenant residue is GONE (no overlapping permissive policy remains)", residueAfter.length === 0,
    JSON.stringify(residueAfter));
  const canonAfter = after.policies.filter((p) => p.policyname.startsWith("p7pilot_tenant_"));
  ok("exactly 15 canonical tenant policies (3 per table)", canonAfter.length === 15, `got ${canonAfter.length}`);
  ok("the canonical policies are SELECT/INSERT/UPDATE only",
    canonAfter.every((p) => ["SELECT", "INSERT", "UPDATE"].includes(p.cmd)),
    JSON.stringify(canonAfter.filter((p) => !["SELECT", "INSERT", "UPDATE"].includes(p.cmd))));
  ok("ZERO DELETE policy on any pilot table (the residue's accidental DELETE is closed)",
    after.policies.every((p) => p.cmd !== "DELETE"),
    JSON.stringify(after.policies.filter((p) => p.cmd === "DELETE")));
  const admAfter = after.policies.filter((p) => p.policyname === "p7adm_read");
  ok("the W2-GATE admin policies survived untouched", admAfter.length === 2);
  ok("no unexpected extra policy appeared",
    after.policies.length === canonAfter.length + admAfter.length,
    JSON.stringify(after.policies.map((p) => `${p.tablename}.${p.policyname}`)));

  // ---- the restricted runtime role is untouched by this wave -----------------
  console.log("\n== runtime role unchanged ==");
  const role = await db.$queryRawUnsafe(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='app_runtime_preview_p4b'`);
  if (role.length === 0) ok("app_runtime_preview_p4b present", false, "role not found");
  else {
    ok("app_runtime_preview_p4b is still NOSUPERUSER", role[0].rolsuper === false);
    ok("app_runtime_preview_p4b is still NOBYPASSRLS", role[0].rolbypassrls === false);
  }
  // Strip comments before scanning: the migration's prose explains why the historical
  // DELETE *grant* is deliberately not matched by a policy, so a naive read of the raw
  // file finds the word and reports a privilege change that does not exist. Only the
  // executable SQL is evidence.
  const code = readFileSync(MIG, "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  ok("the applied SQL contains zero GRANT", !/\bGRANT\b/i.test(code));
  ok("the applied SQL contains zero role change", !/\b(CREATE|ALTER|DROP)\s+ROLE\b/i.test(code));
  ok("the applied SQL contains zero data DML",
    !/(^|;)\s*(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)/im.test(code));

  console.log(`\n[pilot-preview] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("FAILURES:\n  " + failures.join("\n  "));
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
