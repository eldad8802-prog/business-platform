/**
 * SEC-E / M-12(c) — static + behavioural guard for the erasure authority.
 *   npx tsx lib/tenant/erasure-authority.guard.test.ts
 *
 * 1. `runWithErasureAuthority` is CALLED only from lib/tenant/job.ts (the definition
 *    lives in erasure-authority.ts). Any other caller would be a way past the
 *    in-transaction lifecycle gate that CI-AD-5 cannot see, because it never spells
 *    `quarantinePolicy: "erasure"`.
 * 2. `withTenantTransaction` still consults the gate (`assertTenantTxAcceptsWrites`)
 *    and the capability (`holdsErasureAuthority`).
 * 3. The capability is scoped: held for business A, it is not held for B, and it is
 *    gone outside the callback.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { holdsErasureAuthority, runWithErasureAuthority } from "./erasure-authority";

const ROOT = path.resolve(__dirname, "../..");
const offenders: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(full);
    } else if (/\.(ts|tsx|mts|mjs)$/.test(e.name)) {
      const rel = path.relative(ROOT, full).replace(/\\/g, "/");
      const text = fs.readFileSync(full, "utf8");
      if (!/runWithErasureAuthority\s*\(/.test(text)) continue;
      if (rel === "lib/tenant/job.ts" || rel === "lib/tenant/erasure-authority.ts") continue;
      if (rel === "lib/tenant/erasure-authority.guard.test.ts") continue;
      offenders.push(rel);
    }
  }
};
for (const d of ["app", "lib", "scripts", "components", "hooks"]) {
  if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
}
assert.deepEqual(offenders, [], `runWithErasureAuthority called outside lib/tenant/job.ts: ${offenders.join(", ")}`);
console.log("  PASS runWithErasureAuthority is called only from lib/tenant/job.ts");

const tx = fs.readFileSync(path.join(ROOT, "lib/tenant/transaction.ts"), "utf8");
assert.ok(/assertTenantTxAcceptsWrites\(tx, businessId\)/.test(tx), "withTenantTransaction lost its lifecycle gate");
assert.ok(/holdsErasureAuthority\(businessId\)/.test(tx), "withTenantTransaction no longer scopes the bypass to the capability");
assert.ok(/pg_advisory_xact_lock_shared/.test(tx), "withTenantTransaction no longer takes the shared lifecycle lock");
console.log("  PASS withTenantTransaction enforces the lifecycle gate unless the capability is held");

const job = fs.readFileSync(path.join(ROOT, "lib/tenant/job.ts"), "utf8");
assert.ok(/policy === "erasure"[\s\S]{0,400}runWithErasureAuthority\(businessId, fn\)/.test(job), "runTenantJob no longer grants the capability only for the erasure policy");
console.log("  PASS runTenantJob grants the capability only under quarantinePolicy \"erasure\"");

assert.equal(holdsErasureAuthority(5), false);
runWithErasureAuthority(5, () => {
  assert.equal(holdsErasureAuthority(5), true);
  assert.equal(holdsErasureAuthority(6), false);
});
assert.equal(holdsErasureAuthority(5), false);
assert.throws(() => runWithErasureAuthority(0, () => undefined));
console.log("  PASS the capability is scoped to one business and to the callback");
console.log("[erasure-authority] guard PASS");
