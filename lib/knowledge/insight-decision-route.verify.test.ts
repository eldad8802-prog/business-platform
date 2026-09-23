/**
 * M3 — the owner-decision surface. Run:
 *   npx tsx lib/knowledge/insight-decision-route.verify.test.ts
 *
 * The contract here is almost entirely about what the CALLER may not choose. An insight is a statement
 * about one business; a request that could name which business, or which user is answering, would
 * reintroduce exactly the class of bug the whole tenant programme exists to remove.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const api = join(__dirname, "..", "..", "app", "api", "insights");
const list = readFileSync(join(api, "route.ts"), "utf8");
const decide = readFileSync(join(api, "[id]", "decision", "route.ts"), "utf8");
const service = readFileSync(join(__dirname, "insight.service.ts"), "utf8");

// ── The tenant and the actor come from the session, never the request ──────
for (const [name, src] of [["list", list], ["decision", decide]] as const) {
  ok(`${name}: requires a session`, /getCurrentUser\(req\)/.test(src));
  ok(`${name}: answers 401 without one`, /Unauthorized[\s\S]{0,60}401/.test(src));
  ok(`${name}: takes the tenant from the session`, /user\.businessId/.test(src));
  ok(`${name}: never reads a businessId from the caller`,
    !/searchParams\.get\(\s*["']businessId|body\.businessId|params\.businessId/.test(src));
}
ok("decision: the actor is the session user, not a parameter",
  /user\.id/.test(decide) && !/body\.(userId|actorUserId)/.test(decide));

// ── Only the two real answers ──────────────────────────────────────────────
ok("decision: accepts ADOPTED and DISMISSED only",
  /decision !== "ADOPTED" && decision !== "DISMISSED"/.test(decide));
ok("decision: anything else is 400", /must be ADOPTED or DISMISSED[\s\S]{0,80}400/.test(decide));
ok("decision: a dismissal is not treated as lesser than an adoption",
  !/if \(decision === "DISMISSED"\)[\s\S]{0,200}return/.test(decide));

// ── The id is validated before anything is written ─────────────────────────
ok("decision: the insight id is validated",
  /Number\.isInteger\(insightId\)[\s\S]{0,60}insightId\s*<=\s*0/.test(decide));

// ── A note is optional, and bounded ────────────────────────────────────────
ok("decision: a reason is optional", /note\?: unknown|typeof body\.note === "string"/.test(decide));
ok("decision: a reason is length-bounded", /slice\(0,\s*\d+\)/.test(decide));

// ── Cross-tenant attempts cannot succeed, and do not confirm existence ─────
ok("service: the update is predicated on BOTH id and businessId",
  /updateMany\(\{[\s\S]*?where:\s*\{\s*id:\s*insightId,\s*businessId\s*\}/.test(service));
ok("decision: a miss is 404, not 403 (it must not confirm the row exists)",
  /!result\.ok[\s\S]{0,120}404/.test(decide));

// ── Errors are named, never echoed ─────────────────────────────────────────
for (const [name, src] of [["list", list], ["decision", decide]] as const) {
  ok(`${name}: errors are named, not echoed`,
    /error instanceof Error \? error\.name/.test(src));
}

console.log(failed === 0 ? "\ninsight decision surface: session-scoped, two answers, no caller-chosen tenant. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
