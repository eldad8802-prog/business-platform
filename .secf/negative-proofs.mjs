/**
 * SEC-F negative proofs for the migration (AD-2A harness style).
 *
 * For each mutation:
 *   1. record sha256 of the migration file
 *   2. apply ONE textual mutation whose anchor must occur EXACTLY once, and
 *      assert the file actually changed (a mutation that silently misses would
 *      re-run the unmutated tree and "prove" nothing)
 *   3. run the battery in a FRESH lab
 *   4. assert exit code 1 (a control failed — not 2, a setup crash, which FAILS
 *      the proof) AND the specific `[FAIL] <id>` line the mutation must produce
 *   5. restore the original bytes and assert sha256 is identical
 * and finally one post-restore run that must be fully green (exit 0).
 *
 * Every mutation prints MUTATION / EXPECTED RED / ACTUAL RED / INTENDED REASON /
 * RESTORE / POST-RESTORE GREEN.
 *
 * Usage: node .secf/negative-proofs.mjs [id ...]   (default: all)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SECF_MIGRATION } from "./lab.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

const MUTATIONS = [
  {
    id: "N1",
    reason: "without the BillingDocument trigger an owner-role UPDATE rewrites an ISSUED total",
    anchor: `CREATE TRIGGER secf_fiscal_immutable BEFORE UPDATE OR DELETE ON "BillingDocument"\n  FOR EACH ROW EXECUTE FUNCTION public.secf_billing_document_immutable();`,
    replacement: `SELECT 1;`,
    expect: "F-TOTAL-OWN owner UPDATE totalAmount on ISSUED",
  },
  {
    id: "N2",
    reason: "without the REVOKE the runtime keeps UPDATE; the refusal becomes the trigger (DZ001), not the privilege (42501)",
    anchor: `    REVOKE UPDATE, DELETE, TRUNCATE ON "BillingAuditEvent"  FROM app_runtime;\n`,
    replacement: ``,
    expect: "A-RT-UPD BillingAuditEvent",
  },
  {
    id: "N3",
    reason: "without the append-only trigger the table owner rewrites payables history",
    anchor: `CREATE TRIGGER secf_append_only BEFORE UPDATE OR DELETE ON "PayablesAuditEvent"\n  FOR EACH ROW EXECUTE FUNCTION public.secf_append_only_guard();`,
    replacement: `SELECT 1;`,
    expect: "A-OWN-UPD PayablesAuditEvent",
  },
  {
    id: "N4",
    reason: "without the chain-link trigger a row naming the wrong predecessor is accepted",
    anchor: `CREATE TRIGGER secf_chain_link BEFORE INSERT ON "BillingAuditEvent"\n  FOR EACH ROW EXECUTE FUNCTION public.secf_audit_chain_link_guard();`,
    replacement: `SELECT 1;`,
    expect: "C-WRONG-PREV BillingAuditEvent",
  },
  {
    id: "N5",
    reason: "an unconditional SecurityEvent insert rule lets a tenant forge another tenant's events",
    anchor: `  WITH CHECK ("businessId" IS NULL\n              OR "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);`,
    replacement: `  WITH CHECK (true);`,
    expect: "S-RT-XTEN event attributed to another tenant",
  },
  {
    id: "N6",
    reason: "with ON DELETE CASCADE restored, deleting a Business tries to erase its payables trail (refused only by the append-only trigger, DZ001, not by the key)",
    anchor: `FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`,
    replacement: `FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    expect: "P-FK-RESTRICT deleting a Business does not erase its payables trail",
  },
  {
    id: "N7",
    reason: "without the child trigger an ISSUED receipt's payment line can be rewritten",
    anchor: `CREATE TRIGGER secf_fiscal_immutable BEFORE INSERT OR UPDATE OR DELETE ON "BillingReceiptPayment"\n  FOR EACH ROW EXECUTE FUNCTION public.secf_billing_child_immutable('billingDocumentId');`,
    replacement: `SELECT 1;`,
    expect: "F-RCPT-PAY-UPD rewrite an ISSUED receipt's payment",
  },
  {
    id: "N8",
    reason: "if the projection columns are always mutable, an allocation number can be replaced after it was set",
    anchor: `  IF OLD."allocationNumber" IS NULL AND NEW."allocationNumber" IS NOT NULL THEN`,
    replacement: `  IF true THEN`,
    expect: "F-PROJ-CHANGE allocationNumber once set",
  },
];

function runBattery() {
  const r = spawnSync(process.execPath, [".secf/migration-battery.mjs"], { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const wanted = process.argv.slice(2);
const selected = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS;
const original = readFileSync(SECF_MIGRATION);
const originalSha = sha(original);
let bad = 0;

for (const m of selected) {
  const text = original.toString("utf8");
  const n = text.split(m.anchor).length - 1;
  console.log(`\n=== ${m.id} ===`);
  console.log(`MUTATION:        ${m.id} — ${JSON.stringify(m.anchor.slice(0, 90))} -> ${JSON.stringify(m.replacement.slice(0, 60))}`);
  console.log(`EXPECTED RED:    exit 1 with [FAIL] ${m.expect}`);
  console.log(`INTENDED REASON: ${m.reason}`);
  if (n !== 1) {
    console.log(`ACTUAL RED:      PROOF INVALID — anchor occurs ${n} times`);
    bad++;
    continue;
  }
  writeFileSync(SECF_MIGRATION, text.replace(m.anchor, m.replacement));
  const mutatedSha = sha(readFileSync(SECF_MIGRATION));
  let res;
  try {
    if (mutatedSha === originalSha) throw new Error("mutation did not change the file");
    res = runBattery();
  } finally {
    writeFileSync(SECF_MIGRATION, original);
  }
  const restored = sha(readFileSync(SECF_MIGRATION)) === originalSha;
  const failLine = res.out.split("\n").find((l) => l.includes(`[FAIL] ${m.expect}`));
  const setupCrash = res.code === 2 || res.out.includes("[SETUP-ERROR]");
  const red = res.code === 1 && !!failLine && !setupCrash;
  console.log(`ACTUAL RED:      exit=${res.code}${setupCrash ? " SETUP CRASH" : ""} ${failLine ? failLine.trim() : "(expected FAIL line absent)"}`);
  console.log(`RESTORE:         sha256 ${restored ? "identical" : "DIFFERS"} (${originalSha.slice(0, 16)}…)`);
  if (!red || !restored) {
    bad++;
    if (!red) console.log(res.out.split("\n").filter((l) => l.includes("[FAIL]") || l.includes("SETUP")).slice(0, 20).join("\n"));
  }
}

const green = runBattery();
const greenOk = green.code === 0 && /PASS=\d+ FAIL=0/.test(green.out);
console.log(`\nPOST-RESTORE GREEN: exit=${green.code} ${(/PASS=\d+ FAIL=\d+/.exec(green.out) ?? ["(no summary)"])[0]}`);
if (!greenOk) { console.log(green.out.split("\n").filter((l) => l.includes("[FAIL]") || l.includes("SETUP")).join("\n")); bad++; }
console.log(bad === 0 ? "NEGATIVE PROOFS: ALL RED AS INTENDED, RESTORED, GREEN" : `NEGATIVE PROOFS: ${bad} PROBLEM(S)`);
process.exit(bad === 0 ? 0 : 1);
