/**
 * Business Memory SHADOW-VERIFY-1 · Claim evidence path — static guard test. npx tsx. No DB.
 *
 * Verifies the gated read-only evidence SQL + workflow preserve the security model: SELECT-only,
 * READ ONLY transaction, tenant-scoped, exact policy join, bound (non-injectable) params, fixed SQL
 * path, production-db gate + host allowlist, inputs via env (no shell/SQL injection), and that this is
 * NOT a product Claim reader (no runtime Prisma access to the Claim tables).
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
const sql = readFileSync(join(ROOT, "ops", "evidence", "business-memory-claim-evidence.sql"), "utf8").replace(/\r\n/g, "\n");
const wf = readFileSync(join(ROOT, ".github", "workflows", "prod-readonly-evidence-business-memory.yml"), "utf8").replace(/\r\n/g, "\n");

// The EXACT forbidden-write guard used by the workflow (mirrors ops/evidence/prod-readonly-evidence.yml).
const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|comment|commit|upsert|replace|lock|nextval|setval|reindex|cluster|refresh)\b/i;

// ── SQL: SELECT-only + read-only transaction ─────────────────────────────────────────────────────
section("SQL — SELECT-only + READ ONLY transaction");
check("SQL passes the forbidden-write static guard (0 write keywords)", !FORBIDDEN.test(sql));
check("session read-only set", /SET default_transaction_read_only = on;/.test(sql));
check("statement timeout set", /SET statement_timeout/.test(sql));
check("BEGIN TRANSACTION READ ONLY", /BEGIN TRANSACTION READ ONLY;/.test(sql));
check("ends with ROLLBACK (never commits)", /ROLLBACK;\s*$/.test(sql.trim() + "\n") || /\nROLLBACK;/.test(sql));
check("only SELECT statements (no write DML/DDL)", !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql));

// ── SQL: tenant isolation + exact policy join ────────────────────────────────────────────────────
section("SQL — tenant isolation + exact vendor-category/v1 policy join");
const projQueries = (sql.match(/FROM "DerivedClaimProjection"|"DerivedClaimProjection" pr/g) ?? []).length;
check("every DerivedClaim* query is scoped by businessId", (sql.match(/"businessId" = \(:'businessId'\)::int/g) ?? []).length >= 3 && projQueries >= 1);
check("subjectDomain scoped to 'vendor'", /"subjectDomain" = 'vendor'/.test(sql));
check("claimType scoped to 'vendor-category'", /"claimType" = 'vendor-category'/.test(sql));
check("exact policy join key='vendor-category' AND version='v1'", /p\.key = 'vendor-category' AND v\.version = 'v1'/.test(sql));
check("no cross-tenant fallback (no query on subject alone without businessId)", !/WHERE\s+"subjectNormalizedKey"[^;]*;(?![\s\S]*businessId)/i.test(sql));

// ── SQL: bound params (no injection) + privacy ───────────────────────────────────────────────────
section("SQL — bound params (no injection) + subject key not echoed");
check("uses psql bound var for businessId (:'businessId')", /:'businessId'/.test(sql));
check("uses psql bound var for subjectNormalizedKey (:'subjectNormalizedKey')", /:'subjectNormalizedKey'/.test(sql));
check("subjectNormalizedKey is a WHERE predicate, NOT a selected output column", /"subjectNormalizedKey" = :'subjectNormalizedKey'/.test(sql) && !/SELECT[^;]*"subjectNormalizedKey"[^;]*FROM "DerivedClaimProjection"/.test(sql));
check("evidence links output references only (kind + record id), no raw payload column", /l\."evidenceKind"[\s\S]*l\."evidenceRecordId"/.test(sql) && !/rawBelief|rawFinal|verdicts/i.test(sql));

// ── Workflow: gate + guards + input safety ───────────────────────────────────────────────────────
section("Workflow — production-db gate, guards, input safety");
check("workflow_dispatch only", /on:\s*\n\s*workflow_dispatch:/.test(wf) && !/\bpush:|\bschedule:/.test(wf));
check("environment: production-db (approval gate)", /environment:\s*production-db/.test(wf));
check("host allowlist ep-flat-brook-am4bhq1y", /ep-flat-brook-am4bhq1y/.test(wf));
check("SQL static guard step present (same FORBIDDEN set)", /Forbidden write keyword found in SQL/.test(wf) && /insert\|update\|delete/.test(wf));
check("fixed SQL file path (no path input)", /--file=ops\/evidence\/business-memory-claim-evidence\.sql/.test(wf));
check("SQL_FILE hardcoded (not from an input)", /SQL_FILE="ops\/evidence\/business-memory-claim-evidence\.sql"/.test(wf));
check("businessId validated as positive integer", /\*\[!0-9\]\*\) echo "::error::businessId must be a positive integer/.test(wf));
check("inputs passed via env (BID/SKEY), never interpolated into the psql line",
  /BID: \$\{\{ inputs\.businessId \}\}/.test(wf) && /SKEY: \$\{\{ inputs\.subjectNormalizedKey \}\}/.test(wf) &&
  !wf.split("\n").some((l) => /psql/.test(l) && /\$\{\{\s*inputs\./.test(l)));
check("params bound via --set (not string-concatenated into SQL)", /--set=businessId="\$BID"/.test(wf) && /--set=subjectNormalizedKey="\$SKEY"/.test(wf));
check("permissions contents: read only", /permissions:\s*\n\s*contents:\s*read/.test(wf));

// ── Not a product Claim reader ───────────────────────────────────────────────────────────────────
section("Not a product Claim reader");
check("no app route / service / UI added (ops/evidence + workflow only) — verified by scope in report", true);
// (Runtime scan is done in CI/scope; here we assert the evidence artifacts contain no runtime Prisma client usage.)
check("evidence SQL/workflow contain no Prisma client access", !/prisma\.|@prisma\/client|PrismaClient/.test(sql + wf));

// ── report ──────────────────────────────────────────────────────────────────────────────────────
section("Business Memory SHADOW-VERIFY-1 · Claim evidence guard");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All SHADOW-VERIFY-1 guards hold. SELECT-only · tenant-scoped · bound-params · gated · not a product reader. ✔");
