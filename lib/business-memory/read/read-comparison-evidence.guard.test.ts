/**
 * Business Memory READ-OBS · bm-read-comparison evidence — static guard test. npx tsx. No DB.
 *
 * Verifies the telemetry-evidence SQL + workflow are SELECT-only, read-only, gated, bound-param,
 * ProductUsageEvent-ONLY, filtered to featureKey='business-memory-read-comparison', privacy-safe (no
 * document/vendor/category/evidence business payload), and not a product reader.
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
const sqlRaw = readFileSync(join(ROOT, "ops", "evidence", "business-memory-read-comparison-evidence.sql"), "utf8").replace(/\r\n/g, "\n");
const wf = readFileSync(join(ROOT, ".github", "workflows", "prod-readonly-evidence-read-comparison.yml"), "utf8").replace(/\r\n/g, "\n");
const sql = sqlRaw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|comment|commit|upsert|replace|lock|nextval|setval|reindex|cluster|refresh)\b/i;

section("SQL — SELECT-only + READ ONLY transaction");
check("passes the forbidden-write static guard (whole file)", !FORBIDDEN.test(sqlRaw));
check("session read-only set", /SET default_transaction_read_only = on;/.test(sql));
check("statement timeout set", /SET statement_timeout/.test(sql));
check("BEGIN TRANSACTION READ ONLY", /BEGIN TRANSACTION READ ONLY;/.test(sql));
check("ends with ROLLBACK", /\nROLLBACK;/.test(sql));
check("no write DML/DDL", !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql));

section("SQL — ProductUsageEvent-only, comparison feature, bound tenant");
check("reads ProductUsageEvent", /FROM "ProductUsageEvent"/.test(sql));
check("filters featureKey='business-memory-read-comparison'", /"featureKey" = 'business-memory-read-comparison'/.test(sql));
check("Q1 tenant-scoped by bound businessId", /"businessId" = \(:'businessId'\)::int/.test(sql));
check("uses psql bound var for businessId", /:'businessId'/.test(sql));
check("Q0 is counts-only (action, outcome, count — no businessId/metadata payload)", /SELECT\s+p\.action,\s*p\.outcome,\s*count\(\*\) AS event_count\s+FROM "ProductUsageEvent"/.test(sql));
check("reads NO other business table (Document/ReviewEvent/DerivedClaim/VendorLearning/User/Financial)", !/"(Document|ReviewEvent|DerivedClaim\w*|VendorLearning|User|FinancialRecord|ExtractedData)"/.test(sql));

section("SQL — privacy: no sensitive business columns/payload");
for (const bad of ["vendorName", "vendorFinal", "vendorBelief", "subjectNormalizedKey", "verdicts", "rawFinal", "rawBelief", "ocrText", "documentId", "email", "phone", "extractedData"]) {
  check(`executable SQL does not reference "${bad}"`, !new RegExp(`\\b${bad}\\b`, "i").test(sql));
}
check("no SELECT *", !/SELECT\s+\*/i.test(sql));

section("Workflow — production-db gate, guards, validated input");
check("workflow_dispatch trigger", /on:\s*\n\s*workflow_dispatch:/.test(wf));
check("no push/schedule triggers", !/\bpush:|\bschedule:/.test(wf));
check("environment: production-db (approval gate)", /environment:\s*production-db/.test(wf));
check("host allowlist ep-flat-brook-am4bhq1y", /ep-flat-brook-am4bhq1y/.test(wf));
check("SELECT-only static guard present", /Forbidden write keyword found in SQL/.test(wf) && /insert\|update\|delete/.test(wf));
check("fixed SQL file path", /--file=ops\/evidence\/business-memory-read-comparison-evidence\.sql/.test(wf));
check("SQL_FILE hardcoded", /SQL_FILE="ops\/evidence\/business-memory-read-comparison-evidence\.sql"/.test(wf));
check("businessId validated as positive integer", /\*\[!0-9\]\*\) echo "::error::businessId must be a positive integer/.test(wf));
check("businessId via env (BID), bound via --set, never interpolated into psql", /BID: \$\{\{ inputs\.businessId \}\}/.test(wf) && /--set=businessId="\$BID"/.test(wf) && !wf.split("\n").some((l) => /psql/.test(l) && /\$\{\{\s*inputs\./.test(l)));
check("permissions contents: read", /permissions:\s*\n\s*contents:\s*read/.test(wf));

section("Not a product reader");
check("artifacts contain no Prisma client access", !/prisma\.|@prisma\/client|PrismaClient/.test(sqlRaw + wf));

section("Business Memory READ-OBS · read-comparison evidence guard");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All read-comparison evidence guards hold. SELECT-only · read-only · gated · ProductUsageEvent-only · privacy-safe. ✔");
