/**
 * sec(C) — (1) M-14(b) default-deny for new tables, and (2) the read-only
 * production catalog evidence (ops/evidence/security-catalog-assert.sql) proved
 * GREEN on a fresh lab and RED — naming the offender — on deliberately broken labs.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { newLab, dropLab, psql, psqlFile, q, ROOT, PSQL } from "../lab.mjs";
import { ok, section } from "../common";

const ASSERT = path.join(ROOT, "ops/evidence/security-catalog-assert.sql");
const DEFPRIV = path.join(ROOT, "ops/security/sec-c-default-privileges.sql");
const OWNER = new URL(process.env.SECC_PG_URL!).username;

type Row = { id: string; result: string; failing: string; detail: string };
function assertCatalog(url: string): Map<string, Row> {
  const r = spawnSync(PSQL, [url, "-X", "-q", "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", "-f", ASSERT], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`catalog assert crashed: ${r.stderr}`);
  const m = new Map<string, Row>();
  for (const line of r.stdout.split("\n").filter((l) => /^A\d/.test(l))) {
    const [id, result, failing, , detail] = line.split("|");
    m.set(id, { id, result, failing, detail: detail ?? "" });
  }
  return m;
}
const allPass = (m: Map<string, Row>) => [...m.values()].every((r) => r.result === "PASS");
const failing = (m: Map<string, Row>) => [...m.values()].filter((r) => r.result !== "PASS").map((r) => `${r.id}[${r.detail}]`);

const runtimeCan = (url: string, table: string) =>
  q(url, `SELECT string_agg(p, ',') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE has_table_privilege('app_runtime', '${table}', p)`);

void section("catalog", async () => {
  // ── M-14(b) default privileges ─────────────────────────────────────────────
  {
    const lab = await newLab("defpriv");
    psql(lab.ownerUrl, `CREATE TABLE secc_probe_fresh (id int)`);
    ok("M14b fresh lab: a newly created table is NOT accessible to the runtime", runtimeCan(lab.ownerUrl, "secc_probe_fresh") === "");

    // Reproduce Production's out-of-repo default ACL.
    psql(lab.ownerUrl, `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
                        ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER}" GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
                        CREATE TABLE secc_probe_drift (id serial)`);
    ok("CONTROL M14b: under Production's default ACL a new table IS runtime-writable (the gap is real)",
      runtimeCan(lab.ownerUrl, "secc_probe_drift") === "SELECT,INSERT,UPDATE,DELETE");
    const drift = assertCatalog(lab.ownerUrl);
    ok("M14b catalog A6 detects the runtime default ACL (FAIL)", drift.get("A6_no_runtime_default_privileges")?.result === "FAIL", drift.get("A6_no_runtime_default_privileges"));

    const noVar = spawnSync(PSQL, [lab.ownerUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", DEFPRIV], { encoding: "utf8" });
    ok("M14b default-deny script refuses to run without OWNER_ROLE (exit 3, DENY)", noVar.status === 3 && /DENY: pass -v OWNER_ROLE/.test(noVar.stderr), noVar.stdout + noVar.stderr);
    const wrong = spawnSync(PSQL, [lab.ownerUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "OWNER_ROLE=no_such_role_secc", "-f", DEFPRIV], { encoding: "utf8" });
    ok("M14b default-deny script refuses an unknown OWNER_ROLE", wrong.status !== 0 && /DENY: OWNER_ROLE/.test(wrong.stderr), wrong.stderr);

    const run = psqlFile(lab.ownerUrl, DEFPRIV, { vars: { OWNER_ROLE: OWNER }, allowFail: true });
    ok("M14b default-deny script reports before>0 and after=0", run.status === 0 && /before\|[1-9]/.test(run.out) && /after\|0/.test(run.out), run.out + run.err);
    psql(lab.ownerUrl, `CREATE TABLE secc_probe_after (id serial)`);
    ok("M14b after the script a NEW table is NOT accessible to the runtime", runtimeCan(lab.ownerUrl, "secc_probe_after") === "");
    ok("M14b existing tables keep their grants (default privileges act only at CREATE)", runtimeCan(lab.ownerUrl, "secc_probe_drift") === "SELECT,INSERT,UPDATE,DELETE");
    const fixed = assertCatalog(lab.ownerUrl);
    ok("M14b catalog A6 PASS after the script", fixed.get("A6_no_runtime_default_privileges")?.result === "PASS", fixed.get("A6_no_runtime_default_privileges"));
    dropLab(lab);
  }

  // ── catalog evidence: fresh lab GREEN ──────────────────────────────────────
  const gen = spawnSync(process.execPath, [path.join(ROOT, "scripts/security/gen-security-catalog.mjs"), "--check"], { encoding: "utf8" });
  ok("CATALOG manifest is up to date with the migrations", gen.status === 0, gen.stdout + gen.stderr);

  const lab = await newLab("catalog");
  const green = assertCatalog(lab.ownerUrl);
  ok("CATALOG fresh lab (migrate deploy + grant scripts): every assertion PASS", green.size >= 13 && allPass(green), failing(green));

  // Each break is made, measured, and reverted, so each FAIL is attributable to one cause.
  const breaks: Array<[string, string, string, string, string]> = [
    ["FORCE removed on Customer", `ALTER TABLE "Customer" NO FORCE ROW LEVEL SECURITY`, `ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY`, "A2_expected_tables_rls_forced", "Customer:no_force"],
    ["RLS disabled on Document", `ALTER TABLE "Document" DISABLE ROW LEVEL SECURITY`, `ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY`, "A2_expected_tables_rls_forced", "Document:rls_off"],
    ["runtime login given BYPASSRLS", `ALTER ROLE ${lab.roles.rt} BYPASSRLS`, `ALTER ROLE ${lab.roles.rt} NOBYPASSRLS`, "A1_app_roles_least_privilege_attributes", lab.roles.rt],
    ["tenant policy dropped", `ALTER POLICY p7pilot_tenant_read ON "Appointment" RENAME TO secc_renamed`, `ALTER POLICY secc_renamed ON "Appointment" RENAME TO p7pilot_tenant_read`, "A4_expected_policies_present", "Appointment.p7pilot_tenant_read"],
    ["composite tenant FK removed", `ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_customerId_tenant_fkey"`,
      `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_tenant_fkey" FOREIGN KEY ("businessId","customerId") REFERENCES "Customer"("businessId","id") ON DELETE SET NULL ("customerId")`,
      "A8_tenant_fks_present_and_validated", "Conversation_customerId_tenant_fkey:missing"],
    ["definer lookup executable by PUBLIC", `GRANT EXECUTE ON FUNCTION public.sec_c_pos_api_key_lookup(text) TO PUBLIC`, `REVOKE EXECUTE ON FUNCTION public.sec_c_pos_api_key_lookup(text) FROM PUBLIC`, "A9_definer_lookups_hardened", "sec_c_pos_api_key_lookup"],
    ["runtime re-granted User.password", `GRANT SELECT ("password") ON "User" TO app_runtime`, `REVOKE SELECT ("password") ON "User" FROM app_runtime`, "A5_runtime_privilege_ceiling", "User.password"],
    ["admin re-granted table-wide User", `GRANT SELECT ON "User" TO app_admin`, `REVOKE SELECT ON "User" FROM app_admin; GRANT SELECT ("id","email","name","businessId","role","lastLoginAt","loginCount","createdAt","updatedAt") ON "User" TO app_admin`, "A5b_admin_cannot_read_password", ""],
    ["migration ledger entry rolled back", `UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = '20260926110000_sec_c_tenant_composite_fk'`, `UPDATE _prisma_migrations SET rolled_back_at = NULL WHERE migration_name = '20260926110000_sec_c_tenant_composite_fk'`, "A7_migration_ledger_complete", "20260926110000_sec_c_tenant_composite_fk"],
  ];
  for (const [what, breakSql, fixSql, id, name] of breaks) {
    psql(lab.ownerUrl, breakSql);
    const r = assertCatalog(lab.ownerUrl);
    const row = r.get(id);
    const others = [...r.values()].filter((x) => x.id !== id && x.result !== "PASS").map((x) => x.id);
    ok(`CATALOG broken lab (${what}) -> ${id} FAIL${name ? ` naming ${name}` : ""}, nothing else`,
      row?.result === "FAIL" && row.detail.includes(name) && others.length === 0, { row, others });
    psql(lab.ownerUrl, fixSql);
  }
  const restored = assertCatalog(lab.ownerUrl);
  ok("CATALOG lab restored -> every assertion PASS again", allPass(restored), failing(restored));

  const sqlText = (await import("node:fs")).readFileSync(ASSERT, "utf8")
    .replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
  const forbidden = sqlText.match(/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|comment|commit|lock|nextval|setval|reindex|cluster|refresh)\b/gi);
  ok("CATALOG assert SQL is read-only (no write keyword outside comments/literals)", forbidden === null, forbidden);
  dropLab(lab);
});
