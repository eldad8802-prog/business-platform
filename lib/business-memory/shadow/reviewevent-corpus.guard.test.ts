/**
 * Business Memory SHADOW-COMPARISON-2 · ReviewEvent corpus evidence — static guard test. npx tsx. No DB.
 *
 * Verifies the corpus SQL + workflow are SELECT-only, read-only, gated, no-input (no injection surface),
 * privacy-minimal (no amount/document/customer/raw-payload/raw-vendor output), and not a product reader.
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
const sqlRaw = readFileSync(join(ROOT, "ops", "evidence", "business-memory-reviewevent-corpus.sql"), "utf8").replace(/\r\n/g, "\n");
const wf = readFileSync(join(ROOT, ".github", "workflows", "prod-readonly-evidence-reviewevent-corpus.yml"), "utf8").replace(/\r\n/g, "\n");
// Executable SQL only (strip -- comment lines) for column/keyword scans.
const sql = sqlRaw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|comment|commit|upsert|replace|lock|nextval|setval|reindex|cluster|refresh)\b/i;

section("SQL — SELECT-only + READ ONLY transaction");
check("passes the forbidden-write static guard (whole file)", !FORBIDDEN.test(sqlRaw));
check("session read-only set", /SET default_transaction_read_only = on;/.test(sql));
check("statement timeout set", /SET statement_timeout/.test(sql));
check("BEGIN TRANSACTION READ ONLY", /BEGIN TRANSACTION READ ONLY;/.test(sql));
check("ends with ROLLBACK", /\nROLLBACK;/.test(sql));
check("no write DML/DDL", !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql));

section("SQL — correct shape (scenario classification over ReviewEvent)");
check("reads ReviewEvent", /FROM "ReviewEvent"/.test(sql));
check("classifies via a scenario column", /AS scenario/.test(sql));
check("emits event/qualifying/confirmed/corrected counts", /AS event_count/.test(sql) && /AS qualifying_event_count/.test(sql) && /AS confirmed_count/.test(sql) && /AS corrected_count/.test(sql));
check("emits distinct qualifying category count + values", /AS distinct_qualifying_category_count/.test(sql) && /AS qualifying_category_values/.test(sql));
check("cross-tenant same-subject query present", /AS tenant_count/.test(sql) && /HAVING count\(DISTINCT business_id\) >= 2/.test(sql));
check("control subject shadow qa vendor present", /'shadow qa vendor'/.test(sql));
check("uses canonical qualifying predicate (confirmed|corrected + non-empty final)", /category_verdict IN \('confirmed','corrected'\)/.test(sql) && /category_final IS NOT NULL/.test(sql));

section("SQL — privacy minimization (normalized subject only; no sensitive columns)");
check("normalizes vendor into a subject key (never outputs raw vendor)", /translate\(coalesce\(r\."vendorFinal"/.test(sql));
check("no raw-vendor output alias", !/AS\s+vendor(_?final|_?raw|_?name)?\b/i.test(sql));
for (const bad of ["amount", "documentId", "rawFinal", "rawBelief", "email", "phone", "customer", "ocrText", "extractedData", "fileUrl"]) {
  check(`executable SQL does not reference "${bad}"`, !new RegExp(`\\b${bad}\\b`, "i").test(sql));
}
check("no SELECT *", !/SELECT\s+\*/i.test(sql));
check("no User table read", !/"User"/.test(sql));

section("Workflow — production-db gate, guards, no inputs");
check("workflow_dispatch only, no inputs", /workflow_dispatch:\s*\{\}/.test(wf) && !/inputs:/.test(wf));
check("no push/schedule triggers", !/\bpush:|\bschedule:/.test(wf));
check("environment: production-db (approval gate)", /environment:\s*production-db/.test(wf));
check("host allowlist ep-flat-brook-am4bhq1y", /ep-flat-brook-am4bhq1y/.test(wf));
check("SELECT-only static guard present", /Forbidden write keyword found in SQL/.test(wf) && /insert\|update\|delete/.test(wf));
check("fixed SQL file path", /--file=ops\/evidence\/business-memory-reviewevent-corpus\.sql/.test(wf));
check("SQL_FILE hardcoded", /SQL_FILE="ops\/evidence\/business-memory-reviewevent-corpus\.sql"/.test(wf));
check("permissions contents: read", /permissions:\s*\n\s*contents:\s*read/.test(wf));
check("no ${{ inputs }} anywhere", !/\$\{\{\s*inputs\./.test(wf));

section("Not a product reader");
check("artifacts contain no Prisma client access", !/prisma\.|@prisma\/client|PrismaClient/.test(sqlRaw + wf));

section("Business Memory SHADOW-COMPARISON-2 · corpus guard");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All corpus guards hold. SELECT-only · read-only · gated · privacy-minimal · no inputs. ✔");
