// Business Intake — tenant isolation for PostgreSQL LABS, taken VERBATIM from
// the real migration files (policies + grants + REVOKE), with `app_runtime`
// renamed to the lab's runtime role. Labs that build their schema with
// `prisma db push` call this so the batteries prove the SQL that ships:
//
//   M2  20260927180000_m2_intake_event      → IntakeEvent
//   M3  20260929090000_m3_canonical_intake  → IntakeNormalizedEvent
//
// A layout change in either migration throws here instead of silently
// producing a lab without isolation.

import { readFileSync } from "node:fs";

const SECTIONS = [
  {
    stage: "m2",
    file: "prisma/migrations/20260927180000_m2_intake_event/migration.sql",
    start: 'ALTER TABLE "IntakeEvent" ENABLE ROW LEVEL SECURITY;',
  },
  {
    stage: "m3",
    file: "prisma/migrations/20260929090000_m3_canonical_intake/migration.sql",
    start: 'ALTER TABLE "IntakeNormalizedEvent" ENABLE ROW LEVEL SECURITY;',
  },
];

function splitStatements(sql) {
  return sql
    .split(/;\s*\r?\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

/**
 * SQL statements, in order, to run as the table owner. `through: "m2"` stops
 * before the M3 table (a lab reproducing the pre-M3 database).
 */
export function intakeIsolationStatements(runtimeRole, { through = "m3" } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(runtimeRole)) throw new Error("intake isolation: bad role name");
  const out = [];
  for (const { stage, file, start } of SECTIONS) {
    if (through === "m2" && stage === "m3") break;
    const sql = readFileSync(file, "utf8");
    const rlsStart = sql.indexOf(start);
    const doStart = sql.indexOf("DO $do$", rlsStart);
    if (rlsStart < 0 || doStart < 0) throw new Error(`intake isolation: layout of ${file} changed — update the lab helper`);
    out.push(...splitStatements(sql.slice(rlsStart, doStart)));
    out.push(sql.slice(doStart).trim().replace(/;\s*$/, "").replaceAll("app_runtime", runtimeRole));
  }
  return out;
}
