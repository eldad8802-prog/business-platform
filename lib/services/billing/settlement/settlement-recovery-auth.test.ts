/**
 * Run: npx tsx lib/services/billing/settlement/settlement-recovery-auth.test.ts
 *
 * The recovery endpoint may be triggered only by a scheduler holding
 * CRON_SECRET, and fails closed when it is not configured. Also drives the real
 * route handler for the refusal paths (they never reach the database).
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { decideRecoveryAuth } from "./settlement-recovery-auth";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const SECRET = "s".repeat(48);

ok("no secret configured → NOT_CONFIGURED", decideRecoveryAuth(`Bearer ${SECRET}`, undefined) === "NOT_CONFIGURED");
ok("empty secret → NOT_CONFIGURED", decideRecoveryAuth(`Bearer x`, "   ") === "NOT_CONFIGURED");
ok("short placeholder secret → NOT_CONFIGURED", decideRecoveryAuth(`Bearer changeme`, "changeme") === "NOT_CONFIGURED");
ok("missing header → UNAUTHORIZED", decideRecoveryAuth(null, SECRET) === "UNAUTHORIZED");
ok("wrong scheme → UNAUTHORIZED", decideRecoveryAuth(`Basic ${SECRET}`, SECRET) === "UNAUTHORIZED");
ok("wrong secret → UNAUTHORIZED", decideRecoveryAuth(`Bearer ${"t".repeat(48)}`, SECRET) === "UNAUTHORIZED");
ok("prefix of the secret → UNAUTHORIZED", decideRecoveryAuth(`Bearer ${SECRET.slice(0, 40)}`, SECRET) === "UNAUTHORIZED");
ok("secret plus suffix → UNAUTHORIZED", decideRecoveryAuth(`Bearer ${SECRET}x`, SECRET) === "UNAUTHORIZED");
ok("exact bearer → AUTHORIZED", decideRecoveryAuth(`Bearer ${SECRET}`, SECRET) === "AUTHORIZED");
ok("scheme is case-insensitive", decideRecoveryAuth(`bearer ${SECRET}`, SECRET) === "AUTHORIZED");

async function routeChecks() {
  const route = await import("../../../../app/api/payments/settlement-recovery/route");
  const url = "https://example.test/api/payments/settlement-recovery";

  delete process.env.CRON_SECRET;
  const r1 = await route.POST(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
  ok("route: no CRON_SECRET → 503, fails closed", r1.status === 503, String(r1.status));

  process.env.CRON_SECRET = SECRET;
  const r2 = await route.POST(new NextRequest(url, { method: "POST" }));
  ok("route: no header → 401", r2.status === 401, String(r2.status));
  const r3 = await route.GET(new NextRequest(url, { headers: { authorization: "Bearer wrong-wrong-wrong-wrong-wrong-wrong" } }));
  ok("route: wrong secret on GET (Vercel cron verb) → 401", r3.status === 401, String(r3.status));
  const body = await r3.json();
  ok("route: refusal says nothing beyond 'unauthorized'", JSON.stringify(body) === JSON.stringify({ error: "unauthorized" }));
  delete process.env.CRON_SECRET;
}

routeChecks()
  .then(() => {
    console.log(`\nsettlement-recovery-auth: ${pass} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      console.log("FAILURES:\n - " + failures.join("\n - "));
      process.exit(1);
    }
    assert.equal(failures.length, 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
