#!/usr/bin/env node
/**
 * sec(C) negative proofs (mutation runner), AD-2A style.
 *
 *   node .secc/mutate.mjs <ID>      one mutation
 *   node .secc/mutate.mjs --list
 *
 * For each mutation:
 *   1. sha256 the target; the anchor must occur EXACTLY once; apply; assert the file changed.
 *   2. run the proof; it must exit 1 (assertion red) — exit 2 (SETUP-CRASH) or 0 is a
 *      failed negative proof — AND print the SPECIFIC expected failure label.
 *   3. restore; sha256 must be byte-identical to the original.
 *   4. re-run the proof; it must be green again (post-restore).
 * Prints MUTATION / EXPECTED RED / ACTUAL RED / INTENDED REASON / RESTORE / POST-RESTORE GREEN.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const tsx = (f) => ["npx", ["tsx", f]];

const M = {
  N1: {
    file: "prisma/migrations/20260926110000_sec_c_tenant_composite_fk/migration.sql",
    anchor: `ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION NOT VALID;`,
    replace: `-- MUTATION N1: Conversation_customerId_tenant_fkey removed`,
    run: tsx(".secc/sections/m3-db.ts"),
    expect: "FAIL: M3-DB Conversation.customerId A->B rejected 23503 on Conversation_customerId_tenant_fkey",
    reason: "without the composite FK the database accepts tenant B's customer id under tenant A's GUC (FK checks bypass RLS)",
  },
  N2: {
    file: "lib/services/appointment/appointment.service.ts",
    anchor: `if (refs.customerId != null && !(await tx.customer.findFirst({`,
    replace: `if (false && refs.customerId != null && !(await tx.customer.findFirst({`,
    run: tsx(".secc/sections/m3-app.ts"),
    expect: "FAIL: M3-APP appointment foreign customerId -> invalid_input",
    reason: "without the in-transaction ownership check the service links tenant B's customer (lab has no composite FK)",
  },
  N3: {
    file: "app/api/knowledge/derive/route.ts",
    anchor: `...(diagnostics`,
    replace: `...(true`,
    run: tsx(".secc/sections/m3-app.ts"),
    expect: "FAIL: T09 no posture in response",
    reason: "the role name, RLS flags and cross-tenant counts reach the (publicly logged) response",
  },
  N4: {
    file: "prisma/migrations/20260926110100_sec_c_bootstrap_lookup_functions/migration.sql",
    anchor: `RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER`,
    replace: `RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER`,
    run: tsx(".secc/sections/phase3.ts"),
    expect: "FAIL: M14 webhook lookup under FORCE RLS: pnA -> A",
    reason: "an invoker-rights lookup runs as the runtime, which under FORCE RLS without a GUC sees no connection: webhooks stop resolving",
  },
  N5: {
    file: "ops/security/sec-c-phase3-rls.sql",
    anchor: `  WITH CHECK ("businessId" IS NULL
              OR "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);`,
    replace: `  WITH CHECK (true);`,
    run: tsx(".secc/sections/phase3.ts"),
    expect: "FAIL: M14 PUE: tenant A cannot write an event for tenant B (42501 RLS)",
    reason: "an unconditional insert policy lets a tenant forge telemetry for another tenant",
  },
  N6: {
    file: "ops/security/sec-c-default-privileges.sql",
    anchor: `'ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL ON %s FROM %I'`,
    replace: `'ALTER DEFAULT PRIVILEGES FOR ROLE %I %s GRANT SELECT ON %s TO %I'`,
    run: tsx(".secc/sections/catalog.ts"),
    expect: "FAIL: M14b default-deny script reports before>0 and after=0",
    reason: "the runtime default ACL is not removed; the script's own post-check must refuse and roll back",
  },
  N7: {
    file: "lib/prisma-auth.ts",
    anchor: `    if (isProductionDeployment()) {`,
    replace: `    if (false && isProductionDeployment()) {`,
    run: tsx("lib/prisma-auth.test.ts"),
    expect: "[FAIL] T-05: production + unset flag throws (no silent legacy)",
    reason: "production silently serves auth through the tenant runtime identity when the flag is unset",
  },
  N8: {
    file: "lib/services/integrations/whatsapp/connection.service.ts",
    anchor: `    if (!isUndefinedFunction(error)) throw error;`,
    replace: `    throw error;`,
    run: tsx(".secc/sections/phase3.ts"),
    expect: "FAIL: M14 state0: the REAL code still resolves tenants before the migration",
    reason: "without the 42883-only fallback, deploying the code before release-migrate would break every WhatsApp webhook",
  },
  N9: {
    file: "lib/security/knowledge-derive-secret.ts",
    anchor: `  if (dedicated) {`,
    replace: `  if (false && dedicated) {`,
    run: tsx("lib/security/knowledge-derive-secret.test.ts"),
    expect: "FAIL: L8 dedicated secret wins; CRON_SECRET no longer opens the route",
    reason: "the shared CRON_SECRET keeps opening the derive route after a dedicated secret is provisioned",
  },
  N10: {
    file: "prisma/migrations/20260926110300_sec_c_explicit_identity_grants/migration.sql",
    anchor: `    GRANT INSERT ("createdAt") ON "Business" TO app_auth;`,
    replace: `    -- MUTATION N10: Business.createdAt INSERT grant removed`,
    run: tsx(".secc/sections/auth-grants.ts"),
    expect: "FAIL: AUTH signup on the active auth plane succeeds with the migration-shipped grants",
    reason: "Prisma emits createdAt on the Business insert; without the column grant every auth-plane signup is 42501",
  },
};

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
function run([cmd, args]) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: process.env, shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const id = process.argv[2];
if (id === "--list") { console.log(Object.keys(M).join(" ")); process.exit(0); }
const m = M[id];
if (!m) { console.error(`unknown mutation ${id}`); process.exit(2); }
const file = path.join(ROOT, m.file);
const original = fs.readFileSync(file, "utf8");
const h0 = sha(file);
const count = original.split(m.anchor).length - 1;
if (count !== 1) { console.error(`MUTATION ${id}: anchor occurs ${count} times (must be exactly 1) — proof invalid`); process.exit(2); }
let result = 2;
try {
  fs.writeFileSync(file, original.replace(m.anchor, m.replace));
  if (sha(file) === h0) throw new Error("mutation did not change the file");
  const red = run(m.run);
  const labelSeen = red.out.includes(m.expect);
  const crashed = /SETUP-CRASH/.test(red.out) || red.code === 2;
  console.log(`MUTATION:        ${id} ${m.file}`);
  console.log(`EXPECTED RED:    exit 1 with "${m.expect}"`);
  console.log(`ACTUAL RED:      exit ${red.code}; label ${labelSeen ? "seen" : "NOT seen"}${crashed ? "; SETUP-CRASH" : ""}`);
  console.log(`INTENDED REASON: ${m.reason}`);
  if (!labelSeen || red.code !== 1 || crashed) {
    console.log(red.out.split("\n").filter((l) => /FAIL|CRASH|Error/.test(l)).slice(0, 12).join("\n"));
    throw new Error("negative proof did not go red for the intended reason");
  }
  result = 0;
} catch (e) {
  console.error(`NEGATIVE PROOF ${id} FAILED: ${e.message}`);
  result = 1;
} finally {
  fs.writeFileSync(file, original);
  const restored = sha(file) === h0;
  console.log(`RESTORE:         sha256 ${restored ? "byte-identical" : "MISMATCH"} (${h0.slice(0, 16)})`);
  if (!restored) result = 1;
}
if (result === 0) {
  const green = run(m.run);
  console.log(`POST-RESTORE GREEN: exit ${green.code}`);
  if (green.code !== 0) { console.log(green.out.split("\n").filter((l) => /FAIL|CRASH/.test(l)).slice(0, 12).join("\n")); result = 1; }
}
process.exit(result);
