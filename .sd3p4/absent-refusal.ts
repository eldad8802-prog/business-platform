/**
 * Service Desk P4 — the journal-absent mode, as explicit refusals (audit journal lab, step 5). Synthetic labs only.
 *
 * Until M1 the 1.3a battery ran here in journal-absent mode: on a 1.3-0-only lab every journaled command had to answer
 * NOT_AVAILABLE_UNTIL_AUDIT with no write. The code of this checkout writes M1's columns (openCase, on every case), and
 * M1 can only be applied after the case charge, which can only be applied after P4 — so that lab can never carry the
 * code (owner decision 2026-11-12, option A: replace that run with an explicit, counted refusal check, same lab).
 *
 *   J1  the lab is 1.3-0 without the journal: the code's own probe (auditJournalReady) is false there;
 *   J2  the case charge migration (M1's premise), applied verbatim, REFUSES with its P4 message — nothing changed;
 *   J3  M1, applied verbatim, REFUSES at its premise — P4's ServiceSettingsEvent is the one table it reads that is missing —
 *       nothing changed;
 *   J4  after both refusals the lab is still journal-less and carries neither the charge nor M1 (the code's probes);
 *   J5  `prisma migrate deploy` order: P4 sorts before the charge and M1, so a deploy can never reach M1 without P4;
 *   J6  the charge's P4 premise is a constraint P4 creates in the same migration as the objects the code's probe reads
 *       (ServiceEventType 'qa.recorded', ServiceSettingsEvent) — so a database that carries M1 carries the journal;
 *   J7  on a lab that carries M1 (CARRIER_OWNER_URL), the code's probes are true: NOT_AVAILABLE_UNTIL_AUDIT unreachable.
 *
 * env: ABSENT_OWNER_URL (a 1.3-0-only lab: .sd3/lab.sh <db> --with-sd3), CARRIER_OWNER_URL (a lab with P4 … M1).
 * Prints "audit journal (P4) absent" and "<n> passed, <m> failed".
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  AUDIT_JOURNAL_READY_SQL, CHARGE, CHARGE_LEDGER_READY_SQL, CHARGE_REFUSAL, M1, M1_CHARGE_REFUSAL, M1_PREMISE_MISSING_SQL, M1_REFUSAL, P4, migrationSql, psqlAt, refusedUnchanged,
} from "./absent-refusal-checks";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); }
}

const ABSENT = process.env.ABSENT_OWNER_URL;
const CARRIER = process.env.CARRIER_OWNER_URL;
if (!ABSENT || !CARRIER) { console.log("ABSENT_OWNER_URL and CARRIER_OWNER_URL are required"); process.exit(1); }

const journalReady = psqlAt(ABSENT, AUDIT_JOURNAL_READY_SQL);
const isSd3 = psqlAt(ABSENT, `SELECT (to_regclass('public."ServiceCase"') IS NOT NULL AND to_regclass('public."ServiceIntakePhoto"') IS NOT NULL)::text`);
console.log(`audit journal (P4) ${journalReady === "true" ? "PRESENT" : "absent"}`);
ok("J1 the lab is 1.3-0 without the audit journal (the code's auditJournalReady probe is false)", journalReady === "false" && isSd3 === "true", { journalReady, isSd3 });

const charge = refusedUnchanged(ABSENT, CHARGE, CHARGE_REFUSAL);
ok("J2 the case charge migration (M1's premise), applied verbatim, refuses: the P4 audit journal is not applied — nothing changed", charge.ok, charge.detail);
const m1Missing = psqlAt(ABSENT, M1_PREMISE_MISSING_SQL);
const m1 = refusedUnchanged(ABSENT, M1, M1_REFUSAL);
ok("J3 M1, applied verbatim, refuses at its premise (the one table it reads that is missing is P4's ServiceSettingsEvent) — nothing changed",
  m1.ok && m1Missing === "ServiceSettingsEvent", `missing=${m1Missing} ${m1.detail}`);

const still = psqlAt(ABSENT, `SELECT (to_regclass('public."ServiceCompletion"') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ServiceCase' AND column_name = 'workType'))::text`);
ok("J4 after both refusals: still journal-less, no case charge ledger, no M1 objects (the code cannot run here)",
  psqlAt(ABSENT, AUDIT_JOURNAL_READY_SQL) === "false" && psqlAt(ABSENT, CHARGE_LEDGER_READY_SQL) === "false" && still === "true");

const dirs = fs.readdirSync(path.join(process.cwd(), "prisma/migrations")).filter((d) => fs.existsSync(path.join(process.cwd(), "prisma/migrations", d, "migration.sql"))).sort();
const at = (n: string) => dirs.indexOf(n);
ok("J5 migrate deploy order (name order): P4 < the charge < M1, all three in this checkout", at(P4) >= 0 && at(P4) < at(CHARGE) && at(CHARGE) < at(M1), { p4: at(P4), charge: at(CHARGE), m1: at(M1) });

const p4Sql = migrationSql(P4);
const chargeSql = migrationSql(CHARGE);
const m1Sql = migrationSql(M1);
const svc = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/service-case.service.ts"), "utf8");
ok("J6 the chain is in the migrations: M1 requires P4's ServiceSettingsEvent and the charge's ServiceCaseEvent_charge_in_place, the charge requires P4's ServiceCaseEvent_record_in_place, which P4 creates with 'qa.recorded' and ServiceSettingsEvent — the objects the code's probe reads",
  /conname = 'ServiceCaseEvent_charge_in_place'/.test(m1Sql) && M1_CHARGE_REFUSAL.test(m1Sql) && m1Sql.includes(`to_regclass('public."ServiceSettingsEvent"') IS NULL`) && /ADD CONSTRAINT "ServiceCaseEvent_charge_in_place"/.test(chargeSql)
  && /conname = 'ServiceCaseEvent_record_in_place'/.test(chargeSql) && CHARGE_REFUSAL.test(chargeSql)
  && /ADD CONSTRAINT "ServiceCaseEvent_record_in_place"/.test(p4Sql) && /ADD VALUE IF NOT EXISTS 'qa\.recorded'/.test(p4Sql) && /CREATE TABLE "ServiceSettingsEvent"/.test(p4Sql)
  && svc.includes("e.enumlabel = 'qa.recorded'") && svc.includes(`to_regclass('public."ServiceSettingsEvent"') IS NOT NULL`));

const carries = psqlAt(CARRIER, `SELECT (to_regclass('public."ServiceCompletion"') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ServiceCase' AND column_name = 'workType'))::text`);
ok("J7 on a lab that carries M1, the code's probes are true: NOT_AVAILABLE_UNTIL_AUDIT is unreachable wherever this code can run",
  carries === "true" && psqlAt(CARRIER, AUDIT_JOURNAL_READY_SQL) === "true" && psqlAt(CARRIER, CHARGE_LEDGER_READY_SQL) === "true", { carries });

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
