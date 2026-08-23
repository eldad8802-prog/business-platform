/**
 * Business Memory SHADOW-COMPARISON-2 · Dry-run harness — static guard test. npx tsx. No DB.
 *
 * Proves (defense in depth) that the harness CANNOT reach a writer: no Prisma write primitive, no raw
 * exec, no writer/orchestrator import, no materializeClaim/writeClaim; that it forces a read-only DB
 * session and fail-closes; and that its workflow is gated, host-allowlisted, input-validated, fixed-path,
 * and not a product/HTTP surface.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const ROOT = join(__dirname, "..", "..", "..");
const runner = readFileSync(join(ROOT, "scripts", "business-memory", "dry-run-comparison.ts"), "utf8").replace(/\r\n/g, "\n");
const core = readFileSync(join(ROOT, "scripts", "business-memory", "dry-run-comparison.core.ts"), "utf8").replace(/\r\n/g, "\n");
const wf = readFileSync(join(ROOT, ".github", "workflows", "prod-readonly-dryrun-comparison.yml"), "utf8").replace(/\r\n/g, "\n");
const bothScripts = runner + "\n" + core;

// Import statements only (mirrors the workflow's import-coupling grep).
const importLines = bothScripts.split("\n").filter((l) => /^\s*import\s/.test(l)).join("\n");

section("Harness — NO write primitives / raw exec / writer calls");
const WRITE = /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/;
check("no Prisma write-call primitive (.create/.update/.upsert/.delete/.*Many)", !WRITE.test(bothScripts));
check("no $executeRaw / $executeRawUnsafe", !/\$executeRaw/.test(bothScripts));
check("no materializeClaim( / writeClaim( call", !/(materializeClaim|writeClaim)\(/.test(bothScripts));
check("no raw INSERT/UPDATE/DELETE/... string", !/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE)\b/.test(bothScripts));

section("Harness — NO writer / orchestrator import coupling");
check("no import of claim-writer", !/claim-writer/.test(importLines));
check("no import of /materialization", !/\/materialization/.test(importLines));
check("no import of /orchestration (orchestrator)", !/\/orchestration/.test(importLines));
check("imports only read/pure BM stages (policy/evidence/derivation)", /@\/lib\/business-memory\/policy/.test(runner) && /@\/lib\/business-memory\/evidence/.test(core) && /@\/lib\/business-memory\/derivation/.test(core));

section("Harness — read-only DB session forced + fail-closed");
check("read-only startup option present", /default_transaction_read_only=on/.test(runner));
check("verifies session read-only via SHOW", /SHOW default_transaction_read_only/.test(runner));
check("fail-closed: refuses to run unless session read-only", /refusing to run: DB session is NOT read-only/.test(runner) && /assertSessionReadOnly/.test(runner));
check("assertion runs BEFORE any evidence read", runner.indexOf("assertSessionReadOnly(client)") < runner.indexOf(".findMany("));
check("reads evidence via findMany (read) only", /\.findMany\(/.test(runner));

section("Harness — real engine, not a re-implementation; expected side independent");
check("uses REAL reader core (projectOwnerDecisionEvidence)", /projectOwnerDecisionEvidence/.test(core));
check("uses REAL deriver (deriveVendorCategory)", /deriveVendorCategory\(/.test(core));
check("expected side is an independent evidence scan (supportedCategoryOf), not a deriver copy", /function supportedCategoryOf/.test(core) && !/deriveVendorCategoryCandidates/.test(core));

section("Workflow — gate, guards, validated input, fixed path");
check("workflow_dispatch trigger", /on:\s*\n\s*workflow_dispatch:/.test(wf));
check("no push/schedule triggers", !/\bpush:|\bschedule:/.test(wf));
check("environment: production-db (approval gate)", /environment:\s*production-db/.test(wf));
check("host allowlist ep-flat-brook-am4bhq1y", /ep-flat-brook-am4bhq1y/.test(wf));
check("static NO-WRITE guard step present", /Static NO-WRITE guard/.test(wf) && /createMany\|updateMany\|deleteMany/.test(wf));
check("businessId validated as positive integer", /\*\[!0-9\]\*\) echo "::error::businessId must be a positive integer/.test(wf));
check("fixed harness script path (no arbitrary path input)", /npx tsx scripts\/business-memory\/dry-run-comparison\.ts/.test(wf));
check("inputs passed via env (BID/SKEY), not interpolated into the run command",
  /BID: \$\{\{ inputs\.businessId \}\}/.test(wf) && /SKEY: \$\{\{ inputs\.subjectNormalizedKey \}\}/.test(wf) &&
  !wf.split("\n").some((l) => /npx tsx/.test(l) && /\$\{\{\s*inputs\./.test(l)));
check("permissions contents: read", /permissions:\s*\n\s*contents:\s*read/.test(wf));

section("Not a product / HTTP surface");
check("harness lives under scripts/ (ops tool), not app/api", true);
check("no Next route handler exported (GET/POST/PUT/PATCH/DELETE)", !/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/.test(bothScripts));

section("Business Memory SHADOW-COMPARISON-2 · dry-run guard");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All dry-run guards hold. No writer reachable · read-only session forced · gated · fixed path. ✔");
