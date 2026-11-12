// Service Desk loans — mutation run over the code guards. Each mutation weakens one rule in the source, runs the proof
// that must catch it, and restores the file byte-for-byte. Every mutation must be KILLED.
//   PURE    lib/services/service-desk/loans-core.test.ts (no database)
//   SERVICE .sdloancode/battery.ts through the real service, on a fresh copy of <template-db> (the chain + 20261201090000)
//
//   node .sdloancode/mutate.mjs [<template-db>]      (without a template only the PURE mutations run)
// env (SERVICE): PGHOST, PGPORT, SUPER, PGPASSWORD (superuser), LAB_PASSWORD, TASK_REQUEST_HMAC_KEY / _ID, AUTH_TOKEN_SECRET.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TPL = process.argv[2] ?? null;
const CORE = "lib/services/service-desk/loans.core.ts";
const CONTRACTS = "lib/services/service-desk/loans.contracts.ts";
const CASE = "lib/services/service-desk/service-case.core.ts";
const SVC = "lib/services/service-desk/loans.service.ts";
const CASESVC = "lib/services/service-desk/service-case.service.ts";
const PURE = [
  ["status: the exception statuses treated as work", CORE, `return work ? "WORK" : "EXCEPTION";`, `return "WORK";`],
  ["status: a case being cancelled not refused", CORE, `if (c.cancellationRequested || c.outcome === "CANCELLED") return "CANCELLING";`, ``],
  ["lend: the exception names no approval", CORE, `approvals: exception ? ["LEND_OUTSIDE_WORK"] : [],`, `approvals: [],`],
  ["lend: an exception without a reason", CORE, `if (cls === "EXCEPTION" && reason === null`, `if (false && reason === null`],
  ["action: a RETURNED / CLOSED loan may change again", CORE, `if (loan.state !== "OUT") out.push(`, `if (false) out.push(`],
  ["action: the close names no approval", CORE, `approvals: ["LOAN_CLOSE_UNRETURNED"],`, `approvals: [],`],
  ["action: close without a reason", CORE, `if (reason === null && !out.some((x) => x.detail.startsWith("reason"))) out.push(v("REASON_REQUIRED"`, `if (false) out.push(v("REASON_REQUIRED"`],
  ["action: the same expected date accepted", CORE, `else if (d === loan.expectedReturnOn) out.push(`, `else if (false) out.push(`],
  ["identifier: not upper-cased like the database", CONTRACTS, `.replace(/[\\s._/-]+/gu, "").toUpperCase();`, `.replace(/[\\s._/-]+/gu, "");`],
  ["case: CANCEL ignores the loan out", CASE, `      if (!loanerExit(action.loanerOverride, "CANCEL_OPEN_LOANER")) break;\n`, ``],
  ["case: ABANDON ignores the loan out", CASE, `      loanerExit(action.loanerOverride, "ABANDON_OPEN_LOANER");\n`, ``],
  ["case: the exit names no approval", CASE, `    r.approvals.push(kind);\n    r.effects.push("RECORD_LOANER_EXIT_APPROVAL");`, `    r.effects.push("RECORD_LOANER_EXIT_APPROVAL");`],
  ["case: the exit records nothing on the loan", CASE, `    r.approvals.push(kind);\n    r.effects.push("RECORD_LOANER_EXIT_APPROVAL");`, `    r.approvals.push(kind);`],
  ["case: CLOSE with a loan out", CASE, `      // 20261201090000: a case never closes while a lent item is still out (return it, or close the loan with approval)
      if (context.openLoaner) fail(`, `      if (false) fail(`],
  ["case: COMPLETE with a loan out", CASE, `      if (context.openLoaner) fail("OPEN_LOANER", "the temporary replacement item has not been returned or closed");
      if (!isNonNegativeInt(context.openPartReservations)) fail("INVALID_INPUT", "openPartReservations");
      else if (context.openPartReservations > 0) {
        fail("OPEN_PART_RESERVATIONS", \`\${context.openPartReservations} reserved part(s) still open\`);
      }
      if (context.currentQuote?.state === "SENT") fail("OPEN_QUOTE", "a sent quote still awaits a decision");
      r.serverChecks.push("PART_RESERVATIONS_COUNTED_UNDER_LOCK");
      // The balance`, `      if (!isNonNegativeInt(context.openPartReservations)) fail("INVALID_INPUT", "openPartReservations");
      else if (context.openPartReservations > 0) {
        fail("OPEN_PART_RESERVATIONS", \`\${context.openPartReservations} reserved part(s) still open\`);
      }
      if (context.currentQuote?.state === "SENT") fail("OPEN_QUOTE", "a sent quote still awaits a decision");
      r.serverChecks.push("PART_RESERVATIONS_COUNTED_UNDER_LOCK");
      // The balance`],
];
const SERVICE = [
  ["service: openLoaner hard-coded false again", CASESVC, `openLoaner: await caseHasOpenLoan(tx, businessId, caseId),`, `openLoaner: false,`],
  ["service: the cancel exit approval not written", CASESVC, `    const n = await recordLoanerExitApproval(`, `    const n = 1 || await recordLoanerExitApproval(`],
  ["service: no earlier-answer lookup (idempotency)", SVC, `    const prior = await findPriorLoanEvent(tx, b, prepared);\n`, `    const prior = null as { loanId: number; caseId: number } | null;\n`],
  ["service: no double-loan check before the insert (the index race is no longer answered)", SVC, `      if (r[0]?.ok === true) throw new ServiceDeskError("REFUSED", { violations: ["LOAN_ITEM_ALREADY_OUT"] });
`, ``],
  ["service: a loan reached through another case", SVC, `if (!r || Number(r.caseId) !== caseId) throw new ServiceDeskError("NOT_FOUND");`, `if (!r) throw new ServiceDeskError("NOT_FOUND");`],
  ["service: the lend exception approver not stored", SVC, `${"${row.exceptionReason}"}::text, ${"${approver}"}::int, now())`, `${"${row.exceptionReason}"}::text, NULL::int, now())`],
];

function run(cmd, args, env = {}) {
  return spawnSync(process.execPath, [cmd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
}
const H = `${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}`;
const pw = process.env.LAB_PASSWORD ?? "sd_lab_pw";
const superSql = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", process.env.SUPER, "-d", "postgres", "-c", sql], { stdio: "pipe" });

let killed = 0;
const survived = [];
const list = [...PURE.map((m) => ["PURE", ...m]), ...(TPL ? SERVICE.map((m) => ["SERVICE", ...m]) : [])];
const only = process.env.MUT_ONLY ? new RegExp(process.env.MUT_ONLY) : null;
for (const [i, [kind, label, file, from, to]] of list.entries()) {
  if (only && !only.test(label)) continue;
  const orig = readFileSync(file, "utf8");
  if (!orig.includes(from)) { console.log(`  [ANCHOR MISSING] ${label}`); survived.push(label); continue; }
  writeFileSync(file, orig.replace(from, to));
  const db = `${TPL}_cmut${i}`;
  try {
    let r;
    if (kind === "PURE") r = run("node_modules/tsx/dist/cli.mjs", ["lib/services/service-desk/loans-core.test.ts"]);
    else {
      superSql(`DROP DATABASE IF EXISTS ${db}`);
      superSql(`CREATE DATABASE ${db} TEMPLATE ${TPL} OWNER lab_owner`);
      const A = `postgresql://lab_owner:${pw}@${H}/${db}`, R = `postgresql://app_runtime_prod:${pw}@${H}/${db}`;
      r = run("node_modules/tsx/dist/cli.mjs", [".sdloancode/battery.ts"], { OWNER_URL: A, AUTH_DATABASE_URL: A, DATABASE_URL: `${R}?connection_limit=10`, DIRECT_URL: R });
    }
    const out = `${r.stdout}\n${r.stderr}`;
    const line = (out.match(/^.*\d+ passed, \d+ failed.*$/m) ?? ["(no summary)"])[0].trim();
    const first = (out.match(/^\s+\[FAIL\] .*$/m) ?? [""])[0].trim();
    if (r.status !== 0 || / [1-9]\d* failed/.test(line)) { killed++; console.log(`  [KILLED] ${kind} ${label} — ${line}; ${first.slice(0, 140)}`); }
    else { survived.push(label); console.log(`  [SURVIVED] ${kind} ${label} — ${line}`); }
  } finally {
    writeFileSync(file, orig);
    if (readFileSync(file, "utf8") !== orig) throw new Error(`RESTORE NOT BYTE-IDENTICAL: ${file}`);
    if (kind === "SERVICE") superSql(`DROP DATABASE IF EXISTS ${db}`);
  }
}
console.log(`MUTATIONS: ${killed} killed, ${survived.length} survived`);
if (survived.length) process.exit(1);
