// Service Desk handover record (20261130090000) — mutation run. For each key guard: a copy of the template lab (the chain
// applied, legacy rows present), the guard WEAKENED in place (a CHECK dropped, or a function re-created from the
// migration's own text with one rule removed), then .sdhov/battery.ts — which must FAIL. A surviving mutation means a
// rule nothing tests.
//
//   node .sdhov/mutate.mjs <template-db>
// env: PGHOST, PGPORT, SUPER, PGPASSWORD (superuser), LAB_PASSWORD. Synthetic only.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const TPL = process.argv[2];
if (!TPL) { console.error("usage: mutate.mjs <template-db>"); process.exit(2); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const MIG = readFileSync(path.join(ROOT, "prisma/migrations/20261130090000_service_handover_debt_record/migration.sql"), "utf8");
const H = `${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}`;
const pw = process.env.LAB_PASSWORD ?? "sd_lab_pw";
const ownerUrl = (db) => `postgresql://lab_owner:${pw}@${H}/${db}`;
const runtimeUrl = (db) => `postgresql://app_runtime_prod:${pw}@${H}/${db}`;
const superSql = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", process.env.SUPER, "-d", "postgres", "-c", sql], { stdio: "pipe" });
const fn = (name) => {
  const m = MIG.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\$fn\\$;`));
  if (!m) throw new Error(`${name} not found in the migration`);
  return m[0];
};
const cut = (text, from, to) => {
  const i = text.indexOf(from);
  const j = text.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error(`mutation anchor not found: ${from.slice(0, 60)}`);
  return text.slice(0, i) + text.slice(j + to.length);
};
const replace = (text, a, b) => { if (!text.includes(a)) throw new Error(`mutation anchor not found: ${a.slice(0, 60)}`); return text.replace(a, b); };

const MUTATIONS = [
  ["drop CHECK ServiceHandover_balance", `ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_balance";`],
  ["drop CHECK ServiceHandover_debt_decided", `ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_debt_decided";`],
  ["drop CHECK ServiceHandover_loaner_decided", `ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_loaner_decided";`],
  ["record guard: no version-2 requirement", replace(fn("service_handover_record_guard"), `IF NEW."recordVersion" IS DISTINCT FROM 2 THEN`, `IF false THEN`)],
  ["record guard: no actor / born-erased rule", replace(fn("service_handover_record_guard"), `IF NEW."erasedAt" IS NOT NULL OR NEW."actorUserId" IS NULL THEN`, `IF false THEN`)],
  ["record guard: a debt without an approver", replace(fn("service_handover_record_guard"), `IF NEW."openBalanceAgorot" > 0 AND NEW."debtApprovedByUserId" IS NULL THEN`, `IF false THEN`)],
  ["record guard: loaner without an approver", replace(fn("service_handover_record_guard"), `IF NEW."loanerOverrideReason" IS NOT NULL AND NEW."loanerApprovedByUserId" IS NULL THEN`, `IF false THEN`)],
  ["record guard: approver may differ from the actor (debt)", replace(fn("service_handover_record_guard"), `(NEW."debtApprovedByUserId" IS NOT NULL AND NEW."debtApprovedByUserId" <> NEW."actorUserId")`, `false`)],
  ["record guard: approver may differ from the actor (loaner)", replace(fn("service_handover_record_guard"), `OR (NEW."loanerApprovedByUserId" IS NOT NULL AND NEW."loanerApprovedByUserId" <> NEW."actorUserId")`, ``)],
  ["record guard: a deleting business accepted", replace(fn("service_handover_record_guard"), `IF NOT public.service_ui_business_writable(NEW."businessId") THEN`, `IF false THEN`)],
  ["completion guard: approver may differ from the actor", replace(fn("service_completion_guard"), `IF NEW."debtApprovedByUserId" IS NOT NULL AND NEW."debtApprovedByUserId" <> NEW."actorUserId" THEN`, `IF false THEN`)],
  ["handover guard: foundation erasure may re-attribute approvers", replace(fn("service_handover_guard"), `AND NEW."loanerOverrideReason" IS NULL AND NEW."actorUserId" IS NULL AND NEW."erasedAt" IS NOT NULL
       AND approvers_kept_or_null THEN`, `AND NEW."loanerOverrideReason" IS NULL AND NEW."actorUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN`)],
  ["handover guard: record erasure may change anything", replace(fn("service_handover_guard"), `AND (to_jsonb(NEW) - approvers) = (to_jsonb(OLD) - approvers)
       AND NEW."debtApprovedByUserId" IS NULL AND NEW."loanerApprovedByUserId" IS NULL THEN`, `THEN`)],
  ["handover guard: any update allowed (immutability gone)", replace(fn("service_handover_guard"), `  RAISE EXCEPTION USING
    ERRCODE = 'DZS07',
    MESSAGE = format('SERVICE_HANDOVER_FIXED`, `  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZS07',
    MESSAGE = format('SERVICE_HANDOVER_FIXED`)],
  // (The foundation form — the actor only — is an EQUIVALENT mutant while approver = actor is enforced: an approver of
  // another business is then also the actor. The approver arguments are kept for the day that rule is relaxed.)
  ["same-business trigger: the actor not checked", `DROP TRIGGER "ServiceHandover_user_same_business" ON "ServiceHandover";
     CREATE TRIGGER "ServiceHandover_user_same_business" BEFORE INSERT ON "ServiceHandover"
       FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('debtApprovedByUserId');`],
  ["erase: the loaner approver kept", replace(fn("service_handover_record_erase_business"), `SET "debtApprovedByUserId" = NULL, "loanerApprovedByUserId" = NULL`, `SET "debtApprovedByUserId" = NULL`)],
  ["erase: no deleting check", replace(fn("service_handover_record_erase_business"), `IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business`, `IF false AND NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business`)],
];

let killed = 0;
const survived = [];
for (const [i, [label, sql]] of MUTATIONS.entries()) {
  const db = `${TPL}_mut${i}`;
  superSql(`DROP DATABASE IF EXISTS ${db}`);
  superSql(`CREATE DATABASE ${db} TEMPLATE ${TPL} OWNER lab_owner`);
  try {
    execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", ownerUrl(db), "-c", sql], { stdio: "pipe" });
    const run = spawnSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, ".sdhov/battery.ts")], {
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
