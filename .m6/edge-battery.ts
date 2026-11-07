/**
 * Leads L1.5-b · PR-8 — edge cases not covered by the other batteries.
 *
 *   DB outage: with the database unreachable, every intake route (web, Google, Meta, WooCommerce, CloudTalk, Voicenter)
 *   answers 503 — a retryable, visible failure — and never a silent 2xx. (Whether the provider retries is the
 *   provider's: see the readiness table. A browser form shows the visitor an error, never a false "sent".) Run in a
 *   child process whose DATABASE_URL points at a port nothing listens on; the lab database is never touched by it.
 *
 * The rest of the edge matrix lives where it is exercised for real: signatures / duplicates / retry / worker crash /
 * pause / resume / emergency / RLS / entitlement in the M6, M7-A, M7-B/C batteries; loads and racing sweepers in the
 * fair-queue, release and capacity batteries; owner visibility and notifications (no payload, no duplicates) in the
 * owner-status and notifications batteries; expiry in the expiry battery.
 */
import { spawnSync } from "node:child_process";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\n-- DB outage: every intake route answers 503, never a silent 2xx --");
const down = "postgresql://app_runtime:x@127.0.0.1:1/none?connect_timeout=2";
const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", ".m6/db-outage-probe.ts"], {
  env: { ...process.env, DATABASE_URL: down, DIRECT_URL: down },
  encoding: "utf8",
  timeout: 240_000,
  shell: process.platform === "win32",
});
const line = `${r.stdout}`.split("\n").find((l) => l.startsWith("STATUSES "));
const statuses = line ? (JSON.parse(line.slice("STATUSES ".length)) as Record<string, number>) : null;
ok("the probe ran against an unreachable database", !!statuses, `${r.stdout}`.slice(-400) + `${r.stderr}`.slice(-400));
for (const source of ["web", "google", "meta", "woocommerce", "cloudtalk", "voicenter"]) {
  ok(`DB outage: ${source} → 503 (retryable, nothing claimed as received)`, statuses?.[source] === 503, JSON.stringify(statuses));
}

console.log(`\nL1.5-b edge battery: ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
