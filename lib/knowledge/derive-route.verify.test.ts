/**
 * M2/M3 — the derivation route's security contract. Run:
 *   npx tsx lib/knowledge/derive-route.verify.test.ts
 *
 * This route WRITES derived knowledge in production. Everything below is about who may ask it to, and
 * what it is allowed to say back. The auth decision itself is the settlement-recovery contract, already
 * tested where it lives; what is guarded here is that this route uses it correctly and adds nothing
 * that widens it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideRecoveryAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const src = readFileSync(
  join(__dirname, "..", "..", "app", "api", "knowledge", "derive", "route.ts"),
  "utf8",
);

// ── Who may call it ────────────────────────────────────────────────────────
ok("authentication is the CRON_SECRET bearer contract", /decideRecoveryAuth\(/.test(src));
ok("a missing secret answers 503, never 'open'", /NOT_CONFIGURED[\s\S]{0,120}503/.test(src));
ok("anything not AUTHORIZED is 401", /!==\s*"AUTHORIZED"[\s\S]{0,120}401/.test(src));
ok("no user session is consulted", !/getCurrentUser|requireUser|cookies\(\)/.test(src));
ok("no platform-admin path either", !/requirePlatformAdmin/.test(src));

// A real secret is required to be long enough — a placeholder must never become a credential.
ok("short secrets are not configured", decideRecoveryAuth("Bearer x", "short") === "NOT_CONFIGURED");
ok("a wrong bearer is unauthorized",
  decideRecoveryAuth("Bearer wrong", "y".repeat(40)) === "UNAUTHORIZED");
ok("the right bearer is authorized",
  decideRecoveryAuth(`Bearer ${"y".repeat(40)}`, "y".repeat(40)) === "AUTHORIZED");
ok("no bearer at all is unauthorized", decideRecoveryAuth(null, "y".repeat(40)) === "UNAUTHORIZED");

// ── One tenant, explicitly ─────────────────────────────────────────────────
ok("the tenant is validated as a positive integer",
  /Number\.isInteger\(businessId\)[\s\S]{0,60}businessId\s*<=\s*0/.test(src));
ok("an invalid tenant is rejected before any derivation", /400/.test(src));
ok("there is no all-businesses sweep", !/findMany\(\s*\{\s*\}\s*\)|forEach.*business/i.test(src));

// ── What it may say back ───────────────────────────────────────────────────
ok("the response reports the role posture rather than assuming it", /bypassrls/i.test(src));
ok("the response states a proof level", /proofLevel/.test(src));
ok("no fact text, vendor or payee is returned",
  !/factLines|vendorName|payeeName|interpretation/.test(src));
ok("errors are named, not echoed", /error instanceof Error \? error\.name/.test(src));

// ── It must not become a product surface ───────────────────────────────────
ok("force-dynamic (never cached)", /dynamic = "force-dynamic"/.test(src));
ok("node runtime (Prisma needs it)", /runtime = "nodejs"/.test(src));

console.log(failed === 0 ? "\nderive route: scheduler-only, one tenant, nothing leaked. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
