#!/usr/bin/env node
// SEC N-1 negative proofs. Each mutation edits the REAL migration file, builds a fresh
// lab from it, runs the ONE named check that must catch it, and asserts that check goes
// RED for the intended reason. The file is then restored, verified byte-identical
// (sha256), a fresh lab is built from the restored file, and the full battery must be
// green again. A mutation that does not apply, a setup crash, a wrong-reason red or an
// imperfect restore fails the proof.
//
//   ADMIN_URL=postgresql://owner@host:port/postgres RUNTIME_PW=... node .secn1/mutate.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "prisma/migrations/20260928100000_sec_n1_p0_evidence_tenant_rls/migration.sql");
const ADMIN_URL = process.env.ADMIN_URL;
const RUNTIME_PW = process.env.N1_RUNTIME_PW || "n1_lab_synthetic_runtime_pw";
if (!ADMIN_URL) {
  console.error("SETUP FAIL: ADMIN_URL is required");
  process.exit(2);
}
const base = ADMIN_URL.replace(/\/[^/]*$/, "");
const host = new URL(ADMIN_URL);
const runtimeUrl = (db) => `postgresql://app_runtime_prod:${RUNTIME_PW}@${host.host}/${db}`;
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const PRED = `("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`;
const MUTATIONS = [
  {
    id: "M1_DROP_FORCE",
    what: 'remove ALTER TABLE "BusinessAsset" FORCE ROW LEVEL SECURITY',
    anchor: 'ALTER TABLE "BusinessAsset" FORCE ROW LEVEL SECURITY;\n',
    replace: "",
    check: "FORCE_BINDS_OWNER",
    reason: /BusinessAsset: owner sees 2/,
    intended: "without FORCE the table owner is not subject to the tenant policies and reads both tenants",
  },
  {
    id: "M2_WEAKEN_INSERT_WITH_CHECK",
    what: "InventorySale insert policy WITH CHECK predicate replaced by true",
    anchor: `CREATE POLICY inventory_sale_tenant_insert ON "InventorySale" FOR INSERT\n  WITH CHECK ${PRED};`,
    replace: `CREATE POLICY inventory_sale_tenant_insert ON "InventorySale" FOR INSERT\n  WITH CHECK (true);`,
    check: "CROSS_TENANT_INSERT_REFUSED",
    reason: /InventorySale: B ROW INSERTED UNDER A/,
    intended: "without the tenant WITH CHECK, tenant A can write a row owned by tenant B",
  },
  {
    id: "M3_WEAKEN_UPDATE_WITH_CHECK",
    what: "InventorySourceSaleLine update policy WITH CHECK predicate replaced by true",
    anchor: `CREATE POLICY inventory_source_sale_line_tenant_update ON "InventorySourceSaleLine" FOR UPDATE\n  USING ${PRED}\n  WITH CHECK ${PRED};`,
    replace: `CREATE POLICY inventory_source_sale_line_tenant_update ON "InventorySourceSaleLine" FOR UPDATE\n  USING ${PRED}\n  WITH CHECK (true);`,
    check: "CROSS_TENANT_UPDATE_REFUSED",
    reason: /move A->B: ACCEPTED/,
    intended: "without the tenant WITH CHECK on UPDATE, tenant A can re-home its row into tenant B",
  },
  {
    id: "M4_OMIT_INSERT_WITH_CHECK",
    what: "BusinessAsset insert policy WITH CHECK clause deleted entirely",
    anchor: `CREATE POLICY business_asset_tenant_insert ON "BusinessAsset" FOR INSERT\n  WITH CHECK ${PRED};`,
    replace: `CREATE POLICY business_asset_tenant_insert ON "BusinessAsset" FOR INSERT;`,
    check: "OWN_TENANT_WRITES_WORK",
    reason: /BusinessAsset: 42501 new row violates row-level security/,
    intended: "an INSERT policy with no WITH CHECK admits nothing: PostgreSQL fails closed, so the tenant's own writer breaks",
  },
];

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env }, shell: false });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, error: r.error };
}
function buildLab(db) {
  const r = run("bash", [".secn1/build-lab.sh"], { ADMIN_URL, LAB_DB: db });
  if (r.status !== 0 || !/LAB BUILT/.test(r.out)) throw new Error(`lab build ${db} failed:\n${r.out.slice(-2000)}`);
}
function battery(db, only) {
  const args = [".secn1/db-battery.mjs"];
  if (only) args.push("--only", only);
  return run(process.execPath, args, { OWNER_URL: `${base}/${db}`, RUNTIME_URL: runtimeUrl(db) });
}

const results = [];
let failures = 0;
const original = fs.readFileSync(FILE);
const originalSha = sha(FILE);
for (const m of MUTATIONS) {
  const rec = { MUTATION: `${m.id}: ${m.what}`, EXPECTED_RED: `${m.check} ${m.reason}`, INTENDED_REASON: m.intended };
  try {
    const text = original.toString("utf8");
    const hits = text.split(m.anchor).length - 1;
    if (hits !== 1) throw new Error(`anchor occurs ${hits} times (must be exactly 1)`);
    fs.writeFileSync(FILE, text.replace(m.anchor, m.replace));
    if (sha(FILE) === originalSha) throw new Error("mutation did not change the file");
    const db = `n1mut_${m.id.toLowerCase()}`;
    buildLab(db);
    const red = battery(db, m.check);
    const line = red.out.split("\n").find((l) => l.includes(` ${m.check}`)) || red.out.trim();
    rec.ACTUAL_RED = line.trim();
    if (red.status !== 1 || !line.startsWith("RED") || !m.reason.test(line)) {
      throw new Error(`expected RED ${m.check} matching ${m.reason}, got status ${red.status}: ${red.out.slice(-800)}`);
    }
  } catch (e) {
    rec.ERROR = e instanceof Error ? e.message : String(e);
    failures++;
  } finally {
    fs.writeFileSync(FILE, original);
    rec.RESTORE = sha(FILE) === originalSha ? `sha256 ${originalSha.slice(0, 16)}… byte-identical` : "RESTORE MISMATCH";
    if (!rec.RESTORE.includes("byte-identical")) failures++;
  }
  results.push(rec);
}

// Post-restore: one fresh lab from the restored file, the whole battery green.
try {
  buildLab("n1mut_restored");
  const g = battery("n1mut_restored");
  const summary = g.out.trim().split("\n").pop();
  for (const r of results) r.POST_RESTORE_GREEN = g.status === 0 ? summary : `NOT GREEN: ${summary}`;
  if (g.status !== 0) {
    failures++;
    console.log(g.out);
  }
} catch (e) {
  failures++;
  for (const r of results) r.POST_RESTORE_GREEN = `CRASH ${e instanceof Error ? e.message : e}`;
}

for (const r of results) {
  console.log("----");
  for (const [k, v] of Object.entries(r)) console.log(`${k}: ${v}`);
}
console.log(`sec-n1 mutation proofs: ${failures === 0 ? "ALL RED AS INTENDED, RESTORED, GREEN" : failures + " FAILED"}`);
process.exit(failures ? 1 : 0);
