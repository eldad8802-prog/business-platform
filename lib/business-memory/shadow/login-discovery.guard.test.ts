/**
 * Business Memory SHADOW-VERIFY-LOGIN-DISCOVERY-1 · tenant login-discovery evidence — static guard. npx tsx.
 *
 * Verifies the login-discovery SQL + workflow are SELECT-only, read-only, gated, tenant-scoped by a bound
 * businessId, positive-integer-validated, PII/secret-minimal (returns ONLY Business id/name + per-user
 * email/name/role/has-logged-in/count — NEVER password/hash/token/session/secret/phone/address), have a
 * fixed SQL path + single input (no arbitrary SQL/path, no generic runner), and are NOT a product/auth
 * reader (no runtime Prisma access).
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
const sqlRaw = readFileSync(join(ROOT, "ops", "evidence", "business-memory-tenant-login-discovery.sql"), "utf8").replace(/\r\n/g, "\n");
const wf = readFileSync(join(ROOT, ".github", "workflows", "prod-readonly-evidence-tenant-login-discovery.yml"), "utf8").replace(/\r\n/g, "\n");
// Executable SQL only (strip -- comment lines) for column/keyword/secret scans.
const sql = sqlRaw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// The EXACT forbidden-write guard used by the workflow (mirrors ops/evidence/prod-readonly-evidence.yml).
const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|comment|commit|upsert|replace|lock|nextval|setval|reindex|cluster|refresh)\b/i;

// ── SQL: SELECT-only + read-only transaction ─────────────────────────────────────────────────────
section("SQL — SELECT-only + READ ONLY transaction");
check("SQL passes the forbidden-write static guard (0 write keywords, whole file)", !FORBIDDEN.test(sqlRaw));
check("session read-only set", /SET default_transaction_read_only = on;/.test(sql));
check("statement timeout set", /SET statement_timeout/.test(sql));
check("BEGIN TRANSACTION READ ONLY", /BEGIN TRANSACTION READ ONLY;/.test(sql));
check("ends with ROLLBACK (never commits)", /\nROLLBACK;/.test(sql));
check("only SELECT statements (no write DML/DDL)", !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql));

// ── SQL: correct shape + tenant scope by bound businessId ────────────────────────────────────────
section("SQL — Business identity + linked Users, scoped by bound businessId");
check("selects Business id", /b\.id\s+AS business_id/.test(sql));
check("selects Business name", /b\.name\s+AS business_name/.test(sql));
check("selects User login email (login identifier)", /u\.email\s+AS login_email/.test(sql));
check("selects User name", /u\.name\s+AS user_name/.test(sql));
check("selects User role", /u\.role::text\s+AS role/.test(sql));
check("selects has_logged_in boolean (lastLoginAt presence only)", /\(u\."lastLoginAt" IS NOT NULL\)\s+AS has_logged_in/.test(sql));
check("selects login_count", /u\."loginCount"\s+AS login_count/.test(sql));
check("Business query scoped by bound businessId", /b\.id = \(:'businessId'\)::int/.test(sql));
check("User query scoped by bound businessId", /u\."businessId" = \(:'businessId'\)::int/.test(sql));
check("no cross-tenant User scan (every User predicate carries businessId)", !/FROM "User"[\s\S]*?WHERE(?![\s\S]*?"businessId")[\s\S]*?;/.test(sql));

// ── SQL: bound param (no injection) ──────────────────────────────────────────────────────────────
section("SQL — bound param (no injection surface)");
check("uses psql bound var for businessId (:'businessId')", /:'businessId'/.test(sql));
check("businessId used ONLY as a bound var (no raw ${{ }} in SQL)", !/\$\{\{/.test(sqlRaw));

// ── SQL: NO secret / sensitive columns ───────────────────────────────────────────────────────────
section("SQL — no secret/sensitive columns");
for (const bad of ["password", "passwordHash", "hash", "token", "session", "secret", "resetToken", "auth", "phone", "address", "updatedAt"]) {
  check(`executable SQL never selects/references "${bad}"`, !new RegExp(`\\b${bad}\\b`, "i").test(sql));
}
check("no SELECT * (explicit column list only)", !/SELECT\s+\*/i.test(sql));

// ── Workflow: gate + guards + single validated input ─────────────────────────────────────────────
section("Workflow — production-db gate, guards, single validated input");
check("workflow_dispatch trigger", /on:\s*\n\s*workflow_dispatch:/.test(wf) && !/\bpush:|\bschedule:/.test(wf));
const inputsBlock = (wf.match(/inputs:\n([\s\S]*?)\npermissions:/) ?? [])[1] ?? "";
check("single input: businessId only (exactly one input, no subjectNormalizedKey)",
  /businessId:/.test(inputsBlock) && (inputsBlock.match(/required:/g) ?? []).length === 1 && !/subjectNormalizedKey/.test(inputsBlock));
check("environment: production-db (approval gate)", /environment:\s*production-db/.test(wf));
check("host allowlist ep-flat-brook-am4bhq1y", /ep-flat-brook-am4bhq1y/.test(wf));
check("SELECT-only static guard present (same FORBIDDEN set)", /Forbidden write keyword found in SQL/.test(wf) && /insert\|update\|delete/.test(wf));
check("fixed SQL file path (no path input)", /--file=ops\/evidence\/business-memory-tenant-login-discovery\.sql/.test(wf));
check("SQL_FILE hardcoded (not from an input)", /SQL_FILE="ops\/evidence\/business-memory-tenant-login-discovery\.sql"/.test(wf));
check("businessId validated as positive integer", /\*\[!0-9\]\*\) echo "::error::businessId must be a positive integer/.test(wf));
check("businessId passed via env (BID), never interpolated into the psql line",
  /BID: \$\{\{ inputs\.businessId \}\}/.test(wf) &&
  !wf.split("\n").some((l) => /psql/.test(l) && /\$\{\{\s*inputs\./.test(l)));
check("businessId bound via --set (not string-concatenated into SQL)", /--set=businessId="\$BID"/.test(wf));
check("permissions contents: read only", /permissions:\s*\n\s*contents:\s*read/.test(wf));

// ── Not a generic runner / not a product or auth reader ──────────────────────────────────────────
section("Not a generic runner / not a product or auth reader");
check("no arbitrary SQL or file-path input (fixed file only)", !/inputs:[\s\S]*?(sqlFile|filePath|sql:|path:|query:)/.test(wf));
check("artifacts contain no Prisma client access (ops/evidence + workflow only)", !/prisma\.|@prisma\/client|PrismaClient/.test(sqlRaw + wf));
check("no auth mutation / user creation / password reset in artifacts", !/\b(setPassword|resetPassword|createUser|updateUser|signIn|login\()\b/i.test(sqlRaw + wf));

section("Business Memory SHADOW-VERIFY-LOGIN-DISCOVERY-1 · login-discovery guard");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All login-discovery guards hold. SELECT-only · read-only · gated · bound-param · no-secret · not a product/auth reader. ✔");
