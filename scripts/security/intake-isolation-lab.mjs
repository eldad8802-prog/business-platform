// Business Intake — tenant isolation for PostgreSQL LABS, taken VERBATIM from
// the real migration files (policies + grants + REVOKE), with `app_runtime`
// renamed to the lab's runtime role. Labs that build their schema with
// `prisma db push` call this so the batteries prove the SQL that ships:
//
//   M2  20260927180000_m2_intake_event      → IntakeEvent
//   M3  20260929090000_m3_canonical_intake  → IntakeNormalizedEvent
//   M4  20260930090000_m4_identity_routing  → IdentityLink, IdentityProposal
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
  {
    stage: "m4",
    file: "prisma/migrations/20260930090000_m4_identity_routing/migration.sql",
    start: 'ALTER TABLE "IdentityLink" ENABLE ROW LEVEL SECURITY;',
    // Objects Prisma cannot express (so `db push` never creates them): the
    // partial "one active owner per identifier" index and the composite tenant
    // FKs. They need sec-C's (businessId, id) keys, so only labs that applied
    // sec-C ask for them (`dbOnly: true`).
    dbOnly: /"(IdentityLink_active_identifier_key|(IdentityLink_customerId|IdentityProposal_candidateCustomerId|IdentityProposal_leadId)_tenant_fkey)"/,
    dbOnlyCount: 4,
  },
];
const ORDER = ["m2", "m3", "m4"];

function splitStatements(sql) {
  return sql
    .split(/;\s*\r?\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

/**
 * SQL statements, in order, to run as the table owner. `through: "m2"` stops
 * before the M3 table (a lab reproducing the pre-M3 database). `dbOnly: true`
 * also emits each stage's DB-only structural objects, verbatim.
 */
export function intakeIsolationStatements(runtimeRole, { through = "m4", dbOnly = false } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(runtimeRole)) throw new Error("intake isolation: bad role name");
  const out = [];
  for (const section of SECTIONS) {
    const { stage, file, start } = section;
    if (ORDER.indexOf(stage) > ORDER.indexOf(through)) break;
    const sql = readFileSync(file, "utf8");
    const rlsStart = sql.indexOf(start);
    const doStart = sql.indexOf("DO $do$", rlsStart);
    if (rlsStart < 0 || doStart < 0) throw new Error(`intake isolation: layout of ${file} changed — update the lab helper`);
    if (dbOnly && section.dbOnly) {
      const objs = splitStatements(sql.slice(0, rlsStart)).filter((st) => section.dbOnly.test(st));
      if (objs.length !== section.dbOnlyCount) throw new Error(`intake isolation: expected ${section.dbOnlyCount} DB-only objects in ${file}, found ${objs.length}`);
      out.push(...objs);
    }
    out.push(...splitStatements(sql.slice(rlsStart, doStart)));
    out.push(sql.slice(doStart).trim().replace(/;\s*$/, "").replaceAll("app_runtime", runtimeRole));
  }
  return out;
}
