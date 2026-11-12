// Service Desk loans (20261201090000) — mutation run. For each key guard: a copy of the template lab (the chain applied),
// the guard WEAKENED in place (a CHECK / index dropped, or a function re-created from the migration's own text with one
// rule removed), then .sdloan/battery.ts — which must FAIL. A surviving mutation means a rule nothing tests.
//
//   node .sdloan/mutate.mjs <template-db>
// env: PGHOST, PGPORT, SUPER, PGPASSWORD (superuser), LAB_PASSWORD. Synthetic only.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TPL = process.argv[2];
if (!TPL) { console.error("usage: mutate.mjs <template-db>"); process.exit(2); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const MIG = readFileSync(path.join(ROOT, "prisma/migrations/20261201090000_service_desk_loans/migration.sql"), "utf8");
const H = `${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}`;
const pw = process.env.LAB_PASSWORD ?? "sd_lab_pw";
const ownerUrl = (db) => `postgresql://lab_owner:${pw}@${H}/${db}`;
const runtimeUrl = (db) => `postgresql://app_runtime_prod:${pw}@${H}/${db}`;
const superSql = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", process.env.SUPER, "-d", "postgres", "-c", sql], { stdio: "pipe" });
const fn = (name) => {
  const m = MIG.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\$fn\\$;`));
  if (!m) throw new Error(`${name} not found in the migration text`);
  return m[0];
};
const replace = (text, a, b) => { if (!text.includes(a)) throw new Error(`mutation anchor not found: ${a.slice(0, 70)}`); return text.replace(a, b); };

const MUTATIONS = [
  ["drop the double-loan index", `DROP INDEX "ServiceLoan_one_out_per_identifier";`],
  ["drop CHECK ServiceLoan_state_shape", `ALTER TABLE "ServiceLoan" DROP CONSTRAINT "ServiceLoan_state_shape";`],
  ["drop CHECK ServiceLoan_texts", `ALTER TABLE "ServiceLoan" DROP CONSTRAINT "ServiceLoan_texts";`],
  ["drop CHECK ServiceLoanEvent_approval", `ALTER TABLE "ServiceLoanEvent" DROP CONSTRAINT "ServiceLoanEvent_approval";`],
  ["drop CHECK ServiceLoanEvent_tokens", `ALTER TABLE "ServiceLoanEvent" DROP CONSTRAINT "ServiceLoanEvent_tokens";`],
  ["drop UNIQUE idempotency key", `DROP INDEX "ServiceLoanEvent_businessId_idempotencyKey_key";`],
  ["insert guard: any case status", replace(fn("service_loan_insert_guard"), `IF NOT work_status AND NOT exception_status THEN`, `IF false THEN`)],
  ["insert guard: a cancelling case accepted", replace(fn("service_loan_insert_guard"), `IF c."cancellationRequested" OR c."outcome" IS NOT DISTINCT FROM 'CANCELLED' THEN`, `IF false THEN`)],
  ["insert guard: exception without approval", replace(fn("service_loan_insert_guard"), `IF exception_status AND (NEW."lendExceptionReason" IS NULL OR NEW."lendApprovedByUserId" IS NULL) THEN`, `IF false THEN`)],
  ["insert guard: work status takes an exception", replace(fn("service_loan_insert_guard"), `IF work_status AND (NEW."lendExceptionReason" IS NOT NULL`, `IF false AND (NEW."lendExceptionReason" IS NOT NULL`)],
  ["insert guard: approver may differ from the lender", replace(fn("service_loan_insert_guard"), `IF NEW."lendApprovedByUserId" IS NOT NULL AND NEW."lendApprovedByUserId" <> NEW."lentByUserId" THEN`, `IF false THEN`)],
  ["insert guard: non-initial row", replace(fn("service_loan_insert_guard"), `IF NEW."state" <> 'OUT' OR NEW."lastEventKind" <> 'LENT' OR NEW."version" <> 1 OR NEW."erasedAt" IS NOT NULL`, `IF NEW."state" <> 'OUT' OR NEW."lastEventKind" <> 'LENT' OR false`)],
  ["insert guard: lentAt from the writer", replace(fn("service_loan_insert_guard"), `NEW."lentAt" := CURRENT_TIMESTAMP;`, ``)],
  ["insert guard: no business-deleting check", replace(fn("service_loan_insert_guard"), `IF NOT public.service_ui_business_writable(NEW."businessId") THEN`, `IF false THEN`)],
  ["insert guard: no case lock / case check", replace(fn("service_loan_insert_guard"), `IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'SERVICE_LOAN_CASE_INVALID`, `IF false THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'SERVICE_LOAN_CASE_INVALID`)],
  ["update guard: a final loan may change (double return)", replace(fn("service_loan_guard"), `IF OLD."state" <> 'OUT' THEN`, `IF false THEN`)],
  ["update guard: no version rule", replace(fn("service_loan_guard"), `IF NEW."version" <> OLD."version" + 1 THEN`, `IF false THEN`)],
  ["update guard: a kind may change any column", replace(fn("service_loan_guard"), `IF (to_jsonb(NEW) - allowed - bookkeeping) <> (to_jsonb(OLD) - allowed - bookkeeping) THEN`, `IF false THEN`)],
  ["update guard: close without approver", replace(fn("service_loan_guard"), `IF NEW."state" <> 'CLOSED' OR NEW."closedByUserId" IS NULL OR NEW."closeApprovedByUserId" IS NULL OR NEW."closeNote" IS NULL THEN`, `IF NEW."state" <> 'CLOSED' THEN`)],
  ["update guard: close approver may differ", replace(fn("service_loan_guard"), `IF NEW."closeApprovedByUserId" <> NEW."closedByUserId" THEN`, `IF false THEN`)],
  ["update guard: returner of another business", replace(fn("service_loan_guard"), `AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = uid AND u."businessId" = NEW."businessId") THEN`, `AND false THEN`)],
  ["update guard: return without receiver", replace(fn("service_loan_guard"), `IF NEW."state" <> 'RETURNED' OR NEW."returnedByUserId" IS NULL THEN`, `IF NEW."state" <> 'RETURNED' THEN`)],
  ["update guard: same expected date accepted", replace(fn("service_loan_guard"), `IF k = 'EXPECTED_RETURN_CHANGED' AND NEW."expectedReturnOn" IS NOT DISTINCT FROM OLD."expectedReturnOn" THEN`, `IF false THEN`)],
  ["update guard: erasure marker for anyone", replace(fn("service_loan_guard"), `AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  erasable constant text[] := ARRAY['itemName'`, `OR true;
  erasable constant text[] := ARRAY['itemName'`)],
  ["update guard: deleted-user path may change anything", replace(fn("service_loan_guard"), `IF pg_trigger_depth() > 1
     AND (to_jsonb(NEW) - user_refs) = (to_jsonb(OLD) - user_refs)`, `IF pg_trigger_depth() >= 1
     AND (to_jsonb(NEW) - user_refs) = (to_jsonb(OLD) - user_refs)`)],
  ["no silent change check", replace(fn("service_loan_has_event"), `IF NOT EXISTS (SELECT 1 FROM "ServiceLoanEvent" e`, `IF false AND NOT EXISTS (SELECT 1 FROM "ServiceLoanEvent" e`)],
  ["event: no mirror check", replace(fn("service_loan_event_matches_loan"), `IF NEW."seq" <> l."version" OR NEW."kind" <> l."lastEventKind"`, `IF false AND NEW."seq" <> l."version" OR false AND NEW."kind" <> l."lastEventKind"`)],
  ["event: approver may differ from the actor", replace(fn("service_loan_event_matches_loan"), `IF NEW."approvedByUserId" IS NOT NULL AND NEW."approvedByUserId" <> NEW."actorUserId" THEN`, `IF false THEN`)],
  ["event: exit not bound to the case event", replace(fn("service_loan_event_matches_loan"), `IF case_action IS NULL OR NEW."caseSeq" <> case_version OR case_action::text <> want_action THEN`, `IF false THEN`)],
  ["event: exit bound to any seq", replace(fn("service_loan_event_matches_loan"), `OR NEW."caseSeq" <> case_version`, ``)],
  ["event: approval without approver/reason", replace(fn("service_loan_event_matches_loan"), `IF NEW."approvalKind" IS NOT NULL AND (NEW."approvedByUserId" IS NULL OR NEW."reason" IS NULL) THEN`, `IF false THEN`)],
  ["event: other business's loan", replace(fn("service_loan_event_matches_loan"), `IF NOT FOUND OR l."caseId" <> NEW."caseId" THEN`, `IF false THEN`)],
  ["journal: owner may edit / delete", replace(fn("service_loan_event_guard"), `  RAISE EXCEPTION USING
    ERRCODE = 'DZL05'`, `  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF; IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZL05'`)],
  ["case exit: CLOSED with a loan out", replace(fn("service_loan_case_exit_guard"), `IF c."status" = 'CLOSED' THEN`, `IF false THEN`)],
  ["case exit: cancel without approval", replace(fn("service_loan_case_exit_guard"), `IF (c."status" = 'CANCELLED' OR c."cancellationRequested" OR c."outcome" IS NOT DISTINCT FROM 'CANCELLED')`, `IF (c."status" = 'CANCELLED')`)],
  ["case exit: held-item / requested cancel not covered", replace(fn("service_loan_case_exit_guard"), `OR c."cancellationRequested" OR c."outcome" IS NOT DISTINCT FROM 'CANCELLED')`, `)`)],
  ["case exit: abandon without approval", replace(fn("service_loan_case_exit_guard"), `IF c."status" = 'ABANDONED'`, `IF false`)],
  ["case exit: delivered without approval", replace(fn("service_loan_case_exit_guard"), `IF c."status" = 'DELIVERED'`, `IF false`)],
  ["handover: loan out without exception", replace(fn("service_loan_handover_guard"), `IF NEW."loanerOverrideReason" IS NULL AND EXISTS`, `IF false AND EXISTS`)],
  ["same-business at insert: the lender not checked", `DROP TRIGGER "ServiceLoan_user_same_business" ON "ServiceLoan";
     CREATE TRIGGER "ServiceLoan_user_same_business" BEFORE INSERT ON "ServiceLoan"
       FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('lendApprovedByUserId');`],
  ["same-business at insert: the multi-column trigger also on UPDATE (the user-deletion trap)", `DROP TRIGGER "ServiceLoan_user_same_business" ON "ServiceLoan";
     CREATE TRIGGER "ServiceLoan_user_same_business" BEFORE INSERT OR UPDATE OF "lentByUserId", "lendApprovedByUserId", "returnedByUserId" ON "ServiceLoan"
       FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('lentByUserId', 'lendApprovedByUserId', 'returnedByUserId');`],
  ["RLS: no FORCE on ServiceLoan", `ALTER TABLE "ServiceLoan" NO FORCE ROW LEVEL SECURITY; ALTER TABLE "ServiceLoan" DISABLE ROW LEVEL SECURITY;`],
  ["erase: the users kept", replace(fn("service_loan_erase_business"), `"returnedByUserId" = NULL, "closedByUserId" = NULL, "closeApprovedByUserId" = NULL,`, ``)],
  ["erase: no deleting check", replace(fn("service_loan_erase_business"), `IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business`, `IF false AND NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business`)],
  ["erase: every business", replace(fn("service_loan_erase_business"), `WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceLoanEvent"`, `WHERE "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceLoanEvent"`)],
];

let killed = 0;
const survived = [];
const only = process.env.MUT_ONLY ? new RegExp(process.env.MUT_ONLY) : null;
for (const [i, [label, sql]] of MUTATIONS.entries()) {
  if (only && !only.test(label)) continue;
  const db = `${TPL}_mut${i}`;
  superSql(`DROP DATABASE IF EXISTS ${db}`);
  superSql(`CREATE DATABASE ${db} TEMPLATE ${TPL} OWNER lab_owner`);
  try {
    // the weakened SQL goes through a UTF-8 file, never the command line (a code page must not touch its text)
    const dir = mkdtempSync(path.join(tmpdir(), "sdloan-mut-"));
    const file = path.join(dir, "mutation.sql");
    writeFileSync(file, sql, "utf8");
    try { execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", ownerUrl(db), "-f", file], { stdio: "pipe" }); } finally { rmSync(dir, { recursive: true, force: true }); }
    const run = spawnSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, ".sdloan/battery.ts")], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OWNER_URL: ownerUrl(db), DATABASE_URL: `${runtimeUrl(db)}?connection_limit=10`, DIRECT_URL: runtimeUrl(db) },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    const line = (out.match(/^\d+ passed, \d+ failed$/m) ?? ["(no summary)"])[0];
    const first = (out.match(/^\s+\[FAIL\] .*$/m) ?? [""])[0].trim();
    if (run.status !== 0 || !/ 0 failed$/.test(line)) { killed++; console.log(`  [KILLED] ${label} — ${line}; ${first.slice(0, 160)}`); }
    else { survived.push(label); console.log(`  [SURVIVED] ${label} — ${line}`); }
  } finally {
    superSql(`DROP DATABASE IF EXISTS ${db}`);
  }
}
console.log(`MUTATIONS: ${killed} killed, ${survived.length} survived`);
if (survived.length) process.exit(1);
