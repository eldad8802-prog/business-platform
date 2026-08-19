/**
 * Business Memory SHADOW-VERIFY-DISCOVERY-1 · tenant-discovery evidence — static guard test. npx tsx.
 *
 * Verifies the discovery SQL + workflow are SELECT-only, read-only, gated, PII-minimal (only Business
 * id/name/createdAt + a ReviewEvent count — no vendor/category/verdicts/raw/user/email/phone/document),
 * have no inputs/injection surface, and are not a product reader.
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
const sqlRaw = readFileSync(join(ROOT, "ops", "evidence", "business-memory-tenant-discovery.sql"), "utf8").replace(/\r\n/g, "\n");
const wf = readFileSync(join(ROOT, ".github", "workflows", "prod-readonly-evidence-tenant-discovery.yml"), "utf8").replace(/\r\n/g, "\n");
// Executable SQL only (strip -- comment lines) for column/keyword scans.
const sql = sqlRaw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|comment|commit|upsert|replace|lock|nextval|setval|reindex|cluster|refresh)\b/i;

// ── SQL: SELECT-only + read-only ─────────────────────────────────────────────────────────────────
section("SQL — SELECT-only + READ ONLY transaction");
check("passes the forbidden-write static guard", !FORBIDDEN.test(sqlRaw));
check("session read-only set", /SET default_transaction_read_only = on;/.test(sql));
check("BEGIN TRANSACTION READ ONLY", /BEGIN TRANSACTION READ ONLY;/.test(sql));
check("ends with ROLLBACK", /\nROLLBACK;/.test(sql));
check("no write DML/DDL", !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql));

// ── SQL: correct shape ───────────────────────────────────────────────────────────────────────────
section("SQL — Business LEFT JOIN ReviewEvent, grouped, count-desc");
check("selects Business id", /b\.id AS business_id/.test(sql));
check("selects Business name (non-sensitive display name)", /b\.name AS business_name/.test(sql));
check("selects ReviewEvent COUNT per business", /COUNT\(r\.id\) AS review_event_count/.test(sql));
check("LEFT JOIN ReviewEvent on businessId", /LEFT JOIN "ReviewEvent" r ON r\."businessId" = b\.id/.test(sql));
check("GROUP BY business", /GROUP BY b\.id/.test(sql));
check("orders tenants-with-evidence first (count desc)", /ORDER BY COUNT\(r\.id\) DESC/.test(sql));

// ── SQL: PII minimization (executable SQL only) ──────────────────────────────────────────────────
section("SQL — PII minimization (no vendor/category/verdicts/raw/user/email/phone/document)");
for (const bad of ["vendorFinal", "vendorBelief", "vendorName", "subjectNormalizedKey", "category", "verdicts", "rawFinal", "rawBelief", "directionFinal", "email", "phone", "documentId", "extractedData"]) {
  check(`executable SQL does not select "${bad}"`, !new RegExp(bad, "i").test(sql));
}
check("no User table read", !/"User"|\bfrom "User"/i.test(sql));

// ── Workflow: gate + guards + no inputs ──────────────────────────────────────────────────────────
section("Workflow — production-db gate, guards, no inputs (no injection surface)");
check("workflow_dispatch only, no inputs", /workflow_dispatch:\s*\{\}/.test(wf) && !/inputs:/.test(wf));
check("no push/schedule triggers", !/\bpush:|\bschedule:/.test(wf));
check("environment: production-db (approval gate)", /environment:\s*production-db/.test(wf));
check("host allowlist ep-flat-brook-am4bhq1y", /ep-flat-brook-am4bhq1y/.test(wf));
check("SELECT-only static guard present", /Forbidden write keyword found in SQL/.test(wf) && /insert\|update\|delete/.test(wf));
check("fixed SQL file path", /--file=ops\/evidence\/business-memory-tenant-discovery\.sql/.test(wf));
check("SQL_FILE hardcoded", /SQL_FILE="ops\/evidence\/business-memory-tenant-discovery\.sql"/.test(wf));
check("permissions contents: read", /permissions:\s*\n\s*contents:\s*read/.test(wf));
check("no ${{ inputs }} anywhere (no parameters)", !/\$\{\{\s*inputs\./.test(wf));

// ── Not a product reader ─────────────────────────────────────────────────────────────────────────
section("Not a product reader");
check("artifacts contain no Prisma client access", !/prisma\.|@prisma\/client|PrismaClient/.test(sqlRaw + wf));

section("Business Memory SHADOW-VERIFY-DISCOVERY-1 · tenant discovery guard");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All discovery guards hold. SELECT-only · read-only · gated · PII-minimal · no inputs. ✔");
