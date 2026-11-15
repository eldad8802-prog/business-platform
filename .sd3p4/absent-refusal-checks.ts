/**
 * Service Desk P4 — the journal-absent state, proven unreachable for the code of this checkout (shared by
 * .sd3p4/absent-refusal.ts and section A of .sd3p4/records-battery.ts). Synthetic labs only; ZERO secrets.
 *
 * The code writes M1's columns (openCase, on every case). M1 (20261127090000) refuses without the case charge
 * (20261126090000), and the charge refuses without the P4 audit journal (20261122090000). So a database without the
 * journal can never carry this code, and the code's NOT_AVAILABLE_UNTIL_AUDIT path cannot be reached on a database that
 * carries M1. These helpers apply a migration VERBATIM from prisma/migrations (as `prisma migrate deploy` applies it: one
 * transaction, ON_ERROR_STOP) and fingerprint the schema before / after, so "refused and nothing changed" is exact.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const P4 = "20261122090000_service_desk_audit_journal";
export const CHARGE = "20261126090000_service_desk_case_charge";
export const M1 = "20261127090000_service_desk_tracks";
export const CHARGE_REFUSAL = /SERVICE_DESK_CHARGE: the P4 audit journal \(20261122090000\) is not applied; nothing was changed/;
/** M1 refuses on a journal-less database at its table premise (P4's ServiceSettingsEvent is missing) — or, where that
 * table exists, at its charge premise. Either message is M1 refusing because the chain before it is not applied. */
export const M1_REFUSAL = /SERVICE_DESK_TRACKS: (a Service Desk table \(or Appointment\) this migration reads is missing|the case charge migration \(20261126090000\) is not applied); nothing was changed/;
export const M1_CHARGE_REFUSAL = /SERVICE_DESK_TRACKS: the case charge migration \(20261126090000\) is not applied; nothing was changed/;
/** Of the tables M1's premise reads, the ones missing (a journal-less 1.3-0 lab: exactly ServiceSettingsEvent, P4's). */
export const M1_PREMISE_MISSING_SQL = `SELECT coalesce(string_agg(t, ',' ORDER BY t), '') FROM unnest(ARRAY['ServiceCase', 'ServiceDevice', 'ServiceSettings',
  'ServiceSettingsEvent', 'ServicePart', 'ServiceExternalWork', 'ServiceWarrantyOffer', 'Appointment']) t WHERE to_regclass(format('public.%I', t)) IS NULL`;

/** The code's own probes (service-case.service.ts auditJournalReady, quote.service.ts chargeLedgerReady), verbatim. */
export const AUDIT_JOURNAL_READY_SQL = `SELECT (EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ServiceEventType' AND e.enumlabel = 'qa.recorded')
        AND to_regclass('public."ServiceSettingsEvent"') IS NOT NULL)::text`;
export const CHARGE_LEDGER_READY_SQL = `SELECT (to_regclass('public."ServiceCaseCharge"') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ServiceChargeSource' AND e.enumlabel = 'APPROVED_QUOTE'))::text`;

export function psqlAt(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-At", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${`${r.stderr}`.slice(-300)}`);
  return `${r.stdout}`.replace(/\r/g, "").trim();
}

/** Everything a migration could change in public: relations, columns, constraints, indexes, types + enum labels,
 * functions, triggers, policies, grants on tables, and the migration ledger. */
export function fingerprint(url: string): string {
  return psqlAt(url, `SELECT md5(string_agg(x, E'\\n' ORDER BY x)) FROM (
      SELECT 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(array_to_string(c.relacl, ','), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      UNION ALL SELECT 'col ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') FROM information_schema.columns WHERE table_schema = 'public'
      UNION ALL SELECT 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      UNION ALL SELECT 'enum ' || t.typname || ' ' || e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      UNION ALL SELECT 'type ' || typname FROM pg_type WHERE typnamespace = 'public'::regnamespace
      UNION ALL SELECT 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      UNION ALL SELECT 'trg ' || tgrelid::regclass::text || ' ' || tgname FROM pg_trigger WHERE NOT tgisinternal
      UNION ALL SELECT 'pol ' || tablename || ' ' || policyname || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_policies WHERE schemaname = 'public'
      UNION ALL SELECT 'ledger ' || migration_name || ' ' || coalesce(finished_at::text, '-') || ' ' || coalesce(rolled_back_at::text, '-') FROM "_prisma_migrations"
    ) s(x)`);
}

/** Apply prisma/migrations/<name>/migration.sql verbatim, in one transaction, stopping at the first error. */
export function applyVerbatim(url: string, name: string, root = process.cwd()) {
  const file = path.join(root, "prisma/migrations", name, "migration.sql");
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", url, "-f", file], { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } });
  return { status: r.status, stderr: `${r.stderr}`.replace(/\r/g, "") };
}

/** The migration is refused with its own premise message and leaves the database byte-for-byte as it was. */
export function refusedUnchanged(url: string, name: string, message: RegExp) {
  const before = fingerprint(url);
  const r = applyVerbatim(url, name);
  const after = fingerprint(url);
  return { ok: r.status !== 0 && message.test(r.stderr) && before === after, detail: `status=${r.status} unchanged=${before === after} ${r.stderr.slice(-240)}` };
}

export const migrationSql = (name: string, root = process.cwd()) => fs.readFileSync(path.join(root, "prisma/migrations", name, "migration.sql"), "utf8");
